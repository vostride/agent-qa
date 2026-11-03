import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { RemoteBrowserConfig } from '@vostride/agent-qa-runner'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { WebPlatformAdapter } from '../adapter.js'
import {
  createRemoteHeartbeat,
  REMOTE_HEARTBEAT_INTERVAL_MS,
  REMOTE_HEARTBEAT_TIMEOUT_MS,
} from '../remote-heartbeat.js'
import {
  refuseWithoutChromium,
  startCdpBrowser,
  startCountingProxy,
  startPlaywrightServer,
} from './fixtures/remote-browsers.js'
import type { CdpBrowser, CountingProxy, PlaywrightServer } from './fixtures/remote-browsers.js'

const INTERVAL_MS = 1_000
const SHORT_INTERVAL_MS = 200
const SLOW_PAGE_MS = 1_000
const CONNECT_TIMEOUT_MS = 30_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('the remote heartbeat', () => {
  describe('scheduling', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('beats every 30 seconds by default, each beat bounded at 10 seconds', () => {
      expect(REMOTE_HEARTBEAT_INTERVAL_MS).toBe(30_000)
      expect(REMOTE_HEARTBEAT_TIMEOUT_MS).toBe(10_000)
    })

    it('beats at the interval while idle and not after stop', async () => {
      vi.useFakeTimers()
      const beat = vi.fn(async () => undefined)
      const heartbeat = createRemoteHeartbeat({ intervalMs: INTERVAL_MS, beat })
      heartbeat.start()

      await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
      expect(beat).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(beat).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
      expect(beat).toHaveBeenCalledTimes(3)
      expect(heartbeat.counts()).toEqual({ sent: 3, failed: 0, suspect: false })

      heartbeat.stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      expect(beat).toHaveBeenCalledTimes(3)
    })

    it('sends no beat while an action is in flight', async () => {
      vi.useFakeTimers()
      const beat = vi.fn(async () => undefined)
      const heartbeat = createRemoteHeartbeat({ intervalMs: INTERVAL_MS, beat })
      heartbeat.start()

      await heartbeat.enter()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
      expect(beat).not.toHaveBeenCalled()

      heartbeat.leave()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(beat).toHaveBeenCalledTimes(1)
      heartbeat.stop()
    })

    it('lets an action start only after a running beat settles', async () => {
      vi.useFakeTimers()
      const answer = deferred()
      const heartbeat = createRemoteHeartbeat({ intervalMs: INTERVAL_MS, beat: () => answer.promise })
      heartbeat.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)

      let entered = false
      const entering = heartbeat.enter().then(() => {
        entered = true
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(entered).toBe(false)

      answer.resolve()
      await entering
      expect(entered).toBe(true)
      expect(heartbeat.counts()).toEqual({ sent: 1, failed: 0, suspect: false })
      heartbeat.leave()
      heartbeat.stop()
    })

    it('marks the session suspect when a beat rejects, without throwing, and clears it when one answers', async () => {
      vi.useFakeTimers()
      let refuse = true
      const beat = vi.fn(async () => {
        if (refuse) throw new Error('Target page, context or browser has been closed')
      })
      const heartbeat = createRemoteHeartbeat({ intervalMs: INTERVAL_MS, beat })
      heartbeat.start()

      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(heartbeat.counts()).toEqual({ sent: 1, failed: 1, suspect: true })
      await expect(heartbeat.enter()).resolves.toBeUndefined()
      heartbeat.leave()

      refuse = false
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(heartbeat.counts()).toEqual({ sent: 2, failed: 1, suspect: false })
      heartbeat.stop()
    })

    it('counts a beat that hangs past its timeout as failed and stacks no second beat on it', async () => {
      vi.useFakeTimers()
      const hung = deferred()
      const beat = vi.fn(() => hung.promise)
      const heartbeat = createRemoteHeartbeat({ intervalMs: INTERVAL_MS, beatTimeoutMs: 2_500, beat })
      heartbeat.start()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(beat).toHaveBeenCalledTimes(1)

      let entered = false
      const entering = heartbeat.enter().then(() => {
        entered = true
      })
      await vi.advanceTimersByTimeAsync(2_499)
      expect(entered).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await entering
      expect(heartbeat.counts()).toEqual({ sent: 1, failed: 1, suspect: true })
      heartbeat.leave()

      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
      expect(beat).toHaveBeenCalledTimes(1)

      hung.resolve()
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(beat).toHaveBeenCalledTimes(2)
      expect(heartbeat.counts()).toEqual({ sent: 2, failed: 1, suspect: false })
      heartbeat.stop()
    })
  })

  describe('on a remote session', () => {
    let site: Server
    let siteOrigin = ''

    beforeAll(async () => {
      refuseWithoutChromium()
      site = createServer((request, response) => {
        const delay = request.url === '/slow' ? SLOW_PAGE_MS : 0
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html' })
          response.end('<!DOCTYPE html><html><body><h1>Here</h1></body></html>')
        }, delay)
      })
      await new Promise<void>((ready) => site.listen(0, '127.0.0.1', () => ready()))
      siteOrigin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`
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

    // Idle traffic is the heartbeat and nothing else; an action in flight holds it off.
    async function provesHeartbeat(remote: RemoteBrowserConfig, proxy: CountingProxy): Promise<void> {
      const adapter = new WebPlatformAdapter({ heartbeatIntervalMs: SHORT_INTERVAL_MS })
      try {
        await adapter.setup({ platform: 'web', browser: { name: 'chromium', remote } })
        const navigated = await adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/` })
        expect(navigated.success).toBe(true)

        const idleFrames = proxy.clientFrames()
        const idleBeats = heartbeatOf(adapter).sent
        await pause(SHORT_INTERVAL_MS * 6)
        const beatsWhileIdle = heartbeatOf(adapter).sent - idleBeats
        expect(beatsWhileIdle).toBeGreaterThanOrEqual(3)
        expect(beatsWhileIdle).toBeLessThanOrEqual(7)
        expect(proxy.clientFrames() - idleFrames).toBe(beatsWhileIdle)
        expect(heartbeatOf(adapter)).toMatchObject({ failed: 0, suspect: false })

        const slow = adapter.execute({ type: 'navigate', to: 'url', url: `${siteOrigin}/slow` })
        await pause(SHORT_INTERVAL_MS)
        const framesInAction = proxy.clientFrames()
        const beatsInAction = heartbeatOf(adapter).sent
        await pause(SLOW_PAGE_MS - SHORT_INTERVAL_MS * 2)
        expect(proxy.clientFrames()).toBe(framesInAction)
        expect(heartbeatOf(adapter).sent).toBe(beatsInAction)
        expect((await slow).success).toBe(true)

        const afterAction = heartbeatOf(adapter).sent
        await vi.waitFor(() => expect(heartbeatOf(adapter).sent).toBeGreaterThan(afterAction), {
          timeout: SHORT_INTERVAL_MS * 5,
        })
      } finally {
        await adapter.cleanup()
      }
    }

    it('a Playwright server sees one beat per interval while the adapter waits and none during an action', async () => {
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

    it('a CDP endpoint sees one beat per interval while the adapter waits and none during an action', async () => {
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
          timeout: SHORT_INTERVAL_MS * 5,
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
        await pause(SHORT_INTERVAL_MS * 2)
        expect(adapter.placeEvidence).toEqual({ place: 'here' })
      } finally {
        await adapter.cleanup()
      }
    }, 60_000)
  })
})
