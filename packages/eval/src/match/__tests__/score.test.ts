import { asRef } from '@vostride/agent-qa-schema'
import type { Action, ActionAnnotation } from '@vostride/agent-qa-schema'
import { makeScreenState } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import type { CassetteSidecarLeg } from '../../cassette/sidecar-leg'
import {
  leafCassette,
  makeSidecar,
  procedureCassette,
} from '../../replay/__tests__/fixtures'
import {
  computeDecisionIdentity,
  decisionIdentityKey,
} from '../../replay/identity'
import type { DecisionIdentity } from '../../replay/identity'
import type {
  DecisionReplayResult,
  ProcedureReplayResult,
  ReplayAgreement,
  ReplaySample,
  ReplaySampleOutcome,
} from '../../replay/result'
import { MATCHER_CONFIG } from '../config'
import {
  scoreCassetteReplay,
  scoreDecision,
} from '../score'

const screen = makeScreenState()
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

function fillSidecar(goldValue: string): CassetteSidecarLeg {
  const goldAction = fillAction(goldValue)
  return makeSidecar({
    goldAction,
    opClass: 'fill',
    goldValue,
    goldAnchor: { role: 'textbox', nameNormalized: 'email', ordinal: 0 },
    equivalenceSet: [
      { role: 'textbox', nameNormalized: 'email', ordinal: 0, ref: 'gold-input' },
    ],
  })
}

function decisionOutcome(
  action: Action,
  identity: DecisionIdentity = computeDecisionIdentity(action, screen.elements),
): ReplaySampleOutcome {
  return { kind: 'decision', action, identity }
}

interface ResultOptions {
  noConsensus?: boolean
  modalIdentity?: DecisionIdentity
  modalCount?: number
  agreementRate?: number
}

function decisionResult(
  outcomes: readonly ReplaySampleOutcome[],
  options: ResultOptions = {},
): DecisionReplayResult {
  const samples: ReplaySample[] = outcomes.map((outcome, sampleIndex) => ({
    sampleIndex,
    outcome,
    durationMs: 10,
  }))
  const firstDecision = outcomes.find(
    (outcome): outcome is Extract<ReplaySampleOutcome, { kind: 'decision' }> =>
      outcome.kind === 'decision',
  )
  const noConsensus = options.noConsensus ?? false
  const modalIdentity = options.modalIdentity ?? firstDecision?.identity
  const modal =
    noConsensus || modalIdentity === undefined
      ? undefined
      : { identity: modalIdentity, count: options.modalCount ?? 1 }
  const agreement: ReplayAgreement = {
    k: outcomes.length,
    agreementRate: options.agreementRate ?? (modal === undefined ? 0 : modal.count / outcomes.length),
    ...(modal === undefined ? {} : { modal }),
    noConsensus,
    harnessErrorCount: outcomes.filter(outcome => outcome.kind === 'harness-error').length,
  }

  return {
    cassetteId: 'cassette-score',
    briefSource: 'empty',
    samples,
    agreement,
    ...(modal === undefined ? {} : { modalDecision: modal.identity }),
    promptDrift: { drift: false, harnessDrift: false, recordedHash: 'hash', recomputedHash: 'hash' },
    replayedModel: { provider: 'test', modelId: 'model-1' },
    unconsumedExchanges: [],
    totalDurationMs: samples.length * 10,
  }
}

