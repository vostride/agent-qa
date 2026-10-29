// The single producer of chip status, read from durable job state.

import {
  CurationSnapshotSchema,
  POST_PROCESSING_DETAIL_STAGES,
  PostProcessingStatusSchema,
  RunsPostProcessingInputSchema,
  toRunNotificationView,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  PostProcessingChipStatus,
  PostProcessingChips,
  PostProcessingSkipReason,
  PostProcessingStatus,
  PostProcessingDetailStage,
  PostProcessingStageDetail,
  MaskFn,
  RunsPostProcessingInput,
  CurationSnapshot,
  CurationSnapshotWithheldReason,
  RunId,
  RunNotification,
} from '@vostride/agent-qa-schema'

import { chainJobIdsForRun } from '../../jobs/chain-identity.js'
import { FunctionNotBoundError } from '../spec.js'
import type {
  ClauseVerdict,
  FunctionDeps,
  FunctionSpec,
  PostProcessingChainState,
  PostProcessingJobRow,
} from '../spec.js'

// Lowercase, because the id taxonomy admits no camelCased segment.
export const RUNS_POST_PROCESSING_FUNCTION_ID = 'runs.postprocessing'

/**
 * What one job row means as a chip, plus what its ABSENCE means for that particular stage.
 *
 * The absence argument is what keeps this one function rather than one per stage: every stage
 * reads a present row identically, and a stage differs only in what "no row" says. For both
 * chips today that is "not yet" (`pending`). The parameter stays even though both call sites
 * now pass the same word — a stage whose absence means something else would otherwise have to
 * be written as a second projection, which is the duplication this shape exists to prevent.
 *
 * The claim is read only for a NON-terminal row. A terminal job's claim was released by the
 * transaction that ended it, so consulting it there would be reading a field that says nothing;
 * checking the terminal statuses first also means a row that somehow carried a stale claim
 * still reports what it durably is rather than what somebody was doing to it.
 */
function chipFor(
  row: PostProcessingJobRow | undefined,
  absent: PostProcessingChipStatus,
): PostProcessingChipStatus {
  if (row === undefined) return absent
  if (row.status === 'done') return 'complete'
  // `cancelled` joins `failed` deliberately: both are terminal states in which the stage's work
  // did not happen, and a chip that told them apart would be reporting queue mechanics at a
  // reader who asked what became of their run.
  if (row.status === 'failed' || row.status === 'cancelled') return 'failed'
  return row.claimed ? 'running' : 'pending'
}

// No queue database and an empty state both mean nothing was enqueued for this run.
export function projectPostProcessingChips(
  state: PostProcessingChainState | undefined,
): PostProcessingChips {
  return {
    analysis: chipFor(state?.analyzeRun, 'pending'),
    curation: chipFor(state?.curateMemory, 'pending'),
  }
}

// Read from the enqueue skip's own markers, never from missing job rows.
export function projectPostProcessingSkipped(
  document: CompletedRunHandoff | undefined,
): { reason: PostProcessingSkipReason } | undefined {
  if (document?.gateRun === true) return { reason: 'gate-run' }
  if (document?.excludedFromOutcomes === true) return { reason: 'outcome-excluded' }
  return undefined
}

const IN_FLIGHT_ROW_STATUSES: ReadonlySet<string> = new Set(['running', 'pending'])

// `no-verdict` needs a finished row and a log with no verdict; any read gap derives nothing.
async function readNoVerdictSkipped(
  runId: RunId,
  deps: FunctionDeps,
): Promise<{ reason: PostProcessingSkipReason } | undefined> {
  const runDetail = deps.runDetail
  if (runDetail?.readRecord === undefined) return undefined
  try {
    const record = await runDetail.readRecord(runId)
    if (record === undefined || IN_FLIGHT_ROW_STATUSES.has(record.status)) return undefined
    const events = await deps.runs.readEvents(runId, 1)
    return events.some(event => event.type === 'verdict') ? undefined : { reason: 'no-verdict' }
  } catch {
    return undefined
  }
}

