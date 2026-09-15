import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { collectDshHostBuildInventory, type DshHostBuildInventory } from './dsh-host-builds.js'
import { assertDshHostBuildApproval, parseDshHostBuildApproval, type DshHostBuildApproval, type DshHostBuildContext } from './dsh-host-build-policy.js'

export interface DshHostBuildExecution {
  revision: 'dsh-host-build-execution/1'
  requestedApproval: DshHostBuildApproval
  status: 'not-executed' | 'command-completed' | 'failed'
  bindingVerified: boolean
  reason: string
  command?: {
    args: string[]
    code: number | null
    signal: string | null
    timedOut: boolean
    outputExceeded: boolean
    output: string
    outputSha256: string
    launchError?: string
  }
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const MAX_OUTPUT = 256 * 1024
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const child = (parent: FileHandle, name: string): string => `/proc/self/fd/${parent.fd}/${name}`

export function parseDshHostBuildExecution(input: unknown, binding: { inventory: DshHostBuildInventory; context: DshHostBuildContext }): DshHostBuildExecution {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host build execution must contain objects')
    return value as Record<string, unknown>
  }
  const bounded = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new Error('host build execution diagnostic exceeds its bound')
    return value
  }
  const root = record(input)
  if (root.revision !== 'dsh-host-build-execution/1' || !['not-executed', 'command-completed', 'failed'].includes(String(root.status))
    || typeof root.bindingVerified !== 'boolean') throw new Error('unsupported host build execution status or binding')
  const requestedApproval = parseDshHostBuildApproval(root.requestedApproval)
  let command: DshHostBuildExecution['command']
  if (root.command !== undefined) {
    const item = record(root.command)
    const args = ['rebuild', ...requestedApproval.packages]
    if (!Array.isArray(item.args) || item.args.length !== args.length || item.args.some((value, index) => value !== args[index])) throw new Error('host rebuild selectors differ from the exact requested permission')
    if ((item.code !== null && (!Number.isSafeInteger(item.code) || (item.code as number) < -255 || (item.code as number) > 255))
      || (item.signal !== null && (typeof item.signal !== 'string' || item.signal.length > 32 || !/^SIG[A-Z0-9]+$/.test(item.signal)))
      || typeof item.timedOut !== 'boolean' || typeof item.outputExceeded !== 'boolean') throw new Error('host rebuild command has an invalid terminal state')
    if (typeof item.output !== 'string' || Buffer.byteLength(item.output) > MAX_OUTPUT || item.outputSha256 !== sha(Buffer.from(item.output))) throw new Error('host rebuild output exceeds its bound or differs from its digest')
    command = { args, code: item.code as number | null, signal: item.signal as string | null,
      timedOut: item.timedOut, outputExceeded: item.outputExceeded, output: item.output, outputSha256: item.outputSha256 as string,
      ...(item.launchError === undefined ? {} : { launchError: bounded(item.launchError, 1_024) }) }
  }
  if (root.status === 'not-executed') {
    if (command !== undefined || root.bindingVerified) throw new Error('an unexecuted host permission cannot claim a command or verified binding')
  } else if (command === undefined) throw new Error('an executed host permission requires its bounded command observation')
  if (root.status === 'command-completed') {
    if (!root.bindingVerified || command!.code !== 0 || command!.signal !== null || command!.timedOut || command!.outputExceeded || command!.launchError !== undefined) throw new Error('a completed host rebuild requires successful terminal and binding checks')
    assertDshHostBuildApproval(requestedApproval, binding.inventory, binding.context)
  } else if (root.bindingVerified) throw new Error('an unsuccessful host rebuild cannot claim verified binding')
  return { revision: root.revision, requestedApproval, status: root.status as DshHostBuildExecution['status'], bindingVerified: root.bindingVerified,
    reason: bounded(root.reason, 1_024), ...(command === undefined ? {} : { command }) }
}

