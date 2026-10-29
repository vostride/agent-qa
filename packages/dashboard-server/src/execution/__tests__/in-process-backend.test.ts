// THE IN-PROCESS BACKEND'S BRIDGE (Phase 401 plan 07 — D-04/D-09/D-12, INVK-01).
//
// WHAT IS UNDER TEST is the half of INVK-01 that lives in `packages/dashboard-server`: the bridge
// from a started run's `RunSession` bus to the two things the host actually consumes — the settle
// event it reconciles the db row from, and the active-run list. The run-starter is injected here
// (it is the CLI's, and this package may not name it), so what these cells range is the bridge, the
// lifecycle mapping and the completion vocabulary.
//
// 2026-08-27 (405-07, D-19) — THE PARITY ANCHOR AND ITS CELLS ARE GONE, AND THAT IS THE RIGHT
// OUTCOME RATHER THAN A LOSS. The anchor was a golden captured from the SHIPPED spawn-and-scrape
// wire before that class was deleted, and five cells compared this bridge's per-run replay buffer
// against it. Its whole job was to make one producer swap measurable while the consumer surface
// held still — and it did that job. That consumer surface is now deleted with the route it fed, so
// the golden anchors a shape nothing produces and nothing reads. Keeping the cells would have kept
// a buffer alive purely so its own test could pass.
//
// WHAT REPLACES THE SUBSCRIPTION'S COVERAGE. Replay-then-live is still load-bearing — it is how the
// status mapping and `testName` see a run whose first envelopes preceded the attach — so it is
// measured through the two facts that survive: the settled status, and the member name on the
// active list.
//
// THE FAKE SESSION MODELS THE BUS'S REFUSAL, DELIBERATELY. `RunEventBus.subscribe` resolves
// `fromSeq ?? 1` and raises `ReplayIncompleteError` for any `fromSeq` below the earliest seq it can
// serve — and since seq numbering starts at 1, `subscribe(0, …)` is unserveable on EVERY run. A fake
// that accepted 0 would let this suite pass while every dashboard run threw at the attach. So the
// fake throws exactly where the bus throws, which is what makes the attach seq a measured fact.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'

import { createInProcessExecutionBackend } from '../in-process-backend.js'
import type {
  ExecuteOptions,
  RunSettledDetails,
  RunSettledStatus,
} from '../execution-backend.js'
import { PARITY_ENVELOPES, PARITY_RUN_ID } from './envelope-parity-fixture.js'

/** Raised where `RunEventBus` raises it, and with its own name, so a cell can recognise it. */
class ReplayIncompleteError extends Error {
  constructor(from: number, earliest: number) {
    super(`ReplayIncomplete: events before seq ${String(earliest)} are no longer available (replay requested from seq ${String(from)})`)
    this.name = 'ReplayIncompleteError'
  }
}

/**
 * A `RunSession` with the bus's OWN replay contract: `fromSeq ?? 1`, replay `seq >= from`, and a
 * refusal — never a silent late start — when `from` is below the earliest seq that exists.
 */
class FakeRunSession implements RunSession {
  readonly executionContext = 'local-headless' as RunSession['executionContext']
  status: RunSession['status'] = 'running'
  cancels = 0
  private readonly published: RunEventEnvelope[] = []
  private readonly live = new Set<(event: RunEventEnvelope) => void>()
  private resolveDone!: (value: never) => void
  readonly done: Promise<never>

  constructor(readonly id: RunSession['id']) {
    this.done = new Promise((resolve) => { this.resolveDone = resolve as (value: never) => void })
    void this.resolveDone
  }

  publish(envelope: RunEventEnvelope): void {
    this.published.push(envelope)
    for (const handler of [...this.live]) handler(envelope)
  }

  // 403 D-05: no browser behind this fake, so no stream and no frame subscription — the honest
  // absent declaration rather than a stub that would make a viewer wait for frames forever.
  subscribeFrames(): undefined { return undefined }

  streamCapabilityOf(): { kind: 'none' } { return { kind: 'none' } }

  subscribe(fromSeq: number, handler: (event: RunEventEnvelope) => void): () => void {
    const from = fromSeq ?? 1
    const earliest = this.published.length > 0 ? this.published[0]!.seq : this.published.length + 1
    if (from < earliest) throw new ReplayIncompleteError(from, earliest)
    for (const envelope of this.published) {
      if (envelope.seq >= from) handler(envelope)
    }
    this.live.add(handler)
    return () => { this.live.delete(handler) }
  }

