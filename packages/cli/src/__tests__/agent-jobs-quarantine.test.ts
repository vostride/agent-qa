// `agent-qa agent-jobs` over a queue holding a quarantined row.
//
// The store half of D-16 is proved in agent-local. What is under test here is the only part an
// operator ever sees: the listing has to NAME the retired kind, the conclusion and the attempt the
// row spent, and the requeue has to refuse the row through the refusal channel this command
// already has — before anything resets the attempts, deletes the checkpoint rows or disowns the
// run's chain-terminal notification.
//
// Every claim is paired, because each passes vacuously alone: the refusal is paired with a requeue
// of an ordinary terminal row that must still succeed, and the "nothing was wedged" claim is
// paired with a pump that must still drain a row enqueued after the refusal.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createRealJobKindRegistry } from '@vostride/agent-qa-agent'
import type { JobModelCapability } from '@vostride/agent-qa-agent'
import {
  DIGEST_JOB_ID_SOURCE,
  LOCAL_CURATION_CAPABILITIES,
  composeJobRecovery,
} from '@vostride/agent-qa-agent-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentJobsCommand } from '../commands/agent-jobs.js'
import { listAgentJobs, pumpAgentJobs, requeueAgentJob } from '../composition/agent-jobs-ops.js'
import type { AgentJobsOpsDeps } from '../composition/agent-jobs-ops.js'

/** A kind no current vocabulary contains — the Phase 412 needle itself stays deleted. */
const RETIRED_KIND = 'retired-kind-fixture'

/**
 * The store's file name, spelled here rather than imported.
 *
 * It is not on agent-local's barrel, and widening a published surface to let a test reach a
 * constant is a worse trade than restating it: if the name ever moves, the raw seed below opens an
 * empty database with no `jobs` table and the insert throws, so this fails closed rather than
 * quietly seeding nothing.
 */
const JOB_STORE_DB_FILE = 'agent-jobs.db'

const NEVER_AUTHORS: JobModelCapability = {
  modelId: 'test:none',
  generate: () => Promise.reject(new Error('the stand-in never authors')),
}

const clock = { now: (): string => new Date().toISOString() }

let roots: string[] = []
let priorExitCode: number | string | undefined

interface Harness {
  readonly deps: AgentJobsOpsDeps
  readonly agentQaRoot: string
  enqueue(key: string): Promise<string>
  seedRetired(id: string, payload: unknown): void
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-422-10-cli-'))
  roots.push(root)
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'knowledge')
  mkdirSync(agentQaRoot, { recursive: true })
  mkdirSync(knowledgeRoot, { recursive: true })

  const open = (): ReturnType<typeof composeJobRecovery> =>
    composeJobRecovery({
      agentQaRoot,
      clock,
      idSource: DIGEST_JOB_ID_SOURCE,
      model: NEVER_AUTHORS,
      jobKinds: createRealJobKindRegistry(),
    })

  const maintenance = LOCAL_CURATION_CAPABILITIES.maintenance
  return {
    agentQaRoot,
    deps: {
      composeJobs: async () => {
        const host = open()
        return {
          jobs: {
            store: host.store,
            kinds: host.kinds,
            queue: host.queue,
            model: NEVER_AUTHORS,
            idSource: DIGEST_JOB_ID_SOURCE,
            // Stated rather than omitted: this double composes no posture, and the empty set is a
            // fact about it rather than a field nobody got round to.
            unclaimableKinds: [],
          },
          close: async () => {
            host.close()
          },
        }
      },
      knowledgeRoot: async () => knowledgeRoot,
      clock,
      acquireWriterLease: maintenance.acquireWriterLease,
      releaseLease: maintenance.releaseLease,
      refreshWriterLeaseAuthority: maintenance.refreshWriterLeaseAuthority,
    },
    async enqueue(key) {
      const host = open()
      try {
        const outcome = await host.queue.enqueue('consolidate', { note: 'readable' }, key)
        return String(outcome.job.id)
      } finally {
        host.close()
      }
    },
    seedRetired(id, payload) {
      const db = new DatabaseSync(join(agentQaRoot, JOB_STORE_DB_FILE))
      try {
        db.prepare(
          `INSERT INTO jobs
             (id, kind, idempotency_key, status, summary, payload, attempts, claimed_at,
              created_at, updated_at, last_failure_kind, last_failure_reason, cancel_requested_at)
           VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL)`,
        ).run(id, RETIRED_KIND, `retired-${id}`, `agent job ${RETIRED_KIND}`,
          JSON.stringify(payload), '2025-12-31T23:59:58.000Z', '2025-12-31T23:59:58.000Z')
      } finally {
        db.close()
      }
    },
  }
}

