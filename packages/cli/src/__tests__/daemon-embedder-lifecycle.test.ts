import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { ConfigReaderPort, FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import type {
  ComposeJobRecoveryInput,
  ComposeLocalAgentInput,
  JobRecoveryHost,
  LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import {
  EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
  readEmbedderWorkerRegistration,
  resolveProcessIncarnation,
} from '@vostride/agent-qa-knowledge-local'
import { DEFAULT_EMBEDDING_PROFILE, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CURATION_QUEUE_POLL_MS, MAINTENANCE_CADENCE_MS } from '../daemon/host.js'
import {
  EMBEDDER_WORKER_IDLE_MS,
  EMBEDDER_WORKER_START_TIMEOUT_MS,
  EMBEDDER_WORKER_TERM_GRACE_MS,
  runDaemonHost,
  type DaemonHostOperations,
  type EmbedderWorkerRegistration,
  type EmbedderWorkerSpawnOptions,
} from '../daemon/host.js'

const MODEL: JobModelCapability = {
  modelId: 'test:daemon-embedder-lifecycle',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/agent-qa.config.yaml',
    entries: [],
  }),
}

const SESSION_IDS = [
  '00000000-0000-4000-8000-000000000071',
  '00000000-0000-4000-8000-000000000072',
  '00000000-0000-4000-8000-000000000073',
]
const ORPHAN_INSTANCE_ID = '00000000-0000-4000-8000-000000000081'
const REUSED_PID_INSTANCE_ID = '00000000-0000-4000-8000-000000000082'
const roots: string[] = []
const surrogates: ChildProcess[] = []

function orphanRegistration(
  instanceId = ORPHAN_INSTANCE_ID,
  profile: EmbedderWorkerRegistration['profile'] = DEFAULT_EMBEDDING_PROFILE,
  overrides: Partial<Pick<EmbedderWorkerRegistration, 'pid' | 'incarnation'>> = {},
): EmbedderWorkerRegistration {
  return {
    schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
    instanceId,
    pid: overrides.pid ?? (instanceId === REUSED_PID_INSTANCE_ID ? 8_802 : 8_801),
    socketPath: join(tmpdir(), `agent-qa-orphan-${instanceId}.sock`),
    profile,
    startedAtMs: 1_785_000_000_000,
    incarnation: overrides.incarnation ?? 'proc-starttime:1785000000000',
  }
}

/**
 * A real, unrelated live process standing in for whoever the kernel handed a dead worker's pid to.
 *
 * The reused-pid legs deliberately drive the PRODUCTION signal and liveness paths against this
 * child: a guard that only holds against a recording stub proves nothing about whether an innocent
 * process survives.
 */
function spawnSurrogate(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 120_000)'], {
    stdio: 'ignore',
  })
  surrogates.push(child)
  if (child.pid === undefined) throw new Error('Surrogate process did not receive a pid')
  return child
}

function isSurrogateAlive(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false
  try {
    process.kill(child.pid!, 0)
    return true
  } catch {
    return false
  }
}

function fakeRecovery(): JobRecoveryHost {
  return {
    store: { adoptEpoch: () => Promise.resolve({ epoch: 17 }) },
    recoverAbandonedClaims: () => Promise.resolve({ recovered: 0 }),
    resumePending: () => Promise.resolve([]),
    close: vi.fn(),
  } as unknown as JobRecoveryHost
}

function fakeLocalAgent(): LocalAgentHost {
  return {
    registry: {} as FunctionRegistry,
    jobs: () => Promise.resolve({
      queue: { runNextJob: () => Promise.resolve({ ran: false, reason: 'no-job' }) },
    }),
    close: vi.fn(),
  } as unknown as LocalAgentHost
}

function drainReport(jobsProcessed: number, remaining: number) {
  return {
    kind: 'drained' as const,
    jobsProcessed,
    committed: jobsProcessed,
    downgraded: 0,
    withheld: 0,
    quarantined: 0,
    requeued: 0,
    failures: 0,
    failureDetails: [],
    noops: 0,
    noopDetails: [],
    reconcile: undefined,
    writerPass: { kind: 'skipped' as const, reason: 'daemon-cadence' as const },
    gc: { kind: 'skipped' as const, reason: 'daemon-cadence' as const },
    remaining,
    remainingWork: { queued: remaining, claimedNonterminal: 0, quarantined: 0 },
  }
}

class StubWorker extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    if (signal === 'SIGTERM' && this.ignoreTerm) return true
    this.finish(0, signal)
    return true
  })

  constructor(pid: number, private readonly ignoreTerm = false) {
    super()
    this.pid = pid
  }

  crash(code = 1): void {
    this.finish(code, null)
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess
  }

  private finish(code: number, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    queueMicrotask(() => this.emit('close', code, signal))
  }
}

interface ScheduledTimeout {
  readonly callback: () => void
  readonly delayMs: number
}

interface LifecycleHarness {
  readonly running: Promise<number>
  readonly workers: StubWorker[]
  readonly spawnRequests: EmbedderWorkerSpawnOptions[]
  readonly resetCapability: ReturnType<typeof vi.fn>
  readonly events: Array<Record<string, unknown>>
  readonly errors: string[]
  readonly order: string[]
  readonly processSignals: Array<{ pid: number; signal: NodeJS.Signals }>
  readonly unlinkedSockets: string[]
  readonly drainQueue: ReturnType<typeof vi.fn>
  readonly acquireEmbedder: ReturnType<typeof vi.fn>
  readonly runMaintenanceTail: ReturnType<typeof vi.fn>
  readonly workerRegistrationPath: string
  isStarted(): boolean
  fireInterval(intervalMs: number): void
  timeoutIds(delayMs: number): number[]
  fireTimeout(timerId: number): boolean
  queue(candidateId: string, report: ReturnType<typeof drainReport>): void
  signal(signal: NodeJS.Signals): void
}

