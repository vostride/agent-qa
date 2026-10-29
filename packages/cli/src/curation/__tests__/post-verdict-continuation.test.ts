import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId, computeBriefDigest, guardCompletedRunHandoff, canonicalJson, sha256hex, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { RunSession, ServedBrief, StepEvidence } from '@vostride/agent-qa-schema'
import { preparationPendingWarning, runInProcessCliRun } from '../../composition/in-process-run-execution.js'
import {
  createInProcessFixture,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import { composeCliLocalAgent } from '../../composition/local-agent-host.js'
import * as localAgentHost from '../../composition/local-agent-host.js'
import { DRAIN_BUDGET_MS, resolveRunExecutionContext } from '@vostride/agent-qa-agent-local'
import { generateRunId } from '@vostride/agent-qa-ids'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { ownPostVerdictContinuation, postVerdictPendingPath } from '../post-verdict-continuation.js'
import { runPostRunTail } from '../post-run-tail.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPostVerdictStep } from '../post-verdict-step.js'
import { recoverPendingPostVerdictContinuations } from '../post-verdict-continuation.js'
import { CURATION_QUEUE_POLL_MS, runDaemonHost, type DaemonHostOperations } from '../../daemon/host.js'
import { Command } from 'commander'
import { createRunCommand } from '../../commands/run.js'
import * as drive from '../../composition/in-process-run-execution.js'
import * as tailComposition from '../post-run-tail-composition.js'
import { closeTestRunRecords, freshUpdateCheckHome, testRunRecord } from '../../composition/__tests__/in-process-run-fixture.js'

// the run command resolves its context from the environment, so a CI
// runner reads the CI sentence.
const preparationLine = (pendingPath: string): string =>
  preparationPendingWarning('', pendingPath, resolveRunExecutionContext()).replace(/^Run : /u, '')

// every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => { removeInProcessFixtures() })

// The run command's update notice answers from a fresh cache in a temporary HOME, so a cell that
// drives the command neither fetches the registry nor reads or writes the real ~/.agent-qa.
function isolateUpdateCheck(): void {
  const home = freshUpdateCheckHome()
  roots.push(home)
  vi.stubEnv('HOME', home)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type ComposeHost = typeof composeCliLocalAgent

/** A host whose analyze-run enqueue waits for `release`, and throws instead when `fail` says so. */
function holdingHost(compose: ComposeHost, gate: {
  readonly reached: () => void
  readonly release: Promise<void>
  readonly fail?: () => boolean
}): ComposeHost {
  return (input) => {
    const host = compose(input)
    return { ...host, jobs: async () => {
      const jobs = await host.jobs()
      return { ...jobs, queue: { ...jobs.queue, enqueue: async (...args: Parameters<typeof jobs.queue.enqueue>) => {
        if (args[0] === 'analyze-run') {
          gate.reached()
          await gate.release
          if (gate.fail?.() === true) throw new Error('private provider exception must stay hidden')
        }
        return await jobs.queue.enqueue(...args)
      } } }
    } }
  }
}

/** Holds every analyze-run enqueue the run's own post-verdict step makes until released. */
function holdAnalysisEnqueue() {
  const reached = deferred<void>()
  const release = deferred<void>()
  const calls = vi.fn(() => reached.resolve())
  const actual = localAgentHost.composeCliLocalAgent
  vi.spyOn(localAgentHost, 'composeCliLocalAgent')
    .mockImplementation(holdingHost(actual, { reached: calls, release: release.promise }))
  return { reached: reached.promise, release: () => release.resolve(), calls }
}

it.each(['settles', 'host deadline expires', 'abort', 'detached tail', 'framework error'] as const)('retains host ownership after the real runner timeout until the analysis is queued: %s', async (mode) => {
  const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  roots.push(fixture.project)
  const fetchTrap = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
  const held = holdAnalysisEnqueue()
  const brief: ServedBrief = {
    scope: { tier: 'product', key: fixture.targetName }, asOfBuild: 1, budget: 1000,
    truncation: 'none', channel1: [{ id: asRecordId(`rec-${sha256hex(fixture.directTestId)}`), kind: 'fact',
      summary: 'checkout candidate', trust: 0.5, status: 'candidate', servedAsCanary: false, tier: 'L1' }],
    channel2: [], channel3: [], briefDigest: '',
  }
  const evidence: StepEvidence = { stepIndex: 0, stepText: 'Open checkout', cacheStatus: 'miss',
    servedBrief: { ...brief, briefDigest: computeBriefDigest(brief) }, subActions: [],
    verifierVerdict: { pass: false, reasoning: 'checkout remains closed' } }
  let session!: RunSession
  let hostSettled = false
  let runnerSettled = false
  const abort = new AbortController()
  const detached = vi.fn(async () => undefined)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const running = runInProcessCliRun({
    runRecord: testRunRecord(),
    configPath: fixture.configPath, agentQaRoot: fixture.agentQaRoot,
    postVerdictSignal: abort.signal,
    ...(mode === 'detached tail' ? { postRunTail: detached } : {}),
    executionContext: 'local-headless',
    onSession: (value) => { session = value; void value.done.then(() => { runnerSettled = true }) },
    produceMembers: async () => ({
      members: [{ testId: fixture.directTestId, name: 'checkout', filePath: 'tests/direct.yaml' }],
      executor: async () => ({ name: 'checkout', filePath: 'tests/direct.yaml', status: 'failed',
        duration: 1, steps: [{ name: 'Open checkout', status: 'failed', duration: 1, evidence }] }),
      configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
      product: fixture.targetName, configDir: fixture.project, configFilePath: fixture.configPath,
      knowledgeRoot: join(fixture.project, 'knowledge'), memberProbeUrls: [],
      secretRedactor: new SecretRedactor(new SecretStore()),
      applyAssembly: () => undefined,
      bindSession: () => undefined, takeFrameworkError: () => mode === 'framework error' ? new Error('fixture framework failure') : undefined,
      getCurationModelDeps: () => undefined,
      loadPlugins: async () => {},
    }),
    afterVerdict: () => { hostSettled = true; return 1 },
  }, { patterns: [fixture.testPattern] })
  void running.catch(() => undefined)
  try {
    await held.reached
    const runDir = join(fixture.agentQaRoot, 'runs', String(session.id))
    await vi.advanceTimersByTimeAsync(5001)
    expect(runnerSettled).toBe(true)
    expect(hostSettled, 'the host must retain the still-pending preparation after runner.done').toBe(false)
    expect(existsSync(join(runDir, 'post-verdict-pending.json'))).toBe(true)
    if (mode !== 'settles') {
      if (mode === 'abort') { abort.abort(); abort.abort() }
      else await vi.advanceTimersByTimeAsync(DRAIN_BUDGET_MS + 1)
      if (mode === 'framework error') {
        await expect(running).rejects.toThrow('fixture framework failure')
        expect(hostSettled).toBe(false)
      } else {
        const pending = await running
        expect(hostSettled).toBe(true)
        expect(pending.settled).toBeDefined()
      }
      expect(existsSync(join(runDir, 'post-verdict-pending.json.owner', 'owner.json'))).toBe(true)
    }
    held.release()
    if (mode === 'framework error') {
      await vi.waitFor(() => expect(existsSync(join(runDir, 'post-verdict-pending.json'))).toBe(false))
    } else {
      const outcome = await running
      await outcome.settled
      expect(outcome.exitCode).toBe(1)
    }
    expect(held.calls).toHaveBeenCalledTimes(1)
    expect(fetchTrap).not.toHaveBeenCalled()
    const final = guardCompletedRunHandoff(JSON.parse(readFileSync(join(runDir, 'handoff.json'), 'utf8')))
    const host = composeCliLocalAgent({ agentQaRoot: fixture.agentQaRoot, configPath: fixture.configPath })
    try {
      const jobs = await host.jobs()
      const rows = (await jobs.store.dumpState()).jobs.filter((row) => row.kind === 'analyze-run')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.payload).toMatchObject({ handoffDigest: sha256hex(canonicalJson(final)) })
    } finally { await host.close() }
    expect(existsSync(join(runDir, 'post-verdict-pending.json'))).toBe(false)
    if (mode === 'detached tail') expect(detached).toHaveBeenCalledTimes(1)
  } finally {
    held.release()
    await running.catch(() => undefined)
  }
}, 30_000)

function continuationFixture() {
  const fixture = createInProcessFixture({ origin: 'http://127.0.0.1:1', environment: 'local' })
  roots.push(fixture.project)
  const input = { ...fixture, runId: generateRunId(), knowledgeRoot: join(fixture.project, 'knowledge') }
  const runDir = join(input.agentQaRoot, 'runs', input.runId)
  mkdirSync(runDir, { recursive: true })
  const handoffPath = join(runDir, 'handoff.json')
  const brief: ServedBrief = { scope: { tier: 'product', key: fixture.targetName }, asOfBuild: 1,
    budget: 1000, truncation: 'none', channel1: [{ id: asRecordId(`rec-${sha256hex(fixture.directTestId)}`),
      kind: 'fact', summary: 'checkout candidate', trust: 0.5, status: 'candidate', servedAsCanary: false, tier: 'L1' }],
    channel2: [], channel3: [], briefDigest: '' }
  writeFileSync(handoffPath, JSON.stringify(guardCompletedRunHandoff({
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId: input.runId, scope: { tier: 'product', key: fixture.targetName },
    buildOrdinal: 1, executionContext: 'local-headless', aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' }, startedAt: 1, endedAt: 2,
    tests: [{ testId: fixture.directTestId, testName: 'checkout', filePath: 'tests/direct.yaml',
      testIndex: 0, outcome: 'failed', steps: [{ stepIndex: 0, stepText: 'Open checkout', cacheStatus: 'miss',
        servedBrief: { ...brief, briefDigest: computeBriefDigest(brief) }, subActions: [],
        verifierVerdict: { pass: false, reasoning: 'checkout remains closed' } }] }],
  })))
  const pendingPath = postVerdictPendingPath(input)
  let queued = false
  let hold: Promise<void> = Promise.resolve()
  const enqueue = vi.fn(async () => { queued = true; return 'enqueued' as const })
  return { input, runDir, handoffPath, pendingPath, enqueue,
    /** The queue check that precedes the enqueue waits for `until`. */
    holdQueueCheck: (until: Promise<void>) => { hold = until },
    own: (over: Partial<Parameters<typeof ownPostVerdictContinuation>[0]> = {}) =>
      ownPostVerdictContinuation({ ...input, enqueue, queued: async () => { await hold; return queued }, ...over }) }
}

async function analyzeRunRows(f: ReturnType<typeof continuationFixture>) {
  const host = composeCliLocalAgent({ agentQaRoot: f.input.agentQaRoot, configPath: f.input.configPath })
  try {
    return (await (await host.jobs()).store.dumpState()).jobs.filter((row) => row.kind === 'analyze-run')
  } finally { await host.close() }
}

it('same-process callers observe one producer and one publication', async () => {
  const f = continuationFixture()
  const release = deferred<void>()
  f.holdQueueCheck(release.promise)
  const first = f.own()
  const second = f.own()
  expect(first).toBe(second)
  release.resolve()
  await first
  expect(f.enqueue).toHaveBeenCalledTimes(1)
})

// A test-owned real process. Vitest's threads share this PID; killing it kills only this harness.
// The payload is a disposable fixture's trusted host options, never a persisted intent path.
if (process.env.AGENT_QA_CONTINUATION_CHILD !== undefined) {
  it('child-owned-production-preparation', async () => {
    const data = JSON.parse(process.env.AGENT_QA_CONTINUATION_CHILD!)
    const forbidden = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
    const pause = async () => {
      writeFileSync(data.ready, 'ready')
      await new Promise<void>(() => {})
    }
    const step = createPostVerdictStep({ ...data.input, detach: true, log: { warn: () => undefined },
      operations: { composeHost: (input: { agentQaRoot: string; configPath: string }) => {
        const host = composeCliLocalAgent(input)
        return { ...host, jobs: async () => {
          const jobs = await host.jobs()
          return { ...jobs, queue: { ...jobs.queue, enqueue: async (...args: Parameters<typeof jobs.queue.enqueue>) => {
            writeFileSync(data.calls, 'enqueue\n', { flag: 'a' })
            if (data.window === 'before-enqueue') await pause()
            const result = await jobs.queue.enqueue(...args)
            if (data.window === 'enqueue') await pause()
            return result
          } } }
        } }
      } },
    })
    if (data.window === 'before-intent') await pause()
    await step.port.run({} as never)
    if (data.window === 'contender') await pause()
    expect(forbidden).not.toHaveBeenCalled()
  }, 25_000)
}

async function startOwnedChild(f: ReturnType<typeof continuationFixture>, window: string) {
  const ready = join(f.input.project, `child-ready-${randomUUID()}`)
  const calls = join(f.input.project, 'child-enqueues')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run', fileURLToPath(import.meta.url), '-t', '^child-owned-production-preparation$',
    '--pool=threads', '--maxWorkers=1', '--typecheck.enabled=false'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    env: { ...process.env, AGENT_QA_CONTINUATION_CHILD: JSON.stringify({ input: f.input, ready, calls, window }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  try {
    await vi.waitFor(() => {
      if (child.exitCode !== null) throw new Error(`child exited: ${output}`)
      expect(existsSync(ready)).toBe(true)
    }, { timeout: 15_000, interval: 25 })
  } catch (error) { child.kill('SIGKILL'); await exited; throw error }
  return { calls, stop: async () => { child.kill('SIGKILL'); await exited } }
}

async function terminalRecover(f: ReturnType<typeof continuationFixture>) {
  const tail = runPostRunTail({ runId: generateRunId(), agentQaRoot: f.input.agentQaRoot,
    configPath: f.input.configPath, configDir: f.input.project, knowledgeConfig: { dir: 'knowledge' },
    log: { warn: () => undefined }, operations: {
      resolveKnowledgeRoot: () => f.input.knowledgeRoot,
      recoverPendingPostVerdictContinuations: (input) => recoverPendingPostVerdictContinuations(input),
      acquireWriterLease: (() => ({ kind: 'held', holder: { pid: process.pid } })) as never,
      nudgeDaemon: async () => undefined,
    },
  })
  await tail.drain()
}

async function startRecoveryDaemon(f: ReturnType<typeof continuationFixture>) {
  const signals = new Map<NodeJS.Signals, () => void>()
  const cadence: (() => void)[] = []
  let started = false
  const ready = deferred<void>()
  // Recovery passes are counted as they start and settle, so a door awaits the pass it caused.
  let passesStarted = 0
  let passesSettled = 0
  const settlements: { pass: number; resolve: () => void }[] = []
  const settled = (pass: number) => passesSettled >= pass ? Promise.resolve()
    : new Promise<void>((resolve) => { settlements.push({ pass, resolve }) })
  const operations = {
    recoverPendingPostVerdictContinuations: async (input: Parameters<typeof recoverPendingPostVerdictContinuations>[0]) => {
      passesStarted += 1
      try { return await recoverPendingPostVerdictContinuations(input) }
      finally {
        passesSettled += 1
        for (const waiter of settlements.filter(({ pass }) => pass <= passesSettled)) {
          settlements.splice(settlements.indexOf(waiter), 1)
          waiter.resolve()
        }
      }
    },
    acquireWriterLease: () => ({ kind: 'acquired', leaseId: 'fixture-daemon', epoch: 41 }),
    releaseLease: () => ({ kind: 'released' }), heartbeatLease: () => ({ kind: 'alive',
      holder: { pid: process.pid, epoch: 41, heartbeatAtMs: Date.now(), leaseId: 'fixture-daemon' } }),
    readWriterLease: () => ({ kind: 'free' }),
    composeJobRecovery: () => ({ store: { adoptEpoch: async () => ({ epoch: 41 }) },
      recoverAbandonedClaims: async () => ({ recovered: 0 }), close: async () => undefined }),
    composeLocalAgent: () => ({ registry: {}, jobs: async () => ({
      queue: { runNextJob: async () => ({ ran: false, reason: 'no-job' }) },
    }), close: async () => undefined }),
    reconcileRunOutcomesProjection: () => ({ kind: 'skipped' }),
    inspectDrainableCurationWork: () => ({ queuedCandidateIds: [], recoverableClaimedCandidateIds: [] }),
    countRemainingCurationWork: () => ({ queued: 0, claimedNonterminal: 0, quarantined: 0 }),
    listQueuedCandidates: () => [], runMaintenanceTail: async () => undefined,
    setInterval: (callback: () => void, ms: number) => {
      if (ms === CURATION_QUEUE_POLL_MS) cadence.push(callback)
      if (started && cadence.length > 0) ready.resolve()
      return 1
    },
    clearInterval: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined,
    onSignal: (signal: NodeJS.Signals, listener: () => void) => signals.set(signal, listener),
    offSignal: (signal: NodeJS.Signals) => signals.delete(signal),
    startHeartbeatSupervisor: async () => ({ exited: new Promise<void>(() => {}), stop: async () => undefined }),
    startInvokeServer: async (input: { socketPath: string }) => { started = true; return { socketPath: input.socketPath, close: async () => undefined } },
  } as unknown as Partial<DaemonHostOperations>
  const running = runDaemonHost({ agentQaRoot: f.input.agentQaRoot, knowledgeRoot: f.input.knowledgeRoot,
    configPath: f.input.configPath, config: { getMasked: async () => ({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath: f.input.configPath, entries: [] }) },
    model: () => ({ modelId: 'fixture', generate: async () => { throw new Error('provider forbidden') } }),
    operations, logger: { info: () => undefined, error: () => undefined },
  })
  try {
    await Promise.race([ready.promise,
      running.then(() => { throw new Error('the daemon host returned before it registered its cadence') })])
  } catch (error) { signals.get('SIGTERM')?.(); await running; throw error }
  return {
    // The pass a tick requests is the next one to start; it resolves when that pass settles.
    tick: () => {
      const pass = passesStarted + 1
      cadence.forEach((callback) => callback())
      return settled(pass)
    },
    // Pass 1 is the drain the host requests itself once it has registered.
    recovered: settled,
    stop: async () => { signals.get('SIGTERM')!(); await running },
  }
}

it.each(['terminal', 'daemon'] as const)('%s discovers a killed owner and queues its analysis once', async (door) => {
  const f = continuationFixture()
  const child = await startOwnedChild(f, 'before-enqueue')
  let daemon: Awaited<ReturnType<typeof startRecoveryDaemon>> | undefined
  try {
    if (door === 'daemon') daemon = await startRecoveryDaemon(f)
    const intent = readFileSync(f.pendingPath)
    // An already-running daemon/terminal must not treat a live owner as interrupted.
    if (daemon === undefined) await terminalRecover(f)
    else await daemon.tick()
    expect(readFileSync(f.pendingPath)).toEqual(intent)
    expect(await analyzeRunRows(f)).toHaveLength(0)
    await child.stop()
    if (daemon === undefined) await terminalRecover(f)
    else await daemon.tick()
    expect(existsSync(f.pendingPath)).toBe(false)
    expect(readFileSync(child.calls, 'utf8')).toBe('enqueue\n')
    const final = guardCompletedRunHandoff(JSON.parse(readFileSync(f.handoffPath, 'utf8')))
    const rows = await analyzeRunRows(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toMatchObject({ handoffDigest: sha256hex(canonicalJson(final)) })
  } finally { await child.stop(); await daemon?.stop() }
}, 30_000)

it.each(['before-intent', 'before-enqueue', 'enqueue'] as const)('recovers the %s crash window and queues the analysis once', async (window) => {
  const f = continuationFixture()
  const child = await startOwnedChild(f, window)
  try {
    await child.stop()
    const handoffBefore = readFileSync(f.handoffPath)
    await terminalRecover(f)
    const rows = await analyzeRunRows(f)
    expect(rows).toHaveLength(window === 'before-intent' ? 0 : 1)
    if (window !== 'before-intent') {
      const final = guardCompletedRunHandoff(JSON.parse(readFileSync(f.handoffPath, 'utf8')))
      expect(rows[0]!.payload).toMatchObject({ handoffDigest: sha256hex(canonicalJson(final)) })
      expect(readFileSync(child.calls, 'utf8')).toBe('enqueue\n')
      expect(existsSync(f.pendingPath)).toBe(false)
    }
    expect(readFileSync(f.handoffPath)).toEqual(handoffBefore)
  } finally { await child.stop() }
}, 30_000)

it.each((['terminal', 'daemon'] as const).flatMap(door =>
  (['older-stamp', 'unknown-member'] as const).map(state => ({ door, state })),
))('$door refuses a $state pending intent and queues nothing', async ({ door, state }) => {
  const f = continuationFixture()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
  await expect(f.own({ queued: async () => { throw new Error('retain') } })).rejects.toThrow('retain')
  const intent = JSON.parse(readFileSync(f.pendingPath, 'utf8'))
  writeFileSync(f.pendingPath, JSON.stringify(state === 'older-stamp'
    ? { ...intent, schemaVersion: 1 } : { ...intent, unknown: 'd'.repeat(64) }))
  const intentBytes = readFileSync(f.pendingPath)
  if (door === 'terminal') await terminalRecover(f)
  else { const daemon = await startRecoveryDaemon(f); await daemon.stop() }
  expect(readFileSync(f.pendingPath)).toEqual(intentBytes)
  expect(fetch).not.toHaveBeenCalled()
  const host = composeCliLocalAgent({ agentQaRoot: f.input.agentQaRoot, configPath: f.input.configPath })
  try { expect((await (await host.jobs()).store.dumpState()).jobs).toHaveLength(0) } finally { await host.close() }
})

it('separate live process contenders cannot enqueue twice', async () => {
  const f = continuationFixture()
  const first = await startOwnedChild(f, 'before-enqueue')
  try {
    const second = await startOwnedChild(f, 'contender')
    try {
      expect(readFileSync(first.calls, 'utf8')).toBe('enqueue\n')
      expect(await analyzeRunRows(f)).toHaveLength(0)
    } finally { await second.stop() }
  } finally { await first.stop() }
}, 30_000)

it.each(['live', 'EPERM', 'unknown', 'partial'] as const)('refuses %s owner without enqueueing', async (mode) => {
  const f = continuationFixture()
  await expect(f.own({ queued: async () => { throw new Error('retain intent') } })).rejects.toThrow()
  const lock = `${f.pendingPath}.owner`
  mkdirSync(lock)
  const ownerIdentity = JSON.parse(readFileSync(f.pendingPath, 'utf8'))
  if (mode !== 'partial') writeFileSync(join(lock, 'owner.json'), JSON.stringify({
    ...ownerIdentity, pid: process.pid, token: randomUUID(),
  }))
  if (mode === 'EPERM' || mode === 'unknown') vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('uncertain'), { code: mode === 'EPERM' ? 'EPERM' : 'EIO' })
  })
  await expect(Promise.resolve().then(() => f.own())).rejects.toThrow('owner-busy')
  expect(f.enqueue).not.toHaveBeenCalled()
})

it('a stale release cannot remove a newer owner generation', async () => {
  const f = continuationFixture()
  const release = deferred<void>()
  f.holdQueueCheck(release.promise)
  const active = f.own()
  await Promise.resolve()
  const lock = `${f.pendingPath}.owner`
  const old = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
  renameSync(lock, `${lock}.dead-${old.token}`)
  mkdirSync(lock)
  const newer = { ...old, token: randomUUID() }
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(newer))
  release.resolve()
  await expect(active).rejects.toThrow('owner-busy')
  expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))).toEqual(newer)
  expect(existsSync(`${lock}.dead-${old.token}`)).toBe(true)
  expect(f.enqueue).not.toHaveBeenCalled()
})

