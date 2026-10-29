// The serve-time retrieval trace (Phase 387 plan 02, KREV-02 · D-13/D-14/D-15).
//
// Three claims are pinned here, and each one is pinned by a case the assertion could
// actually REJECT rather than by a happy-path sample:
//
//   1. The trace contract is CLOSED — a fourth retrieval leg, a second schemaVersion, a
//      zero rank and an unknown key are each refused, so a producer cannot widen the shape
//      by writing to it.
//   2. The truncation ledger is BOUNDED at both edges of `TRACE_TRUNCATION_TOP_K` — exactly
//      K is admitted, K + 1 is refused. A test that only fed a "large" array would pass
//      against any bound at all, including none.
//   3. `retrievalTrace` is a beside-field on `StepEvidence` that a v5 handoff may carry, may
//      OMIT (historical absence — D-15's substrate), and may not carry malformed.
//
// Schema module-discipline law: extension-less relative import specifiers, no node builtins.
import { describe, expect, it } from 'vitest'

import {
  RETRIEVAL_TRACE_LEGS,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  ServedRetrievalTraceV1Schema,
  TRACE_TRUNCATION_TOP_K,
  TraceLineSchema,
} from '../brief/retrieval-trace'
import type { ServedRetrievalTraceV1, TraceLine } from '../brief/retrieval-trace'
import {
  guardCompletedRunHandoff,
  HandoffVersionError,
} from '../handoff/load-completed-run-handoff'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '../handoff/completed-run-handoff'
import type { CompletedRunHandoff } from '../handoff/completed-run-handoff'
import { asRunId } from '../run/run-id'
import type { ScopeKey } from '../identity/scope-key'

const scope: ScopeKey = { tier: 'suite', key: 'checkout' }

function line(overrides: Partial<TraceLine> = {}): TraceLine {
  return {
    recordId: 'rec-checkout-1',
    leg: 'lexical',
    rank: 1,
    score: 0.42,
    ...overrides,
  }
}

function trace(overrides: Partial<ServedRetrievalTraceV1> = {}): ServedRetrievalTraceV1 {
  return {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
    servedLines: [line()],
    truncated: [line({ recordId: 'rec-checkout-2', rank: 2, score: 0.11 })],
    ...overrides,
  }
}

function ledgerOf(size: number): TraceLine[] {
  return Array.from({ length: size }, (_unused, index) =>
    line({ recordId: `rec-cut-${String(index)}`, rank: index + 1, score: 1 / (index + 2) }),
  )
}

describe('ServedRetrievalTraceV1', () => {
  it('accepts a full-attribution trace at RETRIEVAL_TRACE_SCHEMA_VERSION', () => {
    const parsed = ServedRetrievalTraceV1Schema.parse(trace())

    expect(parsed.schemaVersion).toBe(RETRIEVAL_TRACE_SCHEMA_VERSION)
    expect(parsed.servedLines).toEqual([
      { recordId: 'rec-checkout-1', leg: 'lexical', rank: 1, score: 0.42 },
    ])
    expect(parsed.truncated).toEqual([
      { recordId: 'rec-checkout-2', leg: 'lexical', rank: 2, score: 0.11 },
    ])
  })

  it('pins the closed retrieval-leg vocabulary as an exact set', () => {
    // A closed union is only closed if something rejects the arm nobody wrote. The member
    // set is asserted structurally rather than by the ABSENCE of a fourth test.
    expect([...RETRIEVAL_TRACE_LEGS]).toEqual(['lexical', 'dense', 'anchor'])
  })

  it('rejects a leg outside the vocabulary', () => {
    // `graph` is a real projection name in this repo (§7.7 scrub set) and therefore the
    // plausible fourth arm a future author would reach for — not a nonsense string.
    expect(() => TraceLineSchema.parse(line({ leg: 'graph' as never }))).toThrow()
    expect(() =>
      ServedRetrievalTraceV1Schema.parse(
        trace({ servedLines: [line({ leg: 'graph' as never })] }),
      ),
    ).toThrow()
  })

  it('rejects a missing schemaVersion and any other schemaVersion', () => {
    const { schemaVersion: _omit, ...withoutVersion } = trace()
    void _omit

    expect(() => ServedRetrievalTraceV1Schema.parse(withoutVersion)).toThrow()
    expect(() =>
      ServedRetrievalTraceV1Schema.parse({ ...trace(), schemaVersion: 3 }),
    ).toThrow()
  })

  it('rejects an unknown key at both the trace and the line level (strict)', () => {
    expect(() =>
      ServedRetrievalTraceV1Schema.parse({ ...trace(), legWeights: {} }),
    ).toThrow()
    expect(() =>
      ServedRetrievalTraceV1Schema.parse({
        ...trace(),
        servedLines: [{ ...line(), bundleId: 'bnd-1' }],
      }),
    ).toThrow()
  })

  it('rejects a non-positive rank — ranks are 1-based positions, never offsets', () => {
    expect(() => TraceLineSchema.parse(line({ rank: 0 }))).toThrow()
    expect(() => TraceLineSchema.parse(line({ rank: -1 }))).toThrow()
    expect(() => TraceLineSchema.parse(line({ rank: 1.5 }))).toThrow()
  })

  it('rejects a non-finite score', () => {
    expect(() => TraceLineSchema.parse(line({ score: Number.NaN }))).toThrow()
    expect(() => TraceLineSchema.parse(line({ score: Number.POSITIVE_INFINITY }))).toThrow()
  })
})

