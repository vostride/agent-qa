// One closed union: three spellings would let the dashboard and CLI name one row differently.

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

// Named members, so a third chip fails to compile wherever a surface renders both.
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

// The read degrades the snapshot, never itself: chips, details and the notification still serve.
export type CurationSnapshotWithheldReason = 'masking-unavailable' | 'projection-refused'

export const CURATION_SNAPSHOT_WITHHELD_REASONS = [
  'masking-unavailable',
  'projection-refused',
] as const satisfies readonly CurationSnapshotWithheldReason[]

export const CurationSnapshotWithheldSchema = z.object({
  reason: z.enum(CURATION_SNAPSHOT_WITHHELD_REASONS),
}).strict() satisfies z.ZodType<{ reason: CurationSnapshotWithheldReason }>

// A sibling fact, not a fifth chip word: a skipped chain would otherwise read `pending` forever.
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
  // Absent while the chain is in flight, which is never rendered as a failure.
  notification?: RunNotificationView
}

export function isPostProcessingChipStatus(value: unknown): value is PostProcessingChipStatus {
  return (
    typeof value === 'string' &&
    (POST_PROCESSING_CHIP_STATUSES as readonly string[]).includes(value)
  )
}
