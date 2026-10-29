import {
  DELTA_ORIGINS,
  asEvidenceToken,
  asRecordId,
  type Anchor,
  type ArtifactRef,
  type BundleDraft,
  type BundleKind,
  type CompareAndSet,
  type CurationAuthorship,
  type CurationFallbackReason,
  type Delta,
  type DeltaOrigin,
  type ExecutionContext,
  type FactSubtype,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { z } from 'zod'

import type { CurationCandidatePayload } from '../queue/queue-payload.js'

export const AUTHORED_CHECKPOINT_SCHEMA_VERSION = 2

/** The deterministic author-facing projection of one durable queue payload. */
export type CurationJobView = Pick<
  CurationCandidatePayload,
  | 'candidateId'
  | 'kind'
  | 'subtype'
  | 'rootCauseClass'
  | 'anchors'
  | 'summarySeed'
  | 'bodySeed'
  | 'distilledObservations'
  | 'scope'
  | 'buildOrdinal'
  | 'attributingObservationId'
  | 'executionContext'
>

/** One retrieval hit as shown to the author through a small integer alias. */
interface NeighborRecordBase {
  alias: number
  recordId: RecordId
  summary: string
  anchors: Anchor[]
  observedStatus: string
  observedOrdinal: number
}

type NonFactNeighborRecord = {
  [Kind in Exclude<BundleKind, 'fact'>]: { kind: Kind; subtype?: never }
}[Exclude<BundleKind, 'fact'>]

export type NeighborRecord = NeighborRecordBase &
  ({ kind: 'fact'; subtype: FactSubtype } | NonFactNeighborRecord)

// A procedure job may yield several deltas; fact and caution authoring yield one. Never empty.
export type AuthorOutcome =
  | { kind: 'authored'; deltas: Delta[]; authorship: CurationAuthorship }
  | {
      kind: 'fallback-required'
      reason: CurationFallbackReason
    }

/** Provider-neutral author seam injected by the CLI composition root. */
export type CuratorAuthor = (
  job: CurationJobView,
  neighbors: NeighborRecord[],
) => Promise<AuthorOutcome>

export interface DispositionProfile {
  mode: 'drain-to-active' | 'propose-only'
}

// Local work applies directly; CI and cloud stay proposed for the rolling-PR flow.
export function resolveDispositionProfile(
  executionContext: ExecutionContext,
): DispositionProfile {
  switch (executionContext) {
    case 'local-interactive':
    case 'local-headless':
      return { mode: 'drain-to-active' }
    case 'ci':
    case 'cloud':
      return { mode: 'propose-only' }
    default: {
      const exhaustive: never = executionContext
      return exhaustive
    }
  }
}

const recordIdSchema = z.string().min(1).transform(asRecordId)
const evidenceTokenSchema = z.string().min(1).transform(asEvidenceToken)

const scopeSchema: z.ZodType<ScopeKey> = z
  .object({
    tier: z.enum(['global', 'product', 'suite', 'test']),
    key: z.string().min(1),
  })
  .strict()

const anchorSchema: z.ZodType<Anchor> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('page'), route: z.string() }).strict(),
  z.object({ t: z.literal('flow'), name: z.string() }).strict(),
  z
    .object({
      t: z.literal('el'),
      role: z.string(),
      name: z.string(),
      ordinal: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('platform'),
      platform: z.enum(['web', 'android', 'ios']),
    })
    .strict(),
  z.object({ t: z.literal('selector'), literal: z.string() }).strict(),
  z.object({ t: z.literal('error'), message: z.string() }).strict(),
])

const artifactRefSchema: z.ZodType<ArtifactRef> = z
  .object({
    id: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceIncomplete: z.boolean().optional(),
  })
  .strict()

const bundleKindSchema: z.ZodType<BundleKind> = z.enum([
  'fact',
  'procedure',
  'caution',
  'unknown',
  'policy',
])
const factSubtypeSchema: z.ZodType<FactSubtype> = z.enum([
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
])

type CheckpointBundleDraft = BundleDraft & { needsEnrichment?: true }

const bundleDraftSchema: z.ZodType<CheckpointBundleDraft> = z
  .object({
    kind: bundleKindSchema,
    subtype: factSubtypeSchema.optional(),
    anchors: z.array(anchorSchema).min(1),
    scope: scopeSchema,
    summary: z.string(),
    body: z.string(),
    distilledEvidenceRef: artifactRefSchema,
    originStage: z.literal('run-curation'),
    // Transient signal consumed when commit renders run-linked provenance.
    needsEnrichment: z.literal(true).optional(),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.kind === 'fact' && bundle.subtype === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subtype'],
        message: 'fact bundle drafts require a fact subtype',
      })
    }
    if (bundle.kind !== 'fact' && bundle.subtype !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subtype'],
        message: 'only fact bundle drafts may carry a fact subtype',
      })
    }
  })

const compareAndSetSchema: z.ZodType<CompareAndSet> = z
  .object({
    recordId: recordIdSchema,
    observedStatus: z.string(),
    observedOrdinal: z.number(),
  })
  .strict()

