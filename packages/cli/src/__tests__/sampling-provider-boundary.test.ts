import type { DeclaredModelProfile } from '@vostride/agent-qa-schema'
import { createModel } from '@vostride/agent-qa-model'
import type { ResolvedModelAuth } from '@vostride/agent-qa-model'
import { LLMPlanner, makeScreenState } from '@vostride/agent-qa-runner'
import type { StepContext, TokenAccounting } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

type StubLanguageModel = ReturnType<typeof createModel>
type CapturedCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

const noneAuth: ResolvedModelAuth = { kind: 'none' }

function stubGenerateResult(): StubGenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'provider-boundary-action',
        toolName: 'web_click',
        input: JSON.stringify({
          ref: 'e2',
          reasoning: 'Click the requested Log in button',
          confidence: 0.95,
          stepComplete: true,
          doesActionAdvanceUsTowardsGoal: true,
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

function createCapturingModel(): {
  captured: () => CapturedCallOptions | undefined
  model: StubLanguageModel
} {
  let captured: CapturedCallOptions | undefined
  const stub: StubLanguageModel = {
    specificationVersion: 'v4',
    provider: 'sampling-boundary-stub',
    modelId: 'sampling-boundary-stub',
    supportedUrls: {},
    async doGenerate(params) {
      captured = params
      return stubGenerateResult()
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }

  // openai-compatible strips no sampling params, so `doGenerate` sees the provider boundary.
  const model = createModel(
    {
      provider: 'openai-compatible',
      model: 'sampling-boundary-stub',
      baseURL: 'http://localhost:11434/v1',
      auth: { mode: 'none' },
    },
    noneAuth,
    (text) => text,
    { languageModels: { 'sampling-boundary-stub': stub } },
  )

  return { captured: () => captured, model }
}

function createAccounting(): TokenAccounting {
  return {
    estimate: () => 100,
    recordUsage() {},
    getCeilings: () => ({ contextWindow: 200_000, maxOutput: 768 }),
    degrade: (messages) => ({ ok: true, messages }),
  }
}

function createStepContext(model: StubLanguageModel): StepContext {
  return {
    stepInstruction: 'Click the Log in button',
    testName: 'sampling provider boundary',
    previousSteps: [],
    plannerModel: model,
    verifierModel: model,
  }
}

async function capturePlannerRequest(
  profile?: DeclaredModelProfile,
): Promise<CapturedCallOptions> {
  const { captured, model } = createCapturingModel()
  const planner = new LLMPlanner(model, 'web', undefined, undefined, createAccounting(), profile)

  await planner.plan(
    'Click the Log in button',
    makeScreenState(),
    createStepContext(model),
  )

  const request = captured()
  expect(request).toBeDefined()
  if (request === undefined) throw new Error('expected a captured provider-boundary request')
  return request
}

describe('sampling provider-boundary proof', () => {
  it(
    'preserves pinned sampling params through createModel with a clamp-owned output cap',
    async () => {
      const request = await capturePlannerRequest({
        provider: 'openai-compatible',
        modelId: 'sampling-boundary-stub',
        vision: true,
        sampling: {
          temperature: 0,
          topP: 1,
          stop: ['<END>'],
          seed: 42,
        },
      })

      expect(request.temperature).toBe(0)
      expect(request.topP).toBe(1)
      expect(request.stopSequences).toEqual(['<END>'])
      expect(request.seed).toBe(42)
      expect(request.maxOutputTokens).toBeGreaterThan(0)
    },
  )

  it.each([
    ['no declared profile', undefined],
    [
      'a declared profile with sampling omitted',
      {
        provider: 'openai-compatible',
        modelId: 'sampling-boundary-stub',
        vision: true,
      } satisfies DeclaredModelProfile,
    ],
  ] as const)(
    'omits sampling params for %s while retaining the clamp-owned output cap',
    async (_label, profile) => {
      const request = await capturePlannerRequest(profile)

      expect(request.temperature).toBeUndefined()
      expect(request.topP).toBeUndefined()
      expect(request.stopSequences).toBeUndefined()
      expect(request.seed).toBeUndefined()
      expect(request.maxOutputTokens).toBeGreaterThan(0)
    },
  )
})
