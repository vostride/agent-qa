import { z } from 'zod'

import { CROSS_CHECKS } from '../knowledge/gate-receipt'
import type { CrossCheck } from '../knowledge/gate-receipt'
import { runIdSchema } from '../run/run-id'
import { MEMORY_ON_PATH_TRUSTS } from '../verdict/misdirection-evidence'
import type { MemoryOnPathTrust } from '../verdict/misdirection-evidence'
import { resolveVerdictMisdirection } from '../verdict/resolved-verdicts'
import type { Verdict } from '../verdict/verdict'

// The `analysis.get` op contracts (Phase 389, D-11/D-15 — minted in schema per 384 D-16).
//
// THE one producer of a run's full analysis: resolved verdicts (through the D-10 accessor),
// rendered sentences (the one renderer, live recurrence joins applied), and render-time
// clusters. The DTO carries clusters AND the full per-test sentences so a run page can
// expand a cluster (D-15) — every verdict still carries its sentence (ANLZ-03), the
// presentation dedupes (ANLZ-04).
//
// Clusters mint NO identity (D-16): fingerprint value, count, member refs and a representative —
// a cluster or verdict has no short-ID and no `agentqa://` address.
// 2026-09-02 (Phase 410): the sixth entity kind left with the Issue-slot cleanup.
//
// EVIDENCE ON THE WIRE (Phase 406, D-01). A verdict said what it CONCLUDED and never what it
// READ, so a page wanting "jump to the step this is about" or "open the screenshot it looked at"
// had to open `analysis.json` itself and re-join — a second producer of the same refs, which is
// the one thing this op exists to prevent. Each resolved verdict now carries the cited steps and
// cited artifacts it already held, ADDITIVELY: the field is optional in the type so a reader
// compiled against the older DTO is unaffected, while the op always emits it.
//
// THE CITED ANCHORS AND THE RATIONALE ARE DELIBERATELY OFF IT. The anchor list is an identity
// vocabulary no surface binds, and the rationale is the model's own prose about a run — it
// belongs to the artifact and to the rendered sentence, not to a link target. Widening later is
// additive; unpublishing is not.

const verdictClassValues = [
  'test_bug',
  'app_bug',
  'environment',
  'flake',
  'config_error',
  'llm_error',
  'unknown',
  'timeout',
] as const satisfies readonly Verdict['class'][]

/** `analysis.get` addresses exactly one completed run by id — the `runs.get` shape. */
export const AnalysisGetInputSchema = z.object({
  runId: runIdSchema,
}).strict()

export type AnalysisGetInput = z.infer<typeof AnalysisGetInputSchema>

/**
 * One resolved verdict as the analysis surface lists it: the three classification fields a
 * reader triages on, joined to the member test by `perTest` (D-07's join key) and named by
 * its per-run `testId`. The full `Verdict` (evidence arrays, attribution) stays in the
 * artifact/handoff documents rather than crossing every surface boundary by default.
 */
/**
 * One artifact a verdict cited, as the analysis surface links it (D-01/D-17).
 *
 * TWO ABSENCE FACTS, KEPT APART. `evidenceIncomplete` is the PRODUCER's — it knew at emit time
 * it could not attach these bytes — and `present` is the READER's, a stat taken when this DTO was
 * built. A page renders one `evidence-incomplete` state from either, but collapsing them here
 * would lose which side reported it, and only one of them can be fixed by re-running.
 *
 * `present` ABSENT IS NOT `present: false`. A host that cannot cheaply stat its blobs omits the
 * key, and a page's predicate is `present === false` so that presence-unknown never renders as a
 * claimed absence.
 */
export interface AnalysisCitedArtifact {
  id: string
  sha: string
  evidenceIncomplete?: boolean
  present?: boolean
}

/** What one verdict read, projected from its own `Verdict.evidence` — never re-derived (D-01). */
export interface AnalysisVerdictEvidence {
  citedSteps: number[]
  citedArtifacts: AnalysisCitedArtifact[]
}

/**
 * The not-run words the circularity arbiter is allowed to DISCLOSE on this DTO (422 D-19/D-20).
 *
 * A CLOSED ALLOW-LIST AND NOT A PASSTHROUGH, which is the whole reason it exists.
 * `MisdirectionRecordResult.reason` is an open `string` on the durable row: the arbiter writes one
 * of the four words `curation/misdirection-tail.ts` publishes (`cap-exceeded`, `interrupted`,
 * `no-eval-root`, `posture-unavailable`), but a root read failure or a validator refusal can put
 * arbitrary producer text there, and this DTO crosses the browser boundary. 422-17 held the same
 * line on the CLI close-out line for the same reason: the closed WORDS carry the whole disclosure,
 * and a reason outside this set is OMITTED rather than forwarded.
 *
 * Omission is safe because the word is a REFINEMENT of a row that already says `not-run`: a reader
 * that gets no word still knows the check did not run, it simply is not told why.
 */
export type AnalysisMisdirectionReason =
  | 'cap-exceeded'
  | 'interrupted'
  | 'no-eval-root'
  | 'posture-unavailable'
