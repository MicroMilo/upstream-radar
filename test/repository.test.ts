import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseGitHubRepositoryUrl } from '../src/repository.js'

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
})
