import { expect, test, vi } from 'vitest'
import { asRef } from '@vostride/agent-qa-schema'
import { generateText, type LanguageModel } from 'ai'
import { createStepModelScope, withStepModelCall } from '../step-model-observations.js'
import type { StepModelCallEvent, StepModelCallReport, StepModelObservation, StepModelScopeKey,
  StepModelScopeFactory } from '../ports.js'
import { runMemberTest, type MemberRunConfig } from '../member-runner.js'
import { fakeModel, makeAdapter, makePlanner, makeFakeTokenAccounting } from '../../loop/__tests__/loop-harness.js'
import { executePlanningTurn } from '../../loop/planning-turn.js'
import { LLMVerifier } from '../../loop/verifier.js'
import { LLMAssertionEvaluator } from '../../loop/asserter.js'
import { LLMVariableExtractor } from '../../loop/llm-variable-extractor.js'
import { LLMPlanner } from '../../loop/planner.js'
import { buildTools, defaultRegistry } from '../../tools/index.js'
import { makeScreenState } from '../../testing/screen-fixtures.js'

function fixture(testIndex = 3, stepIndex = 2) {
  const observers = new Map<LanguageModel, StepModelObservation>()
  const bind = (observation: StepModelObservation): LanguageModel => {
    const model = { modelId: 'requested-alias' } as Exclude<LanguageModel, string>
    observers.set(model, observation)
    return model
  }
  const scope = createStepModelScope({
    key: { runId: 'synthetic-run-423' as StepModelScopeKey['runId'], testIndex, stepIndex },
    models: { planner: { model: fakeModel as Exclude<LanguageModel, string>, bind },
      verifier: { model: fakeModel as Exclude<LanguageModel, string>, bind } },
    profiles: { planner: { provider: 'synthetic', modelId: 'requested-alias' },
      verifier: { provider: 'synthetic-judge', modelId: 'judge-alias' } },
    mask: text => text.replaceAll('sensitive-model', '[secret]'),
    createConsumers: () => ({ planner: makePlanner() }),
  })
  const emit = (model: LanguageModel, event: StepModelCallEvent) => observers.get(model)!.onCall(event)
  const dispatch = (model: LanguageModel, report: StepModelCallReport) => withStepModelCall(model, async bound => {
    emit(bound, { kind: 'start' })
    emit(bound, { kind: 'success', report })
    return 'unchanged'
  })
  return { scope, emit, dispatch, observers }
}
const report = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, respondingModelId: 'raw-model' }

test('USAGE-ALL-CALLS: each invocation and retry contributes once to the inclusive population', async () => {
  const f = fixture()
  for (const model of [f.scope.plannerModel, f.scope.verifierModel, f.scope.verifierModel]) {
    expect((await f.dispatch(model, report)).result).toBe('unchanged')
  }
  await withStepModelCall(f.scope.plannerModel, async model => {
    for (let i = 0; i < 2; i++) {
      f.emit(model, { kind: 'start' })
      f.emit(model, { kind: 'success', report })
    }
  })
  expect(f.scope.finish()).toMatchObject({ started: 5, succeeded: 5, failed: 0,
    inputTokens: 500, outputTokens: 50, cachedInputTokens: 200,
    roles: { planner: { respondingModelIds: ['raw-model'] }, verifier: { respondingModelIds: ['raw-model'] } },
  })
  expect(f.scope.snapshot().attempts.map(item => item.invocation)).toEqual([0, 1, 2, 3, 3])
})

test('MIXED-COVERAGE: one missing report removes cache coverage without manufacturing a zero', async () => {
  const f = fixture()
  await f.dispatch(f.scope.plannerModel, report)
  expect(f.scope.snapshot().cachedInputTokens).toBe(40)
  await f.dispatch(f.scope.verifierModel, { inputTokens: 20, outputTokens: 3 })
  expect(f.scope.finish()).toMatchObject({ started: 2, inputTokens: 120, outputTokens: 13 })
  expect(f.scope.snapshot()).not.toHaveProperty('cachedInputTokens')
})

test('ZERO-CALL: no dispatch and pre-dispatch refusal have no usage or responding identity', async () => {
  const f = fixture()
  const refusal = new Error('synthetic pre-dispatch refusal')
  await expect(withStepModelCall(f.scope.plannerModel, async () => { throw refusal })).rejects.toBe(refusal)
  const facts = f.scope.finish()
  expect(facts).toMatchObject({ started: 0, succeeded: 0, failed: 0 })
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens']) expect(facts).not.toHaveProperty(key)
  expect(facts.roles.planner.respondingModelIds).toEqual([])
})

