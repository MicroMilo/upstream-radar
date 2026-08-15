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
import { createDshRadarFamilyMessage, groupPendingAnalysisTasks } from '../dist/src/dsh-plugin.js'

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

function unavailableSource(message) {
  return {
    async query() {
      throw new Error(message)
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
        repository: 'https://github.com/acme/plugin',
      }]])
    },
  }
}

function releaseNotesSource() {
  return {
    async query(observations) {
      return new Map(observations
        .filter(observation => observation.candidate.version !== observation.installed.version)
        .map(observation => [packageKey(observation.installed), {
          text: 'BREAKING CHANGE: the plugin now requires the project session to be configured.',
          url: `https://github.com/acme/plugin/releases/tag/v${observation.candidate.version}`,
        }]))
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
const intermediate = {
  ...structuredClone(previous),
  version: '1.1.0',
}
const blockedIntermediate = {
  ...structuredClone(previous),
  version: '1.2.0',
  engines: { node: '>=24' },
}
const fallbackIntermediate = {
  ...structuredClone(previous),
  version: '1.3.0',
}
const releaseNotes = await readFile(join(fixtureDirectory, 'release-notes.txt'), 'utf8')
const transitiveCandidateAdvisory = {
  id: 'GHSA-transitive-plugin',
  aliases: [],
  summary: 'The candidate pulls a vulnerable parser transitively.',
  details: 'This is a deterministic showcase advisory attached to the candidate graph.',
  severity: 'high',
  modified: '2026-08-14T01:30:00.000Z',
  fixedVersions: ['3.0.0'],
  references: ['https://example.test/GHSA-transitive-plugin'],
}
const candidateDependencyChecks = new Map([
  ['npm:plugin@1.1.0', {
    status: 'checked',
    nodeCount: 3,
    unresolvedCount: 0,
    findings: [{
      package: { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
      advisory: transitiveCandidateAdvisory,
      paths: [[
        { ecosystem: 'npm', name: 'plugin', version: '1.1.0' },
        { ecosystem: 'npm', name: 'logger', version: '4.1.0' },
        { ecosystem: 'npm', name: 'parser', version: '2.9.0' },
      ]],
    }],
  }],
  ['npm:plugin@1.2.0', { status: 'checked', nodeCount: 3, unresolvedCount: 0, findings: [] }],
  ['npm:plugin@1.3.0', { status: 'checked', nodeCount: 3, unresolvedCount: 0, findings: [] }],
  ['npm:plugin@2.0.0', { status: 'checked', nodeCount: 3, unresolvedCount: 0, findings: [] }],
])
const compatibility = assessCompatibilityChange(config.projects[0], {
  previous,
  candidate,
  upgradeCandidates: [intermediate, blockedIntermediate, fallbackIntermediate, candidate],
  candidateVulnerabilities: new Map(),
  candidateVulnerabilityStatus: 'checked',
  candidateDependencyChecks,
  candidateDependencyStatus: 'checked',
  releaseNotes,
  releaseNotesUrl: 'https://github.com/acme/plugin/releases/tag/v2.0.0',
  detectedAt: '2026-08-14T02:00:00.000Z',
})
if (compatibility === undefined) throw new Error('showcase compatibility fixture produced no event')
process.stdout.write(renderRadarEvents([compatibility]))
const compatibilityTask = createAnalysisTask(compatibility)
await save('04-compatibility-alert.json', compatibility)
await save('05-compatibility-dsh-task.txt', renderAgentAnalysisPrompt(compatibilityTask))

heading(5, 'One coordinated DSH runtime update becomes one Agent notice')
const dshFamilyEvents = [
  {
    ...structuredClone(compatibility),
    id: 'event-dsh-family-agent',
    incidentId: 'incident-dsh-family-agent',
    installed: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.1.0-rc.5' },
    candidate: { ecosystem: 'npm', name: '@deepseek-ai/dsh-agent', version: '0.2.0' },
  },
  {
    ...structuredClone(compatibility),
    id: 'event-dsh-family-session',
    incidentId: 'incident-dsh-family-session',
    installed: { ecosystem: 'npm', name: '@deepseek-ai/dsh-session', version: '0.1.0-rc.5' },
    candidate: { ecosystem: 'npm', name: '@deepseek-ai/dsh-session', version: '0.2.0' },
  },
]
const dshFamilyTasks = dshFamilyEvents.map(createAnalysisTask)
const dshNoticeGroups = groupPendingAnalysisTasks(dshFamilyTasks)
if (dshNoticeGroups.length !== 1) throw new Error('showcase did not group the DSH family tasks')
const dshFamilyMessage = createDshRadarFamilyMessage(dshNoticeGroups[0])
process.stdout.write([
  `Deterministic compatibility incidents kept in state: ${dshFamilyTasks.length}`,
  `DSH Agent notices: ${dshNoticeGroups.length}`,
  `Notice: ${dshFamilyMessage.source.summary}`,
  '',
].join('\n'))
await save('05-dsh-runtime-group.json', {
  incidentCount: dshFamilyTasks.length,
  noticeCount: dshNoticeGroups.length,
  source: dshFamilyMessage.source,
  prompt: dshFamilyMessage.content[0]?.text,
})

heading(6, 'Keep one current task per incident, then cancel it when the project catches up')
const firstCompatibility = await pollRadar(
  config.projects,
  vulnerable.state,
  source([advisory]),
  new Date('2026-08-14T02:00:00.000Z'),
  releaseSource(previous, candidate),
  releaseNotesSource(),
)
const nextCandidate = { ...candidate, version: '3.0.0' }
const updatedCompatibility = await pollRadar(
  config.projects,
  firstCompatibility.state,
  source([advisory]),
  new Date('2026-08-14T03:00:00.000Z'),
  releaseSource(previous, nextCandidate),
  releaseNotesSource(),
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
  releaseNotesSource(),
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
  `${firstEvent.change.toUpperCase()}: ${firstEvent.candidate.version}; release notes: ${firstEvent.releaseNotesUrl ?? 'none'}; queued tasks for incident: ${pendingFor(firstCompatibility, firstEvent.incidentId).length}`,
  `${updatedEvent.change.toUpperCase()}: ${updatedEvent.candidate.version}; release notes: ${updatedEvent.releaseNotesUrl ?? 'none'}; queued tasks for incident: ${pendingFor(updatedCompatibility, firstEvent.incidentId).length}`,
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

heading(7, 'A source outage is not a clean bill of health')
const outage = await pollRadar(
  config.projects,
  vulnerable.state,
  unavailableSource('simulated OSV timeout'),
  new Date('2026-08-14T05:00:00.000Z'),
)
process.stdout.write([
  `OSV warning: ${outage.sourceErrors.map(error => error.message).join(', ')}`,
  `New events: ${outage.events.length}; confirmed vulnerability matches kept: ${Object.keys(outage.state.activeVulnerabilities).length}; pending DSH tasks kept: ${outage.state.pendingAnalysisTasks.length}`,
  '',
].join('\n'))
await save('07-source-outage.json', outage)

heading(8, 'Repeated failures become one routed source-health notice')
const healthFirst = await pollRadar(
  config.projects,
  emptyRadarState(),
  unavailableSource('simulated OSV timeout'),
  new Date('2026-08-14T05:30:00.000Z'),
)
const healthSecond = await pollRadar(
  config.projects,
  healthFirst.state,
  unavailableSource('simulated OSV timeout'),
  new Date('2026-08-14T06:00:00.000Z'),
)
const healthThird = await pollRadar(
  config.projects,
  healthSecond.state,
  unavailableSource('simulated OSV timeout'),
  new Date('2026-08-14T06:30:00.000Z'),
)
const healthRecovered = await pollRadar(
  config.projects,
  healthThird.state,
  source([]),
  new Date('2026-08-14T07:00:00.000Z'),
)
const healthEvent = healthThird.events.find(event => event.kind === 'source-health')
const recoveryEvent = healthRecovered.events.find(event => event.kind === 'source-health')
if (healthEvent === undefined || recoveryEvent === undefined) throw new Error('showcase source-health lifecycle did not produce both transitions')
process.stdout.write([
  `ALERT: ${healthEvent.source} failed ${healthEvent.failureCount} times; queued DSH tasks: ${healthThird.state.pendingAnalysisTasks.length}`,
  `RECOVERED: ${recoveryEvent.source}; queued DSH tasks: ${healthRecovered.state.pendingAnalysisTasks.length}`,
  '',
].join('\n'))
await save('08-source-health-lifecycle.json', {
  alert: healthEvent,
  recovered: recoveryEvent,
  pendingTaskCounts: {
    afterAlert: healthThird.state.pendingAnalysisTasks.length,
    afterRecovery: healthRecovered.state.pendingAnalysisTasks.length,
  },
})

process.stdout.write('\nShowcase complete: feed change -> exact graph match -> project route -> coordinated DSH notice -> resolved incident -> source outage -> source-health alert and recovery.\n')
