/** A previous batch summary never proves that the newest agent launch closed. */
export function resolveDshActiveCaseLaunchStatus(input: {
  running: boolean
  launchId?: string
  summaryLaunchId?: string
  exitLaunchId?: string
  exitCode?: number
}): 'running' | 'finished' | 'not-started' | 'failed' | 'interrupted' {
  if (input.running) return 'running'
  if (!input.launchId) return 'not-started'
  if (input.summaryLaunchId === input.launchId) return 'finished'
  if (input.exitLaunchId === input.launchId && Number.isSafeInteger(input.exitCode)) return 'failed'
  return 'interrupted'
}
