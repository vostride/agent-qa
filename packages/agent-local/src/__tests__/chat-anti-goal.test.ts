// JOBQ-04's tripwire, on the REAL chat kind (Phase 385 plan 07, C9).
//
// JOBQ-04 is an ANTI-GOAL: chat is not a checkpointed job, its state of record is the append-only
// session log, and a crash mid-turn must resume nothing. An anti-goal has no feature to demonstrate,
// so the only thing worth building is the thing that FAILS when somebody later unifies chat into the
// agent job queue — and fails citing the requirement rather than as an unexplained assertion in a
// file nobody connects to the decision.
//
// WHY THIS FILE IS NOT `expect(chat.checkpointed).toBe(false)`. Plan 04 already made the declaration
// structurally sound: a `checkpointed: true` kind with an empty schedule is unregisterable, and so
// is the inverse, so re-asserting the flag adds nothing that registration does not already enforce.
// What registration cannot say is what HAPPENS to a chat job that dies mid-turn. That is a claim
// about the engine and the store, it is the claim JOBQ-04 actually makes, and it is what a
// "unification" refactor would break first. So the file has two halves:
//
//   1. The REACHABILITY half, in-process and cheap: over the real chat declaration, a handler that
//      publishes a checkpoint is refused by name, and a handler that tries to author through the one
//      memoizing primitive is refused by name BEFORE the model is consulted. Chat has no path to a
//      recorded model call at all.
//   2. The BEHAVIOURAL half, under a real SIGKILL: a chat turn runs to the very end, its host is
//      killed before the completion is recorded, and the resumed host re-runs NOTHING — no
//      checkpoint exists to resume from, the handler is never invoked again, and the model is never
//      reached. The turn is lost, which is the correct answer for a kind whose state of record is
//      somewhere else entirely.
//
// The crash point is `completeAndChain:before`, and that choice is the leg's own evidence: the
// driver reaches `completeAndChain` only after the handler has returned `complete`, so the marker
// existing at all is proof the turn ran to completion. Nothing about it survived.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  InconsistentJobKindDeclarationError,
  REAL_JOB_KIND_DECLARATIONS,
  UndeclaredJobCheckpointError,
  createAgentJobQueue,
  createJobKindRegistry,
  createRealJobKindRegistry,
} from '@vostride/agent-qa-agent'
import type { JobHandler, JobKindDeclaration, RunNextJobOutcome } from '@vostride/agent-qa-agent'
import type { JobKind } from '@vostride/agent-qa-schema'
import { afterAll, describe, expect, it } from 'vitest'

import { createCountingModel, readInvocations } from './kill-matrix/counting-model.js'
import { crashPointsForKind, verbCrashSelector } from './kill-matrix/crash-points.js'
import {
  KILL_MATRIX_CLOCK,
  KILL_MATRIX_ENV,
  KILL_MATRIX_EPOCH,
  KILL_MATRIX_ID_SOURCE,
  fakeWriterLease,
  idempotencyKeyFor,
  openKillMatrixStore,
  readStoreSnapshot,
  seedJob,
} from './kill-matrix/harness.js'
import {
  LEG_TIMEOUT_MS,
  cleanupKillMatrixRoots,
  killIfRunning,
  makeRoot,
  runChildToCompletion,
  sendRealSigkill,
  startChild,
  waitForCrashMarker,
} from './kill-matrix/spawn-control.js'

const CHAT: JobKind = 'chat'
const registry = createRealJobKindRegistry()

afterAll(cleanupKillMatrixRoots)

/**
 * Run one chat job through the real store with a substituted chat HANDLER.
 *
 * The declaration is otherwise the shipped one, which is the point: these are claims about the kind
 * this repo ships, not about a synthetic stand-in a refactor could leave behind untouched.
 */
