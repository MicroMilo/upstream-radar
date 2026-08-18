import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRepositoryScanRoot, parseGitHubRepositoryUrl } from '../src/repository.js'

describe('GitHub repository target', () => {
  it('normalizes a public repository URL without accepting credentials or refs', () => {
    assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/MicroMilo/upstream-radar'), {
      owner: 'MicroMilo',
      repository: 'upstream-radar',
      url: 'https://github.com/MicroMilo/upstream-radar.git',
    })
    assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/MicroMilo/upstream-radar.git'), {
      owner: 'MicroMilo',
      repository: 'upstream-radar',
      url: 'https://github.com/MicroMilo/upstream-radar.git',
    })
    assert.equal(parseGitHubRepositoryUrl('https://user:secret@github.com/MicroMilo/upstream-radar'), undefined)
    assert.equal(parseGitHubRepositoryUrl('https://github.com/MicroMilo/upstream-radar/tree/main'), undefined)
    assert.equal(parseGitHubRepositoryUrl('https://gitlab.com/MicroMilo/upstream-radar'), undefined)
  })

  it('finds the only DSH plugin when a repository keeps it in a subdirectory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upstream-radar-repository-test-'))
    try {
      const plugin = join(root, 'plugin')
      await mkdir(plugin, { recursive: true })
      await writeFile(join(plugin, 'package.json'), JSON.stringify({
        name: 'nested-dsh-plugin',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      await writeFile(join(plugin, 'cordis.patch.yml'), 'name: nested-dsh-plugin\n')

      assert.deepEqual(await discoverRepositoryScanRoot(root), {
        root: plugin,
        relativeRoot: 'plugin',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
