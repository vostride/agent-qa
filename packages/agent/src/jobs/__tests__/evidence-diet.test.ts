// The D-02 evidence diet and the D-01 compaction ladder.
//
// What is pinned, and why it can fail loudly:
//
//   window     the failing step ± EVIDENCE_WINDOW_STEPS neighbors, clamped at both trajectory
//              edges — a failing step at index 0 or at the last step never indexes outside
//              steps[].
//   verbatim   packs QUOTE StepEvidence fields — stepText, verifierVerdict.reasoning, each
//              subAction's plan and result.error — never paraphrase them.
//   forced     the prior-build channel and the servedBrief + retrieval-trace channel are in
//              EVERY pack and are canonicalJson-identical through every compaction rung
//              (D-02: compaction squeezes the window, never the forced channels).
//   refs       the failing step's decisionScreenshotRef entries travel as refs deduped by
//              sha; rung 1 strips them from every pack while leaving all text sections
//              byte-identical (D-02/L9 text-only degradation, a deterministic rung).
//   ladder     deterministic over an injected estimator and budget — same inputs, same rung,
//              same bytes; exhausting rung 4 returns the rung-4 result with overBudget: true,
//              never a silently dropped test or channel.

import {
  canonicalJson,
  formatLimitStopReason,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  CompletedRunHandoff,
  LimitStopEvidence,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  buildEvidencePacks,
  compactEvidencePacks,
  EVIDENCE_WINDOW_STEPS,
  QUOTE_FIELD_CAP,
} from '../evidence-diet.js'
import type {
  EvidenceHistoryLookup,
  EvidencePack,
  EvidenceTestHistory,
} from '../evidence-diet.js'
import { buildSyntheticHandoff } from './fixtures/synthetic-handoff.js'

const NO_HISTORY: EvidenceHistoryLookup = () => undefined

function historyOf(entries: readonly { buildOrdinal: number; passed: boolean }[]): EvidenceTestHistory {
  return {
    passes: entries.filter((entry) => entry.passed).length,
    failures: entries.filter((entry) => !entry.passed).length,
    heals: 0,
    flakeCount: 0,
    lastOutcomes: entries,
    lastBuildOrdinal: entries.at(-1)?.buildOrdinal,
  }
}

const byLength = (text: string): number => text.length