it.each(['malformed', 'foreign', 'symlink', 'write-failure'] as const)('refuses %s intent before enqueueing', async (mode) => {
  const f = continuationFixture()
  if (mode === 'malformed') writeFileSync(f.pendingPath, '{bad')
  if (mode === 'foreign') writeFileSync(f.pendingPath, JSON.stringify({ schemaVersion: 2,
    runId: generateRunId(), configDigest: 'b'.repeat(64), handoffDigest: 'c'.repeat(64) }))
  if (mode === 'symlink') symlinkSync(f.handoffPath, f.pendingPath)
  if (mode === 'write-failure') mkdirSync(f.pendingPath)
  await expect(Promise.resolve().then(() => f.own())).rejects.toThrow()
  expect(f.enqueue).not.toHaveBeenCalled()
  expect(existsSync(f.pendingPath)).toBe(true)
})

it.each(['gateRun', 'excludedFromOutcomes'] as const)('refuses %s creation and forged pending recovery before lease or provider work', async (marker) => {
  const f = continuationFixture()
  writeFileSync(f.handoffPath, JSON.stringify({ ...JSON.parse(readFileSync(f.handoffPath, 'utf8')), [marker]: true }))
  const forbidden = vi.fn(() => { throw new Error('excluded run must not acquire authority') })
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden)
  const step = createPostVerdictStep({ ...f.input, detach: true, log: { warn: () => undefined },
    operations: {
      readWriterLease: forbidden, acquireWriterLease: forbidden,
      composeHost: forbidden,
    } })
  await step.port.run({ [marker]: true } as never)
  expect(step.handoff.enqueueState).toBe('skipped')
  expect(existsSync(f.pendingPath)).toBe(false)
  // A valid-schema forged record cannot bypass the loaded handoff's exclusion decision.
  const bytes = JSON.stringify({ schemaVersion: 2, runId: f.input.runId,
    configDigest: 'b'.repeat(64), handoffDigest: 'c'.repeat(64) })
  writeFileSync(f.pendingPath, bytes)
  await expect(Promise.resolve().then(() => f.own())).rejects.toThrow('identity-conflict')
  const result = await recoverPendingPostVerdictContinuations({ ...f.input,
    deadlineMs: Date.now() + DRAIN_BUDGET_MS, log: { warn: () => undefined } })
  expect(result).toEqual([{ runId: f.input.runId, pending: true, enqueued: false, detail: 'identity-conflict' }])
  expect(readFileSync(f.pendingPath, 'utf8')).toBe(bytes)
  expect(existsSync(`${f.pendingPath}.owner`)).toBe(false)
  expect(f.enqueue).not.toHaveBeenCalled()
  expect(provider).not.toHaveBeenCalled()
  expect(forbidden).not.toHaveBeenCalled()
})

