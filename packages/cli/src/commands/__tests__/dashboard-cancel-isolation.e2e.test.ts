// CANCELLING ONE OF TWO CONCURRENT DASHBOARD RUNS (401 UAT item 14 / Truth 5, D-12 — INVK-01).
//
// WHAT WAS MISSING, AND WHY THIS FILE EXISTS. 401-07 measured its own door-level cancel cell
// VACUOUS and recorded the measurement (`deferred-items.md` item 7): in every other in-process
// fixture in this phase `PLAYWRIGHT_BROWSERS_PATH` is an empty directory, so the member fails its
// browser check in tens of milliseconds. A run therefore reaches its verdict before an abort can
// unwind anything, both arms produce the identical event log, and both settle the same way — so an
// assertion drawn there discriminates NOTHING. What ships measures ROUTING at the door (a cancel
// reaches the run it names) and the abort's EFFECT only over fake sessions whose `cancel()` can be
// counted. The invariant the truth actually states — **an abort unwinds a LIVE run, and only that
// run** — was exercised by nothing. The deferred item names the missing piece exactly: "a member
// the cell can hold open ... That is a fixture, not a fix." This is that fixture.
//
// THE HOLDABLE MEMBER, AND WHY IT IS NOT A SUBSTITUTION OF THE THING UNDER TEST. Every frame from
// the queue's backend down to the runner shell is the shipped one: `createDashboardRunDoor` →
// `composeDashboardDoor` → the shipped `invokeFunction` → the op gate → the composed host's run
// execution → `runInProcessCliRun` → the core → `startRun` → the real `produceSuiteRunMembers`
// closure → `adapter.setup` → `chromium.launch(...)`. What is stood in for is the BROWSER BINARY —
// the external world, not this product's code. A stand-in executable is planted at the path
// playwright itself reports (`chromium.executablePath()`, under a per-fixture
// `PLAYWRIGHT_BROWSERS_PATH`); it records its arrival and then parks until this cell releases it.
// The member is then genuinely, provably still executing inside the shipped web adapter.
//
// LIVENESS IS ASSERTED, NEVER INFERRED, and never from a clock. There is no `sleep` anywhere in
// the hold: the stand-in writes an arrival file (carrying the argv playwright launched it with)
// and blocks on a release file this cell alone creates. Before the cancel is issued the cell
// asserts (a) BOTH stand-ins arrived, (b) each was launched by playwright (`--remote-debugging-pipe`
// in the recorded argv), (c) NO release has been issued, and (d) each run has published
// `runStarted` + `testStarted` and NEITHER `testFinished` NOR `runFinished`. After the cancelled
// run settles it asserts its release file STILL does not exist — so the member never returned, and
// "cancelled mid-flight" cannot be confused with "already finished before we asked".
//
// WHY A SUITE AND WHY TWO MEMBERS. The truncation has to be real. The direct-test producer wraps
// its executor in a catch that sets a framework error and calls `activeRunSession.cancel()`, so a
// browser-less DIRECT run cancels ITSELF and lands on the same `cancelled` verdict a real abort
// produces — measured, and it is half of why the shipped cell is vacuous. The suite producer
// carries no such wrapper (`takeFrameworkError: () => undefined`), so a released member's throw
// reaches the shell as a member ERROR: `runWarning` + a failed member, which poisons the suite's
// fail-fast group and publishes member 1's `testFinished`. The shell's CANCEL branch, by contrast,
// skips every remaining member SILENTLY (`skippedPerTestOutcome`, no publish). Two members is
// therefore the smallest fixture in which the cancelled run's log is missing work the surviving
// run's log has.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-10-19 (444.1-24, D-39): each drive and its detached tail are awaited before removal.
const tails = vi.hoisted(() => [] as Array<Promise<void>>)

vi.mock('../../composition/in-process-run-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../composition/in-process-run-execution.js')>()
  return {
    ...original,
    runInProcessCliRun: (...args: Parameters<typeof original.runInProcessCliRun>) => {
      const drive = original.runInProcessCliRun(...args)
      tails.push(drive.then((outcome) => outcome.settled, () => undefined))
      return drive
    },
  }
})

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import type { ExecuteOptions, RunSettledDetails } from '@vostride/agent-qa-dashboard'

