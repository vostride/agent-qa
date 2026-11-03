import { chromium } from 'playwright-core'
import { createRemoteRefusalMemory, RemoteRefusalError } from '@vostride/agent-qa-runner'
import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { remoteLabel } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import { debugEnablesPlaywright, scrubRemoteEndpoint } from '../remote-connection.js'
import {
  freePort,
  refuseWithoutChromium,
  startCountingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CountingProxy, PlaywrightServer } from './fixtures/remote-browsers.js'

const CONNECT_TIMEOUT_MS = 30_000

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function remoteOf(protocol: RemoteBrowserConfig['protocol'], url: string): RemoteBrowserConfig {
  return { name: 'grid', protocol, url, connectTimeoutMs: CONNECT_TIMEOUT_MS }
}

async function setupError(adapter: WebPlatformAdapter, remote: RemoteBrowserConfig) {
  return adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } }).then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("Playwright's own logging on a remote", () => {
  it.each([
    '*',
    'pw:*',
    'pw:api',
    'pw:protocol',
    'pw:channel',
    'pw:server',
    'pw:server:channel',
    'pw:server:*',
    'pw:a-name-playwright-adds-later',
    'pw:*,-pw:api,-pw:protocol',
    '*,-pw:api',
    'p*',
    'foo,pw:*',
    'express:* pw:api',
  ])(
    'DEBUG=%s turns it on',
    (debug) => {
      expect(debugEnablesPlaywright(debug)).toBe(true)
    },
  )

  it.each([
    undefined,
    '',
    'express:*',
    'express:*,agent-qa:*',
    '*,-pw:*',
    'pw:*,-pw:*',
    'pw:channel,-pw:*',
    '*,-p*',
  ])(
    'DEBUG=%s leaves it off',
    (debug) => {
      expect(debugEnablesPlaywright(debug)).toBe(false)
    },
  )

  it.each([
    ['playwright', 'ws'],
    ['cdp', 'http'],
  ] as const)(
    'refuses a %s remote before it connects, naming the remote by its label',
    async (protocol, scheme) => {
      vi.stubEnv('DEBUG', 'pw:api')
      let proxy: CountingProxy | undefined
      const adapter = new WebPlatformAdapter()
      try {
        proxy = await startCountingProxy(await freePort())
        const origin = `${scheme}://127.0.0.1:${String(proxy.port)}`
        const refused = await setupError(
          adapter,
          remoteOf(protocol, `${origin}/some/path?token=x`),
        )

        expect(refused).toBeInstanceOf(RemoteRefusalError)
        const { message, remote } = refused as RemoteRefusalError
        expect(message).toBe(
          `Remote grid (${protocol} ${origin}) cannot be used while DEBUG turns on Playwright's own logging, which would print its address and requests. Unset DEBUG to run this test.`,
        )
        expect(message).not.toContain('/some/path')
        expect(message).not.toContain('token')
        expect(remote).toBe(`grid (${protocol} ${origin})`)
        expect(proxy.connections()).toBe(0)
      } finally {
        await adapter.cleanup()
        await proxy?.close()
      }
    },
  )

  it('does not remember the refusal once DEBUG is unset', async () => {
    vi.stubEnv('DEBUG', 'pw:*')
    const refusalMemory = createRemoteRefusalMemory()
    const adapter = new WebPlatformAdapter({ refusalMemory })
    try {
      const refused = await setupError(adapter, remoteOf('playwright', 'ws://127.0.0.1:9/'))
      expect(refused).toBeInstanceOf(RemoteRefusalError)
      expect(refusalMemory.refusalFor('grid')).toBeUndefined()
    } finally {
      await adapter.cleanup()
    }
  })

  it('leaves a browser launched here alone', async () => {
    refuseWithoutChromium()
    vi.stubEnv('DEBUG', 'pw:api')
    const launch = vi.spyOn(chromium, 'launch')
    const adapter = new WebPlatformAdapter()
    try {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium' } })
      expect(launch).toHaveBeenCalledTimes(1)
    } finally {
      await adapter.cleanup()
    }
  }, 60_000)
})

describe('error text from a remote-attached adapter', () => {
  const remote = remoteOf('playwright', 'wss://u:p@grid.example.com/t0k?k=SECRET')

  it('names the remote by its label instead of its endpoint', () => {
    const text = scrubRemoteEndpoint('failed at wss://u:p@grid.example.com/t0k?k=SECRET', remote)

    expect(text).toBe(`failed at ${remoteLabel(remote)}`)
    for (const secret of ['u:p', 't0k', 'SECRET']) expect(text).not.toContain(secret)
  })

  it('replaces every scheme on the remote host and port and keeps the punctuation after it', () => {
    const text = scrubRemoteEndpoint(
      'discovery https://GRID.example.com/json?k=SECRET, then ws://grid.example.com:443/devtools.',
      remote,
    )

    expect(text).toBe(`discovery ${remoteLabel(remote)}, then ${remoteLabel(remote)}.`)
  })

  it('leaves a url on another port of the remote host as it is', () => {
    const local = remoteOf('playwright', 'ws://localhost:3000/t0k')
    const text = 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/login'

    expect(scrubRemoteEndpoint(text, local)).toBe(text)
    expect(scrubRemoteEndpoint('closed ws://localhost:3000/t0k', local)).toBe(
      `closed ${remoteLabel(local)}`,
    )
  })

  it('leaves other hosts and text that already holds the label as they are', () => {
    const text = `Remote ${remoteLabel(remote)} ended; see https://example.com/docs?page=2`

    expect(scrubRemoteEndpoint(text, remote)).toBe(text)
  })

  it('scrubs an action error naming the remote and keeps one naming an app beside it', async () => {
    let server: PlaywrightServer | undefined
    const adapter = new WebPlatformAdapter()
    try {
      server = await startPlaywrightServer()
      const attached = remoteOf('playwright', server.wsEndpoint)
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote: attached } })
      const remotePort = new URL(server.wsEndpoint).port
      const closed = await freePort()

      const onRemote = await adapter.execute({
        type: 'navigate',
        to: 'url',
        url: `https://127.0.0.1:${remotePort}/t0k?k=SECRET`,
      })
      const beside = await adapter.execute({
        type: 'navigate',
        to: 'url',
        url: `http://127.0.0.1:${String(closed)}/login`,
      })

      expect(onRemote.success).toBe(false)
      expect(onRemote.error).toContain(remoteLabel(attached))
      expect(onRemote.error).not.toContain('t0k')
      expect(onRemote.error).not.toContain('SECRET')
      expect(beside.success).toBe(false)
      expect(beside.error).toContain(`http://127.0.0.1:${String(closed)}/login`)
      expect(beside.error).not.toContain(remoteLabel(attached))
    } finally {
      await adapter.cleanup()
      await server?.close()
    }
  }, 60_000)
})