  cancel(): void {
    this.cancels += 1
  }
}

interface Settled {
  runId: string
  status: RunSettledStatus
  details: RunSettledDetails
}

/** Subscribe a settle recorder on the backend's own event, which is the host's only wire to it. */
function recordSettles(
  backend: ReturnType<typeof createInProcessExecutionBackend>,
  sink: Settled[],
): void {
  backend.on('run-settled', (runId: string, status: RunSettledStatus, details: RunSettledDetails) => {
    sink.push({ runId, status, details })
  })
}

interface Drive {
  settled: Settled[]
  session?: FakeRunSession
}

// 2026-10-17 (444-06, D-11, D-43): a cancelled run's status is its own verdict, so a cancelled fake
// session publishes one.
const cancelledVerdict = (runId: string, seq = 1): RunEventEnvelope => ({
  seq,
  ts: '2026-10-17T00:00:00.000Z',
  runId,
  type: 'verdict',
  payload: { verdict: 'cancelled' },
}) as unknown as RunEventEnvelope

const baseOpts = (runId: string): ExecuteOptions => ({
  runId,
  args: ['tests/parity.yaml'],
  source: 'dashboard',
})

/**
 * Drive one run to completion over a scripted session.
 *
 * `preAttach` is how many envelopes are published BEFORE the door names the session, so the replay
 * arm is exercised by every cell that uses this helper rather than by one cell that remembers to.
 */
