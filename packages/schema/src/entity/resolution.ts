// Entity resolution results.
//
// TWO unions, and the split is what makes ENTY-02's one-producer claim testable rather than
// aspirational.
//
//   `EntityResolution`     — DESCRIPTOR-level. What the store layer computes and what the
//                            injected directory port returns. It carries the facts about an
//                            entity and renders nothing.
//   `EntityCardResolution` — CARD-level. What `entities.resolve` answers with, produced by
//                            the single card producer in the function layer.
//
// Collapsing them into one union would have put card construction inside `knowledge-local`,
// and "exactly one producer" would then have meant "one producer plus whatever the store
// happened to build", which is not a claim any test can pin. With the split, the store layer
// has no vocabulary for a card at all.
//
// Three arms, closed, per D-09 — a hit, a small disambiguation set, or an honest miss. There
// is deliberately no "best effort" arm: under ENTY-01's never-guess contract, weaker
// retrieval may only produce MORE disambiguation, never a different silent answer, and an
// arm that meant "probably this one" would be exactly the silent answer the contract forbids.

import { z } from 'zod'

import { EntityCardSchema } from './entity-card'
import { ENTITY_KINDS } from './kinds'
import { EntityUriSchema } from './uri'

/**
 * The disambiguation set is small ON PURPOSE (D-09: "top-3").
 *
 * A long list is not disambiguation, it is a search result — and the moment a caller has to
 * scroll it, the surface has quietly handed the never-guess decision back to a human who has
 * less context than the resolver did. Retune from what real ambiguous references look like,
 * never to accommodate a weaker ranker.
 */
export const ENTITY_RESOLUTION_MAX_CANDIDATES = 3

/** The score tier (a) answers with: an address that parsed and matched is not a guess. */
export const ENTITY_EXACT_MATCH_SCORE = 1

/**
 * Why a reference resolved to nothing. A bare `none` would have collapsed two genuinely
 * different situations — a well-formed address for an entity that was never minted, and text
 * that matched no addressing rule at all — into one answer, and a surface cannot phrase a
 * useful message without knowing which one it holds.
 */
export const ENTITY_NO_MATCH_REASONS = [
  'unknown-address',
  'no-match',
] as const

export type EntityNoMatchReason = (typeof ENTITY_NO_MATCH_REASONS)[number]

/**
 * What the store layer knows about one entity: its address, the machine id that address maps
 * FROM, a human title, and the status the owning store reports.
 *
 * `statusSource` is a plain string rather than the card's closed per-kind union, and that is
 * the render-never-recompute boundary in type form: the store reports what it observed, and
 * the producer is where an unrecognised status is REFUSED by the schema instead of
 * being silently mapped to something plausible.
 */
export const EntityDescriptorSchema = z.object({
  kind: z.enum(ENTITY_KINDS),
  shortId: z.string().min(1),
  uri: EntityUriSchema,
  machineId: z.string().min(1),
  title: z.string(),
  statusSource: z.string().min(1),
  /**
   * The machine id this entity was explicitly RENAMED to, when a rename was recorded.
   *
   * Present only for an address whose successor was written down — never inferred from two
   * similar names. The predecessor keeps its own permanent address and keeps resolving; this
   * field is what lets a card SHOW the rename rather than silently redirecting to the
   * successor, which would make an old CI log's reference quietly mean something else.
   */
  successorMachineId: z.string().min(1).optional(),
  /**
   * The DURABLE test identity a `TST` entity's store keyed it on.
   *
   * `(product, filePath, testName)` — the same three legs the run-outcome projection and the
   * quarantine ledger are keyed by, and never `testId`, which is a per-run explicit id. It is
   * reported BESIDE `machineId` rather than parsed out of it: the two answer different
   * questions, and a card that recovered an identity by splitting a machine id would be
   * guessing at a format no producer has agreed to.
   *
   * OPTIONAL because a store may not know it. A `TST` descriptor without it renders `active`,
   * which is the honest answer for a store that cannot say whether this test is quarantined —
   * matching it from the title instead would be exactly the plausible-but-wrong attribution
   * D-12 refuses. Absent for every other kind by construction: nothing else has a test identity.
   */
  testIdentity: z.object({
    product: z.string().min(1),
    filePath: z.string().min(1),
    testName: z.string().min(1),
  }).strict().optional(),
}).strict()

export type EntityDescriptor = z.infer<typeof EntityDescriptorSchema>

const scoreSchema = z.number().min(0).max(1)

const noneArm = z.object({
  kind: z.literal('none'),
  reason: z.enum(ENTITY_NO_MATCH_REASONS),
  /** The nearest address worth offering, when one exists. Never auto-applied. */
  closestSuggestion: z.string().min(1).optional(),
}).strict()

export const EntityResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolved'),
    descriptor: EntityDescriptorSchema,
    score: scoreSchema,
  }).strict(),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(
      z.object({ descriptor: EntityDescriptorSchema, score: scoreSchema }).strict(),
    ).min(2).max(ENTITY_RESOLUTION_MAX_CANDIDATES),
  }).strict(),
  noneArm,
])

export type EntityResolution = z.infer<typeof EntityResolutionSchema>

export const EntityCardResolutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resolved'),
    card: EntityCardSchema,
    score: scoreSchema,
  }).strict(),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(
      z.object({ card: EntityCardSchema, score: scoreSchema }).strict(),
    ).min(2).max(ENTITY_RESOLUTION_MAX_CANDIDATES),
  }).strict(),
  noneArm,
])

export type EntityCardResolution = z.infer<typeof EntityCardResolutionSchema>

/** `entities.resolve` input: any reference at all — short-ID, URI, or free text. */
export const EntitiesResolveInputSchema = z.object({
  ref: z.string().min(1),
}).strict()

export type EntitiesResolveInput = z.infer<typeof EntitiesResolveInputSchema>

/** `entities.get` input: an EXACT address. The simple read path 396 projects onto. */
export const EntitiesGetInputSchema = z.object({
  ref: z.string().min(1),
}).strict()

export type EntitiesGetInput = z.infer<typeof EntitiesGetInputSchema>
