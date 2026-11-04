import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRemoteHeartbeat } from '../remote-heartbeat.js'

const INTERVAL_MS = 1_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('the remote heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('beats every 30 seconds by default and counts a beat unanswered after 10 seconds as failed', async () => {
    vi.useFakeTimers()
    const hung = deferred()
    const beat = vi.fn(() => hung.promise)
    const heartbeat = createRemoteHeartbeat({ beat })
    heartbeat.start()

    await vi.advanceTimersByTimeAsync(30_000 - 1)
    expect(beat).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(beat).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000 - 1)
    expect(heartbeat.counts()).toEqual({ sent: 1, failed: 0, suspect: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(heartbeat.counts()).toEqual({ sent: 1, failed: 1, suspect: true })
    heartbeat.stop()
    hung.resolve()
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
