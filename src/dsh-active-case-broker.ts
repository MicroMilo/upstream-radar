import { parseDshActiveCaseRequest } from './dsh-active-case-protocol.js'
import {
  createDshEnvironmentRecommendationInputFingerprint, DSH_ENVIRONMENT_REVIEW_CONTRACT,
  parseDshEnvironmentRecommendationDecision, parseDshEnvironmentRecommendations,
  renderDshEnvironmentRecommendationPrompt,
  type DshEnvironmentRecommendationCandidate, type DshEnvironmentRecommendations,
} from './dsh-environment-recommendation.js'

interface DshActiveCaseBrokerOptions {
  candidate: DshEnvironmentRecommendationCandidate
  state: unknown
  save: (state: DshEnvironmentRecommendations) => Promise<void>
  fetchEvidence?: (input: { path: string; offset?: number }) => Promise<unknown>
  selectNetworkRoute: (route: 'direct' | 'configured-proxy' | 'recovery-proxy') => Promise<unknown>
  launch: () => Promise<unknown>
  watch: (cursor: number) => Promise<unknown>
  inspect: (kind?: 'native' | 'surface' | 'adapter') => Promise<unknown>
  cancel: (containerName: string, taskKey: string) => Promise<unknown>
  reviewBuild?: (caseId: string) => Promise<unknown>
  decideBuild?: (caseId: string, decision: unknown) => Promise<unknown>
  reviewSurfaceBuild?: (caseId: string) => Promise<unknown>
  decideSurfaceBuild?: (caseId: string, decision: unknown) => Promise<unknown>
  conclude?: (input: unknown) => Promise<unknown>
}

/** The broker has Docker control; the YOLO agent has only this named protocol. */
export function createDshActiveCaseBroker(options: DshActiveCaseBrokerOptions) {
  const candidate = options.candidate
  const inputFingerprint = createDshEnvironmentRecommendationInputFingerprint(candidate)
  let state = parseDshEnvironmentRecommendations(options.state)
  let initialized = false
  let recommendationReady = state.entries.some(entry => entry.targetId === candidate.targetId
    && entry.inputFingerprint === inputFingerprint && entry.reviewContract === DSH_ENVIRONMENT_REVIEW_CONTRACT
    && entry.status === 'recommended')
  return {
    async initialize() {
      if (initialized) return
      if (!recommendationReady && !state.pendingTasks.some(task => task.targetId === candidate.targetId && task.inputFingerprint === inputFingerprint)) {
        const at = new Date().toISOString()
        state = parseDshEnvironmentRecommendations({ ...state, updatedAt: at,
          pendingTasks: [...state.pendingTasks.filter(task => task.targetId !== candidate.targetId), {
            targetId: candidate.targetId, plugin: candidate.plugin, dshVersion: candidate.dshVersion,
            sourceFingerprint: candidate.sourceFingerprint, inputFingerprint, createdAt: at,
          }] })
        await options.save(state) // Before any agent action is delivered.
      }
      initialized = true
    },
    async handle(value: unknown): Promise<unknown> {
      if (!initialized) throw new Error('active case task must be persisted before agent delivery')
      const request = parseDshActiveCaseRequest(value, candidate.targetId)
      const input = request.input
      if (request.action === 'review') return { targetId: candidate.targetId, plugin: candidate.plugin,
        dshVersion: candidate.dshVersion, inputFingerprint,
        guidance: renderDshEnvironmentRecommendationPrompt(candidate) }
      if (request.action === 'evidence') {
        if (!options.fetchEvidence) throw new Error('supplemental repository evidence is unavailable for this exact case')
        return options.fetchEvidence({ path: input.path as string,
          ...(input.offset === undefined ? {} : { offset: input.offset as number }) })
      }
      if (request.action === 'recommend') {
        const previous = state.entries.find(entry => entry.targetId === candidate.targetId)
        const decision = parseDshEnvironmentRecommendationDecision(input.decision, candidate, previous)
        const at = new Date().toISOString()
        const entry = { ...decision, reviewContract: DSH_ENVIRONMENT_REVIEW_CONTRACT,
          targetId: candidate.targetId, plugin: candidate.plugin, dshVersion: candidate.dshVersion,
          ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
          ...(candidate.sourceCommit === undefined ? {} : { sourceCommit: candidate.sourceCommit }),
          sourceFingerprint: candidate.sourceFingerprint, inputFingerprint,
          plannedAt: at, model: 'codex-yolo-active-case' }
        const next = parseDshEnvironmentRecommendations({ ...state, updatedAt: at,
          entries: [...state.entries.filter(item => item.targetId !== candidate.targetId), entry],
          pendingTasks: state.pendingTasks.filter(task => task.targetId !== candidate.targetId) })
        await options.save(next)
        state = next
        recommendationReady = decision.status === 'recommended'
        return { accepted: true, status: decision.status, nodeMajors: decision.nodeMajors,
          executionProfiles: decision.executionProfiles, inputFingerprint }
      }
      if (request.action === 'launch') {
        if (!recommendationReady) throw new Error('an evidenced Node/profile recommendation is required before execution')
        return options.launch()
      }
      if (request.action === 'network') return options.selectNetworkRoute(input.route as 'direct' | 'configured-proxy' | 'recovery-proxy')
      if (request.action === 'watch') return options.watch(input.cursor as number)
      if (request.action === 'inspect') return options.inspect(input.kind as 'native' | 'surface' | 'adapter' | undefined)
      if (request.action === 'cancel') return options.cancel(input.containerName as string, input.taskKey as string)
      if (request.action === 'build-review') {
        if (!options.reviewBuild) throw new Error('dependency-build review is not available in this case')
        return options.reviewBuild(input.caseId as string)
      }
      if (request.action === 'build') {
        if (!options.decideBuild) throw new Error('dependency-build decision is not available in this case')
        return options.decideBuild(input.caseId as string, input.decision)
      }
      if (request.action === 'surface-build-review') {
        if (!options.reviewSurfaceBuild) throw new Error('surface-build review is not available in this case')
        return options.reviewSurfaceBuild(input.caseId as string)
      }
      if (request.action === 'surface-build') {
        if (!options.decideSurfaceBuild) throw new Error('surface-build decision is not available in this case')
        return options.decideSurfaceBuild(input.caseId as string, input.decision)
      }
      if (request.action === 'conclude') {
        if (!options.conclude) throw new Error('an Agent conclusion is not available in this case')
        return options.conclude(input)
      }
      throw new Error('unsupported active case action')
    },
  }
}
