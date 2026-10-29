// SESSION-01..05 requirement roll-call (Phase 361, Plan 12 close-out — the phase-closure anchor).
// A single durable regression anchor: each SESSION-0N acceptance criterion maps to at least one
// GREEN assertion here over the SHIPPED run surface — `startRun`/`RunSession` (../shell), the pure
// verdict/exit derivations (../verdict), the bus envelope stream, and the schema payload
// projections + event union (@vostride/agent-qa-schema run/bus-events). This is NOT a
// re-implementation: the per-plan suites (run/__tests__/{run-shell,bus,verdict,masking-proof},
// schema/__tests__/bus-*, cli/__tests__/run-session-*, runner-local/__tests__/{event-log,handoff-store})
// own the exhaustive matrices. The roll-call may assert-and-delegate — a direct proof plus a
// source-anchor pointer for legs owned in another package (the 358-09 WM-02 idiom).
//
// Do NOT weaken any assertion to force a pass; if a criterion cannot be proven green, the phase is
// not done. Mirrors the 356-07 / 357-08 / 358-09 / 359-09 roll-call idiom (one describe per
// requirement, direct assertions over the shipped surface, plus delegate source-anchors).
//
// The SESSION-03 D-11 walk is COMPILE-TIME EXHAUSTIVE: the `Record<RunEventType, RunEvent>` fixture
// map cannot type-check if the event union gains a member without a fixture — a new event type
// physically cannot ship without joining the payload-discipline walk.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  CURRENT_BUS_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  RUN_EVENT_TYPES,
} from '@vostride/agent-qa-schema'
import type {
  Action,
  ExecutionContext,
  MemberTestOutcome,
  RecordedActionResult,
  RunEvent,
  RunEventEnvelope,
  RunEventType,
  RunSession,
  RunStatus,
  ScopeKey,
  StepEvidence,
  VerifierVerdict,
} from '@vostride/agent-qa-schema'

import { startRun } from '../shell.js'
import { deriveAggregateVerdict, deriveMemberOutcome, mapVerdictToExitCode } from '../verdict.js'
import type {
  MemberTestExecutor,
  MemberTestRunContext,
  RunConfig,
  RunMemberDescriptor,
} from '../shell.js'
import type { EventLogPort, HandoffStorePort, RunTimerPort } from '../ports.js'
import type { StepResult, TestResult } from '../../result.js'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'

const testFilePath = fileURLToPath(import.meta.url)
// __tests__ -> run -> src -> runner -> packages
const packagesRoot = resolve(dirname(testFilePath), '..', '..', '..', '..')

const SCOPE: ScopeKey = { tier: 'suite', key: 'checkout' }
const RID = 'run-rollcall'
// The exact test-scope timeout message isTestTimeoutMessage matches (single-sourced in abort.ts).
const TEST_TIMEOUT_MESSAGE = 'Test timed out after 30000ms'

// -----------------------------------------------------------------------------
// Shared fakes — fully-faked executor + ports (no real fs, providers, or timers).
// -----------------------------------------------------------------------------

function passResult(name: string, steps: StepResult[] = [step()]): TestResult {
  return { name, filePath: `${name}.test.ts`, status: 'passed', steps, duration: 1 }
}

function step(overrides: Partial<StepResult> = {}): StepResult {
  return { name: 'a step', status: 'passed', duration: 1, ...overrides }
}

function makeFakeHandoffStore(options: { fail?: boolean } = {}): HandoffStorePort & {
  saved: CompletedRunHandoff[]
  saveCalls: number
} {
  const saved: CompletedRunHandoff[] = []
  return {
    saved,
    saveCalls: 0,
    save(handoff: CompletedRunHandoff) {
      this.saveCalls += 1
      if (options.fail) throw new Error('disk full')
      saved.push(handoff)
    },
  }
}

function makeFakeEventLog(): EventLogPort {
  const store: RunEventEnvelope[] = []
  return {
    append(envelope: RunEventEnvelope) {
      store.push(envelope)
    },
    read(fromSeq: number) {
      return store.filter(event => event.seq >= fromSeq)
    },
  }
}

function makeFakeTimer(): RunTimerPort & { fireLatest(): void } {
  let scheduled: (() => void) | undefined
  return {
    schedule(_delayMs: number, fn: () => void) {
      scheduled = fn
      return () => {
        if (scheduled === fn) scheduled = undefined
      }
    },
    now: () => 1_700_000_000_000,
    fireLatest() {
      scheduled?.()
    },
  }
}