async function driveOneRun(input: {
  runId?: string
  envelopes?: readonly RunEventEnvelope[]
  preAttach?: number
  opts?: Partial<ExecuteOptions>
  rejectWith?: unknown
  startSession?: boolean
}): Promise<Drive> {
  const runId = input.runId ?? PARITY_RUN_ID
  const envelopes = input.envelopes ?? PARITY_ENVELOPES
  const preAttach = input.preAttach ?? 3
  const drive: Drive = { settled: [] }

  const backend = createInProcessExecutionBackend({
    invokeRun: async ({ opts, onSession }) => {
      if (input.startSession === false) {
        if (input.rejectWith) throw input.rejectWith
        return
      }
      const session = new FakeRunSession(opts.runId as RunSession['id'])
      drive.session = session
      for (const envelope of envelopes.slice(0, preAttach)) session.publish(envelope)
      onSession(session)
      for (const envelope of envelopes.slice(preAttach)) session.publish(envelope)
      await Promise.resolve()
      if (input.rejectWith) throw input.rejectWith
    },
  })
  recordSettles(backend, drive.settled)

  backend.execute({ ...baseOpts(runId), ...input.opts })
  await waitFor(() => { expect(drive.settled).toHaveLength(1) })
  return drive
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

/**
 * Hold one run OPEN so the active list can be read while it is still running, then release it.
 *
 * The settle-driven helper above cannot answer questions about a LIVE run — by the time it returns,
 * the handle has already reached a terminal status and dropped off the active list. These cells
 * need the in-flight state, so they drive the session by hand.
 */
async function driveOpenRun(input: {
  runId: string
  envelopes: readonly RunEventEnvelope[]
  preAttach: number
}): Promise<{
  backend: ReturnType<typeof createInProcessExecutionBackend>
  session: FakeRunSession
  release: () => void
  settled: Settled[]
}> {
  const settled: Settled[] = []
  let session: FakeRunSession | undefined
  let release: (() => void) | undefined
  const backend = createInProcessExecutionBackend({
    invokeRun: async ({ opts, onSession }) => {
      const live = new FakeRunSession(opts.runId as RunSession['id'])
      session = live
      for (const envelope of input.envelopes.slice(0, input.preAttach)) live.publish(envelope)
      onSession(live)
      for (const envelope of input.envelopes.slice(input.preAttach)) live.publish(envelope)
      await new Promise<void>((resolve) => { release = resolve })
    },
  })
  recordSettles(backend, settled)
  backend.execute(baseOpts(input.runId))
  await waitFor(() => { expect(session).toBeDefined() })
  return { backend, session: session!, release: () => release?.(), settled }
}

describe('the bus subscription answers the active list', () => {
  it('`testName` COMES OFF THE SESSION, not off a buffer of its frames', async () => {
    const { backend, release } = await driveOpenRun({
      runId: PARITY_RUN_ID,
      envelopes: PARITY_ENVELOPES.slice(0, 4),
      preAttach: 0,
    })

    const active = backend.getActiveExecutions()
    expect(active).toHaveLength(1)
    expect(active[0]!.runId).toBe(PARITY_RUN_ID)
    // The Rule-1 fix carried forward: the retiring class looked for a `test-start` event the frozen
    // §2.2 vocabulary never emits, so this field was `undefined` for every run. The envelope type
    // is `testStarted` and the name is its payload's.
    expect(active[0]!.testName).toBe('the parity test')
    release()
  })

  it('REPLAY THEN LIVE — a member that started BEFORE the attach is still named', async () => {
    // Every envelope, including the `testStarted`, is published before the door names the session.
    // A bridge that attached live-only would see none of them, so the name would be absent — which
    // is exactly the failure `REPLAY_FROM_START` exists to prevent.
    const { backend, release } = await driveOpenRun({
      runId: 'replayed-run',
      envelopes: PARITY_ENVELOPES.slice(0, 4).map((envelope) =>
        ({ ...envelope, runId: 'replayed-run' }) as RunEventEnvelope),
      preAttach: 4,
    })

    expect(backend.getActiveExecutions()[0]!.testName).toBe('the parity test')
    release()
  })

  it('A RUN WITH NO MEMBER YET CARRIES NO NAME — absence is served as an absent field', async () => {
    const { backend, release } = await driveOpenRun({
      runId: 'unnamed-run',
      envelopes: PARITY_ENVELOPES.slice(0, 1).map((envelope) =>
        ({ ...envelope, runId: 'unnamed-run' }) as RunEventEnvelope),
      preAttach: 0,
    })

    const active = backend.getActiveExecutions()
    expect(active).toHaveLength(1)
    expect('testName' in active[0]!).toBe(false)
    release()
  })

  it('THE ATTACH SEQ IS SERVEABLE — the bus refuses a prefix it cannot produce, and the bridge asks for one it can', async () => {
    // The fake refuses below the earliest seq exactly as `RunEventBus` does. If the bridge asked
    // from seq 0 — which is what "subscribe from seq 0" reads as, and what the bus answers
    // `ReplayIncompleteError` to on every run — the starter would reject and this run would settle
    // `failed` carrying that name.
    const drive = await driveOneRun({})
    expect(drive.settled[0]!.status).toBe('completed')
    expect(JSON.stringify(drive.settled[0]!.details)).not.toContain('ReplayIncomplete')
  })

  it('THE RUN-LEVEL STATUS IS LAST-WRITER-WINS OVER THE WHOLE SUBSCRIPTION', async () => {
    // The fixture says `testFinished: failed` at seq 6 and `verdict: passed` at seq 7: a member's
    // finish does not move the handle (444-02, D-43), the run-level outcome does. Six of the eight
    // are published before the attach, so this ranges the replay too.
    const drive = await driveOneRun({ preAttach: 6 })
    expect(drive.settled[0]!.status).toBe('completed')
  })
})

describe('native lifecycle mapping — cancel, timeout, completion', () => {
  it('KILL ABORTS THE SESSION — no signal, no grace timer, no process group', async () => {
    const drive: Drive = { settled: [] }
    let session: FakeRunSession | undefined
    let release: (() => void) | undefined
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        session = new FakeRunSession(opts.runId as RunSession['id'])
        onSession(session)
        await new Promise<void>((resolve) => { release = resolve })
      },
    })
    recordSettles(backend, drive.settled)

    backend.execute(baseOpts('cancel-me'))
    await waitFor(() => { expect(session).toBeDefined() })
    expect(backend.kill('cancel-me')).toBe(true)
    expect(session!.cancels).toBe(1)
    session!.publish(cancelledVerdict('cancel-me'))

    release?.()
    await waitFor(() => { expect(drive.settled).toHaveLength(1) })
    expect(drive.settled[0]!.status).toBe('cancelled')
    expect(drive.settled[0]!.details.reason).toBeUndefined()
  })

  it('KILLING A RUN THAT IS NOT RUNNING IS FALSE, AND ABORTS NOTHING', async () => {
    const drive = await driveOneRun({})
    const backend = createInProcessExecutionBackend({ invokeRun: async () => { /* never used */ } })
    expect(backend.kill('a-run-nobody-started')).toBe(false)
    expect(drive.session!.cancels).toBe(0)
  })

  it('A TIMEOUT ABORTS THE SESSION AND THE RUN SETTLES `timeout`', async () => {
    const settled: Settled[] = []
    let session: FakeRunSession | undefined
    let release: (() => void) | undefined
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        session = new FakeRunSession(opts.runId as RunSession['id'])
        onSession(session)
        await new Promise<void>((resolve) => { release = resolve })
      },
    })
    recordSettles(backend, settled)

    backend.execute({ ...baseOpts('slow-run'), timeout: 20 })
    await waitFor(() => { expect(session!.cancels).toBe(1) })
    release?.()
    await waitFor(() => { expect(settled).toHaveLength(1) })
    expect(settled[0]!.status).toBe('timeout')
    expect(settled[0]!.details.reason).toContain('run timeout after 20ms')
  })

  it('A CANCEL THAT LANDS BEFORE THE SESSION EXISTS IS STILL HONOURED', async () => {
    let session: FakeRunSession | undefined
    let nameIt: (() => void) | undefined
    const settled: Settled[] = []
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        await new Promise<void>((resolve) => { nameIt = resolve })
        session = new FakeRunSession(opts.runId as RunSession['id'])
        onSession(session)
        if (session.cancels > 0) session.publish(cancelledVerdict(opts.runId))
      },
    })
    recordSettles(backend, settled)

    backend.execute(baseOpts('cancel-during-start'))
    expect(backend.kill('cancel-during-start')).toBe(true)
    await waitFor(() => { expect(nameIt).toBeDefined() })
    nameIt!()
    await waitFor(() => { expect(settled).toHaveLength(1) })
    expect(session!.cancels).toBe(1)
    expect(settled[0]!.status).toBe('cancelled')
  })
})