// prettier-ignore
export const ANALYSIS_MISDIRECTION_REASONS = ['cap-exceeded', 'interrupted', 'no-eval-root', 'posture-unavailable'] as const satisfies readonly AnalysisMisdirectionReason[]

/**
 * One record's cross-check, thinned to what a surface may show (422 D-20).
 *
 * NO DIGESTS AND NO SAMPLES. The durable row binds run, member, step, decision, brief, corpus and
 * profile identities so it cannot be replayed as another verdict's exoneration; none of that is a
 * fact a reader acts on, and every one of them is a value a page would put in a text node.
 */
export interface AnalysisMisdirectionRecord {
  recordId: string
  crossCheck: CrossCheck
  /** Present only when the row disclosed one of the closed words above. */
  reason?: AnalysisMisdirectionReason
}

/** One record the verdict DECLARED on its failing path, with the store's own trust marker. */
export interface AnalysisMemoryOnPathEntry {
  recordId: string
  trust: MemoryOnPathTrust
}

/**
 * What one resolved verdict says about circularity, as a surface may read it (422 D-17/D-19/D-20).
 *
 * `state` is {@link resolveVerdictMisdirection}'s three-arm reading, carried across the wire rather
 * than re-derived: `not-recorded` is a verdict that made no claim, `declared-only` is D-19's
 * absent-evaluation-root exemption, and `measured` is a real ledger. A surface that folded
 * `not-recorded` into either of the others would invent a backing nobody ever claimed.
 *
 * `memoryOnPath` is the verdict's own DECLARATION and stays exactly as absent or as empty as the
 * producer left it: "the author declared no records" and "the author declared nothing" are
 * different claims, and this member is the only place a page can tell them apart.
 */
export interface AnalysisVerdictMisdirection {
  state: 'not-recorded' | 'declared-only' | 'measured'
  /** The block's own summary word. Present exactly when `state` is not `not-recorded`. */
  crossCheck?: CrossCheck
  /** The complete per-record ledger, thinned. Present exactly when `crossCheck` is. */
  results?: AnalysisMisdirectionRecord[]
  /** D-19's absence marker, forwarded only when the producer actually wrote it. */
  backing?: 'declared-only'
  /** ABSENT stays absent; `[]` stays empty. Never synthesized from the ledger. */
  memoryOnPath?: AnalysisMemoryOnPathEntry[]
}

export interface AnalysisResolvedVerdict {
  perTest: number
  testId: string
  class: Verdict['class']
  producer: 'deterministic-classifier' | 'analyze-run'
  confidence: number
  /** OPTIONAL for readers compiled before 406; the op always emits it (D-01). */
  evidence?: AnalysisVerdictEvidence
  /**
   * What this verdict says about circularity (422 D-17/D-19/D-20), or NOTHING.
   *
   * ABSENT MEANS THE VERDICT SAID NOTHING AT ALL — no ledger, no declaration — which is every
   * verdict written before 422 and the deterministic floor's minted `unknown`. It is emitted
   * exactly when the verdict carries `misdirectionRuledOut` or `memoryOnPath`, so a run whose
   * arbiter never ran reaches a surface with no circularity member and renders as it always did.
   */
  misdirection?: AnalysisVerdictMisdirection
}

/** One member test's composed sentence — the ONE renderer's output, verbatim (D-05). */
export interface AnalysisSentence {
  perTest: number
  testId: string
  sentence: string
}

/** A cluster member ref: the join keys a surface needs to expand, nothing more (D-16). */
export interface AnalysisClusterMemberRef {
  testIndex: number
  testId: string
}

/**
 * One cluster as the op serves it (D-15/D-16): the fingerprint VALUE (never hashed, never
 * given an id), occurrence count, member refs ordered by testIndex, and the representative
 * member with its composed sentence.
 */
export interface AnalysisClusterView {
  fingerprint: string
  count: number
  members: AnalysisClusterMemberRef[]
  representative: {
    testIndex: number
    sentence: string
  }
}

/** The `analysis.get` result (D-11): verdicts + sentences + clusters, one producer. */
export interface AnalysisGetOutput {
  runId: string
  verdicts: AnalysisResolvedVerdict[]
  sentences: AnalysisSentence[]
  clusters: AnalysisClusterView[]
}

export const AnalysisCitedArtifactSchema = z.object({
  id: z.string(),
  sha: z.string(),
  evidenceIncomplete: z.boolean().optional(),
  present: z.boolean().optional(),
}).strict() satisfies z.ZodType<AnalysisCitedArtifact>

export const AnalysisVerdictEvidenceSchema = z.object({
  citedSteps: z.array(z.number().int().nonnegative()),
  citedArtifacts: z.array(AnalysisCitedArtifactSchema),
}).strict() satisfies z.ZodType<AnalysisVerdictEvidence>

export const AnalysisMisdirectionRecordSchema = z.object({
  recordId: z.string().min(1),
  crossCheck: z.enum(CROSS_CHECKS),
  reason: z.enum(ANALYSIS_MISDIRECTION_REASONS).optional(),
}).strict() satisfies z.ZodType<AnalysisMisdirectionRecord>

