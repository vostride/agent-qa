import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import type { AppiumServer, StartAppiumServerOptions } from '@vostride/agent-qa-appium-runtime'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'

import { AppiumManager } from '../execution/appium-manager.js'

const TAGGED = /^\d\d:\d\d:\d\d {2}appium {5}/u

// The text after the time and the tag; a line without them is returned whole, so it cannot match.
function messages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => {
    const text = String(call[0])
    return TAGGED.test(text) ? text.replace(TAGGED, '') : text
  })
}

function maskFor(name: string, value: string): (text: string) => string {
  const redactor = new SecretRedactor(new SecretStore({ [name]: value }))
  return (text) => redactor.redactString(text)
}

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

// The next start settles only once one of the returned functions is called.
function startLate(start: ReturnType<typeof managerWith>['start']): {
  finish(server: AppiumServer): void
  fail(error: Error): void
} {
  let finish = (_server: AppiumServer): void => {}
  let fail = (_error: Error): void => {}
  start.mockImplementationOnce(
    () =>
      new Promise<AppiumServer>((settle, reject) => {
        finish = settle
        fail = reject
      }),
  )
  return { finish: (server) => finish(server), fail: (error) => fail(error) }
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

    it('a shutdown asked for while a start is in flight settles only after that server has been stopped, and stops it once', async () => {
      const { mgr, start } = managerWith()
      const server = fakeServer(47231)
      const finishStop = stopLate(server)
      const starting = startLate(start)
      const running = mgr.ensureRunning()
      let settled = false

      const done = mgr.shutdown().then(() => {
        settled = true
      })
      await flushQueue()
      expect(settled).toBe(false)
      expect(server.stop).not.toHaveBeenCalled()

      starting.finish(server)
      await running
      await flushQueue()
      expect(server.stop).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)

      finishStop()
      await done
      expect(server.stop).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      expect(() => mgr.getUrl()).toThrow('Appium is not running')
    })

    it('a shutdown asked for while a start is in flight settles once that start has failed', async () => {
      const { mgr, start } = managerWith()
      const failure = new Error('Appium exited before it was ready (exit code 1)')
      const starting = startLate(start)
      const running = mgr.ensureRunning()
      let settled = false

      const done = mgr.shutdown().then(() => {
        settled = true
      })
      await flushQueue()
      expect(settled).toBe(false)

      starting.fail(failure)
      await expect(running).rejects.toBe(failure)
      await done
      expect(start).toHaveBeenCalledTimes(1)
    })

    it('an ensureRunning after shutdown rejects and starts nothing', async () => {
      const { mgr, start } = managerWith()
      await mgr.ensureRunning()
      await mgr.shutdown()

      await expect(mgr.ensureRunning()).rejects.toThrow('Appium is shut down')
      await expect(
        mgr.acquireLease({ runId: 'run_android_1', platform: 'android' }),
      ).rejects.toThrow('Appium is shut down')
      expect(start).toHaveBeenCalledTimes(1)
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

    it('a lease taken after the last lease release starts a new server', async () => {
      const { mgr, start, servers } = managerWith()
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      mgr.releaseLease('run_android_1', 'completed')

      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      expect(start).toHaveBeenCalledTimes(2)
      expect(mgr.getUrl()).toBe(servers[1].url)
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
    it('prints nothing Appium writes at the normal level, on either stream', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { mgr, start } = managerWith('normal')
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('some appium traffic\n', 'stdout')
      start.mock.calls[0][0].onOutput!('some warning\n', 'stderr')
      start.mock.calls[0][0].onOutput!('an unfinished line', 'stdout')
      await mgr.shutdown()

      expect(messages(logSpy)).toEqual(['Stopped'])
      expect(errSpy).not.toHaveBeenCalled()
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

    it('prints no lease line at the normal level', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('normal')

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })
      mgr.releaseLease('run_android_1', 'completed')
      mgr.releaseLease('run_ios_1', 'cancelled')

      expect(messages(logSpy)).toEqual(['Started on :47231', 'Stopped'])
    })

    it('prints the lease lines at debug with their values as data', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = managerWith('debug')

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })
      mgr.releaseLease('run_android_1', 'completed')
      mgr.releaseLease('run_ios_1', 'cancelled')

      expect(messages(logSpy)).toEqual([
        'Started on :47231',
        'Lease acquired run="run_android_1" platform="android" leases=1',
        'Lease acquired run="run_ios_1" platform="ios" leases=2',
        'Lease released run="run_android_1" platform="android" reason="completed" leases=1',
        'Server kept alive leases=1',
        'Lease released run="run_ios_1" platform="ios" reason="cancelled" leases=0',
        'Stopped',
      ])
    })

    it('prints a forwarded stdout line to console.log and a stderr line to console.error at debug', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('out line\n', 'stdout')
      start.mock.calls[0][0].onOutput!('err line\n', 'stderr')

      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(String(logSpy.mock.calls[0][0])).toMatch(TAGGED)
      expect(String(errSpy.mock.calls[0][0])).toMatch(TAGGED)
      expect(messages(logSpy)).toEqual(['out line'])
      expect(messages(errSpy)).toEqual(['err line'])
    })

    it('prints each line of a chunk with three line breaks, and skips empty lines', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('first line\nsecond line\n\nthird line\r\n', 'stdout')

      expect(messages(logSpy)).toEqual(['first line', 'second line', 'third line'])
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
        expect(writes[0]).toMatch(/\n\d\d:\d\d:\d\d {2}appium {5}##\[error\]x\n/u)
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
        expect(writes[0]).toMatch(/\n\d\d:\d\d:\d\d {2}appium {5}##\[error\]x\n/u)
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

        expect(messages(logSpy)).toEqual(['out line'])
        expect(messages(errSpy)).toEqual(['err line'])
        expect(writes).toHaveLength(0)
      })
    })
  })

  describe('masking forwarded output', () => {
    const SECRET = 'made-up-device-pw-41c7'
    const sessionLine = (password: string): string =>
      `[HTTP] --> POST /session {"capabilities":{"alwaysMatch":{"appium:password":"${password}"}}}`

    it("prints a new-session request with a declared secret's placeholder and not its value", async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!(`${sessionLine(SECRET)}\n`, 'stdout')

      expect(messages(logSpy)).toEqual([sessionLine('[secret:DEVICE_PASSWORD]')])
      expect(logSpy.mock.calls.flat().join('\n').includes(SECRET)).toBe(false)
    })

    it('applies two masks bound at once to one line', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      mgr.bindMask(maskFor('DEVICE_TOKEN', 'made-up-token-9a2b'))
      await mgr.ensureRunning()

      start.mock.calls[0][0].onOutput!(`token made-up-token-9a2b and ${SECRET}\n`, 'stderr')

      expect(messages(errSpy)).toEqual(['token [secret:DEVICE_TOKEN] and [secret:DEVICE_PASSWORD]'])
    })

    it('stops applying a mask once its release is called, while a mask still bound applies', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      const release = mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      mgr.bindMask(maskFor('DEVICE_TOKEN', 'made-up-token-9a2b'))
      await mgr.ensureRunning()
      logSpy.mockClear()

      release()
      start.mock.calls[0][0].onOutput!(`${SECRET} made-up-token-9a2b\n`, 'stdout')

      expect(messages(logSpy)).toEqual([`${SECRET} [secret:DEVICE_TOKEN]`])
    })

    it('holds a line cut inside the secret until its line break, then prints it once, whole and masked', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      await mgr.ensureRunning()
      logSpy.mockClear()
      const line = sessionLine(SECRET)
      const cut = line.indexOf(SECRET) + 8

      start.mock.calls[0][0].onOutput!(line.slice(0, cut), 'stdout')
      expect(logSpy).not.toHaveBeenCalled()

      start.mock.calls[0][0].onOutput!(`${line.slice(cut)}\nnext`, 'stdout')
      expect(messages(logSpy)).toEqual([sessionLine('[secret:DEVICE_PASSWORD]')])
    })

    it('keeps the unfinished end of each stream apart', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!('out be', 'stdout')
      start.mock.calls[0][0].onOutput!('err be', 'stderr')
      start.mock.calls[0][0].onOutput!('gins\n', 'stdout')
      start.mock.calls[0][0].onOutput!('gins\n', 'stderr')

      expect(messages(logSpy)).toEqual(['out begins'])
      expect(messages(errSpy)).toEqual(['err begins'])
    })

    it('prints the unfinished end of a stream, masked, when the server ends', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start, servers } = managerWith('debug')
      mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      await mgr.ensureRunning()

      start.mock.calls[0][0].onOutput!(`last words ${SECRET}`, 'stderr')
      expect(errSpy).not.toHaveBeenCalled()

      servers[0].end()
      await flushQueue()
      expect(messages(errSpy)).toEqual(['last words [secret:DEVICE_PASSWORD]'])
    })

    it('prints the unfinished end of a stream, masked, when the manager shuts down', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr, start } = managerWith('debug')
      mgr.bindMask(maskFor('DEVICE_PASSWORD', SECRET))
      await mgr.ensureRunning()
      logSpy.mockClear()

      start.mock.calls[0][0].onOutput!(`last words ${SECRET}`, 'stdout')
      await mgr.shutdown()
      await flushQueue()

      expect(messages(logSpy)).toContain('last words [secret:DEVICE_PASSWORD]')
      expect(messages(logSpy)).toContain('Stopped')
      expect(logSpy.mock.calls.flat().join('\n').includes(SECRET)).toBe(false)
    })
  })

  describe('lifecycle messages', () => {
    it.each(['normal', 'debug'] as const)(
      'prints Started on the port and Stopped through console.log at the %s level',
      async (logLevel) => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { mgr } = managerWith(logLevel)

        await mgr.ensureRunning()
        expect(messages(logSpy)).toEqual(['Started on :47231'])
        await mgr.shutdown()

        expect(messages(logSpy)).toEqual(['Started on :47231', 'Stopped'])
        expect(logSpy.mock.calls.every((call) => TAGGED.test(String(call[0])))).toBe(true)
        expect(errSpy).not.toHaveBeenCalled()
      },
    )
  })
})

