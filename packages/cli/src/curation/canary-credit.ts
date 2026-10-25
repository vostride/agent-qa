// The credit pass: each served outcome row's benefit, observed state digest and state validity.
import type { CanaryOutcome, CompletedRunHandoff } from '@vostride/agent-qa-schema'
import {
  actedPair,
  canonicalJson,
  distilledScreenStateDigest,
  exercisedAnchors,
  normalizeAnchor,
} from '@vostride/agent-qa-schema'
import type { LocalCurationCapabilities } from '@vostride/agent-qa-agent-local'
import type { NonSignalClass, ProjectedCanaryAttribution } from './emit-canary-outcomes.js'
import { actedSubAction } from './handoff-anchors.js'

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
  knowledgeRoot: string
  readBundleStateDigests: LocalCurationCapabilities['readCanonicalBundleStateDigests']
  attributions: readonly ProjectedCanaryAttribution[]
  handoff: CompletedRunHandoff
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
    const served = row.source === 'served-brief'
    const outcome: CanaryOutcome = { ...row.outcome, stateValidity: 'unknown',
      benefit: row.outcome.runOutcome === 'negative' ? 'exercised-harmed' : 'rode-along' }
    // Recompute evidence from this pass rather than inheriting a prior projection's citation.
    delete outcome.corpusDigest
    delete outcome.observedStateDigest
    delete outcome.ablation
    if (served) {
      const step = input.handoff.tests.find((test) =>
        test.testIndex === outcome.testIndex && test.testId === outcome.testId)
        ?.steps.find((candidate) => candidate.stepIndex === outcome.stepIndex)
      // Cache-prefix state is not the live decision's input, and the step-only address cannot
      // disambiguate multiple live decisions. The unique live action must exercise THIS row's anchor.
      const live = step?.subActions?.filter(action => action.exchanges !== undefined) ?? []
      const action = live.length === 1 ? live[0] : undefined
      // A healed decision is credited against the pair it dispatched.
      const acted = action === undefined ? undefined : actedSubAction(action)
      const observed = step !== undefined && acted !== undefined
        && exercisedAnchors({ ...step, subActions: [acted] }).some(anchor =>
          canonicalJson(normalizeAnchor(anchor)) === canonicalJson(normalizeAnchor(outcome.exercisedAnchor)))
        ? actedPair(acted).stateBefore : undefined
      if (observed !== undefined) outcome.observedStateDigest = distilledScreenStateDigest(observed)
      const bundle = input.readBundleStateDigests({
        knowledgeRoot: input.knowledgeRoot, candidateId: outcome.candidateId,
      })
      if (outcome.observedStateDigest !== undefined && bundle.kind === 'found' && bundle.digests.length > 0) {
        outcome.stateValidity = bundle.digests.includes(outcome.observedStateDigest) ? 'valid' : 'stale'
      }
    }
    if (outcome.runOutcome === 'positive') counters.rideAlongUncredited += 1
    attributions.push({ ...row, outcome })
  }
  return { attributions, counters }
}
