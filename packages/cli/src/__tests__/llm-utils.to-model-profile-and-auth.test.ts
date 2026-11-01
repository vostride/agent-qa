import { describe, expect, it, vi } from 'vitest'

import {
  toModelProfileAndAuth,
  type LLMConfigLike,
  type ResolvedLLMAuth,
} from '../llm-utils.js'

function authFetch(): typeof globalThis.fetch {
  return vi.fn() as unknown as typeof globalThis.fetch
}

describe('toModelProfileAndAuth', () => {
  it('maps api-key auth and model identity fields into profile plus auth', () => {
    const config: LLMConfigLike = {
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseURL: 'https://models.example/v1',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'api-key',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      apiKey: 'sk-planner',
    }

    const result = toModelProfileAndAuth(config, resolved)

    expect(result).toEqual({
      profile: {
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
        baseURL: 'https://models.example/v1',
        headers: { 'x-workspace': 'agent-qa' },
        auth: { mode: 'api-key' },
      },
      auth: {
        kind: 'api-key',
        apiKey: 'sk-planner',
      },
    })
    expect(result.profile).not.toHaveProperty('providerOptions')
  })

  it('maps bearer-token auth without adding absent optional profile fields', () => {
    const config: LLMConfigLike = {
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://anthropic.example/messages',
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'bearer-token',
      credentialKey: 'verifier',
      provider: 'anthropic-compatible',
      token: 'bearer-verifier',
    }

    const result = toModelProfileAndAuth(config, resolved)

    expect(result).toEqual({
      profile: {
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic.example/messages',
        auth: { mode: 'bearer-token' },
      },
      auth: {
        kind: 'bearer-token',
        token: 'bearer-verifier',
      },
    })
    expect(result.profile).not.toHaveProperty('headers')
    expect(result.profile).not.toHaveProperty('providerOptions')
  })

  it('maps auth-fetch auth with the same fetch identity and model adapter', () => {
    const fetchImpl = authFetch()
    const config: LLMConfigLike = {
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-6',
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'auth-fetch',
      credentialKey: 'claude-subscription',
      provider: 'anthropic-subscription',
      modelAdapter: 'anthropic-messages',
      fetch: fetchImpl,
    }

    const result = toModelProfileAndAuth(config, resolved)

    expect(result).toEqual({
      profile: {
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-6',
        auth: { mode: 'subscription', plugin: 'anthropic-subscription' },
      },
      auth: {
        kind: 'auth-fetch',
        modelAdapter: 'anthropic-messages',
        fetch: fetchImpl,
      },
    })
    expect(result.auth.kind).toBe('auth-fetch')
    if (result.auth.kind === 'auth-fetch') {
      expect(result.auth.fetch).toBe(fetchImpl)
      expect(result.auth.modelAdapter).toBe('anthropic-messages')
    }
  })

  it('maps unauthenticated resolved auth to none transport auth', () => {
    const config: LLMConfigLike = {
      provider: 'openai-compatible',
      model: 'local-text-model',
      baseURL: 'http://127.0.0.1:11434/v1',
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'unauthenticated',
      credentialKey: 'local',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    }

    expect(toModelProfileAndAuth(config, resolved)).toEqual({
      profile: {
        provider: 'openai-compatible',
        model: 'local-text-model',
        baseURL: 'http://127.0.0.1:11434/v1',
        auth: { mode: 'none' },
      },
      auth: {
        kind: 'none',
      },
    })
  })

  it('throws the resolved missing-auth message verbatim', () => {
    const config: LLMConfigLike = {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
    }
    const message = 'Save a Gemini API key for this config before testing.'
    const resolved: ResolvedLLMAuth = {
      kind: 'missing',
      credentialKey: 'gemini-fast',
      provider: 'gemini',
      required: true,
      message,
    }

    expect(() => toModelProfileAndAuth(config, resolved)).toThrow(message)
  })

  it('bakes openai responses provider options onto the profile once', () => {
    const fetchImpl = authFetch()
    const config: LLMConfigLike = {
      provider: 'openai-subscription',
      model: 'gpt-5.2',
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'auth-fetch',
      credentialKey: 'codex',
      provider: 'openai-subscription',
      modelAdapter: 'openai-responses',
      fetch: fetchImpl,
    }

    const result = toModelProfileAndAuth(config, resolved)

    expect(result).toEqual({
      profile: {
        provider: 'openai-subscription',
        model: 'gpt-5.2',
        providerOptions: {
          openai: {
            instructions: 'You are a helpful assistant.',
            store: false,
            systemMessageMode: 'system',
          },
        },
        auth: { mode: 'subscription', plugin: 'openai-subscription' },
      },
      auth: {
        kind: 'auth-fetch',
        modelAdapter: 'openai-responses',
        fetch: fetchImpl,
      },
    })
  })

  it('passes plugin provider ids through unchanged while deriving auth from the resolved kind', () => {
    const fetchImpl = authFetch()
    const config: LLMConfigLike = {
      provider: 'acme-plugin',
      model: 'acme-large',
      baseURL: 'https://acme.example/model',
    }
    const resolved: ResolvedLLMAuth = {
      kind: 'auth-fetch',
      credentialKey: 'acme',
      provider: 'acme-plugin',
      modelAdapter: 'anthropic-messages',
      fetch: fetchImpl,
    }

    expect(toModelProfileAndAuth(config, resolved)).toEqual({
      profile: {
        provider: 'acme-plugin',
        model: 'acme-large',
        baseURL: 'https://acme.example/model',
        auth: { mode: 'subscription', plugin: 'acme-plugin' },
      },
      auth: {
        kind: 'auth-fetch',
        modelAdapter: 'anthropic-messages',
        fetch: fetchImpl,
      },
    })
  })
})
