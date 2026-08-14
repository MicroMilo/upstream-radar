import { createHash } from 'node:crypto'
import {
  lstat,
  readFile,
  readdir,
  readlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { decideVerdict, stricterVerdict } from './policy.js'
import {
  REPORT_SCHEMA,
  type DependencyEvidence,
  type DshEvidence,
  type Finding,
  type LifecycleScriptEvidence,
  type ScanReport,
  type Severity,
} from './types.js'
import { TOOL_VERSION } from './version.js'

const MAX_FILES = 10_000
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules'])
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const
const NATIVE_SUFFIXES = ['.node', '.dll', '.dylib', '.so', '.exe']

interface PackageManifest {
  name?: unknown
  version?: unknown
  packageManager?: unknown
  scripts?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
  bundledDependencies?: unknown
  bundleDependencies?: unknown
  dsh?: unknown
}

interface ScannedFile {
  path: string
  size: number
  digest: string
  mode: number
  symlinkTarget?: string
}

interface WalkResult {
  files: ScannedFile[]
  bytesHashed: number
  incomplete: boolean
}

export interface ScanOptions {
  maxFiles?: number
  maxTotalBytes?: number
  dependencyGraphResolved?: boolean
}

function addFinding(
  findings: Finding[],
  code: string,
  severity: Severity,
  summary: string,
  detail: string,
  evidence?: Finding['evidence'],
  remediation?: string,
): void {
  const finding: Finding = { code, severity, summary, detail }
  if (evidence !== undefined) finding.evidence = evidence
  if (remediation !== undefined) finding.remediation = remediation
  findings.push(finding)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function insideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
}

async function hashFile(path: string): Promise<string> {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

async function walkPackage(root: string, options: ScanOptions, findings: Finding[]): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES
  const files: ScannedFile[] = []
  let bytesHashed = 0
  let entriesVisited = 0
  let incomplete = false

  async function visit(directory: string): Promise<void> {
    if (incomplete) return
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (incomplete) return
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue

      entriesVisited += 1
      if (entriesVisited > maxFiles) {
        incomplete = true
        addFinding(
          findings,
          'scan-budget-exceeded',
          'high',
          'Static scan coverage is incomplete',
          'The package exceeded the configured filesystem-entry budget, so not every entry was inspected.',
          { entriesVisited, filesScanned: files.length, bytesHashed, maxFiles, maxTotalBytes },
          'Increase the scan budget in an isolated worker or reduce the artifact size.',
        )
        return
      }

      const absolutePath = resolve(directory, entry.name)
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      const stats = await lstat(absolutePath)

      if (stats.isSymbolicLink()) {
        const target = await readlink(absolutePath)
        const resolvedTarget = resolve(dirname(absolutePath), target)
        const escapesRoot = !insideRoot(root, resolvedTarget)
        const digest = createHash('sha256').update(`symlink:${target}`).digest('hex')
        files.push({ path: relativePath, size: stats.size, digest, mode: stats.mode, symlinkTarget: target })
        addFinding(
          findings,
          escapesRoot ? 'symlink-escapes-package' : 'symlink-present',
          escapesRoot ? 'critical' : 'medium',
          escapesRoot ? 'Symlink escapes the package root' : 'Package contains a symlink',
          escapesRoot
            ? 'Following this link would access content outside the reviewed artifact.'
            : 'Symlinks need manual review because their target semantics vary across packaging and installation.',
          { path: relativePath, target },
          'Remove the symlink or replace it with an in-package regular file.',
        )
        continue
      }

      if (stats.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!stats.isFile()) continue

      if (bytesHashed + stats.size > maxTotalBytes) {
        incomplete = true
        addFinding(
          findings,
          'scan-budget-exceeded',
          'high',
          'Static scan coverage is incomplete',
          'The package exceeded the configured file or byte budget, so not every file was hashed.',
          { filesScanned: files.length, bytesHashed, maxFiles, maxTotalBytes },
          'Increase the scan budget in an isolated worker or reduce the artifact size.',
        )
        return
      }

      const digest = await hashFile(absolutePath)
      files.push({ path: relativePath, size: stats.size, digest, mode: stats.mode })
      bytesHashed += stats.size
    }
  }

  await visit(root)
  return { files, bytesHashed, incomplete }
}

