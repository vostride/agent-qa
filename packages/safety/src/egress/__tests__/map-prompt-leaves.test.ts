import { describe, expect, it } from 'vitest'

import { mapPromptLeaves, type ProviderRequestParams } from '../map-prompt-leaves'

const identity = (text: string): string => text
const bang = (text: string): string => `${text}!`

function asParams(params: unknown): ProviderRequestParams {
  return params as ProviderRequestParams
}

class LeafBlockError extends Error {}

describe('mapPromptLeaves', () => {
  it('returns an equivalent tree for an identity fn across every part type', () => {
    const params = asParams({
      prompt: [
        { role: 'system', content: 'system prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'user text' },
            { type: 'file', filename: 'f.txt', data: 'string data', mediaType: 'text/plain' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'reasoning' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { q: 'x' } },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 'lookup',
              output: { type: 'content', value: [{ type: 'text', text: 'nested' }] },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c3',
              toolName: 'lookup',
              output: { type: 'json', value: { token: 'v' } },
            },
            {
              type: 'tool-approval-response',
              approvalId: 'a1',
              approved: false,
              reason: 'reason',
            },
          ],
        },
      ],
      temperature: 0.4,
    })

    expect(mapPromptLeaves(params, identity)).toEqual(params)
  })

  it('passes every in-scope string leaf through fn', () => {
    const params = asParams({
      prompt: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'txt' },
            { type: 'file', filename: 'name', data: 'body', mediaType: 'text/plain' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'lookup',
              output: { type: 'error-text', value: 'err' },
            },
          ],
        },
      ],
    })

    const out = mapPromptLeaves(params, bang)
    const sys = out.prompt[0]
    const user = out.prompt[1]
    const tool = out.prompt[2]

    expect(sys?.role === 'system' ? sys.content : undefined).toBe('sys!')
    if (user?.role !== 'user') throw new Error('expected user')
    const text = user.content[0]
    const file = user.content[1]
    expect(text?.type === 'text' ? text.text : undefined).toBe('txt!')
    expect(file?.type === 'file' ? file.filename : undefined).toBe('name!')
    if (tool?.role !== 'tool') throw new Error('expected tool')
    const result = tool.content[0]
    expect(
      result?.type === 'tool-result' && result.output.type === 'error-text'
        ? result.output.value
        : undefined,
    ).toBe('err!')
  })

  it('propagates a throw from fn on a JSON-shaped tool-call input leaf', () => {
    const params = asParams({
      prompt: [
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { q: 'secret' } },
          ],
        },
      ],
    })

    const throwOnJson = (text: string): string => {
      if (text.includes('secret')) throw new LeafBlockError('blocked')
      return text
    }

    expect(() => mapPromptLeaves(params, throwOnJson)).toThrow(LeafBlockError)
  })
})

const PW = 'pa"ss\\word'
const maskPw = (text: string): string => text.split(PW).join('[secret:PW]')

describe('masking tool-call inputs, tool results and text parts', () => {
  it('a value with a quote inside a tool-call input is masked', () => {
    const params = asParams({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'fill',
              input: { a: { b: [`x ${PW} y`] }, n: 3, t: true, z: null },
            },
          ],
        },
      ],
    })

    const out = mapPromptLeaves(params, maskPw)
    const part = out.prompt[0]?.role === 'assistant' ? out.prompt[0].content[0] : undefined

    expect(part?.type === 'tool-call' ? part.input : undefined).toEqual({
      a: { b: ['x [secret:PW] y'] },
      n: 3,
      t: true,
      z: null,
    })
  })

  it('a JSON tool result is walked leaf by leaf', () => {
    const value = { [PW]: { list: [`held ${PW}`, 7], deep: { text: PW } } }
    const params = asParams({
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'read',
              output: { type: 'json', value },
            },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 'read',
              output: { type: 'error-json', value },
            },
          ],
        },
      ],
    })

    const out = mapPromptLeaves(params, maskPw)
    const tool = out.prompt[0]
    if (tool?.role !== 'tool') throw new Error('expected tool')
    const expected = {
      '[secret:PW]': { list: ['held [secret:PW]', 7], deep: { text: '[secret:PW]' } },
    }
    for (const part of tool.content) {
      expect(part.type === 'tool-result' ? part.output : undefined).toMatchObject({
        value: expected,
      })
    }
  })

  it('binary and base64 data is never passed to the mask', () => {
    const fileData = 'ZmlsZSBkYXRh'
    const resultFileData = 'cmVzdWx0IGZpbGU='
    const imageData = 'aW1hZ2UgZGF0YQ=='
    const params = asParams({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'file', filename: `${PW}.txt`, data: fileData, mediaType: 'text/plain' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'screenshot',
              output: {
                type: 'content',
                value: [
                  {
                    type: 'file-data',
                    filename: `${PW}.pdf`,
                    data: resultFileData,
                    mediaType: 'application/pdf',
                  },
                  { type: 'image-data', data: imageData, mediaType: 'image/png' },
                ],
              },
            },
          ],
        },
      ],
    })
    const seen: string[] = []
    const spy = (text: string): string => {
      seen.push(text)
      return maskPw(text)
    }

    const out = mapPromptLeaves(params, spy)

    const user = out.prompt[0]
    if (user?.role !== 'user') throw new Error('expected user')
    expect(user.content[0]).toMatchObject({ filename: '[secret:PW].txt', data: fileData })
    const tool = out.prompt[1]
    if (tool?.role !== 'tool') throw new Error('expected tool')
    const result = tool.content[0]
    if (result?.type !== 'tool-result' || result.output.type !== 'content') {
      throw new Error('expected content output')
    }
    expect(result.output.value[0]).toMatchObject({
      filename: '[secret:PW].pdf',
      data: resultFileData,
    })
    expect(result.output.value[1]).toMatchObject({ data: imageData })
    expect(seen).not.toContain(fileData)
    expect(seen).not.toContain(resultFileData)
    expect(seen).not.toContain(imageData)
  })

  it('URLs and text parts are still masked', () => {
    const params = asParams({
      prompt: [
        { role: 'system', content: `system ${PW}` },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: `text ${PW}` },
            { type: 'reasoning', text: `reasoning ${PW}` },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'open',
              output: {
                type: 'content',
                value: [
                  { type: 'file-url', url: `https://x.test/${PW}` },
                  { type: 'image-url', url: `https://x.test/i/${PW}` },
                ],
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              toolName: 'open',
              output: { type: 'error-text', value: `error ${PW}` },
            },
            {
              type: 'tool-result',
              toolCallId: 'c3',
              toolName: 'open',
              output: { type: 'execution-denied', reason: `denied ${PW}` },
            },
          ],
        },
      ],
    })

    const wire = JSON.stringify(mapPromptLeaves(params, maskPw))

    for (const masked of [
      'system [secret:PW]',
      'text [secret:PW]',
      'reasoning [secret:PW]',
      'https://x.test/[secret:PW]',
      'https://x.test/i/[secret:PW]',
      'error [secret:PW]',
      'denied [secret:PW]',
    ]) {
      expect(wire).toContain(masked)
    }
    expect(wire).not.toContain('pa\\"ss')
  })
})

