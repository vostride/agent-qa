// The low-trust records on a verdict's failing path are recomputed from the run's own briefs.

import { describe, expect, it } from 'vitest'

import type { BriefLine, ServedBrief } from '../../brief/served-brief'
import type { CompletedRunHandoff } from '../../handoff/completed-run-handoff'
import type { PerTestOutcome } from '../../handoff/per-test-outcome'
import type { StepEvidence } from '../../handoff/step-evidence'
import { asRecordId } from '../../ids/record-id'
import { asRef } from '../../primitives/ref'
import { asRunId } from '../../run/run-id'
import { CURRENT_ANALYSIS_SCHEMA_VERSION } from '../analysis-artifact'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../../handoff/completed-run-handoff'
import type { RunAnalysisArtifact } from '../analysis-artifact'
import { deriveMemoryOnPath, deriveMemoryOnPathSites } from '../memory-on-path'
import type { VerdictSentenceParts } from '../sentence-parts'
import { validateAnalysisAgainstHandoff } from '../validate-analysis'
import type { Verdict } from '../verdict'

// test 0: a clean step, then a failing step served a candidate record
// test 1: the failing step served two candidates, one of them as a canary
// test 2: the verdict cites the clean step only; the failing step carried a candidate
// test 3: no low-trust memory anywhere
// test 4: one record served on two steps

const CANDIDATE_RECORD = asRecordId('rec_mem_candidate')
const CANARY_RECORD = asRecordId('rec_mem_canary')
const CLEAN_RECORD = asRecordId('rec_mem_clean')

const STEP_TEXT = 'click the Submit button on the checkout screen'
const VERIFIER_REASONING = 'the submit button never appeared on the checkout screen'
const SUB_ACTION_PLAN = 'click the Submit button now that the cart is full'
const SUB_ACTION_ERROR = 'Error: element "Submit" not found after 3 grounding attempts'

function briefLine(overrides: Partial<BriefLine> = {}): BriefLine {
  return {
    id: CLEAN_RECORD,
    kind: 'fact',
    summary: 'the checkout form autosaves',
    trust: 0.9,
    status: 'active',
    servedAsCanary: false,
    tier: 'L2',
    ...overrides,
  }
}

const candidateLine = (): BriefLine =>
  briefLine({ id: CANDIDATE_RECORD, status: 'candidate', trust: 0.4 })
const canaryLine = (): BriefLine =>
  briefLine({ id: CANARY_RECORD, status: 'candidate', servedAsCanary: true, trust: 0.5 })

