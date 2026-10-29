// The canary observation identity, in a module the READ face may import.
//
// MOVED from `curator/disposition.ts` rather than copied. The writer stamps this id onto the
// outcome event it appends and the reader recomputes it to find that event again, so a second
// spelling would be a silent attribution failure — a run's canary line would render "not yet
// attributed" forever while its evidence sat on disk — rather than a compile error. There is
// exactly one implementation and `curator/disposition.ts` re-exports it, so every writer-side
// caller is unchanged.
//
// WHY IT HAD TO MOVE. `disposition.ts` imports the bundle store, the egress checkpoint and the
// curation queue payloads; a reader-entry module that reached into it would pull the whole write
// path behind the physically read-only entry. This file imports schema types and two pure
// helpers, and nothing else.

import { canonicalJson, sha256hex } from '@vostride/agent-qa-schema'
import type { CanaryOutcome } from '@vostride/agent-qa-schema'

/**
 * bind one canary observation to the served candidate and attributed step. The schema
 * evidence-token recipe adds the exercised anchor and build ordinal; together those fields are
 * the complete replay identity required by §7.5.1.
 */
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