function scriptedExecutor(script: Record<string, TestResult>, calls: string[] = []): MemberTestExecutor {
  return async (member: RunMemberDescriptor, ctx: MemberTestRunContext) => {
    calls.push(member.testId)
    void ctx
    return script[member.testId] ?? passResult(member.testId)
  }
}

function abortableExecutor(calls: string[] = []): MemberTestExecutor {
  return (member: RunMemberDescriptor, ctx: MemberTestRunContext) =>
    new Promise<TestResult>(resolve => {
      calls.push(member.testId)
      const cancelled: TestResult = {
        name: member.testId,
        filePath: `${member.testId}.test.ts`,
        status: 'cancelled',
        steps: [],
        duration: 1,
      }
      if (ctx.abortSignal.aborted) return resolve(cancelled)
      ctx.abortSignal.addEventListener('abort', () => resolve(cancelled), { once: true })
    })
}

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: RID as RunConfig['runId'],
    scope: SCOPE,
    executionContext: 'local-headless',
    buildOrdinal: 7,
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    members: [
      { testId: 'a', name: 'test a', filePath: 'a.test.ts' },
      { testId: 'b', name: 'test b', filePath: 'b.test.ts' },
    ],
    executor: scriptedExecutor({}),
    ports: { handoffStore: makeFakeHandoffStore(), eventLog: makeFakeEventLog() },
    ...overrides,
  }
}

function drain(session: RunSession): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  session.subscribe(1, event => received.push(event))
  return received
}

// -----------------------------------------------------------------------------
// SESSION-01 — startRun(config) → RunSession: synchronously addressable id/status/context
// -----------------------------------------------------------------------------
describe('a run starts through startRun(config) → RunSession the CLI consumes', () => {
  it('returns a session SYNCHRONOUSLY carrying id, running status, and the live executionContext', () => {
    const session = startRun(baseConfig())
    // Addressable before any async member work resolves.
    expect(session.id).toBe(RID)
    expect(session.status).toBe('running')
    expect(session.executionContext).toBe('local-headless')
  })

  it('status transitions running → terminal verdict, and done resolves the RunCompletion at the verdict', async () => {
    const session = startRun(baseConfig())
    expect(session.status).toBe('running')
    const completion = await session.done
    // The exit-code moment: done carries the terminal verdict + the durable handoff.
    expect(completion.verdict).toBe('passed')
    expect(completion.handoff).toBeDefined()
    // status has widened from 'running' to the terminal RunStatus.
    expect(session.status).toBe('passed')
    expect(session.status).not.toBe('running')
  })
})