test('USAGE-CONCURRENT: interleaved steps and same-role overlap retain invocation identity', async () => {
  const a = fixture(1, 0)
  const b = fixture(2, 0)
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const slow = withStepModelCall(a.scope.plannerModel, async model => {
    a.emit(model, { kind: 'start' })
    await waiting
    a.emit(model, { kind: 'success', report: { ...report, respondingModelId: 'slow' } })
    return 'slow result'
  })
  const other = await b.dispatch(b.scope.verifierModel, { ...report, inputTokens: 7, cachedInputTokens: 0,
    respondingModelId: 'other' })
  const fast = await a.dispatch(a.scope.plannerModel, { ...report, respondingModelId: 'fast' })
  release()
  expect((await slow).respondingModelId).toBe('slow')
  expect(fast.respondingModelId).toBe('fast')
  expect(other.respondingModelId).toBe('other')
  expect(a.scope.finish()).toMatchObject({ testIndex: 1, started: 2, inputTokens: 200,
    cachedInputTokens: 80, roles: { planner: { respondingModelIds: ['slow', 'fast'] } } })
  expect(b.scope.finish()).toMatchObject({ testIndex: 2, started: 1, inputTokens: 7,
    cachedInputTokens: 0, roles: { planner: { respondingModelIds: [] }, verifier: { respondingModelIds: ['other'] } } })
})

test('USAGE-SCOPE-LIFETIME: member binds canonical indices before calls and disposes after terminal', async () => {
  const f = fixture(4, 0)
  const finish = vi.spyOn(f.scope, 'finish')
  const dispose = vi.spyOn(f.scope, 'dispose')
  const create: StepModelScopeFactory = vi.fn(() => f.scope)
  const terminal = vi.fn(() => {
    expect(finish).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })
  const config: MemberRunConfig = {
    adapter: makeAdapter(), planner: makePlanner(), plannerModel: fakeModel, verifierModel: fakeModel,
    testIndex: 4, abortSignal: new AbortController().signal,
    sink: { stepStarted: vi.fn(), loopEmitFor: () => ({ stepFinalized: terminal, subActionRecorded: vi.fn() }),
      hookStarted: vi.fn(), hookFinished: vi.fn(), testRetryScheduled: vi.fn() },
    stepModelScope: { runId: 'synthetic-run-423' as StepModelScopeKey['runId'], create },
    executeStep: async (_instruction, ports, context) => {
      expect(ports.planner).toBe(f.scope.planner)
      expect(context.plannerModel).toBe(f.scope.plannerModel)
      await f.dispatch(context.plannerModel, report)
      return { name: 'Scoped step', status: 'passed', duration: 1 }
    },
  }
  const result = await runMemberTest({ testId: 'synthetic-test-423', name: 'Scoped step',
    filePath: 'synthetic.yaml', steps: ['Scoped step'] }, config)
  expect(result.status).toBe('passed')
  expect(create).toHaveBeenCalledWith({ runId: 'synthetic-run-423', testIndex: 4, stepIndex: 0 })
  expect(terminal).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
})

