// 422-20-T1 — the circularity disclosure, at the pure projection.
//
// A judge calibrated partly on cases the system itself authored TO FOOL JUDGES is measuring its
// own reflection. The cases are legitimate corpus members and removing them would be a different
// lie, so the mitigation is disclosure: state how much of the adversarial population is
// self-authored judge bait, who wrote it, and whether any of it reached the measured population.
//
// Three separations carry the whole weight, and each has a cell here:
//
//   - SELF-AUTHORED IS NOT ADVERSARIAL. A table-derived variant comes from a frozen hash-pinned
//     table and a seeded draw; no model authored it. Only the probe arm is self-authored bait, and
//     only its `judge-targeted` kind is aimed at a judge. Collapsing these would discount a
//     calibration number for the wrong population, which is as misleading as not discounting it.
//   - UNAVAILABLE IS NOT ZERO. A run that could not determine its bait content must SAY SO. A
//     disclosure that silently reads zero when its source is unreadable is worse than none.
//   - RAW IS NOT ADJUSTED. This block reports contamination; it does not correct for it. The
//     pooled agreement, its interval, the per-member rows and `minN` are byte-identical whether or
//     not the bait population is supplied.
import { describe, expect, it } from 'vitest'
import * as core from '../../index'
import { MATCHER_CONFIG } from '../../match/config'

const memberModelIds = ['claude-sonnet-4', 'gemini-2.5']

function observation(id: string): core.JudgeCalibrationProbeObservation {
  const members: core.JudgeMemberOutcome[] = memberModelIds.map((judgeModelId, index) => ({
    judgeModelId, judgeFamily: ['claude', 'gemini'][index]!,
    outcome: { kind: 'settled', resolution: 'equivalent', confidence: 'high' },
    usage: { calls: 2, inputTokens: 20, outputTokens: 4 },
  }))
  return { decisionId: id, replayedModelId: 'gpt-5',
    truth: { kind: 'resolved', fullMatch: true, provenance: 'deterministic-full-match' },
    eligibility: core.assessPanelEligibility({ memberModelIds, replayedModelId: 'gpt-5' }),
    kind: 'attempted', outcome: core.poolPanel(members),
    usage: { calls: 4, inputTokens: 40, outputTokens: 8, members },
    probe: { axis: 'element-identity',
      evidence: { stepText: 'Click continue', question: { kind: 'element-equivalence',
        gold: { role: 'button', nameNormalized: 'continue', ordinal: 0 },
        candidate: { role: 'button', nameNormalized: 'continue', ordinal: 0 } } },
      score: { kind: 'scored', matcherVersion: MATCHER_CONFIG.matcherVersion, tierReached: 2,
        axes: { elementIdentity: { kind: 'scored', level: 'full', numeric: 1, tier: 2 } as never,
          opClass: { kind: 'match' } as never, value: { kind: 'not-applicable' } },
        loop: { kind: 'not-flagged' } as never } } }
}

const probe = (kind: core.ProbeGeneratorKind, id: string, family: string): core.CorpusGenerator => ({
  kind, seedCassetteId: 'seed-natural', generatorVersion: 2,
  authoringModel: { id, family }, promptVersion: 1,
})
const table: core.CorpusGenerator = { kind: 'fuzz-label', seedCassetteId: 'seed-natural',
  generatorVersion: 2, mutator: 'confusable', tableVersion: 2, tableHash: '2'.repeat(64) }
const legacy: core.CorpusGenerator = { kind: 'fuzz-selector', seedCassetteId: 'seed-natural', generatorVersion: 1 }

/** Two models: one IS a calibration panel member, one is not. Both authored judge bait. */
const population: core.JudgeTargetedCalibrationMember[] = [
  { cassetteId: 'adv-1', generator: table },
  { cassetteId: 'adv-2', generator: probe('judge-targeted', 'claude-sonnet-4', 'claude') },
  { cassetteId: 'adv-3', generator: probe('judge-targeted', 'outside-author', 'mistral') },
  { cassetteId: 'adv-4', generator: probe('optimized-trigger', 'claude-sonnet-4', 'claude') },
  { cassetteId: 'adv-5', generator: legacy },
  { cassetteId: 'adv-6' },
]

const project = (input: Parameters<typeof core.projectJudgeTargetedCalibration>[0]) =>
  core.projectJudgeTargetedCalibration(input)

