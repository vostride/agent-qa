// Deferred executors settle in an order the test controls, so sequential and pooled runs differ.
import { describe, expect, it } from 'vitest'

import { RUN_EVENT_SCOPE, handleRosterOf, memberIndexOf } from '@vostride/agent-qa-schema'

import { startRun } from '../shell.js'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '../shell.js'
import type { EventLogPort, HandoffStorePort } from '../ports.js'
import type {
  CompletedRunHandoff,
  RunEventEnvelope,
  RunSession,
} from '@vostride/agent-qa-schema'
import type { TestResult } from '../../result.js'

// ---- Shared fakes ---------------------------------------------------------------------------

function passResult(name: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'passed',
    steps: [{ name: 'a step', status: 'passed', duration: 1 }],
    duration: 1,
  }
}

function failResult(name: string): TestResult {
  return {
    name,
    filePath: `${name}.test.ts`,
    status: 'failed',
    steps: [{ name: 'a step', status: 'failed', duration: 1, error: 'boom' }],
    duration: 1,
  }
}

function makeFakeHandoffStore(): HandoffStorePort {
  return { save: () => undefined }
}

function makeFakeEventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append(envelope) {
      store.push(envelope)
    },
    read(fromSeq) {
      return store.filter((event) => event.seq >= fromSeq)
    },
  }
}

function drain(session: RunSession): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  session.subscribe(1, (event) => received.push(event))
  return received
}

function done(session: RunSession): Promise<{ verdict: string; handoff: CompletedRunHandoff }> {
  return session.done as Promise<{ verdict: string; handoff: CompletedRunHandoff }>
}

// ---- The pre-refactor parity control ---------------------------------------------------------

/**
 * The scenario the workers=1 parity control replays. Deliberately NOT uniform: a passing member,
 * a failing member that poisons its group, the resulting skip (a member the executor never sees),
 * and an ungrouped member that still runs. Every branch of the loop body appears exactly once, so
 * a refactor that drops or reorders any of them shows up in the stream.
 */
const BASELINE_MEMBERS: readonly RunMemberDescriptor[] = [
  {
    testId: 'alpha',
    name: 'alpha test',
    filePath: 'alpha.test.ts',
    failFastGroup: 'g1',
    suiteId: 's1',
    suiteName: 'suite one',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  },
  {
    testId: 'bravo',
    name: 'bravo test',
    filePath: 'bravo.test.ts',
    failFastGroup: 'g1',
    suiteId: 's1',
    suiteName: 'suite one',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  },
  {
    testId: 'charlie',
    name: 'charlie test',
    filePath: 'charlie.test.ts',
    failFastGroup: 'g1',
    suiteId: 's1',
    suiteName: 'suite one',
    suiteIndex: 0,
    suiteTotal: 1,
    totalSteps: 1,
  },
  { testId: 'delta', name: 'delta test', filePath: 'delta.test.ts', totalSteps: 1 },
]

const BASELINE_SCRIPT: Record<string, TestResult> = {
  alpha: passResult('alpha'),
  bravo: failResult('bravo'),
  delta: passResult('delta'),
}

function baselineConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const calls: string[] = []
  const executor: MemberTestExecutor = async (member: RunMemberDescriptor) => {
    calls.push(member.testId)
    return BASELINE_SCRIPT[member.testId] ?? passResult(member.testId)
  }
  return {
    runId: 'run-baseline' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: BASELINE_MEMBERS,
    executor,
    ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
    ...overrides,
  }
}

export interface BaselineEvent {
  seq: number
  type: string
  runId: string
  payload: unknown
}

/**
 * `ts` is the ONLY field dropped — it is wall-clock, stamped by the bus's own default clock, and
 * says nothing about ordering that `seq` does not already say. Everything else (payload included)
 * is compared verbatim: the control is worth having only if it is byte-tight.
 */
function normalize(events: readonly RunEventEnvelope[]): BaselineEvent[] {
  return events.map((event) => ({
    seq: event.seq,
    type: event.type,
    runId: event.runId,
    payload: JSON.parse(JSON.stringify(event.payload)) as unknown,
  }))
}

