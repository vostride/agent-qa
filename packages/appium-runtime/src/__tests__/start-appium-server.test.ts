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

class FakeChild extends EventEmitter {
  readonly pid = 4321
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
}

const children: FakeChild[] = []
const homes: string[] = []

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

// A test that fails before it awaits its start leaves no unhandled rejection behind.
function start(options: StartAppiumServerOptions): Promise<AppiumServer> {
  const starting = startAppiumServer(options)
  starting.catch(() => {})
  return starting
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

  it("rejects with the child's last lines when the child exits before it is ready, and removes its home", async () => {
    const { child, spawn, home } = fakeSpawn()
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home

    child.stdout.emit('data', Buffer.from('[Appium] Welcome\n'))
    child.stderr.emit('data', Buffer.from('the server cannot start here\n'))
    child.emit('close', 1, null)

    await expect(starting).rejects.toThrow(
      /^Appium exited before it was ready \(exit code 1\)\n\[Appium\] Welcome\nthe server cannot start here$/u,
    )
    expect(existsSync(prepared)).toBe(false)
  })

  it('does not take an answer that arrives after the child exited', async () => {
    const { child, spawn } = fakeSpawn()
    let answer!: (ready: boolean) => void
    const probe = vi.fn(
      (_url: string) =>
        new Promise<boolean>((settle) => {
          answer = settle
        }),
    )
    const starting = start({ spawn, probe })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))

    child.emit('close', 0, null)
    answer(true)

    await expect(starting).rejects.toThrow(/^Appium exited before it was ready/u)
  })

  it('rejects with the spawn error and removes its home', async () => {
    const { child, spawn, home } = fakeSpawn()
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home

    child.emit('error', new Error('spawn failed'))

    await expect(starting).rejects.toThrow('spawn failed')
    expect(existsSync(prepared)).toBe(false)
  })

  it('kills the tree, removes its home and rejects when the server is not ready in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { child, spawn, home } = fakeSpawn()
    mockTreeKill.mockImplementationOnce((_pid, _signal, callback) => {
      child.emit('close', null, 'SIGKILL')
      callback?.()
    })
    const starting = start({ spawn, probe: async () => false })
    const prepared = await home

    await vi.runAllTimersAsync()

    await expect(starting).rejects.toThrow(/^Appium server did not become ready within \d+ms/u)
    expect(mockTreeKill).toHaveBeenCalledWith(child.pid, 'SIGKILL', expect.any(Function))
    expect(existsSync(prepared)).toBe(false)
  })
})
