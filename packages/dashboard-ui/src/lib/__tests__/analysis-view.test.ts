// The page composes no sentence; the marker is keyed off the chip word, never the sentence text.

import { describe, expect, it } from 'vitest'
import type {
  AnalysisClusterView,
  AnalysisGetOutput,
  AnalysisResolvedVerdict,
} from '@vostride/agent-qa-schema'

import {
  ANALYSIS_FAILED_FALLBACK_TEXT,
  ANALYSIS_PROVISIONAL_TEXT,
  DETERMINISTIC_FALLBACK_LABEL,
  LLM_VERDICT_LABEL,
  MEMORY_ON_PATH_NONE_TEXT,
  markerFor,
  memoryOnPathLine,
  missingEvidenceLine,
  projectAnalysisView,
  provenanceLabel,
  siblingLine,
} from '@/lib/analysis-view'

function analysis(over: Partial<AnalysisGetOutput> = {}): AnalysisGetOutput {
  return {
    runId: 'run-406',
    verdicts: [],
    sentences: [],
    clusters: [],
    ...over,
  }
}

function verdict(perTest: number, over: Partial<AnalysisResolvedVerdict> = {}): AnalysisResolvedVerdict {
  return {
    perTest,
    testId: `t_${String(perTest)}`,
    class: 'unknown',
    producer: 'deterministic-classifier',
    confidence: 0,
    ...over,
  }
}

function cluster(members: number[], over: Partial<AnalysisClusterView> = {}): AnalysisClusterView {
  return {
    fingerprint: 'timeout:submit',
    count: members.length,
    members: members.map((testIndex) => ({ testIndex, testId: `t_${String(testIndex)}` })),
    representative: { testIndex: members[0] ?? 0, sentence: 'the representative sentence' },
    ...over,
  }
}

describe('projectAnalysisView joins verdicts to members by perTest', () => {
  it('joins by perTest and NEVER by array position — verdicts listed out of order', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [
          verdict(3, { testId: 't_three', class: 'app_bug', producer: 'analyze-run', confidence: 0.86 }),
          verdict(1, { testId: 't_one' }),
        ],
        sentences: [
          { perTest: 1, testId: 't_one', sentence: 'the sentence for member ONE' },
          { perTest: 3, testId: 't_three', sentence: 'the sentence for member THREE' },
        ],
      }),
      'complete',
    )

    expect([...view.keys()].sort((a, b) => a - b), 'keyed by the member handle').toEqual([1, 3])
    // Array position would have paired verdict[0] with sentence[0] and swapped both members.
    expect(view.get(1)?.sentence).toBe('the sentence for member ONE')
    expect(view.get(3)?.sentence).toBe('the sentence for member THREE')
    expect(view.get(3)?.producer).toBe('analyze-run')
    expect(view.get(3)?.confidence).toBe(0.86)
    expect(view.get(1)?.testIndex).toBe(1)
  })

  it('projects an undefined analysis and an empty verdicts list to an EMPTY map (the green run)', () => {
    expect(projectAnalysisView(undefined, undefined).size).toBe(0)
    expect(projectAnalysisView(undefined, 'running').size).toBe(0)
    expect(projectAnalysisView(undefined, 'complete').size).toBe(0)
    // A green run: the op answered, and it answered that nothing needs explaining.
    expect(projectAnalysisView(analysis(), 'complete').size).toBe(0)
  })

  it('keys a verdict whose sentence never arrived, and drops a sentence with no verdict', () => {
    // A verdict without a rendered sentence still shows; a sentence with no verdict stays dropped.
    const view = projectAnalysisView(
      analysis({
        verdicts: [verdict(0)],
        sentences: [{ perTest: 4, testId: 't_4', sentence: 'a sentence about nobody' }],
      }),
      'running',
    )

    expect([...view.keys()]).toEqual([0])
    expect(view.get(0)?.sentence, 'empty, never invented').toBe('')
    expect(view.get(0)?.provenance).toBe(DETERMINISTIC_FALLBACK_LABEL)
    expect(view.get(4), 'a sentence nobody graded is not a block').toBeUndefined()
  })

  it("reads provenance from the verdict's own producer and confidence", () => {
    expect(provenanceLabel('analyze-run', 0.86)).toBe(`${LLM_VERDICT_LABEL} · 0.86`)
    expect(provenanceLabel('analyze-run', 1)).toBe(`${LLM_VERDICT_LABEL} · 1.00`)
    // The classifier's confidence is 0 by construction on the floor, and printing "· 0.00" beside
    // "deterministic fallback" would offer a number that means nothing to compare.
    expect(provenanceLabel('deterministic-classifier', 0)).toBe(DETERMINISTIC_FALLBACK_LABEL)

    const view = projectAnalysisView(
      analysis({
        verdicts: [verdict(0)],
        sentences: [{ perTest: 0, testId: 't_0', sentence: 'observed (step 0): "boom"' }],
      }),
      'running',
    )
    expect(view.get(0)?.provenance).toBe(DETERMINISTIC_FALLBACK_LABEL)
  })
})

