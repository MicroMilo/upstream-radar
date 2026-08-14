import type { ScanReport } from './types.js'

export function renderTextReport(report: ScanReport): string {
  const lines = [
    `Plugin Notary ${report.tool.version}`,
    `Target: ${report.target.name}${report.target.version === null ? '' : `@${report.target.version}`}`,
    `Artifact: ${report.target.artifactDigest}`,
    `DSH bundle: ${report.dsh.isBundle ? `yes (${report.dsh.patch ?? 'patch unspecified'})` : 'no'}`,
    `Admission verdict: ${report.verdict.toUpperCase()}`,
    `Risk verdict: ${report.riskVerdict.toUpperCase()}`,
    `Coverage verdict: ${report.coverageVerdict.toUpperCase()}`,
    '',
    'Coverage:',
    `  static source: ${report.coverage.staticSource}`,
    `  dependency resolution: ${report.coverage.dependencyResolution}`,
    `  provenance: ${report.coverage.provenance}`,
    `  source/artifact match: ${report.coverage.sourceArtifactMatch}`,
    `  sandbox detonation: ${report.coverage.sandboxDetonation}`,
    '',
    `Evidence: ${report.evidence.filesScanned} files, ${report.evidence.bytesHashed} bytes, ${report.evidence.dependencies.length} dependency declarations`,
  ]

  if (report.findings.length === 0) {
    lines.push('', 'No findings in the implemented static checks.')
  } else {
    lines.push('', `Findings (${report.findings.length}):`)
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.summary}`)
      lines.push(`    ${finding.detail}`)
    }
  }

  lines.push('', 'This is a bounded evidence report, not a guarantee that the plugin is safe.')
  return `${lines.join('\n')}\n`
}
