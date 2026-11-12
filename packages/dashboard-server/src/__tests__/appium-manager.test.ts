import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import type { AppiumServer, StartAppiumServerOptions } from '@vostride/agent-qa-appium-runtime'

vi.mock('picocolors', () => ({
  default: {
    magenta: (s: string) => `[magenta]${s}[/magenta]`,
    green: (s: string) => `[green]${s}[/green]`,
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    dim: (s: string) => `[dim]${s}[/dim]`,
  },
}))

import { AppiumManager } from '../execution/appium-manager.js'

interface FakeServer extends AppiumServer {
  readonly stop: Mock<() => Promise<void>>
  end(): void
}

// Its stop ends it, as the runtime's does; end() stands for a server that ends on its own.
function fakeServer(port: number): FakeServer {
  let settleExited = (): void => {}
  const exited = new Promise<void>((settle) => {
    settleExited = settle
  })
  return {
    url: `http://127.0.0.1:${port}`,
    exited,
    stop: vi.fn(async () => settleExited()),
    end: () => settleExited(),
  }
}

// Each start hands out a new fake server, the first on port 47231.
function managerWith(logLevel?: 'normal' | 'debug') {
  const servers: FakeServer[] = []
  const start = vi.fn(async (_options: StartAppiumServerOptions): Promise<AppiumServer> => {
    const server = fakeServer(47231 + servers.length)
    servers.push(server)
    return server
  })
  const mgr = new AppiumManager({ startAppium: start, logLevel })
  return { mgr, start, servers }
}

// The server's stop settles only once the returned function is called.
function stopLate(server: FakeServer): () => void {
  let finish = (): void => {}
  server.stop.mockImplementation(
    () =>
      new Promise<void>((settle) => {
        finish = () => {
          server.end()
          settle()
        }
      }),
  )
  return () => finish()
}

