import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createRemoteSessionRegistry,
  REMOTE_RELEASE_BOUND_MS,
  type RemoteSessionRegistry,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createHostProject,
  isAlive,
  methodsOf,
  waitFor,
  webSession,
  type HostProject,
  type ScriptedEntry,
} from './plugin-host-fixtures.js'

let project: HostProject | undefined
const strays: number[] = []

function host(): HostProject {
  project = createHostProject()
  return project
}

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await project?.cleanup()
  project = undefined
})

function request(remote: string, entry: string) {
  return { remote, plugin: { entry }, deadlineMs: 10_000, session: webSession }
}

interface StubbornBehaviour {
  answersShutdown: boolean
  releaseDelayMs?: number
}

type StubbornEvent = { event: string; at: number; pid?: number }

// Speaks the protocol by hand, starts a child in its own group, and ignores stdin closing,
// SIGINT and SIGTERM, so only SIGKILL to the group ends it.
function stubbornMain(ledgerFile: string, behaviour: StubbornBehaviour): string {
  return `import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const ledgerFile = ${JSON.stringify(ledgerFile)}
const behaviour = ${JSON.stringify(behaviour)}
const note = (entry) => appendFileSync(ledgerFile, JSON.stringify({ ...entry, at: Date.now() }) + '\\n')
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')

process.on('SIGINT', () => note({ event: 'SIGINT' }))
process.on('SIGTERM', () => note({ event: 'SIGTERM' }))
process.stdin.on('end', () => note({ event: 'stdin-end' }))
setInterval(() => {}, 1_000)

const answer = {
  initialize: () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
    note({ event: 'grandchild', pid: child.pid })
    return { protocolVersion: 1, plugin: { name: 'stubborn', version: '1.0.0' }, serves: ['playwright'], methods: [] }
  },
  acquire: () => ({ handle: { n: 1 }, protocol: 'playwright', url: 'ws://127.0.0.1:9/lab' }),
}

let pending = ''
process.stdin.on('data', (chunk) => {
  pending += chunk
  for (let end = pending.indexOf('\\n'); end >= 0; end = pending.indexOf('\\n')) {
    const line = pending.slice(0, end)
    pending = pending.slice(end + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    note({ event: message.method, ...(message.method === 'initialize' ? { pid: process.pid } : {}) })
    if (message.method === 'release') {
      setTimeout(() => {
        note({ event: 'released' })
        send({ id: message.id, result: {} })
      }, behaviour.releaseDelayMs ?? 0)
    } else if (message.method === 'shutdown') {
      if (behaviour.answersShutdown) send({ id: message.id, result: {} })
    } else {
      send({ id: message.id, result: answer[message.method]() })
    }
  }
})
`
}

function stubbornEntry(p: HostProject, behaviour: StubbornBehaviour): ScriptedEntry {
  const entry = p.entry('stubborn')
  const ledgerFile = join(p.fixture.root, 'stubborn.events.jsonl')
  writeFileSync(
    join(p.fixture.configDir, 'plugins', 'stubborn', 'main.mjs'),
    stubbornMain(ledgerFile, behaviour),
  )
  return { ...entry, ledgerFile }
}

function eventsOf(entry: ScriptedEntry): StubbornEvent[] {
  if (!existsSync(entry.ledgerFile)) return []
  return readFileSync(entry.ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as StubbornEvent)
}

function at(events: readonly StubbornEvent[], event: string): number {
  const found = events.find((candidate) => candidate.event === event)
  if (found === undefined) throw new Error(`no ${event} in ${JSON.stringify(events)}`)
  return found.at
}

