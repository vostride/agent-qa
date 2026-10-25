import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
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
import { pathToFileURL } from 'node:url'

import type { ConfigReaderPort, FunctionRegistry, JobModelCapability } from '@vostride/agent-qa-agent'
import type {
  ComposeJobRecoveryInput,
  ComposeLocalAgentInput,
  CuratorAuthor,
  JobRecoveryHost,
  LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import * as knowledgeLocal from '@vostride/agent-qa-knowledge-local'
import {
  acquireWriterLease,
  claimNextJob,
  enqueueCurationCandidateProjection,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  listQueuedCandidates,
  readJobState,
  readWriterLease,
  releaseLease,
  WriterAuthorityLostError,
} from '@vostride/agent-qa-knowledge-local'
import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  CurationAuthorship,
  Delta,
  ExecutionContext,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { drainViaDaemon } from '../commands/knowledge-maintain.js'
import {
  CURATION_TAIL_RECEIPT_FILE,
  runCurationTail,
  type CurationTailReceipt,
} from '../curation/curation-tail.js'
import { DAEMON_NUDGE_TIMEOUT_MS, nudgeDaemon } from '../daemon/client.js'
import {
  DRAIN_SESSION_RECEIPTS_FILE,
  readDrainSessionReceipts,
} from '../daemon/drain-receipts.js'
import { DAEMON_EVENTS_FILE } from '../daemon/events.js'
import { runDaemonHost, type DaemonHostOperations } from '../daemon/host.js'
import { DAEMON_REGISTRATION_FILE } from '../daemon/registration.js'
import { removeTempRoots } from './temp-roots.js'

const MODEL: JobModelCapability = {
  modelId: 'test:daemon-drain',
  generate: () => Promise.resolve({ text: 'unused' }),
}

const CONFIG: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/agent-qa.config.yaml',
    entries: [],
  }),
}

