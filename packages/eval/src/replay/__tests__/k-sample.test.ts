import { PlanningTurnError } from '@vostride/agent-qa-runner'
import type { ActionAnnotation } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { guardCassette } from '../../cassette/guard'
import type { ArtifactSource } from '../../ports'
import type { ReplayEscalationContext, ReplayEscalationPredicate } from '../ports'
import type { DecisionReplayResult, ProcedureReplayResult } from '../result'
import { replayCassette } from '../replay-run'
import {
  PROCEDURE_END_STATE,
  actionsFactory,
  decisionPlan,
  fixedIncrementClock,
  leafCassette,
  makeFactory,
  makeLabel,
  makeSidecar,
  procedureCassette,
} from './fixtures'

const emptyArtifacts: ArtifactSource = { getBlob: () => undefined }
const alwaysEscalate: ReplayEscalationPredicate = (_firstSample, _context) => true
const DIGEST = 'a'.repeat(64)

describe('replay fixture builders', () => {
  it('mints a guard-legal real sidecar and label by default', () => {
    const sidecar = makeSidecar()
    const label = makeLabel()

    expect(sidecar.goldAction).toEqual({ type: 'click', ref: 'e1' })
    expect(sidecar.opClass).toBe(sidecar.goldAction.type)
    expect(sidecar.goldAnchor).toEqual({
      role: 'button',
      nameNormalized: 'submit',
      ordinal: 0,
    })
    const goldAnchor = sidecar.goldAnchor
    if (goldAnchor === undefined) throw new Error('expected a default gold anchor')
    expect(
      sidecar.equivalenceSet.some(
        member =>
          member.role === goldAnchor.role &&
          member.nameNormalized === goldAnchor.nameNormalized &&
          member.ordinal === goldAnchor.ordinal,
      ),
    ).toBe(true)
    expect(Object.hasOwn(sidecar, 'goldValue')).toBe(false)
    expect(Object.hasOwn(sidecar, 'annotation')).toBe(false)
    expect(label).toEqual({ sourceChannel: 'recorded-verdict', tier: 'silver' })

    expect(
      guardCassette(
        leafCassette({
          sidecar,
          label,
          receipt: { promptInputHash: DIGEST, screenStateHash: DIGEST },
        }),
      ),
    ).toMatchObject({ sidecar, label })
  })

  it('carries point geometry and a synthetic contrastive pairing through overrides', () => {
    const annotation: ActionAnnotation = {
      kind: 'point',
      viewport: { width: 1280, height: 720 },
      point: { x: 50, y: 36, boundingBox: { x: 10, y: 20, width: 80, height: 32 } },
    }
    const pairing = {
      pairedCassetteId: 'cassette-negative-1',
      relation: 'contrastive-positive',
    } as const

    expect(makeSidecar({ annotation }).annotation).toBe(annotation)
    expect(makeLabel({ pairing })).toEqual({
      sourceChannel: 'self-heal-pair',
      tier: 'near-gold',
      pairing,
    })
  })

  it('accepts leaf and ordered procedure-decision sidecar/label overrides', () => {
    const leafSidecar = makeSidecar({ opClass: 'leaf-click' })
    const leafLabel = makeLabel({ tier: 'gold' })
    const leaf = leafCassette({ sidecar: leafSidecar, label: leafLabel })
    expect(leaf.sidecar).toBe(leafSidecar)
    expect(leaf.label).toBe(leafLabel)

    const firstSidecar = makeSidecar({ opClass: 'first-click' })
    const secondSidecar = makeSidecar({ opClass: 'second-click' })
    const firstLabel = makeLabel({ tier: 'gold' })
    const secondLabel = makeLabel({ tier: 'near-gold' })
    const procedure = procedureCassette([
      { sidecar: firstSidecar, label: firstLabel },
      { sidecar: secondSidecar, label: secondLabel },
    ])
    const firstDecision = procedure.steps[0]
    const secondDecision = procedure.steps[3]
    if (firstDecision.kind !== 'decision' || secondDecision.kind !== 'decision') {
      throw new Error('expected decision fixtures')
    }
    expect(firstDecision.record.sidecar).toBe(firstSidecar)
    expect(firstDecision.record.label).toBe(firstLabel)
    expect(secondDecision.record.sidecar).toBe(secondSidecar)
    expect(secondDecision.record.label).toBe(secondLabel)
  })
})

