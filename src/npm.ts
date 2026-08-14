import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { decideVerdict, stricterVerdict } from './policy.js'
import { parseNpmLockGraph } from './graph.js'
import { scanDirectory } from './scan.js'
import { parseNpmTarball, type ParsedNpmTarball } from './tar.js'
import {
  REPORT_SCHEMA,
  type CheckStatus,
  type Finding,
  type NpmEvidence,
  type NpmProvenanceEvidence,
  type ScanReport,
  type Severity,
  type VulnerabilitySummary,
} from './types.js'
import { TOOL_VERSION } from './version.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024
const MAX_TARBALL_BYTES = 64 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 32 * 1024 * 1024
const MISSING_PUBLISH_TIME_CUTOFF = '2015-01-01T00:00:00.000Z'
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

interface NpmVersionMetadata {
  name: string
  version: string
  publishedAt?: string
  dist: {
    integrity: string
    shasum?: string
    tarball: string
    signatures: RegistrySignature[]
    attestations?: {
      url?: string
      provenance?: {
        predicateType?: string
      }
    }
  }
}

interface RegistrySignature {
  keyid: string
  sig: string
}

interface RegistryKey {
  expires: string | null
  keyid: string
  keytype: string
  scheme: string
  key: string
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
}

interface DeepAuditResult {
  dependencyAudit: NpmEvidence['dependencyAudit']
  provenance: NpmProvenanceEvidence
}

export interface ParsedNpmSpec {
  name: string
  version: string
  canonical: string
}

export interface InspectNpmOptions {
  registry?: string
  deep?: boolean
  fetch?: FetchLike
  timeoutMs?: number
}

