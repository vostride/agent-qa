// `query` is free text: it goes only to the local coverage log, never into an event payload.

import { z } from 'zod'

/** What a person asked, verbatim. Local-only — see the header's free-text note. */
export const ExplainInputSchema = z.object({
  query: z.string().min(1),
}).strict()

/**
 * One run of model prose, or a pointer at one of the citations.
 *
 * A `citation` segment carries an INDEX and nothing else. Letting it carry its own text alongside
 * the index would be the field the header forbids arriving by the back door: the model would be
 * writing the words that stand where a command goes, which is exactly what "the renderer quotes
 * the row" means it must never do.
 */
export const ExplainProseSegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('citation'), citationIndex: z.number().int().nonnegative() }).strict(),
])

// `segments` is admitted but inert: the renderer's output depends only on the rows and cited order.
export const ExplainCitationSchema = z.object({
  /** Canonical catalog row ids — `op:<id>` / `alias:<alias>` / `skill:<name>`, in the model's order. */
  citedRowIds: z.array(z.string().min(1)),
  segments: z.array(ExplainProseSegmentSchema).optional(),
}).strict()

/** Which kind of catalog row a citation resolved to — the catalog's own discriminant. */
export const ExplainCitedRowKindSchema = z.enum(['op', 'alias', 'skill'])

/**
 * One resolved citation: a catalog row, projected.
 *
 * Every member here is copied or derived from row data by the renderer. `invocation` is the row's
 * own reachable form (`/fn <id>`, `/<alias>`, the skill's name) — never a string the model wrote,
 * and never a literal in renderer code for an alias, whose names are compile-bound in the shipped
 * resolver table.
 */
export const ExplainCitedCapabilitySchema = z.object({
  rowId: z.string().min(1),
  rowKind: ExplainCitedRowKindSchema,
  invocation: z.string().min(1),
  description: z.string().min(1),
  /** The op row's declared required input names, verbatim from `params.required`. Empty otherwise. */
  requiredParams: z.array(z.string().min(1)),
  docPath: z.string().min(1).nullable(),
}).strict()

/** Grounded: every cited id resolved, and every line below was quoted out of a row. */
export const ExplainAnswerSchema = z.object({
  kind: z.literal('answer'),
  citations: z.array(ExplainCitedCapabilitySchema).min(1),
  renderedLines: z.array(z.string().min(1)).min(1),
}).strict()

// `closestRowIds` may be empty: naming a closest row with no lexical overlap would be invention.
export const ExplainAbstentionSchema = z.object({
  kind: z.literal('abstention'),
  is_uncertain: z.literal(true),
  closestRowIds: z.array(z.string().min(1)),
  renderedLines: z.array(z.string().min(1)).min(1),
  docsGap: z.object({ logged: z.boolean() }).strict(),
}).strict()

export const ExplainOutputSchema = z.discriminatedUnion('kind', [
  ExplainAnswerSchema,
  ExplainAbstentionSchema,
])

export type ExplainInput = z.infer<typeof ExplainInputSchema>
export type ExplainProseSegment = z.infer<typeof ExplainProseSegmentSchema>
export type ExplainCitation = z.infer<typeof ExplainCitationSchema>
export type ExplainCitedRowKind = z.infer<typeof ExplainCitedRowKindSchema>
export type ExplainCitedCapability = z.infer<typeof ExplainCitedCapabilitySchema>
export type ExplainAnswer = z.infer<typeof ExplainAnswerSchema>
export type ExplainAbstention = z.infer<typeof ExplainAbstentionSchema>
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>
