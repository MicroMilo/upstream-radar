import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseNpmLockGraph, parsePnpmLockGraph } from './graph.js'
import { parsePackageManifestSnapshot } from './inventory.js'
import type { DependencyGraph, PackageManifestSnapshot } from './radar-types.js'

export const DSH_PROFILE_CHECK_SCHEMA = 'upstream-radar.dsh-profile-check/v1alpha1' as const

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PATCH_ENTRIES = 10_000
const MAX_WARNINGS = 100
const PACKAGE_NAME = /^(?:@[^/\s]+\/[^/\s]+|[^/@\s]+)(?:\/[^\s]+)*$/

export type DshProfileCheckStatus = 'pass' | 'review' | 'blocked'
export type DshProfileFindingSeverity = 'review' | 'block'
export type DshProfileFindingCode =
  | 'missing-loader-package'
  | 'duplicate-loader-id'
  | 'minimum-release-age-unexcluded'

export interface DshPatchLoaderEntry {
  id: string
  operation: 'insert' | 'row'
  sourceFile: string
  line: number
  name?: string
  disabled?: boolean
}

export interface DshProfileBundleObservation {
  name: string
  version?: string
  manifestPath?: string
  patchPath?: string
}

export interface DshReleaseAgePolicy {
  minimumReleaseAge: string
  excluded: string[]
  unexcludedBundles: string[]
  sourceFile: string
}

export interface DshProfileFinding {
  code: DshProfileFindingCode
  severity: DshProfileFindingSeverity
  summary: string
  detail: string
  remediation: string
  evidence: {
    sourceFiles: string[]
    lines?: number[]
    loaderIds?: string[]
    packageNames?: string[]
    dependencyVersions?: string[]
  }
}

export interface DshProfileCheckReport {
  schema: typeof DSH_PROFILE_CHECK_SCHEMA
  checkedAt: string
  profile: {
    name: string
    version: string
    directory: string
  }
  bundles: DshProfileBundleObservation[]
  packageManager: 'pnpm' | 'npm' | 'unknown'
  lockfile?: string
  dependencyGraph?: DependencyGraph
  policy?: DshReleaseAgePolicy
  patchFiles: string[]
  loaderEntries: DshPatchLoaderEntry[]
  warnings: string[]
  findings: DshProfileFinding[]
  status: DshProfileCheckStatus
  execution: {
    network: false
    installs: false
    pluginCode: false
    dshAgent: false
    llm: false
  }
}

export interface DshProfileCheckOptions {
  profileDirectory: string
  /** Optional explicit patch path, useful when DSH was started with --patch. */
  patchFile?: string
  checkedAt?: string
}

interface ProfileManifest {
  manifest: PackageManifestSnapshot
  bundles: string[]
}

interface FileReadResult {
  text: string
}

interface PackageAvailability {
  rootName: string
  version?: string
  available: boolean
  source: 'dependency-graph' | 'node_modules' | 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
}

