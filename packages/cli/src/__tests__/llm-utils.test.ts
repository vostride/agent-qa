import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@vostride/agent-qa-core', () => ({
  getCredential: vi.fn(),
  resolveLLMAuth: vi.fn(),
  writeAuth: vi.fn(() => Promise.resolve()),
}))

vi.mock('../config.js', () => ({
  loadConfigFile: vi.fn(),
}))

import { getCredential, resolveLLMAuth } from '@vostride/agent-qa-core'
import { loadConfigFile } from '../config.js'
import {
  applyResolvedAuthToModelConfig,
  resolveLLMModels,
  resolveCredentials,
  resolveModelAuth,
  resolveNamedConfig,
} from '../llm-utils.js'

const mockGetCredential = vi.mocked(getCredential)
const mockResolveLLMAuth = vi.mocked(resolveLLMAuth)
const mockLoadConfigFile = vi.mocked(loadConfigFile)

const PROVIDER_MODES = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

const DECOY_FALLBACK_KEYS = [
  'anthropic-compatible',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_KEY',
  'remote.example',
] as const

describe('resolveCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads named configs from the provided config path', async () => {
    mockLoadConfigFile.mockResolvedValueOnce({
      registry: {
        llms: [{
          name: 'planner',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'planner' },
    })

    const resolved = await resolveNamedConfig(undefined, 'custom-agent-qa.yaml')

    expect(mockLoadConfigFile).toHaveBeenCalledWith('custom-agent-qa.yaml')
    expect(resolved.config).toMatchObject({
      name: 'planner',
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    })
  })

  it('resolves model auth through the core resolver with the named config', async () => {
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'api-key',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      apiKey: 'sk-planner',
    })

    const auth = await resolveModelAuth('planner', {
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://remote.example/api/v1',
    })

    expect(auth).toEqual(expect.objectContaining({
      kind: 'api-key',
      credentialKey: 'planner',
      apiKey: 'sk-planner',
    }))
    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', {
      provider: 'openai-compatible',
      model: 'gpt-4.1',
      baseURL: 'https://remote.example/api/v1',
    })
  })

  it('applies bearer tokens and providerHeaders to runtime model config without apiKey', () => {
    const runtimeConfig = applyResolvedAuthToModelConfig(
      {
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic.example/messages',
        providerHeaders: { 'x-workspace': 'agent-qa' },
      },
      {
        kind: 'bearer-token',
        credentialKey: 'planner',
        provider: 'anthropic-compatible',
        token: 'bearer-planner',
      },
    )

    expect(runtimeConfig).toEqual({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      authToken: 'bearer-planner',
    })
    expect(runtimeConfig).not.toHaveProperty('apiKey')
  })

  it('throws resolver missing messages before model config creation', () => {
    expect(() => applyResolvedAuthToModelConfig(
      {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
      },
      {
        kind: 'missing',
        credentialKey: 'gemini-fast',
        provider: 'gemini',
        required: true,
        message: 'Save a Gemini API key for this config before testing.',
      },
    )).toThrow('Save a Gemini API key for this config before testing.')
  })

  it.each(PROVIDER_MODES)('resolves %s credentials through core resolveLLMAuth by config name only', async (provider) => {
    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockResolveLLMAuth.mockResolvedValue(
      provider === 'anthropic-compatible'
        ? {
            kind: 'bearer-token',
            credentialKey: 'planner',
            provider: 'anthropic-compatible',
            token: 'bearer-planner',
          }
        : provider.endsWith('-subscription')
          ? {
              kind: 'auth-fetch',
              credentialKey: 'planner',
              provider: provider as 'openai-subscription' | 'anthropic-subscription',
              modelAdapter: provider === 'openai-subscription' ? 'openai-responses' : 'anthropic-messages',
              fetch: authFetch,
            }
          : provider === 'gemini'
            ? {
                kind: 'api-key',
                credentialKey: 'planner',
                provider,
                apiKey: 'gemini-planner',
              }
            : {
                kind: 'api-key',
                credentialKey: 'planner',
                provider,
                apiKey: 'sk-planner',
              },
    )

    await resolveCredentials('planner', {
      provider,
      baseURL: provider.includes('compatible') ? 'https://remote.example/api/v1' : undefined,
    } as any)

    expect(mockResolveLLMAuth).toHaveBeenCalledWith(
      'planner',
      expect.objectContaining({ provider }),
    )
    expect(mockGetCredential).not.toHaveBeenCalledWith(expect.not.stringMatching(/^planner$/))
  })

  it('does not query provider env or host fallback credential keys', async () => {
    mockGetCredential.mockImplementation(async (name: string) => {
      if ((DECOY_FALLBACK_KEYS as readonly string[]).includes(name)) {
        return { type: 'api' as const, provider: 'openai-compatible', key: 'sk-shared' }
      }
      return null
    })
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    const result = await resolveCredentials('planner', {
      provider: 'anthropic-compatible',
      baseURL: 'https://remote.example/api/v1',
    } as any)

    expect(result).toEqual({})
    for (const decoy of DECOY_FALLBACK_KEYS) {
      expect(mockGetCredential).not.toHaveBeenCalledWith(decoy)
    }
  })
})

describe('resolveLLMModels', () => {
  it('uses the current Claude fallback when config has no selected LLM', () => {
    const resolved = resolveLLMModels({})

    expect(resolved.configName).toBe('')
    expect(resolved.planner).toEqual({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-6',
    })
    expect(resolved.verifier).toEqual({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-6',
    })
  })

  it('uses the current Claude fallback when the selected LLM is missing', () => {
    const resolved = resolveLLMModels({
      registry: {
        llms: [{
          name: 'configured',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'missing' },
    })

    expect(resolved.configName).toBe('')
    expect(resolved.planner.model).toBe('claude-sonnet-4-6')
    expect(resolved.verifier.model).toBe('claude-sonnet-4-6')
  })

  it('preserves explicit named model configs', () => {
    const resolved = resolveLLMModels({
      registry: {
        llms: [{
          name: 'configured',
          provider: 'openai-compatible',
          model: 'deepseek-chat',
          baseURL: 'https://remote.example/api/v1',
        }],
      },
      use: { llm: 'configured' },
    })

    expect(resolved.configName).toBe('configured')
    expect(resolved.planner).toEqual({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    })
    expect(resolved.verifier).toEqual(resolved.planner)
  })
})