export interface IntegrityResult {
  status: 'verified' | 'invalid'
  algorithm: string
  expected: string
  actual: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function makeFinding(
  code: string,
  severity: Severity,
  summary: string,
  detail: string,
  evidence?: Finding['evidence'],
  remediation?: string,
): Finding {
  const result: Finding = { code, severity, summary, detail }
  if (evidence !== undefined) result.evidence = evidence
  if (remediation !== undefined) result.remediation = remediation
  return result
}

function sortFindings(findings: Finding[]): void {
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  findings.sort((left, right) => order[left.severity] - order[right.severity] || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
}

function normalizeRegistry(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new Error('npm registry must use HTTPS')
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('npm registry URL must not contain credentials, a query string or a fragment')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.toString()
}

function publicUrl(input: string): string {
  const url = new URL(input)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function parseNpmSpec(input: string): ParsedNpmSpec {
  if (!input.startsWith('npm:')) throw new Error('npm package spec must start with npm:')
  const value = input.slice(4)
  const separator = value.lastIndexOf('@')
  if (separator <= 0) throw new Error('npm package spec must include an exact version')
  const name = value.slice(0, separator)
  const version = value.slice(separator + 1)
  if (Buffer.byteLength(name) > 214) throw new Error('npm package name exceeds 214 bytes')
  if (Buffer.byteLength(version) > 256) throw new Error('npm package version exceeds 256 bytes')
  const validName = name.startsWith('@')
    ? /^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/i.test(name)
    : /^[a-z0-9._~-]+$/i.test(name)
  if (!validName) throw new Error(`invalid npm package name: ${name}`)
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`npm package version must be exact, not a tag or range: ${version}`)
  }
  return { name, version, canonical: `npm:${name}@${version}` }
}

async function fetchBuffer(fetcher: FetchLike, url: string, maxBytes: number, timeoutMs: number, accept: string): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error(`refusing non-HTTPS download from ${parsed.origin}${parsed.pathname}`)
  const response = await fetcher(parsed, {
    headers: {
      accept,
      'user-agent': `upstream-radar/${TOOL_VERSION}`,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${parsed.origin}${parsed.pathname}`)
  if (new URL(response.url || parsed.toString()).protocol !== 'https:') throw new Error('download redirected to a non-HTTPS URL')

  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} byte limit`)
  }
  if (response.body === null) return Buffer.alloc(0)

  const chunks: Buffer[] = []
  const reader = response.body.getReader()
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = Buffer.from(next.value)
    total += chunk.length
    if (total > maxBytes) {
      await reader.cancel('response size limit exceeded')
      throw new Error(`response exceeds ${maxBytes} byte limit`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchJson(fetcher: FetchLike, url: string, maxBytes: number, timeoutMs: number): Promise<unknown> {
  const contents = await fetchBuffer(fetcher, url, maxBytes, timeoutMs, 'application/json')
  try {
    return JSON.parse(contents.toString('utf8')) as unknown
  } catch {
    throw new Error(`registry returned invalid JSON for ${new URL(url).pathname}`)
  }
}

function parseVersionMetadata(packument: unknown, spec: ParsedNpmSpec): NpmVersionMetadata {
  const root = asRecord(packument)
  const versions = asRecord(root?.versions)
  const times = asRecord(root?.time)
  const rawVersion = asRecord(versions?.[spec.version])
  if (rawVersion === undefined) throw new Error(`npm version not found: ${spec.name}@${spec.version}`)
  const name = asString(rawVersion.name)
  const version = asString(rawVersion.version)
  const dist = asRecord(rawVersion.dist)
  const integrity = asString(dist?.integrity)
  const tarball = asString(dist?.tarball)
  if (name !== spec.name || version !== spec.version || integrity === undefined || tarball === undefined) {
    throw new Error('npm registry metadata does not identify the requested exact artifact')
  }

  const signatures: RegistrySignature[] = []
  if (Array.isArray(dist?.signatures)) {
    for (const rawSignature of dist.signatures) {
      const signature = asRecord(rawSignature)
      const keyid = asString(signature?.keyid)
      const sig = asString(signature?.sig)
      if (keyid !== undefined && sig !== undefined) signatures.push({ keyid, sig })
    }
  }

  const attestationsRecord = asRecord(dist?.attestations)
  const provenanceRecord = asRecord(attestationsRecord?.provenance)
  const predicateType = asString(provenanceRecord?.predicateType)
  const attestationUrl = asString(attestationsRecord?.url)
  const shasum = asString(dist?.shasum)
  const publishedAt = asString(times?.[spec.version])
  const attestations = attestationsRecord === undefined
    ? undefined
    : {
        ...(attestationUrl === undefined ? {} : { url: attestationUrl }),
        ...(provenanceRecord === undefined
          ? {}
          : { provenance: predicateType === undefined ? {} : { predicateType } }),
      }

  return {
    name,
    version,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    dist: {
      integrity,
      tarball,
      signatures,
      ...(shasum === undefined ? {} : { shasum }),
      ...(attestations === undefined ? {} : { attestations }),
    },
  }
}

export function verifyIntegrity(contents: Buffer, integrity: string): IntegrityResult {
  const supported = new Map<string, number>([['sha512', 4], ['sha384', 3], ['sha256', 2], ['sha1', 1]])
  const candidates = integrity.trim().split(/\s+/).flatMap((token) => {
    const separator = token.indexOf('-')
    if (separator <= 0) return []
    const algorithm = token.slice(0, separator).toLowerCase()
    const expected = token.slice(separator + 1).split('?')[0] ?? ''
    const rank = supported.get(algorithm)
    return rank === undefined || expected === '' ? [] : [{ algorithm, expected, rank }]
  }).sort((left, right) => right.rank - left.rank)
  const selected = candidates[0]
  if (selected === undefined) throw new Error('npm integrity contains no supported digest')

  const actualBuffer = createHash(selected.algorithm).update(contents).digest()
  const expectedBuffer = Buffer.from(selected.expected, 'base64')
  const valid = expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  return {
    status: valid ? 'verified' : 'invalid',
    algorithm: selected.algorithm,
    expected: selected.expected,
    actual: actualBuffer.toString('base64'),
  }
}

function parseRegistryKeys(value: unknown): RegistryKey[] {
  const root = asRecord(value)
  if (!Array.isArray(root?.keys)) return []
  const keys: RegistryKey[] = []
  for (const rawKey of root.keys) {
    const key = asRecord(rawKey)
    const keyid = asString(key?.keyid)
    const keytype = asString(key?.keytype)
    const scheme = asString(key?.scheme)
    const material = asString(key?.key)
    const expires = key?.expires === null ? null : asString(key?.expires)
    if (keyid !== undefined && keytype !== undefined && scheme !== undefined && material !== undefined && expires !== undefined) {
      keys.push({ keyid, keytype, scheme, key: material, expires })
    }
  }
  return keys
}

export function verifyRegistrySignatures(
  name: string,
  version: string,
  integrity: string,
  signatures: readonly RegistrySignature[],
  keys: readonly RegistryKey[],
  publishedAt?: string,
): NpmEvidence['registrySignature'] {
  if (signatures.length === 0) return { status: 'missing', keyIds: [] }
  const message = Buffer.from(`${name}@${version}:${integrity}`, 'utf8')
  const keyIds = signatures.map(signature => signature.keyid)
  const publishedTime = Date.parse(publishedAt ?? MISSING_PUBLISH_TIME_CUTOFF)
  if (!Number.isFinite(publishedTime)) return { status: 'invalid', keyIds }

  for (const signature of signatures) {
    const key = keys.find(candidate => candidate.keyid === signature.keyid)
    if (key === undefined || key.keytype !== 'ecdsa-sha2-nistp256' || key.scheme !== 'ecdsa-sha2-nistp256') {
      return { status: 'invalid', keyIds }
    }
    if (key.expires !== null) {
      const expiry = Date.parse(key.expires)
      if (Number.isFinite(expiry) && publishedTime >= expiry) return { status: 'invalid', keyIds }
    }
    try {
      const der = Buffer.from(key.key, 'base64')
      const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' })
      if (!verifySignature('sha256', message, publicKey, Buffer.from(signature.sig, 'base64'))) return { status: 'invalid', keyIds }
    } catch {
      return { status: 'invalid', keyIds }
    }
  }
  return { status: 'verified', keyIds }
}

async function materializeTarball(archive: ParsedNpmTarball): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upstream-radar-artifact-'))
  try {
    for (const entry of archive.entries) {
      if (entry.type !== 'file' || entry.contents === undefined) continue
      const destination = resolve(root, entry.path)
      const fromRoot = destination.slice(root.length)
      if (!(destination === root || fromRoot.startsWith(sep))) throw new Error('validated archive path escaped materialization root')
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, entry.contents, { flag: 'wx', mode: 0o600 })
    }
    return root
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
    throw error
  }
}

function safeEnvironment(root: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  ]
  const environment: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  environment.NPM_CONFIG_CACHE = join(root, 'npm-cache')
  environment.NPM_CONFIG_USERCONFIG = join(root, 'controlled.npmrc')
  environment.NPM_CONFIG_GLOBALCONFIG = join(root, 'controlled-global.npmrc')
  environment.NPM_CONFIG_IGNORE_SCRIPTS = 'true'
  environment.NPM_CONFIG_AUDIT = 'false'
  environment.NPM_CONFIG_FUND = 'false'
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = join(root, 'controlled.gitconfig')
  environment.GIT_TERMINAL_PROMPT = '0'
  return environment
}

function runProcess(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const detached = process.platform !== 'win32'
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputExceeded = false
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const terminate = (): void => {
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolveResult({
        code,
        stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8'),
        stderr: Buffer.concat(stderr, stderrBytes).toString('utf8'),
        timedOut,
        outputExceeded,
      })
    }
    const collect = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (stdoutBytes + stderrBytes + chunk.length > MAX_PROCESS_OUTPUT_BYTES) {
        outputExceeded = true
        terminate()
        return
      }
      if (stream === 'stdout') stdoutBytes += chunk.length
      else stderrBytes += chunk.length
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'))
    child.once('error', () => finish(127))
    child.once('close', code => finish(code ?? 1))
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
  })
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

function packageLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 100).map((entry) => {
    if (typeof entry === 'string') return entry
    const record = asRecord(entry)
    const name = asString(record?.name) ?? '(unknown)'
    const version = asString(record?.version)
    return version === undefined ? name : `${name}@${version}`
  })
}

function vulnerabilitySummary(audit: unknown): VulnerabilitySummary | null {
  const root = asRecord(audit)
  const metadata = asRecord(root?.metadata)
  const raw = asRecord(metadata?.vulnerabilities)
  if (raw === undefined) return null
  const summary: VulnerabilitySummary = {
    info: asNumber(raw.info) ?? 0,
    low: asNumber(raw.low) ?? 0,
    moderate: asNumber(raw.moderate) ?? 0,
    high: asNumber(raw.high) ?? 0,
    critical: asNumber(raw.critical) ?? 0,
    total: asNumber(raw.total) ?? 0,
  }
  return summary
}

function extractProvenance(
  signaturesAudit: unknown,
  spec: ParsedNpmSpec,
  declared: boolean,
  verificationSucceeded: boolean,
): NpmProvenanceEvidence {
  if (!declared) return { status: 'missing' }
  const root = asRecord(signaturesAudit)
  const invalid = packageLabels(root?.invalid)
  if (invalid.includes(`${spec.name}@${spec.version}`) || invalid.includes(spec.name)) return { status: 'invalid' }
  if (!verificationSucceeded) return { status: 'failed' }
  if (!Array.isArray(root?.verified)) return { status: 'verified' }

  const target = root.verified.map(asRecord).find((entry) => (
    asString(entry?.name) === spec.name && asString(entry?.version) === spec.version
  ))
  if (target === undefined || !Array.isArray(target.attestationBundles)) return { status: 'failed' }
  const slsa = target.attestationBundles.map(asRecord).find(entry => asString(entry?.predicateType) === 'https://slsa.dev/provenance/v1')
  const bundle = asRecord(slsa?.bundle)
  const envelope = asRecord(bundle?.dsseEnvelope)
  const payload = asString(envelope?.payload)
  if (payload === undefined) return { status: 'failed' }

  try {
    const statement = asRecord(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown)
    const predicate = asRecord(statement?.predicate)
    const buildDefinition = asRecord(predicate?.buildDefinition)
    const externalParameters = asRecord(buildDefinition?.externalParameters)
    const workflow = asRecord(externalParameters?.workflow)
    const runDetails = asRecord(predicate?.runDetails)
    const builder = asRecord(runDetails?.builder)
    const dependencies = Array.isArray(buildDefinition?.resolvedDependencies) ? buildDefinition.resolvedDependencies : []
    const source = dependencies.map(asRecord).find(item => asRecord(item?.digest)?.gitCommit !== undefined)
    const sourceDigest = asRecord(source?.digest)
    const sourceRepository = asString(workflow?.repository)
    const sourceRef = asString(workflow?.ref)
    const workflowPath = asString(workflow?.path)
    const sourceCommit = asString(sourceDigest?.gitCommit)
    const builderId = asString(builder?.id)
    return {
      status: 'verified',
      predicateType: 'https://slsa.dev/provenance/v1',
      ...(sourceRepository === undefined ? {} : { sourceRepository }),
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      ...(workflowPath === undefined ? {} : { workflow: workflowPath }),
      ...(builderId === undefined ? {} : { builder: builderId }),
    }
  } catch {
    return { status: 'failed' }
  }
}

