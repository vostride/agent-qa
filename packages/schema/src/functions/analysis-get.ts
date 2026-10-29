import { z } from 'zod'

import { runIdSchema } from '../run/run-id'
import { MEMORY_ON_PATH_TRUSTS } from '../verdict/memory-on-path'
import type { MemoryOnPathTrust } from '../verdict/memory-on-path'
import type { Verdict } from '../verdict/verdict'

// The `analysis.get` op contracts (Phase 389, D-11/D-15 — minted in schema per 384 D-16).
//
// THE one producer of a run's full analysis: resolved verdicts (through the D-10 accessor),
// rendered sentences (the one renderer, live recurrence joins applied), and render-time
// clusters. The DTO carries clusters AND the full per-test sentences so a run page can
// expand a cluster — every verdict still carries its sentence, the
// presentation dedupes.
//
// Clusters mint NO identity: fingerprint value, count, member refs and a representative —
// a cluster or verdict has no short-ID and no `agentqa://` address.
// the sixth entity kind left with the Issue-slot cleanup.
//
// EVIDENCE ON THE WIRE. A verdict said what it CONCLUDED and never what it
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
 * One artifact a verdict cited, as the analysis surface links it.
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

/** What one verdict read, projected from its own `Verdict.evidence` — never re-derived. */
export interface AnalysisVerdictEvidence {
  citedSteps: number[]
  citedArtifacts: AnalysisCitedArtifact[]
}

/** One record the verdict DECLARED on its failing path, with the store's own trust marker. */
export interface AnalysisMemoryOnPathEntry {
  recordId: string
  trust: MemoryOnPathTrust
}

export interface AnalysisResolvedVerdict {
  perTest: number
  testId: string
  class: Verdict['class']
  producer: 'deterministic-classifier' | 'analyze-run'
  confidence: number
  /** OPTIONAL for readers compiled before 406; the op always emits it. */
  evidence?: AnalysisVerdictEvidence
  /**
   * The low-trust records this verdict declared on its failing path. Absent when the verdict
   * declared nothing; `[]` when it declared none.
   */
  memoryOnPath?: AnalysisMemoryOnPathEntry[]
}

/** One member test's composed sentence — the ONE renderer's output, verbatim. */
export interface AnalysisSentence {
  perTest: number
  testId: string
  sentence: string
}

/** A cluster member ref: the join keys a surface needs to expand, nothing more. */
export interface AnalysisClusterMemberRef {
  testIndex: number
  testId: string
}

/**
 * One cluster as the op serves it: the fingerprint VALUE (never hashed, never
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

/** The `analysis.get` result: verdicts + sentences + clusters, one producer. */
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

export const AnalysisMemoryOnPathEntrySchema = z.object({
  recordId: z.string().min(1),
  trust: z.enum(MEMORY_ON_PATH_TRUSTS),
}).strict() satisfies z.ZodType<AnalysisMemoryOnPathEntry>

export const AnalysisResolvedVerdictSchema = z.object({
  perTest: z.number().int().nonnegative(),
  testId: z.string(),
  class: z.enum(verdictClassValues),
  producer: z.enum(['deterministic-classifier', 'analyze-run']),
  confidence: z.number(),
  evidence: AnalysisVerdictEvidenceSchema.optional(),
  memoryOnPath: z.array(AnalysisMemoryOnPathEntrySchema).optional(),
}).strict() satisfies z.ZodType<AnalysisResolvedVerdict>

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
