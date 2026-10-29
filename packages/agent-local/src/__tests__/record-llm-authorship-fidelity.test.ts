// Resume FIDELITY of the authorship primitive, over the real store.
//
// The agent package's own suite proves D-10's control flow: on a recorded checkpoint the author
// is never reached. It cannot prove the other half of the same sentence — that what comes back
// is what went in — because its store is a fake that hands a value straight back. The value has
// to survive canonical JSON, a file, a rename and a re-read before "the recorded bytes" means
// anything, and only the real sqlite store and the real checkpoint files do that.
//
// This file exists for the input the agent suite structurally cannot produce: an authored
// `undefined`. Canonical JSON cannot represent a member whose value is `undefined`, so the
// engine's envelope comes back one key short of the one it wrote — which is exactly the input
// that told a structural envelope sniff "this is not an envelope". Every other authored shape
// round-trips whether the engine unwraps conditionally or unconditionally, so a suite that
// only ever authors objects agrees with a broken primitive perfectly.
//
// The assertion is deliberately IDENTITY, not truthiness: `undefined` and the engine envelope
// are both falsy in no useful sense and both "present", so the only assertion that separates
// the two functions the primitive must not be is "pass 2 returned what pass 1 returned".

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentJobQueue, createJobKindRegistry } from '@vostride/agent-qa-agent'
import type {
  ClockPort,
  JobAuthorCallback,
  JobIdSource,
  JobKindDeclaration,
  JobModelCapability,
} from '@vostride/agent-qa-agent'
import { asJobId, sha256hex16 } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createJobCheckpointStore } from '../store/job-checkpoint-store.js'
import { AGENT_JOB_STORE_DB_FILE, createSqliteJobStore } from '../store/sqlite-job-store.js'
import type { SqliteJobStore } from '../store/sqlite-job-store.js'

const FIXTURE_KIND = 'analyze-run' as const
const FIXTURE_CHECKPOINT = 'analysis'
const FIRST_HOST_HANDLER_FAILURE = 'first host handler failed after the model answered'

function createSteppingClock(): ClockPort {
  let tick = 0
  return {
    now() {
      const stamp = `2026-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`
      tick += 1
      return stamp
    },
  }
}

const idSource: JobIdSource = {
  jobIdFor: (kind, idempotencyKey) => asJobId(`job_${sha256hex16(`${kind} ${idempotencyKey}`)}`),
}

/**
 * The capability the author is handed. It answers, so a defined-value control can be authored
 * with it; the count matters less than the AUTHOR count, because the author is what D-10 says
 * control never reaches on a resume.
 */
const fidelityModel: JobModelCapability = {
  modelId: 'test:fidelity',
  generate: async (request) => ({ text: `authored:${request.prompt}` }),
}

interface Pass {
  readonly store: SqliteJobStore
  readonly queue: ReturnType<typeof createAgentJobQueue>
}

interface FidelityFixture {
  /** What the author produces. Called at most once across both passes, or D-10 is breached. */
  readonly author: JobAuthorCallback<unknown>
  /** Every value the primitive handed back, in pass order. */
  readonly returned: unknown[]
  /** Set on the first pass so the durable checkpoint is followed by a normal retry disposition. */
  readonly thenThrow?: string
}

function fidelityDeclaration(fixture: FidelityFixture): JobKindDeclaration {
  return {
    kind: FIXTURE_KIND,
    checkpointed: true,
    checkpointSchedule: [FIXTURE_CHECKPOINT],
    allowedSuccessors: [],
    maxAttempts: 3,
    backoff: { kind: 'none' },
    onPermanentFailure: 'halt-chain',
    async handler(context) {
      const value = await context.recordLlmAuthorship(FIXTURE_CHECKPOINT, fixture.author)
      fixture.returned.push(value)
      if (fixture.thenThrow !== undefined) throw new Error(fixture.thenThrow)
      return { status: 'complete', next: [] }
    },
  }
}

