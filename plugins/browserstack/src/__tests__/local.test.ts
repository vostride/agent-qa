import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PluginError, type PluginCallContext } from '@vostride/agent-qa-plugin-kit'
import { afterEach, describe, expect, it } from 'vitest'
import type { TunnelFactory, TunnelRequest } from '../local.js'
import { createBrowserStackPlugin } from '../plugin.js'
import { BROWSERSTACK_PLAYWRIGHT_VERSIONS } from '../playwright-versions.js'
import {
  ACCESS_KEY,
  initializePlugin,
  RUN_ID,
  startPluginProcess,
  TEST_NAME,
  USERNAME,
  type PluginProcess,
} from './plugin-process.js'

const LISTED = `${BROWSERSTACK_PLAYWRIGHT_VERSIONS[BROWSERSTACK_PLAYWRIGHT_VERSIONS.length - 1]}.0`
const FRESH_IDENTIFIER = /^agent-qa-[0-9a-f]{16}$/

interface FakeFactory extends TunnelFactory {
  starts: TunnelRequest[]
  stops: number
}

function fakeFactory(input: { fail?: Error; startMs?: number } = {}): FakeFactory {
  const factory: FakeFactory = {
    starts: [],
    stops: 0,
    async start(request) {
      factory.starts.push(request)
      if (input.startMs !== undefined) await new Promise((r) => setTimeout(r, input.startMs))
      if (input.fail !== undefined) throw input.fail
      return {
        async stop() {
          factory.stops += 1
        },
      }
    },
  }
  return factory
}

function context(signal = new AbortController().signal): PluginCallContext & {
  messages: string[]
} {
  const messages: string[] = []
  return {
    signal,
    progress: (update) => messages.push(update.message),
    runFacts: { runId: RUN_ID },
    messages,
  }
}

async function browserStack(factory: TunnelFactory, options: Record<string, unknown> = {}) {
  const plugin = createBrowserStackPlugin({ tunnelFactory: factory })
  const parsed = plugin.options.parse({ username: USERNAME, accessKey: ACCESS_KEY, ...options })
  await plugin.initialize?.(
    {
      options: parsed,
      host: {
        pid: process.pid,
        agentQaVersion: '0.0.0',
        playwrightVersion: LISTED,
        webdriverioVersion: 'unknown',
      },
      entry: 'browserstack',
      runFacts: { runId: RUN_ID },
    },
    context(),
  )
  const settings = plugin.settings.parse({})
  return {
    plugin,
    web: async (ctx = context()) =>
      plugin.acquire(
        {
          remote: 'browserstack',
          settings,
          options: parsed,
          session: { platform: 'web', engine: 'chromium', context: 'new' },
          run: { testName: TEST_NAME },
        },
        ctx,
      ),
    device: async (ctx = context()) =>
      plugin.acquire(
        {
          remote: 'browserstack-devices',
          settings,
          options: parsed,
          session: {
            platform: 'android',
            capabilities: { 'appium:deviceName': 'Google Pixel 9' },
          },
          run: { testName: TEST_NAME },
        },
        ctx,
      ),
    shutdown: async () => plugin.shutdown?.({ options: parsed }, context()),
  }
}

function capsOf(url: string): Record<string, unknown> {
  return JSON.parse(new URL(url).searchParams.get('caps') ?? '{}') as Record<string, unknown>
}

function bstackOptions(answer: { capabilities?: Record<string, unknown> }) {
  return answer.capabilities?.['bstack:options'] as Record<string, unknown>
}