function recordedStream(events: readonly RunEventEnvelope[]): string {
  return `${JSON.stringify(normalize(events), null, 2)}\n`
}

describe('the recorded event stream', () => {
  it('a workers=1 run emits the recorded event stream', async () => {
    const session = startRun(baselineConfig())
    const events = drain(session)
    await done(session)

    await expect(recordedStream(events)).toMatchFileSnapshot(
      './__fixtures__/sequential-baseline.json',
    )
  })
})

// ---- Deferred-executor instruments ------------------------------------------------------------

/**
 * Drain microtasks until `predicate` holds or the budget expires; report which happened. This is
 * the whole timing apparatus of this file. It terminates unconditionally, so a cell that expects
 * overlap FAILS on a sequential executor rather than hanging on one, and a cell that expects
 * serialization proves it without waiting on a clock.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function drainUntil(predicate: () => boolean, turns = 100): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true
    await Promise.resolve()
  }
  return predicate()
}

function plainMembers(ids: readonly string[]): RunMemberDescriptor[] {
  return ids.map((id) => ({ testId: id, name: `${id} test`, filePath: `${id}.test.ts` }))
}

function poolConfig(overrides: Partial<RunConfig>): RunConfig {
  return {
    runId: 'run-pool' as RunConfig['runId'],
    scope: { tier: 'suite', key: 'checkout' },
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: plainMembers(['m0', 'm1']),
    executor: async (member: RunMemberDescriptor) => passResult(member.testId),
    ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
    ...overrides,
  }
}

/**
 * An executor where m0 blocks until m1 has STARTED. Under a concurrent pool that resolves and the
 * two members finish in INVERTED order; under any sequential execution m1 cannot start while m0 is
 * blocked, the drain budget expires, and the recorded orders come out identical instead of
 * inverted. That difference — not a duration, not a timer — is what these cells assert on.
 */
function interleavingExecutor(started: string[], finished: string[]): MemberTestExecutor {
  return async (member: RunMemberDescriptor, _ctx: MemberTestRunContext) => {
    started.push(member.testId)
    if (member.testId === 'm0') await drainUntil(() => started.includes('m1'))
    finished.push(member.testId)
    return passResult(member.testId)
  }
}

