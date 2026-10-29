// The D-09 decision table and the ONE lease acquisition, pinned.
//
// TWO CLAIMS, AND THEY ARE DIFFERENT CLAIMS. `dispositionOf` is a pure mapping and is pinned TOTAL
// over the lease probe's `kind` domain plus the two inputs that have no probe at all — because
// what it returns is written into a frozen bus field that 408's embed and every thin client parse,
// and a case nobody chose is a value nobody chose. `createPostVerdictStep` is pinned on the
// behaviour AROUND that mapping: a decision taken WITHOUT mutating the lease, at most one
// acquisition per run and only when a pump asks for it, a nudge on `held`, and a take-ONCE handoff
// box, which is the whole of RESEARCH Pitfall 3's mitigation.
//
// THE LAZINESS IS ITSELF A PINNED CLAIM. `run()` used to call `acquireWriterLease`
// eagerly, which minted an epoch and a lease file for every run — including the runs that end
// above the tail, where the no-leak backstop then released it and printed `released untaken` on
// stderr. `run-parity.e2e.test.ts` caught that as changed ordinary-run output; the cells below are
// where it is caught at unit range: after a `drained` decision with no pump, `acquireWriterLease`
// has not been called, the release is a no-op, and nothing is warned.
//
// NO REAL KNOWLEDGE ROOT IS TOUCHED. Every cell stubs `operations`, so nothing here mints an epoch,
// writes a lease file or wakes a daemon — the acquisition under test is the CALL, not the file
// system underneath it, which `writer-lease`'s own suite owns.
//
// A THIRD CLAIM SINCE PLAN 04. The durable `analyze-run` enqueue moved
// into this step from `post-run-tail.ts`, so its cells moved here with it — the payload's shape and
// idempotency key, `deduped` as a success, and the D-07 warning wording. What is NEW is the ORDER
// the step imposes around them, and every arm of it is pinned below: the enqueue happens BEFORE the
// lease is even read; a run carrying either INVK-06 marker enqueues nothing and reads nothing; a
// failed enqueue reaches no lease at all; a supplied writer authority reads `drained` without an
// acquisition; and `--detach` enqueues and then skips only the lease. The order is the design —
// see `post-verdict-step.ts`'s header for why each arm sits where it does.

import { describe, expect, it, vi } from 'vitest'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

import {
  createPostVerdictStep,
  dispositionOf,
  enqueueAnalyzeRun,
  PostProcessingUnboundError,
  probeWriterLease,
  releaseUntakenPostVerdictLease,
  type PostVerdictHandoff,
  type PostVerdictStepOperations,
  type WriterLeaseOutcome,
  type WriterLeaseReadOutcome,
} from '../post-verdict-step.js'
import type { CurationWriterAuthority } from '../curation-tail.js'

const KNOWLEDGE_ROOT = '/tmp/agent-qa-404-fake-knowledge'
const AGENT_QA_ROOT = '/tmp/agent-qa-404-fake/.agent-qa'
const CONFIG_PATH = '/tmp/agent-qa-404-fake/agent-qa.config.yaml'
const RUN_ID = 'r_fake-post-verdict-step-run'
const NOW_MS = 1_700_000_000_000

/** The durable record the enqueue mints its payload from. Two of its fields ride the payload. */
const HANDOFF = {
  runId: RUN_ID,
  schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
  executionContext: 'local-headless',
} as unknown as ReturnType<PostVerdictStepOperations['loadCompletedRunHandoff']>

const ACQUIRED: WriterLeaseOutcome = { kind: 'acquired', leaseId: 'lease-1', epoch: 7 }
const HELD: WriterLeaseOutcome = {
  kind: 'held',
  holder: { leaseId: 'other', pid: 4242, epoch: 6, heartbeatAtMs: 1 },
} as WriterLeaseOutcome

/** A `refused` acquisition arm built through the union, so its `reason` is real. */
function refusedAcquisition(): WriterLeaseOutcome {
  return {
    kind: 'refused',
    reason: 'corrupt-epoch-state',
    error: new Error('epoch bytes are not a number'),
  } as unknown as WriterLeaseOutcome
}

const PARSED_LEASE: WriterLeaseReadOutcome = {
  kind: 'parsed',
  lease: { leaseId: 'other', pid: 4242, epoch: 6, heartbeatAtMs: NOW_MS },
} as WriterLeaseReadOutcome

