// `runs.overview` — one completed run as a compact address map.
//
// A MAP, NOT A DOCUMENT. Every field is either identity, a verdict, a count the run stored or the
// literal address another read op takes. Bodies, traces, evidence documents and bytes stay behind
// those addresses. Output ids are plain strings; the input keeps the branded run-id codec.
//
// Addresses, by the op that takes them:
//   runs.artifact         { runId, sha }                                      screenshots, recordings
//   runs.evidence         { runId, testIndex, stepIndex, subActionIndex?, kind }  step evidence, ARIA
//   knowledge.brief.why   { runId, testId, stepIndex }                         served brief
//   knowledge.record.show { recordId }                                         used and learned records

import { z } from 'zod'

import { BRIEF_WHY_NO_TRACE_REASONS } from '../knowledge/review-verbs'
import { RecordChangeSchema } from '../knowledge/maintenance-views'
import { CurationBreakdownSchema, CurationBucketSchema } from '../notification/curation-snapshot'
import {
  CurationSnapshotWithheldSchema,
  POST_PROCESSING_CHIP_STATUSES,
  PostProcessingSkippedSchema,
} from '../notification/post-processing-status'
import { EvidenceAbsenceReasonSchema, EvidenceKindSchema } from '../run/evidence'
import { RECORDING_CONTENT_TYPES } from '../run/recording'
import { runIdSchema } from '../run/run-id'
import { RUN_KNOWLEDGE_CONTENT_ABSENCE_REASONS } from './record-join'
import { RunDetailStepSchema, RunSummarySchema, RunTestDetailSchema } from './runs'

/** Labels and one-line summaries keep this many Unicode code points, then a visible `…`. */
export const RUN_OVERVIEW_TEXT_MAX_CODE_POINTS = 160
export const RUN_OVERVIEW_TRUNCATION_INDICATOR = '…'

export const RunsOverviewInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type RunsOverviewInput = z.infer<typeof RunsOverviewInputSchema>

const index = z.number().int().nonnegative()
const count = z.number().int().nonnegative()
/** Read-time presence of the addressed bytes. Absent means UNKNOWN, never absent bytes. */
const present = z.boolean().optional()
const incomplete = z.literal(true).optional()

export const RunOverviewTextSchema = z.object({
  text: z.string(),
  truncated: z.literal(true).optional(),
}).strict()

export const RunOverviewArtifactAddressSchema = z.object({
  runId: z.string(),
  sha: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

export const RunOverviewEvidenceAddressSchema = z.object({
  runId: z.string(),
  testIndex: index,
  stepIndex: index,
  subActionIndex: index.optional(),
  kind: EvidenceKindSchema,
}).strict()

export const RunOverviewBriefAddressSchema = z.object({
  runId: z.string(),
  testId: z.string(),
  stepIndex: index,
}).strict()

const address = RunOverviewEvidenceAddressSchema

const absentEvidence = <K extends 'console' | 'network' | 'a11y' | 'variables'>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    state: z.literal('absent'),
    reason: EvidenceAbsenceReasonSchema,
    evidenceIncomplete: incomplete,
    address,
  }).strict()

export const RunOverviewStepEvidenceSchema = z.object({
  console: z.union([
    z.object({
      kind: z.literal('console'), state: z.literal('present'),
      counts: z.object({ total: count, errors: count, warnings: count }).strict(), present, address,
    }).strict(),
    absentEvidence('console'),
  ]),
  network: z.union([
    z.object({
      kind: z.literal('network'), state: z.literal('present'),
      counts: z.object({ total: count, failed: count, errored: count }).strict(), present, address,
    }).strict(),
    absentEvidence('network'),
  ]),
  a11y: z.union([
    z.object({
      kind: z.literal('a11y'), state: z.literal('present'),
      counts: z.object({ minor: count, moderate: count, serious: count, critical: count }).strict(),
      present, address,
    }).strict(),
    absentEvidence('a11y'),
  ]),
  variables: z.union([
    z.object({
      kind: z.literal('variables'), state: z.literal('present'),
      counts: z.object({ count }).strict(), address,
    }).strict(),
    absentEvidence('variables'),
  ]),
}).strict()

/** ARIA is sub-action addressed and stores no numeric count, so none is reported. */
export const RunOverviewAriaSchema = z.union([
  z.object({ subActionIndex: index, state: z.literal('present'), present, address }).strict(),
  z.object({
    subActionIndex: index, state: z.literal('absent'), reason: EvidenceAbsenceReasonSchema,
    evidenceIncomplete: incomplete, address,
  }).strict(),
])

export const RunOverviewScreenshotSchema = z.object({
  subActionIndex: index,
  sha: z.string().regex(/^[0-9a-f]{64}$/),
  present,
  evidenceIncomplete: incomplete,
  address: RunOverviewArtifactAddressSchema,
}).strict()

/**
 * One record a step was served. `kind` and `summary` come from the served line or the current
 * record; whenever either is missing, `unavailable` names why, so nothing is inferred from an id.
 */
