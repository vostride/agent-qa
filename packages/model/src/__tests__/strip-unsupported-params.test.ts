import { generateText } from 'ai'
import type { LanguageModelMiddleware } from 'ai'
import { beforeEach, describe, expect, it } from 'vitest'

import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider'
import type { ModelProfile, ModelProviderId } from '@vostride/agent-qa-schema'

import { overrideStore } from '../capability/override-store.js'
import { stripUnsupportedParamsMiddleware } from '../middleware/strip-unsupported-params.js'
import { getProvider } from '../providers/registry.js'
import { createModel } from '../registry.js'
import type { ResolvedModelAuth } from '../auth.js'

const fakeModel = {} as LanguageModelV3

async function transform(
  middleware: LanguageModelMiddleware,
  params: LanguageModelV3CallOptions,
): Promise<LanguageModelV3CallOptions> {
  if (!middleware.transformParams) {
    throw new Error('expected a transformParams middleware')
  }
  return middleware.transformParams({ type: 'generate', params, model: fakeModel })
}

function paramsWithCap(): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [
      {
        type: 'function',
        name: 'probe',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    toolChoice: { type: 'required' },
    temperature: 0.5,
    maxOutputTokens: 4096,
  } as LanguageModelV3CallOptions
}

describe('stripUnsupportedParamsMiddleware', () => {
  it('deletes the named param and preserves every other field, order intact', async () => {
    const middleware = stripUnsupportedParamsMiddleware(['maxOutputTokens'])
    const params = paramsWithCap()
    const before = JSON.parse(JSON.stringify({ ...params, maxOutputTokens: undefined }))

    const result = await transform(middleware, params)

    expect(result).not.toHaveProperty('maxOutputTokens')
    // Every surviving field is byte-identical, and in the same declaration order.
    expect(Object.keys(result)).toEqual(['prompt', 'tools', 'toolChoice', 'temperature'])
    expect(JSON.parse(JSON.stringify(result))).toEqual(before)
  })

  it('returns the params unchanged when the list is empty', async () => {
    const middleware = stripUnsupportedParamsMiddleware([])
    const params = paramsWithCap()

    const result = await transform(middleware, params)

    expect(result).toBe(params)
    expect(result).toHaveProperty('maxOutputTokens', 4096)
  })

  it('returns the params unchanged when no named key is present', async () => {
    const middleware = stripUnsupportedParamsMiddleware(['topK'])
    const params = paramsWithCap()

    const result = await transform(middleware, params)

    expect(result).toBe(params)
    expect(result).toHaveProperty('maxOutputTokens', 4096)
    expect(Object.keys(result)).toEqual(['prompt', 'tools', 'toolChoice', 'temperature', 'maxOutputTokens'])
  })

  it('removes every named key that is present', async () => {
    const middleware = stripUnsupportedParamsMiddleware(['maxOutputTokens', 'topK'])
    const params = { ...paramsWithCap(), topK: 40 } as LanguageModelV3CallOptions

    const result = await transform(middleware, params)

    expect(result).not.toHaveProperty('maxOutputTokens')
    expect(result).not.toHaveProperty('topK')
    expect(result).toHaveProperty('temperature', 0.5)
  })
})

const noneAuth: ResolvedModelAuth = { kind: 'none' }

function captureModel(onGenerate: (params: LanguageModelV3CallOptions) => void): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'capture.test',
    modelId: 'capture-model',
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
      throw new Error('not used')
    },
  }
}

function captureProfile(provider: ModelProviderId): ModelProfile {
  const needsBaseURL = provider === 'openai-compatible' || provider === 'anthropic-compatible'
  return {
    provider,
    model: 'capture-model',
    ...(needsBaseURL ? { baseURL: 'http://localhost:11434/v1' } : {}),
    auth: { mode: 'none' },
  }
}

async function captureMaxOutputTokens(provider: ModelProviderId): Promise<number | undefined> {
  let captured: LanguageModelV3CallOptions | undefined
  const model = createModel(captureProfile(provider), noneAuth, (text) => text, {
    languageModels: { 'capture-model': captureModel((params) => { captured = params }) },
  })
  await generateText({
    model,
    maxOutputTokens: 4096,
    prompt: 'plan the next step',
  })
  return captured?.maxOutputTokens
}

describe('createModel egress strip (auth-free capture proof)', () => {
  beforeEach(() => {
    overrideStore.clear()
  })

  it('strips maxOutputTokens on the wire for openai-subscription (codex Responses 400 fix)', async () => {
    // The captured params are what the provider adapter would serialize to the wire.
    expect(await captureMaxOutputTokens('openai-subscription')).toBeUndefined()
  })

  it('preserves maxOutputTokens for a cap-supporting provider (anthropic-subscription)', async () => {
    expect(await captureMaxOutputTokens('anthropic-subscription')).toBe(4096)
  })

  it('preserves maxOutputTokens for a cap-supporting provider (openai-compatible)', async () => {
    expect(await captureMaxOutputTokens('openai-compatible')).toBe(4096)
  })
})

interface TemperatureWire {
  called: boolean
  temperature: number | undefined
  keys: string[]
}

async function captureTemperature(provider: ModelProviderId): Promise<TemperatureWire> {
  let captured: LanguageModelV3CallOptions | undefined
  const model = createModel(captureProfile(provider), noneAuth, (text) => text, {
    languageModels: { 'capture-model': captureModel((params) => { captured = params }) },
  })
  await generateText({ model, temperature: 0, maxRetries: 0, prompt: 'compile the test document' })
  return {
    called: captured !== undefined,
    temperature: captured?.temperature,
    keys: Object.keys(captured ?? {}),
  }
}

// The Codex subscription backend answers HTTP 400 for `temperature`, which job-model calls send.
describe('temperature on subscription transports', () => {
  beforeEach(() => {
    overrideStore.clear()
  })

  it('the openai-subscription model sends no temperature on the wire when a caller asks for temperature 0', async () => {
    const wire = await captureTemperature('openai-subscription')
    expect(wire.called, 'the capture model was called').toBe(true)
    expect(wire.keys, 'the wire params carry no temperature key').not.toContain('temperature')
    expect(wire.temperature).toBeUndefined()
  })

  it('a provider that accepts temperature keeps temperature 0 on the wire', async () => {
    for (const provider of ['anthropic-subscription', 'openai-compatible'] as const) {
      const wire = await captureTemperature(provider)
      expect(wire.called, `${provider} capture model was called`).toBe(true)
      expect(wire.temperature, provider).toBe(0)
    }
  })
})

describe('provider unsupportedParams declarations', () => {
  it('declares maxOutputTokens unsupported for openai-subscription only', () => {
    expect(getProvider('openai-subscription')?.unsupportedParams).toContain('maxOutputTokens')
  })

  it('does not declare maxOutputTokens unsupported for cap-supporting providers', () => {
    for (const id of ['openai-compatible', 'anthropic-compatible', 'anthropic-subscription', 'gemini']) {
      expect(getProvider(id)?.unsupportedParams ?? []).not.toContain('maxOutputTokens')
    }
  })
})
