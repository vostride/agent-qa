import { describe, expect, it } from 'vitest'

import {
  projectHookStarted,
  projectHookFinished,
  projectStepFinalized,
  projectSubActionRecorded,
  projectTestFinished,
  projectTestRetryScheduled,
} from '../run/bus-projections'
import type { MaskFn } from '../run/bus-projections'
import { screenStateHash } from '../determinism/screen-hash'
import { asRef } from '../primitives/ref'
import type { Action } from '../action/index'
import type { ScopeKey } from '../identity/scope-key'
import type { ScreenState } from '../screen/screen-state'
import type { ServedBrief } from '../brief/served-brief'
import type { RecordedActionResult } from '../result/index'
import type { StepEvidence } from '../handoff/step-evidence'
import type { SubActionEvidence } from '../handoff/sub-action-evidence'
import type { PerTestOutcome } from '../handoff/per-test-outcome'

const SECRET = 'SECRET-42'
const mask: MaskFn = (value: string) => value.replaceAll(SECRET, '[masked]')

const scope: ScopeKey = { tier: 'test', key: 'checkout::happy-path' }

function makeServedBrief(): ServedBrief {
  return {
    scope,
    asOfBuild: 1,
    budget: 4096,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: 'brief-digest-deadbeef',
  }
}

function makeScreenState(): ScreenState {
  return {
    platform: 'web',
    tree: `root ${SECRET}`,
    elements: [],
    refMap: {},
    url: `https://example.test/?token=${SECRET}`,
    timestamp: 1_700_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 2000 },
    },
  }
}

const plannedAction = { type: 'click', ref: asRef('e2') } as unknown as Action

function makeRecordedResult(): RecordedActionResult {
  return { success: true, data: { note: `value ${SECRET}` } }
}

function makeSubActionEvidence(): SubActionEvidence {
  return {
    plan: `Click the Save button holding ${SECRET}`,
    plannedAction,
    stateBefore: makeScreenState(),
    result: makeRecordedResult(),
  }
}

function makeStepEvidence(withSelfHeal: boolean): StepEvidence {
  const evidence: StepEvidence = {
    stepIndex: 0,
    stepText: `Save the record ${SECRET}`,
    cacheStatus: 'miss',
    servedBrief: makeServedBrief(),
    subActions: [makeSubActionEvidence()],
    verifierVerdict: { pass: true, reasoning: `Record saved (${SECRET})` },
  }
  if (withSelfHeal) {
    const decision = {
      plan: 'retry',
      plannedAction,
      result: makeRecordedResult(),
    }
    evidence.selfHeal = { failedDecision: decision, recoveringDecision: decision }
  }
  return evidence
}

function makePerTestOutcome(): PerTestOutcome {
  return {
    testId: 'checkout::happy-path',
    testName: 'Checkout happy path',
    filePath: 'checkout.spec.yaml',
    testIndex: 0,
    outcome: 'passed',
    steps: [makeStepEvidence(false)],
  }
}

