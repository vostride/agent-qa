import { generateText, jsonSchema, Output, tool } from 'ai'
import type { LogWarningsFunction } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JSONSchema7 } from '@ai-sdk/provider'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import type { ResolvedModelAuth } from '../auth.js'
import { withoutPropertyNames } from '../middleware/drop-property-names.js'
import { createModel } from '../registry.js'

const keyed = { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} }
const plain = { type: 'object', additionalProperties: {} }

describe('withoutPropertyNames', () => {
  it('drops a string-keyed propertyNames at every place the OpenAI provider walks', () => {
    const schema = {
      ...keyed,
      properties: { headers: keyed },
      patternProperties: { '^x-': keyed },
      additionalItems: keyed,
      items: [keyed, { type: 'array', items: keyed }],
      contains: keyed,
      not: keyed,
      allOf: [keyed],
      anyOf: [keyed, { type: 'string' }],
      oneOf: [keyed],
      definitions: { headers: keyed },
      $defs: { headers: { ...keyed, propertyNames: { pattern: '^[a-z]+$' } } },
      dependencies: { headers: keyed, cookies: ['headers'] },
      if: keyed,
      then: keyed,
      else: keyed,
    }

    expect(JSON.stringify(withoutPropertyNames(schema))).toBe(JSON.stringify({
      ...plain,
      properties: { headers: plain },
      patternProperties: { '^x-': plain },
      additionalItems: plain,
      items: [plain, { type: 'array', items: plain }],
      contains: plain,
      not: plain,
      allOf: [plain],
      anyOf: [plain, { type: 'string' }],
      oneOf: [plain],
      definitions: { headers: plain },
      $defs: { headers: plain },
      dependencies: { headers: plain, cookies: ['headers'] },
      if: plain,
      then: plain,
      else: plain,
    }))
  })

  it('keeps a property named propertyNames', () => {
    const schema = { type: 'object', properties: { propertyNames: { type: 'string' } } }

    expect(withoutPropertyNames(schema)).toEqual(schema)
  })

  it('keeps a key schema that is not a string, for the provider to refuse', () => {
    const numbered = { type: 'object', propertyNames: { type: 'number' } }
    const closed = { type: 'object', propertyNames: false }

    expect(withoutPropertyNames(numbered)).toEqual(numbered)
    expect(withoutPropertyNames(closed)).toEqual(closed)
  })

  it('leaves propertyNames under a keyword the provider does not walk', () => {
    const schema = { type: 'array', prefixItems: [keyed] }

    expect(withoutPropertyNames(schema)).toEqual(schema)
  })

  it('does not change the schema it is given', () => {
    const schema = { ...keyed, properties: { headers: keyed } }
    const before = structuredClone(schema)

    withoutPropertyNames(schema)

    expect(schema).toEqual(before)
  })
})

// What zod 4 emits for `z.record(z.string(), z.string())`.
const headers: JSONSchema7 = {
  type: 'object',
  properties: {
    headers: {
      type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'string' },
    },
  },
  required: ['headers'],
  additionalProperties: false,
}

type OpenAiTransport = 'openai-compatible' | 'openai-subscription'

function openAiModel(provider: OpenAiTransport, call: { tool: boolean }) {
  const output = JSON.stringify({ headers: { accept: 'json' } })
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(
    provider === 'openai-subscription'
      ? { id: 'resp_fixture', created_at: 1, model: 'gpt-6.1-sol', object: 'response',
        output: [call.tool
          ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'route',
            arguments: output }
          : { type: 'message', id: 'item_fixture', role: 'assistant',
            content: [{ type: 'output_text', text: output, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5 } }
      : { id: 'chat_fixture', created: 1, model: 'gpt-4o',
        choices: [{ index: 0, finish_reason: call.tool ? 'tool_calls' : 'stop', message: call.tool
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture',
            type: 'function', function: { name: 'route', arguments: output } }] }
          : { role: 'assistant', content: output } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const auth: ResolvedModelAuth = provider === 'openai-subscription'
    ? { kind: 'auth-fetch', fetch, modelAdapter: 'openai-responses' }
    : { kind: 'none' }
  const profile: ModelProfile = {
    provider,
    model: provider === 'openai-subscription' ? 'gpt-6.1-sol' : 'gpt-4o',
    baseURL: 'https://fixture.invalid/v1',
    auth: { mode: 'none' },
  }
  return { model: createModel(profile, auth, (text) => text), fetch }
}

function captureWarnings(): string[] {
  const raised: string[] = []
  const capture: LogWarningsFunction = ({ warnings }) => {
    raised.push(...warnings.map(warning => JSON.stringify(warning)))
  }
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', capture)
  return raised
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('a record-keyed schema on the OpenAI transports', () => {
  it.each(['openai-compatible', 'openai-subscription'] as const)(
    'over %s sends a tool without propertyNames and raises no warning',
    async (provider) => {
      const raised = captureWarnings()
      const { model, fetch } = openAiModel(provider, { tool: true })

      await generateText({
        model,
        prompt: 'Mock the shop API.',
        tools: {
          route: tool({ description: 'Mock a web route', inputSchema: jsonSchema(headers) }),
        },
        toolChoice: 'required',
        maxRetries: 0,
      })

      expect(String(fetch.mock.calls[0]![1]!.body)).not.toContain('propertyNames')
      expect(raised).toEqual([])
    },
  )

  it.each(['openai-compatible', 'openai-subscription'] as const)(
    'over %s sends JSON output without propertyNames and raises no warning',
    async (provider) => {
      const raised = captureWarnings()
      const { model, fetch } = openAiModel(provider, { tool: false })

      const result = await generateText({
        model,
        prompt: 'Which headers does the shop API send?',
        output: Output.object({ schema: jsonSchema<{ headers: Record<string, string> }>(headers) }),
        maxRetries: 0,
      })

      expect(result.output).toEqual({ headers: { accept: 'json' } })
      expect(String(fetch.mock.calls[0]![1]!.body)).not.toContain('propertyNames')
      expect(raised).toEqual([])
    },
  )
})
