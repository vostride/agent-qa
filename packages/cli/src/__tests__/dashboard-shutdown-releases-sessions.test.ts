import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shutdownDashboard } from '../commands/dashboard.js'
import type { DashboardShutdownDeps } from '../commands/dashboard.js'
import { REMOTE_RELEASE_BOUND_MS } from '../commands/run.js'

interface Held {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

function held(): Held {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function shutdownWith(waits: {
  cleanupSessions?: () => Promise<void>
  releaseRemoteSessions?: () => Promise<void>
  close?: () => Promise<void>
  stopAppium?: () => Promise<void>
  exit?: () => Promise<void>
}) {
  const order: string[] = []
  const deps: DashboardShutdownDeps = {
    close: vi.fn(() => {
      order.push('close')
      return waits.close?.()
    }),
    closeMcp: vi.fn(() => {
      order.push('close mcp')
    }),
    dispose: vi.fn(() => {
      order.push('dispose')
    }),
    cleanupSessions: vi.fn((boundMs: number) => {
      order.push(`clean up sessions within ${String(boundMs)}`)
      return (waits.cleanupSessions ?? (() => Promise.resolve()))()
    }),
    releaseRemoteSessions: vi.fn((boundMs: number) => {
      order.push(`release remotes within ${String(boundMs)}`)
      return (waits.releaseRemoteSessions ?? (() => Promise.resolve()))()
    }),
    stopAppium: vi.fn((_boundMs: number) => waits.stopAppium?.()),
    exit: vi.fn((code: number) => {
      order.push(`exit ${String(code)}`)
      return waits.exit?.()
    }),
  }
  return { deps, order, done: shutdownDashboard(deps) }
}

describe("the dashboard's shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts both waits before it closes anything, and exits only after both settle', async () => {
    const cleanup = held()
    const release = held()
    const { deps, order, done } = shutdownWith({
      cleanupSessions: () => cleanup.promise,
      releaseRemoteSessions: () => release.promise,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual([
      `clean up sessions within ${String(REMOTE_RELEASE_BOUND_MS)}`,
      `release remotes within ${String(REMOTE_RELEASE_BOUND_MS)}`,
    ])

    cleanup.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.close).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()

    release.resolve()
    await done
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
  })

  it('exits 0 half a second past the bound when a wait never settles, and not before', async () => {
    const { deps, order, done } = shutdownWith({
      cleanupSessions: () => new Promise<void>(() => undefined),
    })
    await vi.advanceTimersByTimeAsync(REMOTE_RELEASE_BOUND_MS)
    expect(deps.close).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(499)
    expect(deps.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
  })

  it('treats a rejected or throwing wait as settled and still exits 0 at once', async () => {
    const rejected = shutdownWith({
      releaseRemoteSessions: () => Promise.reject(new Error('the remote never answered')),
    })
    await rejected.done
    expect(rejected.deps.exit).toHaveBeenCalledExactlyOnceWith(0)

    const thrown = shutdownWith({
      cleanupSessions: () => {
        throw new Error('the session manager is gone')
      },
    })
    await thrown.done
    expect(thrown.deps.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns only once the exit it is handed has finished', async () => {
    const exiting = held()
    const { order, done } = shutdownWith({ exit: () => exiting.promise })
    let returned = false
    void done.then(() => {
      returned = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
    expect(returned).toBe(false)

    exiting.resolve()
    await done
    expect(returned).toBe(true)
  })

  it('with nothing open, exits at once and leaves no timer behind', async () => {
    const { deps, order, done } = shutdownWith({})
    await done
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("waits for the server's close to settle before it closes the MCP listener and exits", async () => {
    const closing = held()
    const { deps, order, done } = shutdownWith({ close: () => closing.promise })
    await vi.advanceTimersByTimeAsync(0)
    expect(order.slice(2)).toEqual(['close'])
    expect(deps.closeMcp).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()

    closing.resolve()
    await done
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
  })

  it("goes on and exits 0 once the bound has passed when the server's close never settles", async () => {
    const { deps, order, done } = shutdownWith({ close: () => new Promise<void>(() => undefined) })
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.close).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(REMOTE_RELEASE_BOUND_MS - 1)
    expect(deps.exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(order.slice(2)).toEqual(['close', 'close mcp', 'dispose', 'exit 0'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops the process's Appium once, within the bound, after the first waits, and exits once it stops", async () => {
    const cleanup = held()
    const release = held()
    const stopping = held()
    const { deps, done } = shutdownWith({
      cleanupSessions: () => cleanup.promise,
      releaseRemoteSessions: () => release.promise,
      stopAppium: () => stopping.promise,
    })
    cleanup.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.stopAppium).not.toHaveBeenCalled()

    release.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.stopAppium).toHaveBeenCalledExactlyOnceWith(REMOTE_RELEASE_BOUND_MS)
    expect(deps.exit).not.toHaveBeenCalled()

    stopping.resolve()
    await done
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0)
  })
})