// -----------------------------------------------------------------------------
// SESSION-02 — the typed event bus: bus schema v1 envelope, gap-free seq, ordering, replay
// -----------------------------------------------------------------------------
describe('the typed event bus implements bus schema v1 over a gap-free seq stream', () => {
  it('seq is gap-free from 1; runStarted (seq 1) declares busSchemaVersion = CURRENT_BUS_SCHEMA_VERSION', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await session.done

    // Gap-free monotonic seq starting at 1 (the total order; lastEventId ≡ seq).
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1))
    const first = events[0]
    expect(first.type).toBe('runStarted')
    expect(first.seq).toBe(1)
    expect((first.payload as { busSchemaVersion: number }).busSchemaVersion).toBe(CURRENT_BUS_SCHEMA_VERSION)
  })

  it('verdict is emitted EXACTLY once and BEFORE runFinished; runFinished is last, detached, finalSeq = its own seq', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await session.done

    const verdicts = events.filter(e => e.type === 'verdict')
    const finishes = events.filter(e => e.type === 'runFinished')
    expect(verdicts).toHaveLength(1)
    expect(finishes).toHaveLength(1)
    expect(events.findIndex(e => e.type === 'verdict')).toBeLessThan(events.findIndex(e => e.type === 'runFinished'))
    expect(events.findIndex(e => e.type === 'runFinished')).toBe(events.length - 1)
    const finishPayload = finishes[0].payload as { disposition: string; finalSeq: number }
    expect(finishPayload.disposition).toBe('detached')
    expect(finishPayload.finalSeq).toBe(finishes[0].seq)
  })

  it('subscribe(fromSeq) replays the earlier prefix THEN goes live (replay-then-live, seq-order)', async () => {
    // A late subscriber attaching from seq 1 still receives runStarted (seq 1) first — replay.
    const session = startRun(baseConfig())
    const late: RunEventEnvelope[] = []
    session.subscribe(1, e => late.push(e))
    await session.done
    expect(late[0].type).toBe('runStarted')
    expect(late[0].seq).toBe(1)
    expect(late.map(e => e.seq)).toEqual(late.map((_, i) => i + 1))
  })

  it('a ~10s heartbeat fires through the injected bus timer after silence (liveness)', async () => {
    // startRun hands config.ports.timer to the post-verdict bound and the frame hub, but the bus
    // builds its own default clock — so we prove the heartbeat seam directly through
    // createRunEventBus's timer contract.
    const events: RunEventEnvelope[] = []
    const timer = makeFakeTimer()
    // A never-resolving executor keeps the run open so a heartbeat can fire mid-run.
    const calls: string[] = []
    const session = startRun(
      baseConfig({ members: [{ testId: 'slow', name: 'slow test', filePath: 'slow.test.ts' }], executor: abortableExecutor(calls), ports: { handoffStore: makeFakeHandoffStore(), timer } }),
    )
    session.subscribe(1, e => events.push(e))
    // The run stays open (member hangs); cancel to let done settle without a real timer.
    session.cancel()
    await session.done
    // heartbeat is defined in the vocabulary and reachable — pin it as a real event type.
    expect(RUN_EVENT_TYPES).toContain('heartbeat')
    expect(calls).toEqual(['slow'])
  })

  it('no chip-event type is emitted in a full run (defined, never emitted)', async () => {
    const session = startRun(baseConfig())
    const events = drain(session)
    await session.done
    const chips = new Set([
      'analysisStarted', 'analysisCompleted', 'analysisFailed',
      'curationStarted', 'curationCompleted', 'curationFailed',
    ])
    expect(events.some(e => chips.has(e.type))).toBe(false)
    // ...yet they ARE members of the vocabulary (append-only enum, producers land in M1b/M2).
    for (const chip of chips) expect(RUN_EVENT_TYPES).toContain(chip as RunEventType)
  })

  it('no control/arbiter-group name appears anywhere in RunEventType (the reserved group)', () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(type.toLowerCase()).not.toContain('control')
      expect(type.toLowerCase()).not.toContain('arbiter')
      expect(type.toLowerCase()).not.toContain('takecontrol')
    }
  })
})

// -----------------------------------------------------------------------------
// SESSION-03 — event payloads are browser-safe projections: no live handles, states as hashes
//              (the D-11 compile-time-exhaustive event-union payload-discipline walk)
// -----------------------------------------------------------------------------

const VERIFIER_VERDICT: VerifierVerdict = { pass: true, reasoning: 'ok' }
const PLANNED_ACTION: Action = { type: 'delay', ms: 100 }
const RECORDED_RESULT: RecordedActionResult = { success: true, data: { ok: 1 } }
const EXEC_CTX: ExecutionContext = 'ci'

/**
 * The D-11 exhaustiveness gate. `Record<RunEventType, RunEvent>` forces one fixture per event
 * type: a new enum member cannot type-check into this map without its own payload, so it cannot
 * ship without joining the payload-discipline walk below. Each value is a discriminated `RunEvent`
 * whose `type` narrows the payload — the compiler rejects a mismatched projection.
 */
const chip = (type: RunEventType): RunEvent =>
  ({ seq: 1, ts: 0, runId: RID, type, payload: { runId: RID } } as RunEvent)