it.each(['config', 'source'] as const)('failed publication retains the intent and queues nothing; changed %s refuses retry', async (changed) => {
  const f = continuationFixture()
  await expect(f.own({ enqueue: async () => { throw new Error('publication failed') } })).rejects.toThrow('publication failed')
  const before = readFileSync(f.pendingPath)
  expect(f.enqueue).not.toHaveBeenCalled()
  if (changed === 'config') writeFileSync(f.input.configPath, '\n# changed host config\n', { flag: 'a' })
  else {
    const source = JSON.parse(readFileSync(f.handoffPath, 'utf8'))
    source.tests[0].testName = 'changed source'
    writeFileSync(f.handoffPath, JSON.stringify(source))
  }
  await expect(Promise.resolve().then(() => f.own())).rejects.toThrow('identity-conflict')
  expect(readFileSync(f.pendingPath)).toEqual(before)
  expect(f.enqueue).not.toHaveBeenCalled()
  await terminalRecover(f)
  expect(await analyzeRunRows(f)).toHaveLength(0)
  expect(readFileSync(f.pendingPath)).toEqual(before)
})

it('an uncertain owner does not starve an unrelated eligible intent', async () => {
  const f = continuationFixture()
  await expect(f.own({ queued: async () => { throw new Error('retain') } })).rejects.toThrow()
  mkdirSync(`${f.pendingPath}.owner`)
  const otherId = generateRunId()
  const otherDir = join(f.input.agentQaRoot, 'runs', otherId)
  mkdirSync(otherDir)
  writeFileSync(join(otherDir, 'handoff.json'), JSON.stringify({
    ...JSON.parse(readFileSync(f.handoffPath, 'utf8')), runId: otherId,
  }))
  await expect(ownPostVerdictContinuation({ ...f.input, runId: otherId,
    queued: async () => { throw new Error('retain') }, enqueue: f.enqueue,
  })).rejects.toThrow()
  await terminalRecover(f)
  expect(existsSync(f.pendingPath)).toBe(true)
  expect(existsSync(join(otherDir, 'post-verdict-pending.json'))).toBe(false)
  const host = composeCliLocalAgent({ agentQaRoot: f.input.agentQaRoot, configPath: f.input.configPath })
  try {
    const rows = (await (await host.jobs()).store.dumpState()).jobs
    expect(rows.filter((row) => row.kind === 'analyze-run').map((row) => row.idempotencyKey)).toEqual([otherId])
  } finally { await host.close() }
})

