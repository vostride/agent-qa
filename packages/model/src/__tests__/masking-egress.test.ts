import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { MaskFn, ModelProfile } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { ResolvedModelAuth } from '../auth.js'
import type { ModelCallEvent } from '../provider-call-report.js'
import { createModel } from '../registry.js'
import { stubGenerateResult, stubModel } from './stub-model.js'

const noneAuth: ResolvedModelAuth = { kind: 'none' }

const baseModelProfile: ModelProfile = {
  provider: 'openai-compatible',
  model: 'override-model',
  baseURL: 'http://localhost:11434/v1',
  auth: { mode: 'none' },
}

describe('model egress applies the given mask and nothing else', () => {
  const declaredMask: MaskFn = (text) => text.replaceAll('q^7', '[secret:SHORT]')

  it('createModel masks a prompt with the mask it was given, after every other middleware', async () => {
    const seen: string[] = []
    const { captured, model } = createCapturingModel((text) => {
      seen.push(text)
      return declaredMask(text)
    })

    await model.doGenerate({
      prompt: [
        { role: 'system', content: '   ' },
        { role: 'user', content: [{ type: 'text', text: 'type q^7 now' }] },
      ],
    })

    expect(captured()?.prompt).toHaveLength(1)
    expect(capturedUserText(captured())).toBe('type [secret:SHORT] now')
    expect(seen).toEqual(['type q^7 now'])
  })

  it('a model built with the identity mask sends text unchanged', async () => {
    const { captured, model } = createCapturingModel((text) => text)

    await model.doGenerate(promptRequest('type q^7 now'))

    expect(capturedUserText(captured())).toBe('type q^7 now')
  })

  it('respondingModelId is masked with the injected mask', async () => {
    const events: ModelCallEvent[] = []
    const model = createModel({ ...baseModelProfile }, noneAuth, declaredMask, {
      providerReportOrigin: 'openai-chat',
      languageModels: {
        'override-model': stubModel({
          async doGenerate() {
            return { ...stubGenerateResult(), response: { modelId: 'model-q^7' } }
          },
        }),
      },
    }, { onCall: event => { events.push(event) } })

    await model.doGenerate(promptRequest('hello'))

    const success = events.find(event => event.kind === 'success')
    expect(success).toEqual({ kind: 'success', report: expect.objectContaining({
      respondingModelId: 'model-[secret:SHORT]',
    }) })
  })

  it('no detector blocks or redacts a model request', async () => {
    const nothingDeclared: MaskFn = (text) => text
    const credentialShaped =
      'card 4242 4242 4242 4242, Bearer abc123def456ghi789, AKIAIOSFODNN7EXAMPLE, qa@example.com'
    const request = promptRequest(credentialShaped)
    const seen: LanguageModelV3CallOptions[] = []
    const model = createModel({ ...baseModelProfile }, noneAuth, nothingDeclared, {
      languageModels: {
        'override-model': stubModel({
          async doGenerate(params) {
            seen.push(params)
            return stubGenerateResult()
          },
          async doStream(params) {
            seen.push(params)
            return { stream: streamOf([]) }
          },
        }),
      },
    })

    await model.doGenerate(request)
    const streamed = await model.doStream(request)
    await collectText(streamed.stream)

    expect(seen).toHaveLength(2)
    for (const params of seen) {
      expect(JSON.stringify(params.prompt)).toBe(JSON.stringify(request.prompt))
    }
  })

  it('a stream reaches the caller unscanned', async () => {
    const model = createModel({ ...baseModelProfile }, noneAuth, (text) => text, {
      languageModels: {
        'override-model': stubModel({
          async doStream() {
            return {
              stream: streamOf([
                { type: 'text-delta', id: 't1', delta: 'card 4242 4242 ' },
                { type: 'text-delta', id: 't1', delta: '4242 4242 end' },
              ]),
            }
          },
        }),
      },
    })

    const result = await model.doStream(promptRequest('hello'))

    expect(await collectText(result.stream)).toBe('card 4242 4242 4242 4242 end')
  })
})

function createCapturingModel(mask: MaskFn = (text) => text): {
  captured: () => LanguageModelV3CallOptions | undefined
  model: ReturnType<typeof createModel>
} {
  let captured: LanguageModelV3CallOptions | undefined
  const model = createModel({ ...baseModelProfile }, noneAuth, mask, {
    languageModels: {
      'override-model': stubModel({
        async doGenerate(params) {
          captured = params
          return stubGenerateResult()
        },
      }),
    },
  })

  return {
    captured: () => captured,
    model,
  }
}

function promptRequest(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    ],
  }
}

function capturedUserText(captured: LanguageModelV3CallOptions | undefined): string {
  expect(captured).toBeDefined()
  const message = captured?.prompt[0]
  expect(message?.role).toBe('user')
  if (message?.role !== 'user') throw new Error('expected captured user message')

  const part = message.content[0]
  expect(part?.type).toBe('text')
  if (part?.type !== 'text') throw new Error('expected captured text part')

  return part.text
}

function streamOf(deltas: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  const parts: LanguageModelV3StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...deltas,
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: stubGenerateResult().usage },
  ]
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collectText(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<string> {
  let text = ''
  for await (const part of stream) {
    if (part.type === 'text-delta') text += part.delta
  }
  return text
}