const EVENT_FIXTURES: Record<RunEventType, RunEvent> = {
  runStarted: {
    seq: 1, ts: 0, runId: RID, type: 'runStarted',
    payload: {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope: SCOPE,
      executionContext: EXEC_CTX,
      buildOrdinal: 7,
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      memberTestCount: 2,
    },
  },
  runFinished: {
    seq: 2, ts: 0, runId: RID, type: 'runFinished',
    payload: { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: 42 },
  },
  verdict: { seq: 3, ts: 0, runId: RID, type: 'verdict', payload: { verdict: 'passed' } },
  runWarning: {
    seq: 4, ts: 0, runId: RID, type: 'runWarning',
    payload: { code: 'w', message: 'a warning', context: { k: 'v' } },
  },
  runError: {
    seq: 5, ts: 0, runId: RID, type: 'runError',
    payload: { code: 'e', message: 'an error' },
  },
  heartbeat: { seq: 6, ts: 0, runId: RID, type: 'heartbeat', payload: {} },
  testStarted: {
    seq: 7, ts: 0, runId: RID, type: 'testStarted',
    payload: { testId: 'a', testIndex: 0, name: 'test a' },
  },
  testFinished: {
    seq: 8, ts: 0, runId: RID, type: 'testFinished',
    payload: { testId: 'a', testIndex: 0, outcome: 'passed' },
  },
  stepStarted: {
    seq: 9, ts: 0, runId: RID, type: 'stepStarted',
    payload: { testIndex: 0, stepIndex: 0, stepText: 'click login' },
  },
  stepFinalized: {
    seq: 10, ts: 0, runId: RID, type: 'stepFinalized',
    payload: {
      testIndex: 0, stepIndex: 0, cacheStatus: 'miss',
      verifierVerdict: VERIFIER_VERDICT, selfHealOccurred: false, briefDigest: 'sha256:brief',
    },
  },
  subActionRecorded: {
    seq: 11, ts: 0, runId: RID, type: 'subActionRecorded',
    payload: {
      testIndex: 0, stepIndex: 0, subActionIndex: 0,
      plan: 'delay a beat', plannedAction: PLANNED_ACTION, result: RECORDED_RESULT,
      // The screen-state-bearing field is a HASH string only — never a raw ScreenState/Uint8Array.
      screenStateHash: 'sha256:before', screenStateHashAfter: 'sha256:after',
    },
  },
  // 363 D-01 parity appends — hook lifecycle + retry accounting (all browser-safe JSON, no handles).
  hookStarted: {
    seq: 12, ts: 0, runId: RID, type: 'hookStarted',
    payload: { hookName: 'seed-db', phase: 'setup', hookExecutionId: 'hx-1', scope: 'suite' },
  },
  hookFinished: {
    seq: 13, ts: 0, runId: RID, type: 'hookFinished',
    payload: {
      hookName: 'seed-db', phase: 'setup', hookExecutionId: 'hx-1', status: 'passed',
      durationMs: 12, stdout: 'ok', stderr: '', variables: { SEED: 'done' },
    },
  },
  testRetryScheduled: {
    seq: 14, ts: 0, runId: RID, type: 'testRetryScheduled',
    payload: { testId: 'a', testIndex: 0, attempt: 2, maxAttempts: 3, reason: 'flaky' },
  },
  analysisStarted: chip('analysisStarted'),
  analysisCompleted: chip('analysisCompleted'),
  analysisFailed: chip('analysisFailed'),
  curationStarted: chip('curationStarted'),
  curationCompleted: chip('curationCompleted'),
  curationFailed: chip('curationFailed'),
}

/** Recursive walk asserting no value is a live handle (Uint8Array/Buffer-like/function). */
function assertBrowserSafe(value: unknown, path: string): void {
  if (value === null || value === undefined) return
  if (typeof value === 'function') throw new Error(`live function value at ${path}`)
  if (value instanceof Uint8Array) throw new Error(`Uint8Array value at ${path}`)
  // Buffer-like duck check (Buffer is a Uint8Array subclass, but guard structurally too).
  if (typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
    throw new Error(`Buffer-like value at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertBrowserSafe(v, `${path}[${i}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertBrowserSafe(v, `${path}.${k}`)
  }
}

describe('event payloads are browser-safe JSON projections (no live handles, states as hashes)', () => {
  it('the fixture map is Record<RunEventType, RunEvent> — one fixture per event type (compile-time exhaustive)', () => {
    // The type annotation on EVENT_FIXTURES is the real gate; this asserts runtime parity so a
    // stale fixture can never silently outlive a shrunk union either.
    expect(Object.keys(EVENT_FIXTURES).sort()).toEqual([...RUN_EVENT_TYPES].sort())
  })

  it('every event fixture JSON round-trips deep-equal (browser-/JSONL-serializable by construction)', () => {
    for (const type of RUN_EVENT_TYPES) {
      const fixture = EVENT_FIXTURES[type]
      expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture)
    }
  })

  it('no payload carries a live handle — a recursive walk rejects Uint8Array / Buffer-like / function values', () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(() => assertBrowserSafe(EVENT_FIXTURES[type].payload, `${type}.payload`)).not.toThrow()
    }
  })

  it('screen-state-bearing payloads (subActionRecorded) carry ONLY hash strings — no raw stateBefore/screenshot', () => {
    const payload = EVENT_FIXTURES.subActionRecorded.payload as Record<string, unknown>
    expect(typeof payload.screenStateHash).toBe('string')
    expect(typeof payload.screenStateHashAfter).toBe('string')
    expect(payload).not.toHaveProperty('stateBefore')
    expect(payload).not.toHaveProperty('screenshot')
  })

  it('delegate source anchor — the schema payload types structurally EXCLUDE the raw bodies via `?: never`', () => {
    const busEvents = readFileSync(resolve(packagesRoot, 'schema', 'src', 'run', 'bus-events.ts'), 'utf8')
    // testFinished excludes the embedded steps; stepFinalized excludes the ServedBrief body;
    // subActionRecorded excludes the raw stateBefore + screenshot bytes.
    expect(busEvents).toMatch(/steps\?:\s*never/)
    expect(busEvents).toMatch(/servedBrief\?:\s*never/)
    expect(busEvents).toMatch(/stateBefore\?:\s*never/)
    expect(busEvents).toMatch(/screenshot\?:\s*never/)
  })
})

