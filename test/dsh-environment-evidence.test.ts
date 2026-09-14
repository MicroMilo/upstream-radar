import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectDshEnvironmentEvidenceTree, mergeDshEnvironmentDocuments, selectDshEnvironmentDocumentPaths, selectDshEnvironmentDocumentSelection } from '../src/dsh-environment-evidence.js'

const blob = (path: string, mode = '100644') => ({ path, mode, type: 'blob' })

describe('bounded repository environment document discovery', () => {
  it('collects author compatibility and manual workflows ahead of excess CI files', () => {
    const selected = selectDshEnvironmentDocumentPaths('package.json', [
      blob('docs/COMPATIBILITY.md'), blob('MANUAL.md'), blob('docs/manual.zh-CN.md'),
      blob('docs/architecture.md'),
      ...Array.from({ length: 30 }, (_, index) => blob(`.github/workflows/ci-${index}.yml`)),
    ])
    assert.ok(selected.includes('docs/COMPATIBILITY.md'))
    assert.ok(selected.includes('MANUAL.md'))
    assert.ok(selected.includes('docs/manual.zh-CN.md'))
    assert.ok(!selected.includes('docs/architecture.md'))
    assert.equal(selected.length, 24)
  })

  it('reports file-count omissions instead of silently presenting a truncated selection as complete', () => {
    const selection = selectDshEnvironmentDocumentSelection('package.json', Array.from({ length: 30 }, (_, index) => blob(`.github/workflows/ci-${index}.yml`)))
    assert.equal(selection.paths.length, 24)
    assert.equal(selection.omittedCount, 6)
  })

  it('discovers real README variants, install instructions and non-conventional workflow names', () => {
    const selected = selectDshEnvironmentDocumentPaths('package.json', [
      blob('package.json'), blob('README.md'), blob('README_EN.md'), blob('README.zh.md'),
      blob('install.sh', '100755'), blob('docs/getting-started.md'),
      blob('docs/getting-started.en.md'), blob('.github/workflows/pr-gate.yml'),
      blob('.github/workflows/release-bundle.yaml'), blob('src/index.ts'),
      blob('docs/roadmap.md'), blob('assets/readme.png'),
    ])
    assert.deepEqual(new Set(selected), new Set([
      'package.json', 'README.md', 'README_EN.md', 'README.zh.md', 'install.sh',
      'docs/getting-started.md', 'docs/getting-started.en.md',
      '.github/workflows/pr-gate.yml', '.github/workflows/release-bundle.yaml',
    ]))
  })

  it('keeps package-local evidence while never selecting links, submodules or unsafe paths', () => {
    const selected = selectDshEnvironmentDocumentPaths('packages/plugin/package.json', [
      blob('package.json'), blob('packages/plugin/package.json'),
      blob('packages/plugin/.nvmrc'), blob('packages/plugin/README.en.md'),
      blob('.node-version', '120000'), blob('../README.md'), blob('/README.md'),
      { path: 'docs', type: 'commit', mode: '160000' },
      blob('packages/other/README.md'),
    ])
    assert.deepEqual(new Set(selected), new Set([
      'package.json', 'packages/plugin/package.json',
      'packages/plugin/.nvmrc', 'packages/plugin/README.en.md',
    ]))
  })

  it('bounds selected files, retains setup evidence ahead of excess workflows and is order-independent', () => {
    const files = [blob('README.md'), blob('.nvmrc'), blob('package.json'),
      ...Array.from({ length: 80 }, (_, index) => blob(`.github/workflows/job-${index}.yml`))]
    const selected = selectDshEnvironmentDocumentPaths('package.json', files)
    assert.equal(selected.length, 24)
    assert.ok(selected.includes('README.md'))
    assert.ok(selected.includes('.nvmrc'))
    assert.deepEqual(selected, selectDshEnvironmentDocumentPaths('package.json', files.reverse()))
    assert.throws(() => selectDshEnvironmentDocumentPaths('package.json', Array(10_001).fill(blob('README.md'))), /10000/)
  })

  it('prioritizes canonical setup and CI ahead of redundant translated READMEs', () => {
    const selected = selectDshEnvironmentDocumentPaths('package.json', [
      blob('README.de.md'), blob('README.fr.md'), blob('README.md'),
      blob('README.zh.md'), blob('.github/workflows/check.yml'),
      blob('docs/getting-started.md'),
    ])
    assert.ok(selected.indexOf('README.md') < selected.indexOf('README.de.md'))
    assert.ok(selected.indexOf('.github/workflows/check.yml') < selected.indexOf('README.de.md'))
    assert.ok(selected.indexOf('docs/getting-started.md') < selected.indexOf('README.fr.md'))
  })

  it('includes DSH repository baseline separately without exceeding shared file or UTF-8 budgets', () => {
    const merged = mergeDshEnvironmentDocuments(
      Array.from({ length: 24 }, (_, index) => ({ path: `doc-${index}.md`, text: '插件'.repeat(8_000) })),
      [{ path: 'package.json', text: '{"engines":{"node":"^22.19 || >=24"}}' }],
    )
    assert.equal(merged.documents[0]?.path, 'dsh-repository/package.json')
    assert.ok(merged.documents.length <= 24)
    assert.ok(merged.documents.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0) <= 192 * 1024)
    assert.ok(merged.omitted.length > 0)
  })

  it('enumerates only evidence directories instead of downloading a large recursive source tree', async () => {
    const directory = (path: string, sha: string) => ({ path, sha, type: 'tree', mode: '040000' })
    const trees: Record<string, unknown[]> = {
      root: [blob('package.json'), directory('apps', 'apps'), directory('.github', 'github'),
        directory('docs', 'docs'), directory('vendor', 'never-fetch'), blob('.node-version', '120000')],
      apps: [directory('cli', 'cli')],
      cli: [blob('package.json'), blob('README.md')],
      github: [directory('workflows', 'workflows')],
      workflows: [blob('node-compat.yaml')],
      docs: [blob('getting-started.md')],
    }
    const requests: string[] = []
    const tree = await collectDshEnvironmentEvidenceTree('apps/cli/package.json', 'root', async sha => {
      requests.push(sha)
      assert.ok(trees[sha], `unexpected tree request ${sha}`)
      return { truncated: false, tree: trees[sha] }
    })
    assert.ok(!requests.includes('never-fetch'))
    const paths = selectDshEnvironmentDocumentPaths('apps/cli/package.json', tree)
    assert.ok(paths.includes('apps/cli/README.md'))
    assert.ok(paths.includes('.github/workflows/node-compat.yaml'))
    assert.ok(paths.includes('docs/getting-started.md'))
    await assert.rejects(collectDshEnvironmentEvidenceTree('package.json', 'root', async () => ({
      truncated: true, tree: [],
    })), /incomplete/)
  })
})
