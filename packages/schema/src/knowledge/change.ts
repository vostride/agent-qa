// The direct knowledge change contracts (432-17, D-02 / D-05 / D-09; introduced by 432-12).
//
// A knowledge change applies in the call. `knowledge.accept`, `knowledge.reject` and
// `knowledge.forget` take the verb input plus an optional operation identity and answer what they
// changed: the records, a typed absence, or a typed refusal. A mark changes knowledge through
// `runs.mark` with the same review vocabulary. Nothing is filed for a second call to apply.
//
// MOVED HERE 2026-10-01. These contracts lived beside the proposal they replaced
// (`knowledge/proposal.ts`, `knowledge/review-verbs.ts`) while the proposal inbox still had readers.
// The inbox, its envelope and the knowledge proposal payload are deleted, and old proposal files are
// never parsed again, so this is the one module the direct change vocabulary lives in. The
// commit receipt moved with it from `functions/feedback.ts` (which re-exports it), because the change
// output carries it and the feedback contracts import this module's primitives: one direction only.
//
// THE CHANGE ID KEEPS ITS RECEIPT SHAPE. A change is identified by `prop_<operationId>`, and the
// forget and commit receipts carry it in their `proposalId` field. The schema that refines the id is
// named for what it identifies now.

import { z } from 'zod'

import { DELTA_KINDS } from '../delta/delta'
import { DELTA_ORIGINS } from '../delta/envelope'
import type { Delta } from '../delta/delta'
import { ENTITY_STATUSES } from '../entity/entity-card'
import { parseShortId } from '../entity/kinds'
import { BundleProvenanceSchema } from './bundle-files'
import { MARKS } from './gate-receipt'
import { PROMOTION_PATHS } from './promotion-path'

/** mark is the fourth — a user mark's fix, applied through the same writer. */
export const KNOWLEDGE_REVIEW_VERBS = ['accept', 'reject', 'forget', 'mark'] as const

export type KnowledgeReviewVerb = (typeof KNOWLEDGE_REVIEW_VERBS)[number]

/**
 * The §7.7 projections a forget must scrub. Closed, and the closure is the point: "scrub
 * every projection" is only a checkable promise if the set of projections is enumerable.
 */
export const KNOWLEDGE_PROJECTIONS = ['fts', 'vec', 'graph', 'exemplar'] as const

export type KnowledgeProjection = (typeof KNOWLEDGE_PROJECTIONS)[number]

/**
 * The id a knowledge change is recorded under, refined rather than a bare string.
 *
 * It is echoed into receipts and derived from a caller-supplied operation identity, so it is
 * attacker-reachable input. The pattern admits a hex mint and an `id-agent` word-id while refusing
 * whitespace, path separators and the empty body — the shapes that turn an identity into a path.
 */
