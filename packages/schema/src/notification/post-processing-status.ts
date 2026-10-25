// THE post-processing chip vocabulary (Phase 388, D-14 / D-15; narrowed Phase 404, D-01).
//
// One exported closed union, in one place, because the vocabulary appears in three: the bus
// chip events the in-process tail emits, the read op that projects durable job state, and
// the CLI's exit summary line. Three spellings of four words is not a duplication a reviewer
// catches — it is the state in which the dashboard says "queued" while the CLI says
// "pending" about the same row, and nothing is wrong with either of them.
//
// 2026-08-26 (Phase 404, D-01): the chip set is exactly `{analysis, curation}` and the
// vocabulary is exactly `pending · running · done · failed`. The Issue engine left the spec on
// 2026-08-25, so the structural member that used to answer for the unfilled triage slot has no
// slot left to answer for, and a word no producer can produce is a word every consumer still
// has to render. The chip side stopped reading and rendering the third id then.
// 2026-09-02 (Phase 412): the job-kind layer followed — the reserved sixth job kind, the chain's
// third derived id, the retired entity kind and the retired proposal arm left with the
// Issue-slot cleanup.
// 2026-10-17 (444-10, D-13): the vocabulary is `pending · running · complete · failed`; a done job row reads `complete`.

import { z } from 'zod'

import { jobConclusionKindValues } from '../job/job'
import type { JobConclusionKind } from '../job/job'
import type { RunNotificationView } from './run-notification'
import type { CurationSnapshot } from './curation-snapshot'

/**
 * Declared in the order a stage passes through them.
 *
 * A runtime array rather than a bare type, because the projection and its tests both need to
 * enumerate the vocabulary, and a union that only exists at compile time cannot be walked.
 */
export const POST_PROCESSING_CHIP_STATUSES = [
  'pending',
  'running',
  'complete',
  'failed',
] as const

export type PostProcessingChipStatus = (typeof POST_PROCESSING_CHIP_STATUSES)[number]

/**
 * The two chips, named rather than indexed.
 *
 * Fixed members instead of a record keyed by stage name: the chip set is ratified and closed
 * (spec §4.1 — notify is not a chip), so a surface that renders both should fail to compile
 * when a third arrives rather than silently render half the truth. That compile error is the
 * point: it is what walked this narrowing through every consumer in Phase 404.
 */
export interface PostProcessingChips {
  analysis: PostProcessingChipStatus
  curation: PostProcessingChipStatus
}

export type PostProcessingDetailStage = 'analysis' | 'curation'

export const POST_PROCESSING_DETAIL_STAGES = [
  'analysis',
  'curation',
] as const satisfies readonly PostProcessingDetailStage[]

/**
 * Recorded job facts only. Producers omit missing facts and mask failure text before
 * publishing; absence never asserts a zero attempt count or an unrecorded timestamp.
 *
 * Two instants, two different facts: `claimedAt` is the lease a drainer holds right now and is
 * absent on every settled row, because a terminal transition releases it; `startedAt` is when the
 * work first began, and it survives the lease.
 */
export interface PostProcessingStageDetail {
  attempts?: number
  createdAt?: string
  claimedAt?: string
  startedAt?: string
  updatedAt?: string
  conclusionKind?: JobConclusionKind
  lastFailureKind?: string
  lastFailureReason?: string
}

export const PostProcessingStageDetailSchema = z.object({
  attempts: z.number().int().nonnegative().optional(),
  createdAt: z.string().min(1).optional(),
  claimedAt: z.string().min(1).optional(),
  startedAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  conclusionKind: z.enum(jobConclusionKindValues).optional(),
  lastFailureKind: z.string().optional(),
  lastFailureReason: z.string().optional(),
}).strict() satisfies z.ZodType<PostProcessingStageDetail>

/**
 * Why a recorded curation snapshot was not served (423 D-15, Gap 2). The read degrades the
 * snapshot, never itself: chips, stage details and the notification are served either way.
 */
export type CurationSnapshotWithheldReason = 'masking-unavailable' | 'projection-refused'

export const CURATION_SNAPSHOT_WITHHELD_REASONS = [
  'masking-unavailable',
  'projection-refused',
] as const satisfies readonly CurationSnapshotWithheldReason[]

export const CurationSnapshotWithheldSchema = z.object({
  reason: z.enum(CURATION_SNAPSHOT_WITHHELD_REASONS),
}).strict() satisfies z.ZodType<{ reason: CurationSnapshotWithheldReason }>

/**
 * Why a run's post-run chain was never enqueued (425 D-08). A gate run and an
 * outcome-excluded run both skip the whole chain (404 D-08), so their chips would otherwise
 * read `pending` forever. The fact is a SIBLING of the chip words, never a fifth word: the
 * four-word vocabulary above stays closed, and a surface renders it beside the chips.
 * 2026-10-17 (444-11, D-39): renamed from the exclusion fact; every surface prints `skipped (<word>)`.
 * 2026-10-18 (444-12, D-14): `no-verdict` is a finished row with no handoff and no logged verdict.
 */
export type PostProcessingSkipReason = 'gate-run' | 'outcome-excluded' | 'no-verdict'

export const POST_PROCESSING_SKIP_REASONS = [
  'gate-run',
  'outcome-excluded',
  'no-verdict',
] as const satisfies readonly PostProcessingSkipReason[]

export const PostProcessingSkippedSchema = z.object({
  reason: z.enum(POST_PROCESSING_SKIP_REASONS),
}).strict() satisfies z.ZodType<{ reason: PostProcessingSkipReason }>

/** The one spelling of each reason every renderer prints inside `skipped (…)`. */
export const POST_PROCESSING_SKIP_REASON_WORDS: Readonly<Record<PostProcessingSkipReason, string>> = {
  'gate-run': 'gate run',
  'outcome-excluded': 'outcome-excluded',
  'no-verdict': 'no verdict',
}

export interface PostProcessingStatus {
  runId: string
  chips: PostProcessingChips
  /** A missing job row leaves its stage absent, including on historical payloads. */
  stageDetails?: Partial<Record<PostProcessingDetailStage, PostProcessingStageDetail>>
  curationSnapshot?: CurationSnapshot
  /**
   * Present iff a recorded snapshot exists and could not be projected safely; never beside
   * curationSnapshot. One flag governs both the checkpoint copy and the notification's nested copy.
   */
  curationSnapshotWithheld?: { reason: CurationSnapshotWithheldReason }
  /**
   * Present iff the run's durable record carries a gate-run or outcome-excluded marker; never
   * derived from missing job rows, from the run's status or from a pushed frame.
   */
  skipped?: { reason: PostProcessingSkipReason }
  /**
   * Present only once the chain reached its terminal and wrote its one row (D-09). Absent is
   * the ordinary state of a chain still in flight — never rendered as a failure.
   */
  notification?: RunNotificationView
}

export function isPostProcessingChipStatus(value: unknown): value is PostProcessingChipStatus {
  return (
    typeof value === 'string' &&
    (POST_PROCESSING_CHIP_STATUSES as readonly string[]).includes(value)
  )
}