async function runRealChatKindWith(
  label: string,
  handler: JobHandler,
): Promise<{ outcome: () => Promise<RunNextJobOutcome>; invocationsPath: string; close: () => void }> {
  const paths = makeRoot(label)
  const declarations: JobKindDeclaration[] = REAL_JOB_KIND_DECLARATIONS.map((declaration) =>
    declaration.kind === CHAT ? { ...declaration, handler } : declaration,
  )
  const store = openKillMatrixStore(paths.agentQaRoot)
  const queue = createAgentJobQueue({
    store,
    registry: createJobKindRegistry(declarations),
    clock: KILL_MATRIX_CLOCK,
    idSource: KILL_MATRIX_ID_SOURCE,
    model: createCountingModel(paths.invocations),
  })
  const lease = fakeWriterLease(KILL_MATRIX_EPOCH)
  await store.adoptEpoch(lease.epoch)
  await queue.enqueue(CHAT, {}, idempotencyKeyFor(CHAT))
  return {
    outcome: () => queue.runNextJob({ fence: lease.fence() }),
    invocationsPath: paths.invocations,
    close: () => {
      store.close()
    },
  }
}

describe('anti-goal: the real chat kind declares no resumable progress', () => {
  it('chat is the one shipped kind that is uncheckpointed, with one attempt', () => {
    const chat = registry.require(CHAT)
    expect(chat.checkpointed).toBe(false)
    expect(chat.checkpointSchedule).toEqual([])
    // One attempt, and the reason is the anti-goal itself: there is no durable progress for a
    // second attempt to resume, so retrying a chat turn would silently re-run a whole conversation
    // turn against the model.
    expect(chat.maxAttempts).toBe(1)
    expect(chat.allowedSuccessors).toEqual([])
    expect(chat.onPermanentFailure).toBe('halt-chain')
    // Pinned as the ONLY uncheckpointed kind, in both directions: a refactor that checkpoints chat
    // reddens this, and so does one that quietly uncheckpoints something else to keep it company.
    expect(
      REAL_JOB_KIND_DECLARATIONS.filter((declaration) => !declaration.checkpointed).map(
        (declaration) => declaration.kind,
      ),
    ).toEqual([CHAT])
  })

  it('a chat declaration that claims checkpoints cannot be registered at all', () => {
    const chat = registry.require(CHAT)
    expect(() =>
      createJobKindRegistry([{ ...chat, checkpointed: true, checkpointSchedule: ['turn-authored'] }]),
    ).not.toThrow()
    // The half that matters: flipping the flag alone is refused at construction, so a refactor
    // cannot make chat resumable by editing one boolean and leaving the schedule empty.
    expect(() => createJobKindRegistry([{ ...chat, checkpointed: true }])).toThrow(
      InconsistentJobKindDeclarationError,
    )
    expect(() => createJobKindRegistry([{ ...chat, checkpointSchedule: ['turn-authored'] }])).toThrow(
      InconsistentJobKindDeclarationError,
    )
  })

  it('chat contributes no crash point, so it cannot be interrupted mid-checkpoint', () => {
    expect(crashPointsForKind(registry.require(CHAT))).toEqual([])
  })

  it('refuses a checkpoint published from inside a chat turn, by name', async () => {
    const run = await runRealChatKindWith('chat-publish', async (context) => {
      await context.publishCheckpoint('turn-authored', { text: 'hello' })
      return { status: 'complete', next: [] }
    })
    try {
      // One claim, one rejection, both properties read off it: a second `runNextJob` would find the
      // row still claimed and answer `no-job`, which would make a re-assertion say nothing.
      const error = await run.outcome().then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(UndeclaredJobCheckpointError)
      expect((error as UndeclaredJobCheckpointError).jobKind).toBe(CHAT)
      expect((error as Error).message).toContain('turn-authored')
    } finally {
      run.close()
    }
  })

  it('refuses authorship inside a chat turn BEFORE the model is consulted', async () => {
    const run = await runRealChatKindWith('chat-author', async (context) => {
      await context.recordLlmAuthorship('turn-authored', async (model) =>
        model.generate({ prompt: 'chat/turn-authored' }),
      )
      return { status: 'complete', next: [] }
    })
    try {
      const error = await run.outcome().then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(UndeclaredJobCheckpointError)
      expect((error as UndeclaredJobCheckpointError).jobKind).toBe(CHAT)
      // The one memoizing path to a model is closed to chat, and closed BEFORE the call: the
      // durable invocation artifact is empty, so nothing was paid for on the way to the refusal.
      expect(readInvocations(run.invocationsPath)).toEqual([])
    } finally {
      run.close()
    }
  })
})

