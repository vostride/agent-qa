// `crash` and `control` differ only in the hook the store decorator fires; `resume` uses recovery.

import { existsSync, renameSync, writeFileSync } from 'node:fs'

import { createAgentJobQueue, createJobKindRegistry } from '@vostride/agent-qa-agent'
import type { JobStorePort, RunNextJobOutcome } from '@vostride/agent-qa-agent'
import type { JobId, JobKind } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { composeJobRecovery } from '../../../composition/compose-job-recovery.js'
import {
  checkpointCrashHook,
  crashPointsForRegistry,
  instrumentJobStore,
  parseCrashPoint,
  parseVerbCrashPoint,
  verbCrashHook,
} from '../crash-points.js'
import type { JobStoreCall, JobStoreCrashHook } from '../crash-points.js'
import { createCountingModel } from '../counting-model.js'
import {
  KILL_MATRIX_CLOCK,
  KILL_MATRIX_ENV,
  KILL_MATRIX_ID_SOURCE,
  authoringDeclarations,
  fakeWriterLease,
  openKillMatrixStore,
} from '../harness.js'

const childMode = process.env[KILL_MATRIX_ENV.child] === '1'

export type KillMatrixRole = 'crash' | 'control' | 'resume'

export function parseKillMatrixRole(value: string | undefined): KillMatrixRole {
  if (value === 'crash' || value === 'control' || value === 'resume') return value
  throw new Error(`unsupported ${KILL_MATRIX_ENV.role}: ${String(value)}`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function flagEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return value === '1'
}

/** Publish in one step a poller can never observe half of. */
function publishAtomically(path: string, body: string): void {
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, body, 'utf8')
  renameSync(staging, path)
}

/**
 * Announce the crash point and then stop existing, as far as the rest of the run is concerned.
 *
 * `Atomics.wait` on a fresh, never-notified buffer parks the thread with no timer, no polling and
 * no wakeup path, so the process dies exactly where the parent's signal finds it rather than
 * somewhere a timeout raced it to.
 */
function markerAndBlock(path: string, details: Record<string, unknown>): never {
  publishAtomically(path, `${JSON.stringify(details)}\n`)
  const parked = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(parked, 0, 0)
  throw new Error('kill-matrix child resumed from its crash point, which cannot happen')
}

/**
 * One outcome, flattened for a parent in another process.
 *
 * The disposition-specific fields travel too, because they are the ones the adversarial legs are
 * about: WHERE a cancel was honoured, and WHAT a permanent failure's declared disposition enqueued.
 * Reporting only the shared base would leave a leg asserting "it was cancelled" with no way to say
 * at which boundary — and "cancelled somewhere" is satisfied by a cancel honoured too late.
 *
 * `continuationDeduped` is the store's own answer to whether each continuation instance merged into
 * a row that already existed. That distinguishes a newly materialized chain from one that reused
 * an independently created continuation, and it cannot be recovered from the rows afterwards — by
 * then the two look identical.
 */
function outcomeReport(outcome: RunNextJobOutcome): Record<string, unknown> {
  if (!outcome.ran) return { ran: false, reason: outcome.reason }
  const base = {
    ran: true,
    disposition: outcome.disposition,
    jobId: String(outcome.job.id),
    attempts: outcome.job.attempts,
    checkpointsPublished: outcome.checkpointsPublished,
    handlerInvoked: outcome.handlerInvoked,
  }
  if (outcome.disposition === 'cancelled') {
    return { ...base, honoredAtCheckpoint: outcome.honoredAtCheckpoint }
  }
  if (outcome.disposition === 'failed') {
    return {
      ...base,
      reason: outcome.reason,
      continuation: outcome.continuation.map((enqueued) => String(enqueued.job.id)),
      continuationDeduped: outcome.continuation.map((enqueued) => enqueued.deduped),
    }
  }
  if (outcome.disposition === 'completed') {
    return { ...base, chained: outcome.chained.map((enqueued) => String(enqueued.job.id)) }
  }
  if (outcome.disposition === 'interrupted') {
    return { ...base, reason: outcome.reason }
  }
  return {
    ...base,
    reason: outcome.reason,
    retryDelayMs: outcome.retryDelayMs,
    attemptsRemaining: outcome.attemptsRemaining,
  }
}

