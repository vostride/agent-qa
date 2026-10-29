// A stand-in browser holds each member open, so the cancel lands on a live run, not a finished one.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// The run-scoped prefix of a log: the drain appends chip envelopes after `runFinished`.
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
      // `subscribe(1, …)` replays from the first seq, so a recorder here sees every envelope.
      const recorded = new Map<string, Envelope[]>()
      runDoor.observeSessions((session) => {
        const id = session.id as unknown as string
        const own: Envelope[] = []
        recorded.set(id, own)
        session.subscribe(1, (envelope) => { own.push(envelope as unknown as Envelope) })
      })
      const buffered = (runId: string): Envelope[] => recorded.get(runId) ?? []
      // A queued row as `JobQueue` hands it to the backend: pending, then flipped.
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
      // The status is the run's own verdict; kill adds no reason.
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

      // Every event the cancelled run lacks is work the survivor did, over the run-scoped prefix.
      const cancelledTypes = runScopedTypes(fixture, cancelled)
      const survivorTypes = runScopedTypes(fixture, survivor)
      expect(cancelledTypes).toEqual([
        'runStarted', 'testStarted', 'testFinished', 'testFinished', 'verdict', 'runFinished',
      ])
      expect(survivorTypes).toEqual([
        'runStarted', 'testStarted', 'runWarning', 'testFinished', 'testFinished', 'verdict', 'runFinished',
      ])
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
