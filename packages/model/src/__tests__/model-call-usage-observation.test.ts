import { generateText } from 'ai'
import { APICallError } from '@ai-sdk/provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaskFn, ModelProfile } from '@vostride/agent-qa-schema'
import { createModel } from '../registry.js'
import { stubGenerateResult, stubModel } from './stub-model.js'
import type { ModelCallEvent, ModelCallReport, ModelCallReportOrigin } from '../index.js'

// A structural consumer lets RED exercise the existing invocation boundary without
// a missing-export/type/load failure standing in for the planned behavior.
type Event = { kind: ModelCallEvent['kind']; report?: ModelCallReport }
const transports = [
  'openai-compatible', 'openai-subscription', 'anthropic-compatible',
  'anthropic-subscription', 'gemini',
] as const
type Transport = typeof transports[number]
const declared = 'fixture-model'

function profile(provider: string): ModelProfile {
  return { provider, model: declared, baseURL: 'https://fixture.invalid/v1', auth: { mode: 'none' } }
}

function body(provider: Transport, cache?: number, model: string | undefined = 'reported-model') {
  if (provider.startsWith('anthropic')) return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 60, output_tokens: 7, cache_creation_input_tokens: 10,
      ...(cache === undefined ? {} : { cache_read_input_tokens: cache }) },
  }
  if (provider === 'gemini') return {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    modelVersion: model,
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7,
      ...(cache === undefined ? {} : { cachedContentTokenCount: cache }) },
  }
  if (provider === 'openai-subscription') return {
    id: 'resp_fixture', created_at: 1, model, object: 'response',
    output: [{ type: 'message', id: 'item_fixture', role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 7,
      ...(cache === undefined ? {} : { input_tokens_details: { cached_tokens: cache } }) },
  }
  return {
    id: 'chat_fixture', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 7,
      ...(cache === undefined ? {} : { prompt_tokens_details: { cached_tokens: cache } }) },
  }
}