function artifactDigest(files: readonly ScannedFile[]): string {
  const aggregate = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    aggregate.update(file.path)
    aggregate.update('\0')
    aggregate.update(file.digest)
    aggregate.update('\0')
    aggregate.update(String(file.mode & 0o777))
    aggregate.update('\n')
  }
  return `sha256:${aggregate.digest('hex')}`
}

function collectDependencies(manifest: PackageManifest): DependencyEvidence[] {
  const groups: Array<[keyof PackageManifest, DependencyEvidence['scope']]> = [
    ['dependencies', 'dependency'],
    ['devDependencies', 'devDependency'],
    ['optionalDependencies', 'optionalDependency'],
    ['peerDependencies', 'peerDependency'],
  ]
  const dependencies: DependencyEvidence[] = []

  for (const [key, scope] of groups) {
    const values = asRecord(manifest[key])
    if (values === undefined) continue
    for (const [name, rawSpec] of Object.entries(values)) {
      const spec = asString(rawSpec)
      if (spec !== undefined) dependencies.push({ name, scope, spec })
    }
  }

  return dependencies.sort((left, right) => `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`))
}

function collectLifecycleScripts(manifest: PackageManifest): LifecycleScriptEvidence[] {
  const scripts = asRecord(manifest.scripts)
  if (scripts === undefined) return []
  const result: LifecycleScriptEvidence[] = []
  for (const name of LIFECYCLE_SCRIPTS) {
    const command = asString(scripts[name])
    if (command !== undefined) result.push({ name, command })
  }
  return result
}

function inspectLifecycleScripts(scripts: readonly LifecycleScriptEvidence[], findings: Finding[]): void {
  for (const script of scripts) {
    const pipesRemoteContentToShell = /(?:curl|wget)\b[^\n|;&]*(?:\||&&|;)\s*(?:ba)?sh\b/i.test(script.command)
    const invokesRemoteDownload = /\b(?:curl|wget|Invoke-WebRequest|Start-BitsTransfer)\b|https?:\/\//i.test(script.command)

    if (pipesRemoteContentToShell) {
      addFinding(
        findings,
        'install-script-remote-shell',
        'critical',
        `Lifecycle script ${script.name} pipes remote content to a shell`,
        'Remote content can change independently of the reviewed package and executes during installation.',
        { script: script.name },
        'Publish a prebuilt artifact and remove the remote shell pipeline.',
      )
    } else if (invokesRemoteDownload) {
      addFinding(
        findings,
        'install-script-network-access',
        'high',
        `Lifecycle script ${script.name} appears to access the network`,
        'Install-time downloads are not covered by the package digest and require isolated review.',
        { script: script.name },
        'Vendor the artifact with a verified digest or build it in a provenance-producing CI workflow.',
      )
    } else {
      addFinding(
        findings,
        'lifecycle-script-present',
        'high',
        `Lifecycle script ${script.name} executes during installation`,
        'Lifecycle scripts run before a plugin is admitted into DSH and therefore require review.',
        { script: script.name, command: script.command },
        'Prefer a prebuilt package with no install-time lifecycle scripts.',
      )
    }
  }
}

