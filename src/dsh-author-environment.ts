import { parseNpmSpec } from './npm.js'
import { satisfiesSemverRange } from './semver.js'
import { parseDshStartupConfiguration, type DshStartupConfiguration } from './dsh-startup-configuration.js'

export interface DshAuthorEvidence {
  path: string
  quote: string
}

/** Repository claims, not execution results or permission to run repository commands. */
export interface DshAuthorEnvironment {
  startupConfigurations?: Array<DshStartupConfiguration & { plane: 'web' | 'tui'; evidence: DshAuthorEvidence[] }>
  packageManagers: Array<{
    name: 'pnpm' | 'npm' | 'yarn' | 'bun'
    version: string
    scope: 'development' | 'host' | 'profile'
    profile?: string
    evidence: DshAuthorEvidence[]
  }>
  overrides: Array<{
    scope: 'development' | 'profile'
    profile?: string
    values: Record<string, string>
    evidence: DshAuthorEvidence[]
  }>
  workflows: Array<{
    kind: 'headless' | 'web' | 'tui' | 'sdk' | 'acp'
    profile?: string
    role: 'primary' | 'additional'
    evidence: DshAuthorEvidence[]
  }>
  dshVersions: Array<{ version: string; evidence: DshAuthorEvidence[] }>
}

function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} contains unexpected keys`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be bounded text (at most ${maximum} characters)`)
  }
  return value
}

function exactVersion(value: unknown, label: string): string {
  const version = text(value, label, 128)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`${label} must be an exact package version`)
  return version
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`${label} is unsupported`)
  return value as T
}

