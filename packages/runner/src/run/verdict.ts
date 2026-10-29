// Pure and total, so the shell and the CLI carry no verdict logic.

import type { MemberTestOutcome, RunStatus } from '@vostride/agent-qa-schema'
import type { TestResult } from '../result.js'
import { isTestTimeoutMessage } from '../loop/abort.js'

// Re-export the matcher so consumers take the timeout signal from the module it feeds.
export { isTestTimeoutMessage }

// `healed` keys on selfHeal evidence presence, never on a step status string.
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

// Order: run cancel, failure, member cancel, healed, passed; step 2 skips quarantined failures.
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

// Healed is a pass; cancelled maps to 130 by SIGINT convention; exit 2 is never produced here.
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
