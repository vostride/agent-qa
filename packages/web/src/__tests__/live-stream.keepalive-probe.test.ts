// A scripted CDP session, because a capture that rejects once cannot be forced on Chromium.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SCREENCAST_RECOVERY_MS, WebPlatformAdapter } from '../adapter.js'

interface Internals {
  browser: unknown
  screencast: unknown
  screencastOnFrame: unknown
  withdrawnSnapshot: unknown
  keepaliveTimer: ReturnType<typeof setTimeout> | null
  fireKeepalive(cdp: unknown): Promise<void>
  handleScreencastWithdrawn(cdp: unknown): void
  rebindScreencast(options?: { focus?: boolean }): Promise<void>
  armScreencastRecovery(): void
  stopWithdrawnSnapshot(): Promise<void>
  clearKeepalive(): void
}

function scriptedSession(answers: { capture: boolean; probe: boolean }) {
  return {
    send: vi.fn(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        if (!answers.capture) throw new Error('Target frame detached')
        return { data: '' }
      }
      if (method === 'Runtime.evaluate') {
        if (!answers.probe) throw new Error('Session closed')
        return { result: { type: 'number', value: 1 } }
      }
      return {}
    }),
    detach: vi.fn(async () => undefined),
    on: vi.fn(),
  }
}

function startedAdapter(cdp: unknown): { adapter: WebPlatformAdapter; internals: Internals } {
  const adapter = new WebPlatformAdapter()
  const internals = adapter as unknown as Internals
  internals.browser = { isConnected: () => true }
  internals.screencast = cdp
  internals.screencastOnFrame = vi.fn()
  return { adapter, internals }
}

describe('the keepalive tells a bad moment from a withdrawn screencast', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('TRANSIENT-CAPTURE-KEEPS-SCREENCAST: a rejected capture on a session that still answers re-arms the keepalive', async () => {
    const cdp = scriptedSession({ capture: false, probe: true })
    const { internals } = startedAdapter(cdp)
    const withdrawn = vi.spyOn(internals, 'handleScreencastWithdrawn').mockImplementation(() => undefined)

    await internals.fireKeepalive(cdp)

    expect(withdrawn).not.toHaveBeenCalled()
    expect(internals.keepaliveTimer, 'the next keepalive is armed').not.toBeNull()
    internals.clearKeepalive()
  })

  it('TRANSIENT-CAPTURE-KEEPS-SCREENCAST: a session that fails the probe too is withdrawn', async () => {
    const cdp = scriptedSession({ capture: false, probe: false })
    const { internals } = startedAdapter(cdp)
    const withdrawn = vi.spyOn(internals, 'handleScreencastWithdrawn').mockImplementation(() => undefined)

    await internals.fireKeepalive(cdp)

    expect(withdrawn).toHaveBeenCalledWith(cdp)
  })

  it('SNAPSHOT-FALLBACK-RECOVERS: the fallback tries the screencast again, without taking focus, until it is back', async () => {
    vi.useFakeTimers()
    const { internals } = startedAdapter(null)
    internals.withdrawnSnapshot = { stop: vi.fn(async () => undefined) }
    let attempts = 0
    const rebind = vi.spyOn(internals, 'rebindScreencast').mockImplementation(async () => {
      attempts += 1
      if (attempts === 2) internals.withdrawnSnapshot = null
    })

    internals.armScreencastRecovery()
    await vi.advanceTimersByTimeAsync(SCREENCAST_RECOVERY_MS - 1)
    expect(rebind).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(rebind).toHaveBeenCalledWith({ focus: false })

    await vi.advanceTimersByTimeAsync(SCREENCAST_RECOVERY_MS)
    expect(rebind, 'a failed attempt is tried again').toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(SCREENCAST_RECOVERY_MS * 3)
    expect(rebind, 'nothing more once the screencast is back').toHaveBeenCalledTimes(2)
  })

  it('SNAPSHOT-FALLBACK-RECOVERS: stopping the fallback stops the recovery', async () => {
    vi.useFakeTimers()
    const { internals } = startedAdapter(null)
    internals.withdrawnSnapshot = { stop: vi.fn(async () => undefined) }
    const rebind = vi.spyOn(internals, 'rebindScreencast').mockImplementation(async () => undefined)

    internals.armScreencastRecovery()
    await internals.stopWithdrawnSnapshot()
    await vi.advanceTimersByTimeAsync(SCREENCAST_RECOVERY_MS * 3)
    expect(rebind).not.toHaveBeenCalled()
  })
})
