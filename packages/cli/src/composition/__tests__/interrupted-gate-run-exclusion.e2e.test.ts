// THE ABSENT-HANDOFF ARM OF INVK-06's INTERRUPTED GATE RUN (Phase 401 plan 22 — closure evidence
// for 401-08's Truth 7 backstop).
//
// WHY A SECOND FILE AND NOT A FIFTH HALF OF `gate-run-exclusion.e2e.test.ts`. That cell's halves
// discriminate on a DECISION: a marker rides the request onto the durable handoff and
// `projectRunOutcomes` answers `excluded: true` against `excluded: false`. This arm's mechanism is
// not a decision at all — it is an ABSENCE, and mixing the two in one file would let a reader take
// the marker cell's discriminating power as this one's.
//
// ---- WHAT THE SIBLING CELL LEFT UNRANGED, IN ITS OWN WORDS ---------------------------------
//
// It closed HALF 1 with an honest limit: "a run that left no handoff at all cannot be handed to
// `projectRunOutcomes`, so 'it contributes nothing' is a statement about the fold's input being
// absent rather than about a decision the fold makes." That sentence is TRUE, and it is not a
// measurement — it reduces to the observation that a function was not called.
//
// THE FALSIFIABLE VERSION LIVES ONE LAYER UP, and it is the whole design of this file. The
// projection family's FULL REBUILD (`rebuildRunOutcomes`, reached through
// `reconcileRunOutcomesProjection` when the stored version stamp differs from the shipped one)
// CLEARS the family and re-reads every `handoff.json` from the runs root. That is the one shipped
// mechanism that could reconstruct an interrupted run's contribution from what IS on disk beside
// the missing handoff — `events.jsonl`, `execution_audit.jsonl`, `artifact.json` are all sitting
// right there in the same directory. So the claim is measured against a real rebuild over a real
// runs root holding BOTH an interrupted run and a completed one, and the mutation ledger in
// 401-22's SUMMARY reds this cell by making the rebuild fall back to each of those files in turn.
//
// ---- THE HONESTY NOTE, WRITTEN HERE SO THE CELL CANNOT OVERCLAIM ---------------------------
//
// IN THIS ARM THE ABSENCE IS THE MECHANISM. The gate-run marker is NOT doing the work: an
// interrupted run that carries no marker at all contributes exactly as little, for exactly the
// same reason. Run B below is that case, and it is carried as a recorded OBSERVATION about what
// the mechanism is — never as evidence that the marker works. A cell that implied otherwise would
// be describing a control it does not have.
//
// ---- ONE SUBSTITUTION, DECLARED --------------------------------------------------------------
//
// The COMPLETED sibling's own durable handoff is rewritten on disk with a member list the
// projection can count, for the same reason `gate-run-exclusion.e2e.test.ts` needs a HALF 2: a run
// driven here has no reachable browser and no reachable model, so its member settles with an
// outcome `countedOutcome` does not count. Without the substitution the "control" would produce no
// rows either and the whole cell would be green at rest — proving nothing (401-05's Truth 3).
// EVERYTHING ELSE ON THAT RECORD IS THE SHIPPED RUN'S OWN: run id, scope, build ordinal, execution
// context, verdict, and the absence of any gate marker. The substituted member is checked against
// the shipped recipes before it is relied on.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 2026-10-19 (444.1-24, D-39): each drive and its detached tail are awaited before removal.
const tails = vi.hoisted(() => [] as Array<Promise<void>>)

vi.mock('../in-process-run-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../in-process-run-execution.js')>()
  return {
    ...original,
    runInProcessCliRun: (...args: Parameters<typeof original.runInProcessCliRun>) => {
      const drive = original.runInProcessCliRun(...args)
      tails.push(drive.then((outcome) => outcome.settled, () => undefined))
      return drive
    },
  }
})

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  RUN_OUTCOMES_PROJECTION_VERSION,
  openIndexWriter,
  acquireWriterLease,
  releaseLease,
  reconcileRunOutcomesProjection as reconcileUnderAuthority,
  suiteFingerprintDeltas,
} from '@vostride/agent-qa-knowledge-local'
import { ANALYSIS_FILE, exercisedAnchors, testFingerprintElements } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  PerTestOutcome,
  RunStartAcknowledgement,
  RunsStartInput,
} from '@vostride/agent-qa-schema'

import { plantHoldableBrowser, waitFor } from '../../commands/__tests__/holdable-browser.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  auditRows,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

afterAll(async () => {
  await Promise.allSettled(tails.splice(0))
  removeInProcessFixtures()
})

