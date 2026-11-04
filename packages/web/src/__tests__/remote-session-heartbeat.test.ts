import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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

const SHORT_INTERVAL_MS = 200
// Never fires on its own: the remote-session cells call the captured tick themselves.
const HELD_INTERVAL_MS = 3_600_000
const BEATS = 3
const CONNECT_TIMEOUT_MS = 30_000

describe('the remote heartbeat on a web session', () => {
  let site: Server
  let siteOrigin = ''
  // A request to /slow waits until the cell lets it go, so an action stays in flight.
  let slowRequested = false
  let heldResponses: Array<() => void> = []

  beforeAll(async () => {
    refuseWithoutChromium()
    site = createServer((request, response) => {
      const answer = (): void => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!DOCTYPE html><html><body><h1>Here</h1></body></html>')
      }
      if (request.url !== '/slow') return answer()
      slowRequested = true
      heldResponses.push(answer)
    })
    await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()))
    siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`
  })

  afterEach(() => {
    for (const answer of heldResponses.splice(0)) answer()
    slowRequested = false
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    site.closeAllConnections()
    await new Promise<void>((closed) => site.close(() => closed()))
  })

  function remoteOf(protocol: RemoteBrowserConfig['protocol'], url: string): RemoteBrowserConfig {
    return { name: 'grid', protocol, url, connectTimeoutMs: CONNECT_TIMEOUT_MS }
  }

  function heartbeatOf(adapter: WebPlatformAdapter): { sent: number; failed: number; suspect: boolean } {
    const evidence = adapter.placeEvidence
    if (evidence?.place !== 'remote' || evidence.heartbeat === undefined) {
      throw new Error('the adapter reports no heartbeat')
    }
    return evidence.heartbeat
  }

  const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

  // The heartbeat's own interval callback, so a cell decides when each tick happens.
  function captureHeartbeatTick(): () => void {
    const schedule = globalThis.setInterval
    let tick: (() => void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
      if (ms === HELD_INTERVAL_MS) tick = handler
      return schedule(handler, ms)
    }) as typeof setInterval)
    return () => {
      if (tick === undefined) throw new Error('the heartbeat never started')
      tick()
    }
  }

  // Idle traffic is the heartbeat and nothing else; an action in flight holds it off.
  async function provesHeartbeat(remote: RemoteBrowserConfig, proxy: CountingProxy): Promise<void> {
    const tick = captureHeartbeatTick()
    const adapter = new WebPlatformAdapter({ heartbeatIntervalMs: HELD_INTERVAL_MS })
    try {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
      const navigated = await adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/` })
      expect(navigated.success).toBe(true)

      // A tick while the last beat is still out sends nothing, so each one is retried until it sends.
      const idleFrames = proxy.clientFrames()
      const idleBeats = heartbeatOf(adapter).sent
      for (let beat = 1; beat <= BEATS; beat += 1) {
        await vi.waitFor(() => {
          if (heartbeatOf(adapter).sent < idleBeats + beat) tick()
          expect(heartbeatOf(adapter).sent).toBe(idleBeats + beat)
        })
      }
      await vi.waitFor(() => expect(proxy.clientFrames() - idleFrames).toBe(BEATS))
      expect(heartbeatOf(adapter)).toMatchObject({ failed: 0, suspect: false })

      const slow = adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/slow` })
      await vi.waitFor(() => expect(slowRequested).toBe(true))
      const framesInAction = proxy.clientFrames()
      const beatsInAction = heartbeatOf(adapter).sent
      for (let beat = 0; beat < BEATS; beat += 1) {
        tick()
        await pause(SHORT_INTERVAL_MS)
      }
      expect(heartbeatOf(adapter).sent).toBe(beatsInAction)
      expect(proxy.clientFrames()).toBe(framesInAction)
      for (const answer of heldResponses.splice(0)) answer()
      expect((await slow).success).toBe(true)

      const afterAction = heartbeatOf(adapter).sent
      await vi.waitFor(() => {
        if (heartbeatOf(adapter).sent === afterAction) tick()
        expect(heartbeatOf(adapter).sent).toBe(afterAction + 1)
      })
    } finally {
      await adapter.cleanup()
    }
  }

  it('a Playwright server sees one frame per beat while the adapter waits and none during an action', async () => {
    let server: PlaywrightServer | undefined
    let proxy: CountingProxy | undefined
    try {
      server = await startPlaywrightServer()
      const upstream = new URL(server.wsEndpoint)
      proxy = await startCountingProxy(Number(upstream.port))
      await provesHeartbeat(
        remoteOf('playwright', `ws://127.0.0.1:${String(proxy.port)}${upstream.pathname}`),
        proxy,
      )
    } finally {
      await proxy?.close()
      await server?.close()
    }
  }, 60_000)

  it('a CDP endpoint sees one frame per beat while the adapter waits and none during an action', async () => {
    let cdp: CdpBrowser | undefined
    let proxy: CountingProxy | undefined
    try {
      cdp = await startCdpBrowser()
      proxy = await startCountingProxy(cdp.port)
      await provesHeartbeat(remoteOf('cdp', `http://127.0.0.1:${String(proxy.port)}`), proxy)
    } finally {
      await proxy?.close()
      await cdp?.close()
    }
  }, 60_000)

  it('stops beating once the remote ends the session', async () => {
    let server: PlaywrightServer | undefined
    const adapter = new WebPlatformAdapter({ heartbeatIntervalMs: SHORT_INTERVAL_MS })
    try {
      server = await startPlaywrightServer()
      await adapter.setup({
        platform: 'web',
        browser: { name: 'chromium', remote: remoteOf('playwright', server.wsEndpoint) },
      })
      await vi.waitFor(() => expect(heartbeatOf(adapter).sent).toBeGreaterThan(0), {
        timeout: 10_000,
      })

      await server.close()
      await vi.waitFor(() => expect(adapter.isBrowserDisconnected).toBe(true), { timeout: 5_000 })
      const ended = heartbeatOf(adapter)
      await pause(SHORT_INTERVAL_MS * 4)
      expect(heartbeatOf(adapter)).toEqual(ended)
    } finally {
      await adapter.cleanup()
      await server?.close()
    }
  }, 60_000)

  it('a browser launched here reports no heartbeat', async () => {
    const adapter = new WebPlatformAdapter({ heartbeatIntervalMs: SHORT_INTERVAL_MS })
    try {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium' } })
      expect(adapter.placeEvidence).toEqual({ place: 'here' })
    } finally {
      await adapter.cleanup()
    }
  }, 60_000)
})
