// THE SPAWNED-BINARY LIVE-VIEW ANCHORS (403-01 Task 5 · LIVE-02 / D-04 / D-14 — WINDOWS #264).
//
// EVERY CLAIM HERE IS ABOUT THE SHIPPED PROCESS. `live-view-tracer.test.ts` proves the frame path
// in-process with a real browser; this file proves the COMPOSITION and the CARRIAGE on the actual
// `agent-qa dashboard` binary, in the ZERO-TOKEN posture — deliberately, because that is the
// default a project gets and it is exactly the arm in which #264 hid: the session registry used to
// be built inside `composeRunServicePorts`, which runs only when a credential is declared, so a
// default dashboard streamed nothing and could mint nothing.
//
// WHAT PHASE 404 CHANGED HERE (2026-08-26 · 404-06 · LIFE-01, D-13/D-07). Cell (10) used to wait
// on the live page's terminal band on a REAL run. D-13 moves the viewer to run detail on the
// verdict, so the band is unreachable there; the cell is re-pinned to the navigation itself and to
// D-07's no-ping-pong rule, measured at the SUBSCRIBER'S OWN ordering — the one place in the
// repository where the `verdict` row write and a page's `fetchRun` race for real. The live-page
// claims it used to carry (`data-preview-state="ended"`, the two-pane count) moved to
// `live-view-dom.test.ts` cell (6), where a live page still stands at the end of a run.
//
// THE LOG-SCAN IS THE STRUCTURAL GUARANTEE (Pitfall 2). The masker is seeded once per run, so a
// token minted mid-run is not masked by that run — which means "the token never lands anywhere
// durable" cannot be an assertion about masking. It has to be a scan of the real channels: the
// child's own stdout and stderr, every byte of every file the project wrote (the SQLite database
// included), the SSE bytes, and the durable run record. With a POSITIVE CONTROL, because a scanner
// that reads nothing reports no leak.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  EditorLiveUrlResultSchema,
  RunsLiveUrlResultSchema,
  CURRENT_BUS_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION as SPAWNED_REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardUiDist,
  reserveEphemeralPort,
  runServiceFixtureProject,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'
import {
  openIdStream,
  plantEditorSubject,
  plantLiveRun,
  publishTo,
  startLiveViewHarness,
} from './live-view-fixture.js'
import type { LiveViewHarness, PlantedLiveRun } from './live-view-fixture.js'

/** What `spawnDashboard` returns: the door plus its own readiness statement. */
type ReadySpawnedDashboard = SpawnedDashboard & { readonly ready: boolean }

const REBUILD_INSTRUCTION =
  'these anchors drive the BUILT binary: run `pnpm -r build` from the agent-qa root first.'

/** How long the run has to become attachable before this file gives up and says so. */
const ATTACH_BUDGET_MS = 60_000
/** How long an SSE read or a socket exchange may take. */
const WIRE_BUDGET_MS = 30_000
/**
 * How long cell (10) holds past an observed `runFinished` (404-06 · D-07).
 *
 * The width of the `runs.start` door's DETACHED post-run tail (404-04 Task 2) — the window in
 * which a slow row write or a stale active set could have thrown the viewer back to `/live`. Read
 * the note inside cell (10) for what this fixture can and cannot reach in that window.
 */
const TAIL_WINDOW_HOLD_MS = 5_000

interface Fixture {
  readonly dashboard: ReadySpawnedDashboard
  readonly root: string
  readonly runId: string
  /** The SSE bytes cell 2 captured, re-scanned by cell 5 after the mint. */
  sseBytes: string
}

let fixture: Fixture | undefined

function held(): Fixture {
  if (fixture === undefined) throw new Error('the live-view anchors fixture never came up')
  return fixture
}

/**
 * The run's own recorded log, DISCOVERED rather than derived (404-06; `post-processing-anchors.ts`'s
 * `readRecordedEvents`, same argument). Re-deriving the runs-dir layout here would be a second
 * spelling of it; this fixture ran exactly one run, and this refuses rather than guesses if that is
 * ever untrue.
 */
function readRecordedEvents(root: string): { seq: number; type: string }[] {
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
    .map((line) => JSON.parse(line) as { seq: number; type: string })
}

/** Quote the child's own streams in every failure — a spawned cell's message is its diagnosis. */
function childContext(dashboard: SpawnedDashboard): string {
  return `child stdout: ${JSON.stringify(dashboard.stdout().slice(-1200))}; `
    + `child stderr: ${JSON.stringify(dashboard.stderr().slice(-1200))}`
}

/** Every file under `dir`, recursively, as raw bytes. The scan reads BYTES, never a re-encoding. */
function everyFileUnder(dir: string, into: { path: string; bytes: Buffer }[] = []): { path: string; bytes: Buffer }[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return into
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      everyFileUnder(full, into)
      continue
    }
    if (!info.isFile()) continue
    try {
      into.push({ path: full, bytes: readFileSync(full) })
    } catch {
      /* an unreadable file is not a hiding place this scan can be blamed for */
    }
  }
  return into
}

