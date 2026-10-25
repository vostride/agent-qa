// The cross-document analysis boundary (Phase 389, plan 04 — D-05/D-07, spec §A9).
//
// `validateAnalysisAgainstHandoff` is what makes "a sentence a QA engineer believes"
// CHECKABLE: an authored artifact validates against the run's own handoff — every cited
// step must exist, every grounding quote must be verbatim-present in that step's captured
// evidence, every class must be a member of the closed union, every link must parse, and a
// no-trust-change class must have honestly ruled memory misdirection out when candidate or
// low-trust memory was on the failing path. Rejects are PER TEST so one confused answer
// never fails its siblings, and the reason strings feed the D-03 repair message verbatim.

import { describe, expect, it } from 'vitest'

import type { BriefLine, ServedBrief } from '../../brief/served-brief'
import { canonicalJson } from '../../determinism/canonical-json'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../../handoff/completed-run-handoff'
import type { CompletedRunHandoff } from '../../handoff/completed-run-handoff'
import type { PerTestOutcome } from '../../handoff/per-test-outcome'
import type { StepEvidence } from '../../handoff/step-evidence'
import { asRecordId } from '../../ids/record-id'
import { asRef } from '../../primitives/ref'
import { asRunId } from '../../run/run-id'
import { CURRENT_ANALYSIS_SCHEMA_VERSION, guardRunAnalysisArtifact } from '../analysis-artifact'
import type { RunAnalysisArtifact } from '../analysis-artifact'
import type { VerdictSentenceParts } from '../sentence-parts'
import type { Verdict } from '../verdict'
import {
  QUOTE_SEARCHED_STEP_FIELDS,
  QUOTE_SEARCHED_TEST_OUTCOME_FIELDS,
  searchedQuoteTexts,
  searchedTestOutcomeTexts,
  validateAnalysisAgainstHandoff,
} from '../validate-analysis'

// ---------------------------------------------------------------------------------------
// Fixture: one handoff, three member tests.
//   test 0  stepped failure — a passing step then a failing step carrying EVERY searched
//           field, served a clean (active, non-canary) brief
//   test 1  zero-step failure — the suite-bootstrap posture
//   test 2  stepped failure whose failing step was served CANDIDATE memory
// ---------------------------------------------------------------------------------------

const STEP_TEXT = 'click the Submit button on the checkout screen'
const VERIFIER_REASONING = 'the submit button never appeared on the checkout screen'
const SUB_ACTION_PLAN = 'click the Submit button now that the cart is full'
const SUB_ACTION_ERROR = 'Error: element "Submit" not found after 3 grounding attempts'

const REPORTED_VALUE = { value: 'the cart badge reads 3 items' }
const AI_JUDGMENT = {
  verb: 'assertAI',
  verdict: false,
  rationale: 'the confirmation banner is absent from the rendered page',
} as const
const ASSERT_OUTCOME = {
  source: 'url',
  op: 'equals',
  expected: '/checkout/complete',
  actual: '/checkout',
  passed: false,
} as const
const TERMINATION = {
  kind: 'infeasible',
  reason: 'the flow cannot proceed past the payment form',
} as const

function briefLine(overrides: Partial<BriefLine> = {}): BriefLine {
  return {
    id: asRecordId('rec_mem_001'),
    kind: 'fact',
    summary: 'the checkout form autosaves',
    trust: 0.9,
    status: 'active',
    servedAsCanary: false,
    tier: 'L2',
    ...overrides,
  }
}

function servedBrief(lines: BriefLine[]): ServedBrief {
  return {
    scope: { tier: 'product', key: 'validate-analysis' },
    asOfBuild: 1,
    budget: 0,
    truncation: 'none',
    channel1: lines,
    channel2: [],
    channel3: [],
    briefDigest: 'validate-analysis-brief-digest',
  }
}

