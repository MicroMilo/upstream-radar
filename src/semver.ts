interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

function parsePart(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value
}

export function parseSemver(value: string, allowPartial = false): Semver | undefined {
  const match = /^(?:v)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  if (!allowPartial && (match[2] === undefined || match[3] === undefined)) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] === undefined ? [] : match[4].split('.').map(parsePart),
  }
}

export function compareSemver(left: Semver, right: Semver): number {
  const numeric = left.major - right.major || left.minor - right.minor || left.patch - right.patch
  if (numeric !== 0) return Math.sign(numeric)
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return leftPart < rightPart ? -1 : 1
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Compare two complete semantic-version strings without guessing for non-semver values. */
export function compareSemverValues(leftValue: string, rightValue: string): number | undefined {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (left === undefined || right === undefined) return undefined
  return compareSemver(left, right)
}

function comparatorMatches(version: Semver, token: string): boolean | undefined {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (match === null) return undefined
  const operator = match[1] ?? '='
  const target = parseSemver(match[2] ?? '', true)
  if (target === undefined) return undefined
  const comparison = compareSemver(version, target)
  switch (operator) {
    case '>=': return comparison >= 0
    case '<=': return comparison <= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    case '=': return comparison === 0
    default: return undefined
  }
}

function caretMatches(version: Semver, value: string): boolean | undefined {
  const lower = parseSemver(value, true)
  if (lower === undefined) return undefined
  const upper: Semver = lower.major > 0
    ? { major: lower.major + 1, minor: 0, patch: 0, prerelease: [] }
    : lower.minor > 0
      ? { major: 0, minor: lower.minor + 1, patch: 0, prerelease: [] }
      : { major: 0, minor: 0, patch: lower.patch + 1, prerelease: [] }
  return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0
}

function tildeMatches(version: Semver, value: string): boolean | undefined {
  const lower = parseSemver(value, true)
  if (lower === undefined) return undefined
  const upper: Semver = { major: lower.major, minor: lower.minor + 1, patch: 0, prerelease: [] }
  return compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0
}

function branchMatches(version: Semver, rawBranch: string): boolean | undefined {
  const branch = rawBranch.trim()
  if (branch === '' || branch === '*' || /^latest$/i.test(branch)) return true
  if (/\s-\s/.test(branch)) return undefined
  const wildcard = /^(?:v)?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(branch)
  if (wildcard !== null && [wildcard[1], wildcard[2], wildcard[3]].some(value => value === undefined || /^[xX*]$/.test(value))) {
    if (wildcard[1] !== undefined && !/^[xX*]$/.test(wildcard[1]) && version.major !== Number(wildcard[1])) return false
    if (wildcard[2] !== undefined && !/^[xX*]$/.test(wildcard[2]) && version.minor !== Number(wildcard[2])) return false
    if (wildcard[3] !== undefined && !/^[xX*]$/.test(wildcard[3]) && version.patch !== Number(wildcard[3])) return false
    return true
  }
  if (branch.startsWith('^')) return caretMatches(version, branch.slice(1))
  if (branch.startsWith('~')) return tildeMatches(version, branch.slice(1))
  const tokens = branch.split(/\s+/)
  let unknown = false
  for (const token of tokens) {
    const result = comparatorMatches(version, token)
    if (result === false) return false
    if (result === undefined) unknown = true
  }
  return unknown ? undefined : true
}

/** Evaluate common npm ranges. Undefined means the range syntax was intentionally not guessed. */
export function satisfiesSemverRange(versionValue: string, rangeValue: string): boolean | undefined {
  const version = parseSemver(versionValue)
  if (version === undefined) return undefined
  const normalized = rangeValue.trim().replace(/^workspace:/, '')
  // npm's bare wildcard is an explicit unconstrained range. Treating it as
  // indeterminate made every resolved `peerDependencies: { name: "*" }`
  // contract look like missing evidence even though any semantic version is
  // a mathematical match.
  if (normalized === '*') return true
  if (normalized === '^' || normalized === '~') return undefined
  let sawUnknown = false
  for (const branch of normalized.split('||')) {
    const result = branchMatches(version, branch)
    if (result === true) return true
    if (result === undefined) sawUnknown = true
  }
  return sawUnknown ? undefined : false
}

export function crossesBreakingVersionBoundary(previousValue: string, candidateValue: string): boolean {
  const previous = parseSemver(previousValue)
  const candidate = parseSemver(candidateValue)
  if (previous === undefined || candidate === undefined || compareSemver(candidate, previous) <= 0) return false
  if (previous.major !== candidate.major) return true
  return previous.major === 0 && previous.minor !== candidate.minor
}
