// RCC-02 deterministic root-cause classifier pins. RED-first: this file
// pins every branch of `classifyRootCause` + the D-02 field-fidelity contract of
// `deterministicVerdict` BEFORE the module exists (right-reason RED on the unresolved import).
//
// Contract source: 373-CONTEXT.md D-01 (presence rule, as refined in Plan 01), D-02 (faithful
// VerdictBase constructor + fixed rationale templates), D-03 (producer discriminator), D-04
// (baseline probe web signal / device-session-create mobile signal), D-05 (pure module beside
// run/verdict.ts) + REQUIREMENTS RCC-02. Branch order pinned: timeout → environment → flake →
// unknown. Misses fall to 'unknown' — the safe Noop default (RESEARCH A2/A3).
//
// Runner package convention: `.js`-suffixed relative import specifiers.
import { describe, expect, it } from 'vitest'

import {
  classifyRootCause,
  CONNECT_ERROR_TOKENS,
  deterministicVerdict,
  SESSION_CREATE_ERROR_TOKENS,
  type RootCauseInput,
} from '../root-cause.js'
import { createTimeoutAbortReason } from '../../loop/abort.js'
import type { StepResult, TestResult } from '../../result.js'
import { formatLimitStopReason, VERDICT_CLASSES } from '@vostride/agent-qa-schema'
import type { LimitStopEvidence, MemberTestOutcome, StepEvidence } from '@vostride/agent-qa-schema'

// ---- Fixtures ------------------------------------------------------------

function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'a step',
    status: 'passed',
    duration: 1,
    ...overrides,
  }
}

function test(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'a member test',
    filePath: 'checkout.test.ts',
    status: 'passed',
    steps: [],
    duration: 1,
    ...overrides,
  }
}

function input(overrides: Partial<RootCauseInput> = {}): RootCauseInput {
  return {
    result: test({ status: 'failed', steps: [step({ status: 'failed', error: 'Some unrelated failure' })] }),
    outcome: 'failed' as MemberTestOutcome,
    testIndex: 0,
    ...overrides,
  }
}

const TEST_TIMEOUT_MESSAGE = createTimeoutAbortReason('test', 30_000).message

// ---- deterministicVerdict (D-02 field fidelity) ---------------------------

describe('deterministicVerdict — faithful VerdictBase constructor', () => {
  it('environment: fills every VerdictBase field exactly', () => {
    const verdict = deterministicVerdict('environment', 'connect failure: ECONNREFUSED app:3000', [2], 0)
    expect(verdict).toEqual({
      class: 'environment',
      producer: 'deterministic-classifier',
      confidence: 1,
      evidence: {
        citedSteps: [2],
        citedAnchors: [],
        citedArtifacts: [],
        rationale: 'connect failure: ECONNREFUSED app:3000',
      },
      memoryMisdirectionRuledOut: true,
      perTest: 0,
    })
  })

  it.each(['timeout', 'flake'] as const)('%s: confidence 1, rationale = the exact signal', (cls) => {
    const verdict = deterministicVerdict(cls, 'the signal', [1], 3)
    expect(verdict.class).toBe(cls)
    expect(verdict.confidence).toBe(1)
    expect(verdict.evidence.rationale).toBe('the signal')
    expect(verdict.perTest).toBe(3)
  })

  it("unknown: confidence 0 and the rationale template is exactly 'no deterministic signal matched'", () => {
    const verdict = deterministicVerdict('unknown', 'ignored', [], 1)
    expect(verdict.confidence).toBe(0)
    expect(verdict.evidence.rationale).toBe('no deterministic signal matched')
    expect(verdict.producer).toBe('deterministic-classifier')
  })
})

// ---- classifyRootCause: timeout branch ------------------------------------

describe('classifyRootCause — timeout (branch 1)', () => {
  it("member outcome 'timeout' ⇒ class 'timeout' with the hard-budget rationale naming the matched step error", () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [step({ status: 'failed', error: TEST_TIMEOUT_MESSAGE })] }),
      outcome: 'timeout',
    }))
    expect(verdict?.class).toBe('timeout')
    expect(verdict?.confidence).toBe(1)
    expect(verdict?.evidence.rationale).toBe(`test budget exhausted: ${TEST_TIMEOUT_MESSAGE}`)
    expect(verdict?.evidence.citedSteps).toEqual([0])
  })

  it('priority pin: BOTH timeout-matched and connect-error-matched ⇒ timeout (documented order)', () => {
    const verdict = classifyRootCause(input({
      result: test({
        status: 'failed',
        steps: [
          step({ status: 'failed', error: 'connect ECONNREFUSED app:3000' }),
          step({ status: 'failed', error: TEST_TIMEOUT_MESSAGE }),
        ],
      }),
      outcome: 'timeout',
      baselineProbe: { status: 503, elapsedMs: 10 },
    }))
    expect(verdict?.class).toBe('timeout')
  })
})

