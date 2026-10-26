import {
  acquireEmbedder,
  type AcquireEmbedderOutcome,
} from '../embedder-acquire.js'
import {
  runKnowledgeGc,
  type GcSummary,
  type RunKnowledgeGcHooks,
} from '../gc.js'
import { readIndexMaintenanceState, type IndexMaintenanceState } from '../index-open.js'
import {
  rebuildIndex,
  removeBundleProjectionRows,
  type RebuildReport,
} from '../index-rebuild.js'
import {
  WriterAuthorityLostError,
  type WriterLeaseAuthority,
} from '../lease/writer-lease.js'
import {
  readRebuildRequest,
  type RebuildRequest,
} from '../rebuild-marker.js'

export type MaintenanceSkipReason =
  | 'lease-held'
  | 'budget-exhausted'
  | 'aborted'
  | 'daemon-cadence'

export type WriterPassReport =
  | { kind: 'not-requested' }
  | { kind: 'skipped'; reason: MaintenanceSkipReason }
  | {
      kind: 'rebuilt'
      request?: RebuildRequest
      rebuild: RebuildReport
    }
  | { kind: 'failed'; message: string }

export type GcPassReport =
  | { kind: 'not-run' }
  | { kind: 'skipped'; reason: MaintenanceSkipReason }
  | {
      kind: 'completed'
      summary: GcSummary
      /** WR-01: projection rows removed by the same-tail scoped cleanup; absent on zero-trim. */
      projectionRowsRemoved?: number
    }
  | { kind: 'failed'; message: string }

export interface MaintenanceOperations {
  readRebuildRequest: typeof readRebuildRequest
  readIndexMaintenanceState: typeof readIndexMaintenanceState
  acquireEmbedder: typeof acquireEmbedder
  rebuildIndex: typeof rebuildIndex
  runKnowledgeGc: typeof runKnowledgeGc
  removeBundleProjectionRows: typeof removeBundleProjectionRows
  beforeGcRemoval?: RunKnowledgeGcHooks['beforeGcRemoval']
}

export interface MaintenanceBudget {
  now: () => number
  startedAtMs: number
  limitMs: number
}

export interface RunMaintenanceTailOptions {
  knowledgeRoot: string
  lease: { leaseId: string; epoch: number }
  /** Host-resolved posture; daemon callers pass worker-required, one-shot callers omit it. */
  embeddingCapability?: AcquireEmbedderOutcome
  /** Omit for daemon cadence; one-shot drains provide their 60 s boundary explicitly. */
  budget?: MaintenanceBudget
  /** Fault-injection seam; production callers must omit it. */
  operations?: Partial<MaintenanceOperations>
  /** One-shot drains fold authority loss into their report; daemon callers surface it by default. */
  surfaceAuthorityLoss?: boolean
}

export interface MaintenanceTailFailure {
  stage: 'writer-pass' | 'gc'
  error: unknown
}

export interface MaintenanceTailResult {
  writerPass: WriterPassReport
  gc: GcPassReport
  failures: MaintenanceTailFailure[]
}

