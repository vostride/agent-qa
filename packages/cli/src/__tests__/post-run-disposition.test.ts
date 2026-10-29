// LIFE-02's posture cells, measured on the SHIPPED BINARY.
//
// WHY A SPAWNED RUN AND NOT A UNIT MAPPING. `runFinished.disposition` is decided inside the runner
// shell, by a step composed at a CLI composition root, threaded through the invocation core, over a
// writer lease that lives on disk. A unit test of the decision function is blind to every one of
// those hops — and the defect this phase exists to retire is precisely a door that never calls the
// step at all (D-12: "a unit-level mapping test [is] blind to a door that never calls the
// post-verdict step"). So the assertion is made against `events.jsonl` — the run's own permanent
// record — after `node dist/cli.js run` has exited.
//
// RED BASELINE, measured 2026-08-26 against the version-0.2 checkout at 6ec921b2 with the same
// hermetic fixture this cell builds:
//
//     5 runFinished {"aggregateVerdict":"cancelled","disposition":"detached","finalSeq":5}
//
// The literal was hardcoded in `shell.ts`, so a run with no daemon anywhere reported that nobody
// would drain it while it was about to drain itself. Forcing that literal back reds this file.
//
// THE FIXTURE FAILS FAST ON PURPOSE. `hermeticEnv` points `HOME` into the temp project, so the
// spawned CLI resolves no browser and the single member ends `skipped` in milliseconds. That is
// enough for this claim: the terminal sequence — verdict, then the post-verdict step, then
// `runFinished` — runs identically whatever the members did, and a cell that drove a real browser
// would be measuring Chromium's availability rather than the run's disposition.
//
// ═══ 2026-08-26 — Phase 404 plan 04 completes D-12's set ═══
//
// Four cells now, and each one is a posture NOBODY can reach by reading the code:
//
//   `drained`   — no daemon anywhere. The step probes a free lease and the wire says this process
//                 will pump. (404-01's cell, kept verbatim.)
//   `handedOff` — a REAL `agent-qa daemon` holds the writer lease over the SAME project root. This
//                 is the one that cannot be faked: it needs two processes, one lease file and one
//                 `agent-jobs.db` between them.
//   `detached`  — `--detach`. The lease is skipped and the wire says so — but the durable row is
//                 STILL there, because detaching asks this process not to SPEND itself on the work,
//                 never to forget the work exists (RESEARCH Pitfall 8).
//   gate-run    — `--gate-run`. Nothing is queued at all; the queue database is never even created.
//                 (D-08.)
//
// THE ROW COUNT IS HALF OF EVERY CELL, and it is the half that measures D-05. These runs end on a
// FRAMEWORK ERROR — `agent-qa browser support is not installed` — which
// `in-process-run-execution.ts` re-throws above `afterVerdict`, so the CLI's post-run TAIL never
// runs. Before the enqueue moved into the shell's post-verdict step, that meant a run like this
// queued nothing whatsoever and its analysis was lost with the process. Every row asserted below
// exists because the step queued it between `verdict` and `runFinished`, on a path the tail never
// reached.
//
// WHAT THESE CELLS DO NOT ASSERT, and why saying so is better than a vacuous assertion: no chip
// line. The tail is where chips are emitted, and the framework error means it never runs — for the
// `drained` posture as much as for the others. `post-run-verdict-sequence.test.ts` drives the
// shipped tail in-process over the same run directory afterwards for exactly this reason, and
// `post-run-door-drain.test.ts` measures the in-process drain leg directly.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  buildFreshness,
  cleanupTempRoots,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  spawnCollecting,
  trackTempRoot,
} from './conformance/spawned-chat.js'
import { readJobRows } from './post-run-daemon/project.js'
import {
  cleanupPostRunDaemonRoots,
  LEG_TIMEOUT_MS,
  makePostRunDaemonRoot,
  startPostRunDaemon,
  stopAllPostRunDaemons,
  stopDaemonGracefully,
  waitForMarker,
  waitUntil,
} from './post-run-daemon/spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