export const RunOverviewRecordSchema = z.object({
  recordId: z.string(),
  channel: z.enum(['brief', 'read', 'caution']),
  kind: z.string().optional(),
  summary: RunOverviewTextSchema.optional(),
  unavailable: z.object({ reason: z.enum(RUN_KNOWLEDGE_CONTENT_ABSENCE_REASONS) }).strict().optional(),
}).strict().refine(
  (record) => (record.kind === undefined || record.summary === undefined)
    === (record.unavailable !== undefined),
  { message: 'a record lacking its kind or summary must say why, and only then' },
)

export const RunOverviewBriefSchema = z.object({
  address: RunOverviewBriefAddressSchema,
  trace: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('answered') }).strict(),
    z.object({ kind: z.literal('no-trace'), reason: z.enum(BRIEF_WHY_NO_TRACE_REASONS) }).strict(),
  ]),
}).strict()

export const RunOverviewStepSchema = z.object({
  stepIndex: index,
  label: RunOverviewTextSchema.optional(),
  status: RunDetailStepSchema.shape.status,
  /** What the run-detail projection recorded; `unavailable` when this host holds no row. */
  capture: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('recorded'),
      screenshots: z.array(RunOverviewScreenshotSchema),
      evidence: RunOverviewStepEvidenceSchema,
      aria: z.array(RunOverviewAriaSchema),
    }).strict(),
    z.object({ state: z.literal('unavailable') }).strict(),
  ]),
  /** What the handoff recorded about the served brief; `unavailable` when it holds no step. */
  knowledge: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('recorded'),
      records: z.array(RunOverviewRecordSchema),
      brief: RunOverviewBriefSchema,
    }).strict(),
    z.object({ state: z.literal('unavailable') }).strict(),
  ]),
}).strict()

export const RunOverviewRecordingSchema = z.union([
  z.object({
    state: z.literal('present'),
    address: RunOverviewArtifactAddressSchema,
    contentType: z.enum(RECORDING_CONTENT_TYPES),
    byteLength: count,
    durationMs: z.number().finite().nonnegative().optional(),
    present,
    evidenceIncomplete: incomplete,
  }).strict(),
  z.object({
    state: z.literal('absent'),
    reason: EvidenceAbsenceReasonSchema,
    evidenceIncomplete: incomplete,
  }).strict(),
])

export const RunOverviewTestSchema = z.object({
  testIndex: index,
  testId: z.string(),
  name: RunOverviewTextSchema,
  outcome: RunTestDetailSchema.shape.outcome,
  recording: RunOverviewRecordingSchema,
  steps: z.array(RunOverviewStepSchema),
}).strict()

export const RunOverviewLearnedSchema = z.object({
  knowledgeStore: z.enum(['bound', 'unbound']),
  curation: z.object({
    status: z.enum(POST_PROCESSING_CHIP_STATUSES),
    counts: z.object({ curated: count, deprecated: count }).strict().optional(),
    skipped: PostProcessingSkippedSchema.optional(),
  }).strict(),
  snapshot: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('recorded'),
      breakdown: CurationBreakdownSchema,
      rows: z.array(z.object({
        recordId: z.string(),
        bucket: CurationBucketSchema,
        byRecordId: z.string().optional(),
      }).strict()),
    }).strict(),
    z.object({
      state: z.literal('withheld'),
      reason: CurationSnapshotWithheldSchema.shape.reason,
    }).strict(),
    z.object({ state: z.literal('not-recorded') }).strict(),
  ]),
  changes: z.array(z.object({
    recordId: z.string(),
    change: RecordChangeSchema.shape.change,
    atOrdinal: count,
  }).strict()),
  scanIncomplete: z.literal(true).optional(),
}).strict()

export const RunOverviewProjectionSchema = z.object({
  runId: z.string(),
  scope: RunSummarySchema.shape.scope,
  recordedTargets: RunSummarySchema.shape.recordedTargets,
  aggregateVerdict: RunSummarySchema.shape.aggregateVerdict,
  buildOrdinal: index,
  startedAt: index,
  endedAt: index,
  tests: z.array(RunOverviewTestSchema),
  learned: RunOverviewLearnedSchema,
}).strict()

export type RunOverviewText = z.infer<typeof RunOverviewTextSchema>
export type RunOverviewArtifactAddress = z.infer<typeof RunOverviewArtifactAddressSchema>
export type RunOverviewEvidenceAddress = z.infer<typeof RunOverviewEvidenceAddressSchema>
export type RunOverviewBriefAddress = z.infer<typeof RunOverviewBriefAddressSchema>
export type RunOverviewStepEvidence = z.infer<typeof RunOverviewStepEvidenceSchema>
export type RunOverviewAria = z.infer<typeof RunOverviewAriaSchema>
export type RunOverviewScreenshot = z.infer<typeof RunOverviewScreenshotSchema>
export type RunOverviewRecord = z.infer<typeof RunOverviewRecordSchema>
export type RunOverviewStep = z.infer<typeof RunOverviewStepSchema>
export type RunOverviewRecording = z.infer<typeof RunOverviewRecordingSchema>
export type RunOverviewTest = z.infer<typeof RunOverviewTestSchema>
export type RunOverviewLearned = z.infer<typeof RunOverviewLearnedSchema>
export type RunOverviewProjection = z.infer<typeof RunOverviewProjectionSchema>