describe('the bounded member pool — 2 members concurrent, one bus, one terminal sequence', () => {
  it('runs two members in flight together and lets the second finish FIRST', async () => {
    const started: string[] = []
    const finished: string[] = []
    const session = startRun(
      poolConfig({ workers: 2, executor: interleavingExecutor(started, finished) }),
    )
    const events = drain(session)
    await done(session)

    // Overlap: m1 entered its executor while m0 was still inside its own.
    expect(started).toEqual(['m0', 'm1'])
    // The discriminating half. A `for` loop CANNOT produce this ordering: it is the one
    // observation that separates a pool from the loop it replaces on identical input.
    expect(finished).toEqual(['m1', 'm0'])

    const startedIds = events
      .filter((e) => e.type === 'testStarted')
      .map((e) => (e.payload as { testId: string }).testId)
    const finishedIds = events
      .filter((e) => e.type === 'testFinished')
      .map((e) => (e.payload as { testId: string }).testId)
    expect(startedIds).toEqual(['m0', 'm1'])
    expect(finishedIds).toEqual(['m1', 'm0'])
  })

  it('stamps every envelope with the run\'s ONE runId at a strictly increasing seq', async () => {
    const started: string[] = []
    const finished: string[] = []
    const session = startRun(
      poolConfig({ workers: 2, executor: interleavingExecutor(started, finished) }),
    )
    const events = drain(session)
    await done(session)

    expect(finished).toEqual(['m1', 'm0'])
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set(['run-pool']))
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i + 1))
  })

  it('runs the terminal sequence exactly once no matter how the members interleave', async () => {
    const started: string[] = []
    const finished: string[] = []
    const session = startRun(
      poolConfig({ workers: 2, executor: interleavingExecutor(started, finished) }),
    )
    const events = drain(session)
    await done(session)

    // Assert the premise first, or the cell also passes on a sequential executor.
    expect(finished).toEqual(['m1', 'm0'])
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'runFinished')).toHaveLength(1)
    const last = events[events.length - 1]
    expect(last.type).toBe('runFinished')
    expect((last.payload as { finalSeq: number }).finalSeq).toBe(last.seq)
  })

  it('serializes members that declare the SAME exclusive lane, even at workers=8', async () => {
    // Suite members share their suite's adapter, so the pool must keep declaration order per lane.
    const started: string[] = []
    const finished: string[] = []
    const members = plainMembers(['m0', 'm1']).map((m) => ({
      ...m,
      exclusiveLane: 'suite-lifecycle',
    }))
    const session = startRun(
      poolConfig({ workers: 8, members, executor: interleavingExecutor(started, finished) }),
    )
    const events = drain(session)
    await done(session)

    expect(started).toEqual(['m0', 'm1'])
    expect(finished).toEqual(['m0', 'm1'])
    const finishedIds = events
      .filter((e) => e.type === 'testFinished')
      .map((e) => (e.payload as { testId: string }).testId)
    expect(finishedIds).toEqual(['m0', 'm1'])
  })

  it('an all-lane run at workers=8 emits the same recorded stream as a workers=1 run', async () => {
    // Give every member the lane a suite producer gives it and the entire event stream (order,
    // seqs, payloads) is the workers=1 one, at any worker count.
    //
    // Every member gets the lane here, including the ungrouped `delta`. That is deliberate: a run
    // where SOME members declare the lane and some do not is a mixed run, and mixing changes the
    // stream (the lane-free member overtakes the queue). No shipped producer builds one — a run is
    // either the suite path (every member lane-bound) or the direct path (no member lane-bound) —
    // so this cell pins the shape that exists rather than the shape that does not.
    //
    // It compares against a workers=1 run made here rather than the recorded file, so only the
    // workers=1 cell writes that file and `vitest -u` cannot record the pool's stream as the golden.
    const sequential = startRun(baselineConfig())
    const sequentialEvents = drain(sequential)
    await done(sequential)

    const laneMembers = BASELINE_MEMBERS.map((m) => ({ ...m, exclusiveLane: 'suite-lifecycle' }))
    const session = startRun(baselineConfig({ members: laneMembers, workers: 8 }))
    const events = drain(session)
    await done(session)

    expect(recordedStream(events)).toBe(recordedStream(sequentialEvents))
  })
})

describe('the pool at the edges — empty and single-member runs', () => {
  it('a zero-member run settles immediately with the terminal sequence exactly once', async () => {
    const session = startRun(poolConfig({ members: [], workers: 4 }))
    const events = drain(session)
    const completion = await done(session)

    expect(events.map((e) => e.type)).toEqual(['runStarted', 'verdict', 'runFinished'])
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1)
    expect(completion.handoff.tests).toEqual([])
    expect((events[0].payload as { memberTestCount: number }).memberTestCount).toBe(0)
  })

  it('a single-member run under the pool matches the same run at workers=1', async () => {
    const single = plainMembers(['m0'])
    const pooled = startRun(poolConfig({ members: single, workers: 4, runId: 'run-x' as RunConfig['runId'] }))
    const pooledEvents = drain(pooled)
    const pooledCompletion = await done(pooled)

    const sequential = startRun(poolConfig({ members: single, runId: 'run-x' as RunConfig['runId'] }))
    const sequentialEvents = drain(sequential)
    const sequentialCompletion = await done(sequential)

    expect(normalize(pooledEvents)).toEqual(normalize(sequentialEvents))
    expect(pooledCompletion.verdict).toBe(sequentialCompletion.verdict)
  })
})

// ---- invariants a pool must hold on purpose, each driven by an input a loop cannot produce ----

function scriptedControlledExecutor(
  script: Record<string, () => Promise<TestResult>>,
  calls: string[],
): MemberTestExecutor {
  return async (member: RunMemberDescriptor) => {
    calls.push(member.testId)
    const leg = script[member.testId]
    return leg ? await leg() : passResult(member.testId)
  }
}