async function readSse(url: string, budgetMs = WIRE_BUDGET_MS): Promise<{ status: number; contentType: string | null; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const contentType = response.headers.get('content-type')
    if (response.body === null || !(contentType ?? '').includes('text/event-stream')) {
      return { status: response.status, contentType, body: await response.text().catch(() => '') }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
      if (body.includes('event: runFinished')) break
    }
    await reader.cancel().catch(() => undefined)
    return { status: response.status, contentType, body }
  } finally {
    clearTimeout(timer)
  }
}

/** One socket exchange: send a hello, collect the server's text messages, report the close code. */
async function speakToFrameSocket(input: {
  origin: string
  runId: string
  token: string
  /** Stop once one of these types has arrived (or the socket closes / the budget expires). */
  until: readonly string[]
}): Promise<{ messages: { type?: string; reason?: string; stream?: { kind?: string } }[]; closeCode?: number }> {
  const wsUrl = `${input.origin.replace(/^http/u, 'ws')}/api/live-view/ws?runId=${encodeURIComponent(input.runId)}`
  const socket = new WebSocket(wsUrl)
  const messages: { type?: string; reason?: string; stream?: { kind?: string } }[] = []
  let closeCode: number | undefined
  await new Promise<void>((settle) => {
    const budget = setTimeout(() => { try { socket.close() } catch { /* ignore */ } settle() }, WIRE_BUDGET_MS)
    const finish = (): void => { clearTimeout(budget); settle() }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', token: input.token }))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      try {
        const parsed = JSON.parse(event.data) as { type?: string }
        messages.push(parsed)
        if (typeof parsed.type === 'string' && input.until.includes(parsed.type)) {
          try { socket.close() } catch { /* ignore */ }
        }
      } catch { /* a non-JSON text frame is not a message this protocol defines */ }
    })
    socket.addEventListener('close', (event: CloseEvent) => { closeCode = event.code; finish() })
    socket.addEventListener('error', () => { finish() })
  })
  return { messages, ...(closeCode === undefined ? {} : { closeCode }) }
}

beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SPAWNED: a stale build measures the previous commit.
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
    .toEqual({ missing: [], stale: [] })

  // THE ZERO-TOKEN POSTURE, DELIBERATELY — the arm WINDOWS #264 lived in. Since 432-21 (D-12) it is
  // the only posture: no project declares a run-service credential.
  const project = runServiceFixtureProject('live-view')
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

  // The queue starts the run asynchronously, so the session is registered a moment later. Poll the
  // mint route — bounded — rather than sleeping a number somebody guessed.
  const deadline = Date.now() + ATTACH_BUDGET_MS
  let attachable = false
  while (Date.now() < deadline) {
    const probe = await fetch(`${dashboard.origin}/api/runs/${encodeURIComponent(runId as string)}/live-url`)
    if (probe.status === 200) { attachable = true; await probe.text(); break }
    await probe.text().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expect(
    attachable,
    `the spawned dashboard never made run ${String(runId)} attachable — the session registry is `
    + `composed only on the token arm if #264 has regressed. ${childContext(dashboard)}`,
  ).toBe(true)

  fixture = { dashboard, root: project.root, runId: runId as string, sseBytes: '' }
}, 180_000)

afterAll(async () => {
  const open = fixture
  fixture = undefined
  if (open !== undefined) await open.dashboard.stop()
  cleanupTempRoots()
})

