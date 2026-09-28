// The Agent runner keeps observing while model turns are slow. This is the same
// exact, read-only broker hand; the model still owns review, recovery and conclusion.
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const tool = join(dirname(fileURLToPath(import.meta.url)), 'dsh-active-case-tool.mjs')

export async function performDshActiveAgentSupervisorWatch(control, targetId) {
  if (typeof control !== 'string' || control.length === 0
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(targetId ?? '')) {
    throw new Error('supervised Agent watch requires an exact case control and target')
  }
  const { stdout } = await execute(process.execPath, [tool, 'watch', '0'], {
    timeout: 35_000, maxBuffer: 600 * 1024,
    env: { RADAR_CASE_TARGET_ID: targetId, RADAR_CASE_CONTROL: control },
  })
  const response = JSON.parse(stdout)
  if (!/^[a-f0-9]{32}$/.test(response?.id ?? '') || response.ok !== true
    || typeof response.value?.status !== 'string' || response.value.status.length > 64
    || (response.value.launchId !== undefined && response.value.launchId !== null
      && !/^[a-f0-9]{32}$/.test(response.value.launchId))) {
    throw new Error('supervised Agent watch did not receive a bounded trusted broker result')
  }
  return { observedAt: new Date().toISOString(), status: response.value.status,
    ...(response.value.launchId === undefined ? {} : { launchId: response.value.launchId }) }
}

export async function supervisedDshActiveAgentSnapshot(readSnapshot, watch) {
  const current = await readSnapshot()
  const id = current?.launch?.id
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)
    || current?.launchResult?.id === id) return current
  await watch()
  return readSnapshot() // Include the runner's persisted observation in the next model input.
}

/** Keep the exact broker case observable even while a model turn has not yielded. */
export async function withDshActiveAgentTurnWatch(turn, watch, intervalMs = 10_000) {
  if (typeof turn !== 'function' || typeof watch !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 30_000) {
    throw new Error('during-turn Agent watch requires a bounded cadence and exact callbacks')
  }
  let active = true, inFlight, watchFailure
  const tick = () => {
    if (!active || inFlight || watchFailure !== undefined) return
    inFlight = Promise.resolve().then(watch).catch(error => { watchFailure = error })
      .finally(() => { inFlight = undefined })
  }
  const timer = setInterval(tick, intervalMs)
  let result, turnFailure
  try { result = await turn() }
  catch (error) { turnFailure = error }
  active = false
  clearInterval(timer)
  if (inFlight) await inFlight
  if (turnFailure !== undefined) throw turnFailure
  if (watchFailure !== undefined) throw watchFailure
  return result
}