describe('TRACE_TRUNCATION_TOP_K (bounded truncation ledger)', () => {
  it('exports the bound as a positive integer constant', () => {
    expect(Number.isSafeInteger(TRACE_TRUNCATION_TOP_K)).toBe(true)
    expect(TRACE_TRUNCATION_TOP_K).toBeGreaterThan(0)
  })

  it('admits exactly TRACE_TRUNCATION_TOP_K cut candidates', () => {
    const atBound = ServedRetrievalTraceV1Schema.parse(
      trace({ truncated: ledgerOf(TRACE_TRUNCATION_TOP_K) }),
    )

    expect(atBound.truncated).toHaveLength(TRACE_TRUNCATION_TOP_K)
  })

  it('refuses one candidate past the bound', () => {
    expect(() =>
      ServedRetrievalTraceV1Schema.parse(
        trace({ truncated: ledgerOf(TRACE_TRUNCATION_TOP_K + 1) }),
      ),
    ).toThrow()
  })

  it('admits an empty ledger — nothing was cut is a legal answer', () => {
    expect(ServedRetrievalTraceV1Schema.parse(trace({ truncated: [] })).truncated).toEqual([])
  })

  it('leaves servedLines unbounded — the budget already bounds what was served', () => {
    const wide = ServedRetrievalTraceV1Schema.parse(
      trace({ servedLines: ledgerOf(TRACE_TRUNCATION_TOP_K + 5) }),
    )

    expect(wide.servedLines).toHaveLength(TRACE_TRUNCATION_TOP_K + 5)
  })
})

function makeStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepIndex: 0,
    stepText: 'buy something',
    cacheStatus: 'miss',
    servedBrief: {
      scope,
      asOfBuild: 7,
      budget: 1_000,
      truncation: 'none',
      channel1: [
        {
          id: 'rec-checkout-1',
          kind: 'fact',
          summary: 'checkout button is in the header',
          trust: 0.8,
          status: 'active',
          servedAsCanary: false,
          tier: 'suite',
        },
      ],
      channel2: [],
      channel3: [],
      briefDigest: 'a'.repeat(64),
    },
    subActions: [
      {
        plannedAction: { kind: 'click' },
        stateBefore: { url: 'https://example.test/cart', elements: [] },
      },
    ],
    verifierVerdict: { pass: true, reasoning: 'reached the confirmation page' },
    ...overrides,
  }
}

function makeHandoff(overrides: Partial<CompletedRunHandoff> = {}): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-trace-1'),
    scope,
    buildOrdinal: 7,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    tests: [
      {
        testId: 't_checkout',
        testName: 'checkout',
        filePath: 'tests/checkout.yaml',
        testIndex: 0,
        outcome: 'passed',
        steps: [makeStep()],
      },
    ],
    ...overrides,
  }
}

function handoffWithStep(step: Record<string, unknown>): Record<string, unknown> {
  const base = makeHandoff()
  return {
    ...base,
    tests: [{ ...(base.tests as Record<string, unknown>[])[0], steps: [step] }],
  }
}

describe('CompletedRunHandoff v5 retrievalTrace beside-field', () => {
  it('pins the current handoff schema version at 2', () => {
    expect(CURRENT_HANDOFF_SCHEMA_VERSION).toBe(2)
  })

  it('refuses a NEWER-than-current document BY NAME rather than by shape', () => {
    let thrown: unknown
    try {
      guardCompletedRunHandoff({ ...makeHandoff(), schemaVersion: 8 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HandoffVersionError)
    const error = thrown as HandoffVersionError
    expect(error.name).toBe('HandoffVersionError')
    expect(error.foundVersion).toBe(8)
    expect(error.supportedVersion).toBe(2)
  })

  it('loads a v5 step that carries NO retrievalTrace (historical absence)', () => {
    const guarded = guardCompletedRunHandoff(makeHandoff())

    expect('retrievalTrace' in guarded.tests[0].steps[0]).toBe(false)
  })

  it('carries a well-formed retrievalTrace through the guard unchanged', () => {
    const carried = trace()

    const guarded = guardCompletedRunHandoff(
      handoffWithStep(makeStep({ retrievalTrace: carried })),
    )

    expect(guarded.tests[0].steps[0].retrievalTrace).toEqual(carried)
  })

  it('refuses a step whose PRESENT retrievalTrace is malformed (fail-closed)', () => {
    // The why-verb (387-06) dereferences every line's recordId/leg/rank/score to answer
    // with, so the load boundary admits the block only in consumer-traversable form — the
    // same present-implies-valid discipline `planSource` and `interpolatedVariables` carry.
    const cases: unknown[] = [
      'not-an-object',
      { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [] , extra: true },
      { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId: 'r', leg: 'graph', rank: 1, score: 1 }], truncated: [] },
      { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId: 'r', leg: 'dense', rank: 0, score: 1 }], truncated: [] },
      { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: ledgerOf(TRACE_TRUNCATION_TOP_K + 1) },
      { servedLines: [], truncated: [] },
    ]

    for (const malformed of cases) {
      expect(() =>
        guardCompletedRunHandoff(handoffWithStep(makeStep({ retrievalTrace: malformed }))),
      ).toThrow()
    }
  })

  it('keeps retrievalTrace and workingMemory independent beside-fields', () => {
    const traceOnly = guardCompletedRunHandoff(
      handoffWithStep(makeStep({ retrievalTrace: trace() })),
    )
    const memoryOnly = guardCompletedRunHandoff(
      handoffWithStep(makeStep({ workingMemory: [] })),
    )

    expect('workingMemory' in traceOnly.tests[0].steps[0]).toBe(false)
    expect('retrievalTrace' in memoryOnly.tests[0].steps[0]).toBe(false)
  })
})
