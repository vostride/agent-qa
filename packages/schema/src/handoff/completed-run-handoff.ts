import type { ScopeKey } from '../identity/scope-key'
import type { RunId } from '../run/run-id'
import type { ExecutionContext, RunStatus } from '../run/run-status'
import type { QuarantineAppliedEntry } from '../quarantine/quarantine-ledger'
import type { PlannerLimitsRecord } from '../config/planner-limits'
import type { PerTestOutcome } from './per-test-outcome'

export const CURRENT_HANDOFF_SCHEMA_VERSION = 2

export interface CompletedRunHandoff {
  schemaVersion: number
  runId: RunId
  scope: ScopeKey
  buildOrdinal: number
  // The runner stamps this before persisting, so incremental folds and full rebuilds agree.
  excludedFromOutcomes?: true
  // Independent of `excludedFromOutcomes`; gate runs still feed curation.
  gateRun?: true
  executionContext: ExecutionContext
  aggregateVerdict: RunStatus
  configDigests: {
    suiteConfigDigest: string
    testConfigDigest: string
  }
  startedAt: number
  endedAt: number
  tests: PerTestOutcome[]
  // Resolved once at run start, so a mid-run ledger edit cannot change a running build.
  quarantineApplied?: readonly QuarantineAppliedEntry[]
  /**
   * The planner limits this run's steps ran under, copied verbatim from the resolved
   * RunConfig, with the members whose own limits differ. Absent on runs whose producer recorded
   * none.
   */
  plannerLimits?: PlannerLimitsRecord
}
