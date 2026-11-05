import { resolve } from 'node:path'

import {
  AcquireResultSchema,
  CheckResultSchema,
  InitializeResultSchema,
  PLUGIN_ERROR_CODES,
  PluginErrorDataSchema,
  StartedResultSchema,
  type AcquireResult,
  type CheckResult,
  type OptionalPluginMethod,
  type RemotePluginManifest,
} from '@vostride/agent-qa-plugin-kit/protocol'
import {
  RemoteRefusalError,
  type RemoteFailureKind,
  type RemoteLease,
  type RemoteLeaseRequest,
  type RemoteLeaseSource,
  type RemotePluginEvidence,
  type RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'

import {
  resolvePluginEntry,
  supportedPluginProtocols,
  type PluginEntryInput,
} from '../../plugins/resolve-entries.js'
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

export interface PluginHostPoolInput {
  configDir: string
  plugins: readonly PluginEntryInput[]
  agentQaVersion: string
  hostVersions: { playwright: string; webdriverio: string }
  // Turns `{{secret:NAME}}` references into values; may throw a RemoteRefusalError.
  resolveSecrets: (value: Record<string, unknown>) => Record<string, unknown>
  runFacts?: { runId?: string }
  mask: (text: string) => string
  debugLog?: (line: string) => void
  sessions?: RemoteSessionRegistry
  bounds?: Partial<PluginHostBounds>
}

export interface PluginCheckRemote {
  name: string
  settings?: Record<string, unknown>
}

export interface PluginHostPool extends RemoteLeaseSource {
  // Undefined when the plugin declares no check.
  check(entry: string, remotes: readonly PluginCheckRemote[]): Promise<CheckResult | undefined>
  shutdown(options?: { signal?: boolean }): Promise<void>
}

type Refusal = (remote: string) => RemoteRefusalError

interface OpenLease {
  release(boundMs: number): Promise<void>
}

interface RunningEntry {
  name: string
  manifest: RemotePluginManifest
  process: PluginProcess
  evidence: RemotePluginEvidence
  leases: Set<OpenLease>
}

type EntryStart = { ok: true; running: RunningEntry } | { ok: false; refusal: Refusal }

type ErrorScope = { call: 'initialize'; entry: string } | { call: 'remote'; remote: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Number((ms / 1000).toFixed(1))}s`
}

function refusalOf(kind: RemoteFailureKind, line: (remote: string) => string): Refusal {
  return (remote) => new RemoteRefusalError(line(remote), { remote, kind })
}

function carriedHandle(answer: PluginLateAnswer): unknown {
  if (answer.status === 'result') {
    return isRecord(answer.result) ? answer.result.handle : undefined
  }
  return isRecord(answer.data) ? answer.data.handle : undefined
}

export function createPluginHostPool(input: PluginHostPoolInput): PluginHostPool {
  const bounds: PluginHostBounds = { ...DEFAULT_PLUGIN_HOST_BOUNDS, ...input.bounds }
  const starts = new Map<string, Promise<EntryStart>>()
  const background = new Set<Promise<void>>()
  let closing: Promise<void> | undefined

  const debug = (line: string): void => input.debugLog?.(input.mask(line))

  const track = (work: Promise<void>): Promise<void> => {
    background.add(work)
    void work.finally(() => background.delete(work))
    return work
  }

  const pluginLine = (message: string): string => {
    const first = input.mask(message).split(/\r?\n/, 1)[0]?.trim() ?? ''
    return first === '' ? 'the plugin gave no reason.' : first
  }

  const pluginErrorKind = (outcome: Extract<PluginCallOutcome, { status: 'error' }>) => {
    if (outcome.code === PLUGIN_ERROR_CODES.cancelled) return 'timeout' as const
    const data = PluginErrorDataSchema.safeParse(outcome.data)
    return data.success ? data.data.kind : ('refused' as const)
  }

  const pluginErrorLine = (
    remote: string,
    outcome: Extract<PluginCallOutcome, { status: 'error' }>,
    _scope: ErrorScope,
  ): string => `Remote ${remote}: ${pluginLine(outcome.message)}`

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

  const releaseHandle = (running: RunningEntry, handle: unknown, boundMs: number) =>
    track(
      (async () => {
        const outcome = await running.process.request(
          'release',
          { handle },
          { timeoutMs: boundMs },
        )
        if (outcome.status !== 'result') {
          debug(`plugin entry ${running.name} did not release a session: ${outcome.status}`)
        }
      })(),
    )

  const releaseCarried = (running: RunningEntry, answer: PluginLateAnswer): Promise<void> => {
    const handle = carriedHandle(answer)
    if (handle === undefined) return Promise.resolve()
    return releaseHandle(running, handle, bounds.releaseMs)
  }

  const stopInBackground = (child: PluginProcess): void => {
    void track(child.stop())
  }

  async function startEntry(name: string): Promise<EntryStart> {
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

    const child = startPluginProcess({
      entryFile: resolve(resolved.packageDir, manifest.entry),
      cwd: input.configDir,
      mask: input.mask,
      ...(input.debugLog === undefined ? {} : { debugLog: input.debugLog }),
      cancelGraceMs: bounds.cancelGraceMs,
      killAfterMs: bounds.killAfterMs,
    })
    const runId = input.runFacts?.runId
    const sendsRunId = manifest.runFacts?.includes('runId') === true && runId !== undefined
    const outcome = await child.request(
      'initialize',
      {
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
      },
      { timeoutMs: bounds.initializeMs },
    )

    const fail = (refusal: Refusal): EntryStart => {
      stopInBackground(child)
      return { ok: false, refusal }
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

    return {
      ok: true,
      running: {
        name,
        manifest,
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
      },
    }
  }

  const entryStart = (name: string): Promise<EntryStart> => {
    let start = starts.get(name)
    if (start === undefined) {
      start = startEntry(name)
      starts.set(name, start)
    }
    return start
  }

  const declares = (running: RunningEntry, method: OptionalPluginMethod): boolean =>
    running.manifest.methods.includes(method)

  function openLease(running: RunningEntry, answer: AcquireResult): RemoteLease {
    let releasing: Promise<void> | undefined
    let unregister: (() => void) | undefined
    const release = (boundMs: number): Promise<void> => {
      if (releasing === undefined) {
        running.leases.delete(open)
        unregister?.()
        releasing = releaseHandle(running, answer.handle, boundMs)
      }
      return releasing
    }
    const open: OpenLease = { release }
    running.leases.add(open)
    unregister = input.sessions?.register(release)

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
        if (!declares(running, 'started')) return {}
        const outcome = await running.process.request(
          'started',
          { handle: answer.handle, ...(sessionId === undefined ? {} : { sessionId }) },
          { timeoutMs: bounds.startedMs },
        )
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
      async end(outcome, reason) {
        if (!declares(running, 'end')) return
        const sendsReason = running.manifest.runFacts?.includes('failure') === true
        const answered = await running.process.request(
          'end',
          {
            handle: answer.handle,
            outcome,
            ...(sendsReason && reason !== undefined ? { reason: input.mask(reason) } : {}),
          },
          { timeoutMs: bounds.endMs },
        )
        if (answered.status !== 'result') debug(`plugin entry ${running.name} did not answer end`)
      },
      release: () => release(bounds.releaseMs),
    }
  }

  async function acquire(request: RemoteLeaseRequest): Promise<RemoteLease> {
    const { remote } = request
    const entry = request.plugin.entry
    if (closing !== undefined) {
      throw new RemoteRefusalError(`Remote ${remote}: the plugin host has shut down.`, {
        remote,
        kind: 'ended',
      })
    }
    const start = await entryStart(entry)
    if (!start.ok) throw start.refusal(remote)
    const running = start.running

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
        onLate: (late) => void releaseCarried(running, late),
      },
    )

    const timedOut = () =>
      new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} did not answer acquire within ${formatMs(request.deadlineMs)}.`,
        { remote, kind: 'timeout' },
      )
    if (outcome.status === 'silent') throw timedOut()
    if (outcome.status === 'exited') {
      throw new RemoteRefusalError(
        `Remote ${remote}: plugin entry ${entry} exited before it answered acquire.`,
        { remote, kind: 'lost' },
      )
    }
    if (outcome.cancelled) {
      await releaseCarried(running, outcome)
      throw timedOut()
    }
    if (outcome.status === 'error') {
      await releaseCarried(running, outcome)
      throw new RemoteRefusalError(
        pluginErrorLine(remote, outcome, { call: 'remote', remote }),
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
    return openLease(running, parsed.data)
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
    const outcome = await running.process.request('check', params, {
      timeoutMs: bounds.checkMs,
    })
    if (outcome.status === 'result' && !outcome.cancelled) {
      const parsed = CheckResultSchema.safeParse(outcome.result)
      if (parsed.success) return parsed.data
    }
    if (outcome.status === 'error' && !outcome.cancelled) {
      throw new RemoteRefusalError(
        pluginErrorLine(remote, outcome, { call: 'remote', remote }),
        { remote, kind: pluginErrorKind(outcome) },
      )
    }
    throw new RemoteRefusalError(
      `Remote ${remote}: plugin entry ${entry} did not answer check within ${formatMs(bounds.checkMs)}.`,
      { remote, kind: 'timeout' },
    )
  }

  async function stopEntry(running: RunningEntry, signal: boolean): Promise<void> {
    const bound = (ms: number): number => (signal ? bounds.signalMs : ms)
    await Promise.all([...running.leases].map((lease) => lease.release(bound(bounds.releaseMs))))
    await running.process.request('shutdown', {}, { timeoutMs: bound(bounds.shutdownMs) })
    await running.process.stop(bound(bounds.killAfterMs))
  }

  function shutdown(options: { signal?: boolean } = {}): Promise<void> {
    closing ??= (async () => {
      const signal = options.signal === true
      const started = await Promise.all(starts.values())
      await Promise.all(
        started.map((start) => (start.ok ? stopEntry(start.running, signal) : undefined)),
      )
      await Promise.all(background)
    })()
    return closing
  }

  return { acquire, check, shutdown }
}
