// The captured provider boundary of a run-shaped createModel. 2026-10-15 (441-30,
// D-12/D-15): the stamped-audit integration proof is deleted with the per-run hook registrar.

import {
  SecretRedactor,
  SecretStore,
  buildSystemPrompt,
  literalSecretMarkerRefusal,
} from '@vostride/agent-qa-runner'
import { createModel } from '@vostride/agent-qa-model'
import type { ResolvedModelAuth } from '@vostride/agent-qa-model'
import { describe, expect, it } from 'vitest'

// Derive the AI-SDK shapes from `createModel` itself — the CLI package declares neither
// @ai-sdk/provider nor @vostride/agent-qa-schema, and this proof needs neither.
type StubLanguageModel = ReturnType<typeof createModel>
type CapturedCallOptions = Parameters<StubLanguageModel['doGenerate']>[0]
type StubGenerateResult = Awaited<ReturnType<StubLanguageModel['doGenerate']>>

const noneAuth: ResolvedModelAuth = { kind: 'none' }

const fileSecret = 'file-secret-passphrase-alpha'
const envSecret = 'env-token-passphrase-bravo'
const cookieSecret = 'cookie-session-passphrase-charlie'

function stubGenerateResult(): StubGenerateResult {
  return {
    content: [],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  }
}

function createCapturingModel(mask: (text: string) => string): {
  captured: () => CapturedCallOptions | undefined
  model: StubLanguageModel
} {
  let captured: CapturedCallOptions | undefined
  const stub: StubLanguageModel = {
    specificationVersion: 'v3',
    provider: 'stub',
    modelId: 'stub',
    supportedUrls: {},
    async doGenerate(params) {
      captured = params
      return stubGenerateResult()
    },
    async doStream() {
      return { stream: new ReadableStream() }
    },
  }
  const model = createModel(
    {
      provider: 'openai-compatible',
      model: 'override-model',
      baseURL: 'http://localhost:11434/v1',
      auth: { mode: 'none' },
    },
    noneAuth,
    mask,
    { languageModels: { 'override-model': stub } },
  )
  return { captured: () => captured, model }
}

function promptRequest(text: string): CapturedCallOptions {
  return {
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    ],
  }
}

function capturedUserText(captured: CapturedCallOptions | undefined): string {
  expect(captured).toBeDefined()
  const message = captured?.prompt[0]
  expect(message?.role).toBe('user')
  if (message?.role !== 'user') throw new Error('expected captured user message')

  const part = message.content[0]
  expect(part?.type).toBe('text')
  if (part?.type !== 'text') throw new Error('expected captured text part')

  return part.text
}

describe('a run-shaped model masks declared values', () => {
  it('a run-shaped model masks the declared value and nothing else', async () => {
    const redactor = new SecretRedactor(
      SecretStore.fromEnvContent(`MY_SERVICE_SECRET=${fileSecret}`),
    )
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

    await model.doGenerate(
      promptRequest(`file=${fileSecret} env=${envSecret} cookie=${cookieSecret}`),
    )

    expect(capturedUserText(captured())).toBe(
      `file=[secret:MY_SERVICE_SECRET] env=${envSecret} cookie=${cookieSecret}`,
    )
    expect(JSON.stringify(captured())).not.toContain(fileSecret)
  })
})

type CapturedPrompt = CapturedCallOptions['prompt']

function conversationRequest(input: {
  system: string
  user: string
  toolCallInput: Record<string, unknown>
  toolErrorText: string
}): CapturedCallOptions {
  const prompt: CapturedPrompt = [
    { role: 'system', content: input.system },
    { role: 'user', content: [{ type: 'text', text: input.user }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'fill', input: input.toolCallInput },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'fill',
          output: { type: 'error-text', value: input.toolErrorText },
        },
      ],
    },
  ]
  return { prompt }
}

function capturedSystemText(captured: CapturedCallOptions | undefined): string {
  const message = captured?.prompt.find((entry) => entry.role === 'system')
  if (message?.role !== 'system') throw new Error('expected captured system message')
  return message.content
}

function capturedToolErrorText(captured: CapturedCallOptions | undefined): string {
  const message = captured?.prompt.find((entry) => entry.role === 'tool')
  if (message?.role !== 'tool') throw new Error('expected captured tool message')
  const part = message.content[0]
  if (part?.type !== 'tool-result' || part.output.type !== 'error-text') {
    throw new Error('expected captured error-text tool result')
  }
  return part.output.value
}