describe('ordering edge — outcome slots are index-addressed, not completion-ordered', () => {
  it('attributes every outcome to its OWN member under fully inverted completion', async () => {
    const calls: string[] = []
    const finished: string[] = []
    // m2 finishes first, then m1, then m0: the exact inverse of declaration order.
    const releaseM1 = deferred()
    const releaseM0 = deferred()
    const m2Done = deferred()
    const executor = scriptedControlledExecutor(
      {
        m0: async () => {
          await releaseM0.promise
          finished.push('m0')
          return passResult('m0')
        },
        m1: async () => {
          await releaseM1.promise
          finished.push('m1')
          releaseM0.resolve()
          return failResult('m1')
        },
        m2: async () => {
          await m2Done.promise
          finished.push('m2')
          releaseM1.resolve()
          return passResult('m2')
        },
      },
      calls,
    )

    const session = startRun(
      poolConfig({ members: plainMembers(['m0', 'm1', 'm2']), workers: 3, executor }),
    )
    const events = drain(session)
    await drainUntil(() => calls.length === 3)
    m2Done.resolve()
    const completion = await done(session)

    expect(calls).toEqual(['m0', 'm1', 'm2'])
    expect(finished).toEqual(['m2', 'm1', 'm0'])

    // A reader takes member i as `tests[i]`, so completion-order appends would misattribute.
    expect(completion.handoff.tests.map((t) => t.testIndex)).toEqual([0, 1, 2])
    expect(completion.handoff.tests.map((t) => t.testId)).toEqual(['m0', 'm1', 'm2'])
    expect(completion.handoff.tests.map((t) => t.outcome)).toEqual(['passed', 'failed', 'passed'])

    // And the aggregate is the same verdict the natural-order run reaches.
    const natural = startRun(
      poolConfig({
        members: plainMembers(['m0', 'm1', 'm2']),
        executor: scriptedControlledExecutor(
          { m1: async () => failResult('m1') },
          [],
        ),
      }),
    )
    const naturalCompletion = await done(natural)
    expect(completion.verdict).toBe(naturalCompletion.verdict)
    expect(completion.handoff.tests.map((t) => t.outcome)).toEqual(
      naturalCompletion.handoff.tests.map((t) => t.outcome),
    )
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1)
  })
})

describe('concurrency edge — cancelling the run while N members are in flight', () => {
  it('aborts every in-flight member and still runs the terminal sequence exactly once', async () => {
    const calls: string[] = []
    const observedAbort: string[] = []
    const executor: MemberTestExecutor = (member: RunMemberDescriptor, ctx: MemberTestRunContext) =>
      new Promise<TestResult>((resolve) => {
        calls.push(member.testId)
        const cancelled: TestResult = {
          name: member.testId,
          filePath: `${member.testId}.test.ts`,
          status: 'cancelled',
          steps: [],
          duration: 0,
        }
        const onAbort = (): void => {
          observedAbort.push(member.testId)
          resolve(cancelled)
        }
        if (ctx.abortSignal.aborted) onAbort()
        else ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
      })

    const session = startRun(poolConfig({ members: plainMembers(['m0', 'm1']), workers: 2, executor }))
    const events = drain(session)
    // Both members are genuinely in flight — the premise. A cancel that arrived with only one
    // member started would be testing the sequential path with extra steps.
    await drainUntil(() => calls.length === 2)
    expect(calls).toEqual(['m0', 'm1'])

    session.cancel()
    const completion = await done(session)

    expect(observedAbort.sort()).toEqual(['m0', 'm1'])
    expect(completion.verdict).toBe('cancelled')
    expect(session.status).toBe('cancelled')
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'runFinished')).toHaveLength(1)
    const last = events[events.length - 1]
    expect(last.type).toBe('runFinished')
    expect((last.payload as { finalSeq: number }).finalSeq).toBe(last.seq)
    // The bus is closed: nothing arrives after runFinished, and the run's own record agrees.
    expect(events.filter((e) => e.seq > last.seq)).toEqual([])
    expect(completion.handoff.tests.map((t) => t.testIndex)).toEqual([0, 1])
    // This cell cannot tell when the terminal sequence runs; the fail-fast and parity cells pin it.
    expect(
      events.filter(
        (e) =>
          e.type === 'runWarning' &&
          (e.payload as { code?: string }).code === 'member-outcome-missing',
      ),
    ).toEqual([])
  })
})