describe('the shipped zero-token dashboard serves a live view', () => {
  it('(2) streams the run — NOT the 503 a dashboard with no session registry answers', async () => {
    const f = held()
    const reading = await readSse(`${f.dashboard.origin}/api/run-stream/${encodeURIComponent(f.runId)}`)
    expect(
      reading.status,
      'a zero-token dashboard used to answer 503 "This server was started without a run service '
      + `to stream from" for a run it was executing (WINDOWS #264). ${childContext(f.dashboard)}`,
    ).toBe(200)
    expect(reading.contentType).toContain('text/event-stream')
    expect(reading.body, 'the bounded reader must observe the run reach its end')
      .toContain('event: runFinished')
    f.sseBytes = reading.body
  }, 60_000)

  it('(3) mints a liveUrl declaring the HONEST none capability for a browserless run', async () => {
    const f = held()
    const response = await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`)
    const raw = await response.text()
    expect(response.status, `${raw}. ${childContext(f.dashboard)}`).toBe(200)
    const result = RunsLiveUrlResultSchema.parse(JSON.parse(raw))
    // The minted origin is the SERVER'S OWN (`http://localhost:<port>`, the command's `boundOrigin`),
    // not the address this test happens to dial. Asserting the server's spelling is the point: a
    // liveUrl is a link a person is handed, so what matters is the origin the process believes it
    // is serving on.
    expect(result.liveUrl).toBe(
      `http://localhost:${String(f.dashboard.port)}/live/${f.runId}#${result.liveUrl.split('#')[1] ?? ''}`,
    )
    expect(result.liveUrl.split('#')[1]?.startsWith('v2.')).toBe(true)
    expect(
      result.stream.kind,
      'this run had no browser, so the declaration is `none` — not an error, and not a guess',
    ).toBe('none')
    expect(result.handle).toBe(0)
  }, 60_000)

  it('(4) answers the frame socket by name: ready+ended, bad_signature, scope_mismatch', async () => {
    const f = held()
    const raw = await (await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`)).text()
    const token = RunsLiveUrlResultSchema.parse(JSON.parse(raw)).liveUrl.split('#')[1] as string

    const accepted = await speakToFrameSocket({
      origin: f.dashboard.origin, runId: f.runId, token, until: ['ended'],
    })
    const ready = accepted.messages.find((m) => m.type === 'ready')
    expect(ready, `no ready frame arrived. ${childContext(f.dashboard)}`).toBeDefined()
    expect(ready?.stream?.kind).toBe('none')
    expect(
      accepted.messages.some((m) => m.type === 'ended'),
      'the run is over, so the socket says so rather than hanging open silently',
    ).toBe(true)

    const tampered = `${token.slice(0, -4)}${token.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`
    const forged = await speakToFrameSocket({
      origin: f.dashboard.origin, runId: f.runId, token: tampered, until: ['refused'],
    })
    expect(forged.messages.find((m) => m.type === 'refused')?.reason).toBe('bad_signature')
    expect(forged.closeCode, 'a refusal closes with the live-view refusal code').toBe(4400)

    // T-403-03: a VALID token presented on ANOTHER run's socket. The claims name the run they were
    // minted for, so cross-run confusion is refused by name rather than silently attaching.
    const crossed = await speakToFrameSocket({
      origin: f.dashboard.origin, runId: 'r_some_other_run', token, until: ['refused'],
    })
    expect(crossed.messages.find((m) => m.type === 'refused')?.reason).toBe('scope_mismatch')
    expect(crossed.closeCode).toBe(4400)
  }, 90_000)

  it('(5) THE LOG-SCAN: the token is in no log, no file, no database byte and no SSE frame', async () => {
    const f = held()
    const raw = await (await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url`)).text()
    const result = RunsLiveUrlResultSchema.parse(JSON.parse(raw))
    const token = result.liveUrl.split('#')[1] as string
    const claimsPart = token.split('.')[1] as string
    expect(claimsPart.length, 'the scan needs a substantial needle to be meaningful')
      .toBeGreaterThan(20)

    // THE POSITIVE CONTROL, FIRST. A scanner that reads nothing reports no leak, so before
    // asserting an absence this cell proves it can see a presence: an invalid handle is refused by
    // name, and the refusal WORD is in the very bytes the scan will read below.
    const invalid = await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}/live-url?handle=notanumber`)
    const invalidBody = await invalid.text()
    expect(invalid.status).toBe(400)
    expect(invalidBody, 'the control: this scanner reads response bytes and can find a word in them')
      .toContain('invalid_handle')

    // Give the child a moment to flush anything it was going to write.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const runRecord = await (await fetch(`${f.dashboard.origin}/api/runs/${encodeURIComponent(f.runId)}`)).text()
    const files = everyFileUnder(f.root)
    expect(files.length, 'the file scan found nothing to read — it would report no leak either way')
      .toBeGreaterThan(0)

    const textChannels: [string, string][] = [
      ['the child stdout', f.dashboard.stdout()],
      ['the child stderr', f.dashboard.stderr()],
      ['the captured SSE frames', f.sseBytes],
      ['the durable run record', runRecord],
      ['the invalid-handle refusal body', invalidBody],
    ]
    for (const [name, channel] of textChannels) {
      expect(channel, `${name} carries the whole liveUrl token`).not.toContain(token)
      expect(channel, `${name} carries the token's claims body`).not.toContain(claimsPart)
    }
    for (const file of files) {
      const bytes = file.bytes.toString('latin1')
      expect(bytes, `${file.path} carries the whole liveUrl token`).not.toContain(token)
      expect(bytes, `${file.path} carries the token's claims body`).not.toContain(claimsPart)
    }
  }, 120_000)

  it('(6) serves the embed document itself, with a nonce CSP and no token in the body', async () => {
    const f = held()
    const response = await fetch(`${f.dashboard.origin}/live/${encodeURIComponent(f.runId)}`)
    const body = await response.text()
    expect(response.status, `${body}. ${childContext(f.dashboard)}`).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain('nonce-')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    // A `<script src=` pointing anywhere would be a second origin this document depends on, which
    // the CSP forbids and which an embedding host has no way to audit.
    expect(body, 'the embed page is self-contained').not.toContain('<script src=')
    expect(body, 'the fragment never reaches the server, so a served document cannot carry it')
      .not.toContain('v2.')
    // And it is the LIVE VIEW, not the SPA fallback wearing its URL (Pitfall 10).
    expect(body).toContain('data-embed-state')

    // THE EDITOR ARM (428 D-07). An editor session is served by the same embed page and frame
    // socket, so the same absence holds around an editor mint. Measured on the shipped composition
    // the live-view harness composes, because a real editor session in this binary would need a
    // declared model the run above must not see.
    const harness = await startLiveViewHarness({ label: 'anchors-editor' })
    const editor = plantEditorSubject(harness, { sessionId: 'ed-anchor', kind: 'cdp-screencast' })
    try {
      const mint = await fetch(`${harness.origin}/api/live-editor/sessions/ed-anchor/live-url`)
      const mintBody = await mint.text()
      expect(mint.status, 'the editor mint door answers the no-Origin caller').toBe(200)
      // THE NEEDLE'S POSITIVE CONTROL: the mint's own body is the one place the token appears.
      expect(mintBody, 'the mint hands out a v2 token').toContain('v2.')
      const token = EditorLiveUrlResultSchema.parse(JSON.parse(mintBody)).liveUrl.split('#')[1] as string

      const surroundings: [string, Response][] = [
        ['the editor embed document', await fetch(`${harness.origin}/live/ed-anchor`)],
        ['the live-editor session list', await fetch(`${harness.origin}/api/live-editor/sessions`)],
        ['the run mint door, asked for the editor id', await fetch(`${harness.origin}/api/runs/ed-anchor/live-url`)],
      ]
      for (const [name, response] of surroundings) {
        const text = await response.text()
        expect(text, `${name} (${String(response.status)}) carries a token`).not.toContain('v2.')
        expect(text, `${name} carries the editor token`).not.toContain(token)
      }
      const embed = await fetch(`${harness.origin}/live/ed-anchor`)
      const embedBody = await embed.text()
      expect(embed.status, 'the embed page is served for an editor subject').toBe(200)
      expect(embedBody, 'and it is the live view').toContain('data-embed-state')
    } finally {
      await editor.close()
      await harness.close()
    }
  }, 60_000)
})

