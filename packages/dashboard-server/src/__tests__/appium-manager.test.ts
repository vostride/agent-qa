import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ClientRequest } from 'node:http'
import { EventEmitter, Readable } from 'node:stream'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('node:http', () => ({
  request: vi.fn(),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn((_pid, _signal, cb) => cb?.()),
}))

vi.mock('picocolors', () => ({
  default: {
    magenta: (s: string) => `[magenta]${s}[/magenta]`,
    green: (s: string) => `[green]${s}[/green]`,
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    dim: (s: string) => `[dim]${s}[/dim]`,
  },
}))

import { AppiumManager } from '../execution/appium-manager.js'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import treeKill from 'tree-kill'

const mockSpawn = vi.mocked(spawn)
const mockRequest = vi.mocked(request)
const mockTreeKill = vi.mocked(treeKill)

function mockHttpResponse(body: string, statusCode = 200): void {
  mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
    const res = new Readable({ read() {} }) as unknown as IncomingMessage
    ;(res as unknown as { statusCode: number }).statusCode = statusCode
    const req = new EventEmitter() as unknown as ClientRequest
    ;(req as unknown as { end: () => void }).end = () => {
      if (callback) callback(res)
      ;(res as unknown as Readable).push(body)
      ;(res as unknown as Readable).push(null)
    }
    ;(req as unknown as { destroy: () => void }).destroy = () => {}
    return req
  }) as any)
}

