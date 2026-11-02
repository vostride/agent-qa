import { APICallError } from '@ai-sdk/provider'
import { simulateReadableStream } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelCapabilities, ModelProfile, ModelProviderId } from '@vostride/agent-qa-schema'

import { capabilityKey, overrideStore } from '../capability/override-store.js'
import { resolveCapabilities } from '../capability/resolve.js'
import { createModel } from '../registry.js'
import { getProvider } from '../providers/registry.js'
import type { ResolvedModelAuth } from '../auth.js'

interface RegistryCase {
  provider: ModelProviderId
  modelId: string
  expectedProvider: string
  baseURL?: string
  headers?: Record<string, string>
}

const noneAuth: ResolvedModelAuth = { kind: 'none' }

type StreamPart = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<
  infer Part
>
  ? Part
  : never

function profile(testCase: RegistryCase): ModelProfile {
  return {
    provider: testCase.provider,
    model: testCase.modelId,
    ...(testCase.baseURL ? { baseURL: testCase.baseURL } : {}),
    ...(testCase.headers ? { headers: testCase.headers } : {}),
    auth: { mode: 'none' },
  }
}

function fakeLanguageModel(
  onGenerate: (params: LanguageModelV4CallOptions) => void,
  streamChunks: StreamPart[] = [],
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'override.test',
    modelId: 'override-model',
    supportedUrls: {},
    async doGenerate(params) {
      onGenerate(params)
      return {
        content: [],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }
    },
    async doStream() {
      return {
        stream: simulateReadableStream({
          chunks: streamChunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      }
    },
  }
}

function apiError(message: string): APICallError {
  return new APICallError({
    message,
    url: 'http://localhost/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseHeaders: {},
    responseBody: '',
    isRetryable: false,
  })
}

function overrideProfile(): ModelProfile {
  return {
    provider: 'openai-compatible',
    model: 'override-model',
    baseURL: 'http://localhost:11434/v1',
    auth: { mode: 'none' },
  }
}

function promptWithUserText(text: string): LanguageModelV4CallOptions['prompt'] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  ] as LanguageModelV4CallOptions['prompt']
}

function textDelta(delta: string): StreamPart {
  return { type: 'text-delta', id: 'text-1', delta } as StreamPart
}

async function collectStreamText(stream: ReadableStream<StreamPart>): Promise<string> {
  const reader = stream.getReader()
  let output = ''

  for (;;) {
    const result = await reader.read()
    if (result.done) break

    if (result.value.type === 'text-delta') {
      output += result.value.delta
    }
  }

  return output
}