const curationAuthorshipSchema: z.ZodType<CurationAuthorship> = z
  .object({
    path: z.enum(['llm', 'llm-repaired', 'deterministic-fallback']),
    model: z
      .object({
        id: z.string().min(1),
        family: z.string().optional(),
        fingerprint: z.string().optional(),
      })
      .strict()
      .optional(),
    executionContext: z.enum(['local-interactive', 'local-headless', 'ci', 'cloud']),
    // Optional, so a checkpoint written before the stamp still parses.
    fallbackReason: z
      .enum(['malformed', 'no-model', 'token-budget', 'model-error'])
      .optional(),
  })
  .strict()

const envelopeShape = {
  // Projected from the schema registry, so no second vocabulary has to be kept in step.
  origin: z.enum(DELTA_ORIGINS),
  scope: scopeSchema,
  citedIds: z.array(recordIdSchema),
  precondition: z.array(compareAndSetSchema).optional(),
  authorship: curationAuthorshipSchema.optional(),
} as const

const deltaSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('Add'),
      ...envelopeShape,
      bundle: bundleDraftSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('Confirm'),
      ...envelopeShape,
      targetId: recordIdSchema,
      evidenceToken: evidenceTokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('Supersede'),
      ...envelopeShape,
      victimId: recordIdSchema,
      newBundle: bundleDraftSchema,
      evidenceToken: evidenceTokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('Deprecate'),
      ...envelopeShape,
      targetId: recordIdSchema,
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('MintUnknown'),
      ...envelopeShape,
      conflict: z
        .object({
          recordIds: z.array(recordIdSchema),
          kind: z.enum(['contradiction', 'drift', 'clarification']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('Noop'),
      ...envelopeShape,
    })
    .strict(),
]) satisfies z.ZodType<Delta>

// Origin-wide on purpose: origin admission belongs to the drain's parse, not the checkpoint shape.
export const authoredCheckpointSchema = z
  .object({
    schemaVersion: z.literal(AUTHORED_CHECKPOINT_SCHEMA_VERSION),
    deltas: z.array(deltaSchema).min(1),
    neighborIds: z.array(recordIdSchema),
    preconditions: z.array(compareAndSetSchema),
    authorship: curationAuthorshipSchema,
  })
  .strict()

export type AuthoredCheckpoint = z.infer<typeof authoredCheckpointSchema>

// Only `agent` crosses: a persisted `user` checkpoint would retry a refusal on every drain.
export const AUTHORED_CHECKPOINT_ORIGIN_ADMISSION = {
  agent: 'admitted',
  import: 'rejected',
  system: 'rejected',
  user: 'rejected',
} as const satisfies Record<DeltaOrigin, 'admitted' | 'rejected'>

// Checked per delta at every array position: a checkpoint carries the job's whole delta array.
const drainAuthoredCheckpointSchema = authoredCheckpointSchema.superRefine((checkpoint, ctx) => {
  checkpoint.deltas.forEach((delta, index) => {
    if (AUTHORED_CHECKPOINT_ORIGIN_ADMISSION[delta.origin] === 'admitted') return
    ctx.addIssue({
      code: 'custom',
      path: ['deltas', index, 'origin'],
      message:
        `origin '${delta.origin}' is not admitted at the drain's authored-checkpoint boundary: `
        + 'the drain authors deltas on the agent\'s behalf, and no producer can place another '
        + 'origin in this slot',
    })
  })
})

/**
 * Parse authored bytes at the drain's boundary — both when wrapping fresh author output
 * (drain.ts:537) and when replaying crash-recovered state (drain.ts:992).
 *
 * BOTH sites, deliberately. Guarding only the recovery read would leave the injected author seam
 * able to put a non-agent origin into the durable slot in the first place, which is the same
 * defect one step upstream: a delta the store attributes to a person, authored by a model, that
 * the autonomy floor would then let tombstone standing knowledge.
 */
export function parseAuthoredCheckpoint(value: unknown): AuthoredCheckpoint {
  return drainAuthoredCheckpointSchema.parse(value)
}

// `commitCurationDelta` disposes exactly one delta per call; the drain slices the checkpoint.
export interface AuthoredDeltaCheckpoint {
  schemaVersion: typeof AUTHORED_CHECKPOINT_SCHEMA_VERSION
  delta: AuthoredCheckpoint['deltas'][number]
  neighborIds: AuthoredCheckpoint['neighborIds']
  preconditions: AuthoredCheckpoint['preconditions']
  authorship: AuthoredCheckpoint['authorship']
}

/** Slice one widened checkpoint into its ordered per-delta commit units. */
export function sliceAuthoredCheckpoint(
  checkpoint: AuthoredCheckpoint,
): AuthoredDeltaCheckpoint[] {
  return checkpoint.deltas.map((delta) => ({
    schemaVersion: checkpoint.schemaVersion,
    delta,
    neighborIds: checkpoint.neighborIds,
    preconditions: checkpoint.preconditions,
    authorship: checkpoint.authorship,
  }))
}

/** Re-widen one commit unit into a parseable singleton checkpoint (job-state persistence). */
export function widenAuthoredDeltaCheckpoint(
  slice: AuthoredDeltaCheckpoint,
): AuthoredCheckpoint {
  return {
    schemaVersion: slice.schemaVersion,
    deltas: [slice.delta],
    neighborIds: slice.neighborIds,
    preconditions: slice.preconditions,
    authorship: slice.authorship,
  }
}