describe('scoreDecision', () => {
  it('returns a settled full multi-axis score for a k=1 valueless decision', () => {
    const score = scoreDecision(
      buttonSidecar(),
      decisionResult([decisionOutcome(buttonAction)]),
    )

    expect(score).toEqual({
      kind: 'scored',
      axes: {
        elementIdentity: {
          kind: 'scored',
          level: 'full',
          numeric: MATCHER_CONFIG.identityLadder.full,
          tier: 2,
        },
        opClass: { kind: 'match', opClass: 'activate' },
        value: { kind: 'not-applicable' },
      },
      loop: { kind: 'not-applicable' },
      tierReached: 2,
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
  })

  it('maps planner and unservable failures without fabricating axes', () => {
    const plannerFailure = scoreDecision(
      buttonSidecar(),
      decisionResult([
        { kind: 'planner-failure', reason: 'step_failed', message: 'recorded failure' },
      ]),
    )
    const divergence = scoreDecision(
      buttonSidecar(),
      decisionResult([
        { kind: 'unservable-divergence', tool: 'lookup_account', args: { id: 1 } },
      ]),
    )

    expect(plannerFailure).toEqual({
      kind: 'miss-by-failure',
      reason: 'step_failed',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
    expect(divergence).toEqual({
      kind: 'miss-by-failure',
      reason: 'unservable-divergence:lookup_account',
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
    expect(Object.hasOwn(plannerFailure, 'axes')).toBe(false)
    expect(Object.hasOwn(divergence, 'axes')).toBe(false)
  })

  it('classifies a partial identity ladder level as an enumerated unresolved tie', () => {
    const partialIdentity: DecisionIdentity = {
      opClass: 'click',
      target: { ...buttonAnchor, ordinal: 2 },
    }
    const score = scoreDecision(
      buttonSidecar(),
      decisionResult([decisionOutcome(buttonAction, partialIdentity)]),
    )

    expect(score.kind).toBe('unresolved-tie')
    if (score.kind !== 'unresolved-tie') return
    expect(score.cause).toBe('partial-identity')
    expect(score.partial?.axes.elementIdentity).toMatchObject({
      kind: 'scored',
      level: 'ordinal-only-differs',
    })
  })

  it('ties only the configured value mid band and settles full and low bands', () => {
    const sidecar = fillSidecar('alpha beta gamma delta')
    const mid = scoreDecision(
      sidecar,
      decisionResult([decisionOutcome(fillAction('alpha beta'))]),
    )
    const full = scoreDecision(
      sidecar,
      decisionResult([decisionOutcome(fillAction('delta gamma beta alpha'))]),
    )
    const low = scoreDecision(
      sidecar,
      decisionResult([decisionOutcome(fillAction('unrelated'))]),
    )

    expect(mid.kind).toBe('unresolved-tie')
    if (mid.kind === 'unresolved-tie') {
      expect(mid.cause).toBe('value-mid-band')
      expect(mid.partial?.axes.value).toMatchObject({ kind: 'scored', band: 'mid' })
    }
    expect(full).toMatchObject({
      kind: 'scored',
      axes: { value: { kind: 'scored', f1: 1, band: 'full' } },
    })
    expect(low).toMatchObject({
      kind: 'scored',
      axes: { value: { kind: 'scored', f1: 0, band: 'low' } },
    })
  })

  it('returns a no-consensus tie with the first decision sample breakdown', () => {
    const score = scoreDecision(
      buttonSidecar(),
      decisionResult(
        [
          decisionOutcome(buttonAction),
          decisionOutcome({ type: 'tapCoordinate', x: 5, y: 5, coordSpace: 'viewport' }),
          { kind: 'planner-failure', reason: 'step_failed', message: 'failed' },
        ],
        { noConsensus: true },
      ),
    )

    expect(score).toMatchObject({
      kind: 'unresolved-tie',
      cause: 'no-consensus',
      partial: {
        axes: { elementIdentity: { kind: 'scored', level: 'full' } },
      },
      matcherVersion: MATCHER_CONFIG.matcherVersion,
    })
  })

  it('scores the first real action in the modal identity class', () => {
    const annotation: ActionAnnotation = {
      kind: 'point',
      viewport: { width: 100, height: 100 },
      point: {
        x: 50,
        y: 50,
        boundingBox: { x: 45, y: 45, width: 10, height: 10 },
      },
    }
    const withAnchor = makeSidecar({
      goldAction: { type: 'tapCoordinate', x: 50, y: 50, coordSpace: 'viewport' },
      opClass: 'tapCoordinate',
      annotation,
      equivalenceSet: [],
    })
    const { goldAnchor: _goldAnchor, ...sidecar } = withAnchor
    const modalIdentity: DecisionIdentity = { opClass: 'tapCoordinate' }
    const score = scoreDecision(
      sidecar,
      decisionResult(
        [
          decisionOutcome(buttonAction),
          decisionOutcome(
            { type: 'tapCoordinate', x: 50, y: 50, coordSpace: 'viewport' },
            modalIdentity,
          ),
          decisionOutcome(
            { type: 'tapCoordinate', x: 90, y: 90, coordSpace: 'viewport' },
            modalIdentity,
          ),
        ],
        { modalIdentity, modalCount: 2, agreementRate: 2 / 3 },
      ),
      {
        priorIdentities: 'leaf-no-history',
        screenStateHash: 'screen-current',
        stateMetadata: screen.metadata,
      },
    )

    expect(score).toMatchObject({
      kind: 'scored',
      tierReached: 3,
      axes: { elementIdentity: { kind: 'scored', level: 'full', tier: 3 } },
    })
  })

  it('settles a wrong operation class with later axes explicitly not evaluated', () => {
    const score = scoreDecision(
      fillSidecar('hello'),
      decisionResult([decisionOutcome(buttonAction)]),
    )

    expect(score).toMatchObject({
      kind: 'scored',
      tierReached: 1,
      axes: {
        opClass: { kind: 'mismatch' },
        elementIdentity: { kind: 'not-evaluated' },
        value: { kind: 'not-evaluated' },
      },
    })
  })

  it('exposes only the named score and axis keys with no aggregate scalar', () => {
    const score = scoreDecision(
      buttonSidecar(),
      decisionResult([decisionOutcome(buttonAction)]),
    )
    expect(score.kind).toBe('scored')
    if (score.kind !== 'scored') return

    expect(Object.keys(score).sort()).toEqual(
      ['kind', 'axes', 'loop', 'tierReached', 'matcherVersion'].sort(),
    )
    expect(Object.keys(score.axes).sort()).toEqual(
      ['elementIdentity', 'opClass', 'value'].sort(),
    )
    expect(Object.hasOwn(score, 'total')).toBe(false)
    expect(Object.hasOwn(score, 'overall')).toBe(false)
    expect(Object.hasOwn(score, 'score')).toBe(false)
  })
})

describe('scoreCassetteReplay', () => {
  it('pools procedure decisions, counts typed skips, and emits only the D-12 summary', () => {
    const firstSidecar = buttonSidecar()
    const secondSidecar = buttonSidecar()
    const cassette = procedureCassette([
      { sidecar: firstSidecar, receipt: { screenStateHash: 'screen-a' } },
      { sidecar: secondSidecar, receipt: { screenStateHash: 'screen-b' } },
    ])
    const secondMiss = { type: 'click', ref: asRef('e1') } as const satisfies Action
    const outcome: ProcedureReplayResult = {
      granularity: 'procedure',
      cassetteId: cassette.id,
      steps: [
        { kind: 'decision', stepIndex: 0, decisionOrdinal: 0, result: decisionResult([decisionOutcome(buttonAction)]) },
        { kind: 'skipped', stepIndex: 1, decisionOrdinal: 0, reason: 'cache-served' },
        { kind: 'skipped', stepIndex: 2, reason: 'synthesized' },
        { kind: 'decision', stepIndex: 3, decisionOrdinal: 0, result: decisionResult([decisionOutcome(secondMiss)]) },
      ],
      endState: cassette.endState,
      totalDurationMs: 20,
    }

    const scored = scoreCassetteReplay(cassette, outcome)
    expect(scored.kind).toBe('procedure')
    if (scored.kind !== 'procedure') return

    expect(scored.entries.map(entry => entry.kind)).toEqual([
      'decision',
      'skipped',
      'skipped',
      'decision',
    ])
    expect(scored.summary).toEqual({
      stepsMatchedFraction: 0.5,
      firstDivergentStepIndex: 3,
      endState: cassette.endState,
    })
    expect(scored.summary.endState).toBe(cassette.endState)
    expect(Object.hasOwn(scored.summary, 'verdict')).toBe(false)
    expect(Object.hasOwn(scored.summary, 'score')).toBe(false)
    expect(Object.hasOwn(scored.summary, 'overall')).toBe(false)

    const allFullCassette = procedureCassette([
      { sidecar: firstSidecar, receipt: { screenStateHash: 'screen-a' } },
      { sidecar: secondSidecar, receipt: { screenStateHash: 'screen-b' } },
    ])
    const allFullOutcome: ProcedureReplayResult = {
      ...outcome,
      cassetteId: allFullCassette.id,
      steps: outcome.steps.map(step =>
        step.kind === 'decision'
          ? { ...step, result: decisionResult([decisionOutcome(buttonAction)]) }
          : step,
      ),
      endState: allFullCassette.endState,
    }
    const allFull = scoreCassetteReplay(allFullCassette, allFullOutcome)
    expect(allFull.kind).toBe('procedure')
    if (allFull.kind === 'procedure') {
      expect(allFull.summary.stepsMatchedFraction).toBe(1)
      expect(Object.hasOwn(allFull.summary, 'firstDivergentStepIndex')).toBe(false)
    }
  })

  it('counts an all-harness-error leaf as a typed never-scored entry', () => {
    const cassette = leafCassette({ sidecar: buttonSidecar() })
    const result = decisionResult([
      { kind: 'harness-error', message: 'runtime failed' },
      { kind: 'harness-error', message: 'runtime failed again' },
    ])

    expect(scoreCassetteReplay(cassette, { ...result, granularity: 'leaf' })).toEqual({
      kind: 'leaf',
      cassetteId: cassette.id,
      entry: {
        kind: 'never-scored',
        decisionOrdinal: cassette.decisionOrdinal,
        reason: 'all-samples-harness-error',
        matcherVersion: MATCHER_CONFIG.matcherVersion,
      },
    })
  })

  it('passes through replay refusals as a typed counted cassette outcome', () => {
    const cassette = leafCassette({ sidecar: buttonSidecar() })
    const refusal = {
      kind: 'integrity-refusal',
      cassetteId: cassette.id,
      reason: 'guard-failed',
      detail: 'malformed cassette',
    } as const

    expect(scoreCassetteReplay(cassette, refusal)).toEqual({
      kind: 'replay-refusal',
      cassetteId: cassette.id,
      refusal,
    })
  })
})