/**
 * The default table: NOBODY holds the lease (the ordinary local run), and an acquisition, if one is
 * ever made, succeeds. Every cell that wants a different world overrides one member.
 */
function stubOperations(
  overrides: Partial<PostVerdictStepOperations> = {},
): Partial<PostVerdictStepOperations> {
  return {
    // This legacy queue/lease harness substitutes IO; real ownership is exercised in post-verdict-continuation.test.ts.
    ownContinuation: async ({ enqueue }) => await enqueue(),
    acquireWriterLease: vi.fn(() => ACQUIRED) as unknown as PostVerdictStepOperations['acquireWriterLease'],
    releaseLease: vi.fn(() => ({ kind: 'released' })) as unknown as PostVerdictStepOperations['releaseLease'],
    readWriterLease: vi.fn(() => ({ kind: 'absent' })) as unknown as PostVerdictStepOperations['readWriterLease'],
    deriveWriterLeaseFreshness: vi.fn(() => ({
      kind: 'fresh',
    })) as unknown as PostVerdictStepOperations['deriveWriterLeaseFreshness'],
    nudgeDaemon: vi.fn(async () => undefined) as unknown as PostVerdictStepOperations['nudgeDaemon'],
    loadCompletedRunHandoff: vi.fn(
      () => HANDOFF,
    ) as unknown as PostVerdictStepOperations['loadCompletedRunHandoff'],
    composeHost: vi.fn(
      () => stubHost(),
    ) as unknown as PostVerdictStepOperations['composeHost'],
    now: () => NOW_MS,
    ...overrides,
  }
}

/**
 * The last `enqueue` spy `stubHost()` handed out, so a cell can read what the step queued.
 *
 * A module-level slot rather than a per-cell wiring: every cell composes its host through
 * `stubOperations`, and threading a spy down through two layers for the two cells that read it
 * would make the other twelve carry plumbing they never use.
 */
let lastEnqueue: ReturnType<typeof vi.fn>
let lastClose: ReturnType<typeof vi.fn>

/** A host whose queue accepts one row. `deduped: false` unless a cell overrides the spy. */
function stubHost(): ReturnType<PostVerdictStepOperations['composeHost']> {
  lastEnqueue = vi.fn(async () => ({ job: { id: 'job_analyze' }, deduped: false }))
  lastClose = vi.fn(async () => undefined)
  return {
    jobs: async () => ({ queue: { enqueue: lastEnqueue } }),
    close: lastClose,
  } as unknown as ReturnType<PostVerdictStepOperations['composeHost']>
}

function probeOperations(
  overrides: Partial<PostVerdictStepOperations> = {},
): Pick<PostVerdictStepOperations, 'readWriterLease' | 'deriveWriterLeaseFreshness' | 'now'> {
  const stub = stubOperations(overrides)
  return {
    readWriterLease: stub.readWriterLease as PostVerdictStepOperations['readWriterLease'],
    deriveWriterLeaseFreshness:
      stub.deriveWriterLeaseFreshness as PostVerdictStepOperations['deriveWriterLeaseFreshness'],
    now: stub.now as PostVerdictStepOperations['now'],
  }
}

/** A box that already holds an authority nobody claimed — what the backstop exists for. */
function boxHolding(authority: CurationWriterAuthority): PostVerdictHandoff {
  let held: CurationWriterAuthority | undefined = authority
  const take = (): CurationWriterAuthority | undefined => {
    const value = held
    held = undefined
    return value
  }
  return { outcome: undefined, takeAcquiredLease: take, takeUnclaimedLease: take }
}