function transportModel(provider: Transport, cache?: number, model?: string, mask: MaskFn = (text) => text) {
  const events: Event[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
    JSON.stringify(body(provider, cache, model)), { headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetch)
  const observation = { onCall: (event: Event) => events.push(event), onProviderCall: vi.fn() }
  const raw = createModel(profile(provider), provider.endsWith('subscription')
    ? { kind: 'auth-fetch', modelAdapter: provider.startsWith('openai')
      ? 'openai-responses' : 'anthropic-messages', fetch }
    : { kind: 'none' }, mask, {}, observation)
  return { raw, events, fetch, observation }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each(transports)('call observation over the %s transport', (provider) => {
  it.each([
    ['USAGE-RAW-ABSENT', undefined], ['USAGE-RAW-ZERO', 0], ['USAGE-RAW-NONZERO', 30],
  ] as const)('%s', async (_cell, cache) => {
    const { raw, events, fetch, observation } = transportModel(provider, cache)
    const result = await raw.doGenerate({ prompt: [] })
    expect(result.usage.inputTokens.cacheRead).toBe(cache ?? 0)
    expect(events.map(event => event.kind)).toEqual(['start', 'success'])
    expect(events[1]?.report).toEqual({ inputTokens: provider.startsWith('anthropic')
      ? 70 + (cache ?? 0) : 100, outputTokens: 7, respondingModelId: 'reported-model',
      ...(cache === undefined ? {} : { cachedInputTokens: cache }) })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(observation.onProviderCall.mock.calls).toEqual([[]])
  })

  it.each(['MODEL-REPORTED', 'MODEL-SAME-AS-DECLARED'])('%s', async (cell) => {
    const identity = cell === 'MODEL-REPORTED' ? 'routed-model' : declared
    const { raw, events } = transportModel(provider, 0, identity)
    await generateText({ model: raw, prompt: 'hello', maxRetries: 0 })
    expect(events[1]?.report?.respondingModelId).toBe(identity)
  })

  it('MODEL-SDK-FALLBACK never fills absent provider-result identity', async () => {
    const { raw } = transportModel(provider, 0)
    const result = await raw.doGenerate({ prompt: [] })
    // Reproduce a transport that preserves usage but omits response identity at the model
    // boundary. Some wire schemas require model even though the provider specification does not.
    result.response = undefined
    const origin = provider === 'openai-compatible' ? 'openai-chat'
      : provider === 'openai-subscription' ? 'openai-responses'
      : provider === 'gemini' ? 'gemini' : 'anthropic-messages'
    const observed = custom(result, origin)
    const generated = await generateText({ model: observed.model, prompt: 'hello', maxRetries: 0 })
    expect(generated.finalStep.response.modelId).toBe(declared)
    expect(observed.events[1]).toMatchObject({ kind: 'success', report: { cachedInputTokens: 0 } })
    expect(observed.events[1]).not.toHaveProperty('report.respondingModelId')
  })
})

it('MODEL-SDK-FALLBACK and CUSTOM-UNKNOWN reject normalized custom facts', async () => {
  const events: Event[] = []
  const result = stubGenerateResult([{ type: 'text', text: 'ok' }])
  result.usage.inputTokens.total = 100
  result.usage.outputTokens.total = 7
  const observation = { onProviderCall: vi.fn(), onCall: (event: Event) => events.push(event) }
  const raw = createModel(profile('openai-compatible'), { kind: 'none' }, (text) => text, {
    languageModels: { [declared]: stubModel({ modelId: declared, generate: async () => result }) },
  }, observation)
  const generated = await generateText({ model: raw, prompt: 'hello', maxRetries: 0 })
  expect(generated.finalStep.response.modelId).toBe(declared)
  expect(events).toEqual([{ kind: 'start' }, { kind: 'success', report: { inputTokens: 100, outputTokens: 7 } }])
})

function custom(result = stubGenerateResult(), origin?: ModelCallReportOrigin,
  onCall?: (event: ModelCallEvent) => void) {
  const events: ModelCallEvent[] = []
  const base = stubModel({ provider: 'openai.chat', modelId: declared, generate: async () => result })
  const model = createModel(profile('openai-compatible'), { kind: 'none' }, (text) => text, {
    languageModels: { [declared]: base }, providerReportOrigin: origin,
  }, { onCall: event => { events.push(event); onCall?.(event) } })
  return { base, model, events }
}

it('USAGE-RETRY-FAILURE records each failed attempt then success with one report', async () => {
  const { base, model, events } = custom()
  let attempts = 0
  base.doGenerate = async () => {
    if (++attempts === 1) throw new APICallError({ message: 'temporary',
      url: 'https://fixture.invalid', requestBodyValues: {}, statusCode: 503,
      responseHeaders: { 'retry-after-ms': '0' }, isRetryable: true })
    return stubGenerateResult()
  }
  await model.doGenerate({ prompt: [] })
  expect(attempts).toBe(2)
  expect(events.map(event => event.kind)).toEqual(['start', 'failure', 'start', 'success'])
  expect(events.filter(event => 'report' in event)).toHaveLength(1)
})

it('USAGE-RETRY-FAILURE clamp retry dispatches once for each attempted budget', async () => {
  const { base, model, events } = custom()
  const caps: (number | undefined)[] = []
  base.doGenerate = async params => {
    caps.push(params.maxOutputTokens)
    if (caps.length === 1) throw new APICallError({
      message: "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens",
      url: 'https://fixture.invalid', requestBodyValues: {}, statusCode: 400, isRetryable: false,
    })
    return stubGenerateResult()
  }
  await expect(model.doGenerate({ prompt: [], maxOutputTokens: 40000 })).rejects.toBeInstanceOf(APICallError)
  await model.doGenerate({ prompt: [], maxOutputTokens: 1000 })
  expect(caps).toEqual([40000, 1000])
  expect(events.map(event => event.kind)).toEqual(['start', 'failure', 'start', 'success'])
})

it.each(transports)('INPUT-DENOMINATOR %s remains inclusive on the same call', async provider => {
  const { raw, events } = transportModel(provider, 30)
  const result = await raw.doGenerate({ prompt: [] })
  expect(result.usage.inputTokens.total).toBe(100)
  expect(events[1]?.report).toMatchObject({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 30 })
  expect(events[1]?.report).not.toHaveProperty('cacheWriteTokens')
})

it.each([undefined, null, -1, 1.5, NaN, Infinity, '3'])('USAGE-MALFORMED raw cache %s stays absent', async cache => {
  const result = stubGenerateResult()
  // JSON-null and deliberately malformed custom provider values are untrusted input.
  result.usage.raw = { prompt_tokens_details: { cached_tokens: cache } }
  result.usage.inputTokens.cacheRead = 0
  const { model, events } = custom(result, 'openai-chat')
  await model.doGenerate({ prompt: [] })
  expect(events[1]).toEqual({ kind: 'success', report: { inputTokens: 0, outputTokens: 0 } })
})

it('CUSTOM-UNKNOWN ignores spoofed provider names and model/usage metadata without trusted origin', async () => {
  const result = stubGenerateResult()
  result.response = { modelId: declared }
  result.usage.raw = { prompt_tokens_details: { cached_tokens: 30 } }
  const unknown = custom(result)
  await unknown.model.doGenerate({ prompt: [] })
  expect(unknown.events[1]).toEqual({ kind: 'success', report: { inputTokens: 0, outputTokens: 0 } })
  const trusted = custom(result, 'openai-chat')
  await trusted.model.doGenerate({ prompt: [] })
  expect(trusted.events[1]).toEqual({ kind: 'success', report: {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 30, respondingModelId: declared,
  } })
})

it.each(['openai-responses', 'anthropic-messages'] as const)(
  'MODEL-SDK-FALLBACK subscription %s missing usage/model stays absent', async origin => {
    const result = stubGenerateResult([{ type: 'text', text: 'ok' }])
    result.usage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined } }
    const { model, events } = custom(result, origin)
    const generated = await generateText({ model, prompt: 'hello', maxRetries: 0 })
    expect(generated.finalStep.response.modelId).toBe(declared)
    expect(events[1]).toEqual({ kind: 'success', report: {} })
  },
)