type V3Model = Extract<LanguageModel, { specificationVersion: 'v3' }>
interface ScriptedCall {
  report?: StepModelCallReport
  text?: string
  tool?: true
  failure?: string
  middlewareRetry?: true
}
// the verifier's structured output is per-condition.
const MET_TEXT = JSON.stringify({
  conditions: [{
    quote: 'Click Log in', verdict: 'met', needs: 'none', controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations: [{ source: 'final-screen', quote: 'button "Log in"' }], reasoning: 'synthetic',
  }],
  dialogs: [], isAppError: false, reasoning: 'synthetic',
})
function sdkFixture(rows: ScriptedCall[]) {
  const script = [...rows]
  const raw = (observation?: StepModelObservation): V3Model => ({
    specificationVersion: 'v3', provider: 'synthetic', modelId: 'requested-alias', supportedUrls: {},
    async doGenerate() {
      const row = script.shift()
      if (!row) throw new Error('Synthetic script exhausted')
      if (row.middlewareRetry) {
        observation?.onCall({ kind: 'start' })
        observation?.onCall({ kind: 'failure' })
      }
      observation?.onCall({ kind: 'start' })
      if (row.failure) {
        observation?.onCall({ kind: 'failure' })
        throw new Error(row.failure)
      }
      observation?.onCall({ kind: 'success', report: row.report ?? {} })
      return {
        content: row.tool ? [{ type: 'tool-call', toolCallId: 'synthetic-call', toolName: 'web_click',
          input: JSON.stringify({ ref: 'e2', reasoning: 'synthetic', confidence: 1,
            stepComplete: true, doesActionAdvanceUsTowardsGoal: true }) }]
          : [{ type: 'text', text: row.text ?? MET_TEXT }],
        finishReason: { unified: row.tool ? 'tool-calls' : 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [],
        // Deliberately no response model: the real installed SDK synthesizes requested-alias.
      }
    },
    doStream: async () => { throw new Error('Streaming is outside the runner call census') },
  })
  const base = raw()
  const accounting = makeFakeTokenAccounting()
  const scope = createStepModelScope({
    key: { runId: 'synthetic-run-423' as StepModelScopeKey['runId'], testIndex: 3, stepIndex: 0 },
    models: { planner: { model: base, bind: raw }, verifier: { model: base, bind: raw } },
    profiles: { planner: { provider: 'synthetic', modelId: 'requested-alias' },
      verifier: { provider: 'synthetic', modelId: 'judge-alias' } }, mask: text => text,
    createConsumers: models => ({ planner: makePlanner(),
      verifier: new LLMVerifier(models.verifierModel, accounting) }),
  })
  return { scope, base, script, accounting }
}
const planning = (model: LanguageModel) => executePlanningTurn({ model,
  registry: defaultRegistry, actionTools: buildTools(defaultRegistry, { platform: 'web' }),
  system: 'synthetic', messages: [{ role: 'user', content: 'Click Log in' }],
})

test('USAGE-RETRY-FAILURE: verifier clamp and middleware retries count every dispatched failure', async () => {
  const f = sdkFixture([{ failure: 'maximum context length' }, { report, middlewareRetry: true }])
  const screen = makeScreenState()
  const result = await f.scope.verifier!.verify('Click Log in', screen, screen, { type: 'click', ref: asRef('e2') })
  expect(result.verification.conditions.map((condition) => condition.verdict)).toEqual(['met'])
  expect(f.accounting.degradeCalls).toHaveLength(1)
  expect(f.accounting.recordUsageCalls).toHaveLength(1)
  expect(f.scope.finish()).toMatchObject({ started: 3, failed: 2, succeeded: 1 })
  expect(f.scope.snapshot()).not.toHaveProperty('cachedInputTokens')
})

test('USAGE-ASSERTION: legacy AI assertions, structured judgments and extraction all use verifier scope', async () => {
  const f = sdkFixture([
    { report, text: '{"passed":true,"reasoning":"synthetic","evidence":"visible"}' },
    { report, text: '{"verdict":true,"rationale":"visible"}' },
    { report, text: '{"name":"visible"}' },
  ])
  expect((await new LLMAssertionEvaluator(f.scope.verifierModel).evaluate(
    { type: 'ai', value: 'visible' }, makeScreenState(),
  )).passed).toBe(true)
  expect(await f.scope.verifier!.judgeClaim!('visible', makeScreenState(), { mode: 'multimodal' }))
    .toMatchObject({ outcome: 'judged', verdict: true })
  expect(await f.scope.verifier!.extractData!('name', makeScreenState(),
    { fields: [{ name: 'name', type: 'string', description: 'the name' }] }))
    .toEqual({ outcome: 'extracted', fields: { name: 'visible' } })
  expect(f.scope.finish()).toMatchObject({ started: 3, inputTokens: 300, outputTokens: 30,
    cachedInputTokens: 120, roles: { verifier: { respondingModelIds: ['raw-model'] },
      planner: { respondingModelIds: [] } } })
})

test('USAGE-EXTRACTION: post-loop capture reaches final facts and replaces legacy loop totals once', async () => {
  const f = sdkFixture([{ report, tool: true }, { report },
    { report, text: '{"value":"captured","reasoning":"synthetic"}' }])
  const finish = vi.spyOn(f.scope, 'finish')
  const terminal = vi.fn(() => {
    expect(finish).toHaveBeenCalledOnce()
    expect(f.scope.snapshot().started).toBe(3)
  })
  const config: MemberRunConfig = {
    adapter: makeAdapter(), planner: makePlanner(), plannerModel: fakeModel, verifierModel: fakeModel,
    testIndex: 3, abortSignal: new AbortController().signal,
    stepModelScope: { runId: f.scope.key.runId, create: () => f.scope },
    sink: { stepStarted: vi.fn(), loopEmitFor: () => ({ stepFinalized: terminal, subActionRecorded: vi.fn() }),
      hookStarted: vi.fn(), hookFinished: vi.fn(), testRetryScheduled: vi.fn() },
    executeStep: async (_instruction, ports, context) => {
      expect((await planning(context.plannerModel)).ok).toBe(true)
      await ports.verifier!.verify('Click Log in', makeScreenState(), makeScreenState(), { type: 'click', ref: asRef('e2') })
      return { name: 'Scoped step', status: 'passed', duration: 1, trace: {
        observation: '', reasoning: '', plannedAction: { type: 'click', ref: asRef('e2') }, result: 'success',
        screenStateBefore: '', tokenUsage: { promptTokens: 999, completionTokens: 99, totalTokens: 1098 },
      } }
    },
  }
  const result = await runMemberTest({ testId: 'synthetic-test-423', name: 'Scoped step',
    filePath: 'synthetic.yaml', steps: [{ step: 'Click Log in', capture: { variable: 'name', method: 'ai' } }] }, config)
  expect(result.status).toBe('passed')
  expect(result.steps[0].capturedVariables).toEqual({ name: 'captured' })
  expect(result.steps[0].trace?.tokenUsage).toEqual({ promptTokens: 300, completionTokens: 30, totalTokens: 330 })
  expect(f.scope.snapshot()).toMatchObject({ inputTokens: 300, cachedInputTokens: 120 })
  expect(terminal).toHaveBeenCalledOnce()
})

test.each([undefined, 'requested-alias', 'raw-routed-model'])('MODEL-SDK-FALLBACK: callRecord uses invocation report only (%s)', async respondingModelId => {
  const facts = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0,
    ...(respondingModelId === undefined ? {} : { respondingModelId }) }
  const f = sdkFixture([{ report: facts, tool: true }])
  const result = await planning(f.scope.plannerModel)
  expect(result.ok).toBe(true)
  if (respondingModelId === undefined) expect(result.callRecord).not.toHaveProperty('resolvedModelId')
  else expect(result.callRecord?.resolvedModelId).toBe(respondingModelId)
  expect(f.scope.finish().cachedInputTokens).toBe(0)
})

