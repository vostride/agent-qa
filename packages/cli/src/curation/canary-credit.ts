// The credit pass: each outcome row's benefit from its run outcome, and the ride-along count.
import type { CanaryOutcome } from '@vostride/agent-qa-schema'
import type { NonSignalClass, ProjectedCanaryAttribution } from './emit-canary-outcomes.js'

export interface CanaryCreditCounters {
  rideAlongUncredited: number
  rerunExcluded: number
  nonSignal: Record<NonSignalClass, number>
}

export function emptyCanaryCreditCounters(): CanaryCreditCounters {
  return { rideAlongUncredited: 0, rerunExcluded: 0, nonSignal: { environment: 0, timeout: 0, flake: 0 } }
}

export type CreditedCanaryAttribution = ProjectedCanaryAttribution
export interface CanaryCreditInput {
  attributions: readonly ProjectedCanaryAttribution[]
}

export function creditCanaryAttributions(
  input: CanaryCreditInput,
): { attributions: CreditedCanaryAttribution[], counters: CanaryCreditCounters } {
  const counters = emptyCanaryCreditCounters()
  const attributions: CreditedCanaryAttribution[] = []
  for (const row of input.attributions) {
    if (row.kind !== 'outcome') {
      attributions.push(row)
      continue
    }
    const outcome: CanaryOutcome = { ...row.outcome,
      benefit: row.outcome.runOutcome === 'negative' ? 'exercised-harmed' : 'rode-along' }
    if (outcome.runOutcome === 'positive') counters.rideAlongUncredited += 1
    attributions.push({ ...row, outcome })
  }
  return { attributions, counters }
}
