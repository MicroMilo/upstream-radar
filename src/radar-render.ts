import type { CompatibilityEvent, DependencySource, RadarEvent, VulnerabilityEvent } from './radar-types.js'

function display(value: string, max = 2_048): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`
}

function packageLabel(value: { name: string; version: string }): string {
  return `${display(value.name)}@${display(value.version)}`
}

function dependencySourceLabel(source: 'profile' | 'dsh-host'): string {
  return source === 'dsh-host' ? 'DSH host runtime' : 'plugin profile'
}

function dependencySourcesLabel(sources: readonly DependencySource[]): string {
  return (['profile', 'dsh-host'] as const)
    .filter(source => sources.includes(source))
    .map(dependencySourceLabel)
    .join(' + ')
}

function vulnerabilityNextStep(event: VulnerabilityEvent): string {
  if (event.change === 'resolved') return 'No action required; confirm the installed graph no longer matches this incident.'
  if (event.kind === 'malware') return `Remove or isolate ${packageLabel(event.plugin)} and ask the DSH Agent to assess project exposure.`
  const fixedVersions = event.advisory.fixedVersions.slice(0, 4).map(item => display(item)).join(', ')
  return fixedVersions.length === 0
    ? `No published fix is recorded; ask the DSH Agent to assess containment or replacement for ${packageLabel(event.plugin)}.`
    : `Review ${packageLabel(event.affected)} fixed version(s) ${fixedVersions} with the DSH Agent before changing the plugin.`
}

function compatibilityNextStep(event: CompatibilityEvent): string {
  if (event.change === 'resolved') return 'No action required; confirm the current graph and source are up to date.'
  const remediationCandidate = event.upgradePath?.firstCandidateRemovingAllPaths?.candidate
  if (remediationCandidate !== undefined) {
    return `Ask the DSH Agent to inspect project impact before applying ${packageLabel(remediationCandidate)}; it removes all checked vulnerability paths.`
  }
  const candidate = event.upgradePath?.firstCandidate?.candidate ?? event.candidate
  return `Ask the DSH Agent to inspect project impact before applying ${packageLabel(candidate)}.`
}

function sourceHealthNextStep(event: Extract<RadarEvent, { kind: 'source-health' }>): string {
  return event.change === 'resolved'
    ? 'No action required; continue monitoring.'
    : `Restore ${display(event.source)} before treating the absence of new alerts as a clean result.`
}

function renderVulnerability(event: VulnerabilityEvent): string[] {
  const severity = event.kind === 'malware' ? 'CRITICAL' : event.advisory.severity.toUpperCase()
  const lines = [
    `[${severity}][${event.change.toUpperCase()}] ${event.kind === 'malware' ? 'Malicious package' : 'Dependency vulnerability'}`,
    `Project: ${display(event.project.name)} (${display(event.project.id)})`,
    `Plugin: ${packageLabel(event.plugin)}`,
    `Affected: ${packageLabel(event.affected)}`,
    ...(event.affectedSources === undefined || event.affectedSources.length === 0
      ? []
      : [`Origin: ${dependencySourcesLabel(event.affectedSources)}`]),
    `Advisory: ${display(event.advisory.id)}${event.advisory.aliases.length === 0 ? '' : ` / ${event.advisory.aliases.map(item => display(item)).join(', ')}`}`,
    `Summary: ${display(event.advisory.summary)}`,
  ]
  if (event.paths.length > 0) {
    lines.push('Paths:')
    for (const path of event.paths) lines.push(`  ${path.map(packageLabel).join(' -> ')}`)
  }
  if (event.affectedSources?.includes('dsh-host') === true) {
    const directBoundary = event.paths.some(path => path.length === 1
      && path[0]?.name === event.affected.name
      && path[0]?.version === event.affected.version)
    lines.push(directBoundary
      ? 'Path note: this one-node path is the exact DSH host-runtime boundary, not a plugin dependency edge.'
      : 'Path note: this finding crosses the shared DSH host-runtime boundary; the path does not mean the plugin declared every host package directly.')
  }
  lines.push(`Fixed versions: ${event.advisory.fixedVersions.length === 0 ? 'none published' : event.advisory.fixedVersions.map(item => display(item)).join(', ')}`)
  lines.push(`Route: ${event.route.owner === undefined ? '(no owner)' : display(event.route.owner)} via ${event.route.channels.map(item => display(item)).join(', ')}`)
  lines.push(`Next: ${vulnerabilityNextStep(event)}`)
  return lines
}

function renderCompatibility(event: CompatibilityEvent): string[] {
  const lines = [
    `[COMPATIBILITY][${event.change.toUpperCase()}] ${event.change === 'resolved' ? 'Candidate risk no longer applies' : 'Candidate update needs project analysis'}`,
    `Project: ${display(event.project.name)} (${display(event.project.id)})`,
    `Installed plugin: ${packageLabel(event.plugin)}`,
    `Changed package: ${packageLabel(event.installed)}`,
    `Candidate: ${packageLabel(event.candidate)}`,
    'Signals:',
  ]
  for (const signal of event.signals) {
    lines.push(`  [${signal.confidence.toUpperCase()}] ${display(signal.code)}: ${display(signal.summary)}`)
  }
  if (event.upgradePath !== undefined) {
    const vulnerabilityStatus = event.upgradePath.vulnerabilityStatus ?? 'not-requested'
    const dependencyStatus = event.upgradePath.dependencyStatus ?? 'not-requested'
    if (vulnerabilityStatus === 'unavailable') {
      lines.push(`Upgrade path: OSV candidate check unavailable; no candidate is recommended among ${event.upgradePath.evaluated} newer versions.`)
    } else if (dependencyStatus === 'unavailable') {
      lines.push(`Upgrade path: candidate dependency graph check unavailable; no candidate is recommended among ${event.upgradePath.evaluated} newer versions.`)
    } else if (event.upgradePath.firstCandidate === undefined) {
      lines.push(`Upgrade path: no fully checked candidate without a deterministic blocker among the checked ${event.upgradePath.evaluated - (event.upgradePath.uncheckedCount ?? 0)} of ${event.upgradePath.evaluated} newer versions.`)
    } else {
      lines.push(`${dependencyStatus === 'partial' ? 'First checked candidate' : 'First candidate'} without a deterministic blocker: ${packageLabel(event.upgradePath.firstCandidate.candidate)} (still requires project analysis)`)
      if (event.upgradePath.firstCandidate.signals.length > 0) {
        lines.push('First-candidate signals:')
        for (const signal of event.upgradePath.firstCandidate.signals) {
          lines.push(`  [${signal.confidence.toUpperCase()}] ${display(signal.code)}: ${display(signal.summary)}`)
        }
      }
    }
    lines.push(`Candidate OSV check: ${vulnerabilityStatus === 'checked' ? 'complete' : vulnerabilityStatus === 'unavailable' ? 'unavailable' : 'not requested'}`)
    lines.push(`Candidate dependency graph check: ${dependencyStatus === 'checked' ? 'complete' : dependencyStatus === 'partial' ? 'bounded prefix only' : dependencyStatus === 'unavailable' ? 'unavailable' : 'not requested'}${(event.upgradePath.uncheckedCount ?? 0) === 0 ? '' : `; ${event.upgradePath.uncheckedCount} candidate(s) not fully checked`}`)
    if (event.upgradePath.remediationCoverage !== undefined) {
      const coverage = event.upgradePath.remediationCoverage
      lines.push(`Vulnerability remediation check: ${coverage === 'checked' ? 'complete' : coverage === 'partial' ? 'bounded prefix only' : coverage === 'unavailable' ? 'unavailable' : 'not requested'}`)
      if (event.upgradePath.firstCandidateRemovingAllPaths !== undefined) {
        const remediation = event.upgradePath.firstCandidateRemovingAllPaths
        lines.push(`First checked candidate removing all known vulnerability paths: ${packageLabel(remediation.candidate)} (still requires project analysis)`)
        for (const item of remediation.vulnerabilityRemediation ?? []) {
          lines.push(`  ${display(item.advisoryId)}: ${item.status}; ${display(item.reason)}`)
        }
      } else if (coverage === 'checked') {
        lines.push('No checked candidate removes all known vulnerability paths without a deterministic blocker.')
      }
    }
    lines.push(`Upgrade candidates evaluated: ${event.upgradePath.evaluated}; deterministic blockers: ${event.upgradePath.blockedCount}`)
    if (event.upgradePath.blocked.length > 0) {
      lines.push('Blocked candidate samples:')
      for (const blocked of event.upgradePath.blocked) {
        const reasons = blocked.signals
          .filter(signal => signal.confidence === 'confirmed' || signal.confidence === 'strong')
          .map(signal => display(signal.code))
        lines.push(`  ${packageLabel(blocked.candidate)}: ${reasons.length === 0 ? 'deterministic blocker' : reasons.join(', ')}`)
      }
    }
  }
  if (event.releaseNotesUrl !== undefined) lines.push(`Release notes: ${display(event.releaseNotesUrl)}`)
  lines.push(`Route: ${event.route.owner === undefined ? '(no owner)' : display(event.route.owner)} via ${event.route.channels.map(item => display(item)).join(', ')}`)
  lines.push(`Next: ${compatibilityNextStep(event)}`)
  return lines
}

function renderSourceHealth(event: Extract<RadarEvent, { kind: 'source-health' }>): string[] {
  const title = event.change === 'resolved' ? 'Source recovered' : 'Monitoring source degraded'
  const lines = [
    `[SOURCE HEALTH][${event.change.toUpperCase()}] ${title}`,
    `Project: ${display(event.project.name)} (${display(event.project.id)})`,
    `Source: ${display(event.source)}`,
    `Consecutive failures: ${event.failureCount}`,
    `Last attempted: ${display(event.lastAttemptedAt)}`,
  ]
  if (event.lastSucceededAt !== undefined) lines.push(`Last succeeded: ${display(event.lastSucceededAt)}`)
  if (event.error !== undefined) lines.push(`Error: ${display(event.error)}`)
  lines.push(`Route: ${event.route.owner === undefined ? '(no owner)' : display(event.route.owner)} via ${event.route.channels.map(item => display(item)).join(', ')}`)
  lines.push(`Next: ${sourceHealthNextStep(event)}`)
  return lines
}

export function renderRadarEvent(event: RadarEvent): string {
  const lines = event.kind === 'compatibility'
    ? renderCompatibility(event)
    : event.kind === 'source-health'
      ? renderSourceHealth(event)
      : renderVulnerability(event)
  return `${lines.join('\n')}\n`
}

export function renderRadarEvents(events: readonly RadarEvent[]): string {
  if (events.length === 0) return 'No vulnerability or compatibility changes require attention.\n'
  return events.map(renderRadarEvent).join('\n')
}