describe('replayCassette — k-sample agreement', () => {
  it('the default (neverEscalate) predicate runs exactly one sample even at k=3', async () => {
    const probe = actionsFactory([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e1' },
      { type: 'click', ref: 'e2' },
    ])
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
    })) as DecisionReplayResult
    expect(probe.createCount()).toBe(1)
    expect(outcome.samples).toHaveLength(1)
    expect(outcome.agreement.k).toBe(1)
    expect(outcome.agreement.agreementRate).toBe(1)
  })

  it("Test 2: a leaf predicate receives the cassette's own sidecar and no stepIndex", async () => {
    const contexts: ReplayEscalationContext[] = []
    const recordContext: ReplayEscalationPredicate = (_firstSample, context) => {
      contexts.push(context)
      return false
    }
    const cassette = leafCassette()

    await replayCassette({
      cassette,
      artifacts: emptyArtifacts,
      plannerFactory: actionsFactory([{ type: 'click', ref: 'e2' }]).factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: recordContext,
    })

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({
      cassetteId: cassette.id,
      decisionOrdinal: cassette.decisionOrdinal,
    })
    expect(contexts[0].sidecar).toBe(cassette.sidecar)
    expect(contexts[0].receipt).toBe(cassette.receipt)
    expect(Object.hasOwn(contexts[0], 'stepIndex')).toBe(false)
  })

  it('a forced always-escalate predicate at k=3 runs three fresh samples', async () => {
    const probe = makeFactory(() => decisionPlan({ type: 'click', ref: 'e2' }))
    await replayCassette({
      cassette: leafCassette({
        leg: { exchanges: [{ tool: 'lookup', args: { query: 'a' }, result: 'ok' }] },
      }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: alwaysEscalate,
    })
    expect(probe.createCount()).toBe(3)
    const creates = probe.creates()
    expect(creates[0].nonActionTools).not.toBe(creates[1].nonActionTools)
    expect(creates[1].nonActionTools).not.toBe(creates[2].nonActionTools)
  })

  it('Test 4: escalation preserves modal count, agreement rate, and consensus semantics', async () => {
    const probe = actionsFactory([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e1' },
    ])
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: alwaysEscalate,
    })) as DecisionReplayResult
    expect(outcome.agreement.noConsensus).toBe(false)
    expect(outcome.agreement.modal?.count).toBe(2)
    expect(outcome.agreement.modal?.identity.target).toEqual({ role: 'button', nameNormalized: 'log in', ordinal: 0 })
    expect(outcome.agreement.agreementRate).toBeCloseTo(2 / 3)
    expect(outcome.modalDecision?.opClass).toBe('click')
  })

  it('Test 5: all-distinct samples yield noConsensus true, modal absent, agreementRate 1/3', async () => {
    const probe = actionsFactory([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e1' },
      { type: 'type', ref: 'e1', text: 'hello' },
    ])
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: alwaysEscalate,
    })) as DecisionReplayResult
    expect(outcome.agreement.noConsensus).toBe(true)
    expect(outcome.agreement.modal).toBeUndefined()
    expect('modalDecision' in outcome).toBe(false)
    expect(outcome.agreement.agreementRate).toBeCloseTo(1 / 3)
  })

  it('k=1 yields agreementRate 1 with modal = the single sample identity class', async () => {
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })) as DecisionReplayResult
    expect(outcome.agreement.k).toBe(1)
    expect(outcome.agreement.agreementRate).toBe(1)
    expect(outcome.agreement.modal?.count).toBe(1)
    expect(outcome.modalDecision?.opClass).toBe('click')
  })

  it('Test 7: planner-failure samples group by reason; harness-errors are counted, never modal', async () => {
    const probe = makeFactory(callIndex => {
      if (callIndex < 2) throw new PlanningTurnError('no_action_tool_called', `fail ${callIndex}`, [])
      throw new Error('infra down')
    })
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: alwaysEscalate,
    })) as DecisionReplayResult
    expect(outcome.samples).toHaveLength(3)
    expect(outcome.agreement.harnessErrorCount).toBe(1)
    expect(outcome.agreement.agreementRate).toBeCloseTo(2 / 3)
    expect(outcome.agreement.noConsensus).toBe(false)
    expect('modalDecision' in outcome).toBe(false)
  })

  it('value casing and whitespace noise share one agreement class', async () => {
    const probe = actionsFactory([
      {
        type: 'fill',
        ref: 'e1',
        text: '  Hello   World  ',
        clearMode: 'replace',
        submit: false,
      },
      {
        type: 'fill',
        ref: 'e1',
        text: 'hello world',
        clearMode: 'replace',
        submit: false,
      },
      {
        type: 'fill',
        ref: 'e1',
        text: 'goodbye',
        clearMode: 'replace',
        submit: false,
      },
    ])
    const outcome = (await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: alwaysEscalate,
    })) as DecisionReplayResult

    // Identity normalization changes k-sample agreement classes.
    expect(outcome.agreement.noConsensus).toBe(false)
    expect(outcome.agreement.modal?.count).toBe(2)
    expect(outcome.agreement.modal?.identity.value).toBe('hello world')
    expect(outcome.agreement.agreementRate).toBeCloseTo(2 / 3)
  })
})

