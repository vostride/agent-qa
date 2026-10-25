import { asRef, sha256hex } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  Decision,
  SubActionEvidence,
} from '@vostride/agent-qa-schema'
import type { GoldMark } from '../golden-plan'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_ARTIFACT_SHA,
  FIXTURE_SCREENSHOT_SHA,
  makeArtifactRefV2Handoff,
} from '../../__tests__/fixtures/handoff-fixtures'
import { canonicalJson } from '../../canonical-json'
import type { LeafCassette } from '../../cassette/cassette'
import { extractRunCassettes, type ExtractedCassette } from '../../extract/extract-run'
import type { ArtifactSource } from '../../ports'
import { committedFileText } from '../committed-file'
import {
  LABEL_RECORD_SCHEMA_VERSION,
  projectPairLabelRecords,
  projectSilverLabelRecord,
  projectUserMarkLabelRecord,
  projectOverturnedVerdictLabelRecord,
  type StandaloneLabelRecord,
} from '../label-record'
import { collectSelfHealPairs, type MintedContrastivePair } from '../pair-matching'

const RUN_ID = 'run / checkout suite 42'
const RUN_SLUG = 'run---checkout-suite-42'
const FAILED_LEAF_ID = `${RUN_SLUG}/test-00-step-00-d00-leaf`
const RECOVERING_LEAF_ID = `${RUN_SLUG}/test-00-step-00-d01-leaf`
const SILVER_LEAF_ID = `${RUN_SLUG}/test-00-step-01-d01-leaf`

function fullArtifacts(): ArtifactSource {
  const entries = new Map<string, Uint8Array>([
    [FIXTURE_SCREENSHOT_SHA, new Uint8Array([1, 2, 3])],
    [FIXTURE_ARTIFACT_SHA, new Uint8Array([4, 5])],
  ])
  return { getBlob: (sha) => entries.get(sha) }
}

function decisionFor(subAction: SubActionEvidence): Decision {
  return {
    plan: subAction.plan,
    plannedAction: structuredClone(subAction.plannedAction),
    result: structuredClone(subAction.result),
  }
}

function addSelfHeal(handoff: CompletedRunHandoff): void {
  const step = handoff.tests[0]!.steps[0]!
  const failedSub = step.subActions[0]!
  const recoveringSub = structuredClone(failedSub)
  recoveringSub.plannedAction = { type: 'click', ref: asRef('e-continue-2') }
  step.subActions = [failedSub, recoveringSub]
  step.selfHeal = {
    failedDecision: decisionFor(failedSub),
    recoveringDecision: decisionFor(recoveringSub),
  }
}

function extract(handoff: CompletedRunHandoff): readonly ExtractedCassette[] {
  return extractRunCassettes({ handoff, artifacts: fullArtifacts() }).cassettes
}

function leafById(cassettes: readonly ExtractedCassette[], id: string): LeafCassette {
  const found = cassettes
    .map((entry) => entry.cassette)
    .find(
      (cassette): cassette is LeafCassette =>
        cassette.granularity === 'leaf' && cassette.id === id,
    )
  if (found === undefined) throw new Error(`missing leaf cassette ${id}`)
  return found
}

interface HealedSetup {
  pair: MintedContrastivePair
  failedCassette: LeafCassette
  recoveringCassette: LeafCassette
}

function healedSetup(mutate?: (handoff: CompletedRunHandoff) => void): HealedSetup {
  const handoff = makeArtifactRefV2Handoff()
  addSelfHeal(handoff)
  mutate?.(handoff)
  const cassettes = extract(handoff)
  const { pairs } = collectSelfHealPairs({ handoff, cassettes })
  const pair = pairs[0]!
  return {
    pair,
    failedCassette: leafById(cassettes, pair.failedCassetteId),
    recoveringCassette: leafById(cassettes, pair.recoveringCassetteId),
  }
}

function silverLeaf(mutate?: (handoff: CompletedRunHandoff) => void): LeafCassette {
  const handoff = makeArtifactRefV2Handoff()
  mutate?.(handoff)
  return leafById(extract(handoff), SILVER_LEAF_ID)
}