it('a conflicting durable queue row refuses recovery and preserves the intent without enqueueing', async () => {
  const f = continuationFixture()
  await expect(f.own({ queued: async () => { throw new Error('retain') } })).rejects.toThrow()
  const intent = readFileSync(f.pendingPath)
  const host = composeCliLocalAgent({ agentQaRoot: f.input.agentQaRoot, configPath: f.input.configPath })
  try {
    const jobs = await host.jobs()
    await jobs.queue.enqueue('analyze-run', { runId: f.input.runId, handoffDigest: 'a'.repeat(64),
      handoffSchemaVersion: 7, executionContext: 'local-headless' }, f.input.runId)
    await terminalRecover(f)
    expect(readFileSync(f.pendingPath)).toEqual(intent)
    expect((await jobs.store.dumpState()).jobs).toHaveLength(1)
  } finally { await host.close() }
})

it('terminal drain discovers recorded pending work before an unrelated empty FIFO', async () => {
  const f = continuationFixture()
  await expect(f.own({ queued: async () => { throw new Error('interrupted before enqueue') } })).rejects.toThrow()
  const tail = runPostRunTail({ runId: generateRunId(), agentQaRoot: f.input.agentQaRoot,
    configPath: f.input.configPath, configDir: f.input.project, knowledgeConfig: { dir: 'knowledge' },
    log: { warn: () => undefined }, operations: {
      acquireWriterLease: (() => ({ kind: 'held', holder: { pid: process.pid } })) as never,
      nudgeDaemon: async () => undefined,
    },
  })
  await tail.drain()
  const host = composeCliLocalAgent({ agentQaRoot: f.input.agentQaRoot, configPath: f.input.configPath })
  try {
    const rows = (await (await host.jobs()).store.dumpState()).jobs
    expect(rows.filter((row) => row.kind === 'analyze-run' && row.idempotencyKey === f.input.runId)).toHaveLength(1)
    expect(existsSync(f.pendingPath)).toBe(false)
  } finally { await host.close() }
})

