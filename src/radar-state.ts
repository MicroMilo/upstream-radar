import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { emptyRadarState } from './radar.js'
import {
  ANALYSIS_TASK_SCHEMA,
  ANALYSIS_DELIVERY_SCHEMA,
  ANALYSIS_RESULT_SCHEMA,
  MAX_RADAR_HISTORY_EVENTS,
  RADAR_EVENT_SCHEMA,
  RADAR_STATE_SCHEMA,
  WEBHOOK_DELIVERY_SCHEMA,
  type AnalysisDelivery,
  type AgentAnalysisResult,
  type StoredAnalysisResult,
  type RadarState,
} from './radar-types.js'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function validAffectedSources(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false
  const allowed = new Set(['profile', 'dsh-host'])
  return new Set(value).size === value.length && value.every(item => typeof item === 'string' && allowed.has(item))
}

function validAdvisorySources(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false
  const allowed = new Set(['osv', 'github-advisories'])
  return new Set(value).size === value.length && value.every(item => typeof item === 'string' && allowed.has(item))
}

function validAdvisoryConflicts(value: unknown, sourcesValue: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(sourcesValue)) return false
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return false
  const fields = value.map(raw => asRecord(raw)?.field)
  if (new Set(fields).size !== fields.length
    || fields.some(field => field !== 'severity' && field !== 'fixed-versions')) return false
  const allowedSources = new Set(['osv', 'github-advisories'])
  const declaredSources = new Set(sourcesValue)
  return value.every(raw => {
    const conflict = asRecord(raw)
    const claims = conflict?.claims
    if (!Array.isArray(claims) || claims.length < 2 || claims.length > 2) return false
    const sources = claims.map(claim => asRecord(claim)?.source)
    return new Set(sources).size === sources.length
      && sources.every(source => typeof source === 'string' && allowedSources.has(source))
      && sources.every(source => declaredSources.has(source))
      && claims.every(claim => {
        const item = asRecord(claim)
        return typeof item?.value === 'string' && item.value.length > 0 && item.value.length <= 1_024
      })
  })
}

function validAdvisoryRiskSignals(value: unknown): boolean {
  if (value === undefined) return true
  const signals = asRecord(value)
  if (signals === undefined) return false
  const cisaKev = signals.cisaKev === undefined ? undefined : asRecord(signals.cisaKev)
  const epss = signals.epss === undefined ? undefined : asRecord(signals.epss)
  if (cisaKev === undefined && epss === undefined) return false
  if (cisaKev !== undefined) {
    if (cisaKev.knownExploited !== true
      || (cisaKev.dateAdded !== undefined && (typeof cisaKev.dateAdded !== 'string' || cisaKev.dateAdded.length > 128))
      || (cisaKev.dueDate !== undefined && (typeof cisaKev.dueDate !== 'string' || cisaKev.dueDate.length > 128))
      || (cisaKev.knownRansomwareCampaignUse !== undefined
        && (typeof cisaKev.knownRansomwareCampaignUse !== 'string' || cisaKev.knownRansomwareCampaignUse.length > 128))
      || (cisaKev.requiredAction !== undefined
        && (typeof cisaKev.requiredAction !== 'string' || cisaKev.requiredAction.length > 8_192))
      || (cisaKev.notes !== undefined
        && (typeof cisaKev.notes !== 'string' || cisaKev.notes.length > 8_192))) return false
  }
  if (epss !== undefined) {
    if (typeof epss.score !== 'number' || !Number.isFinite(epss.score) || epss.score < 0 || epss.score > 1
      || typeof epss.percentile !== 'number' || !Number.isFinite(epss.percentile) || epss.percentile < 0 || epss.percentile > 1
      || (epss.date !== undefined && (typeof epss.date !== 'string' || epss.date.length > 64))) return false
  }
  return true
}

