import { PlanningTurnError } from '@vostride/agent-qa-runner'
import { asRecordId, sha256hex, SERVED_BRIEF_PROOF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import type { ArtifactSource } from '../../ports'
import type { ArtifactRef } from '@vostride/agent-qa-schema'
import { buildEvalReport } from '../../match/metrics'
import { UnservableDivergenceError } from '../exchange-server'
import type { DecisionReplayResult, ReplayRefusal } from '../result'
import { replayCassette } from '../replay-run'
import {
  actionsFactory,
  decisionPlan,
  fixedIncrementClock,
  fullCaptureScreenState,
  leafCassette,
  makeFactory,
} from './fixtures'

const emptyArtifacts: ArtifactSource = { getBlob: () => undefined }

function isRefusal(outcome: unknown): outcome is ReplayRefusal {
  return typeof outcome === 'object' && outcome !== null && 'kind' in outcome
    && (outcome as { kind: unknown }).kind === 'integrity-refusal'
}

describe('replayCassette — single sample', () => {
  it('Test 1: refuses an incomplete cassette without ever calling the factory', async () => {
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const outcome = await replayCassette({
      cassette: leafCassette({ completeness: { status: 'evidence-incomplete' } }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    expect(isRefusal(outcome)).toBe(true)
    expect((outcome as ReplayRefusal).reason).toBe('completeness')
    expect((outcome as ReplayRefusal).completenessStatus).toBe('evidence-incomplete')
    expect(probe.createCount()).toBe(0)
  })

  it('Test 2: a grounded PlanResult yields a leaf decision sample with identity, tokenUsage, duration', async () => {
    const probe = makeFactory(() =>
      decisionPlan({ type: 'click', ref: 'e2' }, { promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    )
    const outcome = await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    expect(isRefusal(outcome)).toBe(false)
    const result = outcome as DecisionReplayResult & { granularity: 'leaf' }
    expect(result.granularity).toBe('leaf')
    expect(result.samples).toHaveLength(1)
    const sample = result.samples[0]
    expect(sample.outcome).toMatchObject({ kind: 'decision', action: { type: 'click', ref: 'e2' } })
    if (sample.outcome.kind !== 'decision') throw new Error('expected decision')
    expect(sample.outcome.identity.opClass).toBe('click')
    expect(sample.outcome.identity.target).toEqual({ role: 'button', nameNormalized: 'log in', ordinal: 0 })
    expect(sample.tokenUsage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 })
    expect(sample.durationMs).toBeGreaterThan(0)
    expect(sample).not.toHaveProperty('unsupportedFeatures')
    expect(sample).not.toHaveProperty('providerFingerprint')
    expect(probe.createCount()).toBe(1)
  })

  it('Test 3: a PlanningTurnError throw yields a scoreable planner-failure sample', async () => {
    const probe = makeFactory(() => {
      throw new PlanningTurnError('no_action_tool_called', 'no action', [])
    })
    const outcome = await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    const result = outcome as DecisionReplayResult
    expect(result.samples[0].outcome).toMatchObject({
      kind: 'planner-failure',
      reason: 'no_action_tool_called',
    })
    expect(result.samples[0]).not.toHaveProperty('unsupportedFeatures')
    expect(result.samples[0]).not.toHaveProperty('providerFingerprint')
  })

  it.each(['decision', 'planner-failure'] as const)(
    'carries observed call metadata through a %s sample into the report',
    async kind => {
      const callRecord = { unsupportedFeatures: ['seed'], fingerprint: 'fp_abc' }
      const probe = makeFactory(() => {
        if (kind === 'planner-failure') {
          throw new PlanningTurnError('no_action_tool_called', 'no action', [], callRecord)
        }
        return { ...decisionPlan({ type: 'click', ref: 'e2' }), callRecord }
      })
      const cassette = leafCassette()
      const outcome = await replayCassette({
        cassette,
        artifacts: emptyArtifacts,
        plannerFactory: probe.factory,
        actionToolNames: new Set(),
        clock: fixedIncrementClock(),
      })
      if (!('granularity' in outcome) || outcome.granularity !== 'leaf') {
        throw new Error('expected a leaf replay result')
      }

      expect(outcome.samples).toHaveLength(1)
      expect(outcome.samples[0].outcome.kind).toBe(kind)
      expect(outcome.samples[0].unsupportedFeatures).toEqual(['seed'])
      expect(outcome.samples[0].providerFingerprint).toBe('fp_abc')
      const report = buildEvalReport([
        { cassetteId: cassette.id, outcome },
      ], undefined, undefined, { declaredSeed: 11 })
      expect(report.seedHonored).toBe(false)
      expect(report.providerFingerprints).toEqual(['fp_abc'])
    },
  )

  it('Test 4: an UnservableDivergenceError throw yields an unservable-divergence sample', async () => {
    const probe = makeFactory(() => {
      throw new UnservableDivergenceError('lookup', { query: 'weather' })
    })
    const outcome = await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    const result = outcome as DecisionReplayResult
    expect(result.samples[0].outcome).toEqual({
      kind: 'unservable-divergence',
      tool: 'lookup',
      args: { query: 'weather' },
    })
  })

  it('a planner error is a harness error, not a guardrail refusal', async () => {
    const probe = makeFactory(() => {
      throw new Error('provider outage')
    })
    const outcome = await replayCassette({
      cassette: leafCassette(),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    const result = outcome as DecisionReplayResult
    expect(result.samples[0].outcome).toMatchObject({ kind: 'harness-error', message: 'provider outage' })
  })

  it('Test 6: promptDrift, recordedModel, replayedModel, and unconsumed exchanges are stamped', async () => {
    const probe = makeFactory(() => decisionPlan({ type: 'click', ref: 'e2' }), {
      provider: 'anthropic',
      modelId: 'sonnet-replay',
    })
    const outcome = await replayCassette({
      cassette: leafCassette({
        leg: { exchanges: [{ tool: 'lookup', args: { query: 'a' }, result: { answer: 'ok' } }] },
        receipt: { promptInputHash: 'hash-recorded', model: { declared: { provider: 'openai', modelId: 'gpt-x' }, resolvedModelId: 'gpt-x-2024' } },
      }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    const result = outcome as DecisionReplayResult
    expect(result.promptDrift.recordedHash).toBe('hash-recorded')
    expect(typeof result.promptDrift.recomputedHash).toBe('string')
    expect(result.recordedModel).toEqual({ provider: 'openai', modelId: 'gpt-x-2024' })
    expect(result.replayedModel).toEqual({ provider: 'anthropic', modelId: 'sonnet-replay' })
    expect(result.unconsumedExchanges).toEqual([{ tool: 'lookup', args: { query: 'a' } }])
  })

  it('Test 6b: recordedModel is typed-absent when the receipt declares no model', async () => {
    const probe = makeFactory(() => decisionPlan({ type: 'click', ref: 'e2' }))
    const outcome = await replayCassette({
      cassette: leafCassette({ receipt: { model: {} } }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    const result = outcome as DecisionReplayResult
    expect('recordedModel' in result).toBe(false)
  })

  it('Test 7a: an action-tool collision maps to a typed refusal, factory never called', async () => {
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const outcome = await replayCassette({
      cassette: leafCassette({
        leg: { exchanges: [{ tool: 'click', args: {}, result: null }] },
      }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(['click']),
      clock: fixedIncrementClock(),
    })
    expect(isRefusal(outcome)).toBe(true)
    expect((outcome as ReplayRefusal).reason).toBe('action-tool-collision')
    expect(probe.createCount()).toBe(0)
  })

  it('Test 7b: a missing decision blob maps to a typed missing-blob refusal', async () => {
    const screenshotRef: ArtifactRef = { id: 'decision-shot', sha: 'b'.repeat(64) }
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const outcome = await replayCassette({
      cassette: leafCassette({
        leg: { stateBefore: fullCaptureScreenState(), decisionScreenshotRef: screenshotRef },
      }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    expect(isRefusal(outcome)).toBe(true)
    expect((outcome as ReplayRefusal).reason).toBe('missing-blob')
  })

  it('Test 7c: a channel3-only brief maps to a typed unrenderable-brief refusal', async () => {
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const brief = { ...leafCassette().input.servedBrief }
    brief.channel3 = [{ id: asRecordId('caution'), anchors: [], summary: 'a hint' }]
    const outcome = await replayCassette({
      cassette: leafCassette({ leg: { servedBrief: brief } }),
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    expect(isRefusal(outcome)).toBe(true)
    expect((outcome as ReplayRefusal).reason).toBe('unrenderable-brief')
  })

  it('stamps briefSource proof and turnMatch exact through replayCassette', async () => {
    const cassette = leafCassette()
    cassette.input.servedBrief.channel3 = [
      { id: asRecordId('proof-caution'), anchors: [], summary: 'a caution' },
    ]
    const policyL0 = 'recorded policy'
    cassette.input.servedBrief.proof = {
      schemaVersion: SERVED_BRIEF_PROOF_SCHEMA_VERSION,
      completeness: 'lossless',
      recordCap: 10,
      combinedBudget: 100,
      admissionEvents: [],
      promptTurns: [{
        ordinal: 0,
        turnOrdinal: cassette.input.decisionOrdinal,
        runDate: '2026-09-05',
        policyL0,
        learnedL1: '',
        learnedL2: 'recorded observation',
        contextTier: '',
        volatileTier: '',
        policyDigest: sha256hex(policyL0),
        contextTierDigest: sha256hex(''),
        volatileTierDigest: sha256hex(''),
      }],
    }
    const probe = actionsFactory([{ type: 'click', ref: 'e2' }])
    const outcome = await replayCassette({
      cassette,
      artifacts: emptyArtifacts,
      plannerFactory: probe.factory,
      actionToolNames: new Set(),
      clock: fixedIncrementClock(),
    })
    expect(outcome).toMatchObject({ granularity: 'leaf', briefSource: 'proof', turnMatch: 'exact' })
    expect((outcome as DecisionReplayResult).samples[0].outcome.kind).toBe('decision')
  })
})
