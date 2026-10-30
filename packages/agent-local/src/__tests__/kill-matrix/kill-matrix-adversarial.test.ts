// Each family asserts positive evidence too, because each guarantee passes vacuously alone.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { StaleJobStoreEpochError, createRealJobKindRegistry } from '@vostride/agent-qa-agent'
import type { JobKindDeclaration, JobModelCapability } from '@vostride/agent-qa-agent'
import { jobSchema } from '@vostride/agent-qa-schema'
import type { JobKind } from '@vostride/agent-qa-schema'
import { afterAll, describe, expect, it } from 'vitest'

import { composeJobRecovery } from '../../composition/compose-job-recovery.js'
import {
  AGENT_JOB_STORE_DB_FILE,
  AGENT_JOB_STORE_USER_VERSION,
} from '../../store/sqlite-job-store.js'
import { checkpointIdOfPrompt, readConsumptions, readInvocations } from './counting-model.js'
import {
  JOB_CRASH_SIDES,
  JOB_STORE_VERBS,
  crashPointSelector,
  instrumentJobStore,
  parseVerbCrashPoint,
  verbCrashHook,
  verbCrashSelector,
} from './crash-points.js'
import type { JobStoreCall } from './crash-points.js'
import {
  KILL_MATRIX_CLOCK,
  KILL_MATRIX_ENV,
  KILL_MATRIX_EPOCH,
  KILL_MATRIX_ID_SOURCE,
  KILL_MATRIX_INSTANT,
  fakeWriterLease,
  jobIdFor,
  openKillMatrixStore,
  readStoreSnapshot,
  seedJob,
} from './harness.js'
import type { KillMatrixSnapshot } from './harness.js'
import {
  LEG_TIMEOUT_MS,
  cleanupKillMatrixRoots,
  killIfRunning,
  makeRoot,
  runChildExpectingRefusal,
  runChildToCompletion,
  sendRealSigkill,
  startChild,
  waitForCrashMarker,
} from './spawn-control.js'
import type { KillMatrixPaths } from './spawn-control.js'

const registry = createRealJobKindRegistry()

afterAll(cleanupKillMatrixRoots)

function declarationFor(kind: JobKind): JobKindDeclaration {
  return registry.require(kind)
}

// Asked of the producer the engine runs, not `allowedSuccessors`, so the matrix tracks real chains.
function continuationKindsFor(kind: JobKind, jobId: string, payload: unknown): readonly JobKind[] {
  const disposition = declarationFor(kind).onPermanentFailure
  if (disposition === 'halt-chain') return []
  return disposition({
    job: { id: jobId, kind } as unknown as Parameters<typeof disposition>[0]['job'],
    payload,
    // Only the KINDS are read here, and no producer's kind set depends on the reason text.
    reason: 'asking the producer which continuations it makes',
  }).map((request) => request.kind)
}

function jobRows(snapshot: KillMatrixSnapshot): readonly Record<string, unknown>[] {
  return snapshot.outcome.tables.find((table) => table.table === 'jobs')?.rows ?? []
}

function jobRow(snapshot: KillMatrixSnapshot, jobId: string): Record<string, unknown> {
  const row = jobRows(snapshot).find((candidate) => candidate.id === jobId)
  expect(row, `no jobs row for ${jobId}; rows: ${JSON.stringify(jobRows(snapshot))}`).toBeDefined()
  return row!
}

function jobHistory(snapshot: KillMatrixSnapshot, jobId: string): Record<string, unknown> {
  const row = snapshot.history.jobs.find((candidate) => candidate.id === jobId)
  expect(row, `no history row for ${jobId}`).toBeDefined()
  return row!
}

function checkpointPath(jobId: string, checkpointId: string): string {
  return `${jobId}/${checkpointId}.json`
}

function checkpointFileNames(snapshot: KillMatrixSnapshot): readonly string[] {
  return Object.keys(snapshot.checkpointBytes).sort()
}

function authoredCheckpointIds(invocationsPath: string, from = 0): readonly string[] {
  return readInvocations(invocationsPath)
    .slice(from)
    .map((invocation) => checkpointIdOfPrompt(invocation.prompt))
}

function consumedCheckpointIds(consumptionPath: string, from = 0): readonly string[] {
  return readConsumptions(consumptionPath)
    .slice(from)
    .map((entry) => entry.checkpointId)
}

/** The base environment every adversarial child shares. Roles and points are layered on top. */
function childEnv(
  paths: KillMatrixPaths,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
    [KILL_MATRIX_ENV.invocations]: paths.invocations,
    [KILL_MATRIX_ENV.consumption]: paths.consumption,
    [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
    ...extra,
  }
}

// Spawn a crash host, wait for its marker, and kill it by the signal while it is alive.
async function crashAt(
  paths: KillMatrixPaths,
  markerPath: string,
  selector: string,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const running = startChild(
    childEnv(paths, {
      [KILL_MATRIX_ENV.role]: 'crash',
      [KILL_MATRIX_ENV.marker]: markerPath,
      ...env,
    }),
  )
  try {
    const marker = await waitForCrashMarker(running, markerPath, selector)
    expect(marker.selector).toBe(selector)
    expect(marker.pid, 'the worker must be a second OS process').not.toBe(process.pid)
    await sendRealSigkill(running.child)
    return marker
  } finally {
    await killIfRunning(running.child)
  }
}