async function readBounded(path: string): Promise<FileReadResult> {
  const text = await readFile(path, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_FILE_BYTES} bytes`)
  return { text }
}

async function readOptional(path: string): Promise<FileReadResult | undefined> {
  try {
    return await readBounded(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function realPathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function isOutside(baseDirectory: string, path: string): boolean {
  const value = relative(baseDirectory, path)
  return value.startsWith('..') || isAbsolute(value)
}

function cleanYamlScalar(value: string): string | boolean | undefined {
  const trimmed = value.trim().replace(/\s+#.*$/, '')
  if (trimmed === '') return undefined
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('!!js ')) return trimmed.slice(5).trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function yamlKeyValue(value: string): { key: string; value: string | boolean | undefined } | undefined {
  const colon = value.indexOf(':')
  if (colon < 1) return undefined
  const key = value.slice(0, colon).trim()
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) return undefined
  return { key, value: cleanYamlScalar(value.slice(colon + 1)) }
}

function patchLines(text: string): Array<{ indent: number; content: string; line: number }> {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    if (raw.includes('\t')) return []
    const withoutComment = raw.replace(/\s+#.*$/, '').trimEnd()
    if (withoutComment.trim() === '' || withoutComment.trim() === '---' || withoutComment.trim() === '...') return []
    const indent = withoutComment.length - withoutComment.trimStart().length
    return [{ indent, content: withoutComment.slice(indent), line: index + 1 }]
  })
}

/**
 * Read the loader rows that can make a DSH patch import a package.
 * This deliberately understands only the small subset needed for a safety
 * check; it never evaluates YAML tags, JavaScript values, or plugin code.
 */
function parsePatchEntries(text: string, sourceFile: string): DshPatchLoaderEntry[] {
  const entries: DshPatchLoaderEntry[] = []
  let insertIndent: number | undefined
  let active: DshPatchLoaderEntry | undefined
  let activeIndent: number | undefined

  for (const line of patchLines(text)) {
    if (line.content.startsWith('-')) {
      const rest = line.content.slice(1).trim()
      const mapping = yamlKeyValue(rest)
      if (mapping?.key === 'insert' && mapping.value === undefined) {
        insertIndent = line.indent
        active = undefined
        activeIndent = undefined
        continue
      }
      if (insertIndent !== undefined && line.indent <= insertIndent) insertIndent = undefined
      if (mapping?.key !== 'id' && mapping?.key !== 'name' && mapping?.key !== 'disabled') {
        active = undefined
        activeIndent = undefined
        continue
      }
      const id = mapping.key === 'id' && typeof mapping.value === 'string' ? mapping.value : undefined
      const entry = id === undefined
        ? undefined
        : {
            id,
            operation: insertIndent !== undefined && line.indent > insertIndent ? 'insert' as const : 'row' as const,
            sourceFile,
            line: line.line,
          }
      if (entry !== undefined) entries.push(entry)
      active = entry
      activeIndent = entry === undefined ? undefined : line.indent
      if (active !== undefined && mapping.key !== 'id') applyPatchField(active, mapping.key, mapping.value)
      continue
    }

    if (active === undefined || activeIndent === undefined) continue
    if (line.indent <= activeIndent) {
      active = undefined
      activeIndent = undefined
      continue
    }
    const mapping = yamlKeyValue(line.content)
    if (mapping === undefined) continue
    if (mapping.key === 'id' && typeof mapping.value === 'string') active.id = mapping.value
    else if (mapping.key === 'name' && typeof mapping.value === 'string') active.name = mapping.value
    else if (mapping.key === 'disabled' && typeof mapping.value === 'boolean') active.disabled = mapping.value
  }

  if (entries.length > MAX_PATCH_ENTRIES) throw new Error(`${sourceFile} contains more than ${MAX_PATCH_ENTRIES} loader rows`)
  return entries.filter(entry => entry.id.length > 0 && entry.id.length <= 512)
}

function applyPatchField(entry: DshPatchLoaderEntry, key: string, value: string | boolean | undefined): void {
  if (key === 'name' && typeof value === 'string') entry.name = value
  if (key === 'disabled' && typeof value === 'boolean') entry.disabled = value
}

function rootPackageName(value: string): string | undefined {
  const trimmed = value.trim()
  if (!PACKAGE_NAME.test(trimmed)) return undefined
  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  }
  return trimmed.split('/')[0]
}

function profileRelative(profileDirectory: string, path: string): string {
  const value = relative(profileDirectory, path)
  return value === '' ? '.' : value
}

function safeChildPath(profileDirectory: string, path: string): string | undefined {
  const resolvedProfile = resolve(profileDirectory)
  const resolvedPath = resolve(path)
  const value = relative(resolvedProfile, resolvedPath)
  if (value.startsWith('..') || isAbsolute(value)) return undefined
  return resolvedPath
}

async function readProfileManifest(profileDirectory: string): Promise<ProfileManifest> {
  const path = join(profileDirectory, 'package.json')
  const file = await readBounded(path)
  const manifest = parsePackageManifestSnapshot(parseJson(file.text, path))
  const source = asRecord(manifest.dsh)
  const profile = asRecord(source?.profile)
  const bundles = profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0 || !bundles.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${path} does not contain dsh.profile.bundles`)
  }
  return { manifest, bundles: bundles.map(item => item as string) }
}

async function readNodeModulesManifest(profileDirectory: string, packageName: string): Promise<{ manifest: PackageManifestSnapshot; path: string } | undefined> {
  const rootName = rootPackageName(packageName)
  if (rootName === undefined) return undefined
  const path = safeChildPath(profileDirectory, join(profileDirectory, 'node_modules', ...rootName.split('/'), 'package.json'))
  if (path === undefined) return undefined
  const realProfileDirectory = await realpath(profileDirectory)
  const realNodeModulesDirectory = await realPathIfExists(join(profileDirectory, 'node_modules'))
  const realManifest = await realPathIfExists(path)
  if (realNodeModulesDirectory === undefined || realManifest === undefined) return undefined
  if (isOutside(realProfileDirectory, realManifest) || isOutside(realNodeModulesDirectory, realManifest)) {
    throw new Error(`DSH package manifest escapes the profile node_modules directory: ${packageName}`)
  }
  const file = await readBounded(realManifest)
  return { manifest: parsePackageManifestSnapshot(parseJson(file.text, realManifest)), path: realManifest }
}

