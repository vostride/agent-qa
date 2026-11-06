import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hostIdentity,
  spawnScriptedPlugin,
  stopSpawnedPlugins,
  waitFor,
  type SpawnedPlugin,
} from './spawned-plugin.js'

const answer = { protocol: 'playwright', url: 'ws://127.0.0.1:9222/lab' }
const acquireParams = {
  remote: 'lab-chrome',
  settings: {},
  session: { platform: 'web', engine: 'chromium', context: 'new' },
}

const releasesOf = (ledger: Record<string, unknown>[]) =>
  ledger.filter((line) => line.method === 'release').map((line) => line.handle)

afterEach(() => {
  stopSpawnedPlugins()
})

// Sends an acquire nobody waits on, and returns once the handler is running.
async function acquireStarted(plugin: SpawnedPlugin): Promise<void> {
  plugin.send('acquire', acquireParams).answered.catch(() => {})
  await waitFor(() => (plugin.ledger().some((line) => line.method === 'acquire') || undefined))
}

describe('cancels', () => {
  it('answers a cancelled acquire with -32800 and the handle it had already created', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer, script: { acquire: { delayMs: 5000 } } })

    const acquire = plugin.send('acquire', acquireParams)
    plugin.notify('$/cancel', { id: acquire.id })
    const answered = await acquire.answered

    expect(answered.error?.code).toBe(-32800)
    expect(answered.error?.data).toEqual({ kind: 'timeout', handle: { n: 1 } })
  })

  it('answers a cancelled acquire with its result when it finishes inside the grace', async () => {
    const plugin = spawnScriptedPlugin({ timing: { cancelAnswerGraceMs: 5000 } })
    await plugin.initialize({
      answer,
      script: { acquire: { delayMs: 200, ignoreCancel: true } },
    })

    const acquire = plugin.send('acquire', acquireParams)
    plugin.notify('$/cancel', { id: acquire.id })

    expect((await acquire.answered).result).toEqual({ handle: { n: 1 }, ...answer })
  })

  it('keeps the result it already sent when the cancel arrives after the acquire finished', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })

    const acquire = plugin.send('acquire', acquireParams)
    expect((await acquire.answered).result).toEqual({ handle: { n: 1 }, ...answer })
    plugin.notify('$/cancel', { id: acquire.id })

    expect((await plugin.request('release', { handle: { n: 1 } })).result).toEqual({})
    expect(plugin.takeUnaddressed()).toEqual([])
  })

  it('answers an acquire that ignores its cancel with -32800 and no handle once the grace passes', async () => {
    const plugin = spawnScriptedPlugin({ timing: { cancelAnswerGraceMs: 300 } })
    expect(readFileSync(plugin.entry, 'utf8')).toContain('{"cancelAnswerGraceMs":300}')
    await plugin.initialize({ answer, script: { acquire: 'ignoreCancel' } })

    const acquire = plugin.send('acquire', acquireParams)
    plugin.notify('$/cancel', { id: acquire.id })
    const answered = await acquire.answered

    expect(answered.error?.code).toBe(-32800)
    expect(answered.error?.data).toEqual({ kind: 'timeout' })
  })

  it('releases a handle that arrives after its cancel was answered without one', async () => {
    const plugin = spawnScriptedPlugin({ timing: { cancelAnswerGraceMs: 100 } })
    await plugin.initialize({
      answer,
      script: { acquire: { delayMs: 400, ignoreCancel: true } },
    })

    const acquire = plugin.send('acquire', acquireParams)
    plugin.notify('$/cancel', { id: acquire.id })
    expect((await acquire.answered).error?.data).toEqual({ kind: 'timeout' })

    const released = await waitFor(() => {
      const handles = releasesOf(plugin.ledger())
      return handles.length > 0 ? handles : undefined
    })
    expect(released).toEqual([{ n: 1 }])
  })
})

