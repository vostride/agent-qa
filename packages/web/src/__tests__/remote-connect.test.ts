import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createServer as createSocketServer } from 'node:net'

import { chromium } from 'playwright-core'
import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import {
  refuseWithoutChromium,
  startCdpBrowser,
  startCountingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CdpBrowser, CountingProxy, PlaywrightServer } from './fixtures/remote-browsers.js'

const VIEWPORT = { width: 1024, height: 640 }
const CONNECT_TIMEOUT_MS = 30_000

let site: Server
let siteOrigin = ''

beforeAll(async () => {
  refuseWithoutChromium()
  site = createServer((request, response) => {
    const title = request.url === '/service' ? 'Service home' : 'Order lookup'
    response.writeHead(200, { 'content-type': 'text/html' })
    const head = `<head><title>${title}</title></head>`
    response.end(`<!DOCTYPE html><html>${head}<body><h1>${title}</h1></body></html>`)
  })
  await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()))
  siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`
})

afterAll(async () => {
  site.closeAllConnections()
  await new Promise<void>((closed) => site.close(() => closed()))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function remoteOf(
  protocol: RemoteBrowserConfig['protocol'],
  url: string,
  extra: Partial<RemoteBrowserConfig> = {},
): RemoteBrowserConfig {
  return { name: 'grid', protocol, url, connectTimeoutMs: CONNECT_TIMEOUT_MS, ...extra }
}

// Setup, navigate, observe and screenshot on the remote; reports what setup launched.
async function runOnRemote(
  remote: RemoteBrowserConfig,
): Promise<{ launches: number; tree: string }> {
  const launch = vi.spyOn(chromium, 'launch')
  const adapter = new WebPlatformAdapter()
  try {
    await adapter.setup({
      platform: 'web',
      browser: { name: 'chromium', viewport: VIEWPORT, remote },
    })
    const launches = launch.mock.calls.length
    launch.mockRestore()
    const navigated = await adapter.execute({
      type: 'navigate',
      to: 'url',
      url: `${siteOrigin}/orders`,
    })
    expect(navigated.success).toBe(true)
    const state = await adapter.observe()
    expect(state.url).toBe(`${siteOrigin}/orders`)
    expect(state.metadata.viewportWidth).toBe(VIEWPORT.width)
    expect(state.metadata.viewportHeight).toBe(VIEWPORT.height)
    const shot = await adapter.screenshot()
    expect(shot?.byteLength ?? 0).toBeGreaterThan(0)
    return { launches, tree: state.tree }
  } finally {
    await adapter.cleanup()
  }
}

async function devtoolsVersionStatus(endpoint: string): Promise<number> {
  const response = await fetch(`${endpoint}/json/version`)
  await response.body?.cancel()
  return response.status
}

// What the browser holds once every client has gone, read through a fresh connection.
async function pagesLeft(cdp: CdpBrowser): Promise<string[][]> {
  const look = await chromium.connectOverCDP(cdp.endpoint, { timeout: CONNECT_TIMEOUT_MS })
  try {
    return look.contexts().map((context) => context.pages().map((page) => page.url()))
  } finally {
    await look.close()
  }
}

describe('the web adapter on a remote browser', () => {
  it('connects to a Playwright server instead of launching a browser', async () => {
    let server: PlaywrightServer | undefined
    let proxy: CountingProxy | undefined
    try {
      server = await startPlaywrightServer()
      const upstream = new URL(server.wsEndpoint)
      proxy = await startCountingProxy(Number(upstream.port))
      const url = `ws://127.0.0.1:${String(proxy.port)}${upstream.pathname}`

      const { launches, tree } = await runOnRemote(remoteOf('playwright', url))

      expect(tree).toContain('Order lookup')
      expect(launches).toBe(0)
      expect(proxy.sessions()).toBe(1)
    } finally {
      await proxy?.close()
      await server?.close()
    }
  }, 60_000)

  it('connects to a CDP endpoint in its own context and leaves the browser running', async () => {
    let cdp: CdpBrowser | undefined
    let proxy: CountingProxy | undefined
    try {
      cdp = await startCdpBrowser()
      proxy = await startCountingProxy(cdp.port)

      const { launches, tree } = await runOnRemote(
        remoteOf('cdp', `http://127.0.0.1:${String(proxy.port)}`, { context: 'new' }),
      )

      expect(tree).toContain('Order lookup')
      expect(launches).toBe(0)
      expect(proxy.sessions()).toBe(1)
      expect(await devtoolsVersionStatus(cdp.endpoint)).toBe(200)
      expect(await pagesLeft(cdp)).toEqual([[]])
    } finally {
      await proxy?.close()
      await cdp?.close()
    }
  }, 60_000)

  it("reuses the CDP browser's first context, closing only its own pages", async () => {
    let cdp: CdpBrowser | undefined
    let proxy: CountingProxy | undefined
    try {
      cdp = await startCdpBrowser()
      const service = await chromium.connectOverCDP(cdp.endpoint, { timeout: CONNECT_TIMEOUT_MS })
      try {
        const [first] = service.contexts()
        if (first === undefined) throw new Error('the CDP browser has no context')
        await (await first.newPage()).goto(`${siteOrigin}/service`)
      } finally {
        await service.close()
      }
      proxy = await startCountingProxy(cdp.port)
      const remote = remoteOf('cdp', `http://127.0.0.1:${String(proxy.port)}`, { context: 'reuse' })

      // Two tests in a row share the service's context.
      for (const run of [1, 2]) {
        const { launches, tree } = await runOnRemote(remote)
        expect(tree).toContain('Order lookup')
        expect(launches).toBe(0)
        expect(proxy.sessions()).toBe(run)
      }

      expect(await devtoolsVersionStatus(cdp.endpoint)).toBe(200)
      expect(await pagesLeft(cdp)).toEqual([[`${siteOrigin}/service`]])
    } finally {
      await proxy?.close()
      await cdp?.close()
    }
  }, 60_000)

  describe('against an endpoint that accepts and never answers', () => {
    let silent: ReturnType<typeof createSocketServer>
    let silentPort = 0
    const held = new Set<Socket>()

    beforeAll(async () => {
      silent = createSocketServer((socket) => {
        held.add(socket)
        socket.on('close', () => held.delete(socket))
      })
      await new Promise<void>((ready) => silent.listen(0, '127.0.0.1', () => ready()))
      silentPort = (silent.address() as AddressInfo).port
    })

    afterAll(async () => {
      for (const socket of held) socket.destroy()
      await new Promise<void>((closed) => silent.close(() => closed()))
    })

    it.each([
      ['playwright', 'ws'],
      ['cdp', 'http'],
    ] as const)('a %s connect gives up at the remote connect timeout', async (protocol, scheme) => {
      const adapter = new WebPlatformAdapter()
      const remote = remoteOf(protocol, `${scheme}://127.0.0.1:${String(silentPort)}/`, {
        connectTimeoutMs: 1_500,
      })
      const started = Date.now()
      try {
        await expect(
          adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } }),
        ).rejects.toThrow(
          `Remote grid (${protocol} ${scheme}://127.0.0.1:${String(silentPort)}) did not connect within 1500ms. Raise its connectTimeout or check the service.`,
        )
      } finally {
        await adapter.cleanup()
      }
      const elapsed = Date.now() - started
      expect(elapsed).toBeGreaterThanOrEqual(1_400)
      expect(elapsed).toBeLessThan(5_000)
    }, 30_000)
  })
})
