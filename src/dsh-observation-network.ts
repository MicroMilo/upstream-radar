/** Transport selected by the operator, never inherited from package metadata or host credentials. */
export function observationNetworkEnvironment(networkProxy: string | undefined): NodeJS.ProcessEnv {
  if (networkProxy === undefined) return {}
  const invalid = (): never => { throw new Error('observation networkProxy must be a credential-free HTTP proxy origin') }
  if (networkProxy.length === 0 || networkProxy.length > 2048) return invalid()
  let url: URL
  try { url = new URL(networkProxy) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.length === 0
    || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return invalid()
  return {
    HTTP_PROXY: url.href,
    HTTPS_PROXY: url.href,
    http_proxy: url.href,
    https_proxy: url.href,
    NODE_USE_ENV_PROXY: '1',
  }
}