describe('fail-fast under the pool — poisoning stops STARTS, not work in flight', () => {
  it('skips the queued member while the in-flight sibling runs to completion', async () => {
    // After the poison m2 never starts and in-flight m1 finishes, which no sequential run produces.
    const calls: string[] = []
    const events: RunEventEnvelope[] = []
    const finishedIds = (): string[] =>
      events
        .filter((e) => e.type === 'testFinished')
        .map((e) => (e.payload as { testId: string }).testId)

    const members = plainMembers(['m0', 'm1', 'm2']).map((m) => ({ ...m, failFastGroup: 'g1' }))
    const executor = scriptedControlledExecutor(
      {
        m0: async () => failResult('m0'),
        // m1 stays in flight until the run has decided what to do with m2.
        m1: async () => {
          await drainUntil(() => finishedIds().includes('m2'))
          return passResult('m1')
        },
      },
      calls,
    )

    const session = startRun(poolConfig({ members, workers: 2, executor }))
    session.subscribe(1, (event) => events.push(event))
    const completion = await done(session)

    // m2's executor is never invoked — poisoning refuses a START, it does not kill a run.
    expect(calls).toEqual(['m0', 'm1'])
    expect(finishedIds()).toEqual(['m0', 'm2', 'm1'])
    expect(completion.handoff.tests.map((t) => t.testId)).toEqual(['m0', 'm1', 'm2'])
    expect(completion.handoff.tests.map((t) => t.outcome)).toEqual(['failed', 'passed', 'skipped'])
    expect(completion.verdict).toBe('failed')
  })
})

// ---- The handle roster on runStarted -------------------------------------------

describe('the runStarted handle roster — the run announcing which streams are attachable', () => {
  it('announces each member\'s DERIVED testIndex, in member order, on a 3-member run', async () => {
    const session = startRun(poolConfig({ members: plainMembers(['m0', 'm1', 'm2']), workers: 2 }))
    const events = drain(session)
    await done(session)

    const runStarted = events.find((e) => e.type === 'runStarted')
    expect(runStarted).toBeDefined()
    expect(handleRosterOf(runStarted as RunEventEnvelope)).toEqual([0, 1, 2])
  })

  it('announces PLANTED testIndex values, not array positions', async () => {
    // The whole discriminating point. With 0,1,2 a roster built from array positions and a roster
    // built from the members' stamped identity are the same three numbers, so such a fixture
    // cannot tell a correct roster from a positional one. These are non-contiguous and not
    // 0-based, so the two answers differ.
    const members = plainMembers(['m0', 'm1', 'm2']).map((member, i) => ({
      ...member,
      testIndex: [3, 7, 11][i] as number,
    }))
    const session = startRun(poolConfig({ members, workers: 3 }))
    const events = drain(session)
    await done(session)

    const runStarted = events.find((e) => e.type === 'runStarted')
    expect(handleRosterOf(runStarted as RunEventEnvelope)).toEqual([3, 7, 11])
  })

  it('announces exactly the identities the sinks then STAMP — roster and stamps cannot drift', async () => {
    const members = plainMembers(['m0', 'm1', 'm2']).map((member, i) => ({
      ...member,
      testIndex: [3, 7, 11][i] as number,
    }))
    const session = startRun(poolConfig({ members, workers: 3 }))
    const events = drain(session)
    await done(session)

    const roster = handleRosterOf(events[0] as RunEventEnvelope)
    const stamped = new Set<number>()
    for (const event of events) {
      const index = memberIndexOf(event)
      if (index !== undefined) stamped.add(index)
    }
    expect(roster).toBeDefined()
    expect([...stamped].sort((a, b) => a - b)).toEqual([...(roster ?? [])].sort((a, b) => a - b))
  })

  it('leaves the rest of the runStarted payload byte-identical (the field is ADDITIVE)', async () => {
    const session = startRun(poolConfig({ members: plainMembers(['m0', 'm1']) }))
    const events = drain(session)
    await done(session)

    const payload = events[0]?.payload as Record<string, unknown>
    expect(events[0]?.type).toBe('runStarted')
    expect(Object.keys(payload).filter((key) => key !== 'handles').sort()).toEqual([
      'buildOrdinal',
      'busSchemaVersion',
      'configDigests',
      'executionContext',
      'memberTestCount',
      'scope',
    ])
    expect(payload['memberTestCount']).toBe(2)
    // The envelope shape itself is untouched — five keys, exactly as frozen.
    expect(Object.keys(events[0] as object).sort()).toEqual([
      'payload', 'runId', 'seq', 'ts', 'type',
    ])
  })
})

