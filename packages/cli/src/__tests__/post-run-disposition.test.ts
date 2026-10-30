// Spawned: each posture's `runFinished.disposition` and queued rows are read from `events.jsonl`.

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

// The minimum a run accepts: an unreachable local target, one member and the required files.
export function runFixtureProject(label: string, memberCount = 1, into?: string): {
  root: string
  configPath: string
} {
  // `into` writes the project into a root somebody else owns — the daemon fixture's, so a real
  // `agent-qa daemon` and a real `agent-qa run` address ONE `.agent-qa` and ONE knowledge root.
  // Its cleanup is that owner's; only a minted root is tracked here.
  const root = into ?? trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-${label}-`)))
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
    'no post-processing envelope may precede runFinished',
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

    // The run ends on a framework error so the tail never runs, yet the shell's step queues it.
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
      // A daemon and the run share one lease file and `agent-jobs.db`; the run reads a live holder.
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
        'a handed-off run emits no chips of its own: the holder drains, and the daemon is silent',
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
    // Detaching skips spending this process on the work, never the record of it.
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