function validAffectedPlugins(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) return false
  const keys = value.map(item => validPackageCoordinate(item)
    ? `${(item as { ecosystem: string }).ecosystem}:${(item as { name: string }).name}@${(item as { version: string }).version}`
    : undefined)
  return keys.every(key => key !== undefined) && new Set(keys).size === keys.length
}

function validPackageCoordinate(value: unknown): boolean {
  const coordinate = asRecord(value)
  return coordinate?.ecosystem === 'npm'
    && typeof coordinate.name === 'string' && coordinate.name.length > 0 && coordinate.name.length <= 512
    && typeof coordinate.version === 'string' && coordinate.version.length > 0 && coordinate.version.length <= 512
}

function validCompatibilityDependencyCheck(value: unknown): boolean {
  const check = asRecord(value)
  const findings = check?.findings
  if ((check?.status !== 'checked' && check?.status !== 'incomplete' && check?.status !== 'unavailable')
    || typeof check.nodeCount !== 'number' || !Number.isSafeInteger(check.nodeCount) || check.nodeCount < 0 || check.nodeCount > 1_000_000
    || typeof check.unresolvedCount !== 'number' || !Number.isSafeInteger(check.unresolvedCount) || check.unresolvedCount < 0 || check.unresolvedCount > 1_000_000
    || !Array.isArray(findings) || findings.length > 32
    || (check.findingsTruncated !== undefined && typeof check.findingsTruncated !== 'boolean')
    || (check.error !== undefined && (typeof check.error !== 'string' || check.error.length > 2_048))) return false
  return findings.every(rawFinding => {
    const finding = asRecord(rawFinding)
    const advisory = asRecord(finding?.advisory)
    const paths = finding?.paths
    return validPackageCoordinate(finding?.package)
      && typeof advisory?.id === 'string' && advisory.id.length > 0 && advisory.id.length <= 256
      && typeof advisory.summary === 'string' && advisory.summary.length <= 8_192
      && typeof advisory.details === 'string' && advisory.details.length <= 64 * 1_024
      && (advisory.severity === 'unknown' || advisory.severity === 'info' || advisory.severity === 'low'
        || advisory.severity === 'medium' || advisory.severity === 'high' || advisory.severity === 'critical')
      && typeof advisory.modified === 'string' && advisory.modified.length <= 256
      && (advisory.published === undefined || (typeof advisory.published === 'string' && advisory.published.length <= 256))
      && (advisory.withdrawn === undefined || (typeof advisory.withdrawn === 'string' && advisory.withdrawn.length <= 256))
      && Array.isArray(advisory.aliases) && advisory.aliases.length <= 100
      && advisory.aliases.every(item => typeof item === 'string' && item.length <= 256)
      && Array.isArray(advisory.fixedVersions) && advisory.fixedVersions.length <= 128
      && advisory.fixedVersions.every(item => typeof item === 'string' && item.length <= 256)
      && Array.isArray(advisory.references) && advisory.references.length <= 100
      && advisory.references.every(item => typeof item === 'string' && item.length <= 4_096)
      && validAdvisorySources(advisory.sources)
      && validAdvisoryConflicts(advisory.conflicts, advisory.sources)
      && validAdvisoryRiskSignals(advisory.riskSignals)
      && Array.isArray(paths) && paths.length <= 4
      && paths.every(path => Array.isArray(path) && path.length > 0 && path.length <= 64 && path.every(validPackageCoordinate))
  })
}

function validCompatibilityVulnerabilityRemediation(value: unknown): boolean {
  const remediation = asRecord(value)
  const remainingPaths = remediation?.remainingPaths
  if (typeof remediation?.incidentId !== 'string' || remediation.incidentId.length === 0 || remediation.incidentId.length > 512
    || typeof remediation.advisoryId !== 'string' || remediation.advisoryId.length === 0 || remediation.advisoryId.length > 512
    || !validPackageCoordinate(remediation.affected)
    || (remediation.status !== 'removed' && remediation.status !== 'still-affected' && remediation.status !== 'unknown')
    || typeof remediation.reason !== 'string' || remediation.reason.length > 2_048
    || (remainingPaths !== undefined && (!Array.isArray(remainingPaths) || remainingPaths.length > 4))) return false
  return remainingPaths === undefined || remainingPaths.every(path => (
    Array.isArray(path) && path.length > 0 && path.length <= 64 && path.every(validPackageCoordinate)
  ))
}

