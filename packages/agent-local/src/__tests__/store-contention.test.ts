// Two real OS processes writing one agent job database (Phase 385 plan 03, D-02).
//
// This retires research assumption A4 — that `DatabaseSync`'s `timeout` option really is
// sqlite's busy timeout under lock contention, which was verified to EXIST but never
// exercised under load. The two legs are deliberately different in kind, because a
// "concurrent writers" test whose two writers happen to run one after the other proves
// nothing at all:
//
//   Leg 1 (contention). The parent holds a write transaction open on its own connection and
//   only then releases the child, which is already loaded and waiting. The child's enqueue
//   therefore CANNOT proceed until the parent commits, and the time it spent waiting is
//   reported back. A store that failed fast on a busy lock would report an error instead.
//
//   Leg 2 (interleaving). Both processes then take strict turns, each blocked on seeing the
//   other's previous row. The committed row order is alternating by construction, so this
//   leg cannot pass by accident of scheduling — and it shows no write is lost when two
//   processes are writing the same table.
//
// What this file does NOT prove: that the two processes are ever inside a transaction at the
// same INSTANT during leg 2 (turn-taking is interleaving, not simultaneity — leg 1 is the
// simultaneity proof), and nothing about more than two writers.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import type { ClockPort, JobInsert } from '@vostride/agent-qa-agent'
import { asJobId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'

const ROUNDS = 8
/** How long the parent keeps the write lock after releasing the child. */
const LOCK_HOLD_MS = 900
/** The floor the child's blocked enqueue must clear for the block to be real, not noise. */
const MIN_OBSERVED_BLOCK_MS = 250

const childFixturePath = fileURLToPath(
  new URL('./fixtures/job-store-child.test.ts', import.meta.url),
)
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const vitestPath = join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs')

function steppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`
      tick += 1
      return stamp
    },
  }
}

function insert(id: string, idempotencyKey: string): JobInsert {
  return {
    id: asJobId(id),
    kind: 'analyze-run',
    idempotencyKey,
    summary: `agent job analyze-run (${idempotencyKey})`,
    payload: { from: 'parent' },
  }
}

async function waitFor(
  description: string,
  ready: () => boolean | Promise<boolean>,
  child: ChildProcess,
  output: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await ready()) return
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before ${description}:\n${output()}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}:\n${output()}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('agent job store under real cross-process contention', () => {
  let root: string
  let store: SqliteJobStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-job-contention-'))
    store = createSqliteJobStore({
      path: join(root, AGENT_JOB_STORE_DB_FILE),
      clock: steppingClock(),
      checkpoints: createJobCheckpointStore({ root }),
      timeoutMs: 15_000,
    })
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('blocks a second process on the write lock and loses no write once it clears', async () => {
    const reportPath = join(root, 'child-report.json')
    const readyPath = join(root, 'child-ready')
    const goPath = join(root, 'parent-go')

    const child = spawn(
      process.execPath,
      [vitestPath, 'run', childFixturePath, '--pool=threads', '--maxWorkers=1'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          AGENT_QA_JOB_CHILD: '1',
          AGENT_QA_JOB_CHILD_ROLE: 'store-contention',
          AGENT_QA_JOB_CHILD_ROOT: root,
          AGENT_QA_JOB_CHILD_REPORT: reportPath,
          AGENT_QA_JOB_CHILD_READY: readyPath,
          AGENT_QA_JOB_CHILD_GO: goPath,
          AGENT_QA_JOB_CHILD_ROUNDS: String(ROUNDS),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let childOutput = ''
    const output = (): string => childOutput
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) throw new Error('child pipes were not created')
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        childOutput += chunk
      })
    }

    try {
      await waitFor('the child to load', () => existsSync(readyPath), child, output)

      // A second connection in this process, used exactly the way any other writer would use
      // one. Taking the lock BEFORE releasing the child is what makes the child's wait
      // certain rather than probable.
      const holder = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE), { timeout: 15_000 })
      holder.exec('BEGIN IMMEDIATE')
      writeGo(goPath)
      await new Promise((resolve) => setTimeout(resolve, LOCK_HOLD_MS))
      holder.exec('COMMIT')
      holder.close()

      for (let i = 0; i < ROUNDS; i += 1) {
        await waitFor(
          `child round ${i}`,
          async () =>
            (await store.dumpState()).jobs.some((job) => job.idempotencyKey === `child-${i}`),
          child,
          output,
        )
        await store.enqueue(insert(`job_p${i}`, `parent-${i}`))
      }

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code))
      })
      expect(exitCode, output()).toBe(0)

      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        failed: boolean
        blockedMs: number
        pid: number
        message?: string
      }
      expect(report.failed, report.message).toBe(false)
      // A genuine second OS process, not a worker thread: the rows above were written by a
      // different pid, and a thread would have reported this one.
      expect(report.pid).not.toBe(process.pid)
      expect(report.pid).toBeGreaterThan(0)

      // The evidence that the contention was real: the child's enqueue sat waiting for the
      // lock this process was holding, rather than failing fast or sailing through. A store
      // that surfaced SQLITE_BUSY instead of retrying would have reported a failure above.
      expect(report.blockedMs).toBeGreaterThanOrEqual(MIN_OBSERVED_BLOCK_MS)

      // Every write from both processes landed, and they landed alternating — the turn-taking
      // protocol makes that order a fact rather than a lucky schedule.
      const expectedOrder = ['blocked']
      for (let i = 0; i < ROUNDS; i += 1) expectedOrder.push(`child-${i}`, `parent-${i}`)

      const db = new DatabaseSync(join(root, AGENT_JOB_STORE_DB_FILE))
      try {
        expect(
          db
            .prepare('SELECT idempotency_key AS k FROM jobs ORDER BY rowid ASC')
            .all()
            .map((row) => String(row.k)),
        ).toEqual(expectedOrder)
      } finally {
        db.close()
      }

      const dump = await store.dumpState()
      expect(dump.jobs).toHaveLength(ROUNDS * 2 + 1)
      expect(new Set(dump.jobs.map((job) => job.idempotencyKey)).size).toBe(ROUNDS * 2 + 1)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 120_000)
})

/** Published in one step, so the child cannot observe a marker that is not yet a marker. */
function writeGo(path: string): void {
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, 'go\n', 'utf8')
  renameSync(staging, path)
}