describe('buildEvidencePacks — the evidence diet', () => {
  it('windows the failing step ± EVIDENCE_WINDOW_STEPS with both flanks present', () => {
    const handoff = buildSyntheticHandoff({ passingStepsBefore: 3, passingStepsAfter: 3 })
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    expect(EVIDENCE_WINDOW_STEPS).toBe(2)
    expect(pack?.failingStepIndex).toBe(3)
    expect(pack?.steps.map((quote) => quote.stepIndex)).toEqual([1, 2, 3, 4, 5])
    expect(pack?.steps.map((quote) => quote.role)).toEqual([
      'neighbor',
      'neighbor',
      'failing',
      'neighbor',
      'neighbor',
    ])
  })

  it('clamps the window at the trajectory start: failing step at index 0', () => {
    const handoff = buildSyntheticHandoff({ passingStepsBefore: 0, passingStepsAfter: 4 })
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    expect(pack?.failingStepIndex).toBe(0)
    expect(pack?.steps.map((quote) => quote.stepIndex)).toEqual([0, 1, 2])
  })

  it('clamps the window at the trajectory end: failing step is the last step', () => {
    const handoff = buildSyntheticHandoff({ passingStepsBefore: 4, passingStepsAfter: 0 })
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    expect(pack?.failingStepIndex).toBe(4)
    expect(pack?.steps.map((quote) => quote.stepIndex)).toEqual([2, 3, 4])
  })

  it('falls back to the LAST step when no step carries a failed verifier verdict', () => {
    const handoff = buildSyntheticHandoff({ passingStepsBefore: 2 })
    const test = handoff.tests[0]
    if (test === undefined) throw new Error('fixture produced no test')
    const allPassing = {
      ...handoff,
      tests: [
        {
          ...test,
          steps: test.steps.map((step) => ({
            ...step,
            verifierVerdict: { pass: true, reasoning: 'passed on retry' },
          })),
        },
      ],
    }
    const [pack] = buildEvidencePacks(allPassing, [0], NO_HISTORY)
    expect(pack?.failingStepIndex).toBe(2)
  })

  it('quotes stepText, verifier reasoning, and each sub-action plan + result.error verbatim', () => {
    const handoff = buildSyntheticHandoff({})
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    const failing = pack?.steps.find((quote) => quote.role === 'failing')
    expect(failing?.stepText).toBe('click the Submit button')
    expect(failing?.verifierReasoning).toBe(
      'the submit button never appeared on the checkout screen',
    )
    expect(failing?.subActions).toEqual([
      { plan: 'click Submit', error: 'Error: element "Submit" not found' },
    ])
  })

  it('produces a test-level pack for a zero-step failure: outcome quoted, no fabricated step', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 1, steplessFailureCount: 1 })
    const [pack] = buildEvidencePacks(handoff, [1], NO_HISTORY)
    expect(pack?.testIndex).toBe(1)
    expect(pack?.failingStepIndex).toBeUndefined()
    expect(pack?.steps).toEqual([])
    expect(pack?.testLevelQuote).toBe('failed')
    expect(pack?.screenshotRefs).toEqual([])
    expect(pack?.memory).toEqual({ kind: 'no-failing-step' })
  })

  it('packs only the requested tests, in trajectory order', () => {
    const handoff = buildSyntheticHandoff({ failureCount: 3 })
    const packs = buildEvidencePacks(handoff, [2, 0], NO_HISTORY)
    expect(packs.map((pack) => pack.testIndex)).toEqual([0, 2])
  })

  it('collects the failing step decisionScreenshotRef entries deduped by sha', () => {
    const refs: ArtifactRef[] = [
      { id: 'shot-1', sha: 'sha-a' },
      { id: 'shot-2', sha: 'sha-a' },
      { id: 'shot-3', sha: 'sha-b' },
    ]
    const handoff = buildSyntheticHandoff({ decisionScreenshotRefs: refs })
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    expect(pack?.screenshotRefs).toEqual([
      { id: 'shot-1', sha: 'sha-a' },
      { id: 'shot-3', sha: 'sha-b' },
    ])
  })

  describe('forced channel 1 — the prior-build outcome', () => {
    it('keys the history lookup by filePath + testName, never testId', () => {
      const handoff = buildSyntheticHandoff({})
      const seen: unknown[] = []
      buildEvidencePacks(handoff, [0], (identity) => {
        seen.push(identity)
        return undefined
      })
      expect(seen).toEqual([{ filePath: 'tests/failed-0.yaml', testName: 'stepped failure 0' }])
    })

    it('states no-history as a typed absence when the lookup answers undefined', () => {
      const handoff = buildSyntheticHandoff({})
      const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
      expect(pack?.priorBuild).toEqual({ kind: 'no-history' })
    })

    it('selects the greatest ordinal STRICTLY below the current build, boundary-pinned both sides', () => {
      const entries = [
        { buildOrdinal: 3, passed: true },
        { buildOrdinal: 5, passed: false },
      ]
      const expectAt = (currentOrdinal: number, expected: EvidencePack['priorBuild']) => {
        const handoff = buildSyntheticHandoff({ buildOrdinal: currentOrdinal })
        const [pack] = buildEvidencePacks(handoff, [0], () => historyOf(entries))
        expect(pack?.priorBuild).toEqual(expected)
      }
      expectAt(6, { kind: 'prior-build', buildOrdinal: 5, passed: false })
      expectAt(5, { kind: 'prior-build', buildOrdinal: 3, passed: true })
      expectAt(4, { kind: 'prior-build', buildOrdinal: 3, passed: true })
      expectAt(3, { kind: 'no-prior-build' })
      expectAt(2, { kind: 'no-prior-build' })
    })
  })

  describe('forced channel 2 — servedBrief + retrieval trace', () => {
    it('carries the failing step servedBrief verbatim, with a typed no-trace absence', () => {
      const handoff = buildSyntheticHandoff({})
      const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
      const failingStep = handoff.tests[0]?.steps[0]
      expect(pack?.memory).toEqual({
        kind: 'served',
        servedBrief: failingStep?.servedBrief,
        retrievalTrace: undefined,
      })
      expect(pack?.memory.kind === 'served' && pack.memory.servedBrief.briefDigest).toBe(
        'synthetic-brief-digest',
      )
    })

    it('carries the serve-time retrieval trace verbatim when the step recorded one', () => {
      const trace: ServedRetrievalTraceV1 = {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId: 'rec-1', leg: 'lexical', rank: 1, score: 0.5 }],
        truncated: [{ recordId: 'rec-2', leg: 'dense', rank: 2, score: 0.25 }],
      }
      const handoff = buildSyntheticHandoff({ retrievalTrace: trace })
      const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
      expect(pack?.memory.kind === 'served' && pack.memory.retrievalTrace).toEqual(trace)
    })
  })
})