async function deepAuditNpmPackage(
  spec: ParsedNpmSpec,
  registry: string,
  provenanceDeclared: boolean,
  timeoutMs: number,
): Promise<DeepAuditResult> {
  const root = await mkdtemp(join(tmpdir(), 'upstream-radar-npm-audit-'))
  const failed = (error: string): DeepAuditResult => ({
    dependencyAudit: {
      status: 'failed',
      packages: null,
      invalidSignatures: [],
      missingSignatures: [],
      vulnerabilities: null,
      error,
    },
    provenance: { status: provenanceDeclared ? 'failed' : 'missing' },
  })

  try {
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'upstream-radar-quarantine',
      version: '0.0.0',
      private: true,
      dependencies: { [spec.name]: spec.version },
    }, null, 2)}\n`, { mode: 0o600 })
    await writeFile(join(root, 'controlled.npmrc'), `registry=${registry}\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\n`, { mode: 0o600 })
    await writeFile(join(root, 'controlled-global.npmrc'), '', { mode: 0o600 })
    await writeFile(join(root, 'controlled.gitconfig'), '', { mode: 0o600 })
    const environment = safeEnvironment(root)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

    const install = await runProcess(npm, [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--loglevel=error',
      '--registry', registry,
    ], root, environment, timeoutMs)
    if (install.code !== 0 || install.timedOut || install.outputExceeded) {
      const reason = install.timedOut
        ? 'npm dependency resolution timed out'
        : install.outputExceeded
          ? 'npm dependency resolution exceeded output budget'
          : `npm dependency resolution failed with exit code ${install.code}`
      return failed(reason)
    }

    const lockfile = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as unknown
    const dependencyGraph = parseNpmLockGraph(lockfile, spec)
    const graphDigest = dependencyGraph.digest
    if (graphDigest === undefined) throw new Error('resolved dependency graph has no digest')
    let signatures = await runProcess(npm, [
      'audit', 'signatures', '--json', '--include-attestations', '--registry', registry,
    ], root, environment, timeoutMs)
    let signaturesJson = parseJsonOutput(signatures.stdout)
    let signaturesRoot = asRecord(signaturesJson)
    const firstAttemptHasResults = Array.isArray(signaturesRoot?.verified)
      || Array.isArray(signaturesRoot?.invalid)
      || Array.isArray(signaturesRoot?.missing)
    if (signaturesJson === undefined || (signatures.code !== 0 && !firstAttemptHasResults)) {
      signatures = await runProcess(npm, ['audit', 'signatures', '--json', '--registry', registry], root, environment, timeoutMs)
      signaturesJson = parseJsonOutput(signatures.stdout)
      signaturesRoot = asRecord(signaturesJson)
    }
    if (signaturesJson === undefined || signatures.timedOut || signatures.outputExceeded) {
      return failed('npm signature/provenance verification did not return bounded JSON')
    }

    const invalidSignatures = packageLabels(signaturesRoot?.invalid)
    const missingSignatures = packageLabels(signaturesRoot?.missing)
    const provenance = extractProvenance(signaturesJson, spec, provenanceDeclared, signatures.code === 0)
    if (signatures.code !== 0 && invalidSignatures.length === 0 && missingSignatures.length === 0) {
      return {
        dependencyAudit: {
          status: 'failed',
          packages: dependencyGraph.nodes.length,
          graphDigest,
          graph: dependencyGraph,
          invalidSignatures,
          missingSignatures,
          vulnerabilities: null,
          error: `npm signature verification failed with exit code ${signatures.code}`,
        },
        provenance,
      }
    }
    const audit = await runProcess(npm, ['audit', '--json', '--registry', registry], root, environment, timeoutMs)
    const auditJson = parseJsonOutput(audit.stdout)
    if (auditJson === undefined || audit.timedOut || audit.outputExceeded) {
      return {
        dependencyAudit: {
          status: 'failed',
          packages: dependencyGraph.nodes.length,
          graphDigest,
          graph: dependencyGraph,
          invalidSignatures,
          missingSignatures,
          vulnerabilities: null,
          error: 'npm vulnerability audit did not return bounded JSON',
        },
        provenance,
      }
    }
    const vulnerabilities = vulnerabilitySummary(auditJson)
    if (vulnerabilities === null) {
      return {
        dependencyAudit: {
          status: 'failed',
          packages: dependencyGraph.nodes.length,
          graphDigest,
          graph: dependencyGraph,
          invalidSignatures,
          missingSignatures,
          vulnerabilities: null,
          error: 'npm vulnerability audit returned JSON without a vulnerability summary',
        },
        provenance,
      }
    }
    const status = invalidSignatures.length > 0 || missingSignatures.length > 0 || (vulnerabilities?.total ?? 0) > 0
      ? 'findings' as const
      : signatures.code === 0 ? 'verified' as const : 'findings' as const

    return {
      dependencyAudit: {
        status,
        packages: dependencyGraph.nodes.length,
        graphDigest,
        graph: dependencyGraph,
        invalidSignatures,
        missingSignatures,
        vulnerabilities,
      },
      provenance,
    }
  } catch {
    return failed('deep npm audit failed before producing complete evidence')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}

function emptyDependencyAudit(): NpmEvidence['dependencyAudit'] {
  return {
    status: 'not-run',
    packages: null,
    invalidSignatures: [],
    missingSignatures: [],
    vulnerabilities: null,
  }
}

function failedArtifactReport(
  spec: ParsedNpmSpec,
  artifactDigest: string,
  npmEvidence: NpmEvidence,
  findings: Finding[],
): ScanReport {
  sortFindings(findings)
  const riskVerdict = decideVerdict(findings)
  return {
    schema: REPORT_SCHEMA,
    tool: { name: 'upstream-radar', version: TOOL_VERSION },
    target: { kind: 'npm', name: spec.name, version: spec.version, artifactDigest, spec: spec.canonical },
    dsh: { isBundle: false },
    evidence: {
      filesScanned: 0,
      bytesHashed: 0,
      lockfiles: [],
      packageManager: null,
      lifecycleScripts: [],
      dependencies: [],
      npm: npmEvidence,
    },
    coverage: {
      staticSource: 'incomplete',
      artifactIntegrity: npmEvidence.integrity.status,
      registrySignature: npmEvidence.registrySignature.status,
      dependencyResolution: 'manifest-only',
      provenance: npmEvidence.provenance.status,
      sourceArtifactMatch: 'not-checked',
      sandboxDetonation: 'not-run',
    },
    findings,
    riskVerdict,
    coverageVerdict: 'incomplete',
    verdict: stricterVerdict(riskVerdict, 'review'),
  }
}

function addNpmEvidenceFindings(evidence: NpmEvidence, findings: Finding[]): void {
  if (evidence.registrySignature.status === 'missing') {
    findings.push(makeFinding(
      'npm-registry-signature-missing',
      'high',
      'npm artifact has no registry signature',
      'The exact package integrity cannot be authenticated against a registry signing key.',
    ))
  } else if (evidence.registrySignature.status === 'invalid') {
    findings.push(makeFinding(
      'npm-registry-signature-invalid',
      'critical',
      'npm registry signature is invalid',
      'The registry signature does not verify for the requested package, version and integrity string.',
    ))
  } else if (evidence.registrySignature.status === 'failed') {
    findings.push(makeFinding(
      'npm-registry-signature-check-failed',
      'high',
      'npm registry signature could not be checked',
      'The registry signing keys were unavailable or could not be parsed, so authenticity remains unverified.',
    ))
  }

  if (evidence.provenance.status === 'missing') {
    findings.push(makeFinding(
      'npm-provenance-missing',
      'medium',
      'npm artifact has no build provenance',
      'The published bytes are not cryptographically linked to a declared source commit and build workflow.',
    ))
  } else if (evidence.provenance.status === 'invalid') {
    findings.push(makeFinding(
      'npm-provenance-invalid',
      'critical',
      'npm provenance verification failed',
      'The provenance attestation is invalid for the requested package artifact.',
    ))
  } else if (evidence.provenance.status === 'failed') {
    findings.push(makeFinding(
      'npm-provenance-check-failed',
      'high',
      'npm provenance could not be verified',
      'The declared provenance was not converted into verified source and build evidence.',
    ))
  } else if (evidence.provenance.status === 'present-unverified') {
    findings.push(makeFinding(
      'npm-provenance-not-checked',
      'medium',
      'npm provenance is present but was not verified',
      'Run deep inspection before relying on the package\'s declared source and build identity.',
    ))
  }

  if (evidence.dependencyAudit.status === 'failed') {
    findings.push(makeFinding(
      'dependency-audit-failed',
      'high',
      'Resolved dependency audit did not complete',
      evidence.dependencyAudit.error ?? 'The dependency graph lacks complete signature and vulnerability evidence.',
    ))
  }

  if (evidence.dependencyAudit.invalidSignatures.length > 0) {
    findings.push(makeFinding(
      'dependency-signature-invalid',
      'critical',
      'Resolved dependencies include invalid signatures',
      'At least one dependency failed npm signature or attestation verification.',
      { packages: evidence.dependencyAudit.invalidSignatures },
    ))
  }
  if (evidence.dependencyAudit.missingSignatures.length > 0) {
    findings.push(makeFinding(
      'dependency-signature-missing',
      'high',
      'Resolved dependencies include unsigned packages',
      'At least one dependency has no verifiable registry signature.',
      { packages: evidence.dependencyAudit.missingSignatures },
    ))
  }

  const vulnerabilities = evidence.dependencyAudit.vulnerabilities
  if (vulnerabilities !== null && vulnerabilities.total > 0) {
    const severity: Severity = vulnerabilities.critical > 0
      ? 'critical'
      : vulnerabilities.high > 0
        ? 'high'
        : 'medium'
    findings.push(makeFinding(
      'dependency-known-vulnerabilities',
      severity,
      'Resolved dependency graph contains known vulnerabilities',
      'Registry advisory data reports vulnerabilities in the exact graph resolved for this review.',
      {
        total: vulnerabilities.total,
        critical: vulnerabilities.critical,
        high: vulnerabilities.high,
        moderate: vulnerabilities.moderate,
        low: vulnerabilities.low,
      },
    ))
  }
}

export async function inspectNpmPackage(input: string, options: InspectNpmOptions = {}): Promise<ScanReport> {
  const spec = parseNpmSpec(input)
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const packagePath = encodeURIComponent(spec.name)
  const packument = await fetchJson(fetcher, new URL(packagePath, registry).toString(), MAX_PACKUMENT_BYTES, timeoutMs)
  const metadata = parseVersionMetadata(packument, spec)
  const tarball = await fetchBuffer(fetcher, metadata.dist.tarball, MAX_TARBALL_BYTES, timeoutMs, 'application/octet-stream')
  const integrity = verifyIntegrity(tarball, metadata.dist.integrity)
  const artifactDigest = `sha256:${createHash('sha256').update(tarball).digest('hex')}`

  let registrySignature: NpmEvidence['registrySignature'] = { status: 'not-checked', keyIds: [] }
  try {
    const keysJson = await fetchJson(fetcher, new URL('-/npm/v1/keys', registry).toString(), 1024 * 1024, timeoutMs)
    registrySignature = verifyRegistrySignatures(
      spec.name,
      spec.version,
      metadata.dist.integrity,
      metadata.dist.signatures,
      parseRegistryKeys(keysJson),
      metadata.publishedAt,
    )
  } catch {
    registrySignature = { status: 'failed', keyIds: metadata.dist.signatures.map(signature => signature.keyid) }
  }

  const provenanceDeclared = metadata.dist.attestations?.provenance !== undefined
  const initialProvenance: NpmProvenanceEvidence = provenanceDeclared
    ? {
        status: 'present-unverified',
        ...(metadata.dist.attestations?.provenance?.predicateType === undefined
          ? {}
          : { predicateType: metadata.dist.attestations.provenance.predicateType }),
      }
    : { status: 'missing' }
  const baseNpmEvidence: NpmEvidence = {
    registry,
    tarball: publicUrl(metadata.dist.tarball),
    compressedBytes: tarball.length,
    unpackedBytes: 0,
    integrity,
    registrySignature,
    provenance: initialProvenance,
    dependencyAudit: emptyDependencyAudit(),
  }

  const earlyFindings: Finding[] = []
  if (integrity.status === 'invalid') {
    earlyFindings.push(makeFinding(
      'npm-integrity-mismatch',
      'critical',
      'Downloaded npm tarball does not match registry integrity',
      'The bytes fetched for this exact version differ from the digest declared by the registry.',
      { algorithm: integrity.algorithm, expected: integrity.expected, actual: integrity.actual },
    ))
    addNpmEvidenceFindings(baseNpmEvidence, earlyFindings)
    return failedArtifactReport(spec, artifactDigest, baseNpmEvidence, earlyFindings)
  }
  if (metadata.dist.shasum !== undefined) {
    const actualShasum = createHash('sha1').update(tarball).digest('hex')
    if (actualShasum !== metadata.dist.shasum) {
      earlyFindings.push(makeFinding(
        'npm-shasum-mismatch',
        'critical',
        'Downloaded npm tarball does not match registry shasum',
        'The legacy SHA-1 registry checksum disagrees with the downloaded artifact.',
        { expected: metadata.dist.shasum, actual: actualShasum },
      ))
    }
  }

  let archive: ParsedNpmTarball
  try {
    archive = parseNpmTarball(tarball)
  } catch (error) {
    earlyFindings.push(makeFinding(
      'npm-archive-invalid',
      'critical',
      'npm artifact cannot be parsed safely',
      error instanceof Error ? error.message : String(error),
    ))
    addNpmEvidenceFindings(baseNpmEvidence, earlyFindings)
    return failedArtifactReport(spec, artifactDigest, baseNpmEvidence, earlyFindings)
  }
  baseNpmEvidence.unpackedBytes = archive.unpackedBytes

  if (archive.findings.some(finding => finding.severity === 'critical')) {
    const findings = [...earlyFindings, ...archive.findings]
    addNpmEvidenceFindings(baseNpmEvidence, findings)
    return failedArtifactReport(spec, artifactDigest, baseNpmEvidence, findings)
  }

  let deep: DeepAuditResult | undefined
  if (options.deep === true) {
    deep = await deepAuditNpmPackage(spec, registry, provenanceDeclared, Math.max(timeoutMs, 60_000))
    baseNpmEvidence.dependencyAudit = deep.dependencyAudit
    baseNpmEvidence.provenance = deep.provenance
  }

  let materialized: string
  try {
    materialized = await materializeTarball(archive)
  } catch {
    const findings = [
      ...earlyFindings,
      ...archive.findings,
      makeFinding(
        'npm-static-scan-materialization-failed',
        'high',
        'Published artifact could not be materialized for static inspection',
        'The scanner failed closed without executing or trusting the package contents.',
      ),
    ]
    addNpmEvidenceFindings(baseNpmEvidence, findings)
    return failedArtifactReport(spec, artifactDigest, baseNpmEvidence, findings)
  }
  try {
    let report: ScanReport
    try {
      report = await scanDirectory(materialized, {
        dependencyGraphResolved: deep?.dependencyAudit.status === 'verified' || deep?.dependencyAudit.status === 'findings',
      })
    } catch {
      const findings = [
        ...earlyFindings,
        ...archive.findings,
        makeFinding(
          'npm-package-manifest-invalid',
          'critical',
          'Published npm artifact has no usable package.json',
          'The tarball package.json is missing, not a regular file, too large, or invalid JSON.',
        ),
      ]
      addNpmEvidenceFindings(baseNpmEvidence, findings)
      return failedArtifactReport(spec, artifactDigest, baseNpmEvidence, findings)
    }

    const packagedName = report.target.name
    const packagedVersion = report.target.version
    report.tool.version = TOOL_VERSION
    report.target = {
      kind: 'npm',
      name: spec.name,
      version: spec.version,
      artifactDigest,
      treeDigest: archive.treeDigest,
      spec: spec.canonical,
    }
    report.evidence.npm = baseNpmEvidence
    report.coverage.artifactIntegrity = integrity.status
    report.coverage.registrySignature = registrySignature.status
    report.coverage.dependencyResolution = deep?.dependencyAudit.status === 'verified' || deep?.dependencyAudit.status === 'findings'
      ? 'resolved'
      : 'manifest-only'
    report.coverage.provenance = baseNpmEvidence.provenance.status
    report.findings.push(...earlyFindings, ...archive.findings)
    if (packagedName !== spec.name || packagedVersion !== spec.version) {
      report.findings.push(makeFinding(
        'npm-manifest-identity-mismatch',
        'critical',
        'Published package manifest identity differs from registry metadata',
        'The package.json inside the tarball does not match the exact name and version requested from the registry.',
        {
          requested: `${spec.name}@${spec.version}`,
          packaged: `${packagedName}@${packagedVersion ?? '(missing)'}`,
        },
      ))
    }
    addNpmEvidenceFindings(baseNpmEvidence, report.findings)
    sortFindings(report.findings)
    report.riskVerdict = decideVerdict(report.findings)
    report.coverageVerdict = 'incomplete'
    report.verdict = stricterVerdict(report.riskVerdict, 'review')
    return report
  } finally {
    await rm(materialized, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
}