function mockHttpError(): void {
  mockRequest.mockImplementation(((_opts: unknown, _callback?: unknown) => {
    const req = new EventEmitter() as unknown as ClientRequest
    ;(req as unknown as { end: () => void }).end = () => {
      process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
    }
    ;(req as unknown as { destroy: () => void }).destroy = () => {}
    return req
  }) as any)
}

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess
  ;(child as unknown as { pid: number }).pid = 12345
  ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
  ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
  ;(child as unknown as { kill: () => void }).kill = vi.fn()
  return child
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AppiumManager', () => {
  describe('checkStatus', () => {
    it('returns false when no server is running', async () => {
      mockHttpError()
      const mgr = new AppiumManager()
      expect(await mgr.checkStatus()).toBe(false)
    })

    it('returns true for healthy Appium response', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()
      expect(await mgr.checkStatus()).toBe(true)
    })

    it('returns false for unhealthy response', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: false } }))
      const mgr = new AppiumManager()
      expect(await mgr.checkStatus()).toBe(false)
    })

    it('returns false for invalid JSON', async () => {
      mockHttpResponse('not json')
      const mgr = new AppiumManager()
      expect(await mgr.checkStatus()).toBe(false)
    })
  })

  describe('ensureRunning', () => {
    it('skips start when external Appium detected', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()
      await mgr.ensureRunning()
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(mgr.isManaged()).toBe(false)
    })

    it('concurrent ensureRunning calls coalesce', async () => {
      let callCount = 0
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)

      // First call to checkStatus returns false (no server), subsequent ones return true
      mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
        callCount++
        const res = new Readable({ read() {} }) as unknown as IncomingMessage
        const req = new EventEmitter() as unknown as ClientRequest
        ;(req as unknown as { end: () => void }).end = () => {
          if (callCount <= 2) {
            // First 2 calls: no server running (initial check for both concurrent calls)
            process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
          } else {
            // Later calls: server is up
            if (callback) callback(res)
            ;(res as unknown as Readable).push(JSON.stringify({ value: { ready: true } }))
            ;(res as unknown as Readable).push(null)
          }
        }
        ;(req as unknown as { destroy: () => void }).destroy = () => {}
        return req
      }) as any)

      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      const p1 = mgr.ensureRunning()
      const p2 = mgr.ensureRunning()

      await Promise.all([p1, p2])
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('starts Appium with the resolved local executable', async () => {
      let callCount = 0
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)
      mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
        callCount++
        const res = new Readable({ read() {} }) as unknown as IncomingMessage
        const req = new EventEmitter() as unknown as ClientRequest
        ;(req as unknown as { end: () => void }).end = () => {
          if (callCount === 1) {
            process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
            return
          }
          if (callback) callback(res)
          ;(res as unknown as Readable).push(JSON.stringify({ value: { ready: true } }))
          ;(res as unknown as Readable).push(null)
        }
        ;(req as unknown as { destroy: () => void }).destroy = () => {}
        return req
      }) as any)

      const mgr = new AppiumManager({
        pollIntervalMs: 10,
        startupTimeoutMs: 2000,
        appiumResolver: () => ({ command: '/repo/app/node_modules/.bin/appium', source: 'local' }),
      })

      await mgr.ensureRunning()

      expect(mockSpawn).toHaveBeenCalledWith('/repo/app/node_modules/.bin/appium', ['-p', '4723', '--relaxed-security', '--log-no-colors'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    })
  })

  describe('shutdown', () => {
    it('does nothing when no managed process', () => {
      const mgr = new AppiumManager()
      mgr.shutdown()
      expect(mockTreeKill).not.toHaveBeenCalled()
    })
  })

  describe('getUrl', () => {
    it('returns correct URL with default port', () => {
      const mgr = new AppiumManager()
      expect(mgr.getUrl()).toBe('http://localhost:4723')
    })

    it('returns correct URL with custom port', () => {
      const mgr = new AppiumManager({ port: 4800 })
      expect(mgr.getUrl()).toBe('http://localhost:4800')
    })
  })

  describe('getPort', () => {
    it('returns default port', () => {
      const mgr = new AppiumManager()
      expect(mgr.getPort()).toBe(4723)
    })

    it('returns custom port', () => {
      const mgr = new AppiumManager({ port: 5000 })
      expect(mgr.getPort()).toBe(5000)
    })
  })

  describe('integration: server wiring contracts', () => {
    it('ensureRunning is idempotent — second call when already ready is fast', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()
      await mgr.ensureRunning()
      await mgr.ensureRunning()
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('shutdown is safe to call multiple times', () => {
      const mgr = new AppiumManager()
      mgr.shutdown()
      mgr.shutdown()
      mgr.shutdown()
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('getUrl reflects configured port', () => {
      const custom = new AppiumManager({ port: 4800 })
      expect(custom.getUrl()).toBe('http://localhost:4800')
      const def = new AppiumManager()
      expect(def.getUrl()).toBe('http://localhost:4723')
    })

    it('isManaged returns false when external Appium detected', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()
      await mgr.ensureRunning()
      expect(mgr.isManaged()).toBe(false)
    })

    it('startup timeout throws clear error and cleans up', async () => {
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)
      mockHttpError()

      const mgr = new AppiumManager({ startupTimeoutMs: 100, pollIntervalMs: 20 })
      await expect(mgr.ensureRunning()).rejects.toThrow('did not become ready')
      expect(mockTreeKill).toHaveBeenCalledWith(12345, 'SIGKILL', expect.any(Function))
      expect(mgr.isManaged()).toBe(false)
    })
  })

  describe('acquire / release', () => {
    function setupManagedAppium() {
      let callCount = 0
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)
      mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
        callCount++
        const res = new Readable({ read() {} }) as unknown as IncomingMessage
        const req = new EventEmitter() as unknown as ClientRequest
        ;(req as unknown as { end: () => void }).end = () => {
          if (callCount <= 2) {
            process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
          } else {
            if (callback) callback(res)
            ;(res as unknown as Readable).push(JSON.stringify({ value: { ready: true } }))
            ;(res as unknown as Readable).push(null)
          }
        }
        ;(req as unknown as { destroy: () => void }).destroy = () => {}
        return req
      }) as any)
      return child
    }

    it('acquire increments refCount', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquire()
      expect(mgr.getRefCount()).toBe(1)
    })

    it('second acquire increments refCount to 2', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquire()
      await mgr.acquire()
      expect(mgr.getRefCount()).toBe(2)
    })

    it('release decrements refCount', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquire()
      await mgr.acquire()
      mgr.release()
      expect(mgr.getRefCount()).toBe(1)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('release shuts down when refCount hits 0 on managed', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquire()
      mgr.release()
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).toHaveBeenCalled()
    })

    it('release does not shut down unmanaged Appium', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()
      await mgr.acquire()
      expect(mgr.isManaged()).toBe(false)
      mgr.release()
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('release is safe when refCount already 0', () => {
      const mgr = new AppiumManager()
      mgr.release()
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('shutdown force-kills regardless of refCount', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquire()
      await mgr.acquire()
      expect(mgr.getRefCount()).toBe(2)
      mgr.shutdown()
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).toHaveBeenCalled()
    })

    it('acquireLease records one run lease with platform metadata', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })

      expect(mgr.getLeaseCount()).toBe(1)
      expect(mgr.getRefCount()).toBe(1)
      expect(mgr.hasLease('run_android_1')).toBe(true)
      expect(mgr.getLeases()).toMatchObject([
        { runId: 'run_android_1', platform: 'android' },
      ])
    })

    it('multiple run leases contribute to total refCount', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      expect(mgr.getLeaseCount()).toBe(2)
      expect(mgr.getRefCount()).toBe(2)
    })

    it('releaseLease keeps managed Appium alive while another run lease remains', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      const released = mgr.releaseLease('run_android_1', 'completed')

      expect(released).toBe(true)
      expect(mgr.getLeaseCount()).toBe(1)
      expect(mgr.hasLease('run_ios_1')).toBe(true)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('releaseLease shuts down managed Appium when the last run lease releases', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })

      const released = mgr.releaseLease('run_android_1', 'completed')

      expect(released).toBe(true)
      expect(mgr.getLeaseCount()).toBe(0)
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).toHaveBeenCalledTimes(1)
    })

    it('releaseLease is idempotent for missing run leases', () => {
      const mgr = new AppiumManager()

      const released = mgr.releaseLease('missing-run', 'completed')

      expect(released).toBe(false)
      expect(mgr.getLeaseCount()).toBe(0)
      expect(mgr.getRefCount()).toBe(0)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('releaseLease does not shut down unmanaged external Appium', async () => {
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      expect(mgr.isManaged()).toBe(false)
      mgr.releaseLease('run_android_1', 'completed')

      expect(mgr.getLeaseCount()).toBe(0)
      expect(mockTreeKill).not.toHaveBeenCalled()
    })

    it('duplicate acquireLease for the same run does not double count', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })

      expect(mgr.getLeaseCount()).toBe(1)
      expect(mgr.getRefCount()).toBe(1)
    })

    it('releaseAllLeases releases each active run lease', async () => {
      setupManagedAppium()
      const mgr = new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000 })
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })

      const released = mgr.releaseAllLeases('server-close')

      expect(released).toEqual(['run_android_1', 'run_ios_1'])
      expect(mgr.getLeaseCount()).toBe(0)
      expect(mockTreeKill).toHaveBeenCalledTimes(1)
    })
  })

  describe('log gating', () => {
    function setupForLogTest(logLevel: 'normal' | 'debug') {
      let callCount = 0
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)
      mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
        callCount++
        const res = new Readable({ read() {} }) as unknown as IncomingMessage
        const req = new EventEmitter() as unknown as ClientRequest
        ;(req as unknown as { end: () => void }).end = () => {
          if (callCount <= 2) {
            process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
          } else {
            if (callback) callback(res)
            ;(res as unknown as Readable).push(JSON.stringify({ value: { ready: true } }))
            ;(res as unknown as Readable).push(null)
          }
        }
        ;(req as unknown as { destroy: () => void }).destroy = () => {}
        return req
      }) as any)
      return { child, mgr: new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000, logLevel }) }
    }

    it('suppresses stdout at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { child, mgr } = setupForLogTest('normal')
      await mgr.ensureRunning()
      logSpy.mockClear()
      child.stdout!.emit('data', Buffer.from('some appium traffic\n'))
      const stdoutCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(stdoutCalls).toHaveLength(0)
      logSpy.mockRestore()
    })

    it('suppresses stderr at normal logLevel', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { child, mgr } = setupForLogTest('normal')
      await mgr.ensureRunning()
      errSpy.mockClear()
      child.stderr!.emit('data', Buffer.from('some warning\n'))
      const stderrCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(stderrCalls).toHaveLength(0)
      errSpy.mockRestore()
    })

    it('shows stdout with colored prefix at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { child, mgr } = setupForLogTest('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()
      child.stdout!.emit('data', Buffer.from('debug traffic line\n'))
      const dimCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(dimCalls.length).toBeGreaterThan(0)
      expect(String(dimCalls[0][0])).toContain('[magenta]')
      logSpy.mockRestore()
    })

    it('shows stderr with colored prefix at debug logLevel', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { child, mgr } = setupForLogTest('debug')
      await mgr.ensureRunning()
      errSpy.mockClear()
      child.stderr!.emit('data', Buffer.from('warning line\n'))
      const dimCalls = errSpy.mock.calls.filter((c) => String(c[0]).includes('[dim]'))
      expect(dimCalls.length).toBeGreaterThan(0)
      expect(String(dimCalls[0][0])).toContain('[magenta]')
      errSpy.mockRestore()
    })

    it('constructor defaults logLevel to normal', () => {
      const mgr = new AppiumManager()
      expect(mgr.getRefCount()).toBe(0)
    })

    it('constructor accepts logLevel debug', () => {
      const mgr = new AppiumManager({ logLevel: 'debug' })
      expect(mgr.getRefCount()).toBe(0)
    })
  })

  describe('lifecycle messages', () => {
    function setupForLifecycle(logLevel: 'normal' | 'debug') {
      let callCount = 0
      const child = createMockChild()
      mockSpawn.mockReturnValue(child)
      mockRequest.mockImplementation(((_opts: unknown, callback?: (res: IncomingMessage) => void) => {
        callCount++
        const res = new Readable({ read() {} }) as unknown as IncomingMessage
        const req = new EventEmitter() as unknown as ClientRequest
        ;(req as unknown as { end: () => void }).end = () => {
          if (callCount <= 2) {
            process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
          } else {
            if (callback) callback(res)
            ;(res as unknown as Readable).push(JSON.stringify({ value: { ready: true } }))
            ;(res as unknown as Readable).push(null)
          }
        }
        ;(req as unknown as { destroy: () => void }).destroy = () => {}
        return req
      }) as any)
      return { child, mgr: new AppiumManager({ pollIntervalMs: 10, startupTimeoutMs: 2000, logLevel }) }
    }

    it('prints started lifecycle message at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = setupForLifecycle('normal')
      await mgr.ensureRunning()
      const startedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[green]'))
      expect(startedCalls.length).toBeGreaterThan(0)
      expect(String(startedCalls[0][0])).toContain('started on')
      expect(String(startedCalls[0][0])).toContain('[magenta]')
      logSpy.mockRestore()
    })

    it('prints started lifecycle message at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = setupForLifecycle('debug')
      await mgr.ensureRunning()
      const startedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[green]'))
      expect(startedCalls.length).toBeGreaterThan(0)
      expect(String(startedCalls[0][0])).toContain('started on')
      logSpy.mockRestore()
    })

    it('prints stopped lifecycle message at normal logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = setupForLifecycle('normal')
      await mgr.ensureRunning()
      logSpy.mockClear()
      mgr.shutdown()
      const stoppedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[yellow]'))
      expect(stoppedCalls.length).toBeGreaterThan(0)
      expect(String(stoppedCalls[0][0])).toContain('stopped')
      expect(String(stoppedCalls[0][0])).toContain('[magenta]')
      logSpy.mockRestore()
    })

    it('prints stopped lifecycle message at debug logLevel', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = setupForLifecycle('debug')
      await mgr.ensureRunning()
      logSpy.mockClear()
      mgr.shutdown()
      const stoppedCalls = logSpy.mock.calls.filter((c) => String(c[0]).includes('[yellow]'))
      expect(stoppedCalls.length).toBeGreaterThan(0)
      expect(String(stoppedCalls[0][0])).toContain('stopped')
      logSpy.mockRestore()
    })

    it('prints ownership lease details for managed Appium', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { mgr } = setupForLifecycle('normal')
      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      await mgr.acquireLease({ runId: 'run_ios_1', platform: 'ios' })
      mgr.releaseLease('run_android_1', 'completed')

      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('lease acquired')
      expect(output).toContain('run=run_android_1')
      expect(output).toContain('platform=android')
      expect(output).toContain('leases=1')
      expect(output).toContain('managed=true')
      expect(output).toContain('lease released')
      expect(output).toContain('reason=completed')
      expect(output).toContain('server kept alive')
      logSpy.mockRestore()
    })

    it('prints external server retention details for unmanaged Appium', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      mockHttpResponse(JSON.stringify({ value: { ready: true } }))
      const mgr = new AppiumManager()

      await mgr.acquireLease({ runId: 'run_android_1', platform: 'android' })
      mgr.releaseLease('run_android_1', 'completed')

      const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('lease acquired')
      expect(output).toContain('managed=false')
      expect(output).toContain('external server left running')
      expect(output).toContain('leases=0')
      logSpy.mockRestore()
    })

  })
})
