import { z } from 'zod'

import type { BundleKind, FactSubtype } from '../delta/envelope'
import type { ScopeKey, ScopeTier } from '../identity/scope-key'
import type { BundleStatus, DerivedTrustState } from '../knowledge/trust-fold'
import { GateLineSchema, GateReceiptSchema } from '../knowledge/gate-receipt'
import { PROMOTION_PATHS } from '../knowledge/promotion-path'
import { PROMOTION_GATE_HOLD_REASONS, type PromotionGateVerdict } from '../knowledge/promotion-gate'

export const KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION = 2

/**
 * One committed knowledge bundle as `knowledge.bundles.list` projects it
 *
 * Deliberately a LISTING row, not a record view: it carries bundle identity, product
 * qualification, the derived trust state a reviewer triages on, and the one-line summary —
 * never the record body, evidence, relations, or screen states. 387's five review verbs
 * extend this stub with the deeper projections they need; nothing here is meant to be the
 * final shape of a record inspection.
 *
 * All trust-shaped fields are DERIVED (the v51 trust fold), never authored: a surface
 * renders them and never recomputes them.
 */
export interface KnowledgeBundleSummary {
  /** The record id, which is also the bundle directory name. */
  bundleId: string
  /** Product the bundle is filed under; bundle ids are unique only per product. */
  product: string
  /** Bundle directory path relative to the knowledge root. */
  dir: string
  kind: BundleKind
  subtype?: FactSubtype
  scope: ScopeKey
  status: BundleStatus
  /** Derived trust score in [0, 1]. */
  trust: number
  counters: DerivedTrustState['counters']
  /** Build ordinal at which the record opened. */
  openedAtOrdinal: number
  /** Present iff the record has been closed (withdrawn or superseded). */
  closedAtOrdinal?: number
  /** Latest surviving real confirmation; staleness is asOfBuild minus this value. */
  lastConfirmedOrdinal: number
  /** The record's one-line human summary. */
  summary: string
  /** True when the record was folded with an incomplete evidence set (discounted prior). */
  evidenceIncomplete: boolean
}

const scopeTierValues = [
  'global',
  'product',
  'suite',
  'test',
] as const satisfies readonly ScopeTier[]

const bundleKindValues = [
  'fact',
  'procedure',
  'caution',
  'unknown',
  'policy',
] as const satisfies readonly BundleKind[]

const factSubtypeValues = [
  'selector',
  'behavioral',
  'navigational',
  'measurement',
  'content',
] as const satisfies readonly FactSubtype[]

const bundleStatusValues = [
  'active',
  'candidate',
  'superseded',
  'deprecated',
] as const satisfies readonly BundleStatus[]

export const BundleKindSchema = z.enum(bundleKindValues)
export const BundleStatusSchema = z.enum(bundleStatusValues)

const scopeKeySchema = z.object({
  tier: z.enum(scopeTierValues),
  key: z.string(),
}).strict()

const trustCountersSchema = z.object({
  confirmed: z.number().int().nonnegative(),
  contradicted: z.number().int().nonnegative(),
  helpful: z.number().nonnegative(),
  harmful: z.number().nonnegative(),
}).strict() satisfies z.ZodType<DerivedTrustState['counters']>

export const KnowledgeBundleSummarySchema = z.object({
  bundleId: z.string(),
  product: z.string(),
  dir: z.string(),
  kind: BundleKindSchema,
  subtype: z.enum(factSubtypeValues).optional(),
  scope: scopeKeySchema,
  status: BundleStatusSchema,
  trust: z.number().min(0).max(1),
  counters: trustCountersSchema,
  openedAtOrdinal: z.number().int().nonnegative(),
  closedAtOrdinal: z.number().int().nonnegative().optional(),
  lastConfirmedOrdinal: z.number().int().nonnegative(),
  summary: z.string(),
  evidenceIncomplete: z.boolean(),
}).strict() satisfies z.ZodType<KnowledgeBundleSummary>

// the listing's whole result, named so the op and the MCP tool share one object.
export const KnowledgeBundlesListOutputSchema = z.array(KnowledgeBundleSummarySchema)

/**
 * `knowledge.bundles.list` takes no arguments in the seed slice. A `.strict()` empty object
 * rather than `z.void()` so product/status/trust filters become additive fields later
 * without changing the op's input contract shape.
 */
export const KnowledgeBundlesListInputSchema = z.object({}).strict()

export type KnowledgeBundlesListInput = z.infer<typeof KnowledgeBundlesListInputSchema>

// history, standing evidence and the live verdict are one schema-owned answer.
export const KnowledgeGatesListInputSchema = z.object({ recordId: z.string().min(1) }).strict()
export const PromotionGateVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('promote'),
    promotionPath: z.enum(PROMOTION_PATHS),
    citedReceiptDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  }).strict(),
  z.object({
    verdict: z.literal('hold'),
    reason: z.enum(PROMOTION_GATE_HOLD_REASONS),
  }).strict(),
]) satisfies z.ZodType<PromotionGateVerdict>
export const KnowledgeGatesListResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-found'), recordId: z.string() }).strict(),
  z.object({
    kind: z.literal('found'),
    recordId: z.string(),
    product: z.string(),
    recordKind: z.enum(bundleKindValues),
    status: z.enum(bundleStatusValues),
    strongestPromotionPath: z.enum(PROMOTION_PATHS).optional(),
    lines: z.array(GateLineSchema),
    standing: z.array(GateReceiptSchema),
    live: PromotionGateVerdictSchema,
  }).strict(),
])
export type KnowledgeGatesListInput = z.infer<typeof KnowledgeGatesListInputSchema>
export type KnowledgeGatesListResult = z.infer<typeof KnowledgeGatesListResultSchema>