describe('projectPairLabelRecords (D-01/D-06/D-07/D-12)', () => {
  it('mints two near-gold self-heal-pair records with cross-linked pairing and pairState', () => {
    const { pair, failedCassette, recoveringCassette } = healedSetup()

    const [failedRecord, recoveringRecord] = projectPairLabelRecords({
      pair,
      failedCassette,
      recoveringCassette,
      runId: RUN_ID,
    })

    expect(failedRecord.schemaVersion).toBe(LABEL_RECORD_SCHEMA_VERSION)
    expect(failedRecord.cassetteId).toBe(FAILED_LEAF_ID)
    expect(failedRecord.label.sourceChannel).toBe('self-heal-pair')
    expect(failedRecord.label.tier).toBe('near-gold')
    expect(failedRecord.label.pairing).toEqual({
      pairedCassetteId: RECOVERING_LEAF_ID,
      relation: 'contrastive-negative',
    })

    expect(recoveringRecord.schemaVersion).toBe(LABEL_RECORD_SCHEMA_VERSION)
    expect(recoveringRecord.cassetteId).toBe(RECOVERING_LEAF_ID)
    expect(recoveringRecord.label.sourceChannel).toBe('self-heal-pair')
    expect(recoveringRecord.label.tier).toBe('near-gold')
    expect(recoveringRecord.label.pairing).toEqual({
      pairedCassetteId: FAILED_LEAF_ID,
      relation: 'contrastive-positive',
    })

    expect(failedRecord.pairState).toEqual({
      sameState: pair.sameState,
      screenStateHash: pair.failedScreenStateHash,
      pairedScreenStateHash: pair.recoveringScreenStateHash,
    })
    expect(recoveringRecord.pairState).toEqual({
      sameState: pair.sameState,
      screenStateHash: pair.recoveringScreenStateHash,
      pairedScreenStateHash: pair.failedScreenStateHash,
    })
  })

  it('preserves each member embedded-leg verdict and recordedFailure context', () => {
    const { pair, failedCassette, recoveringCassette } = healedSetup((handoff) => {
      handoff.tests[0]!.steps[0]!.verifierVerdict = {
        pass: false,
        reasoning: 'Continue stayed blocked after the recovery attempt',
      }
    })

    const [failedRecord, recoveringRecord] = projectPairLabelRecords({
      pair,
      failedCassette,
      recoveringCassette,
      runId: RUN_ID,
    })

    expect(failedCassette.label.recordedFailure).toBeDefined()
    expect(failedRecord.label.verdict).toEqual(failedCassette.label.verdict)
    expect(failedRecord.label.recordedFailure).toEqual(failedCassette.label.recordedFailure)
    expect(recoveringRecord.label.verdict).toEqual(recoveringCassette.label.verdict)
    expect(recoveringRecord.label.recordedFailure).toEqual(
      recoveringCassette.label.recordedFailure,
    )
  })
})

describe('projectSilverLabelRecord (D-01/D-12)', () => {
  it('carries the embedded recorded-verdict/silver leg verbatim with no pairing or pairState', () => {
    const cassette = silverLeaf()

    const record = projectSilverLabelRecord({ cassette, runId: RUN_ID })

    expect(record.schemaVersion).toBe(LABEL_RECORD_SCHEMA_VERSION)
    expect(record.cassetteId).toBe(SILVER_LEAF_ID)
    expect(record.label).toEqual(cassette.label)
    expect(record.label.sourceChannel).toBe('recorded-verdict')
    expect(record.label.tier).toBe('silver')
    expect(record.label.pairing).toBeUndefined()
    expect(record.pairState).toBeUndefined()
  })
})

describe('tier law (D-12)', () => {
  it('never mints the reserved top tier from any projection on pass or fail verdicts', () => {
    const tiers: string[] = []

    for (const failing of [false, true]) {
      const { pair, failedCassette, recoveringCassette } = healedSetup((handoff) => {
        if (failing) {
          handoff.tests[0]!.steps[0]!.verifierVerdict = {
            pass: false,
            reasoning: 'The recovery did not settle the step',
          }
        }
      })
      const records = projectPairLabelRecords({
        pair,
        failedCassette,
        recoveringCassette,
        runId: RUN_ID,
      })
      tiers.push(...records.map((record) => record.label.tier))
    }

    const passLeaf = silverLeaf()
    const failLeaf = silverLeaf((handoff) => {
      handoff.tests[0]!.steps[1]!.verifierVerdict = {
        pass: false,
        reasoning: 'The follow-up state regressed',
      }
    })
    tiers.push(projectSilverLabelRecord({ cassette: passLeaf, runId: RUN_ID }).label.tier)
    tiers.push(projectSilverLabelRecord({ cassette: failLeaf, runId: RUN_ID }).label.tier)

    expect(tiers).toHaveLength(6)
    for (const tier of tiers) {
      expect(['near-gold', 'silver']).toContain(tier)
    }
    expect(tiers).not.toContain('gold')
  })
})

