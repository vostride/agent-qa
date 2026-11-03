import { createRequire } from 'node:module'

import { RemoteRefusalError, SecretStore } from '@vostride/agent-qa-runner'
import type { PlatformConfig, RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import type { WebPlatformAdapterOptions } from '../adapter.js'
import {
  startCdpBrowser,
  startCredentialCheckingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CredentialCheckingProxy, CredentialExpectation } from './fixtures/remote-browsers.js'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_VERSION = (require('playwright-core/package.json') as { version: string }).version

const PW_TOKEN = 'pw tok/en+"quoted"\\back'
const GRID_KEY = 'grid key/+&=?"ü\\'
const BASIC_PASSWORD = 'pä ss/wörd:+'
const SECRETS_FILE = '.env.secrets.local'
const CONNECT_TIMEOUT_MS = 30_000

const secrets = new SecretStore([
  ['PW_TOKEN', PW_TOKEN],
  ['GRID_KEY', GRID_KEY],
  ['BASIC_PASSWORD', BASIC_PASSWORD],
])

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0).reverse()) await teardown()
})

function encodedForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1)
  return [value, encodeURIComponent(value), json, encodeURIComponent(json)]
}

function remoteAt(url: string, extra: Partial<RemoteBrowserConfig> = {}): RemoteBrowserConfig {
  return {
    name: 'grid',
    protocol: 'playwright',
    url,
    headers: { Authorization: 'Bearer {{secret:PW_TOKEN}}' },
    query: {
      token: '{{secret:GRID_KEY}}',
      caps: {
        'client.playwrightVersion': '{{playwright:version}}',
        'grid.accessKey': '{{secret:GRID_KEY}}',
      },
    },
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    ...extra,
  }
}

async function playwrightBehindProxy(
  expected: CredentialExpectation,
): Promise<{ proxy: CredentialCheckingProxy; url: string }> {
  const server = await startPlaywrightServer()
  teardowns.push(() => server.close())
  const endpoint = new URL(server.wsEndpoint)
  const proxy = await startCredentialCheckingProxy({
    target: Number(endpoint.port),
    expect: expected,
  })
  teardowns.push(() => proxy.close())
  return { proxy, url: `ws://127.0.0.1:${String(proxy.port)}${endpoint.pathname}` }
}

async function setUp(
  remote: RemoteBrowserConfig,
  options: WebPlatformAdapterOptions = { connectionSecrets: secrets, secretsFile: SECRETS_FILE },
): Promise<PlatformConfig> {
  const config: PlatformConfig = { platform: 'web', browser: { name: 'chromium', remote } }
  const adapter = new WebPlatformAdapter(options)
  teardowns.push(() => adapter.cleanup())
  const before = structuredClone(config)
  await adapter.setup(config)
  expect(config).toEqual(before)
  return config
}

async function refusalOf(
  remote: RemoteBrowserConfig,
  options: WebPlatformAdapterOptions,
): Promise<RemoteRefusalError> {
  const adapter = new WebPlatformAdapter(options)
  try {
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteRefusalError)
    return error as RemoteRefusalError
  } finally {
    await adapter.cleanup()
  }
  throw new Error('setup connected with credentials that should refuse')
}

function carriedText(error: Error): string {
  return [
    error.message,
    error.stack ?? '',
    String(error),
    ...Object.getOwnPropertyNames(error).map((key) =>
      String((error as unknown as Record<string, unknown>)[key]),
    ),
  ].join('\n')
}