describe('probeWriterLease — the decision read, total over the four read kinds and MUTATING NOTHING', () => {
  it('a fresh current-epoch holder ⇒ held', () => {
    const operations = probeOperations({
      readWriterLease: vi.fn(() => PARSED_LEASE) as unknown as PostVerdictStepOperations['readWriterLease'],
    })
    expect(probeWriterLease({ knowledgeRoot: KNOWLEDGE_ROOT, operations })).toEqual({ kind: 'held' })
    expect(
      operations.deriveWriterLeaseFreshness,
      'the freshness verdict decides, never the lease bytes alone (CR-01/CR-08)',
    ).toHaveBeenCalledWith(KNOWLEDGE_ROOT, PARSED_LEASE.kind === 'parsed' ? PARSED_LEASE.lease : undefined, NOW_MS)
  })

  it('a reclaimable holder ⇒ free — a stale or superseded lease holds nothing up', () => {
    const operations = probeOperations({
      readWriterLease: vi.fn(() => PARSED_LEASE) as unknown as PostVerdictStepOperations['readWriterLease'],
      deriveWriterLeaseFreshness: vi.fn(() => ({
        kind: 'reclaimable',
      })) as unknown as PostVerdictStepOperations['deriveWriterLeaseFreshness'],
    })
    expect(probeWriterLease({ knowledgeRoot: KNOWLEDGE_ROOT, operations })).toEqual({ kind: 'free' })
  })

  it('an UNKNOWN freshness verdict ⇒ refused, never free — an unreadable epoch is not evidence nobody holds it', () => {
    const operations = probeOperations({
      readWriterLease: vi.fn(() => PARSED_LEASE) as unknown as PostVerdictStepOperations['readWriterLease'],
      deriveWriterLeaseFreshness: vi.fn(() => ({
        kind: 'unknown',
        error: new Error('epoch unreadable'),
      })) as unknown as PostVerdictStepOperations['deriveWriterLeaseFreshness'],
    })
    expect(probeWriterLease({ knowledgeRoot: KNOWLEDGE_ROOT, operations })).toEqual({
      kind: 'refused',
      reason: 'corrupt-epoch-state',
    })
  })

  it('absent and malformed ⇒ free; UNREADABLE ⇒ refused CARRYING THE ERRNO', () => {
    for (const kind of ['absent', 'malformed'] as const) {
      const operations = probeOperations({
        readWriterLease: vi.fn(() => ({ kind })) as unknown as PostVerdictStepOperations['readWriterLease'],
      })
      expect(
        probeWriterLease({ knowledgeRoot: KNOWLEDGE_ROOT, operations }),
        `${kind} is genuine recovery input — an acquisition would reclaim`,
      ).toEqual({ kind: 'free' })
    }
    const unreadable = probeOperations({
      readWriterLease: vi.fn(() => ({
        kind: 'unreadable',
        code: 'EACCES',
      })) as unknown as PostVerdictStepOperations['readWriterLease'],
    })
    const outcome = probeWriterLease({ knowledgeRoot: KNOWLEDGE_ROOT, operations: unreadable })
    expect(outcome.kind, 'a lease that EXISTS and cannot be opened is not a free lease').toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : '').toContain('EACCES')
  })
})

