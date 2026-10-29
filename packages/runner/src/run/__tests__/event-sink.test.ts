// Phase 363-03 Task 1 (D-01). The event sink is the single masking chokepoint every
// parity payload crosses. These tests pin the widened stepFinalized leg (StepResult-derived
// status/durationMs/error) and the three NEW sink legs (hookStarted/hookFinished from the
// Plan 04 hooks migration, testRetryScheduled from the Plan 10 member-runner retry loop) —
// each routed through its Plan 01 projection + the sink mask so no value-bearing string
// escapes redaction (T-363-05/T-363-06). RED before the sink widening exists.
//
// Runner package convention: `.js`-suffixed relative import specifiers. Real in-memory bus,
// synthetic mask — no fs, no timers.
import { describe, expect, it } from 'vitest'

import { createRunEventBus } from '../bus.js'
import type { RunEventBus } from '../bus.js'
import { createMemberEventSink } from '../event-sink.js'
import { makeEmptyServedBrief } from '../../loop/evidence.js'
import type {
  HookFinishedPayload,
  HookStartedPayload,
  MaskFn,
  RecordedRetrievalRung,
  RunEventEnvelope,
  ScopeKey,
  StepEvidence,
  StepFinalizedPayload,
  TestRetryScheduledPayload,
} from '@vostride/agent-qa-schema'

const SECRET = 'SECRET-42'
const SCOPE: ScopeKey = { tier: 'suite', key: 'checkout' }

/** A synthetic run mask — scrubs the planted secret from every string. */
const MASK: MaskFn = (text: string) => text.replaceAll(SECRET, '[masked]')

function collect(bus: RunEventBus): RunEventEnvelope[] {
  const received: RunEventEnvelope[] = []
  bus.subscribe(1, (event) => received.push(event))
  return received
}

function makeStepEvidence(): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'open the panel',
    cacheStatus: 'miss',
    servedBrief: makeEmptyServedBrief(SCOPE, 7),
    subActions: [],
    verifierVerdict: { pass: false, reasoning: 'no match' },
  }
}

function makeSink(): { bus: RunEventBus; received: RunEventEnvelope[]; sink: ReturnType<typeof createMemberEventSink> } {
  const bus = createRunEventBus({ runId: 'run-1' })
  const received = collect(bus)
  const sink = createMemberEventSink({ bus, mask: MASK, testIndex: 2 })
  return { bus, received, sink }
}

// ---- Test 1: widened stepFinalized leg (StepResult-derived extras, masked error) --------

describe('event sink — widened stepFinalized leg', () => {
  it('carries StepResult-derived status/durationMs and masks the error at the sink', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized(makeStepEvidence(), {
      status: 'failed',
      durationMs: 1234,
      error: `boom ${SECRET}`,
    })

    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect(payload.status).toBe('failed')
    expect(payload.durationMs).toBe(1234)
    // The error string crossed the mask chokepoint — the secret is gone.
    expect(payload.error).toBe('boom [masked]')
    expect(JSON.stringify(payload)).not.toContain(SECRET)
  })

  it('the widened extras are optional — a bare stepFinalized still emits the base payload', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized(makeStepEvidence())
    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('error')
  })
})

// ---- Test 1b: the 405 D-05 tokenUsage leg (absent is not zero) --------------------------

describe('event sink — stepFinalized tokenUsage leg', () => {
  it('publishes the measured tokenUsage verbatim on the envelope payload', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized(makeStepEvidence(), {
      status: 'passed',
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })
    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect(payload.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('a bare stepFinalized publishes NO tokenUsage key — an unmeasured step is absent, not zero', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized(makeStepEvidence())
    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect('tokenUsage' in payload).toBe(false)
  })
})

// ---- Test 1c: the 407 D-13/D-14 retrievalRung leg (the live-header banner's source) -----

describe('event sink — stepFinalized retrievalRung leg', () => {
  const rung: RecordedRetrievalRung = {
    schemaVersion: 2,
    rung: 'bundle-scan',
    reason: 'index-unavailable',
  }

  it('publishes the recorded rung byte-equal when the evidence carries one', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized({ ...makeStepEvidence(), retrievalRung: rung })
    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect(payload.retrievalRung).toEqual(rung)
  })

  it('publishes NO retrievalRung key when the evidence recorded none', () => {
    const { received, sink } = makeSink()
    sink.loopEmitFor(0).stepFinalized(makeStepEvidence())
    const finalized = received.find((e) => e.type === 'stepFinalized')
    expect(finalized).toBeDefined()
    const payload = finalized!.payload as StepFinalizedPayload
    expect('retrievalRung' in payload).toBe(false)
  })
})

// ---- Test 2: hookStarted / hookFinished legs (masked captured streams) -------------------

describe('event sink — hook lifecycle legs', () => {
  it('hookStarted publishes a hookStarted envelope of the hook identity', () => {
    const { received, sink } = makeSink()
    const input: HookStartedPayload = {
      hookName: 'seed-db',
      phase: 'setup',
      hookExecutionId: 'hx-1',
      scope: 'suite',
    }
    sink.hookStarted(input)
    const started = received.find((e) => e.type === 'hookStarted')
    expect(started).toBeDefined()
    const payload = started!.payload as HookStartedPayload
    expect(payload.hookName).toBe('seed-db')
    expect(payload.phase).toBe('setup')
    expect(payload.hookExecutionId).toBe('hx-1')
  })

  it('hookFinished masks stdout/stderr/error and every variables VALUE (keys preserved)', () => {
    const { received, sink } = makeSink()
    const input: HookFinishedPayload = {
      hookName: 'seed-db',
      phase: 'setup',
      hookExecutionId: 'hx-1',
      status: 'failed',
      durationMs: 42,
      stdout: `token=${SECRET}`,
      stderr: `err ${SECRET}`,
      variables: { API_KEY: SECRET, PLAIN: 'ok' },
      error: `failed ${SECRET}`,
    }
    sink.hookFinished(input)
    const finished = received.find((e) => e.type === 'hookFinished')
    expect(finished).toBeDefined()
    const payload = finished!.payload as HookFinishedPayload
    expect(payload.stdout).toBe('token=[masked]')
    expect(payload.stderr).toBe('err [masked]')
    expect(payload.error).toBe('failed [masked]')
    // Keys pass through; values are masked.
    expect(payload.variables).toEqual({ API_KEY: '[masked]', PLAIN: 'ok' })
    expect(JSON.stringify(payload)).not.toContain(SECRET)
  })
})

// ---- Test 3: testRetryScheduled leg (accumulation-reset marker) --------------------------

describe('event sink — testRetryScheduled leg', () => {
  it('publishes {testId, testIndex, attempt, maxAttempts} envelopes', () => {
    const { received, sink } = makeSink()
    const input: TestRetryScheduledPayload = {
      testId: 'checkout-happy',
      testIndex: 2,
      attempt: 2,
      maxAttempts: 3,
      reason: 'flaky-timeout',
    }
    sink.testRetryScheduled(input)
    const retry = received.find((e) => e.type === 'testRetryScheduled')
    expect(retry).toBeDefined()
    const payload = retry!.payload as TestRetryScheduledPayload
    expect(payload).toEqual({
      testId: 'checkout-happy',
      testIndex: 2,
      attempt: 2,
      maxAttempts: 3,
      reason: 'flaky-timeout',
    })
  })
})