function validCompatibilityUpgradeCandidate(value: unknown): boolean {
  const candidate = asRecord(value)
  const coordinate = asRecord(candidate?.candidate)
  const signals = candidate?.signals
  const dependencyCheck = candidate?.dependencyCheck
  const vulnerabilityRemediation = candidate?.vulnerabilityRemediation
  if (coordinate?.ecosystem !== 'npm'
    || typeof coordinate.name !== 'string' || coordinate.name.length === 0 || coordinate.name.length > 512
    || typeof coordinate.version !== 'string' || coordinate.version.length === 0 || coordinate.version.length > 512
    || !Array.isArray(signals) || signals.length > 64) return false
  if (dependencyCheck !== undefined && !validCompatibilityDependencyCheck(dependencyCheck)) return false
  if (vulnerabilityRemediation !== undefined
    && (!Array.isArray(vulnerabilityRemediation) || vulnerabilityRemediation.length > 32
      || !vulnerabilityRemediation.every(validCompatibilityVulnerabilityRemediation))) return false
  return signals.every(rawSignal => {
    const signal = asRecord(rawSignal)
    return typeof signal?.code === 'string' && signal.code.length > 0 && signal.code.length <= 256
      && (signal.confidence === 'confirmed' || signal.confidence === 'strong' || signal.confidence === 'needs-analysis')
      && typeof signal.summary === 'string' && signal.summary.length <= 2_048
      && (signal.before === undefined || (typeof signal.before === 'string' && signal.before.length <= 2_048))
      && (signal.after === undefined || (typeof signal.after === 'string' && signal.after.length <= 2_048))
  })
}

function validCompatibilityUpgradePath(value: unknown): boolean {
  if (value === undefined) return true
  const path = asRecord(value)
  const evaluated = path?.evaluated
  const blockedCount = path?.blockedCount
  const blocked = path?.blocked
  const vulnerabilityStatus = path?.vulnerabilityStatus
  const dependencyStatus = path?.dependencyStatus
  const uncheckedCount = path?.uncheckedCount
  const remediationCoverage = path?.remediationCoverage
  if (typeof evaluated !== 'number' || !Number.isSafeInteger(evaluated) || evaluated < 0 || evaluated > 1_000_000
    || typeof blockedCount !== 'number' || !Number.isSafeInteger(blockedCount) || blockedCount < 0 || blockedCount > evaluated
    // 0.17.0 upgrade paths did not have this field; treat those persisted paths as legacy.
    || (vulnerabilityStatus !== undefined
      && vulnerabilityStatus !== 'checked' && vulnerabilityStatus !== 'unavailable' && vulnerabilityStatus !== 'not-requested')
    || (dependencyStatus !== undefined
      && dependencyStatus !== 'checked' && dependencyStatus !== 'partial' && dependencyStatus !== 'unavailable' && dependencyStatus !== 'not-requested')
    || (remediationCoverage !== undefined
      && remediationCoverage !== 'checked' && remediationCoverage !== 'partial' && remediationCoverage !== 'unavailable' && remediationCoverage !== 'not-requested')
    || (uncheckedCount !== undefined
      && (typeof uncheckedCount !== 'number' || !Number.isSafeInteger(uncheckedCount) || uncheckedCount < 0 || uncheckedCount > evaluated))
    || !Array.isArray(blocked) || blocked.length > 8
    || (path?.firstCandidate !== undefined && !validCompatibilityUpgradeCandidate(path.firstCandidate))
    || (path?.firstCandidateRemovingAllPaths !== undefined && !validCompatibilityUpgradeCandidate(path.firstCandidateRemovingAllPaths))) return false
  return blocked.every(validCompatibilityUpgradeCandidate)
}

