import type {
  CompletedRunHandoff,
  LosslessServedBriefProofV1,
  RecordedRetrievalRung,
  StepEvidence,
} from '@vostride/agent-qa-schema'
import { committedFileText, SERVED_BRIEF_PROOF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
  makeV2Handoff,
} from '../../__tests__/fixtures/handoff-fixtures'
import type { LeafCassette } from '../../cassette/cassette'
import { guardCassette } from '../../cassette/guard'
import type { ArtifactSource } from '../../ports'
import { extractRunCassettes } from '../extract-run'
import { projectInputLeg } from '../input-leg'

const RUNG: RecordedRetrievalRung = {
  schemaVersion: 2,
  rung: 'lexical-only',
  reason: 'model-not-downloaded',
}

function makeProof(): LosslessServedBriefProofV1 {
  return {
    schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
    completeness: 'lossless',
    recordCap: 32,
    combinedBudget: 2_048,
    admissionEvents: [],
    promptTurns: [
      {
        ordinal: 0,
        turnOrdinal: 0,
        runDate: '2026-09-04',
        policyL0: 'policy text',
        learnedL1: 'learned one',
        learnedL2: 'learned two',
        contextTier: 'context text',
        volatileTier: 'volatile text',
        policyDigest: '0'.repeat(64),
        contextTierDigest: '1'.repeat(64),
        volatileTierDigest: '2'.repeat(64),
      },
    ],
  }
}

function projectFirstDecision(mutate: (step: StepEvidence) => StepEvidence) {
  const handoffTest = makeV2Handoff().tests[0]!
  const step = mutate(handoffTest.steps[0]!)
  const subAction = step.subActions[0]!
  return projectInputLeg({
    handoffTest,
    step,
    subAction,
    testIndex: handoffTest.testIndex,
    stepIndex: step.stepIndex,
    decisionOrdinal: 0,
  })
}

function fullArtifacts(): ArtifactSource {
  const entries = new Map<string, Uint8Array>([
    [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
    [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
  ])
  return { getBlob: (sha) => entries.get(sha) }
}

function firstLeafWithRung(): LeafCassette {
  const handoff: CompletedRunHandoff = makeArtifactRefV2Handoff()
  const step = handoff.tests[0]!.steps[0]! as StepEvidence & {
    retrievalRung?: RecordedRetrievalRung
  }
  step.retrievalRung = { ...RUNG }

  const found = extractRunCassettes({ handoff, artifacts: fullArtifacts() })
    .cassettes.map((entry) => entry.cassette)
    .find(
      (cassette): cassette is LeafCassette =>
        cassette.granularity === 'leaf' && cassette.input.stepIndex === 0,
    )
  if (found === undefined) throw new Error('missing first leaf cassette')
  return found
}

describe('projectInputLeg served-brief proof and retrieval rung', () => {
  it('carries ServedBrief.proof through projection as the verbatim served brief object', () => {
    const proof = makeProof()
    let servedBrief: StepEvidence['servedBrief'] | undefined

    const leg = projectFirstDecision((step) => {
      servedBrief = { ...step.servedBrief, proof }
      return { ...step, servedBrief }
    })

    expect(leg.servedBrief.proof).toEqual(proof)
    expect(leg.servedBrief.proof?.promptTurns).toHaveLength(1)
    expect(leg.servedBrief.proof?.admissionEvents).toEqual([])
    expect(leg.servedBrief).toBe(servedBrief)
  })

  it('projects the recorded retrieval rung beside the brief when the step carries one', () => {
    const leg = projectFirstDecision((step) => ({ ...step, retrievalRung: { ...RUNG } }))

    expect(leg.retrievalRung).toEqual(RUNG)
  })

  it('leaves the rung structurally absent when the step recorded none', () => {
    const leg = projectFirstDecision((step) => {
      const { retrievalRung: _rung, ...withoutRung } = step
      void _rung
      return withoutRung
    })

    expect(leg).not.toHaveProperty('retrievalRung')
    expect(Object.hasOwn(leg, 'retrievalRung')).toBe(false)
  })

  it('round-trips the rung through guardCassette and still admits a rung-less cassette', () => {
    const cassette = firstLeafWithRung()

    const admitted = guardCassette(JSON.parse(committedFileText(cassette)))
    expect(admitted.granularity).toBe('leaf')
    if (admitted.granularity !== 'leaf') throw new Error('expected a leaf cassette')
    expect(admitted.input.retrievalRung).toEqual(RUNG)

    const legacy = JSON.parse(committedFileText(cassette)) as {
      input: Record<string, unknown>
    }
    delete legacy.input.retrievalRung
    const legacyAdmitted = guardCassette(legacy)
    expect(legacyAdmitted.granularity).toBe('leaf')
    if (legacyAdmitted.granularity !== 'leaf') throw new Error('expected a leaf cassette')
    expect(legacyAdmitted.input).not.toHaveProperty('retrievalRung')
  })
})
