/** Additional disabled/offline checks never replace the author's default startup. */
export interface DshStartupConfiguration {
  scope: string
  environment: Record<string, string>
}

export function parseDshStartupConfiguration(value: unknown): DshStartupConfiguration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('startup configuration must be an object')
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['scope', 'environment'].includes(key))) throw new Error('startup configuration contains unexpected fields')
  if (typeof item.scope !== 'string' || item.scope.trim() === '' || Buffer.byteLength(item.scope) > 512 || /[\u0000-\u001f\u007f]/.test(item.scope)) throw new Error('startup scope must be bounded non-empty text')
  if (typeof item.environment !== 'object' || item.environment === null || Array.isArray(item.environment)) throw new Error('startup environment must be an object')
  const entries = Object.entries(item.environment)
  if (entries.length === 0 || entries.length > 4) throw new Error('startup environment requires 1–4 bounded flags')
  const environment = Object.fromEntries(entries.map(([name, value]) => {
    // No paths, commands, credentials, service endpoints or host permission flags.
    if (!/^DSH_[A-Z][A-Z0-9_]{0,48}_(?:DISABLED|OFFLINE|NO_NETWORK)$/.test(name) || (value !== '1' && value !== 'true')) throw new Error('startup environment permits only explicit disabling/offline flags')
    return [name, value]
  }).sort(([left], [right]) => left!.localeCompare(right!)))
  return { scope: item.scope, environment }
}