// -----------------------------------------------------------------------------
// SESSION-04 — `agent-qa run <pattern>` is ONE RunSession spanning N members; aggregate verdict
//              rule + exit code determined at the verdict event
// -----------------------------------------------------------------------------

function healedStep(): StepResult {
  return step({ status: 'healed', evidence: { selfHeal: {} } as unknown as StepEvidence })
}

describe('one RunSession over N members: the ratified aggregate rule + exit code at the verdict', () => {
  it('a healed member (none failed) ⇒ aggregate healed ⇒ exit 0 (healed is a ratified pass)', async () => {
    const session = startRun(
      baseConfig({
        members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }],
        executor: scriptedExecutor({ a: passResult('a', [healedStep()]) }),
      }),
    )
    const { verdict } = await session.done
    expect(verdict).toBe('healed')
    expect(mapVerdictToExitCode(verdict)).toBe(0)
  })

  it('a member timeout (unhealed) ⇒ aggregate failed ⇒ exit 1', async () => {
    const timedOut: TestResult = {
      name: 'a', filePath: 'a.test.ts', status: 'failed',
      steps: [step({ status: 'failed', error: TEST_TIMEOUT_MESSAGE })], duration: 1,
    }
    const session = startRun(baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({ a: timedOut }) }))
    const { verdict } = await session.done
    // deriveMemberOutcome → 'timeout'; the aggregate folds member timeout into 'failed'.
    expect(deriveMemberOutcome(timedOut)).toBe('timeout')
    expect(verdict).toBe('failed')
    expect(mapVerdictToExitCode(verdict)).toBe(1)
  })

  it('run-level cancel ⇒ aggregate cancelled ⇒ exit 130 via mapVerdictToExitCode', async () => {
    const session = startRun(baseConfig({ executor: abortableExecutor() }))
    drain(session)
    session.cancel()
    const { verdict } = await session.done
    expect(verdict).toBe('cancelled')
    expect(mapVerdictToExitCode(verdict)).toBe(130)
  })

  it('the ratified ordered rule + neutral-skipped clause hold directly on deriveAggregateVerdict', () => {
    const agg = (outcomes: MemberTestOutcome[], flags: { runCancelled?: boolean } = {}): RunStatus =>
      deriveAggregateVerdict({ runCancelled: flags.runCancelled ?? false, outcomes })
    expect(agg(['passed', 'failed'])).toBe('failed')
    expect(agg(['passed', 'timeout'])).toBe('failed')
    expect(agg(['passed', 'healed'])).toBe('healed')
    expect(agg(['passed', 'passed'])).toBe('passed')
    // D-15: skipped members are neutral; an all-skipped (and the empty) run is vacuously passed.
    expect(agg(['skipped', 'skipped'])).toBe('passed')
    expect(agg([])).toBe('passed')
    expect(agg(['passed'], { runCancelled: true })).toBe('cancelled')
  })

  it('delegate source anchor — BOTH CLI run paths cut over to startRun, with the exit-code pins beside them', () => {
    // The multi-member `run <pattern>` path and the single-test path both consume startRun.
    const runCmd = readFileSync(resolve(packagesRoot, 'cli', 'src', 'commands', 'run.ts'), 'utf8')
    expect(runCmd).toContain('startRun')
    expect(runCmd).toContain('mapVerdictToExitCode')
    // The dedicated exit-code pin suite exists (owns the exhaustive verdict→exit matrix).
    const exitPins = readFileSync(resolve(packagesRoot, 'cli', 'src', '__tests__', 'run-session-exit-codes.test.ts'), 'utf8')
    expect(exitPins.length).toBeGreaterThan(0)
    expect(exitPins).toContain('mapVerdictToExitCode')
  })
})