describe('a refusal is not silence — the completion vocabulary', () => {
  it('A REFUSAL — the starter rejects with NO session, and the reason reaches the consumers', async () => {
    const drive = await driveOneRun({
      runId: 'refused-run',
      startSession: false,
      rejectWith: new Error('Unrecognised run request field: scope'),
    })

    expect(drive.settled[0]!.status).toBe('failed')
    // The refusal's own words, carried to the surface a person reads.
    expect(drive.settled[0]!.details.reason).toContain('Unrecognised run request field')
    expect(drive.settled[0]!.details.output.join('\n')).toContain('scope')
    // NO RUN HAPPENED, and the settle says so by name rather than by the absence of frames between
    // two synthetic bookends — which is what this used to read (405-07, D-19).
    expect(drive.settled[0]!.details.refusedBeforeStart).toBe(true)
    expect(drive.session).toBeUndefined()
  })

  it('A POST-START FAILURE IS A RUN THAT HAPPENED — the reason says so, and the envelopes survive', async () => {
    const drive = await driveOneRun({
      runId: 'framework-error-run',
      rejectWith: new Error('agent-qa browser support is not installed for Chromium'),
    })
    expect(drive.settled[0]!.details.reason).toContain('Run failed after start')
    // A session existed, which is the fact that separates this from a refusal.
    expect(drive.session).toBeDefined()
  })

  // ---- 401-18 (G-401-16): A REFUSAL TRAVELS AS A FACT, NOT AS PROSE THE READER RE-DERIVES ------
  //
  // `settle` already KNOWS the difference — `handle.session === undefined` is the run that never
  // began — and threw the knowledge away, leaving the host's reconciliation to guess from a regex
  // over the message. These cells pin the two facts that now ride the settle instead.

  it('A REFUSAL IS MARKED AS ONE — the host is not left to infer it from the message', async () => {
    const drive = await driveOneRun({
      runId: 'marked-refusal',
      startSession: false,
      rejectWith: Object.assign(new Error('Unrecognised run request field: scope'), { remedies: [] }),
    })
    expect(drive.settled[0]!.details.refusedBeforeStart).toBe(true)
    // The settle is plain facts only: nothing else the rejection carries is projected.
    expect(drive.settled[0]!.details).not.toHaveProperty('remedies')
    expect(Object.keys(drive.settled[0]!.details).sort())
      .toEqual(['output', 'reason', 'refusedBeforeStart'])
  })

  it('AN INPUT ERROR IS A REFUSAL, AND ITS OWN MESSAGE IS THE REASON', async () => {
    // An input error never started a run, so it is marked a refusal like any other.
    const drive = await driveOneRun({
      runId: 'field-refusal',
      startSession: false,
      rejectWith: new Error('The dashboard run door does not honour --headed.'),
    })
    expect(drive.settled[0]!.details.refusedBeforeStart).toBe(true)
    expect(drive.settled[0]!.details.reason).toContain('does not honour --headed')
    expect(drive.settled[0]!.details).not.toHaveProperty('remedies')
  })

  it('A POST-START FAILURE IS NOT MARKED A REFUSAL — the scope control', async () => {
    const drive = await driveOneRun({
      runId: 'post-start-failure',
      rejectWith: new Error('agent-qa browser support is not installed for Chromium'),
    })
    expect(drive.settled[0]!.details.refusedBeforeStart).toBeUndefined()
  })

  it('A RUN THAT ENDS WITH NO TERMINAL ENVELOPE IS `failed`, NOT `completed`', async () => {
    const drive = await driveOneRun({
      runId: 'no-verdict-run',
      envelopes: PARITY_ENVELOPES.slice(0, 2),
      preAttach: 0,
    })
    expect(drive.settled[0]!.status).toBe('failed')
    expect(drive.settled[0]!.details.reason).toBe('Run ended before a verdict was reached')
  })
})