// ---- the new selector vocabulary ------------------------------------------------------------------

describe('verb crash points, beside the checkpoint points', () => {
  // A hook that can never fire is a leg that proves nothing while reporting success, so every
  // component of a selector is refused by name before a store is opened.
  it('refuses an unknown verb, an unknown side, and a missing selector — by name', () => {
    expect(() => parseVerbCrashPoint('drainEverything:before')).toThrow('verb: drainEverything')
    expect(() => parseVerbCrashPoint('recordFailure:during')).toThrow('side: during')
    expect(() => parseVerbCrashPoint(undefined)).toThrow('undefined')
    expect(() => parseVerbCrashPoint('')).toThrow('AGENT_QA_JOB_KILL_VERB_POINT')
    expect(() => parseVerbCrashPoint('recordFailure:before:a:b')).toThrow('recordFailure:before:a:b')
  })

  it('accepts every verb the decorator actually intercepts, on both sides', () => {
    expect(JOB_STORE_VERBS.length).toBeGreaterThan(0)
    for (const verb of JOB_STORE_VERBS) {
      for (const side of JOB_CRASH_SIDES) {
        expect(parseVerbCrashPoint(verbCrashSelector(verb, side))).toMatchObject({ verb, side })
      }
    }
  })

  // The narrowing is load-bearing: the failure path enqueues rows the leg never seeded, so a hook
  // that ignored the id would fire on the wrong call and the leg would name a point it never hit.
  it('fires only on the named verb, side and row', () => {
    const fired: JobStoreCall[] = []
    const hook = verbCrashHook(
      parseVerbCrashPoint(verbCrashSelector('recordFailure', 'before', 'job_wanted')),
      (call): never => {
        fired.push(call)
        throw new Error('reached')
      },
    )
    hook('before', { verb: 'enqueue', jobId: 'job_wanted' })
    hook('after', { verb: 'recordFailure', jobId: 'job_wanted' })
    hook('before', { verb: 'recordFailure', jobId: 'job_other' })
    expect(fired).toEqual([])
    expect(() => hook('before', { verb: 'recordFailure', jobId: 'job_wanted' })).toThrow('reached')
    expect(fired).toEqual([{ verb: 'recordFailure', jobId: 'job_wanted' }])
  })

  it('leaves an un-narrowed selector free to fire on any row of its verb', () => {
    const seen: string[] = []
    const hook = verbCrashHook(
      parseVerbCrashPoint(verbCrashSelector('enqueue', 'after')),
      (call): never => {
        seen.push(String(call.jobId))
        throw new Error('reached')
      },
    )
    expect(() => hook('after', { verb: 'enqueue', jobId: 'job_any' })).toThrow('reached')
    expect(seen).toEqual(['job_any'])
  })

  it('stands beside every verb of the real store, not a subset', async () => {
    const paths = makeRoot('verb-seam')
    const store = openKillMatrixStore(paths.agentQaRoot)
    const observed: string[] = []
    try {
      const instrumented = instrumentJobStore(store, (side, call) => {
        observed.push(`${call.verb}:${side}`)
      })
      await instrumented.adoptEpoch(KILL_MATRIX_EPOCH)
      await instrumented.dumpState()
      expect(observed).toEqual([
        'adoptEpoch:before',
        'adoptEpoch:after',
        'dumpState:before',
        'dumpState:after',
      ])
    } finally {
      store.close()
    }
  })
})

// ---- LEG FAMILY 1: the poison job -------------------------------------------------

