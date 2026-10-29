// Digests evidence with and without the trace, so `servedBrief` byte-stability is measured.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeBriefDigest,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  guardCompletedRunHandoff,
  ServedRetrievalTraceV1Schema,
  TRACE_TRUNCATION_TOP_K,
  asRecordId,
  type BriefBlock,
  type CautionLine,
  type MemberTestOutcome,
  type RunId,
  type ScopeKey,
  type ServedRetrievalTraceV1,
  type TraceLine,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { EvidenceRecorder } from '../loop/evidence.js'
import { assembleHandoff, assemblePerTestOutcome } from '../run/handoff-assembly.js'
import type { RunConfig, RunMemberDescriptor } from '../run/ports.js'
import type { TestResult } from '../result.js'

const scope: ScopeKey = { tier: 'test', key: 'checkout' }
const passVerdict = { pass: true, reasoning: 'done' } as const

function line(recordId: string, rank: number, score = 1): TraceLine {
  return { recordId, leg: 'anchor', rank, score }
}

function trace(
  servedLines: readonly TraceLine[],
  truncated: readonly TraceLine[] = [],
): ServedRetrievalTraceV1 {
  return { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [...servedLines], truncated: [...truncated] }
}

function block(ids: readonly string[]): BriefBlock {
  return {
    tiers: { L0: 'policy', L1: 'learned', L2: '' },
    lines: ids.map((id) => ({
      id: asRecordId(id),
      kind: 'fact',
      summary: `${id} summary`,
      trust: 0.9,
      status: 'active',
      servedAsCanary: false,
      tier: 'L1',
    })),
    truncation: '',
    admissions: [],
  }
}

function cautionLine(id: string): CautionLine {
  return { id: asRecordId(id), anchors: [], summary: `${id} caution` }
}