type Fixture = ReturnType<typeof createInProcessFixture>

/** 418-12: the direct rebuild fixture must own the same real writer authority as a host. */
function reconcileRunOutcomesProjection(
  opts: Parameters<typeof reconcileUnderAuthority>[0],
): ReturnType<typeof reconcileUnderAuthority> {
  const authority = acquireWriterLease(opts.knowledgeRoot)
  if (authority.kind !== 'acquired') throw new Error('rebuild fixture did not acquire writer authority')
  try {
    return reconcileUnderAuthority({ ...opts, authority })
  } finally {
    releaseLease({ knowledgeRoot: opts.knowledgeRoot, leaseId: authority.leaseId })
  }
}

const COUNTED_FILE = 'tests/counted.yaml'
const COUNTED_NAME = 'a member with evidence on it'
const HANDOFF_FILE = 'handoff.json'

/**
 * The member the completed sibling's record is given, so the control has something to contribute.
 *
 * `outcome: 'failed'` is a counted outcome; the sub-action resolves an element and reports success,
 * which is what `testFingerprintElements` needs to mint an element. Both facts are asserted through
 * the SHIPPED recipes in the integrity cell below rather than believed — the same posture, and the
 * same member, as `gate-run-exclusion.e2e.test.ts`'s half 2.
 */
function countableMember(): PerTestOutcome {
  return {
    testId: 't_counted',
    testName: COUNTED_NAME,
    filePath: COUNTED_FILE,
    testIndex: 0,
    outcome: 'failed',
    steps: [
      {
        stepIndex: 0,
        stepText: 'Click the Submit button',
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'in-process-thing' },
          asOfBuild: 1,
          budget: 1,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
        },
        subActions: [
          {
            plan: 'plan click',
            plannedAction: { type: 'click', ref: 'e1' },
            stateBefore: {
              platform: 'web',
              tree: '',
              elements: [
                {
                  ref: 'e1',
                  role: 'button',
                  name: 'submit',
                  nameNormalized: 'submit',
                  state: { enabled: true, focused: false, visible: true },
                  labels: {},
                  attributes: {},
                },
              ],
              refMap: {},
              timestamp: 0,
              metadata: {},
              url: 'http://127.0.0.1:8931/form.html',
            },
            result: { success: true },
          },
        ],
        verifierVerdict: { pass: false, reasoning: 'the banner did not appear' },
      },
    ],
  } as unknown as PerTestOutcome
}

/** Every run directory currently on disk, by its directory name. */
function runDirNames(fixture: Fixture): string[] {
  return runDirs(fixture).map((dir) => dir.split('/').pop()!).sort()
}