describe('dispositionOf — total over the lease probe domain', () => {
  it('held ⇒ handedOff, with nothing to warn about', () => {
    expect(
      dispositionOf({ probe: { kind: 'held' }, leaseSkipped: false }),
      'a current-epoch holder exists, so somebody else will pump',
    ).toEqual({ disposition: 'handedOff' })
  })

  it('free ⇒ drained, with nothing to warn about', () => {
    expect(
      dispositionOf({ probe: { kind: 'free' }, leaseSkipped: false }),
      'nobody holds it, so this process is the one that will take it and pump',
    ).toEqual({ disposition: 'drained' })
  })

  it('refused ⇒ detached plus writer-lease-refused CARRYING THE REFUSAL\'S OWN REASON', () => {
    const outcome = dispositionOf({
      probe: { kind: 'refused', reason: 'corrupt-epoch-state' },
      leaseSkipped: false,
    })
    expect(outcome.disposition, 'a lease nobody can evaluate promises nothing').toBe('detached')
    expect(outcome.warning?.code).toBe('writer-lease-refused')
    expect(
      outcome.warning?.message,
      'the reason travels to the reader rather than being flattened to "refused"',
    ).toContain('corrupt-epoch-state')
  })

  it('leaseSkipped ⇒ detached with NO warning — a deliberate skip is not a fault', () => {
    expect(dispositionOf({ leaseSkipped: true })).toEqual({ disposition: 'detached' })
    expect(
      dispositionOf({ probe: { kind: 'free' }, leaseSkipped: true }),
      'the skip wins: a lease that was never meant to be consulted cannot promise a drain',
    ).toEqual({ disposition: 'detached' })
  })

  it('no probe at all and not skipped ⇒ detached plus post-processing-unbound', () => {
    const outcome = dispositionOf({ leaseSkipped: false })
    expect(outcome.disposition).toBe('detached')
    expect(
      outcome.warning?.code,
      'a host with no lease capability says so by name rather than looking like a refusal',
    ).toBe('post-processing-unbound')
  })

  it('a FAILED enqueue ⇒ detached plus post-run-enqueue-failed, whatever the lease said', () => {
    const outcome = dispositionOf({
      enqueue: 'failed',
      enqueueError: 'Post-run analysis was not queued for r_x (SQLITE_BUSY)',
      // A free lease is deliberately present: nothing is queued, so a `drained` posture over it
      // would promise a pump for a chain that does not exist.
      probe: { kind: 'free' },
      leaseSkipped: false,
    })
    expect(outcome.disposition, 'nothing is queued, so nothing can be drained').toBe('detached')
    expect(outcome.warning?.code).toBe('post-run-enqueue-failed')
    expect(
      outcome.warning?.message,
      'the cause travels to the reader rather than being flattened to "failed"',
    ).toContain('SQLITE_BUSY')
  })

  it('an UNBOUND queue ⇒ detached plus post-processing-unbound — the same sentence as the lease arm', () => {
    const outcome = dispositionOf({ enqueue: 'unbound', probe: { kind: 'free' }, leaseSkipped: false })
    expect(outcome.disposition).toBe('detached')
    expect(
      outcome.warning?.code,
      'a host that binds no queue and a host that binds no lease both say "nothing from here"',
    ).toBe('post-processing-unbound')
  })

  it('a SUPPLIED writer authority ⇒ drained, with no probe consulted and nothing to warn about', () => {
    expect(
      dispositionOf({
        enqueue: 'enqueued',
        writerAuthority: { leaseId: 'daemon-lease', epoch: 11 },
        leaseSkipped: false,
      }),
      'the host holds the lease and said so — its own pump is what drains this chain (D-09)',
    ).toEqual({ disposition: 'drained' })
  })

  it('a supplied authority OUTRANKS a held probe — the daemon is not handed off to itself', () => {
    expect(
      dispositionOf({
        enqueue: 'enqueued',
        writerAuthority: { leaseId: 'daemon-lease', epoch: 11 },
        // What a daemon's own process WOULD read if it asked: `held`, by itself.
        probe: { kind: 'held' },
        leaseSkipped: false,
      }),
      'handedOff here would hand the chain to nobody, which is the whole defect',
    ).toEqual({ disposition: 'drained' })
  })

  it('a gate-run skip and a --detach skip are the SAME answer: detached, no warning', () => {
    expect(
      dispositionOf({ enqueue: 'skipped', leaseSkipped: true }),
      'a gate run queued nothing on purpose',
    ).toEqual({ disposition: 'detached' })
    expect(
      dispositionOf({ enqueue: 'enqueued', leaseSkipped: true }),
      'a detached run queued its work and declined to spend itself on it (Pitfall 8)',
    ).toEqual({ disposition: 'detached' })
  })
})