describe('replayCassette — procedure teacher-forcing', () => {
  it("Test 3: a procedure predicate receives each decision step's own sidecar in order", async () => {
    const contexts: ReplayEscalationContext[] = []
    const recordContext: ReplayEscalationPredicate = (_firstSample, context) => {
      contexts.push(context)
      return false
    }
    const cassette = procedureCassette()
    const firstDecision = cassette.steps[0]
    const secondDecision = cassette.steps[3]
    if (firstDecision.kind !== 'decision' || secondDecision.kind !== 'decision') {
      throw new Error('expected decision fixtures')
    }
    expect(firstDecision.record.sidecar).not.toBe(secondDecision.record.sidecar)

    await replayCassette({
      cassette,
      artifacts: emptyArtifacts,
      plannerFactory: actionsFactory([
        { type: 'click', ref: 'e2' },
        { type: 'click', ref: 'e1' },
      ]).factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
      k: 3,
      escalationPredicate: recordContext,
    })

    expect(contexts).toHaveLength(2)
    expect(contexts.map(context => [context.stepIndex, context.decisionOrdinal])).toEqual([
      [firstDecision.stepIndex, firstDecision.decisionOrdinal],
      [secondDecision.stepIndex, secondDecision.decisionOrdinal],
    ])
    expect(contexts[0].sidecar).toBe(firstDecision.record.sidecar)
    expect(contexts[1].sidecar).toBe(secondDecision.record.sidecar)
    expect(contexts[0].receipt).toBe(firstDecision.record.receipt)
    expect(contexts[1].receipt).toBe(secondDecision.record.receipt)
  })

  it('Test 8: procedure steps replay independently; non-decision steps skip; endState untouched', async () => {
    const probe = actionsFactory([
      { type: 'click', ref: 'e2' },
      { type: 'click', ref: 'e1' },
    ])
    const cassette = procedureCassette()
    const outcome = (await replayCassette({
      cassette,
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })) as ProcedureReplayResult

    expect(outcome.granularity).toBe('procedure')
    expect(probe.createCount()).toBe(2)
    expect(outcome.steps).toHaveLength(4)

    const [step0, step1, step2, step3] = outcome.steps
    expect(step0).toMatchObject({ kind: 'decision', stepIndex: 0, decisionOrdinal: 0 })
    expect(step1).toEqual({ kind: 'skipped', stepIndex: 1, reason: 'cache-served', decisionOrdinal: 0 })
    expect(step2).toEqual({ kind: 'skipped', stepIndex: 2, reason: 'synthesized' })
    expect(step3).toMatchObject({ kind: 'decision', stepIndex: 3, decisionOrdinal: 0 })

    if (step0.kind !== 'decision' || step3.kind !== 'decision') throw new Error('expected decision steps')
    // Teacher-forced: each decision step replayed against its own recorded state independently.
    expect(step0.result.samples[0].outcome).toMatchObject({ kind: 'decision', action: { ref: 'e2' } })
    expect(step3.result.samples[0].outcome).toMatchObject({ kind: 'decision', action: { ref: 'e1' } })

    expect(outcome.endState).toEqual(PROCEDURE_END_STATE)
    expect(outcome.endState).toBe(cassette.endState)
  })
})
