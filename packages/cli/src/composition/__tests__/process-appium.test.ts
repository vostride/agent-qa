import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appium = vi.hoisted(() => ({
  built: [] as unknown[],
  ensureRunning: vi.fn<() => Promise<void>>(),
  getUrl: vi.fn<() => string>(),
  shutdown: vi.fn<() => Promise<void>>(),
}))

vi.mock('@vostride/agent-qa-dashboard', () => ({
  AppiumManager: class {
    constructor(options: unknown) {
      appium.built.push(options)
    }
    ensureRunning(): Promise<void> {
      return appium.ensureRunning()
    }
    getUrl(): string {
      return appium.getUrl()
    }
    shutdown(): Promise<void> {
      return appium.shutdown()
    }
  },
}))

const APPIUM_URL = 'http://127.0.0.1:47231'
const BOUND_MS = 2_000

// The module holds the process's manager, so each test loads a copy of its own.
async function freshModule(): Promise<typeof import('../process-appium.js')> {
  vi.resetModules()
  return import('../process-appium.js')
}

function held(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function watch(promise: Promise<void> | undefined): { readonly settled: boolean } {
  const state = { settled: false }
  void promise?.then(() => {
    state.settled = true
  })
  return state
}

beforeEach(() => {
  appium.built.length = 0
  appium.ensureRunning.mockReset().mockResolvedValue(undefined)
  appium.getUrl.mockReset().mockReturnValue(APPIUM_URL)
  appium.shutdown.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the process's Appium", () => {
  it('has nothing to stop and waits for nothing before anything asked for Appium', async () => {
    const { stopProcessAppium, stopProcessAppiumWithin } = await freshModule()

    expect(stopProcessAppium()).toBeUndefined()
    expect(stopProcessAppiumWithin(BOUND_MS)).toBeUndefined()
    expect(appium.built).toEqual([])
    expect(appium.ensureRunning).not.toHaveBeenCalled()
    expect(appium.getUrl).not.toHaveBeenCalled()
    expect(appium.shutdown).not.toHaveBeenCalled()
  })

  it("makes sure the server runs each time it is asked, on one manager, and returns that manager's URL", async () => {
    const { ensureProcessAppium } = await freshModule()

    await expect(ensureProcessAppium('debug')).resolves.toBe(APPIUM_URL)
    await expect(ensureProcessAppium('debug')).resolves.toBe(APPIUM_URL)
    expect(appium.built).toEqual([{ logLevel: 'debug' }])
    expect(appium.ensureRunning).toHaveBeenCalledTimes(2)
  })

  it("stopping after a start settles only once the manager's shutdown has settled", async () => {
    const { ensureProcessAppium, stopProcessAppium } = await freshModule()
    await ensureProcessAppium('normal')
    const shutdown = held()
    appium.shutdown.mockReturnValueOnce(shutdown.promise)

    const stopping = stopProcessAppium()
    expect(stopping).toBeInstanceOf(Promise)
    const state = watch(stopping)
    await new Promise((resolve) => setImmediate(resolve))
    expect(appium.shutdown).toHaveBeenCalledTimes(1)
    expect(state.settled).toBe(false)

    shutdown.resolve()
    await stopping
    expect(state.settled).toBe(true)
  })

  it('stopping within a bound settles with the shutdown, or once the bound has passed when the shutdown never settles', async () => {
    const { ensureProcessAppium, stopProcessAppiumWithin } = await freshModule()
    await ensureProcessAppium('normal')
    vi.useFakeTimers()

    const shutdown = held()
    appium.shutdown.mockReturnValueOnce(shutdown.promise)
    const withShutdown = watch(stopProcessAppiumWithin(BOUND_MS))
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(withShutdown.settled).toBe(false)
    shutdown.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(withShutdown.settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    appium.shutdown.mockReturnValueOnce(new Promise<void>(() => {}))
    const atBound = watch(stopProcessAppiumWithin(BOUND_MS))
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(atBound.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(atBound.settled).toBe(true)
  })
})