describe('a poison job that SIGKILLs its host on every attempt', () => {
  // `consolidate` declares maxAttempts 2, which is the cheapest bound that is still a bound.
  //
  // THE BOUND IS SPENT AT THE CLAIM, so the arithmetic is: claims 1..maxAttempts run the handler,
  // and the claim that arrives as maxAttempts+1 is refused before the handler ever sees the job.
  // The terminal row therefore reads `attempts = maxAttempts + 1` — the extra claim is the one that
  // DETECTS the exhaustion, and asserting `attempts === maxAttempts` would be asserting a state the
  // engine never reaches. What equals maxAttempts is the number of times the handler ran, and that
  // is asserted separately from the durable artifacts.
  it('exhausts its declared bound through claim-time counting and lands failed, never looping', async () => {
    const kind: JobKind = 'consolidate'
    const declaration = declarationFor(kind)
    const maxAttempts = declaration.maxAttempts
    // Every expectation below is arithmetic over `maxAttempts`, which would re-derive itself
    // through a changed bound. These two literals are what make a bound change RED here.
    expect(maxAttempts).toBe(2)
    expect(declaration.backoff).toEqual({ kind: 'fixed', delayMs: 5_000 })
    const checkpointId = declaration.checkpointSchedule[0]!
    const selector = crashPointSelector(kind, checkpointId, 'before-publish')

    const paths = makeRoot('poison')
    const jobId = String(await seedJob(paths.agentQaRoot, kind))
    expect(jobId).toBe(String(jobIdFor(kind)))

    const markerFor = (attempt: number): string => join(paths.root, `crash-${attempt}.marker`)

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const marker = await crashAt(paths, markerFor(attempt), selector, {
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.point]: selector,
        // Every host after the first must reclaim the row its predecessor died holding: `claimNext`
        // never re-offers a claimed row, so without this the job would be STUCK rather than
        // looping — the failure mode this whole leg exists to distinguish from termination.
        [KILL_MATRIX_ENV.recover]: attempt === 1 ? '0' : '1',
      })
      expect(marker.checkpointId).toBe(checkpointId)

      const crashed = await readStoreSnapshot(paths.agentQaRoot)
      expect(jobRow(crashed, jobId)).toMatchObject({ id: jobId, status: 'queued' })
      expect(
        jobRow(crashed, jobId).claimed_at,
        'a killed host leaves its claim behind, which is why recovery must release it',
      ).not.toBeNull()
      // THE COUNTER MOVED. This is the whole mechanism: the attempt was spent by the claim, and a
      // host that never returned recorded no failure of its own.
      expect(jobHistory(crashed, jobId).attempts).toBe(attempt)
      expect(authoredCheckpointIds(paths.invocations)).toHaveLength(attempt)
      expect(existsSync(join(paths.agentQaRoot, 'agent-jobs', 'checkpoints', jobId))).toBe(false)
    }

    // THE TERMINAL HOST. Configured to crash at exactly the same point as its two predecessors, and
    // told that the point is expected to be unreachable — so the child asserts from the inside that
    // its marker was never written, rather than the parent inferring termination from silence.
    const terminalMarker = markerFor(maxAttempts + 1)
    const terminal = await runChildToCompletion(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'crash',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.point]: selector,
        [KILL_MATRIX_ENV.marker]: terminalMarker,
        [KILL_MATRIX_ENV.recover]: '1',
        [KILL_MATRIX_ENV.unreached]: '1',
        [KILL_MATRIX_ENV.report]: paths.report,
      }),
      paths.report,
    )
    expect(existsSync(terminalMarker), 'the crash point must be unreachable once the bound is spent').toBe(false)
    // AND IT WAS STILL ARMED. An absent marker is equally consistent with a host that was never
    // given a crash point at all, so the host reports the selector it installed and it is required
    // to be the same one its two predecessors died at.
    expect(terminal.armedAt).toBe(selector)
    // It DID reclaim the row — so it stopped because the bound was spent, not because nothing was
    // ever offered to it. This is the assertion that separates "exhausted" from "stuck".
    expect(terminal.released).toEqual([jobId])
    expect(terminal.outcomes).toMatchObject([
      {
        ran: true,
        disposition: 'failed',
        jobId,
        attempts: maxAttempts + 1,
        checkpointsPublished: [],
        // The handler was NEVER HANDED THE JOB. That is the mechanism: the bound is consulted
        // between the claim and the handler, which is the one point a job that kills its host
        // cannot skip.
        handlerInvoked: false,
        continuation: [],
      },
      { ran: false, reason: 'no-job' },
    ])
    expect(terminal.outcomes).toHaveLength(2)

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRow(settled, jobId)).toMatchObject({ id: jobId, status: 'failed', claimed_at: null })
    const history = jobHistory(settled, jobId)
    expect(history.attempts).toBe(maxAttempts + 1)
    expect(history.last_failure_kind).toBe('permanent')
    expect(String(history.last_failure_reason)).toContain(`the attempt bound of ${maxAttempts} is spent`)
    expect(String(history.last_failure_reason)).toContain(`attempt ${maxAttempts + 1}`)

    // The handler ran exactly maxAttempts times and the model was invoked exactly as often — the
    // positive half. A poison job that had been silently skipped would show zero of both.
    expect(authoredCheckpointIds(paths.invocations)).toEqual(
      Array.from({ length: maxAttempts }, () => checkpointId),
    )
    expect(consumedCheckpointIds(paths.consumption)).toEqual(
      Array.from({ length: maxAttempts }, () => checkpointId),
    )
    expect(new Set(readInvocations(paths.invocations).map((entry) => entry.pid)).size).toBe(maxAttempts)
    // Nothing durable was ever produced: every host died before its first publish.
    expect(checkpointFileNames(settled)).toEqual([])
    expect(jobRows(settled)).toHaveLength(1)
  }, LEG_TIMEOUT_MS)
})

// ---- LEG FAMILY 2: a kill around the atomic failure path -----------------------------

