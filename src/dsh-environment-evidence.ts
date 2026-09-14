import { posix } from 'node:path'
import type { DshEnvironmentRecommendationDocument } from './dsh-environment-recommendation.js'

const MAX_TREE_ENTRIES = 10_000
const MAX_DOCUMENTS = 24
const MAX_DOCUMENT_BYTES = 48 * 1024
const MAX_DOCUMENT_TOTAL_BYTES = 192 * 1024
const MAX_TREE_REQUESTS = 16

function cleanPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.startsWith('/') && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

/** Traverse only package, setup-doc and CI directories of a non-recursive immutable Git tree. */
export async function collectDshEnvironmentEvidenceTree(
  packagePath: string | undefined,
  rootSha: string,
  fetchTree: (sha: string) => Promise<unknown>,
): Promise<unknown[]> {
  if (packagePath !== undefined && (!cleanPath(packagePath) || packagePath.split('/').length > 8)) {
    throw new Error('repository evidence package path is unsafe or too deep')
  }
  const packageDirectory = packagePath === undefined ? '.' : posix.dirname(packagePath)
  const trees = new Map<string, Record<string, unknown>[]>()
  const result: unknown[] = []
  let requests = 0
  async function readTree(path: string, sha: string): Promise<void> {
    if (++requests > MAX_TREE_REQUESTS) throw new Error(`repository evidence exceeds ${MAX_TREE_REQUESTS} tree requests`)
    const value = await fetchTree(sha)
    const payload = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined
    if (payload?.truncated !== false || !Array.isArray(payload.tree)) throw new Error('repository evidence tree is incomplete')
    if (result.length + payload.tree.length > MAX_TREE_ENTRIES) throw new Error(`repository evidence tree exceeds ${MAX_TREE_ENTRIES} entries`)
    const entries: Record<string, unknown>[] = []
    for (const item of payload.tree) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('repository evidence tree contains an invalid entry')
      const entry = item as Record<string, unknown>
      if (!cleanPath(entry.path) || entry.path.includes('/')) throw new Error('non-recursive evidence tree contains an unsafe path')
      entries.push(entry)
      result.push({ ...entry, path: path === '' ? entry.path : `${path}/${entry.path}` })
    }
    trees.set(path, entries)
  }
  async function visit(path: string): Promise<void> {
    if (path === '.' || trees.has(path)) return
    const parent = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    if (parent !== '') await visit(parent)
    const entry = trees.get(parent)?.find(item => item.path === posix.basename(path))
    if (entry?.type !== 'tree' || entry.mode !== '040000') return
    if (typeof entry.sha !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.sha)) throw new Error('repository evidence tree has an unsafe identity')
    await readTree(path, entry.sha)
  }
  await readTree('', rootSha)
  for (const path of [packageDirectory, '.github/workflows', 'docs',
    ...(packageDirectory === '.' ? [] : [`${packageDirectory}/docs`])]) await visit(path)
  return result
}

/** Select text evidence from an immutable Git tree; symlinks and submodules are never followed. */
export function selectDshEnvironmentDocumentSelection(packagePath: string | undefined, tree: readonly unknown[]): { paths: string[]; omittedCount: number } {
  if (tree.length > MAX_TREE_ENTRIES) throw new Error(`repository evidence tree exceeds ${MAX_TREE_ENTRIES} entries`)
  const packageDirectory = packagePath !== undefined && cleanPath(packagePath) ? posix.dirname(packagePath) : '.'
  const bases = new Set(['.', packageDirectory])
  const selected = new Map<string, number>()
  for (const value of tree) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') || !cleanPath(entry.path)) continue
    const path = entry.path
    const directory = posix.dirname(path)
    const name = posix.basename(path)
    let priority: number | undefined
    if (path === packagePath || path === 'package.json') priority = 0
    else if (bases.has(directory) && /^(?:\.nvmrc|\.node-version|\.tool-versions|mise\.toml)$/.test(name)) priority = 1
    else if (bases.has(directory) && /^README(?:[._-](?:en|EN|zh|zh-CN|zh_CN))?\.md$/i.test(name)) priority = 2
    else if (bases.has(directory) && /^(?:install\.(?:sh|ps1)|cordis\.patch\.ya?ml|pnpm-workspace\.ya?ml)$/.test(name)) priority = 3
    else if ((bases.has(directory) || [...bases].some(base => directory === (base === '.' ? 'docs' : `${base}/docs`)))
      && /^(?:compatibility|manual)(?:[._-][A-Za-z0-9_-]+)*\.md$/i.test(name)) priority = 3
    else if ([...bases].some(base => directory === (base === '.' ? 'docs' : `${base}/docs`))
      && /^(?:README|getting-started|quick-start|installation|install|setup|configuration|plugins)(?:[._-][A-Za-z0-9_-]+)*\.md$/i.test(name)) priority = 5
    else if (directory === '.github/workflows' && /\.ya?ml$/.test(name)) priority = 4
    else if (bases.has(directory) && /^README(?:[._-][A-Za-z0-9_-]+)*\.md$/i.test(name)) priority = 6
    if (priority !== undefined) selected.set(path, priority)
  }
  const ordered = [...selected].sort(([left, leftPriority], [right, rightPriority]) => (
    leftPriority - rightPriority || left.localeCompare(right)
  )).map(([path]) => path)
  return { paths: ordered.slice(0, MAX_DOCUMENTS), omittedCount: Math.max(0, ordered.length - MAX_DOCUMENTS) }
}

export function selectDshEnvironmentDocumentPaths(packagePath: string | undefined, tree: readonly unknown[]): string[] {
  return selectDshEnvironmentDocumentSelection(packagePath, tree).paths
}

/** Keep DSH's repository baseline identifiable and reserve space for it before plugin documents. */
export function mergeDshEnvironmentDocuments(
  pluginDocuments: readonly DshEnvironmentRecommendationDocument[],
  dshDocuments: readonly DshEnvironmentRecommendationDocument[],
): { documents: DshEnvironmentRecommendationDocument[]; omitted: string[] } {
  const documents: DshEnvironmentRecommendationDocument[] = []
  const omitted: string[] = []
  let bytes = 0
  for (const document of [
    ...dshDocuments.map(item => ({ path: `dsh-repository/${item.path}`, text: item.text })),
    ...pluginDocuments,
  ]) {
    const documentBytes = Buffer.byteLength(document.text)
    if (!cleanPath(document.path) || documentBytes > MAX_DOCUMENT_BYTES
      || documents.length >= MAX_DOCUMENTS || bytes + documentBytes > MAX_DOCUMENT_TOTAL_BYTES
      || documents.some(item => item.path === document.path)) {
      omitted.push(document.path)
      continue
    }
    documents.push(document)
    bytes += documentBytes
  }
  return { documents, omitted }
}