it('recovery enqueues a pending intent whose workspace has no declared secrets file, as the hand-off does', async () => {
  const f = continuationFixture()
  await expect(f.own({ queued: async () => { throw new Error('interrupted before enqueue') } })).rejects.toThrow()
  rmSync(join(f.input.project, '.env.secrets.local'))
  const result = await recoverPendingPostVerdictContinuations({ ...f.input,
    deadlineMs: Date.now() + DRAIN_BUDGET_MS, log: { warn: () => undefined } })
  expect(result).toEqual([{ runId: f.input.runId, pending: false, enqueued: true }])
  expect((await analyzeRunRows(f)).map((row) => row.idempotencyKey)).toEqual([f.input.runId])
  expect(existsSync(f.pendingPath)).toBe(false)
})

it.each(['direct', 'suite'] as const)('actual %s command keeps failed exit one when first SIGINT interrupts the real shared preparation wait', async (mode) => {
  await commandSignalFixture(mode, 'post-verdict')
}, 30_000)

it.each((['direct', 'suite'] as const).flatMap(mode =>
  (['active-run', 'second-signal'] as const).map(timing => ({ mode, timing })),
))('actual $mode command retains $timing exit 130', async ({ mode, timing }) => {
  await commandSignalFixture(mode, timing)
}, 30_000)