describe('SIGKILL inside the permanent-failure disposition', () => {
  const kind: JobKind = 'analyze-run'
  const REASON = 'analyze-run kill-matrix adversarial permanent failure'
  const PAYLOAD = { fail: 'permanent', reason: REASON } as const

  function continuationIdFor(jobId: string, successor: JobKind): string {
    return String(KILL_MATRIX_ID_SOURCE.jobIdFor(successor, `${jobId}->${successor}`))
  }

  it('leaves no continuation before failAndChain, then resumes into one complete set', async () => {
    const declaration = declarationFor(kind)
    const checkpointId = declaration.checkpointSchedule[0]!
    const paths = makeRoot('failure-path-record')
    const jobId = String(await seedJob(paths.agentQaRoot, kind, PAYLOAD))
    const successors = continuationKindsFor(kind, jobId, PAYLOAD)
    // Non-vacuity: a failure continuing into nothing would satisfy every assertion below.
    expect(successors.length).toBeGreaterThan(0)
    const selector = verbCrashSelector('failAndChain', 'before', jobId)

    const marker = await crashAt(paths, paths.marker, selector, {
      [KILL_MATRIX_ENV.kind]: kind,
      [KILL_MATRIX_ENV.verbPoint]: selector,
      [KILL_MATRIX_ENV.payload]: JSON.stringify(PAYLOAD),
    })
    expect(marker).toMatchObject({ verb: 'failAndChain', side: 'before', jobId })

    const crashed = await readStoreSnapshot(paths.agentQaRoot)
    // The producer ran, but the single durable boundary has not: no partial successor may escape.
    for (const successor of successors) {
      expect(jobRows(crashed).some((row) => row.kind === successor)).toBe(false)
    }
    expect(jobRow(crashed, jobId)).toMatchObject({ id: jobId, status: 'queued' })
    expect(jobRow(crashed, jobId).claimed_at).not.toBeNull()
    expect(jobHistory(crashed, jobId)).toEqual({
      id: jobId,
      attempts: 1,
      last_failure_kind: null,
      last_failure_reason: null,
    })
    expect(jobRows(crashed)).toHaveLength(1)
    expect(checkpointFileNames(crashed)).toEqual([checkpointPath(jobId, checkpointId)])
    const authoredPreCrash = authoredCheckpointIds(paths.invocations)
    expect(authoredPreCrash).toEqual([checkpointId])

    const resumed = await runChildToCompletion(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: paths.report,
      }),
      paths.report,
    )
    expect(resumed.released).toEqual([jobId])
    // The resume DRAINS: it finishes the failed head and then runs the continuations that head's
    // disposition had already enqueued. That is the point of the disposition — a permanently failed
    // analysis must not leave its downstream jobs waiting on a dead head — so the drain is asserted
    // rather than avoided. Matched by id, because with a frozen clock the claim order is id order.
    const outcomes = resumed.outcomes as Record<string, unknown>[]
    expect(outcomes).toHaveLength(1 + successors.length)
    const failedOutcome = outcomes.find((entry) => entry.jobId === jobId)
    expect(failedOutcome).toMatchObject({
      ran: true,
      disposition: 'failed',
      attempts: 2,
      handlerInvoked: true,
      // The recorded checkpoint was NOT republished on the way through.
      checkpointsPublished: [],
      reason: REASON,
      continuationDeduped: successors.map(() => false),
      continuation: successors.map((successor) => continuationIdFor(jobId, successor)),
    })
    for (const successor of successors) {
      expect(
        outcomes.find((entry) => entry.jobId === continuationIdFor(jobId, successor)),
      ).toMatchObject({ ran: true, disposition: 'completed' })
    }

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    // EXACTLY ONE of each continuation, whatever the replay did.
    expect(jobRows(settled)).toHaveLength(1 + successors.length)
    for (const successor of successors) {
      expect(jobRows(settled).filter((row) => row.kind === successor)).toHaveLength(1)
      expect(jobRow(settled, continuationIdFor(jobId, successor))).toMatchObject({
        idempotency_key: `${jobId}->${successor}`,
        status: 'done',
      })
    }
    expect(jobRow(settled, jobId)).toMatchObject({ id: jobId, status: 'failed', claimed_at: null })
    expect(jobHistory(settled, jobId)).toEqual({
      id: jobId,
      attempts: 2,
      last_failure_kind: 'permanent',
      last_failure_reason: REASON,
    })
    // The recorded checkpoint was never re-authored across the crash: same bytes, and the resume's
    // authorship delta names the continuations' OWN checkpoints and nothing this job had recorded.
    expect(settled.checkpointBytes[checkpointPath(jobId, checkpointId)]).toBe(
      crashed.checkpointBytes[checkpointPath(jobId, checkpointId)],
    )
    const authoredOnResume = authoredCheckpointIds(paths.invocations, authoredPreCrash.length)
    expect(authoredOnResume, 'a recorded checkpoint must never be authored again').not.toContain(
      checkpointId,
    )
    expect([...authoredOnResume].sort()).toEqual(
      successors.flatMap((successor) => [...declarationFor(successor).checkpointSchedule]).sort(),
    )
  }, LEG_TIMEOUT_MS)

  it('makes the terminal parent and every continuation visible before failAndChain returns', async () => {
    const declaration = declarationFor(kind)
    const checkpointId = declaration.checkpointSchedule[0]!
    const paths = makeRoot('failure-path-atomic')
    const jobId = String(await seedJob(paths.agentQaRoot, kind, PAYLOAD))
    const successors = continuationKindsFor(kind, jobId, PAYLOAD)
    // Non-vacuity: a failure continuing into nothing would satisfy every assertion below.
    expect(successors.length).toBeGreaterThan(0)
    const selector = verbCrashSelector('failAndChain', 'after', jobId)

    const marker = await crashAt(paths, paths.marker, selector, {
      [KILL_MATRIX_ENV.kind]: kind,
      [KILL_MATRIX_ENV.verbPoint]: selector,
      [KILL_MATRIX_ENV.payload]: JSON.stringify(PAYLOAD),
    })
    expect(marker).toMatchObject({ verb: 'failAndChain', side: 'after', jobId })

    const crashed = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRow(crashed, jobId)).toMatchObject({ status: 'failed', claimed_at: null })
    expect(jobHistory(crashed, jobId)).toMatchObject({
      attempts: 1,
      last_failure_kind: 'permanent',
      last_failure_reason: REASON,
    })
    for (const successor of successors) {
      expect(jobRow(crashed, continuationIdFor(jobId, successor))).toMatchObject({
        kind: successor,
        status: 'queued',
      })
    }
    expect(jobRows(crashed)).toHaveLength(1 + successors.length)
    expect(checkpointFileNames(crashed)).toEqual([checkpointPath(jobId, checkpointId)])
    const authoredPreCrash = authoredCheckpointIds(paths.invocations)
    expect(authoredPreCrash).toEqual([checkpointId])

    const resumed = await runChildToCompletion(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: paths.report,
      }),
      paths.report,
    )
    expect(resumed.released).toEqual([])
    const outcomes = resumed.outcomes as Record<string, unknown>[]
    expect(outcomes).toHaveLength(successors.length)
    expect(outcomes.some((entry) => entry.jobId === jobId)).toBe(false)
    for (const successor of successors) {
      expect(outcomes.find((entry) => entry.jobId === continuationIdFor(jobId, successor))).toMatchObject({
        ran: true,
        disposition: 'completed',
      })
    }

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRows(settled)).toHaveLength(1 + successors.length)
    for (const successor of successors) {
      expect(jobRows(settled).filter((row) => row.kind === successor)).toHaveLength(1)
      expect(jobRow(settled, continuationIdFor(jobId, successor))).toMatchObject({ status: 'done' })
    }
    expect(jobRow(settled, jobId)).toMatchObject({ status: 'failed', claimed_at: null })
    expect(jobHistory(settled, jobId)).toMatchObject({
      attempts: 1,
      last_failure_kind: 'permanent',
      last_failure_reason: REASON,
    })
    expect(settled.checkpointBytes[checkpointPath(jobId, checkpointId)]).toBe(
      crashed.checkpointBytes[checkpointPath(jobId, checkpointId)],
    )
    const authoredOnResume = authoredCheckpointIds(paths.invocations, authoredPreCrash.length)
    expect(authoredOnResume).not.toContain(checkpointId)
    expect([...authoredOnResume].sort()).toEqual(
      successors.flatMap((successor) => [...declarationFor(successor).checkpointSchedule]).sort(),
    )
  }, LEG_TIMEOUT_MS)
})