describe('BrowserStack Local started by the plugin', () => {
  it('starts one tunnel for the run with a fresh identifier, however many acquires ask', async () => {
    const factory = fakeFactory({ startMs: 20 })
    const { web, device } = await browserStack(factory, { local: true })

    const first = context()
    await Promise.all([web(first), device()])
    await web()

    expect(factory.starts).toHaveLength(1)
    expect(factory.starts[0]?.identifier).toMatch(FRESH_IDENTIFIER)
    expect(factory.starts[0]?.accessKey).toBe(ACCESS_KEY)
    expect(factory.starts[0]?.binary).toBeUndefined()
    expect(first.messages).toEqual(['starting BrowserStack Local'])
  })

  it('gives each plugin process its own identifier', async () => {
    const one = fakeFactory()
    const two = fakeFactory()
    await (await browserStack(one, { local: true })).web()
    await (await browserStack(two, { local: true })).web()

    expect(one.starts[0]?.identifier).not.toBe(two.starts[0]?.identifier)
  })

  it('asks for the tunnel in the web capabilities and the device bstack:options', async () => {
    const factory = fakeFactory()
    const { web, device } = await browserStack(factory, { local: true })

    const webAnswer = await web()
    const deviceAnswer = await device()
    const identifier = factory.starts[0]?.identifier

    expect(capsOf(webAnswer.url)).toMatchObject({
      'browserstack.local': true,
      'browserstack.localIdentifier': identifier,
    })
    expect(bstackOptions(deviceAnswer)).toMatchObject({ local: true, localIdentifier: identifier })
  })

  it('names the tunnel with localIdentifier and runs the localBinary when local is on', async () => {
    const factory = fakeFactory()
    const { web } = await browserStack(factory, {
      local: true,
      localIdentifier: 'team-tunnel',
      localBinary: '/opt/BrowserStackLocal',
    })

    const answer = await web()

    expect(factory.starts).toEqual([
      { accessKey: ACCESS_KEY, identifier: 'team-tunnel', binary: '/opt/BrowserStackLocal' },
    ])
    expect(capsOf(answer.url)['browserstack.localIdentifier']).toBe('team-tunnel')
  })

  it('stops the tunnel once on shutdown, however often shutdown runs', async () => {
    const factory = fakeFactory()
    const { web, shutdown } = await browserStack(factory, { local: true })
    await web()

    await shutdown()
    await shutdown()

    expect(factory.stops).toBe(1)
  })

  it('stops a tunnel that was still starting when shutdown came', async () => {
    const factory = fakeFactory({ startMs: 50 })
    const { web, shutdown } = await browserStack(factory, { local: true })
    const acquiring = web()

    await shutdown()
    await acquiring

    expect(factory.stops).toBe(1)
  })

  it('stops nothing on shutdown when no acquire asked for the tunnel', async () => {
    const factory = fakeFactory()
    const { shutdown } = await browserStack(factory, { local: true })

    await shutdown()

    expect(factory.starts).toEqual([])
    expect(factory.stops).toBe(0)
  })

  it('refuses the acquire with kind unreachable naming the tunnel when the start fails, and tries again on the next', async () => {
    const factory = fakeFactory({ fail: new Error(`binary exited; key ${ACCESS_KEY} refused`) })
    const { web } = await browserStack(factory, { local: true })

    const refusal = await web().catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(PluginError)
    expect(refusal).toMatchObject({ kind: 'unreachable', path: 'local' })
    expect((refusal as Error).message).toBe(
      'BrowserStack Local did not start: binary exited; key *** refused',
    )
    await web().catch(() => {})
    expect(factory.starts).toHaveLength(2)
  })

  it('gives up waiting when the acquire is cancelled while the tunnel starts', async () => {
    const factory = fakeFactory({ startMs: 200 })
    const { web } = await browserStack(factory, { local: true })
    const controller = new AbortController()

    const acquiring = web(context(controller.signal))
    controller.abort()

    await expect(acquiring).rejects.toThrow('cancelled while BrowserStack Local was starting')
  })
})

describe('a BrowserStack Local tunnel that is already running', () => {
  it('asks for the tunnel by localIdentifier and starts nothing', async () => {
    const factory = fakeFactory()
    const { web, device, shutdown } = await browserStack(factory, {
      localIdentifier: 'team-tunnel',
    })

    const webAnswer = await web()
    const deviceAnswer = await device()
    await shutdown()

    expect(capsOf(webAnswer.url)).toMatchObject({
      'browserstack.local': true,
      'browserstack.localIdentifier': 'team-tunnel',
    })
    expect(bstackOptions(deviceAnswer)).toMatchObject({
      local: true,
      localIdentifier: 'team-tunnel',
    })
    expect(factory.starts).toEqual([])
    expect(factory.stops).toBe(0)
  })

  it('asks for no tunnel when neither local nor localIdentifier is set', async () => {
    const factory = fakeFactory()
    const { web, device } = await browserStack(factory)

    const caps = capsOf((await web()).url)
    const own = bstackOptions(await device())

    expect(caps).not.toHaveProperty('browserstack.local')
    expect(caps).not.toHaveProperty('browserstack.localIdentifier')
    expect(own).not.toHaveProperty('local')
    expect(own).not.toHaveProperty('localIdentifier')
    expect(factory.starts).toEqual([])
  })

  it('refuses localBinary without local, because only a tunnel the plugin starts runs a binary', async () => {
    const refusal = await browserStack(fakeFactory(), {
      localBinary: '/opt/BrowserStackLocal',
    }).catch((error: unknown) => error)

    expect(refusal).toMatchObject({ kind: 'refused', path: 'localBinary' })
  })
})

describe('the built BrowserStack plugin with local on', () => {
  const plugins: PluginProcess[] = []

  afterEach(async () => {
    await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  })

  it('refuses the acquire with kind unreachable, because this build cannot start BrowserStack Local', async () => {
    const plugin = startPluginProcess()
    plugins.push(plugin)
    expect((await initializePlugin(plugin, { local: true }, LISTED)).error).toBeUndefined()

    const answer = await plugin.call('acquire', {
      remote: 'browserstack',
      settings: {},
      session: { platform: 'web', engine: 'chromium', context: 'new' },
      run: { testName: TEST_NAME },
    })

    expect(answer.error?.code).toBe(-32000)
    expect(answer.error?.data).toMatchObject({ kind: 'unreachable', path: 'local' })
    expect(answer.error?.message).toBe(
      'This build of the plugin cannot start BrowserStack Local; start the tunnel yourself and set localIdentifier.',
    )
    expect(existsSync(join(process.cwd(), 'local.log'))).toBe(false)
  })
})
