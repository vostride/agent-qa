// process-tree.ts kills a process it recorded only while that pid still runs the recorded command
// line, so a reused pid is never signalled. Each cell spawns its own `/bin/sleep 60` and always reaps
// it through its handle.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

import { describe, expect, it } from 'vitest'

interface RecordedProcess {
  readonly pid: number
  readonly command: string
}

interface ProcessIdentity {
  readonly recordProcesses: (pids: readonly number[]) => RecordedProcess[]
  readonly killRecorded: (recorded: readonly RecordedProcess[]) => number[]
}

interface Sleeper {
  readonly child: ChildProcess
  readonly pid: number
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

const STILL_ALIVE_MS = 500
const KILLED_WITHIN_MS = 5_000

function refuseWithoutPosix(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

async function processIdentity(): Promise<ProcessIdentity> {
  const tree = (await import('./process-tree.js')) as Record<string, unknown>
  expect(typeof tree.recordProcesses, 'process-tree exports recordProcesses').toBe('function')
  expect(typeof tree.killRecorded, 'process-tree exports killRecorded').toBe('function')
  return tree as unknown as ProcessIdentity
}

async function startSleeper(): Promise<Sleeper> {
  const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.once('close', (code, signal) => { settle({ code, signal }) })
  })
  await new Promise<void>((started, failed) => {
    child.once('spawn', started)
    child.once('error', failed)
  })
  return { child, pid: child.pid!, closed }
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function reap(sleeper: Sleeper | undefined): Promise<void> {
  if (sleeper === undefined) return
  if (running(sleeper.child)) sleeper.child.kill('SIGKILL')
  await sleeper.closed
}

describe('killing a recorded process', () => {
  it('a recorded process whose command line no longer matches is never killed', async () => {
    refuseWithoutPosix()
    let sleeper: Sleeper | undefined
    try {
      const { killRecorded } = await processIdentity()
      sleeper = await startSleeper()
      const killed = killRecorded([{ pid: sleeper.pid, command: 'not the recorded command' }])
      expect(killed).toEqual([])
      await new Promise((tick) => setTimeout(tick, STILL_ALIVE_MS))
      expect(running(sleeper.child), `pid ${String(sleeper.pid)} is still alive ${String(STILL_ALIVE_MS)} ms later`).toBe(true)
    } finally {
      await reap(sleeper)
    }
  }, 30_000)

  it('a recorded process that is still the same process is killed', async () => {
    refuseWithoutPosix()
    let sleeper: Sleeper | undefined
    try {
      const { killRecorded, recordProcesses } = await processIdentity()
      sleeper = await startSleeper()
      const recorded = recordProcesses([sleeper.pid])
      expect(recorded.map((entry) => entry.pid)).toEqual([sleeper.pid])
      expect(recorded[0]!.command).toMatch(/\bsleep\b/u)
      expect(killRecorded(recorded)).toEqual([sleeper.pid])
      const ended = await Promise.race([
        sleeper.closed,
        new Promise<undefined>((settle) => setTimeout(() => { settle(undefined) }, KILLED_WITHIN_MS)),
      ])
      expect(ended, `the recorded sleep closed within ${String(KILLED_WITHIN_MS)} ms`).toEqual({ code: null, signal: 'SIGKILL' })
    } finally {
      await reap(sleeper)
    }
  }, 30_000)
})
