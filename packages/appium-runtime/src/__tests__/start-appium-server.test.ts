import { EventEmitter } from 'node:events'
import { existsSync, rmSync, statSync } from 'node:fs'

import treeKill from 'tree-kill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveBundledAppium } from '../bundled-appium'
import {
  startAppiumServer,
  type AppiumServer,
  type AppiumSpawn,
  type StartAppiumServerOptions,
} from '../start-appium-server'

vi.mock('tree-kill')

const mockTreeKill = vi.mocked(treeKill)

class FakeOutput extends EventEmitter {
  readonly ref = vi.fn()
  readonly unref = vi.fn()
}

class FakeChild extends EventEmitter {
  readonly pid = 4321
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly kill = vi.fn()
  readonly ref = vi.fn()
  readonly unref = vi.fn()
}

const children: FakeChild[] = []
const homes: string[] = []

const exitListeners = () => process.listeners('exit')

// The child the fake spawn hands out, and the home the start prepared, known once it has spawned.
function fakeSpawn() {
  const child = new FakeChild()
  children.push(child)
  let spawned!: (home: string) => void
  const home = new Promise<string>((settle) => {
    spawned = settle
  })
  const spawn = vi.fn<AppiumSpawn>((_command, _args, options) => {
    const given = options.env?.APPIUM_HOME ?? ''
    homes.push(given)
    spawned(given)
    return child
  })
  return { child, spawn, home }
}

// A probe that answers only when the test says so.
function heldProbe() {
  let give: (ready: boolean) => void = () => {}
  const probe = vi.fn(
    (_url: string) =>
      new Promise<boolean>((settle) => {
        give = settle
      }),
  )
  return { probe, answer: (ready: boolean) => give(ready) }
}

// A test that fails before it awaits its start leaves no unhandled rejection behind.
function start(options: StartAppiumServerOptions): Promise<AppiumServer> {
  const starting = startAppiumServer(options)
  starting.catch(() => {})
  return starting
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false
  const mark = () => {
    settled = true
  }
  promise.then(mark, mark)
  await new Promise((wait) => setTimeout(wait, ms))
  return settled
}

beforeEach(() => {
  mockTreeKill.mockReset()
  mockTreeKill.mockImplementation((_pid, _signal, callback) => callback?.())
})

afterEach(() => {
  vi.useRealTimers()
  for (const child of children.splice(0)) child.emit('close', null, 'SIGKILL')
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('startAppiumServer', () => {
  it('starts the server entry with this Node on a loopback port with cross-origin requests denied, in a home of its own', async () => {
    const appiumHomeBefore = process.env.APPIUM_HOME
    const { spawn, home } = fakeSpawn()

    await start({ spawn, probe: async () => true })

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      resolveBundledAppium().serverEntry,
      '--address',
      '127.0.0.1',
      '--port',
      expect.stringMatching(/^\d+$/u),
      '--relaxed-security',
      '--deny-insecure',
      '*:cors',
      '--log-no-colors',
    ])
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(statSync(await home).isDirectory()).toBe(true)
    expect(process.env.APPIUM_HOME).toBe(appiumHomeBefore)
  })

  it('resolves with the URL of its port once the probe answers while the child lives', async () => {
    const { spawn } = fakeSpawn()
    const probe = vi.fn(async (_url: string) => true)

    const server = await start({ spawn, probe })

    const port = spawn.mock.calls[0][1][4]
    expect(server.url).toBe(`http://127.0.0.1:${port}`)
    expect(probe).toHaveBeenCalledWith(server.url)
  })

  it("rejects with the child's last lines when the child exits before it is ready, and leaves no home or exit listener", async () => {
    const before = exitListeners()
    const { child, spawn, home } = fakeSpawn()
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home
    expect(exitListeners()).toHaveLength(before.length + 1)

    child.stdout.emit('data', Buffer.from('[Appium] Welcome\n'))
    child.stderr.emit('data', Buffer.from('the server cannot start here\n'))
    child.emit('close', 1, null)

    await expect(starting).rejects.toThrow(
      /^Appium exited before it was ready \(exit code 1\)\n\[Appium\] Welcome\nthe server cannot start here$/u,
    )
    expect(existsSync(prepared)).toBe(false)
    expect(exitListeners()).toEqual(before)
  })

  it('does not take an answer that arrives after the child exited', async () => {
    const { child, spawn } = fakeSpawn()
    const { probe, answer } = heldProbe()
    const starting = start({ spawn, probe })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))

    child.emit('close', 0, null)
    answer(true)

    await expect(starting).rejects.toThrow(/^Appium exited before it was ready/u)
  })

  it('rejects with the spawn error and leaves no home or exit listener', async () => {
    const before = exitListeners()
    const { child, spawn, home } = fakeSpawn()
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home
    expect(exitListeners()).toHaveLength(before.length + 1)

    child.emit('error', new Error('spawn failed'))

    await expect(starting).rejects.toThrow('spawn failed')
    expect(existsSync(prepared)).toBe(false)
    expect(exitListeners()).toEqual(before)
  })

  it('kills the tree and rejects when the server is not ready in time, and leaves no home or exit listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const before = exitListeners()
    const { child, spawn, home } = fakeSpawn()
    mockTreeKill.mockImplementationOnce((_pid, _signal, callback) => {
      child.emit('close', null, 'SIGKILL')
      callback?.()
    })
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home
    expect(exitListeners()).toHaveLength(before.length + 1)

    await vi.runAllTimersAsync()

    await expect(starting).rejects.toThrow(/^Appium server did not become ready within \d+ms/u)
    expect(mockTreeKill).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
    expect(existsSync(prepared)).toBe(false)
    expect(exitListeners()).toEqual(before)
  })

  it('passes stdout and stderr to onOutput with their names, before and after readiness', async () => {
    const { child, spawn } = fakeSpawn()
    const { probe, answer } = heldProbe()
    const onOutput = vi.fn()
    const starting = start({ spawn, probe, onOutput })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))

    child.stdout.emit('data', Buffer.from('starting\n'))
    answer(true)
    await starting
    child.stderr.emit('data', Buffer.from('serving\n'))

    expect(onOutput.mock.calls).toEqual([
      ['starting\n', 'stdout'],
      ['serving\n', 'stderr'],
    ])
  })
})

