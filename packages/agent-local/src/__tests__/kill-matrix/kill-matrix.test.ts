// The kill matrix (Phase 385 plan 06 — JOBQ-03's acceptance instrument, D-09/D-12).
//
// LEG COUNT AND RUNTIME BUDGET, stated because a silently capped matrix reads as full coverage.
// Every derived crash point runs; nothing is sampled: two points per declared checkpoint of every
// checkpointed kind, each spawning a crash child and a resume child, plus one control child per
// checkpointed kind (cached across that kind's legs) and one 2-spawn idempotency leg. The count is
// derived from the registry, so a reworked kind changes it with no edit here beyond the pinned
// list below.
//
// WHAT EACH LEG PROVES, and the three ways a leg like this normally proves nothing:
//
//   1. A child that exited instead of being killed makes every later assertion vacuous. So the kill
//      is proven twice: the exit is asserted to be a SIGNAL (`code === null`, `signal === 'SIGKILL'`)
//      rather than merely non-zero, and the durable state left behind is asserted to be exactly the
//      state of the named point — the checkpoints before it exist, the one at it does not.
//   2. "Zero model invocations on resume" is satisfied perfectly by a matrix that never invoked a
//      model at all. So both halves are asserted from the same artifact: the first host's invocation
//      count is non-zero and names exactly the checkpoints it authored, and the resume's delta names
//      exactly the checkpoints that were NOT recorded — which is zero precisely when the crash came
//      after the last publish, and is checked to contain no recorded checkpoint in any case.
//   3. A comparison whose expected value comes from the run under test compares a value to itself.
//      So the expected value is an UNINTERRUPTED control run of the same job in its own store, in
//      its own process, and the comparison is byte equality of a canonical projection whose
//      exclusions are separately asserted with exact values rather than dropped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REAL_JOB_KIND_DECLARATIONS,
  createJobKindRegistry,
  createRealJobKindRegistry,
} from '@vostride/agent-qa-agent'
import type { JobKindDeclaration } from '@vostride/agent-qa-agent'
import type { JobKind } from '@vostride/agent-qa-schema'
import { afterAll, describe, expect, it } from 'vitest'

import {
  CHECKPOINT_ROW_SOURCE_COLUMNS,
  KILL_MATRIX_EPOCH,
  KILL_MATRIX_ENV,
  KILL_MATRIX_INSTANT,
  authoringDeclarations,
  jobIdFor,
  readStoreSnapshot,
  seedJob,
} from './harness.js'
import type { KillMatrixSnapshot } from './harness.js'
import {
  JOB_CRASH_PHASES,
  crashPointsForKind,
  crashPointsForRegistry,
  parseCrashPoint,
  pendingCheckpointsAtCrash,
  recordedCheckpointsAtCrash,
} from './crash-points.js'
import type { JobCrashPoint } from './crash-points.js'
import { checkpointIdOfPrompt, readConsumptions, readInvocations } from './counting-model.js'
// The parent-side spawn/kill/marker plumbing, lifted into its own module when plan 07's adversarial
// legs arrived. Nothing about it changed; the legs below drive exactly the protocol they always did.
import {
  LEG_TIMEOUT_MS,
  cleanupKillMatrixRoots,
  killIfRunning,
  makeRoot,
  runChildToCompletion,
  sendRealSigkill,
  startChild,
  waitForCrashMarker,
} from './spawn-control.js'

const registry = createRealJobKindRegistry()
const CRASH_POINTS = crashPointsForRegistry(registry)
const CHECKPOINTED = registry.list().filter((declaration) => declaration.checkpointed)

afterAll(cleanupKillMatrixRoots)

function declarationFor(kind: JobKind): JobKindDeclaration {
  return registry.require(kind)
}

function checkpointFileNames(snapshot: KillMatrixSnapshot): readonly string[] {
  return Object.keys(snapshot.checkpointBytes).sort()
}

function jobRow(snapshot: KillMatrixSnapshot): Record<string, unknown> {
  const jobs = snapshot.outcome.tables.find((table) => table.table === 'jobs')
  expect(jobs?.rows, 'the matrix drives exactly one job per leg').toHaveLength(1)
  return jobs!.rows[0]!
}

function jobHistory(snapshot: KillMatrixSnapshot): Record<string, unknown> {
  expect(snapshot.history.jobs).toHaveLength(1)
  return snapshot.history.jobs[0]!
}