describe('createModel', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    overrideStore.clear()
  })

  it('observes actual provider attempts beneath retries, without receiving provider data', async () => {
    const onProviderCall = vi.fn()
    let attempts = 0
    const raw = fakeLanguageModel(() => {
      if (++attempts === 1) {
        throw new APICallError({
          message: 'temporary provider failure',
          url: 'http://localhost/v1',
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { 'retry-after-ms': '0' },
          isRetryable: true,
        })
      }
    })
    const model = createModel(overrideProfile(), noneAuth,
      (text) => text,
      { languageModels: { 'override-model': raw } }, { onProviderCall })

    await model.doGenerate({ prompt: promptWithUserText('hello') })

    expect(attempts).toBe(2)
    expect(onProviderCall.mock.calls).toEqual([[], []])
  })

  it('observes adapter fallbacks and leaves no-observer calls unchanged', async () => {
    const onProviderCall = vi.fn()
    const providerCall = vi.fn()
    const raw = fakeLanguageModel(providerCall)
    vi.spyOn(getProvider('openai-compatible')!, 'adapter').mockReturnValue(raw)
    const observed = createModel(overrideProfile(), noneAuth, (text) => text, {}, { onProviderCall })
    const ordinary = createModel(overrideProfile(), noneAuth, (text) => text)
    const params: LanguageModelV4CallOptions = { prompt: promptWithUserText('hello') }
    expect(await observed.doGenerate(params)).toEqual(await ordinary.doGenerate(params))
    expect(providerCall).toHaveBeenCalledTimes(2)
    expect(onProviderCall).toHaveBeenCalledTimes(1)
    expect(observed.modelId).toBe(ordinary.modelId)
    expect(observed.provider).toBe(ordinary.provider)
  })

  it('keeps an observer failure from changing provider results or errors', async () => {
    const onProviderCall = () => { throw new Error('observation failed') }
    const raw = fakeLanguageModel(() => {})
    const model = createModel(overrideProfile(), noneAuth,
      (text) => text,
      { languageModels: { 'override-model': raw } }, { onProviderCall })
    expect((await model.doGenerate({ prompt: [] })).finishReason.unified).toBe('stop')
    const failure = apiError('provider failure')
    raw.doGenerate = () => { throw failure }
    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(failure)
  })

  it('preserves provider binding and streaming while observing each invocation once', async () => {
    const onProviderCall = vi.fn()
    const raw = fakeLanguageModel(() => {}, [textDelta('streamed')])
    const generate = raw.doGenerate
    const stream = raw.doStream
    raw.doGenerate = function (params) {
      expect(this).toBe(raw)
      return generate.call(this, params)
    }
    raw.doStream = function (params) {
      expect(this).toBe(raw)
      return stream.call(this, params)
    }
    const model = createModel(overrideProfile(), noneAuth,
      (text) => text,
      { languageModels: { 'override-model': raw } }, { onProviderCall })
    await model.doGenerate({ prompt: [] })
    const result = await model.doStream({ prompt: [] })
    expect(await collectStreamText(result.stream)).toBe('streamed')
    expect(onProviderCall).toHaveBeenCalledTimes(2)
  })

  it('observes a failed invocation and preserves the original error', async () => {
    const onProviderCall = vi.fn()
    const failure = apiError('permanent failure')
    const model = createModel(overrideProfile(), noneAuth,
      (text) => text,
      { languageModels: { 'override-model': fakeLanguageModel(() => { throw failure }) } },
      { onProviderCall })
    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(failure)
    expect(onProviderCall).toHaveBeenCalledTimes(1)
  })

  it('resolves a model on the current provider specification for each built-in provider through the registry', () => {
    const cases: RegistryCase[] = [
      {
        provider: 'openai-compatible',
        modelId: 'local-chat-model',
        expectedProvider: 'openai.chat',
        baseURL: 'http://localhost:11434/v1',
      },
      {
        provider: 'openai-subscription',
        modelId: 'gpt-5.1',
        expectedProvider: 'openai.responses',
      },
      {
        provider: 'anthropic-compatible',
        modelId: 'claude-local',
        expectedProvider: 'anthropic.messages',
        baseURL: 'http://localhost:8080',
        headers: { 'x-routing-key': 'local' },
      },
      {
        provider: 'anthropic-subscription',
        modelId: 'claude-sonnet-4-5',
        expectedProvider: 'anthropic.messages',
      },
      {
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        expectedProvider: 'google.generative-ai',
      },
    ]

    for (const testCase of cases) {
      const model = createModel(profile(testCase), noneAuth, (text) => text)

      expect(model.specificationVersion).toBe('v4')
      expect(model.provider).toBe(testCase.expectedProvider)
      expect(model.modelId).toBe(testCase.modelId)
    }
  })

  it('throws a supported-providers error for unknown provider ids', () => {
    const invalidProfile: ModelProfile = {
      provider: 'unknown-provider' as ModelProviderId,
      model: 'model-id',
      auth: { mode: 'none' },
    }

    expect(() => createModel(invalidProfile, noneAuth, (text) => text)).toThrow(
      /Unknown provider "unknown-provider".*openai-compatible.*gemini/,
    )
  })

  it('applies tool schema middleware centrally through the registry', async () => {
    let captured: LanguageModelV4CallOptions | undefined
    const model = createModel(
      {
        provider: 'openai-compatible',
        model: 'override-model',
        baseURL: 'http://localhost:11434/v1',
        auth: { mode: 'none' },
      },
      noneAuth,
      (text) => text,
      {
        languageModels: {
          'override-model': fakeLanguageModel((params) => {
            captured = params
          }),
        },
      },
    )

    await model.doGenerate({
      prompt: [],
      tools: [
        {
          type: 'function',
          name: 'probe',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            properties: {},
          },
        },
      ],
    })

    const transformedTool = captured?.tools?.[0]
    expect(transformedTool?.type).toBe('function')
    if (!transformedTool || transformedTool.type !== 'function') {
      throw new Error('Expected a transformed function tool')
    }

    expect(transformedTool).toMatchObject({
      type: 'function',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    })
    expect(transformedTool.inputSchema).not.toHaveProperty('$schema')
  })

  it('auto-fills capabilities when absent and preserves declared capabilities', () => {
    const autoProfile = profile({
      provider: 'openai-compatible',
      modelId: 'gpt-4o',
      expectedProvider: 'openai.chat',
      baseURL: 'http://localhost:11434/v1',
    })
    const expected = resolveCapabilities(autoProfile)

    createModel(autoProfile, noneAuth, (text) => text)

    expect(autoProfile.capabilities).toEqual(expected)

    const declared: ModelCapabilities = {
      text: true,
      vision: false,
      visionToolMessages: false,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      contextWindow: 12345,
      maxOutput: 2048,
    }
    const declaredProfile = profile({
      provider: 'openai-compatible',
      modelId: 'gpt-4o',
      expectedProvider: 'openai.chat',
      baseURL: 'http://localhost:11434/v1',
    })
    declaredProfile.capabilities = declared

    createModel(declaredProfile, noneAuth, (text) => text)

    expect(declaredProfile.capabilities).toBe(declared)
  })

  it('records un-retried overflow through the full registry stack', async () => {
    let calls = 0
    const modelProfile = profile({
      provider: 'openai-compatible',
      modelId: 'override-model',
      expectedProvider: 'override.test',
      baseURL: 'http://localhost:11434/v1',
    })
    const overflow = apiError(
      "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens",
    )
    const model = createModel(modelProfile, noneAuth, (text) => text, {
      languageModels: {
        'override-model': {
          ...fakeLanguageModel(() => {
            calls += 1
            throw overflow
          }),
          async doGenerate(params) {
            calls += 1
            throw overflow
          },
        },
      },
    })

    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(overflow)

    expect(calls).toBe(1)
    expect(overrideStore.get(capabilityKey(modelProfile.provider, modelProfile.model))).toBe(32768)
  })
})
