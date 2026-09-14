import type { DshWebBundleCapture } from './dsh-web-package-provenance.js'

/** Self-contained so Playwright can serialize it into the authenticated page.
 * Nothing from a target module is imported into the scanner. Responses contribute
 * only bounded digests; redirects and other origins are not evidence sources.
 */
export async function captureDshWebBundles(input: { baseUrl: string; entries: Array<{ id: string; url: string }> }): Promise<DshWebBundleCapture[]> {
  const value = globalThis as unknown as {
    fetch(url: string, options: { credentials: string; redirect: string; signal: unknown }): Promise<{ status: number;
      body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null }>
    crypto: { subtle: { digest(algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> } }
    AbortSignal: { timeout(ms: number): unknown }
  }
  const base = new URL(input.baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('bundle origin must be credential-free loopback')
  if (input.entries.length > 512) throw new Error('bundle roster entry budget exceeded')
  const captures: DshWebBundleCapture[] = []
  const deadline = Date.now() + 30_000
  let totalBytes = 0
  for (const row of input.entries) {
    if (typeof row.id !== 'string' || row.id.length > 214 || typeof row.url !== 'string' || row.url.length > 2048) throw new Error('bundle row budget exceeded')
    let status = 0
    try {
      const url = new URL(row.url, base)
      if (url.origin !== base.origin || url.username || url.password) throw new Error('bundle origin does not match the authenticated page')
      const remaining = deadline - Date.now()
      if (remaining <= 0 || totalBytes >= 64 * 1024 * 1024) throw new Error('bundle collection time or byte budget exceeded')
      const response = await value.fetch(url.href, { credentials: 'same-origin', redirect: 'error', signal: value.AbortSignal.timeout(Math.min(remaining, 7000)) })
      status = response.status
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('bundle body is unavailable')
      let bytes = 0
      const chunks: Uint8Array[] = []
      try {
        if (status === 200) {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            if (chunk.value === undefined) throw new Error('bundle body is incomplete')
            bytes += chunk.value.length
            totalBytes += chunk.value.length
            if (bytes > 8 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024 || Date.now() > deadline) throw new Error('bundle collection time or byte budget exceeded')
            chunks.push(chunk.value)
          }
        }
      } finally { await reader.cancel().catch(() => {}) }
      if (status !== 200) { captures.push({ ...row, status }); continue }
      if (bytes === 0) throw new Error('bundle body is empty')
      const body = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
      const digest = new Uint8Array(await value.crypto.subtle.digest('SHA-256', body))
      captures.push({ id: row.id, url: row.url, status, bytes, sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      captures.push({ id: row.id, url: row.url, status, error: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) || 'bundle collection failed' })
    }
  }
  return captures
}
