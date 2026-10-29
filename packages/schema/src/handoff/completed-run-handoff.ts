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
  /**
   * D-14 §6 gate-run exclusion. Internal validation runs (including M4's
   * verify-before-present gate and eval cassette replays) contribute zero run-outcome
   * counter changes. The runner stamps this literal marker before persisting the handoff,
   * making the decision durable and identical for incremental folds and full rebuilds.
   * Absent means an ordinary counted run.
   */
  excludedFromOutcomes?: true
  /**
   * D-10 carrier for verify-before-present gate runs. Marks a run
   * as an M4 verification gate run so 388 can propagate it onto the `analyze-run` job
   * payload and 393 can set it, with no second breaking handoff-schema change.
   *
   * C8-ratified: gate runs DO feed curation. This is a DISTINCT axis from
   * `excludedFromOutcomes` above — neither marker implies the other, and v51's
   * run-outcome projection continues to read `excludedFromOutcomes` alone. The
   * exclusion semantics of a gate run land in 388/393; 384 mints only the carrier.
   *
   * Only the literal marker is meaningful; absence denotes an ordinary run.
   */
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
  /**
   * which committed ledger entries this run applied, resolved ONCE at run start.
   * The set is folded before the first member executes, so a mid-run ledger edit can never
   * retroactively change a running build — and the run's own record says exactly which
   * dispositions it was operating under, and until when.
   *
   * Absent on runs that applied nothing (the overwhelmingly common case).
   */
  quarantineApplied?: readonly QuarantineAppliedEntry[]
  /**
   * The planner limits this run's steps ran under, copied verbatim from the resolved
   * RunConfig, with the members whose own limits differ. Absent on runs whose producer recorded
   * none.
   */
  plannerLimits?: PlannerLimitsRecord
}