// ---- LEG FAMILY 3: a cancel that crosses a crash --------------------------------------------

describe('a cancel requested mid-run, honoured across a crash', () => {
  // `curate-memory` is the only two-checkpoint kind, so it is the only one where "the boundary
  // after the crash" and "the boundary the job never reached" are different places.
  it('survives the kill with the request intact and lands cancelled at the next boundary', async () => {
    const kind: JobKind = 'curate-memory'
    const [firstCheckpoint, secondCheckpoint] = declarationFor(kind).checkpointSchedule
    expect(firstCheckpoint).toBeDefined()
    expect(secondCheckpoint).toBeDefined()
    const selector = crashPointSelector(kind, firstCheckpoint!, 'after-publish')

    const paths = makeRoot('cancel-across-crash')
    const jobId = String(await seedJob(paths.agentQaRoot, kind))

    const running = startChild(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'crash',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.point]: selector,
        [KILL_MATRIX_ENV.marker]: paths.marker,
      }),
    )
    try {
      const marker = await waitForCrashMarker(running, paths.marker, selector)
      expect(marker.pid).not.toBe(process.pid)

      // A cancel from another process while the holder is parked: the store only records it.
      const lease = fakeWriterLease(KILL_MATRIX_EPOCH)
      const store = openKillMatrixStore(paths.agentQaRoot)
      try {
        expect(await store.requestCancel(jobIdFor(kind), lease.fence())).toEqual({
          outcome: 'cancel-requested',
        })
      } finally {
        store.close()
      }

      await sendRealSigkill(running.child)
    } finally {
      await killIfRunning(running.child)
    }

    const crashed = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRow(crashed, jobId)).toMatchObject({ id: jobId, status: 'queued' })
    expect(jobRow(crashed, jobId).claimed_at).not.toBeNull()
    expect(jobRow(crashed, jobId).cancel_requested_at).not.toBeNull()
    expect(checkpointFileNames(crashed)).toEqual([checkpointPath(jobId, firstCheckpoint!)])
    const authoredPreCrash = authoredCheckpointIds(paths.invocations)
    expect(authoredPreCrash).toEqual([firstCheckpoint!])
    const consumedPreCrash = consumedCheckpointIds(paths.consumption)
    expect(consumedPreCrash).toEqual([firstCheckpoint!])

    const resumed = await runChildToCompletion(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: paths.report,
      }),
      paths.report,
    )
    // Recovery returns the row to the queue WITH the request still on it — if it cleared the
    // request as part of "cleaning up", the resumed job would run to completion instead.
    expect(resumed.released).toEqual([jobId])
    expect(resumed.outcomes).toMatchObject([
      {
        ran: true,
        disposition: 'cancelled',
        jobId,
        attempts: 2,
        handlerInvoked: true,
        honoredAtCheckpoint: firstCheckpoint!,
        checkpointsPublished: [],
      },
    ])

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRow(settled, jobId)).toMatchObject({
      id: jobId,
      status: 'cancelled',
      claimed_at: null,
    })
    // The step already durable stays durable, byte for byte; the step after the boundary never
    // existed and never will.
    expect(settled.checkpointBytes[checkpointPath(jobId, firstCheckpoint!)]).toBe(
      crashed.checkpointBytes[checkpointPath(jobId, firstCheckpoint!)],
    )
    expect(checkpointFileNames(settled)).toEqual([checkpointPath(jobId, firstCheckpoint!)])
    expect(
      existsSync(
        join(paths.agentQaRoot, 'agent-jobs', 'checkpoints', jobId, `${secondCheckpoint!}.json`),
      ),
    ).toBe(false)

    // CHECKPOINT TWO WAS NEVER ENTERED. The consumption log records a boundary before the
    // authorship call, so the resumed run naming only the first is the statement that the handler
    // was unwound at that boundary rather than after the second one.
    expect(consumedCheckpointIds(paths.consumption, consumedPreCrash.length)).toEqual([
      firstCheckpoint!,
    ])
    // And the boundary sits on the READ, so the cancel was honoured BEFORE any model call: zero
    // further invocations, beside a pre-crash count that is deliberately non-zero.
    expect(authoredCheckpointIds(paths.invocations, authoredPreCrash.length)).toEqual([])
    expect(authoredPreCrash.length).toBeGreaterThan(0)
  }, LEG_TIMEOUT_MS)
})

