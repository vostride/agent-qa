// SESSION-04 verdict-derivation core (D-14/D-15/D-16). Pure, total, no imports
// beyond types + the single-sourced isTestTimeoutMessage matcher. The shell (Plan 06)
// and CLI (Plans 10/11) consume these so the orchestration layers carry zero verdict
// logic. Every branch here is pinned by run/__tests__/verdict.test.ts.

import type { MemberTestOutcome, RunStatus } from '@vostride/agent-qa-schema'
import type { TestResult } from '../result.js'
import { isTestTimeoutMessage } from '../loop/abort.js'

// Re-export the single-sourced matcher so verdict consumers (and the Wave-0 table)
// import the timeout signal from the same module as the derivations it feeds.
export { isTestTimeoutMessage }

/**
 * Derive the member-level outcome for one completed test (D-16). Pure total function.
 *
 * - status `skipped` ⇒ `'skipped'` (member-neutral; passed through)
 * - status `cancelled` ⇒ `'cancelled'`
 * - status `passed` ⇒ `'healed'` when ANY step carries selfHeal evidence, else `'passed'`.
 *   The live heal signal is StepEvidence.selfHeal *presence* — a step-status read would
 *   never fire (RESEARCH Pitfall 5), so we never inspect a step status string here.
 * - status `failed` ⇒ `'timeout'` when ANY failed step's `error` is the test-deadline
 *   message (isTestTimeoutMessage), else `'failed'`.
 *
 * Core's TestStatus and the executor port stay untouched by this derivation (D-16).
 */
export function deriveMemberOutcome(result: TestResult): MemberTestOutcome {
  switch (result.status) {
    case 'skipped':
      return 'skipped'
    case 'cancelled':
      return 'cancelled'
    case 'passed':
      return result.steps.some((s) => s.evidence?.selfHeal !== undefined) ? 'healed' : 'passed'
    case 'failed':
      return result.steps.some((s) => s.status === 'failed' && s.error !== undefined && isTestTimeoutMessage(s.error))
        ? 'timeout'
        : 'failed'
  }
}

/**
 * Fold member outcomes into the aggregate run verdict — the ratified spec §2.1 ordered
 * rule with the D-15 neutral-skipped clause. EVALUATED IN ORDER:
 *
 *  1. `runCancelled` ⇒ `'cancelled'` (a whole-run cancel wins over everything)
 *  2. any member `'failed'` or `'timeout'` ⇒ `'failed'`
 *  3. any member `'cancelled'` (none failed) ⇒ `'cancelled'`
 *  4. any member `'healed'` (none failed) ⇒ `'healed'`
 *  5. else ⇒ `'passed'`
 *
 * `'skipped'` members are neutral throughout — an all-skipped (or empty) run is
 * vacuously `'passed'` (D-15, the reconciled clause; matches every test runner).
 *
 * The quarantine skip is EXPLICIT IN THE RULE, right here in step 2 and nowhere else.
 * `quarantined[i] === true` marks a member whose failure the committed ledger has licensed:
 * step 2 passes over it, so a run whose only failures are quarantined aggregates `'passed'` and
 * exits 0 through the untouched {@link mapVerdictToExitCode}. Three things this deliberately does
 * NOT do: it does not rewrite the member outcome (`'failed'` stays `'failed'` — the projection
 * window and the auto-exit keep seeing reality), it does not touch any other branch (a sibling
 * `'cancelled'`/`'healed'` still governs, and the run-level cancel branch still wins outright), and
 * it does not widen either closed union. `quarantined` absent — or shorter than `outcomes` — is
 * byte-identical pre-390 behavior, which is why every existing call site compiles unchanged.
 *
 * The skip covers `'timeout'` members as well as `'failed'` ones: a quarantined flaky test that
 * times out is the same A3 phenomenon, and a rule that suppressed one but not the other would make
 * relief depend on how the flake happened to manifest that build.
 */
export function deriveAggregateVerdict(input: {
  runCancelled: boolean
  outcomes: readonly MemberTestOutcome[]
  quarantined?: readonly boolean[]
}): RunStatus {
  if (input.runCancelled) return 'cancelled'
  const quarantined = input.quarantined
  if (
    input.outcomes.some(
      (o, index) => (o === 'failed' || o === 'timeout') && quarantined?.[index] !== true,
    )
  ) {
    return 'failed'
  }
  if (input.outcomes.some((o) => o === 'cancelled')) return 'cancelled'
  if (input.outcomes.some((o) => o === 'healed')) return 'healed'
  return 'passed'
}

/**
 * Map an aggregate verdict to a process exit code (D-14). Pure and pinned:
 * passed/healed ⇒ 0 (healed is ratified as a pass — the annotation lives in output and
 * the handoff, never the exit code), failed/timeout ⇒ 1, cancelled ⇒ 130 (existing SIGINT
 * convention). Exit 2 stays reserved for config/setup errors and is NOT produced here.
 */
export function mapVerdictToExitCode(verdict: RunStatus): number {
  switch (verdict) {
    case 'passed':
    case 'healed':
      return 0
    case 'failed':
    case 'timeout':
      return 1
    case 'cancelled':
      return 130
  }
}