function toolCallParams(input: unknown): ProviderRequestParams {
  return asParams({
    prompt: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'fill', input }],
      },
    ],
  })
}

function jsonResultParams(value: unknown): ProviderRequestParams {
  return asParams({
    prompt: [
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'json', value } },
        ],
      },
    ],
  })
}

function sentToolCallInput(params: ProviderRequestParams): unknown {
  const message = params.prompt[0]
  const part = message?.role === 'assistant' ? message.content[0] : undefined
  if (part?.type !== 'tool-call') throw new Error('expected tool-call')
  return part.input
}

function sentJsonValue(params: ProviderRequestParams): Record<string, unknown> {
  const message = params.prompt[0]
  const part = message?.role === 'tool' ? message.content[0] : undefined
  if (part?.type !== 'tool-result' || part.output.type !== 'json') {
    throw new Error('expected json tool result')
  }
  return part.output.value as Record<string, unknown>
}

describe('masking object keys and JSON-shaped values', () => {
  it('object keys in a tool-call input and a JSON tool result are masked', () => {
    const input = sentToolCallInput(mapPromptLeaves(toolCallParams({ map: { [PW]: 1 } }), maskPw))
    expect(input).toEqual({ map: { '[secret:PW]': 1 } })

    const result = sentJsonValue(
      mapPromptLeaves(jsonResultParams({ localStorage: { [`session:${PW}`]: 'x' } }), maskPw),
    )
    expect(result).toEqual({ localStorage: { 'session:[secret:PW]': 'x' } })
  })

  it('an own __proto__ key survives as a key', () => {
    const value = JSON.parse('{"__proto__":{"note":"x"}}') as Record<string, unknown>
    value.note = `held ${PW}`

    const out = sentJsonValue(mapPromptLeaves(jsonResultParams(value), maskPw))

    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.stringify(out)).toBe('{"__proto__":{"note":"x"},"note":"held [secret:PW]"}')
  })

  it('a class instance and an object with toJSON are walked as the JSON a provider receives', () => {
    class Holder {
      text: string
      constructor(text: string) {
        this.text = text
      }
    }
    const custom = { toJSON: () => ({ token: PW }) }

    const out = sentJsonValue(
      mapPromptLeaves(jsonResultParams({ holder: new Holder(`held ${PW}`), custom }), maskPw),
    )

    expect(out).toEqual({
      holder: { text: 'held [secret:PW]' },
      custom: { token: '[secret:PW]' },
    })
  })

  it('binary data is returned untouched and never passed to the mask', () => {
    const bytes = new Uint8Array([104, 105])
    const seen: string[] = []
    const spy = (text: string): string => {
      seen.push(text)
      return maskPw(text)
    }

    const out = sentJsonValue(
      mapPromptLeaves(jsonResultParams({ bytes, buffer: bytes.buffer, label: PW }), spy),
    )

    expect(out.bytes).toBe(bytes)
    expect(out.buffer).toBe(bytes.buffer)
    expect(out.label).toBe('[secret:PW]')
    expect(seen).toEqual(['bytes', 'buffer', 'label', PW])
  })

  it('two keys that mask to one name refuse the request', () => {
    let error: unknown
    try {
      mapPromptLeaves(jsonResultParams({ [PW]: 1, '[secret:PW]': 2 }), maskPw)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('two keys of one object mask to the same name')
  })
})