// ---- LEG FAMILY 4: fencing, with a fake lease -------------------------------------

describe('a resume carrying a stale epoch, proven with a fake lease', () => {
  it('refuses both the re-adoption and the stale fence, changes nothing, and lets the holder finish', async () => {
    const kind: JobKind = 'consolidate'
    const checkpointId = declarationFor(kind).checkpointSchedule[0]!
    const selector = crashPointSelector(kind, checkpointId, 'after-publish')

    const paths = makeRoot('stale-epoch')
    const jobId = String(await seedJob(paths.agentQaRoot, kind))

    const held = fakeWriterLease(KILL_MATRIX_EPOCH)
    const successor = fakeWriterLease(KILL_MATRIX_EPOCH + 1)

    const running = startChild(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'crash',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.point]: selector,
        [KILL_MATRIX_ENV.marker]: paths.marker,
        [KILL_MATRIX_ENV.epoch]: String(held.epoch),
      }),
    )
    let markerPid: unknown
    try {
      const marker = await waitForCrashMarker(running, paths.marker, selector)
      markerPid = marker.pid
      // AUTHORITY MOVES while the old host is parked — the fake lease's successor adopts.
      const store = openKillMatrixStore(paths.agentQaRoot)
      try {
        expect(await store.adoptEpoch(successor.epoch)).toEqual({ epoch: successor.epoch })
      } finally {
        store.close()
      }
      await sendRealSigkill(running.child)
    } finally {
      await killIfRunning(running.child)
    }

    const crashed = await readStoreSnapshot(paths.agentQaRoot)
    expect(checkpointFileNames(crashed)).toEqual([checkpointPath(jobId, checkpointId)])
    expect(jobRow(crashed, jobId)).toMatchObject({ id: jobId, status: 'queued' })

    // (a) THE RETURNING HOST tries to re-arm at the epoch it still believes it holds. Refused
    //     before it touches a row: authority only ever moves forward.
    const staleAdopt = await runChildExpectingRefusal(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: join(paths.root, 'stale-adopt.report.json'),
        [KILL_MATRIX_ENV.epoch]: String(held.epoch),
      }),
      join(paths.root, 'stale-adopt.report.json'),
    )
    expect(staleAdopt.errorName).toBe('StaleJobStoreEpochError')
    expect(String(staleAdopt.errorMessage)).toContain(`held epoch ${held.epoch}`)
    expect(String(staleAdopt.errorMessage)).toContain(`observed ${successor.epoch}`)
    expect((await readStoreSnapshot(paths.agentQaRoot)).logicalDump).toBe(crashed.logicalDump)

    // (b) The split-brain host keeps its old token and is refused at the commit boundary.
    const staleFence = await runChildExpectingRefusal(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: join(paths.root, 'stale-fence.report.json'),
        [KILL_MATRIX_ENV.epoch]: String(held.epoch),
        [KILL_MATRIX_ENV.adopt]: '0',
      }),
      join(paths.root, 'stale-fence.report.json'),
    )
    expect(staleFence.errorName).toBe('StaleJobStoreEpochError')
    expect((await readStoreSnapshot(paths.agentQaRoot)).logicalDump).toBe(crashed.logicalDump)

    // (c) THE NEGATIVE CONTROL, without which "a stale epoch is refused" is satisfied by a store
    //     that refuses everything: the current holder resumes the very same job and finishes it.
    const holder = await runChildToCompletion(
      childEnv(paths, {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.report]: paths.report,
        [KILL_MATRIX_ENV.epoch]: String(successor.epoch),
      }),
      paths.report,
    )
    expect(holder.released).toEqual([jobId])
    expect(holder.outcomes).toMatchObject([
      { ran: true, disposition: 'completed', jobId, attempts: 2, checkpointsPublished: [] },
    ])

    // EXACTLY ONE EXECUTION RECORD across four hosts: one row, one checkpoint file with the bytes
    // the dead host wrote, and one model invocation — made by that host, not by either refused one.
    const settled = await readStoreSnapshot(paths.agentQaRoot)
    expect(jobRows(settled)).toHaveLength(1)
    expect(jobRow(settled, jobId)).toMatchObject({ id: jobId, status: 'done', claimed_at: null })
    expect(checkpointFileNames(settled)).toEqual([checkpointPath(jobId, checkpointId)])
    expect(settled.checkpointBytes[checkpointPath(jobId, checkpointId)]).toBe(
      crashed.checkpointBytes[checkpointPath(jobId, checkpointId)],
    )
    const invocations = readInvocations(paths.invocations)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]!.pid).toBe(markerPid)
    expect(authoredCheckpointIds(paths.invocations)).toEqual([checkpointId])
  }, LEG_TIMEOUT_MS)
})