describe('handles and progress', () => {
  it('carries the handle in the error of an acquire that failed after creating a session', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({
      answer,
      script: { acquire: { errorAfterCreate: { kind: 'capacity', message: 'quota reached' } } },
    })

    const failed = await plugin.request('acquire', acquireParams)

    expect(failed.error).toEqual({
      code: -32000,
      message: 'quota reached',
      data: { kind: 'capacity', handle: { n: 1 } },
    })
  })

  it('sends progress notifications carrying the id of the acquire they belong to', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({
      answer,
      progress: [
        { message: 'queued, 3 ahead', queued: 3 },
        { message: 'starting', percent: 50 },
      ],
    })

    const acquire = plugin.send('acquire', acquireParams)
    await acquire.answered

    expect(plugin.takeUnaddressed()).toEqual([
      {
        jsonrpc: '2.0',
        method: '$/progress',
        params: { id: acquire.id, message: 'queued, 3 ahead', queued: 3 },
      },
      {
        jsonrpc: '2.0',
        method: '$/progress',
        params: { id: acquire.id, message: 'starting', percent: 50 },
      },
    ])
  })

  it('keeps stdout to protocol lines when a handler logs to the console', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer, script: { acquire: 'consoleLog' } })

    expect((await plugin.request('acquire', acquireParams)).result).toEqual({
      handle: { n: 1 },
      ...answer,
    })

    for (const line of plugin.stdoutLines()) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    }
    expect(plugin.stderr()).toContain('acquire logged to the console')
  })
})

describe('shutdown', () => {
  it('releases a handle whose release failed before it runs shutdown', async () => {
    const plugin = spawnScriptedPlugin()
    const failed = { error: { kind: 'unreachable', message: 'the vendor did not answer' } }
    await plugin.initialize({ answer, script: { release: [failed, 'ok'] } })
    await plugin.request('acquire', acquireParams)
    expect((await plugin.request('release', { handle: { n: 1 } })).error?.data).toEqual({
      kind: 'unreachable',
    })

    expect((await plugin.request('shutdown', {})).result).toEqual({})
    expect(plugin.ledger().slice(-3)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
    expect(await plugin.close()).toBe(0)
    expect(plugin.ledger().at(-1)).toEqual({ method: 'shutdown' })
  })
})

describe('leaving', () => {
  it('releases the handle it still holds, shuts down and exits 0 when stdin closes', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })
    await plugin.request('acquire', acquireParams)

    expect(await plugin.close()).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
  })

  it('cancels an acquire still running when stdin closes and releases the handle it returns, before shutting down', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer, script: { acquire: { delayMs: 5000 } } })
    await acquireStarted(plugin)

    expect(await plugin.close()).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
  })

  it('waits for an acquire that finishes after stdin closed and releases its session', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({
      answer,
      script: { acquire: { delayMs: 300, ignoreCancel: true } },
    })
    await acquireStarted(plugin)

    expect(await plugin.close()).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
    expect(plugin.stdoutLines().map((line) => JSON.parse(line) as { id?: number })).toEqual([
      expect.objectContaining({ id: 1 }),
    ])
  })

  it('releases and exits when the host pid it was given is gone', async () => {
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      stdio: 'ignore',
    })
    const hostExited = new Promise((resolve) => host.on('exit', resolve))
    const plugin = spawnScriptedPlugin({ timing: { hostPidPollMs: 50 } })
    expect(readFileSync(plugin.entry, 'utf8')).toContain('{"hostPidPollMs":50}')
    await plugin.initialize({ answer }, [1], hostIdentity(host.pid))
    await plugin.request('acquire', acquireParams)

    host.kill('SIGKILL')
    await hostExited

    expect(await plugin.exited).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
  })

  it('still releases and shuts down when the dead host closed its pipes and release logs', async () => {
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      stdio: 'ignore',
    })
    const hostExited = new Promise((resolve) => host.on('exit', resolve))
    const plugin = spawnScriptedPlugin({ timing: { hostPidPollMs: 50 } })
    const script = { release: 'consoleLog' }
    await plugin.initialize({ answer, script }, [1], hostIdentity(host.pid))
    await plugin.request('acquire', acquireParams)

    plugin.dropOutput()
    host.kill('SIGKILL')
    await hostExited

    expect(await plugin.exited).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
  })

  it('keeps answering after SIGINT', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer, script: { acquire: { delayMs: 100 } } })

    plugin.signal('SIGINT')

    expect((await plugin.request('acquire', acquireParams)).result).toEqual({
      handle: { n: 1 },
      ...answer,
    })
    expect(await plugin.close()).toBe(0)
  })

  it('releases what it holds and exits 0 on SIGTERM', async () => {
    const plugin = spawnScriptedPlugin()
    await plugin.initialize({ answer })
    await plugin.request('acquire', acquireParams)

    plugin.signal('SIGTERM')

    expect(await plugin.exited).toBe(0)
    expect(plugin.ledger().slice(-2)).toEqual([
      { method: 'release', handle: { n: 1 } },
      { method: 'shutdown' },
    ])
  })
})
