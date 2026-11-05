import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createLineDecoder,
  encodeMessage,
  MAX_MESSAGE_BYTES,
} from '@vostride/agent-qa-plugin-kit/protocol'
import { afterEach, describe, expect, it } from 'vitest'

const ENTRY = fileURLToPath(new URL('../../dist/main.js', import.meta.url))
const USERNAME = 'bs-test-user'
const ACCESS_KEY = 'bs-test-access-key'
const RUN_ID = 'run-7'
const TEST_NAME = 'checkout keeps the cart'
const LISTED = '1.63.0'

interface RpcAnswer {
  result?: unknown
  error?: { code: number; message: string; data?: { kind?: string; path?: string } }
}

interface WebResult {
  handle: Record<string, unknown>
  protocol: string
  url: string
  mask: string[]
}

interface PluginHost {
  request(method: string, params?: unknown): Promise<RpcAnswer>
  close(): Promise<void>
}

const hosts: PluginHost[] = []

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()))
})

function startPlugin(): PluginHost {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'ignore'] })
  const waiting = new Map<number, (answer: RpcAnswer) => void>()
  let next = 0
  const decoder = createLineDecoder({
    maxLineBytes: MAX_MESSAGE_BYTES,
    onLine: (line) => {
      const message = JSON.parse(line) as RpcAnswer & { id?: number }
      if (typeof message.id !== 'number') return
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    },
    onOverflow: () => {
      throw new Error('the plugin wrote an oversized line')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  const host: PluginHost = {
    request(method, params) {
      next += 1
      const id = next
      const answered = new Promise<RpcAnswer>((resolve) => waiting.set(id, resolve))
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      return answered
    },
    close() {
      child.stdin.end()
      return exited
    },
  }
  hosts.push(host)
  return host
}

async function initialized(input: { options?: Record<string, unknown>; playwright?: string }) {
  const plugin = startPlugin()
  const answer = await plugin.request('initialize', {
    protocolVersions: [1],
    host: {
      pid: process.pid,
      agentQaVersion: '0.0.0',
      playwrightVersion: input.playwright ?? LISTED,
      webdriverioVersion: 'unknown',
    },
    entry: 'browserstack',
    options: { username: USERNAME, accessKey: ACCESS_KEY, ...input.options },
    runFacts: { runId: RUN_ID },
  })
  return { plugin, answer }
}

async function browserStack(playwright?: string) {
  const { plugin, answer } = await initialized({ ...(playwright ? { playwright } : {}) })
  expect(answer.error).toBeUndefined()
  return plugin
}

function acquire(
  plugin: PluginHost,
  input: { engine?: 'chromium' | 'firefox' | 'webkit'; settings?: Record<string, unknown> } = {},
) {
  return plugin.request('acquire', {
    remote: 'browserstack',
    settings: input.settings ?? {},
    session: { platform: 'web', engine: input.engine ?? 'chromium', context: 'new' },
    run: { testName: TEST_NAME },
  })
}

function webResult(answer: RpcAnswer): WebResult {
  expect(answer.error).toBeUndefined()
  return answer.result as WebResult
}

function capsOf(url: string): Record<string, unknown> {
  const caps = new URL(url).searchParams.get('caps')
  expect(caps).not.toBeNull()
  return JSON.parse(caps ?? '') as Record<string, unknown>
}

describe('a BrowserStack web acquire', () => {
  it.each([
    ['chromium', 'chrome'],
    ['firefox', 'playwright-firefox'],
    ['webkit', 'playwright-webkit'],
  ] as const)(
    'answers a %s test with the Playwright URL and %s in its capabilities',
    async (engine, browser) => {
      const plugin = await browserStack()

      const result = webResult(await acquire(plugin, { engine }))

      expect(result.protocol).toBe('playwright')
      expect(result.url.startsWith('wss://cdp.browserstack.com/playwright?caps=')).toBe(true)
      expect(capsOf(result.url)).toEqual({
        'browserstack.username': USERNAME,
        'browserstack.accessKey': ACCESS_KEY,
        browser,
        os: 'OS X',
        os_version: 'Sequoia',
        'client.playwrightVersion': LISTED,
        project: 'agent-qa',
        build: RUN_ID,
        name: TEST_NAME,
      })
    },
  )

  it('lets settings override the build, the project and the platform, with extra merged last', async () => {
    const plugin = await browserStack()

    const result = webResult(
      await acquire(plugin, {
        settings: {
          build: 'nightly',
          project: 'shop',
          os: 'Windows',
          osVersion: '11',
          browser: 'edge',
          browserVersion: 'latest-1',
          extra: { resolution: '1280x1024', os_version: '10' },
        },
      }),
    )

    expect(capsOf(result.url)).toMatchObject({
      browser: 'edge',
      browser_version: 'latest-1',
      os: 'Windows',
      os_version: '10',
      project: 'shop',
      build: 'nightly',
      name: TEST_NAME,
      resolution: '1280x1024',
    })
    expect(result.handle).toMatchObject({ kind: 'web', build: 'nightly', name: TEST_NAME })
  })

  it('lists the whole Playwright URL in mask, because its query carries the access key', async () => {
    const plugin = await browserStack()

    const result = webResult(await acquire(plugin))

    expect(result.url).toContain(encodeURIComponent(ACCESS_KEY))
    expect(result.mask).toEqual([result.url])
  })

  it('refuses a browser that cannot run the test engine, pointing at settings.browser', async () => {
    const plugin = await browserStack()

    const answer = await acquire(plugin, { engine: 'firefox', settings: { browser: 'chrome' } })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path: 'settings.browser' })
  })

  it('releases a web handle twice with nothing to delete', async () => {
    const plugin = await browserStack()
    const { handle } = webResult(await acquire(plugin))

    expect((await plugin.request('release', { handle })).result).toEqual({})
    expect((await plugin.request('release', { handle })).result).toEqual({})
  })
})