describe('enqueueAnalyzeRun — THE one durable hand-off', () => {
  it('queues analyze-run with the handoff digest and the runId as the idempotency key', async () => {
    const operations = stubOperations()
    const outcome = await enqueueAnalyzeRun({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      configPath: CONFIG_PATH,
      operations: operations as unknown as Pick<
        PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'
      >,
    })

    expect(outcome).toBe('enqueued')
    expect(lastEnqueue).toHaveBeenCalledTimes(1)
    const [kind, payload, key] = lastEnqueue.mock.calls[0] as [string, Record<string, unknown>, string]
    expect(kind).toBe('analyze-run')
    expect(key, 'idempotent BY RUN ID, which is what makes a second step run a dedupe').toBe(RUN_ID)
    expect(payload).toMatchObject({
      runId: RUN_ID,
      handoffSchemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
      executionContext: 'local-headless',
    })
    // the digest pins the BYTES, so it must be a sha256 of the handoff and not a path.
    expect(payload.handoffDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(
      lastClose,
      'the enqueue closes its own host — the tail composes another for the drain',
    ).toHaveBeenCalledTimes(1)
  })

  it('reports a deduped row as a SUCCESS, never an error', async () => {
    const operations = stubOperations({
      composeHost: (() => {
        const host = stubHost()
        lastEnqueue.mockImplementation(async () => ({ job: { id: 'job_analyze' }, deduped: true }))
        return host
      }) as unknown as PostVerdictStepOperations['composeHost'],
    })
    await expect(enqueueAnalyzeRun({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      configPath: CONFIG_PATH,
      operations: operations as unknown as Pick<
        PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'
      >,
    })).resolves.toBe('deduped')
  })

  it('a host that binds NO queue raises the named unbound error, not a generic failure', async () => {
    const operations = stubOperations({
      composeHost: (() => ({ close: async () => undefined })) as unknown as PostVerdictStepOperations['composeHost'],
    })
    await expect(enqueueAnalyzeRun({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      configPath: CONFIG_PATH,
      operations: operations as unknown as Pick<
        PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'
      >,
    })).rejects.toBeInstanceOf(PostProcessingUnboundError)
  })

  it('CLOSES the host even when the enqueue raises', async () => {
    const operations = stubOperations({
      composeHost: (() => {
        const host = stubHost()
        lastEnqueue.mockImplementation(async () => {
          throw new Error('SQLITE_BUSY: database is locked')
        })
        return host
      }) as unknown as PostVerdictStepOperations['composeHost'],
    })
    await expect(enqueueAnalyzeRun({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      configPath: CONFIG_PATH,
      operations: operations as unknown as Pick<
        PostVerdictStepOperations, 'loadCompletedRunHandoff' | 'composeHost'
      >,
    })).rejects.toThrow('SQLITE_BUSY')
    expect(lastClose, 'a leaked sqlite handle on every failed enqueue is not a degrade').toHaveBeenCalledTimes(1)
  })
})

describe('createPostVerdictStep — decide without mutating, acquire only for a pump', () => {
  it('a free lease reads drained and ACQUIRES NOTHING until a pump asks', async () => {
    const operations = stubOperations()
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    const outcome = await step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome, 'nobody held it, so this process will pump').toEqual({ disposition: 'drained' })
    expect(
      operations.readWriterLease,
      'the decision is taken from the non-mutating read',
    ).toHaveBeenCalledWith(KNOWLEDGE_ROOT)
    expect(
      operations.acquireWriterLease,
      'THE regression: deciding the posture must not mint an epoch for a chain nobody asked to pump',
    ).not.toHaveBeenCalled()

    expect(
      step.handoff.takeAcquiredLease(),
      'the pump receives the authority, epoch included — acquired at the moment it asked',
    ).toEqual({ leaseId: 'lease-1', epoch: 7 })
    expect(
      operations.acquireWriterLease,
      'THE one acquisition: a second consult would answer `held` by this very process',
    ).toHaveBeenCalledTimes(1)
    expect(operations.acquireWriterLease).toHaveBeenCalledWith(KNOWLEDGE_ROOT)
    expect(
      step.handoff.takeAcquiredLease(),
      'take-ONCE: two callers each believing they hold the lease is the defect this box prevents',
    ).toBeUndefined()
    expect(
      operations.acquireWriterLease,
      'and the second take acquires nothing either — take-once bounds the acquisition too',
    ).toHaveBeenCalledTimes(1)
    expect(step.handoff.outcome).toEqual({ disposition: 'drained' })
  })

  it('a pump that arrives after a daemon took the lease gets NOTHING, and this process acquires nothing twice', async () => {
    const operations = stubOperations({
      acquireWriterLease: vi.fn(() => HELD) as unknown as PostVerdictStepOperations['acquireWriterLease'],
    })
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    expect(await step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })).toEqual({
      disposition: 'drained',
    })
    expect(
      step.handoff.takeAcquiredLease(),
      'the race is lost honestly: nothing was acquired, so nothing is handed over and the tail\'s own consult decides',
    ).toBeUndefined()
    expect(operations.acquireWriterLease).toHaveBeenCalledTimes(1)
  })

  it('a held lease reads handedOff, nudges the holder once, and hands NOTHING to the pump', async () => {
    const operations = stubOperations({
      readWriterLease: vi.fn(() => PARSED_LEASE) as unknown as PostVerdictStepOperations['readWriterLease'],
    })
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    const outcome = await step.port.run({ runId: RUN_ID as never, verdict: 'failed' as never })
    expect(outcome).toEqual({ disposition: 'handedOff' })
    expect(operations.readWriterLease, 'still exactly one consult').toHaveBeenCalledTimes(1)
    expect(
      operations.acquireWriterLease,
      'a holder exists — taking the lease from underneath it is the Pitfall 3 defect',
    ).not.toHaveBeenCalled()
    expect(operations.nudgeDaemon, 'the holder is woken exactly once').toHaveBeenCalledTimes(1)
    expect(operations.nudgeDaemon).toHaveBeenCalledWith(AGENT_QA_ROOT, {
      knowledgeRoot: KNOWLEDGE_ROOT,
    })
    expect(
      step.handoff.takeAcquiredLease(),
      'this process acquired nothing, so it hands the pump nothing',
    ).toBeUndefined()
    expect(
      operations.acquireWriterLease,
      'and the pump asking does not change that: the step planned no acquisition',
    ).not.toHaveBeenCalled()
  })

  it('a refused probe is a WARNING, never a throw — the shell\'s own degrade path stays reserved for real faults', async () => {
    const operations = stubOperations({
      readWriterLease: vi.fn(() => ({
        kind: 'unreadable',
        code: 'EACCES',
      })) as unknown as PostVerdictStepOperations['readWriterLease'],
    })
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    const outcome = await step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome.disposition).toBe('detached')
    expect(outcome.warning?.code).toBe('writer-lease-refused')
    expect(operations.nudgeDaemon, 'nobody to nudge — nobody holds it').not.toHaveBeenCalled()
    expect(
      operations.acquireWriterLease,
      'a detached posture promises no pump, so no pump acquires',
    ).not.toHaveBeenCalled()
    expect(step.handoff.takeAcquiredLease()).toBeUndefined()
  })

  it('an UNEXPECTED throw from the capability propagates, so the shell degrade path is reachable', async () => {
    const operations = stubOperations({
      readWriterLease: vi.fn(() => {
        throw new Error('EACCES')
      }) as unknown as PostVerdictStepOperations['readWriterLease'],
    })
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    await expect(
      step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never }),
      'a raise is not a decided posture; the shell names it post-verdict-step-failed',
    ).rejects.toThrow('EACCES')
  })

  it('an acquisition that is REFUSED at pump time hands back nothing rather than a half-authority', async () => {
    const operations = stubOperations({
      acquireWriterLease: vi.fn(() => refusedAcquisition()) as unknown as PostVerdictStepOperations['acquireWriterLease'],
    })
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })

    await step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(step.handoff.takeAcquiredLease()).toBeUndefined()
  })
})

