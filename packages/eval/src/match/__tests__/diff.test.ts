import { asRef } from '@vostride/agent-qa-schema'
import type { Action } from '@vostride/agent-qa-schema'
import { makeScreenState } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import type { CassetteSidecarLeg } from '../../cassette/sidecar-leg'
import { makeSidecar } from '../../replay/__tests__/fixtures'
import { computeDecisionIdentity } from '../../replay/identity'
import type { DecisionIdentity } from '../../replay/identity'
import type {
  DecisionReplayResult,
  ReplaySampleOutcome,
} from '../../replay/result'
import { MATCHER_CONFIG } from '../config'
import { buildDecisionDiff } from '../diff'
import { scoreDecision } from '../score'

const screen = makeScreenState()
const buttonAction = { type: 'click', ref: asRef('e2') } as const satisfies Action
const buttonAnchor = { role: 'button', nameNormalized: 'log in', ordinal: 0 }

function buttonSidecar(): CassetteSidecarLeg {
  return makeSidecar({
    goldAction: buttonAction,
    opClass: 'click',
    goldAnchor: buttonAnchor,
    equivalenceSet: [{ ...buttonAnchor, ref: 'recorded-ref' }],
  })
}

function decisionResult(outcome: ReplaySampleOutcome): DecisionReplayResult {
  const modal =
    outcome.kind === 'decision'
      ? { identity: outcome.identity, count: 1 }
      : undefined
  return {
    cassetteId: 'cassette-diff',
    briefSource: 'empty',
    samples: [{ sampleIndex: 0, outcome, durationMs: 12 }],
    agreement: {
      k: 1,
      agreementRate: 1,
      ...(modal === undefined ? {} : { modal }),
      noConsensus: false,
      harnessErrorCount: 0,
    },
    ...(modal === undefined ? {} : { modalDecision: modal.identity }),
    promptDrift: {
      drift: true,
      harnessDrift: true,
      recordedHash: 'recorded-hash',
      recomputedHash: 'recomputed-hash',
    },
    recordedModel: { provider: 'recorded', modelId: 'model-a' },
    replayedModel: { provider: 'replayed', modelId: 'model-b' },
    unconsumedExchanges: [],
    totalDurationMs: 12,
  }
}

function decisionOutcome(
  action: Action,
  identity: DecisionIdentity = computeDecisionIdentity(action, screen.elements),
): ReplaySampleOutcome {
  return { kind: 'decision', action, identity }
}

describe('buildDecisionDiff', () => {
  it('projects a settled score into an attribution-grade gold/candidate DTO', () => {
    const sidecar = buttonSidecar()
    const result = decisionResult(decisionOutcome(buttonAction))
    const score = scoreDecision(sidecar, result)
    expect(score.kind).toBe('scored')
    if (score.kind !== 'scored') return

    const diff = buildDecisionDiff({
      cassetteId: result.cassetteId,
      stepIndex: 3,
      decisionOrdinal: 0,
      sidecar,
      elements: screen.elements,
      result,
      score,
    })

    expect(diff).toMatchObject({
      kind: 'scored',
      cassetteId: result.cassetteId,
      stepIndex: 3,
      decisionOrdinal: 0,
      goldIdentity: {
        opClass: 'click',
        target: buttonAnchor,
      },
      candidateIdentity: {
        opClass: 'click',
        target: buttonAnchor,
      },
      tierReached: 2,
      axes: score.axes,
      loop: { kind: 'not-applicable' },
      replay: {
        promptDrift: result.promptDrift,
        agreement: result.agreement,
        recordedModel: result.recordedModel,
        replayedModel: result.replayedModel,
      },
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
  })

  it('names a recorded failure without fabricating candidate identity or axes', () => {
    const sidecar = buttonSidecar()
    const result = decisionResult({
      kind: 'planner-failure',
      reason: 'ungroundable_action',
      message: 'recorded planner failure',
    })
    const score = scoreDecision(sidecar, result)
    expect(score.kind).toBe('miss-by-failure')
    if (score.kind !== 'miss-by-failure') return

    const diff = buildDecisionDiff({
      cassetteId: result.cassetteId,
      decisionOrdinal: 0,
      sidecar,
      elements: screen.elements,
      result,
      score,
    })

    expect(diff).toMatchObject({
      kind: 'miss-by-failure',
      reason: 'ungroundable_action',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
    expect(Object.hasOwn(diff, 'candidateIdentity')).toBe(false)
    expect(Object.hasOwn(diff, 'axes')).toBe(false)
    expect(Object.hasOwn(diff, 'tierReached')).toBe(false)
  })

  it('preserves the enumerated tie cause and partial breakdown', () => {
    const sidecar = buttonSidecar()
    const result = decisionResult(
      decisionOutcome(buttonAction, {
        opClass: 'click',
        target: { ...buttonAnchor, ordinal: 2 },
      }),
    )
    const score = scoreDecision(sidecar, result)
    expect(score.kind).toBe('unresolved-tie')
    if (score.kind !== 'unresolved-tie') return

    const diff = buildDecisionDiff({
      cassetteId: result.cassetteId,
      decisionOrdinal: 0,
      sidecar,
      elements: screen.elements,
      result,
      score,
    })

    expect(diff).toMatchObject({
      kind: 'unresolved-tie',
      cause: 'partial-identity',
      candidateIdentity: {
        opClass: 'click',
        target: { ...buttonAnchor, ordinal: 2 },
      },
      partial: score.partial,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
  })

  it('is stable under a JSON round trip and emits no undefined-valued keys', () => {
    const sidecar = buttonSidecar()
    const result = decisionResult(decisionOutcome(buttonAction))
    const score = scoreDecision(sidecar, result)
    expect(score.kind).toBe('scored')
    if (score.kind !== 'scored') return

    const diff = buildDecisionDiff({
      cassetteId: result.cassetteId,
      decisionOrdinal: 0,
      sidecar,
      elements: screen.elements,
      result,
      score,
    })

    expect(JSON.parse(JSON.stringify(diff))).toEqual(diff)
    expect(Object.values(diff).every(value => value !== undefined)).toBe(true)
  })
})