function passingStep(stepIndex: number): StepEvidence {
  return {
    stepIndex,
    stepText: `neighbor step ${stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: servedBrief([briefLine()]),
    subActions: [
      {
        plan: `observe step ${stepIndex}`,
        plannedAction: { type: 'click', ref: asRef('e1') },
        stateBefore: screenState(),
        result: { success: true },
      },
    ],
    verifierVerdict: { pass: true, reasoning: `neighbor step ${stepIndex} verified` },
  }
}

function screenState() {
  return {
    platform: 'web' as const,
    tree: '',
    elements: [],
    refMap: {},
    url: '/checkout',
    timestamp: 1,
    metadata: {
      coordSpace: 'viewport' as const,
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
      captureMode: 'textOnly' as const,
    },
  }
}

function failingStep(stepIndex: number, brief: ServedBrief): StepEvidence {
  return {
    stepIndex,
    stepText: STEP_TEXT,
    cacheStatus: 'miss',
    servedBrief: brief,
    subActions: [
      {
        plan: SUB_ACTION_PLAN,
        plannedAction: { type: 'click', ref: asRef('e1') },
        stateBefore: screenState(),
        result: { success: false, error: SUB_ACTION_ERROR },
      },
    ],
    verifierVerdict: { pass: false, reasoning: VERIFIER_REASONING },
    reportedValue: REPORTED_VALUE,
    aiJudgment: AI_JUDGMENT,
    assertOutcome: ASSERT_OUTCOME,
    termination: TERMINATION,
  }
}

function buildHandoff(): CompletedRunHandoff {
  const tests: PerTestOutcome[] = [
    {
      testId: 't_stepped',
      testName: 'stepped failure',
      filePath: 'tests/stepped.yaml',
      testIndex: 0,
      outcome: 'failed',
      steps: [passingStep(0), failingStep(1, servedBrief([briefLine()]))],
    },
    {
      testId: 't_stepless',
      testName: 'step-less failure',
      filePath: 'tests/stepless.yaml',
      testIndex: 1,
      outcome: 'failed',
      steps: [],
    },
    {
      testId: 't_candidate_memory',
      testName: 'failure with candidate memory on the path',
      filePath: 'tests/candidate.yaml',
      testIndex: 2,
      outcome: 'failed',
      steps: [failingStep(0, servedBrief([briefLine({ status: 'candidate', trust: 0.4 })]))],
    },
  ]
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-validate-analysis'),
    scope: { tier: 'product', key: 'validate-analysis' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests,
  }
}

function verdictFor(perTest: number, overrides: Partial<Verdict> = {}): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: perTest === 1 ? [] : perTest === 2 ? [0] : [1],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'advisory self-trace, never the sentence',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
    ...overrides,
  } as Verdict
}

function partsFor(perTest: number, overrides: Partial<VerdictSentenceParts> = {}): VerdictSentenceParts {
  return {
    perTest,
    groundingQuote:
      perTest === 1
        ? { source: 'test-outcome', quote: 'failed' }
        : perTest === 2
          ? { stepIndex: 0, quote: SUB_ACTION_ERROR }
          : { stepIndex: 1, quote: SUB_ACTION_ERROR },
    discriminator: 'the same step passed on the previous build',
    nextAction: 'file the failure against the application with the quoted evidence',
    links: ['agentqa://memory/MEM-001'],
    ...overrides,
  }
}

function artifactOf(
  verdicts: Verdict[],
  parts: VerdictSentenceParts[],
): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId: 'run-validate-analysis',
    verdicts,
    parts,
  }
}

function fullValidArtifact(): RunAnalysisArtifact {
  return artifactOf(
    [verdictFor(0), verdictFor(1), verdictFor(2)],
    [partsFor(0), partsFor(1), partsFor(2)],
  )
}

function rejectsOf(result: ReturnType<typeof validateAnalysisAgainstHandoff>) {
  if (result.ok) throw new Error('expected a rejecting result')
  return result.rejects
}

describe('validateAnalysisAgainstHandoff: the accept side', () => {
  const handoff = buildHandoff()

  it('accepts a valid artifact against its handoff', () => {
    expect(validateAnalysisAgainstHandoff(fullValidArtifact(), handoff)).toEqual({ ok: true })
  })

  it('pins the searched set as an exported constant', () => {
    expect(QUOTE_SEARCHED_STEP_FIELDS).toEqual([
      'stepText',
      'verifierVerdict.reasoning',
      'subActions[].plan',
      'subActions[].result.error',
      'canonicalJson(reportedValue)',
      'canonicalJson(aiJudgment)',
      'canonicalJson(assertOutcome)',
      'canonicalJson(termination)',
    ])
    expect(QUOTE_SEARCHED_TEST_OUTCOME_FIELDS).toEqual(['outcome'])
  })

  it('searches exactly the pinned fields, in the pinned order', () => {
    const step = failingStep(1, servedBrief([briefLine()]))
    expect(searchedQuoteTexts(step)).toEqual([
      STEP_TEXT,
      VERIFIER_REASONING,
      SUB_ACTION_PLAN,
      SUB_ACTION_ERROR,
      canonicalJson(REPORTED_VALUE),
      canonicalJson(AI_JUDGMENT),
      canonicalJson(ASSERT_OUTCOME),
      canonicalJson(TERMINATION),
    ])
    expect(searchedTestOutcomeTexts(buildHandoff().tests[1] as PerTestOutcome)).toEqual([
      'failed',
    ])
  })

  it('accepts a quote drawn from EACH searched field — one accept case per member', () => {
    const step = failingStep(1, servedBrief([briefLine()]))
    const texts = searchedQuoteTexts(step)
    expect(texts).toHaveLength(QUOTE_SEARCHED_STEP_FIELDS.length)
    for (const text of texts) {
      const artifact = artifactOf(
        [verdictFor(0)],
        [partsFor(0, { groundingQuote: { stepIndex: 1, quote: text } })],
      )
      expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
    }
  })

  it('accepts a contiguous substring of a searched field, not only the whole field', () => {
    const artifact = artifactOf(
      [verdictFor(0)],
      [partsFor(0, { groundingQuote: { stepIndex: 1, quote: 'element "Submit" not found' } })],
    )
    expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
  })

  it('accepts confidence exactly 0 and exactly 1 — the closed interval boundary', () => {
    for (const confidence of [0, 1]) {
      const artifact = artifactOf([verdictFor(0, { confidence })], [partsFor(0)])
      expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
    }
  })
})

describe('validateAnalysisAgainstHandoff: per-test rejects, each with a named reason', () => {
  const handoff = buildHandoff()

  it('rejects a citedSteps index with no matching StepEvidence, naming the bad ref', () => {
    const artifact = artifactOf(
      [verdictFor(0, { evidence: { ...verdictFor(0).evidence, citedSteps: [1, 7] } })],
      [partsFor(0)],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects).toHaveLength(1)
    expect(rejects[0]?.perTest).toBe(0)
    expect(rejects[0]?.reason).toContain('citedSteps')
    expect(rejects[0]?.reason).toContain('7')
  })

  it('rejects a verdict whose perTest names no member test in the handoff', () => {
    const artifact = artifactOf([verdictFor(9)], [partsFor(9)])
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.perTest).toBe(9)
    expect(rejects[0]?.reason).toContain('no member test')
  })

  it('rejects the anti-hallucination near-miss: one word changed in a real quote', () => {
    // The verifier said "checkout screen"; the invented observation says "checkout page".
    const nearMiss = 'the submit button never appeared on the checkout page'
    const artifact = artifactOf(
      [verdictFor(0)],
      [partsFor(0, { groundingQuote: { stepIndex: 1, quote: nearMiss } })],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.perTest).toBe(0)
    expect(rejects[0]?.reason).toContain('quote not found')
  })

  it('rejects a groundingQuote citing a step the test never captured', () => {
    const artifact = artifactOf(
      [verdictFor(0)],
      [partsFor(0, { groundingQuote: { stepIndex: 5, quote: SUB_ACTION_ERROR } })],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.reason).toContain('5')
  })

  it('rejects an empty quote — a sentence must quote captured evidence', () => {
    const artifact = artifactOf(
      [verdictFor(0)],
      [partsFor(0, { groundingQuote: { stepIndex: 1, quote: '' } })],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.perTest).toBe(0)
  })

  it('zero-step test: accepts the test-outcome quote, rejects one not present in the outcome', () => {
    const good = artifactOf(
      [verdictFor(1)],
      [partsFor(1, { groundingQuote: { source: 'test-outcome', quote: 'failed' } })],
    )
    expect(validateAnalysisAgainstHandoff(good, handoff)).toEqual({ ok: true })

    const bad = artifactOf(
      [verdictFor(1)],
      [partsFor(1, { groundingQuote: { source: 'test-outcome', quote: 'crashed' } })],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(bad, handoff))
    expect(rejects[0]?.perTest).toBe(1)
    expect(rejects[0]?.reason).toContain('quote not found')
  })

  it('zero-step test: rejects a stepIndex-bearing quote — the step does not exist', () => {
    const artifact = artifactOf(
      [verdictFor(1)],
      [partsFor(1, { groundingQuote: { stepIndex: 0, quote: 'failed' } })],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.perTest).toBe(1)
    expect(rejects[0]?.reason).toContain('zero steps')
  })

  it('rejects a class string outside the closed union, naming the class', () => {
    const artifact = artifactOf(
      [verdictFor(0, { class: 'browser_bug' } as unknown as Partial<Verdict>)],
      [partsFor(0)],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.reason).toContain('browser_bug')
  })

  it('rejects confidence one step either side of the closed interval — never clamps', () => {
    for (const confidence of [-0.1, 1.0000001]) {
      const artifact = artifactOf([verdictFor(0, { confidence })], [partsFor(0)])
      const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
      expect(rejects[0]?.perTest).toBe(0)
      expect(rejects[0]?.reason).toContain('confidence')
    }
  })

  it('rejects an unparseable agentqa:// link through the one URI codec', () => {
    for (const link of ['not-a-uri', 'agentqa://MEMORY/mem-001']) {
      const artifact = artifactOf([verdictFor(0)], [partsFor(0, { links: [link] })])
      const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
      expect(rejects[0]?.perTest).toBe(0)
      expect(rejects[0]?.reason).toContain(link)
    }
  })

  it('rejects a verdict with no sentence-parts record joining it by perTest', () => {
    const artifact = artifactOf([verdictFor(0)], [])
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects[0]?.perTest).toBe(0)
    expect(rejects[0]?.reason).toContain('parts')
  })
})

describe('the §A9 memory-misdirection rule (spec memory.md §7.2)', () => {
  const handoff = buildHandoff()

  it('rejects a no-trust-change class that did not rule misdirection out over candidate memory', () => {
    for (const cls of ['app_bug', 'flake', 'environment', 'config_error'] as const) {
      const artifact = artifactOf(
        [verdictFor(2, { class: cls, memoryMisdirectionRuledOut: false } as Partial<Verdict>)],
        [partsFor(2)],
      )
      const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
      expect(rejects[0]?.perTest).toBe(2)
      expect(rejects[0]?.reason).toContain('memoryMisdirectionRuledOut')
    }
  })

  it('accepts the same classes once memoryMisdirectionRuledOut is true', () => {
    const artifact = artifactOf(
      [verdictFor(2, { class: 'flake', memoryMisdirectionRuledOut: true } as Partial<Verdict>)],
      [partsFor(2)],
    )
    expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
  })

  it('does not demand the flag for classes that DO move trust (test_bug, llm_error, unknown, timeout)', () => {
    for (const cls of ['test_bug', 'llm_error', 'unknown', 'timeout'] as const) {
      const artifact = artifactOf(
        [verdictFor(2, { class: cls, memoryMisdirectionRuledOut: false } as Partial<Verdict>)],
        [partsFor(2)],
      )
      expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
    }
  })

  it('does not demand the flag when the cited step served no candidate/low-trust memory', () => {
    const artifact = artifactOf(
      [verdictFor(0, { memoryMisdirectionRuledOut: false })],
      [partsFor(0)],
    )
    expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })
  })
})

describe('per-test granularity: one bad test never fails its siblings', () => {
  const handoff = buildHandoff()

  it('rejects only the failing test and keeps the valid siblings out of the reject list', () => {
    const artifact = artifactOf(
      [verdictFor(0), verdictFor(1), verdictFor(2)],
      [
        partsFor(0),
        partsFor(1, { groundingQuote: { source: 'test-outcome', quote: 'an invented outcome' } }),
        partsFor(2),
      ],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects.map((reject) => reject.perTest)).toEqual([1])
  })

  it('collects every reason for one test rather than stopping at the first', () => {
    const artifact = artifactOf(
      [
        verdictFor(0, {
          confidence: 2,
          evidence: { ...verdictFor(0).evidence, citedSteps: [9] },
        }),
      ],
      [partsFor(0)],
    )
    const rejects = rejectsOf(validateAnalysisAgainstHandoff(artifact, handoff))
    expect(rejects.length).toBeGreaterThanOrEqual(2)
    expect(rejects.every((reject) => reject.perTest === 0)).toBe(true)
  })
})

describe('perTest uniqueness ownership (WR-02 / G-389-3B): the guard owns it, not this boundary', () => {
  const handoff = buildHandoff()

  it('WR-02 non-owner pin: a duplicate-perTest artifact this validator does not re-check is refused upstream by guardRunAnalysisArtifact', () => {
    // Two verdicts for perTest 0 with CONTRADICTING classes, each of which validates
    // independently against the handoff — so this boundary answers ok BY DESIGN: it is the
    // two-document check, and duplicate perTest is a one-document structural property owned
    // by the artifact guard. This case is the executable pin that the read boundary upstream
    // refuses the very bytes this boundary does not re-check: delete the guard's uniqueness
    // rule and this case reds HERE, inside the non-owner's own suite.
    const artifact = artifactOf(
      [verdictFor(0, { class: 'unknown' } as Partial<Verdict>), verdictFor(0)],
      [partsFor(0)],
    )
    expect(validateAnalysisAgainstHandoff(artifact, handoff)).toEqual({ ok: true })

    const storedBytes: unknown = JSON.parse(canonicalJson(artifact))
    expect(() => guardRunAnalysisArtifact(storedBytes)).toThrowError(
      new TypeError('RunAnalysisArtifact failed structural validation'),
    )
  })
})