describe('StepEvidence carries the serve-time trace beside servedBrief', () => {
  it('persists the exact attributions the reader returned', () => {
    const recorder = new EvidenceRecorder()
    const served = trace(
      [line('fact-a', 1, 0.9), line('fact-b', 2, 0.7)],
      [line('fact-c', 3, 0.5)],
    )
    recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['fact-a', 'fact-b']),
      trace: served,
    })

    const evidence = recorder.finalize(passVerdict, 0, 'checkout')

    expect(evidence.retrievalTrace).toEqual(served)
    // Beside, not inside: the brief's own channels are untouched by the trace.
    expect(evidence.servedBrief.channel1.map(({ id }) => String(id)))
      .toEqual(['fact-a', 'fact-b'])
    expect('retrievalTrace' in evidence.servedBrief).toBe(false)
    expect(ServedRetrievalTraceV1Schema.safeParse(evidence.retrievalTrace).success).toBe(true)
  })

  it('leaves the trace ABSENT when no reader served the step (an honest no-trace)', () => {
    const evidence = new EvidenceRecorder({ scope, asOfBuild: 7 })
      .finalize(passVerdict, 0, 'checkout')

    // Absence means "no reader was bound", never "a trace was lost". The key is absent, not
    // undefined-valued, so the persisted JSON says nothing rather than saying null.
    expect('retrievalTrace' in evidence).toBe(false)
    expect(JSON.parse(JSON.stringify(evidence))).not.toHaveProperty('retrievalTrace')
  })

  it('leaves the ServedBrief bytes and its digest identical with and without a trace', () => {
    const briefBlock = block(['fact-a', 'fact-b'])
    const withTrace = new EvidenceRecorder()
    withTrace.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: briefBlock,
      trace: trace([line('fact-a', 1), line('fact-b', 2)], [line('fact-c', 3)]),
    })
    const without = new EvidenceRecorder()
    without.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: briefBlock,
      trace: trace([]),
    })

    const traced = withTrace.finalize(passVerdict, 0, 'checkout')
    const plain = without.finalize(passVerdict, 0, 'checkout')

    // The corpus is deliberately NOT two empty briefs: a digest comparison between two empty
    // things is true for the wrong reason. This trace is non-empty and the brief has lines.
    expect(traced.retrievalTrace!.servedLines).toHaveLength(2)
    expect(traced.retrievalTrace!.truncated).toHaveLength(1)

    expect(JSON.stringify(traced.servedBrief)).toBe(JSON.stringify(plain.servedBrief))
    expect(traced.servedBrief.briefDigest).toBe(plain.servedBrief.briefDigest)
    // And the digest is genuinely the content digest of exactly this brief — a recomputation
    // over the trace-carrying value produces the same address.
    expect(computeBriefDigest({ ...traced.servedBrief, briefDigest: '' }))
      .toBe(traced.servedBrief.briefDigest)
  })

  it('carries the serve-time trace unchanged when a step replans against the same brief', () => {
    // A step replans more than once and re-reads the SAME frozen Channel-1 block. The recorder
    // must replace the Channel-1 attributions rather than append them, exactly as `servedBrief`
    // itself re-projects channel1 while preserving channel2/channel3.
    const recorder = new EvidenceRecorder()
    const served = trace([line('fact-a', 1, 0.9)], [line('fact-c', 2, 0.5)])
    const record = (): void => recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['fact-a']),
      trace: served,
    })

    record()
    const afterOne = recorder.finalize(passVerdict, 0, 'checkout').retrievalTrace
    record()
    record()
    const afterThree = recorder.finalize(passVerdict, 0, 'checkout').retrievalTrace

    expect(afterThree).toEqual(afterOne)
    expect(afterThree!.servedLines).toHaveLength(1)
    expect(afterThree!.truncated).toHaveLength(1)
  })

  it('records only the cautions the turn actually injected, cutting the refused ones', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['fact-a']),
      trace: trace([line('fact-a', 1)]),
    })
    // The reader ranked three cautions and cut a fourth; the loop's own record ledger then
    // refused one of the three, so only two were rendered into the turn.
    recorder.recordServedCautions(
      [cautionLine('caution-1'), cautionLine('caution-2')],
      trace(
        [line('caution-1', 1), line('caution-2', 2), line('caution-3', 3)],
        [line('caution-4', 4)],
      ),
    )

    const evidence = recorder.finalize(passVerdict, 0, 'checkout')

    expect(evidence.retrievalTrace!.servedLines.map(({ recordId }) => recordId))
      .toEqual(['fact-a', 'caution-1', 'caution-2'])
    // The refused caution is a CUT candidate, not a served line: the trace must not claim a
    // record the planner never saw, and must not forget it either.
    expect(evidence.retrievalTrace!.truncated.map(({ recordId }) => recordId))
      .toEqual(['caution-3', 'caution-4'])
  })

  it('bounds the folded truncation ledger at the pinned top-K across channels', () => {
    const recorder = new EvidenceRecorder()
    const channel1Cuts = Array.from(
      { length: TRACE_TRUNCATION_TOP_K },
      (_unused, index) => line(`brief-cut-${index}`, index + 1),
    )
    recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['fact-a']),
      trace: trace([line('fact-a', 1)], channel1Cuts),
    })
    recorder.recordServedCautions(
      [cautionLine('caution-1')],
      trace([line('caution-1', 1)], [line('caution-cut', 2)]),
    )

    const folded = recorder.finalize(passVerdict, 0, 'checkout').retrievalTrace!

    // Exactly K + 1 cut candidates were handed in, and exactly K survive — the boundary, not
    // "a lot". Channel-1 cuts take precedence, so the caution cut is the one dropped.
    expect(folded.truncated).toHaveLength(TRACE_TRUNCATION_TOP_K)
    expect(folded.truncated.map(({ recordId }) => recordId)).not.toContain('caution-cut')
    expect(ServedRetrievalTraceV1Schema.safeParse(folded).success).toBe(true)
  })

  it('Shape B: records the cut ledger when the ledger refused every caution the reader served', () => {
    const recorder = new EvidenceRecorder()
    recorder.recordServedCautions(
      [],
      trace(
        [line('caution-1', 1, 0.8), line('caution-2', 2, 0.6)],
        [line('caution-cut', 3, 0.4)],
      ),
    )

    const evidence = recorder.finalize(passVerdict, 0, 'checkout')

    expect(evidence.retrievalTrace).toBeTruthy()
    // A refused caution is a cut candidate, ahead of the reader's own cuts; order is asserted.
    expect(evidence.retrievalTrace!.truncated.map(({ recordId }) => recordId))
      .toEqual(['caution-1', 'caution-2', 'caution-cut'])
    expect(evidence.retrievalTrace!.servedLines).toEqual([])
    expect(ServedRetrievalTraceV1Schema.safeParse(evidence.retrievalTrace).success).toBe(true)
  })

  it('Shape B leaves the ServedBrief digest untouched by a zero-injection recording', () => {
    // A zero-line channel append would churn the digest with no content, so the brief stays put.
    const recorder = new EvidenceRecorder()
    recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['fact-a', 'fact-b']),
      trace: trace([line('fact-a', 1), line('fact-b', 2)]),
    })
    const before = recorder.finalize(passVerdict, 0, 'checkout').servedBrief

    recorder.recordServedCautions([], trace([line('caution-1', 1)], [line('caution-cut', 2)]))
    const after = recorder.finalize(passVerdict, 0, 'checkout')

    expect(after.servedBrief.channel3).toHaveLength(0)
    expect(after.servedBrief.briefDigest).toBe(before.briefDigest)
    expect(JSON.stringify(after.servedBrief)).toBe(JSON.stringify(before))
    // Not vacuous: the recording that left the bytes alone genuinely moved the ledger.
    expect(after.retrievalTrace!.truncated.map(({ recordId }) => recordId))
      .toEqual(['caution-1', 'caution-cut'])
  })

  it('bounds the zero-injection ledger at the pinned top-K like every other path', () => {
    const recorder = new EvidenceRecorder()
    const readerCuts = Array.from(
      { length: TRACE_TRUNCATION_TOP_K },
      (_unused, index) => line(`caution-cut-${index}`, index + 2),
    )
    // Exactly K + 1 candidates cross the new path: one refused served line plus K reader cuts.
    recorder.recordServedCautions([], trace([line('caution-refused', 1)], readerCuts))

    const folded = recorder.finalize(passVerdict, 0, 'checkout').retrievalTrace!

    expect(folded.truncated).toHaveLength(TRACE_TRUNCATION_TOP_K)
    // The refused served line leads, so the LAST reader cut is the one the bound drops — the
    // boundary, asserted by which entry fell off rather than by a count alone.
    expect(folded.truncated[0]!.recordId).toBe('caution-refused')
    expect(folded.truncated.map(({ recordId }) => recordId))
      .not.toContain(`caution-cut-${TRACE_TRUNCATION_TOP_K - 1}`)
    expect(ServedRetrievalTraceV1Schema.safeParse(folded).success).toBe(true)
  })

  it('round-trips byte-identically through persistence and preserves tied ranks', () => {
    const recorder = new EvidenceRecorder()
    // Every score ties, so a serialization that reordered on equal scores would be visible.
    const tied = [line('r-a', 1, 0.5), line('r-b', 2, 0.5), line('r-c', 3, 0.5)]
    recorder.recordServedBrief({
      scope,
      asOfBuild: 42,
      budget: 256,
      block: block(['r-a', 'r-b', 'r-c']),
      trace: trace(tied, [line('r-d', 4, 0.5)]),
    })

    const persisted = recorder.finalize(passVerdict, 0, 'checkout').retrievalTrace!
    const once = JSON.stringify(persisted)
    const reparsed = ServedRetrievalTraceV1Schema.parse(JSON.parse(once))

    expect(JSON.stringify(reparsed)).toBe(once)
    expect(reparsed.servedLines.map(({ recordId }) => recordId)).toEqual(['r-a', 'r-b', 'r-c'])
    expect(new Set(reparsed.servedLines.map(({ score }) => score)).size).toBe(1)
  })
})

