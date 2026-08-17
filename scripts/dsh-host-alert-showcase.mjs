import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  emptyRadarState,
  packageKey,
  pollRadar,
  renderRadarEvents,
} from '../dist/src/index.js'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportPath = join(repository, 'examples/dsh/reports/dsh-host-alert-dedup.json')
const writeReport = process.argv.includes('--write-report')

const hostPackage = { ecosystem: 'npm', name: '@deepseek-ai/cordis', version: '4.0.1' }
const advisory = {
  package: hostPackage,
  advisory: {
    id: 'GHSA-dsh-host-showcase',
    aliases: [],
    summary: 'A shared DSH host package is affected.',
    details: 'This deterministic local advisory demonstrates project-level host alert coalescing.',
    severity: 'high',
    modified: '2026-08-16T01:00:00.000Z',
    fixedVersions: ['4.0.2'],
    references: [],
  },
}

const inventory = {
  schema: 'upstream-radar.inventory/v1alpha1',
  project: { id: 'dsh-host-showcase', name: 'DSH host alert showcase', channels: ['stdout'] },
  plugins: [
    {
      package: { ecosystem: 'npm', name: 'browser-plugin', version: '1.0.0' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1',
        rootNodeId: 'browser-plugin',
        nodes: [
          { id: 'browser-plugin', name: 'browser-plugin', version: '1.0.0' },
          { id: 'host-cordis-a', ...hostPackage, source: 'dsh-host' },
        ],
        edges: [{ from: 'browser-plugin', to: 'host-cordis-a', kind: 'peer' }],
      },
    },
    {
      package: { ecosystem: 'npm', name: 'search-plugin', version: '2.0.0' },
      graph: {
        schema: 'upstream-radar.dependency-graph/v1alpha1',
        rootNodeId: 'search-plugin',
        nodes: [
          { id: 'search-plugin', name: 'search-plugin', version: '2.0.0' },
          { id: 'host-cordis-b', ...hostPackage, source: 'dsh-host' },
        ],
        edges: [{ from: 'search-plugin', to: 'host-cordis-b', kind: 'peer' }],
      },
    },
  ],
}

const source = {
  async query(packages) {
    const result = new Map(packages.map(item => [packageKey(item), []]))
    result.set(packageKey(hostPackage), [advisory])
    return result
  },
}

const result = await pollRadar(
  [inventory],
  emptyRadarState(),
  source,
  new Date('2026-08-16T01:01:00.000Z'),
)
const event = result.events[0]
if (result.events.length !== 1 || event?.kind !== 'vulnerability') {
  throw new Error('showcase expected one coalesced vulnerability event')
}
if (event.affectedPlugins?.length !== 2 || event.paths.length !== 2 || result.analysisTasks.length !== 1) {
  throw new Error('showcase did not retain all affected plugin roots and paths')
}

const report = {
  schema: 'upstream-radar.dsh-host-alert-showcase/v1alpha1',
  project: inventory.project,
  pluginRoots: inventory.plugins.map(plugin => plugin.package),
  activeEvents: result.events.length,
  dshAnalysisTasks: result.analysisTasks.length,
  affectedPackage: event.affected,
  affectedPlugins: event.affectedPlugins,
  affectedPaths: event.paths,
  incidentId: event.incidentId,
}

console.log('DSH shared host alert showcase')
console.log(`  plugin roots: ${report.pluginRoots.length}`)
console.log(`  vulnerability events: ${report.activeEvents}`)
console.log(`  DSH analysis tasks: ${report.dshAnalysisTasks}`)
console.log(`  affected plugins: ${report.affectedPlugins.map(plugin => `${plugin.name}@${plugin.version}`).join(', ')}`)
console.log(`  exact paths retained: ${report.affectedPaths.length}`)
console.log('')
console.log(renderRadarEvents(result.events))

if (writeReport) {
  await mkdir(join(repository, 'examples/dsh/reports'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report: ${reportPath}`)
}
