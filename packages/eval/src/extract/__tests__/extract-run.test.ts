import { asRef } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff } from '@vostride/agent-qa-schema'
import type {
  ArtifactSource,
  Cassette,
  DecisionRecord,
  LeafCassette,
  ProcedureCassette,
} from '../../index'
import { buildProcedureCassette, deriveRunSlug, guardCassette } from '../../index'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
  makeV2Handoff,
} from '../../__tests__/fixtures/handoff-fixtures'
import { extractRunCassettes } from '../extract-run'

function mapSource(entries: ReadonlyMap<string, Uint8Array> = new Map()): ArtifactSource {
  return {
    getBlob(sha) {
      return entries.get(sha)
    },
  }
}

function cassettesOf(result: ReturnType<typeof extractRunCassettes>): Cassette[] {
  return result.cassettes.map((entry) => entry.cassette)
}

function proceduresOf(result: ReturnType<typeof extractRunCassettes>): ProcedureCassette[] {
  return cassettesOf(result).filter(
    (cassette): cassette is ProcedureCassette => cassette.granularity === 'procedure',
  )
}

describe('one-pass run extraction', () => {
  it('emits one leaf per live decision and one procedure per recorded test', () => {
    const result = extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() })
    const leaves = cassettesOf(result).filter((cassette) => cassette.granularity === 'leaf')
    const procedures = proceduresOf(result)

    expect(leaves.map((cassette) => cassette.id)).toEqual([
      'run---checkout-suite-42/test-00-step-00-d00-leaf',
      'run---checkout-suite-42/test-00-step-01-d01-leaf',
      'run---checkout-suite-42/test-01-step-00-d00-leaf',
      'run---checkout-suite-42/test-01-step-02-d00-leaf',
    ])
    expect(procedures.map((cassette) => cassette.id)).toEqual([
      'run---checkout-suite-42/test-00-procedure',
      'run---checkout-suite-42/test-01-procedure',
    ])
    expect(
      leaves.find((cassette) => cassette.id.includes('test-01-step-00'))?.label.verdict,
    ).toEqual({ pass: false, reasoning: 'Continue remained blocked after execution' })
  })

  it('reports every cache-hit and actionless skip without fabricating ordinals', () => {
    const result = extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() })

    expect(result.report.skips).toEqual([
      {
        testId: 'checkout::happy-path',
        testIndex: 0,
        stepIndex: 1,
        decisionOrdinal: 0,
        reason: 'cache-hit',
      },
      {
        testId: 'checkout::happy-path',
        testIndex: 0,
        stepIndex: 2,
        reason: 'actionless',
      },
      {
        testId: 'checkout::failure-path',
        testIndex: 1,
        stepIndex: 1,
        reason: 'actionless',
      },
    ])
    expect(result.report.emitted).toEqual(
      result.cassettes.map(({ cassette }) => ({
        id: cassette.id,
        granularity: cassette.granularity,
        completenessStatus: cassette.completeness.status,
      })),
    )
  })

  it('keeps procedure ordering truthful across decisions, cache service, and synthesis', () => {
    const [passing, failing] = proceduresOf(
      extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() }),
    )

    expect(passing!.steps.map((entry) => [entry.kind, entry.stepIndex])).toEqual([
      ['decision', 0],
      ['cache-served', 1],
      ['decision', 1],
      ['synthesized', 2],
    ])
    expect(passing!.steps[0]).toMatchObject({ kind: 'decision', decisionOrdinal: 0 })
    expect(passing!.steps[1]).toEqual({
      kind: 'cache-served',
      stepIndex: 1,
      decisionOrdinal: 0,
    })
    expect(passing!.steps[2]).toMatchObject({ kind: 'decision', decisionOrdinal: 1 })
    expect(failing!.steps.map((entry) => [entry.kind, entry.stepIndex])).toEqual([
      ['decision', 0],
      ['synthesized', 1],
      ['decision', 2],
    ])
  })

  it('projects only recorded procedure end-state values', () => {
    const [passing, failing] = proceduresOf(
      extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() }),
    )

    expect(passing!.endState).toEqual({
      outcome: 'passed',
      finalVerdict: { pass: true, reasoning: 'No action was required' },
    })
    expect(Object.hasOwn(passing!.endState, 'finalAssert')).toBe(false)
    expect(failing!.endState).toEqual({
      outcome: 'failed',
      finalVerdict: { pass: false, reasoning: 'The URL stayed on the checkout route' },
      finalAssert: {
        source: 'url',
        op: 'contains',
        expected: '/complete',
        actual: '/checkout',
        passed: false,
      },
    })
  })

  it('embeds each procedure cassette own deduplicated blob closure', () => {
    const screenshotBytes = new Uint8Array([1, 2, 3])
    const artifactBytes = new Uint8Array([4, 5])
    const result = extractRunCassettes({
      handoff: makeArtifactRefV2Handoff(),
      artifacts: mapSource(
        new Map([
          [FIXTURE_SCREENSHOT_SHA, screenshotBytes],
          [FIXTURE_ARTIFACT_SHA, artifactBytes],
        ]),
      ),
    })
    const procedures = result.cassettes.filter(
      (entry): entry is typeof entry & { cassette: ProcedureCassette } =>
        entry.cassette.granularity === 'procedure',
    )

    expect(procedures).toHaveLength(2)
    for (const entry of procedures) {
      expect(entry.cassette.blobs).toEqual([FIXTURE_SCREENSHOT_SHA, FIXTURE_ARTIFACT_SHA])
      expect(entry.blobs).toEqual([
        { sha: FIXTURE_SCREENSHOT_SHA, bytes: screenshotBytes },
        { sha: FIXTURE_ARTIFACT_SHA, bytes: artifactBytes },
      ])
    }
    expect(procedures[0]!.cassette.blobs).not.toBe(procedures[1]!.cassette.blobs)
    expect(procedures[0]!.blobs).not.toBe(procedures[1]!.blobs)
  })

  it('emits every affected cassette as evidence-incomplete when a referenced sha is absent', () => {
    const result = extractRunCassettes({
      handoff: makeArtifactRefV2Handoff(),
      artifacts: mapSource(
        new Map([[FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])]]),
      ),
    })

    expect(result.cassettes).toHaveLength(6)
    for (const entry of result.cassettes) {
      expect(entry.cassette.completeness).toEqual({
        status: 'evidence-incomplete',
        missingBlobShas: [FIXTURE_ARTIFACT_SHA],
      })
      expect(entry.cassette.blobs).toEqual([FIXTURE_SCREENSHOT_SHA, FIXTURE_ARTIFACT_SHA])
      expect(entry.blobs.map((blob) => blob.sha)).toEqual([FIXTURE_SCREENSHOT_SHA])
    }
  })

  it('produces guard-valid cassettes with no pairing label', () => {
    const result = extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() })

    for (const cassette of cassettesOf(result)) {
      expect(guardCassette(cassette)).toEqual(cassette)
      if (cassette.granularity === 'leaf') {
        expect(Object.hasOwn(cassette.label, 'pairing')).toBe(false)
        continue
      }
      for (const step of cassette.steps) {
        if (step.kind === 'decision') {
          expect(Object.hasOwn(step.record.label, 'pairing')).toBe(false)
        }
      }
    }
  })

  it('copies a pre-masked value-bearing paste into leaf and procedure sidecars without restoring raw content', () => {
    const marker = '[secret]'
    const handoff: CompletedRunHandoff = makeV2Handoff()
    handoff.tests[0]!.steps[0]!.subActions[0]!.plannedAction = {
      type: 'paste',
      ref: asRef('e-continue-1'),
      value: marker,
    }

    const result = extractRunCassettes({ handoff, artifacts: mapSource() })

    const leaf = cassettesOf(result).find(
      (cassette): cassette is LeafCassette =>
        cassette.granularity === 'leaf' && cassette.id.includes('test-00-step-00'),
    )
    expect(leaf?.sidecar.goldValue).toBe(marker)
    expect(leaf?.sidecar.goldAction).toMatchObject({ type: 'paste', value: marker })

    const [passing] = proceduresOf(result)
    const decision = passing!.steps.find(
      (step) => step.kind === 'decision' && step.stepIndex === 0,
    )
    if (decision?.kind !== 'decision') throw new Error('expected a decision step')
    expect(decision.record.sidecar.goldValue).toBe(marker)
    expect(decision.record.sidecar.goldAction).toMatchObject({ type: 'paste', value: marker })

    expect(JSON.stringify(leaf)).not.toContain('sk-live')
    expect(JSON.stringify(passing)).not.toContain('sk-live')
  })

  it('is deeply deterministic for repeated extraction of identical inputs', () => {
    const handoff = makeV2Handoff()
    const artifacts = mapSource()

    expect(extractRunCassettes({ handoff, artifacts })).toEqual(
      extractRunCassettes({ handoff, artifacts }),
    )
  })
})

