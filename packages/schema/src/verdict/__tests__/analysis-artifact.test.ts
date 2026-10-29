// The artifact guard's direct corpus (Phase 389 gap G-389-3B, review WR-02).
//
// `guardRunAnalysisArtifact` is the ONE gate every stored/foreign artifact crosses — both
// byte-readers route through it (compose-local-agent's reader, emit-canary's loader). Its
// coverage previously rode consumers, whose fixtures all carry unique `perTest` values, so
// the guard's input domain never contained a duplicate-join-key artifact: two verdicts for
// the same test both passed, `sentenceByPerTest` kept the last, and `clusterVerdicts`
// counted one member twice. Per the precondition-guarded-rule-corpus-law this corpus holds
// both directions: the duplicate REJECT cases the domain lacked, and the distinct-perTest
// CONTROL the guard must still admit.
//
// The refusal pinned here is the exact typed failure `createVersionGuard` produces for a
// `shape: false` — a `TypeError` with message `'RunAnalysisArtifact failed structural
// validation'` — never a bare toThrow, and never `AnalysisVersionError` (that name is the
// version discipline's, not the shape check's).

import { describe, expect, it } from 'vitest'

import {
  admitAnalysisArtifactForRun,
  AnalysisVersionError,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  guardRunAnalysisArtifact,
} from '../analysis-artifact'
import type { RunAnalysisArtifact } from '../analysis-artifact'
import type { VerdictSentenceParts } from '../sentence-parts'
import type { Verdict } from '../verdict'

// ---------------------------------------------------------------------------------------
// Guard-admissible fixture builders — the validate-analysis.test.ts idioms, at the depth
// hasCompleteArtifactShape traverses: every verdict passes hasVerdictShape, every parts
// record parses through VerdictSentencePartsSchema (links through the one URI codec).
// ---------------------------------------------------------------------------------------

function verdictFor(perTest: number, overrides: Partial<Verdict> = {}): Verdict {
  return {
    class: 'unknown',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: [],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'advisory self-trace, never the sentence',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
    ...overrides,
  } as Verdict
}

function partsFor(perTest: number): VerdictSentenceParts {
  return {
    perTest,
    groundingQuote: { source: 'test-outcome', quote: 'failed' },
    discriminator: 'the same step passed on the previous build',
    nextAction: 'file the failure against the application with the quoted evidence',
    links: ['agentqa://memory/MEM-001'],
  }
}

function artifactOf(
  verdicts: Verdict[],
  parts: VerdictSentenceParts[],
): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId: 'run-analysis-artifact-guard',
    verdicts,
    parts,
  }
}

/** Captures the guard's thrown refusal; a guard that ADMITS is this corpus's RED. */
function refusalOf(candidate: unknown): unknown {
  try {
    guardRunAnalysisArtifact(candidate)
  } catch (error) {
    return error
  }
  throw new Error('expected guardRunAnalysisArtifact to refuse, but it admitted the artifact')
}

function expectShapeRefusal(candidate: unknown): void {
  const error = refusalOf(candidate)
  expect(error).toBeInstanceOf(TypeError)
  expect((error as TypeError).message).toBe(
    'RunAnalysisArtifact failed structural validation',
  )
  // The shape miss is NOT the version discipline's refusal.
  expect(error).not.toBeInstanceOf(AnalysisVersionError)
}

describe('guardRunAnalysisArtifact: perTest uniqueness on both arrays', () => {
  it('refuses two verdicts entries for the same perTest — contradicting classes, each shape-valid', () => {
    const artifact = artifactOf(
      [verdictFor(0, { class: 'unknown' }), verdictFor(0, { class: 'app_bug' })],
      [partsFor(0)],
    )
    expectShapeRefusal(artifact)
  })

  it('refuses two parts records for the same perTest — verdicts unique', () => {
    const artifact = artifactOf(
      [verdictFor(0), verdictFor(1)],
      [partsFor(0), partsFor(0)],
    )
    expectShapeRefusal(artifact)
  })

  it('CONTROL: still admits the same artifact with distinct perTest on both arrays', () => {
    const artifact = artifactOf(
      [verdictFor(0), verdictFor(1)],
      [partsFor(0), partsFor(1)],
    )
    expect(guardRunAnalysisArtifact(artifact)).toBe(artifact)
  })
})

describe('guardRunAnalysisArtifact: a declared memoryOnPath', () => {
  it('admits a verdict carrying a well-formed memoryOnPath, entries intact', () => {
    const memoryOnPath = [{ recordId: 'rec_mem_candidate', trust: 'candidate' }]
    const artifact = artifactOf([verdictFor(0, { memoryOnPath } as Partial<Verdict>)], [partsFor(0)])
    expect(guardRunAnalysisArtifact(artifact).verdicts[0]?.memoryOnPath).toEqual(memoryOnPath)
  })

  it('refuses a memoryOnPath outside the closed trust vocabulary or not an array', () => {
    expectShapeRefusal(
      artifactOf(
        [verdictFor(0, { memoryOnPath: [{ recordId: 'rec_mem_candidate', trust: 'canary' }] } as never)],
        [partsFor(0)],
      ),
    )
    expectShapeRefusal(
      artifactOf(
        [verdictFor(0, { memoryOnPath: { recordId: 'rec_mem_candidate' } } as never)],
        [partsFor(0)],
      ),
    )
  })
})

// ---------------------------------------------------------------------------------------
// G-389-3A: the read half of the two-sided run-identity contract. The write half derives
// the artifact's path FROM artifact.runId (persistAnalysis); this helper is the ONE place
// the recorded id is compared against the run being resolved, consumed at both byte
// boundaries (compose-local-agent's reader, emit-canary's loader). A mismatch is a typed
// refusal the consumers fold to the deterministic floor — never adoption, never hard-fail.
// ---------------------------------------------------------------------------------------

describe('admitAnalysisArtifactForRun: recorded runId vs the run being resolved', () => {
  it('admits a matching runId carrying the SAME artifact reference — identity, not a copy', () => {
    const artifact = artifactOf([verdictFor(0)], [partsFor(0)])
    const admission = admitAnalysisArtifactForRun(artifact, 'run-analysis-artifact-guard')
    expect(admission.kind).toBe('admitted')
    if (admission.kind === 'admitted') expect(admission.artifact).toBe(artifact)
  })

  it('refuses a mismatch TYPED, carrying both ids verbatim', () => {
    const artifact = artifactOf([verdictFor(0)], [partsFor(0)])
    expect(admitAnalysisArtifactForRun(artifact, 'run-somebody-else')).toEqual({
      kind: 'run-mismatch',
      recordedRunId: 'run-analysis-artifact-guard',
      resolvingRunId: 'run-somebody-else',
    })
  })
})