const DEFAULT_OPERATIONS: MaintenanceOperations = {
  readRebuildRequest,
  readIndexMaintenanceState,
  acquireEmbedder,
  rebuildIndex,
  runKnowledgeGc,
  removeBundleProjectionRows,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasIndexMaintenanceDebt(state: IndexMaintenanceState): boolean {
  return state.indexAbsent
    || state.pendingEmbeddings > 0
    || state.renderingEpochStale
    || state.vectorReconciliationOutstanding
}

function budgetExhausted(budget: MaintenanceBudget | undefined): boolean {
  return budget !== undefined && budget.now() - budget.startedAtMs >= budget.limitMs
}

async function runWriterPass(
  options: RunMaintenanceTailOptions,
  operations: MaintenanceOperations,
): Promise<WriterPassReport> {
  const marker = operations.readRebuildRequest(options.knowledgeRoot)
  const maintenance = operations.readIndexMaintenanceState(options.knowledgeRoot)
  if (!marker.present && !hasIndexMaintenanceDebt(maintenance)) {
    return { kind: 'not-requested' }
  }

  const capability = options.embeddingCapability
    ?? await operations.acquireEmbedder({ allowDownload: false })
  const injectedRebuild = options.operations?.rebuildIndex !== undefined
  const rebuild = await operations.rebuildIndex({
    knowledgeRoot: options.knowledgeRoot,
    ...(capability.kind === 'ready' ? { embedder: capability.embedder } : {}),
    // Production rebuilds retain Phase 385's fresh authority fence at every mutation boundary.
    // Fault-injection rebuilds keep their historical call shape and own their injected behavior.
    ...(injectedRebuild
      ? {}
      : {
          writerAuthority: {
            knowledgeRoot: options.knowledgeRoot,
            leaseId: options.lease.leaseId,
            epoch: options.lease.epoch,
          },
        }),
  })
  return {
    kind: 'rebuilt',
    ...(marker.present && marker.request !== undefined ? { request: marker.request } : {}),
    rebuild,
  }
}

function shouldSurfaceAuthorityLoss(
  options: RunMaintenanceTailOptions,
  error: unknown,
): boolean {
  return options.surfaceAuthorityLoss !== false && error instanceof WriterAuthorityLostError
}

/**
 * Run the writer-repair and canonical-GC tail as one host-independent callable.
 *
 * Daemon callers omit budget and receive stale authority errors unchanged. The one-shot drain
 * supplies its existing wall-clock boundary and folds typed failures into DrainReport.
 */
export async function runMaintenanceTail(
  options: RunMaintenanceTailOptions,
): Promise<MaintenanceTailResult> {
  const operations: MaintenanceOperations = {
    ...DEFAULT_OPERATIONS,
    ...options.operations,
  }
  const failures: MaintenanceTailFailure[] = []
  let writerPass: WriterPassReport
  let gc: GcPassReport = { kind: 'not-run' }

  try {
    writerPass = await runWriterPass(options, operations)
  } catch (error) {
    if (shouldSurfaceAuthorityLoss(options, error)) throw error
    failures.push({ stage: 'writer-pass', error })
    writerPass = { kind: 'failed', message: errorMessage(error) }
  }

  if (budgetExhausted(options.budget)) {
    return {
      writerPass,
      gc: { kind: 'skipped', reason: 'budget-exhausted' },
      failures,
    }
  }

  try {
    /**
     * D-13 M2 has no gate receipts. Phase 380 adds live canary-reference exclusions; M3 supplies
     * the real ordinal horizon through this seam. Budget gates the start only and never
     * interrupts whole-dir trims.
     */
    const writerAuthority: WriterLeaseAuthority = {
      knowledgeRoot: options.knowledgeRoot,
      leaseId: options.lease.leaseId,
      epoch: options.lease.epoch,
    }
    const summary = operations.runKnowledgeGc(
      {
        knowledgeRoot: options.knowledgeRoot,
        horizon: { kind: 'none' },
      },
      writerAuthority,
      { beforeGcRemoval: operations.beforeGcRemoval },
    )
    const completed: Extract<GcPassReport, { kind: 'completed' }> = {
      kind: 'completed',
      summary,
    }
    gc = completed
    if (summary.trimmedRecordIds.length > 0) {
      try {
        completed.projectionRowsRemoved = operations.removeBundleProjectionRows(
          options.knowledgeRoot,
          summary.trimmedRecordIds,
          writerAuthority,
        )
      } catch (error) {
        if (shouldSurfaceAuthorityLoss(options, error)) throw error
        // Canonical truth was already trimmed; preserve the projection debt as a typed failure.
        failures.push({ stage: 'gc', error })
      }
    }
  } catch (error) {
    if (shouldSurfaceAuthorityLoss(options, error)) throw error
    failures.push({ stage: 'gc', error })
    gc = { kind: 'failed', message: errorMessage(error) }
  }

  return { writerPass, gc, failures }
}