/** The id shape the parser accepts: `t_` plus ten id-agent words. */
const PROBE_TEST_ID = 't_ponent-toa-base-fred-click-sigma-lad-agen-report-sticky'

/**
 * A project a real `agent-qa run` completes against, with NOTHING it does not need.
 *
 * `fixtureProject` in the conformance harness serves the chat/MCP anchors and declares no target,
 * no hooks file and no env files — a `run` refuses on each of those in turn before it reaches a
 * verdict. This builds the minimum a run accepts: one unreachable local target, one member, and the
 * three empty files the config resolver requires to exist.
 *
 * Exported so 404-04's added legs and the LIFE-01 sequence cells drive the SAME project rather than
 * a second one that could differ in a way nobody notices.
 */
export function runFixtureProject(label: string, memberCount = 1, into?: string): {
  root: string
  configPath: string
} {
  // `into` writes the project into a root somebody else owns — the daemon fixture's, so a real
  // `agent-qa daemon` and a real `agent-qa run` address ONE `.agent-qa` and ONE knowledge root.
  // Its cleanup is that owner's; only a minted root is tracked here.
  const root = into ?? trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-404-${label}-`)))
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  testPathIgnore: []',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'use:',
      '  mobile:',
      '    appState: preserve',
      'registry:',
      '  targets:',
      '    probe:',
      '      platform: web',
      // Port 9 is the discard protocol — reserved, never listening, and refused instantly rather
      // than left to a connect timeout.
      '      url: http://127.0.0.1:9/unreachable',
      '      environment: local',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  for (let i = 0; i < memberCount; i += 1) {
    writeFileSync(
      join(root, 'tests', `probe-${String(i)}.yaml`),
      [
        // Every member carries the SAME explicit test-id: the parser only judges its shape, and a
        // per-member id would make the fixture's member count a second thing to keep in step.
        `test-id: ${PROBE_TEST_ID}`,
        `name: disposition probe ${String(i)}`,
        'target: probe',
        'steps:',
        '  - Verify the page says "nothing"',
        '',
      ].join('\n'),
      'utf8',
    )
  }
  return { root, configPath: join(root, 'agent-qa.config.yaml') }
}

/**
 * The run's own event log, parsed.
 *
 * The run directory is DISCOVERED rather than derived: the CLI mints the id itself and does not
 * print it on the passing path, and re-deriving `slugBranch(runId)` here would be a second spelling
 * of the runs-dir layout. A fixture that ran exactly one run has exactly one directory, and this
 * refuses rather than guesses if that is ever untrue.
 */
export function readRunEvents(root: string): {
  runId: string
  events: { seq: number; type: string; payload: Record<string, unknown> }[]
} {
  const runsDir = join(root, '.agent-qa', 'runs')
  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one run directory under ${runsDir}, found ${JSON.stringify(dirs)}`,
    )
  }
  const runDir = dirs[0]
  const raw = readFileSync(join(runsDir, runDir, 'events.jsonl'), 'utf8')
  const events = raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
  return { runId: runDir, events }
}

/**
 * The knowledge root a project at `root` resolves to — `knowledge.dir` defaults to
 * `agent-qa-knowledge`, relative to the config's own directory.
 *
 * Spelled once here rather than at four call sites, because the whole `handedOff` cell rests on the
 * daemon and the run addressing the SAME root: two spellings that agree today are two spellings.
 */
function knowledgeRootOf(root: string): string {
  return join(root, 'agent-qa-knowledge')
}

/** This project's queue rows, read through a composition over its own `.agent-qa`. */
async function analyzeRunRows(root: string): Promise<readonly { id: string; status: string }[]> {
  const agentQaRoot = join(root, '.agent-qa')
  // The gate-run posture never creates a queue database at all, which is a STRONGER reading of
  // "nothing was enqueued" than an empty table — so it is reported as the empty set rather than
  // made into a composition error.
  if (!existsSync(join(agentQaRoot, 'agent-jobs.db'))) return []
  const rows = await readJobRows(agentQaRoot, knowledgeRootOf(root))
  return rows.filter((row) => row.kind === 'analyze-run')
}