function firstStepLeaf(result: ReturnType<typeof extractRunCassettes>): LeafCassette | undefined {
  return cassettesOf(result).find(
    (cassette): cassette is LeafCassette =>
      cassette.granularity === 'leaf' && cassette.id.includes('test-00-step-00'),
  )
}

describe('leaf typed evidence closure', () => {
  it('marks a full-capture leaf with no screenshot ref evidence-incomplete at its coordinates', () => {
    const result = extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() })
    const leaf = firstStepLeaf(result)

    expect(leaf?.blobs).toEqual([])
    expect(leaf?.completeness).toEqual({
      status: 'evidence-incomplete',
      missingEvidence: [{ kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 }],
    })
    expect(guardCassette(leaf!)).toEqual(leaf)
  })

  it('marks a usable typed-ref leaf complete and retains its typed input refs when bytes resolve', () => {
    const result = extractRunCassettes({
      handoff: makeArtifactRefV2Handoff(),
      artifacts: mapSource(
        new Map([
          [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
          [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
        ]),
      ),
    })
    const leaf = firstStepLeaf(result)

    expect(leaf?.completeness).toEqual({ status: 'complete' })
    expect(leaf?.blobs).toEqual([FIXTURE_SCREENSHOT_SHA, FIXTURE_ARTIFACT_SHA])
    expect(leaf?.input.decisionScreenshotRef?.sha).toBe(FIXTURE_SCREENSHOT_SHA)
    expect(leaf?.input.auxiliaryArtifactRefs?.map((ref) => ref.sha)).toEqual([FIXTURE_ARTIFACT_SHA])
  })

  it('reports a usable-ref leaf with missing bytes as missing shas without a screenshot fact', () => {
    const result = extractRunCassettes({
      handoff: makeArtifactRefV2Handoff(),
      artifacts: mapSource(new Map([[FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])]])),
    })
    const leaf = firstStepLeaf(result)

    expect(leaf?.completeness).toEqual({
      status: 'evidence-incomplete',
      missingBlobShas: [FIXTURE_ARTIFACT_SHA],
    })
    expect(leaf?.input.decisionScreenshotRef?.sha).toBe(FIXTURE_SCREENSHOT_SHA)
  })

  it('marks a full-capture leaf with an evidenceIncomplete screenshot ref evidence-incomplete', () => {
    const handoff = makeV2Handoff()
    handoff.tests[0]!.steps[0]!.subActions[0]!.decisionScreenshotRef = {
      id: 'decision-shot',
      sha: FIXTURE_SCREENSHOT_SHA,
      evidenceIncomplete: true,
    }

    const result = extractRunCassettes({
      handoff,
      artifacts: mapSource(new Map([[FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])]])),
    })
    const leaf = firstStepLeaf(result)

    expect(leaf?.completeness).toEqual({
      status: 'evidence-incomplete',
      missingEvidence: [{ kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 }],
    })
  })

  it('keeps a text-only no-ref leaf complete', () => {
    const handoff = makeV2Handoff()
    const sub = handoff.tests[0]!.steps[0]!.subActions[0]!
    sub.stateBefore = {
      ...sub.stateBefore,
      metadata: { ...sub.stateBefore.metadata, captureMode: 'textOnly' },
    }

    const result = extractRunCassettes({ handoff, artifacts: mapSource() })
    const leaf = firstStepLeaf(result)

    expect(leaf?.completeness).toEqual({ status: 'complete' })
  })
})