function capturedUserTextIn(captured: CapturedCallOptions | undefined): string {
  const message = captured?.prompt.find((entry) => entry.role === 'user')
  if (message?.role !== 'user') throw new Error('expected captured user message')
  const part = message.content[0]
  if (part?.type !== 'text') throw new Error('expected captured text part')
  return part.text
}

describe('declared values in markers, templates and object keys', () => {
  it('Rule 23, the literal-marker refusal and step text reach the model with the template intact', async () => {
    const value = 'hunter2-gap-61'
    const redactor = new SecretRedactor(SecretStore.fromEnvContent(`PW=${value}`))
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))
    const system = buildSystemPrompt()
    const refusal = literalSecretMarkerRefusal({ text: '[secret:PW]' })
    expect(refusal).toBeDefined()

    await model.doGenerate(
      conversationRequest({
        system,
        user: `Type {{secret:PW}} into the field; the old code was ${value}`,
        toolCallInput: { text: '[secret:PW]' },
        toolErrorText: refusal!,
      }),
    )

    expect(capturedSystemText(captured())).toBe(system)
    expect(capturedSystemText(captured())).toContain('use {{secret:NAME}} verbatim')
    expect(capturedUserTextIn(captured())).toBe(
      'Type {{secret:PW}} into the field; the old code was [secret:PW]',
    )
    expect(capturedToolErrorText(captured()).endsWith('Use {{secret:PW}} to type the secret.')).toBe(
      true,
    )
    expect(JSON.stringify(captured())).not.toContain(value)
  })

  it('a declared value hidden in a marker or template never reaches the model', async () => {
    const redactor = new SecretRedactor(SecretStore.fromEnvContent('PW=hunter2'))
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

    await model.doGenerate(
      promptRequest('use {{secret:hunter2}} or [secret:hunter2] or {{secret:PW}}'),
    )

    expect(capturedUserText(captured())).toContain('{{secret:PW}}')
    expect(JSON.stringify(captured())).not.toContain('hunter2')
  })

  it('a declared value used as an object key never reaches the model', async () => {
    const value = 'qa-admin-42'
    const redactor = new SecretRedactor(SecretStore.fromEnvContent(`USER=${value}`))
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

    await model.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'fill',
              input: { map: { [value]: 1 } },
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(captured())).toContain('"[secret:USER]":1')
    expect(JSON.stringify(captured())).not.toContain(value)

    await model.doGenerate({
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'read',
              output: { type: 'json', value: { localStorage: { [`session:${value}`]: 'x' } } },
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(captured())).toContain('"session:[secret:USER]":"x"')
    expect(JSON.stringify(captured())).not.toContain(value)
  })
})

describe('declared values against template braces', () => {
  it('a declared value against a template brace is never sent raw', async () => {
    const redactor = new SecretRedactor(new SecretStore({ PW: 'ab{', TAIL: '}tail9' }))
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

    await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ab{{secret:PW}}' },
            { type: 'text', text: '{{secret:PW}}tail9 end' },
          ],
        },
      ],
    })

    expect(JSON.stringify(captured())).not.toContain('ab{')
    expect(JSON.stringify(captured())).not.toContain('}tail9')
  })

  it('a template whose name holds a declared value is not sent verbatim', async () => {
    const redactor = new SecretRedactor(new SecretStore({ PIN: '42', KEY_42: 'v-key-0417' }))
    const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

    await model.doGenerate(promptRequest('use {{secret:KEY_42}} now'))

    expect(capturedUserText(captured())).toBe('use [secret:KEY_42] now')
    expect(JSON.stringify(captured())).not.toContain('{{secret:KEY_42}}')
    expect(JSON.stringify(captured())).not.toContain('v-key-0417')
  })
})

describe('declared brace values inside templates', () => {
  it('a declared brace value inside a template never reaches the provider', async () => {
    for (const [name, value] of [['B', '}'], ['B', '{{'], ['X', 'W}']] as const) {
      const redactor = new SecretRedactor(new SecretStore({ PW: 'hunter2', [name]: value }))
      const { captured, model } = createCapturingModel((text) => redactor.redactString(text))

      await model.doGenerate(promptRequest('type {{secret:PW}} now'))

      const text = capturedUserText(captured())
      expect(text, value).not.toContain('{{secret:PW}}')
      expect(text, value).not.toContain(value)
      expect(JSON.stringify(captured()), value).not.toContain('hunter2')
      if (value === 'W}') expect(JSON.stringify(captured())).not.toContain(value)
    }
  })
})