// ---- INVK-05 ON REAL SOCKETS, AND THE SHIPPED BINARY'S OWN LIVE PAGE (403-06 Task 2) ----------
//
// WHAT THE CELLS ABOVE DO NOT MEASURE. They drive ONE reader at a time, and every claim INVK-05
// makes is about MORE THAN ONE: several surfaces attached at once, one of them walking away
// mid-run, one of them coming back with a resume point, and a run that carries on regardless. A
// single-reader fixture is structurally blind to all four — 388 paid for that lesson by name
// ("single-run fixtures cannot see a cross-instance attribution defect, and ~35 differentials
// didn't"), and the same shape applies to a single-VIEWER fixture here.
//
// THE FRAME IS THE PRODUCTION ONE. `startLiveViewHarness` composes the shipped `startServer` with
// the shipped door, the shipped registry, the shipped mint and the built UI — see
// `live-view-fixture.ts`. A bare router mounted in this file would answer every request below
// identically while proving nothing about the process a person runs.
//
// THE `cancel` SPY IS THE WHOLE OF T-403-07. Attach is not ownership: no count of viewers
// arriving, leaving or dying may reach the run. The only way to measure "nobody called it" is to
// hold the function that would have been called, which is why the session is planted.

/**
 * The words `data-terminal-state` can carry for a run that ENDED.
 *
 * SPELLED HERE RATHER THAN IMPORTED, because the attribute carries dashboard-ui's own
 * `normalizeRunStatus` output — a strictly wider vocabulary than the schema's `RunStatus`, living
 * in a `.ts` behind that package's `@/` aliases. What matters to this cell is that the page named
 * a word from a CLOSED set rather than whatever the run happened to produce, so the set is stated
 * and a word outside it is a red.
 */
const TERMINAL_RUN_WORDS = [
  'passed', 'failed', 'timeout', 'cancelled', 'flaky', 'healed', 'skipped',
] as const