describe('provenance (ROOT-03 base)', () => {
  it('stamps runId, runSlug, capturedAtOrdinal, and an independently recomputed receiptDigest', () => {
    const { pair, failedCassette, recoveringCassette } = healedSetup()
    const [failedRecord, recoveringRecord] = projectPairLabelRecords({
      pair,
      failedCassette,
      recoveringCassette,
      runId: RUN_ID,
    })
    const silverCassette = silverLeaf()
    const silverRecord = projectSilverLabelRecord({ cassette: silverCassette, runId: RUN_ID })

    const cases: Array<[StandaloneLabelRecord, LeafCassette]> = [
      [failedRecord, failedCassette],
      [recoveringRecord, recoveringCassette],
      [silverRecord, silverCassette],
    ]
    for (const [record, cassette] of cases) {
      expect(record.provenance).toEqual({
        runId: RUN_ID,
        runSlug: RUN_SLUG,
        capturedAtOrdinal: cassette.receipt.buildOrdinal,
        receiptDigest: sha256hex(canonicalJson(cassette.receipt)),
      })
      expect(record.provenance.capturedAtOrdinal).toBe(37)
    }
  })
})

describe('committedFileText (D-17 idempotence precondition)', () => {
  it('is byte-identical across key insertion orders, newline-terminated, and parseable', () => {
    const first = committedFileText({ b: 1, a: { d: 2, c: 3 } })
    const second = committedFileText({ a: { c: 3, d: 2 }, b: 1 })

    expect(first).toBe(second)
    expect(first.endsWith('\n')).toBe(true)
    expect(first.endsWith('\n\n')).toBe(false)
    expect(JSON.parse(first)).toEqual({ a: { c: 3, d: 2 }, b: 1 })
  })
})

describe('419 gold projections', () => {
  const mark = { kind: 'false-pass', markId: 'mark_0123456789ab', correctedExpectation: 'Stay blocked' } as GoldMark

  it.each(['false-fail', 'false-pass', 'confirmed-bug'] as const)('preserves the %s recorded verdict and adds only the appropriate correction', kind => {
    const cassette = silverLeaf()
    const input = { cassette, runId: RUN_ID, goldCassetteId: `${cassette.id}-gold-m01`, mark: { ...mark, kind } }
    const record = projectUserMarkLabelRecord(input)
    expect(record.label).toEqual({ ...cassette.label, sourceChannel: 'user-mark', tier: 'gold' })
    expect(record.provenance.sourceCassetteId).toBe(cassette.id)
    expect(record.correction).toEqual({ verdict: kind === 'false-fail' ? 'pass' : 'fail',
      overturnedVerdict: cassette.label.verdict, markId: mark.markId, correctedExpectation: mark.correctedExpectation })
    expect(Object.hasOwn(record, 'supersedes')).toBe(false)
  })

  it('stores the fail correction and expectation without mutating the observed cassette', () => {
    const cassette = silverLeaf()
    const before = JSON.stringify(cassette)
    const record = projectOverturnedVerdictLabelRecord({ cassette, runId: RUN_ID, goldCassetteId: 'gold', mark, supersedes: 'earlier-gold' })
    expect(record.label).toEqual({ ...cassette.label, sourceChannel: 'overturned-verdict', tier: 'gold' })
    expect(record.correction).toEqual({ verdict: 'fail', overturnedVerdict: cassette.label.verdict, correctedExpectation: 'Stay blocked', markId: mark.markId })
    expect(record.provenance.sourceCassetteId).toBe(cassette.id)
    expect(record.supersedes).toBe('earlier-gold')
    expect(JSON.stringify(cassette)).toBe(before)
    const { correctedExpectation: _, ...withoutExpectation } = mark
    const noText = projectOverturnedVerdictLabelRecord({ cassette, runId: RUN_ID, goldCassetteId: 'gold', mark: withoutExpectation })
    expect(Object.hasOwn(noText.correction!, 'correctedExpectation')).toBe(false)
  })

  it('does not synthesize missing verifier evidence', () => {
    const cassette = silverLeaf()
    delete cassette.label.verdict
    expect(() => projectOverturnedVerdictLabelRecord({ cassette, runId: RUN_ID, goldCassetteId: 'gold', mark })).toThrow('recorded verifier verdict')
  })

  it('keeps silver serialized bytes identical to the pre-419 shape', () => {
    const cassette = silverLeaf()
    expect(committedFileText(projectSilverLabelRecord({ cassette, runId: RUN_ID }))).toBe(committedFileText({
      schemaVersion: LABEL_RECORD_SCHEMA_VERSION, cassetteId: cassette.id, label: { ...cassette.label },
      provenance: { runId: RUN_ID, runSlug: RUN_SLUG, capturedAtOrdinal: cassette.receipt.buildOrdinal, receiptDigest: sha256hex(canonicalJson(cassette.receipt)) },
    }))
  })
})