/** Copy only recorded DTO facts; queue state and cancellation requests are not detail fields. */
function projectStageDetails(
  state: PostProcessingChainState | undefined,
  mask: MaskFn | undefined,
): PostProcessingStatus['stageDetails'] {
  const rows = {
    analysis: state?.analyzeRun,
    curation: state?.curateMemory,
  } satisfies Record<PostProcessingDetailStage, PostProcessingJobRow | undefined>
  const details: NonNullable<PostProcessingStatus['stageDetails']> = {}
  for (const stage of POST_PROCESSING_DETAIL_STAGES) {
    const row = rows[stage]
    if (row === undefined) continue
    details[stage] = {
      ...(row.attempts === undefined ? {} : { attempts: row.attempts }),
      ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
      ...(row.claimedAt === undefined ? {} : { claimedAt: row.claimedAt }),
      ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
      ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
      ...(row.conclusionKind === undefined ? {} : { conclusionKind: row.conclusionKind }),
      ...(row.lastFailureKind === undefined || mask === undefined
        ? {} : { lastFailureKind: mask(row.lastFailureKind) }),
      ...(row.lastFailureReason === undefined || mask === undefined
        ? {} : { lastFailureReason: mask(row.lastFailureReason) }),
    } satisfies PostProcessingStageDetail
  }
  return Object.keys(details).length === 0 ? undefined : details
}

type CurationSnapshotProjection =
  | { kind: 'served'; snapshot: CurationSnapshot }
  | { kind: 'withheld'; reason: 'projection-refused' }

const refused = (): CurationSnapshotProjection => ({ kind: 'withheld', reason: 'projection-refused' })

function projectCurationSnapshot(snapshot: CurationSnapshot, mask: MaskFn): CurationSnapshotProjection {
  const source = CurationSnapshotSchema.safeParse(snapshot)
  if (!source.success) return refused()
  const projected = {
    ...source.data,
    rows: source.data.rows.map(row => ({
      ...row,
      recordId: mask(row.recordId),
      ...(row.byRecordId === undefined ? {} : { byRecordId: mask(row.byRecordId) }),
      changes: row.changes.map(entry => ({
        ...entry,
        change: {
          ...entry.change,
          recordId: mask(entry.change.recordId),
          ...(entry.change.byRecordId === undefined ? {} : { byRecordId: mask(entry.change.byRecordId) }),
          ...(entry.change.evidenceToken === undefined ? {} : { evidenceToken: mask(entry.change.evidenceToken) }),
          ...(entry.change.sourceRunId === undefined ? {} : { sourceRunId: mask(entry.change.sourceRunId) }),
          ...(entry.change.observationId === undefined ? {} : { observationId: mask(entry.change.observationId) }),
        },
      })),
    })),
  }
  // Discriminants and constrained hex digests remain structural facts. If redaction
  // collapses identities, withhold rather than merge rows or fabricate a new breakdown.
  const result = CurationSnapshotSchema.safeParse(projected)
  if (!result.success) return refused()
  return { kind: 'served', snapshot: result.data }
}

type RecordedSnapshots =
  | { kind: 'served'; checkpoint?: CurationSnapshot; nested?: CurationSnapshot }
  | { kind: 'withheld'; reason: CurationSnapshotWithheldReason }

// With a mask, either copy refusing withholds both, so the two can never disagree.
function projectRecordedSnapshots(
  state: PostProcessingChainState | undefined,
  mask: MaskFn | undefined,
): RecordedSnapshots {
  const recorded = {
    checkpoint: state?.curationSnapshot,
    nested: state?.notification?.stages.curation.curationSnapshot,
  }
  if (recorded.checkpoint === undefined && recorded.nested === undefined) return { kind: 'served' }
  if (mask === undefined) return { kind: 'withheld', reason: 'masking-unavailable' }
  const served: { checkpoint?: CurationSnapshot; nested?: CurationSnapshot } = {}
  for (const key of ['checkpoint', 'nested'] as const) {
    const snapshot = recorded[key]
    if (snapshot === undefined) continue
    const projection = projectCurationSnapshot(snapshot, mask)
    if (projection.kind === 'withheld') return projection
    served[key] = projection.snapshot
  }
  return { kind: 'served', ...served }
}