/** Every post-processing envelope in a run's log — the chip trail, if any. */
function chipLines(
  events: readonly { type: string }[],
): readonly string[] {
  return events
    .map((event) => event.type)
    .filter((type) => type.startsWith('analysis') || type.startsWith('curation'))
}

/**
 * The terminal sequence every cell asserts, whatever its posture: one verdict, one `runFinished`,
 * the verdict first, and `finalSeq` pointing at `runFinished`'s own seq.
 */
function terminalSequence(root: string): {
  disposition: unknown
  events: { seq: number; type: string; payload: Record<string, unknown> }[]
} {
  const { events } = readRunEvents(root)
  const finishes = events.filter(event => event.type === 'runFinished')
  const verdicts = events.filter(event => event.type === 'verdict')
  expect(finishes, 'runFinished is published exactly once per run').toHaveLength(1)
  expect(verdicts, 'verdict is published exactly once per run').toHaveLength(1)
  const finished = finishes[0]!
  expect(
    finished.payload.finalSeq,
    'finalSeq is runFinished\'s own seq (the next seq the bus stamps)',
  ).toBe(finished.seq)
  expect(
    verdicts[0]!.seq,
    'the verdict lands before the post-verdict step and therefore before runFinished',
  ).toBeLessThan(finished.seq)
  expect(
    chipLines(events.slice(0, events.indexOf(finished))),
    'no post-processing envelope may precede runFinished (LIFE-01)',
  ).toEqual([])
  return { disposition: finished.payload.disposition, events }
}

afterEach(async () => {
  await stopAllPostRunDaemons()
  cleanupTempRoots()
})

afterAll(cleanupPostRunDaemonRoots)

