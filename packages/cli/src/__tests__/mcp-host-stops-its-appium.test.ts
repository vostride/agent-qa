import { describe, expect, it, vi } from 'vitest'

import { closeMcpHost } from '../commands/mcp.js'
import { REMOTE_RELEASE_BOUND_MS } from '../composition/remote-sessions.js'

interface Held {
  readonly promise: Promise<void>
  resolve(): void
}

function held(): Held {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// Every promise job queued before this call has run once it settles.
function jobsRun(): Promise<void> {
  return new Promise((settle) => setImmediate(settle))
}

const STOP_APPIUM = `stop appium within ${String(REMOTE_RELEASE_BOUND_MS)}`

function closeWith(steps: {
  closeHost?: () => Promise<void>
  stopAppium?: () => Promise<void> | undefined
}) {
  const order: string[] = []
  const deps = {
    closeHost: vi.fn(() => {
      order.push('close host')
      return (steps.closeHost ?? (() => Promise.resolve()))()
    }),
    stopAppium: vi.fn((boundMs: number) => {
      order.push(`stop appium within ${String(boundMs)}`)
      return steps.stopAppium?.()
    }),
    settleReporting: vi.fn(() => {
      order.push('settle reporting')
      return Promise.resolve()
    }),
  }
  return { deps, order, done: closeMcpHost(deps) }
}

describe("the MCP host's close", () => {
  it('closes the host, then stops Appium, and settles reporting only once the stop has settled', async () => {
    const closing = held()
    const stopping = held()
    const { order, done } = closeWith({
      closeHost: () => closing.promise,
      stopAppium: () => stopping.promise,
    })
    await jobsRun()
    expect(order).toEqual(['close host'])

    closing.resolve()
    await jobsRun()
    expect(order).toEqual(['close host', STOP_APPIUM])

    stopping.resolve()
    await done
    expect(order).toEqual(['close host', STOP_APPIUM, 'settle reporting'])
  })

  it('stops Appium once, within the remote release bound', async () => {
    const { deps, done } = closeWith({ stopAppium: () => Promise.resolve() })
    await done
    expect(deps.stopAppium).toHaveBeenCalledExactlyOnceWith(REMOTE_RELEASE_BOUND_MS)
  })

  it('still stops Appium and settles reporting when the host fails to close, and does not reject', async () => {
    const { order, done } = closeWith({
      closeHost: () => Promise.reject(new Error('the agent host would not close')),
      stopAppium: () => Promise.resolve(),
    })
    await expect(done).resolves.toBeUndefined()
    expect(order).toEqual(['close host', STOP_APPIUM, 'settle reporting'])
  })

  it('with nothing to stop, settles reporting straight after the host has closed', async () => {
    const closing = held()
    const { deps, order, done } = closeWith({ closeHost: () => closing.promise })
    await jobsRun()
    expect(deps.settleReporting).not.toHaveBeenCalled()

    closing.resolve()
    await jobsRun()
    expect(order).toEqual(['close host', STOP_APPIUM, 'settle reporting'])
    await done
  })
})