describe('compactEvidencePacks — the compaction ladder', () => {
  const LONG = 'x'.repeat(QUOTE_FIELD_CAP + 200)

  function ladderPacks(): EvidencePack[] {
    const handoff = buildSyntheticHandoff({
      failureCount: 1,
      steplessFailureCount: 1,
      passingStepsBefore: 3,
      passingStepsAfter: 3,
      evidenceText: `Error: ${LONG}`,
      verifierReasoning: `because ${LONG}`,
      decisionScreenshotRefs: [
        { id: 'shot-1', sha: 'sha-a' },
        { id: 'shot-2', sha: 'sha-b' },
      ],
      retrievalTrace: {
        schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId: 'rec-1', leg: 'anchor', rank: 1, score: 1.5 }],
        truncated: [],
      },
      buildOrdinal: 5,
    })
    return buildEvidencePacks(handoff, [0, 1], () =>
      historyOf([{ buildOrdinal: 4, passed: true }]),
    )
  }

  /** Walk the ladder rung by rung using each result's own estimate as the next budget. */
  function resultsAtEveryRung(packs: readonly EvidencePack[]) {
    const atRung0 = compactEvidencePacks(packs, byLength, Number.MAX_SAFE_INTEGER)
    const atRung1 = compactEvidencePacks(packs, byLength, atRung0.estimatedTokens - 1)
    const atRung2 = compactEvidencePacks(packs, byLength, atRung1.estimatedTokens - 1)
    const atRung3 = compactEvidencePacks(packs, byLength, atRung2.estimatedTokens - 1)
    const atRung4 = compactEvidencePacks(packs, byLength, atRung3.estimatedTokens - 1)
    return [atRung0, atRung1, atRung2, atRung3, atRung4] as const
  }

  it('fits at rung 0 untouched when the budget allows', () => {
    const packs = ladderPacks()
    const result = compactEvidencePacks(packs, byLength, Number.MAX_SAFE_INTEGER)
    expect(result.rung).toBe(0)
    expect(result.overBudget).toBe(false)
    expect(result.packs).toEqual(packs)
  })

  it('walks the pinned rungs in order, each strictly smaller than the last', () => {
    const results = resultsAtEveryRung(ladderPacks())
    expect(results.map((result) => result.rung)).toEqual([0, 1, 2, 3, 4])
    for (let index = 1; index < results.length; index += 1) {
      const current = results[index]
      const previous = results[index - 1]
      if (current === undefined || previous === undefined) throw new Error('missing rung')
      expect(current.estimatedTokens).toBeLessThan(previous.estimatedTokens)
      expect(current.overBudget).toBe(false)
    }
  })

  it('rung 1 strips screenshotRefs from every pack, text sections byte-identical', () => {
    const packs = ladderPacks()
    const [, atRung1] = resultsAtEveryRung(packs)
    for (const pack of atRung1.packs) expect(pack.screenshotRefs).toEqual([])
    expect(canonicalJson(atRung1.packs)).toBe(
      canonicalJson(packs.map((pack) => ({ ...pack, screenshotRefs: [] }))),
    )
  })

  it('rung 2 shrinks the neighbor window to ±1; rung 3 keeps only the whole failing step', () => {
    const packs = ladderPacks()
    const [, , atRung2, atRung3] = resultsAtEveryRung(packs)
    const steppedAt2 = atRung2.packs[0]
    expect(steppedAt2?.steps.map((quote) => quote.stepIndex)).toEqual([2, 3, 4])
    const steppedAt3 = atRung3.packs[0]
    expect(steppedAt3?.steps.map((quote) => quote.role)).toEqual(['failing'])
    // The failing step survives rung 3 WHOLE — byte-identical to its uncompacted quote.
    const originalFailing = packs[0]?.steps.find((quote) => quote.role === 'failing')
    expect(canonicalJson(steppedAt3?.steps[0])).toBe(canonicalJson(originalFailing))
    // Stripped refs are never re-introduced by a later rung.
    for (const result of [atRung2, atRung3]) {
      for (const pack of result.packs) expect(pack.screenshotRefs).toEqual([])
    }
  })

  it('rung 4 truncates per-field quote lengths to QUOTE_FIELD_CAP, failing step still present', () => {
    const packs = ladderPacks()
    const results = resultsAtEveryRung(packs)
    const atRung4 = results[4]
    const stepped = atRung4.packs[0]
    expect(stepped?.steps.map((quote) => quote.role)).toEqual(['failing'])
    const failing = stepped?.steps[0]
    expect(failing?.verifierReasoning.length).toBeLessThanOrEqual(QUOTE_FIELD_CAP)
    for (const subAction of failing?.subActions ?? []) {
      expect(subAction.plan.length).toBeLessThanOrEqual(QUOTE_FIELD_CAP)
      expect((subAction.error ?? '').length).toBeLessThanOrEqual(QUOTE_FIELD_CAP)
    }
    expect(failing?.stepText.length).toBeLessThanOrEqual(QUOTE_FIELD_CAP)
  })

  it('keeps BOTH forced channels canonicalJson-identical to the uncompacted pack at every rung', () => {
    const packs = ladderPacks()
    const results = resultsAtEveryRung(packs)
    for (const result of results) {
      expect(result.packs.length).toBe(packs.length)
      for (const [index, pack] of result.packs.entries()) {
        const original = packs[index]
        if (original === undefined) throw new Error('missing original pack')
        expect(canonicalJson(pack.priorBuild)).toBe(canonicalJson(original.priorBuild))
        expect(canonicalJson(pack.memory)).toBe(canonicalJson(original.memory))
      }
    }
  })

  it('returns the rung-4 result flagged overBudget when even rung 4 cannot fit — never drops a test', () => {
    const packs = ladderPacks()
    const result = compactEvidencePacks(packs, byLength, 1)
    expect(result.rung).toBe(4)
    expect(result.overBudget).toBe(true)
    expect(result.packs.length).toBe(packs.length)
    for (const pack of result.packs) {
      expect(pack.screenshotRefs).toEqual([])
      expect(pack.priorBuild).toEqual(packs[0]?.priorBuild)
    }
  })

  it('is deterministic: same packs, same estimator, same budget — same rung, same bytes', () => {
    const budget = compactEvidencePacks(ladderPacks(), byLength, Number.MAX_SAFE_INTEGER)
      .estimatedTokens - 1
    const first = compactEvidencePacks(ladderPacks(), byLength, budget)
    const second = compactEvidencePacks(ladderPacks(), byLength, budget)
    expect(second.rung).toBe(first.rung)
    expect(canonicalJson(second.packs)).toBe(canonicalJson(first.packs))
  })
})

