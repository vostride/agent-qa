import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ActionResult, RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import {
  refuseWithoutChromium,
  startCountingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CountingProxy, PlaywrightServer } from './fixtures/remote-browsers.js'

const CONNECT_TIMEOUT_MS = 30_000
const CELL_TIMEOUT_MS = 60_000

interface Scene {
  readonly server: PlaywrightServer
  readonly proxy: CountingProxy
  readonly remote: RemoteBrowserConfig
}

interface Outcome {
  readonly failed: boolean
  // Read in the same turn the call settled.
  readonly summary: string | undefined
}

describe("a remote session's life", () => {
  let site: Server
  let siteOrigin = ''
  const held = new Set<ServerResponse>()
  let hung: () => void = () => undefined
  let hangArrived = new Promise<void>((arrived) => { hung = arrived })
  const opened: Array<() => Promise<void>> = []

  beforeAll(async () => {
    refuseWithoutChromium()
    site = createServer((request, response) => {
      if (request.url === '/hang') {
        held.add(response)
        hung()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!DOCTYPE html><html><body><h1>Here</h1><button>Go</button></body></html>')
    })
    await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()))
    siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`
  })

  afterEach(async () => {
    for (const close of opened.splice(0).reverse()) await close()
    for (const response of held) response.destroy()
    held.clear()
    hangArrived = new Promise<void>((arrived) => { hung = arrived })
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    site.closeAllConnections()
    await new Promise<void>((closed) => site.close(() => closed()))
  })

  async function scene(): Promise<Scene> {
    const server = await startPlaywrightServer()
    opened.push(() => server.close())
    const upstream = new URL(server.wsEndpoint)
    const proxy = await startCountingProxy(Number(upstream.port))
    opened.push(() => proxy.close())
    const remote: RemoteBrowserConfig = {
      name: 'grid',
      protocol: 'playwright',
      url: `ws://127.0.0.1:${String(proxy.port)}${upstream.pathname}`,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    }
    return { server, proxy, remote }
  }

  async function connected(remote: RemoteBrowserConfig): Promise<WebPlatformAdapter> {
    const adapter = new WebPlatformAdapter()
    opened.push(() => adapter.cleanup())
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
    return adapter
  }

  function navigate(adapter: WebPlatformAdapter, path: string): Promise<ActionResult> {
    return adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}${path}` })
  }

  function settledWithSummary(adapter: WebPlatformAdapter, call: Promise<unknown>): Promise<Outcome> {
    return call.then(
      (result) => ({
        failed: (result as Partial<ActionResult>).success === false,
        summary: adapter.disconnectSummary,
      }),
      () => ({ failed: true, summary: adapter.disconnectSummary }),
    )
  }

  function lostSentence(remote: RemoteBrowserConfig): string {
    return `The connection to remote grid (playwright ${new URL(remote.url).origin}) was lost while this test ran.`
  }

  function endedSentence(remote: RemoteBrowserConfig): string {
    return `Remote grid (playwright ${new URL(remote.url).origin}) ended the session while this test ran.`
  }

  // Reads the summary inside the browser's own disconnected event, after the adapter's listener.
  async function connectedWatchingDrop(
    remote: RemoteBrowserConfig,
  ): Promise<{ adapter: WebPlatformAdapter; atDrop: () => string | undefined }> {
    const connect = vi.spyOn(chromium, 'connect')
    const adapter = await connected(remote)
    const browser = (await connect.mock.results[0]?.value) as Browser
    let atDrop: string | undefined
    browser.on('disconnected', () => {
      atDrop = adapter.disconnectSummary
    })
    return { adapter, atDrop: () => atDrop }
  }

  // The drop happens while a navigation waits on a page that never answers.
  async function dropMidNavigation(
    adapter: WebPlatformAdapter,
    drop: () => Promise<void>,
  ): Promise<Outcome> {
    const pending = settledWithSummary(adapter, navigate(adapter, '/hang'))
    await hangArrived
    await drop()
    return pending
  }

  it('one adapter counts one session across setup, several actions and cleanup', async () => {
    const { proxy, remote } = await scene()
    const adapter = await connected(remote)

    expect((await navigate(adapter, '/')).success).toBe(true)
    await adapter.observe()
    await adapter.screenshot()
    expect((await navigate(adapter, '/again')).success).toBe(true)
    await adapter.cleanup()

    expect(proxy.sessions()).toBe(1)
  }, CELL_TIMEOUT_MS)

  it('two adapters count two sessions', async () => {
    const { proxy, remote } = await scene()
    const first = await connected(remote)
    const second = await connected(remote)

    expect((await navigate(first, '/')).success).toBe(true)
    expect((await navigate(second, '/')).success).toBe(true)

    expect(proxy.sessions()).toBe(2)
  }, CELL_TIMEOUT_MS)

  it('a remote that ends the session fails the action, names the remote at once and settles as ended', async () => {
    const { server, proxy, remote } = await scene()
    const { adapter, atDrop } = await connectedWatchingDrop(remote)

    // The proxy keeps listening, so the remote's host still answers once its browser is gone.
    const outcome = await dropMidNavigation(adapter, () => server.close())

    expect(atDrop()).toBe(lostSentence(remote))
    expect(outcome.failed).toBe(true)
    // On loopback the probe can answer before the rejection reaches the caller.
    expect([lostSentence(remote), endedSentence(remote)]).toContain(outcome.summary)
    expect(adapter.isBrowserDisconnected).toBe(true)
    await adapter.settleDisconnect()
    expect(adapter.disconnectSummary).toBe(endedSentence(remote))
    expect(adapter.placeEvidence).toMatchObject({ place: 'remote', failureKind: 'ended' })

    expect(await settledWithSummary(adapter, navigate(adapter, '/'))).toMatchObject({ failed: true })
    expect(proxy.sessions()).toBe(1)
  }, CELL_TIMEOUT_MS)

  it('a connection that is lost fails the action, names the remote at once and settles as lost', async () => {
    const { proxy, remote } = await scene()
    const { adapter, atDrop } = await connectedWatchingDrop(remote)

    const outcome = await dropMidNavigation(adapter, () => proxy.close())

    expect(atDrop()).toBe(lostSentence(remote))
    expect(outcome).toEqual({ failed: true, summary: lostSentence(remote) })
    await adapter.settleDisconnect()
    expect(adapter.disconnectSummary).toBe(lostSentence(remote))
    expect(adapter.placeEvidence).toMatchObject({ place: 'remote', failureKind: 'lost' })

    expect(await settledWithSummary(adapter, navigate(adapter, '/'))).toMatchObject({ failed: true })
    expect(proxy.sessions()).toBe(1)
  }, CELL_TIMEOUT_MS)

  it('a session that ends on purpose names nothing', async () => {
    const { remote } = await scene()
    const adapter = await connected(remote)

    await adapter.cleanup()

    expect(adapter.isBrowserDisconnected).toBe(false)
    expect(adapter.disconnectSummary).toBeUndefined()
    await expect(adapter.settleDisconnect()).resolves.toBeUndefined()
  }, CELL_TIMEOUT_MS)

  it("an earlier session's late disconnect leaves the same adapter's next session alone", async () => {
    const { remote } = await scene()
    const connect = vi.spyOn(chromium, 'connect')
    const adapter = await connected(remote)
    const earlier = (await connect.mock.results[0]?.value) as Browser
    await adapter.cleanup()
    await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
    expect(connect).toHaveBeenCalledTimes(2)

    // A silent remote's disconnect can arrive this late, after the next session has started.
    ;(earlier as unknown as { emit(event: string, browser: Browser): void }).emit('disconnected', earlier)

    expect(adapter.isBrowserDisconnected).toBe(false)
    expect(adapter.disconnectSummary).toBeUndefined()
    expect((await navigate(adapter, '/')).success).toBe(true)
  }, CELL_TIMEOUT_MS)
})
