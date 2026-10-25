import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeArtifactRefV2Handoff } from '../../__tests__/fixtures/handoff-fixtures'
import { extractRunCassettes } from '../../extract/extract-run'
import { deriveGoldCassetteId, deriveRunSlug } from '../../extract/ids'
import { isProposerVisibleEntry } from '../corpus-entry'
import { buildGoldenTrajectoryPlan, resolveMarkedDecisions, type GoldMark } from '../golden-plan'
import * as splitAssignment from '../split-assignment'
import { MARK_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

function setup(kind: GoldMark['kind'] = 'false-fail', stepIndex?: number) {
  const handoff = makeArtifactRefV2Handoff()
  // The base fixture ends in a cached-only step. Use two live steps for gold cells.
  handoff.tests[0]!.steps = handoff.tests[0]!.steps.slice(0, 2)
  const mark: GoldMark = {
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: 'mark_0123456789ab', runId: handoff.runId as GoldMark['runId'],
    runSlug: deriveRunSlug(handoff.runId), testIndex: 0, kind, origin: 'user', ordinal: 1,
    markedAt: 0, disposition: { kind: 'confirmed-bug', confirmedRecords: 0 },
    gold: [], evidence: { confirmed: 0, overturned: 0 },
    ...(stepIndex === undefined ? {} : { stepIndex }),
  }
  const extract = () => extractRunCassettes({ handoff, artifacts: { getBlob: () => new Uint8Array([1]) } }).cassettes
  const build = () => buildGoldenTrajectoryPlan({ handoff, mark, product: 'example-web', cassettes: extract() })
  return { handoff, mark, extract, build }
}

afterEach(() => vi.restoreAllMocks())

describe('golden plan (419 D-05/D-06/D-11)', () => {
  it('freezes exactly every decision on the marked step, preserving all source bytes', () => {
    const { handoff, mark, extract } = setup('false-fail', 0)
    const step = handoff.tests[0]!.steps[0]!
    step.subActions.push(structuredClone(step.subActions[0]!))
    step.verifierVerdict = { pass: false, reasoning: 'recorded failure' }
    const cassettes = extract()
    const before = JSON.stringify(cassettes)
    const spy = vi.spyOn(splitAssignment, 'assignSplit')
    const plan = buildGoldenTrajectoryPlan({ handoff, mark, product: 'example-web', cassettes })
    const sources = cassettes.filter(({ cassette }) => cassette.granularity === 'leaf' && cassette.testIndex === 0 && cassette.stepIndex === 0)
    expect(sources).toHaveLength(2)
    expect(plan.cases.map(c => c.labelRecord.provenance.sourceCassetteId)).toEqual(sources.map(e => e.cassette.id))
    expect(plan.goldCassettes).toHaveLength(2)
    for (const [index, item] of plan.cases.entries()) {
      expect(item.cassetteId).toBe(`${sources[index]!.cassette.id}-gold-m01`)
      expect(item.corpusEntry).toMatchObject({ split: 'held-out', heldOutVisibility: 'private' })
      expect(isProposerVisibleEntry(item.corpusEntry)).toBe(false)
      expect(item.labelRecord.correction?.verdict).toBe('pass')
      expect(plan.goldCassettes[index]).toEqual({ ...sources[index], cassette: { ...sources[index]!.cassette, id: item.cassetteId } })
    }
    expect(spy).toHaveBeenCalledTimes(0)
    expect(JSON.stringify(cassettes)).toBe(before)
    expect(plan.cases).toEqual([...plan.cases].sort((a, b) => a.cassetteId.localeCompare(b.cassetteId)))
  })

  it.each(['false-fail', 'confirmed-bug'] as const)('%s selects the first failing step only', kind => {
    const { handoff, mark, build } = setup(kind)
    for (const step of handoff.tests[0]!.steps) step.verifierVerdict = { pass: false, reasoning: 'failure' }
    expect(resolveMarkedDecisions(handoff, mark, kind)).toEqual([{ testIndex: 0, stepIndex: 0, reason: 'failing-step' }])
    expect(build().goldCassettes.every(e => e.cassette.granularity === 'leaf' && e.cassette.stepIndex === 0)).toBe(true)
  })

  it('false-pass selects the last step and emits both gold channels with observed action intact', () => {
    const { handoff, mark, build } = setup('false-pass')
    mark.correctedExpectation = 'The checkout should remain blocked'
    const plan = build()
    expect(resolveMarkedDecisions(handoff, mark, mark.kind)).toEqual([{ testIndex: 0, stepIndex: 1, reason: 'passing-verdict' }])
    expect(plan.cases.map(c => c.labelRecord.label.sourceChannel).sort()).toEqual(['overturned-verdict', 'user-mark'])
    expect(plan.cases.find(c => c.labelRecord.label.sourceChannel === 'overturned-verdict')?.labelRecord.correction).toEqual({
      verdict: 'fail', overturnedVerdict: handoff.tests[0]!.steps[1]!.verifierVerdict,
      correctedExpectation: mark.correctedExpectation, markId: mark.markId,
    })
    expect(plan.cases.every(c => !isProposerVisibleEntry(c.corpusEntry))).toBe(true)
  })

  it('discloses the last-step fallback when no step failed', () => {
    const { handoff, mark } = setup()
    expect(resolveMarkedDecisions(handoff, mark, mark.kind)).toEqual([{ testIndex: 0, stepIndex: 1, reason: 'passing-verdict' }])
  })

  it('refuses the exclusive upper bound and an empty member', () => {
    const { handoff, mark, build } = setup('false-fail', 2)
    expect(resolveMarkedDecisions(handoff, mark, mark.kind)).toEqual({ refusal: 'step-not-found', stepCount: 2 })
    expect(build).toThrow('step-not-found')
    delete mark.stepIndex
    handoff.tests[0]!.steps = []
    expect(resolveMarkedDecisions(handoff, mark, mark.kind)).toEqual({ refusal: 'step-not-found', stepCount: 0 })
  })

  it('refuses mismatched run/member identities and duplicate source ids', () => {
    const { handoff, mark, extract } = setup('confirmed-bug', 0)
    expect(() => resolveMarkedDecisions(handoff, { ...mark, testId: 'other' }, mark.kind)).toThrow('member')
    expect(() => resolveMarkedDecisions(handoff, { ...mark, runId: 'other' as GoldMark['runId'] }, mark.kind)).toThrow('run')
    const cassettes = extract()
    expect(() => buildGoldenTrajectoryPlan({ handoff, mark, product: 'p', cassettes: [...cassettes, cassettes[0]!] })).toThrow('duplicate')
  })

  it('accounts for missing and non-leaf sources without admitting them', () => {
    const { handoff, mark, extract } = setup('confirmed-bug', 0)
    const cassettes = extract()
    const leaf = cassettes[0]!
    const missing = buildGoldenTrajectoryPlan({ handoff, mark, product: 'p', cassettes: [] })
    expect(missing.cases).toEqual([])
    expect(missing.skipped).toEqual([{ cassetteId: leaf.cassette.id, reason: 'missing-cassette' }])
    const procedure = cassettes.find(e => e.cassette.granularity === 'procedure')!
    expect(buildGoldenTrajectoryPlan({ handoff, mark, product: 'p', cassettes: [{ ...procedure, cassette: { ...procedure.cassette, id: leaf.cassette.id } }] }).skipped).toEqual([{ cassetteId: leaf.cassette.id, reason: 'not-leaf' }])
  })

  it('re-marks mint distinct ids and point to the prior gold case', () => {
    const { handoff, mark, extract, build } = setup('confirmed-bug', 0)
    const oldId = build().cases[0]!.cassetteId
    mark.ordinal = 2
    const plan = buildGoldenTrajectoryPlan({ handoff, mark, product: 'p', cassettes: extract(), supersedes: oldId })
    expect(plan.cases[0]!.cassetteId).toMatch(/-gold-m02$/)
    expect(plan.cases[0]!.labelRecord.supersedes).toBe(oldId)
    expect(deriveGoldCassetteId({ leafCassetteId: 'leaf', markOrdinal: 100 })).toBe('leaf-gold-m100')
  })
})
