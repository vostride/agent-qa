import { describe, expect, it } from 'vitest'
import { definePlugin, z, type PluginSpec } from '../index.js'
import { startInProcessPlugin } from './in-process-plugin.js'

const session = { platform: 'web', engine: 'chromium', context: 'new' }
const acquireParams = { remote: 'lab', settings: {}, session }

type Spec = PluginSpec<z.ZodObject, z.ZodObject>

function pluginWith(handlers: Partial<Spec>) {
  return startInProcessPlugin(
    definePlugin({
      options: z.object({}),
      settings: z.object({}),
      serves: ['cdp'],
      acquire: () => ({ handle: { n: 1 }, protocol: 'cdp', url: 'ws://127.0.0.1:9/b' }),
      release: () => {},
      ...handlers,
    }),
  )
}

describe('handler results', () => {
  it('refuses a check that answers nothing, instead of sending a reply with no result', async () => {
    const plugin = pluginWith({ check: (() => undefined) as unknown as Spec['check'] })
    await plugin.initialize()

    const answered = await plugin.request('check', { remotes: [] })

    expect(answered.error?.code).toBe(-32000)
    expect(answered.error?.data).toEqual({ kind: 'refused' })
    expect(answered.error?.message).toMatch(/^check answered a malformed result: /)
    expect(await plugin.close()).toBe(0)
  })

  it('refuses a malformed acquire result at its field and keeps its handle for release', async () => {
    const released: unknown[] = []
    const plugin = pluginWith({
      acquire: (() => ({
        handle: { n: 7 },
        protocol: 'telnet',
        url: 'ws://127.0.0.1:9/b',
      })) as unknown as Spec['acquire'],
      release: ({ handle }) => {
        released.push(handle)
      },
    })
    await plugin.initialize()

    const answered = await plugin.request('acquire', acquireParams)

    expect(answered.error?.data).toEqual({ kind: 'refused', handle: { n: 7 } })
    expect(answered.error?.message).toMatch(/^acquire answered a malformed result at protocol: /)
    expect(await plugin.close()).toBe(0)
    expect(released).toEqual([{ n: 7 }])
  })

  it('refuses an uploadApp answer without a ref and a started answer that is not an object', async () => {
    const plugin = pluginWith({
      uploadApp: (() => ({})) as unknown as Spec['uploadApp'],
      started: (() => 'linked') as unknown as Spec['started'],
    })
    await plugin.initialize()

    const uploaded = await plugin.request('uploadApp', {
      remote: 'lab',
      settings: {},
      platform: 'android',
      path: '/tmp/app.apk',
      sha256: 'ab'.repeat(32),
      size: 1,
    })
    const started = await plugin.request('started', { handle: { n: 1 } })

    expect(uploaded.error?.message).toMatch(/^uploadApp answered a malformed result at ref: /)
    expect(started.error?.message).toMatch(/^started answered a malformed result: /)
    expect(await plugin.close()).toBe(0)
  })

  it('answers well-formed results as the handler returned them', async () => {
    const plugin = pluginWith({
      check: () => ({ state: 'warn', lines: ['one pool missing'] }),
      started: () => ({ link: 'https://lab.example/s/1' }),
    })
    await plugin.initialize()

    expect((await plugin.request('check', { remotes: [] })).result).toEqual({
      state: 'warn',
      lines: ['one pool missing'],
    })
    expect((await plugin.request('acquire', acquireParams)).result).toEqual({
      handle: { n: 1 },
      protocol: 'cdp',
      url: 'ws://127.0.0.1:9/b',
    })
    expect((await plugin.request('started', { handle: { n: 1 } })).result).toEqual({
      link: 'https://lab.example/s/1',
    })
    expect(await plugin.close()).toBe(0)
  })
})