const CANDIDATE_ID = 'b'.repeat(64)
const SESSION_ID = '00000000-0000-4000-8000-000000000006'
const STOPPED_DAEMON_ROOT_ENV = 'AGENT_QA_STOPPED_DAEMON_ROOT'
const STOPPED_DAEMON_HOST_URL_ENV = 'AGENT_QA_STOPPED_DAEMON_HOST_URL'
const STOPPED_DAEMON_CHILD_SCRIPT = `
const root = process.env.${STOPPED_DAEMON_ROOT_ENV}
const hostUrl = process.env.${STOPPED_DAEMON_HOST_URL_ENV}
if (root === undefined || hostUrl === undefined) throw new Error('stopped daemon fixture missing')
const { runDaemonHost } = await import(hostUrl)
process.exitCode = await runDaemonHost({
  agentQaRoot: root + '/.agent-qa',
  knowledgeRoot: root + '/agent-qa-knowledge',
  config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: root + '/agent-qa.config.yaml', entries: [] }) },
  model: () => ({ modelId: 'test:stopped-daemon', generate: async () => ({ text: 'unused' }) }),
})
`
const TYPESCRIPT_LOADER = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`
const roots: string[] = []

function makeRoot(): { root: string; agentQaRoot: string; knowledgeRoot: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-daemon-drain-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch('run-daemon-drain'))
  mkdirSync(runDir, { recursive: true })
  return {
    root,
    agentQaRoot,
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    runDir,
  }
}

function enqueueRealCandidate(
  knowledgeRoot: string,
  seed: string,
  executionContext: ExecutionContext = 'local-headless',
): string {
  const outcome = enqueueCurationCandidateProjection({
    knowledgeRoot,
    projection: {
      sourceRunId: `run-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext,      kind: 'fact',
      subtype: 'selector',
      anchors: [
        { t: 'el', role: 'button', name: seed, ordinal: 0 },
        { t: 'page', route: `/${seed}` },
        { t: 'selector', literal: `[data-testid="${seed}"]` },
      ],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was resolved and verified.`,
      distilledObservations: [{
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: `${seed}-click`, ordinal: 0 },
        platform: 'web',
        element: { naturalKey: `button:${seed}:0` },
        locator: { selector: `[data-testid="${seed}"]` },
        observedAtOrdinal: 42,
      }],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      artifactDescriptors: [],
      emittedAt: '2026-07-30T00:00:00.000Z',
    },
    artifactSources: [],
  })
  expect(outcome.kind).toBe('enqueued')
  if (outcome.kind !== 'enqueued') throw new Error('expected enqueued candidate')
  return outcome.candidateId
}

function deterministicAuthor(): CuratorAuthor {
  return async (job) => {
    const authorship: CurationAuthorship = {
      path: 'llm',
      model: { id: 'daemon-drain-serving-fixture' },
      executionContext: job.executionContext,
    }
    const delta: Delta = {
      kind: 'Add',
      origin: 'agent',
      scope: job.scope,
      citedIds: [],
      authorship,
      bundle: {
        kind: job.kind,
        ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
        anchors: job.anchors,
        scope: job.scope,
        summary: job.summarySeed,
        body: job.bodySeed,
        distilledEvidenceRef: {
          id: `curation-candidate-${job.candidateId}`,
          sha: job.candidateId,
        },
        originStage: 'run-curation',
      },
    }
    return { kind: 'authored', deltas: [delta], authorship }
  }
}

function fakeRecovery(): JobRecoveryHost {
  return {
    store: { adoptEpoch: () => Promise.resolve({ epoch: 1 }) },
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

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function rawNudge(
  socketPath: string,
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  const encoded = JSON.stringify(body)
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(
      {
        socketPath,
        path: '/nudge',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
          connection: 'close',
        },
      },
      async (response) => {
        response.setEncoding('utf8')
        let text = ''
        for await (const chunk of response) text += String(chunk)
        resolveResponse({ statusCode: response.statusCode ?? 500, body: text })
      },
    )
    outgoing.once('error', rejectResponse)
    outgoing.end(encoded)
  })
}

interface ScheduledHostHarness {
  running: Promise<number>
  fire(intervalMs: number): void
  signal(signal: NodeJS.Signals): void
}

interface ProductionDrainCall {
  options: Parameters<DaemonHostOperations['drainQueue']>[0]
  report: Awaited<ReturnType<DaemonHostOperations['drainQueue']>>
}

interface ProductionDrainHarness extends ScheduledHostHarness {
  drainCalls: ProductionDrainCall[]
}

function startProductionDrainHost(options: {
  paths: ReturnType<typeof makeRoot>
  author: () => CuratorAuthor | Promise<CuratorAuthor>
  configPath?: string
  onCompose?: (input: ComposeLocalAgentInput) => void
}): ProductionDrainHarness {
  const signals = new Map<NodeJS.Signals, () => void>()
  const intervals = new Map<number, { callback: () => void; intervalMs: number }>()
  const drainCalls: ProductionDrainCall[] = []
  let nextTimerId = 1
  const drainQueue = vi.fn<DaemonHostOperations['drainQueue']>(async (drainOptions) => {
    const report = await knowledgeLocal.drainQueue(drainOptions)
    drainCalls.push({ options: drainOptions, report })
    return report
  })
  const operations = {
    composeJobRecovery: (_input: ComposeJobRecoveryInput) => fakeRecovery(),
    composeLocalAgent: (input: ComposeLocalAgentInput) => {
      options.onCompose?.(input)
      return fakeLocalAgent()
    },
    // Keep the production drainer while disabling the unrelated embedder-child lifecycle.
    drainQueue,
    setInterval: (callback: () => void, intervalMs: number) => {
      const timerId = nextTimerId++
      intervals.set(timerId, { callback, intervalMs })
      return timerId as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer as unknown as number)
    },
    setTimeout: () => 99 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: vi.fn(),
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: vi.fn(),
    startInvokeServer: async ({ socketPath }: { socketPath: string }) => ({
      socketPath,
      close: () => Promise.resolve(),
    }),
    randomUUID: () => SESSION_ID,
  } as unknown as Partial<DaemonHostOperations>
  const running = runDaemonHost({
    agentQaRoot: options.paths.agentQaRoot,
    knowledgeRoot: options.paths.knowledgeRoot,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    config: CONFIG,
    model: () => MODEL,
    author: options.author,
    operations,
    logger: { info: vi.fn(), error: vi.fn() },
  })
  return {
    running,
    drainCalls,
    fire(intervalMs) {
      const callbacks = [...intervals.values()]
        .filter((scheduled) => scheduled.intervalMs === intervalMs)
        .map((scheduled) => scheduled.callback)
      if (callbacks.length === 0) throw new Error(`interval ${intervalMs} was not scheduled`)
      for (const callback of callbacks) callback()
    },
    signal(signal) {
      const listener = signals.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
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

function startScheduledHost(options: {
  paths: ReturnType<typeof makeRoot>
  queued: Set<string>
  drainQueue: DaemonHostOperations['drainQueue']
  runMaintenanceTail?: (...args: unknown[]) => unknown
  acquireWriterLease?: DaemonHostOperations['acquireWriterLease']
}): ScheduledHostHarness {
  const signals = new Map<NodeJS.Signals, () => void>()
  const intervals = new Map<number, { callback: () => void; intervalMs: number }>()
  let nextTimerId = 1
  const operations = {
    composeJobRecovery: (_input: ComposeJobRecoveryInput) => fakeRecovery(),
    composeLocalAgent: (_input: ComposeLocalAgentInput) => fakeLocalAgent(),
    inspectDrainableCurationWork: () => ({
      queuedCandidateIds: [...options.queued].sort(),
      recoverableClaimedCandidateIds: [],
    }),
    countRemainingCurationWork: () => ({
      queued: options.queued.size,
      claimedNonterminal: 0,
      quarantined: 0,
    }),
    listQueuedCandidates: () => [...options.queued].sort(),
    drainQueue: options.drainQueue,
    ...(options.acquireWriterLease === undefined
      ? {}
      : { acquireWriterLease: options.acquireWriterLease }),
    ...(options.runMaintenanceTail === undefined
      ? {}
      : { runMaintenanceTail: options.runMaintenanceTail }),
    randomUUID: () => SESSION_ID,
    setInterval: (callback: () => void, intervalMs: number) => {
      const timerId = nextTimerId++
      intervals.set(timerId, { callback, intervalMs })
      return timerId as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => {
      intervals.delete(timer as unknown as number)
    },
    setTimeout: () => 99 as unknown as ReturnType<typeof setTimeout>,
    clearTimeout: vi.fn(),
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals, listener: () => void) => {
      if (signals.get(signal) === listener) signals.delete(signal)
    },
    hardExit: vi.fn(),
    startInvokeServer: async ({ socketPath }: { socketPath: string }) => ({
      socketPath,
      close: () => Promise.resolve(),
    }),
  } as unknown as Partial<DaemonHostOperations>
  const running = runDaemonHost({
    agentQaRoot: options.paths.agentQaRoot,
    knowledgeRoot: options.paths.knowledgeRoot,
    config: CONFIG,
    model: () => MODEL,
    author: () => async () => ({ kind: 'fallback-required', reason: 'no-model' }),
    operations,
    logger: { info: vi.fn(), error: vi.fn() },
  })
  return {
    running,
    fire(intervalMs) {
      const callbacks = [...intervals.values()]
        .filter((scheduled) => scheduled.intervalMs === intervalMs)
        .map((scheduled) => scheduled.callback)
      if (callbacks.length === 0) throw new Error(`interval ${intervalMs} was not scheduled`)
      for (const callback of callbacks) callback()
    },
    signal(signal) {
      const listener = signals.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  removeTempRoots(roots.splice(0))
})

describe('daemon curation serving tracer', () => {
  it('refreshes the daemon-owned posture preparation when the eval root appears and disappears', async () => {
    const paths = makeRoot()
    const configPath = join(paths.root, 'agent-qa.config.yaml')
    writeFileSync(configPath, JSON.stringify({
      workspace: { testMatch: ['tests/**/*.yaml'], suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml', envFile: '.env', secretsFile: '.env.secrets.local' },
      use: { mobile: { appState: 'preserve' } },
    }))
    let composed: ComposeLocalAgentInput | undefined
    const host = startProductionDrainHost({ paths, configPath,
      author: () => async () => ({ kind: 'fallback-required', reason: 'no-model' }),
      onCompose: input => { composed = input },
    })
    await waitUntil(() => composed !== undefined, 'daemon did not compose its read port')
    try {
      const candidate = { id: CANDIDATE_ID, product: 'shop',
        scope: { tier: 'product' as const, key: 'shop' },
        provenance: { runIds: ['freshness'], receiptDigests: [], capturedAtOrdinals: [1] },
      }
      const prepare = composed!.resolvePromotionPosture!
      expect((await prepare())?.(candidate)).toBeUndefined()
      const committedRoot = join(paths.root, 'agent-qa-eval')
      mkdirSync(join(committedRoot, 'reports/noise-floor'), { recursive: true })
      expect((await prepare())?.(candidate)).toBeUndefined()
      writeFileSync(join(committedRoot, 'reports/noise-floor/any-profile.json'), '{}')
      expect((await prepare())?.(candidate)).toMatchObject({ kind: 'unavailable' })
      rmSync(committedRoot, { recursive: true })
      expect((await prepare())?.(candidate)).toBeUndefined()
    } finally {
      host.signal('SIGTERM')
      expect(await host.running).toBe(0)
    }
  })

  it('receipts a handed-off tail, nudges once, drains under standing authority, and receipts the session', async () => {
    const paths = makeRoot()
    const queued = new Set<string>()
    const signals = new Map<NodeJS.Signals, () => void>()
    const drainQueue = vi.fn<DaemonHostOperations['drainQueue']>(async (options) => {
      expect(options).toMatchObject({
        knowledgeRoot: paths.knowledgeRoot,
        budgetMs: 'unbounded',
        executionContext: 'local-headless',
        maintenance: 'skip',
        lease: { epoch: 1 },
      })
      const jobsProcessed = queued.size
      queued.clear()
      return {
        kind: 'drained',
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
        writerPass: { kind: 'skipped', reason: 'daemon-cadence' },
        gc: { kind: 'skipped', reason: 'daemon-cadence' },
        remaining: 0,
        remainingWork: { queued: 0, claimedNonterminal: 0, quarantined: 0 },
      }
    })
    const hostOperations = {
      composeJobRecovery: (_input: ComposeJobRecoveryInput) => fakeRecovery(),
      composeLocalAgent: (_input: ComposeLocalAgentInput) => fakeLocalAgent(),
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
      randomUUID: () => SESSION_ID,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: vi.fn(),
      setTimeout: () => 2 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: vi.fn(),
      onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
      offSignal: (signal: NodeJS.Signals, listener: () => void) => {
        if (signals.get(signal) === listener) signals.delete(signal)
      },
      hardExit: vi.fn(),
    } as unknown as Partial<DaemonHostOperations>
    const author = vi.fn<CuratorAuthor>(async () => ({
      kind: 'fallback-required',
      reason: 'no-model',
    }))
    const running = runDaemonHost({
      agentQaRoot: paths.agentQaRoot,
      knowledgeRoot: paths.knowledgeRoot,
      config: CONFIG,
      model: () => MODEL,
      author: () => author,
      operations: hostOperations,
      logger: { info: vi.fn(), error: vi.fn() },
    })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'daemon registration was not written',
    )
    const leaseBefore = readFileSync(join(paths.knowledgeRoot, LEASE_FILE), 'utf8')

    const handoff = {
      executionContext: 'local-interactive',
      runId: 'run-daemon-drain',
    } as CompletedRunHandoff
    const order: string[] = []
    const nudge = vi.fn(async (agentQaRoot: string) => {
      order.push('nudge')
      const response = await nudgeDaemon(agentQaRoot)
      expect(response).toEqual({ sessionId: SESSION_ID })
      return response
    })
    await runCurationTail({
      runId: String(handoff.runId),
      agentQaRoot: paths.agentQaRoot,
      knowledgeConfig: { dir: paths.knowledgeRoot },
      configDir: paths.root,
      log: { warn: vi.fn(), info: vi.fn() },
      operations: {
        loadCompletedRunHandoff: () => handoff,
        resolveKnowledgeRoot: () => paths.knowledgeRoot,
        runSafetyScope: (_options, body) => body(),
        emitCurationCandidates: () => {
          queued.add(CANDIDATE_ID)
          return {
            enqueued: 1,
            coalesced: 0,
            capExceeded: 0,
            refused: 0,
            details: [{
              candidateId: CANDIDATE_ID,
              kind: 'fact',
              outcome: { kind: 'enqueued', candidateId: CANDIDATE_ID },
            }],
          }
        },
        openKnowledgeReader: () => ({
          emitCanaryOutcome: vi.fn(),
        }) as unknown as KnowledgeHintReader,
        emitCanaryOutcomes: async () => ({
          emitted: 0,
          refused: 0,
          unresolved: 0,
          canary: { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } },
          procedure: { emitted: 0, refused: 0, unresolved: 0 },
          details: [],
        }),
        foldRunOutcomes: () => ({
          kind: 'applied',
          tests: 0,
          // 390 D-08: this stub asks for no detection, so the fold declares it skipped.
          quarantine: { kind: 'not-evaluated', reason: 'not-requested' },
        }),
        drainQueue: async () => ({
          kind: 'handed-off',
          holder: {
            leaseId: 'daemon-standing-lease',
            pid: process.pid,
            epoch: 1,
            heartbeatAtMs: Date.now(),
          },
          jobsProcessed: 0,
          committed: 0,
          downgraded: 0,
          withheld: 0,
          quarantined: 0,
          requeued: 0,
          failures: 0,
          failureDetails: [],
          noops: 0,
          noopDetails: [],
          reconcile: undefined,
          writerPass: { kind: 'skipped', reason: 'lease-held' },
          gc: { kind: 'skipped', reason: 'lease-held' },
          remaining: 1,
          remainingWork: { queued: 1, claimedNonterminal: 0, quarantined: 0 },
        }),
        listCompletedRunDirs: () => [paths.runDir],
        readCurationTailReceipt: () => undefined,
        writeCurationTailReceipt: (_runDir, receipt: CurationTailReceipt) => {
          order.push('receipt')
          writeFileSync(
            join(paths.runDir, CURATION_TAIL_RECEIPT_FILE),
            `${JSON.stringify(receipt)}\n`,
          )
        },
        nudgeDaemon: nudge,
      },
    })

    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DRAIN_SESSION_RECEIPTS_FILE)),
      'daemon drain receipt was not written',
    )
    expect(order).toEqual(['receipt', 'nudge'])
    expect(nudge).toHaveBeenCalledOnce()
    expect(drainQueue).toHaveBeenCalledOnce()
    expect(readFileSync(join(paths.knowledgeRoot, LEASE_FILE), 'utf8')).toBe(leaseBefore)

    const tailReceipt = JSON.parse(
      readFileSync(join(paths.runDir, CURATION_TAIL_RECEIPT_FILE), 'utf8'),
    ) as CurationTailReceipt
    expect(tailReceipt).toMatchObject({
      drainKind: 'handed-off',
      handoffHolderPid: process.pid,
      candidateIds: [CANDIDATE_ID],
    })
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([{
      ts: expect.any(String),
      sessionId: SESSION_ID,
      holderPid: process.pid,
      epoch: 1,
      candidateIds: [CANDIDATE_ID],
      remainingAfter: 0,
      outcome: 'completed',
      failures: 0,
      quarantined: 0,
    }])
    const events = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string })
    expect(events.filter((event) => event.kind === 'drain-session-start')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'drain-session-end')).toHaveLength(1)

    const registration = JSON.parse(
      readFileSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE), 'utf8'),
    ) as { socketPath: string }
    const malformed = await rawNudge(registration.socketPath, {
      kind: 'candidates-enqueued',
      extra: true,
    })
    expect(malformed.statusCode).toBe(400)
    expect(JSON.parse(malformed.body)).toMatchObject({ name: 'NudgeEnvelopeError' })
    expect(drainQueue).toHaveBeenCalledOnce()

    signals.get('SIGTERM')?.()
    await expect(running).resolves.toBe(0)
  })

  it('treats a missing daemon registration as a successful best-effort no-op', async () => {
    const paths = makeRoot()
    await expect(nudgeDaemon(paths.agentQaRoot)).resolves.toBeUndefined()
    expect(existsSync(join(paths.agentQaRoot, DRAIN_SESSION_RECEIPTS_FILE))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')(
    'exits a delegated drain within its deadline when the real daemon child is SIGSTOPped',
    async () => {
      const paths = makeRoot()
      enqueueRealCandidate(paths.knowledgeRoot, 'stopped-daemon-remainder')
      const loaderPath = join(paths.root, 'typescript-loader.mjs')
      writeFileSync(loaderPath, TYPESCRIPT_LOADER, 'utf8')
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          '--experimental-loader',
          pathToFileURL(loaderPath).href,
          '--input-type=module',
          '--eval',
          STOPPED_DAEMON_CHILD_SCRIPT,
        ],
        {
          env: {
            ...process.env,
            [STOPPED_DAEMON_ROOT_ENV]: paths.root,
            [STOPPED_DAEMON_HOST_URL_ENV]: new URL('../daemon/host.ts', import.meta.url).href,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let childOutput = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { childOutput += chunk })
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { childOutput += chunk })
      const originalExitCode = process.exitCode
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const stderr: string[] = []
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr.push(String(chunk))
        return true
      })

      try {
        await waitUntil(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`daemon child exited before registration:\n${childOutput}`)
          }
          return existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE))
        }, `daemon child never registered:\n${childOutput}`)
        expect(child.kill('SIGSTOP')).toBe(true)

        expect(DAEMON_NUDGE_TIMEOUT_MS).toBe(5_000)
        expect(drainViaDaemon).toBeTypeOf('function')

        process.exitCode = undefined
        const startedAtMs = Date.now()
        await drainViaDaemon(
          {
            configPath: join(paths.agentQaRoot, '..', 'agent-qa.config.yaml'),
            knowledgeRoot: paths.knowledgeRoot,
            runtimeRoot: paths.agentQaRoot,
          },
          {},
          (text) => text,
          { waitTimeoutMs: 250, pollMs: 10 },
        )
        const elapsedMs = Date.now() - startedAtMs

        expect(process.exitCode).toBe(1)
        expect(elapsedMs).toBeLessThan(2_000)
        expect(stderr.join('')).toContain('daemon unresponsive')
        expect(stderr.join('')).toContain('queued 1')
      } finally {
        stdoutWrite.mockRestore()
        stderrWrite.mockRestore()
        process.exitCode = originalExitCode
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGCONT')
          child.kill('SIGKILL')
          await once(child, 'exit')
        }
      }
    },
    15_000,
  )

  it('does not receipt success while the last candidate is claimed and authoring fails', async () => {
    const paths = makeRoot()
    const candidateId = enqueueRealCandidate(paths.knowledgeRoot, 'claimed-not-done')
    let releaseFirstAuthor!: () => void
    const firstAuthorGate = new Promise<void>((resolve) => {
      releaseFirstAuthor = resolve
    })
    let authorCalls = 0
    const fallback = deterministicAuthor()
    const author: CuratorAuthor = async (job, neighbors) => {
      authorCalls += 1
      if (authorCalls === 1) {
        await firstAuthorGate
        throw new Error('injected terminal author failure')
      }
      return fallback(job, neighbors)
    }
    const host = startProductionDrainHost({ paths, author: () => author })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'claimed-not-done daemon did not register',
    )

    host.fire(30_000)
    await waitUntil(
      () => listQueuedCandidates(paths.knowledgeRoot).length === 0,
      'candidate was not claimed',
    )
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([])
    releaseFirstAuthor()
    await waitUntil(
      () => readDrainSessionReceipts(paths.agentQaRoot).length === 1,
      'terminal failure receipt was not written',
    )

    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([{
      ts: expect.any(String),
      sessionId: SESSION_ID,
      holderPid: process.pid,
      epoch: expect.any(Number),
      candidateIds: [candidateId],
      remainingAfter: 1,
      outcome: 'failed',
      failures: 1,
      quarantined: 0,
    }])
    expect(listQueuedCandidates(paths.knowledgeRoot)).toEqual([candidateId])
    expect(authorCalls).toBe(1)

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })
})

describe('daemon stale-claim drain admission', () => {
  it('inventories queued and non-current claims without mutating absent or current roots', () => {
    const inspectDrainableCurationWork = (
      knowledgeLocal as unknown as {
        inspectDrainableCurationWork?: (options: {
          knowledgeRoot: string
          currentLeaseId: string
        }) => {
          queuedCandidateIds: readonly string[]
          recoverableClaimedCandidateIds: readonly string[]
        }
      }
    ).inspectDrainableCurationWork
    expect(inspectDrainableCurationWork).toBeTypeOf('function')
    if (inspectDrainableCurationWork === undefined) return

    const paths = makeRoot()
    expect(inspectDrainableCurationWork({
      knowledgeRoot: join(paths.root, 'absent-knowledge-root'),
      currentLeaseId: 'current-lease',
    })).toEqual({ queuedCandidateIds: [], recoverableClaimedCandidateIds: [] })

    const recoverableId = enqueueRealCandidate(paths.knowledgeRoot, 'recoverable-claim')
    const expired = acquireWriterLease(paths.knowledgeRoot)
    if (expired.kind !== 'acquired') throw new Error('expected expired-lease seed')
    const recoverableClaim = claimNextJob({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: expired.leaseId,
      authority: expired,
    })
    expect(recoverableClaim?.candidateId).toBe(recoverableId)
    expect(releaseLease({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: expired.leaseId,
    })).toEqual({ kind: 'released' })

    const currentId = enqueueRealCandidate(paths.knowledgeRoot, 'current-claim')
    const current = acquireWriterLease(paths.knowledgeRoot)
    if (current.kind !== 'acquired') throw new Error('expected current-lease seed')
    const currentClaim = claimNextJob({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: current.leaseId,
      authority: current,
    })
    expect(currentClaim?.candidateId).toBe(currentId)
    const queuedId = enqueueRealCandidate(paths.knowledgeRoot, 'queued-candidate')

    const before = {
      recoverableClaimPresent: existsSync(recoverableClaim!.candidateDir),
      currentClaimPresent: existsSync(currentClaim!.candidateDir),
      recoverableState: readJobState(paths.knowledgeRoot, recoverableId),
      currentState: readJobState(paths.knowledgeRoot, currentId),
    }
    const expected = {
      queuedCandidateIds: [queuedId],
      recoverableClaimedCandidateIds: [recoverableId],
    }
    expect(inspectDrainableCurationWork({
      knowledgeRoot: paths.knowledgeRoot,
      currentLeaseId: current.leaseId,
    })).toEqual(expected)
    expect(inspectDrainableCurationWork({
      knowledgeRoot: paths.knowledgeRoot,
      currentLeaseId: current.leaseId,
    })).toEqual(expected)
    expect({
      recoverableClaimPresent: existsSync(recoverableClaim!.candidateDir),
      currentClaimPresent: existsSync(currentClaim!.candidateDir),
      recoverableState: readJobState(paths.knowledgeRoot, recoverableId),
      currentState: readJobState(paths.knowledgeRoot, currentId),
    }).toEqual(before)
    expect(releaseLease({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: current.leaseId,
    })).toEqual({ kind: 'released' })
  })

  it('recovers a real expired-lease claim through the production drainer exactly once', async () => {
    const paths = makeRoot()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const candidateId = enqueueRealCandidate(paths.knowledgeRoot, 'expired-daemon-claim')
    const expired = acquireWriterLease(paths.knowledgeRoot)
    if (expired.kind !== 'acquired') throw new Error('expected old writer lease')
    const claimed = claimNextJob({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: expired.leaseId,
      authority: expired,
    })
    expect(claimed?.candidateId).toBe(candidateId)
    expect(claimed === undefined ? false : existsSync(claimed.candidateDir)).toBe(true)
    expect(listQueuedCandidates(paths.knowledgeRoot)).toEqual([])
    expect(readJobState(paths.knowledgeRoot, candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'queued' },
    })

    now.mockReturnValue(1_000_000 + LEASE_HEARTBEAT_TTL_MS + 1)
    const author = vi.fn(deterministicAuthor())
    const authorFactory = vi.fn(() => author)
    const host = startProductionDrainHost({ paths, author: authorFactory })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'replacement daemon did not register',
    )
    const successor = readWriterLease(paths.knowledgeRoot)
    expect(successor).toMatchObject({
      kind: 'parsed',
      lease: { epoch: expired.epoch + 1 },
    })
    if (successor.kind !== 'parsed') throw new Error('expected successor writer lease')

    host.fire(30_000)
    await waitUntil(() => host.drainCalls.length === 1, 'stale claim did not reach drainQueue')
    expect(host.drainCalls[0]).toMatchObject({
      options: {
        knowledgeRoot: paths.knowledgeRoot,
        lease: { leaseId: successor.lease.leaseId, epoch: successor.lease.epoch },
      },
      report: {
        kind: 'drained',
        committed: 1,
        failures: 0,
        remaining: 0,
        reconcile: { jobsRequeued: 1 },
      },
    })
    expect(authorFactory).toHaveBeenCalledOnce()
    expect(author).toHaveBeenCalledOnce()
    expect(readJobState(paths.knowledgeRoot, candidateId).kind).toBe('absent')
    expect(listQueuedCandidates(paths.knowledgeRoot)).toEqual([])

    const sessionEvents = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => (
        event.kind === 'drain-session-start'
        || event.kind === 'job-claimed'
        || event.kind === 'job-completed'
        || event.kind === 'drain-session-end'
      ))
    expect(sessionEvents).toMatchObject([
      {
        kind: 'drain-session-start',
        sessionId: SESSION_ID,
        holderPid: process.pid,
        epoch: successor.lease.epoch,
      },
      {
        kind: 'job-claimed',
        sessionId: SESSION_ID,
        candidateId,
        holderPid: process.pid,
        leaseId: successor.lease.leaseId,
        epoch: successor.lease.epoch,
      },
      {
        kind: 'job-completed',
        sessionId: SESSION_ID,
        candidateId,
        holderPid: process.pid,
        leaseId: successor.lease.leaseId,
        epoch: successor.lease.epoch,
      },
      {
        kind: 'drain-session-end',
        sessionId: SESSION_ID,
        holderPid: process.pid,
        epoch: successor.lease.epoch,
        candidateIds: [candidateId],
      },
    ])

    const eventsBefore = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
    const receiptsBefore = readDrainSessionReceipts(paths.agentQaRoot)
    host.fire(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.drainCalls).toHaveLength(1)
    expect(authorFactory).toHaveBeenCalledOnce()
    expect(author).toHaveBeenCalledOnce()
    expect(readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')).toBe(eventsBefore)
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual(receiptsBefore)

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })

  it('keeps a genuinely empty root free of drain sessions, authoring, and receipts', async () => {
    const paths = makeRoot()
    const authorFactory = vi.fn(() => deterministicAuthor())
    const host = startProductionDrainHost({ paths, author: authorFactory })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'empty-root daemon did not register',
    )

    host.fire(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.drainCalls).toEqual([])
    expect(authorFactory).not.toHaveBeenCalled()
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([])
    const events = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
    expect(events).not.toMatch(/drain-session-|job-claimed|job-completed/)

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })

  it('does not advertise or mutate a claim owned by the daemon current lease', async () => {
    const paths = makeRoot()
    const authorFactory = vi.fn(() => deterministicAuthor())
    const host = startProductionDrainHost({ paths, author: authorFactory })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'current-holder daemon did not register',
    )
    const current = readWriterLease(paths.knowledgeRoot)
    if (current.kind !== 'parsed') throw new Error('expected standing daemon lease')

    const candidateId = enqueueRealCandidate(paths.knowledgeRoot, 'current-daemon-claim')
    const claimed = claimNextJob({
      knowledgeRoot: paths.knowledgeRoot,
      leaseId: current.lease.leaseId,
      authority: current.lease,
    })
    expect(claimed?.candidateId).toBe(candidateId)
    expect(listQueuedCandidates(paths.knowledgeRoot)).toEqual([])

    host.fire(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.drainCalls).toEqual([])
    expect(authorFactory).not.toHaveBeenCalled()
    expect(claimed === undefined ? false : existsSync(claimed.candidateDir)).toBe(true)
    expect(readJobState(paths.knowledgeRoot, candidateId)).toMatchObject({
      kind: 'parsed',
      state: { lifecycle: 'queued' },
    })
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([])
    const events = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
    expect(events).not.toMatch(/drain-session-|job-claimed|job-completed/)

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })
})

describe('daemon curation scheduling', () => {
  it('drains work on the 30 second poll backstop when no nudge arrives', async () => {
    const paths = makeRoot()
    const queued = new Set([CANDIDATE_ID])
    const drainQueue = vi.fn<DaemonHostOperations['drainQueue']>(async () => {
      const jobsProcessed = queued.size
      queued.clear()
      return drainReport(jobsProcessed, 0)
    })
    const host = startScheduledHost({ paths, queued, drainQueue })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'scheduled daemon did not register',
    )

    host.fire(30_000)
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DRAIN_SESSION_RECEIPTS_FILE)),
      'poll tick did not drain the curation queue',
    )

    expect(drainQueue).toHaveBeenCalledOnce()
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toHaveLength(1)
    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })

  it('runs maintenance every 300 seconds under the standing lease epoch', async () => {
    const paths = makeRoot()
    const queued = new Set<string>()
    const runMaintenanceTail = vi.fn(async () => ({
      writerPass: { kind: 'not-requested' },
      gc: { kind: 'completed', summary: { trimmedRecordIds: [] } },
      failures: [],
    }))
    const host = startScheduledHost({
      paths,
      queued,
      drainQueue: vi.fn(async () => drainReport(0, 0)),
      runMaintenanceTail,
    })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'maintenance daemon did not register',
    )

    host.fire(300_000)
    await waitUntil(() => runMaintenanceTail.mock.calls.length === 1, 'maintenance did not run')
    expect(runMaintenanceTail).toHaveBeenCalledWith({
      knowledgeRoot: paths.knowledgeRoot,
      lease: expect.objectContaining({ epoch: 1 }),
      embeddingCapability: { kind: 'deferred', reason: 'worker-unavailable' },
    })

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })

  it('routes cadence authority loss through lease-lost teardown without reacquiring', async () => {
    const paths = makeRoot()
    const queued = new Set<string>()
    const acquire = vi.fn((knowledgeRoot: string) => acquireWriterLease(knowledgeRoot))
    const runMaintenanceTail = vi.fn(async () => {
      throw new WriterAuthorityLostError(
        { knowledgeRoot: paths.knowledgeRoot, leaseId: SESSION_ID, epoch: 1 },
        'stale-epoch',
        2,
      )
    })
    const host = startScheduledHost({
      paths,
      queued,
      drainQueue: vi.fn(async () => drainReport(0, 0)),
      runMaintenanceTail,
      acquireWriterLease: acquire,
    })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'authority-loss daemon did not register',
    )

    host.fire(300_000)
    await expect(host.running).resolves.toBe(1)
    expect(acquire).toHaveBeenCalledOnce()
    expect(existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE))).toBe(false)
    expect(readFileSync(join(paths.knowledgeRoot, LEASE_FILE), 'utf8')).not.toBe('')
  })

  it('finishes a multi-pass over-budget queue in one unbounded session', async () => {
    const paths = makeRoot()
    const candidateIds = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]
    const queued = new Set(candidateIds)
    const drainQueue = vi.fn<DaemonHostOperations['drainQueue']>(async (options) => {
      expect(options.budgetMs).toBe('unbounded')
      const next = [...queued].sort()[0]
      if (next !== undefined) queued.delete(next)
      return drainReport(next === undefined ? 0 : 1, queued.size)
    })
    const host = startScheduledHost({ paths, queued, drainQueue })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'unbounded-session daemon did not register',
    )

    host.fire(30_000)
    await waitUntil(
      () => readDrainSessionReceipts(paths.agentQaRoot).length === 1,
      'unbounded session did not complete',
    )
    expect(drainQueue).toHaveBeenCalledTimes(3)
    expect(readDrainSessionReceipts(paths.agentQaRoot)[0]).toMatchObject({
      candidateIds,
      remainingAfter: 0,
    })

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })

  it('keeps an empty poll tick receipt- and event-free', async () => {
    const paths = makeRoot()
    const queued = new Set<string>()
    const drainQueue = vi.fn<DaemonHostOperations['drainQueue']>(async () => drainReport(0, 0))
    const host = startScheduledHost({ paths, queued, drainQueue })
    await waitUntil(
      () => existsSync(join(paths.agentQaRoot, DAEMON_REGISTRATION_FILE)),
      'idle daemon did not register',
    )

    host.fire(30_000)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(drainQueue).not.toHaveBeenCalled()
    expect(readDrainSessionReceipts(paths.agentQaRoot)).toEqual([])
    const events = readFileSync(join(paths.agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
    expect(events).not.toContain('drain-session-')

    host.signal('SIGTERM')
    await expect(host.running).resolves.toBe(0)
  })
})
