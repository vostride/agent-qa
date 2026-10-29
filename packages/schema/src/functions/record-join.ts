import { z } from 'zod'

import type { KnowledgeRecordShowResult } from '../knowledge/review-verbs'
import { InspectRecordViewSchema } from '../knowledge/maintenance-views'
import type { MaskFn } from '../run/bus-projections'

// `not-found` is the store's answer, `scan-incomplete` an unfinished read, `not-bound` no read.
export const RUN_KNOWLEDGE_CONTENT_ABSENCE_REASONS = [
  'not-found',
  'scan-incomplete',
  'not-bound',
] as const

export const RunKnowledgeContentAbsenceSchema = z.object({
  reason: z.enum(RUN_KNOWLEDGE_CONTENT_ABSENCE_REASONS),
}).strict()

// Every `current*` member is read-time state; the row keeps its own historical change and trust.
export const RunKnowledgeRecordContentSchema = z.object({
  content: z.string(),
  summary: z.string(),
  kind: InspectRecordViewSchema.shape.kind,
  applicability: z.object({
    product: z.string(),
    scope: z.string(),
    anchors: z.array(z.string()),
    openedAtOrdinal: z.number().int().nonnegative(),
    closedAtOrdinal: z.number().int().nonnegative().optional(),
  }).strict(),
  currentStatus: InspectRecordViewSchema.shape.status,
  currentTrust: z.object({
    confirmations: z.number().int().nonnegative(),
    contradictions: z.number().int().nonnegative(),
    evidenceTokens: z.array(z.string()),
    lastEventOrdinal: z.number().int().nonnegative(),
    trustNarrative: z.string().optional(),
  }).strict(),
}).strict()

export type RunKnowledgeRecordContent = z.infer<typeof RunKnowledgeRecordContentSchema>
export type RunKnowledgeContentAbsence = z.infer<typeof RunKnowledgeContentAbsenceSchema>

export const recordJoinShape = {
  recordContent: RunKnowledgeRecordContentSchema.optional(),
  contentAbsence: RunKnowledgeContentAbsenceSchema.optional(),
}

export function oneJoinArm(
  row: { recordContent?: unknown; contentAbsence?: unknown },
  ctx: z.RefinementCtx,
) {
  if (row.recordContent !== undefined && row.contentAbsence !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['contentAbsence'],
      message: 'a joined row carries record content or its absence, never both' })
  }
}

// Trust and status are `deriveBundleTrust`'s answer, never recomputed; masking is a separate step.
export function projectRecordContent(result: Extract<KnowledgeRecordShowResult, { kind: 'found' }>): RunKnowledgeRecordContent {
  const { record } = result
  return {
    content: result.body,
    summary: result.summary,
    kind: record.kind,
    applicability: {
      product: record.product,
      scope: record.scope,
      anchors: [...record.anchors],
      openedAtOrdinal: record.openedAtOrdinal,
      ...(record.closedAtOrdinal === undefined ? {} : { closedAtOrdinal: record.closedAtOrdinal }),
    },
    currentStatus: record.status,
    currentTrust: {
      confirmations: record.confirmations,
      contradictions: record.contradictions,
      evidenceTokens: [...record.evidenceTokens],
      lastEventOrdinal: record.lastEventOrdinal,
      ...(record.trustNarrative === undefined || record.trustNarrative === null
        ? {}
        : { trustNarrative: record.trustNarrative }),
    },
  }
}

/** Every free-text member of joined content crosses the mask; ordinals, kind and status stay structural. */
export function maskRecordContent(content: RunKnowledgeRecordContent, mask: MaskFn): RunKnowledgeRecordContent {
  return {
    ...content,
    content: mask(content.content),
    summary: mask(content.summary),
    applicability: {
      ...content.applicability,
      product: mask(content.applicability.product),
      scope: mask(content.applicability.scope),
      anchors: content.applicability.anchors.map(mask),
    },
    currentTrust: {
      ...content.currentTrust,
      evidenceTokens: content.currentTrust.evidenceTokens.map(mask),
      ...(content.currentTrust.trustNarrative === undefined ? {} : { trustNarrative: mask(content.currentTrust.trustNarrative) }),
    },
  }
}
