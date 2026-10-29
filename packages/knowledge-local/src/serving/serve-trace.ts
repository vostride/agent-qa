// Serve-time trace composition for the four serving channels.
//
// D-16 makes producing a trace inseparable from serving: every serving entry returns brief and
// trace as ONE value, so no code path can hand a caller a brief while quietly discarding how it
// was chosen. This module owns the two small decisions that composition needs — which leg a
// channel's ranking attributes to, and how the truncation ledger is bounded — so those decisions
// live in one place with their reasoning rather than being restated per channel.
//
// LEG ATTRIBUTION, STATED HONESTLY. The trace's leg vocabulary is the RETRIEVAL vocabulary, and
// the run-brief/caution assemblies do NOT run the retrieval legs: Channel 1 orders candidates by
// `trust x anchorMatch(anchors, scope)` and Channel 3 admits a caution only when one of its
// anchors matches the failure anchors. In both, the ONLY query-shaped signal is anchor overlap —
// no FTS scan and no embedding participates. `anchor` is therefore what actually put a line in
// those channels, and naming any other leg would be a fabricated attribution in exactly the place
// KREV-02 exists to make honest. The authoring channel is different: its relevance really is a
// weighted sum of an anchor term, a lexical term and an optional dense term, so it attributes per
// line to whichever term contributed most (see `dominantAuthoringLeg`).
import {
  RETRIEVAL_TRACE_LEGS,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  TRACE_TRUNCATION_TOP_K,
  type RetrievalTraceLeg,
  type ServedRetrievalTraceV1,
  type TraceLine,
} from '@vostride/agent-qa-schema'

/**
 * The leg Channel-1 run-brief assembly attributes to. See the module header: the assembly's whole
 * ordering signal is the scope/anchor token overlap, so this is a statement about the code that
 * ranks, not a default.
 */
export const CHANNEL_1_SERVING_LEG: RetrievalTraceLeg = 'anchor'

/**
 * The leg Channel-3 caution selection attributes to. Unambiguous here: a caution with no matching
 * anchor is dropped before it is ever ranked.
 */
export const CHANNEL_3_CAUTION_LEG: RetrievalTraceLeg = 'anchor'

/**
 * Fixed precedence for a tie between authoring relevance terms. Anchor overlap is the authoring
 * assembly's primary signal and the lexical term is explicitly secondary and additive, so an
 * exact tie resolves toward the stronger claim rather than toward whichever term the loop
 * happened to visit last.
 */
const AUTHORING_LEG_PRECEDENCE: readonly RetrievalTraceLeg[] = ['anchor', 'lexical', 'dense']

/**
 * The leg that contributed most to one authoring relevance value. Contributions arrive ALREADY
 * weighted — the caller passes the same products it summed into relevance, so this reads the
 * decomposition of a number that was actually computed rather than recomputing a second one.
 */
export function dominantAuthoringLeg(
  contributions: Readonly<Record<RetrievalTraceLeg, number>>,
): RetrievalTraceLeg {
  let best = AUTHORING_LEG_PRECEDENCE[0]!
  for (const leg of AUTHORING_LEG_PRECEDENCE) {
    if (contributions[leg] > contributions[best]) best = leg
  }
  return best
}

/**
 * A score that the persistence boundary will accept. `TraceLineSchema` requires a finite number,
 * and the load boundary validates a PRESENT trace, so one non-finite score would make an entire
 * run handoff unloadable rather than degrading a single attribution. A non-finite ranking score
 * cannot occur through the current selection paths (every input is finite-guarded upstream); this
 * keeps that a local property of this module instead of an inherited assumption.
 */
function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** Build one attributed trace line, normalizing rank to the schema's 1-based positive contract. */
export function traceLine(input: {
  recordId: string
  leg: RetrievalTraceLeg
  rank: number
  score: number
}): TraceLine {
  return {
    recordId: input.recordId,
    leg: input.leg,
    rank: Math.max(1, Math.floor(input.rank)),
    score: finiteScore(input.score),
  }
}

/**
 * Bound the truncation ledger at the pinned top-K. The cut set is unbounded in principle;
 * the ledger keeps the highest-ranked cuts because those are the ones a "why didn't it mention X"
 * question is actually asked about. Input order IS rank order at every call site, so this keeps a
 * prefix rather than re-sorting a ranking somebody else produced.
 */
export function boundTruncationLedger(lines: readonly TraceLine[]): TraceLine[] {
  return lines.slice(0, TRACE_TRUNCATION_TOP_K)
}

/** Assemble the persisted trace value from its two ledgers. */
export function composeServedTrace(input: {
  servedLines: readonly TraceLine[]
  truncated: readonly TraceLine[]
}): ServedRetrievalTraceV1 {
  return {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
    servedLines: [...input.servedLines],
    truncated: boundTruncationLedger(input.truncated),
  }
}

/**
 * The legs a serving channel in this package can actually emit. This is the `knowledge-local` half
 * of the cross-package vocabulary check the trace DTO asks for: the schema declares
 * `RETRIEVAL_TRACE_LEGS`, the retrieval legs module declares a module-private `CandidateLeg`, and
 * this package is the only one that can see both. Exported so a test can assert the three sets
 * agree instead of a comment claiming they do.
 */
export const SERVING_TRACE_LEGS: readonly RetrievalTraceLeg[] = RETRIEVAL_TRACE_LEGS
