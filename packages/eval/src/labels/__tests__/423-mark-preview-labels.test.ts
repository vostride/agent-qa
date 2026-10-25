import { describe, expect, it } from 'vitest'
import { makeArtifactRefV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'
import { extractRunCassettes } from '../../extract/extract-run'
import { deriveRunSlug } from '../../extract/ids'
import * as goldenPlan from '../golden-plan'
import { MARK_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

type Kind = goldenPlan.GoldMark['kind']
type LabelIntent = goldenPlan.MarkLabelIntent
function api() {
  expect(typeof goldenPlan.previewMarkLabels, 'golden-plan must export previewMarkLabels').toBe('function')
  return goldenPlan
}

function setup(kind: Kind, stepIndex?: number) {
  const handoff = makeArtifactRefV2Handoff()
  handoff.tests[0]!.steps = handoff.tests[0]!.steps.slice(0, 2)
  const address = { runId: handoff.runId as goldenPlan.GoldMark['runId'], testIndex: 0,
    ...(stepIndex === undefined ? {} : { stepIndex }) }
  const receipt = (ordinal: number, extra: Partial<goldenPlan.GoldMark> = {}): goldenPlan.GoldMark => ({
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runSlug: deriveRunSlug(handoff.runId), kind, origin: 'user',
    ordinal, markedAt: 1_700_000_000_000, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 },
    gold: [], evidence: { confirmed: 0, overturned: 0 }, ...address, ...extra,
  })
  const cassettes = () => extractRunCassettes({ handoff, artifacts: { getBlob: () => new Uint8Array([1]) } }).cassettes
  return { handoff, address, receipt, cassettes }
}

describe('423-17 prospective gold labels without persistent identities (D-16)', () => {
  it('FALSE-PASS-TWO-LABELS: a false-pass previews both frozen label channels with corrected ground truth', () => {
    const { handoff, address } = setup('false-pass')
    const step = handoff.tests[0]!.steps[1]!
    const before = JSON.stringify(handoff)
    const mark: LabelIntent = { kind: 'false-pass', correctedExpectation: 'The checkout should remain blocked' }
    const preview = api().previewMarkLabels({ handoff, address, mark })
    if (preview.kind !== 'labels') throw new Error(`expected labels, got ${preview.kind}`)
    expect(preview.decisionCount).toBe(1)
    expect(preview.labels.map(label => label.channel)).toEqual(['user-mark', 'overturned-verdict'])
    const correction = { verdict: 'fail', overturnedVerdict: step.verifierVerdict,
      correctedExpectation: mark.correctedExpectation }
    expect(preview.labels.map(label => label.correction)).toEqual([correction, correction])
    expect(new Set(preview.labels.map(label => label.sourceCassetteId)).size).toBe(1)
    expect(preview.groundTruth).toEqual([{ testIndex: 0, stepIndex: 1, verdict: 'fail',
      recordedVerdict: step.verifierVerdict, correctedExpectation: mark.correctedExpectation }])
    const serialized = JSON.stringify(preview)
    for (const minted of ['markId', 'mark_', '-gold-m', 'markedAt', 'ordinal', '1700000000000']) {
      expect(serialized).not.toContain(minted)
    }
    expect(api().previewMarkLabels({ handoff, address, mark })).toEqual(preview)
    expect(JSON.stringify(handoff)).toBe(before)
  })

  it('TARGET-REASON: explicit, first failing and last-step targets keep their reason and refusal arms', () => {
    const preview = (kind: Kind, stepIndex?: number, mutate?: (h: ReturnType<typeof setup>['handoff']) => void,
      mark: Partial<LabelIntent> = {}) => {
      const { handoff, address } = setup(kind, stepIndex)
      mutate?.(handoff)
      return api().previewMarkLabels({ handoff, address, mark: { kind, ...mark } })
    }
    const failAll = (h: ReturnType<typeof setup>['handoff']) => {
      for (const step of h.tests[0]!.steps) step.verifierVerdict = { pass: false, reasoning: 'failure' }
    }
    expect(preview('false-fail', 0)).toMatchObject({ kind: 'labels', targets: [{ testIndex: 0, stepIndex: 0, reason: 'step-mark' }] })
    expect(preview('false-fail', undefined, failAll)).toMatchObject({ kind: 'labels',
      targets: [{ stepIndex: 0, reason: 'failing-step' }], groundTruth: [{ stepIndex: 0, verdict: 'pass' }] })
    expect(preview('confirmed-bug', undefined, failAll)).toMatchObject({ kind: 'labels',
      targets: [{ stepIndex: 0, reason: 'failing-step' }], groundTruth: [{ stepIndex: 0, verdict: 'fail' }] })
    expect(preview('confirmed-bug')).toMatchObject({ kind: 'labels', targets: [{ stepIndex: 1, reason: 'passing-verdict' }] })
    expect(preview('false-pass', undefined, failAll)).toMatchObject({ kind: 'labels',
      targets: [{ stepIndex: 1, reason: 'passing-verdict' }] })
    expect(preview('false-fail', 2)).toEqual({ kind: 'step-not-found', stepCount: 2 })
    expect(preview('false-fail', undefined, h => { h.tests[0]!.steps = [] })).toEqual({ kind: 'step-not-found', stepCount: 0 })
    const { handoff } = setup('false-fail', 0)
    const action = handoff.tests[0]!.steps[0]!.subActions[0]!.plannedAction
    expect(preview('false-fail', 0, h => {
      const step = h.tests[0]!.steps[0]!
      step.subActions.push(structuredClone(step.subActions[0]!))
    }, { correctedAction: action })).toEqual({ kind: 'ambiguous-correction', decisionCount: 2,
      targets: [{ testIndex: 0, stepIndex: 0, reason: 'step-mark' }] })
    expect(preview('confirmed-bug', undefined, undefined, { correctedAction: action })).toMatchObject({ kind: 'labels',
      decisionCount: 1, labels: [{ channel: 'user-mark', correction: { verdict: 'fail', correctedAction: action } }] })
  })

  it('LABEL-WRITER-PARITY: the preview selects exactly the labels the writer freezes', () => {
    const cases: [Kind, number | undefined, Partial<LabelIntent>][] = [
      ['false-fail', undefined, {}], ['false-fail', 0, { correctedExpectation: 'Continue' }],
      ['false-pass', undefined, {}], ['false-pass', 0, { correctedExpectation: 'Blocked' }],
      ['confirmed-bug', undefined, {}], ['confirmed-bug', 1, { correctedExpectation: 'Error shown' }],
    ]
    for (const [kind, stepIndex, extra] of cases) {
      const { handoff, address, receipt, cassettes } = setup(kind, stepIndex)
      for (const step of handoff.tests[0]!.steps) {
        step.subActions.push(structuredClone(step.subActions[0]!))
      }
      const preview = api().previewMarkLabels({ handoff, address, mark: { kind, ...extra } })
      if (preview.kind !== 'labels') throw new Error(`expected labels for ${kind}`)
      for (const ordinal of [1, 12, 100]) {
        const plan = goldenPlan.buildGoldenTrajectoryPlan({ handoff, cassettes: cassettes(), mark: receipt(ordinal, extra),
          product: 'example-web' })
        expect(plan.skipped).toEqual([])
        expect(preview.labels.map(({ channel, sourceCassetteId, correction }) => ({ channel, sourceCassetteId,
          ...(correction === undefined ? {} : { correction }) }))).toEqual(plan.cases.map(({ labelRecord }) => {
          const { markId: _, ...correction } = labelRecord.correction ?? { markId: '' }
          return { channel: labelRecord.label.sourceChannel, sourceCassetteId: labelRecord.provenance.sourceCassetteId,
            ...(labelRecord.correction === undefined ? {} : { correction }) }
        }))
        expect(preview.labels.map(label => [label.testIndex, label.stepIndex])).toEqual(plan.goldCassettes.map(
          ({ cassette }) => [cassette.testIndex, cassette.granularity === 'leaf' ? cassette.stepIndex : undefined]))
      }
      expect(preview.decisionCount).toBe(goldenPlan.markedDecisionCount(handoff, preview.targets))
    }
  })
})