// ---- classifyRootCause: environment branch --------------------------------

describe('classifyRootCause — environment (branch 2)', () => {
  it('baseline probe ≥500 ⇒ environment with the fixed probe template', () => {
    const verdict = classifyRootCause(input({ baselineProbe: { status: 503, elapsedMs: 230 } }))
    expect(verdict?.class).toBe('environment')
    expect(verdict?.evidence.rationale).toBe('health probe: 503 in 230ms')
  })

  it('baseline probe connect error ⇒ environment with the probe connect-failure template', () => {
    const verdict = classifyRootCause(input({ baselineProbe: { error: 'ECONNREFUSED 127.0.0.1:3000', elapsedMs: 12 } }))
    expect(verdict?.class).toBe('environment')
    expect(verdict?.evidence.rationale).toBe('health probe connect failure: ECONNREFUSED 127.0.0.1:3000')
  })

  it.each([200, 302])('baseline probe status %d is NOT environment via the probe branch (falls to unknown)', (status) => {
    const verdict = classifyRootCause(input({ baselineProbe: { status, elapsedMs: 40 } }))
    expect(verdict?.class).toBe('unknown')
  })

  it('failing step with a connect token ⇒ environment with the connect-failure template (token + trailing detail)', () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [step({ status: 'failed', error: 'connect ECONNREFUSED app:3000' })] }),
    }))
    expect(verdict?.class).toBe('environment')
    expect(verdict?.evidence.rationale).toBe('connect failure: ECONNREFUSED app:3000')
  })

  it.each(CONNECT_ERROR_TOKENS.map((t) => [t] as const))('connect/DNS token %s classifies environment', (token) => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [step({ status: 'failed', error: `page.goto failed: ${token} at http://app:3000` })] }),
    }))
    expect(verdict?.class).toBe('environment')
    expect(verdict?.evidence.rationale).toContain(`connect failure: ${token}`)
  })

  it.each(SESSION_CREATE_ERROR_TOKENS.map((t) => [t] as const))(
    'device-session-create token %s in a failing step error classifies environment (mobile signal)',
    (token) => {
      const verdict = classifyRootCause(input({
        result: test({ status: 'failed', steps: [step({ status: 'failed', error: `${token}: device unavailable` })] }),
      }))
      expect(verdict?.class).toBe('environment')
      expect(verdict?.evidence.rationale).toContain('session create failure:')
    },
  )

  it('session-create failure carried on failureSummary (bootstrap path, empty steps) ⇒ environment with citedSteps []', () => {
    const verdict = classifyRootCause(input({
      result: test({
        status: 'failed',
        steps: [],
        failureSummary: 'MobileSetupError: Failed to launch Android app "com.example.app": device offline',
      }),
    }))
    expect(verdict?.class).toBe('environment')
    expect(verdict?.evidence.citedSteps).toEqual([])
  })
})

// ---- classifyRootCause: flake branch --------------------------------------

describe('classifyRootCause — flake (branch 3)', () => {
  it("final status 'passed' with retryCount > 0 ⇒ flake naming the retry", () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'passed', retryCount: 1, steps: [step()] }),
      outcome: 'passed',
    }))
    expect(verdict?.class).toBe('flake')
    expect(verdict?.confidence).toBe(1)
    expect(verdict?.evidence.rationale).toBe('passed on retry 1')
  })

  it("'healed' with retryCount > 0 ⇒ flake (healed is a pass — result.status 'passed')", () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'passed', retryCount: 2, steps: [step()] }),
      outcome: 'healed',
    }))
    expect(verdict?.class).toBe('flake')
    expect(verdict?.evidence.rationale).toBe('passed on retry 2')
  })

  it.each([0, undefined])("status 'passed' with retryCount %s ⇒ undefined (clean pass — presence rule)", (retryCount) => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'passed', ...(retryCount !== undefined ? { retryCount } : {}), steps: [step()] }),
      outcome: 'passed',
    }))
    expect(verdict).toBeUndefined()
  })

  it("'healed' with retryCount 0 ⇒ undefined", () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'passed', retryCount: 0, steps: [step()] }),
      outcome: 'healed',
    }))
    expect(verdict).toBeUndefined()
  })
})