function inspectDependencySpecs(
  dependencies: readonly DependencyEvidence[],
  hasLockfile: boolean,
  dependencyGraphResolved: boolean,
  findings: Finding[],
): void {
  const runtimeDependencies = dependencies.filter(dependency => dependency.scope !== 'devDependency')
  if (!hasLockfile && !dependencyGraphResolved && runtimeDependencies.length > 0) {
    addFinding(
      findings,
      'dependency-graph-unlocked',
      'medium',
      'Runtime dependency graph is not locked in the reviewed source tree',
      'A future resolution of the same manifest may select different transitive artifacts.',
      { runtimeDependencyCount: runtimeDependencies.length },
      'Commit a supported lockfile and verify every resolved artifact integrity.',
    )
  }

  for (const dependency of dependencies) {
    const isGit = /^(?:git\+|git:|github:|gitlab:|bitbucket:)|\.git(?:#|$)/i.test(dependency.spec)
    const pinnedGitCommit = /#[0-9a-f]{40}(?:$|&)/i.test(dependency.spec) || /#[0-9a-f]{64}(?:$|&)/i.test(dependency.spec)
    if (isGit && !pinnedGitCommit) {
      addFinding(
        findings,
        'mutable-git-dependency',
        'high',
        `Git dependency ${dependency.name} is not pinned to a full commit`,
        'Branches, tags and abbreviated revisions can resolve to different source over time.',
        { dependency: dependency.name, scope: dependency.scope, spec: dependency.spec },
        'Pin the dependency to a full commit and record the produced artifact digest.',
      )
    } else if (/^https?:\/\//i.test(dependency.spec)) {
      addFinding(
        findings,
        'remote-tarball-dependency',
        'high',
        `Dependency ${dependency.name} is fetched from a URL`,
        'A URL dependency bypasses normal registry provenance and publisher controls.',
        { dependency: dependency.name, scope: dependency.scope, spec: dependency.spec },
        'Use a signed registry release or independently pin and verify the artifact digest.',
      )
    } else if (['*', 'latest', 'next'].includes(dependency.spec.trim())) {
      addFinding(
        findings,
        'floating-dependency-spec',
        'medium',
        `Dependency ${dependency.name} uses a floating version`,
        'The same manifest can resolve to a different artifact without a source change.',
        { dependency: dependency.name, scope: dependency.scope, spec: dependency.spec },
        'Use a bounded version and a verified lockfile.',
      )
    }
  }
}

function inspectFiles(root: string, files: readonly ScannedFile[], findings: Finding[]): void {
  for (const file of files) {
    const lowercase = file.path.toLowerCase()
    if (NATIVE_SUFFIXES.some(suffix => lowercase.endsWith(suffix))) {
      addFinding(
        findings,
        'native-binary-present',
        'high',
        `Native executable artifact found: ${file.path}`,
        'Native artifacts cannot be fully explained by JavaScript source review and require provenance or sandbox analysis.',
        { path: file.path, sha256: file.digest, size: file.size },
        'Provide build provenance and a reproducible build for this artifact.',
      )
    }

    if (lowercase === '.pnpmfile.cjs' || lowercase.endsWith('/.pnpmfile.cjs')) {
      addFinding(
        findings,
        'package-manager-hook-present',
        'high',
        'Package contains a pnpm resolution hook',
        'A pnpm hook can rewrite dependency manifests during resolution.',
        { path: file.path },
        'Remove the hook or require dedicated human review.',
      )
    }
  }

  void root
}

function inspectBundledDependencies(manifest: PackageManifest, findings: Finding[]): void {
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies
  if (Array.isArray(bundled) && bundled.length > 0) {
    const names = bundled.filter((entry): entry is string => typeof entry === 'string')
    addFinding(
      findings,
      'bundled-dependencies-present',
      'medium',
      'Package embeds bundled dependencies',
      'Bundled dependencies must be inspected from the artifact rather than trusted from registry metadata.',
      { dependencies: names },
      'Prefer normal locked dependencies or include the bundled components in an SBOM.',
    )
  }
}

function inspectNpmrc(root: string, files: readonly ScannedFile[], findings: Finding[]): Promise<void> {
  const npmrc = files.find(file => file.path === '.npmrc')
  if (npmrc === undefined || npmrc.size > MAX_MANIFEST_BYTES) return Promise.resolve()
  return readFile(resolve(root, npmrc.path), 'utf8').then((contents) => {
    if (/(?:_authToken|_password|username)\s*=/i.test(contents)) {
      addFinding(
        findings,
        'credential-in-npmrc',
        'critical',
        'Package contains registry credentials in .npmrc',
        'Credential material must never be distributed inside a plugin artifact.',
        { path: '.npmrc' },
        'Revoke the credential, remove it from history and publish a clean artifact.',
      )
    }
    if (/^registry\s*=\s*https?:\/\//im.test(contents)) {
      addFinding(
        findings,
        'custom-registry-config',
        'medium',
        'Package configures a custom npm registry',
        'Dependency provenance depends on a registry selected by package-local configuration.',
        { path: '.npmrc' },
        'Review the registry endpoint and enforce it through consumer policy instead.',
      )
    }
  })
}

function extractDshEvidence(
  manifest: PackageManifest,
  root: string,
  files: readonly ScannedFile[],
  scanIncomplete: boolean,
  findings: Finding[],
): DshEvidence {
  const dsh = asRecord(manifest.dsh)
  const bundle = asRecord(dsh?.bundle)
  const patch = asString(bundle?.patch)
  if (patch === undefined) return { isBundle: false }

  const patchPath = resolve(root, patch)
  if (!insideRoot(root, patchPath)) {
    addFinding(
      findings,
      'dsh-patch-escapes-package',
      'critical',
      'DSH bundle patch path escapes the package root',
      'The manifest points DSH at configuration outside the reviewed artifact.',
      { patch },
      'Keep the bundle patch inside the published package.',
    )
  } else if (!scanIncomplete) {
    const patchRelative = relative(root, patchPath).split(sep).join('/')
    const patchEntry = files.find(file => file.path === patchRelative)
    if (patchEntry === undefined || patchEntry.symlinkTarget !== undefined) {
      addFinding(
        findings,
        'dsh-patch-not-regular-file',
        'high',
        'DSH bundle patch is missing or not a regular file',
        'The published package does not contain the declared patch as a reviewed regular file.',
        { patch },
        'Publish the declared patch inside the package as a regular file.',
      )
    }
  }
  return { isBundle: true, patch }
}

async function readManifest(root: string): Promise<PackageManifest> {
  const manifestPath = resolve(root, 'package.json')
  const stats = await lstat(manifestPath)
  if (!stats.isFile()) throw new Error('package.json is not a regular file')
  if (stats.size > MAX_MANIFEST_BYTES) throw new Error('package.json exceeds the 1 MiB safety limit')

  const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  const record = asRecord(parsed)
  if (record === undefined) throw new Error('package.json must contain a JSON object')
  return record as PackageManifest
}

export async function scanDirectory(input: string, options: ScanOptions = {}): Promise<ScanReport> {
  const root = resolve(input)
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory()) throw new Error(`scan target is not a directory: ${input}`)

  const manifest = await readManifest(root)
  const findings: Finding[] = []
  const walk = await walkPackage(root, options, findings)
  const fileNames = new Set(walk.files.map(file => file.path))
  const lockfiles = LOCKFILES.filter(lockfile => fileNames.has(lockfile))
  const lifecycleScripts = collectLifecycleScripts(manifest)
  const dependencies = collectDependencies(manifest)

  inspectLifecycleScripts(lifecycleScripts, findings)
  inspectDependencySpecs(dependencies, lockfiles.length > 0, options.dependencyGraphResolved ?? false, findings)
  inspectBundledDependencies(manifest, findings)
  inspectFiles(root, walk.files, findings)
  await inspectNpmrc(root, walk.files, findings)
  const dsh = extractDshEvidence(manifest, root, walk.files, walk.incomplete, findings)

  findings.sort((left, right) => {
    const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    return order[left.severity] - order[right.severity] || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)
  })

  const riskVerdict = decideVerdict(findings)
  const coverageVerdict = 'incomplete' as const

  return {
    schema: REPORT_SCHEMA,
    tool: { name: 'upstream-radar', version: TOOL_VERSION },
    target: {
      kind: 'directory',
      name: asString(manifest.name) ?? '(unnamed)',
      version: asString(manifest.version) ?? null,
      artifactDigest: artifactDigest(walk.files),
    },
    dsh,
    evidence: {
      filesScanned: walk.files.length,
      bytesHashed: walk.bytesHashed,
      lockfiles,
      packageManager: asString(manifest.packageManager) ?? null,
      lifecycleScripts,
      dependencies,
    },
    coverage: {
      staticSource: walk.incomplete ? 'incomplete' : 'complete',
      artifactIntegrity: 'locally-hashed',
      registrySignature: 'not-checked',
      dependencyResolution: options.dependencyGraphResolved === true ? 'resolved' : 'manifest-only',
      provenance: 'not-checked',
      sourceArtifactMatch: 'not-checked',
      sandboxDetonation: 'not-run',
    },
    findings,
    riskVerdict,
    coverageVerdict,
    verdict: stricterVerdict(riskVerdict, 'review'),
  }
}