async function patchPathForManifest(profileDirectory: string, manifestPath: string, manifest: PackageManifestSnapshot): Promise<string | undefined> {
  const source = asRecord(manifest.dsh)
  const bundle = asRecord(source?.bundle)
  const patch = bundle?.patch
  if (typeof patch !== 'string' || patch.trim() === '') return undefined
  const path = safeChildPath(profileDirectory, resolve(dirname(manifestPath), patch))
  if (path === undefined) return undefined
  const realProfileDirectory = await realpath(profileDirectory)
  const realPatch = await realPathIfExists(path)
  if (realPatch === undefined) return undefined
  if (isOutside(realProfileDirectory, realPatch)) throw new Error(`DSH bundle patch escapes the profile: ${patch}`)
  return realPatch
}

function parseReleaseAgePolicy(text: string, sourceFile: string, bundles: string[]): DshReleaseAgePolicy | undefined {
  let minimumReleaseAge: string | undefined
  const excluded: string[] = []
  let readingExcluded = false
  for (const raw of text.split(/\r?\n/)) {
    const withoutComment = raw.replace(/\s+#.*$/, '').trimEnd()
    if (withoutComment.trim() === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    const content = withoutComment.slice(indent)
    if (indent === 0) readingExcluded = false
    const mapping = yamlKeyValue(content)
    if (indent === 0 && mapping?.key === 'minimumReleaseAge' && typeof mapping.value === 'string') {
      minimumReleaseAge = mapping.value
      continue
    }
    if (indent === 0 && mapping?.key === 'minimumReleaseAgeExclude') {
      readingExcluded = true
      continue
    }
    if (readingExcluded && indent > 0 && content.startsWith('-')) {
      const value = cleanYamlScalar(content.slice(1).trim())
      if (typeof value === 'string') excluded.push(value)
    }
  }
  if (minimumReleaseAge === undefined) return undefined
  const unexcludedBundles = bundles.filter(bundle => !isReleaseAgeExcluded(bundle, excluded))
  return { minimumReleaseAge, excluded, unexcludedBundles, sourceFile }
}

function policyPackageName(value: string): string {
  const trimmed = value.trim()
  const at = trimmed.lastIndexOf('@')
  if (at > 0 && (trimmed.startsWith('@') ? at > trimmed.indexOf('/') : true)) return trimmed.slice(0, at)
  return trimmed
}

function isReleaseAgeExcluded(packageName: string, excluded: string[]): boolean {
  return excluded.some(raw => {
    const pattern = policyPackageName(raw)
    if (pattern === packageName) return true
    if (pattern.endsWith('/*')) return packageName.startsWith(pattern.slice(0, -1))
    return false
  })
}

async function loadDependencyGraph(
  profileDirectory: string,
  root: { name: string; version: string },
  warnings: string[],
  searchDirectories: readonly string[],
): Promise<{ packageManager: DshProfileCheckReport['packageManager']; lockfile?: string; graph?: DependencyGraph }> {
  let pnpmPath: string | undefined
  let pnpm: FileReadResult | undefined
  let npmPath: string | undefined
  let npm: FileReadResult | undefined
  for (const directory of [...new Set(searchDirectories)]) {
    if (pnpm === undefined) {
      const candidate = join(directory, 'pnpm-lock.yaml')
      const file = await readOptional(candidate)
      if (file !== undefined) {
        pnpmPath = candidate
        pnpm = file
      }
    }
    if (npm === undefined) {
      const candidate = join(directory, 'package-lock.json')
      const file = await readOptional(candidate)
      if (file !== undefined) {
        npmPath = candidate
        npm = file
      }
    }
  }
  if (pnpm !== undefined) {
    if (npm !== undefined) warnings.push('both pnpm-lock.yaml and package-lock.json exist; pnpm-lock.yaml was selected')
    try {
      return { packageManager: 'pnpm', lockfile: profileRelative(profileDirectory, pnpmPath!), graph: parsePnpmLockGraph(pnpm.text, root) }
    } catch (error: unknown) {
      warnings.push(`could not parse ${profileRelative(profileDirectory, pnpmPath!)}: ${error instanceof Error ? error.message : String(error)}`)
      return { packageManager: 'pnpm', lockfile: profileRelative(profileDirectory, pnpmPath!) }
    }
  }
  if (npm !== undefined) {
    try {
      return { packageManager: 'npm', lockfile: profileRelative(profileDirectory, npmPath!), graph: parseNpmLockGraph(parseJson(npm.text, npmPath!), root) }
    } catch (error: unknown) {
      warnings.push(`could not parse ${profileRelative(profileDirectory, npmPath!)}: ${error instanceof Error ? error.message : String(error)}`)
      return { packageManager: 'npm', lockfile: profileRelative(profileDirectory, npmPath!) }
    }
  }
  warnings.push('no pnpm-lock.yaml or package-lock.json was found; dependency presence is checked only against node_modules')
  return { packageManager: 'unknown' }
}

async function packageAvailability(
  profileDirectory: string,
  packageName: string,
  graph: DependencyGraph | undefined,
): Promise<PackageAvailability> {
  const rootName = rootPackageName(packageName) ?? packageName
  const node = graph?.nodes.find(item => item.name === rootName)
  if (node !== undefined) return { rootName, version: node.version, available: true, source: 'dependency-graph' }
  const installed = await readNodeModulesManifest(profileDirectory, rootName)
  if (installed !== undefined) return { rootName, version: installed.manifest.version, available: true, source: 'node_modules' }
  return { rootName, available: graph === undefined, source: graph === undefined ? 'unknown' : 'dependency-graph' }
}

function displayCoordinate(name: string, version: string | undefined): string {
  return version === undefined ? name : `${name}@${version}`
}

function sourceFilesFor(entries: DshPatchLoaderEntry[]): string[] {
  return [...new Set(entries.map(entry => entry.sourceFile))].sort()
}

async function buildFindings(
  profileDirectory: string,
  entries: DshPatchLoaderEntry[],
  graph: DependencyGraph | undefined,
  policy: DshReleaseAgePolicy | undefined,
  warnings: string[],
): Promise<DshProfileFinding[]> {
  const active = entries.filter(entry => entry.disabled !== true)
  const findings: DshProfileFinding[] = []
  const duplicateGroups = new Map<string, DshPatchLoaderEntry[]>()
  for (const entry of active) {
    const group = duplicateGroups.get(entry.id) ?? []
    group.push(entry)
    duplicateGroups.set(entry.id, group)
  }
  for (const [id, group] of duplicateGroups) {
    if (group.length < 2 || !group.some(entry => entry.operation === 'insert')) continue
    const files = sourceFilesFor(group)
    findings.push({
      code: 'duplicate-loader-id',
      severity: 'block',
      summary: `loader id ${id} appears more than once`,
      detail: `${group.map(entry => `${entry.sourceFile}:${entry.line}`).join(', ')} all contribute an active row. At least one is an insert, so DSH may reject the profile with a duplicate loader entry or load the wrong implementation.`,
      remediation: `Keep one active registration for ${id}; if the row is already supplied by a bundle, remove the generated insert instead of installing another package.`,
      evidence: {
        sourceFiles: files,
        lines: group.map(entry => entry.line),
        loaderIds: [id],
        packageNames: group.flatMap(entry => entry.name === undefined ? [] : [entry.name]),
      },
    })
  }

  const missingEntries: Array<{ entry: DshPatchLoaderEntry & { name: string }; availability: PackageAvailability }> = []
  for (const entry of active) {
    if (entry.name === undefined) continue
    const availability = await packageAvailability(profileDirectory, entry.name, graph)
    if (!availability.available && availability.source === 'dependency-graph') {
      missingEntries.push({ entry: entry as DshPatchLoaderEntry & { name: string }, availability })
    }
  }
  for (const { entry, availability } of missingEntries) {
    findings.push({
      code: 'missing-loader-package',
      severity: 'block',
      summary: `loader ${entry.id} imports a package that is not in the profile`,
      detail: `${entry.sourceFile}:${entry.line} names ${entry.name}, but ${availability.rootName} is absent from the locked dependency graph. DSH will fail when it imports this loader; adding the package separately can create a second registration for the same id.`,
      remediation: `Align the patch with the installed bundle layout: remove this insert when the feature is bundled, or add the exact package to the profile and ensure it is registered only once.`,
      evidence: {
        sourceFiles: [entry.sourceFile],
        lines: [entry.line],
        loaderIds: [entry.id],
        packageNames: [entry.name],
        dependencyVersions: [displayCoordinate(availability.rootName, availability.version)],
      },
    })
  }

  if (policy !== undefined && policy.unexcludedBundles.length > 0) {
    const source = policy.sourceFile
    findings.push({
      code: 'minimum-release-age-unexcluded',
      severity: 'review',
      summary: 'pnpm can silently hold a DSH plugin below its newest release',
      detail: `${source} sets minimumReleaseAge=${policy.minimumReleaseAge}, but these profile bundles are not excluded: ${policy.unexcludedBundles.join(', ')}. A newly published fix can therefore be unavailable during the cooling window, leaving the profile on an older broken layout.`,
      remediation: `Either pin and review the intended versions, or add the exact plugin package names to minimumReleaseAgeExclude and re-run this check after updating the lockfile.`,
      evidence: {
        sourceFiles: [source],
        packageNames: policy.unexcludedBundles,
      },
    })
  }

  if (warnings.length > MAX_WARNINGS) warnings.splice(MAX_WARNINGS)
  return findings.sort((left, right) => left.code.localeCompare(right.code))
}

export async function checkDshProfile(options: DshProfileCheckOptions): Promise<DshProfileCheckReport> {
  const profileDirectory = resolve(options.profileDirectory)
  const profile = await readProfileManifest(profileDirectory)
  const warnings: string[] = []
  const dshHomeDirectory = resolve(profileDirectory, '..', '..')
  const graphResult = await loadDependencyGraph(profileDirectory, profile.manifest, warnings, [profileDirectory, dshHomeDirectory])
  const bundles: DshProfileBundleObservation[] = []
  const patchFiles = new Set<string>()
  const loaderEntries: DshPatchLoaderEntry[] = []

  const profilePatchCandidates = options.patchFile === undefined
    ? [
        join(profileDirectory, 'cordis.patch.yml'),
        join(profileDirectory, 'cordis.patch.yaml'),
        join(dshHomeDirectory, 'cordis.patch.yml'),
        join(dshHomeDirectory, 'cordis.patch.yaml'),
      ]
    : [resolve(options.patchFile)]
  for (const path of profilePatchCandidates) {
    const file = await readOptional(path)
    if (file === undefined) continue
    const displayPath = profileRelative(profileDirectory, path)
    patchFiles.add(displayPath)
    loaderEntries.push(...parsePatchEntries(file.text, displayPath))
    break
  }

  for (const bundleName of profile.bundles) {
    const packageObservation = await readNodeModulesManifest(profileDirectory, bundleName)
    if (packageObservation === undefined) {
      bundles.push({ name: bundleName })
      continue
    }
    const bundle: DshProfileBundleObservation = {
      name: bundleName,
      version: packageObservation.manifest.version,
      manifestPath: profileRelative(profileDirectory, packageObservation.path),
    }
    const patchPath = await patchPathForManifest(profileDirectory, packageObservation.path, packageObservation.manifest)
    if (patchPath !== undefined) {
      const displayPath = profileRelative(profileDirectory, patchPath)
      bundle.patchPath = displayPath
      if (!patchFiles.has(displayPath)) {
        const file = await readBounded(patchPath)
        patchFiles.add(displayPath)
        loaderEntries.push(...parsePatchEntries(file.text, displayPath))
      }
    }
    bundles.push(bundle)
  }

  const workspaceCandidates = [
    join(profileDirectory, 'pnpm-workspace.yaml'),
    join(profileDirectory, 'pnpm-workspace.yml'),
    join(dshHomeDirectory, 'pnpm-workspace.yaml'),
    join(dshHomeDirectory, 'pnpm-workspace.yml'),
  ]
  let workspacePath: string | undefined
  for (const candidate of workspaceCandidates) {
    if (await pathExists(candidate)) {
      workspacePath = candidate
      break
    }
  }
  let policy: DshReleaseAgePolicy | undefined
  if (workspacePath !== undefined) {
    const policyFile = await readBounded(workspacePath)
    policy = parseReleaseAgePolicy(policyFile.text, profileRelative(profileDirectory, workspacePath), profile.bundles)
  }
  const findings = await buildFindings(profileDirectory, loaderEntries, graphResult.graph, policy, warnings)
  const status: DshProfileCheckStatus = findings.some(finding => finding.severity === 'block')
    ? 'blocked'
    : findings.length > 0 || warnings.length > 0 || graphResult.graph === undefined
      ? 'review'
      : 'pass'

  return {
    schema: DSH_PROFILE_CHECK_SCHEMA,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    profile: {
      name: profile.manifest.name,
      version: profile.manifest.version,
      directory: profileDirectory,
    },
    bundles,
    packageManager: graphResult.packageManager,
    ...(graphResult.lockfile === undefined ? {} : { lockfile: graphResult.lockfile }),
    ...(graphResult.graph === undefined ? {} : { dependencyGraph: graphResult.graph }),
    ...(policy === undefined ? {} : { policy }),
    patchFiles: [...patchFiles].sort(),
    loaderEntries: loaderEntries.sort((left, right) => left.sourceFile.localeCompare(right.sourceFile) || left.line - right.line),
    warnings,
    findings,
    status,
    execution: {
      network: false,
      installs: false,
      pluginCode: false,
      dshAgent: false,
      llm: false,
    },
  }
}

function displayPath(value: string): string {
  return value.replaceAll('\\', '/')
}

export function renderDshProfileCheck(report: DshProfileCheckReport): string {
  const lines = [
    'Upstream Radar — DSH profile check',
    `Profile: ${displayPath(report.profile.directory)} (${report.profile.name}@${report.profile.version})`,
    `Status: ${report.status.toUpperCase()}`,
    `Dependency graph: ${report.packageManager}${report.lockfile === undefined ? '' : ` / ${report.lockfile}`} ${report.dependencyGraph === undefined ? '(not available)' : `(${report.dependencyGraph.nodes.length} nodes, ${report.dependencyGraph.edges.length} edges)`}`,
    `Patch files: ${report.patchFiles.length === 0 ? 'none' : report.patchFiles.join(', ')}`,
    '',
    'This run:',
    '  network: no',
    '  installs: no',
    '  plugin code: no',
    '  DSH Agent / LLM: no',
  ]
  if (report.dependencyGraph !== undefined) {
    lines.push('', 'Dependency graph packages:')
    for (const node of report.dependencyGraph.nodes.slice(0, 80)) lines.push(`  ${node.name}@${node.version}`)
    if (report.dependencyGraph.nodes.length > 80) lines.push(`  ... ${report.dependencyGraph.nodes.length - 80} more`)
  }
  if (report.policy !== undefined) {
    lines.push('', `pnpm release-age policy: minimumReleaseAge=${report.policy.minimumReleaseAge}`)
    lines.push(`  excluded: ${report.policy.excluded.length === 0 ? 'none' : report.policy.excluded.join(', ')}`)
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) lines.push(`  - ${warning}`)
  }
  if (report.findings.length === 0) {
    lines.push('', 'Findings: none')
  } else {
    lines.push('', `Findings (${report.findings.length}):`)
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.summary}`)
      lines.push(`    ${finding.detail}`)
      lines.push(`    Fix: ${finding.remediation}`)
    }
  }
  lines.push('', `Result: ${report.status === 'blocked' ? 'do not start this profile' : report.status === 'review' ? 'review the evidence before starting' : 'static checks passed'}`)
  return `${lines.join('\n')}\n`
}

/**
 * A short operator-facing result for the common case where the user wants the
 * answer and the next repair, not the complete graph dump.
 */
export function renderDshProfileCheckSummary(report: DshProfileCheckReport): string {
  const status = report.status.toUpperCase()
  const lines = [
    `DSH profile ${displayPath(report.profile.name)}@${displayPath(report.profile.version)}: ${status}`,
    `Evidence: ${report.dependencyGraph?.nodes.length ?? 0} dependency nodes, ${report.loaderEntries.length} loader rows, ${report.findings.length} finding(s).`,
    'Scope: static profile files only; no install, plugin execution, DSH start, or Agent/model call.',
  ]
  if (report.findings.length === 0) {
    lines.push('Next: static checks passed; continue with the normal DSH start or dependency monitoring flow.')
    return `${lines.join('\n')}\n`
  }
  lines.push('', 'Findings:')
  for (const finding of report.findings.slice(0, 5)) {
    lines.push(`- [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.summary}`)
    lines.push(`  Why: ${finding.detail}`)
    lines.push(`  Fix: ${finding.remediation}`)
  }
  if (report.findings.length > 5) lines.push(`- ... ${report.findings.length - 5} more finding(s)`)
  lines.push('', `Next: ${report.status === 'blocked' ? 'do not start this profile until the findings are fixed.' : 'review the findings before starting this profile.'}`)
  return `${lines.join('\n')}\n`
}