export const KnowledgeChangeIdSchema = z
  .string()
  .min(10)
  .regex(/^prop_[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'expected a prop_-prefixed lowercase change id')

/**
 * the three knowledge changes a caller makes directly. A mark changes
 * knowledge through `runs.mark`, so it is a review verb and not one of these.
 */
export const KNOWLEDGE_CHANGE_VERBS = ['accept', 'reject', 'forget'] as const

export type KnowledgeChangeVerb = (typeof KNOWLEDGE_CHANGE_VERBS)[number]

/**
 * A caller's stable identity for one knowledge change. Repeating it repeats the change,
 * which lands once. Letters, digits and single hyphens, so a UUID fits and the change id derived
 * from it keeps the receipt id shape.
 */
export const KnowledgeChangeOperationIdSchema = z
  .string()
  .min(5)
  .max(64)
  .regex(
    /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u,
    'expected letters, digits and single hyphens, such as a UUID',
  )

/**
 * WHAT a change is about, at either of the two grains D-19 pins: one record, or the `MEM-`
 * addressed bundle that contains records.
 *
 * The bundle arm refuses a well-formed short-ID of any other kind. `TST-001` parses and resolves to
 * a real entity — it is simply not a thing a knowledge change applies to, and a ref that reached
 * the store before anyone noticed would address by coincidence.
 */
export const KnowledgeTargetRefSchema = z.discriminatedUnion('grain', [
  z.object({
    grain: z.literal('record'),
    recordId: z.string().min(1),
  }).strict(),
  z.object({
    grain: z.literal('bundle'),
    shortId: z.string().refine(
      (value) => parseShortId(value)?.kind === 'MEM',
      'expected a MEM- short-ID addressing a knowledge bundle',
    ),
  }).strict(),
])

export type KnowledgeTargetRef = z.infer<typeof KnowledgeTargetRefSchema>

/** {@link KnowledgeTargetRefSchema} under the name D-19 gives it. Deliberately the same value. */
export const ForgetTargetRefSchema = KnowledgeTargetRefSchema

export type ForgetTargetRef = KnowledgeTargetRef

/**
 * Validates a change's deltas at ENVELOPE depth — the discriminant plus the three fields every arm
 * of the union carries — and no deeper.
 *
 * `Delta` is a type-only union, so a full arm-by-arm schema here would be a SECOND declaration of
 * the write vocabulary, free to drift from the one `commit()` actually applies. Arm interiors are
 * validated where they are applied; what this boundary owes is that an unrecognised kind or a delta
 * with no attributable origin never reaches that point looking well-formed.
 *
 * STRUCTURAL, not `z.custom`: a predicate is unprojectable, and the function layer projects
 * every declared contract into an inert JSON Schema document for its listing.
 */
export const DeltaSchema = z.looseObject({
  kind: z.enum(DELTA_KINDS),
  origin: z.enum(DELTA_ORIGINS),
  scope: z.looseObject({ tier: z.string(), key: z.string() }),
  citedIds: z.array(z.string()),
}) as unknown as z.ZodType<Delta>

/** One record a forget tombstones, with the provenance that survives it. */
export const TombstonedRecordSchema = z.object({
  recordId: z.string().min(1),
  provenance: BundleProvenanceSchema,
}).strict()

export type TombstonedRecord = z.infer<typeof TombstonedRecordSchema>

const scrubSetSchema = z
  .array(z.enum(KNOWLEDGE_PROJECTIONS))
  .refine(
    (members) => new Set(members).size === members.length,
    'projectionsScrubbed is a SUBSET of the scrub set, not a log of attempts',
  )

export const FORGET_RECEIPT_SCHEMA_VERSION = 2

/**
 * What a forget DID: the value the change returns, and the content the forgotten entity's address
 * resolves to afterwards. Every tombstoned record is enumerated with its provenance,
 * because a receipt that listed only what it happened to find is a receipt nobody can act on.
 *
 * `proposalId` carries the change id; the field name is the persisted receipt's (see the header).
 */
export const ForgetReceiptV1Schema = z.object({
  schemaVersion: z.literal(FORGET_RECEIPT_SCHEMA_VERSION),
  proposalId: KnowledgeChangeIdSchema,
  tombstonedRecords: z.array(TombstonedRecordSchema),
  projectionsScrubbed: scrubSetSchema,
  resultingBundleStatus: z.enum(ENTITY_STATUSES.MEM),
  forgottenAt: z.number().int().nonnegative(),
}).strict()

export type ForgetReceiptV1 = z.infer<typeof ForgetReceiptV1Schema>

/** The stamp binding a mark's knowledge fix to the mark that made it. */
export const MarkChangeStampSchema = z.object({
  markId: z.string().regex(/^mark_[0-9a-f]{12}$/),
  runId: z.string().min(1),
  testIndex: z.number().int().nonnegative(),
  stepIndex: z.number().int().nonnegative().optional(),
  kind: z.enum(MARKS),
  fix: z.enum(['fact', 'caution', 'procedure-hint']),
}).strict()

export type MarkChangeStamp = z.infer<typeof MarkChangeStampSchema>

export const COMMIT_RECEIPT_SCHEMA_VERSION = 2

const ordinalSchema = z.number().int().nonnegative()

/**
 * What a change that crossed a promotion gate, or wrote a policy record, committed.
 * `proposalId` carries the change id; the field name is the persisted receipt's (see the header).
 */
export const CommitReceiptSchema = z.object({
  schemaVersion: z.literal(COMMIT_RECEIPT_SCHEMA_VERSION),
  proposalId: KnowledgeChangeIdSchema,
  markId: z.string().optional(),
  committedAtOrdinal: ordinalSchema,
  recordIds: z.array(z.string().min(1)),
  gate3: z.array(z.object({ candidateId: z.string().min(1), receiptDigest: z.string().min(1) }).strict()),
  promoted: z.array(z.object({ candidateId: z.string().min(1), promotionPath: z.enum(PROMOTION_PATHS) }).strict()),
  held: z.array(z.object({ candidateId: z.string().min(1), reason: z.string().min(1) }).strict()),
  policy: z.object({
    recordId: z.string().min(1), scope: z.string().min(1), relPath: z.string().min(1),
    outcome: z.enum(['written', 'unchanged']),
  }).strict().optional(),
}).strict()

export type CommitReceipt = z.infer<typeof CommitReceiptSchema>

/** Accept a candidate: promote what the store already holds. */
export const KnowledgeAcceptInputSchema = z.object({
  target: KnowledgeTargetRefSchema,
}).strict()

export type KnowledgeAcceptInput = z.infer<typeof KnowledgeAcceptInputSchema>

/**
 * Reject a candidate. The reason is REQUIRED because the delta this becomes (`Deprecate`) requires
 * one — an input DTO that let it through empty would have handed the verb the job of inventing a
 * justification for a human decision.
 */
export const KnowledgeRejectInputSchema = z.object({
  target: KnowledgeTargetRefSchema,
  reason: z.string().min(1),
}).strict()

export type KnowledgeRejectInput = z.infer<typeof KnowledgeRejectInputSchema>

/** Forget a record or a whole bundle. */
export const KnowledgeForgetInputSchema = z.object({
  target: ForgetTargetRefSchema,
}).strict()

export type KnowledgeForgetInput = z.infer<typeof KnowledgeForgetInputSchema>

/**
 * what a CHANGE op takes on top of the verb it applies — an optional operation
 * identity. A caller that repeats the identity repeats the change, which lands once and answers the
 * same records; a caller that omits it gets a fresh identity back on the receipt.
 */
const CHANGE_IDENTITY = { operationId: KnowledgeChangeOperationIdSchema.optional() }

/** {@link KnowledgeAcceptInputSchema} as `knowledge.accept` takes it. */
export const KnowledgeAcceptChangeInputSchema = z.object({
  ...KnowledgeAcceptInputSchema.shape,
  ...CHANGE_IDENTITY,
}).strict()

export type KnowledgeAcceptChangeInput = z.infer<typeof KnowledgeAcceptChangeInputSchema>

/** {@link KnowledgeRejectInputSchema} as `knowledge.reject` takes it. */
export const KnowledgeRejectChangeInputSchema = z.object({
  ...KnowledgeRejectInputSchema.shape,
  ...CHANGE_IDENTITY,
}).strict()

export type KnowledgeRejectChangeInput = z.infer<typeof KnowledgeRejectChangeInputSchema>

/** {@link KnowledgeForgetInputSchema} as `knowledge.forget` takes it. */
export const KnowledgeForgetChangeInputSchema = z.object({
  ...KnowledgeForgetInputSchema.shape,
  ...CHANGE_IDENTITY,
}).strict()

export type KnowledgeForgetChangeInput = z.infer<typeof KnowledgeForgetChangeInputSchema>

/** Why a direct change wrote nothing, when the store refused it by type rather than by absence. */
export const KNOWLEDGE_CHANGE_REFUSAL_REASONS = ['policy-materialize-refused'] as const

export type KnowledgeChangeRefusalReason = (typeof KNOWLEDGE_CHANGE_REFUSAL_REASONS)[number]

/**
 * What a direct knowledge change DID: the records it changed, a typed absence, or a
 * typed refusal. Never a proposal: nothing waits for a second call.
 *
 * `recordIds` are read back after the write. A forget carries the tombstone receipt, and a change
 * that crossed a promotion gate carries its commit receipt. `operationId` is the identity the change
 * landed under, so a caller can retry it and land nothing twice.
 */
export const KnowledgeChangeOutputSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('applied'),
    verb: z.enum(KNOWLEDGE_CHANGE_VERBS),
    operationId: KnowledgeChangeOperationIdSchema,
    recordIds: z.array(z.string().min(1)),
    /** Present exactly when the change was a forget. */
    forgetReceipt: ForgetReceiptV1Schema.optional(),
    /** Present when the change passed a promotion gate or wrote a policy record. */
    commitReceipt: CommitReceiptSchema.optional(),
  }).strict(),
  z.object({
    outcome: z.literal('target-not-found'),
    verb: z.enum(KNOWLEDGE_CHANGE_VERBS),
    operationId: KnowledgeChangeOperationIdSchema,
    /** Echoed so an answer pasted into an issue still says what was asked about. */
    target: KnowledgeTargetRefSchema,
  }).strict(),
  z.object({
    outcome: z.literal('refused'),
    verb: z.enum(KNOWLEDGE_CHANGE_VERBS),
    operationId: KnowledgeChangeOperationIdSchema,
    reason: z.enum(KNOWLEDGE_CHANGE_REFUSAL_REASONS),
  }).strict(),
]).superRefine((output, ctx) => {
  // 2026-10-03 (quick 261003-cpv, 432 review IN-21): "present exactly when the change was a forget",
  // enforced. Producer-parsed only (the op, the daemon answer the host re-parses, MCP).
  if (output.outcome !== 'applied') return
  if ((output.verb === 'forget') !== (output.forgetReceipt !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['forgetReceipt'],
      message: 'an applied forget carries its forget receipt, and no other change carries one',
    })
  }
})

export type KnowledgeChangeOutput = z.infer<typeof KnowledgeChangeOutputSchema>