function validAnalysisResultFields(value: Record<string, unknown>): value is Record<string, unknown> & AgentAnalysisResult {
  const evidence = value.evidence
  return (value.project_exposure === 'exposed'
    || value.project_exposure === 'likely_exposed'
    || value.project_exposure === 'not_exposed'
    || value.project_exposure === 'unknown')
    && (value.confidence === 'high' || value.confidence === 'medium' || value.confidence === 'low')
    && (value.urgency === 'immediate'
      || value.urgency === 'within_24_hours'
      || value.urgency === 'planned'
      || value.urgency === 'monitor')
    && Array.isArray(evidence) && evidence.length <= 64
    && evidence.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 4_096)
    && typeof value.recommended_action === 'string'
    && value.recommended_action.trim().length > 0 && value.recommended_action.length <= 8_192
    && typeof value.reasoning_summary === 'string'
    && value.reasoning_summary.trim().length > 0 && value.reasoning_summary.length <= 16_384
}

function validAnalysisDelivery(value: unknown): value is AnalysisDelivery {
  const delivery = asRecord(value)
  const taskRefs = delivery?.taskRefs
  const expectedKeys = new Set([
    'schema', 'id', 'messageId', 'taskRefs', 'projectId', 'deliveredAt',
    ...(delivery?.agentId === undefined ? [] : ['agentId']),
    ...(delivery?.sessionId === undefined ? [] : ['sessionId']),
    ...(delivery?.userMessageId === undefined ? [] : ['userMessageId']),
    ...(delivery?.userMessageSeq === undefined ? [] : ['userMessageSeq']),
  ])
  if (delivery?.schema !== ANALYSIS_DELIVERY_SCHEMA
    || Object.keys(delivery).length !== expectedKeys.size
    || Object.keys(delivery).some(key => !expectedKeys.has(key))
    || typeof delivery.id !== 'string' || delivery.id.length === 0 || delivery.id.length > 512
    || typeof delivery.messageId !== 'string' || delivery.messageId.length === 0 || delivery.messageId.length > 512
    || typeof delivery.projectId !== 'string' || delivery.projectId.length === 0 || delivery.projectId.length > 512
    || typeof delivery.deliveredAt !== 'string' || delivery.deliveredAt.length > 256
    || !Array.isArray(taskRefs) || taskRefs.length === 0 || taskRefs.length > 64
    || (delivery.agentId !== undefined && (typeof delivery.agentId !== 'string' || delivery.agentId.length > 512))
    || (delivery.sessionId !== undefined && (typeof delivery.sessionId !== 'string' || delivery.sessionId.length > 512))
    || (delivery.userMessageId !== undefined && (typeof delivery.userMessageId !== 'string' || delivery.userMessageId.length > 512))
    || (delivery.userMessageSeq !== undefined
      && (typeof delivery.userMessageSeq !== 'number' || !Number.isSafeInteger(delivery.userMessageSeq) || delivery.userMessageSeq < 0))) {
    return false
  }
  const known = new Set<string>()
  return taskRefs.every(rawReference => {
    const reference = asRecord(rawReference)
    if (reference === undefined
      || typeof reference.taskId !== 'string' || reference.taskId.length === 0 || reference.taskId.length > 256
      || typeof reference.incidentId !== 'string' || reference.incidentId.length === 0 || reference.incidentId.length > 512
      || typeof reference.eventId !== 'string' || reference.eventId.length === 0 || reference.eventId.length > 512
      || known.has(reference.taskId)) return false
    known.add(reference.taskId)
    return true
  })
}