describe('createPostVerdictStep — the gate-run, exclusion and detach arms, in the order the step imposes', () => {
  const step = (extra: Record<string, unknown> = {}, operations = stubOperations()) => ({
    operations,
    step: createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
      ...extra,
    }),
  })

  it('an ordinary run ENQUEUES ONCE, and does so BEFORE the lease is ever read', async () => {
    const order: string[] = []
    const operations = stubOperations()
    ;(operations as { readWriterLease: unknown }).readWriterLease = vi.fn(() => {
      order.push('read-lease')
      return { kind: 'absent' }
    })
    ;(operations as { composeHost: unknown }).composeHost = vi.fn(() => {
      order.push('compose-host')
      return stubHost()
    })
    const { step: composed } = step({}, operations)

    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome).toEqual({ disposition: 'drained' })
    expect(lastEnqueue, 'the durable record is written exactly once').toHaveBeenCalledTimes(1)
    expect(
      order,
      'the lease decision is a promise about draining work that must already EXIST',
    ).toEqual(['compose-host', 'read-lease'])
  })

  it('a deduped enqueue is NOT a warning — the posture is decided as if it were the first', async () => {
    const operations = stubOperations({
      composeHost: (() => {
        const host = stubHost()
        lastEnqueue.mockImplementation(async () => ({ job: { id: 'job_analyze' }, deduped: true }))
        return host
      }) as unknown as PostVerdictStepOperations['composeHost'],
    })
    const { step: composed } = step({}, operations)
    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome, 'the unique index absorbing a second row is the store working').toEqual({
      disposition: 'drained',
    })
  })

  it('a THROWING enqueue ⇒ detached + post-run-enqueue-failed, and NO lease consult at all', async () => {
    const operations = stubOperations({
      composeHost: (() => {
        const host = stubHost()
        lastEnqueue.mockImplementation(async () => {
          throw new Error('SQLITE_BUSY: database is locked')
        })
        return host
      }) as unknown as PostVerdictStepOperations['composeHost'],
    })
    const { step: composed } = step({}, operations)

    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'failed' as never })
    expect(outcome.disposition).toBe('detached')
    expect(outcome.warning?.code).toBe('post-run-enqueue-failed')
    const message = String(outcome.warning?.message)
    expect(message).toContain(RUN_ID)
    expect(message).toContain('SQLITE_BUSY')
    // The whole point of the D-07 wording is that it says what was NOT affected, and where the
    // handoff still is — that path IS the manual re-queue path.
    expect(message).toContain('verdict and exit code are unaffected')
    expect(message).toContain(AGENT_QA_ROOT)
    expect(
      operations.readWriterLease,
      'taking a lease to pump a chain that was never queued leaves it held for its TTL',
    ).not.toHaveBeenCalled()
    expect(operations.acquireWriterLease).not.toHaveBeenCalled()
    expect(composed.handoff.takeAcquiredLease()).toBeUndefined()
  })

  it('a host that binds no queue ⇒ detached + post-processing-unbound', async () => {
    const operations = stubOperations({
      composeHost: (() => ({ close: async () => undefined })) as unknown as PostVerdictStepOperations['composeHost'],
    })
    const { step: composed } = step({}, operations)
    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome.disposition).toBe('detached')
    expect(outcome.warning?.code).toBe('post-processing-unbound')
    expect(operations.readWriterLease).not.toHaveBeenCalled()
  })

  it('gateRun ⇒ NO enqueue, NO lease read, detached, and nothing warned', async () => {
    const operations = stubOperations()
    const { step: composed } = step({}, operations)

    const outcome = await composed.port.run({
      runId: RUN_ID as never,
      verdict: 'passed' as never,
      gateRun: true,
    })
    expect(outcome, 'a keep-gate probe costs no analysis and produces no chips').toEqual({
      disposition: 'detached',
    })
    expect(operations.composeHost, 'nothing is composed, so nothing is queued').not.toHaveBeenCalled()
    expect(operations.loadCompletedRunHandoff).not.toHaveBeenCalled()
    expect(operations.readWriterLease).not.toHaveBeenCalled()
    expect(operations.acquireWriterLease).not.toHaveBeenCalled()
  })

  it('excludedFromOutcomes ALONE skips too — the two markers are DISTINCT axes', async () => {
    const operations = stubOperations()
    const { step: composed } = step({}, operations)

    const outcome = await composed.port.run({
      runId: RUN_ID as never,
      verdict: 'failed' as never,
      excludedFromOutcomes: true,
    })
    expect(outcome).toEqual({ disposition: 'detached' })
    expect(
      operations.composeHost,
      'each marker suppresses on its own condition; neither is copied from the other',
    ).not.toHaveBeenCalled()
  })

  it('--detach ENQUEUES and skips only the lease', async () => {
    const operations = stubOperations()
    const { step: composed } = step({ detach: true }, operations)

    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome, 'detaching declines to SPEND this process, never to forget the work').toEqual({
      disposition: 'detached',
    })
    expect(lastEnqueue, 'the record exists — that is the half detach keeps').toHaveBeenCalledTimes(1)
    expect(operations.readWriterLease).not.toHaveBeenCalled()
    expect(operations.acquireWriterLease).not.toHaveBeenCalled()
    expect(composed.handoff.takeAcquiredLease()).toBeUndefined()
  })

  it('a SUPPLIED writerAuthority ⇒ drained, no consult, and the pump gets THAT authority', async () => {
    const operations = stubOperations()
    const authority = { leaseId: 'daemon-lease', epoch: 11 }
    const { step: composed } = step({ writerAuthority: authority }, operations)

    const outcome = await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    expect(outcome, 'the daemon-launched run IS drained — by the daemon\'s own pump (D-09)').toEqual({
      disposition: 'drained',
    })
    expect(lastEnqueue, 'the daemon door queued nothing at all before this change').toHaveBeenCalledTimes(1)
    expect(
      operations.readWriterLease,
      'a holder that asks is answered `held` by itself (Pitfall 3)',
    ).not.toHaveBeenCalled()
    expect(operations.acquireWriterLease).not.toHaveBeenCalled()
    expect(composed.handoff.takeAcquiredLease()).toEqual(authority)
    expect(
      composed.handoff.takeAcquiredLease(),
      'take-ONCE holds for a supplied authority exactly as it does for an acquired one',
    ).toBeUndefined()
  })

  it('a SUPPLIED authority is NEVER released by the no-leak backstop — it is the daemon\'s live lease', async () => {
    const operations = stubOperations()
    const warn = vi.fn()
    const composed = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      writerAuthority: { leaseId: 'daemon-lease', epoch: 11 },
      log: { warn: vi.fn() },
      operations,
    })

    await composed.port.run({ runId: RUN_ID as never, verdict: 'passed' as never })
    // The daemon door supplies no tail, so nothing ever takes the authority — and the
    // drive's outermost `finally` runs the backstop over the box on the way out.
    releaseUntakenPostVerdictLease({
      handoff: composed.handoff,
      knowledgeRoot: KNOWLEDGE_ROOT,
      runId: RUN_ID,
      log: { warn },
      operations: { releaseLease: operations.releaseLease },
    })
    expect(
      operations.releaseLease,
      'releasing a live daemon\'s lease would let every other process take it under a fence the daemon still owns',
    ).not.toHaveBeenCalled()
    expect(warn, 'nothing leaked, so nothing is worth waking anyone for').not.toHaveBeenCalled()
  })
})