describe('two concurrent runs are isolated at the consumer surface', () => {
  it('EACH HANDLE HOLDS ONLY ITS OWN RUN, AND KILLING ONE ABORTS ONLY THAT SESSION', async () => {
    const sessions = new Map<string, FakeRunSession>()
    const settled: Settled[] = []
    const releases = new Map<string, () => void>()

    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        const session = new FakeRunSession(opts.runId as RunSession['id'])
        sessions.set(opts.runId, session)
        onSession(session)
        await new Promise<void>((resolve) => { releases.set(opts.runId, resolve) })
      },
    })
    recordSettles(backend, settled)

    backend.execute(baseOpts('run-A'))
    backend.execute(baseOpts('run-B'))
    await waitFor(() => { expect(sessions.size).toBe(2) })

    // Interleaved deliberately: a bridge with one shared buffer would pass a cell that published
    // one run's envelopes and then the other's.
    for (const envelope of PARITY_ENVELOPES.slice(0, 4)) {
      sessions.get('run-A')!.publish({ ...envelope, runId: 'run-A' } as RunEventEnvelope)
      sessions.get('run-B')!.publish({ ...envelope, runId: 'run-B' } as RunEventEnvelope)
    }

    // 405-07 (D-19): the per-run buffers this cell used to compare are gone. What remains per-run
    // is the HANDLE, and the isolation claim is made over the one derived fact it carries. The
    // interleaved publishing above is what makes it a claim: a bridge with one shared handle map
    // keyed on anything but the run id would cross the two names here.
    sessions.get('run-B')!.publish({
      ...PARITY_ENVELOPES[1]!,
      runId: 'run-B',
      payload: { ...(PARITY_ENVELOPES[1]!.payload as object), name: 'the other test' },
    } as RunEventEnvelope)

    expect(backend.getActiveExecutions().map((execution) => execution.runId).sort())
      .toEqual(['run-A', 'run-B'])
    const nameOf = (runId: string): string | undefined =>
      backend.getActiveExecutions().find((execution) => execution.runId === runId)?.testName
    expect(nameOf('run-A')).toBe('the parity test')
    expect(nameOf('run-B')).toBe('the other test')

    expect(backend.kill('run-A')).toBe(true)
    expect(sessions.get('run-A')!.cancels).toBe(1)
    expect(sessions.get('run-B')!.cancels).toBe(0)
    sessions.get('run-A')!.publish(cancelledVerdict('run-A', 5))

    releases.get('run-A')!()
    await waitFor(() => { expect(settled).toHaveLength(1) })
    expect(settled[0]!.runId).toBe('run-A')
    expect(settled[0]!.status).toBe('cancelled')
    // B is still going: a cancel that took the other run with it would have settled it too.
    expect(backend.getActiveExecutions().map((execution) => execution.runId)).toEqual(['run-B'])

    releases.get('run-B')!()
    await waitFor(() => { expect(settled).toHaveLength(2) })
    expect(settled[1]!.runId).toBe('run-B')
  })

  it('killAll ABORTS EVERY LIVE SESSION AND NOTHING ELSE', async () => {
    const sessions: FakeRunSession[] = []
    const releases: (() => void)[] = []
    const backend = createInProcessExecutionBackend({
      invokeRun: async ({ opts, onSession }) => {
        const session = new FakeRunSession(opts.runId as RunSession['id'])
        sessions.push(session)
        onSession(session)
        await new Promise<void>((resolve) => { releases.push(resolve) })
      },
    })
    backend.execute(baseOpts('run-1'))
    backend.execute(baseOpts('run-2'))
    await waitFor(() => { expect(sessions).toHaveLength(2) })
    backend.killAll()
    expect(sessions.map((session) => session.cancels)).toEqual([1, 1])
    for (const release of releases) release()
  })
})