function validStoredAnalysisResult(value: unknown): value is StoredAnalysisResult {
  const result = asRecord(value)
  const expectedKeys = new Set([
    'schema', 'taskId', 'incidentId', 'eventId', 'deliveryId', 'receivedAt',
    'sessionId', 'userMessageId', 'assistantMessageId', 'project_exposure',
    'confidence', 'evidence', 'recommended_action', 'urgency', 'reasoning_summary',
  ])
  if (result === undefined || Object.keys(result).length !== expectedKeys.size
    || Object.keys(result).some(key => !expectedKeys.has(key))) return false
  return result?.schema === ANALYSIS_RESULT_SCHEMA
    && typeof result.taskId === 'string' && result.taskId.length > 0 && result.taskId.length <= 256
    && typeof result.incidentId === 'string' && result.incidentId.length > 0 && result.incidentId.length <= 512
    && typeof result.eventId === 'string' && result.eventId.length > 0 && result.eventId.length <= 512
    && typeof result.deliveryId === 'string' && result.deliveryId.length > 0 && result.deliveryId.length <= 512
    && typeof result.receivedAt === 'string' && result.receivedAt.length <= 256
    && typeof result.sessionId === 'string' && result.sessionId.length > 0 && result.sessionId.length <= 512
    && typeof result.userMessageId === 'string' && result.userMessageId.length > 0 && result.userMessageId.length <= 512
    && typeof result.assistantMessageId === 'string' && result.assistantMessageId.length > 0 && result.assistantMessageId.length <= 512
    && validAnalysisResultFields(result)
}

function validWebhookDeliveryState(value: unknown): boolean {
  const webhook = asRecord(value)
  const delivered = asRecord(webhook?.deliveredEventIds)
  const pending = webhook?.pendingEvents
  const expectedKeys = new Set([
    'schema',
    'endpointHash',
    'deliveredEventIds',
    ...(pending === undefined ? [] : ['pendingEvents']),
  ])
  if (webhook === undefined || Object.keys(webhook).length !== expectedKeys.size
    || Object.keys(webhook).some(key => !expectedKeys.has(key))
    || webhook.schema !== WEBHOOK_DELIVERY_SCHEMA
    || typeof webhook.endpointHash !== 'string' || !/^[a-f0-9]{64}$/.test(webhook.endpointHash)
    || delivered === undefined || Object.keys(delivered).length > 10_000
    || (pending !== undefined && (!Array.isArray(pending) || pending.length > 10_000))) return false
  if (pending !== undefined && !pending.every(validHistoryEvent)) return false
  return Object.entries(delivered).every(([eventId, deliveredAt]) => (
    eventId.length > 0 && eventId.length <= 512
      && typeof deliveredAt === 'string' && deliveredAt.length > 0 && deliveredAt.length <= 256
  ))
}

function validIncidentMutes(value: unknown): boolean {
  if (value === undefined) return true
  const mutes = asRecord(value)
  if (mutes === undefined || Object.keys(mutes).length > 100_000) return false
  return Object.entries(mutes).every(([incidentId, rawMute]) => {
    const mute = asRecord(rawMute)
    const mutedUntil = mute?.mutedUntil
    const eventId = mute?.eventId
    return incidentId.length > 0 && incidentId.length <= 512
      && typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 512
      && typeof mutedUntil === 'string' && mutedUntil.length > 0 && mutedUntil.length <= 256
      && Number.isFinite(Date.parse(mutedUntil))
  })
}

