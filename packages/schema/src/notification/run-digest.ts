// Refs and counts only: surfaces render it directly, so it may carry no secret.

import { z } from 'zod'

import { AnalysisClusterViewSchema } from '../functions/analysis-get'
import type { AnalysisClusterView } from '../functions/analysis-get'
import { MARK_FIX_KINDS, MarkAppliedChangeSchema } from '../functions/feedback'
import type { MarkAppliedChange, MarkFixKind } from '../functions/feedback'
import { runIdSchema } from '../run/run-id'
import { POST_PROCESSING_CHIP_STATUSES, PostProcessingSkippedSchema } from './post-processing-status'
import type { PostProcessingChipStatus, PostProcessingSkipReason } from './post-processing-status'
import { RUN_NOTIFICATION_VIEW_STATUSES } from './run-notification'
import type { RunNotificationViewStatus } from './run-notification'

/** `runs.digest` addresses exactly one run by id — the `runs.postprocessing` shape. */
export const RunsDigestInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsDigestInput = z.infer<typeof RunsDigestInputSchema>

// In ledger order; a later mark on the same address does not remove an earlier change.
export interface RunDigestMarkChange {
  markId: string
  ordinal: number
  fix: MarkFixKind
  change: MarkAppliedChange
}

// `outcome` is a fact about the chain, not the run: a failed run's clean chain reads `complete`.
export interface RunDigestChainOutcomes {
  analysis: PostProcessingChipStatus
  curation: PostProcessingChipStatus
  outcome?: RunNotificationViewStatus
  // So a machine reader never re-derives the skipped fact from `pending` chips.
  skipped?: { reason: PostProcessingSkipReason }
}

// Counts only: the notification row is counts-only, and no other durable source lists candidates.
export interface RunDigestCandidateReport {
  curated: number
  deprecated: number
}

// State, not transitions: entries carry no run attribution, so per-run changes cannot be counted.
export interface RunDigestQuarantineReport {
  quarantined: number
  expired: number
  refs: string[]
}

// `lines` are the printed bytes so no surface composes a sentence.
export interface RunDigest {
  runId: string
  verdictClusters: AnalysisClusterView[]
  chain: RunDigestChainOutcomes
  /**
   * The fixes this run's marks applied, in ledger order. ABSENT where this host reads no mark
   * ledger or the ledger could not be read — an empty list is a measurement ("no mark changed
   * anything"), and an unread ledger is not.
   */
  markChanges?: RunDigestMarkChange[]
  candidates: RunDigestCandidateReport
  quarantine: RunDigestQuarantineReport
  lines: string[]
}

export const RunDigestMarkChangeSchema = z.object({
  markId: z.string().min(1),
  ordinal: z.number().int().positive(),
  fix: z.enum(MARK_FIX_KINDS),
  change: MarkAppliedChangeSchema,
}).strict().superRefine((value, ctx) => {
  // The same fix-to-change pairing `MarkDispositionSchema`'s applied arm enforces on the ledger.
  if ((value.fix === 'test-edit') !== (value.change.kind === 'test-file')) {
    ctx.addIssue({
      code: 'custom',
      path: ['change', 'kind'],
      message: 'a test edit writes a test file and every other fix changes knowledge',
    })
  }
}) satisfies z.ZodType<RunDigestMarkChange>

// Built from the exported vocabulary, so a new chip status cannot arrive unadmitted.
export const RunDigestChainOutcomesSchema = z.object({
  analysis: z.enum(POST_PROCESSING_CHIP_STATUSES),
  curation: z.enum(POST_PROCESSING_CHIP_STATUSES),
  outcome: z.enum(RUN_NOTIFICATION_VIEW_STATUSES).optional(),
  skipped: PostProcessingSkippedSchema.optional(),
}).strict() satisfies z.ZodType<RunDigestChainOutcomes>

export const RunDigestCandidateReportSchema = z.object({
  curated: z.number().int().nonnegative(),
  deprecated: z.number().int().nonnegative(),
}).strict() satisfies z.ZodType<RunDigestCandidateReport>

export const RunDigestQuarantineReportSchema = z.object({
  quarantined: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  refs: z.array(z.string().min(1)),
}).strict() satisfies z.ZodType<RunDigestQuarantineReport>

/**
 * The `runs.digest` result.
 *
 * `AnalysisClusterViewSchema` is IMPORTED, not restated: the digest's verdict section is the
 * analysis op's cluster view, and a second declaration of that shape here would be free to
 * agree today and drop `members` after the first change to either.
 */
export const RunDigestSchema = z.object({
  runId: z.string(),
  verdictClusters: z.array(AnalysisClusterViewSchema),
  chain: RunDigestChainOutcomesSchema,
  markChanges: z.array(RunDigestMarkChangeSchema).optional(),
  candidates: RunDigestCandidateReportSchema,
  quarantine: RunDigestQuarantineReportSchema,
  lines: z.array(z.string()),
}).strict() satisfies z.ZodType<RunDigest>