describe('on real sockets: two surfaces, a mid-run resume, and a detach that owns nothing', () => {
  let harness: LiveViewHarness | undefined
  let browser: Browser | undefined
  const runs: PlantedLiveRun[] = []

  function harnessHeld(): LiveViewHarness {
    if (harness === undefined) throw new Error('the in-process live-view harness never came up')
    return harness
  }

  /** A planted run registered with the harness, remembered so `afterAll` can close its bus. */
  function plant(runId: string): PlantedLiveRun {
    const run = plantLiveRun({ runId, heartbeatMs: 60_000, capability: { kind: 'none' } })
    runs.push(run)
    harnessHeld().plant(run)
    return run
  }

  beforeAll(async () => {
    // The same freshness refusal the file's own `beforeAll` makes, restated here because this
    // describe serves the BUILT bundle through `uiDir` and a stale one would certify last week.
    expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), SPAWNED_REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    harness = await startLiveViewHarness({ label: 'invk05', uiDir: dashboardUiDist() })
    try {
      browser = await chromium.launch({ headless: true })
    } catch (error) {
      throw new Error(
        'these cells drive the BUILT dashboard UI in a real Chromium: run '
        + '`pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE SKIPPED WHEN THE '
        + `BROWSER IS ABSENT. underlying error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    browser = undefined
    await harness?.close()
    harness = undefined
    for (const run of runs) run.close()
    runs.length = 0
  })

  it('(7) two readers and a mid-run resume observe one seq set — no duplicate, no gap', async () => {
    const run = plant('r_two')
    const url = `${harnessHeld().origin}/api/run-stream/r_two`

    const a = openIdStream(url)
    publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
    publishTo(run, 'testStarted', { testId: 't0', testIndex: 0, name: 'the two-surface member', totalSteps: 3 })
    await a.waitForIdCount(2)

    // B ATTACHES WHILE A IS ALREADY WATCHING. Both are served by the same session; neither is
    // told about the other, and neither may cost the other an envelope.
    const b = openIdStream(url)
    await b.waitForIdCount(2)

    for (let i = 0; i < 30; i += 1) {
      if (i % 3 === 0) publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: i % 3, stepText: `step ${String(i)}` })
      else if (i % 3 === 1) publishTo(run, 'subActionRecorded', { testIndex: 0, stepIndex: i % 3, subActionIndex: i })
      else publishTo(run, 'heartbeat', {})
      if (i === 8) await b.waitForIdCount(8)
    }
    await b.waitForIdCount(8)

    // B WALKS AWAY MID-RUN. A real socket abort, not an unsubscribe call: what a person closing a
    // tab does to this door.
    const seenByB = b.ids()
    const lastSeenByB = Math.max(...seenByB)
    b.abort()
    await b.finished

    for (let i = 0; i < 10; i += 1) publishTo(run, 'heartbeat', {})

    // AND COMES BACK WITH A RESUME POINT. `Last-Event-ID` names the last envelope B ALREADY saw,
    // so the door opens the replay at the next one — `subscribe(N + 1)`, never `subscribe(N)`,
    // which would re-deliver an envelope B has already rendered.
    const b2 = openIdStream(url, { lastEventId: lastSeenByB })
    await b2.waitForIdCount(1)

    for (let i = 0; i < 10; i += 1) publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: i % 3, stepText: `late ${String(i)}` })
    publishTo(run, 'stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed', durationMs: 5 })
    publishTo(run, 'verdict', { verdict: 'passed' })
    const finalSeq = publishTo(run, 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: run.bus.currentSeq + 1 }).seq

    await a.waitForEvent('runFinished')
    await b2.waitForEvent('runFinished')
    await a.finished
    await b2.finished

    const everySeq = Array.from({ length: finalSeq }, (_, index) => index + 1)
    expect(a.ids(), 'the firehose reader saw the run\'s whole seq set').toEqual(everySeq)

    const bUnion = [...seenByB, ...b2.ids()]
    expect([...bUnion].sort((x, y) => x - y), 'the resumed reader\'s union IS the whole seq set')
      .toEqual(everySeq)
    expect(new Set(bUnion).size, `no envelope was delivered twice: ${JSON.stringify(bUnion)}`)
      .toBe(bUnion.length)
    expect(b2.ids()[0], 'the resume opens at lastSeen + 1 — one id later, never the same one again')
      .toBe(lastSeenByB + 1)
    expect(Math.min(...b2.ids()), 'and nothing at or below the resume point is re-sent')
      .toBeGreaterThan(lastSeenByB)

    expect(a.endedByServer(), 'the door closed A on its own terms at runFinished').toBe(true)
    expect(b2.endedByServer(), 'and closed the resumed reader the same way').toBe(true)
    expect(run.cancelCalls(), 'T-403-07: no reader, arriving or leaving, ever ended the run').toBe(0)

    // AND THE PRECEDENCE, ON THE SAME RETAINED RUN. A client can name a resume point twice — the
    // `Last-Event-ID` header a browser sends for free, and the `?lastEventId=` a page composes on
    // its first attach — and the two can DISAGREE. The door resolves that with one rule (the
    // header wins) and this is where it is measured on a socket rather than in a unit: a query
    // that won here would replay from near the beginning and hand this viewer fifty envelopes it
    // had already rendered.
    const contested = openIdStream(`${url}?lastEventId=1`, { lastEventId: finalSeq - 3 })
    await contested.waitForEvent('runFinished')
    await contested.finished
    expect(contested.ids()[0], 'the Last-Event-ID header wins over the ?lastEventId= query')
      .toBe(finalSeq - 2)
    expect(contested.ids(), 'so the query\'s own resume point is NOT what was served')
      .not.toContain(2)
  }, 120_000)

  it('(8) a detach owns nothing — the run keeps going and a later viewer sees all of it', async () => {
    const run = plant('r_three')
    const url = `${harnessHeld().origin}/api/run-stream/r_three`

    const early = openIdStream(url)
    publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
    publishTo(run, 'testStarted', { testId: 't0', testIndex: 0, name: 'the abandoned member', totalSteps: 2 })
    publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'a step nobody is watching' })
    await early.waitForIdCount(3)
    early.abort()
    await early.finished

    // THE RUN CARRIES ON, and the only proof of that is envelopes published after the last viewer
    // left, delivered to somebody who was not there when they happened.
    const afterDetach: number[] = []
    for (let i = 0; i < 5; i += 1) {
      afterDetach.push(publishTo(run, 'subActionRecorded', { testIndex: 0, stepIndex: 0, subActionIndex: i }).seq)
    }
    expect(run.cancelCalls(), 'the last detach did not cancel the run').toBe(0)
    expect(run.isDone(), 'and it did not settle it either — a detach is not a verdict').toBe(false)

    const late = openIdStream(url)
    await late.waitForIdCount(3 + afterDetach.length)
    for (const seq of afterDetach) {
      expect(late.ids(), `seq ${String(seq)} was published after every viewer left and is still served`)
        .toContain(seq)
    }

    publishTo(run, 'verdict', { verdict: 'passed' })
    publishTo(run, 'runFinished', { aggregateVerdict: 'passed', disposition: 'detached', finalSeq: run.bus.currentSeq + 1 })
    await late.waitForEvent('runFinished')
    await late.finished

    expect(late.endedByServer()).toBe(true)
    expect(run.cancelCalls(), 'and nothing in this cell ever reached the run').toBe(0)
    expect(run.isDone(), 'the session settles when the RUN says so, never when a socket does').toBe(false)
    run.finish('passed')
  }, 120_000)

  it('(9) concurrency: two surfaces attached at once render the same row states', async () => {
    const run = plant('r_pair')
    const held = browser
    if (held === undefined) throw new Error('no browser')
    const pageA = await held.newPage()
    const pageB = await held.newPage()
    try {
      publishTo(run, 'runStarted', { busSchemaVersion: CURRENT_BUS_SCHEMA_VERSION, memberTestCount: 1, handles: [0] })
      // RE-SPELLED 2026-09-26 (428-30, owner decision 2026-09-26 (2), G-428-2). A row with no text
      // is no longer drawn, so this testStarted carries its step texts and the pending rows both
      // surfaces wait for and count are still drawn.
      publishTo(run, 'testStarted', {
        testId: 't0',
        testIndex: 0,
        name: 'the shared member',
        totalSteps: 3,
        stepTexts: ['the first step', 'the running step', 'the last step'],
      })

      // BOTH ATTACHED BEFORE THE INTERESTING ENVELOPES, so this is a concurrency claim and not two
      // replays of a finished run taken one after the other.
      const url = `${harnessHeld().origin}/runs/r_pair/live`
      await Promise.all([pageA.goto(url), pageB.goto(url)])
      await Promise.all([
        pageA.locator('[data-step-status]').first().waitFor({ state: 'attached', timeout: 30_000 }),
        pageB.locator('[data-step-status]').first().waitFor({ state: 'attached', timeout: 30_000 }),
      ])

      publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: 0, stepText: 'the first step' })
      publishTo(run, 'stepFinalized', { testIndex: 0, stepIndex: 0, status: 'passed', durationMs: 10 })
      publishTo(run, 'stepStarted', { testIndex: 0, stepIndex: 1, stepText: 'the running step' })
      publishTo(run, 'subActionRecorded', { testIndex: 0, stepIndex: 1, subActionIndex: 0 })

      const expected = ['passed', 'running', 'pending']
      const statusesOf = async (page: Page): Promise<string[]> =>
        page.locator('[data-step-status]').evaluateAll(
          (nodes) => nodes.map((node) => node.getAttribute('data-step-status') ?? ''),
        )
      for (const page of [pageA, pageB]) {
        const deadline = Date.now() + 30_000
        for (;;) {
          const seen = await statusesOf(page)
          if (JSON.stringify(seen) === JSON.stringify(expected)) break
          if (Date.now() > deadline) {
            throw new Error(`a surface never reached ${JSON.stringify(expected)}; it shows ${JSON.stringify(seen)}`)
          }
          await page.waitForTimeout(100)
        }
      }
      const [seenA, seenB] = await Promise.all([statusesOf(pageA), statusesOf(pageB)])
      expect(seenA, 'the row states the reducer implies from this seq set').toEqual(expected)
      expect(seenB, 'and the SECOND surface reads the same run identically').toEqual(seenA)
      expect(run.cancelCalls(), 'two viewers are still not an owner').toBe(0)
    } finally {
      await pageA.close()
      await pageB.close()
    }
  }, 150_000)

  // RE-PINNED 2026-08-26 (404-06 · LIFE-01, D-13/D-07). This cell was "(10) THE SHIPPED BINARY: a
  // real run's live page reaches its honest terminal state", and it waited on `data-terminal-state`
  // — the live page's terminal band — on a REAL run. D-13 inverts that path: the verdict now moves
  // the viewer to run detail, so the band is unreachable here and the wait would hang for its whole
  // budget. The cell keeps its ONE real run, the whole production chain and nothing planted, and
  // re-pins to the claim D-13 and D-07 actually make on it.
  //
  // WHAT MOVED OUT. The `data-preview-state="ended"` wait and the two-pane count are LIVE-PAGE
  // claims about a run that ended; with the page gone by then they went to `live-view-dom.test.ts`
  // cell (6) — the planted `runFinished`-with-no-verdict path, where the live page really does stay
  // and where the ending is an instant the cell decides rather than one it waits out.
  //
  // WHAT THIS MEASURES THAT NOTHING ELSE DOES. `live-view-dom.test.ts` cell (9) drives a PLANTED
  // session whose row this test writes: the ordering between the `verdict` envelope and the durable
  // row is a seam the cell owns. Here neither is: the run is the spawned binary's own, the row is
  // written by the dashboard's own reporter subscriber at its own `verdict`, and the page's own
  // `fetchRun` races that write for real. If D-07's no-ping-pong rule is going to fail at the
  // subscriber's real ordering, this is the cell it fails in.
  it('(10) THE SHIPPED BINARY: a real run\'s verdict moves the viewer to run detail, and never back to /live', async () => {
    const f = held()
    const heldBrowser = browser
    if (heldBrowser === undefined) throw new Error('no browser')
    const page = await heldBrowser.newPage()
    const attaches: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/run-stream/')) attaches.push(request.url())
    })
    // EVERY MAIN-FRAME NAVIGATION, IN ORDER. A single end-state reading cannot tell "went to run
    // detail and stayed" from "went, bounced to /live, and was sent back" — the ping-pong D-07
    // forbids settles in exactly one tick, so the ONLY instrument that can see it is the list.
    const navigations: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url())
    })
    try {
      // THE WHOLE PRODUCTION CHAIN, and nothing planted anywhere in it: the built `agent-qa
      // dashboard` binary, its own queue, its own run, its own bus, its own `uiDir`, driven by a
      // real browser. The run fails fast (its target has no browser), which is the point — the
      // claim is about the honest END of a real run, not about a passing one.
      await page.goto(`${f.dashboard.origin}/runs/${encodeURIComponent(f.runId)}/live`)

      // THE VERDICT ARRIVES BY REPLAY, AND THAT IS A MEASUREMENT, NOT A COMPROMISE. Earlier cells
      // in this file read the run's SSE to completion, so by now the run has ended and the door
      // replays `events.jsonl` to this viewer. The planner's explicit assumption is that a viewer
      // attached AFTER the verdict navigates once, because the replay delivers the verdict envelope
      // like any other — this is that assumption, on the shipped binary. A viewer attached BEFORE
      // it is `live-view-dom.test.ts` cell (9).
      await page.waitForURL(/\/runs\/[^/]+$/u, { timeout: 60_000 })
      expect(
        page.url().endsWith(`/runs/${f.runId}`),
        `landed on ${page.url()}; navigations ${JSON.stringify(navigations)}. ${childContext(f.dashboard)}`,
      ).toBe(true)

      // THE BADGE FOLLOWS THE ROW, WITHIN THE CATCH-UP. The subscriber writes the row's status at
      // the SAME `verdict` envelope this page navigated on, and the page's own `fetchRun` may win
      // that race — D-07's bounded re-fetch is what turns "the row is a moment behind" into "the
      // header says the verdict word a moment later" instead of "the viewer is back on /live".
      const badge = page.locator('[data-verdict-badge]')
      await badge.waitFor({ state: 'attached', timeout: 3_000 })
      const verdictWord = await badge.getAttribute('data-verdict-badge')
      expect(
        TERMINAL_RUN_WORDS as readonly string[],
        `the header named a verdict this build has no terminal word for: ${String(verdictWord)}. `
        + childContext(f.dashboard),
      ).toContain(verdictWord)

      // AND NOW THE WINDOW AFTER THE END. The test opens its OWN reader on the same run so the hold
      // below starts from an observed `runFinished` rather than from a number somebody guessed, and
      // then holds a further 5 s — the width of the `runs.start` door's detached post-run tail
      // (404-04 Task 2). See the note under the assertions for what this fixture can and cannot
      // reach there.
      const reader = openIdStream(`${f.dashboard.origin}/api/run-stream/${encodeURIComponent(f.runId)}`)
      await reader.waitForEvent('runFinished', WIRE_BUDGET_MS)
      reader.abort()
      await page.waitForTimeout(TAIL_WINDOW_HOLD_MS)

      // D-07, AS ONE READING OF THE WHOLE LIST, AND THE INSTRUMENT IS THE ORDER RATHER THAN THE
      // COUNT. Measured: the initial `/live` entry appears TWICE, because `createBrowserRouter`
      // normalises the URL on hydration with a same-document replace to the same address — both
      // entries land before the arrival and neither is a bounce. A count-of-`/live` assertion
      // would therefore have been red on a page doing nothing wrong, and would have said nothing
      // about the failure it was aimed at. A PING-PONG IS AN ORDERING: `/runs/:id`, then `/live`
      // again, then `/runs/:id` again. So every entry after the first run-detail arrival must be
      // the run-detail URL, and the arrival must have been reached from a live page at all.
      const firstDetail = navigations.findIndex((url) => /\/runs\/[^/]+$/u.test(url))
      expect(
        firstDetail,
        `no run-detail entry at all: ${JSON.stringify(navigations)}. ${childContext(f.dashboard)}`,
      ).toBeGreaterThan(0)
      expect(
        navigations.slice(0, firstDetail).every((url) => url.includes('/live')),
        `the control: this viewer really was on the live surface before the verdict — `
        + JSON.stringify(navigations),
      ).toBe(true)
      expect(
        navigations.slice(firstDetail + 1).filter((url) => url.includes('/live')),
        'D-07: nothing after the arrival may be a live URL — not at the verdict race, where the '
        + `subscriber's row write and this page's fetchRun collide for real, and not during the `
        + `tail window. navigations ${JSON.stringify(navigations)}. ${childContext(f.dashboard)}`,
      ).toEqual([])
      expect(page.url().endsWith(`/runs/${f.runId}`), `ended on ${page.url()}`).toBe(true)

      // WHAT THIS FIXTURE CANNOT REACH, STATED RATHER THAN IMPLIED (WINDOWS #281, 404-05 D-6 /
      // 404-04 D-6). `spawnDashboard` runs the child under `hermeticEnv`, which points `HOME` into
      // the temp project, so the member resolves no Playwright browser and raises a FRAMEWORK
      // error — and `in-process-run-execution.ts` re-throws that ABOVE the line that starts the
      // detached post-run tail. The tail therefore never runs here, and the 5 s hold above is a
      // window in which no chain is draining. Everything asserted above IS measured: the verdict
      // arrives, the page moves, the row catches up, and nothing re-enters /live through
      // `runFinished` and five further seconds. The tail-window half is not.
      //
      // THIS ASSERTION IS THE TRIPWIRE. The day this fixture can reach a real verdict — a
      // browserless member, an installed browser in the child, any harness change that makes the
      // tail run — a chip envelope lands in this run's own log and this cell REDS, which is the
      // signal to promote the hold above from a hold into a genuine tail-window measurement.
      const recorded = readRecordedEvents(f.root)
      const afterFinished = recorded
        .slice(recorded.findIndex((event) => event.type === 'runFinished') + 1)
        .map((event) => event.type)
      expect(
        afterFinished,
        'WINDOWS #281 no longer holds: this run\'s log carries post-`runFinished` envelopes, so the '
        + 'detached tail DID run. Re-pin the 5 s hold above as a real tail-window measurement — it '
        + 'has been a vacuous window until now and this cell said so.',
      ).toEqual([])

      // HNST-01 ON THE SHIPPED CHAIN, NOW READ OFF THE RUN-DETAIL DOCUMENT. `plannedAction` is a
      // FIELD NAME the bus really carries, so its absence from the served document is a claim about
      // this page and not about a payload shape nothing produces.
      const html = await page.evaluate(() => document.documentElement.outerHTML)
      expect(html.length, 'the positive control — a document was actually read').toBeGreaterThan(500)
      expect(html, 'no provisional payload field is reachable on the shipped surface')
        .not.toContain('plannedAction')

      // NO RECONNECT LOOP behind the arrival. Run detail does not stream, so a growing attach count
      // here would be a live page this viewer keeps being returned to.
      const settled = attaches.length
      await page.waitForTimeout(5_000)
      expect(attaches.length, `attaches: ${JSON.stringify(attaches)}`).toBe(settled)
    } finally {
      await page.close()
    }
  }, 180_000)
})
