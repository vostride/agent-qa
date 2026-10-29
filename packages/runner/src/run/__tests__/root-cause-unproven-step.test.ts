// the deterministic classifier reads a failed step the verifier left
// unproven as 'unknown' with confidence 0 and the step's reason as rationale, never an
// application or environment class. A not-met block falls through to today's classification,
// and a limit stop keeps its own branch.
import { describe, expect, it } from 'vitest'

import { formatLimitStopReason } from '@vostride/agent-qa-schema'
import type {
  ConditionVerdict,
  ConditionVerdictsEvidence,
  LimitStopEvidence,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import type { StepResult, TestResult } from '../../result.js'
import { classifyRootCause, UNKNOWN_SIGNAL_RATIONALE } from '../root-cause.js'

const UNPROVEN_ERROR =
  'Step failed: The draft was not saved — Unverified: "the setting is saved" (no re-read after reload)'

function block(
  verdict: ConditionVerdict,
  ending: ConditionVerdictsEvidence['ending'] = 'give-up',
): ConditionVerdictsEvidence {
  return {
    ending,
    conditions: [
      { quote: 'the setting is saved', verdict, reason: 'no re-read after reload', citations: [] },
    ],
  }
}

function judgedStep(
  verdict: ConditionVerdict,
  error: string = UNPROVEN_ERROR,
  ending: ConditionVerdictsEvidence['ending'] = 'give-up',
): StepResult {
  return {
    name: 'Save the setting',
    status: 'failed',
    duration: 1,
    error,
    evidence: {
      verifierVerdict: { pass: false, reasoning: 'the verifier reasoning' },
      conditionVerdicts: block(verdict, ending),
    } as unknown as StepEvidence,
  }
}

function passedStep(): StepResult {
  return { name: 'Open settings', status: 'passed', duration: 1 }
}

function failed(steps: StepResult[]): TestResult {
  return { name: 'settings', filePath: 'settings.test.ts', status: 'failed', steps, duration: 1 }
}

describe('root cause of an unproven step', () => {
  it('an unproven failed step is unknown with its reason as rationale', () => {
    const verdict = classifyRootCause({
      result: failed([passedStep(), judgedStep('unverified')]),
      outcome: 'failed',
      testIndex: 3,
    })
    expect(verdict).toEqual({
      class: 'unknown',
      producer: 'deterministic-classifier',
      confidence: 0,
      evidence: {
        citedSteps: [1],
        citedAnchors: [],
        citedArtifacts: [],
        rationale: UNPROVEN_ERROR,
      },
      memoryMisdirectionRuledOut: true,
      perTest: 3,
    })
  })

  it("an unproven step's rationale passes through the run's mask", () => {
    const masked = (text: string) => text.replace('The draft was not saved', '<SECRET_1>')
    const verdict = classifyRootCause({
      result: failed([judgedStep('unverified')]),
      outcome: 'failed',
      testIndex: 0,
      mask: masked,
    })
    expect(verdict?.evidence.rationale).toBe(masked(UNPROVEN_ERROR))
    expect(verdict?.evidence.rationale).not.toContain('The draft was not saved')
  })

  it("an unproven step without an error cites the verifier verdict's reasoning", () => {
    const step = judgedStep('inconclusive')
    delete step.error
    const verdict = classifyRootCause({ result: failed([step]), outcome: 'failed', testIndex: 0 })
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.evidence.rationale).toBe('the verifier reasoning')
  })

  it('a step whose model judgment could not be made is unknown, never environment', () => {
    const error =
      'assertAI could not judge "the banner is visible": the model call failed: connect ECONNREFUSED 127.0.0.1:443'
    const verdict = classifyRootCause({
      result: failed([judgedStep('unverified', error, 'unresolved')]),
      outcome: 'failed',
      testIndex: 0,
    })
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.confidence).toBe(0)
  })

  it('an unproven step is never classed environment by the error-token scans', () => {
    const verdict = classifyRootCause({
      result: failed([judgedStep('unverified', `${UNPROVEN_ERROR} after ECONNREFUSED`)]),
      outcome: 'failed',
      testIndex: 0,
    })
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.confidence).toBe(0)
  })

  it("a not-met-only block falls through to today's classification", () => {
    const plain = classifyRootCause({
      result: failed([judgedStep('not-met')]),
      outcome: 'failed',
      testIndex: 0,
    })
    expect(plain?.class).toBe('unknown')
    expect(plain?.evidence.rationale).toBe(UNKNOWN_SIGNAL_RATIONALE)

    const connect = classifyRootCause({
      result: failed([judgedStep('not-met', 'Step failed: ECONNREFUSED app:3000')]),
      outcome: 'failed',
      testIndex: 0,
    })
    expect(connect?.class).toBe('environment')
  })

  it('a limit stop keeps its own branch', () => {
    const reason = formatLimitStopReason('actions', 30, 30)
    const limitStop: LimitStopEvidence = {
      limit: 'actions',
      configured: 30,
      used: 30,
      reason,
      requestedOutcome: 'unverified',
    }
    const stopped: StepResult = {
      name: 'Save the setting',
      status: 'failed',
      duration: 1,
      error: reason,
      evidence: { limitStop } as unknown as StepEvidence,
    }
    const verdict = classifyRootCause({
      result: failed([judgedStep('unverified'), stopped]),
      outcome: 'failed',
      testIndex: 0,
    })
    expect(verdict?.class).toBe('unknown')
    expect(verdict?.evidence.citedSteps).toEqual([1])
    expect(verdict?.evidence.rationale).toBe(reason)
  })
})
