// The inspect and diff outputs reuse the reader's view schemas verbatim, so they cannot drift.

import { z } from 'zod'

import { ServedRetrievalTraceV1Schema } from '../brief/retrieval-trace'
import type { ServedBrief } from '../brief/served-brief'
import { ImprovementPlanKnowledgeSchema } from '../functions/feedback'
import { InspectFilterSchema, InspectRecordViewSchema, RecordChangeSchema } from './maintenance-views'
import { BundleProvenanceSchema } from './bundle-files'
import { KnowledgeTargetRefSchema, MarkChangeStampSchema } from './change'

/**
 * WHY a why-question has no answer. Closed, and each member names a genuinely different
 * situation a surface has to phrase differently:
 *
 *   `pre-trace-run`   — the run predates trace capture. Nothing was lost; nothing was ever
 *                       written. This is permanent and no amount of retrying changes it.
 *   `artifact-missing`— the run captured a trace and the artifact is gone (pruned, moved).
 *   `step-not-found`  — the run and its trace exist; the step being asked about does not.
 *
 * A bare "no trace" would have collapsed all three, and the only message a surface could
 * then print is one that tells the reader nothing about whether to go looking.
 */
export const BRIEF_WHY_NO_TRACE_REASONS = [
  'pre-trace-run',
  'artifact-missing',
  'step-not-found',
] as const

export type BriefWhyNoTraceReason = (typeof BRIEF_WHY_NO_TRACE_REASONS)[number]

// No re-run arm: re-running retrieval answers about today's index, not the brief that was served.
export const BRIEF_WHY_RESULT_KINDS = ['answered', 'no-trace'] as const

export type BriefWhyResultKind = (typeof BRIEF_WHY_RESULT_KINDS)[number]

// Structural, not `z.custom`, because a custom type cannot be projected to JSON Schema.
const ServedBriefOfferingSchema = z.looseObject({
  channel1: z.array(z.unknown()),
  channel2: z.array(z.unknown()),
  channel3: z.array(z.unknown()),
  briefDigest: z.string(),
}) as unknown as z.ZodType<ServedBrief>

// The arms are incompatible on purpose: a trace on the absence arm is refused.
export const BriefWhyResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('answered'),
    trace: ServedRetrievalTraceV1Schema,
    /** Where the brief this trace explains lives, when the caller wants to read it too. */
    servedBriefRef: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('no-trace'),
    reason: z.enum(BRIEF_WHY_NO_TRACE_REASONS),
    /** Offered when the brief survived even though its trace did not. */
    servedBrief: ServedBriefOfferingSchema.optional(),
  }).strict(),
])

export type BriefWhyResult = z.infer<typeof BriefWhyResultSchema>

// `stepIndex` is per test, so a run with two tests needs `testId`; an ambiguous address is refused.
export const BriefWhyInputSchema = z.object({
  runId: z.string().min(1),
  testId: z.string().min(1).optional(),
  stepIndex: z.number().int().nonnegative(),
  recordId: z.string().min(1).optional(),
}).strict()

export type BriefWhyInput = z.infer<typeof BriefWhyInputSchema>

export const KnowledgeMarkInputSchema = z.object({
  target: KnowledgeTargetRefSchema,
  mark: MarkChangeStampSchema,
  plan: ImprovementPlanKnowledgeSchema,
}).strict()
export type KnowledgeMarkInput = z.infer<typeof KnowledgeMarkInputSchema>

/** `inspectRecords`' structural filter, unchanged — the verb is a client, not a rewrite. */
export const KnowledgeRecordsInspectInputSchema = z.object({
  filter: InspectFilterSchema,
}).strict()

export type KnowledgeRecordsInspectInput = z.infer<typeof KnowledgeRecordsInspectInputSchema>

export const KnowledgeRecordsInspectOutputSchema = z.object({
  schemaVersion: z.literal(2),
  records: z.array(InspectRecordViewSchema),
}).strict()

export type KnowledgeRecordsInspectOutput = z.infer<typeof KnowledgeRecordsInspectOutputSchema>

export const KnowledgeRecordsDiffInputSchema = z.object({
  sinceOrdinal: z.number().int().nonnegative(),
}).strict()

export type KnowledgeRecordsDiffInput = z.infer<typeof KnowledgeRecordsDiffInputSchema>

/**
 * The diff echoes the ordinal it was taken since. A change list with no baseline is a list
 * whose meaning depends on remembering the question, and these answers get pasted into
 * issues and CI logs where that context is gone.
 */
export const KnowledgeRecordsDiffOutputSchema = z.object({
  schemaVersion: z.literal(2),
  sinceOrdinal: z.number().int().nonnegative(),
  changes: z.array(RecordChangeSchema),
}).strict()

export type KnowledgeRecordsDiffOutput = z.infer<typeof KnowledgeRecordsDiffOutputSchema>

export const KnowledgeRecordShowInputSchema = z.object({
  recordId: z.string().min(1),
}).strict()

export type KnowledgeRecordShowInput = z.infer<typeof KnowledgeRecordShowInputSchema>

/**
 * One record with the provenance that justifies it — the whole point of the verb. A record
 * shown without its provenance is an assertion; shown with it, it is evidence.
 */
export const KnowledgeRecordShowOutputSchema = z.object({
  schemaVersion: z.literal(2),
  record: InspectRecordViewSchema,
  provenance: BundleProvenanceSchema,
  summary: z.string(),
  body: z.string(),
}).strict()

export type KnowledgeRecordShowOutput = z.infer<typeof KnowledgeRecordShowOutputSchema>

// A missing record is an ordinary answer, not a throw, so it stays apart from an unreadable store.
export const KnowledgeRecordShowResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    ...KnowledgeRecordShowOutputSchema.shape,
  }).strict(),
  z.object({
    kind: z.literal('not-found'),
    schemaVersion: z.literal(2),
    /** Echoed so an answer pasted into an issue still says what was asked about. */
    recordId: z.string().min(1),
  }).strict(),
])

export type KnowledgeRecordShowResult = z.infer<typeof KnowledgeRecordShowResultSchema>
