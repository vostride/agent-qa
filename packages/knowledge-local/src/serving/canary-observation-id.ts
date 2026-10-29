// One implementation the reader may import; `curator/disposition.ts` re-exports it for writers.

import { canonicalJson, sha256hex } from '@vostride/agent-qa-schema'
import type { CanaryOutcome } from '@vostride/agent-qa-schema'

// Binds one canary observation to the served candidate and attributed step.
export function canaryOutcomeObservationId(
  outcome: Pick<
    CanaryOutcome,
    'candidateId' | 'runId' | 'testId' | 'testIndex' | 'stepIndex'
  >,
): string {
  return `canary-outcome:${sha256hex(canonicalJson({
    candidateId: outcome.candidateId,
    runId: outcome.runId,
    testId: outcome.testId,
    testIndex: outcome.testIndex,
    stepIndex: outcome.stepIndex,
  }))}`
}