function pidOf(events: readonly StubbornEvent[], event: string): number {
  const pid = events.find((candidate) => candidate.event === event)?.pid
  if (pid === undefined) throw new Error(`no pid for ${event} in ${JSON.stringify(events)}`)
  return pid
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

// Timers start a moment before the plugin notices what they time, so allow that moment.
const SLACK_MS = 100

// Counts the registrations that are still live, so a cell sees what is left registered.
function countingRegistry(): RemoteSessionRegistry & { live(): number } {
  const registry = createRemoteSessionRegistry()
  let live = 0
  return {
    register(release, options) {
      live += 1
      let gone = false
      const unregister = registry.register(async (boundMs) => {
        if (!gone) {
          gone = true
          live -= 1
        }
        await release(boundMs)
      }, options)
      return () => {
        if (gone) return
        gone = true
        live -= 1
        unregister()
      }
    },
    releaseAll: (boundMs) => registry.releaseAll(boundMs),
    live: () => live,
  }
}

// Process groups and their signals are POSIX; CI runs macOS and Linux.
describe.skipIf(process.platform === 'win32')('the plugin host pool shutting a plugin down', () => {
  it('sends release, then shutdown, then closes stdin, then SIGTERM and SIGKILL to the group, each after killAfterMs', async () => {
    const p = host()
    const stubborn = stubbornEntry(p, { answersShutdown: true })
    const killAfterMs = 500
    const pool = p.pool([stubborn], { bounds: { killAfterMs, cancelGraceMs: 1_000 } })

    await pool.acquire(request('lab-a', 'stubborn'))
    const pid = pidOf(eventsOf(stubborn), 'initialize')
    strays.push(pid)
    await pool.shutdown()
    const shutDownAt = Date.now()

    const events = eventsOf(stubborn)
    expect(events.map((line) => line.event)).toEqual([
      'initialize',
      'grandchild',
      'acquire',
      'release',
      'released',
      'shutdown',
      'stdin-end',
      'SIGTERM',
    ])
    expect(at(events, 'SIGTERM') - at(events, 'stdin-end')).toBeGreaterThanOrEqual(
      killAfterMs - SLACK_MS,
    )
    expect(shutDownAt - at(events, 'SIGTERM')).toBeGreaterThanOrEqual(killAfterMs - SLACK_MS)
    expect(isAlive(pid)).toBe(false)
    await waitFor(() => !isAlive(pidOf(events, 'grandchild')), 2_000)
    expect(groupAlive(pid)).toBe(false)
  })

  it('on a signal gives every step signalMs, whatever the normal bounds say', async () => {
    const p = host()
    const stubborn = stubbornEntry(p, { answersShutdown: false })
    const signalMs = 300
    const pool = p.pool([stubborn], {
      bounds: {
        releaseMs: 30_000,
        shutdownMs: 30_000,
        killAfterMs: 30_000,
        signalMs,
        cancelGraceMs: 200,
      },
    })

    await pool.acquire(request('lab-a', 'stubborn'))
    const pid = pidOf(eventsOf(stubborn), 'initialize')
    strays.push(pid)
    const startedAt = Date.now()
    await pool.shutdown({ signal: true })
    const shutDownAt = Date.now()

    const events = eventsOf(stubborn)
    expect(events.map((line) => line.event)).toEqual([
      'initialize',
      'grandchild',
      'acquire',
      'release',
      'released',
      'shutdown',
      'stdin-end',
      'SIGTERM',
    ])
    expect(at(events, 'stdin-end') - at(events, 'shutdown')).toBeGreaterThanOrEqual(
      signalMs - SLACK_MS,
    )
    expect(at(events, 'SIGTERM') - at(events, 'stdin-end')).toBeGreaterThanOrEqual(
      signalMs - SLACK_MS,
    )
    expect(shutDownAt - startedAt).toBeLessThan(5_000)
    expect(groupAlive(pid)).toBe(false)
  })

  it('waits for a release already under way before it sends shutdown', async () => {
    const p = host()
    const stubborn = stubbornEntry(p, { answersShutdown: true, releaseDelayMs: 500 })
    const pool = p.pool([stubborn], { bounds: { killAfterMs: 200 } })

    const lease = await pool.acquire(request('lab-a', 'stubborn'))
    strays.push(pidOf(eventsOf(stubborn), 'initialize'))
    const releasing = lease.release()
    await pool.shutdown()
    await releasing

    const events = eventsOf(stubborn)
    expect(at(events, 'shutdown')).toBeGreaterThanOrEqual(at(events, 'released'))
    expect(events.filter((line) => line.event === 'release')).toHaveLength(1)
  })
})

describe('the plugin host pool on the session registry', () => {
  it('registers each lease and its own signal shutdown at five seconds, so a slow release still gets its shutdown', async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true, script: { release: { delayMs: 3_000 } } })
    const sessions = createRemoteSessionRegistry()
    const pool = p.pool([lab], { sessions })

    await pool.acquire(request('lab-a', 'lab'))
    const pid = p.ledger(lab)[0]?.pid as number
    const startedAt = Date.now()
    await sessions.releaseAll(REMOTE_RELEASE_BOUND_MS)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(3_000 - SLACK_MS)
    expect(methodsOf(p.ledger(lab))).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
    expect(isAlive(pid)).toBe(false)
  }, 15_000)

  it('sends one release for a lease that the adapter and the pool both registered', async () => {
    const p = host()
    const lab = p.entry('lab')
    const sessions = createRemoteSessionRegistry()
    const pool = p.pool([lab], { sessions })

    const lease = await pool.acquire(request('lab-a', 'lab'))
    sessions.register(() => lease.release())
    await sessions.releaseAll(REMOTE_RELEASE_BOUND_MS)

    const releases = p.ledger(lab).filter((line) => line.method === 'release')
    expect(releases.map((line) => line.handle)).toEqual([{ n: 1 }])
  })

  it('registers nothing before an entry starts, and leaves nothing registered after a normal shutdown', async () => {
    const p = host()
    const lab = p.entry('lab')
    const sessions = countingRegistry()
    const pool = p.pool([lab], { sessions })
    expect(sessions.live()).toBe(0)

    const lease = await pool.acquire(request('lab-a', 'lab'))
    expect(sessions.live()).toBe(2)
    await lease.release()
    await pool.shutdown()

    expect(sessions.live()).toBe(0)
  })
})
