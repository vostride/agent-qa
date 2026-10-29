// What FEEDS the failure fingerprint: one exported derivation.
//
// The recipe itself lives next door in `failure-fingerprint.ts` and is FROZEN.
// This module is its INPUT stage — the rule that decides which step a failure is about, and
// which recorded bytes describe it — and it changes nothing about the recipe.
//
// THE RULE (contract, not implementation detail):
//   failing step = the FIRST step whose verifier verdict failed, else the LAST recorded step
//                  (the timeout-after-all-verified anchor); a zero-step test has none.
//   error text   = the failing step's FIRST non-empty sub-action error, else the verifier's
//                  reasoning; a step-less test answers its recorded outcome.
//
// It lives HERE, in schema, rather than beside its first caller, because three consumers now
// need one spelling and they cannot all reach each other: `analysis/cluster.ts` (the render-time
// presentation), `jobs/kinds.ts`'s `templateGroundingQuote` (the floor sentence's quote), and —
// the reason for the hoist — knowledge-local's fingerprint-keyed recurrence windows, which
// cannot import agent. Two spellings of "which step failed" would be two fingerprints for one
// failure, so SC1's window and the cluster presentation would eventually disagree about what
// "the same failure" means (388 C13: one exported vocabulary).
//
// Pure-sync over DTOs, no host APIs — the schema-package law.

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

/**
 * The error-signature fallback source for anchorless failures (D-13's total-function leg):
 * the failing step's first sub-action error text, else the verifier's reasoning; a step-less
 * test answers its recorded outcome. Every branch quotes bytes the run recorded.
 */
export function errorTextOf(step: StepEvidence | undefined, test: PerTestOutcome): string {
  if (step === undefined) return test.outcome
  const subActionError = step.subActions
    .map((subAction) => subAction.result.error)
    .find((error): error is string => typeof error === 'string' && error !== '')
  return subActionError ?? step.verifierVerdict.reasoning
}
