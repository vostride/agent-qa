import type { LanguageModel } from 'ai'
import { describe, expect, it } from 'vitest'
import { createStepModelScope } from '../../run/step-model-observations.js'
import type { StepModelObservation, StepModelScopeKey } from '../../run/ports.js'
import { makePlanner } from './loop-harness.js'

import { buildTools, defaultRegistry } from '../../tools/index.js'
import {
  executePlanningTurn,
  type ExecutePlanningTurnOptions,
} from '../planning-turn.js'

type StubLanguageModel = Extract<LanguageModel, { readonly specificationVersion: 'v4' }>
type GenerateCall = Parameters<StubLanguageModel['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

const MODEL_ID = 'runner-sampling-stub'
const ACTION_INPUT = {
  ref: 'e1',
  reasoning: 'click the requested control',
  confidence: 0.9,
  stepComplete: true,
  doesActionAdvanceUsTowardsGoal: true,
}

function generateResult(content: GenerateResult['content']): GenerateResult {
  return {
    content,
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
    response: {
      id: 'sampling-response',
      timestamp: new Date(0),
      modelId: MODEL_ID,
    },
  }
}

function createCapturingModel(output: 'action' | 'no-tool' = 'action') {
  const calls: GenerateCall[] = []
  const bind = (observation?: StepModelObservation): StubLanguageModel => ({
    specificationVersion: 'v4',
    provider: 'runner-test',
    modelId: MODEL_ID,
    supportedUrls: {},
    async doGenerate(params) {
      calls.push(params)
      observation?.onCall({ kind: 'start' })
      // Independently specified raw-provider facts at dispatch, before SDK fallback.
      observation?.onCall({ kind: 'success', report: {
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, respondingModelId: MODEL_ID,
      } })
      return generateResult(
        output === 'action'
          ? [{
              type: 'tool-call',
              toolCallId: `tool-call-${calls.length}`,
              toolName: 'web_click',
              input: JSON.stringify(ACTION_INPUT),
            }]
          : [],
      )
    },
    async doStream() {
      throw new Error('streaming is not used by executePlanningTurn')
    },
  })
  const base = bind()
  const scope = createStepModelScope({
    key: { runId: 'sampling-run' as StepModelScopeKey['runId'], testIndex: 0, stepIndex: 0 },
    models: { planner: { model: base, bind }, verifier: { model: base, bind } },
    mask: text => text, createConsumers: () => ({ planner: makePlanner() }),
  })

  return { model: scope.plannerModel, calls }
}

function turnOptions(
  model: LanguageModel,
  overrides: Partial<ExecutePlanningTurnOptions> = {},
): ExecutePlanningTurnOptions {
  return {
    model,
    registry: defaultRegistry,
    actionTools: buildTools(defaultRegistry, { platform: 'web' }),
    system: 'system prompt',
    messages: [{ role: 'user', content: 'click the requested control' }],
    ...overrides,
  }
}

describe('executePlanningTurn sampling seam', () => {
  it('passes pinned sampling values and the clamp-owned output ceiling to the raw model boundary', async () => {
    const { model, calls } = createCapturingModel()

    const result = await executePlanningTurn(turnOptions(model, {
      maxOutputTokens: 768,
      sampling: { temperature: 0, topP: 1, stop: ['<END>'], seed: 42 },
    }))

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].temperature).toBe(0)
    expect(calls[0].topP).toBe(1)
    expect(calls[0].stopSequences).toEqual(['<END>'])
    expect(calls[0].seed).toBe(42)
    expect(calls[0].maxOutputTokens).toBe(768)
  })

  it('omits every sampling key when no profile pins one', async () => {
    const { model, calls } = createCapturingModel()

    const result = await executePlanningTurn(turnOptions(model, { maxOutputTokens: 512 }))

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].temperature).toBeUndefined()
    expect(calls[0].topP).toBeUndefined()
    expect(calls[0].stopSequences).toBeUndefined()
    expect(calls[0].seed).toBeUndefined()
    expect(calls[0].maxOutputTokens).toBe(512)
  })

  it('records observed model identity and only the effective settings on success', async () => {
    const { model } = createCapturingModel()

    const result = await executePlanningTurn(turnOptions(model, {
      maxOutputTokens: 640,
      sampling: { temperature: 0, seed: 7 },
    }))

    expect(result.ok).toBe(true)
    expect(result.callRecord).toEqual({
      resolvedModelId: MODEL_ID,
      effectiveMaxOutputTokens: 640,
      effectiveSampling: { temperature: 0, seed: 7 },
    })
    expect(result.callRecord).not.toHaveProperty('fingerprint')
  })

  it('records the final response model identity on the no-action failure variant', async () => {
    const { model, calls } = createCapturingModel('no-tool')

    const result = await executePlanningTurn(turnOptions(model, { maxOutputTokens: 384 }))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected planning failure')
    expect(result.reason).toBe('no_action_tool_called')
    expect(calls).toHaveLength(2)
    expect(result.callRecord).toEqual({
      resolvedModelId: MODEL_ID,
      effectiveMaxOutputTokens: 384,
    })
    expect(result.callRecord).not.toHaveProperty('effectiveSampling')
    expect(result.callRecord).not.toHaveProperty('fingerprint')
  })
})