function list<T>(value: unknown, label: string, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must contain at most ${maximum} items`)
  const result = value.map(parse)
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) throw new Error(`${label} must contain unique items`)
  return result
}

function evidence(value: unknown): DshAuthorEvidence[] {
  const result = list(value, 'author evidence', 8, value => {
    const item = object(value, 'author evidence', ['path', 'quote'])
    const path = text(item.path, 'author evidence path', 512)
    if (path.startsWith('/') || path.includes('\\') || /\s/.test(path)
      || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new Error('author evidence requires a clean repository-relative path')
    }
    return { path, quote: text(item.quote, 'author evidence quote', 2_048) }
  })
  if (result.length === 0) throw new Error('author environment requires evidence')
  return result
}

function profileScope(item: Record<string, unknown>): { profile?: string } {
  if (item.profile === undefined) return {}
  const profile = text(item.profile, 'author profile name', 64)
  if (item.scope !== 'profile' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile) || profile === 'node_modules') {
    throw new Error('named author profile requires a safe name and profile scope')
  }
  return { profile }
}

/** Parse a bounded, data-only vocabulary shared by review, plans and evidence fingerprints. */
export function parseDshAuthorEnvironment(value: unknown): DshAuthorEnvironment | undefined {
  if (value === undefined) return undefined // Legacy history remains readable, not newly verified.
  const root = object(value, 'author environment', ['packageManagers', 'overrides', 'workflows', 'dshVersions', 'startupConfigurations'])
  const result: DshAuthorEnvironment = {
    ...(root.startupConfigurations === undefined ? {} : { startupConfigurations: list(root.startupConfigurations, 'author startup configurations', 4, value => {
      const item = object(value, 'author startup configuration', ['plane', 'scope', 'environment', 'evidence'])
      return { plane: choice(item.plane, ['web', 'tui'], 'startup plane'),
        ...parseDshStartupConfiguration({ scope: item.scope, environment: item.environment })!, evidence: evidence(item.evidence) }
    }) }),
    packageManagers: list(root.packageManagers, 'author package managers', 8, value => {
      const item = object(value, 'author package manager', ['name', 'version', 'scope', 'profile', 'evidence'])
      return {
        name: choice(item.name, ['pnpm', 'npm', 'yarn', 'bun'], 'author package manager'),
        version: exactVersion(item.version, 'author package manager version'),
        scope: choice(item.scope, ['development', 'host', 'profile'], 'author package manager scope'),
        ...profileScope(item),
        evidence: evidence(item.evidence),
      }
    }),
    overrides: list(root.overrides, 'author overrides', 8, value => {
      const item = object(value, 'author overrides', ['scope', 'profile', 'values', 'evidence'])
      if (typeof item.values !== 'object' || item.values === null || Array.isArray(item.values)) throw new Error('author override values must be an object')
      const entries = Object.entries(item.values)
      if (entries.length === 0 || entries.length > 64) throw new Error('author overrides require 1–64 values')
      const values = Object.fromEntries(entries.map(([name, value]) => {
        if (parseNpmSpec(`${name}@1.0.0`).name !== name) throw new Error('author override name must be an npm package name')
        const range = text(value, 'author override version', 512)
        if (satisfiesSemverRange('0.0.0', range) === undefined) throw new Error('author override version must be a supported registry version range')
        return [name, range]
      }).sort(([left], [right]) => left!.localeCompare(right!)))
      return { scope: choice(item.scope, ['development', 'profile'], 'author override scope'), ...profileScope(item), values, evidence: evidence(item.evidence) }
    }),
    workflows: list(root.workflows, 'author workflows', 16, value => {
      const item = object(value, 'author workflow', ['kind', 'profile', 'role', 'evidence'])
      const profile = item.profile === undefined ? undefined : text(item.profile, 'author workflow profile', 64)
      if (profile !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) throw new Error('author workflow profile must be a safe name')
      return {
        kind: choice(item.kind, ['headless', 'web', 'tui', 'sdk', 'acp'], 'author workflow kind'),
        ...(profile === undefined ? {} : { profile }),
        role: choice(item.role, ['primary', 'additional'], 'author workflow role'),
        evidence: evidence(item.evidence),
      }
    }),
    dshVersions: list(root.dshVersions, 'author DSH versions', 16, value => {
      const item = object(value, 'author DSH version', ['version', 'evidence'])
      return { version: exactVersion(item.version, 'author DSH version'), evidence: evidence(item.evidence) }
    }),
  }
  if (result.workflows.filter(item => item.role === 'primary').length > 1) throw new Error('author environment may select at most one primary workflow')
  return result
}

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
/** Locate an exact, bounded JSON property quote; never evaluate repository code. */
function propertyQuote(source: string, name: string, expected: unknown): string | undefined {
  const pattern = new RegExp(`"${escape(name)}"\\s*:\\s*`, 'g')
  for (const match of source.matchAll(pattern)) {
    const start = match.index!
    const valueStart = start + match[0].length
    let inString = false
    let escaped = false
    let depth = 0
    for (let index = valueStart; index < Math.min(source.length, start + 2048); index += 1) {
      const character = source[index]
      if (escaped) { escaped = false; continue }
      if (inString && character === '\\') { escaped = true; continue }
      if (character === '"') inString = !inString
      if (!inString && (character === '{' || character === '[')) depth += 1
      if (!inString && (character === '}' || character === ']')) depth -= 1
      if (!inString && depth === 0) {
        const quote = source.slice(start, index + 1)
        try {
          const parsed = JSON.parse(`{${quote}}`) as Record<string, unknown>
          if (JSON.stringify(parsed[name]) === JSON.stringify(expected)) return quote
        } catch { /* Not the complete property yet. */ }
      }
    }
  }
  return undefined
}

/** Deterministic manifest facts cannot disappear when the model summarizes them. */
export function completeDshAuthorManifestFacts(environment: DshAuthorEnvironment, sources: ReadonlyMap<string, string>): {
  environment: DshAuthorEnvironment; gaps: string[]
} {
  const result = structuredClone(environment)
  const gaps: string[] = []
  for (const [path, source] of sources) {
    if (path.startsWith('dsh-repository/') || !/(^|\/)package\.json$/.test(path)) continue
    if (Buffer.byteLength(source) > 48 * 1024) throw new Error('author manifest exceeds its byte budget')
    let manifest: Record<string, unknown>
    try { manifest = JSON.parse(source) as Record<string, unknown> }
    catch { gaps.push(`Cannot parse author manifest ${path}; its environment requirements are unknown.`); continue }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      gaps.push(`Author manifest ${path} is not an object; its environment requirements are unknown.`); continue
    }
    if (manifest.packageManager !== undefined) {
      const manager = typeof manifest.packageManager === 'string'
        ? /^(pnpm|npm|yarn|bun)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(manifest.packageManager) : null
      const quote = propertyQuote(source, 'packageManager', manifest.packageManager)
      if (!manager || !quote) gaps.push(`Author packageManager in ${path} is not an exact supported version with bounded evidence.`)
      else if (!result.packageManagers.some(item => item.scope === 'development' && item.name === manager[1] && item.version === manager[2])) {
        result.packageManagers.push({ name: manager[1] as DshAuthorEnvironment['packageManagers'][number]['name'],
          version: manager[2]!, scope: 'development', evidence: [{ path, quote }] })
      }
    }
    const pnpm = manifest.pnpm && typeof manifest.pnpm === 'object' && !Array.isArray(manifest.pnpm)
      ? manifest.pnpm as Record<string, unknown> : undefined
    for (const [label, property, values] of [
      ['pnpm overrides', 'overrides', pnpm?.overrides],
      ['npm overrides', 'overrides', manifest.overrides],
      ['Yarn resolutions', 'resolutions', manifest.resolutions],
    ] as const) {
      if (values === undefined) continue
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        gaps.push(`Author ${label} in ${path} are not an object; requirements remain incomplete.`); continue
      }
      const entries = Object.entries(values)
      if (!entries.length) continue
      const quote = propertyQuote(source, property, values)
      if (!quote) { gaps.push(`Author ${label} in ${path} exceed the bounded evidence quote; requirements remain incomplete.`); continue }
      const supported: Record<string, string> = {}
      let unsupported = entries.length > 64
      for (const [name, value] of entries.slice(0, 64)) {
        try {
          const fact = parseDshAuthorEnvironment({ packageManagers: [], workflows: [], dshVersions: [],
            overrides: [{ scope: 'development', values: { [name]: value }, evidence: [{ path, quote }] }] })!.overrides[0]!
          if (!result.overrides.some(item => item.scope === 'development' && item.values[name] === value)) {
            Object.defineProperty(supported, name, { value: fact.values[name], enumerable: true })
          }
        } catch { unsupported = true }
      }
      if (Object.keys(supported).length) result.overrides.push({ scope: 'development', values: supported, evidence: [{ path, quote }] })
      if (unsupported) gaps.push(`Author ${label} in ${path} contain unsupported selectors or versions, or exceed 64 entries; requirements remain incomplete.`)
    }
  }
  return { environment: parseDshAuthorEnvironment(result)!, gaps }
}

function namesVersion(quote: string, version: string): boolean {
  return new RegExp(`(^|[^0-9A-Za-z.-])${escape(version)}(?=$|[^0-9A-Za-z.-]|[.](?=\\s|$))`).test(quote)
}

/** Resolve quoted Markdown rows against their own DSH version columns. */
function dshReleaseTableEvidence(source: string | undefined, quote: string, version: string): boolean {
  if (source === undefined || Buffer.byteLength(source) > 48 * 1024) return false
  const quotedLines = new Set(quote.split(/\r?\n/).map(line => line.trim()))
  const cells = (line: string): string[] | undefined => {
    const value = line.trim()
    if (!value.startsWith('|') || !value.endsWith('|') || /\\\|/.test(value)) return undefined
    const columns = value.slice(1, -1).split('|').map(cell => cell.trim())
    return columns.length > 0 && columns.length <= 32 ? columns : undefined
  }
  let previous: string[] | undefined, header: string[] | undefined
  for (const line of source.split(/\r?\n/)) {
    const row = cells(line)
    if (row?.every(cell => /^:?-{3,}:?$/.test(cell))) {
      header = previous?.length === row.length ? previous : undefined
    } else if (header !== undefined && row?.length === header.length) {
      if (quotedLines.has(line.trim()) && header.some((label, index) =>
        /^(?:dsh|(?:deepseek )?harness)(?: (?:release|version)s?)?$/i.test(label.replace(/[`*_]/g, '').trim())
        && row[index]!.replace(/^`([^`]+)`$/, '$1') === version)) return true
    } else { header = undefined }
    previous = row
  }
  return false
}

/** Quotes must exist in the exact collected bytes and support the claimed structured fact. */
export function validateDshAuthorEnvironment(environment: DshAuthorEnvironment | undefined, sources: ReadonlyMap<string, string>): void {
  if (environment === undefined) return
  for (const fact of [...environment.packageManagers, ...environment.overrides, ...environment.workflows, ...environment.dshVersions, ...(environment.startupConfigurations ?? [])]) {
    for (const citation of fact.evidence) {
      if (!sources.get(citation.path)?.includes(citation.quote)) throw new Error(`author environment evidence does not match ${citation.path}`)
    }
  }
  for (const item of environment.startupConfigurations ?? []) {
    for (const [name, value] of Object.entries(item.environment)) {
      const literal = new RegExp(`\\b${escape(name)}\\s*=\\s*["']?${escape(value)}(?=$|["'\\s.,;:])`)
      if (!item.evidence.some(ref => !ref.path.startsWith('dsh-repository/') && literal.test(ref.quote))) throw new Error('author startup flag is not supported by plugin evidence')
    }
  }
  for (const item of environment.packageManagers) {
    if (!item.evidence.some(ref => new RegExp(`\\b${item.name}\\b`, 'i').test(ref.quote) && namesVersion(ref.quote, item.version))) {
      throw new Error('author package manager version is not supported by its evidence')
    }
  }
  for (const item of [...environment.packageManagers, ...environment.overrides]) {
    if (item.profile !== undefined && !item.evidence.some(ref => !ref.path.startsWith('dsh-repository/')
      && new RegExp(`--profile[ =]+["'\x60]?${escape(item.profile!)}(?=$|["'\x60\\s.,;:])`).test(ref.quote))) {
      throw new Error('named author profile configuration is not supported by its evidence')
    }
  }
  for (const item of environment.overrides) {
    for (const [name, version] of Object.entries(item.values)) {
      const pair = new RegExp(`(?:^|[\\s,{])["']?${escape(name)}["']?\\s*:\\s*["']?${escape(version)}["']?(?=$|[\\s,}])`)
      if (!item.evidence.some(ref => /overrides|resolutions/i.test(ref.quote) && pair.test(ref.quote))) {
        throw new Error('author override value is not supported by its evidence')
      }
    }
  }
  for (const item of environment.workflows) {
    const pattern = item.kind === 'tui' ? /\b(?:tui|terminal)\b|终端/i : new RegExp(`\\b${item.kind}\\b`, 'i')
    if (!item.evidence.some(ref => !ref.path.startsWith('dsh-repository/') && pattern.test(ref.quote))) throw new Error('author workflow is not supported by plugin evidence')
    if (item.profile !== undefined && !item.evidence.some(ref => {
      return !ref.path.startsWith('dsh-repository/') && new RegExp(`--profile[ =]+["'\x60]?${escape(item.profile!)}(?=$|["'\x60\\s.,;:])`).test(ref.quote)
    })) throw new Error('author workflow profile is not named in its evidence')
  }
  for (const item of environment.dshVersions) {
    if (!item.evidence.some(ref => !ref.path.startsWith('dsh-repository/') && (
      ref.quote.split(/\r?\n/).some(line => /^\s*\|.*\|\s*$/.test(line))
        ? dshReleaseTableEvidence(sources.get(ref.path), ref.quote, item.version)
        : /dsh|harness/i.test(ref.quote) && namesVersion(ref.quote, item.version)
    ))) {
      throw new Error('author DSH version is not supported by plugin evidence')
    }
  }
}