describe("a remote's credentials", () => {
  it('reach a Playwright server resolved, in one encoding, while the config keeps its references', async () => {
    const { proxy, url } = await playwrightBehindProxy({
      headers: { authorization: `Bearer ${PW_TOKEN}` },
      query: { token: GRID_KEY },
    })
    const config = await setUp(remoteAt(url))

    expect(config.browser?.remote?.headers).toEqual({
      Authorization: 'Bearer {{secret:PW_TOKEN}}',
    })
    const [request, ...others] = proxy.requests()
    expect(others).toEqual([])
    const caps = {
      'client.playwrightVersion': PLAYWRIGHT_VERSION,
      'grid.accessKey': GRID_KEY,
    }
    expect(request?.requestLine).toContain(
      `?token=${encodeURIComponent(GRID_KEY)}&caps=${encodeURIComponent(JSON.stringify(caps))} `,
    )
    const sent = new URL(request?.url ?? '/', 'http://127.0.0.1').searchParams.get('caps')
    expect(JSON.parse(sent ?? 'null')).toEqual(caps)
    expect(request?.headers.authorization).toBe(`Bearer ${PW_TOKEN}`)
  })

  it('reach a CDP endpoint resolved', async () => {
    const browser = await startCdpBrowser()
    teardowns.push(() => browser.close())
    const discovery = (await (await fetch(`${browser.endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string
    }
    const proxy = await startCredentialCheckingProxy({
      target: browser.port,
      expect: { headers: { authorization: `Bearer ${PW_TOKEN}` }, query: { token: GRID_KEY } },
    })
    teardowns.push(() => proxy.close())
    const path = new URL(discovery.webSocketDebuggerUrl).pathname
    await setUp(remoteAt(`ws://127.0.0.1:${String(proxy.port)}${path}`, { protocol: 'cdp' }))

    expect(proxy.requests()).toHaveLength(1)
  })

  it('send basicAuth as an Authorization Basic header over the UTF-8 bytes', async () => {
    const expected = Buffer.from(`agent:${BASIC_PASSWORD}`, 'utf8').toString('base64')
    const { proxy, url } = await playwrightBehindProxy({
      headers: { authorization: `Basic ${expected}` },
    })
    const remote = remoteAt(url, {
      basicAuth: { user: 'agent', password: '{{secret:BASIC_PASSWORD}}' },
    })
    delete remote.headers
    delete remote.query
    await setUp(remote)

    expect(proxy.requests().map((request) => request.headers.authorization)).toEqual([
      `Basic ${expected}`,
    ])
  })

  it('refuse a reference to an undeclared secret before connecting, naming it and the secrets file', async () => {
    const { proxy, url } = await playwrightBehindProxy({})
    const remote = remoteAt(url, {
      headers: { Authorization: 'Bearer {{secret:MISSING_TOKEN}}' },
    })
    const label = `grid (playwright ws://127.0.0.1:${String(proxy.port)})`

    const named = await refusalOf(remote, { connectionSecrets: secrets, secretsFile: SECRETS_FILE })
    expect(named.message).toBe(
      `Remote ${label} needs MISSING_TOKEN, which ${SECRETS_FILE} does not declare. Add it there.`,
    )
    expect(named.remote).toBe(label)

    const unnamed = await refusalOf(remote, {})
    expect(unnamed.message).toBe(
      `Remote ${label} needs GRID_KEY, which workspace.secretsFile does not declare. Add it there.`,
    )
    expect(proxy.requests()).toEqual([])
  })

  it('refuse a wrong token with the credentials sentence and none of its encoded forms', async () => {
    const wrong = 'wrong tok/en+"x"\\y'
    const wrongKey = 'wrong key/&=ü'
    const { proxy, url } = await playwrightBehindProxy({
      headers: { authorization: `Bearer ${PW_TOKEN}` },
    })
    const store = new SecretStore([
      ['PW_TOKEN', wrong],
      ['GRID_KEY', wrongKey],
    ])

    const error = await refusalOf(remoteAt(url), {
      connectionSecrets: store,
      secretsFile: SECRETS_FILE,
    })

    expect(error.kind).toBe('auth')
    expect(error.message).toBe(
      `Remote grid (playwright ws://127.0.0.1:${String(proxy.port)}) refused the credentials. Check GRID_KEY and PW_TOKEN in ${SECRETS_FILE}.`,
    )
    expect(proxy.requests()).toHaveLength(1)
    const carried = carriedText(error)
    for (const form of [...encodedForms(wrong), ...encodedForms(wrongKey)]) {
      expect(carried).not.toContain(form)
    }
    expect(carried).not.toContain(proxy.requests()[0]?.url ?? '/never')
  })
})