describe('procedure missing-evidence aggregation', () => {
  it('aggregates every decision missing-evidence fact into full/no-ref procedures in order', () => {
    const [passing, failing] = proceduresOf(
      extractRunCassettes({ handoff: makeV2Handoff(), artifacts: mapSource() }),
    )

    expect(passing!.completeness).toEqual({
      status: 'evidence-incomplete',
      missingEvidence: [
        { kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 },
        { kind: 'decision-screenshot-ref', stepIndex: 1, decisionOrdinal: 1 },
      ],
    })
    expect(failing!.completeness).toEqual({
      status: 'evidence-incomplete',
      missingEvidence: [
        { kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 },
        { kind: 'decision-screenshot-ref', stepIndex: 2, decisionOrdinal: 0 },
      ],
    })
    expect(guardCassette(passing!)).toEqual(passing)
  })

  it('stays evidence-incomplete for missing identity even when all blobs resolve', () => {
    const handoff = makeV2Handoff()
    handoff.tests[0]!.steps[0]!.subActions[0]!.decisionScreenshotRef = {
      id: 'decision-shot',
      sha: FIXTURE_SCREENSHOT_SHA,
      evidenceIncomplete: true,
    }

    const [passing] = proceduresOf(
      extractRunCassettes({
        handoff,
        artifacts: mapSource(new Map([[FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])]])),
      }),
    )

    expect(passing!.completeness.status).toBe('evidence-incomplete')
    expect(passing!.completeness.missingEvidence).toEqual([
      { kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 },
      { kind: 'decision-screenshot-ref', stepIndex: 1, decisionOrdinal: 1 },
    ])
    expect(Object.hasOwn(passing!.completeness, 'missingBlobShas')).toBe(false)
  })

  it('combines unresolved anchor and missing screenshot identity in one procedure cassette', () => {
    const handoff = makeV2Handoff()
    handoff.tests[0]!.steps[0]!.subActions[0]!.plannedAction = {
      type: 'click',
      ref: asRef('e-missing'),
    }

    const [passing] = proceduresOf(extractRunCassettes({ handoff, artifacts: mapSource() }))

    expect(passing!.completeness).toEqual({
      status: 'evidence-incomplete',
      unresolvedAnchorRef: 'e-missing',
      missingEvidence: [
        { kind: 'decision-screenshot-ref', stepIndex: 0, decisionOrdinal: 0 },
        { kind: 'decision-screenshot-ref', stepIndex: 1, decisionOrdinal: 1 },
      ],
    })
    expect(guardCassette(passing!)).toEqual(passing)
  })

  it('reports typed refs with one missing blob without inventing identity facts', () => {
    const [passing] = proceduresOf(
      extractRunCassettes({
        handoff: makeArtifactRefV2Handoff(),
        artifacts: mapSource(new Map([[FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])]])),
      }),
    )

    expect(passing!.completeness).toEqual({
      status: 'evidence-incomplete',
      missingBlobShas: [FIXTURE_ARTIFACT_SHA],
    })
  })

  it('keeps a textOnly/no-ref procedure complete', () => {
    const handoff = makeV2Handoff()
    for (const test of handoff.tests) {
      for (const step of test.steps) {
        for (const sub of step.subActions) {
          sub.stateBefore = {
            ...sub.stateBefore,
            metadata: { ...sub.stateBefore.metadata, captureMode: 'textOnly' },
          }
        }
      }
    }

    const [passing] = proceduresOf(extractRunCassettes({ handoff, artifacts: mapSource() }))

    expect(passing!.completeness).toEqual({ status: 'complete' })
  })

  it('shares the same typed screenshot ref between a leaf and its procedure decision sibling', () => {
    const result = extractRunCassettes({
      handoff: makeArtifactRefV2Handoff(),
      artifacts: mapSource(
        new Map([
          [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
          [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
        ]),
      ),
    })
    const leaf = firstStepLeaf(result)
    const [passing] = proceduresOf(result)
    const decision = passing!.steps.find(
      (step) => step.kind === 'decision' && step.stepIndex === 0,
    )
    if (decision?.kind !== 'decision') throw new Error('expected a decision step')

    expect(decision.record.input.decisionScreenshotRef).toEqual(leaf!.input.decisionScreenshotRef)
    expect(decision.record.input.auxiliaryArtifactRefs).toEqual(leaf!.input.auxiliaryArtifactRefs)
  })

  it('deduplicates exact missing-evidence tuples by first procedure order', () => {
    const handoff = makeV2Handoff()
    const soloTest = { ...handoff.tests[0]!, steps: [handoff.tests[0]!.steps[0]!] }
    const soloHandoff: CompletedRunHandoff = { ...handoff, tests: [soloTest] }

    const leaf = cassettesOf(
      extractRunCassettes({ handoff: soloHandoff, artifacts: mapSource() }),
    ).find((cassette): cassette is LeafCassette => cassette.granularity === 'leaf')!
    const record: DecisionRecord = {
      input: leaf.input,
      sidecar: leaf.sidecar,
      label: leaf.label,
      receipt: leaf.receipt,
    }
    const fact = {
      kind: 'decision-screenshot-ref',
      stepIndex: 0,
      decisionOrdinal: 0,
    } as const

    const built = buildProcedureCassette({
      handoff: soloHandoff,
      handoffTest: soloTest,
      runSlug: deriveRunSlug(soloHandoff.runId),
      decisions: [
        {
          stepIndex: 0,
          decisionOrdinal: 0,
          record,
          blobShas: [],
          missingEvidence: [fact, { ...fact }],
          anchorUnresolved: false,
        },
      ],
      artifacts: mapSource(),
    })

    expect(built.cassette.completeness).toEqual({
      status: 'evidence-incomplete',
      missingEvidence: [fact],
    })
  })
})
