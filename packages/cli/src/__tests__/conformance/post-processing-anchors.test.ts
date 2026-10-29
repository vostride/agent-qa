// LIFE-02's FOURTH POSTURE, ON THE SHIPPED BINARY: a run the DASHBOARD started (Phase 404 plan 05,
// D-06/D-07/D-12 · LIFE-02).
//
// WHY THIS CELL EXISTS AT ALL. `post-run-disposition.test.ts` measures three postures through the
// spawned `agent-qa run` binary, and D-12's argument for spawning it is that a unit-level mapping
// test is blind to a DOOR THAT NEVER CALLS THE POST-VERDICT STEP. The dashboard is a fourth door
// and it is the one that had no cell: it reaches `runs.start` through the injected backend, in a
// long-lived server process, with a queue between the click and the run. Everything the other three
// cells prove about the shell says nothing about whether THIS door's leg runs — which is exactly
// the class of defect the whole plan is built around.
//
// THREE FACTS, THREE DIFFERENT WITNESSES, DELIBERATELY:
//
//   1. The LOCAL RUN-STREAM DOOR's `runFinished` frame says `disposition: 'drained'`. That is the
//      WIRE — what a browser watching the run was told at the moment the run ended.
//   2. The run's own `events.jsonl` under the fixture's `.agent-qa/runs/` says the same. That is the
//      RECORD, written by the shell, and it is the one a later process reads.
//   3. `GET /api/runs/:id/post-processing` reaches two TERMINAL chips. That is the WORK — whether
//      the chain the disposition promised actually got pumped.
//
// A cell that read only the wire could not tell a decision from a report of one; a cell that read
// only the record could not tell whether a browser was ever told; and neither could tell whether
// anything was drained. D-07 is the fourth: the run leaves `/api/execution/active` at `runFinished`
// and does NOT sit there for the length of its post-processing tail, which is what "the tail is
// detached" means from the outside.
//
// WHAT THIS FILE DOES NOT ASSERT, AND WHY SAYING SO IS BETTER THAN A VACUOUS ASSERTION.
//
// It does NOT reach a TERMINAL chain, and it cannot. `hermeticEnv` points `HOME` into the temp
// project, so the spawned child resolves no Playwright browser and the single member raises
// `agent-qa browser support is not installed for Chromium` — a FRAMEWORK error, which
// `in-process-run-execution.ts` re-throws at `takeFrameworkError()`, four statements ABOVE the
// line that starts the detached `postRunTail`. So on this harness the tail never runs, for the
// dashboard door exactly as `post-run-disposition.test.ts`'s header records it for the CLI's
// The plan for this cell assumed a chain that pumps; the harness cannot produce one
// without installing a browser into the child, which would make every claim below contingent on
// Chromium being present — the measurement `live-view-anchors.test.ts` refuses by name.
//
// The three claims that fall out of that are covered where they CAN be measured honestly:
//
//   - the read route on a TERMINAL chain, and its 204 —  `routes.post-processing.test.ts` and
//     `routes.post-processing-stream.test.ts`, at the production `startServer` frame;
//   - the chip trail an in-process drain leaves — `post-run-chip-events.test.ts`, against a real
//     store, a real handoff and the real handler bodies;
//   - the dashboard door's drain leg emitting that trail — `dashboard-cancel-isolation.e2e.test.ts`
//     in-process, over a run that reaches a real verdict.
//
// What is left HERE is everything only the shipped binary can say: the posture on both doors, the
// active-set timing, the read route answering by name through the composed host, the live channel
// opening through a relay this command threaded in two places, and the queue database on disk.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  buildFreshness,
  cleanupTempRoots,
  reserveEphemeralPort,
  runServiceFixtureProject,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

const REBUILD_INSTRUCTION =
  'these anchors drive the BUILT binary: run `pnpm -r build` from the agent-qa root first.'

/** How long the run has to reach `runFinished` on the local door. */
const RUN_BUDGET_MS = 90_000
/** D-07's bound: the run must leave the active set within this of its `runFinished` frame. */
const ACTIVE_SET_BUDGET_MS = 5_000

type ReadySpawnedDashboard = SpawnedDashboard & { readonly ready: boolean }

interface PostProcessingBody {
  status: {
    runId: string
    chips: { analysis: string; curation: string }
    notification?: { runId: string; outcome: string }
  }
  disposition?: string
  failures?: {
    analysis?: { error?: string; willRetry?: boolean }
    curation?: { error?: string; willRetry?: boolean }
  }
}

interface Fixture {
  readonly dashboard: ReadySpawnedDashboard
  readonly root: string
  readonly runId: string
  /** The parsed `runFinished` payload the LOCAL run-stream door served. */
  readonly wireRunFinished: Record<string, unknown>
  /** Seconds from the `runFinished` frame to `/api/execution/active` no longer listing the run. */
  readonly secondsToLeaveActiveSet: number
  /** What the read route said at the moment the run ended — the tail's own state, quoted. */
  readonly chainAtRunFinished?: PostProcessingBody
}