describe('the marker is the chip word and nothing else', () => {
  it('maps every chip word — pending and running provisional, failed failed, complete nothing', () => {
    expect(markerFor('pending')).toBe('provisional')
    expect(markerFor('running')).toBe('provisional')
    expect(markerFor('failed')).toBe('failed')
    expect(markerFor('complete'), 'a terminal chain has nothing left to warn about').toBeUndefined()
    expect(markerFor(undefined), 'no read has landed — that is not a marker').toBeUndefined()
  })

  it('carries the marker and its exported sentence onto the member view', () => {
    const bytes = analysis({
      verdicts: [verdict(0)],
      sentences: [{ perTest: 0, testId: 't_0', sentence: 'observed (step 0): "boom"' }],
    })

    expect(projectAnalysisView(bytes, 'running').get(0)?.marker).toBe('provisional')
    expect(projectAnalysisView(bytes, 'running').get(0)?.markerText).toBe(ANALYSIS_PROVISIONAL_TEXT)
    expect(projectAnalysisView(bytes, 'pending').get(0)?.markerText).toBe(ANALYSIS_PROVISIONAL_TEXT)
    expect(projectAnalysisView(bytes, 'failed').get(0)?.marker).toBe('failed')
    expect(projectAnalysisView(bytes, 'failed').get(0)?.markerText).toBe(ANALYSIS_FAILED_FALLBACK_TEXT)
    expect(projectAnalysisView(bytes, 'complete').get(0)?.marker).toBeUndefined()
    expect(projectAnalysisView(bytes, 'complete').get(0)?.markerText).toBeUndefined()
  })

  it('gives the SAME marker to a sentence with the fallback words and one without them', () => {
    // THE PAIR. The floor renderer ends its sentence with "root cause undetermined", and an
    // implementation that read the marker off that phrase would look right until an LLM verdict
    // happened to contain it — or until the floor's copy changed. The chip word is the input.
    const withWords = analysis({
      verdicts: [verdict(0)],
      sentences: [
        { perTest: 0, testId: 't_0', sentence: 'observed (step 0): "boom" — root cause undetermined' },
      ],
    })
    const withoutWords = analysis({
      verdicts: [verdict(0)],
      sentences: [{ perTest: 0, testId: 't_0', sentence: 'the submit button never became enabled' }],
    })

    for (const chip of ['pending', 'running', 'complete', 'failed'] as const) {
      expect(
        projectAnalysisView(withWords, chip).get(0)?.marker,
        `the ${chip} marker must not read the sentence`,
      ).toBe(projectAnalysisView(withoutWords, chip).get(0)?.marker)
    }

    // And a floor sentence under a `done` chain carries no marker at all: the analysis finished
    // and the deterministic verdict is the answer, not a provisional one.
    expect(projectAnalysisView(withWords, 'complete').get(0)?.marker).toBeUndefined()
  })
})

describe('clusters render as a per-member sibling line', () => {
  it('excludes self, keeps the producer order, and reads the plural line', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [verdict(0), verdict(4), verdict(7)],
        sentences: [
          { perTest: 0, testId: 't_0', sentence: 's0' },
          { perTest: 4, testId: 't_4', sentence: 's4' },
          { perTest: 7, testId: 't_7', sentence: 's7' },
        ],
        clusters: [cluster([0, 4, 7])],
      }),
      'complete',
    )

    expect(view.get(4)?.siblings).toEqual([
      { testIndex: 0, testId: 't_0' },
      { testIndex: 7, testId: 't_7' },
    ])
    expect(view.get(4)?.siblingText).toBe(siblingLine(2))
    expect(view.get(0)?.siblings.map((s) => s.testIndex), 'producer order, self removed').toEqual([4, 7])
  })

  it('says "1 other test" in the singular and "N other tests" in the plural', () => {
    expect(siblingLine(1)).toBe('same failure as 1 other test')
    expect(siblingLine(2)).toBe('same failure as 2 other tests')
    expect(siblingLine(39)).toBe('same failure as 39 other tests')
  })

  it('renders NO line for a cluster of one — a lone failure is not a group', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [verdict(0)],
        sentences: [{ perTest: 0, testId: 't_0', sentence: 's0' }],
        clusters: [cluster([0])],
      }),
      'complete',
    )

    expect(view.get(0)?.siblings).toEqual([])
    expect(view.get(0)?.siblingText, 'no siblings is no sentence').toBeUndefined()
  })

  it('leaves a member no cluster mentions with no siblings at all', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [verdict(0), verdict(9)],
        sentences: [
          { perTest: 0, testId: 't_0', sentence: 's0' },
          { perTest: 9, testId: 't_9', sentence: 's9' },
        ],
        clusters: [cluster([0, 4])],
      }),
      'complete',
    )

    expect(view.get(9)?.siblings).toEqual([])
    expect(view.get(9)?.siblingText).toBeUndefined()
  })
})