describe('judge-targeted self-authored bait disclosure', () => {
  it('identifies self-authored judge-targeted bait and never sums it with the table-derived arm', () => {
    const disclosure = project({ members: population, memberModelIds })
    expect(disclosure.source).toBe('resolved')
    if (disclosure.source !== 'resolved') throw new Error('unreachable')
    expect(disclosure).toMatchObject({ basis: 'raw', total: 6, metadataUnavailable: 1,
      judgeTargeted: 2, selfAuthored: 1, observedInCalibration: 0 })
    // Closed sets read zero; the two derivation paths are counted apart and never added.
    expect(disclosure.byProvenance).toEqual({ absent: 1, table: 1, probe: 3, malformed: 0 })
    expect(disclosure.byKind).toEqual({ 'fuzz-selector': 1, 'fuzz-label': 1, 'fuzz-error': 0,
      'injection-name': 0, 'optimized-trigger': 1, 'judge-targeted': 2 })
    expect(disclosure.byAuthoringModel).toEqual([
      { authoringModel: 'claude-sonnet-4', authoringFamily: 'claude', panelMember: true,
        probeAuthored: 2, judgeTargeted: 1 },
      { authoringModel: 'outside-author', authoringFamily: 'mistral', panelMember: false,
        probeAuthored: 1, judgeTargeted: 1 },
    ])
  })

  it('counts a judge-targeted member that reached the measured population instead of assuming none did', () => {
    const clean = project({ members: population, memberModelIds, observedCassetteIds: ['adv-1', 'adv-5'] })
    const dirty = project({ members: population, memberModelIds, observedCassetteIds: ['adv-2'] })
    expect(clean).toMatchObject({ source: 'resolved', observedInCalibration: 0 })
    expect(dirty).toMatchObject({ source: 'resolved', observedInCalibration: 1 })
  })

  it('says unavailable rather than reporting a clean zero when the bait source cannot be read', () => {
    for (const reason of core.JUDGE_TARGETED_CALIBRATION_UNAVAILABLE_REASONS) {
      const disclosure = project({ memberModelIds, unavailable: reason })
      expect(disclosure).toEqual({ basis: 'raw', source: 'unavailable', reason })
      // An unavailable source carries NO count at all — a zero here would read as "measured none".
      expect(Object.hasOwn(disclosure, 'judgeTargeted')).toBe(false)
      expect(Object.hasOwn(disclosure, 'total')).toBe(false)
    }
    // An empty committed population is a different fact: it is a MEASURED zero and says so.
    expect(project({ members: [], memberModelIds })).toMatchObject({ source: 'resolved',
      total: 0, judgeTargeted: 0, selfAuthored: 0, byAuthoringModel: [] })
  })

  it('summarizes raw: supplying the bait population adjusts no calibration number', () => {
    const observations = [observation('one'), observation('two')]
    const without = core.summarizeJudgeCalibration({ observations, memberModelIds })
    const with_ = core.summarizeJudgeCalibration({ observations, memberModelIds,
      judgeTargeted: { members: population } })
    for (const key of ['status', 'n', 'minN', 'minNSource', 'counts', 'pooled', 'perMember',
      'pooledAgreement', 'wilson95', 'abstention', 'disagreement', 'cost'] as const) {
      expect(with_[key]).toEqual(without[key])
    }
    expect(with_.judgeTargeted).toMatchObject({ basis: 'raw', source: 'resolved', judgeTargeted: 2, selfAuthored: 1 })
    // A caller that supplied no population never gets a zero standing in for "not read".
    expect(without.judgeTargeted).toEqual({ basis: 'raw', source: 'unavailable', reason: 'not-read' })
  })

  it('discloses a singleton author without claiming the panel capability that singleton lacks', () => {
    const disclosure = project({ members: population, memberModelIds: ['claude-sonnet-4'] })
    expect(disclosure.source).toBe('resolved')
    if (disclosure.source !== 'resolved') throw new Error('unreachable')
    expect(disclosure.selfAuthored).toBe(1)
    // The disclosure names authorship only. It carries no calibration status, n or interval, so a
    // probe-author-capable host cannot read it as evidence that a judge panel could be calibrated.
    for (const key of ['status', 'n', 'minN', 'pooledAgreement', 'wilson95', 'perMember']) {
      expect(Object.hasOwn(disclosure, key)).toBe(false)
    }
  })
})
