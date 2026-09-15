import { observationNetworkEnvironment } from './dsh-observation-network.js'
import { createHash } from 'node:crypto'

/** Scheduling throughput is not part of an observation's runtime contract. */
export function createDshBatchExecutorIdentity(input: {
  sourceIdentity: string
  images: Array<{ nodeMajor: number; pnpmVersion: string; id: string }>
  config: { dockerContext: string; architecture: string; timeoutSeconds: number; networkProxy?: string; maxTasks: number }
}): string {
  const { dockerContext, architecture, timeoutSeconds, networkProxy } = input.config
  observationNetworkEnvironment(networkProxy)
  const images = input.images.map(({ nodeMajor, pnpmVersion, id }) => ({ nodeMajor, pnpmVersion, id }))
    .sort((left, right) => left.nodeMajor - right.nodeMajor || left.pnpmVersion.localeCompare(right.pnpmVersion))
  return createHash('sha256').update(JSON.stringify({ sourceIdentity: input.sourceIdentity, images,
    runtime: { dockerContext, architecture, timeoutSeconds, networkProxy } })).digest('hex')
}

export function dshBatchDockerObjectAbsent(error: unknown): boolean {
  const stderr = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : undefined
  return typeof stderr === 'string' && /^(?:error response from daemon: |error: )?no such (?:object|container|image): /im.test(stderr)
}

// This program is sent as code owned by Radar. Package/review values enter only
// through one JSON argv value. It is never evaluated by the host scanner.
const ISOLATED_COLLECTOR = `
const input = JSON.parse(process.argv[1]);
const {cell, kind} = input;
const common = {packageSpec:cell.plugin, dshVersion:cell.dshVersion, caseId:cell.id,
  profileEnvironment:cell.profileEnvironment, allowExecution:true, isolationProvider:'other',
  timeoutMs:input.timeoutSeconds*1000, networkProxy:input.networkProxy,
  allowedBuilds:(cell.allowedBuilds || '').split(',').filter(Boolean)};
let report;
if (kind === 'native') {
  const {observeDshPluginInstall} = await import('/radar/dist/src/dsh-install-observation.js');
  report = await observeDshPluginInstall({...common, expectedArtifactSha256:cell.expectedArtifactSha256});
} else if (kind === 'adapter') {
  const {observeDshAuthorAdapter} = await import('/radar/dist/src/dsh-adapter-observation.js');
  report = await observeDshAuthorAdapter({...common, adapter:cell.adapter, expectedArtifactSha256:cell.expectedArtifactSha256});
} else {
  const {observeDshPluginSurface} = await import('/radar/dist/src/dsh-surface-observation.js');
  report = await observeDshPluginSurface({...common, sourceCaseId:cell.sourceCaseId,
    hostBuildApproval:cell.hostBuildApproval,
    startupConfiguration:cell.startupConfiguration,
    sourceFingerprint:cell.sourceFingerprint, contractFingerprint:cell.contractFingerprint,
    plane:cell.plane, profile:cell.profile, runtimeId:cell.runtimeId, expectedArtifactSha256:cell.artifactSha256,
    driverRoot:'/surface-driver', chromiumExecutable:'/usr/bin/chromium', artifactsDirectory:'/sandbox/export'});
}
const attachments = [], attachmentGaps = [];
if (kind === 'surface') {
  const {constants} = await import('node:fs');
  const {open} = await import('node:fs/promises');
  let directory, bytes = 0;
  try {
    directory = await open('/sandbox/export', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const key of ['hostLog','screenshot','trace','transcript']) {
      const name = report.evidence[key];
      if (typeof name !== 'string') continue;
      if (!/^[a-z0-9][a-z0-9._-]{0,100}$/.test(name)) {attachmentGaps.push('unsafe evidence name'); continue;}
      let file;
      try {
        file = await open('/proc/self/fd/'+directory.fd+'/'+name, constants.O_RDONLY | constants.O_NOFOLLOW);
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > 8*1024*1024-bytes) throw new Error('attachment budget exceeded');
        const data = await file.readFile();
        if(data.length !== metadata.size) throw new Error('attachment changed while reading');
        bytes += data.length; attachments.push({name, base64:data.toString('base64')});
      } catch(error) {attachmentGaps.push(key+': '+String(error).slice(0,256));}
      finally {if(file) await file.close();}
    }
  } catch(error) {attachmentGaps.push(String(error).slice(0,256));}
  finally {if(directory) await directory.close();}
}
console.log(JSON.stringify({report,attachments,attachmentGaps}));
`

export function dshBatchContainerArguments(input: {
  name: string; key: string; image: string; kind: 'native' | 'surface' | 'adapter'; cell: unknown
  timeoutSeconds: number; networkProxy?: string
}): string[] {
  if (!/^radar-batch-[a-z0-9-]{1,80}$/.test(input.name) || !/^[a-f0-9]{64}$/.test(input.key)) throw new Error('invalid managed batch container identity')
  if (!/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new Error('batch execution requires an exact image digest')
  if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 30 || input.timeoutSeconds > 600) throw new Error('batch timeout exceeds bounds')
  if (!['native', 'surface', 'adapter'].includes(input.kind)) throw new Error('unsupported batch execution kind')
  observationNetworkEnvironment(input.networkProxy)
  const data = JSON.stringify({ kind: input.kind, cell: input.cell, timeoutSeconds: input.timeoutSeconds, networkProxy: input.networkProxy })
  if (Buffer.byteLength(data) > 64 * 1024) throw new Error('batch execution input exceeds bounds')
  return ['create', '--name', input.name, '--label', `upstream-radar.task=${input.key}`,
    '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
    ...(input.kind === 'native' ? ['--cap-add', 'SYS_PTRACE'] : []),
    '--security-opt', 'no-new-privileges=true', '--pids-limit', '256', '--memory', '3g', '--cpus', '1.5',
    '--ulimit', 'nofile=4096:4096', '--shm-size', '256m',
    '--tmpfs', '/sandbox:rw,exec,nosuid,nodev,size=3g,mode=1777',
    '--env', 'UPSTREAM_RADAR_ISOLATED_RUNNER=1', '--env', 'TMPDIR=/sandbox', '--env', 'LANG=C.UTF-8',
    '--entrypoint', 'node', input.image, '--input-type=module', '-e', ISOLATED_COLLECTOR, data]
}
