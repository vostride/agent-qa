import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRemoteSessionRegistry, REMOTE_RELEASE_BOUND_MS } from '../remote.js'

describe('the remote session registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts every registered release at once, each handed the bound', async () => {
    const registry = createRemoteSessionRegistry()
    const started: Array<{ name: string; boundMs: number }> = []
    const finish: Array<() => void> = []
    for (const name of ['first', 'second', 'third']) {
      registry.register((boundMs) => {
        started.push({ name, boundMs })
        return new Promise<void>((resolve) => finish.push(resolve))
      })
    }

    let settled = false
    const releasing = registry.releaseAll(REMOTE_RELEASE_BOUND_MS).then(() => {
      settled = true
    })

    expect(started).toEqual([
      { name: 'first', boundMs: REMOTE_RELEASE_BOUND_MS },
      { name: 'second', boundMs: REMOTE_RELEASE_BOUND_MS },
      { name: 'third', boundMs: REMOTE_RELEASE_BOUND_MS },
    ])
    for (const resolve of finish) resolve()
    await releasing
    expect(settled).toBe(true)
  })

  it('settles at the bound when a release never answers, without waiting for it', async () => {
    const registry = createRemoteSessionRegistry()
    let healthyDone = false
    registry.register(() => new Promise<void>(() => {}))
    registry.register(async () => {
      healthyDone = true
    })

    let settled = false
    const releasing = registry.releaseAll(2_000).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(1_999)
    expect(healthyDone).toBe(true)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await releasing
    expect(settled).toBe(true)
  })

  it('never throws when a release rejects or throws', async () => {
    const registry = createRemoteSessionRegistry()
    registry.register(() => Promise.reject(new Error('the remote refused the close')))
    registry.register(() => {
      throw new Error('thrown before any promise')
    })

    await expect(registry.releaseAll(2_000)).resolves.toBeUndefined()
  })

  it('does not call a release that was unregistered', async () => {
    const registry = createRemoteSessionRegistry()
    const called: string[] = []
    const unregister = registry.register(async () => {
      called.push('gone')
    })
    registry.register(async () => {
      called.push('open')
    })

    unregister()
    await registry.releaseAll(2_000)

    expect(called).toEqual(['open'])
  })

  it('releases a session once, so a second releaseAll calls nothing', async () => {
    const registry = createRemoteSessionRegistry()
    let calls = 0
    registry.register(async () => {
      calls += 1
    })

    await registry.releaseAll(2_000)
    await registry.releaseAll(2_000)

    expect(calls).toBe(1)
  })

  it('resolves at once with no timer when nothing is open', async () => {
    const registry = createRemoteSessionRegistry()

    await registry.releaseAll(2_000)

    expect(vi.getTimerCount()).toBe(0)
  })
})
