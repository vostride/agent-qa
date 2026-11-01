import { APICallError, type LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ModelProfile, ModelProviderId } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { ResolvedModelAuth } from '../auth.js'
import { createModel } from '../registry.js'
import { stubGenerateResult, stubModel } from './stub-model.js'

const noneAuth: ResolvedModelAuth = { kind: 'none' }

function profile(provider: ModelProviderId): ModelProfile {
  return {
    provider,
    model: 'override-model',
    ...(provider === 'openai-compatible' ? { baseURL: 'http://localhost:11434/v1' } : {}),
    auth: { mode: 'none' },
  }
}

function stackModel(onGenerate: (params: LanguageModelV4CallOptions) => void) {
  return stubModel({
    async doGenerate(params) {
      onGenerate(params)
      return stubGenerateResult([
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'click',
          input: '{"ref":"#x"',
        },
      ])
    },
  })
}

function createOverrideModel(provider: ModelProviderId, fake = stackModel(() => {})) {
  return createModel(profile(provider), noneAuth, (text) => text, {
    languageModels: {
      'override-model': fake,
    },
  })
}

function clickTool() {
  return {
    type: 'function' as const,
    name: 'click',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        ref: { type: 'string' },
      },
    },
  }
}

describe('registry middleware stack', () => {
  it('applies request and response reliability middleware through createModel', async () => {
    let captured: LanguageModelV4CallOptions | undefined
    const model = createOverrideModel(
      'openai-compatible',
      stackModel((params) => {
        captured = params
      }),
    )

    const result = await model.doGenerate({
      prompt: [],
      tools: [clickTool()],
    })

    const transformedTool = captured?.tools?.[0]
    expect(transformedTool?.type).toBe('function')
    if (!transformedTool || transformedTool.type !== 'function') {
      throw new Error('Expected transformed function tool')
    }

    expect(transformedTool.inputSchema).not.toHaveProperty('$schema')
    expect(transformedTool.inputSchema).toMatchObject({
      type: 'object',
      properties: { ref: { type: 'string' } },
    })
    expect(transformedTool.description).toContain('Input Examples:')

    const content = result.content[0]
    expect(content.type).toBe('tool-call')
    if (content.type !== 'tool-call') throw new Error('Expected tool-call content')
    expect(JSON.parse(content.input)).toEqual({ ref: '#x' })
  })

  it('applies the same response stack for a second provider', async () => {
    const model = createOverrideModel('gemini')

    const result = await model.doGenerate({
      prompt: [],
      tools: [clickTool()],
    })

    const content = result.content[0]
    expect(content.type).toBe('tool-call')
    if (content.type !== 'tool-call') throw new Error('Expected tool-call content')
    expect(JSON.parse(content.input)).toEqual({ ref: '#x' })
  })

  it('does not retry non-retryable overflow errors through the composed stack', async () => {
    let calls = 0
    const overflow = new APICallError({
      message: 'overflow',
      url: 'http://localhost/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: '',
      isRetryable: false,
    })
    const model = createOverrideModel(
      'openai-compatible',
      stubModel({
        async doGenerate() {
          calls += 1
          throw overflow
        },
      }),
    )

    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(overflow)

    expect(calls).toBe(1)
  })
})