function flushQueue(): Promise<void> {
  return new Promise((settle) => setImmediate(settle))
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppiumManager', () => {
  describe('ensureRunning', () => {
    it('concurrent ensureRunning calls coalesce', async () => {
      const { mgr, start } = managerWith()

      await Promise.all([mgr.ensureRunning(), mgr.ensureRunning()])

      expect(start).toHaveBeenCalledTimes(1)
    })

    it('a second ensureRunning while a server is held starts nothing', async () => {
      const { mgr, start } = managerWith()

      await mgr.ensureRunning()
      await mgr.ensureRunning()

      expect(start).toHaveBeenCalledTimes(1)
    })

    it('a start that rejects makes ensureRunning reject with its error and holds no server, so the next call starts again', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failure = new Error(
        'Appium exited before it was ready (exit code 1)\nthe last line Appium printed',
      )
      const { mgr, start } = managerWith()
      start.mockRejectedValueOnce(failure)

      await expect(mgr.ensureRunning()).rejects.toBe(failure)
      expect(() => mgr.getUrl()).toThrow('Appium is not running')
      expect(logSpy).not.toHaveBeenCalled()
      expect(errSpy).not.toHaveBeenCalled()

      await mgr.ensureRunning()
      expect(start).toHaveBeenCalledTimes(2)
      expect(mgr.getUrl()).toBe('http://127.0.0.1:47231')
    })

    it('when the held server ends on its own, the next ensureRunning starts a new one', async () => {
      const { mgr, start, servers } = managerWith()
      await mgr.ensureRunning()

      servers[0].end()
      await flushQueue()
      await mgr.ensureRunning()

      expect(start).toHaveBeenCalledTimes(2)
      expect(mgr.getUrl()).toBe(servers[1].url)
    })
  })

  describe('getUrl', () => {
    it("is the started server's URL", async () => {
      const { mgr, servers } = managerWith()

      await mgr.ensureRunning()

      expect(mgr.getUrl()).toBe('http://127.0.0.1:47231')
      expect(mgr.getUrl()).toBe(servers[0].url)
    })

    it('throws before any start', () => {
      const { mgr } = managerWith()

      expect(() => mgr.getUrl()).toThrow('Appium is not running')
    })
  })

  describe('shutdown', () => {
    it('shutdown with no server held starts and stops nothing', async () => {
      const { mgr, start } = managerWith()

      await mgr.shutdown()

      expect(start).not.toHaveBeenCalled()
    })

    it('shutdown is safe to call multiple times', async () => {
      const { mgr, servers } = managerWith()
      await mgr.ensureRunning()

      await Promise.all([mgr.shutdown(), mgr.shutdown(), mgr.shutdown()])

      expect(servers[0].stop).toHaveBeenCalledTimes(1)
    })

    it('shutdown stops the server while a lease remains, and drops the leases', async () => {
      const { mgr, servers } = managerWith()
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      await mgr.shutdown()

      expect(servers[0].stop).toHaveBeenCalledTimes(1)
      expect(() => mgr.getUrl()).toThrow('Appium is not running')
      expect(mgr.releaseLease('run_ios_1', 'completed')).toBe(false)
    })

    it("the promise shutdown returns settles only after the server's stop settles", async () => {
      const { mgr, servers } = managerWith()
      await mgr.ensureRunning()
      const finishStop = stopLate(servers[0])
      let settled = false

      const done = mgr.shutdown().then(() => {
        settled = true
      })
      await flushQueue()

      expect(servers[0].stop).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      finishStop()
      await done
      expect(settled).toBe(true)
    })

    it('a shutdown after the last lease release settles only after the stop that release began', async () => {
      const { mgr, servers } = managerWith()
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      const finishStop = stopLate(servers[0])
      mgr.releaseLease('run_android_1', 'completed')
      let settled = false

      const done = mgr.shutdown().then(() => {
        settled = true
      })
      await flushQueue()

      expect(servers[0].stop).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      finishStop()
      await done
      expect(settled).toBe(true)
    })
  })

  describe('leases', () => {
    it('a lease release keeps the server while another run holds a lease', async () => {
      const { mgr, servers } = managerWith()
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      const released = mgr.releaseLease('run_android_1', 'completed')

      expect(released).toBe(true)
      expect(servers[0].stop).not.toHaveBeenCalled()
      expect(mgr.getUrl()).toBe(servers[0].url)
    })

    it('the last lease release stops the server', async () => {
      const { mgr, servers } = managerWith()
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })

      const released = mgr.releaseLease('run_android_1', 'completed')

      expect(released).toBe(true)
      expect(servers[0].stop).toHaveBeenCalledTimes(1)
    })

    it('a lease release for a run that holds none returns false and stops nothing', async () => {
      const { mgr, servers } = managerWith()
      await mgr.ensureRunning()

      const released = mgr.releaseLease('missing-run', 'completed')

      expect(released).toBe(false)
      expect(servers[0].stop).not.toHaveBeenCalled()
    })

    it('duplicate acquireLease for the same run does not double count', async () => {
      const { mgr, servers } = managerWith()

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      mgr.releaseLease('run_android_1', 'completed')

      expect(servers[0].stop).toHaveBeenCalledTimes(1)
    })
  })

  describe('log gating', () => {
    it('suppresses stdout at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('normal')
      await mgr.ensureRunning()
      logSpy.mockClear()
      start.mock.calls[0][0].onOutput!('some appium traffic\n', 'stdout')
      const stdoutCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(stdoutCalls).toHaveLength(0)
    })

    it('suppresses stderr at normal logLevel', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('normal')
      await mgr.ensureRunning()
      errSpy.mockClear()
      start.mock.calls[0][0].onOutput!('some warning\n', 'stderr')
      const stderrCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(stderrCalls).toHaveLength(0)
    })

    it('shows stdout with colored prefix at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()
      start.mock.calls[0][0].onOutput!('debug traffic line\n', 'stdout')
      const dimCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(dimCalls.length).toBeGreaterThan(0)
      expect(String(dimCalls[0][0])).toContain('[magenta]')
    })

    it('shows stderr with colored prefix at debug logLevel', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      errSpy.mockClear()
      start.mock.calls[0][0].onOutput!('warning line\n', 'stderr')
      const dimCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(dimCalls.length).toBeGreaterThan(0)
      expect(String(dimCalls[0][0])).toContain('[magenta]')
    })

    describe('forwarded output under GitHub Actions', () => {
      const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
      let writes: string[]

      beforeEach(() => {
        writes = []
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
          writes.push(String(chunk))
          return true
        })
      })

      afterEach(() => {
        vi.unstubAllEnvs()
      })

      it('prints a forwarded stdout line inside one pair on stdout', async () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true')
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const { mgr, start } = managerWith('debug')
        await mgr.ensureRunning()
        logSpy.mockClear()
        writes.length = 0

        start.mock.calls[0][0].onOutput!('##[error]x\n', 'stdout')

        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatch(PAIR)
        expect(writes[0]).toContain('##[error]x')
        expect(logSpy).not.toHaveBeenCalled()
      })

      it('prints a forwarded stderr line inside one pair on stdout', async () => {
        vi.stubEnv('GITHUB_ACTIONS', 'true')
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        const { mgr, start } = managerWith('debug')
        await mgr.ensureRunning()
        writes.length = 0

        start.mock.calls[0][0].onOutput!('##[error]x\n', 'stderr')

        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatch(PAIR)
        expect(writes[0]).toContain('##[error]x')
        expect(errSpy).not.toHaveBeenCalled()
      })

      it('prints forwarded lines through console off Actions', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { mgr, start } = managerWith('debug')
        await mgr.ensureRunning()
        logSpy.mockClear()

        start.mock.calls[0][0].onOutput!('out line\n', 'stdout')
        start.mock.calls[0][0].onOutput!('err line\n', 'stderr')

        expect(logSpy.mock.calls).toEqual([['[magenta][appium][/magenta] [dim]out line[/dim]']])
        expect(errSpy.mock.calls).toEqual([['[magenta][appium][/magenta] [dim]err line[/dim]']])
        expect(writes).toHaveLength(0)
      })
    })

    it('constructor defaults logLevel to normal', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { mgr, start } = managerWith()
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('out line\n', 'stdout')
      start.mock.calls[0][0].onOutput!('err line\n', 'stderr')

      expect(logSpy).not.toHaveBeenCalled()
      expect(errSpy).not.toHaveBeenCalled()
    })

    it('constructor accepts logLevel debug', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('first line\n\nsecond line\n', 'stdout')

      expect(logSpy.mock.calls).toEqual([
        ['[magenta][appium][/magenta] [dim]first line[/dim]'],
        ['[magenta][appium][/magenta] [dim]second line[/dim]'],
      ])
    })
  })

  describe('lifecycle messages', () => {
    it('prints started lifecycle message at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('normal')
      await mgr.ensureRunning()
      const startedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[green]'))
      expect(startedCalls).toHaveLength(1)
      expect(String(startedCalls[0][0])).toContain('started on :47231')
      expect(String(startedCalls[0][0])).toContain('[magenta]')
    })

    it('prints started lifecycle message at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('debug')
      await mgr.ensureRunning()
      const startedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[green]'))
      expect(startedCalls).toHaveLength(1)
      expect(String(startedCalls[0][0])).toContain('started on :47231')
    })

    it('prints stopped lifecycle message at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('normal')
      await mgr.ensureRunning()
      logSpy.mockClear()
      await mgr.shutdown()
      const stoppedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[yellow]'))
      expect(stoppedCalls).toHaveLength(1)
      expect(String(stoppedCalls[0][0])).toContain('stopped')
      expect(String(stoppedCalls[0][0])).toContain('[magenta]')
    })

    it('prints stopped lifecycle message at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()
      await mgr.shutdown()
      const stoppedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[yellow]'))
      expect(stoppedCalls).toHaveLength(1)
      expect(String(stoppedCalls[0][0])).toContain('stopped')
    })

    it('prints ownership lease details', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('normal')
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })
      mgr.releaseLease('run_android_1', 'completed')

      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('lease acquired')
      expect(output).toContain('run=run_android_1')
      expect(output).toContain('platform=android')
      expect(output).toContain('leases=1')
      expect(output).toContain('lease released')
      expect(output).toContain('reason=completed')
      expect(output).toContain('server kept alive leases=1')
    })
  })
})
