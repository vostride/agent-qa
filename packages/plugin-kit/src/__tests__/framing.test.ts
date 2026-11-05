import { afterEach, describe, expect, it } from 'vitest'
import { createLineDecoder, encodeMessage, MAX_MESSAGE_BYTES } from '../protocol/index.js'
import { spawnScriptedPlugin, stopSpawnedPlugins } from './spawned-plugin.js'

const answer = { protocol: 'playwright', url: 'ws://127.0.0.1:9222/lab' }

afterEach(() => {
  stopSpawnedPlugins()
})

function decode(maxLineBytes: number) {
  const lines: string[] = []
  let overflows = 0
  const decoder = createLineDecoder({
    maxLineBytes,
    onLine: (line) => lines.push(line),
    onOverflow: () => {
      overflows += 1
    },
  })
  return { decoder, lines, overflows: () => overflows }
}

describe('the line decoder', () => {
  it('joins a line split across two chunks into one message', () => {
    const { decoder, lines } = decode(1024)
    const encoded = new TextEncoder().encode(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'é' }))

    decoder.push(encoded.subarray(0, 30))
    expect(lines).toEqual([])
    decoder.push(encoded.subarray(30))

    expect(lines.map((line) => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'é' }])
  })

  it('splits two messages in one chunk into two', () => {
    const { decoder, lines } = decode(1024)

    decoder.push(`${encodeMessage({ id: 1 })}${encodeMessage({ id: 2 })}`)

    expect(lines).toEqual(['{"id":1}', '{"id":2}'])
  })

  it('discards a line over the limit, reports it once and keeps decoding', () => {
    const { decoder, lines, overflows } = decode(16)

    decoder.push(`{"id":1,"pad":"${'x'.repeat(10)}`)
    decoder.push(`${'x'.repeat(40)}"}\n{"id":2}\n`)

    expect(overflows()).toBe(1)
    expect(lines).toEqual(['{"id":2}'])
  })
})

describe('the stdio loop refuses what is not protocol', () => {
  it('answers a line over the message limit with an invalid request and keeps reading', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })

    plugin.writeRaw(`${'x'.repeat(MAX_MESSAGE_BYTES + 10)}\n`)
    const released = await plugin.request('release', { handle: { n: 1 } })

    expect(released.result).toEqual({})
    expect(plugin.takeUnaddressed()).toEqual([
      { jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32600 }) },
    ])
  })

  it('answers a request that carries an unknown field and ignores an unknown notification', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })

    plugin.writeRaw(encodeMessage({ jsonrpc: '2.0', method: 'agent-qa/unknown', params: {} }))
    const acquired = await plugin.request('acquire', {
      remote: 'lab-chrome',
      settings: {},
      session: { platform: 'web', engine: 'chromium', context: 'new' },
      futureField: { anything: true },
    })

    expect(acquired.result).toEqual({ handle: { n: 1 }, ...answer })
    expect(plugin.takeUnaddressed()).toEqual([])
  })

  it('answers a declared-optional method the plugin does not implement with method not found', async () => {
    const plugin = spawnScriptedPlugin({ methods: [] })
    await plugin.initialize({ answer })

    const checked = await plugin.request('check', { remotes: [] })

    expect(checked.error?.code).toBe(-32601)
  })

  it('answers acquire for an unknown platform with invalid params', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })

    const acquired = await plugin.request('acquire', {
      remote: 'lab-chrome',
      settings: {},
      session: { platform: 'tv' },
    })

    expect(acquired.error?.code).toBe(-32602)
  })

  it('answers a line that is not JSON with a parse error and a null id', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })

    plugin.writeRaw('not json\n')
    const released = await plugin.request('release', { handle: { n: 1 } })

    expect(released.result).toEqual({})
    expect(plugin.takeUnaddressed()).toEqual([
      { jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32700 }) },
    ])
  })
})