function servedBrief(lines: BriefLine[], briefDigest = 'brief-digest-1'): ServedBrief {
  return {
    scope: { tier: 'product', key: 'memory-on-path' },
    asOfBuild: 1,
    budget: 0,
    truncation: 'none',
    channel1: lines,
    channel2: [],
    channel3: [],
    briefDigest,
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

function passingStep(stepIndex: number, brief: ServedBrief): StepEvidence {
  return {
    stepIndex,
    stepText: `neighbor step ${stepIndex}`,
    cacheStatus: 'miss',
    servedBrief: brief,
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
  }
}

function buildHandoff(): CompletedRunHandoff {
  const tests: PerTestOutcome[] = [
    {
      testId: 't_candidate',
      testName: 'candidate memory on the failing step',
      filePath: 'tests/candidate.yaml',
      testIndex: 0,
      outcome: 'failed',
      steps: [
        passingStep(0, servedBrief([briefLine()], 'brief-digest-clean')),
        failingStep(1, servedBrief([briefLine(), candidateLine()], 'brief-digest-1')),
      ],
    },
    {
      testId: 't_two_records',
      testName: 'two candidate records on the failing step',
      filePath: 'tests/two-records.yaml',
      testIndex: 1,
      outcome: 'failed',
      steps: [failingStep(0, servedBrief([candidateLine(), canaryLine()], 'brief-digest-2'))],
    },
    {
      testId: 't_citation_dodge',
      testName: 'the verdict cites the clean step only',
      filePath: 'tests/citation-dodge.yaml',
      testIndex: 2,
      outcome: 'failed',
      steps: [
        passingStep(0, servedBrief([briefLine()], 'brief-digest-clean')),
        failingStep(1, servedBrief([candidateLine()], 'brief-digest-3')),
      ],
    },
    {
      testId: 't_clean',
      testName: 'no low-trust memory anywhere',
      filePath: 'tests/clean.yaml',
      testIndex: 3,
      outcome: 'failed',
      steps: [failingStep(0, servedBrief([briefLine()], 'brief-digest-clean'))],
    },
    {
      testId: 't_twice',
      testName: 'one record served on two steps',
      filePath: 'tests/twice.yaml',
      testIndex: 4,
      outcome: 'failed',
      steps: [
        passingStep(0, servedBrief([candidateLine()], 'brief-digest-4a')),
        failingStep(1, servedBrief([candidateLine(), canaryLine()], 'brief-digest-4b')),
      ],
    },
  ]
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-memory-on-path'),
    scope: { tier: 'product', key: 'memory-on-path' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1,
    endedAt: 2,
    tests,
  }
}

const HANDOFF = buildHandoff()

function testAt(perTest: number): PerTestOutcome {
  const test = HANDOFF.tests[perTest]
  if (test === undefined) throw new Error(`fixture has no test ${perTest}`)
  return test
}

function verdictFor(perTest: number, overrides: Partial<Verdict> = {}): Verdict {
  return {
    class: 'app_bug',
    producer: 'analyze-run',
    confidence: 0.9,
    evidence: {
      citedSteps: perTest === 0 || perTest === 2 ? [1] : [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'advisory self-trace, never the sentence',
    },
    memoryMisdirectionRuledOut: true,
    perTest,
    ...overrides,
  } as Verdict
}

function partsFor(
  perTest: number,
  overrides: Partial<VerdictSentenceParts> = {},
): VerdictSentenceParts {
  return {
    perTest,
    groundingQuote: {
      stepIndex: perTest === 0 || perTest === 2 ? 1 : 0,
      quote: SUB_ACTION_ERROR,
    },
    discriminator: 'the same step passed on the previous build',
    nextAction: 'file the failure against the application with the quoted evidence',
    links: ['agentqa://memory/MEM-001'],
    ...overrides,
  }
}

function artifactOf(verdicts: Verdict[], parts: VerdictSentenceParts[]): RunAnalysisArtifact {
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId: 'run-memory-on-path',
    verdicts,
    parts,
  }
}

function reasonsOf(result_: ReturnType<typeof validateAnalysisAgainstHandoff>): string[] {
  if (result_.ok) return []
  return result_.rejects.map((reject) => reject.reason)
}

describe('deriveMemoryOnPath', () => {
  it('names the candidate record served on the failing step, and only it', () => {
    expect(deriveMemoryOnPath(testAt(0).steps)).toEqual([
      { recordId: CANDIDATE_RECORD, trust: 'candidate' },
    ])
  })

  it('names every candidate on the failing step, including one served as a canary', () => {
    expect(deriveMemoryOnPath(testAt(1).steps)).toEqual([
      { recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { recordId: CANARY_RECORD, trust: 'candidate' },
    ])
  })

  it('derives nothing from a brief that served only established memory', () => {
    expect(deriveMemoryOnPath(testAt(3).steps)).toEqual([])
  })

  it('keeps the step each exposure happened on', () => {
    expect(deriveMemoryOnPathSites(testAt(1).steps)).toEqual([
      { stepIndex: 0, recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { stepIndex: 0, recordId: CANARY_RECORD, trust: 'candidate' },
    ])
  })

  it('records both exposures of a record served on two steps', () => {
    expect(deriveMemoryOnPathSites(testAt(4).steps)).toEqual([
      { stepIndex: 0, recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { stepIndex: 1, recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { stepIndex: 1, recordId: CANARY_RECORD, trust: 'candidate' },
    ])
  })

  it('folds the two exposures to one record-level entry', () => {
    expect(deriveMemoryOnPath(testAt(4).steps)).toEqual([
      { recordId: CANDIDATE_RECORD, trust: 'candidate' },
      { recordId: CANARY_RECORD, trust: 'candidate' },
    ])
  })
})

describe('validateAnalysisAgainstHandoff: memoryOnPath cannot be forged or omitted', () => {
  it('accepts a verdict whose declared memoryOnPath matches recomputation', () => {
    const artifact = artifactOf(
      [verdictFor(0, { memoryOnPath: [{ recordId: CANDIDATE_RECORD, trust: 'candidate' }] })],
      [partsFor(0)],
    )
    expect(validateAnalysisAgainstHandoff(artifact, HANDOFF)).toEqual({ ok: true })
  })

  it('rejects a verdict that declares an empty memoryOnPath over a served candidate', () => {
    const artifact = artifactOf([verdictFor(0, { memoryOnPath: [] })], [partsFor(0)])
    expect(reasonsOf(validateAnalysisAgainstHandoff(artifact, HANDOFF)).join('\n')).toContain(
      'memoryOnPath',
    )
  })

  it('rejects a verdict that declares a trust word the briefs did not record', () => {
    const artifact = artifactOf(
      [verdictFor(0, { memoryOnPath: [{ recordId: CANDIDATE_RECORD, trust: 'established' as never }] })],
      [partsFor(0)],
    )
    expect(validateAnalysisAgainstHandoff(artifact, HANDOFF).ok).toBe(false)
  })

  it('gates a verdict that cites only the clean step while the actual failing step carried memory', () => {
    const artifact = artifactOf(
      [
        verdictFor(2, {
          memoryMisdirectionRuledOut: false,
          evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [], rationale: 'r' },
        }),
      ],
      [partsFor(2, { groundingQuote: { stepIndex: 0, quote: 'neighbor step 0' } })],
    )
    expect(validateAnalysisAgainstHandoff(artifact, HANDOFF).ok).toBe(false)
  })
})