/** Seed a poisoned head plus a readable follower and pump once, so the quarantine has happened. */
async function quarantinedHarness(): Promise<{ harness: Harness; validId: string }> {
  const harness = makeHarness()
  const validId = await harness.enqueue('first')
  harness.seedRetired('job_retired_head', { runId: 'r_retired', secret: 'never-printed' })

  const pumped = await pumpAgentJobs({ only: 'consolidate' }, harness.deps)
  expect(pumped.kind).toBe('pumped')
  if (pumped.kind !== 'pumped') throw new Error('the fixture pump must drain')
  // Non-vacuity: the readable follower really ran, so every assertion below is about a queue that
  // got past its poisoned head rather than one that never had work to do.
  expect(pumped.outcomes).toHaveLength(1)
  expect(pumped.outcomes[0]).toMatchObject({ jobId: validId, kind: 'consolidate' })
  return { harness, validId }
}

function captureStdout(): { read: () => string; restore: () => void } {
  let buffer = ''
  const spy = vi.spyOn(console, 'log').mockImplementation((value: unknown) => {
    buffer += `${String(value)}\n`
  })
  return { read: () => buffer, restore: () => spy.mockRestore() }
}

function captureStderr(): { read: () => string; restore: () => void } {
  let buffer = ''
  const spy = vi.spyOn(console, 'error').mockImplementation((value: unknown) => {
    buffer += `${String(value)}\n`
  })
  return { read: () => buffer, restore: () => spy.mockRestore() }
}

beforeEach(() => {
  roots = []
  priorExitCode = process.exitCode ?? undefined
})

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  process.exitCode = priorExitCode
  vi.restoreAllMocks()
})

describe('agent-qa agent-jobs list over a quarantined row', () => {
  it('prints the original retired kind, the unreadable-kind conclusion and the spent attempt', async () => {
    const { harness } = await quarantinedHarness()

    const stdout = captureStdout()
    await createAgentJobsCommand({ opsFor: async () => harness.deps })
      .parseAsync(['list'], { from: 'user' })
    stdout.restore()

    const line = stdout
      .read()
      .split('\n')
      .find((candidate) => candidate.includes('job_retired_head'))
    expect(line, `no listing row for the quarantined job:\n${stdout.read()}`).toBeDefined()
    // The three facts an operator needs to act, on ONE line: what the row was, what became of it,
    // and that it cost an attempt rather than being silently dropped.
    expect(line).toContain(RETIRED_KIND)
    expect(line).toContain('unreadable_kind')
    expect(line).toMatch(/\bfailed\b/)
    expect(line).toMatch(/(^|\s)1(\s|$)/)
    // The listing has a conclusion column at all — named, so a reader knows what they are seeing.
    expect(stdout.read()).toContain('conclusion')
    // The disclosure boundary is unchanged: no payload body reaches the terminal.
    expect(stdout.read()).not.toContain('never-printed')
  })

  it('carries the conclusion in the typed DTO and still omits every payload body', async () => {
    const { harness, validId } = await quarantinedHarness()

    const result = await listAgentJobs(harness.deps)

    const quarantined = result.jobs.find((row) => row.id === 'job_retired_head')
    expect(quarantined).toMatchObject({
      kind: RETIRED_KIND,
      status: 'failed',
      attempts: 1,
      conclusionKind: 'unreadable_kind',
    })
    // The control: a readable row carries no conclusion, so the field means something.
    expect(result.jobs.find((row) => row.id === validId)?.conclusionKind).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('never-printed')
  })
})

