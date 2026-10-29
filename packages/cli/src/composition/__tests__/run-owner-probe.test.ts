import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  classifyRunOwner,
  completeRunOwnership,
  DashboardDatabase,
  resolveRunOwnerHost,
} from '@vostride/agent-qa-dashboard'
import type { RunOwner } from '@vostride/agent-qa-dashboard'
import { resolveProcessIncarnation } from '@vostride/agent-qa-knowledge-local'
import { describe, expect, it } from 'vitest'

import { processIsAlive } from '../../daemon/registration.js'
import {
  composeRunOwnership,
  createRunOwnership,
  RUN_OWNER_START_TIME_TIMEOUT_MS,
} from '../run-owner-probe.js'

function requirePosix(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function requirePid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('the child process did not start')
  return child.pid
}

describe('the owner stamp the CLI composes', () => {
  it('the CLI composes its own pid, start time and host', () => {
    const composed = composeRunOwnership()
    const db = new DashboardDatabase({ dbPath: ':memory:', runOwnership: composed })
    try {
      expect(db.runOwnership.self).toEqual({
        pid: process.pid,
        incarnation: resolveProcessIncarnation(process.pid) ?? null,
        host: resolveRunOwnerHost(),
      })
    } finally {
      db.close()
    }
    expect(Object.keys(composed.self).sort()).toEqual(['incarnation', 'pid'])
    expect(composeRunOwnership()).toBe(composed)
  })
})

describe('owner classification over real processes', () => {
  it('the composed probe reads real processes', async () => {
    requirePosix()
    const ownership = completeRunOwnership(composeRunOwnership())
    expect(typeof ownership.self.incarnation).toBe('string')
    const host = resolveRunOwnerHost()

    const finished = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const finishedPid = requirePid(finished)
    await exited(finished)
    expect(classifyRunOwner({ pid: finishedPid, incarnation: null, host }, ownership)).toBe('gone')

    const waiting = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    try {
      const waitingPid = requirePid(waiting)
      const incarnation = resolveProcessIncarnation(waitingPid)
      expect(incarnation).toEqual(expect.any(String))
      const live: RunOwner = { pid: waitingPid, incarnation: incarnation ?? null, host }
      expect(classifyRunOwner(live, ownership)).toBe('alive')
      waiting.stdin?.end()
      await exited(waiting)
      expect(classifyRunOwner(live, ownership)).toBe('gone')
    } finally {
      waiting.stdin?.end()
      await exited(waiting)
    }

    const reused = `${String(ownership.self.incarnation).split(':')[0]}:never`
    expect(classifyRunOwner({ pid: process.pid, incarnation: reused, host }, ownership)).toBe('gone')
    expect(classifyRunOwner(ownership.self, ownership)).toBe('self')
  })
})

describe("reading the CLI's own start time", () => {
  it('the CLI retries an unread own start time and keeps the first one it reads', () => {
    const ownReads: number[] = []
    const ownership = completeRunOwnership(createRunOwnership({
      readStartTime: (pid) => {
        ownReads.push(pid)
        return ownReads.length === 1 ? undefined : 'ps-lstart-utc:A'
      },
      isAlive: () => true,
    }))

    expect(ownership.self.incarnation).toBeNull()
    expect(ownership.self.incarnation).toBe('ps-lstart-utc:A')
    expect(ownership.self).toEqual({
      pid: process.pid,
      incarnation: 'ps-lstart-utc:A',
      host: resolveRunOwnerHost(),
    })
    expect(ownReads).toEqual([process.pid, process.pid])
  })

  it('the CLI bounds both start-time reads, and a ps that never answers reads as unknown', async () => {
    expect(RUN_OWNER_START_TIME_TIMEOUT_MS).toBe(1000)
    const bounds: Array<number | undefined> = []
    const recording = createRunOwnership({
      readStartTime: (_pid, timeoutMs) => {
        bounds.push(timeoutMs)
        return 'ps-lstart-utc:A'
      },
      isAlive: () => true,
    })
    expect(recording.self.incarnation).toBe('ps-lstart-utc:A')
    expect(recording.probe.incarnationOf(4242)).toBe('ps-lstart-utc:A')
    expect(bounds).toEqual([RUN_OWNER_START_TIME_TIMEOUT_MS, RUN_OWNER_START_TIME_TIMEOUT_MS])

    requirePosix()
    const wedgedBounds: Array<number | undefined> = []
    const wedged = completeRunOwnership(createRunOwnership({
      readStartTime: (pid, timeoutMs) => {
        wedgedBounds.push(timeoutMs)
        if (pid === process.pid) return 'ps-lstart-utc:self'
        spawnSync('/bin/sleep', ['30'], { stdio: 'ignore', timeout: timeoutMs })
        return undefined
      },
      isAlive: processIsAlive,
    }))
    expect(wedged.self.incarnation).toBe('ps-lstart-utc:self')

    const waiting = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    try {
      const waitingPid = requirePid(waiting)
      const live: RunOwner = {
        pid: waitingPid,
        incarnation: 'ps-lstart-utc:child',
        host: resolveRunOwnerHost(),
      }
      const startedAt = Date.now()
      expect(classifyRunOwner(live, wedged)).toBe('unknown')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(wedgedBounds).toEqual([
        RUN_OWNER_START_TIME_TIMEOUT_MS,
        RUN_OWNER_START_TIME_TIMEOUT_MS,
      ])
      expect(waiting.exitCode).toBeNull()
      expect(processIsAlive(waitingPid)).toBe(true)
    } finally {
      waiting.stdin?.end()
      await exited(waiting)
    }
  })
})