describePosix('runFinished.disposition on the shipped binary', () => {
  beforeAll(() => {
    const freshness = buildFreshness(ANCHORED_BUILDS)
    expect(
      { missing: freshness.missing, stale: freshness.stale },
      `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
    ).toEqual({ missing: [], stale: [] })
  })

  it('a real `agent-qa run` with no daemon holding the writer lease writes disposition: drained, after its own verdict', async () => {
    const { root } = runFixtureProject('drained')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', 'tests/probe-0.yaml'])
    expect(
      outcome.signal,
      `the run must exit on its own, not on a signal (stderr: ${outcome.stderr})`,
    ).toBeNull()

    const { disposition, events } = terminalSequence(root)
    expect(
      disposition,
      'no daemon holds the lease, so THIS process took it and will pump — the wire must say drained',
    ).toBe('drained')

    // D-05, measured: this run ended on a framework error, so the CLI's tail never ran — and the
    // row exists anyway, because the SHELL's post-verdict step queued it. Before the relocation
    // this project's `agent-jobs.db` would have been empty and the analysis lost with the process.
    const rows = await analyzeRunRows(root)
    expect(rows, 'exactly one durable hand-off, idempotent by runId').toHaveLength(1)
    expect(rows[0]!.status, 'nobody drained it: this process died above its own tail').toBe('queued')
    expect(
      chipLines(events),
      'the tail is where chips are emitted, and a framework error is above the tail',
    ).toEqual([])
  }, LEG_TIMEOUT_MS)

  it('a run whose project a REAL daemon holds the writer lease over writes disposition: handedOff',
    async () => {
      // THE CELL THAT CANNOT BE FAKED. Two processes, one lease file, one `agent-jobs.db`: the
      // daemon acquires the writer lease over this project's knowledge root and heartbeats it, and
      // the spawned `agent-qa run` — a different process, over the SAME root — probes that lease
      // and reads a live current-epoch holder. `handedOff` is D-09's promise about WHO will pump.
      const paths = makePostRunDaemonRoot('handedoff')
      const { root } = runFixtureProject('handedoff', 1, paths.root)
      expect(
        knowledgeRootOf(root),
        'the daemon and the run must address ONE knowledge root, or the lease is not the same lease',
      ).toBe(paths.knowledgeRoot)

      const daemon = startPostRunDaemon('first', paths)
      const ready = await waitForMarker(daemon, paths.readyMarker.first, 'the daemon')
      expect(existsSync(String(ready.socketPath)), 'the daemon is really up').toBe(true)

      const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', 'tests/probe-0.yaml'])
      expect(
        outcome.signal,
        `the run must exit on its own, not on a signal (stderr: ${outcome.stderr})`,
      ).toBeNull()

      const { disposition, events } = terminalSequence(root)
      expect(
        disposition,
        'a live daemon holds a current-epoch lease, so somebody else will pump — handedOff',
      ).toBe('handedOff')
      expect(
        chipLines(events),
        'a handed-off run emits no chips of its own: the holder drains, and the daemon is silent (388 D-13)',
      ).toEqual([])

      // The row is here for the daemon to find, which is the point of enqueueing before consulting.
      const rows = await analyzeRunRows(root)
      expect(rows, 'the hand-off happened even though this process will not pump').toHaveLength(1)

      // …and the daemon really took it. Polled on the row's own status rather than on a marker, so
      // this measures the DAEMON claiming this run's chain and not the fixture's bookkeeping.
      await waitUntil(
        async () => (await analyzeRunRows(root)).every((row) => row.status !== 'queued'),
        `the daemon never claimed the run's analyze-run row:\n${daemon.output()}`,
      )

      // Open the curation gate so the daemon's parked fold can finish, then stop it cleanly and
      // read its own report — the second process's account of what it drained.
      writeFileSync(paths.gate, 'open\n', 'utf8')
      const exitCode = await stopDaemonGracefully(daemon)
      expect(exitCode, 'the daemon stopped cleanly, so its report is complete').toBe(0)
      const report = JSON.parse(readFileSync(paths.report.first, 'utf8')) as {
        failed: boolean
        curationEntries: string[]
      }
      expect(report.failed, `the daemon reported a failure:\n${daemon.output()}`).toBe(false)
    }, LEG_TIMEOUT_MS)

  it('--detach writes disposition: detached AND still leaves the durable row', async () => {
    const { root } = runFixtureProject('detached')
    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'run', 'tests/probe-0.yaml', '--detach'])
    expect(
      outcome.signal,
      `the run must exit on its own, not on a signal (stderr: ${outcome.stderr})`,
    ).toBeNull()

    const { disposition, events } = terminalSequence(root)
    expect(disposition, 'the lease was skipped, so nothing is promised about draining').toBe('detached')
    // THE HALF THAT MATTERS. `--detach` asks this process not to SPEND itself on the work; it has
    // never meant "forget the work exists", and a build that treated detach as "skip the step"
    // would leave nothing for a later run or a daemon to drain (RESEARCH Pitfall 8).
    expect(await analyzeRunRows(root), 'detaching keeps the record and skips the spending').toHaveLength(1)
    expect(chipLines(events), 'nothing drained here, so nothing emitted').toEqual([])
  }, LEG_TIMEOUT_MS)

  it('a gate-run writes disposition: detached and enqueues NOTHING', async () => {
    const { root } = runFixtureProject('gaterun')
    const outcome = await spawnCollecting(
      root,
      [CLI_ENTRY, 'run', 'tests/probe-0.yaml', '--gate-run'],
    )
    expect(
      outcome.signal,
      `the run must exit on its own, not on a signal (stderr: ${outcome.stderr})`,
    ).toBeNull()

    const { disposition, events } = terminalSequence(root)
    expect(disposition, 'nothing was queued, so nothing can be drained from anywhere').toBe('detached')
    // The DIFFERENTIAL against the `drained` cell above: byte-identical fixture, byte-identical
    // invocation but for one flag, and the row that cell asserts is absent here. No strong-model
    // analysis per keep-gate iteration, no draft evidence reaching curation, no chips about a run
    // nobody opens.
    expect(await analyzeRunRows(root), 'a keep-filter probe queues nothing at all').toHaveLength(0)
    expect(
      existsSync(join(root, '.agent-qa', 'agent-jobs.db')),
      'the queue database is not even brought into existence',
    ).toBe(false)
    expect(chipLines(events)).toEqual([])
  }, LEG_TIMEOUT_MS)
})
