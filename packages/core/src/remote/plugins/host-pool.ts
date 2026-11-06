import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  AcquireResultSchema,
  CheckResultSchema,
  InitializeResultSchema,
  PLUGIN_ERROR_CODES,
  PluginErrorDataSchema,
  StartedResultSchema,
  UploadAppResultSchema,
  type AcquireResult,
  type CheckResult,
  type OptionalPluginMethod,
  type ProgressParams,
  type RemotePluginManifest,
} from '@vostride/agent-qa-plugin-kit/protocol'
import {
  PLUGIN_RELEASE_BOUND_MS,
  REMOTE_RELEASE_BOUND_MS,
  RemoteRefusalError,
  type RemoteFailureKind,
  type RemoteLease,
  type RemoteLeaseEnded,
  type RemoteLeaseOutcome,
  type RemoteLeaseRequest,
  type RemoteLeaseSource,
  type RemotePluginEvidence,
  type RemoteProgress,
  type RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'

import {
  resolvePluginEntry,
  supportedPluginProtocols,
  type PluginEntryInput,
} from '../../plugins/resolve-entries.js'
import { checkPluginAnswer } from './answer.js'
import {
  startPluginProcess,
  type PluginCallOutcome,
  type PluginLateAnswer,
  type PluginProcess,
} from './plugin-process.js'

export interface PluginHostBounds {
  initializeMs: number
  checkMs: number
  startedMs: number
  endMs: number
  releaseMs: number
  shutdownMs: number
  signalMs: number
  cancelGraceMs: number
  killAfterMs: number
}

export const DEFAULT_PLUGIN_HOST_BOUNDS: PluginHostBounds = {
  initializeMs: 10_000,
  checkMs: 15_000,
  startedMs: 30_000,
  endMs: 30_000,
  releaseMs: 30_000,
  shutdownMs: 30_000,
  signalMs: 5_000,
  cancelGraceMs: 5_000,
  killAfterMs: 5_000,
}

// On a signal, once SIGTERM is sent, how long a plugin's group has before SIGKILL.
const SIGNAL_KILL_AFTER_MS = 500
// What the session registry waits past signalMs, so SIGTERM and SIGKILL go out before it stops.
const SIGNAL_KILL_RESERVE_MS = SIGNAL_KILL_AFTER_MS + 500

const PROGRESS_LINE_MAX = 200

// Terminal escape sequences: CSI, OSC to its terminator or the end, and two-character escapes.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\|$)|[ -\/]*[0-~])/g
const CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f]/g

// One line a terminal or a page shows as plain text: no escape sequence and no C0 or C1 control.
function plainFirstLine(text: string): string {
  const first = text.replace(ESCAPE_SEQUENCE, '').split(/\r?\n/, 1)[0] ?? ''
  return first.replace(CONTROL_CHARACTER, ' ').trim()
}

export interface PluginHostProgress extends RemoteProgress {
  remote: string
  entry: string
}

export interface PluginHostPoolInput {
  configDir: string
  plugins: readonly PluginEntryInput[]
  agentQaVersion: string
  hostVersions: { playwright: string; webdriverio: string }
  // Turns `{{secret:NAME}}` references into values; may throw a RemoteRefusalError.
  resolveSecrets: (value: Record<string, unknown>) => Record<string, unknown>
  runFacts?: { runId?: string }
  // A run marks every session it ends, so on a signal one it has not marked yet was cancelled.
  // The live editor marks none.
  marksSessions?: boolean
  mask: (text: string) => string
  // Values an acquire answer asks to mask; they reach the run's mask before the session is used.
  onMask?: (entry: string, values: readonly string[]) => void
  // Every call's progress, masked and cut to one plain line, after the call's own onProgress.
  onProgress?: (event: PluginHostProgress) => void
  debugLog?: (line: string) => void
  sessions?: RemoteSessionRegistry
  bounds?: Partial<PluginHostBounds>
}

export type PluginUploadRequest = Parameters<NonNullable<RemoteLeaseSource['uploadApp']>>[0]

export interface PluginCheckRemote {
  name: string
  settings?: Record<string, unknown>
}

export interface PluginHostPool extends RemoteLeaseSource {
  uploadApp(request: PluginUploadRequest): Promise<{ ref: string }>
  // Undefined when the plugin declares no check.
  check(entry: string, remotes: readonly PluginCheckRemote[]): Promise<CheckResult | undefined>
  shutdown(options?: { signal?: boolean }): Promise<void>
}

type Refusal = (remote: string) => RemoteRefusalError