/** The event types a run wrote to ITS OWN durable log, in order. */
function loggedTypes(fixture: Fixture, runDirName: string): string[] {
  return readFileSync(join(fixture.agentQaRoot, 'runs', runDirName, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

/**
 * The run id THE RUN ITSELF recorded, read off its own `runStarted` envelope.
 *
 * Not the directory name: an interrupted run hands back no acknowledgement, and taking the id from
 * the directory would make this cell's identity claims a restatement of the naming convention it
 * also asserts. The directory name is then checked AGAINST this, which pins the convention (401-20)
 * instead of assuming it.
 */
function recordedRunId(fixture: Fixture, runDirName: string): string {
  const first = readFileSync(join(fixture.agentQaRoot, 'runs', runDirName, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; runId?: string })
    .find((event) => event.type === 'runStarted')
  if (first?.runId === undefined) throw new Error(`no runStarted envelope in ${runDirName}`)
  return first.runId
}

/**
 * Every table in the derived index that carries a `run_id` column, derived from the SCHEMA.
 *
 * THE CENSUS IS RE-DERIVED HERE RATHER THAN TRANSCRIBED. `gate-run-exclusion.e2e.test.ts` censused
 * consumers as FOLD-TIME FUNCTIONS (`projectRunOutcomes`, `suiteFingerprintDeltas`,
 * `foldSuiteFingerprints`, the durable tables). That census cannot be transcribed onto this arm,
 * and the drift is the point: an absent run never reaches any of those functions at all, so at
 * rebuild time the only observable surface is the DURABLE FAMILY the rebuild clears and
 * repopulates. This walks `sqlite_master` and `PRAGMA table_info` so a table added to the family
 * later is censused automatically; the caller asserts the derived set against the expected one, so
 * drift reds the cell instead of silently shrinking what it ranges.
 */
function runIdBearingTables(db: DatabaseSync): string[] {
  const tables = (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[])
    .map((row) => row.name)
  return tables
    .filter((table) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .some((column) => column.name === 'run_id'),
    )
    .sort()
}

describe('an interrupted gate run leaves nothing a full rebuild can reconstruct (INVK-06, truth 7)', () => {
  it('THE SUBSTITUTED MEMBER REACHES THE RECIPES IT CLAIMS TO', () => {
    // The control is worth nothing if its member cannot be counted or fingerprinted, so this is
    // asserted through the shipped recipes rather than believed.
    const member = countableMember()
    expect(testFingerprintElements(member).length).toBeGreaterThan(0)
    expect(suiteFingerprintDeltas([member])).toHaveLength(1)
  })

  it('CONTRIBUTES NOTHING TO ANY CENSUSED CONSUMER AFTER A FULL REBUILD, WHILE A COMPLETED SIBLING DOES', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        headedBrowser: true,
      })
      const browsers = plantHoldableBrowser(fixture)
      try {
        const { registry } = composeCliLocalAgent({
          agentQaRoot: fixture.agentQaRoot,
          configPath: fixture.configPath,
          resolveExecutionContext: () => 'local-headless',
        })
        const start = (request: RunsStartInput): Promise<unknown> =>
          invokeFunction(registry, 'runs.start', request, CLI_FUNCTION_CALLER)

        // ---- (1) THREE RUNS IN ONE RUNS ROOT, DIFFERING ON ONE AXIS AT A TIME ------------------
        //
        // All three drive the SAME suite through the SAME shipped composition. Started one at a
        // time and each awaited to its browser's arrival, so the stand-in's atomic ordinal is a
        // NAME for a run rather than a race: ordinal 0 is A, 1 is B, 2 is C.
        //
        //   A  the INTERRUPTED GATE run   — markers on, never released, never completes
        //   B  the INTERRUPTED UNMARKED   — the observation: absence, not the marker, is the
        //                                   mechanism in this arm
        //   C  the COMPLETED sibling      — released, reaches its own verdict, writes a handoff
        //
        // `runs.start` resolves only once the run has written its record, so A's and B's promises
        // are fired and never awaited — which is precisely what "interrupted" means here.
        const pendingA = start({
          patterns: [fixture.suitePattern],
          gateRun: true,
          excludedFromOutcomes: true,
        })
        pendingA.catch(() => undefined)
        await waitFor(() => { expect(browsers.arrivals()).toHaveLength(1) })
        const dirA = runDirNames(fixture)[0]!

        const pendingB = start({ patterns: [fixture.suitePattern] })
        pendingB.catch(() => undefined)
        await waitFor(() => { expect(browsers.arrivals()).toHaveLength(2) })
        const dirB = runDirNames(fixture).find((name) => name !== dirA)!

        const pendingC = start({ patterns: [fixture.suitePattern] })
        await waitFor(() => { expect(browsers.arrivals()).toHaveLength(3) })

        // ---- (2) THE INTERRUPTION IS A MEASURED CONDITION, NOT AN ASSUMPTION -------------------
        //
        // (a) playwright launched each stand-in, so each member is inside `adapter.setup` and not
        //     somewhere else — the non-vacuity witness for the plant itself;
        for (const argv of browsers.arrivals()) expect(argv).toContain('--remote-debugging-pipe')
        // (b) NEITHER interrupted run's member has been released. `releasedOrdinals` rather than
        //     the count, because C is about to be released and "member 0 was never let go" is a
        //     statement about a NAMED member that a global counter cannot make.
        expect(browsers.releasedOrdinals()).toEqual([])
        // (c) each interrupted run is mid-flight on its own durable log: it started a member and
        //     reached no terminal event.
        for (const dir of [dirA, dirB]) {
          expect(loggedTypes(fixture, dir)).toEqual(['runStarted', 'testStarted'])
        }

        // Only now is the sibling released. It fails on the stand-in it was allowed to reach,
        // which is what "completed" means here: it reached its OWN verdict and wrote its record.
        browsers.release(2)
        const ackC = await pendingC as RunStartAcknowledgement
        const runC = String(ackC.runId)
        expect(browsers.releasedOrdinals()).toEqual([2])

        const runA = recordedRunId(fixture, dirA)
        const runB = recordedRunId(fixture, dirB)
        expect(new Set([runA, runB, runC])).toHaveProperty('size', 3)
        // The directory name is the run's own id — pinned, not assumed (401-20's codec).
        expect(runDirNames(fixture)).toEqual([runA, runB, runC].sort())

        // ---- (3) REACH, ASSERTED BEFORE ANY EXCLUSION CLAIM -----------------------------------
        //
        // Without this, "the interrupted run contributed nothing" and "the interrupted run never
        // started" read identically, and this phase has produced that exact false green three
        // times. RE-SPELLED 2026-09-30 (432-13): the reach witness was the run gate's `run:start`
        // row, which no start writes any more; it is now each run's own first event.
        expect(auditRows(fixture).filter((row) => row.action === 'run:start')).toEqual([])
        for (const dir of [dirA, dirB, runC]) {
          const first = readFileSync(join(fixture.agentQaRoot, 'runs', dir, 'events.jsonl'), 'utf8')
            .split('\n')
            .find((line) => line.trim() !== '')
          expect((JSON.parse(first!) as { type: string }).type, `${dir} never started`).toBe('runStarted')
        }

        // ---- (4) THE ABSENCE, ASSERTED ON DISK RATHER THAN INFERRED ---------------------------
        //
        // The two interrupted runs left a directory with real residue and NO handoff. That residue
        // is exactly what a rebuild could reconstruct a contribution from, which is why the
        // mutations in the ledger target it.
        for (const dir of [dirA, dirB]) {
          const runDir = join(fixture.agentQaRoot, 'runs', dir)
          expect(existsSync(join(runDir, HANDOFF_FILE))).toBe(false)
          // 432-13: `execution_audit.jsonl` was the run gate's row; a start writes none now.
          // 441-58 (D-14): nor does it write a `masking-digests.json` sidecar.
          expect(readdirSync(runDir).sort())
            .toEqual(['artifact.json', 'events.jsonl'])
          expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim()).not.toBe('')
        }
        expect(existsSync(join(fixture.agentQaRoot, 'runs', runC, HANDOFF_FILE))).toBe(true)

        // The completed sibling's OWN record, given a member the projection can count. See the
        // declared substitution in this file's header: the id, scope, build ordinal, execution
        // context and marker-absence below are all the shipped run's own.
        const handoffPathC = join(fixture.agentQaRoot, 'runs', runC, HANDOFF_FILE)
        const recordC = JSON.parse(readFileSync(handoffPathC, 'utf8')) as CompletedRunHandoff
        expect(String(recordC.runId)).toBe(runC)
        expect(recordC.gateRun).toBeUndefined()
        expect(recordC.excludedFromOutcomes).toBeUndefined()
        expect(recordC.aggregateVerdict).toBe('failed')
        writeFileSync(
          handoffPathC,
          JSON.stringify({ ...recordC, tests: [countableMember()] }, null, 2),
        )

        const residueBefore = new Map(
          [dirA, dirB].map((dir) => [
            dir,
            readFileSync(join(fixture.agentQaRoot, 'runs', dir, 'events.jsonl'), 'utf8'),
          ]),
        )

        // ---- (5) THE REBUILD — THE ONE MECHANISM THAT COULD RECONSTRUCT THEM ------------------
        //
        // Reached through the shipped VERSION-STAMP trigger, not by calling the rebuild directly:
        // a fresh index carries no stamp, absence reads as mismatch, and `reconcile` rebuilds. The
        // report is the confirmation that the rebuild is what ran — and its two skip counters say
        // the interrupted runs were never even CANDIDATES, which is a different and stronger fact
        // than their having been counted as malformed skips.
        const knowledgeRoot = join(fixture.project, 'rebuilt-knowledge')
        const runsRoot = join(fixture.agentQaRoot, 'runs')
        const rebuild = reconcileRunOutcomesProjection({
          knowledgeRoot,
          runsRoot,
          extractAnchors: exercisedAnchors,
        })
        expect(rebuild).toEqual({
          kind: 'rebuilt',
          report: { folded: 1, skippedHandoffs: 0, skippedArtifacts: 0 },
        })

        // The stamp mechanism itself, driven in both directions so "it rebuilt" cannot be an
        // accident of the index being new: at the shipped version it answers `current`, and a
        // STALE stamp sends it round again to the same answer.
        const stampHandle = openIndexWriter(knowledgeRoot)
        try {
          expect(stampHandle.db.prepare('SELECT version FROM run_outcome_projection_version').all())
            .toEqual([{ version: RUN_OUTCOMES_PROJECTION_VERSION }])
        } finally {
          stampHandle.close()
        }
        expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors: exercisedAnchors }))
          .toEqual({ kind: 'current' })
        const staleHandle = openIndexWriter(knowledgeRoot)
        try {
          staleHandle.db
            .prepare('INSERT OR REPLACE INTO run_outcome_projection_version (id, version) VALUES (1, ?)')
            .run(RUN_OUTCOMES_PROJECTION_VERSION - 1)
        } finally {
          staleHandle.close()
        }
        expect(reconcileRunOutcomesProjection({ knowledgeRoot, runsRoot, extractAnchors: exercisedAnchors }))
          .toEqual({
            kind: 'rebuilt',
            report: { folded: 1, skippedHandoffs: 0, skippedArtifacts: 0 },
          })

        // ---- (6) PER CENSUSED CONSUMER: NOTHING FOR THE INTERRUPTED RUNS, ROWS FOR THE SIBLING -
        const handle = openIndexWriter(knowledgeRoot)
        try {
          const db = handle.db
          // The census, re-derived from the schema. Asserted against the expected set so a table
          // joining the family later reds this line instead of quietly falling outside the sweep.
          expect(runIdBearingTables(db)).toEqual([
            'run_fingerprint_windows',
            'run_outcome_applied_runs',
            'suite_fingerprints',
          ])
          // Every run_id-bearing table, swept: the interrupted ids appear in none of them, and the
          // sibling's id appears in ALL of them — so an empty answer cannot pass as an exclusion.
          for (const table of runIdBearingTables(db)) {
            const ids = (db.prepare(`SELECT DISTINCT run_id FROM ${table}`).all() as { run_id: string }[])
              .map((row) => row.run_id)
              .sort()
            expect(ids).toEqual([runC])
          }

          // The two tables that carry NO run_id: attribution is by row identity and by counter
          // value. A contribution from either interrupted run would show up as a second row (its
          // member is `tests/member.yaml` / `the suite member`, not the substituted one) or, if
          // something coerced it onto the same identity, as `failures: 2` and a second entry in
          // the outcome window.
          expect(db.prepare(`
            SELECT product, file_path, test_name, passes, failures, heals, flake_count,
                   last_outcomes_json, last_build_ordinal
            FROM run_test_outcomes
          `).all()).toEqual([
            {
              product: 'in-process-thing',
              file_path: COUNTED_FILE,
              test_name: COUNTED_NAME,
              passes: 0,
              failures: 1,
              heals: 0,
              flake_count: 0,
              last_outcomes_json: JSON.stringify([
                { buildOrdinal: recordC.buildOrdinal, passed: false },
              ]),
              last_build_ordinal: recordC.buildOrdinal,
            },
          ])
          const anchorRows = db
            .prepare('SELECT DISTINCT file_path, test_name FROM run_test_anchors')
            .all()
          expect(anchorRows).toEqual([{ file_path: COUNTED_FILE, test_name: COUNTED_NAME }])
          expect(
            (db.prepare('SELECT COUNT(*) AS n FROM run_test_anchors').get() as { n: number }).n,
          ).toBeGreaterThan(0)
        } finally {
          handle.close()
        }

        // ---- (7) THE INTERRUPTED RUNS' OWN ARTIFACTS ARE NOT REPAIRED -------------------------
        //
        // The rebuild reads; it does not backfill, synthesize, or complete what an interrupted run
        // left behind. Asserted on the bytes, so "no rows" cannot have been bought by quietly
        // finishing the runs' records.
        for (const dir of [dirA, dirB]) {
          const runDir = join(fixture.agentQaRoot, 'runs', dir)
          expect(existsSync(join(runDir, HANDOFF_FILE))).toBe(false)
          expect(existsSync(join(runDir, ANALYSIS_FILE))).toBe(false)
          // 441-58 (D-14): no `masking-digests.json` sidecar is written.
          expect(readdirSync(runDir).sort())
            .toEqual(['artifact.json', 'events.jsonl'])
          expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).toBe(residueBefore.get(dir))
        }

        // ---- (8) THE OBSERVATION, RECORDED AS ONE ---------------------------------------------
        //
        // A and B were treated identically by every assertion above, and B carries no gate marker
        // at all. That is the honest reading of this arm: what excluded them is that their records
        // do not exist, NOT the marker the gate run carries. The marker's own discriminating power
        // is measured in `gate-run-exclusion.e2e.test.ts`, over two runs that both completed.
        expect(existsSync(join(fixture.agentQaRoot, 'runs', dirB, HANDOFF_FILE))).toBe(false)
      } finally {
        // Never leave a parked stand-in behind: it would outlive the run that spawned it.
        browsers.releaseAll()
        browsers.restoreBrowsersPath()
      }
    } finally {
      await target.close()
    }
  }, 300_000)
})
