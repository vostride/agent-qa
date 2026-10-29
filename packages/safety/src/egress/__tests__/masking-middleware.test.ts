import { wrapLanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import type { ProviderRequestParams } from '../map-prompt-leaves'
import { createMaskingMiddleware } from '../masking-middleware'

const upper = (text: string): string => text.toUpperCase()

function recorder(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    },
  })
}

describe('the middleware rewrites through the injected mask', () => {
  it('the middleware rewrites only through the injected function', async () => {
    const tools = [
      {
        type: 'function' as const,
        name: 'lookup',
        description: 'look up a value',
        inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } } },
      },
    ]
    const headers = { authorization: 'Bearer header-value' }
    const providerOptions = { openai: { user: 'provider-option-value' } }
    const params = {
      prompt: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: [{ type: 'text', text: 'user text' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'assistant text' }] },
      ],
      tools,
      headers,
      providerOptions,
    } as unknown as ProviderRequestParams

    const model = recorder()
    const wrapped = wrapLanguageModel({ model, middleware: createMaskingMiddleware(upper) })
    await wrapped.doGenerate(params)

    const sent = model.doGenerateCalls[0]!
    expect(sent.prompt).toEqual([
      { role: 'system', content: 'SYSTEM TEXT' },
      { role: 'user', content: [{ type: 'text', text: 'USER TEXT' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ASSISTANT TEXT' }] },
    ])
    expect(sent.tools).toEqual(tools)
    expect(sent.headers).toEqual(headers)
    expect(sent.providerOptions).toEqual(providerOptions)
  })
})

const stubMask = (text: string): string =>
  text
    .replaceAll('{{secret:X}}', '[secret:X]')
    .replaceAll('{{secret:Z}}', '[secret:other]')
    .replaceAll('raw-stand-in', '[secret:X]')

describe('templates the mask leaves alone are sent verbatim', () => {
  it('a template the mask names or leaves alone is sent verbatim, and the text around it is masked', async () => {
    const params = {
      prompt: [
        { role: 'system', content: 'use {{secret:X}} verbatim, never raw-stand-in' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'type {{secret:X}} then {{secret:Y}} or {{secret:Z}}; raw-stand-in' },
          ],
        },
      ],
    } as unknown as ProviderRequestParams

    const model = recorder()
    const wrapped = wrapLanguageModel({ model, middleware: createMaskingMiddleware(stubMask) })
    await wrapped.doGenerate(params)

    const sent = model.doGenerateCalls[0]!
    expect(sent.prompt).toEqual([
      { role: 'system', content: 'use {{secret:X}} verbatim, never [secret:X]' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'type {{secret:X}} then {{secret:Y}} or [secret:other]; [secret:X]' },
        ],
      },
    ])
    expect(JSON.stringify(sent.prompt)).not.toContain('raw-stand-in')
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Built like the record mask: one left-to-right alternation, the template form first, then the
// declared values longest first.
function alternationMask(declared: Record<string, string>): (text: string) => string {
  const nameByValue = new Map(Object.entries(declared).map(([name, value]) => [value, name]))
  const values = [...nameByValue.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const pattern = new RegExp([String.raw`\{\{secret:(\w+)\}\}`, ...values].join('|'), 'g')
  return (text) =>
    text.replace(pattern, (match: string, name: string | undefined) =>
      `[secret:${name ?? nameByValue.get(match)}]`)
}

describe('a declared value near a template is never sent raw', () => {
  it('a declared value against a template or inside its name is never sent raw, and a clean template still is', async () => {
    const mask = alternationMask({ PW: 'ab{', TAIL: '}tail9', PIN: '42', KEY_42: 'v-key-0417' })
    const params = {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ab{{secret:PW}}' },
            { type: 'text', text: '{{secret:PW}}tail9 end' },
            { type: 'text', text: 'use {{secret:KEY_42}} now' },
            { type: 'text', text: 'type {{secret:X}} now' },
          ],
        },
      ],
    } as unknown as ProviderRequestParams

    const model = recorder()
    const wrapped = wrapLanguageModel({ model, middleware: createMaskingMiddleware(mask) })
    await wrapped.doGenerate(params)

    const sent = model.doGenerateCalls[0]!
    const json = JSON.stringify(sent.prompt)
    expect(json).not.toContain('ab{')
    expect(json).not.toContain('}tail9')
    expect(json).not.toContain('{{secret:KEY_42}}')
    expect(json).not.toContain('v-key-0417')
    expect(sent.prompt).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[secret:PW]{secret:PW}}' },
          { type: 'text', text: '[secret:PW]tail9 end' },
          { type: 'text', text: 'use [secret:KEY_42] now' },
          { type: 'text', text: 'type {{secret:X}} now' },
        ],
      },
    ])
  })
})

describe('a declared value inside a template\'s own text is never sent', () => {
  async function sentLeaf(mask: (text: string) => string, text: string): Promise<string> {
    const model = recorder()
    const wrapped = wrapLanguageModel({ model, middleware: createMaskingMiddleware(mask) })
    await wrapped.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as unknown as ProviderRequestParams)
    const message = model.doGenerateCalls[0]!.prompt[0]!
    if (message.role !== 'user' || message.content[0]?.type !== 'text') {
      throw new Error('expected a text leaf')
    }
    return message.content[0].text
  }

  it('a declared value inside a template\'s own text is never sent, and the template is not restored', async () => {
    for (const [name, value] of [['B', '}'], ['B', '{{'], ['X', 'W}']] as const) {
      const mask = alternationMask({ PW: 'hunter2', [name]: value })
      const leaf = await sentLeaf(mask, 'type {{secret:PW}} now')
      expect(leaf, value).not.toContain('{{secret:PW}}')
      expect(leaf, value).not.toContain(value)
      expect(leaf, value).not.toContain('hunter2')
    }
  })

  it('with no declared value inside it, the template is still sent verbatim', async () => {
    expect(await sentLeaf(alternationMask({ PW: 'hunter2' }), 'type {{secret:PW}} now'))
      .toBe('type {{secret:PW}} now')
  })
})