export const AnalysisMemoryOnPathEntrySchema = z.object({
  recordId: z.string().min(1),
  trust: z.enum(MEMORY_ON_PATH_TRUSTS),
}).strict() satisfies z.ZodType<AnalysisMemoryOnPathEntry>

export const AnalysisVerdictMisdirectionSchema = z.object({
  state: z.enum(['not-recorded', 'declared-only', 'measured']),
  crossCheck: z.enum(CROSS_CHECKS).optional(),
  results: z.array(AnalysisMisdirectionRecordSchema).optional(),
  backing: z.literal('declared-only').optional(),
  memoryOnPath: z.array(AnalysisMemoryOnPathEntrySchema).optional(),
}).strict() satisfies z.ZodType<AnalysisVerdictMisdirection>

export const AnalysisResolvedVerdictSchema = z.object({
  perTest: z.number().int().nonnegative(),
  testId: z.string(),
  class: z.enum(verdictClassValues),
  producer: z.enum(['deterministic-classifier', 'analyze-run']),
  confidence: z.number(),
  evidence: AnalysisVerdictEvidenceSchema.optional(),
  misdirection: AnalysisVerdictMisdirectionSchema.optional(),
}).strict() satisfies z.ZodType<AnalysisResolvedVerdict>

/**
 * THE one projection of a verdict's circularity evidence onto this DTO (422 D-17/D-19/D-20).
 *
 * It lives beside the shape it produces and is called by `analysis.get` and by nobody else, which
 * is the point: a second spelling at the op, at the door or at the page would be a second answer to
 * "what did this verdict say about the memory it was served", and the three would agree only on the
 * day they were written. The three refusals it inherits from {@link resolveVerdictMisdirection} are
 * not restated here — the function is CALLED, never re-derived.
 *
 * THREE THINGS IT REFUSES TO DO ITSELF:
 *
 *   - It does not synthesize a member. A verdict with no ledger AND no declaration answers
 *     `undefined`, so an older run's failure view is byte-identical to what it rendered before 422.
 *   - It does not recompute a cross-check, soften a `flipped` row or count a majority. The block's
 *     own word and the complete per-record ledger are carried; the reading is the reader's.
 *   - It does not forward a `reason` outside {@link ANALYSIS_MISDIRECTION_REASONS}, a digest, a
 *     sample record or the row's identity bindings. See {@link AnalysisMisdirectionRecord}.
 */
export function projectVerdictMisdirection(
  verdict: Verdict,
): AnalysisVerdictMisdirection | undefined {
  if (verdict.misdirectionRuledOut === undefined && verdict.memoryOnPath === undefined) {
    return undefined
  }
  // ABSENT STAYS ABSENT. `?? []` here would tell every reader the author declared an empty set.
  const declaration = verdict.memoryOnPath === undefined
    ? {}
    : {
        memoryOnPath: verdict.memoryOnPath.map((entry) => ({
          recordId: String(entry.recordId),
          trust: entry.trust,
        })),
      }
  const resolved = resolveVerdictMisdirection(verdict)
  if (resolved.state === 'not-recorded') return { state: 'not-recorded', ...declaration }
  const { evidence } = resolved
  return {
    state: resolved.state,
    crossCheck: evidence.crossCheck,
    results: evidence.results.map((row) => ({
      recordId: String(row.recordId),
      crossCheck: row.crossCheck,
      ...(disclosableReason(row.reason) === undefined
        ? {}
        : { reason: row.reason as AnalysisMisdirectionReason }),
    })),
    ...(evidence.backing === undefined ? {} : { backing: evidence.backing }),
    ...declaration,
  }
}

/** The allow-list read, spelled once. `undefined` for a word this DTO may not carry. */
function disclosableReason(reason: string | undefined): AnalysisMisdirectionReason | undefined {
  return ANALYSIS_MISDIRECTION_REASONS.find((word) => word === reason)
}

export const AnalysisSentenceSchema = z.object({
  perTest: z.number().int().nonnegative(),
  testId: z.string(),
  sentence: z.string(),
}).strict() satisfies z.ZodType<AnalysisSentence>

const analysisClusterMemberRefSchema = z.object({
  testIndex: z.number().int().nonnegative(),
  testId: z.string(),
}).strict() satisfies z.ZodType<AnalysisClusterMemberRef>

export const AnalysisClusterViewSchema = z.object({
  fingerprint: z.string(),
  count: z.number().int().positive(),
  members: z.array(analysisClusterMemberRefSchema),
  representative: z.object({
    testIndex: z.number().int().nonnegative(),
    sentence: z.string(),
  }).strict(),
}).strict() satisfies z.ZodType<AnalysisClusterView>

export const AnalysisGetOutputSchema = z.object({
  runId: z.string(),
  verdicts: z.array(AnalysisResolvedVerdictSchema),
  sentences: z.array(AnalysisSentenceSchema),
  clusters: z.array(AnalysisClusterViewSchema),
}).strict() satisfies z.ZodType<AnalysisGetOutput>