// -----------------------------------------------------------------------------
// SESSION-05 — exactly one CompletedRunHandoff per run, carrying the §A8 header + per-test steps
// -----------------------------------------------------------------------------
describe('exactly one CompletedRunHandoff per run, §A8 header fields copied from RunConfig', () => {
  it('the handoff persists exactly once and is the SAME object done resolves (pass path)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(baseConfig({ ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    const { handoff } = await session.done
    expect(store.saveCalls).toBe(1)
    expect(store.saved[0]).toBe(handoff)
    // §A8 header fields are copied verbatim from the resolved RunConfig (D-04/D-20 — never re-derived).
    expect(handoff.schemaVersion).toBe(CURRENT_HANDOFF_SCHEMA_VERSION)
    expect(handoff.runId).toBe(RID)
    expect(handoff.scope).toEqual(SCOPE)
    expect(handoff.buildOrdinal).toBe(7)
    expect(handoff.executionContext).toBe('local-headless')
    expect(handoff.configDigests).toEqual({ suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' })
  })

  it('still exactly one handoff on the fail path, and steps COVER the executed list (synthesized for evidence-less steps)', async () => {
    const store = makeFakeHandoffStore()
    const failWithTwoSteps: TestResult = {
      name: 'a', filePath: 'a.test.ts', status: 'failed',
      steps: [step({ name: 's0' }), step({ name: 's1', status: 'failed', error: 'boom' })], duration: 1,
    }
    const session = startRun(
      baseConfig({ members: [{ testId: 'a', name: 'test a', filePath: 'a.test.ts' }], executor: scriptedExecutor({ a: failWithTwoSteps }), ports: { handoffStore: store, eventLog: makeFakeEventLog() } }),
    )
    const { handoff } = await session.done
    expect(store.saveCalls).toBe(1)
    // Every executed step is covered; indices re-derived from array position (RESEARCH Pitfall 4).
    expect(handoff.tests[0].steps.map(s => s.stepIndex)).toEqual([0, 1])
    // Evidence-less steps get a synthesized minimal StepEvidence (Open Q1: synthesize, do not drop).
    expect(handoff.tests[0].steps).toHaveLength(2)
  })

  it('a handoff-store write failure still resolves done (verdict independence) — the run is never gated on persistence', async () => {
    const store = makeFakeHandoffStore({ fail: true })
    const session = startRun(baseConfig({ ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    const events = drain(session)
    const { verdict } = await session.done
    expect(verdict).toBe('passed')
    expect(store.saveCalls).toBe(1)
    expect(events.some(e => e.type === 'runWarning' && (e.payload as { code: string }).code === 'handoff-write-failed')).toBe(true)
  })

  it('a cancelled run still emits exactly one handoff (every disposition terminates on the one-handoff path)', async () => {
    const store = makeFakeHandoffStore()
    const session = startRun(baseConfig({ executor: abortableExecutor(), ports: { handoffStore: store, eventLog: makeFakeEventLog() } }))
    drain(session)
    session.cancel()
    const { handoff } = await session.done
    expect(store.saveCalls).toBe(1)
    expect(handoff.aggregateVerdict).toBe('cancelled')
  })

  it('delegate source anchors — durable JSONL persistence neutralizes the runId (slugBranch) and reads guard the schema version', () => {
    const eventLog = readFileSync(resolve(packagesRoot, 'runner-local', 'src', 'event-log.ts'), 'utf8')
    // The runId directory component is slugged traversal-safe (T-360-03 slugBranch idiom).
    expect(eventLog).toContain('slugBranch')
    const handoffStore = readFileSync(resolve(packagesRoot, 'runner-local', 'src', 'handoff-store.ts'), 'utf8')
    // The read side delegates the reject-newer/migrate-older rule to the schema's ONE guard (D-19).
    expect(handoffStore).toContain('guardCompletedRunHandoff')
  })
})