// ---- Two-sided attribution, WRITE side --------------------------------

/**
 * The three members of the attribution scene, at PLANTED non-contiguous indices.
 *
 * 0, 1, 2 would make a correct stamp indistinguishable from one derived from the member's array
 * position, from the order it happened to start in, or from a counter — under a concurrent pool
 * those three answers coincide for two members and diverge for three at these indices.
 */
const ATTRIBUTION_MEMBERS: readonly RunMemberDescriptor[] = [
  { testId: 'alpha', name: 'alpha test', filePath: 'alpha.test.ts', testIndex: 3 },
  { testId: 'bravo', name: 'bravo test', filePath: 'bravo.test.ts', testIndex: 7 },
  { testId: 'charlie', name: 'charlie test', filePath: 'charlie.test.ts', testIndex: 11 },
]

const EXPECTED_INDEX: Readonly<Record<string, number>> = { alpha: 3, bravo: 7, charlie: 11 }

/**
 * Which member an envelope's own CONTENT says it belongs to — derived from the payload's testId,
 * its step text, or its hook execution id, never from `testIndex`.
 *
 * This is the whole instrument. Asserting `testIndex === testIndex` proves nothing; asserting that
 * the index the sink stamped agrees with the member the payload is manifestly ABOUT is what can
 * catch a cross-attribution defect. A pool that handed member `bravo`'s sink to member `charlie`'s
 * executor produces envelopes saying `charlie` stamped 7, and this reads it.
 */
function ownerOf(event: RunEventEnvelope): string | undefined {
  const payload = event.payload as {
    testId?: unknown
    stepText?: unknown
    hookExecutionId?: unknown
  }
  if (typeof payload.testId === 'string') return payload.testId
  if (typeof payload.stepText === 'string') return payload.stepText.split(' ')[0]
  if (typeof payload.hookExecutionId === 'string') return payload.hookExecutionId.split('-')[1]
  return undefined
}

// No executor finishes until all have started, so the cell fails on any sequential execution.
function attributionExecutor(started: string[]): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    started.push(member.testId)
    ctx.events.stepStarted({ stepIndex: 0, stepText: `${member.testId} first` })
    ctx.events.hookStarted({
      hookName: 'before-each',
      phase: 'setup',
      hookExecutionId: `h-${member.testId}`,
      scope: 'test',
      testIndex: ctx.testIndex,
    })
    await drainUntil(() => started.length === 3)
    ctx.events.stepStarted({ stepIndex: 1, stepText: `${member.testId} second` })
    return passResult(member.testId)
  }
}