// Without a usable mask, failure prose is omitted and recorded snapshots are withheld.
function projectMasked(state: PostProcessingChainState | undefined, mask: MaskFn | undefined) {
  return {
    stageDetails: projectStageDetails(state, mask),
    snapshots: projectRecordedSnapshots(state, mask),
  }
}

function withNestedSnapshot(
  notification: RunNotification,
  snapshot: CurationSnapshot | undefined,
): RunNotification {
  const { curationSnapshot: _recorded, ...curation } = notification.stages.curation
  return {
    ...notification,
    stages: {
      ...notification.stages,
      curation: { ...curation, ...(snapshot === undefined ? {} : { curationSnapshot: snapshot }) },
    },
  }
}

export const runsPostProcessingSpec: FunctionSpec<RunsPostProcessingInput, PostProcessingStatus> = {
  id: RUNS_POST_PROCESSING_FUNCTION_ID,
  summary: "Read one run's post-processing chip statuses from durable job state.",
  resultKind: 'unary',
  // Bound where the composition supplies durable queue storage; otherwise listed `unbound`.
  boundThrough: 'postProcessing',
  input: RunsPostProcessingInputSchema,
  output: PostProcessingStatusSchema,
  risk: { name: `fn:${RUNS_POST_PROCESSING_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * The two chips drive classification; recorded stage details do not change read success.
   *
   * A chip reading `failed` is this op reporting a CHAIN's state truthfully; the read succeeded.
   * Folding a red chip into the clause's own status would make "the post-run chain broke" and "I
   * could not tell you about the post-run chain" the same line on a receipt.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `chain for ${output.runId} — analysis ${output.chips.analysis}, `
        + `curation ${output.chips.curation}`,
    }
  },
  async invoke(input, deps) {
    // Reached with no port only by an in-layer caller; the refusal is the same named error.
    const postProcessing = deps.postProcessing
    if (postProcessing === undefined) {
      throw new FunctionNotBoundError(RUNS_POST_PROCESSING_FUNCTION_ID)
    }

    const runId = String(input.runId)
    // Derived here through this host's id source, so the rows read are the rows enqueued.
    const ids = chainJobIdsForRun(runId, postProcessing.idSource)
    const state = await postProcessing.readChain(ids, runId)
    // Through the REQUIRED runs port, and with no refusal on absence. The not-found throw
    // `runs.get` and `runs.digest` raise is theirs: each NAMES a run, while a chain can
    // legitimately be polled before its handoff lands (the skip runs after the write). An
    // absent document carries no handoff marker; only the run's own record can say no-verdict.
    const handoff = await deps.runs.get(input.runId)
    const skipped = projectPostProcessingSkipped(handoff)
      ?? (handoff === undefined ? await readNoVerdictSkipped(input.runId, deps) : undefined)
    let projected: ReturnType<typeof projectMasked>
    try {
      projected = projectMasked(state, deps.secretMask)
    } catch {
      projected = projectMasked(state, undefined)
    }
    const { stageDetails, snapshots } = projected
    const curationSnapshot = snapshots.kind === 'served' ? snapshots.checkpoint : undefined
    const recordedNotification = state?.notification
    const notification = recordedNotification?.stages.curation.curationSnapshot === undefined
      ? recordedNotification
      : withNestedSnapshot(recordedNotification,
          snapshots.kind === 'served' ? snapshots.nested : undefined)

    return {
      runId,
      chips: projectPostProcessingChips(state),
      ...(stageDetails === undefined ? {} : { stageDetails }),
      ...(curationSnapshot === undefined ? {} : { curationSnapshot }),
      ...(snapshots.kind === 'withheld' ? { curationSnapshotWithheld: { reason: snapshots.reason } } : {}),
      ...(skipped === undefined ? {} : { skipped }),
      // Absence is spread away rather than padded (the `runs-get.ts` idiom): a chain in flight
      // has no record yet, and a rendered `null` would be a second spelling of what a missing
      // key already says.
      ...(notification === undefined ? {} : { notification: toRunNotificationView(notification) }),
    }
  },
}
