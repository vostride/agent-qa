import { afterEach, describe, expect, it } from 'vitest'
import { spawnScriptedPlugin, stopSpawnedPlugins } from './spawned-plugin.js'

const answer = { protocol: 'playwright', url: 'ws://127.0.0.1:9222/lab' }
const webSession = { platform: 'web', engine: 'chromium', context: 'new' }

afterEach(() => {
  stopSpawnedPlugins()
})

describe('a plugin built with the kit, spoken to over stdio', () => {
  it('answers initialize, acquire, release and shutdown, then exits when stdin closes', async () => {
    const plugin = spawnScriptedPlugin({
      packageName: '@acme/agent-qa-plugin-lab',
      version: '2.3.4',
    })

    const initialized = await plugin.initialize({ answer })
    expect(initialized.result).toEqual({
      protocolVersion: 1,
      plugin: { name: '@acme/agent-qa-plugin-lab', version: '2.3.4' },
      serves: ['playwright', 'cdp', 'appium'],
      methods: ['check', 'uploadApp', 'started', 'end'],
    })

    const acquired = await plugin.request('acquire', {
      remote: 'lab-chrome',
      settings: {},
      session: webSession,
    })
    expect(acquired.result).toEqual({ handle: { n: 1 }, ...answer })

    expect((await plugin.request('release', { handle: { n: 1 } })).result).toEqual({})
    expect((await plugin.request('shutdown', {})).result).toEqual({})
    expect(plugin.ledger()).toEqual([
      { method: 'initialize' },
      { method: 'acquire', handle: { n: 1 }, remote: 'lab-chrome' },
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])

    expect(await plugin.close()).toBe(0)
  })

  it('refuses a host that offers only protocol 2, naming the versions on both sides', async () => {
    const plugin = spawnScriptedPlugin()

    const refused = await plugin.initialize({ answer }, [2])

    expect(refused.error?.code).toBe(-32000)
    expect(refused.error?.data).toEqual({ kind: 'version', supported: [1], requested: [2] })
  })

  it('sends a handler failure as its first line with its kind and option path', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({
      answer,
      script: {
        acquire: {
          error: { kind: 'capacity', message: 'no browsers left\nsecond line', path: 'pool' },
        },
      },
    })

    const failed = await plugin.request('acquire', {
      remote: 'lab-chrome',
      settings: {},
      session: webSession,
    })

    expect(failed.error).toEqual({
      code: -32000,
      message: 'no browsers left',
      data: { kind: 'capacity', path: 'pool' },
    })
  })

  it('refuses options that fail its schema at initialize, naming the option', async () => {
    const plugin = spawnScriptedPlugin()

    const refused = await plugin.initialize({ ledgerFile: 5 })

    expect(refused.error?.code).toBe(-32000)
    expect(refused.error?.data).toEqual({ kind: 'refused', path: 'options.ledgerFile' })
    expect(refused.error?.message).not.toContain('\n')
  })
})
