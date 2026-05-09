import { afterEach, describe, expect, it, vi } from 'vitest'

describe('provider dispatch', () => {
  afterEach(() => {
    vi.doUnmock('@ai-sdk/anthropic')
    vi.doUnmock('@ai-sdk/openai')
    vi.doUnmock('@ai-sdk/google')
    vi.resetModules()
  })

  function mockAnthropicProvider() {
    const model = { kind: 'anthropic-model' }
    const anthropic = vi.fn().mockReturnValue(model)
    const createAnthropic = vi.fn().mockReturnValue(anthropic)

    vi.resetModules()
    vi.doMock('@ai-sdk/anthropic', () => ({ createAnthropic }))

    return { model, anthropic, createAnthropic }
  }

  function mockOpenAIProvider() {
    const model = { kind: 'openai-chat-model' }
    const responsesModel = { kind: 'openai-responses-model' }
    const chat = vi.fn().mockReturnValue(model)
    const responses = vi.fn().mockReturnValue(responsesModel)
    const createOpenAI = vi.fn().mockReturnValue({ chat, responses })

    vi.resetModules()
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI }))

    return { model, responsesModel, chat, responses, createOpenAI }
  }

  function mockGoogleProvider() {
    const model = { kind: 'gemini-model' }
    const gemini = vi.fn().mockReturnValue(model)
    const createGoogleGenerativeAI = vi.fn().mockReturnValue(gemini)

    vi.resetModules()
    vi.doMock('@ai-sdk/google', () => ({ createGoogleGenerativeAI }))

    return { model, gemini, createGoogleGenerativeAI }
  }

  it('dispatches anthropic-compatible through createAnthropic with exact baseURL', async () => {
    const { model, anthropic, createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')

    const result = await createModel({
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/api/v1/messages',
    })

    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://remote.example/api/v1/messages',
      apiKey: 'anthropic-compatible',
    }))
    expect(anthropic).toHaveBeenCalledWith('claude-compatible')
    expect(result).toBe(model)
  })

  it('maps anthropic-compatible API keys to the Anthropic apiKey option', async () => {
    const { createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')

    await createModel({
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/api/v1/messages',
      apiKey: 'sk-saved',
    })

    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-saved',
    }))
  })

  it('maps anthropic-compatible bearer tokens to the Anthropic authToken option', async () => {
    const { createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')

    await createModel({
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/api/v1/messages',
      authToken: 'bearer-saved',
    })

    const options = createAnthropic.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.authToken).toBe('bearer-saved')
    expect(options).not.toHaveProperty('apiKey')
  })

  it('passes providerHeaders only as Anthropic headers', async () => {
    const { createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')

    await createModel({
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/api/v1/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    })

    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      headers: { 'x-workspace': 'agent-qa' },
    }))
  })

  it('passes Anthropic-compatible fetch through without adding hidden timeout wrappers', async () => {
    const { createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    await createModel({
      provider: 'anthropic-compatible',
      model: 'claude-compatible',
      baseURL: 'https://remote.example/api/v1/messages',
      apiKey: 'sk-saved',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      fetch,
    })

    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://remote.example/api/v1/messages',
      apiKey: 'sk-saved',
      headers: { 'x-workspace': 'agent-qa' },
      fetch,
    })
  })

  it('preserves OpenAI-compatible chat model creation', async () => {
    const { model, chat, responses, createOpenAI } = mockOpenAIProvider()
    const { createModel, getProviderOptions } = await import('../provider.js')

    const modelConfig = {
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      apiKey: 'sk-saved',
      baseURL: 'https://remote.example/api/v1',
    } as const
    const result = await createModel(modelConfig)

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-saved',
      baseURL: 'https://remote.example/api/v1',
      fetch: undefined,
    })
    expect(chat).toHaveBeenCalledWith('deepseek-chat')
    expect(responses).not.toHaveBeenCalled()
    expect(result).toBe(model)
    expect(getProviderOptions(modelConfig)).toBeUndefined()
  })

  it('passes OpenAI-compatible headers and fetch through without adding hidden timeout wrappers', async () => {
    const { chat, createOpenAI } = mockOpenAIProvider()
    const { createModel } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    await createModel({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      apiKey: 'sk-saved',
      baseURL: 'https://remote.example/api/v1',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      fetch,
    })

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-saved',
      baseURL: 'https://remote.example/api/v1',
      headers: { 'x-workspace': 'agent-qa' },
      fetch,
    })
    expect(chat).toHaveBeenCalledWith('deepseek-chat')
  })

  it('creates OpenAI subscription models with the Responses API', async () => {
    const { responsesModel, responses, chat, createOpenAI } = mockOpenAIProvider()
    const { createModel } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    const result = await createModel({
      provider: 'openai-subscription',
      model: 'gpt-5',
      fetch,
    })

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: 'placeholder',
      fetch,
    })
    expect(responses).toHaveBeenCalledWith('gpt-5')
    expect(chat).not.toHaveBeenCalled()
    expect(result).toBe(responsesModel)
  })

  it('creates Anthropic subscription models with subscription fetch material', async () => {
    const { model, anthropic, createAnthropic } = mockAnthropicProvider()
    const { createModel } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    const result = await createModel({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-20250514',
      fetch,
    })

    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'placeholder',
      fetch,
    })
    expect(anthropic).toHaveBeenCalledWith('claude-sonnet-4-20250514')
    expect(result).toBe(model)
  })

  it('creates Gemini models with the Google Generative AI provider', async () => {
    const { model, gemini, createGoogleGenerativeAI } = mockGoogleProvider()
    const { createModel } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    const result = await createModel({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'gemini-key',
      fetch,
    })

    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
      apiKey: 'gemini-key',
      fetch,
    })
    expect(gemini).toHaveBeenCalledWith('gemini-2.0-flash')
    expect(result).toBe(model)
  })

  it('uses providerOptions only for openai-subscription', async () => {
    const { getProviderOptions } = await import('../provider.js')
    const fetch = vi.fn() as unknown as typeof globalThis.fetch

    expect(getProviderOptions({
      provider: 'openai-subscription',
      model: 'gpt-5',
      fetch,
    })).toEqual({
      openai: {
        instructions: 'You are a helpful assistant.',
        store: false,
      },
    })
    expect(getProviderOptions({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
      fetch,
    })).toBeUndefined()
  })

  it('rejects unknown providers with the five supported modes in the message', async () => {
    const { createModel } = await import('../provider.js')

    await expect(createModel({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    } as any)).rejects.toThrow(
      'Supported: openai-compatible, anthropic-compatible, openai-subscription, anthropic-subscription, gemini',
    )
  })
})