describe('recordLlmAuthorship resume fidelity over the real store', () => {
  let root: string
  let open: SqliteJobStore[]
  let clock: ClockPort

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-authorship-fidelity-'))
    open = []
    // one clock for both hosts, so the second never reads a time
    // before the first host's retry was recorded.
    clock = createSteppingClock()
  })

  afterEach(() => {
    for (const store of open) store.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** A host: its own engine, its own registry, its own connection to the same durable state. */
  function openPass(declaration: JobKindDeclaration): Pass {
    const checkpoints = createJobCheckpointStore({ root })
    const store = createSqliteJobStore({
      path: join(root, AGENT_JOB_STORE_DB_FILE),
      clock,
      checkpoints,
    })
    open.push(store)
    return {
      store,
      queue: createAgentJobQueue({
        store,
        registry: createJobKindRegistry([declaration]),
        clock,
        idSource,
        model: fidelityModel,
      }),
    }
  }

  function closePass(pass: Pass): void {
    pass.store.close()
    open = open.filter((store) => store !== pass.store)
  }

  /**
   * Author once in a host whose handler then fails, assert that the engine lands and releases the
   * retry disposition, and let a SECOND host — new engine, new registry, new connection, nothing
   * shared but the bytes on disk — run the same job again.
   */
  async function authorAcrossTwoHosts(input: {
    readonly author: JobAuthorCallback<unknown>
    readonly idempotencyKey: string
  }): Promise<{ readonly returned: unknown[]; readonly authorCalls: number }> {
    let authorCalls = 0
    const countingAuthor: JobAuthorCallback<unknown> = async (model) => {
      authorCalls += 1
      return input.author(model)
    }
    const returned: unknown[] = []

    const first = openPass(
      fidelityDeclaration({
        author: countingAuthor,
        returned,
        thenThrow: FIRST_HOST_HANDLER_FAILURE,
      }),
    )
    const firstFence = await first.store.adoptEpoch(1)
    await first.queue.enqueue(FIXTURE_KIND, { runRef: 'run_1' }, input.idempotencyKey)
    const firstOutcome = await first.queue.runNextJob({ fence: firstFence })

    expect(firstOutcome).toMatchObject({
      ran: true,
      disposition: 'retry-scheduled',
      handlerInvoked: true,
      checkpointsPublished: [FIXTURE_CHECKPOINT],
      reason: `handler-threw: ${FIRST_HOST_HANDLER_FAILURE}`,
      retryDelayMs: 0,
      attemptsRemaining: 2,
      job: { attempts: 1, status: 'queued' },
    })
    expect((await first.store.dumpState()).jobs[0]).toMatchObject({
      status: 'queued',
      claimed: false,
      attempts: 1,
    })
    closePass(first)

    const second = openPass(fidelityDeclaration({ author: countingAuthor, returned }))
    const secondFence = await second.store.adoptEpoch(2)
    const outcome = await second.queue.runNextJob({ fence: secondFence })
    closePass(second)

    expect(outcome).toMatchObject({ ran: true, disposition: 'completed' })
    return { returned, authorCalls }
  }

  // THE CASE. Authored `undefined` is the one value canonical JSON cannot carry as a member, and
  // therefore the one value that told the old structural sniff the engine's own envelope was not
  // an envelope. Before the fix this returned `{attempt, checkpointId, jobId, recordedAt}`.
  it('hands back the SAME value on resume as on the first pass when a handler authors undefined', async () => {
    const { returned, authorCalls } = await authorAcrossTwoHosts({
      author: async () => undefined,
      idempotencyKey: 'authored-undefined',
    })

    expect(authorCalls).toBe(1)
    expect(returned).toHaveLength(2)
    expect(returned[0]).toBeUndefined()
    // Stated first because its failure PRINTS what came back instead: before the fix this read
    // `{attempt: 1, checkpointId: 'analysis', jobId: 'job_…', recordedAt: '…'}`, the engine's
    // own envelope.
    expect(returned[1]).toBeUndefined()
    // Identity, not equality: an envelope is neither `undefined` nor deep-equal to it, and this
    // is the assertion that refuses "two functions wearing one name".
    expect(Object.is(returned[1], returned[0])).toBe(true)
  })

  // POSITIVE CONTROL. Without this, "pass 2 equals pass 1" is satisfied by a primitive that
  // returns `undefined` for everything.
  it('round-trips a defined authored value across the same two hosts', async () => {
    const { returned, authorCalls } = await authorAcrossTwoHosts({
      author: async (model) => (await model.generate({ prompt: 'the verdicts' })).text,
      idempotencyKey: 'authored-text',
    })

    expect(authorCalls).toBe(1)
    expect(returned).toEqual(['authored:the verdicts', 'authored:the verdicts'])
  })

  // THE BOUND on the fix. Unwrapping unconditionally peels exactly one level, so an authored
  // object that happens to look like an envelope is still returned whole — the worry the
  // verifier checked and did not reproduce, pinned so a later "smarter" unwrap cannot introduce
  // it.
  it('peels exactly one level, so an authored object carrying its own value key survives', async () => {
    const authored = { checkpointId: 'not-the-envelope', value: 'inner' }
    const { returned, authorCalls } = await authorAcrossTwoHosts({
      author: async () => authored,
      idempotencyKey: 'authored-envelope-shaped',
    })

    expect(authorCalls).toBe(1)
    expect(returned).toEqual([authored, authored])
  })
})