describe('the write side of the attribution contract — 3 CONCURRENT members, one bus', () => {
  it('interleaves: every member emits its first event before any emits its second', async () => {
    const started: string[] = []
    const session = startRun(poolConfig({
      members: [...ATTRIBUTION_MEMBERS],
      workers: 3,
      executor: attributionExecutor(started),
    }))
    const events = drain(session)
    await done(session)

    expect(started).toEqual(['alpha', 'bravo', 'charlie'])
    const steps = events
      .filter((e) => e.type === 'stepStarted')
      .map((e) => (e.payload as { stepText: string }).stepText)
    // The discriminating half. A sequential execution emits
    // [alpha first, alpha second, bravo first, bravo second, …]; only genuine overlap puts all
    // three `first`s ahead of every `second`.
    expect(steps.slice(0, 3)).toEqual(['alpha first', 'bravo first', 'charlie first'])
    expect(steps.slice(3).every((text) => text.endsWith('second'))).toBe(true)
  })

  it('stamps EVERY member-scoped envelope with its own member — walked, not sampled', async () => {
    const started: string[] = []
    const session = startRun(poolConfig({
      members: [...ATTRIBUTION_MEMBERS],
      workers: 3,
      executor: attributionExecutor(started),
    }))
    const events = drain(session)
    await done(session)

    // TOTALITY FOLD: every envelope is classified and accounted for, and the count is asserted
    // against the stream length. A loop that `continue`d past an unrecognised envelope would
    // silently sample; this cannot.
    let accounted = 0
    let memberScoped = 0
    const seenPerMember = new Map<number, number>()
    for (const event of events) {
      const scope = RUN_EVENT_SCOPE[event.type]
      const index = memberIndexOf(event)
      if (scope === 'run') {
        // A run-scoped envelope must not carry a member's identity at all.
        expect(index, `${event.type} at seq ${String(event.seq)} is run-scoped`).toBeUndefined()
        accounted += 1
        continue
      }
      const owner = ownerOf(event)
      expect(owner, `no owner derivable for ${event.type} at seq ${String(event.seq)}`)
        .toBeDefined()
      // THE CROSS-ATTRIBUTION ASSERTION: the stamped index equals the index of the member the
      // payload's own content names. Zero cross-attribution is asserted for every envelope, not
      // for a sampled few.
      expect(index, `${event.type} seq ${String(event.seq)} owned by ${String(owner)}`)
        .toBe(EXPECTED_INDEX[owner as string])
      seenPerMember.set(index as number, (seenPerMember.get(index as number) ?? 0) + 1)
      memberScoped += 1
      accounted += 1
    }

    expect(accounted).toBe(events.length)
    // Non-vacuity: an empty member-scoped set would satisfy every assertion above.
    expect(memberScoped).toBeGreaterThan(0)
    expect([...seenPerMember.keys()].sort((a, b) => a - b)).toEqual([3, 7, 11])
    // Each member emits the same shape, so the per-member counts must be equal — an imbalance
    // means envelopes migrated between members.
    expect([...seenPerMember.values()]).toEqual([
      seenPerMember.get(3), seenPerMember.get(3), seenPerMember.get(3),
    ])
  })

  it('the member-scoped sets of the three members are PAIRWISE DISJOINT by seq', async () => {
    const started: string[] = []
    const session = startRun(poolConfig({
      members: [...ATTRIBUTION_MEMBERS],
      workers: 3,
      executor: attributionExecutor(started),
    }))
    const events = drain(session)
    await done(session)

    const sets = [3, 7, 11].map((handle) => new Set(
      events
        .filter((e) => RUN_EVENT_SCOPE[e.type] !== 'run' && memberIndexOf(e) === handle)
        .map((e) => e.seq),
    ))
    expect(sets.map((set) => set.size).every((size) => size > 0)).toBe(true)
    for (let i = 0; i < sets.length; i += 1) {
      for (let j = i + 1; j < sets.length; j += 1) {
        expect([...sets[i]!].filter((seq) => sets[j]!.has(seq))).toEqual([])
      }
    }
  })

  it('announces a roster that is exactly the set of identities it went on to stamp', async () => {
    const started: string[] = []
    const session = startRun(poolConfig({
      members: [...ATTRIBUTION_MEMBERS],
      workers: 3,
      executor: attributionExecutor(started),
    }))
    const events = drain(session)
    await done(session)

    const stamped = new Set<number>()
    for (const event of events) {
      const index = memberIndexOf(event)
      if (index !== undefined) stamped.add(index)
    }
    expect(handleRosterOf(events[0] as RunEventEnvelope)).toEqual([3, 7, 11])
    expect([...stamped].sort((a, b) => a - b)).toEqual([3, 7, 11])
  })
})