function startHarness(
  label: string,
  initialReports: Array<ReturnType<typeof drainReport>>,
  overrides: Partial<{
    waitForEmbedderWorkerReady: (
      agentQaRoot: string,
      pid: number | undefined,
      instanceId: string,
      signal: AbortSignal,
    ) => Promise<EmbedderWorkerRegistration>
    workerIgnoresTerm: boolean
    orphanRegistration: EmbedderWorkerRegistration
    orphanSocketAnswers: boolean
    orphanProcessAlive: boolean
    acquireFromRegistration: boolean
    /** Omit the process-control stubs so the daemon drives real signals against real pids. */
    realProcessControl: boolean
    incarnationVerdict: 'match' | 'mismatch' | 'unverifiable'
    /** Bytes left at the registration path, read back through the real registration schema. */
    plantedRegistrationBytes: Buffer
  }> = {},
): LifecycleHarness {
  const root = mkdtempSync(join(tmpdir(), `agent-qa-daemon-embedder-${label}-`))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const workerRegistrationPath = join(agentQaRoot, 'embedder-worker.json')
  const queued = new Set(['a'.repeat(64)])
  const reports = [...initialReports]
  const signals = new Map<NodeJS.Signals, () => void>()
  const intervals = new Map<number, { callback: () => void; intervalMs: number }>()
  const timeouts = new Map<number, ScheduledTimeout>()
  const workers: StubWorker[] = []
  const workerRegistrations = new Map<number, EmbedderWorkerRegistration>()
  const spawnRequests: EmbedderWorkerSpawnOptions[] = []
  const events: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const order: string[] = []
  const processSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const unlinkedSockets: string[] = []
  const resetCapability = vi.fn()
  const livePids = new Set<number>()
  let nextTimerId = 1
  let nextSessionId = 0

  const drainQueue = vi.fn(async (_options: unknown) => {
    const report = reports.shift()
    if (report === undefined) throw new Error('No drain report queued')
    if (report.remaining === 0) queued.clear()
    return report
  })
  if (overrides.orphanRegistration !== undefined) {
    mkdirSync(agentQaRoot, { recursive: true })
    writeFileSync(
      workerRegistrationPath,
      `${JSON.stringify(overrides.orphanRegistration)}\n`,
    )
    if (overrides.orphanProcessAlive !== false) livePids.add(overrides.orphanRegistration.pid)
  }

  const acquireEmbedder = vi.fn(async () => {
    if (overrides.acquireFromRegistration === true && existsSync(workerRegistrationPath)) {
      return {
        kind: 'ready' as const,
        rung: 'native' as const,
        profile: DEFAULT_EMBEDDING_PROFILE,
        embedder: {
          embedDocument: async () => new Int8Array(DEFAULT_EMBEDDING_PROFILE.dim),
          embedQuery: async () => new Int8Array(DEFAULT_EMBEDDING_PROFILE.dim),
        },
      }
    }
    return {
      kind: 'deferred' as const,
      reason: 'worker-unavailable' as const,
    }
  })
  const runMaintenanceTail = vi.fn(async (_options: unknown) => ({
    writerPass: { kind: 'not-requested' as const },
    gc: { kind: 'completed' as const, summary: { trimmedRecordIds: [] } },
    failures: [],
  }))

  const operations = {
    composeJobRecovery: (_input: ComposeJobRecoveryInput) => fakeRecovery(),
    composeLocalAgent: (_input: ComposeLocalAgentInput) => fakeLocalAgent(),
    acquireWriterLease: () => ({
      kind: 'acquired' as const,
      leaseId: '00000000-0000-4000-8000-000000000017',
      epoch: 17,
    }),
    heartbeatLease: () => ({
      kind: 'heartbeated' as const,
      holder: { pid: process.pid, epoch: 17, heartbeatAtMs: Date.now() },
    }),
    releaseLease: () => {
      order.push('lease-release')
      return { kind: 'released' as const }
    },
    inspectDrainableCurationWork: () => ({
      queuedCandidateIds: [...queued].sort(),
      recoverableClaimedCandidateIds: [],
    }),
    countRemainingCurationWork: () => ({
      queued: queued.size,
      claimedNonterminal: 0,
      quarantined: 0,
    }),
    listQueuedCandidates: () => [...queued].sort(),
    drainQueue,
    acquireEmbedder,
    runMaintenanceTail,
    randomUUID: () => SESSION_IDS[nextSessionId++] ?? SESSION_IDS.at(-1)!,
    setInterval: (callback: () => void, intervalMs: number) => {
      const timerId = nextTimerId++
      intervals.set(timerId, { callback, intervalMs })
      return timerId as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer as unknown as number)
    },
    setTimeout: (callback: () => void, delayMs: number) => {
      const timerId = nextTimerId++
      timeouts.set(timerId, { callback, delayMs })
      return timerId as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      timeouts.delete(timer as unknown as number)
    },
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: (code: number) => {
      throw new Error(`Unexpected hard exit ${code}`)
    },
    startInvokeServer: async ({ socketPath }: { socketPath: string }) => ({
      socketPath,
      close: () => Promise.resolve(),
    }),
    writeDaemonRegistration: vi.fn(),
    appendDrainSessionReceipt: vi.fn(),
    appendDaemonEvent: (_agentQaRoot: string, event: Record<string, unknown>) => {
      events.push(event)
    },
    resolveEmbedderWorkerEntryPath: () => '/fixture/dist/embedder-worker/worker-entry.js',
    spawnEmbedderWorker: (request: EmbedderWorkerSpawnOptions) => {
      order.push('spawn')
      spawnRequests.push(request)
      const worker = new StubWorker(7_100 + workers.length, overrides.workerIgnoresTerm)
      workers.push(worker)
      const instanceId = request.args[3]
      if (instanceId === undefined) throw new Error('Worker instance id was not passed')
      const registration: EmbedderWorkerRegistration = {
        schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
        instanceId,
        pid: worker.pid,
        socketPath: join(agentQaRoot, `embedder-worker-${instanceId}.sock`),
        profile: DEFAULT_EMBEDDING_PROFILE,
        startedAtMs: Date.now(),
        incarnation: `proc-starttime:${worker.pid}`,
      }
      workerRegistrations.set(worker.pid, registration)
      livePids.add(worker.pid)
      return worker.asChildProcess()
    },
    waitForEmbedderWorkerReady:
      overrides.waitForEmbedderWorkerReady ?? ((_agentQaRoot, pid, instanceId) => {
        const registration = pid === undefined ? undefined : workerRegistrations.get(pid)
        if (registration === undefined || registration.instanceId !== instanceId) {
          return Promise.reject(new Error('Expected matching worker registration'))
        }
        mkdirSync(agentQaRoot, { recursive: true })
        writeFileSync(workerRegistrationPath, `${JSON.stringify(registration)}\n`)
        return Promise.resolve(registration)
      }),
    readEmbedderWorkerRegistration: () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(workerRegistrationPath, 'utf8')) as unknown
      } catch {
        return { kind: 'absent' as const }
      }
      if (
        typeof parsed === 'object'
        && parsed !== null
        && 'schemaVersion' in parsed
        && parsed.schemaVersion === EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION
        && 'instanceId' in parsed
        && 'incarnation' in parsed
      ) {
        return { kind: 'parsed' as const, registration: parsed as EmbedderWorkerRegistration }
      }
      return { kind: 'malformed' as const }
    },
    probeEmbedderWorkerSocket: async (socketPath: string) => {
      if (socketPath === overrides.orphanRegistration?.socketPath) {
        return overrides.orphanSocketAnswers !== false
      }
      return true
    },
    embedderWorkerSocketPath: (
      _agentQaRoot: string,
      _projectRoot: string,
      instanceId: string,
    ) => instanceId === overrides.orphanRegistration?.instanceId
      ? overrides.orphanRegistration.socketPath
      : join(agentQaRoot, `embedder-worker-${instanceId}.sock`),
    embedderWorkerProcessIsAlive: (pid: number) => livePids.has(pid),
    verifyEmbedderWorkerIncarnation: (_registration: EmbedderWorkerRegistration) =>
      overrides.incarnationVerdict ?? 'match',
    signalEmbedderWorkerProcess: (pid: number, signal: NodeJS.Signals) => {
      processSignals.push({ pid, signal })
      order.push(`signal:${pid}:${signal}`)
      if (!livePids.has(pid)) return false
      livePids.delete(pid)
      return true
    },
    waitForEmbedderWorkerProcessExit: async (pid: number) => {
      order.push(`wait-dead:${pid}`)
      return !livePids.has(pid)
    },
    unlinkEmbedderWorkerSocket: (socketPath: string) => {
      unlinkedSockets.push(socketPath)
      order.push(`unlink:${socketPath}`)
      rmSync(socketPath, { force: true })
    },
    removeEmbedderWorkerRegistration: (
      _agentQaRoot: string,
      expected: EmbedderWorkerRegistration,
    ) => {
      let current: unknown
      try {
        current = JSON.parse(readFileSync(workerRegistrationPath, 'utf8')) as unknown
      } catch {
        return false
      }
      if (
        typeof current !== 'object'
        || current === null
        || !('instanceId' in current)
        || current.instanceId !== expected.instanceId
      ) {
        return false
      }
      rmSync(workerRegistrationPath, { force: true })
      return true
    },
    resetEmbedderCapability: resetCapability,
  } as unknown as Partial<DaemonHostOperations> & Record<string, unknown>

  if (overrides.plantedRegistrationBytes !== undefined) {
    mkdirSync(agentQaRoot, { recursive: true })
    writeFileSync(workerRegistrationPath, overrides.plantedRegistrationBytes)
    operations.readEmbedderWorkerRegistration = () => readEmbedderWorkerRegistration(agentQaRoot)
  }

  if (overrides.realProcessControl === true) {
    // Production liveness, incarnation, and signal delivery. Only the daemon's surroundings stay
    // stubbed, so "the surrogate is still alive" is a claim about the OS, not about a fake.
    delete operations.embedderWorkerProcessIsAlive
    delete operations.waitForEmbedderWorkerProcessExit
    // Signal delivery stays production (`process.kill` with the ESRCH reading, verbatim), but the
    // DECISION is still recorded: a `processSignals` assertion that only holds because the
    // recorder was deleted measures the harness, not the daemon.
    operations.signalEmbedderWorkerProcess = (pid: number, signal: NodeJS.Signals) => {
      processSignals.push({ pid, signal })
      order.push(`signal:${pid}:${signal}`)
      try {
        process.kill(pid, signal)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    }
    if (overrides.incarnationVerdict === undefined) {
      delete operations.verifyEmbedderWorkerIncarnation
    }
  }

  const running = runDaemonHost({
    agentQaRoot,
    knowledgeRoot,
    config: CONFIG,
    model: () => MODEL,
    author: () => async () => ({ kind: 'fallback-required', reason: 'no-model' }),
    operations,
    logger: { info: vi.fn(), error: (message) => errors.push(message) },
  })

  return {
    running,
    workers,
    spawnRequests,
    resetCapability,
    events,
    errors,
    order,
    processSignals,
    unlinkedSockets,
    drainQueue,
    acquireEmbedder,
    runMaintenanceTail,
    workerRegistrationPath,
    isStarted() {
      return signals.has('SIGTERM')
        && [...intervals.values()].some(
          (scheduled) => scheduled.intervalMs === CURATION_QUEUE_POLL_MS,
        )
    },
    fireInterval(intervalMs) {
      const callbacks = [...intervals.values()]
        .filter((scheduled) => scheduled.intervalMs === intervalMs)
        .map((scheduled) => scheduled.callback)
      if (callbacks.length === 0) throw new Error(`Interval ${intervalMs} was not scheduled`)
      for (const callback of callbacks) callback()
    },
    timeoutIds(delayMs) {
      return [...timeouts.entries()]
        .filter(([, timeout]) => timeout.delayMs === delayMs)
        .map(([timerId]) => timerId)
    },
    fireTimeout(timerId) {
      const timeout = timeouts.get(timerId)
      if (timeout === undefined) return false
      timeouts.delete(timerId)
      timeout.callback()
      return true
    },
    queue(candidateId, report) {
      queued.add(candidateId)
      reports.push(report)
    },
    signal(signal) {
      const listener = signals.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of surrogates.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('daemon embedder-worker lifecycle', () => {
  it('types a missed worker registration deadline and defers the required capability', async () => {
    let observedStartRefusal: unknown
    const harness = startHarness(
      'start-timeout',
      [drainReport(1, 0)],
      {
        waitForEmbedderWorkerReady: (
          _agentQaRoot,
          _pid,
          _instanceId,
          signal,
        ) => new Promise(
          (_resolve, reject) => signal.addEventListener('abort', () => {
            observedStartRefusal = signal.reason
            reject(signal.reason)
          }, { once: true }),
        ),
      },
    )
    await waitUntil(() => harness.isStarted(), 'daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.workers.length === 1, 'worker did not spawn')
    const [startDeadline] = harness.timeoutIds(EMBEDDER_WORKER_START_TIMEOUT_MS)
    expect(startDeadline).toBeDefined()
    expect(harness.fireTimeout(startDeadline!)).toBe(true)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'drain did not defer')

    expect(observedStartRefusal).toMatchObject({
      name: 'EmbedderWorkerTimeoutError',
      phase: 'start',
    })
    expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: { kind: 'deferred', reason: 'worker-unavailable' },
    }))
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: 'embedder-worker-exit',
      reason: 'start-error',
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('defers a drain when worker startup fails without regaining in-process embedding', async () => {
    const harness = startHarness(
      'worker-required-start-failure',
      [drainReport(1, 0)],
      {
        waitForEmbedderWorkerReady: () => Promise.reject(new Error('forced start failure')),
      },
    )
    await waitUntil(() => harness.isStarted(), 'daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'drain did not finish')

    expect(harness.acquireEmbedder).toHaveBeenCalledWith({
      allowDownload: false,
      workerPolicy: 'required',
      agentQaRoot: expect.any(String),
    })
    expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: { kind: 'deferred', reason: 'worker-unavailable' },
    }))
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: 'embedder-worker-exit',
      reason: 'start-error',
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('ensures the worker and threads worker-required capability into scheduled maintenance', async () => {
    const harness = startHarness('maintenance-worker-required', [])
    await waitUntil(() => harness.isStarted(), 'daemon did not start')

    harness.fireInterval(MAINTENANCE_CADENCE_MS)
    await waitUntil(
      () => harness.runMaintenanceTail.mock.calls.length === 1,
      'maintenance did not finish',
    )

    expect(harness.workers).toHaveLength(1)
    expect(harness.acquireEmbedder).toHaveBeenCalledWith({
      allowDownload: false,
      workerPolicy: 'required',
      agentQaRoot: expect.any(String),
    })
    expect(harness.runMaintenanceTail).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: { kind: 'deferred', reason: 'worker-unavailable' },
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('spawns once for repeated session demands and attributes captured output on idle exit', async () => {
    const harness = startHarness('reuse', [drainReport(1, 1), drainReport(1, 0)])
    await waitUntil(() => harness.isStarted(), 'daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 2, 'drain did not finish')
    expect(harness.workers).toHaveLength(1)
    expect(harness.spawnRequests).toEqual([
      expect.objectContaining({
        command: process.execPath,
        cwd: expect.any(String),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ])

    harness.workers[0]!.stdout.write('worker-out')
    harness.workers[0]!.stderr.write('worker-err')
    const [idleTimer] = harness.timeoutIds(EMBEDDER_WORKER_IDLE_MS)
    expect(idleTimer).toBeDefined()
    expect(harness.fireTimeout(idleTimer!)).toBe(true)
    await waitUntil(() => harness.resetCapability.mock.calls.length === 1, 'idle exit not handled')

    const lifecycleEvents = harness.events.filter((event) =>
      event.kind === 'embedder-worker-start' || event.kind === 'embedder-worker-exit')
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({ kind: 'embedder-worker-start' }),
      expect.objectContaining({
        kind: 'embedder-worker-exit',
        reason: 'idle',
        stdout: 'worker-out',
        stderr: 'worker-err',
      }),
    ])

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('cancels the old deadline when a demand arrives just before it and grants a full new window', async () => {
    const harness = startHarness('boundary', [drainReport(1, 0)])
    await waitUntil(() => harness.isStarted(), 'daemon did not start')
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'first drain did not finish')
    const [firstDeadline] = harness.timeoutIds(EMBEDDER_WORKER_IDLE_MS)
    expect(firstDeadline).toBeDefined()

    harness.queue('b'.repeat(64), drainReport(1, 0))
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 2, 'second drain did not finish')
    expect(harness.workers).toHaveLength(1)
    expect(harness.fireTimeout(firstDeadline!)).toBe(false)
    expect(harness.workers[0]!.kill).not.toHaveBeenCalled()

    const [secondDeadline] = harness.timeoutIds(EMBEDDER_WORKER_IDLE_MS)
    expect(secondDeadline).toBeDefined()
    expect(secondDeadline).not.toBe(firstDeadline)
    expect(harness.fireTimeout(secondDeadline!)).toBe(true)
    await waitUntil(() => harness.workers[0]!.kill.mock.calls.length === 1, 'idle kill missing')

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('invalidates on crash and graceful stop, removing the worker before lease release', async () => {
    const harness = startHarness('exit-paths', [drainReport(1, 0)])
    await waitUntil(() => harness.isStarted(), 'daemon did not start')
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.workers.length === 1, 'first worker did not spawn')

    harness.workers[0]!.crash()
    await waitUntil(() => harness.resetCapability.mock.calls.length === 1, 'crash not handled')
    expect(existsSync(harness.workerRegistrationPath)).toBe(false)

    harness.queue('c'.repeat(64), drainReport(1, 0))
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.workers.length === 2, 'replacement worker did not spawn')
    harness.workers[1]!.once('close', () => harness.order.push('worker-close'))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
    expect(harness.resetCapability).toHaveBeenCalledTimes(2)
    expect(harness.workers[1]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(harness.workerRegistrationPath)).toBe(false)
    expect(harness.order.indexOf('worker-close')).toBeLessThan(
      harness.order.indexOf('lease-release'),
    )
    expect(
      harness.events
        .filter((event) => event.kind === 'embedder-worker-exit')
        .map((event) => event.reason),
    ).toEqual(['crash', 'daemon-stop'])
  })

  it('keeps successor registration bytes when predecessor exit callback crosses the publish barrier', async () => {
    const harness = startHarness('exit-callback-barrier', [drainReport(1, 0)])
    await waitUntil(() => harness.isStarted(), 'daemon did not start')
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.workers.length === 1, 'predecessor worker did not spawn')

    const successorBytes = Buffer.from('{"schemaVersion":3,"successor":true}\n')
    writeFileSync(harness.workerRegistrationPath, successorBytes)
    harness.workers[0]!.crash()
    await waitUntil(() => harness.resetCapability.mock.calls.length === 1, 'exit not handled')

    expect(readFileSync(harness.workerRegistrationPath)).toEqual(successorBytes)

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('adopts a matching worker orphaned by predecessor daemon SIGKILL and owns its shutdown', async () => {
    const orphan = orphanRegistration()
    const harness = startHarness(
      'sigkill-orphan-adopt',
      [drainReport(1, 0)],
      {
        orphanRegistration: orphan,
        orphanSocketAnswers: true,
        orphanProcessAlive: true,
        acquireFromRegistration: true,
      },
    )
    await waitUntil(() => harness.isStarted(), 'replacement daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'adopted drain did not finish')

    expect(harness.workers).toHaveLength(0)
    expect(harness.spawnRequests).toHaveLength(0)
    expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: expect.objectContaining({ kind: 'ready' }),
    }))
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: 'embedder-worker-start',
      mode: 'adopted',
      outcome: 'adopted',
      instanceId: orphan.instanceId,
      pid: orphan.pid,
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
    expect(harness.processSignals).toEqual([{ pid: orphan.pid, signal: 'SIGTERM' }])
    expect(harness.unlinkedSockets).toContain(orphan.socketPath)
    expect(existsSync(harness.workerRegistrationPath)).toBe(false)
  })

  it('verified-terminates a mismatched live orphan before spawning a fresh generation', async () => {
    const orphan = orphanRegistration(
      ORPHAN_INSTANCE_ID,
      { ...DEFAULT_EMBEDDING_PROFILE, revision: 'incompatible-revision' },
    )
    const harness = startHarness(
      'sigkill-orphan-replace',
      [drainReport(1, 0)],
      {
        orphanRegistration: orphan,
        orphanSocketAnswers: true,
        orphanProcessAlive: true,
        acquireFromRegistration: true,
      },
    )
    await waitUntil(() => harness.isStarted(), 'replacement daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'replacement drain did not finish')

    expect(harness.workers).toHaveLength(1)
    expect(harness.processSignals).toContainEqual({ pid: orphan.pid, signal: 'SIGTERM' })
    expect(harness.order.indexOf(`wait-dead:${orphan.pid}`)).toBeLessThan(
      harness.order.indexOf('spawn'),
    )
    expect(harness.unlinkedSockets).toContain(orphan.socketPath)
    const successor = JSON.parse(readFileSync(harness.workerRegistrationPath, 'utf8')) as {
      instanceId: string
    }
    expect(successor.instanceId).not.toBe(orphan.instanceId)
    expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: expect.objectContaining({ kind: 'ready' }),
    }))
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: 'embedder-worker-start',
      mode: 'spawned',
      outcome: 'replaced',
      replacedInstanceId: orphan.instanceId,
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'withholds every signal from a live reused pid whose incarnation does not match',
    async () => {
      // The registration is schema-valid, names a live pid, and its socket is dead — the exact
      // evidence the daemon used to treat as licence to SIGTERM-then-SIGKILL. The pid now belongs
      // to an unrelated process, and the ONLY thing that says so is the OS-assigned start time.
      const surrogate = spawnSurrogate()
      // The reader's own start-time format with a value no process has (another is unverifiable).
      const startTimeFormat = String(resolveProcessIncarnation(process.pid)).split(':')[0]
      const orphan = orphanRegistration(REUSED_PID_INSTANCE_ID, DEFAULT_EMBEDDING_PROFILE, {
        pid: surrogate.pid!,
        incarnation: `${startTimeFormat}:0`,
      })
      const harness = startHarness(
        'reused-pid-unsignaled',
        [drainReport(1, 0)],
        {
          orphanRegistration: orphan,
          orphanSocketAnswers: false,
          orphanProcessAlive: true,
          acquireFromRegistration: true,
          realProcessControl: true,
        },
      )
      await waitUntil(() => harness.isStarted(), 'replacement daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(
        () => harness.drainQueue.mock.calls.length === 1,
        'signal-free replacement did not finish',
      )

      // The innocent occupant is untouched: alive, never signalled, and it later exits on its own
      // terms rather than by a signal the daemon guessed its way into sending.
      expect(isSurrogateAlive(surrogate)).toBe(true)
      expect(surrogate.signalCode).toBeNull()

      // Replacement never depended on touching that pid. Generation-specific sockets mean the
      // fresh worker cannot collide with whatever the unverified occupant is doing.
      expect(harness.workers).toHaveLength(1)
      const successor = JSON.parse(readFileSync(harness.workerRegistrationPath, 'utf8')) as {
        instanceId: string
      }
      expect(successor.instanceId).not.toBe(orphan.instanceId)
      expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
        embeddingCapability: expect.objectContaining({ kind: 'ready' }),
      }))
      expect(harness.events).toContainEqual(expect.objectContaining({
        kind: 'embedder-worker-start',
        outcome: 'replaced',
        replacedInstanceId: orphan.instanceId,
        signalWithheld: true,
        incarnationVerdict: 'mismatch',
      }))

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)
      expect(isSurrogateAlive(surrogate)).toBe(true)
    },
    20_000,
  )

  it.skipIf(process.platform === 'win32')(
    'withholds every signal from a live pid whose incarnation cannot be resolved at all',
    async () => {
      // Unverifiable is a refusal, never a default-allow: a pid we cannot attribute is exactly the
      // pid we must not signal, even though it is unambiguously alive.
      const surrogate = spawnSurrogate()
      const orphan = orphanRegistration(REUSED_PID_INSTANCE_ID, DEFAULT_EMBEDDING_PROFILE, {
        pid: surrogate.pid!,
      })
      const harness = startHarness(
        'unverifiable-unsignaled',
        [drainReport(1, 0)],
        {
          orphanRegistration: orphan,
          orphanSocketAnswers: false,
          orphanProcessAlive: true,
          acquireFromRegistration: true,
          realProcessControl: true,
          incarnationVerdict: 'unverifiable',
        },
      )
      await waitUntil(() => harness.isStarted(), 'replacement daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(
        () => harness.drainQueue.mock.calls.length === 1,
        'signal-free replacement did not finish',
      )

      expect(isSurrogateAlive(surrogate)).toBe(true)
      expect(surrogate.signalCode).toBeNull()
      expect(harness.workers).toHaveLength(1)
      expect(existsSync(harness.workerRegistrationPath)).toBe(true)
      expect(harness.events).toContainEqual(expect.objectContaining({
        kind: 'embedder-worker-start',
        outcome: 'replaced',
        signalWithheld: true,
        incarnationVerdict: 'unverifiable',
      }))

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)
      expect(isSurrogateAlive(surrogate)).toBe(true)
    },
    20_000,
  )

  it.skipIf(process.platform === 'win32')(
    'still terminates a real dead-socket orphan whose incarnation matches its registration',
    async () => {
      // The load-bearing accepting control. A guard that refused everything would pass both legs
      // above and fail here, so this is what makes the fix non-trivial: a verified owner is still
      // TERM-bounded and reaped before its replacement starts.
      const owner = spawnSurrogate()
      const orphan = orphanRegistration(ORPHAN_INSTANCE_ID, DEFAULT_EMBEDDING_PROFILE, {
        pid: owner.pid!,
      })
      const harness = startHarness(
        'verified-owner-terminated',
        [drainReport(1, 0)],
        {
          orphanRegistration: orphan,
          orphanSocketAnswers: false,
          orphanProcessAlive: true,
          acquireFromRegistration: true,
          realProcessControl: true,
          incarnationVerdict: 'match',
        },
      )
      await waitUntil(() => harness.isStarted(), 'replacement daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(
        () => harness.drainQueue.mock.calls.length === 1,
        'verified replacement did not finish',
      )

      expect(isSurrogateAlive(owner)).toBe(false)
      expect(owner.signalCode).toBe('SIGTERM')
      expect(harness.workers).toHaveLength(1)
      expect(harness.events).toContainEqual(expect.objectContaining({
        kind: 'embedder-worker-start',
        outcome: 'replaced',
        replacedInstanceId: orphan.instanceId,
        signalWithheld: false,
      }))

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)
    },
    20_000,
  )

  it.skipIf(process.platform === 'win32')(
    'withholds every shutdown signal from an adopted worker it cannot attribute',
    async () => {
      // The other half of 386-32 prohibition #1. Replacement already refuses to signal a pid it
      // cannot attribute; shutdown did not, and its own module's docstring says neither verdict
      // may be signalled. The registered pid here belongs to an unrelated live process, exactly
      // as it would after an adopted worker died and the kernel recycled its number.
      const surrogate = spawnSurrogate()
      const orphan = orphanRegistration(ORPHAN_INSTANCE_ID, DEFAULT_EMBEDDING_PROFILE, {
        pid: surrogate.pid!,
      })
      const harness = startHarness(
        'adopted-unverifiable-shutdown',
        [drainReport(1, 0)],
        {
          orphanRegistration: orphan,
          orphanSocketAnswers: true,
          orphanProcessAlive: true,
          acquireFromRegistration: true,
          realProcessControl: true,
          incarnationVerdict: 'unverifiable',
        },
      )
      await waitUntil(() => harness.isStarted(), 'adopting daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(
        () => harness.drainQueue.mock.calls.length === 1,
        'adopted drain did not finish',
      )
      // Adoption really happened — an answering generation socket, no spawn, no signal.
      expect(harness.spawnRequests).toHaveLength(0)
      expect(harness.processSignals).toEqual([])

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)

      // The unattributable process survives its own daemon's shutdown, unsignalled.
      expect(isSurrogateAlive(surrogate)).toBe(true)
      expect(surrogate.signalCode).toBeNull()
      expect(harness.processSignals).toEqual([])

      // Withholding the signal does not withhold the cleanup: the registration and the worker's
      // generation socket are still reclaimed, so nothing is left to mislead a successor.
      expect(existsSync(harness.workerRegistrationPath)).toBe(false)
      expect(harness.unlinkedSockets).toContain(orphan.socketPath)

      // And the leak is on the record rather than silent — this is the observable residual the
      // tighten direction accepts in exchange for never killing an unattributable pid.
      expect(harness.events).toContainEqual(expect.objectContaining({
        kind: 'embedder-worker-exit',
        mode: 'adopted',
        pid: orphan.pid,
        signalWithheld: true,
        incarnationVerdict: 'unverifiable',
      }))
    },
    20_000,
  )

  it.skipIf(process.platform === 'win32')(
    'still terminates an adopted worker whose shutdown incarnation matches',
    async () => {
      // The accepting direction, against the production signal path. A predicate that refused
      // everything would pass the leg above and fail here, and the exit record must say so.
      const owner = spawnSurrogate()
      const orphan = orphanRegistration(ORPHAN_INSTANCE_ID, DEFAULT_EMBEDDING_PROFILE, {
        pid: owner.pid!,
      })
      const harness = startHarness(
        'adopted-match-shutdown',
        [drainReport(1, 0)],
        {
          orphanRegistration: orphan,
          orphanSocketAnswers: true,
          orphanProcessAlive: true,
          acquireFromRegistration: true,
          realProcessControl: true,
          incarnationVerdict: 'match',
        },
      )
      await waitUntil(() => harness.isStarted(), 'adopting daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(
        () => harness.drainQueue.mock.calls.length === 1,
        'adopted drain did not finish',
      )
      expect(harness.spawnRequests).toHaveLength(0)

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)

      expect(harness.processSignals).toEqual([{ pid: orphan.pid, signal: 'SIGTERM' }])
      expect(isSurrogateAlive(owner)).toBe(false)
      expect(owner.signalCode).toBe('SIGTERM')
      expect(harness.events).toContainEqual(expect.objectContaining({
        kind: 'embedder-worker-exit',
        mode: 'adopted',
        pid: orphan.pid,
        signalWithheld: false,
        incarnationVerdict: 'match',
      }))
    },
    20_000,
  )

  it.each([
    {
      shape: 'no instanceId and no incarnation, stamped 1',
      planted: {
        schemaVersion: 1,
        pid: 8_811,
        socketPath: join(tmpdir(), 'agent-qa-older-registration.sock'),
        profile: DEFAULT_EMBEDDING_PROFILE,
        startedAtMs: 1_785_000_000_000,
      },
    },
    {
      shape: 'an instanceId and no incarnation, stamped 2',
      planted: {
        schemaVersion: 2,
        instanceId: ORPHAN_INSTANCE_ID,
        pid: 8_812,
        socketPath: join(tmpdir(), `agent-qa-orphan-${ORPHAN_INSTANCE_ID}.sock`),
        profile: DEFAULT_EMBEDDING_PROFILE,
        startedAtMs: 1_785_000_000_000,
      },
    },
    {
      shape: 'every current field, stamped 3',
      planted: { ...orphanRegistration(), schemaVersion: 3, pid: 8_813 },
    },
  ])(
    'an older registration file is refused, left in place, and no pid is signalled: $shape',
    async ({ planted }) => {
      const bytes = Buffer.from(`${JSON.stringify(planted)}\n`)
      const harness = startHarness('older-registration', [drainReport(1, 0)], {
        plantedRegistrationBytes: bytes,
      })
      await waitUntil(() => harness.isStarted(), 'daemon did not start')

      harness.fireInterval(CURATION_QUEUE_POLL_MS)
      await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'drain did not finish')

      expect(harness.errors).toContainEqual(expect.stringContaining(
        `Embedder worker registration ${harness.workerRegistrationPath} is malformed or was `
          + 'written by an older agent-qa build; refusing to overwrite it. Remove the file once',
      ))
      expect(harness.processSignals).toEqual([])
      expect(harness.workers).toHaveLength(0)
      expect(harness.unlinkedSockets).toEqual([])
      expect(readFileSync(harness.workerRegistrationPath)).toEqual(bytes)
      expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
        embeddingCapability: { kind: 'deferred', reason: 'worker-unavailable' },
      }))

      harness.signal('SIGTERM')
      await expect(harness.running).resolves.toBe(0)
      expect(harness.processSignals).toEqual([])
      expect(readFileSync(harness.workerRegistrationPath)).toEqual(bytes)
    },
  )

  it('keeps every adopted-shutdown signal below the verified-match gate', () => {
    // The behavioural legs prove the current predicate; this pins the SHAPE that makes it hold.
    // TERM-then-KILL escalation is two calls by construction, so "one call site" is not the
    // available property — "no call site is reachable without a match" is, and it is what a later
    // edit could silently break by hoisting a signal above the gate.
    const source = readFileSync(
      new URL('../daemon/host.ts', import.meta.url),
      'utf8',
    )
    const arm = source.slice(
      source.indexOf('const stopEmbedderWorker = async ('),
      source.indexOf('const cleanOwnedEmbedderWorkerResources = ('),
    )
    expect(arm.length).toBeGreaterThan(0)

    const gate = arm.indexOf("if (incarnationVerdict !== 'match') {")
    expect(gate, 'the adopted arm must withhold on every non-match verdict').toBeGreaterThan(-1)
    expect(
      arm.split("operations.verifyEmbedderWorkerIncarnation(").length - 1,
      'one verdict, read once, for the whole arm',
    ).toBe(1)

    const signalSites: number[] = []
    for (
      let at = arm.indexOf('operations.signalEmbedderWorkerProcess(');
      at !== -1;
      at = arm.indexOf('operations.signalEmbedderWorkerProcess(', at + 1)
    ) {
      signalSites.push(at)
    }
    expect(signalSites.length, 'the adopted arm signals only via TERM then KILL').toBe(2)
    for (const site of signalSites) expect(site).toBeGreaterThan(gate)
  })

  it('serializes concurrent ensure calls until one fresh worker registration is ready', async () => {
    let publishRegistration: (() => void) | undefined
    const harness = startHarness(
      'double-ensure',
      [drainReport(1, 0)],
      {
        acquireFromRegistration: true,
        waitForEmbedderWorkerReady: (agentQaRoot, pid, instanceId) => new Promise((resolve) => {
          const registration: EmbedderWorkerRegistration = {
            schemaVersion: EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION,
            instanceId,
            pid: pid!,
            socketPath: join(agentQaRoot, `embedder-worker-${instanceId}.sock`),
            profile: DEFAULT_EMBEDDING_PROFILE,
            startedAtMs: Date.now(),
            incarnation: `proc-starttime:${pid!}`,
          }
          publishRegistration = () => {
            mkdirSync(agentQaRoot, { recursive: true })
            writeFileSync(
              join(agentQaRoot, 'embedder-worker.json'),
              `${JSON.stringify(registration)}\n`,
            )
            resolve(registration)
          }
        }),
      },
    )
    await waitUntil(() => harness.isStarted(), 'daemon did not start')

    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    harness.fireInterval(MAINTENANCE_CADENCE_MS)
    await waitUntil(() => publishRegistration !== undefined, 'fresh worker did not begin startup')
    expect(harness.workers).toHaveLength(1)
    publishRegistration!()
    await waitUntil(
      () => harness.drainQueue.mock.calls.length === 1
        && harness.runMaintenanceTail.mock.calls.length === 1,
      'concurrent demands did not finish',
    )

    expect(harness.workers).toHaveLength(1)
    expect(harness.drainQueue).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: expect.objectContaining({ kind: 'ready' }),
    }))
    expect(harness.runMaintenanceTail).toHaveBeenCalledWith(expect.objectContaining({
      embeddingCapability: expect.objectContaining({ kind: 'ready' }),
    }))

    harness.signal('SIGTERM')
    await expect(harness.running).resolves.toBe(0)
  })

  it('bounds wedged-worker shutdown with TERM then KILL and reaps before lease release', async () => {
    const harness = startHarness(
      'wedged-shutdown',
      [drainReport(1, 0)],
      { workerIgnoresTerm: true },
    )
    await waitUntil(() => harness.isStarted(), 'daemon did not start')
    harness.fireInterval(CURATION_QUEUE_POLL_MS)
    await waitUntil(() => harness.drainQueue.mock.calls.length === 1, 'drain did not finish')
    const worker = harness.workers[0]!
    worker.once('close', () => harness.order.push('worker-close'))

    harness.signal('SIGTERM')
    await waitUntil(
      () => worker.kill.mock.calls.some(([signal]) => signal === 'SIGTERM'),
      'worker did not receive SIGTERM',
    )
    const termDeadline = harness.timeoutIds(EMBEDDER_WORKER_TERM_GRACE_MS).at(-1)
    expect(termDeadline).toBeDefined()
    expect(harness.fireTimeout(termDeadline!)).toBe(true)
    await waitUntil(
      () => worker.kill.mock.calls.some(([signal]) => signal === 'SIGKILL'),
      'worker did not receive SIGKILL after its TERM grace',
    )
    await expect(harness.running).resolves.toBe(0)

    expect(worker.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(worker.signalCode).toBe('SIGKILL')
    expect(harness.events).toContainEqual(expect.objectContaining({
      kind: 'embedder-worker-terminate-escalated',
      signal: 'SIGKILL',
    }))
    expect(harness.order.indexOf('worker-close')).toBeLessThan(
      harness.order.indexOf('lease-release'),
    )
    expect(existsSync(harness.workerRegistrationPath)).toBe(false)
  }, 15_000)
})