function validIncidentTriage(value: unknown): boolean {
  if (value === undefined) return true
  const triage = asRecord(value)
  if (triage === undefined || Object.keys(triage).length > 100_000) return false
  const statuses = new Set(['open', 'in-progress', 'blocked', 'accepted-risk'])
  return Object.entries(triage).every(([incidentId, rawRecord]) => {
    const record = asRecord(rawRecord)
    if (record === undefined) return false
    const expectedKeys = new Set([
      'eventId',
      'status',
      'updatedAt',
      ...(record.owner === undefined ? [] : ['owner']),
      ...(record.note === undefined ? [] : ['note']),
      ...(record.dueAt === undefined ? [] : ['dueAt']),
    ])
    if (Object.keys(record).length !== expectedKeys.size || Object.keys(record).some(key => !expectedKeys.has(key))) return false
    const note = record.note
    return incidentId.length > 0 && incidentId.length <= 512
      && typeof record.eventId === 'string' && record.eventId.length > 0 && record.eventId.length <= 512
      && typeof record.status === 'string' && statuses.has(record.status)
      && typeof record.updatedAt === 'string' && record.updatedAt.length > 0 && record.updatedAt.length <= 256
      && Number.isFinite(Date.parse(record.updatedAt))
      && (record.owner === undefined || (typeof record.owner === 'string' && record.owner.length > 0 && record.owner.length <= 512))
      && (note === undefined || (typeof note === 'string' && note.length > 0 && note.length <= 2_048))
      && (record.dueAt === undefined
        || (typeof record.dueAt === 'string' && record.dueAt.length > 0 && record.dueAt.length <= 256
          && Number.isFinite(Date.parse(record.dueAt))))
      && ((record.status !== 'blocked' && record.status !== 'accepted-risk') || note !== undefined)
  })
}

function validHistoryEvent(value: unknown): boolean {
  const event = asRecord(value)
  const project = asRecord(event?.project)
  const route = asRecord(event?.route)
  if (event?.schema !== RADAR_EVENT_SCHEMA
    || typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 512
    || typeof event.incidentId !== 'string' || event.incidentId.length === 0 || event.incidentId.length > 512
    || (event.change !== 'new' && event.change !== 'updated' && event.change !== 'resolved')
    || typeof event.detectedAt !== 'string' || event.detectedAt.length === 0 || event.detectedAt.length > 256
    || project?.id === undefined || typeof project.id !== 'string' || project.id.length === 0 || project.id.length > 512
    || project.name === undefined || typeof project.name !== 'string' || project.name.length === 0 || project.name.length > 2_048
    || !Array.isArray(route?.channels) || route.channels.length > 64
    || !route.channels.every(item => typeof item === 'string' && item.length > 0 && item.length <= 512)) return false

  if (event.kind === 'vulnerability' || event.kind === 'malware') {
    const advisory = asRecord(event.advisory)
    const paths = event.paths
    return validPackageCoordinate(event.plugin)
      && validAffectedPlugins(event.affectedPlugins)
      && validPackageCoordinate(event.affected)
      && Array.isArray(paths) && paths.length <= 64
      && paths.every(path => Array.isArray(path) && path.length > 0 && path.length <= 128 && path.every(validPackageCoordinate))
      && advisory?.id !== undefined && typeof advisory.id === 'string' && advisory.id.length > 0 && advisory.id.length <= 512
      && advisory.modified !== undefined && typeof advisory.modified === 'string' && advisory.modified.length > 0 && advisory.modified.length <= 256
      && (advisory.severity === 'unknown' || advisory.severity === 'info' || advisory.severity === 'low'
        || advisory.severity === 'medium' || advisory.severity === 'high' || advisory.severity === 'critical')
      && validAdvisorySources(advisory.sources)
      && validAdvisoryConflicts(advisory.conflicts, advisory.sources)
      && validAdvisoryRiskSignals(advisory.riskSignals)
  }
  if (event.kind === 'compatibility') {
    return validPackageCoordinate(event.plugin)
      && validPackageCoordinate(event.installed)
      && validPackageCoordinate(event.candidate)
      && Array.isArray(event.signals) && event.signals.length <= 64
      && event.signals.every(signal => {
        const item = asRecord(signal)
        return typeof item?.summary === 'string' && item.summary.length <= 2_048
      })
      && validCompatibilityUpgradePath(event.upgradePath)
  }
  if (event.kind === 'source-health') {
    return (event.source === 'osv' || event.source === 'github-advisories' || event.source === 'cisa-kev'
      || event.source === 'epss' || event.source === 'npm-releases'
      || event.source === 'npm-candidate-graphs' || event.source === 'github-releases')
      && (event.status === 'degraded' || event.status === 'healthy')
      && typeof event.failureCount === 'number' && Number.isSafeInteger(event.failureCount)
      && event.failureCount >= 0 && event.failureCount <= 1_000_000
      && typeof event.lastAttemptedAt === 'string' && event.lastAttemptedAt.length > 0 && event.lastAttemptedAt.length <= 256
  }
  return false
}

