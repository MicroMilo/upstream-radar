/** A YOLO agent may request only these bounded operations from the trusted broker. */
export interface DshActiveCaseRequest {
  schema: 'upstream-radar.dsh-active-case-request/v1alpha1'
  id: string
  targetId: string
  action: 'review' | 'recommend' | 'evidence' | 'network' | 'launch' | 'watch' | 'inspect' | 'cancel'
    | 'build-review' | 'build' | 'surface-build-review' | 'surface-build' | 'conclude'
  input: Record<string, unknown>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function parseDshActiveCaseRequest(value: unknown, expectedTargetId: string): DshActiveCaseRequest {
  const item = object(value, 'agent request')
  if (Object.keys(item).some(key => !['schema', 'id', 'targetId', 'action', 'input'].includes(key))) throw new Error('agent request has unexpected keys')
  if (item.schema !== 'upstream-radar.dsh-active-case-request/v1alpha1'
    || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id)) throw new Error('invalid agent request identity')
  if (typeof expectedTargetId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(expectedTargetId)
    || item.targetId !== expectedTargetId) throw new Error('agent request targets a different plugin')
  if (!['review', 'recommend', 'evidence', 'network', 'launch', 'watch', 'inspect', 'cancel', 'build-review', 'build',
    'surface-build-review', 'surface-build', 'conclude'].includes(String(item.action))) throw new Error('agent request action is unsupported')
  const input = object(item.input, 'agent request input')
  const allowed = item.action === 'recommend' ? ['decision'] : item.action === 'evidence' ? ['path', 'offset']
    : item.action === 'network' ? ['route'] : item.action === 'watch' ? ['cursor']
    : item.action === 'inspect' ? ['kind'] : item.action === 'cancel' ? ['containerName', 'taskKey']
      : item.action === 'build-review' || item.action === 'surface-build-review' ? ['caseId']
        : item.action === 'build' || item.action === 'surface-build' ? ['caseId', 'decision']
        : item.action === 'conclude' ? ['launchId', 'statement', 'coverageNotes'] : []
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('agent request input has unexpected keys')
  if (item.action === 'recommend' && (Object.keys(input).length !== 1 || typeof input.decision !== 'object' || input.decision === null || Array.isArray(input.decision))) throw new Error('recommend action requires one decision object')
  if (item.action === 'evidence' && ((Object.keys(input).length !== 1 && Object.keys(input).length !== 2)
    || typeof input.path !== 'string'
    || input.path.length < 1 || input.path.length > 512 || input.path.startsWith('/')
    || input.path.includes('\\') || input.path.includes('://') || /^[a-z]+:/i.test(input.path)
    || /[\u0000-\u001f\u007f]/.test(input.path)
    || input.path.split('/').some(part => part === '' || part === '.' || part === '..')
    || (input.offset !== undefined && (!Number.isSafeInteger(input.offset)
      || (input.offset as number) < 0 || (input.offset as number) > 256 * 1024)))) {
    throw new Error('evidence action requires one clean bounded repository-relative path and optional byte offset')
  }
  if (item.action === 'network' && (Object.keys(input).length !== 1 || !['direct', 'configured-proxy', 'recovery-proxy'].includes(String(input.route)))) throw new Error('network action requires an operator-preconfigured route')
  if (item.action === 'watch' && (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.cursor) || (input.cursor as number) < 0 || (input.cursor as number) > 1_000_000)) throw new Error('watch action requires a bounded cursor')
  if (item.action === 'inspect' && input.kind !== undefined && !['native', 'surface', 'adapter'].includes(String(input.kind))) throw new Error('inspect action kind is unsupported')
  if (item.action === 'cancel' && (typeof input.containerName !== 'string' || !/^radar-batch-[a-z0-9-]{1,80}$/.test(input.containerName)
    || typeof input.taskKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.taskKey))) throw new Error('cancel action requires an exact owned handle')
  if ((item.action === 'build-review' || item.action === 'build'
    || item.action === 'surface-build-review' || item.action === 'surface-build')
    && (typeof input.caseId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.caseId))) {
    throw new Error('dependency-build action requires an exact bounded caseId')
  }
  if ((item.action === 'build-review' || item.action === 'surface-build-review')
    && Object.keys(input).length !== 1) throw new Error('build-review accepts only the caseId')
  if ((item.action === 'build' || item.action === 'surface-build')
    && (Object.keys(input).length !== 2 || typeof input.decision !== 'object'
    || input.decision === null || Array.isArray(input.decision))) throw new Error('build requires one bounded decision object')
  if (item.action === 'conclude' && (Object.keys(input).length !== 3
    || typeof input.launchId !== 'string' || !/^[a-f0-9]{32}$/.test(input.launchId)
    || typeof input.statement !== 'string' || !Array.isArray(input.coverageNotes))) {
    throw new Error('conclude requires the exact launch and a bounded attribution statement')
  }
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(item)) } catch { throw new Error('agent request is not serializable') }
  if (bytes > 64 * 1024) throw new Error('agent request exceeds its byte budget')
  return item as unknown as DshActiveCaseRequest
}
