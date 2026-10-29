// In schema so knowledge-local, which cannot import agent, shares one rule for which step failed.

import type { PerTestOutcome } from '../handoff/per-test-outcome'
import type { StepEvidence } from '../handoff/step-evidence'

/**
 * THE failing-step selection rule: the FIRST step whose verifier verdict failed, else the LAST
 * recorded step (the timeout-after-all-verified anchor). A zero-step test has no failing step
 * and keys through the error-signature fallback below.
 */
export function failingStepOf(test: PerTestOutcome): StepEvidence | undefined {
  if (test.steps.length === 0) return undefined
  return (
    test.steps.find((step) => !step.verifierVerdict.pass)
    ?? test.steps[test.steps.length - 1]
  )
}

// Every branch quotes bytes the run recorded.
export function errorTextOf(step: StepEvidence | undefined, test: PerTestOutcome): string {
  if (step === undefined) return test.outcome
  const subActionError = step.subActions
    .map((subAction) => subAction.result.error)
    .find((error): error is string => typeof error === 'string' && error !== '')
  return subActionError ?? step.verifierVerdict.reasoning
}