test('MODEL-SDK-FALLBACK-CONTROL: real SDK manufactures a response identity from an unreported model', async () => {
  const f = sdkFixture([{ text: 'synthetic' }])
  expect((await generateText({ model: f.base, prompt: 'synthetic', maxRetries: 0 })).response.modelId)
    .toBe('requested-alias')
})

test('CACHE-HIT-NO-REPORT: execution cache and unobserved SDK usage cannot manufacture coverage', async () => {
  const f = fixture()
  const legacy = { promptTokens: 999, completionTokens: 99, totalTokens: 1098 }
  const config: MemberRunConfig = {
    adapter: makeAdapter(), planner: makePlanner(), plannerModel: fakeModel, verifierModel: fakeModel,
    testIndex: 3, abortSignal: new AbortController().signal,
    stepModelScope: { runId: f.scope.key.runId, create: () => f.scope },
    sink: { stepStarted: vi.fn(), loopEmitFor: () => ({ stepFinalized: vi.fn(), subActionRecorded: vi.fn() }),
      hookStarted: vi.fn(), hookFinished: vi.fn(), testRetryScheduled: vi.fn() },
    executeStep: async () => ({ name: 'Cached', status: 'passed', duration: 1, trace: {
      observation: '', reasoning: 'cache hit', plannedAction: { type: 'click', ref: asRef('e2') }, result: 'success',
      screenStateBefore: '', tokenUsage: legacy,
    } }),
  }
  const member = { testId: 'synthetic-test-423', name: 'Cached', filePath: 'synthetic.yaml', steps: ['Cached'] }
  const scoped = await runMemberTest(member, config)
  expect(scoped.steps[0].trace).not.toHaveProperty('tokenUsage')
  expect(f.scope.snapshot().started).toBe(0)
  expect(f.scope.snapshot()).not.toHaveProperty('cachedInputTokens')
  delete config.stepModelScope
  const unbound = await runMemberTest(member, config)
  expect(unbound.steps[0].trace?.tokenUsage).toEqual(legacy)
})

test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 101])(
  'MIXED-COVERAGE-INVALID: invalid cached count %s never becomes authoritative', async cachedInputTokens => {
    const f = fixture()
    await f.dispatch(f.scope.plannerModel, { ...report, cachedInputTokens })
    expect(f.scope.finish()).not.toHaveProperty('cachedInputTokens')
  },
)

