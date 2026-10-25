// The shared post-run tail's postures (Phase 388 plan 02, D-03 / D-07).
//
// Every operation is injected, so what is under test here is the tail's DECISION TABLE — who
// drains, who hands off, when the pump stops, what a failure costs — rather than sqlite or a
// lease file. The durable half (one row for two tail runs) is proven against the real store in
// `post-run-enqueue-idempotency.test.ts`; splitting them keeps each proof about one thing.
//
// 2026-08-26 (404 D-05): THE ENQUEUE CELLS LEFT THIS FILE. The payload's shape, its idempotency
// key, `deduped`-is-a-success and the D-07 warning are now pinned in
// `curation/__tests__/post-verdict-step.test.ts`, because that is where the enqueue is. What
// replaced them here is the complementary claim — this tail enqueues NOTHING — plus the two legs
// that used to depend on `enqueue()` having run first: `drain()` resolves its own knowledge root
// and composes its own host, and `finish()` composes one for the detach posture that never drains.

import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promotionHostProof } from './promotion-host-proof.js'

import { chainJobIdsForRun } from '@vostride/agent-qa-agent'
import { DIGEST_JOB_ID_SOURCE } from '@vostride/agent-qa-agent-local'
import { CURRENT_HANDOFF_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { ResolvePromotionPosture } from '@vostride/agent-qa-schema'

import { runVerdictFirstCurationTail } from '../curation/curation-tail.js'
import {
  runPostRunTail,
  type PostRunTailOperations,
  type RunPostRunTailOptions,
} from '../curation/post-run-tail.js'
import * as promotionPosture from '../curation/promotion-posture.js'

const agentQaRoot = '/workspace/project/.agent-qa'
const configDir = '/workspace/project'
const configPath = '/workspace/project/agent-qa.config.yaml'
const knowledgeRoot = '/workspace/project/agent-qa-knowledge'
const runId = 'run-post-run-tail'
/**
 * The ids THIS run's chain addresses, derived the way the tail derives them.
 *
 * The fakes below claim jobs by id now, because the tail scopes what it emits and what it counts
 * as its own by id (388-07). A stand-in id invented here would model a job no run could enqueue,
 * and every own-chain assertion made against it would be measuring the fixture.
 */
const OWN_CHAIN = chainJobIdsForRun(runId, DIGEST_JOB_ID_SOURCE)

const handoff = {
  runId,
  schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
  executionContext: 'local-headless',
} as unknown as ReturnType<PostRunTailOperations['loadCompletedRunHandoff']>

interface Harness {
  operations: PostRunTailOperations
  enqueue: ReturnType<typeof vi.fn>
  runNextJob: ReturnType<typeof vi.fn>
  adoptEpoch: ReturnType<typeof vi.fn>
  recoverAbandonedClaims: ReturnType<typeof vi.fn>
  nudgeDaemon: ReturnType<typeof vi.fn>
  releaseLease: ReturnType<typeof vi.fn>
  runCurationTail: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  warn: Mock<(message: string) => void>
  clock: { value: number }
}

function harness(overrides: {
  lease?: ReturnType<PostRunTailOperations['acquireWriterLease']>
  enqueue?: ReturnType<typeof vi.fn>
  runNextJob?: ReturnType<typeof vi.fn>
} = {}): Harness {
  const clock = { value: 1_000 }
  const warn = vi.fn<(message: string) => void>()
  const enqueue = overrides.enqueue
    ?? vi.fn(async () => ({ job: { id: 'job_analyze' }, deduped: false }))
  const runNextJob = overrides.runNextJob
    ?? vi.fn(async () => ({ ran: false, reason: 'no-job' }))
  const adoptEpoch = vi.fn(async () => ({ epoch: 7 }))
  const recoverAbandonedClaims = vi.fn(async () => ({ recovered: 0 }))
  const nudgeDaemon = vi.fn(async () => undefined)
  const releaseLease = vi.fn(() => ({ kind: 'released' }))
  const runCurationTail = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)

  const operations = {
    loadCompletedRunHandoff: vi.fn(() => handoff),
    resolveKnowledgeRoot: vi.fn(() => knowledgeRoot),
    composeHost: vi.fn(() => ({
      jobs: async () => ({
        queue: { enqueue, runNextJob, recoverAbandonedClaims },
        store: { adoptEpoch },
        // The real handle publishes the source its queue mints ids with, and the tail derives
        // this run's chain from it. A fake without one would let the tail's derivation pass on
        // a shape production never hands it.
        idSource: DIGEST_JOB_ID_SOURCE,
      }),
      close,
    })),
    acquireWriterLease: vi.fn(() => overrides.lease
      ?? { kind: 'acquired', leaseId: 'lease-1', epoch: 7 }),
    releaseLease,
    nudgeDaemon,
    curateCompletedRun: vi.fn(async () => ({
      curated: 0,
      deprecated: 0,
      complete: true,
      drainKind: 'drained' as const,
    })),
    runCurationTail,
    // 2026-10-16 (442-10, D-17): another run's fixture context, as its own run-config record would give it.
    resolveRunCurationContext: vi.fn(async () => ({ mask: (text: string) => text, knowledgeRoot })),
    now: () => clock.value,
  } as unknown as PostRunTailOperations

  return {
    operations,
    enqueue,
    runNextJob,
    adoptEpoch,
    recoverAbandonedClaims,
    nudgeDaemon,
    releaseLease,
    runCurationTail,
    close,
    warn,
    clock,
  }
}

