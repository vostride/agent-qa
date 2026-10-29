import { z } from 'zod'

import { runIdSchema } from '../run/run-id'
import { MEMORY_ON_PATH_TRUSTS } from '../verdict/memory-on-path'
import type { MemoryOnPathTrust } from '../verdict/memory-on-path'
import type { Verdict } from '../verdict/verdict'

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

// `present` is a read-time stat, apart from `evidenceIncomplete`; absent `present` is unknown.
export interface AnalysisCitedArtifact {
  id: string
  sha: string
  evidenceIncomplete?: boolean
  present?: boolean
}

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
  // Optional in the type only; the op always emits it.
  evidence?: AnalysisVerdictEvidence
  /**
   * The low-trust records this verdict declared on its failing path. Absent when the verdict
   * declared nothing; `[]` when it declared none.
   */
  memoryOnPath?: AnalysisMemoryOnPathEntry[]
}

export interface AnalysisSentence {
  perTest: number
  testId: string
  sentence: string
}

export interface AnalysisClusterMemberRef {
  testIndex: number
  testId: string
}

export interface AnalysisClusterView {
  fingerprint: string
  count: number
  members: AnalysisClusterMemberRef[]
  representative: {
    testIndex: number
    sentence: string
  }
}

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