async function directoryAt(parent: FileHandle, path: string): Promise<FileHandle> {
  const parts = path.split('/')
  if (Buffer.byteLength(path) > 2_048 || /[\\\u0000-\u001f\u007f]/.test(path) || parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('host rebuild directory must remain within its pinned root')
  let current: FileHandle | undefined
  try {
    for (const part of parts) {
      const next = await open(child(current ?? parent, part), DIRECTORY)
      await current?.close(); current = next
    }
    return current!
  } catch (error) { await current?.close(); throw error }
}

async function read(parent: FileHandle, name: string, maximum: number): Promise<Buffer> {
  const file = await open(child(parent, name), FILE)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('host rebuild metadata exceeds its regular-file bound')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    const after = await file.stat()
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('host rebuild metadata changed while reading')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

async function rebuild(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<NonNullable<DshHostBuildExecution['command']>> {
  const process = spawn(command, args, { cwd, env: { ...environment, NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    npm_config_ignore_scripts: 'false', PNPM_CONFIG_IGNORE_SCRIPTS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const chunks: Buffer[] = []
  let bytes = 0, timedOut = false, outputExceeded = false, launchError: string | undefined
  const kill = (): void => { try { globalThis.process.kill(-process.pid!, 'SIGKILL') } catch { process.kill('SIGKILL') } }
  const capture = (chunk: Buffer): void => {
    if (bytes + chunk.length > MAX_OUTPUT) { outputExceeded = true; kill(); return }
    bytes += chunk.length; chunks.push(chunk)
  }
  process.stdout.on('data', capture); process.stderr.on('data', capture)
  process.once('error', error => { launchError = error.message.slice(0, 1_024) })
  const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
  const terminal = await new Promise<{ code: number | null; signal: string | null }>(resolve => process.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  let output = Buffer.concat(chunks).toString('utf8')
  // Invalid UTF-8 expands to replacement characters when serialized. Bound
  // the retained text as well as the original process bytes.
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    outputExceeded = true
    output = Buffer.from(output).subarray(0, MAX_OUTPUT - 4).toString('utf8')
  }
  return { args, ...terminal, timedOut, outputExceeded, output, outputSha256: sha(Buffer.from(output)),
    ...(launchError === undefined ? {} : { launchError }) }
}

/** Run only within a disposable Linux observer. This does not resolve packages
 * again or claim that a successful command proves a working native module.
 */
export async function executeDshHostBuildApproval(options: {
  approval: DshHostBuildApproval
  context: DshHostBuildContext
  cacheHome: string
  pnpmCommand: string
  environment: NodeJS.ProcessEnv
  timeoutMs: number
  allowExecution: boolean
}): Promise<DshHostBuildExecution> {
  const approval = parseDshHostBuildApproval(options.approval)
  const result: DshHostBuildExecution = { revision: 'dsh-host-build-execution/1', requestedApproval: approval,
    status: 'not-executed', bindingVerified: false, reason: 'the exact host build permission has not been verified' }
  let slash: FileHandle | undefined, cache: FileHandle | undefined, installation: FileHandle | undefined
  try {
    if (!options.allowExecution || process.platform !== 'linux' || process.env.UPSTREAM_RADAR_ISOLATED_RUNNER !== '1') throw new Error('host rebuild requires an explicitly enabled isolated Linux executor')
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 600_000) throw new Error('host rebuild timeout exceeds its bound')
    if (!options.pnpmCommand || options.pnpmCommand.length > 2_048 || /[\u0000-\u001f\u007f]/.test(options.pnpmCommand)) throw new Error('host rebuild requires a bounded package-manager command')
    if (options.context.runtime.nodeVersion !== process.versions.node || options.context.runtime.architecture !== process.arch) throw new Error('host rebuild context differs from the executing Node runtime')
    const inventory = await collectDshHostBuildInventory(options.cacheHome, options.context.dshVersion)
    assertDshHostBuildApproval(approval, inventory, options.context)
    slash = await open('/', DIRECTORY)
    cache = await directoryAt(slash, options.cacheHome.slice(1))
    installation = await directoryAt(cache, inventory.installation!.location)
    const manifestBytes = await read(installation, 'package.json', 1024 * 1024)
    if (sha(manifestBytes) !== inventory.installation!.manifestSha256
      || sha(await read(installation, 'pnpm-lock.yaml', 8 * 1024 * 1024)) !== inventory.installation!.lockfileSha256) throw new Error('host rebuild inventory changed before execution')
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
    // pnpm rebuild can be overridden by a project script. The DLX root must
    // remain the installation project, not a target-provided command router.
    if (manifest.scripts !== undefined) throw new Error('host rebuild refuses lifecycle or command scripts in the DLX project')
    for (const name of ['pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']) {
      let existing: FileHandle | undefined
      try { existing = await open(child(installation, name), FILE) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (existing) { await existing.close(); throw new Error(`host rebuild refuses existing installation policy: ${name}`) }
    }
    for (const item of inventory.packages.filter(item => approval.packages.includes(item.spec))) {
      const directory = await directoryAt(cache, item.location)
      try { if (sha(await read(directory, 'package.json', 1024 * 1024)) !== item.manifestSha256) throw new Error('host rebuild package manifest changed before execution') }
      finally { await directory.close() }
    }
    const policy = Buffer.from(JSON.stringify({ allowBuilds: Object.fromEntries(approval.packages.map(spec => [spec, true])) }))
    const file = await open(child(installation, 'pnpm-workspace.yaml'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(policy); await file.sync() } finally { await file.close() }
    // Pin cwd through the observer's still-open descriptor, not through a
    // target-replaceable cache pathname. Keep it open until the child exits.
    result.command = await rebuild(options.pnpmCommand, ['rebuild', ...approval.packages],
      `/proc/${process.pid}/fd/${installation.fd}`, options.environment, options.timeoutMs)
    if (result.command.code !== 0 || result.command.signal !== null || result.command.timedOut || result.command.outputExceeded || result.command.launchError) throw new Error('the exact host rebuild command did not complete within its bounds')
    if (sha(await read(installation, 'pnpm-workspace.yaml', 16 * 1024)) !== sha(policy)) throw new Error('host build policy changed during execution')
    const after = await collectDshHostBuildInventory(options.cacheHome, options.context.dshVersion)
    assertDshHostBuildApproval(approval, after, options.context)
    result.status = 'command-completed'
    result.bindingVerified = true
    result.reason = 'the exact rebuild command completed with unchanged bindings; native functionality still requires its own host observation'
  } catch (error) {
    result.status = result.command === undefined ? 'not-executed' : 'failed'
    result.reason = (error instanceof Error ? error.message : String(error)).slice(0, 1_024) || 'host rebuild failed without a diagnostic'
  } finally { await installation?.close(); await cache?.close(); await slash?.close() }
  return result
}