async function runWorkerRole(role: 'crash' | 'control'): Promise<Record<string, unknown>> {
  const root = requiredEnv(KILL_MATRIX_ENV.root)
  const kind = requiredEnv(KILL_MATRIX_ENV.kind) as JobKind
  const invocationsPath = requiredEnv(KILL_MATRIX_ENV.invocations)
  const consumptionPath = requiredEnv(KILL_MATRIX_ENV.consumption)
  const epoch = Number(requiredEnv(KILL_MATRIX_ENV.epoch))

  const registry = createJobKindRegistry(
    authoringDeclarations({ invocationsPath, consumptionPath }),
  )

  let hook: JobStoreCrashHook = () => undefined
  // Reported back to the parent, because "this host was still armed at the same point and did not
  // reach it" is the poison leg's whole claim — and an absent marker is equally consistent with a
  // host that was quietly never armed at all.
  let armedAt: string | undefined
  if (role === 'crash') {
    const markerPath = requiredEnv(KILL_MATRIX_ENV.marker)
    const checkpointSelector = process.env[KILL_MATRIX_ENV.point]
    const verbSelector = process.env[KILL_MATRIX_ENV.verbPoint]
    // Refused rather than resolved by precedence: two hooks racing in one process would publish a
    // marker naming whichever fired first, and the leg would report the point it did not test.
    if ((checkpointSelector ?? '') !== '' && (verbSelector ?? '') !== '') {
      throw new Error(
        `${KILL_MATRIX_ENV.point} and ${KILL_MATRIX_ENV.verbPoint} are mutually exclusive`,
      )
    }
    if ((verbSelector ?? '') !== '') {
      const point = parseVerbCrashPoint(verbSelector)
      armedAt = point.selector
      hook = verbCrashHook(point, (call: JobStoreCall): never =>
        markerAndBlock(markerPath, {
          selector: point.selector,
          verb: point.verb,
          side: point.side,
          jobId: call.jobId,
          checkpointId: call.checkpointId,
          pid: process.pid,
        }),
      )
    } else {
      const point = parseCrashPoint(checkpointSelector, crashPointsForRegistry(registry))
      if (point.kind !== kind) {
        throw new Error(`crash point ${point.selector} does not belong to kind ${kind}`)
      }
      armedAt = point.selector
      hook = checkpointCrashHook(point, (call: JobStoreCall): never =>
        markerAndBlock(markerPath, {
          selector: point.selector,
          kind: point.kind,
          checkpointId: point.checkpointId,
          phase: point.phase,
          jobId: call.jobId,
          pid: process.pid,
        }),
      )
    }
  }

  const store = openKillMatrixStore(root)
  try {
    const instrumented: JobStorePort = instrumentJobStore(store, hook)
    const queue = createAgentJobQueue({
      store: instrumented,
      registry,
      clock: KILL_MATRIX_CLOCK,
      idSource: KILL_MATRIX_ID_SOURCE,
      model: createCountingModel(invocationsPath),
    })
    const lease = fakeWriterLease(epoch)
    await store.adoptEpoch(lease.epoch)

    // Only when asked. The twelve derived legs kill a job's FIRST host, so there is nothing to
    // release and recovering by default would be plumbing nobody exercises. A poison job needs the
    // opposite: `claimNext` never re-offers a claimed row, so each successive host must reclaim the
    // row its predecessor died holding or the job is STUCK rather than looping.
    const released = flagEnv(KILL_MATRIX_ENV.recover, false)
      ? (await queue.recoverAbandonedClaims({ fence: lease.fence() })).released.map((jobId: JobId) =>
          String(jobId),
        )
      : []

    const outcomes: Record<string, unknown>[] = []
    for (let pumped = 0; pumped < 8; pumped += 1) {
      const outcome = await queue.runNextJob({ fence: lease.fence() })
      outcomes.push(outcomeReport(outcome))
      if (!outcome.ran) break
    }
    return {
      role,
      pid: process.pid,
      kind,
      armedAt: armedAt ?? null,
      released,
      outcomes,
      failed: false,
    }
  } finally {
    store.close()
  }
}