export function parseRadarState(value: unknown): RadarState {
  const root = asRecord(value)
  if (root?.schema !== RADAR_STATE_SCHEMA) throw new Error('radar state has an unsupported schema')
  const active = asRecord(root.activeVulnerabilities)
  if (active === undefined) throw new Error('radar state has no active vulnerability map')
  const activeCompatibility = asRecord(root.activeCompatibility)
  if (activeCompatibility === undefined) throw new Error('radar state has no active compatibility map')
  const sourceHealth = root.sourceHealth === undefined ? {} : asRecord(root.sourceHealth)
  if (sourceHealth === undefined) throw new Error('radar state has an invalid source health map')
  const activeSourceHealth = root.activeSourceHealth === undefined ? {} : asRecord(root.activeSourceHealth)
  if (activeSourceHealth === undefined) throw new Error('radar state has an invalid active source health map')
  const analysisDeliveries = root.analysisDeliveries === undefined ? {} : asRecord(root.analysisDeliveries)
  if (analysisDeliveries === undefined) throw new Error('radar state has an invalid analysis delivery map')
  const analysisResults = root.analysisResults === undefined ? {} : asRecord(root.analysisResults)
  if (analysisResults === undefined) throw new Error('radar state has an invalid analysis result map')
  const history = root.history === undefined ? [] : root.history
  if (!Array.isArray(history) || history.length > MAX_RADAR_HISTORY_EVENTS
    || history.some(event => !validHistoryEvent(event))) {
    throw new Error('radar state has an invalid event history')
  }
  if (root.webhook !== undefined && !validWebhookDeliveryState(root.webhook)) {
    throw new Error('radar state has an invalid webhook delivery state')
  }
  if (!validIncidentMutes(root.incidentMutes)) {
    throw new Error('radar state has an invalid incident mute map')
  }
  if (!validIncidentTriage(root.incidentTriage)) {
    throw new Error('radar state has an invalid incident triage map')
  }
  if (Object.keys(sourceHealth).length > 10 || Object.keys(activeSourceHealth).length > 1_000_000) {
    throw new Error('radar state exceeds the source health limit')
  }
  if (Object.keys(analysisDeliveries).length > 100_000 || Object.keys(analysisResults).length > 100_000) {
    throw new Error('radar state exceeds the analysis record limit')
  }
  const sourceNames = new Set(['osv', 'github-advisories', 'cisa-kev', 'epss', 'npm-releases', 'npm-candidate-graphs', 'github-releases'])
  for (const [source, rawStatus] of Object.entries(sourceHealth)) {
    const status = asRecord(rawStatus)
    const failures = status?.consecutiveFailures
    if (!sourceNames.has(source)
      || typeof status?.lastAttemptedAt !== 'string'
      || typeof failures !== 'number' || !Number.isSafeInteger(failures)
      || failures < 0 || failures > 1_000_000
      || (status.lastSucceededAt !== undefined && typeof status.lastSucceededAt !== 'string')
      || (status.lastError !== undefined
        && (typeof status.lastError !== 'string' || status.lastError.length > 2_048))) {
      throw new Error(`radar state contains an invalid source health status: ${source}`)
    }
  }
  if (!Array.isArray(root.pendingAnalysisTasks) || root.pendingAnalysisTasks.length > 100_000) {
    throw new Error('radar state has an invalid pending analysis queue')
  }
  for (const rawTask of root.pendingAnalysisTasks) {
    const task = asRecord(rawTask)
    const event = asRecord(task?.event)
    if (task?.schema !== ANALYSIS_TASK_SCHEMA || typeof task.id !== 'string'
      || typeof task.createdAt !== 'string' || event?.schema !== RADAR_EVENT_SCHEMA
      || typeof event.id !== 'string' || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware' && event.kind !== 'compatibility' && event.kind !== 'source-health')) {
      throw new Error('radar state contains an invalid pending analysis task')
    }
    if (!validAffectedSources(event.affectedSources)
      || !validAffectedPlugins(event.affectedPlugins)) throw new Error('radar state contains invalid vulnerability scope')
    if (!validCompatibilityUpgradePath(event.upgradePath)) throw new Error('radar state contains an invalid compatibility upgrade path')
  }
  for (const [key, rawDelivery] of Object.entries(analysisDeliveries)) {
    if (!validAnalysisDelivery(rawDelivery) || rawDelivery.id !== key) {
      throw new Error(`radar state contains an invalid analysis delivery: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawResult] of Object.entries(analysisResults)) {
    if (!validStoredAnalysisResult(rawResult) || rawResult.incidentId !== key) {
      throw new Error(`radar state contains an invalid analysis result: ${key.slice(0, 256)}`)
    }
  }
  if (Object.keys(active).length > 1_000_000) throw new Error('radar state exceeds the active match limit')
  if (Object.keys(activeCompatibility).length > 1_000_000) {
    throw new Error('radar state exceeds the active compatibility limit')
  }
  for (const [key, rawStored] of Object.entries(active)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    const advisory = asRecord(event?.advisory)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA || typeof event.incidentId !== 'string'
      || (event.kind !== 'vulnerability' && event.kind !== 'malware')
      || typeof advisory?.id !== 'string' || typeof advisory.modified !== 'string'
      || !validAdvisorySources(advisory.sources)
      || !validAdvisoryConflicts(advisory.conflicts, advisory.sources)
      || !validAdvisoryRiskSignals(advisory.riskSignals)
      || !validAffectedSources(event.affectedSources)
      || !validAffectedPlugins(event.affectedPlugins)) {
      throw new Error(`radar state contains an invalid active match: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawStored] of Object.entries(activeCompatibility)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA
      || event.kind !== 'compatibility' || event.incidentId !== key
      || !validCompatibilityUpgradePath(event.upgradePath)) {
      throw new Error(`radar state contains an invalid compatibility match: ${key.slice(0, 256)}`)
    }
  }
  for (const [key, rawStored] of Object.entries(activeSourceHealth)) {
    const stored = asRecord(rawStored)
    const event = asRecord(stored?.event)
    if (stored?.key !== key || event?.schema !== RADAR_EVENT_SCHEMA
      || event.kind !== 'source-health' || event.incidentId !== key
      || !sourceNames.has(typeof event.source === 'string' ? event.source : '')) {
      throw new Error(`radar state contains an invalid source health match: ${key.slice(0, 256)}`)
    }
  }
  return structuredClone(value) as RadarState
}

export async function loadRadarState(path: string): Promise<RadarState> {
  try {
    const contents = await readFile(resolve(path), 'utf8')
    if (Buffer.byteLength(contents) > 256 * 1024 * 1024) throw new Error('radar state exceeds the file size limit')
    return parseRadarState(JSON.parse(contents) as unknown)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRadarState()
    if (error instanceof SyntaxError) throw new Error('radar state is not valid JSON')
    throw error
  }
}

export async function saveRadarState(path: string, state: RadarState): Promise<void> {
  const destination = resolve(path)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