describe('releaseUntakenPostVerdictLease — the no-leak rule for a door with no tail', () => {
  it('releases a lease nobody took and warns by name', () => {
    const releaseLease = vi.fn(() => ({ kind: 'released' }))
    const warn = vi.fn()
    const handoff = boxHolding({ leaseId: 'lease-1', epoch: 7 })

    releaseUntakenPostVerdictLease({
      handoff,
      knowledgeRoot: KNOWLEDGE_ROOT,
      runId: RUN_ID,
      log: { warn },
      operations: { releaseLease: releaseLease as unknown as PostVerdictStepOperations['releaseLease'] },
    })

    expect(releaseLease).toHaveBeenCalledWith({
      knowledgeRoot: KNOWLEDGE_ROOT,
      leaseId: 'lease-1',
    })
    expect(warn.mock.calls[0][0], 'the fact is named, not silently absorbed').toContain(
      'released untaken',
    )
    expect(
      handoff.takeAcquiredLease(),
      'the box is empty afterwards — the release consumed the take',
    ).toBeUndefined()
  })

  it('is a NO-OP when the tail already took the lease — no double release, no warning', () => {
    const operations = stubOperations()
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })
    const warn = vi.fn()

    return step.port.run({ runId: RUN_ID as never, verdict: 'passed' as never }).then(() => {
      expect(step.handoff.takeAcquiredLease()).toEqual({ leaseId: 'lease-1', epoch: 7 })
      releaseUntakenPostVerdictLease({
        handoff: step.handoff,
        knowledgeRoot: KNOWLEDGE_ROOT,
        runId: RUN_ID,
        log: { warn },
        operations: { releaseLease: operations.releaseLease },
      })
      expect(
        operations.releaseLease,
        'the pump owns the release once it has taken the authority',
      ).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('IS SILENT on the ordinary run that never reached a pump — nothing acquired, nothing released, nothing said', () => {
    const operations = stubOperations()
    const step = createPostVerdictStep({
      runId: RUN_ID,
      agentQaRoot: AGENT_QA_ROOT,
      knowledgeRoot: KNOWLEDGE_ROOT,
      configPath: CONFIG_PATH,
      log: { warn: vi.fn() },
      operations,
    })
    const warn = vi.fn()

    // The framework-error shape: the shell ran the step, the drive re-threw above `afterVerdict`,
    // and the outermost `finally` is the next thing that happens. This is what put
    // `post-run lease released untaken` on the stderr of ordinary runs.
    return step.port.run({ runId: RUN_ID as never, verdict: 'failed' as never }).then(() => {
      releaseUntakenPostVerdictLease({
        handoff: step.handoff,
        knowledgeRoot: KNOWLEDGE_ROOT,
        runId: RUN_ID,
        log: { warn },
        operations: { releaseLease: operations.releaseLease },
      })
      expect(
        operations.acquireWriterLease,
        'the backstop must never be what acquires the lease it releases',
      ).not.toHaveBeenCalled()
      expect(operations.releaseLease).not.toHaveBeenCalled()
      expect(warn, 'an ordinary run has nothing to say about a lease it never took').not.toHaveBeenCalled()
    })
  })
})