async function runResumeRole(): Promise<Record<string, unknown>> {
  const root = requiredEnv(KILL_MATRIX_ENV.root)
  const invocationsPath = requiredEnv(KILL_MATRIX_ENV.invocations)
  const consumptionPath = requiredEnv(KILL_MATRIX_ENV.consumption)
  const epoch = Number(requiredEnv(KILL_MATRIX_ENV.epoch))

  const host = composeJobRecovery({
    agentQaRoot: root,
    clock: KILL_MATRIX_CLOCK,
    idSource: KILL_MATRIX_ID_SOURCE,
    model: createCountingModel(invocationsPath),
    jobKinds: createJobKindRegistry(authoringDeclarations({ invocationsPath, consumptionPath })),
  })
  try {
    const lease = fakeWriterLease(epoch)
    // Skipping the adoption is the stale-FENCE case: this host still believes it holds the lease
    // and only finds out otherwise when a verb refuses its token at the commit boundary. A host
    // that re-adopts is refused earlier and by a different guard, which is why both are drivable
    // from here rather than one standing in for the other.
    if (flagEnv(KILL_MATRIX_ENV.adopt, true)) {
      await host.store.adoptEpoch(lease.epoch)
    }
    const fence = lease.fence()
    // Recovery FIRST. `claimNext` never re-offers a row whose claim is still set, so a resume that
    // pumped before releasing would report an empty queue over a job nobody is running.
    const recovered = await host.recoverAbandonedClaims(fence)
    const outcomes = await host.resumePending(fence)
    return {
      role: 'resume',
      pid: process.pid,
      released: recovered.released.map((jobId: JobId) => String(jobId)),
      outcomes: outcomes.map(outcomeReport),
      failed: false,
    }
  } finally {
    host.close()
  }
}

describe('kill-matrix child role selector', () => {
  it.each(['crash', 'control', 'resume'] as const)('accepts %s', (role) => {
    expect(parseKillMatrixRole(role)).toBe(role)
  })

  it('refuses an unknown role before any store is opened', () => {
    expect(() => parseKillMatrixRole('drain')).toThrow(
      `unsupported ${KILL_MATRIX_ENV.role}: drain`,
    )
  })

  it('refuses a missing role rather than defaulting to one', () => {
    expect(() => parseKillMatrixRole(undefined)).toThrow('undefined')
  })
})

describe.skipIf(!childMode)('kill-matrix worker child', () => {
  it('runs the role it was asked for', async () => {
    const role = parseKillMatrixRole(process.env[KILL_MATRIX_ENV.role])
    const reportPath = process.env[KILL_MATRIX_ENV.report]
    try {
      const report = role === 'resume' ? await runResumeRole() : await runWorkerRole(role)
      if (reportPath !== undefined && reportPath !== '') {
        publishAtomically(reportPath, `${JSON.stringify(report)}\n`)
      }
    } catch (error) {
      // Reported on the failure path too, so a child that threw is visible to the parent as a
      // report rather than as a bare non-zero exit with its stack buried in captured output.
      // The error's NAME travels separately from its text: a leg asserting a named refusal should
      // assert the class, not a substring of a message somebody may later reword.
      if (reportPath !== undefined && reportPath !== '') {
        publishAtomically(
          reportPath,
          `${JSON.stringify({
            role,
            pid: process.pid,
            failed: true,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
            message: String(error),
          })}\n`,
        )
      }
      throw error
    }
    // The crash role never reaches here: it parks at its crash point and is killed. If a run ever
    // does, the point was not reached and every downstream assertion would be vacuous.
    //
    // Unless the leg said so in advance. A poison job's TERMINAL attempt is armed at exactly the
    // point its predecessors died at and must NOT reach it: the bound is spent, so the handler is
    // never invoked and the hook never fires. Asserting the marker's ABSENCE from inside that host
    // is what makes "it stopped crashing" a measured fact rather than the parent inferring
    // termination from silence.
    if (role === 'crash') {
      const markerPath = requiredEnv(KILL_MATRIX_ENV.marker)
      if (flagEnv(KILL_MATRIX_ENV.unreached, false)) {
        expect(existsSync(markerPath)).toBe(false)
      } else {
        expect(existsSync(markerPath)).toBe(true)
        throw new Error('the crash role completed without being killed at its crash point')
      }
    }
  }, 120_000)
})
