import { asRecordId } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { creditCanaryAttributions } from '../canary-credit.js'
import type { ProjectedCanaryAttribution } from '../emit-canary-outcomes.js'

function row(candidateId = 'candidate-checkout', runOutcome: 'positive' | 'negative' = 'positive'): Extract<ProjectedCanaryAttribution, { kind: 'outcome' }> {
  return { kind: 'outcome', source: 'served-brief', outcome: {
    candidateId: asRecordId(candidateId), runOutcome, benefit: 'rode-along',
    runId: 'run-credit', testId: 'checkout', testIndex: 0, stepIndex: 0,
    buildOrdinal: 43, briefDigest: 'brief', attribution: 'Checkout exercised',
    exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
  } }
}
function credit(attributions: ProjectedCanaryAttribution[]) {
  return creditCanaryAttributions({ attributions })
}
describe('canary credit pass', () => {
  it('counts every positive row as ride-along, served or replayed, and no negative row', () => {
    const later = row()
    later.outcome.stepIndex = 1
    const report = credit([row('a'), later, { ...row('b'), source: 'procedure-replay' }, row('c', 'negative')])
    expect(report.counters).toEqual({ rideAlongUncredited: 3, rerunExcluded: 0,
      nonSignal: { environment: 0, timeout: 0, flake: 0 } })
  })
  it('a row\'s benefit follows its run outcome', () => {
    const harmed = row('candidate-checkout', 'negative')
    harmed.outcome.stepIndex = 1
    const report = credit([row('candidate-checkout'), harmed, { ...row('procedure', 'negative'), source: 'procedure-replay' }])
    expect(report.attributions.map(attribution =>
      attribution.kind === 'outcome'
        ? `${attribution.outcome.stepIndex}:${attribution.outcome.benefit}`
        : 'not-an-outcome')).toEqual(['0:rode-along', '1:exercised-harmed', '0:exercised-harmed'])
  })
  it('unresolved rows pass through untouched', () => {
    const unresolved: ProjectedCanaryAttribution = { kind: 'unresolved', source: 'served-brief',
      candidateId: asRecordId('missing'), testId: 'checkout', testIndex: 0, stepIndex: 0, reason: 'not-found' }
    expect(credit([unresolved]).attributions[0]).toBe(unresolved)
  })
})
