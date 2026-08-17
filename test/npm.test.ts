import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import { describe, it } from 'node:test'
import {
  inspectNpmPackage,
  parseNpmSpec,
  verifyIntegrity,
  verifyRegistrySignatures,
} from '../src/npm.js'
import { makeTarball } from './helpers/tar.js'

describe('npm artifact inspection', () => {
  it('requires an exact npm version', () => {
    assert.deepEqual(parseNpmSpec('npm:@scope/plugin@1.2.3-rc.1'), {
      name: '@scope/plugin',
      version: '1.2.3-rc.1',
      canonical: 'npm:@scope/plugin@1.2.3-rc.1',
    })
    assert.deepEqual(parseNpmSpec('@scope/plugin@1.2.3-rc.1'), {
      name: '@scope/plugin',
      version: '1.2.3-rc.1',
      canonical: 'npm:@scope/plugin@1.2.3-rc.1',
    })
    assert.deepEqual(parseNpmSpec('plugin@1.2.3'), {
      name: 'plugin',
      version: '1.2.3',
      canonical: 'npm:plugin@1.2.3',
    })
    assert.throws(() => parseNpmSpec('npm:plugin@latest'), /must be exact/)
    assert.throws(() => parseNpmSpec('npm:plugin@^1.0.0'), /must be exact/)
    assert.throws(() => parseNpmSpec(`npm:${'a'.repeat(215)}@1.0.0`), /exceeds 214 bytes/)
  })

  it('verifies subresource integrity against exact bytes', () => {
    const contents = Buffer.from('review these bytes')
    const expected = createHash('sha512').update(contents).digest('base64')
    assert.equal(verifyIntegrity(contents, `sha512-${expected}`).status, 'verified')
    assert.equal(verifyIntegrity(Buffer.from('different'), `sha512-${expected}`).status, 'invalid')
  })

  it('verifies npm ECDSA registry signatures', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const der = publicKey.export({ format: 'der', type: 'spki' })
    const keyid = `SHA256:${createHash('sha256').update(der).digest('base64')}`
    const integrity = `sha512-${createHash('sha512').update('artifact').digest('base64')}`
    const message = Buffer.from(`demo-plugin@1.0.0:${integrity}`)
    const signature = sign('sha256', message, privateKey).toString('base64')

    const result = verifyRegistrySignatures(
      'demo-plugin',
      '1.0.0',
      integrity,
      [{ keyid, sig: signature }],
      [{ keyid, key: der.toString('base64'), keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: null }],
    )
    assert.equal(result.status, 'verified')
  })

  it('rejects a signature made after its registry key expired', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const der = publicKey.export({ format: 'der', type: 'spki' })
    const keyid = 'test-expired-key'
    const integrity = `sha512-${createHash('sha512').update('artifact').digest('base64')}`
    const signature = sign('sha256', Buffer.from(`demo-plugin@1.0.0:${integrity}`), privateKey).toString('base64')

    const result = verifyRegistrySignatures(
      'demo-plugin',
      '1.0.0',
      integrity,
      [{ keyid, sig: signature }],
      [{ keyid, key: der.toString('base64'), keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: '2025-01-01T00:00:00.000Z' }],
      '2025-01-02T00:00:00.000Z',
    )
    assert.equal(result.status, 'invalid')
  })

  it('fetches, authenticates and scans the exact published tarball', async () => {
    const tarball = makeTarball([
      {
        path: 'package/package.json',
        contents: JSON.stringify({
          name: 'demo-plugin',
          version: '1.0.0',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      },
      { path: 'package/cordis.patch.yml', contents: 'name: demo-plugin\n' },
    ])
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const der = publicKey.export({ format: 'der', type: 'spki' })
    const keyid = `SHA256:${createHash('sha256').update(der).digest('base64')}`
    const signature = sign('sha256', Buffer.from(`demo-plugin@1.0.0:${integrity}`), privateKey).toString('base64')
    const packument = {
      versions: {
        '1.0.0': {
          name: 'demo-plugin',
          version: '1.0.0',
          dist: {
            integrity,
            shasum: createHash('sha1').update(tarball).digest('hex'),
            tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz?temporary-token=redacted',
            signatures: [{ keyid, sig: signature }],
          },
        },
      },
    }
    const keys = {
      keys: [{ keyid, key: der.toString('base64'), keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: null }],
    }
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/demo-plugin')) return Response.json(packument)
      if (url.endsWith('/-/npm/v1/keys')) return Response.json(keys)
      if (new URL(url).pathname.endsWith('.tgz')) return new Response(new Uint8Array(tarball), { headers: { 'content-type': 'application/octet-stream' } })
      return new Response('not found', { status: 404 })
    }

    const report = await inspectNpmPackage('npm:demo-plugin@1.0.0', { fetch: fetcher })
    assert.equal(report.target.kind, 'npm')
    assert.equal(report.dsh.isBundle, true)
    assert.equal(report.coverage.artifactIntegrity, 'verified')
    assert.equal(report.coverage.registrySignature, 'verified')
    assert.equal(report.coverage.provenance, 'missing')
    assert.match(report.findings.find(finding => finding.code === 'npm-provenance-missing')?.remediation ?? '', /NPM_CONFIG_PROVENANCE=true/)
    assert.equal(report.evidence.npm?.tarball, 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz')
    assert.equal(report.riskVerdict, 'warn')
    assert.equal(report.verdict, 'review')
  })

  it('blocks before parsing when downloaded bytes fail registry integrity', async () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"tampered","version":"1.0.0"}' },
    ])
    const expectedIntegrity = `sha512-${createHash('sha512').update('different bytes').digest('base64')}`
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/tampered')) {
        return Response.json({
          versions: {
            '1.0.0': {
              name: 'tampered',
              version: '1.0.0',
              dist: {
                integrity: expectedIntegrity,
                tarball: 'https://registry.npmjs.org/tampered/-/tampered-1.0.0.tgz',
                signatures: [],
              },
            },
          },
        })
      }
      if (url.endsWith('/-/npm/v1/keys')) return Response.json({ keys: [] })
      if (url.endsWith('.tgz')) return new Response(new Uint8Array(tarball))
      return new Response('not found', { status: 404 })
    }

    const report = await inspectNpmPackage('npm:tampered@1.0.0', { fetch: fetcher })
    assert.equal(report.coverage.artifactIntegrity, 'invalid')
    assert.equal(report.riskVerdict, 'block')
    assert.equal(report.evidence.filesScanned, 0)
    assert.ok(report.findings.some(finding => finding.code === 'npm-integrity-mismatch'))
  })

  it('keeps the requested registry identity when the tarball manifest lies', async () => {
    const tarball = makeTarball([
      { path: 'package/package.json', contents: '{"name":"evil\\nname","version":"9.9.9"}' },
    ])
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const fetcher = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/expected-name')) {
        return Response.json({
          versions: {
            '1.0.0': {
              name: 'expected-name',
              version: '1.0.0',
              dist: {
                integrity,
                tarball: 'https://registry.npmjs.org/expected-name/-/expected-name-1.0.0.tgz',
                signatures: [],
              },
            },
          },
        })
      }
      if (url.endsWith('/-/npm/v1/keys')) return Response.json({ keys: [] })
      if (url.endsWith('.tgz')) return new Response(new Uint8Array(tarball))
      return new Response('not found', { status: 404 })
    }

    const report = await inspectNpmPackage('npm:expected-name@1.0.0', { fetch: fetcher })
    assert.equal(report.target.name, 'expected-name')
    assert.equal(report.target.version, '1.0.0')
    assert.ok(report.findings.some(finding => finding.code === 'npm-manifest-identity-mismatch'))
  })

  it('rejects registry URLs that could leak embedded secrets', async () => {
    await assert.rejects(
      inspectNpmPackage('npm:demo-plugin@1.0.0', { registry: 'https://registry.example.test/?token=secret' }),
      /must not contain credentials, a query string or a fragment/,
    )
  })
})
