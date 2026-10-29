// D-06 lockstep pins: the cassette zod mirror must track the schema Verdict
// union in the same commit window as any schema change. Phase 373 Plan 01
// extends the union to the closed eight classes (unknown/timeout, §A9) and
// mints the required producer discriminator. CASSETTE_SCHEMA_VERSION
// stays 2 — additive literals plus a required field inside the never-yet-written
// optional label.rootCause object (RESEARCH Pitfall 6): every committed cassette
// under demo/init/agent-qa-eval/ is rootCause-free and still parses.
import { describe, expect, it } from 'vitest'
import { CASSETTE_SCHEMA_VERSION, guardCassette } from '../../index'

const SHA = 'a'.repeat(64)

function validLeafDocument() {
  return {
    schemaVersion: CASSETTE_SCHEMA_VERSION,
    id: 'run-one/step-00-decision-00-leaf',
    runId: 'run-one',
    testId: 'test-one',
    testIndex: 0,
    blobs: [SHA],
    completeness: { status: 'complete' },
    granularity: 'leaf',
    stepIndex: 0,
    decisionOrdinal: 0,
    input: {
      testId: 'test-one',
      testIndex: 0,
      stepIndex: 0,
      decisionOrdinal: 0,
      stepText: 'Submit the form',
      stateBefore: {
        platform: 'web',
        tree: '- button "Submit" [ref=e1]',
        elements: [
          {
            ref: 'e1',
            role: 'button',
            name: 'Submit',
            nameNormalized: 'submit',
            state: { enabled: true, focused: false, visible: true },
            labels: { ariaLabel: 'Submit' },
            attributes: { type: 'submit' },
          },
        ],
        refMap: {
          e1: {
            bounds: { x: 10, y: 20, width: 80, height: 32 },
            center: { x: 50, y: 36 },
          },
        },
        url: 'https://example.test/form',
        timestamp: 123,
        metadata: {
          captureMode: 'textOnly',
          coordSpace: 'viewport',
          viewportWidth: 1280,
          viewportHeight: 720,
          scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
        },
      },
      servedBrief: {
        scope: { tier: 'test', key: 'test-one' },
        asOfBuild: 7,
        budget: 256,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: SHA,
      },
      exchanges: [{ tool: 'inspect', args: { what: 'console' }, result: [] }],
    },
    sidecar: {
      goldAction: { type: 'click', ref: 'e1' },
      opClass: 'click',
      goldAnchor: { role: 'button', nameNormalized: 'submit', ordinal: 0, ref: 'e1' },
      equivalenceSet: [{ role: 'button', nameNormalized: 'submit', ordinal: 0 }],
    },
    label: {
      verdict: { pass: true, reasoning: 'Submitted successfully' },
      sourceChannel: 'recorded-verdict',
      tier: 'silver',
    },
    receipt: {
      promptInputHash: SHA,
      model: { resolvedModelId: 'planner-model-2026' },
      sampling: { declared: { temperature: 0 } },
      screenStateHash: SHA,
      judge: {},
      buildOrdinal: 7,
    },
  }
}

function verdictFixture(overrides: Record<string, unknown> = {}) {
  return {
    class: 'unknown',
    producer: 'deterministic-classifier',
    confidence: 0,
    evidence: {
      citedSteps: [0],
      citedAnchors: [{ t: 'el', role: 'button', name: 'Submit' }],
      citedArtifacts: [{ id: 'screenshot-after', sha: SHA }],
      rationale: 'The judge could not attribute the failure to any bounded class.',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
    ...overrides,
  }
}

function withRootCause(rootCause: unknown): unknown {
  const doc = validLeafDocument()
  return { ...doc, label: { ...doc.label, rootCause } }
}

function wireRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

describe('cassette verdict mirror stays in lockstep with the schema Verdict', () => {
  it('parses a rootCause-free schemaVersion 2 document (pre-phase cassettes unaffected)', () => {
    const cassette = guardCassette(wireRoundTrip(validLeafDocument()))

    expect(cassette.schemaVersion).toBe(2)
    expect(cassette.granularity).toBe('leaf')
  })

  it("parses a verdict with class 'unknown' and producer 'deterministic-classifier'", () => {
    const cassette = guardCassette(wireRoundTrip(withRootCause(verdictFixture())))

    expect(cassette.granularity).toBe('leaf')
  })

  it("parses a verdict with class 'timeout' and producer", () => {
    const cassette = guardCassette(
      wireRoundTrip(withRootCause(verdictFixture({ class: 'timeout', producer: 'analyze-run' }))),
    )

    expect(cassette.granularity).toBe('leaf')
  })

  it('rejects a verdict missing producer (required discriminator)', () => {
    const { producer: _omit, ...withoutProducer } = verdictFixture()
    void _omit

    expect(() => guardCassette(wireRoundTrip(withRootCause(withoutProducer)))).toThrow(
      /producer/,
    )
  })

  it('rejects a ninth class literal (closed union, §A9)', () => {
    expect(() =>
      guardCassette(wireRoundTrip(withRootCause(verdictFixture({ class: 'other' })))),
    ).toThrow()
  })
})

describe('cassette verdict mirror: a declared memoryOnPath', () => {
  const memoryOnPath = [
    { recordId: 'rec_checkout_button', trust: 'candidate' },
    { recordId: 'rec_checkout_flow', trust: 'candidate' },
  ]

  it('carries a well-formed memoryOnPath through the parser unchanged', () => {
    const cassette = guardCassette(wireRoundTrip(withRootCause(verdictFixture({ memoryOnPath }))))

    if (cassette.granularity !== 'leaf') throw new Error('expected a leaf cassette')
    expect(cassette.label.rootCause?.memoryOnPath).toEqual(memoryOnPath)
  })

  it('refuses a memoryOnPath outside the closed trust vocabulary or not an array', () => {
    expect(() =>
      guardCassette(
        wireRoundTrip(
          withRootCause(
            verdictFixture({ memoryOnPath: [{ recordId: 'rec_checkout_button', trust: 'canary' }] }),
          ),
        ),
      ),
    ).toThrow()
    expect(() =>
      guardCassette(
        wireRoundTrip(
          withRootCause(verdictFixture({ memoryOnPath: { recordId: 'rec_checkout_button' } })),
        ),
      ),
    ).toThrow()
  })
})