// ---- classifyRootCause: presence rule + unknown fallback -------------------

describe('classifyRootCause — presence rule + unknown (branch 4)', () => {
  it.each(['skipped', 'cancelled'] as const)("outcome '%s' ⇒ undefined (no rootCause — presence rule)", (outcome) => {
    const verdict = classifyRootCause(input({
      result: test({ status: outcome, retryCount: 1, steps: [] }),
      outcome,
    }))
    expect(verdict).toBeUndefined()
  })

  it('failed member matching no signal ⇒ unknown with confidence 0', () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [step({ status: 'failed', error: 'assertion failed: expected 3 items' })] }),
    }))
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.confidence).toBe(0)
    expect(verdict?.evidence.rationale).toBe('no deterministic signal matched')
  })

  it('citedSteps = the failing step indices; perTest = testIndex', () => {
    const verdict = classifyRootCause(input({
      result: test({
        status: 'failed',
        steps: [step(), step({ status: 'failed', error: 'boom' }), step({ status: 'failed', error: 'also boom' })],
      }),
      testIndex: 4,
    }))
    expect(verdict?.evidence.citedSteps).toEqual([1, 2])
    expect(verdict?.perTest).toBe(4)
  })
})

// ---- classifyRootCause: a limit stop ------------------------------

function limitStoppedStep(limit: LimitStopEvidence['limit'], configured: number): StepResult {
  const reason = formatLimitStopReason(limit, configured, configured)
  const limitStop: LimitStopEvidence = {
    limit,
    configured,
    used: configured,
    reason,
    requestedOutcome: 'unverified',
  }
  return step({
    status: 'failed',
    error: reason,
    evidence: { limitStop } as unknown as StepEvidence,
  })
}

describe('classifyRootCause — limit stop', () => {
  it('a limit-stopped failed member is unknown with the limit reason as rationale', () => {
    const stopped = limitStoppedStep('actions', 30)
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [step(), stopped] }),
      testIndex: 2,
    }))
    expect(verdict?.evidence.rationale).toBe('Stopped: action limit reached — 30 of 30 actions used')
    expect(verdict).toEqual({
      class: 'unknown',
      producer: 'deterministic-classifier',
      confidence: 0,
      evidence: {
        citedSteps: [1],
        citedAnchors: [],
        citedArtifacts: [],
        rationale: 'Stopped: action limit reached — 30 of 30 actions used',
      },
      memoryMisdirectionRuledOut: true,
      perTest: 2,
    })
    expect(VERDICT_CLASSES).toContain(verdict?.class)
  })

  it('a planning-turn limit stop cites its own reason', () => {
    const verdict = classifyRootCause(input({
      result: test({ status: 'failed', steps: [limitStoppedStep('planning-turns', 12)] }),
    }))
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.evidence.rationale)
      .toBe('Stopped: planning-turn limit reached — 12 of 12 planner calls used')
  })

  it('a health-probe failure still wins over a limit stop', () => {
    const result = test({ status: 'failed', steps: [limitStoppedStep('actions', 30)] })
    expect(classifyRootCause(input({ result, baselineProbe: { status: 503, elapsedMs: 9 } }))?.class)
      .toBe('environment')
    expect(
      classifyRootCause(input({ result, baselineProbe: { error: 'ECONNREFUSED x', elapsedMs: 1 } }))
        ?.class,
    ).toBe('environment')
  })

  it('a limit stop is never classed environment by error-token scans', () => {
    for (const token of [...CONNECT_ERROR_TOKENS, ...SESSION_CREATE_ERROR_TOKENS]) {
      const verdict = classifyRootCause(input({
        result: test({
          status: 'failed',
          steps: [
            step({ status: 'failed', error: `${token} on the way` }),
            limitStoppedStep('actions', 5),
          ],
          failureSummary: `${token} in the summary`,
        }),
      }))
      expect({ token, cls: verdict?.class }).toEqual({ token, cls: 'unknown' })
      expect(verdict?.evidence.rationale).toBe(formatLimitStopReason('actions', 5, 5))
    }
  })
})
