import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  assessCompatibilityChange,
  createAnalysisTask,
  emptyRadarState,
  packageKey,
  parsePackageManifestSnapshot,
  parseRadarConfig,
  pollRadar,
  renderAgentAnalysisPrompt,
  renderRadarEvents,
} from '../dist/src/index.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(repository, 'examples/radar')
const reportDirectory = join(fixtureDirectory, 'reports')
const writeReports = process.argv.includes('--write-reports')

async function json(name) {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8'))
}

function heading(number, title) {
  process.stdout.write(`\n${'='.repeat(78)}\n${number}. ${title}\n${'='.repeat(78)}\n\n`)
}

function source(matches) {
  return {
    async query(packages) {
      const result = new Map(packages.map(item => [packageKey(item), []]))
      for (const match of matches) result.set(packageKey(match.package), [match])
      return result
    },
  }
}

function releaseSource(previous, candidate) {
  return {
    async query(packages) {
      const installed = packages.find(item => item.name === previous.name && item.version === previous.version)
      if (installed === undefined) return new Map()
      return new Map([[packageKey(installed), {
        installed,
        latestVersion: candidate.version,
        previous,
        candidate,
      }]])
    },
  }
}

async function save(name, value) {
  if (!writeReports) return
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(join(reportDirectory, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
}

const config = parseRadarConfig(await json('config.json'))
const advisory = await json('advisory-added.json')

heading(1, 'Always-on baseline: exact installed dependency graph, no alert')
const baseline = await pollRadar(
  config.projects,
  emptyRadarState(),
  source([]),
  new Date('2026-08-14T00:30:00.000Z'),
)
process.stdout.write(`Watched ${baseline.packagesQueried} unique package versions. Alerts: ${baseline.events.length}.\n`)
await save('01-baseline.json', baseline)

heading(2, 'A vulnerability feed changes: route the exact affected path')
const vulnerable = await pollRadar(
  config.projects,
  baseline.state,
  source([advisory]),
  new Date('2026-08-14T01:01:00.000Z'),
)
process.stdout.write(renderRadarEvents(vulnerable.events))
await save('02-vulnerability-alert.json', vulnerable)

heading(3, 'Wake DSH with a constrained, project-specific analysis task')
const vulnerabilityPrompt = renderAgentAnalysisPrompt(vulnerable.analysisTasks[0])
process.stdout.write(`${vulnerabilityPrompt}\n`)
await save('03-vulnerability-dsh-task.txt', vulnerabilityPrompt)

heading(4, 'A plugin update appears: detect compatibility and breaking-change signals')
const previous = parsePackageManifestSnapshot(await json('plugin-before.json'))
const candidate = parsePackageManifestSnapshot(await json('plugin-candidate.json'))
const releaseNotes = await readFile(join(fixtureDirectory, 'release-notes.txt'), 'utf8')
const compatibility = assessCompatibilityChange(config.projects[0], {
  previous,
  candidate,
  releaseNotes,
  detectedAt: '2026-08-14T02:00:00.000Z',
})
if (compatibility === undefined) throw new Error('showcase compatibility fixture produced no event')
process.stdout.write(renderRadarEvents([compatibility]))
const compatibilityTask = createAnalysisTask(compatibility)
await save('04-compatibility-alert.json', compatibility)
await save('05-compatibility-dsh-task.txt', renderAgentAnalysisPrompt(compatibilityTask))

heading(5, 'Keep one current task per incident, then cancel it when the project catches up')
const firstCompatibility = await pollRadar(
  config.projects,
  vulnerable.state,
  source([advisory]),
  new Date('2026-08-14T02:00:00.000Z'),
  releaseSource(previous, candidate),
)
const nextCandidate = { ...candidate, version: '3.0.0' }
const updatedCompatibility = await pollRadar(
  config.projects,
  firstCompatibility.state,
  source([advisory]),
  new Date('2026-08-14T03:00:00.000Z'),
  releaseSource(previous, nextCandidate),
)

const upgradedConfig = structuredClone(config)
const upgradedProject = upgradedConfig.projects[0]
const upgradedPlugin = upgradedProject.plugins[0]
upgradedProject.environment.nodeVersion = '24.0.0'
upgradedPlugin.package.version = nextCandidate.version
upgradedPlugin.manifest = nextCandidate
upgradedPlugin.graph.nodes.find(node => node.id === upgradedPlugin.graph.rootNodeId).version = nextCandidate.version
upgradedPlugin.graph.nodes.find(node => node.name === '@deepseek-ai/dsh-agent').version = '0.2.0'
const resolvedCompatibility = await pollRadar(
  upgradedConfig.projects,
  updatedCompatibility.state,
  source([]),
  new Date('2026-08-14T04:00:00.000Z'),
  releaseSource(nextCandidate, nextCandidate),
)

const firstEvent = firstCompatibility.events.find(event => event.kind === 'compatibility')
const updatedEvent = updatedCompatibility.events.find(event => event.kind === 'compatibility')
const resolvedEvent = resolvedCompatibility.events.find(event => event.kind === 'compatibility')
if (firstEvent === undefined || updatedEvent === undefined || resolvedEvent === undefined) {
  throw new Error('showcase compatibility lifecycle did not produce all transitions')
}
const pendingFor = (result, incidentId) => result.state.pendingAnalysisTasks
  .filter(task => task.event.incidentId === incidentId)
process.stdout.write([
  `${firstEvent.change.toUpperCase()}: ${firstEvent.candidate.version}; queued tasks for incident: ${pendingFor(firstCompatibility, firstEvent.incidentId).length}`,
  `${updatedEvent.change.toUpperCase()}: ${updatedEvent.candidate.version}; queued tasks for incident: ${pendingFor(updatedCompatibility, firstEvent.incidentId).length}`,
  `${resolvedEvent.change.toUpperCase()}: project caught up; queued tasks for incident: ${pendingFor(resolvedCompatibility, firstEvent.incidentId).length}`,
  '',
].join('\n'))
await save('06-incident-lifecycle.json', {
  newEvent: firstEvent,
  updatedEvent,
  resolvedEvent,
  pendingTaskCounts: {
    afterNew: pendingFor(firstCompatibility, firstEvent.incidentId).length,
    afterUpdated: pendingFor(updatedCompatibility, firstEvent.incidentId).length,
    afterResolved: pendingFor(resolvedCompatibility, firstEvent.incidentId).length,
  },
})

process.stdout.write('\nShowcase complete: feed change -> exact graph match -> project route -> current DSH task -> resolved incident.\n')
