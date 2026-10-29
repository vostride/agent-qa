import { anthropicCompatible, anthropicSubscription } from '../adapters/anthropic.js'
import { gemini } from '../adapters/gemini.js'
import { openaiCompatible, openaiSubscription } from '../adapters/openai.js'

import { registerProvider } from './registry.js'

export function seedBuiltins(): void {
  registerProvider({
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    adapter: openaiCompatible,
    needsBaseURL: true,
    authModes: ['api-key'],
    credentialOptional: true,
    modelAdapter: 'openai-responses',
    baseURLPlaceholder: 'https://openrouter.ai/api/v1',
    defaultModel: 'gpt-5.5',
  })
  registerProvider({
    id: 'anthropic-compatible',
    label: 'Anthropic-compatible',
    adapter: anthropicCompatible,
    needsBaseURL: true,
    authModes: ['api-key', 'bearer-token'],
    credentialOptional: true,
    modelAdapter: 'anthropic-messages',
    baseURLPlaceholder: 'https://anthropic-proxy.example/messages',
    defaultModel: 'claude-sonnet-4-6',
  })
  registerProvider({
    id: 'openai-subscription',
    label: 'OpenAI subscription',
    adapter: openaiSubscription,
    needsBaseURL: false,
    authModes: ['subscription'],
    subscription: true,
    modelAdapter: 'openai-responses',
    defaultModel: 'gpt-6.1-sol',
    // The subscription backend rejects `max_output_tokens` and `temperature` with HTTP 400.
    unsupportedParams: ['maxOutputTokens', 'temperature'],
  })
  registerProvider({
    id: 'anthropic-subscription',
    label: 'Anthropic subscription',
    adapter: anthropicSubscription,
    needsBaseURL: false,
    authModes: ['subscription'],
    subscription: true,
    modelAdapter: 'anthropic-messages',
    defaultModel: 'claude-sonnet-5-5',
  })
  registerProvider({
    id: 'gemini',
    label: 'Gemini',
    adapter: gemini,
    needsBaseURL: false,
    authModes: ['api-key'],
    defaultModel: 'gemini-3-flash-preview',
  })
}