test('MIXED-COVERAGE-INCOMPLETE: pending starts, missing input and failed attempts remove coverage', async () => {
  for (const missing of ['pending', 'input', 'failure'] as const) {
    const f = fixture()
    await f.dispatch(f.scope.plannerModel, report)
    await withStepModelCall(f.scope.verifierModel, async model => {
      f.emit(model, { kind: 'start' })
      if (missing === 'failure') f.emit(model, { kind: 'failure' })
      if (missing === 'input') f.emit(model, { kind: 'success', report: { cachedInputTokens: 0 } })
    })
    expect(f.scope.finish().started).toBe(2)
    expect(f.scope.snapshot()).not.toHaveProperty('cachedInputTokens')
    expect(f.scope.snapshot()).not.toHaveProperty('inputTokens')
  }
})

test('USAGE-ISOLATION: duplicate and late terminals cannot mutate masked detached final facts', async () => {
  const f = fixture()
  let observer!: StepModelObservation
  await withStepModelCall(f.scope.plannerModel, async model => {
    observer = f.observers.get(model)!
    observer.onCall({ kind: 'start' })
    observer.onCall({ kind: 'success', report: { ...report, respondingModelId: 'sensitive-model' } })
    observer.onCall({ kind: 'failure' })
    observer.onCall({ kind: 'success', report: { inputTokens: 9999 } })
  })
  const final = f.scope.finish()
  expect(JSON.stringify(final)).not.toContain('sensitive-model')
  expect(final).toMatchObject({ started: 1, succeeded: 1, failed: 0, inputTokens: 100 })
  final.attempts[0].report!.inputTokens = 9999
  final.roles.planner.respondingModelIds.push('untrusted')
  f.scope.dispose()
  observer.onCall({ kind: 'start' })
  observer.onCall({ kind: 'success', report })
  expect(f.scope.snapshot()).toMatchObject({ started: 1, inputTokens: 100,
    roles: { planner: { respondingModelIds: ['[secret]'] } } })
  await expect(f.dispatch(f.scope.plannerModel, report)).rejects.toThrow('scope is closed')
})

test('USAGE-HEALING: actual planner and verifier retain failed-action replanning decisions', async () => {
  const f = sdkFixture([{ report, tool: true },
    { report, text: '{"conditions":[],"dialogs":[],"isAppError":false,"reasoning":"retry"}' },
    { report, tool: true }, { report }])
  const planner = new LLMPlanner(f.scope.plannerModel, 'web', undefined, undefined, makeFakeTokenAccounting())
  const config: MemberRunConfig = {
    adapter: makeAdapter({ executeResults: [{ success: false, error: 'synthetic action failure' }, { success: true }] }),
    planner, verifier: f.scope.verifier, plannerModel: f.scope.plannerModel, verifierModel: f.scope.verifierModel,
    testIndex: 3, abortSignal: new AbortController().signal,
    stepModelScope: { runId: f.scope.key.runId, create: () => ({ ...f.scope, planner }) },
    sink: { stepStarted: vi.fn(), loopEmitFor: () => ({ stepFinalized: vi.fn(), subActionRecorded: vi.fn() }),
      hookStarted: vi.fn(), hookFinished: vi.fn(), testRetryScheduled: vi.fn() },
  }
  const result = await runMemberTest({ testId: 'synthetic-test-423', name: 'Healing',
    filePath: 'synthetic.yaml', steps: ['Click Log in'] }, config)
  expect(result.status).toBe('passed')
  expect(result.steps[0].evidence?.subActions).toHaveLength(2)
  expect(f.script).toHaveLength(0)
  expect(f.scope.snapshot()).toMatchObject({ started: 4, inputTokens: 400, outputTokens: 40, cachedInputTokens: 160 })
})

test('USAGE-EXTRACTION-FAILURE: discarded extraction usage remains observed after provider failure', async () => {
  const f = sdkFixture([{ failure: 'synthetic extraction failure' }])
  const result = await new LLMVariableExtractor(f.scope.verifierModel).extract(
    { method: 'ai', variableName: 'name' }, makeScreenState(),
  )
  expect(result.success).toBe(false)
  expect(f.scope.finish()).toMatchObject({ started: 1, failed: 1, succeeded: 0 })
  expect(f.scope.snapshot()).not.toHaveProperty('cachedInputTokens')
})
