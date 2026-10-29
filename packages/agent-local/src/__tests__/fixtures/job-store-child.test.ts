// A second OS process that writes the agent job store.
//
// The idiom is v51's `sigkill-drain-child` fixture, generalized so later plans can add roles
// without re-deriving the plumbing: a `.test.ts` that doubles as a child entry point, gated
// by an env flag, with every input arriving as a required environment variable and every
// result handed back as one atomically-published JSON report. Plan 06's kill-matrix worker is
// meant to be another ROLE in this file rather than another file.
//
// The contract, verbatim, for whoever adds the next role:
//   AGENT_QA_JOB_CHILD=1            gate — without it the child suite is skipped entirely
//   AGENT_QA_JOB_CHILD_ROLE         which role to run; an unknown value is refused by name
//   AGENT_QA_JOB_CHILD_ROOT         absolute agent-qa root the store lives under
//   AGENT_QA_JOB_CHILD_REPORT       absolute path the child publishes its JSON report to
//   AGENT_QA_JOB_CHILD_READY        absolute path the child touches when it is loaded
//   AGENT_QA_JOB_CHILD_GO           absolute path the child waits for before acting
//   AGENT_QA_JOB_CHILD_ROUNDS       how many ping-pong rounds to run
// Markers are published temp-then-rename so the parent can never observe a half-written one.

import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ClockPort, JobInsert } from '@vostride/agent-qa-agent'
import { asJobId } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { createJobCheckpointStore } from '../../store/job-checkpoint-store.js'
import {
  AGENT_JOB_STORE_DB_FILE,
  createSqliteJobStore,
} from '../../store/sqlite-job-store.js'

const childMode = process.env.AGENT_QA_JOB_CHILD === '1'

export type JobChildRole = 'store-contention'

export function parseJobChildRole(value: string | undefined): JobChildRole {
  if (value === 'store-contention') return value
  throw new Error(`unsupported AGENT_QA_JOB_CHILD_ROLE: ${String(value)}`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

/** Publish a marker the parent may be polling, in one step it cannot see half of. */
function publishMarker(path: string, body: string): void {
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, body, 'utf8')
  renameSync(staging, path)
}

async function waitFor(
  description: string,
  ready: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await ready()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function steppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-01-01T00:01:${String(tick).padStart(2, '0')}.000Z`
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
    payload: { from: 'child' },
  }
}

describe('agent job store child role selector', () => {
  it('accepts the roles it knows', () => {
    expect(parseJobChildRole('store-contention')).toBe('store-contention')
  })

  it('refuses an unknown role before any store is opened', () => {
    expect(() => parseJobChildRole('not-a-role')).toThrow(
      'unsupported AGENT_QA_JOB_CHILD_ROLE: not-a-role',
    )
  })

  it('refuses a missing role rather than defaulting to one', () => {
    expect(() => parseJobChildRole(undefined)).toThrow('undefined')
  })
})

describe.skipIf(!childMode)('agent job store child', () => {
  it('writes the same database as its parent', async () => {
    const role = parseJobChildRole(process.env.AGENT_QA_JOB_CHILD_ROLE)
    expect(role).toBe('store-contention')

    const root = requiredEnv('AGENT_QA_JOB_CHILD_ROOT')
    const reportPath = requiredEnv('AGENT_QA_JOB_CHILD_REPORT')
    const readyPath = requiredEnv('AGENT_QA_JOB_CHILD_READY')
    const goPath = requiredEnv('AGENT_QA_JOB_CHILD_GO')
    const rounds = Number(requiredEnv('AGENT_QA_JOB_CHILD_ROUNDS'))

    const store = createSqliteJobStore({
      path: join(root, AGENT_JOB_STORE_DB_FILE),
      clock: steppingClock(),
      checkpoints: createJobCheckpointStore({ root }),
      // Generous on purpose: the point of this leg is that a writer WAITS for the lock, and
      // a timeout tight enough to expire on a loaded machine would turn the proof into noise.
      timeoutMs: 15_000,
    })

    async function keyExists(key: string): Promise<boolean> {
      const dump = await store.dumpState()
      return dump.jobs.some((job) => job.idempotencyKey === key)
    }

    try {
      // Constructed BEFORE the handshake, so the schema statements this open runs are not
      // what ends up blocking below — the measurement has to be of the enqueue itself.
      publishMarker(readyPath, 'ready\n')
      await waitFor('the parent to take the write lock', () => existsSync(goPath))

      const startedAt = Date.now()
      await store.enqueue(insert('job_blocked', 'blocked'))
      const blockedMs = Date.now() - startedAt

      // Strict alternation, enforced by the protocol rather than hoped for: neither side can
      // write round i+1 until it has SEEN the other side's round i, so the committed row
      // order is a fact about two processes taking turns, not a coincidence of scheduling.
      for (let i = 0; i < rounds; i += 1) {
        await store.enqueue(insert(`job_c${i}`, `child-${i}`))
        await waitFor(`parent round ${i}`, () => keyExists(`parent-${i}`))
      }

      publishMarker(
        reportPath,
        `${JSON.stringify({ blockedMs, rounds, pid: process.pid, failed: false })}\n`,
      )
    } catch (error) {
      publishMarker(
        reportPath,
        `${JSON.stringify({ failed: true, message: String(error) })}\n`,
      )
      throw error
    } finally {
      store.close()
    }
  }, 60_000)
})
