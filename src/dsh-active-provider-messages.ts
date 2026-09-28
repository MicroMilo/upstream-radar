export interface DshActiveProviderToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface DshActiveProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: DshActiveProviderToolCall[]
  tool_call_id?: string
}

/** Repair only the structurally unambiguous wrapper; the broker still applies
 * every semantic and repository-evidence check to the decision itself. */
export function normalizeDshActiveCaseAction(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const action = raw as Record<string, unknown>
  const input = action.input
  if (action.action === 'recommend' && typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const decision = input as Record<string, unknown>
    if (decision.decision === undefined && typeof decision.status === 'string') {
      return { ...action, input: { decision } }
    }
  }
  return raw
}

/** Remove only complete old turns. A provider tool response is never retained
 * without the assistant tool call it answers. */
export function compactDshActiveProviderMessages(messages: DshActiveProviderMessage[], turnStart: number,
  maximumBytes: number): { messages: DshActiveProviderMessage[]; turnStart: number } {
  if (!Array.isArray(messages) || !Number.isSafeInteger(turnStart) || turnStart < 1
    || turnStart >= messages.length || !Number.isSafeInteger(maximumBytes) || maximumBytes < 64 * 1024) {
    throw new Error('invalid provider conversation compaction input')
  }
  if (Buffer.byteLength(JSON.stringify(messages)) <= maximumBytes) return { messages, turnStart }
  const compacted: DshActiveProviderMessage = { role: 'system', content: 'Earlier complete turns were compacted. The trusted broker is the source of truth; call review, watch, or inspect again before acting. Never reuse a prior rejected recommendation.' }
  const currentTurn = messages.slice(turnStart)
  let retained = [messages[0]!, compacted, ...currentTurn]
  if (Buffer.byteLength(JSON.stringify(retained)) > maximumBytes) {
    let lastAssistant = -1
    for (let index = currentTurn.length - 1; index >= 1; index -= 1) {
      if (currentTurn[index]?.role === 'assistant') { lastAssistant = index; break }
    }
    retained = [messages[0]!, compacted, currentTurn[0]!,
      ...(lastAssistant < 0 ? [] : currentTurn.slice(lastAssistant))]
  }
  for (const [index, message] of retained.entries()) {
    if (message.role !== 'tool') continue
    const matchingAssistant = retained.slice(0, index).findLast(previous => previous.role === 'assistant'
      && previous.tool_calls?.some(call => call.id === message.tool_call_id))
    if (!matchingAssistant) throw new Error('conversation compaction would orphan a tool response')
  }
  return { messages: retained, turnStart: 2 }
}