async function commandSignalFixture(mode: 'direct' | 'suite', timing: 'post-verdict' | 'active-run' | 'second-signal') {
  const f = continuationFixture()
  isolateUpdateCheck()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
  const held = holdAnalysisEnqueue()
  const beforeListeners = new Set(process.listeners('SIGINT'))
  const beforeExitCode = process.exitCode
  const executing = deferred<void>()
  const releaseExecution = deferred<void>()
  const actualDrive = drive.runInProcessCliRun
  let session!: RunSession
  let runnerSettled = false
  let outcome: Awaited<ReturnType<typeof actualDrive>> | undefined
  const evidence = JSON.parse(readFileSync(f.handoffPath, 'utf8')).tests[0].steps[0]
  vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
    const produced = await input.produceMembers!({} as never)
    // Keep the actual command callbacks and actual shared drive; only the member/provider ports
    // are controlled. The runner publishes its real handoff and times out at its fixed 5000 ms.
    outcome = await actualDrive({ ...input,
      onSession: (value) => {
        session = value; input.onSession?.(value)
        void value.done.then(() => { runnerSettled = true })
      },
      produceMembers: async () => ({ ...produced,
        memberProbeUrls: [],
        members: [{ testId: f.input.directTestId, name: 'checkout', filePath: 'tests/direct.yaml' }],
        executor: async () => {
          executing.resolve()
          if (timing === 'active-run') await releaseExecution.promise
          return { name: 'checkout', filePath: 'tests/direct.yaml', status: 'failed', duration: 1,
            steps: [{ name: 'Open checkout', status: 'failed', duration: 1, evidence }] }
        },
      }),
    }, request)
    return outcome
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  const parsing = program.parseAsync(['--config', f.input.configPath, 'run',
    mode === 'suite' ? f.input.suitePattern : f.input.testPattern, '--detach'], { from: 'user' })
  void parsing.catch(() => undefined)
  try {
    await (timing === 'active-run' ? executing.promise : held.reached)
    if (timing !== 'active-run') await vi.advanceTimersByTimeAsync(5001)
    expect(runnerSettled).toBe(timing !== 'active-run')
    expect(exit).not.toHaveBeenCalled()
    const pendingPath = postVerdictPendingPath({ ...f.input, runId: String(session.id) })
    expect(existsSync(pendingPath)).toBe(timing !== 'active-run')
    const handlers = process.listeners('SIGINT').filter(handler => !beforeListeners.has(handler))
    expect(handlers).toHaveLength(1)
    handlers[0]!('SIGINT')
    if (timing === 'active-run') { releaseExecution.resolve(); held.release() }
    if (timing === 'second-signal') expect(() => handlers[0]!('SIGINT')).toThrow('fixture command exit')
    await expect(parsing).rejects.toThrow('fixture command exit')
    expect(exit.mock.calls[0]![0], 'completed failure is frozen; active cancellation and hard second signal retain 130')
      .toBe(timing === 'post-verdict' ? 1 : 130)
    if (timing === 'active-run') expect(outcome?.verdict).toBe('cancelled')
    else {
      expect(output.mock.calls.flat().join('\n')).toContain(preparationLine(pendingPath))
      expect(existsSync(pendingPath)).toBe(true)
      expect(outcome?.settled).toBeDefined()
    }
  } finally {
    releaseExecution.resolve()
    held.release()
    await parsing.catch(() => undefined)
    await outcome?.settled
    process.exitCode = beforeExitCode
  }
  expect(fetch).not.toHaveBeenCalled()
}