function options(h: Harness): RunPostRunTailOptions {
  return {
    runId,
    agentQaRoot,
    configPath,
    knowledgeConfig: { dir: 'agent-qa-knowledge' },
    configDir,
    mask: (text: string) => text,
    log: { warn: (message: string) => h.warn(message) },
    operations: h.operations,
  }
}

describe('the shared post-run tail (ANLZ-01 / JOBQ-06, D-03/D-07)', () => {
  it('binds lazy replay so the actual tail resolver holds missing receipts and permits the quiet rare path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tail-replay-law-'))
    const path = join(root, 'agent-qa.config.yaml')
    const proof = promotionHostProof(path)
    const build = vi.spyOn(promotionPosture, 'buildPromotionPostureResolver').mockImplementation(proof.prepare)
    try {
      const h = harness()
      const tail = runPostRunTail({ ...options(h), configPath: path, configDir: root,
        agentQaRoot: join(root, '.agent-qa') })
      await tail.drain()
      const swept = h.runCurationTail.mock.calls[0]![0] as { resolvePromotionPosture: ResolvePromotionPosture }
      proof.verify(swept.resolvePromotionPosture)
      expect(build).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('builds posture once before the lease and forwards it to both the job fold and sweep', async () => {
    const h = harness()
    const resolvePosture = vi.fn(() => ({ kind: 'unavailable' as const, replayGateAvailable: false, refusals: ['partition refused'] }))
    const build = vi.spyOn(promotionPosture, 'buildPromotionPostureResolver').mockResolvedValue({
      kind: 'unavailable', committedRoot: '/project/agent-qa-eval', refusals: ['partition refused'], resolve: resolvePosture,
    })
    try {
      const tail = runPostRunTail(options(h))
      await tail.drain()
      expect(build).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ configPath, knowledgeRoot, agentQaRoot, canaryFacts: expect.any(Function), lowerTrustShares: expect.any(Function) }))
      expect(build.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(h.operations.acquireWriterLease).mock.invocationCallOrder[0])
      const swept = h.runCurationTail.mock.calls[0]![0] as { resolvePromotionPosture?: ResolvePromotionPosture }
      expect(swept.resolvePromotionPosture).toBeTypeOf('function')
      const composed = vi.mocked(h.operations.composeHost).mock.calls[0][0]
      await composed.curateRun({ runId, executionContext: 'local-headless' })
      expect(h.operations.curateCompletedRun).toHaveBeenCalledWith(expect.objectContaining({ resolvePromotionPosture: expect.any(Function) }))
      expect(build).toHaveBeenCalledTimes(1)
      expect(h.warn).toHaveBeenCalledWith('curation: posture unavailable: partition refused')
    } finally {
      build.mockRestore()
    }
  })
  it('418 reuses prepared identity with distinct own-run and janitor ordinal bindings', async () => {
    const h = harness()
    const resolve = vi.fn(() => undefined)
    const build = vi.spyOn(promotionPosture, 'buildPromotionPostureResolver').mockResolvedValue({
      kind: 'ready', committedRoot: '/project/agent-qa-eval', resolve,
      host: { notices: [] } as unknown as promotionPosture.PromotionPostureHostFacts,
    })
    vi.mocked(h.operations.loadCompletedRunHandoff).mockReturnValue({ ...handoff, buildOrdinal: 15,
      scope: { tier: 'product', key: 'shop' } })
    try {
      await runPostRunTail(options(h)).drain()
      const composed = vi.mocked(h.operations.composeHost).mock.calls[0]![0]
      await composed.curateRun({ runId, executionContext: 'local-headless' })
      const own = vi.mocked(h.operations.curateCompletedRun).mock.calls[0]![0].resolvePromotionPosture!
      const sweep = h.runCurationTail.mock.calls[0]![0] as {
        resolvePromotionPostureForRun: (ordinal: number, scope: { tier: 'product'; key: string }) => Promise<ResolvePromotionPosture>
      }
      const prior = await sweep.resolvePromotionPostureForRun(11, { tier: 'product', key: 'shop' })
      const candidate = { id: 'candidate', product: 'shop', scope: { tier: 'product' as const, key: 'shop' },
        provenance: { runIds: [], receiptDigests: [], capturedAtOrdinals: [] } }
      own(candidate)
      prior(candidate)
      own(candidate)
      const foreign = { ...candidate, product: 'another-shop' }
      own(foreign)
      prior(foreign)
      expect(resolve.mock.calls).toEqual([[candidate, 15], [candidate, 11], [candidate, 15],
        [foreign, undefined], [foreign, undefined]])
      expect(build).toHaveBeenCalledTimes(1)
    } finally { build.mockRestore() }
  })
  it('hands off with a nudge and returns immediately when the lease is held', async () => {
    const h = harness({ lease: { kind: 'held', holder: { pid: 4242 } } as never })
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(h.nudgeDaemon).toHaveBeenCalledWith(agentQaRoot, { knowledgeRoot })
    expect(tail.report().drain).toBe('handed-off')
    // The run process NEVER waits on the daemon: no epoch adopted, no job claimed, no sweep.
    expect(h.adoptEpoch).not.toHaveBeenCalled()
    expect(h.runNextJob).not.toHaveBeenCalled()
    expect(h.runCurationTail).not.toHaveBeenCalled()
    expect(h.releaseLease).not.toHaveBeenCalled()
  })

  it('pumps under a HANDED lease and never consults the writer lease again (Pitfall 3)', async () => {
    // THE ONE-LEASE RULE, from the tail's side. The 404 D-10 post-verdict step acquires exactly
    // once and hands the authority over; a tail that consulted for itself would be answered
    // `held` — BY ITS OWN PROCESS — and would then "hand off" this run's chain to nobody, leaving
    // the rows claimed and the chips frozen.
    //
    // The harness's acquisition is rigged to answer `held` precisely so the two behaviours are
    // distinguishable: a tail that honours the handed lease pumps and reports `drained`; one that
    // re-acquires reports `handed-off` and nudges a daemon that does not exist.
    const h = harness({ lease: { kind: 'held', holder: { pid: 4242 } } as never })
    const tail = runPostRunTail(options(h))
    await tail.drain({ takeLease: () => ({ leaseId: 'lease-from-the-step', epoch: 9 }) })

    expect(
      h.operations.acquireWriterLease as unknown as ReturnType<typeof vi.fn>,
      'a second consult is the defect; the authority was already decided at the verdict',
    ).not.toHaveBeenCalled()
    expect(tail.report().drain, 'the handed authority is what the pump runs under').toBe('drained')
    expect(h.adoptEpoch, 'and it adopts the epoch the STEP minted, not one of its own').toHaveBeenCalledWith(9)
    expect(h.nudgeDaemon, 'nobody to hand off to — this process is the holder').not.toHaveBeenCalled()
    // Acquire -> pump -> release stays ONE lease: whichever leg held it, exactly one release.
    expect(h.releaseLease).toHaveBeenCalledWith({
      knowledgeRoot,
      leaseId: 'lease-from-the-step',
    })
  })

  it('drains the chain in-process through the full authority dance when the lease is free', async () => {
    const ran = [
      { ran: true, disposition: 'completed', job: { id: String(OWN_CHAIN.analyzeRun) } },
      { ran: true, disposition: 'completed', job: { id: String(OWN_CHAIN.curateMemory) } },
      { ran: false, reason: 'no-job' },
    ]
    let call = 0
    const h = harness({ runNextJob: vi.fn(async () => ran[call++]) })
    const tail = runPostRunTail(options(h))
    await tail.drain()

    // Pitfall 7, in order: adopt the epoch the lease minted, reclaim abandoned claims, then pump.
    expect(h.adoptEpoch).toHaveBeenCalledWith(7)
    expect(h.recoverAbandonedClaims).toHaveBeenCalledWith({ fence: { epoch: 7 } })
    expect(h.runNextJob).toHaveBeenCalledTimes(3)
    // `enqueue: 'skipped'` is the honest reading for a tail no step ran in front of: this file's
    // harness drives `drain()` directly, and the tail no longer performs a hand-off of its own.
    expect(tail.report()).toEqual({ enqueue: 'skipped', drain: 'drained', jobsRun: 2 })
    expect(h.nudgeDaemon).not.toHaveBeenCalled()
    expect(h.releaseLease).toHaveBeenCalledWith({ knowledgeRoot, leaseId: 'lease-1' })
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('runs the prior-run sweep under the SAME lease and the remainder of the one budget', async () => {
    const h = harness()
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(h.runCurationTail).toHaveBeenCalledTimes(1)
    const swept = h.runCurationTail.mock.calls[0]![0] as Record<string, unknown>
    expect(swept.authority).toEqual({ leaseId: 'lease-1', epoch: 7 })
    // D-03: one budget. The sweep's stop point is the tail's own deadline, not a second knob.
    expect(swept.deadlineMs).toBe(1_000 + 60_000)
  })

  it('continues the pump past retry-scheduled and leaves the retrying job for a claim after its backoff', async () => {
    const ran = [
      {
        ran: true,
        disposition: 'retry-scheduled',
        reason: 'transient',
        retryDelayMs: 30_000,
        attemptsRemaining: 2,
        job: { id: String(OWN_CHAIN.analyzeRun) },
      },
      { ran: true, disposition: 'completed', job: { id: 'job_some_other_run' } },
      { ran: false, reason: 'no-job' },
    ]
    let call = 0
    const runNextJob = vi.fn(async () => ran[call++])
    const h = harness({ runNextJob })
    const tail = runPostRunTail(options(h))
    await tail.drain()

    // 2026-10-19 (444.1-12, D-23): the store skips the retrying row until its not-before time, so
    // the pump never sleeps on the backoff and claims whatever else is ready.
    expect(runNextJob).toHaveBeenCalledTimes(3)
    expect(tail.report()).toEqual({ enqueue: 'skipped', drain: 'retry-scheduled', jobsRun: 2 })
  })

  it('does not report backlog-exhausted when a foreign retry-scheduled row is followed by the own chain of this run (G-388-3)',
    async () => {
      const ran = [
        {
          ran: true,
          disposition: 'retry-scheduled',
          reason: 'transient',
          retryDelayMs: 30_000,
          attemptsRemaining: 2,
          job: { id: 'job_some_other_run' },
        },
        { ran: true, disposition: 'completed', job: { id: String(OWN_CHAIN.analyzeRun) } },
        { ran: false, reason: 'no-job' },
      ]
      let call = 0
      const runNextJob = vi.fn(async () => ran[call++])
      const h = harness({ runNextJob })
      const tail = runPostRunTail(options(h))
      await tail.drain()

      expect(runNextJob).toHaveBeenCalledTimes(3)
      expect(tail.report().drain).not.toBe('backlog-exhausted')
      expect(tail.report()).toEqual({ enqueue: 'skipped', drain: 'drained', jobsRun: 2 })
    })

  it('stops the pump at the one budget rather than following the chain forever', async () => {
    const h = harness({
      runNextJob: vi.fn(async () => ({
        ran: true,
        disposition: 'completed',
        // THIS run's own chain head, endlessly re-claimed: the budget ran out while the pump was
        // on this run's work, which is `budget-exhausted` and not a backlog.
        job: { id: String(OWN_CHAIN.analyzeRun) },
      })),
    })
    // Every clock read advances by half the budget, so the third boundary check is past it.
    let reads = 0
    ;(h.operations as { now: () => number }).now = () => 1_000 + (reads++) * 30_000
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(tail.report().drain).toBe('budget-exhausted')
    expect(h.runNextJob.mock.calls.length).toBeLessThan(4)
  })

  it('reports backlog-exhausted when the budget went entirely to other runs\' jobs (WR-01)',
    async () => {
      // The differential twin of the test above: same clock, same dispositions, same bound. The
      // ONE thing that differs is the id the pump kept claiming — a foreign one — and that is the
      // only input the posture is allowed to turn on.
      const h = harness({
        runNextJob: vi.fn(async () => ({
          ran: true,
          disposition: 'completed',
          job: { id: 'job_some_other_run' },
        })),
      })
      let reads = 0
      ;(h.operations as { now: () => number }).now = () => 1_000 + (reads++) * 30_000
      const tail = runPostRunTail(options(h))
      await tail.drain()

      expect(tail.report().drain).toBe('backlog-exhausted')
    })

  it('reports backlog-exhausted at the pump bound when every claimed job was foreign (a CONTROL)',
    async () => {
      // CONTROL, not a detector: this case passed BEFORE the exit classification existed — the
      // shipped guard already covered the `bound` exit — and it passes after. It is here to pin
      // the table's `bound` member so the classification cannot silently flip, not as evidence
      // the G-388-3 fix works. Static clock, so the loop runs to its bound and falls out.
      const h = harness({
        runNextJob: vi.fn(async () => ({
          ran: true,
          disposition: 'completed',
          job: { id: 'job_some_other_run' },
        })),
      })
      const tail = runPostRunTail(options(h))
      await tail.drain()

      // CHAIN_PUMP_BOUND claims, none of them this run's.
      expect(h.runNextJob).toHaveBeenCalledTimes(16)
      expect(tail.report().drain).toBe('backlog-exhausted')
    })

  it('keeps `drained` at the pump bound when the pump was on this run\'s own chain (a CONTROL)',
    async () => {
      // CONTROL, differential twin of the case above — same static clock, same dispositions,
      // same bound; the one input that differs is the claimed id, this run's OWN. Passed before
      // AND after the change: it pins that observing the own chain suppresses the starvation
      // posture, whatever the exit.
      const h = harness({
        runNextJob: vi.fn(async () => ({
          ran: true,
          disposition: 'completed',
          job: { id: String(OWN_CHAIN.analyzeRun) },
        })),
      })
      const tail = runPostRunTail(options(h))
      await tail.drain()

      expect(h.runNextJob).toHaveBeenCalledTimes(16)
      expect(tail.report().drain).toBe('drained')
    })

  it('keeps `drained` when the queue simply emptied, backlog or not', async () => {
    // An empty queue means this run's enqueued chain WAS reached — the rows are gone because
    // somebody ran them, so a starvation posture here would report a backlog that does not exist.
    const h = harness({ runNextJob: vi.fn(async () => ({ ran: false, reason: 'no-job' })) })
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(tail.report().drain).toBe('drained')
    expect(tail.report().jobsRun).toBe(0)
  })

  it('keeps `drained` when an abort ends the pump before this run\'s chain was reached',
    async () => {
      // An aborted drain is not a starved one. The user asked this process to stop; telling them
      // their work is queued behind a backlog would name a cause the run never observed.
      const controller = new AbortController()
      const h = harness({
        runNextJob: vi.fn(async () => {
          controller.abort()
          return { ran: true, disposition: 'completed', job: { id: 'job_some_other_run' } }
        }),
      })
      const tail = runPostRunTail({ ...options(h), signal: controller.signal })
      await tail.drain()

      expect(h.runNextJob).toHaveBeenCalledTimes(1)
      expect(tail.report().drain).toBe('drained')
    })

  it('never reports `drained` when the pump THREW — the one exit outside the enumeration (WR-10)',
    async () => {
      // `drainOutcome` is set to 'drained' optimistically BEFORE the pump, and a throw escapes
      // the loop to the drain's catch without passing any of the five ChainPumpExit members.
      // So the report kept saying the pump drained the chain when it had in fact blown up on
      // the first job — `{drain: 'drained', jobsRun: 0}`, which reads exactly like the honest
      // empty-queue case above and is indistinguishable from it.
      const h = harness({
        runNextJob: vi.fn(async () => {
          throw new Error('the queue database is unreadable')
        }),
      })
      const tail = runPostRunTail(options(h))
      await tail.drain()

      // The warning is the part that already worked, and it is why this is latent rather than
      // user-visible: the cause reaches the user one line before any status. Asserted on
      // `drain()` alone, like every sibling case here — this harness's operations table has no
      // `readPostProcessingStatus`, so `finish()` would warn about the fake, not about the throw.
      expect(h.warn).toHaveBeenCalledTimes(1)
      expect(String(h.warn.mock.calls[0]![0])).toContain('the queue database is unreadable')

      // The report may not claim a drain that threw.
      expect(tail.report().drain).not.toBe('drained')
      expect(tail.report().drain).toBe('threw')
      expect(tail.report().jobsRun).toBe(0)
    })

  it('ENQUEUES NOTHING — leg 1 belongs to the post-verdict step now (404 D-05)', async () => {
    // The complementary half of the relocation, and the one that can go silently wrong: a tail
    // that kept a queue write of its own would put a SECOND row-writing path back into the
    // product, and the store's idempotency index would hide it behind a `deduped` nobody reads.
    const h = harness()
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(h.enqueue, 'the queue is only ever written by the step the shell awaits').not.toHaveBeenCalled()
    expect(tail.report().drain, 'and the drain still ran — this is not a dead tail').toBe('drained')
  })

  it('threads the STEP\'s enqueue outcome into the report rather than performing one', async () => {
    const h = harness()
    const tail = runPostRunTail({ ...options(h), enqueueOutcome: 'deduped' })
    await tail.drain()

    expect(
      tail.report().enqueue,
      'the report answers what the step said, so `deduped` stays a success all the way out',
    ).toBe('deduped')
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('skips only the drain under --detach; the enqueue already happened in the shell (Pitfall 8)', async () => {
    const h = harness()
    const tail = runPostRunTail({ ...options(h), enqueueOutcome: 'enqueued' })

    const exitCode = await runVerdictFirstCurationTail({
      exitCode: 3,
      detach: true,
      runTail: () => tail.drain(),
    })

    expect(exitCode).toBe(3)
    expect(
      h.operations.acquireWriterLease as unknown as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled()
    expect(h.runNextJob).not.toHaveBeenCalled()
    expect(tail.report()).toEqual({
      // What the step reported, carried through unchanged: detaching never means "forget the work
      // exists", and a report that said `skipped` here would say it did.
      enqueue: 'enqueued',
      drain: 'not-attempted',
      jobsRun: 0,
    })
  })

  it('imports the one budget rather than declaring a second timing constant', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const source = readFileSync(
      fileURLToPath(new URL('../curation/post-run-tail.ts', import.meta.url)),
      'utf8',
    )

    expect(source).toContain('DRAIN_BUDGET_MS')
    // The prohibition, stated as a measurement: no literal 60s anywhere in the helper.
    expect(source).not.toMatch(/60_000|60000/u)
  })
})

describe('C444.1-TAIL-BOUND', () => {
  it('every job the tail runs gets the tail budget signal', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const timed = harness({
      runNextJob: vi.fn(async (input: { signal?: AbortSignal }) => {
        seen.push(input.signal)
        const signal = input.signal
        if (signal !== undefined && !signal.aborted) {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        }
        return { ran: false, reason: 'no-job' }
      }),
    })
    await runPostRunTail({ ...options(timed), deadlineMs: timed.clock.value + 20 }).drain()
    expect(seen.length, 'the pump claimed a job').toBe(1)
    expect(seen[0], 'the claim carries a signal').toBeInstanceOf(AbortSignal)
    expect(seen[0]!.aborted, 'the budget fired at the deadline').toBe(true)

    const caller = new AbortController()
    const claims: Array<{ signal?: AbortSignal; abortedAtClaim: boolean }> = []
    const h = harness({
      runNextJob: vi.fn(async (input: { signal?: AbortSignal }) => {
        claims.push({ signal: input.signal, abortedAtClaim: input.signal?.aborted === true })
        if (claims.length === 1) {
          return { ran: true, disposition: 'completed', job: { id: String(OWN_CHAIN.analyzeRun) } }
        }
        caller.abort()
        return { ran: false, reason: 'no-job' }
      }),
    })
    await runPostRunTail({ ...options(h), signal: caller.signal }).drain()
    expect(claims.length).toBe(2)
    for (const claim of claims) {
      expect(claim.signal).toBeInstanceOf(AbortSignal)
      expect(claim.abortedAtClaim).toBe(false)
    }
    expect(claims[1]!.signal!.aborted, "the caller's abort reaches the job's signal").toBe(true)
  })

  it('an interrupted job ends the pump as budget exhausted', async () => {
    const runNextJob = vi.fn(async () => ({
      ran: true,
      disposition: 'interrupted',
      reason: 'handler-threw: the model request was aborted',
      job: { id: String(OWN_CHAIN.analyzeRun) },
    }))
    const h = harness({ runNextJob })
    const tail = runPostRunTail(options(h))
    await tail.drain()

    expect(runNextJob).toHaveBeenCalledTimes(1)
    expect(tail.report().drain).toBe('budget-exhausted')
  })
})

describe('the tail can never reach the exit code (JOBQ-06)', () => {
  it('survives a tail whose own operation table cannot be resolved', async () => {
    // The environment `run.test.ts`'s mocked unit runs live in: a partially-stubbed
    // `runner-local` where merely BUILDING the operation table throws. Reproduced here as a
    // throwing accessor because the spread that assembles the table is what reads the export.
    // Discovered by that suite going to exit 2 the moment the tail moved to the call site —
    // a post-run concern reaching the process code is exactly what JOBQ-06 forbids, so
    // constructing the tail must cost nothing until a leg is awaited.
    const exploding = Object.defineProperty({}, 'now', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('[vitest] No "loadCompletedRunHandoff" export is defined')
      },
    }) as Partial<PostRunTailOperations>
    const warn = vi.fn<(message: string) => void>()
    const tail = runPostRunTail({
      runId,
      agentQaRoot,
      configPath,
      knowledgeConfig: { dir: 'agent-qa-knowledge' },
      configDir,
      log: { warn: (message: string) => warn(message) },
      operations: exploding,
    })

    const exitCode = await runVerdictFirstCurationTail({
      exitCode: 0,
      detach: false,
      runTail: () => tail.drain(),
    })

    expect(exitCode).toBe(0)
    // 404 D-05: `drain()` is the leg that builds the table now, so it is the leg that must absorb
    // a table that cannot be built. The claim is unchanged — a post-run concern may never reach
    // the process code — only the leg that carries it.
    expect(tail.report().drain).toBe('not-attempted')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