describe('cited evidence rides the verdict, and absence is counted', () => {
  it('forwards citedSteps verbatim and answers an empty list when the op sent no evidence', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [
          verdict(0, { evidence: { citedSteps: [2, 3], citedArtifacts: [] } }),
          verdict(1),
        ],
        sentences: [
          { perTest: 0, testId: 't_0', sentence: 's0' },
          { perTest: 1, testId: 't_1', sentence: 's1' },
        ],
      }),
      'complete',
    )

    expect(view.get(0)?.citedSteps).toEqual([2, 3])
    expect(view.get(1)?.citedSteps, 'a reader compiled before 406 sent nothing').toEqual([])
    expect(view.get(1)?.citedArtifacts).toEqual([])
    expect(view.get(1)?.missingEvidence).toBeUndefined()
  })

  it('marks a ref incomplete from EITHER absence fact, and never from presence-unknown', () => {
    // An absent `present` is not `present: false`: a host that cannot stat its blobs omits the key.
    const view = projectAnalysisView(
      analysis({
        verdicts: [
          verdict(0, {
            evidence: {
              citedSteps: [],
              citedArtifacts: [
                { id: 'a-present', sha: 'sha-present', present: true },
                { id: 'a-unknown', sha: 'sha-unknown' },
                { id: 'a-gone', sha: 'sha-gone', present: false },
                { id: 'a-never-attached', sha: 'sha-never', evidenceIncomplete: true },
              ],
            },
          }),
        ],
        sentences: [{ perTest: 0, testId: 't_0', sentence: 's0' }],
      }),
      'complete',
    )

    expect(view.get(0)?.citedArtifacts).toEqual([
      { id: 'a-present', sha: 'sha-present', incomplete: false },
      { id: 'a-unknown', sha: 'sha-unknown', incomplete: false },
      { id: 'a-gone', sha: 'sha-gone', incomplete: true },
      { id: 'a-never-attached', sha: 'sha-never', incomplete: true },
    ])
    expect(view.get(0)?.missingEvidence).toEqual({ missing: 2, total: 4 })
    expect(view.get(0)?.missingEvidenceText).toBe(missingEvidenceLine({ missing: 2, total: 4 }))
  })

  it('counts nothing when every cited artifact is there', () => {
    const view = projectAnalysisView(
      analysis({
        verdicts: [
          verdict(0, {
            evidence: {
              citedSteps: [0],
              citedArtifacts: [{ id: 'a', sha: 'sha-a', present: true }],
            },
          }),
        ],
        sentences: [{ perTest: 0, testId: 't_0', sentence: 's0' }],
      }),
      'complete',
    )

    expect(view.get(0)?.missingEvidence, 'nothing missing is no count line').toBeUndefined()
    expect(view.get(0)?.missingEvidenceText).toBeUndefined()
  })

  it('says "cited artifact" in the singular and "cited artifacts" in the plural', () => {
    expect(missingEvidenceLine({ missing: 1, total: 1 })).toBe('1 of 1 cited artifact unavailable')
    expect(missingEvidenceLine({ missing: 1, total: 2 })).toBe('1 of 2 cited artifacts unavailable')
    expect(missingEvidenceLine({ missing: 3, total: 3 })).toBe('3 of 3 cited artifacts unavailable')
  })
})

describe('the projection lists the records a verdict declared on its failing path', () => {
  const CANDIDATE = 'rec_cand_0001'
  const CANARY = 'rec_canary_01'

  function withMemoryOnPath(memoryOnPath: AnalysisResolvedVerdict['memoryOnPath']) {
    return projectAnalysisView(
      analysis({
        verdicts: [verdict(0, memoryOnPath === undefined ? {} : { memoryOnPath })],
        sentences: [{ perTest: 0, testId: 't_0', sentence: 'observed (step 0): "boom"' }],
      }),
      'complete',
    ).get(0)?.memoryOnPath
  }

  it('carries every declared record with its trust word and counts them', () => {
    const view = withMemoryOnPath([
      { recordId: CANDIDATE, trust: 'candidate' },
      { recordId: CANARY, trust: 'candidate' },
    ])

    expect(view?.onPath).toEqual([
      { recordId: CANDIDATE, trust: 'candidate' },
      { recordId: CANARY, trust: 'candidate' },
    ])
    expect(view?.onPathText).toBe(memoryOnPathLine(2))
  })

  it('reads an empty declaration as none declared', () => {
    const view = withMemoryOnPath([])

    expect(view?.onPath).toEqual([])
    expect(view?.onPathText).toBe(MEMORY_ON_PATH_NONE_TEXT)
  })

  it('projects a verdict that declared nothing to no member at all', () => {
    expect(withMemoryOnPath(undefined)).toBeUndefined()
  })
})
