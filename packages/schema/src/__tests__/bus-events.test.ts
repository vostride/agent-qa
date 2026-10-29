import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  CURRENT_BUS_SCHEMA_VERSION,
  RUN_EVENT_TYPES,
} from '../run/bus-events'
import type {
  RunEventEnvelope,
  RunEventType,
  RunFinishedPayload,
  RunStartedPayload,
  HookStartedPayload,
  HookFinishedPayload,
  TestRetryScheduledPayload,
  TestStartedPayload,
  StepFinalizedPayload,
  TestFinishedPayload,
} from '../run/bus-events'
import type { MemberTestOutcome } from '../run/member-outcome'
import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { ScopeKey } from '../identity/scope-key'
import type { ExecutionContext, RunStatus } from '../run/run-status'

const EXPECTED_EVENT_TYPES: readonly string[] = [
  // Run lifecycle
  'runStarted',
  'runFinished',
  // Member-test lifecycle
  'testStarted',
  'testFinished',
  // Step lifecycle
  'stepStarted',
  'stepFinalized',
  // Sub-action evidence tick
  'subActionRecorded',
  // Verdict
  'verdict',
  // Diagnostics
  'runWarning',
  'runError',
  // Liveness
  'heartbeat',
  // Post-processing chips
  'analysisStarted',
  'analysisCompleted',
  'analysisFailed',
  'curationStarted',
  'curationCompleted',
  'curationFailed',
  'hookStarted',
  'hookFinished',
  'testRetryScheduled',
]

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }
const executionContext: ExecutionContext = 'local-headless'

describe('bus schema — envelope + event vocabulary (spec §2.2)', () => {
  it('declares bus schema version 2', () => {
    expect(CURRENT_BUS_SCHEMA_VERSION).toBe(2)
  })

  it('the event-type vocabulary is exactly the §2.2 groups minus control/arbiter', () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual([...EXPECTED_EVENT_TYPES].sort())
  })

  it('defines exactly the six chip events verbatim (spec §2.2)', () => {
    const chips = [
      'analysisStarted',
      'analysisCompleted',
      'analysisFailed',
      'curationStarted',
      'curationCompleted',
      'curationFailed',
    ]
    for (const chip of chips) {
      expect(RUN_EVENT_TYPES).toContain(chip)
    }
    expect(
      RUN_EVENT_TYPES.filter((type) => /^(analysis|curation|issues)/.test(type)),
    ).toEqual(chips)
  })

  it('an envelope { seq, ts, runId, type, payload } JSON-round-trips deep-equal', () => {
    const envelope: RunEventEnvelope = {
      seq: 1,
      ts: 1_700_000_000_000,
      runId: 'run-abc',
      type: 'heartbeat',
      payload: {},
    }
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope)
  })

  it('the envelope seq/ts/runId/type/payload fields are all present', () => {
    const envelope: RunEventEnvelope = {
      seq: 7,
      ts: 1_700_000_000_042,
      runId: 'run-xyz',
      type: 'runWarning',
      payload: { code: 'subscriber-detached', message: 'handler threw' },
    }
    expect(Object.keys(envelope).sort()).toEqual(
      ['payload', 'runId', 'seq', 'ts', 'type'],
    )
  })
})

describe('run-lifecycle payload headers (spec §2.2)', () => {
  it('RunStartedPayload carries the CompletedRunHandoff header fields + busSchemaVersion', () => {
    const runStarted: RunStartedPayload = {
      busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION,
      scope,
      executionContext,
      buildOrdinal: 1,
      configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
      memberTestCount: 3,
    }
    expect(Object.keys(runStarted).sort()).toEqual([
      'buildOrdinal',
      'busSchemaVersion',
      'configDigests',
      'executionContext',
      'memberTestCount',
      'scope',
    ])
    expect(runStarted.busSchemaVersion).toBe(CURRENT_BUS_SCHEMA_VERSION)
    expect(JSON.parse(JSON.stringify(runStarted))).toEqual(runStarted)
  })

  it('RunFinishedPayload carries aggregateVerdict, disposition fixed detached, finalSeq', () => {
    const runFinished: RunFinishedPayload = {
      aggregateVerdict: 'passed',
      disposition: 'detached',
      finalSeq: 42,
    }
    expect(runFinished.disposition).toBe('detached')
    expect(runFinished.finalSeq).toBe(42)
    expect(JSON.parse(JSON.stringify(runFinished))).toEqual(runFinished)
  })
})

describe('MemberTestOutcome — the per-test union split', () => {
  it('includes skipped and every RunStatus member', () => {
    const outcomes: MemberTestOutcome[] = [
      'passed',
      'failed',
      'healed',
      'timeout',
      'cancelled',
      'skipped',
    ]
    expect(outcomes).toContain('skipped')
  })

  it('every RunStatus is a valid MemberTestOutcome (member superset of aggregate)', () => {
    expectTypeOf<RunStatus>().toMatchTypeOf<MemberTestOutcome>()
  })

  it('PerTestOutcome.outcome is assignable from MemberTestOutcome', () => {
    expectTypeOf<MemberTestOutcome>().toMatchTypeOf<PerTestOutcome['outcome']>()
    expectTypeOf<RunEventType>().toEqualTypeOf<(typeof RUN_EVENT_TYPES)[number]>()
  })
})