interface OpenLease {
  remote: string
  release(boundMs: number): Promise<void>
  end(ended: RemoteLeaseEnded): void
}

interface EntryFault {
  line: (remote: string) => string
  // The lease whose own call went unanswered ends timeout; every other lease ends lost.
  timedOut?: OpenLease
}

interface RunningEntry {
  name: string
  manifest: RemotePluginManifest
  entryFile: string
  initialize: Record<string, unknown>
  process: PluginProcess
  evidence: RemotePluginEvidence
  leases: Set<OpenLease>
  // Lease releases sent and not yet settled; shutdown waits for them.
  releasing: Set<Promise<void>>
  // Every session handle this process gave out and has not answered a release for.
  held: Set<unknown>
  stopping: boolean
  fault?: EntryFault
  restarted?: Promise<void>
}

type EntryStart = { ok: true; running: RunningEntry } | { ok: false; refusal: Refusal }

async function fileFacts(path: string): Promise<{ sha256: string; size: number }> {
  const { size } = await stat(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return { sha256: hash.digest('hex'), size }
}

type ErrorScope = { call: 'initialize' | 'remote'; entry: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Number((ms / 1000).toFixed(1))}s`
}

function crashLine(entry: string, reason: string | undefined): (remote: string) => string {
  const why = reason === undefined ? '' : `: ${reason.replace(/\.+$/, '')}`
  return (remote) => `Remote ${remote}: plugin entry ${entry} stopped unexpectedly${why}.`
}

function silentLine(entry: string, deadlineMs: number): (remote: string) => string {
  return (remote) =>
    `Remote ${remote}: plugin entry ${entry} did not answer within ${formatMs(deadlineMs)} and was stopped.`
}

function strayLine(entry: string): (remote: string) => string {
  return (remote) =>
    `Remote ${remote}: plugin entry ${entry} wrote to stdout outside the protocol and was stopped.`
}

function refusalOf(kind: RemoteFailureKind, line: (remote: string) => string): Refusal {
  return (remote) => new RemoteRefusalError(line(remote), { remote, kind })
}

const shutDown: Refusal = refusalOf(
  'ended',
  (remote) => `Remote ${remote}: the plugin host has shut down.`,
)

function carriedHandle(answer: PluginLateAnswer): unknown {
  if (answer.status === 'result') {
    return isRecord(answer.result) ? answer.result.handle : undefined
  }
  return isRecord(answer.data) ? answer.data.handle : undefined
}

export function createPluginHostPool(input: PluginHostPoolInput): PluginHostPool {
  const bounds: PluginHostBounds = { ...DEFAULT_PLUGIN_HOST_BOUNDS, ...input.bounds }
  const starts = new Map<string, Promise<EntryStart>>()
  // One upload per plugins entry, platform and content for the pool's life, refusals included.
  const uploads = new Map<string, Promise<{ ref: string }>>()
  const background = new Set<Promise<void>>()
  const live = new Set<PluginProcess>()
  // Stops under way, and whether each already fits in a signal's bound.
  const stops = new Map<PluginProcess, { done: Promise<void>; bounded: boolean }>()
  let closing: Promise<void> | undefined
  let signalClosing: Promise<void> | undefined
  let signalDeadline: number | undefined
  let unregisterShutdown: (() => void) | undefined

  // What is left of a signal's bound; unbounded until a signal comes.
  const left = (): number =>
    signalDeadline === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, signalDeadline - Date.now())

  // After a signal, a call and its cancel grace together fit in what is left of the bound.
  const within = (timeoutMs: number): { timeoutMs: number; cancelGraceMs?: number } => {
    const remaining = left()
    if (remaining === Number.POSITIVE_INFINITY) return { timeoutMs }
    const bounded = Math.min(timeoutMs, remaining)
    return {
      timeoutMs: bounded,
      cancelGraceMs: Math.min(bounds.cancelGraceMs, remaining - bounded),
    }
  }

  const settledWithin = async (work: Promise<unknown>, boundMs: number): Promise<void> => {
    const settled = work.then(
      () => undefined,
      () => undefined,
    )
    if (boundMs === Number.POSITIVE_INFINITY) return settled
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      settled,
      new Promise<void>((done) => {
        timer = setTimeout(done, boundMs)
      }),
    ])
    clearTimeout(timer)
  }

  const settledWithinLeft = (work: Promise<unknown>): Promise<void> => settledWithin(work, left())

  const stopChild = (child: PluginProcess, killAfterMs = bounds.killAfterMs): Promise<void> => {
    const remaining = left()
    const bounded = remaining !== Number.POSITIVE_INFINITY
    const done = bounded
      ? child.stop(Math.min(killAfterMs, remaining), SIGNAL_KILL_AFTER_MS)
      : child.stop(killAfterMs)
    const stop = { done, bounded }
    stops.set(child, stop)
    void done.finally(() => {
      if (stops.get(child) === stop) stops.delete(child)
    })
    return done
  }

  const debug = (line: string): void => input.debugLog?.(input.mask(line))

  const track = (work: Promise<void>): Promise<void> => {
    background.add(work)
    void work.finally(() => background.delete(work))
    return work
  }

  const pluginLine = (message: string, stderr?: string): string => {
    const first = input.mask(message).split(/\r?\n/, 1)[0]?.trim() ?? ''
    if (first !== '') return first
    const logged = input.mask(stderr ?? '').trim()
    return logged === '' ? 'the plugin gave no reason.' : logged
  }

  const pluginErrorKind = (outcome: Extract<PluginCallOutcome, { status: 'error' }>) => {
    if (outcome.code === PLUGIN_ERROR_CODES.cancelled) return 'timeout' as const
    const data = PluginErrorDataSchema.safeParse(outcome.data)
    return data.success ? data.data.kind : ('refused' as const)
  }

  const pluginErrorLine = (
    remote: string,
    outcome: Extract<PluginCallOutcome, { status: 'error' }>,
    scope: ErrorScope,
  ): string => {
    const reason = pluginLine(outcome.message, outcome.stderr).replace(/\.+$/, '')
    const line = `Remote ${remote}: ${reason}.`
    const data = PluginErrorDataSchema.safeParse(outcome.data)
    const path = data.success ? input.mask(data.data.path ?? '').split(/\r?\n/, 1)[0]?.trim() : ''
    if (path === undefined || path === '') return line
    const options = `in plugins entry ${scope.entry}.`
    const settings = `in remote ${remote}.`
    // A prefix names the block in any call; a path without one belongs to the call's own block.
    if (path.startsWith('options.')) return `${line} Check ${path} ${options}`
    if (path.startsWith('settings.')) return `${line} Check ${path} ${settings}`
    if (scope.call === 'initialize') return `${line} Check options.${path} ${options}`
    return `${line} Check settings.${path} ${settings}`
  }

  // A progress report reaches its own request's listener and the pool's; neither touches the
  // call's deadline, and a listener that throws only reaches the debug log.
  const progressRelay =
    (remote: string, entry: string, own: ((progress: RemoteProgress) => void) | undefined) =>
    (update: ProgressParams): void => {
      // Masked again once plain, in case an escape sequence split a secret.
      const message = input.mask(plainFirstLine(input.mask(update.message)))
      const progress: RemoteProgress = {
        message: message.slice(0, PROGRESS_LINE_MAX),
        ...(update.queued === undefined ? {} : { queued: update.queued }),
        ...(update.percent === undefined ? {} : { percent: update.percent }),
      }
      const tell = (send: () => void): void => {
        try {
          send()
        } catch (error) {
          debug(`a progress listener for remote ${remote} failed: ${String(error)}`)
        }
      }
      tell(() => own?.(progress))
      tell(() => input.onProgress?.({ remote, entry, ...progress }))
    }

  const asRefusal = (error: unknown, remote: string, entry: string): RemoteRefusalError => {
    if (error instanceof RemoteRefusalError) {
      return new RemoteRefusalError(error.message, {
        remote,
        ...(error.kind === undefined ? {} : { kind: error.kind }),
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    return new RemoteRefusalError(
      `Remote ${remote}: plugin entry ${entry} could not start: ${pluginLine(message)}`,
      { remote, kind: 'refused' },
    )
  }

  const spawnPlugin = (entryFile: string, onStray?: () => void): PluginProcess => {
    const child = startPluginProcess({
      entryFile,
      cwd: input.configDir,
      mask: input.mask,
      ...(input.debugLog === undefined ? {} : { debugLog: input.debugLog }),
      ...(onStray === undefined ? {} : { onStray }),
      cancelGraceMs: bounds.cancelGraceMs,
      killAfterMs: bounds.killAfterMs,
    })
    live.add(child)
    void child.exited.then(() => live.delete(child))
    return child
  }

  // A handle stays held until the plugin answers its release; a stopped plugin's held handles
  // go to the restart.
  const releaseHandle = (
    running: RunningEntry,
    handle: unknown,
    boundMs: number,
  ): Promise<void> => {
    if (running.fault !== undefined) return running.restarted ?? Promise.resolve()
    return track(
      (async () => {
        const outcome = await running.process.request('release', { handle }, within(boundMs))
        if (outcome.status === 'result' || outcome.status === 'error') {
          running.held.delete(handle)
        }
        if (outcome.status !== 'result') {
          debug(`plugin entry ${running.name} did not release a session: ${outcome.status}`)
        }
        if (outcome.status === 'silent') hung(running, boundMs)
        if (outcome.status === 'exited') await running.process.exited
        await running.restarted
      })(),
    )
  }

  const releaseCarried = (running: RunningEntry, answer: PluginLateAnswer): Promise<void> => {
    const handle = carriedHandle(answer)
    if (handle === undefined) return Promise.resolve()
    running.held.add(handle)
    return releaseHandle(running, handle, bounds.releaseMs)
  }

  const stopInBackground = (child: PluginProcess): void => {
    void track(stopChild(child))
  }

  // A fresh process with the same options only releases what the stopped one held; nothing is
  // acquired again.
  async function releaseOnly(running: RunningEntry, handles: readonly unknown[]): Promise<void> {
    if (left() === 0) {
      debug(`plugin entry ${running.name} had no time left on the signal to release its sessions`)
      return
    }
    const child = spawnPlugin(running.entryFile)
    try {
      const started = await child.request(
        'initialize',
        running.initialize,
        within(bounds.initializeMs),
      )
      if (started.status !== 'result' || started.cancelled) {
        debug(`plugin entry ${running.name} did not restart to release its sessions`)
        return
      }
      await Promise.all(
        handles.map(async (handle) => {
          const outcome = await child.request('release', { handle }, within(bounds.releaseMs))
          if (outcome.status !== 'result') {
            debug(`plugin entry ${running.name} did not release a session after its restart`)
          }
        }),
      )
      await child.request('shutdown', {}, within(bounds.shutdownMs))
    } finally {
      await stopChild(child)
    }
  }

  function fault(running: RunningEntry, found: EntryFault): void {
    if (running.fault !== undefined) return
    running.fault = found
    const leases = [...running.leases]
    running.leases.clear()
    for (const lease of leases) {
      const kind = lease === found.timedOut ? 'timeout' : 'lost'
      lease.end({ kind, message: found.line(lease.remote) })
    }
    running.restarted = track(
      (async () => {
        await stopChild(running.process)
        await running.process.exited
        const handles = [...running.held]
        running.held.clear()
        if (handles.length > 0) await releaseOnly(running, handles)
      })(),
    )
  }

  // A plugin silent past a call's deadline and the cancel grace is stopped, unless agent-qa is
  // already stopping it.
  const hung = (running: RunningEntry, deadlineMs: number, own?: OpenLease): void => {
    if (running.stopping) return
    fault(running, {
      line: silentLine(running.name, deadlineMs),
      ...(own === undefined ? {} : { timedOut: own }),
    })
  }

  const silentRefusal = (
    running: RunningEntry,
    remote: string,
    deadlineMs: number,
  ): RemoteRefusalError => {
    hung(running, deadlineMs)
    return new RemoteRefusalError(silentLine(running.name, deadlineMs)(remote), {
      remote,
      kind: 'timeout',
    })
  }

  const stoppedRefusal = (
    running: RunningEntry,
    remote: string,
    outcome?: Extract<PluginCallOutcome, { status: 'exited' | 'stray' }>,
  ): RemoteRefusalError => {
    const stderr = outcome?.status === 'exited' ? outcome.stderr : undefined
    const line = running.fault?.line ?? crashLine(running.name, stderr)
    return new RemoteRefusalError(line(remote), { remote, kind: 'lost' })
  }

  // An unexpected throw, such as a folder changing under resolution, refuses only this entry.
  async function startEntry(name: string): Promise<EntryStart> {
    try {
      return await startEntryProcess(name)
    } catch (error) {
      return { ok: false, refusal: (remote) => asRefusal(error, remote, name) }
    }
  }

  async function startEntryProcess(name: string): Promise<EntryStart> {
    const entry = input.plugins.find((candidate) => candidate.name === name)
    if (entry === undefined) {
      return {
        ok: false,
        refusal: refusalOf(
          'refused',
          (remote) => `Remote ${remote} names plugins entry ${name}, which plugins does not list.`,
        ),
      }
    }

    const resolved = resolvePluginEntry(entry, {
      configDir: input.configDir,
      agentQaVersion: input.agentQaVersion,
    })
    if (resolved.state !== 'ok') {
      const kind =
        resolved.state === 'version_mismatch' || resolved.state === 'protocol_mismatch'
          ? 'version'
          : 'refused'
      const reason = resolved.reason ?? `Plugin entry ${name} cannot start.`
      return { ok: false, refusal: refusalOf(kind, (remote) => `Remote ${remote}: ${reason}`) }
    }
    const manifest = resolved.manifest
    if (manifest?.kind !== 'remote' || resolved.packageDir === undefined) {
      return {
        ok: false,
        refusal: refusalOf(
          'refused',
          (remote) =>
            `Remote ${remote}: plugin entry ${name} names ${resolved.label}, which is not a remote plugin.`,
        ),
      }
    }

    let options: Record<string, unknown>
    try {
      options = input.resolveSecrets(isRecord(entry.options) ? entry.options : {})
    } catch (error) {
      return { ok: false, refusal: (remote) => asRefusal(error, remote, name) }
    }

    const entryFile = resolve(resolved.packageDir, manifest.entry)
    let running: RunningEntry | undefined
    const child = spawnPlugin(entryFile, () => {
      if (running !== undefined) fault(running, { line: strayLine(name) })
    })
    const runId = input.runFacts?.runId
    const sendsRunId = manifest.runFacts?.includes('runId') === true && runId !== undefined
    const initialize = {
      protocolVersions: supportedPluginProtocols(),
      host: {
        pid: process.pid,
        agentQaVersion: input.agentQaVersion,
        playwrightVersion: input.hostVersions.playwright,
        webdriverioVersion: input.hostVersions.webdriverio,
      },
      entry: name,
      options,
      ...(sendsRunId ? { runFacts: { runId } } : {}),
    }
    const outcome = await child.request('initialize', initialize, within(bounds.initializeMs))

    const fail = (refusal: Refusal): EntryStart => {
      stopInBackground(child)
      return { ok: false, refusal }
    }

    if (outcome.status === 'stray') {
      return fail(refusalOf('refused', strayLine(name)))
    }
    if (outcome.status === 'silent' || (outcome.status !== 'exited' && outcome.cancelled)) {
      return fail(
        refusalOf(
          'timeout',
          (remote) =>
            `Remote ${remote}: plugin entry ${name} did not answer initialize within ${formatMs(bounds.initializeMs)}.`,
        ),
      )
    }
    if (outcome.status === 'exited') {
      return fail(
        refusalOf(
          'refused',
          (remote) => `Remote ${remote}: plugin entry ${name} exited before it answered initialize.`,
        ),
      )
    }
    if (outcome.status === 'error') {
      const kind = pluginErrorKind(outcome)
      return fail(
        refusalOf(kind, (remote) =>
          pluginErrorLine(remote, outcome, { call: 'initialize', entry: name }),
        ),
      )
    }

    const parsed = InitializeResultSchema.safeParse(outcome.result)
    if (!parsed.success) {
      return fail(
        refusalOf(
          'refused',
          (remote) =>
            `Remote ${remote}: plugin entry ${name} answered initialize with something that is not a plugin protocol answer.`,
        ),
      )
    }
    const window = supportedPluginProtocols()
    if (!window.includes(parsed.data.protocolVersion)) {
      return fail(
        refusalOf(
          'version',
          (remote) =>
            `Remote ${remote}: plugin entry ${name} answered with plugin protocol ${parsed.data.protocolVersion}; this agent-qa speaks ${window.join(' and ')}.`,
        ),
      )
    }

    running = {
      name,
      manifest,
      entryFile,
      initialize,
      process: child,
      evidence: {
        entry: name,
        ...(entry.package === undefined ? {} : { package: entry.package }),
        ...(entry.path === undefined ? {} : { path: entry.path }),
        version: resolved.version ?? parsed.data.plugin.version,
        protocol: parsed.data.protocolVersion,
        origin: resolved.origin,
      },
      leases: new Set(),
      releasing: new Set(),
      held: new Set(),
      stopping: false,
    }
    const started = running
    void child.exited.then(() => {
      if (started.stopping) return
      fault(started, { line: crashLine(name, child.stderrLine) })
    })
    return { ok: true, running: started }
  }

  // Once shutdown has begun nothing new starts, so nothing escapes it.
  const entryStart = (name: string): Promise<EntryStart> => {
    if (closing !== undefined) return Promise.resolve({ ok: false, refusal: shutDown })
    let start = starts.get(name)
    if (start === undefined) {
      // A signal shuts every started entry down after its leases' releases, in the same bound.
      unregisterShutdown ??= input.sessions?.register(() => shutdown({ signal: true }), {
        boundMs: bounds.signalMs + SIGNAL_KILL_RESERVE_MS,
      })
      start = startEntry(name)
      starts.set(name, start)
    }
    return start
  }

  const declares = (running: RunningEntry, method: OptionalPluginMethod): boolean =>
    running.manifest.methods.includes(method)

  function openLease(running: RunningEntry, remote: string, answer: AcquireResult): RemoteLease {
    let releasing: Promise<void> | undefined
    let ending: Promise<void> | undefined
    let unregister: (() => void) | undefined
    let before: (() => Promise<void>) | undefined
    let ended: RemoteLeaseEnded | undefined
    const listeners = new Set<(ended: RemoteLeaseEnded) => void>()
    const tell = (listener: (ended: RemoteLeaseEnded) => void, value: RemoteLeaseEnded) => {
      try {
        listener(value)
      } catch (error) {
        debug(`a listener for remote ${remote} failed: ${String(error)}`)
      }
    }
    // Sent once, and never after the session's release has begun.
    const end = (outcome: RemoteLeaseOutcome, reason?: string): Promise<void> => {
      if (releasing !== undefined) return ending ?? Promise.resolve()
      ending ??= (async () => {
        if (!declares(running, 'end') || running.fault !== undefined) return
        const sendsReason = running.manifest.runFacts?.includes('failure') === true
        const answered = await running.process.request(
          'end',
          {
            handle: answer.handle,
            outcome,
            ...(sendsReason && reason !== undefined ? { reason: input.mask(reason) } : {}),
          },
          within(bounds.endMs),
        )
        if (answered.status === 'silent') hung(running, bounds.endMs, open)
        if (answered.status !== 'result') debug(`plugin entry ${running.name} did not answer end`)
      })()
      return ending
    }
    const release = (boundMs: number): Promise<void> => {
      if (releasing === undefined) {
        running.leases.delete(open)
        unregister?.()
        const marked =
          signalDeadline !== undefined && input.marksSessions === true
            ? end('cancelled')
            : Promise.resolve()
        // Whoever asks first, the holder's own teardown, such as deleting its session, goes first.
        const held = marked.then(() =>
          before === undefined
            ? undefined
            : settledWithin(
                Promise.resolve().then(before),
                Math.min(REMOTE_RELEASE_BOUND_MS, left()),
              ),
        )
        const sent = held.then(() => releaseHandle(running, answer.handle, boundMs))
        releasing = sent
        running.releasing.add(sent)
        void sent.finally(() => running.releasing.delete(sent))
      }
      return releasing
    }
    const open: OpenLease = {
      remote,
      release,
      end(value) {
        if (ended !== undefined) return
        ended = value
        for (const listener of [...listeners]) tell(listener, value)
        listeners.clear()
      },
    }
    running.held.add(answer.handle)
    running.leases.add(open)
    unregister = input.sessions?.register(release, { boundMs: PLUGIN_RELEASE_BOUND_MS })

    return {
      connection: {
        protocol: answer.protocol,
        url: answer.url,
        ...(answer.headers === undefined ? {} : { headers: answer.headers }),
        ...(answer.capabilities === undefined ? {} : { capabilities: answer.capabilities }),
      },
      plugin: running.evidence,
      ...(answer.link === undefined ? {} : { link: answer.link }),
      async started({ sessionId }) {
        if (!declares(running, 'started') || running.fault !== undefined) return {}
        const outcome = await running.process.request(
          'started',
          { handle: answer.handle, ...(sessionId === undefined ? {} : { sessionId }) },
          within(bounds.startedMs),
        )
        if (outcome.status === 'silent') hung(running, bounds.startedMs, open)
        const parsed =
          outcome.status === 'result' ? StartedResultSchema.safeParse(outcome.result) : undefined
        if (parsed?.success !== true) {
          debug(`plugin entry ${running.name} did not answer started`)
          return {}
        }
        return {
          ...(parsed.data.link === undefined ? {} : { link: parsed.data.link }),
          ...(parsed.data.appiumVersion === undefined
            ? {}
            : { appiumVersion: parsed.data.appiumVersion }),
        }
      },
      end,
      beforeRelease(step) {
        if (releasing === undefined) before = step
      },
      release: () => release(bounds.releaseMs),
      onEnded(listener) {
        if (ended !== undefined) {
          const value = ended
          let live = true
          queueMicrotask(() => {
            if (live) tell(listener, value)
          })
          return () => {
            live = false
          }
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }

  async function acquire(request: RemoteLeaseRequest): Promise<RemoteLease> {
    const { remote } = request
    const entry = request.plugin.entry
    const start = await entryStart(entry)
    if (!start.ok) throw start.refusal(remote)
    if (closing !== undefined) throw shutDown(remote)
    const running = start.running
    if (running.fault !== undefined) throw stoppedRefusal(running, remote)

    let settings: Record<string, unknown>
    try {
      settings = input.resolveSecrets(request.plugin.settings ?? {})
    } catch (error) {
      throw asRefusal(error, remote, entry)
    }
    const sendsTestName =
      running.manifest.runFacts?.includes('testName') === true && request.testName !== undefined
    const outcome = await running.process.request(
      'acquire',
      {
        remote,
        settings,
        session: request.session,
        ...(sendsTestName ? { run: { testName: request.testName } } : {}),
      },
      {
        timeoutMs: request.deadlineMs,
        onProgress: progressRelay(remote, entry, request.onProgress?.bind(request)),
        onLate: (late) => void releaseCarried(running, late),
      },
    )

    const timedOut = () =>
      new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} did not answer acquire within ${formatMs(request.deadlineMs)}.`,
        { remote, kind: 'timeout' },
      )
    if (outcome.status === 'silent') throw silentRefusal(running, remote, request.deadlineMs)
    if (outcome.status === 'exited' || outcome.status === 'stray') {
      throw stoppedRefusal(running, remote, outcome)
    }
    if (outcome.cancelled) {
      await releaseCarried(running, outcome)
      throw timedOut()
    }
    if (outcome.status === 'error') {
      await releaseCarried(running, outcome)
      throw new RemoteRefusalError(
        pluginErrorLine(remote, outcome, { call: 'remote', entry }),
        { remote, kind: pluginErrorKind(outcome) },
      )
    }

    const parsed = AcquireResultSchema.safeParse(outcome.result)
    if (!parsed.success) {
      await releaseCarried(running, outcome)
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} answered acquire with something that is not a session.`,
        { remote, kind: 'refused' },
      )
    }
    input.onMask?.(entry, parsed.data.mask ?? [])
    const session = request.session
    const unsafe = checkPluginAnswer(parsed.data, {
      serves: running.manifest.serves,
      place: session.platform === 'web' ? 'web' : 'device',
      ...(session.platform === 'web' ? { engine: session.engine } : {}),
      remote,
      entry,
    })
    if (unsafe !== undefined) {
      await releaseCarried(running, outcome)
      throw unsafe
    }
    // A session answered once shutdown has begun is released, never handed out.
    if (closing !== undefined || running.stopping) {
      void releaseCarried(running, outcome)
      throw shutDown(remote)
    }
    if (running.fault !== undefined) {
      running.held.add(parsed.data.handle)
      throw stoppedRefusal(running, remote)
    }
    return openLease(running, remote, parsed.data)
  }

  async function uploadApp(request: PluginUploadRequest): Promise<{ ref: string }> {
    const { remote, path, platform } = request
    const entry = request.plugin.entry
    if (closing !== undefined) throw shutDown(remote)
    let facts: { sha256: string; size: number }
    try {
      facts = await fileFacts(path)
    } catch {
      throw new RemoteRefusalError(`Remote ${remote}: the app at ${path} could not be read.`, {
        remote,
        kind: 'refused',
      })
    }
    if (closing !== undefined) throw shutDown(remote)
    const key = JSON.stringify([entry, platform, facts.sha256])
    let upload = uploads.get(key)
    if (upload === undefined) {
      upload = sendUpload(request, facts)
      uploads.set(key, upload)
    }
    return upload
  }

  async function sendUpload(
    request: PluginUploadRequest,
    facts: { sha256: string; size: number },
  ): Promise<{ ref: string }> {
    const { remote, path, platform } = request
    const entry = request.plugin.entry
    const start = await entryStart(entry)
    if (!start.ok) throw start.refusal(remote)
    const running = start.running
    if (running.fault !== undefined) throw stoppedRefusal(running, remote)
    if (!declares(running, 'uploadApp')) {
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} uploads no apps; set app.ref on the target to an app the service already has.`,
        { remote, kind: 'refused' },
      )
    }
    let settings: Record<string, unknown>
    try {
      settings = input.resolveSecrets(request.plugin.settings ?? {})
    } catch (error) {
      throw asRefusal(error, remote, entry)
    }
    const outcome = await running.process.request(
      'uploadApp',
      { remote, settings, platform, path, sha256: facts.sha256, size: facts.size },
      {
        timeoutMs: request.deadlineMs,
        onProgress: progressRelay(remote, entry, request.onProgress?.bind(request)),
      },
    )
    if (outcome.status === 'silent') throw silentRefusal(running, remote, request.deadlineMs)
    if (outcome.status === 'exited' || outcome.status === 'stray') {
      throw stoppedRefusal(running, remote, outcome)
    }
    if (outcome.cancelled) {
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} did not answer uploadApp within ${formatMs(request.deadlineMs)}.`,
        { remote, kind: 'timeout' },
      )
    }
    if (outcome.status === 'error') {
      throw new RemoteRefusalError(
        pluginErrorLine(remote, outcome, { call: 'remote', entry }),
        { remote, kind: pluginErrorKind(outcome) },
      )
    }
    const parsed = UploadAppResultSchema.safeParse(outcome.result)
    if (!parsed.success || parsed.data.ref.trim() === '') {
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} answered uploadApp with something that is not an app ref.`,
        { remote, kind: 'refused' },
      )
    }
    return { ref: parsed.data.ref }
  }

  async function check(
    entry: string,
    remotes: readonly PluginCheckRemote[],
  ): Promise<CheckResult | undefined> {
    const remote = remotes[0]?.name ?? entry
    const start = await entryStart(entry)
    if (!start.ok) throw start.refusal(remote)
    const running = start.running
    if (!declares(running, 'check')) return undefined
    if (running.fault !== undefined) throw stoppedRefusal(running, remote)

    let params: { remotes: { name: string; settings: Record<string, unknown> }[] }
    try {
      params = {
        remotes: remotes.map((candidate) => ({
          name: candidate.name,
          settings: input.resolveSecrets(candidate.settings ?? {}),
        })),
      }
    } catch (error) {
      throw asRefusal(error, remote, entry)
    }
    const outcome = await running.process.request('check', params, within(bounds.checkMs))
    if (outcome.status === 'result' && !outcome.cancelled) {
      const parsed = CheckResultSchema.safeParse(outcome.result)
      if (parsed.success) return parsed.data
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} answered check with something that is not a check result.`,
        { remote, kind: 'refused' },
      )
    }
    if (outcome.status === 'error' && !outcome.cancelled) {
      throw new RemoteRefusalError(
        pluginErrorLine(remote, outcome, { call: 'remote', entry }),
        { remote, kind: pluginErrorKind(outcome) },
      )
    }
    if (outcome.status === 'exited' || outcome.status === 'stray') {
      throw stoppedRefusal(running, remote, outcome)
    }
    if (outcome.status === 'silent') throw silentRefusal(running, remote, bounds.checkMs)
    throw new RemoteRefusalError(
      `Remote ${remote}: plugin entry ${entry} did not answer check within ${formatMs(bounds.checkMs)}.`,
      { remote, kind: 'timeout' },
    )
  }

  async function stopEntry(running: RunningEntry, signal: boolean): Promise<void> {
    const bound = (ms: number): number => (signal ? bounds.signalMs : ms)
    if (running.fault === undefined) {
      await settledWithinLeft(
        Promise.all([
          ...[...running.leases].map((lease) => lease.release(bound(bounds.releaseMs))),
          ...running.releasing,
        ]),
      )
    }
    if (running.fault !== undefined) {
      await settledWithinLeft(running.restarted ?? Promise.resolve())
      return
    }
    running.stopping = true
    await running.process.request('shutdown', {}, within(bound(bounds.shutdownMs)))
    await stopChild(running.process, bound(bounds.killAfterMs))
  }

  // On a signal every step shares one bound: calls, waits and the release-only restart get what
  // is left of it, and whatever still runs when it is spent is killed.
  // The signal hook stays registered until shutdown settles, so a signal during a slow normal
  // shutdown still reaches the bounded path.
  function shutdown(options: { signal?: boolean } = {}): Promise<void> {
    const signal = options.signal === true
    if (signal) signalDeadline ??= Date.now() + bounds.signalMs
    const closed = (closing ??= (async () => {
      const started = await Promise.allSettled(starts.values())
      await Promise.allSettled(
        started.map((start) =>
          start.status === 'fulfilled' && start.value.ok
            ? stopEntry(start.value.running, signal)
            : undefined,
        ),
      )
      while (background.size > 0) await Promise.all(background)
    })().finally(() => unregisterShutdown?.()))
    if (signalDeadline === undefined) return closed
    signalClosing ??= (async () => {
      await settledWithinLeft(closed)
      await Promise.all(
        [...live].map((child) => {
          const stop = stops.get(child)
          return stop?.bounded === true ? stop.done : child.stop(0, SIGNAL_KILL_AFTER_MS)
        }),
      )
    })()
    return signalClosing
  }

  return { acquire, uploadApp, check, shutdown }
}