describe('agent-qa agent-jobs requeue over a quarantined row', () => {
  it('refuses through the existing refusal channel and leaves the history untouched', async () => {
    const { harness } = await quarantinedHarness()
    const before = await listAgentJobs(harness.deps)

    const outcome = await requeueAgentJob('job_retired_head', harness.deps)


    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('unreadable-kind')
    // WR-07. THIS PIN IS INVERTED FROM WHAT IT USED TO SAY, deliberately. It required the
    // message to name the row's own kind, "so the operator reading it knows why this row is
    // different". But `QUARANTINED_UNREADABLE_KIND_REASON` -- the store's own reason column,
    // twenty lines from the error that was interpolating this value -- states the opposite
    // rule with a full rationale: the unreadable kind is a string an EARLIER build, or
    // anything with write access to that database, put in a column, and a rendered-on-a-
    // terminal field is the last place to paste the one value this build refuses to trust.
    // Two rules for one value, and the considered one wins.
    //
    // Actionability does not depend on this: the cell above pins that `listAgentJobs` still
    // discloses `kind: RETIRED_KIND` on the typed DTO, which is where a reader has to ASK for
    // the value and knows what it is when they do.
    expect(String(outcome.message)).not.toContain(RETIRED_KIND)
    expect(String(outcome.message)).toContain('a kind this build does not read')
    expect(String(outcome.message)).toContain('job_retired_head')

    // Nothing moved: same rows, same attempts, same statuses, same conclusion — asserted over the
    // whole row set rather than field by field, so a column this cell never thought to name cannot
    // change unnoticed. The JOBS are compared and not the whole DTO: `epoch` is the writer lease's
    // own counter, and taking a lease in order to be refused advances it whatever the refusal did.
    const after = await listAgentJobs(harness.deps)
    expect(after.jobs).toEqual(before.jobs)
    expect(after.epoch).toBeGreaterThan(before.epoch)
  })

  it('exits 1 and writes the refusal to stderr, printing no success line', async () => {
    const { harness } = await quarantinedHarness()

    const stdout = captureStdout()
    const stderr = captureStderr()
    await createAgentJobsCommand({ opsFor: async () => harness.deps })
      .parseAsync(['requeue', 'job_retired_head'], { from: 'user' })
    stdout.restore()
    stderr.restore()

    expect(process.exitCode).toBe(1)
    expect(stderr.read()).toContain('unreadable-kind')
    expect(stdout.read()).not.toContain('requeued')
  })

  it('still requeues an ordinary terminal row — the control for the refusal above', async () => {
    const { harness, validId } = await quarantinedHarness()

    expect(await requeueAgentJob(validId, harness.deps)).toEqual({ kind: 'requeued' })

    const after = await listAgentJobs(harness.deps)
    expect(after.jobs.find((row) => row.id === validId)).toMatchObject({
      status: 'queued',
      attempts: 0,
    })
  })

  it('drains subsequent valid work after the refusal', async () => {
    const { harness } = await quarantinedHarness()
    expect((await requeueAgentJob('job_retired_head', harness.deps)).kind).toBe('refused')

    const nextId = await harness.enqueue('second')
    const pumped = await pumpAgentJobs({ only: 'consolidate' }, harness.deps)

    expect(pumped.kind).toBe('pumped')
    if (pumped.kind !== 'pumped') return
    expect(pumped.outcomes).toHaveLength(1)
    expect(pumped.outcomes[0]).toMatchObject({ jobId: nextId, disposition: 'completed' })
    // And the quarantined row was not re-offered by that pump.
    const after = await listAgentJobs(harness.deps)
    expect(after.jobs.find((row) => row.id === 'job_retired_head')).toMatchObject({
      attempts: 1,
      conclusionKind: 'unreadable_kind',
    })
  })
})