describe('bus schema v1 — parity event vocabulary (spec §2.2)', () => {
  it('appends hookStarted, hookFinished, testRetryScheduled at the end of the enum', () => {
    for (const type of ['hookStarted', 'hookFinished', 'testRetryScheduled']) {
      expect(RUN_EVENT_TYPES).toContain(type)
    }
    // Existing entries keep their order; the appends land after them.
    const idx = (t: string) => (RUN_EVENT_TYPES as readonly string[]).indexOf(t)
    expect(idx('hookStarted')).toBeGreaterThan(idx('curationFailed'))
    expect(idx('hookFinished')).toBeGreaterThan(idx('hookStarted'))
    expect(idx('testRetryScheduled')).toBeGreaterThan(idx('hookFinished'))
  })

  it('HookStartedPayload carries hook identity + phase/scope and JSON-round-trips', () => {
    const payload: HookStartedPayload = {
      hookName: 'seed-db',
      phase: 'setup',
      hookExecutionId: 'hx-1',
      hookId: 'hook-1',
      scope: 'suite',
      testIndex: 0,
      stepIndex: 2,
    }
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('HookStartedPayload identity fields are the only required keys', () => {
    const minimal: HookStartedPayload = {
      hookName: 'seed-db',
      phase: 'teardown',
      hookExecutionId: 'hx-2',
    }
    expect(JSON.parse(JSON.stringify(minimal))).toEqual(minimal)
  })

  it('HookFinishedPayload extends the identity fields with result + captured streams', () => {
    const payload: HookFinishedPayload = {
      hookName: 'seed-db',
      phase: 'setup',
      hookExecutionId: 'hx-1',
      hookId: 'hook-1',
      scope: 'test',
      testIndex: 0,
      stepIndex: 2,
      status: 'passed',
      durationMs: 128,
      stdout: 'seeded 3 rows',
      stderr: '',
      variables: { API_TOKEN: 'plain-value' },
      error: undefined,
      kind: 'hook',
    }
    // A HookFinishedPayload is assignable where the identity fields are expected.
    const identity: HookStartedPayload = payload
    expect(identity.hookExecutionId).toBe('hx-1')
    // undefined optional keys are absent after JSON round-trip.
    const { error: _e, ...defined } = payload
    void _e
    expect(JSON.parse(JSON.stringify(payload))).toEqual(defined)
  })

  it('TestRetryScheduledPayload carries the per-test attempt accounting', () => {
    const payload: TestRetryScheduledPayload = {
      testId: 'checkout::happy-path',
      testIndex: 0,
      attempt: 2,
      maxAttempts: 3,
      reason: 'timeout on step 4',
    }
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
    const minimal: TestRetryScheduledPayload = {
      testId: 'checkout::happy-path',
      testIndex: 0,
      attempt: 1,
      maxAttempts: 3,
    }
    expect(JSON.parse(JSON.stringify(minimal))).toEqual(minimal)
  })
})

describe('bus schema v1 — widened payload fields (additive-optional, §2.2)', () => {
  it('TestStartedPayload gains filePath + suite grouping + totalSteps (all optional)', () => {
    const base: TestStartedPayload = { testId: 't1', testIndex: 0, name: 'happy path' }
    expect(JSON.parse(JSON.stringify(base))).toEqual(base)
    const widened: TestStartedPayload = {
      testId: 't1',
      testIndex: 0,
      name: 'happy path',
      filePath: 'suites/checkout.suite.yaml',
      suiteId: 'checkout',
      suiteName: 'Checkout',
      suiteIndex: 0,
      suiteTotal: 2,
      totalSteps: 5,
    }
    expect(JSON.parse(JSON.stringify(widened))).toEqual(widened)
  })

  it('StepFinalizedPayload gains status/durationMs/error (all optional)', () => {
    const widened: StepFinalizedPayload = {
      testIndex: 0,
      stepIndex: 1,
      cacheStatus: 'miss',
      verifierVerdict: { pass: false, reasoning: 'element not found' },
      selfHealOccurred: true,
      briefDigest: 'brief-d',
      status: 'failed',
      durationMs: 900,
      error: 'element not found',
    }
    expect(JSON.parse(JSON.stringify(widened))).toEqual(widened)
  })

  it('TestFinishedPayload gains durationMs/failureSummary/retryCount (all optional)', () => {
    const widened: TestFinishedPayload = {
      testId: 't1',
      testIndex: 0,
      outcome: 'failed',
      durationMs: 4200,
      failureSummary: 'step 4 failed: element not found',
      retryCount: 2,
    }
    expect(JSON.parse(JSON.stringify(widened))).toEqual(widened)
  })
})