describe('stop and exited', () => {
  it('stop kills the tree and settles only once the child has closed and its home is gone', async () => {
    const { child, spawn, home } = fakeSpawn()
    const server = await start({ spawn, probe: async () => true })
    const prepared = await home

    const stopping = server.stop()

    expect(await settledWithin(stopping, 50)).toBe(false)
    expect(mockTreeKill).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
    expect(existsSync(prepared)).toBe(true)
    child.emit('close', null, 'SIGKILL')
    await stopping
    expect(existsSync(prepared)).toBe(false)
  })

  it('a second stop settles without killing again', async () => {
    const { child, spawn } = fakeSpawn()
    const server = await start({ spawn, probe: async () => true })

    const first = server.stop()
    const second = server.stop()
    child.emit('close', null, 'SIGKILL')
    await Promise.all([first, second])
    await server.stop()

    expect(mockTreeKill).toHaveBeenCalledTimes(1)
  })

  it('stop settles once the child closes even when the kill reports an error', async () => {
    const { child, spawn, home } = fakeSpawn()
    const server = await start({ spawn, probe: async () => true })
    const prepared = await home
    mockTreeKill.mockImplementationOnce((_pid, _signal, callback) =>
      callback?.(new Error('kill failed')),
    )

    const stopping = server.stop()
    child.emit('close', null, 'SIGKILL')

    await expect(stopping).resolves.toBeUndefined()
    expect(existsSync(prepared)).toBe(false)
  })

  it('a server that ends on its own leaves no home or exit listener, and a later stop kills nothing', async () => {
    const before = exitListeners()
    const { child, spawn, home } = fakeSpawn()
    const server = await start({ spawn, probe: async () => true })
    const prepared = await home
    expect(exitListeners()).toHaveLength(before.length + 1)

    child.emit('close', 1, null)
    await server.exited

    expect(existsSync(prepared)).toBe(false)
    expect(exitListeners()).toEqual(before)
    await server.stop()
    expect(mockTreeKill).not.toHaveBeenCalled()
  })
})

describe('a process that ends without stopping the server', () => {
  it('unrefs the child and its output streams as soon as it is spawned', async () => {
    const { child, spawn, home } = fakeSpawn()
    const starting = start({ spawn, probe: async () => true })
    await home

    for (const target of [child, child.stdout, child.stderr]) {
      expect(target.unref).toHaveBeenCalledTimes(1)
    }
    await starting
  })

  it("registers one exit listener, which kills the server with the child's own kill and removes its home before it returns", async () => {
    const before = exitListeners()
    const { child, spawn, home } = fakeSpawn()
    await start({ spawn, probe: async () => true })
    const prepared = await home
    const added = exitListeners().filter((listener) => !before.includes(listener))
    expect(added).toHaveLength(1)

    added[0](0)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(mockTreeKill).not.toHaveBeenCalled()
    expect(existsSync(prepared)).toBe(false)
  })

  it('stop refs the child and its streams before it kills, and removes the exit listener', async () => {
    const before = exitListeners()
    const { child, spawn } = fakeSpawn()
    const server = await start({ spawn, probe: async () => true })
    expect(exitListeners()).toHaveLength(before.length + 1)

    const stopping = server.stop()
    child.emit('close', null, 'SIGKILL')
    await stopping

    const killedAt = mockTreeKill.mock.invocationCallOrder[0]
    for (const target of [child, child.stdout, child.stderr]) {
      expect(target.ref).toHaveBeenCalledTimes(1)
      expect(target.ref.mock.invocationCallOrder[0]).toBeLessThan(killedAt)
    }
    expect(exitListeners()).toEqual(before)
  })
})
