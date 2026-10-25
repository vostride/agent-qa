import { CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId, asRunId, distilledScreenStateDigest, type CompletedRunHandoff, type ScreenState, type StepEvidence } from '@vostride/agent-qa-schema'
import { describe, expect, it, vi } from 'vitest'
import { creditCanaryAttributions, type CanaryCreditInput } from '../canary-credit.js'
import type { ProjectedCanaryAttribution } from '../emit-canary-outcomes.js'

const D = 'c'.repeat(64)
const { makeScreenStateFixture } = await import(new URL(
  '../../../../knowledge-local/src/__tests__/fixtures/bundle-fixture.js', import.meta.url,
).href)
function stateFixture(): ScreenState {
  const state: ScreenState = makeScreenStateFixture()
  state.elements[0] = { ...state.elements[0]!, role: 'button', name: 'Checkout', nameNormalized: 'checkout' }
  return state
}
function liveAction(state = stateFixture()) {
  return { stateBefore: state, plannedAction: { type: 'click' as const, ref: state.elements[0]!.ref },
    plan: 'Click Checkout', result: { success: true }, exchanges: [] }
}
function liveStep(state = stateFixture()): StepEvidence {
  return { stepIndex: 0, stepText: 'Click Checkout', cacheStatus: 'miss', subActions: [liveAction(state)],
    servedBrief: { scope: { tier: 'product', key: 'storefront' }, asOfBuild: 43, budget: 100,
      truncation: 'none', channel1: [], channel2: [], channel3: [], briefDigest: 'brief' },
    verifierVerdict: { pass: true, reasoning: 'Fixture checkout exercised' } }
}
const handoff: CompletedRunHandoff = { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId: asRunId('run-credit'),
  scope: { tier: 'product', key: 'storefront' }, buildOrdinal: 43,
  executionContext: 'local-interactive', aggregateVerdict: 'passed',
  configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' }, startedAt: 1, endedAt: 2,
  tests: [{ testId: 'checkout', testIndex: 0, testName: 'Checkout', filePath: 'checkout.yaml', outcome: 'passed', steps: [liveStep(), { ...liveStep(), stepIndex: 1 }] }] }
function row(candidateId = 'candidate-checkout', runOutcome: 'positive' | 'negative' = 'positive'): Extract<ProjectedCanaryAttribution, { kind: 'outcome' }> {
  return { kind: 'outcome', source: 'served-brief', outcome: {
    candidateId: asRecordId(candidateId), runOutcome, benefit: 'rode-along', stateValidity: 'unknown',
    runId: String(handoff.runId), testId: 'checkout', testIndex: 0, stepIndex: 0,
    buildOrdinal: 43, briefDigest: 'brief', attribution: 'Checkout exercised',
    exercisedAnchor: { t: 'el', role: 'button', name: 'checkout', ordinal: 0 },
  } }
}
function credit(attributions: ProjectedCanaryAttribution[], overrides: Partial<CanaryCreditInput> = {}) {
  return creditCanaryAttributions({ attributions, handoff, knowledgeRoot: '/tmp/knowledge',
    readBundleStateDigests: () => ({ kind: 'not-found' }), ...overrides })
}
describe('canary credit pass', () => {
  it.each(['valid', 'stale', 'ambiguous', 'wrong-anchor', 'cached-only'] as const)('uses the matching live pre-state after a cached prefix: %s', mode => {
    const first = stateFixture()
    first.url = 'https://fixture.example/cached'
    const target = stateFixture()
    target.url = 'https://fixture.example/live'
    const prefix = liveAction(first)
    delete (prefix as { exchanges?: unknown }).exchanges
    const action = liveAction(target)
    if (mode === 'wrong-anchor') action.plannedAction.ref = asRecordId('unresolved') as never
    const step = { ...liveStep(), subActions: mode === 'cached-only' ? [prefix]
      : mode === 'ambiguous' ? [prefix, action, liveAction(target)] : [prefix, action] }
    const report = credit([row('a'), row('b', 'negative')], {
      handoff: { ...handoff, tests: [{ ...handoff.tests[0]!, steps: [step] }] },
      readBundleStateDigests: () => ({ kind: 'found', digests: [distilledScreenStateDigest(mode === 'stale' ? first : target)] }),
    })
    for (const attribution of report.attributions) {
      expect(attribution).toMatchObject({ outcome: { stateValidity: ['valid', 'stale'].includes(mode) ? mode : 'unknown' } })
      if (attribution.kind !== 'outcome') throw new Error('expected outcome')
      if (['valid', 'stale'].includes(mode)) expect(attribution.outcome.observedStateDigest).toBe(distilledScreenStateDigest(target))
      else expect(attribution.outcome).not.toHaveProperty('observedStateDigest')
    }
  })
  it.each(['valid', 'stale', 'missing-step', 'not-found', 'empty'] as const)('computes %s snapshot validity for positives and negatives', (mode) => {
    const state = stateFixture()
    const observedStateDigest = distilledScreenStateDigest(state)
    const live: CompletedRunHandoff = { ...handoff, tests: [{
      testId: 'checkout', testIndex: 0, testName: 'Checkout', filePath: 'checkout.yaml', outcome: 'passed',
      steps: mode === 'missing-step' ? [] : [liveStep(state)],
    }] }
    const readBundleStateDigests = vi.fn<CanaryCreditInput['readBundleStateDigests']>(() => mode === 'not-found'
      ? { kind: 'not-found' } : { kind: 'found', digests: mode === 'empty' ? []
        : [mode === 'stale' ? distilledScreenStateDigest({ ...state, url: '/changed' }) : observedStateDigest] })
    const report = credit([row('a'), row('b', 'negative')], { handoff: live, readBundleStateDigests })
    const stateValidity = mode === 'valid' ? 'valid' : mode === 'stale' ? 'stale' : 'unknown'
    expect(report.attributions[1]).toMatchObject({ outcome: { stateValidity, benefit: 'exercised-harmed' } })
    for (const attribution of report.attributions) {
      expect(attribution).toMatchObject({ outcome: { stateValidity } })
      if (mode !== 'missing-step') expect(attribution).toMatchObject({ outcome: { observedStateDigest } })
    }
    expect(readBundleStateDigests).toHaveBeenCalledWith({ knowledgeRoot: '/tmp/knowledge', candidateId: 'b' })
  })
  it('a step without sub-action evidence stays unknown', () => {
    const live: CompletedRunHandoff = { ...handoff, tests: [{
      testId: 'checkout', testIndex: 0, testName: 'Checkout', filePath: 'checkout.yaml', outcome: 'passed',
      steps: [{ stepIndex: 0 } as StepEvidence],
    }] }
    const report = credit([row()], { handoff: live,
      readBundleStateDigests: () => ({ kind: 'found', digests: [D] }) })
    expect(report.attributions[0]).toMatchObject({ outcome: { stateValidity: 'unknown' } })
    if (report.attributions[0]?.kind === 'outcome') expect(report.attributions[0].outcome).not.toHaveProperty('observedStateDigest')
  })
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
    const readBundleStateDigests = vi.fn<CanaryCreditInput['readBundleStateDigests']>(() => ({ kind: 'not-found' }))
    expect(credit([unresolved], { readBundleStateDigests }).attributions[0]).toBe(unresolved)
    expect(readBundleStateDigests).not.toHaveBeenCalled()
  })
})
