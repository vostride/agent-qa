import type { ArtifactRef } from '../ids/artifact-ref'
import type { RecordId } from '../ids/record-id'
import type { Anchor } from '../identity/anchor'
import type { MemoryOnPathEntry } from './memory-on-path'

export interface VerdictEvidence {
  citedSteps: number[]
  citedAnchors: Anchor[]
  citedArtifacts: ArtifactRef[]
  rationale: string
}

interface VerdictBase {
  // A different axis from `VerdictSource` in `verb-evidence.ts`; failure-side trust keys on it.
  producer: 'deterministic-classifier' | 'analyze-run'
  confidence: number
  evidence: VerdictEvidence
  attribution?: {
    records: RecordId[]
    anchors: Anchor[]
  }
  memoryMisdirectionRuledOut: boolean
  /**
   * The low-trust records the author says the run put on this verdict's failing path. A
   * declaration, never the source of truth: `validateAnalysisAgainstHandoff` recomputes the set
   * from the run's own served briefs and rejects a declaration that disagrees.
   */
  memoryOnPath?: MemoryOnPathEntry[]
  perTest: number
}

// One list as data, so stored-class validators check the same set the type declares.
export const VERDICT_CLASSES = [
  'test_bug',
  'app_bug',
  'environment',
  'flake',
  'config_error',
  'llm_error',
  'unknown',
  'timeout',
] as const

export type VerdictClass = (typeof VERDICT_CLASSES)[number]

const VERDICT_CLASS_SET: ReadonlySet<string> = new Set(VERDICT_CLASSES)

/** True for exactly the eight closed classes — the membership check stored bytes must pass. */
export function isVerdictClass(value: unknown): value is VerdictClass {
  return typeof value === 'string' && VERDICT_CLASS_SET.has(value)
}

export type Verdict =
  | (VerdictBase & {
      class: 'test_bug'
      subtype?: 'stale_selector' | 'outdated_flow' | 'bad_assertion' | 'wrong_expected_value'
    })
  | (VerdictBase & { class: 'app_bug' })
  | (VerdictBase & { class: 'environment' })
  | (VerdictBase & { class: 'flake' })
  | (VerdictBase & { class: 'config_error' })
  | (VerdictBase & { class: 'llm_error' })
  /** LLM-judge abstention / unclassifiable — noop for learning; never files an issue (§A9 routing). */
  | (VerdictBase & { class: 'unknown' })
  /** Routes with environment/flake (flake management); never the issue path (§A9 routing). */
  | (VerdictBase & { class: 'timeout' })
