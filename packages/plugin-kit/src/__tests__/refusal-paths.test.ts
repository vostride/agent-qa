import { describe, expect, it } from 'vitest'
import { definePlugin, z } from '../index.js'
import { startInProcessPlugin } from './in-process-plugin.js'

const session = { platform: 'web', engine: 'chromium', context: 'new' }

function strictPlugin() {
  return startInProcessPlugin(
    definePlugin({
      options: z.strictObject({ apiKey: z.string().min(1) }),
      settings: z.strictObject({ region: z.enum(['eu', 'us']).optional() }),
      serves: ['cdp'],
      acquire: () => ({ handle: { n: 1 }, protocol: 'cdp', url: 'ws://127.0.0.1:9/b' }),
      release: () => {},
    }),
  )
}

describe('refusals of options and settings that fail their schemas', () => {
  it('names an option by its options. path at initialize', async () => {
    const plugin = strictPlugin()

    const refused = await plugin.initialize({ apiKey: '' })

    expect(refused.error?.data).toEqual({ kind: 'refused', path: 'options.apiKey' })
    expect(refused.error?.message).toMatch(/^options\.apiKey: /)
    expect(await plugin.close()).toBe(0)
  })

  it('names a setting by its settings. path at acquire', async () => {
    const plugin = strictPlugin()
    await plugin.initialize({ apiKey: 'key' })

    const refused = await plugin.request('acquire', {
      remote: 'lab',
      settings: { region: 'mars' },
      session,
    })

    expect(refused.error?.data).toEqual({ kind: 'refused', path: 'settings.region' })
    expect(await plugin.close()).toBe(0)
  })

  it('gives no path when the fault is the block as a whole, such as an unknown key', async () => {
    const plugin = strictPlugin()
    await plugin.initialize({ apiKey: 'key' })

    const refused = await plugin.request('acquire', {
      remote: 'lab',
      settings: { zone: 'eu' },
      session,
    })

    expect(refused.error?.data).toEqual({ kind: 'refused' })
    expect(refused.error?.message).toMatch(/^settings: /)
    expect(await plugin.close()).toBe(0)
  })
})