let fixture: Fixture | undefined

function held(): Fixture {
  if (fixture === undefined) throw new Error('the post-processing anchors fixture never came up')
  return fixture
}

/** Quote the child's own streams in every failure — a spawned cell's message is its diagnosis. */
function childContext(dashboard: SpawnedDashboard): string {
  return `child stdout: ${JSON.stringify(dashboard.stdout().slice(-1500))}; `
    + `child stderr: ${JSON.stringify(dashboard.stderr().slice(-1500))}`
}

/**
 * Read the local run-stream door until `runFinished` arrives, and hand back that frame's payload.
 *
 * NEVER A SLEEP. The frame is the event this whole file times from, so it is READ rather than
 * waited past — and the budget is stated so a run that never finishes fails with a sentence rather
 * than by hanging out the suite timeout.
 */
async function readUntilRunFinished(
  url: string,
  budgetMs: number,
): Promise<{ status: number; body: string; runFinished?: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const contentType = response.headers.get('content-type')
    if (response.body === null || !(contentType ?? '').includes('text/event-stream')) {
      return { status: response.status, body: await response.text().catch(() => '') }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      body += decoder.decode(chunk.value, { stream: true })
      if (body.includes('event: runFinished')) break
    }
    await reader.cancel().catch(() => undefined)
    const frame = /^event: runFinished\ndata: (.+)$/mu.exec(body)?.[1]
    return {
      status: response.status,
      body,
      ...(frame === undefined
        ? {}
        : { runFinished: (JSON.parse(frame) as { payload: Record<string, unknown> }).payload }),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  what: string,
  budgetMs: number,
): Promise<number> {
  const started = Date.now()
  const deadline = started + budgetMs
  for (;;) {
    if (await predicate()) return Date.now() - started
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${String(budgetMs)}ms waiting for ${what}`)
    }
    await new Promise<void>((tick) => { setTimeout(tick, 200) })
  }
}

async function readPostProcessing(origin: string, runId: string): Promise<{
  status: number
  raw: string
  body?: PostProcessingBody
}> {
  const response = await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/post-processing`)
  const raw = await response.text()
  try {
    return { status: response.status, raw, body: JSON.parse(raw) as PostProcessingBody }
  } catch {
    return { status: response.status, raw }
  }
}

/**
 * The run's own recorded log, DISCOVERED rather than derived.
 *
 * `readRunEvents`'s own argument (`post-run-disposition.test.ts`): re-deriving `slugBranch(runId)`
 * here would be a second spelling of the runs-dir layout. A fixture that ran exactly one run has
 * exactly one directory, and this refuses rather than guesses if that is ever untrue.
 */
function readRecordedEvents(root: string): { seq: number; type: string; payload: Record<string, unknown> }[] {
  const runsDir = join(root, '.agent-qa', 'runs')
  const dirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one run directory under ${runsDir}, found ${JSON.stringify(dirs)}`)
  }
  return readFileSync(join(runsDir, dirs[0]!, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
}

beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SPAWNED: a stale build measures the previous commit.
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
    .toEqual({ missing: [], stale: [] })

  // THE ZERO-TOKEN POSTURE, on `live-view-anchors.test.ts`'s own argument: it is the default a
  // project gets, and it is the arm in which a composition that only runs on the credentialed
  // branch hides.
  const project = runServiceFixtureProject('post-processing')
  const port = await reserveEphemeralPort()
  const dashboard = await spawnDashboard(project.root, project.configPath, port)
  expect(
    dashboard.ready,
    `the built \`agent-qa dashboard\` never reported that it was listening. ${childContext(dashboard)}`,
  ).toBe(true)

  const trigger = await fetch(`${dashboard.origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'tests/probe.test.yaml' }),
  })
  const triggerBody = await trigger.text()
  expect(trigger.status, `the trigger route refused: ${triggerBody}. ${childContext(dashboard)}`)
    .toBe(202)
  const runId = (JSON.parse(triggerBody) as { runId?: string }).runId
  expect(typeof runId, `the trigger ack named no run: ${triggerBody}`).toBe('string')

  // THE QUEUE STARTS THE RUN ASYNCHRONOUSLY, so the session is registered a moment after the ack —
  // the local door answers `404 unknown_run` until it is. Polled rather than slept past, on
  // `live-view-anchors.test.ts`'s own argument, and re-ATTACHED rather than probed with a second
  // route: the session registry keeps a finished run attachable for its retention window, so a
  // replay that opens late still carries the whole log including `runFinished`.
  const streamUrl = `${dashboard.origin}/api/run-stream/${encodeURIComponent(runId as string)}`
  const attachDeadline = Date.now() + RUN_BUDGET_MS
  let reading = await readUntilRunFinished(streamUrl, RUN_BUDGET_MS)
  while (reading.runFinished === undefined && Date.now() < attachDeadline) {
    await new Promise<void>((tick) => { setTimeout(tick, 250) })
    reading = await readUntilRunFinished(streamUrl, RUN_BUDGET_MS)
  }
  expect(
    reading.runFinished,
    `the local door never served a runFinished frame for ${String(runId)}. `
    + `body: ${JSON.stringify(reading.body.slice(-800))}. ${childContext(dashboard)}`,
  ).toBeDefined()

  // READ THE INSTANT THE RUN ENDED, before the active-set poll below can let time pass. This is
  // what makes D-07's cell a real measurement rather than a vacuous one: it records whether the
  // chain was STILL IN FLIGHT at the moment the run stopped being called active.
  const chainAtRunFinished = (await readPostProcessing(dashboard.origin, runId as string)).body

  // D-07, TIMED FROM THE FRAME. The clock starts the instant the wire said the run ended, so the
  // number this records is exactly "how long after the run ended was it still called active".
  const secondsToLeaveActiveSet = await waitUntil(
    async () => {
      const response = await fetch(`${dashboard.origin}/api/execution/active`)
      const body = await response.json() as { executions?: { runId?: string }[] }
      return !(body.executions ?? []).some((row) => row.runId === runId)
    },
    `run ${String(runId)} to leave /api/execution/active`,
    ACTIVE_SET_BUDGET_MS,
  ).then((ms) => ms / 1000)

  fixture = {
    dashboard,
    root: project.root,
    runId: runId as string,
    wireRunFinished: reading.runFinished!,
    secondsToLeaveActiveSet,
    ...(chainAtRunFinished === undefined ? {} : { chainAtRunFinished }),
  }
}, 240_000)

afterAll(async () => {
  const open = fixture
  fixture = undefined
  if (open !== undefined) await open.dashboard.stop()
  cleanupTempRoots()
})

describePosix('a run the DASHBOARD started is drained BY the dashboard', () => {
  it("says disposition: 'drained' on BOTH doors — the wire and the durable record", () => {
    const f = held()

    // 1. THE WIRE. What the browser watching this run was told at the moment it ended.
    expect(
      f.wireRunFinished.disposition,
      'a dashboard-started run has no daemon holding the writer lease, so this process took it. '
      + `frame: ${JSON.stringify(f.wireRunFinished)}. ${childContext(f.dashboard)}`,
    ).toBe('drained')

    // 2. THE RECORD. What a later process reads off this run's permanent log. The two are written
    // by one publish, and a cell that read only one of them could not tell a decision from a report.
    const recorded = readRecordedEvents(f.root)
    const runFinished = recorded.find((event) => event.type === 'runFinished')
    expect(runFinished, `no runFinished line in the recorded log. ${childContext(f.dashboard)}`)
      .toBeDefined()
    expect(runFinished!.payload.disposition).toBe('drained')
    expect(
      runFinished!.payload,
      'and the record is the frame, field for field — one publish, two readers',
    ).toEqual(f.wireRunFinished)
  })

  it('leaves /api/execution/active within seconds of runFinished, not after its tail', () => {
    const f = held()
    // The claim is that the post-processing leg is DETACHED: `execute()` resolves at the verdict and
    // the tail runs behind it. If the drive awaited the tail, this run would still be "running"
    // while its chain pumped — which is the state the dashboard's own list would have shown.
    expect(
      f.secondsToLeaveActiveSet,
      `the run was still listed as active ${String(f.secondsToLeaveActiveSet)}s after runFinished. `
      + `${childContext(f.dashboard)}`,
    ).toBeLessThan(ACTIVE_SET_BUDGET_MS / 1000)
    // AND THE CHAIN WAS STILL OWED AT THAT INSTANT, which is what makes the reading above
    // non-vacuous. "Left the active set quickly" alone is satisfied by a door that never listed the
    // run at all; "left it while its post-processing chain was unfinished" is the actual D-07
    // claim, and it is the one a drive that AWAITED the tail would fail.
    expect(
      f.chainAtRunFinished?.status.chips,
      `the chain had already settled by the time the run left the active set, so this reading says `
      + `nothing about the tail: ${JSON.stringify(f.chainAtRunFinished)}`,
    ).toEqual({ analysis: 'pending', curation: 'pending' })
  })

  it('serves chip truth by name on the new read route, with the run posture beside it', async () => {
    const f = held()
    const answer = await readPostProcessing(f.dashboard.origin, f.runId)
    expect(answer.status, `${answer.raw}. ${childContext(f.dashboard)}`).toBe(200)
    expect(
      Object.keys(answer.body!.status.chips).sort(),
      'exactly two chips — the 404 D-01 narrowing, on the wire the browser actually reads',
    ).toEqual(['analysis', 'curation'])
    expect(answer.body!.status.runId).toBe(f.runId)
    expect(
      answer.body!.disposition,
      'the posture the route read off this run\'s own runFinished line',
    ).toBe('drained')
  }, 60_000)

  it('serves the QUEUED chain honestly while the tail is still owed', async () => {
    const f = held()

    // THE DURABLE ROW EXISTS. This is D-05's half and it is the whole reason the enqueue moved into
    // the post-verdict step: the tail never ran for this run (see the header), and before the
    // relocation that meant the chain was lost with the process. The queue database being on disk
    // is the structural proof that the work was handed off between `verdict` and `runFinished`.
    expect(
      readdirSync(join(f.root, '.agent-qa')),
      `no agent-jobs.db under the fixture root — the post-verdict step queued nothing. `
      + `${childContext(f.dashboard)}`,
    ).toContain('agent-jobs.db')

    // THE RECORD HOLDS NO CHIP LINE, and that is not an accident of timing — it is the header's
    // structural fact, asserted so a future harness that DOES reach the tail reds this cell rather
    // than silently changing what the cells below mean.
    const recordedTypes = new Set(readRecordedEvents(f.root).map((event) => event.type))
    for (const chip of ['analysisStarted', 'analysisCompleted', 'analysisFailed', 'curationStarted', 'curationCompleted', 'curationFailed']) {
      expect(
        recordedTypes.has(chip),
        `the hermetic child resolved no browser, so the drive re-raised a framework error above `
        + `the tail and no chip was ever emitted — a ${chip} line here means the harness changed `
        + `and the terminal cells this file gave up can be written`,
      ).toBe(false)
    }

    const answer = await readPostProcessing(f.dashboard.origin, f.runId)
    expect(answer.status, `${answer.raw}. ${childContext(f.dashboard)}`).toBe(200)
    expect(
      answer.body!.status.chips,
      'the durable rows are queued and unclaimed, so both chips are pending — a state, not a failure',
    ).toEqual({ analysis: 'pending', curation: 'pending' })
    expect(
      answer.body!.failures,
      'PRESENT and EMPTY: the record was read (a refusal would have removed the key entirely) and '
      + 'it holds no failure line, so the route composes none (D-21 as narrowed in 404-03)',
    ).toEqual({})
    expect(answer.body!.status.notification, 'no chain-terminal row, because no chain ran')
      .toBeUndefined()
  }, 60_000)

  it('opens the live channel with a snapshot for a chain still in flight', async () => {
    const f = held()
    // THE COMPOSITION IS WHAT THIS MEASURES. The relay is created in `agent-qa dashboard`, handed
    // to the run door's bridge as the emitter's second sink AND to `startServer` as the stream
    // door's registry — two threadings of one object, in a file no unit cell mounts. A stream that
    // answered 503 `post_processing_relay_unavailable` here would mean the shipped command wired
    // one half and not the other, which is exactly the shape of WINDOWS #264 one seam over.
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, 20_000)
    try {
      const response = await fetch(
        `${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/post-processing/stream`,
        { signal: abort.signal },
      )
      expect(
        response.status,
        `the shipped dashboard refused its own post-processing stream. ${childContext(f.dashboard)}`,
      ).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
      }
      await reader.cancel().catch(() => undefined)

      const frame = buffered.slice(0, buffered.indexOf('\n\n') + 2)
      expect(
        /^event: snapshot$/mu.test(frame),
        `the stream opened with something other than a snapshot: ${JSON.stringify(frame)}`,
      ).toBe(true)
      const snapshot = JSON.parse(/^data: (.+)$/mu.exec(frame)![1]!) as PostProcessingBody
      const polled = await readPostProcessing(f.dashboard.origin, f.runId)
      expect(
        snapshot,
        'the snapshot IS the read route body — one joined read behind two doors, not two spellings',
      ).toEqual(polled.body)
      expect(snapshot.disposition, 'and it carries the run posture the page needs to decide').toBe('drained')
    } finally {
      clearTimeout(timer)
      abort.abort()
    }
  }, 60_000)

  it('CONTROL: an unknown run is an honest all-pending chain, never an error', async () => {
    const f = held()
    const answer = await readPostProcessing(f.dashboard.origin, 'r_this_dashboard_never_ran_me')
    expect(answer.status, `${answer.raw}. ${childContext(f.dashboard)}`).toBe(200)
    expect(
      answer.body!.status.chips,
      'the op\'s own law: nothing queued is two pending chips, which is a state and not a failure',
    ).toEqual({ analysis: 'pending', curation: 'pending' })
    expect(
      answer.body!.disposition,
      'and no posture, because no run ever wrote a runFinished line for that id',
    ).toBeUndefined()
  }, 60_000)
})
