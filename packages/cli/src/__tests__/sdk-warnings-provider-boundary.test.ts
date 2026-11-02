// Every call goes to a stubbed fetch through the real provider adapters: no network.

import { createModel, getProviderOptions } from '@vostride/agent-qa-model'
import type { ResolvedModelAuth } from '@vostride/agent-qa-model'
import { LLMPlanner, LLMVerifier, makeScreenState } from '@vostride/agent-qa-runner'
import type { TokenAccounting } from '@vostride/agent-qa-runner'
import { asRef } from '@vostride/agent-qa-schema'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import type { LogWarningsFunction } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildJobModelCapability } from '../llm-utils.js'

const wires = [
  'openai-compatible', 'openai-subscription', 'anthropic-compatible',
  'anthropic-subscription', 'gemini',
] as const
type Wire = typeof wires[number]
type Answer = { toolCall: { name: string; input: Record<string, unknown> } } | { text: string }

// Vision-capable ids, so the analysis job attaches its image. claude-sonnet-5-5 raises
// tool-choice and temperature notices of its own, so the subscription wire runs claude-sonnet-4-6.
const WIRES: Record<Wire, string> = {
  'openai-compatible': 'gpt-4o',
  'openai-subscription': 'gpt-6.1-sol',
  'anthropic-compatible': 'claude-sonnet-4-6',
  'anthropic-subscription': 'claude-sonnet-4-6',
  gemini: 'gemini-3-flash-preview',
}

const screenshot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const verification = {
  conditions: [],
  dialogs: [],
  isAppError: false,
  reasoning: 'The dashboard is shown',
}

function reply(wire: Wire, answer: Answer): unknown {
  const call = 'toolCall' in answer ? answer.toolCall : undefined
  const text = 'text' in answer ? answer.text : ''
  if (wire.startsWith('anthropic')) return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: WIRES[wire],
    content: [call
      ? { type: 'tool_use', id: 'toolu_fixture', name: call.name, input: call.input }
      : { type: 'text', text }],
    stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  if (wire === 'gemini') return {
    candidates: [{ content: { role: 'model', parts: [call
      ? { functionCall: { name: call.name, args: call.input } }
      : { text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }
  if (wire === 'openai-subscription') return {
    id: 'resp_fixture', created_at: 1, model: WIRES[wire], object: 'response',
    output: [call
      ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: call.name,
        arguments: JSON.stringify(call.input) }
      : { type: 'message', id: 'item_fixture', role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return {
    id: 'chat_fixture', created: 1, model: WIRES[wire],
    choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
      : { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

function transport(wire: Wire, answer: Answer) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
    JSON.stringify(reply(wire, answer)), { headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetch)
  const auth: ResolvedModelAuth = wire.endsWith('subscription')
    ? { kind: 'auth-fetch', fetch,
      modelAdapter: wire.startsWith('openai') ? 'openai-responses' : 'anthropic-messages' }
    : { kind: 'none' }
  const providerOptions = getProviderOptions({ provider: wire,
    ...(auth.kind === 'auth-fetch' ? { modelAdapter: auth.modelAdapter, fetch: auth.fetch } : {}) })
  const profile: ModelProfile = {
    provider: wire,
    model: WIRES[wire],
    baseURL: 'https://fixture.invalid/v1',
    auth: { mode: 'none' },
    ...(providerOptions ? { providerOptions } : {}),
  }
  return { profile, auth, model: createModel(profile, auth, (text) => text), fetch }
}

function accounting(): TokenAccounting {
  return {
    estimate: () => 100,
    recordUsage() {},
    getCeilings: () => ({ contextWindow: 200_000, maxOutput: 768 }),
    degrade: (messages) => ({ ok: true, messages }),
  }
}

// The one request each call sent, and whether the screenshot rode it.
function sentScreenshot(fetch: ReturnType<typeof transport>['fetch']): boolean {
  expect(fetch).toHaveBeenCalledTimes(1)
  return String(fetch.mock.calls[0]![1]!.body).includes(screenshot.toString('base64'))
}

let raised: string[] = []

// The SDK's documented hook sees every warning, so a deprecation shown once is still counted.
const capture: LogWarningsFunction = ({ warnings, provider, model }) => {
  for (const warning of warnings) {
    raised.push(`${provider ?? 'ai'} / ${model ?? '-'}: ${JSON.stringify(warning)}`)
  }
}

beforeEach(() => {
  raised = []
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', capture)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a screenshot call raises no AI SDK warning', () => {
  it.each(wires)('the verifier check over %s', async (wire) => {
    const { model, fetch } = transport(wire, { text: JSON.stringify(verification) })
    const verifier = new LLMVerifier(model, accounting())
    const before = makeScreenState()
    const after = makeScreenState({ url: 'https://example.test/dashboard' })

    const result = await verifier.verify(
      'Click the Log in button', before, after, { type: 'click', ref: asRef('e2') }, screenshot,
    )

    expect(result.verification.verifierError).toBeUndefined()
    expect(sentScreenshot(fetch)).toBe(true)
    expect(raised).toEqual([])
  })

  it.each(wires)('the analysis job over %s', async (wire) => {
    const { profile, auth, fetch } = transport(wire, { text: 'The total is wrong.' })
    const job = buildJobModelCapability(profile, auth, (text) => text)

    const result = await job.generate({ prompt: 'Explain the failure.', images: [screenshot] })

    expect(result.text).toBe('The total is wrong.')
    expect(sentScreenshot(fetch)).toBe(true)
    expect(raised).toEqual([])
  })
})