it('actual --all command freezes an earlier suite failure into a passing direct result', async () => {
  const f = continuationFixture()
  isolateUpdateCheck()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
  const codes: number[] = []
  vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
    const produced = await input.produceMembers!({} as never)
    try {
      const verdict = codes.length === 0 ? 'failed' : 'passed'
      const exitCode = input.freezeVerdict!(verdict)
      codes.push(exitCode)
      return { runId: String(request.runId), verdict, exitCode }
    } finally { await produced.finalize?.() }
  })
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(program.parseAsync(['--config', f.input.configPath, 'run', '--all', '--detach'],
    { from: 'user' })).rejects.toThrow('fixture command exit')
  expect(codes).toEqual([1, 1])
  expect(exit.mock.calls[0]![0]).toBe(1)
  expect(fetch).not.toHaveBeenCalled()
})

it.each((['direct', 'suite'] as const).flatMap(mode =>
  (['pending', 'late-failure', 'failed', 'settled-before-finish', 'skipped'] as const).map(state => ({ mode, state })),
))('actual $mode command reports $state preparation without a false chain', async ({ mode, state }) => {
  const f = continuationFixture()
  isolateUpdateCheck()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture command exit') })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider forbidden'))
  const actualTail = tailComposition.composeCliPostRunTail
  let report: ReturnType<ReturnType<typeof actualTail>['report']> | undefined
  let pendingPath = ''
  let finishPreparation: (() => Promise<unknown>) | undefined
  const composed = vi.spyOn(tailComposition, 'composeCliPostRunTail').mockImplementation((input) => {
    const handle = actualTail(input)
    return { ...handle, finish: async (options) => {
      if (state === 'settled-before-finish') await finishPreparation!()
      await handle.finish(options); report = handle.report()
    } }
  })
  const execution = vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
    const produced = await input.produceMembers!({} as never)
    const runId = String(request.runId)
    const runDir = join(f.input.agentQaRoot, 'runs', runId)
    mkdirSync(runDir, { recursive: true })
    // a skipped preparation is a gate run, so its handoff carries the marker the shell
    // copies from the same RunConfig, and the exit line reads the status read's skipped fact.
    writeFileSync(join(runDir, 'handoff.json'), JSON.stringify({
      ...JSON.parse(readFileSync(f.handoffPath, 'utf8')), runId,
      ...(state === 'skipped' ? { gateRun: true } : {}),
    }))
    const release = deferred<void>()
    const reserved = deferred<void>()
    const step = createPostVerdictStep({ ...f.input, runId, detach: true, log: { warn: () => undefined },
      operations: { composeHost: holdingHost(composeCliLocalAgent, {
        reached: () => reserved.resolve(),
        release: release.promise,
        fail: () => state === 'failed' || state === 'late-failure',
      }) },
    })
    const preparation = step.port.run({ ...(state === 'skipped' ? { gateRun: true } : {}) } as never)
    finishPreparation = async () => { release.resolve(); await preparation }
    try {
      if (state === 'skipped') await preparation
      else await reserved.promise
      if (state === 'failed') await finishPreparation()
      pendingPath = postVerdictPendingPath({ ...f.input, runId })
      const exitCode = await input.afterVerdict!({ verdict: 'failed', exitCode: input.freezeVerdict!('failed'), runId, configDir: f.input.project,
        configFilePath: f.input.configPath, postVerdict: step.handoff,
        postVerdictDeadlineMs: Date.now() - 1 } as never)
      expect(existsSync(pendingPath)).toBe(state !== 'skipped' && state !== 'settled-before-finish')
      expect(existsSync(join(runDir, 'curation-tail-receipt.json'))).toBe(false)
      return { runId, exitCode } as never
    } finally { release.resolve(); await preparation; await produced.finalize?.() }
  })
  const program = new Command().option('--config <path>').addCommand(createRunCommand())
  await expect(program.parseAsync(['--config', f.input.configPath, 'run',
    mode === 'suite' ? f.input.suitePattern : f.input.testPattern, '--detach'], { from: 'user' }))
    .rejects.toThrow('fixture command exit')
  expect(execution).toHaveBeenCalledTimes(1)
  expect(composed).toHaveBeenCalledTimes(1)
  expect(exit.mock.calls[0]![0]).toBe(1)
  const lines = output.mock.calls.flat().join('\n')
  const warning = warnings.mock.calls.flat().join('\n')
  if (state === 'pending' || state === 'late-failure') {
    expect(report, 'a pending producer has no enqueue disposition and no completed drain')
      .toEqual({ preparationPending: true, drain: 'not-attempted', jobsRun: 0 })
    expect(lines).toContain(preparationLine(pendingPath))
  } else if (state === 'failed') expect(report).toEqual({ enqueue: 'failed', drain: 'not-attempted', jobsRun: 0 })
  else if (state === 'skipped') {
    expect(report).toEqual({ enqueue: 'skipped', drain: 'not-attempted', jobsRun: 0 })
    expect(lines).toContain('post-processing — analysis: skipped (gate run) · curation: skipped (gate run)')
    expect(lines).not.toContain('post-run analysis')
    expect(lines).not.toContain('Durable intent:')
  } else {
    expect(report).toEqual({ enqueue: 'enqueued', drain: 'detached', jobsRun: 0 })
    expect(lines).not.toContain('hand-off pending')
    expect(lines).toContain('agent-qa digest')
  }
  if (state === 'failed' || state === 'late-failure') {
    expect(warning).toContain('analysis enqueue failed or was refused (enqueue-error)')
    expect(warning).toContain(pendingPath)
    expect(warning).not.toContain('private provider exception')
  }
  expect(fetch).not.toHaveBeenCalled()
}, 30_000)