import { composeDashboardDoor, createDashboardRunDoor } from '../dashboard.js'
import { plantHoldableBrowser, waitFor } from './holdable-browser.js'
import {
  CountingTarget,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'

type Fixture = ReturnType<typeof createInProcessFixture>

interface Settled {
  runId: string
  status: string
  details: RunSettledDetails
}

interface Envelope {
  id: number
  type: string
  seq?: number
  runId?: string
  payload?: Record<string, unknown>
  reason?: string
}

// THE HOLDABLE MEMBER LIVES IN `holdable-browser.ts` (401-22), imported above. It has a second
// consumer now — `composition/__tests__/interrupted-gate-run-exclusion.e2e.test.ts` — and a fixture
// whose whole value is that liveness is ASSERTED cannot afford two spellings: the weaker copy
// would go green having measured nothing. That module's header names every load-bearing property,
// including the `PLAYWRIGHT_BROWSERS_PATH`-before-anything-touches-playwright ordering hazard that
// this cell's plant depends on.

/** The event types a run wrote to ITS OWN durable log, in order. */
/**
 * The RUN-SCOPED prefix of a run's log: everything up to and including `runFinished`.
 *
 * 404 D-06 gave the `runs.start` door a drain leg, so a finished run's log continues with the chip
 * envelopes that drain emits. Those are post-processing and this cell is about the run, so the
 * comparison is made over the prefix — and a chip line that appeared BEFORE `runFinished` would be
 * caught by the ordering assertion at the call site rather than silently trimmed here.
 */
function runScopedTypes(fixture: Fixture, runId: string): string[] {
  const all = loggedTypes(fixture, runId)
  const finishedAt = all.indexOf('runFinished')
  return finishedAt < 0 ? all : all.slice(0, finishedAt + 1)
}

function loggedTypes(fixture: Fixture, runId: string): string[] {
  return readFileSync(join(fixture.agentQaRoot, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

function loggedEnvelopes(fixture: Fixture, runId: string): Envelope[] {
  return readFileSync(join(fixture.agentQaRoot, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Envelope)
}

let plantedBrowsers: ReturnType<typeof plantHoldableBrowser> | undefined

beforeEach(() => { plantedBrowsers = undefined })
afterEach(() => {
  // Never leave a parked stand-in behind: it would outlive the run that spawned it. The plant owns
  // the `PLAYWRIGHT_BROWSERS_PATH` it pinned, so it also owns putting it back.
  plantedBrowsers?.releaseAll()
  plantedBrowsers?.restoreBrowsersPath()
  plantedBrowsers = undefined
})
afterAll(async () => {
  await Promise.allSettled(tails.splice(0))
  removeInProcessFixtures()
})

describe('cancelling one of two concurrently executing dashboard runs', () => {
  it('ABORTS THE NAMED RUN MID-FLIGHT AND LEAVES THE OTHER TO ITS OWN VERDICT, EACH UNDER ITS OWN runId', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        headedBrowser: true,
        secondSuiteMember: true,
      })
      const browsers = plantHoldableBrowser(fixture)
      plantedBrowsers = browsers

      const db = new DashboardDatabase({ dbPath: ':memory:' })
      const runDoor = await createDashboardRunDoor({ db })
      const door = composeDashboardDoor({
        agentQaRoot: fixture.agentQaRoot,
        configPath: fixture.configPath,
        boundOrigin: () => undefined,
        runBridge: runDoor.runBridge,
      })
      runDoor.bindHost(door.host)

      const settled: Settled[] = []
      runDoor.backend.on('run-settled', (runId: string, status: string, details: RunSettledDetails) => {
        settled.push({ runId, status, details })
      })
      // 2026-08-27 (405-07, D-19): the run's OWN bus, watched through the door's published
      // `observeSessions` fan-out. This used to read the backend's per-run replay buffer, which
      // existed for one SSE route and was deleted with it. `subscribe(1, …)` is replay-then-live
      // from the first seq, so a recorder registered here sees every envelope of every run the
      // door starts — and each list is a different SESSION, which is a stronger isolation claim
      // than two entries in one map.
      const recorded = new Map<string, Envelope[]>()
      runDoor.observeSessions((session) => {
        const id = session.id as unknown as string
        const own: Envelope[] = []
        recorded.set(id, own)
        session.subscribe(1, (envelope) => { own.push(envelope as unknown as Envelope) })
      })
      const buffered = (runId: string): Envelope[] => recorded.get(runId) ?? []
      // A queued row as `JobQueue` hands it to the backend: pending, then flipped (443-04).
      const enqueue = (name: string): string => {
        const id = db.insertRun({
          name,
          status: 'pending',
          duration: 0,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          platform: 'web',
        })
        db.updateRunStatus(id, 'running')
        return id
      }

      const cancelled = enqueue('the run that will be cancelled')
      const survivor = enqueue('the run that must not notice')

      // ---- (1) TWO RUNS, BOTH PARKED IN A LIVE MEMBER -----------------------------------------
      //
      // Started ONE AT A TIME, each awaited to its arrival, so the stand-in's atomic ordinal is a
      // NAME for a run rather than a race: ordinal 0 is `cancelled`'s browser, ordinal 1 is
      // `survivor`'s. Both are running before either is touched, which is what makes this a
      // concurrency claim at all.
      runDoor.backend.execute({ runId: cancelled, args: [fixture.suitePattern], source: 'dashboard' } as ExecuteOptions)
      await waitFor(() => { expect(browsers.arrivals()).toHaveLength(1) })
      runDoor.backend.execute({ runId: survivor, args: [fixture.suitePattern], source: 'dashboard' } as ExecuteOptions)
      await waitFor(() => { expect(browsers.arrivals()).toHaveLength(2) })

      // ---- (2) LIVENESS AT THE MOMENT OF THE CANCEL, ASSERTED --------------------------------
      //
      // (a) both stand-ins are parked, and PLAYWRIGHT launched them — the argv is the browser
      //     launch's own, so the member is inside `adapter.setup` and not somewhere else;
      for (const argv of browsers.arrivals()) expect(argv).toContain('--remote-debugging-pipe')
      // (b) NOTHING HAS BEEN RELEASED. This is the difference between a held member and a member
      //     that finished on its own, and it is a fact about what this cell has done, not a timing
      //     guess.
      expect(browsers.releasesIssued()).toBe(0)
      // (c) each run has published its own mid-flight events and NEITHER terminal one;
      for (const runId of [cancelled, survivor]) {
        const types = buffered(runId).map((event) => event.type)
        expect(types).toContain('runStarted')
        expect(types).toContain('testStarted')
        expect(types).not.toContain('testFinished')
        expect(types).not.toContain('runFinished')
      }
      // (d) the backend agrees both are in flight, and nothing has settled.
      expect(runDoor.backend.getActiveExecutions().map((execution) => execution.runId).sort())
        .toEqual([cancelled, survivor].sort())
      expect(settled).toEqual([])

      // ---- (3) THE ABORT UNWINDS THE LIVE RUN IT NAMES ----------------------------------------
      expect(runDoor.backend.kill(cancelled)).toBe(true)
      await waitFor(() => { expect(settled.map((entry) => entry.runId)).toEqual([cancelled]) })

      // THE ASSERTION THAT MAKES THIS NOT THE VACUOUS CELL: the cancelled run settled while its
      // member was STILL PARKED. Nothing released it, so the run cannot have reached its verdict by
      // finishing — the abort is what ended it.
      expect(browsers.releasesIssued()).toBe(0)
      // 2026-10-17 (444-06, D-43): the status is the run's own verdict; kill adds no reason.
      expect(settled[0]!.status).toBe('cancelled')
      expect(settled[0]!.details.reason).toBeUndefined()

      // ---- (4) AT THAT SAME MOMENT THE OTHER RUN IS UNTOUCHED ---------------------------------
      expect(runDoor.backend.getActiveExecutions().map((execution) => execution.runId)).toEqual([survivor])
      const survivorMidFlight = buffered(survivor).map((event) => event.type)
      expect(survivorMidFlight).not.toContain('runFinished')
      expect(survivorMidFlight).not.toContain('testFinished')
      // Nothing has settled for the survivor either — the terminal fact now lives only on the
      // settle event, where the synthetic completion frame used to duplicate it.
      expect(settled.map((entry) => entry.runId)).not.toContain(survivor)

      // ---- (5) RELEASE THE SURVIVOR — IT REACHES ITS OWN VERDICT ------------------------------
      browsers.release(1)
      await waitFor(() => { expect(settled).toHaveLength(2) })
      const bySettledRun = new Map(settled.map((entry) => [entry.runId, entry]))
      expect(bySettledRun.get(survivor)!.status).toBe('failed')
      expect(bySettledRun.get(survivor)!.details.reason).toBeUndefined()

      // ---- (6) THE CANCELLED RUN'S LOG IS TRUNCATED, NOT MERELY PRESENT ----------------------
      //
      // Both runs ran the SAME two-member suite, and both `runStarted` envelopes promise two
      // members. The cancelled run's log carries ONE member's run and stops; the survivor's
      // carries the member-0 failure, the `runWarning` that failure raised, and member 1's
      // fail-fast `testFinished`. Every event the cancelled run is missing is work the survivor
      // did — which is the claim, stated as a subset rather than as "both logs are non-empty".
      // 2026-10-17 (444-08, D-34): the member the cancel skipped is published as `skipped`.
      //
      // 2026-08-26 (404 D-06): the run's log now continues PAST `runFinished`. This door drains
      // its own post-processing chain in-process, so the chip envelopes the drain emits land in
      // the run's own `events.jsonl` — which is the whole point of giving `runs.start` a drain leg
      // and is why a dashboard user's chips advance at all. The claim this cell makes is about the
      // RUN, so it is stated over the run-scoped PREFIX (everything up to and including
      // `runFinished`) and the post-processing tail is asserted separately as what it is.
      const cancelledTypes = runScopedTypes(fixture, cancelled)
      const survivorTypes = runScopedTypes(fixture, survivor)
      expect(cancelledTypes).toEqual([
        'runStarted', 'testStarted', 'testFinished', 'testFinished', 'verdict', 'runFinished',
      ])
      expect(survivorTypes).toEqual([
        'runStarted', 'testStarted', 'runWarning', 'testFinished', 'testFinished', 'verdict', 'runFinished',
      ])
      // Nothing post-processing precedes `runFinished`, on either run — LIFE-01's own ordering,
      // re-measured here because this is where a chip line would first be seen out of place.
      for (const runId of [cancelled, survivor]) {
        const all = loggedTypes(fixture, runId)
        const finishedAt = all.indexOf('runFinished')
        expect(finishedAt, `${runId}: runFinished must be present`).toBeGreaterThanOrEqual(0)
        expect(
          all.slice(0, finishedAt).filter((type) => type.startsWith('analysis') || type.startsWith('curation')),
          `${runId}: no post-processing envelope may precede runFinished`,
        ).toEqual([])
      }
      expect(survivorTypes.length).toBeGreaterThan(cancelledTypes.length)
      // The member count both runs SET OUT to do is the same, so a shorter log is missing work.
      for (const runId of [cancelled, survivor]) {
        const started = loggedEnvelopes(fixture, runId).find((event) => event.type === 'runStarted')!
        expect(started.payload!['memberTestCount']).toBe(2)
      }
      // Named, so a regression that swapped one event type for another cannot pass on length.
      expect(cancelledTypes.filter((type) => type === 'testFinished')).toHaveLength(2)
      expect(survivorTypes.filter((type) => type === 'testFinished')).toHaveLength(2)
      expect(cancelledTypes).not.toContain('runWarning')
      const cancelledEvents = loggedEnvelopes(fixture, cancelled)
      const survivorEvents = loggedEnvelopes(fixture, survivor)
      expect(cancelledEvents.find((event) => event.type === 'verdict')!.payload!['verdict']).toBe('cancelled')
      expect(survivorEvents.find((event) => event.type === 'verdict')!.payload!['verdict']).toBe('failed')
      expect(
        cancelledEvents.filter((event) => event.type === 'testFinished').map((event) => event.payload!['outcome']),
      ).toEqual(['cancelled', 'skipped'])
      // The survivor's own failure is the browser stand-in it was allowed to reach, which is the
      // second half of "released": the member RAN and reported, rather than being unwound.
      expect(survivorEvents.find((event) => event.type === 'runWarning')!.payload!['code'])
        .toBe('member-executor-error')

      // ---- (7) ATTRIBUTION, CHECKED RATHER THAN COUNTED --------------------------------------
      //
      // Cross-attribution is a real defect class here (the two-sided contract pin), so each surface
      // is asked WHOSE the rows are, never how many there are.
      const dirs = runDirs(fixture).map((dir) => dir.split('/').pop())
      expect(dirs.sort()).toEqual([cancelled, survivor].sort())
      for (const [runId, other] of [[cancelled, survivor], [survivor, cancelled]] as const) {
        const owners = new Set(loggedEnvelopes(fixture, runId).map((event) => event.runId))
        expect(owners).toEqual(new Set([runId]))
        // The other run's id appears NOWHERE in this run's log — not as an owner, not in a payload.
        expect(readFileSync(join(fixture.agentQaRoot, 'runs', runId, 'events.jsonl'), 'utf8'))
          .not.toContain(other)
        const sessionOwners = new Set(buffered(runId).map((event) => event.runId))
        expect(sessionOwners).toEqual(new Set([runId]))
      }
      // Two db rows, each adopted by the run that was enqueued as it — no third row, and no swap.
      expect(db.getRuns({}).map((row) => row.id).sort()).toEqual([cancelled, survivor].sort())
      expect(db.getRun(cancelled)!.status).toBe('cancelled')
      expect(db.getRun(survivor)!.status).toBe('failed')
      // ONE KNOCK PER RUN AND NO MORE: the assembler's baseline probe is the only thing either run
      // reached the target with, because both were parked at the browser before a step could run.
      // A cancelled run that had somehow been restarted, or a survivor that had inherited its
      // sibling's work, would show up as a third.
      expect(target.hits).toEqual(['/in-process-thing', '/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 240_000)
})
