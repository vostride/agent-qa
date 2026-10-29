import { z } from 'zod'

import { createVersionGuard } from '../versioning/create-version-guard'
import { PROMOTION_PATHS } from './promotion-path'

export const RECORD_CHANGE_SCHEMA_VERSION = 2
export const INSPECT_RECORD_VIEW_SCHEMA_VERSION = 2

const knowledgeRecordKindSchema = z.enum([
  'fact',
  'procedure',
  'caution',
  'unknown',
  'policy',
])

const bundleStatusSchema = z.enum([
  'active',
  'candidate',
  'superseded',
  'deprecated',
])

/** Closed structural filter for deterministic maintenance inspection. */
export const InspectFilterSchema = z.object({
  product: z.string().optional(),
  scope: z.string().optional(),
  kind: knowledgeRecordKindSchema.optional(),
  status: bundleStatusSchema.optional(),
  anchor: z.string().optional(),
  recordId: z.string().optional(),
  asOfBuild: z.number().int().nonnegative().optional(),
  unresolvedOnly: z.boolean().optional(),
}).strict()

export type InspectFilter = z.infer<typeof InspectFilterSchema>

/** Stable machine-readable view of one record derived from committed bundle truth. */
export const InspectRecordViewSchema = z.object({
  schemaVersion: z.literal(INSPECT_RECORD_VIEW_SCHEMA_VERSION),
  recordId: z.string(),
  product: z.string(),
  scope: z.string(),
  kind: knowledgeRecordKindSchema,
  status: bundleStatusSchema,
  confirmations: z.number().int().nonnegative(),
  contradictions: z.number().int().nonnegative(),
  evidenceTokens: z.array(z.string()),
  lastEventOrdinal: z.number().int().nonnegative(),
  openedAtOrdinal: z.number().int().nonnegative(),
  closedAtOrdinal: z.number().int().nonnegative().optional(),
  anchors: z.array(z.string()),
  /** LLM-authored prose remains separate from code-computed evidence and counts. */
  trustNarrative: z.string().nullable().optional(),
}).strict()

export type InspectRecordView = z.infer<typeof InspectRecordViewSchema>

const guardInspectRecordViewVersion = createVersionGuard<InspectRecordView>({
  name: 'InspectRecordView',
  current: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  migrations: {},
})

export function guardInspectRecordView(value: unknown): InspectRecordView {
  return InspectRecordViewSchema.parse(guardInspectRecordViewVersion(value))
}

export const RecordChangeSchema = z.object({
  schemaVersion: z.literal(RECORD_CHANGE_SCHEMA_VERSION),
  recordId: z.string(),
  change: z.enum([
    'added',
    'confirmed',
    'superseded',
    'deprecated',
    'promoted',
    'purged',
  ]),
  atOrdinal: z.number().int().nonnegative(),
  evidenceToken: z.string().optional(),
  byRecordId: z.string().optional(),
  /**
   * present only when change === 'promoted' and the bundle's gate part
   * names a strongest path; numbers and digests are COPIED from the receipt line,
   * never derived at render.
   */
  promotionPath: z.enum(PROMOTION_PATHS).optional(),
  promotionReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The run whose curation produced this change.
   *
   * ADDITIVE AND OPTIONAL, and `RECORD_CHANGE_SCHEMA_VERSION` deliberately does NOT move: every
   * change ever written stays valid, and a reader that ignores the field reads exactly what it
   * read before. Stamped by the reader entry's `diffSince` from the bundle's own
   * `provenance.runId` (`mode: 'run-linked'`) for commit and promotion events.
   *
   * WHY A FIELD AND NOT A JOIN ON `curationJobId`. There is no single "this run's curation job
   * id" to join on: commit stamps `curationJobId = candidateId`, promotion stamps
   * `promote:<candidateId>`, and a canary outcome stamps a sha-derived observation id — none of
   * which a `RecordChange` carries and none of which is the run. Absent when attribution is not
   * derivable, because a change attributed to the wrong run is worse than one attributed to no
   * run: a person reading "this run deprecated that fact" acts on it.
   */
  sourceRunId: z.string().min(1).optional(),
  /**
   * The attributed observation this change came from, when it came from one.
   *
   * The second half of the run link, and a DIFFERENT axis from `sourceRunId` rather than a
   * fallback for it. Canary outcomes are attributed by an observation id recomputed from the
   * run's served-canary tuples — `canaryOutcomeObservationId({ candidateId, runId, testId,
   * testIndex, stepIndex })` — so a consumer matches those changes by observation id while
   * matching commit/promotion changes by run id. Absent for a change no observation produced.
   */
  observationId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.change === 'promoted') return
  for (const field of ['promotionPath', 'promotionReceiptDigest'] as const) {
    if (value[field] !== undefined) {
      ctx.addIssue({
        code: 'custom', path: [field],
        message: 'only a promoted change carries promotion receipt attribution (419 D-19)',
      })
    }
  }
})

export type RecordChange = z.infer<typeof RecordChangeSchema>

const guardRecordChangeVersion = createVersionGuard<RecordChange>({
  name: 'RecordChange',
  current: RECORD_CHANGE_SCHEMA_VERSION,
  migrations: {},
})

export function guardRecordChange(value: unknown): RecordChange {
  return RecordChangeSchema.parse(guardRecordChangeVersion(value))
}
