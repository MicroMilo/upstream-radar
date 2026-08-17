import type { ScanReport } from './types.js'
import type { DependencyGraph } from './radar-types.js'

type UnresolvedEdge = NonNullable<
  NonNullable<NonNullable<ScanReport['evidence']['npm']>['dependencyAudit']['graph']>['unresolved']
>[number]

function display(value: string, maxLength = 512): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`
  ))
  return escaped.length <= maxLength ? escaped : `${escaped.slice(0, maxLength)}…`
}

function displayUnresolvedEdge(
  graph: NonNullable<NonNullable<ScanReport['evidence']['npm']>['dependencyAudit']['graph']>,
  edge: UnresolvedEdge,
): string {
  const parent = graph.nodes.find(node => node.id === edge.from)
  const parentName = parent === undefined ? edge.from : `${parent.name}@${parent.version}`
  return `  ${display(parentName, 256)} -> ${display(edge.name, 256)} (${display(edge.spec, 256)}) [${display(edge.kind, 32)}]`
}

function displayGraphEdge(graph: DependencyGraph, from: string, to: string, kind: string): string {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const parent = nodes.get(from)
  const child = nodes.get(to)
  const parentName = parent === undefined ? from : `${parent.name}@${parent.version}`
  const childName = child === undefined ? to : `${child.name}@${child.version}`
  return `  ${display(parentName, 256)} -> ${display(childName, 256)} [${display(kind, 32)}]`
}

function renderDependencyGraph(lines: string[], graph: DependencyGraph): void {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const root = nodes.get(graph.rootNodeId)
  const unresolved = graph.unresolved ?? []
  lines.push(
    '',
    'Dependency graph:',
    `  source: ${display(graph.source ?? 'lockfile', 64)}`,
    `  root: ${display(root === undefined ? graph.rootNodeId : `${root.name}@${root.version}`, 512)}`,
    `  nodes: ${graph.nodes.length}`,
    `  edges: ${graph.edges.length}`,
    `  unresolved: ${unresolved.length}`,
    `  digest: ${display(graph.digest ?? '(none)', 128)}`,
  )
  const directEdges = graph.edges.filter(edge => edge.from === graph.rootNodeId)
  if (directEdges.length > 0) {
    lines.push(`  direct dependencies: ${directEdges.length}`)
    for (const edge of directEdges.slice(0, 12)) lines.push(displayGraphEdge(graph, edge.from, edge.to, edge.kind))
    if (directEdges.length > 12) lines.push(`  ... ${directEdges.length - 12} more direct dependencies`)
  }
  if (unresolved.length > 0) {
    lines.push('  unresolved edge details:')
    for (const edge of unresolved.slice(0, 12)) lines.push(displayUnresolvedEdge(graph, edge))
    if (unresolved.length > 12) lines.push(`  ... ${unresolved.length - 12} more unresolved edge(s)`)
  }
}

export function renderTextReport(report: ScanReport): string {
  const lines = [
    `Upstream Radar ${report.tool.version}`,
    `Target: ${display(report.target.name)}${report.target.version === null ? '' : `@${display(report.target.version)}`}`,
    `Artifact: ${report.target.artifactDigest}`,
    `DSH bundle: ${report.dsh.isBundle ? `yes (${display(report.dsh.patch ?? 'patch unspecified')})` : 'no'}`,
    `Admission verdict: ${report.verdict.toUpperCase()}`,
    `Risk verdict: ${report.riskVerdict.toUpperCase()}`,
    `Coverage verdict: ${report.coverageVerdict.toUpperCase()}`,
    '',
    'Coverage:',
    `  static source: ${report.coverage.staticSource}`,
    `  artifact integrity: ${report.coverage.artifactIntegrity}`,
    `  registry signature: ${report.coverage.registrySignature}`,
    `  dependency resolution: ${report.coverage.dependencyResolution}`,
    `  provenance: ${report.coverage.provenance}`,
    `  source/artifact match: ${report.coverage.sourceArtifactMatch}`,
    `  sandbox detonation: ${report.coverage.sandboxDetonation}`,
    '',
    `Evidence: ${report.evidence.filesScanned} ${report.evidence.filesScanned === 1 ? 'file' : 'files'}, ${report.evidence.bytesHashed} bytes, ${report.evidence.dependencies.length} dependency declarations`,
  ]

  if (report.evidence.dependencyGraph !== undefined) {
    renderDependencyGraph(lines, report.evidence.dependencyGraph)
  } else if (report.evidence.dependencyGraphError !== undefined) {
    lines.push('', 'Dependency graph: unavailable', `  reason: ${display(report.evidence.dependencyGraphError, 2_048)}`)
  }

  if (report.evidence.npm !== undefined) {
    const npm = report.evidence.npm
    lines.push(
      '',
      'npm chain of custody:',
      `  registry: ${display(npm.registry)}`,
      `  tarball integrity: ${npm.integrity.status} (${npm.integrity.algorithm})`,
      `  registry signature: ${npm.registrySignature.status}`,
      `  provenance: ${npm.provenance.status}`,
      `  dependency audit: ${npm.dependencyAudit.status}`,
      `  resolved packages: ${npm.dependencyAudit.packages ?? 'not resolved'}`,
    )
    if (npm.provenance.sourceRepository !== undefined) lines.push(`  source repository: ${display(npm.provenance.sourceRepository)}`)
    if (npm.provenance.sourceCommit !== undefined) lines.push(`  source commit: ${display(npm.provenance.sourceCommit)}`)
    if (npm.provenance.workflow !== undefined) lines.push(`  build workflow: ${display(npm.provenance.workflow)}`)
    if (npm.dependencyAudit.graphDigest !== undefined) lines.push(`  graph digest: ${npm.dependencyAudit.graphDigest}`)
    const unresolved = npm.dependencyAudit.graph?.unresolved
    if (unresolved !== undefined) {
      const optional = unresolved.filter(edge => edge.kind === 'optional').length
      lines.push(`  unresolved dependency edges: ${unresolved.length}${optional === 0 ? '' : ` (${optional} optional)`}`)
      if (unresolved.length > 0) {
        lines.push('  unresolved edge details:')
        for (const edge of unresolved.slice(0, 12)) lines.push(displayUnresolvedEdge(npm.dependencyAudit.graph!, edge))
        if (unresolved.length > 12) lines.push(`  ... ${unresolved.length - 12} more unresolved edge(s)`)
        lines.push('  note: optional edges can be platform choices; they explain incomplete coverage, not a confirmed vulnerability.')
      }
    }
    if (npm.dependencyAudit.vulnerabilities !== null) {
      const vulnerabilities = npm.dependencyAudit.vulnerabilities
      lines.push(`  known vulnerabilities: ${vulnerabilities.total} total (${vulnerabilities.critical} critical, ${vulnerabilities.high} high)`)
    }
  }

  if (report.findings.length === 0) {
    lines.push('', 'No findings in the implemented static checks.')
  } else {
    lines.push('', `Findings (${report.findings.length}):`)
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${display(finding.code)}: ${display(finding.summary)}`)
      lines.push(`    ${display(finding.detail, 2_048)}`)
      if (finding.remediation !== undefined) lines.push(`    Fix: ${display(finding.remediation, 2_048)}`)
    }
  }

  const nextStep = report.riskVerdict === 'block'
    ? 'Do not install this package until the blocking finding is resolved.'
    : report.riskVerdict === 'review'
      ? 'Review the findings before installation; use --fail-on block only when your gate should block hard stops.'
      : report.riskVerdict === 'warn'
        ? 'Review the warnings before installation and decide whether your team accepts them.'
        : report.coverageVerdict === 'incomplete'
          ? 'Coverage is incomplete; do not treat an empty finding list as an allow decision.'
          : 'The implemented admission checks passed; continue with DSH setup and keep monitoring.'
  lines.push('', `Next step: ${nextStep}`)
  lines.push('', 'This is a bounded evidence report, not a guarantee that the plugin is safe.')
  return `${lines.join('\n')}\n`
}
