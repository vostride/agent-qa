import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appium = vi.hoisted(() => ({
  built: [] as unknown[],
  events: [] as string[],
  ensureRunning: vi.fn<() => Promise<void>>(),
  getUrl: vi.fn<() => string>(),
  shutdown: vi.fn<() => Promise<void>>(),
  bindMask: vi.fn<(mask: (text: string) => string) => () => void>(),
  releases: [] as Array<ReturnType<typeof vi.fn<() => void>>>,
}))

vi.mock('@vostride/agent-qa-dashboard', () => ({
  AppiumManager: class {
    constructor(options: unknown) {
      appium.built.push(options)
    }
    ensureRunning(): Promise<void> {
      appium.events.push('ensureRunning')
      return appium.ensureRunning()
    }
    bindMask(mask: (text: string) => string): () => void {
      appium.events.push(`bindMask:${mask('secret')}`)
      return appium.bindMask(mask)
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
  appium.events.length = 0
  appium.releases.length = 0
  appium.bindMask.mockReset().mockImplementation(() => {
    const release = vi.fn<() => void>()
    appium.releases.push(release)
    return release
  })
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

  it('after a stop, the next ensure builds a new manager and a second stop without one has nothing to stop', async () => {
    const { ensureProcessAppium, stopProcessAppium } = await freshModule()
    await ensureProcessAppium('normal')

    await stopProcessAppium()
    expect(stopProcessAppium()).toBeUndefined()
    expect(appium.shutdown).toHaveBeenCalledTimes(1)

    await expect(ensureProcessAppium('debug')).resolves.toBe(APPIUM_URL)
    expect(appium.built).toEqual([{ logLevel: 'normal' }, { logLevel: 'debug' }])
    expect(appium.ensureRunning).toHaveBeenCalledTimes(2)
  })

  it("an ensure in flight when the process's Appium is stopped fails with the error of the manager it started on", async () => {
    const { ensureProcessAppium, stopProcessAppium } = await freshModule()
    const start = held()
    appium.ensureRunning.mockReturnValueOnce(start.promise)
    appium.getUrl.mockImplementationOnce(() => {
      throw new Error('Appium is not running')
    })

    const ensuring = ensureProcessAppium('normal')
    await new Promise((resolve) => setImmediate(resolve))
    await stopProcessAppium()
    start.resolve()

    await expect(ensuring).rejects.toThrow('Appium is not running')
    expect(appium.built).toEqual([{ logLevel: 'normal' }])
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

    await ensureProcessAppium('normal')
    appium.shutdown.mockReturnValueOnce(new Promise<void>(() => {}))
    const atBound = watch(stopProcessAppiumWithin(BOUND_MS))
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(atBound.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(atBound.settled).toBe(true)
  })

  describe('the masks a run binds', () => {
    const maskOne = (text: string): string => text.replace('secret', '[secret:ONE]')
    const maskTwo = (text: string): string => text.replace('secret', '[secret:TWO]')

    it("binds the run's mask before it starts Appium", async () => {
      const { ensureProcessAppium } = await freshModule()

      await ensureProcessAppium('debug', maskOne)

      expect(appium.events).toEqual(['bindMask:[secret:ONE]', 'ensureRunning'])
      expect(appium.bindMask).toHaveBeenCalledWith(maskOne)
    })

    it('binds nothing with no mask and still starts Appium', async () => {
      const { ensureProcessAppium } = await freshModule()

      await expect(ensureProcessAppium('normal')).resolves.toBe(APPIUM_URL)

      expect(appium.bindMask).not.toHaveBeenCalled()
      expect(appium.events).toEqual(['ensureRunning'])
    })

    it('binds the mask of each run, releases every one once on stop, and binds again on a new manager', async () => {
      const { ensureProcessAppium, stopProcessAppium } = await freshModule()
      await ensureProcessAppium('debug', maskOne)
      await ensureProcessAppium('debug', maskTwo)
      expect(appium.built).toHaveLength(1)
      expect(appium.bindMask.mock.calls).toEqual([[maskOne], [maskTwo]])
      const [releaseOne, releaseTwo] = appium.releases

      await stopProcessAppium()
      await stopProcessAppium()
      expect(releaseOne).toHaveBeenCalledTimes(1)
      expect(releaseTwo).toHaveBeenCalledTimes(1)

      await ensureProcessAppium('debug', maskOne)
      expect(appium.built).toHaveLength(2)
      expect(appium.bindMask).toHaveBeenCalledTimes(3)
      expect(releaseOne).toHaveBeenCalledTimes(1)
    })

    it('a release that throws stops neither the other releases nor the shutdown', async () => {
      const { ensureProcessAppium, stopProcessAppium } = await freshModule()
      await ensureProcessAppium('debug', maskOne)
      await ensureProcessAppium('debug', maskTwo)
      const [releaseOne, releaseTwo] = appium.releases
      releaseOne?.mockImplementation(() => {
        throw new Error('release failed')
      })

      await stopProcessAppium()

      expect(releaseOne).toHaveBeenCalledTimes(1)
      expect(releaseTwo).toHaveBeenCalledTimes(1)
      expect(appium.shutdown).toHaveBeenCalledTimes(1)
    })
  })
})