describe('the assembled handoff carries a trace-bearing step at schemaVersion 5', () => {
  const member: RunMemberDescriptor = {
    testId: 'checkout-guest-1',
    name: 'Guest checkout',
    filePath: 'checkout.spec.yaml',
  }
  const baseConfig = {
    runId: 'run-trace' as RunId,
    scope,
    executionContext: 'local-headless',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    buildOrdinal: 7,
    members: [member],
    executor: async (): Promise<TestResult> => ({
      name: 'checkout',
      filePath: 'checkout.spec.yaml',
      status: 'passed',
      duration: 1,
      steps: [],
    }),
  } satisfies RunConfig

  function tracedOutcome(): ReturnType<typeof assemblePerTestOutcome> {
    const recorder = new EvidenceRecorder()
    recorder.recordServedBrief({
      scope,
      asOfBuild: 7,
      budget: 256,
      block: block(['fact-a']),
      trace: trace([line('fact-a', 1, 0.9)], [line('fact-b', 2, 0.4)]),
    })
    const evidence = recorder.finalize(passVerdict, 0, 'checkout')
    const result: TestResult = {
      name: 'checkout',
      filePath: 'checkout.spec.yaml',
      status: 'passed',
      duration: 1,
      steps: [{ name: 'checkout', status: 'passed', duration: 1, evidence }],
    }
    return assemblePerTestOutcome(
      member,
      result,
      'passed' as MemberTestOutcome,
      {
        testIndex: 0,
        scope,
        buildOrdinal: 7,
        mask: (value: string) => value,
      },
    )
  }

  it('stamps the version the trace contract shipped under', () => {
    const handoff = assembleHandoff(
      baseConfig,
      [tracedOutcome()],
      'passed',
      { startedAt: 1, endedAt: 2 },
    )

    expect(CURRENT_HANDOFF_SCHEMA_VERSION).toBe(2)
    expect(handoff.schemaVersion).toBe(2)
  })

  it('round-trips the persisted trace through the one load-boundary guard', () => {
    const handoff = assembleHandoff(
      baseConfig,
      [tracedOutcome()],
      'passed',
      { startedAt: 1, endedAt: 2 },
    )
    const reloaded = guardCompletedRunHandoff(JSON.parse(JSON.stringify(handoff)))

    const step = reloaded.tests[0]!.steps[0]!
    expect(step.retrievalTrace).toEqual({
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      servedLines: [{ recordId: 'fact-a', leg: 'anchor', rank: 1, score: 0.9 }],
      truncated: [{ recordId: 'fact-b', leg: 'anchor', rank: 2, score: 0.4 }],
    })
    // The loader refuses a malformed trace, so what the runner writes must pass its guard.
    expect(() => guardCompletedRunHandoff(JSON.parse(JSON.stringify({
      ...handoff,
      tests: [{
        ...handoff.tests[0]!,
        steps: [{ ...step, retrievalTrace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId: 'x' }] } }],
      }],
    })))).toThrow()
  })
})