/** Checkpoint artifacts are addressed by PATH and enumerated in path order, not schedule order. */
function checkpointPaths(jobId: string, checkpointIds: readonly string[]): readonly string[] {
  return checkpointIds.map((checkpointId) => `${jobId}/${checkpointId}.json`).sort()
}

function byPath<T extends { path: string }>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function byCheckpointId<T extends { checkpointId: unknown }>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((left, right) =>
    String(left.checkpointId) < String(right.checkpointId) ? -1 : 1,
  )
}

function authoredCheckpointIds(invocationsPath: string, from = 0): readonly string[] {
  return readInvocations(invocationsPath)
    .slice(from)
    .map((invocation) => checkpointIdOfPrompt(invocation.prompt))
}

// ---- the control runs (the independent expected value) --------------------------------------------

interface ControlRun {
  readonly agentQaRoot: string
  readonly snapshot: KillMatrixSnapshot
  readonly authored: readonly string[]
  readonly consumed: readonly string[]
}

const controls = new Map<JobKind, ControlRun>()

async function controlFor(kind: JobKind): Promise<ControlRun> {
  const cached = controls.get(kind)
  if (cached !== undefined) return cached

  const paths = makeRoot(`control-${kind}`)
  await seedJob(paths.agentQaRoot, kind)
  const report = await runChildToCompletion(
    {
      [KILL_MATRIX_ENV.role]: 'control',
      [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
      [KILL_MATRIX_ENV.kind]: kind,
      [KILL_MATRIX_ENV.invocations]: paths.invocations,
      [KILL_MATRIX_ENV.consumption]: paths.consumption,
      [KILL_MATRIX_ENV.report]: paths.report,
      [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
    },
    paths.report,
  )
  expect(report.outcomes).toMatchObject([{ ran: true, disposition: 'completed', attempts: 1 }, { ran: false }])

  const run: ControlRun = {
    agentQaRoot: paths.agentQaRoot,
    snapshot: await readStoreSnapshot(paths.agentQaRoot),
    authored: authoredCheckpointIds(paths.invocations),
    consumed: readConsumptions(paths.consumption).map((entry) => entry.checkpointId),
  }
  controls.set(kind, run)
  return run
}

// ---- the derivation ------------------------------------------------------------------------------

describe('crash-point derivation', () => {
  it('produces exactly two points per declared checkpoint, for every registered kind', () => {
    for (const declaration of registry.list()) {
      const points = crashPointsForKind(declaration)
      expect(points).toHaveLength(declaration.checkpointSchedule.length * 2)
      for (const checkpointId of declaration.checkpointSchedule) {
        expect(points.filter((point) => point.checkpointId === checkpointId).map((p) => p.phase))
          .toEqual([...JOB_CRASH_PHASES])
      }
    }
    expect(new Set(CRASH_POINTS.map((point) => point.selector)).size).toBe(CRASH_POINTS.length)
  })

  // A pin on today's shipped kind set, listed rather than counted so a change says WHAT changed.
  // An intentional kind rework updates this list; nothing else in the harness moves.
  it('derives exactly the crash points the shipped kinds imply', () => {
    expect(CRASH_POINTS.map((point) => point.selector)).toEqual([
      'analyze-run:verdicts-authored:before-publish',
      'analyze-run:verdicts-authored:after-publish',
      'consolidate:consolidation-authored:before-publish',
      'consolidate:consolidation-authored:after-publish',
      'curate-memory:candidates-authored:before-publish',
      'curate-memory:candidates-authored:after-publish',
      'curate-memory:bundle-committed:before-publish',
      'curate-memory:bundle-committed:after-publish',
    ])
  })

  // The accounting line: chat's absence from the matrix is a declaration, not an oversight.
  it('skips chat, the one kind that declares checkpointed: false and contributes no crash point', () => {
    const chat = registry.require('chat')
    expect(chat.checkpointed).toBe(false)
    expect(chat.checkpointSchedule).toEqual([])
    expect(crashPointsForKind(chat)).toEqual([])
    expect(CRASH_POINTS.some((point) => point.kind === 'chat')).toBe(false)
    expect(CHECKPOINTED.map((declaration) => declaration.kind)).not.toContain('chat')
  })

  it('refuses an unknown selector by name and never defaults to one', () => {
    expect(() => parseCrashPoint('analyze-run:nope:before-publish', CRASH_POINTS)).toThrow(
      'unsupported AGENT_QA_JOB_KILL_POINT',
    )
    expect(() => parseCrashPoint(undefined, CRASH_POINTS)).toThrow('undefined')
    expect(parseCrashPoint(CRASH_POINTS[0]!.selector, CRASH_POINTS)).toEqual(CRASH_POINTS[0])
  })

  it('splits each schedule into recorded and pending with nothing lost', () => {
    for (const point of CRASH_POINTS) {
      const schedule = declarationFor(point.kind).checkpointSchedule
      const recorded = recordedCheckpointsAtCrash(schedule, point)
      const pending = pendingCheckpointsAtCrash(schedule, point)
      expect([...recorded, ...pending]).toEqual([...schedule])
      expect(recorded).toHaveLength(point.checkpointIndex + (point.phase === 'after-publish' ? 1 : 0))
    }
  })

  it('drives the SAME crash points through the authoring substitution as through the shipped kinds', () => {
    const substituted = authoringDeclarations({ invocationsPath: '/dev/null', consumptionPath: '/dev/null' })
    expect(crashPointsForRegistry(createJobKindRegistry(substituted))).toEqual([...CRASH_POINTS])
  })

  it('substitutes the handler and carries every other declared field through unchanged', () => {
    const substituted = authoringDeclarations({ invocationsPath: '/dev/null', consumptionPath: '/dev/null' })
    expect(substituted).toHaveLength(REAL_JOB_KIND_DECLARATIONS.length)
    substituted.forEach((declaration, index) => {
      const shipped = REAL_JOB_KIND_DECLARATIONS[index]!
      expect(declaration.handler).not.toBe(shipped.handler)
      const { handler: _substituted, ...restOfSubstituted } = declaration
      const { handler: _shipped, ...restOfShipped } = shipped
      expect(restOfSubstituted).toEqual(restOfShipped)
    })
  })
})

// ---- the composition entry -----------------------------------------------------------------------

describe('the resume composition entry', () => {
  it('names no model package, and the scan is proven to have read the right file', () => {
    const entry = fileURLToPath(
      new URL('../../composition/compose-job-recovery.ts', import.meta.url),
    )
    const source = readFileSync(entry, 'utf8')
    // Assembled rather than spelled: a scan whose needle appears in the scanning file, or in a
    // comment of the scanned one, finds itself and reports a violation that is only its own text.
    const modelPackage = ['agent', 'qa', 'model'].join('-')
    const offending = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter((entryLine) => entryLine.text.includes(modelPackage))
    expect(offending, `compose-job-recovery.ts must not name the model package`).toEqual([])
    // Positive control: the scan reads a file that DOES contain a package specifier, so a scan
    // pointed at a missing or empty file cannot report an all-clear.
    expect(source).toContain(['agent', 'qa', 'agent'].join('-'))
    expect(source.length).toBeGreaterThan(1000)
  })
})

// ---- the matrix ----------------------------------------------------------------------------------

const legOutcomes = new Map<string, string>()

describe('kill matrix: every registered kind x declared checkpoint x before/after publish', () => {
  // Enumerated by iterating the DERIVED points rather than by `it.each`, so the whole selector
  // reaches the report: vitest truncates an interpolated title, and two legs of the same kind whose
  // names collide after truncation are two legs nobody can tell apart in a failure.
  for (const point of CRASH_POINTS) {
    const leg = point
    it(
      `survives SIGKILL at ${leg.selector} and resumes without re-authoring a recorded checkpoint`,
      async () => {
      const declaration = declarationFor(point.kind)
      const schedule = declaration.checkpointSchedule
      const recorded = recordedCheckpointsAtCrash(schedule, point)
      const pending = pendingCheckpointsAtCrash(schedule, point)
      const authoredBeforeCrash = schedule.slice(0, point.checkpointIndex + 1)

      const paths = makeRoot(point.selector.replaceAll(':', '-'))
      const jobId = String(await seedJob(paths.agentQaRoot, point.kind))
      expect(jobId).toBe(String(jobIdFor(point.kind)))

      const running = startChild({
        [KILL_MATRIX_ENV.role]: 'crash',
        [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
        [KILL_MATRIX_ENV.kind]: point.kind,
        [KILL_MATRIX_ENV.point]: point.selector,
        [KILL_MATRIX_ENV.invocations]: paths.invocations,
        [KILL_MATRIX_ENV.consumption]: paths.consumption,
        [KILL_MATRIX_ENV.marker]: paths.marker,
        [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
      })

      try {
        const marker = await waitForCrashMarker(running, paths.marker, point.selector)
        expect(marker).toMatchObject({
          selector: point.selector,
          kind: point.kind,
          checkpointId: point.checkpointId,
          phase: point.phase,
          jobId,
        })
        expect(marker.pid, 'the worker must be a second OS process').not.toBe(process.pid)

        // (1) THE KILL, PROVEN: a signal death, not merely a non-zero exit.
        await sendRealSigkill(running.child)

        // (1b) AT THE RIGHT POINT: the durable state left behind is exactly the named point's.
        const crashed = await readStoreSnapshot(paths.agentQaRoot)
        expect(checkpointFileNames(crashed)).toEqual(checkpointPaths(jobId, recorded))
        for (const checkpointId of pending) {
          expect(existsSync(join(paths.agentQaRoot, 'agent-jobs', 'checkpoints', jobId, `${checkpointId}.json`))).toBe(false)
        }
        expect(jobRow(crashed)).toMatchObject({ id: jobId, status: 'queued' })
        expect(jobRow(crashed).claimed_at, 'a killed host leaves its claim behind').not.toBeNull()
        expect(jobHistory(crashed)).toEqual({
          id: jobId,
          attempts: 1,
          last_failure_kind: null,
          last_failure_reason: null,
        })

        // (2a) THE POSITIVE HALF: the first host really did invoke the model, for exactly the
        // checkpoints it reached. Without this, "zero on resume" is satisfied by never authoring.
        const authoredPreCrash = authoredCheckpointIds(paths.invocations)
        expect(authoredPreCrash).toEqual([...authoredBeforeCrash])
        expect(authoredPreCrash.length).toBeGreaterThan(0)
        const consumedPreCrash = readConsumptions(paths.consumption)
        expect(consumedPreCrash.map((entry) => entry.checkpointId)).toEqual([...authoredBeforeCrash])
        expect(new Set(consumedPreCrash.map((entry) => entry.pid))).toEqual(new Set([marker.pid]))

        // (3) THE RESUME, in a fresh process, through the recovery composition entry.
        const resumeReport = await runChildToCompletion(
          {
            [KILL_MATRIX_ENV.role]: 'resume',
            [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
            [KILL_MATRIX_ENV.kind]: point.kind,
            [KILL_MATRIX_ENV.invocations]: paths.invocations,
            [KILL_MATRIX_ENV.consumption]: paths.consumption,
            [KILL_MATRIX_ENV.report]: paths.report,
            [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
          },
          paths.report,
        )
        expect(resumeReport.released).toEqual([jobId])
        // `resumePending` returns the jobs it RAN, so exactly one entry means the recovered job was
        // finished and nothing else was claimed. The published list is the second, independent
        // signal that the recorded checkpoints were consumed rather than rewritten.
        expect(resumeReport.outcomes).toMatchObject([
          {
            ran: true,
            disposition: 'completed',
            jobId,
            attempts: 2,
            handlerInvoked: true,
            checkpointsPublished: [...pending],
          },
        ])
        expect(resumeReport.outcomes).toHaveLength(1)
        expect(resumeReport.pid).not.toBe(marker.pid)

        // (2b) THE ZERO HALF, from the same durable artifact, and named rather than counted.
        const authoredOnResume = authoredCheckpointIds(paths.invocations, authoredPreCrash.length)
        expect(authoredOnResume).toEqual([...pending])
        for (const checkpointId of recorded) {
          expect(
            authoredOnResume,
            `a recorded checkpoint must never be authored again (JOBQ-03)`,
          ).not.toContain(checkpointId)
        }
        if (pending.length === 0) {
          expect(authoredOnResume).toHaveLength(0)
        }

        // The backstop: the resumed run entered every checkpoint of the schedule, in declared
        // order — recorded ones were consumed, not skipped.
        const consumedOnResume = readConsumptions(paths.consumption).slice(consumedPreCrash.length)
        expect(consumedOnResume.map((entry) => entry.checkpointId)).toEqual([...schedule])
        expect(new Set(consumedOnResume.map((entry) => entry.pid))).toEqual(
          new Set([resumeReport.pid]),
        )

        // (4) CONVERGENCE against an independent uninterrupted control run.
        const control = await controlFor(point.kind)
        const resumed = await readStoreSnapshot(paths.agentQaRoot)
        expect(control.authored).toEqual([...schedule])
        expect(control.consumed).toEqual([...schedule])
        expect(resumed.canonicalOutcome).toBe(control.snapshot.canonicalOutcome)
        legOutcomes.set(point.selector, resumed.canonicalOutcome)

        // Raw file bytes, with no projection at all, for every checkpoint that survived the crash.
        for (const checkpointId of recorded) {
          const path = `${jobId}/${checkpointId}.json`
          expect(resumed.checkpointBytes[path]).toBe(control.snapshot.checkpointBytes[path])
        }

        // (5) THE EXCLUSIONS, asserted by exact value rather than dropped.
        expect(jobHistory(resumed)).toEqual({
          id: jobId,
          attempts: 2,
          last_failure_kind: 'retry',
          last_failure_reason:
            'the claim was abandoned by a host that did not finish it',
        })
        expect(jobHistory(control.snapshot)).toEqual({
          id: jobId,
          attempts: 1,
          last_failure_kind: null,
          last_failure_reason: null,
        })
        expect(resumed.history.checkpoints).toEqual(
          byPath(
            schedule.map((checkpointId) => ({
              path: `${jobId}/${checkpointId}.json`,
              attempt: recorded.includes(checkpointId) ? 1 : 2,
            })),
          ),
        )
        expect(control.snapshot.history.checkpoints).toEqual(
          byPath(
            schedule.map((checkpointId) => ({
              path: `${jobId}/${checkpointId}.json`,
              attempt: 1,
            })),
          ),
        )
        expect(resumed.history.checkpointRows).toEqual(
          byCheckpointId(
            schedule.map((checkpointId) => ({
              jobId,
              checkpointId,
              attempt: recorded.includes(checkpointId) ? 1 : 2,
              epoch: KILL_MATRIX_EPOCH,
            })),
          ),
        )
        expect(control.snapshot.history.checkpointRows).toEqual(
          byCheckpointId(
            schedule.map((checkpointId) => ({
              jobId,
              checkpointId,
              attempt: 1,
              epoch: KILL_MATRIX_EPOCH,
            })),
          ),
        )
        expect(jobRow(resumed)).toMatchObject({
          status: 'done',
          claimed_at: null,
          created_at: KILL_MATRIX_INSTANT,
          updated_at: KILL_MATRIX_INSTANT,
        })

        // Completeness: every column of the table is classified as outcome or history. A column
        // added later must be placed deliberately rather than vanishing from both.
        expect([...Object.keys(jobRow(resumed)), ...Object.keys(jobHistory(resumed))].sort()).toEqual(
          [...resumed.jobColumns, 'id'].sort(),
        )
        expect(resumed.checkpointColumns).toEqual(CHECKPOINT_ROW_SOURCE_COLUMNS)
        // 388 plan 01 adds `notifications`. Named here rather than admitted by a contains
        // check for the same reason as every other exhaustive list in this matrix: the failure
        // mode a crash comparison has is agreeing that two states are the same because the
        // instrument stopped looking at the table that differed.
        expect(resumed.tableNames).toEqual([
          'job_checkpoints',
          'job_store_fence',
          'jobs',
          'notifications',
        ])
      } finally {
        await killIfRunning(running.child)
      }
      },
      LEG_TIMEOUT_MS,
    )
  }

  it('converges on the SAME final state from either side of every checkpoint publish', () => {
    for (const declaration of CHECKPOINTED) {
      for (const checkpointId of declaration.checkpointSchedule) {
        const before = legOutcomes.get(`${declaration.kind}:${checkpointId}:before-publish`)
        const after = legOutcomes.get(`${declaration.kind}:${checkpointId}:after-publish`)
        expect(before, `no before-publish leg ran for ${declaration.kind}/${checkpointId}`).toBeDefined()
        expect(after).toBeDefined()
        expect(before).toBe(after)
      }
    }
    expect(legOutcomes.size).toBe(CRASH_POINTS.length)
  })
})

describe('the comparison basis', () => {
  // Every equality assertion above is only as good as this. A projection that answered the same
  // string whatever it was handed — the phase-384 defect, in its exact shape — would make ten
  // convergence assertions pass while proving nothing at all. So the instrument is required to
  // MOVE with what it claims to describe, and the split between outcome and history is required to
  // move in each direction independently.
  it('varies with the state it describes, and its two halves move independently', async () => {
    const paths = makeRoot('varies')
    const kind: JobKind = 'consolidate'
    const checkpointId = declarationFor(kind).checkpointSchedule[0]!
    const jobId = String(await seedJob(paths.agentQaRoot, kind))

    const queued = await readStoreSnapshot(paths.agentQaRoot)
    expect(queued.outcome.checkpoints).toEqual([])

    await runChildToCompletion(
      {
        [KILL_MATRIX_ENV.role]: 'control',
        [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.invocations]: paths.invocations,
        [KILL_MATRIX_ENV.consumption]: paths.consumption,
        [KILL_MATRIX_ENV.report]: paths.report,
        [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
      },
      paths.report,
    )
    const done = await readStoreSnapshot(paths.agentQaRoot)
    expect(done.canonicalOutcome).not.toBe(queued.canonicalOutcome)

    const file = join(paths.agentQaRoot, 'agent-jobs', 'checkpoints', jobId, `${checkpointId}.json`)
    const original = readFileSync(file, 'utf8')
    const envelope = JSON.parse(original) as {
      payload: { attempt: number; value: { text: string } }
    }

    // An authored byte moves the OUTCOME and leaves the history alone.
    envelope.payload.value.text = `${envelope.payload.value.text}!`
    writeFileSync(file, `${JSON.stringify(envelope)}\n`, 'utf8')
    const authoredDifferently = await readStoreSnapshot(paths.agentQaRoot)
    expect(authoredDifferently.canonicalOutcome).not.toBe(done.canonicalOutcome)
    expect(authoredDifferently.history).toEqual(done.history)

    // The excluded field moves the HISTORY and leaves the outcome alone — which is exactly the
    // claim that makes excluding it honest rather than convenient.
    writeFileSync(file, original, 'utf8')
    const restored = JSON.parse(original) as { payload: { attempt: number } }
    restored.payload.attempt = 9
    writeFileSync(file, `${JSON.stringify(restored)}\n`, 'utf8')
    const attemptedDifferently = await readStoreSnapshot(paths.agentQaRoot)
    expect(attemptedDifferently.canonicalOutcome).toBe(done.canonicalOutcome)
    expect(attemptedDifferently.history).not.toEqual(done.history)
  }, LEG_TIMEOUT_MS)
})

describe('resuming a job that is already done', () => {
  it('invokes nothing, releases nothing and changes not one byte', async () => {
    const paths = makeRoot('idempotent')
    const kind: JobKind = 'curate-memory'
    const jobId = String(await seedJob(paths.agentQaRoot, kind))

    const first = await runChildToCompletion(
      {
        [KILL_MATRIX_ENV.role]: 'control',
        [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.invocations]: paths.invocations,
        [KILL_MATRIX_ENV.consumption]: paths.consumption,
        [KILL_MATRIX_ENV.report]: paths.report,
        [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
      },
      paths.report,
    )
    expect(first.outcomes).toMatchObject([{ ran: true, disposition: 'completed' }, { ran: false }])

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    const authoredBefore = readInvocations(paths.invocations).length
    expect(authoredBefore).toBe(declarationFor(kind).checkpointSchedule.length)

    const second = await runChildToCompletion(
      {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
        [KILL_MATRIX_ENV.kind]: kind,
        [KILL_MATRIX_ENV.invocations]: paths.invocations,
        [KILL_MATRIX_ENV.consumption]: paths.consumption,
        [KILL_MATRIX_ENV.report]: join(paths.root, 'second.report.json'),
        [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
      },
      join(paths.root, 'second.report.json'),
    )
    expect(second.released).toEqual([])
    // Nothing RAN: a terminal job is not claimable, so recovery released nothing and the pump
    // found nothing. An empty list here is the no-op, stated rather than inferred.
    expect(second.outcomes).toEqual([])

    const after = await readStoreSnapshot(paths.agentQaRoot)
    // The FULL D-03 dump this time, with no projection at all: a no-op has no history to excuse.
    expect(after.logicalDump).toBe(settled.logicalDump)
    expect(readInvocations(paths.invocations)).toHaveLength(authoredBefore)
    expect(readConsumptions(paths.consumption).map((entry) => entry.checkpointId)).toEqual([
      ...declarationFor(kind).checkpointSchedule,
    ])
    expect(jobRow(after)).toMatchObject({ id: jobId, status: 'done' })
  }, LEG_TIMEOUT_MS)
})
