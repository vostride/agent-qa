import { generateText, jsonSchema, Output, tool } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import type { ResolvedModelAuth } from '../auth.js'
import { getProviderOptions } from '../adapters/openai.js'
import { createModel } from '../registry.js'

type Transport =
  | 'openai-compatible' | 'openai-subscription' | 'anthropic-compatible'
  | 'anthropic-subscription' | 'gemini'
type Body = Record<string, unknown>

// Registered default models, except OpenAI-compatible, which proxies any model id.
const models: Record<Transport, string> = {
  'openai-compatible': 'proxied-model',
  'openai-subscription': 'gpt-6.1-sol',
  'anthropic-compatible': 'claude-sonnet-4-6',
  'anthropic-subscription': 'claude-sonnet-5-5',
  gemini: 'gemini-3-flash-preview',
}

const clickArgs = { ref: 'e1' }
const extracted = { label: 'Total', count: null }

function answer(provider: Transport, sent: string) {
  const toolCall = sent.includes('"click"')
  const text = JSON.stringify(extracted)
  if (provider.startsWith('anthropic')) {
    const jsonTool = sent.includes('"name":"json"')
    return {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: models[provider],
      content: [toolCall
        ? { type: 'tool_use', id: 'toolu_fixture', name: 'click', input: clickArgs }
        : jsonTool
          ? { type: 'tool_use', id: 'toolu_fixture', name: 'json', input: extracted }
          : { type: 'text', text }],
      stop_reason: toolCall || jsonTool ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
  }
  if (provider === 'gemini') return {
    candidates: [{ content: { role: 'model', parts: [toolCall
      ? { functionCall: { name: 'click', args: clickArgs } }
      : { text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }
  if (provider === 'openai-subscription') return {
    id: 'resp_fixture', created_at: 1, model: models[provider], object: 'response',
    output: [toolCall
      ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'click',
        arguments: JSON.stringify(clickArgs) }
      : { type: 'message', id: 'item_fixture', role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  return {
    id: 'chat_fixture', created: 1, model: models[provider],
    choices: [{ index: 0, finish_reason: toolCall ? 'tool_calls' : 'stop', message: toolCall
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function',
        function: { name: 'click', arguments: JSON.stringify(clickArgs) } }] }
      : { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

function transportModel(provider: Transport) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Response(
    JSON.stringify(answer(provider, String(init?.body))),
    { headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetch)
  const auth: ResolvedModelAuth = provider.endsWith('subscription')
    ? { kind: 'auth-fetch', fetch,
      modelAdapter: provider.startsWith('openai') ? 'openai-responses' : 'anthropic-messages' }
    : { kind: 'none' }
  const providerOptions = getProviderOptions({ provider,
    ...(auth.kind === 'auth-fetch' ? { modelAdapter: auth.modelAdapter, fetch: auth.fetch } : {}) })
  const profile: ModelProfile = {
    provider,
    model: models[provider],
    baseURL: 'https://fixture.invalid/v1',
    auth: { mode: 'none' },
    ...(providerOptions ? { providerOptions } : {}),
  }
  return { model: createModel(profile, auth, text => text), fetch }
}

function sentBody(fetch: ReturnType<typeof transportModel>['fetch']): Body {
  expect(fetch).toHaveBeenCalledTimes(1)
  return JSON.parse(fetch.mock.calls[0]![1]!.body as string) as Body
}

async function toolCallBody(provider: Transport): Promise<Body> {
  const { model, fetch } = transportModel(provider)
  const result = await generateText({
    model,
    instructions: 'Act on the page.',
    prompt: 'Click the total.',
    tools: {
      click: tool({
        description: 'Click an element',
        inputSchema: jsonSchema<{ ref: string }>({
          type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'],
        }),
      }),
    },
    toolChoice: 'required',
    temperature: 0,
    maxOutputTokens: 256,
    maxRetries: 0,
  })
  expect(result.toolCalls.map(call => [call.toolName, call.input])).toEqual([['click', clickArgs]])
  return sentBody(fetch)
}

async function structuredOutputBody(provider: Transport): Promise<Body> {
  const { model, fetch } = transportModel(provider)
  const result = await generateText({
    model,
    instructions: 'Read the page.',
    prompt: 'Extract the total.',
    output: Output.object({
      schema: jsonSchema<{ label: string; count: number | null }>({
        type: 'object',
        properties: { label: { type: 'string' }, count: { type: ['number', 'null'] } },
        required: ['label', 'count'],
      }),
    }),
    maxRetries: 0,
  })
  expect(result.output).toEqual(extracted)
  return sentBody(fetch)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the OpenAI Chat transport request body', () => {
  it('sends the system message first with role system and a required tool choice', async () => {
    const body = await toolCallBody('openai-compatible')
    expect(body).toHaveProperty(['messages', 0], { role: 'system', content: 'Act on the page.' })
    expect(body).toHaveProperty('tool_choice', 'required')
  })

  it('sends a nullable structured-output field as a number-or-null type', async () => {
    const body = await structuredOutputBody('openai-compatible')
    expect(body).toHaveProperty(['messages', 0, 'role'], 'system')
    const count = ['response_format', 'json_schema', 'schema', 'properties', 'count', 'type']
    expect(body).toHaveProperty(count, ['number', 'null'])
  })
})

describe('the OpenAI Responses transport request body', () => {
  it('sends the system message with role system', async () => {
    const body = await toolCallBody('openai-subscription')
    expect(body).toHaveProperty(['input', 0], { role: 'system', content: 'Act on the page.' })
    expect(body).toHaveProperty('tool_choice', 'required')
  })

  it('asks for encrypted reasoning, sends a non-strict tool and no temperature or output limit', async () => {
    const body = await toolCallBody('openai-subscription')
    expect(body).toHaveProperty('include', ['reasoning.encrypted_content'])
    expect(body).toHaveProperty(['tools', 0, 'name'], 'click')
    expect(body).toHaveProperty(['tools', 0, 'strict'], false)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_output_tokens')
  })

  it('keeps the system role and a number-or-null field for structured output', async () => {
    const body = await structuredOutputBody('openai-subscription')
    expect(body).toHaveProperty(['input', 0, 'role'], 'system')
    expect(body).toHaveProperty(
      ['text', 'format', 'schema', 'properties', 'count', 'type'], ['number', 'null'])
  })
})

describe('the Anthropic Messages transport request body', () => {
  // claude-sonnet-5-5 rejects forced tool use, so the provider sends auto for a required tool.
  it.each([
    ['anthropic-compatible', 'any'],
    ['anthropic-subscription', 'auto'],
  ] as const)(
    'over %s sends the system text in system and tool_choice %s for a required tool',
    async (provider, toolChoice) => {
      const body = await toolCallBody(provider)
      expect(body).toHaveProperty('system', [{ type: 'text', text: 'Act on the page.' }])
      expect(body).toHaveProperty(['tool_choice', 'type'], toolChoice)
    },
  )

  it.each(['anthropic-compatible', 'anthropic-subscription'] as const)(
    'over %s sends structured output as output_config',
    async (provider) => {
      const body = await structuredOutputBody(provider)
      expect(body).not.toHaveProperty('tools')
      expect(body).toHaveProperty(['output_config', 'format', 'type'], 'json_schema')
      expect(body).toHaveProperty(
        ['output_config', 'format', 'schema', 'properties', 'count', 'type'], ['number', 'null'])
    },
  )
})

describe('the Gemini transport request body', () => {
  it('sends the tool as a JSON Schema parametersJsonSchema declaration', async () => {
    const body = await toolCallBody('gemini')
    const declaration = ['tools', 0, 'functionDeclarations', 0]
    const ref = [...declaration, 'parametersJsonSchema', 'properties', 'ref']
    expect(body).toHaveProperty(ref, { type: 'string' })
    expect(body).not.toHaveProperty([...declaration, 'parameters'])
  })

  it('sends structured output as a JSON Schema responseJsonSchema with a number-or-null field', async () => {
    const body = await structuredOutputBody('gemini')
    expect(body).toHaveProperty(
      ['generationConfig', 'responseJsonSchema', 'properties', 'count', 'type'], ['number', 'null'])
    expect(body).not.toHaveProperty(['generationConfig', 'responseSchema'])
  })
})