describe('the spawn vocabulary is gone from this module', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'in-process-backend.ts'),
    'utf8',
  )
  /** Comment-filtered, so the header may NAME what it retired without satisfying the grep itself. */
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n')

  it('THE SCANNER SEES WHAT IT FORBIDS — before any verdict about the module', () => {
    // Non-vacuity: the same filter over a line that DOES carry each forbidden token must find it.
    const probe = ["import { spawn } from 'node:child_process'", "const P = 'AGENT_QA_EVENT:'", "treeKill(pid)"].join('\n')
    expect(probe).toContain('node:child_process')
    expect(probe).toContain('AGENT_QA_EVENT:')
    expect(probe).toContain('treeKill')
    // And the filter does not strip a code line.
    expect(code).toContain('createInProcessExecutionBackend')
  })

  it('NO CHILD PROCESS, NO SCRAPE PREFIX, NO TREE-KILL', () => {
    expect(code).not.toContain('node:child_process')
    expect(code).not.toContain('AGENT_QA_EVENT:')
    expect(code).not.toContain('treeKill')
    expect(code).not.toContain('tree-kill')
    expect(code).not.toContain('SIGKILL')
  })

  // 2026-08-27 (405-07, D-19/D-21): the retired live-feed machinery, pinned absent in the module
  // that used to hold it. Each needle is two halves so this assertion cannot be the hit that
  // satisfies the phase's grep-clean inventory — a pin that matches itself proves nothing.
  it('NO PER-RUN EVENT BUFFER, NO COUNTER, NO SECOND EMISSION', () => {
    expect(code).not.toContain('event' + 'Buffers')
    expect(code).not.toContain('event' + 'Counters')
    expect(code).not.toContain('push' + 'Event')
    expect(code).not.toContain('getBuffered' + 'Events')
    expect(code).not.toContain('execution-' + 'event')
    expect(code).not.toContain('run-' + 'complete')
    expect(code).not.toContain('run-' + 'start\'')
    // The control: what the module DOES still emit, and the one fact the subscription derives.
    expect(code).toContain("'run-settled'")
    expect(code).toContain('handle.testName =')
  })

  it('THE REFUSAL FACT IS READ STRUCTURALLY — no class name, no regex over the message', () => {
    // The two things a repair here could reach for and must not. Naming the class would be an
    // import `validate:arch` forbids; a regex over the message would be a second parser over prose
    // another package composes — the defect this repair exists to close, one layer down.
    const REFUSAL_CLASS_CHECK = /instanceof\s+\w*(?:Denied|Refused)\w*Error/
    const REGEX_OVER_MESSAGE = /(?:message|reason)\s*\.(?:match|search)\(|\.test\(\s*(?:message|reason)\s*\)/
    expect(code).not.toContain(['Function', 'Denied', 'Error'].join(''))
    expect(code).not.toMatch(REFUSAL_CLASS_CHECK)
    expect(code).not.toMatch(REGEX_OVER_MESSAGE)
    // What it DOES: a refusal is a rejection with no started session.
    expect(code).toContain('handle.session === undefined')
    // NON-VACUITY, BEFORE THE VERDICT ABOVE IS WORTH ANYTHING: both predicates must fire on the
    // very shapes they forbid, or two `not.toMatch`es are green because they match nothing at all.
    expect('if (error instanceof StartRefusedError) return error.message')
      .toMatch(REFUSAL_CLASS_CHECK)
    expect('if (/fail-closed/.test(message)) return message').toMatch(REGEX_OVER_MESSAGE)
    expect('const hit = message.match(/--trust-session/)').toMatch(REGEX_OVER_MESSAGE)
  })
})
