import { asRef } from '@vostride/agent-qa-schema'
import type { Action } from '@vostride/agent-qa-schema'
import { makeScreenState } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import type { CassetteSidecarLeg } from '../../cassette/sidecar-leg'
import {
  actionsFactory,
  fixedIncrementClock,
  leafCassette,
  makeLabel,
  makeReceipt,
  makeSidecar,
} from '../../replay/__tests__/fixtures'
import { computeDecisionIdentity } from '../../replay/identity'
import type { ReplayEscalationContext } from '../../replay/ports'
import { replayCassette } from '../../replay/replay-run'
import type { DecisionReplayResult, ReplaySample } from '../../replay/result'
import { tiersSettlePredicate } from '../predicate'

const screen = makeScreenState()
const emptyArtifacts = { getBlob: () => undefined }
const buttonAction = { type: 'click', ref: asRef('e2') } as const satisfies Action
const buttonAnchor = { role: 'button', nameNormalized: 'log in', ordinal: 0 }

function buttonSidecar(
  overrides: Partial<CassetteSidecarLeg> = {},
): CassetteSidecarLeg {
  return makeSidecar({
    goldAction: buttonAction,
    opClass: 'click',
    goldAnchor: buttonAnchor,
    equivalenceSet: [{ ...buttonAnchor, ref: 'gold-button' }],
    ...overrides,
  })
}

function fillAction(text: string): Action {
  return {
    type: 'fill',
    ref: asRef('e1'),
    text,
    clearMode: 'replace',
    submit: false,
  }
}

function context(sidecar: CassetteSidecarLeg): ReplayEscalationContext {
  return {
    cassetteId: 'cassette-predicate',
    decisionOrdinal: 0,
    sidecar,
    receipt: makeReceipt(),
  }
}

function decisionSample(
  action: Action,
  identity = computeDecisionIdentity(action, screen.elements),
): ReplaySample {
  return {
    sampleIndex: 0,
    outcome: { kind: 'decision', action, identity },
    durationMs: 10,
  }
}

describe('tiersSettlePredicate', () => {
  it('settles a full deterministic match at the first sample', () => {
    const sidecar = buttonSidecar()

    expect(tiersSettlePredicate(decisionSample(buttonAction), context(sidecar))).toBe(false)
  })

  it('escalates every single-sample tie cause', () => {
    const partialIdentity = decisionSample(buttonAction, {
      opClass: 'click',
      target: { ...buttonAnchor, ordinal: 2 },
    })
    const valueSidecar = makeSidecar({
      goldAction: fillAction('alpha beta gamma delta'),
      opClass: 'fill',
      goldValue: 'alpha beta gamma delta',
      goldAnchor: { role: 'textbox', nameNormalized: 'email', ordinal: 0 },
      equivalenceSet: [
        { role: 'textbox', nameNormalized: 'email', ordinal: 0, ref: 'gold-input' },
      ],
    })

    expect(tiersSettlePredicate(partialIdentity, context(buttonSidecar()))).toBe(true)
    expect(
      tiersSettlePredicate(decisionSample(fillAction('alpha beta')), context(valueSidecar)),
    ).toBe(true)
  })

  it('settles hard misses, scoreable failures, and harness errors without escalation', () => {
    const sidecar = buttonSidecar()
    const plannerFailure: ReplaySample = {
      sampleIndex: 0,
      outcome: {
        kind: 'planner-failure',
        reason: 'step_failed',
        message: 'recorded planner failure',
      },
      durationMs: 10,
    }
    const harnessError: ReplaySample = {
      sampleIndex: 0,
      outcome: { kind: 'harness-error', message: 'provider unavailable' },
      durationMs: 10,
    }

    expect(tiersSettlePredicate(decisionSample(fillAction('wrong op')), context(sidecar))).toBe(
      false,
    )
    expect(tiersSettlePredicate(plannerFailure, context(sidecar))).toBe(false)
    expect(tiersSettlePredicate(harnessError, context(sidecar))).toBe(false)
  })

  it('composes with replay: settled spends k=1 while a tie spends k=3', async () => {
    const settledProbe = actionsFactory([buttonAction, buttonAction, buttonAction])
    const settled = (await replayCassette({
      cassette: leafCassette({ sidecar: buttonSidecar(), label: makeLabel() }),
      artifacts: emptyArtifacts,
      plannerFactory: settledProbe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: tiersSettlePredicate,
    })) as DecisionReplayResult

    const tieAnchor = { ...buttonAnchor, ordinal: 1 }
    const tieProbe = actionsFactory([buttonAction, buttonAction, buttonAction])
    const escalated = (await replayCassette({
      cassette: leafCassette({
        sidecar: buttonSidecar({
          goldAnchor: tieAnchor,
          equivalenceSet: [{ ...tieAnchor, ref: 'gold-button' }],
        }),
      }),
      artifacts: emptyArtifacts,
      plannerFactory: tieProbe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: tiersSettlePredicate,
    })) as DecisionReplayResult

    expect(settledProbe.createCount()).toBe(1)
    expect(settled.samples).toHaveLength(1)
    expect(settled.agreement.k).toBe(1)

    expect(tieProbe.createCount()).toBe(3)
    expect(escalated.samples).toHaveLength(3)
    expect(escalated.agreement).toMatchObject({
      k: 3,
      agreementRate: 1,
      noConsensus: false,
      modal: { count: 3 },
    })
  })
})
