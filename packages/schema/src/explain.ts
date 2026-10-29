// The `explain` contract.
//
// THE UNION IS BINARY AND THERE IS NO CONFIDENCE MEMBER, and the absence is load-bearing. This is
// the chat resolver table's own law, restated for the surface where it matters second-most:
// `resolver-table.ts` says "RESOLUTION IS BINARY … NO CONFIDENCE MEMBER … A confidence number
// would be the first half of a threshold". Here the reasoning is the same with a different
// consequence: `explain` answers a person asking what the tool can do, and a 0.6-confidence answer
// is an answer they will act on. There is exactly one honest split — the catalog grounds this, or
// it does not — so the union has two arms and no number to tune between them.
//
// NO-INVENTION IS STRUCTURAL, NOT PROMPTED. `ExplainCitationSchema` is the LLM's whole
// output contract, and it is `.strict()` with no field that can carry a command string: the model
// selects catalog ROW IDS and nothing else. Every command a person reads is quoted out of a
// catalog row by the deterministic renderer in `packages/agent/src/explain/renderer.ts`. A cited
// id that no row answers to is therefore not a bad answer to sanitise — it is structurally an
// abstention, because there is nothing for the renderer to quote.
//
// `query` IS THE ONE DELIBERATELY FREE-TEXT FIELD IN THIS FEATURE, and it never leaves the machine.
// It flows to the local coverage log under `.agent-qa/` and nowhere else; analytics may
// carry at most a counter (D-14's no-free-text law). Nothing downstream of this file may put it in
// an event payload.

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

/**
 * THE LLM'S ENTIRE OUTPUT CONTRACT.
 *
 * `segments` is admitted so the model is not forced to answer in a shape it cannot hold, and the
 * renderer treats it as INERT: the rendered output is a total function of the resolved rows and
 * the cited order, proven by the `renderer.test.ts` inertness cell. That cell is the guard on this
 * field — an author who later starts rendering model prose reds it, rather than discovering by
 * report that a made-up command reached a person.
 */
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

/**
 * Not grounded — stated plainly, with the nearest thing the catalog does carry.
 *
 * `closestRowIds` may be empty, and that is the honest arm rather than a hole: a query with no
 * lexical overlap with any row has no closest capability, and naming one anyway would be the
 * invention this whole contract exists to make impossible.
 *
 * `docsGap.logged` is the renderer's report of whether the host actually appended the coverage
 * record, not a request that it should — the renderer is storage-neutral and writes nothing.
 */
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
