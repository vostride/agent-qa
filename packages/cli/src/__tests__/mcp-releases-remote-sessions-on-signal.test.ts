import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { listenForStopSignal } from '../commands/mcp.js'
import { REMOTE_RELEASE_BOUND_MS } from '../composition/remote-sessions.js'

function signalSource(): EventEmitter & { count(): number } {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    count: () => emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM'),
  })
}

describe('an MCP host stopped by a signal', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'releases every remote session at once on %s and stops serving',
    async (signal) => {
      const signals = signalSource()
      let release: () => void = () => undefined
      const releasing = new Promise<void>((settle) => {
        release = settle
      })
      const releaseSessions = vi.fn((_boundMs: number) => releasing)
      const stop = listenForStopSignal(signals, releaseSessions)
      expect(stop.signalled()).toBe(false)

      signals.emit(signal)

      await stop.stopped
      expect(stop.signalled()).toBe(true)
      expect(releaseSessions).toHaveBeenCalledWith(REMOTE_RELEASE_BOUND_MS)
      let released = false
      void stop.released().then(() => {
        released = true
      })
      await Promise.resolve()
      expect(released).toBe(false)
      release()
      await stop.released()
      expect(released).toBe(true)
    },
  )

  it('leaves a second signal to end the process and starts one release only', () => {
    const signals = signalSource()
    const releaseSessions = vi.fn(async (_boundMs: number) => undefined)
    listenForStopSignal(signals, releaseSessions)

    signals.emit('SIGTERM')

    expect(signals.count()).toBe(0)
    expect(releaseSessions).toHaveBeenCalledTimes(1)
  })

  it('a release that fails still lets the host exit', async () => {
    const signals = signalSource()
    const stop = listenForStopSignal(signals, () => Promise.reject(new Error('remote silent')))

    signals.emit('SIGINT')

    await expect(stop.released()).resolves.toBeUndefined()
  })

  it('a host that stops without a signal releases nothing and keeps no listener', () => {
    const signals = signalSource()
    const releaseSessions = vi.fn(async (_boundMs: number) => undefined)
    const stop = listenForStopSignal(signals, releaseSessions)

    stop.detach()

    expect(signals.count()).toBe(0)
    expect(stop.signalled()).toBe(false)
    expect(releaseSessions).not.toHaveBeenCalled()
  })
})
