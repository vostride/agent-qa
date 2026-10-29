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

/**
 * One authored outcome may carry multiple deltas: a procedure-extraction job can yield
 * whole-flow AND sub-flow candidates from one trajectory. Fact/caution authoring produces a
 * one-element array. The array is never empty.
 */
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

/**
 * Caller-owned disposition authority. Phase 379 may extend this profile with its deterministic
 * born-active drift-supersede carve-out without changing the author or checkpoint contracts.
 */
export interface DispositionProfile {
  mode: 'drain-to-active' | 'propose-only'
}

/**
 * Resolve automatic curation authority from the run's already-captured execution context.
 * Local work applies directly; CI and cloud stay proposed for the rolling-PR flow.
 */
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
    /** Transient CUR-02 signal consumed when commit renders run-linked provenance. */
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
    // 381-47 additive-optional: an absent member still parses (pre-stamp checkpoints).
    fallbackReason: z
      .enum(['malformed', 'no-model', 'token-budget', 'model-error'])
      .optional(),
  })
  .strict()

const envelopeShape = {
  // Projected from the schema package's registry rather than re-listed here. A hand-written
  // member list is the class of defect this phase keeps closing: it is a second vocabulary that
  // has to be kept in step with the first, and nothing makes it.
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

/**
 * The SHARED structural boundary for a checkpoint. Neighbor membership and CAS freshness are
 * deliberately disposition checks, so this schema validates structure without applying them.
 * the checkpoint carries the authored outcome's FULL delta array — one durable authoring
 * checkpoint per job, disposed delta-by-delta through the commit boundary.
 *
 * Deliberately origin-WIDE, and that is not an oversight — see
 * `AUTHORED_CHECKPOINT_ORIGIN_ADMISSION` below. `AuthoredCheckpoint`'s inferred delta type is
 * the type every in-process checkpoint carries, including the user-origin deltas the review
 * verbs commit and the system-origin deltas rollback and the canary commit. Origin admission is
 * a property of the DRAIN's parse boundary, not of the checkpoint shape.
 */
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

/**
 * Which origins may cross the DRAIN's authored-checkpoint boundary.
 *
 * MECHANISM, stated so the claim can be reded rather than believed: totality is the `satisfies`
 * clause — a fifth member of `DeltaOrigin` is a compile error AT THIS TABLE — and each member's
 * behaviour is pinned by the DELTA_ORIGINS walk in `__tests__/author-contract.test.ts`, whose
 * expectations are declared independently of this literal. Dropping a member fails `tsc`;
 * flipping a member's value reds a named row.
 *
 * CONSEQUENCE the table exists for: `parseAuthoredCheckpoint` is the drain's only reader of the
 * durable `authored` job-state slot (drain.ts:992, crash recovery). Before this table, a
 * persisted checkpoint claiming `origin: 'user'` parsed, re-entered `commitCurationDelta`, and
 * on a broken citation threw `UserDeltaCitationIntegrityError` — which the drain records as a
 * COMMIT failure and requeues durably, so every subsequent drain retried the same deterministic
 * refusal and stopped the pass. A rejected origin is now a ZodError at parse, which drain.ts
 * :993-1003 routes to `quarantineMalformedClaim`: typed, terminal, once.
 *
 * PRODUCER ENUMERATION that decides the members — the slot's writers, not just the author:
 *
 *   - drain.ts:593 `persistCheckpoint` → `persistAuthoredCheckpoint` (queue/job-state.ts:218),
 *     carrying `checkpointFromAuthored` (drain.ts:537) over the INJECTED `options.author` seam.
 *     The two production authors are cli `curator-author.ts` and `curator/fallback.ts`, and both
 *     hard-code `agent`. This is the writer drain.ts:992 re-reads.
 *   - drain.ts:682 `preserveAuthoredCheckpointAndRequeue` re-persists that same parsed value.
 *   - commit.ts:1065 / :1183 write the slot with the origin of whatever delta is being
 *     committed, which for knowledge-port callers is `user` (the review verbs) or `system` (the
 *     canary Confirm). Those candidates are never queued and never claimed — 387-17's write-free
 *     `bridgeDelta` materializes no claimed candidate, and `reconcileOnDrainStart`'s
 *     `requeueCandidate` returns early unless a claimed or queued candidate directory exists —
 *     so the drain cannot reach their job state. A candidateId collision cannot bridge the gap
 *     either: `candidateContentAddress` hashes `sourceRunId: 'knowledge-port'` and an
 *     `attributingObservationId` derived from the delta's own canonical hash.
 *   - journal/reconcile.ts:173 carries an existing value forward on requeue; it mints no origin.
 *
 * Admitted set: exactly `{ agent }`. `user` is rejected because that is the retry-forever
 * closure. `import` and `system` are rejected because NO producer can put them here — admitting
 * an origin on the grounds that it exists somewhere in the vocabulary is how the widened enum
 * this table replaces came to admit `user` in the first place.
 *
 * NOT the same question as `AUTONOMOUS_DEPRECATE_BY_ORIGIN` in disposition.ts, which asks who
 * may tombstone standing knowledge. `system` is allowed there and rejected here without
 * contradiction: rollback's `maintenanceCheckpoint` and knowledge-store's `bridgeDelta` build
 * plain in-process checkpoints and never parse at this boundary. The two tables are in fact
 * mutually load-bearing — the floor can afford to let a `user` Deprecate through precisely
 * because this boundary guarantees the model cannot mint one.
 */
export const AUTHORED_CHECKPOINT_ORIGIN_ADMISSION = {
  agent: 'admitted',
  import: 'rejected',
  system: 'rejected',
  user: 'rejected',
} as const satisfies Record<DeltaOrigin, 'admitted' | 'rejected'>

/**
 * Structure PLUS drain origin admission. Applied per delta and at every array position: a check
 * written against `deltas[0]` would be the same one-member-of-a-set defect at the array axis,
 * and a widened checkpoint carries the job's full delta array.
 */
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

/**
 * The per-delta commit unit sliced from a widened checkpoint. `commitCurationDelta` remains
 * the ONE serialized mutation boundary and disposes exactly one delta per call; the drain
 * slices the checkpoint and disposes each delta independently.
 */
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