// ---- LEG FAMILY 5: a retired-kind row at the head of the FIFO ----------

describe('a retired-kind row at the head of the FIFO', () => {
  // Spelled independently: a constant this build exported for a retired kind would be the bug.
  const RETIRED_KIND = 'retired-kind-fixture'

  // The FIXED, MASKED reason a quarantine records. Spelled out rather than imported for the same
  // reason the kind is: an assertion that read the production constant would agree with whatever
  // that constant became, including an interpolation of the unreadable bytes it exists to withhold.
  const QUARANTINE_REASON =
    'agent job quarantined at claim: this build does not read the kind recorded for this row, so '
    + 'the row was landed permanently without being parsed. The original kind, id and payload are '
    + 'preserved in the row for inspection.'

  const NEVER_AUTHORS: JobModelCapability = {
    modelId: 'test:none',
    generate: () => Promise.reject(new Error('the stand-in never authors')),
  }

  /**
   * Write one row under a kind the shipped contract does not contain.
   *
   * Raw SQL on purpose: `enqueue` parses what it inserted through `jobSchema` before returning it,
   * so the store itself cannot produce this row. The bytes an EARLIER build left behind are the
   * subject, and the only honest way to obtain them is to write them the way that build did.
   */
  function seedRetiredKindRow(
    agentQaRoot: string,
    id: string,
    payload: unknown,
    createdAt: string,
  ): void {
    const db = new DatabaseSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try {
      db.prepare(
        `INSERT INTO jobs
           (id, kind, idempotency_key, status, summary, payload, attempts, claimed_at,
            created_at, updated_at, last_failure_kind, last_failure_reason, cancel_requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL)`,
      ).run(id, RETIRED_KIND, `retired-${id}`, `agent job ${RETIRED_KIND}`,
        JSON.stringify(payload), createdAt, createdAt)
    } finally {
      db.close()
    }
  }

  function readRawRows(agentQaRoot: string): readonly Record<string, unknown>[] {
    const db = new DatabaseSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try {
      return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC, id ASC').all()
    } finally {
      db.close()
    }
  }

  function stampedVersion(agentQaRoot: string): number {
    const db = new DatabaseSync(join(agentQaRoot, AGENT_JOB_STORE_DB_FILE))
    try {
      return Number(db.prepare('PRAGMA user_version').get()?.user_version)
    } finally {
      db.close()
    }
  }

  function recoveryHost(agentQaRoot: string): ReturnType<typeof composeJobRecovery> {
    return composeJobRecovery({
      agentQaRoot,
      clock: KILL_MATRIX_CLOCK,
      idSource: KILL_MATRIX_ID_SOURCE,
      model: NEVER_AUTHORS,
    })
  }

  it('lands every poisoned head permanently with its attempt spent and runs the valid follower', async () => {
    const kind: JobKind = 'consolidate'
    const paths = makeRoot('quarantine-retired-kind')
    // Seeded FIRST, so the database exists, is stamped, and has adopted the epoch before any raw
    // row is written into it.
    const validJobId = String(await seedJob(paths.agentQaRoot, kind))

    // TWO poisoned rows, both older than the valid one. One would be satisfied by an
    // implementation that quarantines a row and then gives up on the rest of the claim; the FIFO
    // order is what makes them heads rather than stragglers.
    const poisonPayloads = {
      job_retired_a: { runId: 'r_retired_a', note: 'written by a build that still had this kind' },
      job_retired_b: { runId: 'r_retired_b', note: 'the second poisoned head' },
    } as const
    seedRetiredKindRow(paths.agentQaRoot, 'job_retired_a', poisonPayloads.job_retired_a,
      '2025-12-31T23:59:58.000Z')
    seedRetiredKindRow(paths.agentQaRoot, 'job_retired_b', poisonPayloads.job_retired_b,
      '2025-12-31T23:59:59.000Z')

    // (a) THE STALE FENCE, BEFORE ANY MUTATION. A quarantine is a write, so a claim carrying an
    //     epoch the store does not recognise must be refused with nothing moved — otherwise the
    //     new path would be a way for a host that lost its lease to land another writer's rows.
    const stale = openKillMatrixStore(paths.agentQaRoot)
    try {
      await expect(stale.claimNext({ epoch: KILL_MATRIX_EPOCH + 7 })).rejects.toBeInstanceOf(
        StaleJobStoreEpochError,
      )
    } finally {
      stale.close()
    }
    for (const row of readRawRows(paths.agentQaRoot)) {
      expect(row.attempts, 'a refused claim spends no attempt').toBe(0)
      expect(row.status).toBe('queued')
    }

    // (b) THE DRAIN. One fenced pass over a queue whose two head rows cannot be parsed.
    const host = recoveryHost(paths.agentQaRoot)
    let drainError: unknown
    let outcomes: readonly { ran: boolean }[] = []
    try {
      const fence = await host.store.adoptEpoch(KILL_MATRIX_EPOCH)
      outcomes = await host
        .resumePending(fence)
        .catch((error: unknown) => {
          drainError = error
          return []
        })
    } finally {
      host.close()
    }
    expect(
      drainError,
      `a poisoned head must be quarantined inside the claim, never surfaced: ${String(drainError)}`,
    ).toBeUndefined()
    // EXACTLY ONE execution: the valid follower, once. Two would mean the poisoned rows were
    // handed to a handler; zero would mean the queue stopped at the head it could not read.
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      ran: true,
      disposition: 'completed',
      job: { id: validJobId, kind, attempts: 1 },
    })

    // (c) THE DURABLE LANDING, read back through a fresh connection so it is the COMMIT that is
    //     asserted rather than anything a live handle is holding open.
    const rows = readRawRows(paths.agentQaRoot)
    expect(rows.map((row) => String(row.id))).toEqual([
      'job_retired_a',
      'job_retired_b',
      validJobId,
    ])
    for (const id of ['job_retired_a', 'job_retired_b'] as const) {
      const row = rows.find((candidate) => String(candidate.id) === id)!
      // Claim and quarantine commit in one transaction, so a thrown parser cannot unspend it.
      expect(Number(row.attempts), `${id} must have spent its claim`).toBe(1)
      expect(String(row.status)).toBe('failed')
      expect(row.claimed_at).toBeNull()
      expect(String(row.last_failure_kind)).toBe('permanent')
      // The reason is FIXED and carries none of the unreadable bytes it describes.
      expect(String(row.last_failure_reason)).toBe(QUARANTINE_REASON)
      expect(String(row.last_failure_reason)).not.toContain(RETIRED_KIND)
      // THE HISTORY SURVIVED. Kind, id and payload are exactly the bytes the earlier build wrote.
      expect(String(row.kind)).toBe(RETIRED_KIND)
      expect(JSON.parse(String(row.payload))).toEqual(poisonPayloads[id])
    }
    const valid = rows.find((row) => String(row.id) === validJobId)!
    expect(String(valid.status)).toBe('done')
    expect(Number(valid.attempts)).toBe(1)

    // (d) NO SILENT WIDENING. The store is still the version this build reads, and the retired
    //     kind is still not a Job — the quarantine records an outcome, it does not admit a kind.
    expect(stampedVersion(paths.agentQaRoot)).toBe(AGENT_JOB_STORE_USER_VERSION)
    expect(AGENT_JOB_STORE_USER_VERSION).toBe(2)
    const parsable = {
      id: validJobId,
      kind,
      status: 'failed',
      summary: 'agent job consolidate',
      attempts: 1,
      createdAt: KILL_MATRIX_INSTANT,
      updatedAt: KILL_MATRIX_INSTANT,
    }
    expect(jobSchema.safeParse(parsable).success).toBe(true)
    expect(
      jobSchema.safeParse({ ...parsable, kind: RETIRED_KIND }).success,
      'a quarantined kind must never become a valid Job',
    ).toBe(false)
    // The conclusion the quarantine names IS in the shipped vocabulary, so a reader can type the
    // outcome without widening the kinds.
    expect(jobSchema.safeParse({ ...parsable, conclusionKind: 'unreadable_kind' }).success).toBe(
      true,
    )
    expect(jobSchema.safeParse({ ...parsable, conclusionKind: 'unreadable-kind' }).success).toBe(
      false,
    )

    // (e) REOPEN AND DRAIN AGAIN. A landed row is permanent: it is never re-offered, so the second
    //     pass spends no further attempt and runs nothing at all.
    const second = recoveryHost(paths.agentQaRoot)
    try {
      const fence = await second.store.adoptEpoch(KILL_MATRIX_EPOCH)
      expect(await second.resumePending(fence)).toEqual([])
    } finally {
      second.close()
    }
    const settled = readRawRows(paths.agentQaRoot)
    for (const id of ['job_retired_a', 'job_retired_b'] as const) {
      expect(Number(settled.find((row) => String(row.id) === id)!.attempts)).toBe(1)
    }
  })
})