describe('projectStepFinalized (spec §2.2 step lifecycle)', () => {
  it('carries cacheStatus, verifierVerdict, a boolean selfHealOccurred, and a briefDigest string', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
    )
    expect(payload.cacheStatus).toBe('miss')
    expect(payload.verifierVerdict.pass).toBe(true)
    expect(typeof payload.selfHealOccurred).toBe('boolean')
    expect(payload.selfHealOccurred).toBe(false)
    expect(typeof payload.briefDigest).toBe('string')
    expect(payload.briefDigest).toBe('brief-digest-deadbeef')
  })

  it('flags selfHealOccurred true when a heal is present — never leaks the full ServedBrief body', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(true),
      { testIndex: 0, stepIndex: 0 },
      mask,
    )
    expect(payload.selfHealOccurred).toBe(true)
    // Payload discipline: the brief travels as a digest, never as the ServedBrief object.
    expect(payload).not.toHaveProperty('servedBrief')
  })

  it('routes evidence string fields through the mask', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
    )
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(payload.verifierVerdict.reasoning).toContain('[masked]')
  })

  it('JSON-round-trips deep-equal (JSON-serializable, no functions/undefined holes)', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(true),
      { testIndex: 0, stepIndex: 0 },
      mask,
    )
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectSubActionRecorded (spec §2.2 sub-action tick)', () => {
  it('collapses stateBefore to a screenStateHash string and carries result as RecordedActionResult', () => {
    const sub = makeSubActionEvidence()
    const payload = projectSubActionRecorded(
      sub,
      { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
      mask,
    )
    expect(payload.screenStateHash).toBe(screenStateHash(sub.stateBefore))
    expect(typeof payload.screenStateHash).toBe('string')
    // The full ScreenState never rides the bus — only its identity hash.
    expect(payload).not.toHaveProperty('stateBefore')
    expect(payload.result.success).toBe(true)
    expect(payload.result).not.toHaveProperty('screenshot')
  })

  it('masks planted secrets and JSON-round-trips deep-equal', () => {
    const payload = projectSubActionRecorded(
      makeSubActionEvidence(),
      { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
      mask,
    )
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('folds a decision screenshot ref into artifactRefs when the evidence carries no others', () => {
    const ref = { id: `decision-screenshot:${'a'.repeat(64)}`, sha: 'a'.repeat(64) }
    const payload = projectSubActionRecorded(
      { ...makeSubActionEvidence(), decisionScreenshotRef: ref },
      { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
      mask,
    )
    expect(payload.artifactRefs).toEqual([ref])
  })

  it('APPENDS the decision screenshot ref rather than displacing what the evidence already had', () => {
    // The two are different claims — everything this sub-action produced, and the frame the
    // planner decided from — so a fold that replaced one with the other would lose evidence in
    // order to gain evidence.
    const stored = { id: `artifact:${'b'.repeat(64)}`, sha: 'b'.repeat(64) }
    const decision = { id: `decision-screenshot:${'c'.repeat(64)}`, sha: 'c'.repeat(64) }
    const payload = projectSubActionRecorded(
      { ...makeSubActionEvidence(), artifactRefs: [stored], decisionScreenshotRef: decision },
      { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
      mask,
    )
    expect(payload.artifactRefs).toEqual([stored, decision])
  })

  it('control: neither present leaves NO artifactRefs key at all, never an empty array', () => {
    // The control is what makes the two cells above mean anything, and it also pins the
    // absent-is-spread-away idiom: an empty array would be a second spelling of "no artifacts",
    // and a reader that had to tell `[]` from missing would be learning a distinction nothing
    // means.
    const payload = projectSubActionRecorded(
      makeSubActionEvidence(),
      { testIndex: 0, stepIndex: 0, subActionIndex: 0 },
      mask,
    )
    expect(payload).not.toHaveProperty('artifactRefs')
    expect('artifactRefs' in payload).toBe(false)
  })
})

describe('projectTestFinished (spec §2.2 member-test lifecycle)', () => {
  it('carries the PerTestOutcome identity + outcome but never the embedded steps', () => {
    const payload = projectTestFinished(makePerTestOutcome(), mask)
    expect(payload.testId).toBe('checkout::happy-path')
    expect(payload.testIndex).toBe(0)
    expect(payload.outcome).toBe('passed')
    expect(payload).not.toHaveProperty('steps')
  })

  it('JSON-round-trips deep-equal', () => {
    const payload = projectTestFinished(makePerTestOutcome(), mask)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectHookStarted (spec §2.2 hook lifecycle)', () => {
  it('carries hook identity + phase/scope and masks string fields', () => {
    const payload = projectHookStarted(
      {
        hookName: `seed-db ${SECRET}`,
        phase: 'setup',
        hookExecutionId: 'hx-1',
        hookId: 'hook-1',
        scope: 'suite',
        testIndex: 0,
        stepIndex: 2,
      },
      mask,
    )
    expect(payload.phase).toBe('setup')
    expect(payload.scope).toBe('suite')
    expect(payload.hookExecutionId).toBe('hx-1')
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(payload.hookName).toContain('[masked]')
  })

  it('omits absent optional identity fields (no undefined holes)', () => {
    const payload = projectHookStarted(
      { hookName: 'seed-db', phase: 'teardown', hookExecutionId: 'hx-2' },
      mask,
    )
    expect(payload).not.toHaveProperty('hookId')
    expect(payload).not.toHaveProperty('scope')
    expect(payload).not.toHaveProperty('testIndex')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectHookFinished (captured-stream masking)', () => {
  it('masks stdout, stderr, error, and each variables VALUE while preserving keys', () => {
    const payload = projectHookFinished(
      {
        hookName: 'seed-db',
        phase: 'setup',
        hookExecutionId: 'hx-1',
        status: 'failed',
        durationMs: 128,
        stdout: `seeded with token ${SECRET}`,
        stderr: `warning: ${SECRET} rejected`,
        variables: { API_TOKEN: `bearer ${SECRET}`, REGION: 'us-east' },
        error: `hook failed: ${SECRET}`,
        kind: 'hook',
      },
      mask,
    )
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(payload.stdout).toContain('[masked]')
    expect(payload.stderr).toContain('[masked]')
    expect(payload.error).toContain('[masked]')
    // Keys survive; only the secret-bearing value is masked.
    expect(Object.keys(payload.variables).sort()).toEqual(['API_TOKEN', 'REGION'])
    expect(payload.variables.API_TOKEN).toContain('[masked]')
    expect(payload.variables.REGION).toBe('us-east')
    expect(payload.status).toBe('failed')
    expect(payload.durationMs).toBe(128)
  })

  it('omits absent optional fields and JSON-round-trips deep-equal', () => {
    const payload = projectHookFinished(
      {
        hookName: 'seed-db',
        phase: 'teardown',
        hookExecutionId: 'hx-9',
        status: 'passed',
        durationMs: 5,
        stdout: '',
        stderr: '',
        variables: {},
      },
      mask,
    )
    expect(payload).not.toHaveProperty('error')
    expect(payload).not.toHaveProperty('kind')
    expect(payload).not.toHaveProperty('hookId')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectTestRetryScheduled (per-test attempt reset marker)', () => {
  it('carries the attempt accounting and omits an absent reason', () => {
    const payload = projectTestRetryScheduled({
      testId: 'checkout::happy-path',
      testIndex: 0,
      attempt: 2,
      maxAttempts: 3,
    })
    expect(payload.attempt).toBe(2)
    expect(payload.maxAttempts).toBe(3)
    expect(payload).not.toHaveProperty('reason')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('carries an optional reason when present', () => {
    const payload = projectTestRetryScheduled({
      testId: 'checkout::happy-path',
      testIndex: 0,
      attempt: 1,
      maxAttempts: 3,
      reason: 'timeout on step 4',
    })
    expect(payload.reason).toBe('timeout on step 4')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectStepFinalized widened fields (status/durationMs/error appended)', () => {
  it('carries the additive optional fields with error masked', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
      { status: 'failed', durationMs: 900, error: `boom ${SECRET}` },
    )
    expect(payload.status).toBe('failed')
    expect(payload.durationMs).toBe(900)
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(payload.error).toContain('[masked]')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('omits the widened fields when the optional inputs are absent (no undefined holes)', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
    )
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('durationMs')
    expect(payload).not.toHaveProperty('error')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectStepFinalized tokenUsage (absent is not zero)', () => {
  it('carries the measured tokenUsage verbatim; the numbers pass the mask untouched', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
      { tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
    )
    expect(payload.tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('omits tokenUsage entirely when nothing was measured — never a zero-filled triple', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
      { status: 'passed' },
    )
    expect('tokenUsage' in payload).toBe(false)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectTestFinished widened fields (durationMs/failureSummary/retryCount appended)', () => {
  it('carries the additive optional fields with failureSummary masked', () => {
    const payload = projectTestFinished(makePerTestOutcome(), mask, {
      durationMs: 4200,
      failureSummary: `step 4 failed: ${SECRET}`,
      retryCount: 2,
    })
    expect(payload.durationMs).toBe(4200)
    expect(payload.retryCount).toBe(2)
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(payload.failureSummary).toContain('[masked]')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('omits the widened fields when the optional inputs are absent (no undefined holes)', () => {
    const payload = projectTestFinished(makePerTestOutcome(), mask)
    expect(payload).not.toHaveProperty('durationMs')
    expect(payload).not.toHaveProperty('failureSummary')
    expect(payload).not.toHaveProperty('retryCount')
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})

describe('projectStepFinalized retrievalRung (read from the EVIDENCE, not from extra)', () => {
  it('carries the recorded rung verbatim; the closed enum words survive the mask', () => {
    const evidence = makeStepEvidence(false)
    evidence.retrievalRung = {
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'native-runtime-unavailable',
    }
    const payload = projectStepFinalized(evidence, { testIndex: 0, stepIndex: 0 }, mask)
    expect(payload.retrievalRung).toEqual({
      schemaVersion: 2,
      rung: 'static-floor',
      reason: 'native-runtime-unavailable',
    })
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('carries a memidex rung with no reason key', () => {
    const evidence = makeStepEvidence(false)
    evidence.retrievalRung = { schemaVersion: 2, rung: 'memidex' }
    const payload = projectStepFinalized(evidence, { testIndex: 0, stepIndex: 0 }, mask)
    expect(payload.retrievalRung).toEqual({ schemaVersion: 2, rung: 'memidex' })
    expect('reason' in (payload.retrievalRung as object)).toBe(false)
  })

  it('omits retrievalRung entirely when the evidence recorded none — never a zero-fill', () => {
    const payload = projectStepFinalized(
      makeStepEvidence(false),
      { testIndex: 0, stepIndex: 0 },
      mask,
      { status: 'passed' },
    )
    expect('retrievalRung' in payload).toBe(false)
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})
