// Wave-0 RED scaffold (361-01, Task 2). Pins the SESSION-04 verdict-derivation tables
// BEFORE any implementation exists — RED strictly on the unresolved import of the
// not-yet-existing `../verdict.js` module (right-reason RED). Turns green in Plan 05.
//
// Contract source: 361-CONTEXT.md D-14 (exit codes), D-15 (member outcome union + neutral
// skipped), D-16 (per-test outcome is a pure total function; timeout via the existing
// createTimeoutAbortReason tag; healed keyed on selfHeal evidence, NEVER a step status
// string — RESEARCH Pitfall 5) + spec/v2/runner.md §2.1 ratified aggregate rule.
//
// Runner package convention: `.js`-suffixed relative import specifiers.
import { describe, expect, it } from 'vitest'

import {
  deriveAggregateVerdict,
  deriveMemberOutcome,
  isTestTimeoutMessage,
  mapVerdictToExitCode,
} from '../verdict.js'
import { createTimeoutAbortReason } from '../../loop/abort.js'
import type { StepResult, TestResult } from '../../result.js'
import type { MemberTestOutcome } from '@vostride/agent-qa-schema'
import type { RunStatus, StepEvidence } from '@vostride/agent-qa-schema'

// ---- Fixtures ------------------------------------------------------------

function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    name: 'a step',
    status: 'passed',
    duration: 1,
    ...overrides,
  }
}

function healedEvidence(): StepEvidence {
  // Only selfHeal is load-bearing for the derivation; the rest is minimal.
  return {
    selfHeal: {
      failedDecision: { plan: 'x', plannedAction: { type: 'click', ref: 'e1' }, result: { success: false } },
      recoveringDecision: { plan: 'y', plannedAction: { type: 'click', ref: 'e1' }, result: { success: true } },
    },
  } as unknown as StepEvidence
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

const TEST_TIMEOUT_MESSAGE = createTimeoutAbortReason('test', 30_000).message
const STEP_TIMEOUT_MESSAGE = createTimeoutAbortReason('step', 5_000).message

// ---- isTestTimeoutMessage -----------------------------------------

describe('isTestTimeoutMessage', () => {
  it.each([
    [TEST_TIMEOUT_MESSAGE, true],
    [STEP_TIMEOUT_MESSAGE, false],
    ['Some unrelated failure', false],
    ['', false],
  ])('%j -> %s', (message, expected) => {
    expect(isTestTimeoutMessage(message)).toBe(expected)
  })
})

// ---- deriveMemberOutcome -------------------------------------

describe('deriveMemberOutcome — pure total function', () => {
  it('passed + a step carrying selfHeal evidence ⇒ healed (keyed on evidence, not step status)', () => {
    const result = test({ status: 'passed', steps: [step({ status: 'passed', evidence: healedEvidence() })] })
    expect(deriveMemberOutcome(result)).toBe('healed')
  })

  it('passed with no heal evidence ⇒ passed', () => {
    const result = test({ status: 'passed', steps: [step({ status: 'passed' })] })
    expect(deriveMemberOutcome(result)).toBe('passed')
  })

  it('failed with a test-timeout-tagged step error ⇒ timeout', () => {
    const result = test({ status: 'failed', steps: [step({ status: 'failed', error: TEST_TIMEOUT_MESSAGE })] })
    expect(deriveMemberOutcome(result)).toBe('timeout')
  })

  it('failed with a step-scope timeout error is NOT a test timeout ⇒ failed', () => {
    const result = test({ status: 'failed', steps: [step({ status: 'failed', error: STEP_TIMEOUT_MESSAGE })] })
    expect(deriveMemberOutcome(result)).toBe('failed')
  })

  it.each<[TestResult['status'], MemberTestOutcome]>([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['skipped', 'skipped'],
  ])('status %s (no heal, no timeout) ⇒ %s', (status, expected) => {
    const result = test({ status, steps: [step({ status: status === 'passed' ? 'passed' : 'failed' })] })
    expect(deriveMemberOutcome(result)).toBe(expected)
  })
})

// ---- deriveAggregateVerdict (spec §2.1 ordered rule + D-15) ---------------

interface AggregateCase {
  name: string
  runCancelled: boolean
  outcomes: MemberTestOutcome[]
  expected: RunStatus
}

const AGGREGATE_CASES: AggregateCase[] = [
  { name: 'runCancelled wins over everything', runCancelled: true, outcomes: ['failed', 'passed'], expected: 'cancelled' },
  { name: 'any member failed ⇒ failed', runCancelled: false, outcomes: ['passed', 'failed', 'healed'], expected: 'failed' },
  { name: 'any member timeout ⇒ failed', runCancelled: false, outcomes: ['passed', 'timeout'], expected: 'failed' },
  { name: 'any member cancelled (no failed) ⇒ cancelled', runCancelled: false, outcomes: ['passed', 'cancelled'], expected: 'cancelled' },
  { name: 'some healed none failed ⇒ healed', runCancelled: false, outcomes: ['passed', 'healed'], expected: 'healed' },
  { name: 'all passed ⇒ passed', runCancelled: false, outcomes: ['passed', 'passed'], expected: 'passed' },
  { name: 'skipped members are neutral ⇒ passed', runCancelled: false, outcomes: ['passed', 'skipped'], expected: 'passed' },
  { name: 'all-skipped ⇒ passed (vacuous)', runCancelled: false, outcomes: ['skipped', 'skipped'], expected: 'passed' },
  { name: 'skipped + healed ⇒ healed', runCancelled: false, outcomes: ['skipped', 'healed'], expected: 'healed' },
  { name: 'empty run ⇒ passed', runCancelled: false, outcomes: [], expected: 'passed' },
]

describe('deriveAggregateVerdict (spec §2.1 ratified rule + neutral-skipped)', () => {
  it.each(AGGREGATE_CASES)('$name', ({ runCancelled, outcomes, expected }) => {
    expect(deriveAggregateVerdict({ runCancelled, outcomes })).toBe(expected)
  })
})

// ---- mapVerdictToExitCode -----------------------------------------

describe('mapVerdictToExitCode', () => {
  it.each<[RunStatus, number]>([
    ['passed', 0],
    ['healed', 0],
    ['failed', 1],
    ['timeout', 1],
    ['cancelled', 130],
  ])('%s ⇒ exit %d', (verdict, code) => {
    expect(mapVerdictToExitCode(verdict)).toBe(code)
  })
})