describe('anti-goal: a chat turn killed mid-flight resumes nothing', () => {
  it('the turn runs to completion, the host dies, and the resume re-runs nothing', async () => {
    const paths = makeRoot('chat-anti-goal')
    const jobId = String(await seedJob(paths.agentQaRoot, CHAT))
    // `completeAndChain` is reached only after the handler has returned `complete`, so a marker
    // here is the proof the turn ran all the way through — and nothing about it is durable.
    const selector = verbCrashSelector('completeAndChain', 'before', jobId)

    const running = startChild({
      [KILL_MATRIX_ENV.role]: 'crash',
      [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
      [KILL_MATRIX_ENV.kind]: CHAT,
      [KILL_MATRIX_ENV.verbPoint]: selector,
      [KILL_MATRIX_ENV.marker]: paths.marker,
      [KILL_MATRIX_ENV.invocations]: paths.invocations,
      [KILL_MATRIX_ENV.consumption]: paths.consumption,
      [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
    })
    let markerPid: unknown
    try {
      const marker = await waitForCrashMarker(running, paths.marker, selector)
      expect(marker).toMatchObject({ verb: 'completeAndChain', side: 'before', jobId })
      markerPid = marker.pid
      expect(markerPid, 'the turn must have run in a second OS process').not.toBe(process.pid)
      await sendRealSigkill(running.child)
    } finally {
      await killIfRunning(running.child)
    }

    const crashed = await readStoreSnapshot(paths.agentQaRoot)
    expect(crashed.checkpointBytes, 'a chat turn leaves NOTHING to resume from').toEqual({})
    expect(existsSync(join(paths.agentQaRoot, 'agent-jobs', 'checkpoints', jobId))).toBe(false)
    expect(readInvocations(paths.invocations)).toEqual([])
    const crashedRow = crashed.outcome.tables
      .find((table) => table.table === 'jobs')
      ?.rows.find((row) => row.id === jobId)
    expect(crashedRow).toMatchObject({ id: jobId, kind: CHAT, status: 'queued' })
    expect(crashedRow?.claimed_at).not.toBeNull()

    const resumed = await runChildToCompletion(
      {
        [KILL_MATRIX_ENV.role]: 'resume',
        [KILL_MATRIX_ENV.root]: paths.agentQaRoot,
        [KILL_MATRIX_ENV.kind]: CHAT,
        [KILL_MATRIX_ENV.invocations]: paths.invocations,
        [KILL_MATRIX_ENV.consumption]: paths.consumption,
        [KILL_MATRIX_ENV.report]: paths.report,
        [KILL_MATRIX_ENV.epoch]: String(KILL_MATRIX_EPOCH),
      },
      paths.report,
    )
    expect(resumed.pid).not.toBe(markerPid)
    // The claim IS released — so the resume genuinely reached this job rather than never seeing it.
    expect(resumed.released).toEqual([jobId])
    // And then it re-ran NOTHING. The handler is never invoked, no checkpoint is published, and
    // chat's one declared attempt is already spent, so the row lands terminal instead of quietly
    // replaying a conversation turn against the model.
    expect(resumed.outcomes).toMatchObject([
      {
        ran: true,
        disposition: 'failed',
        jobId,
        attempts: 2,
        handlerInvoked: false,
        checkpointsPublished: [],
        continuation: [],
      },
    ])
    expect(resumed.outcomes).toHaveLength(1)
    expect(String((resumed.outcomes as Record<string, unknown>[])[0]!.reason)).toContain(
      'the attempt bound of 1 is spent',
    )

    const settled = await readStoreSnapshot(paths.agentQaRoot)
    expect(settled.checkpointBytes).toEqual({})
    expect(readInvocations(paths.invocations)).toEqual([])
    expect(
      settled.outcome.tables.find((table) => table.table === 'jobs')?.rows,
    ).toMatchObject([{ id: jobId, kind: CHAT, status: 'failed', claimed_at: null }])
  }, LEG_TIMEOUT_MS)
})