describe("agent-qa's Playwright version on BrowserStack", () => {
  it('runs a web test when BrowserStack lists the Playwright major.minor', async () => {
    const plugin = await browserStack('1.63.0')

    expect((await acquire(plugin)).error).toBeUndefined()
  })

  it('refuses a web test with kind version and one line naming both versions', async () => {
    const plugin = await browserStack('1.64.1')

    const answer = await acquire(plugin)

    expect(answer.error?.data?.kind).toBe('version')
    expect(answer.error?.message).toBe(
      'BrowserStack lists Playwright 1.59 to 1.63, not 1.64, so web tests cannot run there yet; run this test here or on another remote.',
    )
  })
})

describe('the BrowserStack endpoints', () => {
  it.each([
    ['apiUrl', 'http://api.example.com'],
    ['appApiUrl', 'http://api-cloud.example.com'],
    ['hubUrl', 'http://hub.example.com/wd/hub'],
    ['playwrightUrl', 'ws://cdp.example.com/playwright'],
    ['playwrightUrl', 'https://cdp.example.com/playwright'],
    ['apiUrl', 'https://user:secret@api.example.com'],
  ])('refuses %s %s at initialize with its path', async (path, value) => {
    const { answer } = await initialized({ options: { [path]: value } })

    expect(answer.error?.data).toMatchObject({ kind: 'refused', path })
  })

  it('accepts cleartext endpoints that point at this machine', async () => {
    const { plugin, answer } = await initialized({
      options: {
        apiUrl: 'http://127.0.0.1:9',
        appApiUrl: 'http://localhost:9',
        hubUrl: 'http://[::1]:9/wd/hub',
        playwrightUrl: 'ws://127.0.0.1:9/playwright',
      },
    })

    expect(answer.error).toBeUndefined()
    const result = webResult(await acquire(plugin))
    expect(result.url.startsWith('ws://127.0.0.1:9/playwright?caps=')).toBe(true)
  })
})