it('OBSERVER-NONINTERFERENCE preserves successful result and original failure for throwing callbacks', async () => {
  const result = stubGenerateResult([{ type: 'text', text: 'ok' }])
  const { base, model, events } = custom(result, undefined, () => { throw new Error('observer') })
  expect(await model.doGenerate({ prompt: [] })).toEqual(result)
  const failure = new Error('original provider failure')
  base.doGenerate = () => { throw failure }
  await expect(model.doGenerate({ prompt: [] })).rejects.toBe(failure)
  expect(events.map(event => event.kind)).toEqual(['start', 'success', 'start', 'failure'])
  expect(JSON.stringify(events)).not.toContain('original provider failure')
})

it('OBSERVER-NONINTERFERENCE stream dispatch failure emits failure and preserves error', async () => {
  const { base, model, events } = custom()
  const failure = new Error('original stream failure')
  base.doStream = () => { throw failure }
  await expect(model.doStream({ prompt: [] })).rejects.toBe(failure)
  expect(events).toEqual([{ kind: 'start' }, { kind: 'failure' }])
})

it('OBSERVER-NONINTERFERENCE stream success preserves chunks and reports completed usage', async () => {
  const { base, model, events } = custom(undefined, 'openai-chat', () => { throw new Error('observer') })
  const usage = stubGenerateResult().usage
  usage.raw = { prompt_tokens_details: { cached_tokens: 0 } }
  const chunks = [
    { type: 'response-metadata' as const, modelId: declared },
    { type: 'text-start' as const, id: 'text' },
    { type: 'text-delta' as const, id: 'text', delta: 'ok' },
    { type: 'text-end' as const, id: 'text' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
  ]
  base.doStream = async () => ({ stream: new ReadableStream({ start(controller) {
    chunks.forEach(chunk => controller.enqueue(chunk)); controller.close()
  } }) })
  const result = await model.doStream({ prompt: [] })
  const received = []
  for await (const chunk of result.stream) received.push(chunk)
  expect(received).toEqual(chunks)
  expect(events).toEqual([{ kind: 'start' }, { kind: 'success', report: {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, respondingModelId: declared,
  } }])
})

it('MODEL-REPORTED crosses the live masking context before observation', async () => {
  const mask: MaskFn = (text) => text.replaceAll('private-model-name', '[secret:MODEL_NAME]')
  const { raw, events } = transportModel('openai-compatible', 0, 'private-model-name', mask)
  await raw.doGenerate({ prompt: [] })
  expect(events[1]?.report?.respondingModelId).toBe('[secret:MODEL_NAME]')
  expect(JSON.stringify(events)).not.toContain('private-model-name')
})