describe('the evidence writer copies serve-time values through unchanged', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'loop', 'evidence.ts')

  function statementsOf(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((textLine) => textLine.replace(/\/\/.*$/, ''))
      .join('\n')
  }

  function occurrences(source: string, needle: string): number {
    return source.split(needle).length - 1
  }

  it('derives no rank and no score at persistence time', () => {
    const source = statementsOf(readFileSync(path, 'utf8'))

    // The reader computed; the runner writes. Constructing a rank or doing arithmetic on a score
    // here would make the persisted trace testimony about the moment of WRITING.
    // Deliberately NOT a blanket arithmetic ban: this module has always done coordinate clamping
    // for `collapseAnnotation`, which has nothing to do with the trace. The tokens below are the
    // ones that could only appear if a rank or a score were being MADE here.
    for (const forbidden of [
      'rank:',
      'score:',
      '.score *',
      '.score +',
      '.rank *',
      '.rank +',
      'rank +',
      'sort(',
    ]) {
      expect(occurrences(source, forbidden)).toBe(0)
    }
    // The check is reached at all: the fold really does handle the trace's own ledgers.
    expect(occurrences(source, 'servedLines')).toBeGreaterThan(0)
    expect(occurrences(source, 'truncated')).toBeGreaterThan(0)

    // POSITIVE CONTROL: a planted recomputation is caught by the same scan.
    const planted = `${source}\nconst fixed = { rank: index + 1, score: incoming.score * 2 }\nlines.sort((a, b) => a.rank - b.rank)\n`
    expect(occurrences(planted, 'rank:')).toBe(1)
    expect(occurrences(planted, '.score *')).toBe(1)
    expect(occurrences(planted, 'sort(')).toBe(1)

    // INVERSE CONTROL: the same tokens in prose must not be flagged — this module documents the
    // very recomputation it refuses to do.
    expect(occurrences(
      statementsOf('// never write rank: n here\n/* nor score: n */\nconst x = 1\n'),
      'rank:',
    )).toBe(0)
  })
})