// ---- 436 D-12: the limit block is quoted for any reader ----------------------------------

function withLimitStopOnFailingStep(
  handoff: CompletedRunHandoff,
  limitStop: LimitStopEvidence,
): CompletedRunHandoff {
  return {
    ...handoff,
    tests: handoff.tests.map((test) => ({
      ...test,
      steps: test.steps.map((step) => (step.verifierVerdict.pass ? step : { ...step, limitStop })),
    })),
  }
}

describe('evidence-diet — the limit stop quote', () => {
  const limitStop: LimitStopEvidence = {
    limit: 'actions',
    configured: 30,
    used: 30,
    reason: formatLimitStopReason('actions', 30, 30),
    requestedOutcome: 'unverified',
    lastVerifierRejection: 'the confirmation banner never appeared',
    lastPlannerReasoning: 'clicking Save again',
  }

  it('quoteStep carries limitStop with its reason truncated by the existing rule', () => {
    const handoff = withLimitStopOnFailingStep(
      buildSyntheticHandoff({ passingStepsBefore: 1 }),
      limitStop,
    )
    const [pack] = buildEvidencePacks(handoff, [0], NO_HISTORY)
    const failing = pack?.steps.find((quote) => quote.role === 'failing')
    const neighbor = pack?.steps.find((quote) => quote.role === 'neighbor')
    expect(failing?.limitStop?.reason).toBe(limitStop.reason)
    expect(failing?.limitStop).toEqual(limitStop)
    expect(neighbor !== undefined && 'limitStop' in neighbor).toBe(false)

    const long = 'y'.repeat(QUOTE_FIELD_CAP + 50)
    const longHandoff = withLimitStopOnFailingStep(buildSyntheticHandoff(), {
      ...limitStop,
      reason: long,
    })
    const compacted = compactEvidencePacks(
      buildEvidencePacks(longHandoff, [0], NO_HISTORY),
      byLength,
      1,
    )
    expect(compacted.rung).toBe(4)
    const quoted = compacted.packs[0]?.steps.find((quote) => quote.role === 'failing')?.limitStop
    expect(quoted).toEqual({ ...limitStop, reason: long.slice(0, QUOTE_FIELD_CAP) })
  })
})
