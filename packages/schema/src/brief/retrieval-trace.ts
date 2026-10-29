// The serve-time retrieval trace.
//
// What a brief SAID is already durable; what this contract makes durable is WHY it said it.
// The serving path knows leg, rank, score and what the token budget cut at the moment it
// assembles a brief, and every one of those facts is gone a millisecond later — a later
// question answered by re-querying the index answers about *now*, which is precisely the
// dishonesty KREV-02 exists to prevent. So the trace is captured at the seam and persisted
// beside the evidence, and the why-verb reads only what was written down.
//
// TWO ledgers, not one. `servedLines` answers "why did it say this". `truncated` answers
// "why didn't it mention X" — the question a QA engineer debugging a missed hint actually
// asks, and the one that is unanswerable from the served brief alone because the cut
// candidates leave no trace in it at all.
//
// This module deliberately does NOT touch the `ServedBrief` contract. That value feeds
// `computeBriefDigest`, and every cassette and acceptance digest in the tree is keyed on its
// exact bytes; a trace channel added there would have rewritten all of them.

import { z } from 'zod'

/**
 * The retrieval legs a served line can be attributed to.
 *
 * VOCABULARY OF RECORD: `knowledge-local/src/retrieval/legs.ts`, whose `CandidateLeg` type
 * declares exactly these three names. That type is module-private and lives in a package
 * that sits ABOVE this one in the dependency order, so it cannot be imported here — which
 * makes this a second, independent spelling of one vocabulary with nothing holding the two
 * together. The cross-check belongs on the `knowledge-local` side (it depends on `schema`,
 * not the reverse) and is left for the plan that wires the serve seam.
 *
 * Closed on purpose: a leg is the ATTRIBUTION a why-answer prints, and an open string would
 * let a producer invent a fourth leg that no reader has a rendering for.
 */
export const RETRIEVAL_TRACE_LEGS = ['lexical', 'dense', 'anchor'] as const

export type RetrievalTraceLeg = (typeof RETRIEVAL_TRACE_LEGS)[number]

/**
 * How many budget-cut candidates the truncation ledger carries.
 *
 * Bounded because the cut set is unbounded in principle — every admitted candidate that did
 * not fit is a cut candidate, and an unbounded ledger would make a step's evidence grow with
 * the size of the index rather than with what happened. Twenty is the depth at which "why
 * didn't it mention X" stops being answerable in practice: past it, X was not a near miss.
 * Retune from operational evidence — real why-questions whose answer fell off the end —
 * without adding config.
 */
export const TRACE_TRUNCATION_TOP_K = 20

/**
 * One attributed candidate: which record, which leg matched it, where it ranked, and what it
 * scored.
 *
 * `rank` is 1-based, matching the in-tree convention the retrieval legs already use
 * (`index + 1` at their candidate-construction sites). A zero is rejected rather than
 * silently read as "top result", because the two conventions differ by exactly one and a
 * printed answer that is off by one rank is wrong in the least detectable way.
 *
 * `score` is finite but otherwise unbounded: fused RRF scores are sums of reciprocal-rank
 * contributions, not probabilities, and clamping them to [0,1] here would misreport them.
 */
export const TraceLineSchema = z.object({
  recordId: z.string().min(1),
  leg: z.enum(RETRIEVAL_TRACE_LEGS),
  rank: z.number().int().positive(),
  score: z.number().finite(),
}).strict()

export type TraceLine = z.infer<typeof TraceLineSchema>

export const RETRIEVAL_TRACE_SCHEMA_VERSION = 2

/**
 * The trace as persisted, stamped with `RETRIEVAL_TRACE_SCHEMA_VERSION`.
 *
 * `servedLines` is deliberately unbounded — the serving budget already bounds how many lines
 * can be served, so a second cap here would only ever disagree with the first.
 */
export const ServedRetrievalTraceV1Schema = z.object({
  schemaVersion: z.literal(RETRIEVAL_TRACE_SCHEMA_VERSION),
  servedLines: z.array(TraceLineSchema),
  truncated: z.array(TraceLineSchema).max(TRACE_TRUNCATION_TOP_K),
}).strict()

export type ServedRetrievalTraceV1 = z.infer<typeof ServedRetrievalTraceV1Schema>
