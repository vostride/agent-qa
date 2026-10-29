// The per-run digest — a READ-TIME projection, never a record.
//
// Minted here, beside `run-notification.ts`, and deliberately NOT inside it. The notification
// row is the chain's one DURABLE artifact: counts-only, exact-key-guarded, read by chat and by
// the dashboard, and frozen. The digest is what a HUMAN is shown once per run — the
// sentences, the chain, the decisions waiting on them — composed live from four already-shipped
// read paths every time somebody asks. Widening the row to carry any of that would have made
// one payload answer two questions, and `guardRunNotification`'s sorted-key comparison would
// hard-fail every reader on the first field. So the two shapes sit side by side in one
// directory, and this one has no `schemaVersion`: nothing persists a digest, so there is no
// build boundary for a version stamp to describe. A stamp here would be an invitation to store
// one, which is precisely the second representation D-16 refuses.
//
// EXACTLY ONE DIGEST PER RUN IS STRUCTURAL, not a rule anyone enforces. The projection is keyed
// by `runId`; a projection keyed by a run cannot fire per event, which is PROP-04's whole
// complaint ("an approval UX that fires 40 times per nightly run is a worse product than one
// that fires once") answered by a shape rather than by a throttle.
//
// REFS AND COUNTS ONLY. Nothing on this DTO carries evidence bytes, receipt
// bytes, rationale prose or masked content: a mark change is its mark id, its fix and the ids or
// workspace path it changed; candidates and quarantine are counts plus identity refs. 2026-09-30,
// the digest reads applied mark changes from this run's own ledger and never
// reads a proposal store. That is a privacy boundary rather than a size budget — this
// value is rendered directly by a terminal, a chat and a dashboard, and a payload that COULD
// carry a secret would need a masking boundary at each of them.

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

/**
 * One fix a mark on this run applied, read from the run's own mark ledger.
 *
 * The receipt's applied change VERBATIM: record ids for a knowledge fix, the written workspace path
 * and its byte digest for a test edit. In ledger order; a later mark on the same address does not
 * remove an earlier change, because the earlier fix was never retracted.
 */
export interface RunDigestMarkChange {
  markId: string
  ordinal: number
  fix: MarkFixKind
  change: MarkAppliedChange
}

/**
 * The chain's per-stage outcomes, in the ONE chip vocabulary (388 D-14/C13; narrowed to two —
 * Phase 404, D-01, 2026-08-26).
 *
 * The two chips are the `runs.postprocessing` values verbatim — not a synonym, not a
 * control-flow word — because two spellings of four words is the state in which the CLI and
 * the dashboard disagree about a row neither of them got wrong.
 *
 * `outcome` is present exactly once the chain wrote its terminal row, and it is a fact about
 * the CHAIN rather than about the run (the row's own note): a failed run whose analysis and
 * curation both succeeded reads `complete` (444 D-36: the served view's word, not the stored one).
 */
export interface RunDigestChainOutcomes {
  analysis: PostProcessingChipStatus
  curation: PostProcessingChipStatus
  outcome?: RunNotificationViewStatus
  /**
   * The `runs.postprocessing` skipped fact verbatim, so a machine reader of the
   * digest never re-derives from `pending` chips what the read op already knows. A sibling of
   * the two chip arms rather than a fifth word on either of them.
   */
  skipped?: { reason: PostProcessingSkipReason }
}

/**
 * Curator candidates staged this run, as COUNTS.
 *
 * The digest REPORTS; the KREV verbs review. Candidates stay candidate-status truth inside
 * bundles and are never listed as proposals, so nothing here addresses one for a decision.
 *
 * NO REFS, and the absence is measured rather than an omission: the only run-scoped, durable
 * record of what a run curated is the chain-terminal notification row, which is counts-only BY
 * CONSTRUCTION and may not be widened. A ref list would therefore
 * have had to come from somewhere else — a new port over the run directory's curation receipt —
 * and inventing one so a field could be populated is a larger change than the field is worth.
 * Stated here so a later reader does not read the gap as a bug.
 */
export interface RunDigestCandidateReport {
  curated: number
  deprecated: number
}

/**
 * Quarantine as counts + identity refs.
 *
 * STATE, NOT TRANSITIONS, and the difference is a fact about the ledger rather than a shortcut.
 * A quarantine entry records the test's three identity legs, its window and its history; it
 * carries NO run attribution, because auto-quarantine is code-authored operational state keyed
 * by a failure fingerprint and not by whoever happened to be running (390 C15). So there is no
 * honest way to compute "transitions caused by this run" from what is committed, and a number
 * presented as one would be a fabrication. What the digest can say truthfully is what the
 * ledger holds when the digest is read, which is also what a person acts on.
 *
 * `refs` are `product/filePath::testName` — the durable identity legs, never `testId`, which is
 * per-run and would address nothing tomorrow.
 */
export interface RunDigestQuarantineReport {
  quarantined: number
  expired: number
  refs: string[]
}

/**
 * The whole digest: structured sections, plus the bytes a surface prints.
 *
 * `lines` exists so that no surface composes a sentence. The tail, the CLI verb, 392's chat and
 * M5 all print these strings; the structured sections are for a surface that wants to lay the
 * same facts out differently (a dashboard card, a chat block) without re-deriving any of them.
 * Carrying both is what keeps "one renderer" true for the terminal without making every other
 * surface parse strings.
 *
 * `verdictClusters` are the `analysis.get` cluster views VERBATIM — the same value, the same
 * type, the same already-composed representative sentence. The digest re-renders nothing: 389
 * D-05/D-10 put one renderer and one accessor behind that op, and a second composition here
 * would be exactly the drift those decisions exist to prevent.
 */
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
  // 2026-10-03 (quick 261003-cpv, 432 review IN-21): the same pairing `MarkDispositionSchema`'s
  // applied arm enforces on the ledger these rows are projected from. The digest is computed per
  // call and not stored, so no stored row is read through this.
  if ((value.fix === 'test-edit') !== (value.change.kind === 'test-file')) {
    ctx.addIssue({
      code: 'custom',
      path: ['change', 'kind'],
      message: 'a test edit writes a test file and every other fix changes knowledge',
    })
  }
}) satisfies z.ZodType<RunDigestMarkChange>

/**
 * The chip enums are CONSTRUCTED from the exported vocabulary rather than respelled (C13), so a
 * fifth chip status cannot arrive with this contract still admitting four.
 */
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
