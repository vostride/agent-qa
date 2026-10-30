/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` / `page.addInitScript`
// callbacks are compiled as TypeScript and EXECUTED in a browser — `dashboard-dom.test.ts`'s
// reasoning, unchanged.

// A red run is produced by occupying the analysis artifact's path, so its rename fails with EISDIR.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { RUNS_POST_PROCESSING_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { acquireWriterLease, releaseLease } from '@vostride/agent-qa-knowledge-local'
import { slugBranch } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  DASHBOARD_ANCHORED_BUILDS,
  DRAINABLE_SUITE_PATH,
  PACKAGES_ROOT,
  buildFreshness,
  cleanupTempRoots,
  drainableSuiteFixtureProject,
  reserveEphemeralPort,
  spawnCollecting,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'
import {
  startPostRunDaemon,
  stopAllPostRunDaemons,
  stopDaemonGracefully,
  waitForMarker,
} from '../post-run-daemon/spawn-helpers.js'
import type { PostRunDaemonPaths, RunningDaemon } from '../post-run-daemon/spawn-helpers.js'

const describePosix = process.platform === 'win32' ? describe.skip : describe

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT dashboard UI served by the BUILT `agent-qa dashboard`: run '
  + '`pnpm turbo run build --force` from the agent-qa root first. `--force` is required — the 404 '
  + 'mutation scripts restore their subjects byte-identically, which turbo treats as a cache hit, '
  + 'so a plain build reports FULL TURBO and refreshes no dist mtime.'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium: run '
  + '`pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE SKIPPED WHEN THE BROWSER '
  + 'IS ABSENT — they are the only cells in this repository that measure the post-processing chips '
  + 'in the medium a person actually sees.'

/** How long one drainable run has to reach `runFinished` on the local run-stream door. */
const RUN_BUDGET_MS = 90_000
/** How long a chain has to reach terminal ON THE PAGE once it is being drained. */
const CHAIN_BUDGET_MS = 90_000
/** The hand-off leg waits on a real daemon over a real lease. */
const DAEMON_BUDGET_MS = 180_000
/** How many times each timing-shaped posture is measured. */
const K = 3

/**
 * How many foreign chains sit in the queue ahead of each in-process arm's own.
 *
 * Three, because the pump's own bound is sixteen jobs: three chains is six rows plus the arm's own
 * two and its terminal notify, which is comfortably inside the bound — a backlog that exceeded it
 * would STARVE the arm's chain (`backlog-exhausted`), which is a real posture and the wrong one to
 * be measuring here. `seedForeignBacklog` states what the backlog is for.
 */
const BACKLOG_CHAINS = 3


/**
 * A published constant, read out of the module that publishes it.
 *
 * `live-view-dom.test.ts`'s `publishedSentence`, widened by one level because the sentences this
 * file asserts on live inside a `Record` literal rather than at the top level. Extracted rather
 * than imported for that file's own reason: importing a `dashboard-ui` module into a Node test
 * would drag a renderer in. Either way the cell fails when the sentence moves, which is the point —
 * a hardcoded copy would go on passing against a page that says something else.
 */
function publishedRecordSentence(relativePath: string, record: string, key: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const block = new RegExp(`${record}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`, 'u').exec(source)
  if (block === null) throw new Error(`${record} is no longer an exported object literal in ${relativePath}`)
  const entry = new RegExp(`\\n\\s*${key}:\\s*'([^']+)'`, 'u').exec(block[1] as string)
  if (entry === null) throw new Error(`${record} no longer carries a single-quoted '${key}' member`)
  return entry[1] as string
}

/** The poll floor the client holds while a chain is still moving — read out of the client. */
function publishedPollMs(): number {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', 'lib', 'api.ts'), 'utf8')
  const match = /POST_PROCESSING_POLL_MS\s*=\s*(\d+)/u.exec(source)
  if (match === null) throw new Error('POST_PROCESSING_POLL_MS is no longer an exported number literal')
  return Number(match[1])
}

/** A single-quoted exported string constant, read out of the shipped module rather than retyped. */
function publishedConstant(relativePath: string, name: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const match = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`, 'u').exec(source)
  if (match === null) throw new Error(`${name} is no longer an exported single-quoted string in ${relativePath}`)
  return match[1] as string
}

const POLL_MS = publishedPollMs()
const REASON_ABSENT_HANDED_OFF =
  publishedRecordSentence('lib/post-processing-view.ts', 'FAILED_REASON_ABSENT_TEXT', 'handedOff')
const PENDING_POSTURE_HANDED_OFF =
  publishedRecordSentence('lib/post-processing-view.ts', 'PENDING_POSTURE_TEXT', 'handedOff')
const WILL_RETRY_TEXT = publishedConstant('lib/post-processing-view.ts', 'WILL_RETRY_TEXT')

/**
 * EVERY sentence the view can paint when nobody recorded a reason.
 *
 * The producer's reason and the absence that stands in for it used to be two different elements, so
 * reading one proved it was not the other. They now share the card's outcome line, and the RED-run
 * cell's claim — "the page shows the PRODUCER's text" — is only kept by telling them apart, which
 * needs the whole record rather than the one key `(3b)` asserts on.
 */
const REASON_ABSENT_SENTENCES = ['handedOff', 'detached', 'drained', 'unknown'].map((key) =>
  publishedRecordSentence('lib/post-processing-view.ts', 'FAILED_REASON_ABSENT_TEXT', key),
)

/**
 * `stageFailedText`'s join for the analysis stage, spelled here rather than imported.
 *
 * The cli package cannot import dashboard-ui, so this prefix is the one half that is retyped; the
 * reason half is still read out of the shipped module above, which is the half that could drift
 * without anybody noticing.
 */
const ANALYSIS_FAILED_PREFIX = 'Analysis failed — '

// Literals, checked against `STAGE_CARD_LINE_SELECTORS`, because cli cannot import it.
const STAGE_CARD_LINES = {
  outcome: '[data-stage-card-line="outcome"]',
  timing: '[data-stage-card-line="timing"]',
  retry: '[data-stage-card-line="retry"]',
} as const

for (const [kind, selector] of Object.entries(STAGE_CARD_LINES)) {
  const published = publishedRecordSentence(
    'components/run-detail/post-processing-chips.tsx',
    'STAGE_CARD_LINE_SELECTORS',
    kind,
  )
  if (published !== selector) {
    throw new Error(
      `STAGE_CARD_LINE_SELECTORS.${kind} is now ${JSON.stringify(published)}; this file reads `
      + `${JSON.stringify(selector)} and would harvest nothing`,
    )
  }
}

/** How long a focused indicator is given to open its card before the absence is taken as real. */
const CARD_OPEN_BUDGET_MS = 5_000

// Split on space, middle dot, space; a looser split reads a dotted clause as two.
function timingClauses(line: string): string[] {
  return line.split(' · ').map((clause) => clause.trim())
}

/**
 * Every spelling `formatDuration` emits — `450ms`, `2s`, `2.5s`, `1m`, `1m 30s`, `1h`, `1h 5m`.
 *
 * Anchored and value-free: it says a clause CARRIES a duration without saying which one, because
 * the drain's real durations vary between a laptop and CI and a pinned value measures the machine.
 */
const DURATION_TEXT = String.raw`(?:\d+ms|\d+(?:\.\d+)?s|\d+m(?: \d+s)?|\d+h(?: \d+m)?)`
const QUEUED_CLAUSE = /^Queued \d{2}:\d{2}:\d{2}$/u
const STARTED_AFTER_CLAUSE = new RegExp(`^started after ${DURATION_TEXT}$`, 'u')
const FINISHED_IN_CLAUSE = new RegExp(`^finished in ${DURATION_TEXT}$`, 'u')


interface ChipTransition {
  readonly at: number
  readonly state: string
}

interface HttpEvent {
  readonly url: string
  readonly at: number
  readonly status?: number
}

/** Everything one driven page recorded about one chain. */
interface PageObservation {
  readonly runId: string
  /** Chip state changes, stamped by a `MutationObserver` inside the page. */
  readonly transitions: readonly ChipTransition[]
  /** Every `/post-processing` request the browser issued, read route and stream alike. */
  readonly requests: readonly HttpEvent[]
  /** Every `/post-processing` response the browser received. Aborted requests produce none. */
  readonly responses: readonly HttpEvent[]
  /** The chip area's serialised HTML at the end of the observation. */
  readonly html: string
  /** `data-chip` → `data-chip-status`, as painted at the end. */
  readonly painted: Record<string, string>
  // A stage with nothing to say paints no card, so an absence here is a real absence.
  readonly analysisOutcome?: string
  /** The analysis card's `timing` line, if the read carried a job row to time. */
  readonly analysisTiming?: string
  /** The analysis card's `retry` line — painted only when the envelope carried a retry intent. */
  readonly analysisRetry?: string
  // Whether the first read of the route carried a `disposition`.
  readonly firstReadHadDisposition: boolean
  /** Whether the chain was already terminal on the first read. */
  readonly firstReadTerminal: boolean
  /** When this browser received its own `verdict`, on the browser's monotonic clock. */
  readonly browserVerdictAt?: number
  /** When this page changed its route, on the same browser clock as `browserVerdictAt`. */
  readonly navigatedAt?: number
  /** What the DURABLE read said for this run at the end of the observation. */
  readonly durableChips?: Record<string, string>
}

// Measured with `fetch` at the binary's push and poll routes: a browser mounts too late.
interface PushPollArm {
  readonly runId: string
  /** Chip frame types the dedicated stream delivered, with this process's stamp. */
  readonly frames: readonly { readonly type: string; readonly at: number }[]
  /** When the STREAM first carried a settling `analysis` frame. */
  readonly streamSettledAt?: number
  /** When a poller running at the client's own cadence first SAW `analysis` settled. */
  readonly pollSettledAt?: number
  /** How many reads the poller made before it saw it. */
  readonly pollReads: number
  /** The stream's HTTP status at open, so a refusal is a reading rather than an absence. */
  readonly streamStatus: number
}

interface DrainFixture {
  readonly dashboard: SpawnedDashboard & { readonly ready: boolean }
  readonly root: string
  readonly configPath: string
  readonly browser: Browser
  /**
   * ONE browser context for the whole file, and that is a measurement decision.
   *
   * `browser.newPage()` mints a fresh CONTEXT every time, and a fresh context has an empty HTTP
   * cache — so every arm would re-fetch and re-parse the whole bundle, which measured at roughly a
   * second before the page could read anything. A second is longer than this fixture's entire
   * post-verdict window, so the cells that must watch a chain IN FLIGHT would each open onto a
   * finished one (measured: three of three arms). Sharing the context shares the cache; the pages
   * are still separate, so nothing about request counting or page state is shared between arms.
   */
  readonly context: BrowserContext
}

/** Everything `beforeAll` measured, or the reason it could not. */
interface Recorded {
  /** k arms of posture (1): the page opened at the verdict while THIS process drains. */
  readonly inProcess: PageObservation[]
  /** k arms of posture (2): the same, with the dedicated stream aborted in the browser. */
  readonly noSocket: PageObservation[]
  /** Posture (4): a return visit to a run that was already terminal. */
  returnVisit?: PageObservation
  /** Posture (3): a run a real `agent-qa daemon` drained. */
  handedOff?: PageObservation
  /** The red in-process run, opened after the backlog was finished. */
  redRun?: PageObservation
  /** k arms of the push-vs-poll differential, measured at the shipped dashboard's own door. */
  readonly differential: PushPollArm[]
  /** `runs.postprocessing` answered by a COLD process, the dashboard already killed. */
  coldControl?: { runId: string; exit: number | null; chips: Record<string, string>; stdout: string; stderr: string }
  /** The red run's own recorded log — the envelope trail an in-process drain leaves. */
  redRunEventTypes: string[]
  /**
   * What the READ said about the red chain's retry intent, straight off the failures fold.
   *
   * The card paints a retry line only when the envelope carried `willRetry: true`, so "the chain
   * says whether it intends to try again" is a claim about agreement between the route and the
   * page — which needs the route's answer recorded beside the page's.
   */
  redRunWillRetry?: boolean
  /** The handed-off run's own recorded log. A daemon-drained chain leaves NO chip line. */
  handedOffEventTypes: string[]
  /** Whatever stopped the drive, if anything did. */
  failure?: string
}

let fixture: DrainFixture | undefined
let daemon: RunningDaemon | undefined
const recorded: Recorded = {
  inProcess: [],
  noSocket: [],
  differential: [],
  redRunEventTypes: [],
  handedOffEventTypes: [],
}

function held(): DrainFixture {
  if (fixture === undefined) throw new Error('the post-processing DOM fixture never came up')
  return fixture
}

/** Quote the child's own streams in every failure — a spawned cell's message is its diagnosis. */
function childContext(): string {
  const dashboard = fixture?.dashboard
  if (dashboard === undefined) return 'the dashboard was never spawned'
  return `child stdout: ${JSON.stringify(dashboard.stdout().slice(-1200))}; `
    + `child stderr: ${JSON.stringify(dashboard.stderr().slice(-1200))}`
}

/** The drive recorded a failure rather than throwing; every cell reports it the same way. */
function driveOk(): void {
  expect(recorded.failure, `the measurement drive stopped early. ${childContext()}`).toBeUndefined()
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  budgetMs: number,
  everyMs = 50,
): Promise<number> {
  const started = Date.now()
  const deadline = started + budgetMs
  for (;;) {
    if (await predicate()) return Date.now() - started
    if (Date.now() >= deadline) throw new Error(`timed out after ${String(budgetMs)}ms waiting for ${what}`)
    await new Promise<void>((tick) => { setTimeout(tick, everyMs) })
  }
}

interface ReadBody {
  status: { runId: string; chips: Record<string, string>; notification?: unknown }
  disposition?: string
  failures?: Record<string, { error?: string; willRetry?: boolean }>
}

async function readChain(origin: string, runId: string): Promise<ReadBody> {
  const response = await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/post-processing`)
  const raw = await response.text()
  return JSON.parse(raw) as ReadBody
}

/** The door's own terminal rule, restated over a read body the way the client restates it. */
function chainTerminal(body: ReadBody): boolean {
  if (body.status.notification !== undefined) return true
  const settled = (chip: string | undefined): boolean => chip === 'complete' || chip === 'failed'
  return settled(body.status.chips.analysis) && settled(body.status.chips.curation)
}

/** Trigger one drainable suite run and hand back the id the door acked. */
async function triggerDrainableRun(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/runs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: DRAINABLE_SUITE_PATH }),
  })
  const body = await response.text()
  if (response.status !== 202) throw new Error(`the trigger route refused: ${body}`)
  const runId = (JSON.parse(body) as { runId?: string }).runId
  if (typeof runId !== 'string') throw new Error(`the trigger ack named no run: ${body}`)
  return runId
}

/**
 * Measure ONE push-vs-poll arm: subscribe, trigger, and let a poller race the stream.
 *
 * THE POLLER IS THE CONTROL AND IT RUNS AT THE CLIENT'S OWN PERIOD, read out of the client rather
 * than typed here. It starts at the same instant the subscriber does, so the two channels are asked
 * the same question from the same moment and the difference between their answers is the whole
 * measurement. A subscriber that learned nothing the poller had not already seen would report a
 * non-positive difference, which is exactly what the relay mutation produces.
 */
async function drivePushPollArm(fx: DrainFixture): Promise<PushPollArm> {
  const runId = await triggerDrainableRun(fx.dashboard.origin)
  const settling = new Set(['analysisCompleted', 'analysisFailed'])

  const abort = new AbortController()
  const frames: { type: string; at: number }[] = []
  let streamSettledAt: number | undefined
  let streamStatus = 0

  const subscription = (async () => {
    const response = await fetch(
      `${fx.dashboard.origin}/api/runs/${encodeURIComponent(runId)}/post-processing/stream`,
      { signal: abort.signal },
    )
    streamStatus = response.status
    if (response.body === null || response.status !== 200) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffered += decoder.decode(chunk.value, { stream: true })
      for (const match of buffered.matchAll(/^event: (.+)$/gmu)) {
        const type = match[1] as string
        if (frames.some((frame) => frame.type === type && frame.at > 0) && type === 'snapshot') continue
        frames.push({ type, at: Date.now() })
        if (settling.has(type) && streamSettledAt === undefined) streamSettledAt = Date.now()
      }
      buffered = ''
      if (streamSettledAt !== undefined) break
    }
    await reader.cancel().catch(() => undefined)
  })().catch(() => { /* a refusal is recorded as `streamStatus`; the cell reports it */ })

  // The poller, at the client's own cadence, from the same moment.
  let pollSettledAt: number | undefined
  let pollReads = 0
  const pollDeadline = Date.now() + CHAIN_BUDGET_MS
  while (pollSettledAt === undefined && Date.now() < pollDeadline) {
    pollReads += 1
    const chip = (await readChain(fx.dashboard.origin, runId)).status.chips.analysis
    if (chip === 'complete' || chip === 'failed') { pollSettledAt = Date.now(); break }
    await new Promise<void>((tick) => { setTimeout(tick, POLL_MS) })
  }
  abort.abort()
  await subscription

  return {
    runId,
    frames,
    ...(streamSettledAt === undefined ? {} : { streamSettledAt }),
    ...(pollSettledAt === undefined ? {} : { pollSettledAt }),
    pollReads,
    streamStatus,
  }
}

// Unclaimed foreign chains ahead of the arm's own, so the page watches a chain still in flight.
async function seedForeignBacklog(fx: DrainFixture, chains: number): Promise<string[]> {
  const knowledgeRoot = join(fx.root, 'agent-qa-knowledge')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') {
    throw new Error(`the backlog seeder could not take the writer lease: ${JSON.stringify(lease)}`)
  }
  const seeded: string[] = []
  try {
    for (let index = 0; index < chains; index += 1) {
      const runId = await triggerDrainableRun(fx.dashboard.origin)
      await waitUntil(
        async () => (await readChain(fx.dashboard.origin, runId)).disposition !== undefined,
        `filler run ${runId} to reach runFinished`,
        RUN_BUDGET_MS,
        25,
      )
      const posture = (await readChain(fx.dashboard.origin, runId)).disposition
      if (posture !== 'handedOff') {
        throw new Error(
          `filler run ${runId} read \`${String(posture)}\` rather than \`handedOff\`, so the lease this `
          + 'seeder holds is not the one the post-verdict step consults and no backlog was created',
        )
      }
      seeded.push(runId)
    }
  } finally {
    releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
  }
  return seeded
}

/**
 * Occupy the analysis artifact's path with a DIRECTORY, so `persistAnalysis` fails for real.
 *
 * WAITED FOR RATHER THAN PRE-CREATED. Creating `runs/<slug>/` before the shell does leaves the run
 * unable to finish at all (measured), so the plant waits for the shell's own directory and then
 * occupies one name inside it. `slugBranch` is the PRODUCTION derivation, imported rather than
 * re-spelled — `post-processing-anchors.test.ts` discovers its single run directory instead, which
 * is the right call for a fixture that ran one run and the wrong one here, where several runs share
 * a project and each plant must address exactly one of them.
 */
async function occupyAnalysisArtifactPath(root: string, runId: string): Promise<string> {
  const runDir = join(root, '.agent-qa', 'runs', slugBranch(runId))
  await waitUntil(() => existsSync(runDir), `the shell to create ${runDir}`, RUN_BUDGET_MS, 5)
  mkdirSync(join(runDir, 'analysis.json'), { recursive: true })
  return runDir
}

/** A run's own recorded log, by type, in order. */
function recordedEventTypes(root: string, runId: string): string[] {
  const file = join(root, '.agent-qa', 'runs', slugBranch(runId), 'events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

/**
 * The observer, installed BEFORE the bundle runs.
 *
 * `addInitScript` rather than `evaluate` after `goto`, and the difference is the whole measurement:
 * an observer attached after the page settled would miss every transition that happened while it
 * was loading, and the reading would silently become "the transitions we were awake for".
 */
async function armChipObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const bag = window as unknown as { __chipLog?: { at: number; state: string }[] }
    bag.__chipLog = []
    const snapshot = (): string =>
      Array.from(document.querySelectorAll('[data-chip]'))
        .map((element) => `${element.getAttribute('data-chip') ?? '?'}=${element.getAttribute('data-chip-status') ?? '?'}`)
        .sort()
        .join(',')
    let last = ''
    const record = (): void => {
      const now = snapshot()
      if (now === last) return
      last = now
      bag.__chipLog?.push({ at: Date.now(), state: now })
    }
    const start = (): void => {
      new MutationObserver(record).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
      })
      record()
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
  })
}

// Timed from the viewer's own envelope on the browser clock, so page load is not counted.
async function armVerdictNavigationObserver(page: Page, runId: string): Promise<void> {
  await page.addInitScript((id) => {
    const timing: { verdictAt?: number; navigatedAt?: number } = {}
    const bag = window as unknown as { __verdictNavigation: typeof timing }
    bag.__verdictNavigation = timing
    const streamPath = `/api/run-stream/${encodeURIComponent(id)}`
    const detailPath = `/runs/${encodeURIComponent(id)}`
    window.EventSource = new Proxy(window.EventSource, {
      construct(Target, args, newTarget) {
        const source = Reflect.construct(Target, args, newTarget) as EventSource
        if (new URL(String(args[0]), location.href).pathname === streamPath) {
          source.addEventListener('verdict', () => { timing.verdictAt ??= performance.now() })
        }
        return source
      },
    })
    const recordNavigation = (): void => {
      if (location.pathname === detailPath) timing.navigatedAt ??= performance.now()
    }
    const replaceState = history.replaceState.bind(history)
    history.replaceState = (...args) => {
      replaceState(...args)
      recordNavigation()
    }
    const pushState = history.pushState.bind(history)
    history.pushState = (...args) => {
      pushState(...args)
      recordNavigation()
    }
  }, runId)
}

/**
 * Count every `/post-processing` request and response this page makes FOR ONE RUN.
 *
 * SCOPED BY RUN ID, not by path alone: `driveInProcessArm` warms the run-detail chunk inside the
 * same page by visiting a run nobody ever started, and that warm visit legitimately reads the door
 * once. Counting it would turn "exactly one read" into "two" for reasons that have nothing to do
 * with the claim. The id is in the path of every request this door serves, so the filter is exact
 * rather than heuristic.
 */
function trackPostProcessingTraffic(page: Page, runId: string): { requests: HttpEvent[]; responses: HttpEvent[] } {
  const requests: HttpEvent[] = []
  const responses: HttpEvent[] = []
  const mine = (url: string): boolean => url.includes('/post-processing') && url.includes(encodeURIComponent(runId))
  page.on('request', (request) => {
    if (mine(request.url())) requests.push({ url: request.url(), at: Date.now() })
  })
  page.on('response', (response) => {
    if (mine(response.url())) {
      responses.push({ url: response.url(), at: Date.now(), status: response.status() })
    }
  })
  return { requests, responses }
}

/**
 * A run whose detail page every arm visits before it measures anything.
 *
 * IT MUST BE A RUN THAT REALLY RAN. Run detail paints no header — and therefore no chips — for an
 * id the store has never heard of, so warming on a made-up id warms nothing and waits out a
 * timeout. This is a real drainable run, driven to terminal once, whose only job afterwards is to
 * be a page the browser has already mounted.
 */
let warmRunId: string | undefined

const isStream = (event: HttpEvent): boolean => event.url.includes('/post-processing/stream')
const isRead = (event: HttpEvent): boolean => !isStream(event)

/** Harvest everything the page painted, once the observation window is over. */
async function harvest(
  page: Page,
  runId: string,
  traffic: { requests: HttpEvent[]; responses: HttpEvent[] },
  firstRead: {
    hadDisposition: boolean
    terminal: boolean
    browserVerdictAt?: number
    navigatedAt?: number
    durableChips?: Record<string, string>
  },
): Promise<PageObservation> {
  const transitions = await page.evaluate(
    () => (window as unknown as { __chipLog?: { at: number; state: string }[] }).__chipLog ?? [],
  )
  const area = page.locator('[data-chips-state]').first()
  const html = await area.innerHTML().catch(() => '')
  const painted = await page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll('[data-chip]')).map((element) => [
        element.getAttribute('data-chip') ?? '?',
        element.getAttribute('data-chip-status') ?? '?',
      ]),
    ),
  )
  // Opened by focus, not hover; the card is portalled, and `.first()` skips Radix's hidden copy.
  const analysisChip = page.locator('[data-chip="analysis"]').first()
  const analysisCard = page.locator('[data-stage-card="analysis"]').first()
  const cardLine = async (selector: string): Promise<string | undefined> => {
    const node = analysisCard.locator(selector)
    return (await node.count()) === 0 ? undefined : (await node.first().innerText()).trim()
  }
  let analysisOutcome: string | undefined
  let analysisTiming: string | undefined
  let analysisRetry: string | undefined
  if ((await analysisChip.count()) > 0) {
    await analysisChip.focus().catch(() => undefined)
    // A stage with nothing to say renders no card, and that is a reading rather than a timeout.
    const opened = await analysisCard
      .waitFor({ state: 'attached', timeout: CARD_OPEN_BUDGET_MS })
      .then(() => true)
      .catch(() => false)
    if (opened) {
      analysisOutcome = await cardLine(STAGE_CARD_LINES.outcome)
      analysisTiming = await cardLine(STAGE_CARD_LINES.timing)
      analysisRetry = await cardLine(STAGE_CARD_LINES.retry)
    }
  }
  return {
    runId,
    transitions,
    requests: traffic.requests,
    responses: traffic.responses,
    html,
    painted,
    ...(analysisOutcome === undefined ? {} : { analysisOutcome }),
    ...(analysisTiming === undefined ? {} : { analysisTiming }),
    ...(analysisRetry === undefined ? {} : { analysisRetry }),
    firstReadHadDisposition: firstRead.hadDisposition,
    firstReadTerminal: firstRead.terminal,
    ...(firstRead.browserVerdictAt === undefined ? {} : { browserVerdictAt: firstRead.browserVerdictAt }),
    ...(firstRead.navigatedAt === undefined ? {} : { navigatedAt: firstRead.navigatedAt }),
    ...(firstRead.durableChips === undefined ? {} : { durableChips: firstRead.durableChips }),
  }
}

// Warm the lazily loaded run-detail chunk, so the first measured open pays no cold module graph.
async function warmRunDetailChunk(origin: string, context: BrowserContext): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto(`${origin}/runs/r_this_dashboard_never_ran_me`)
    await page.waitForTimeout(750)
  } finally {
    await page.close()
  }
}

/** A daemon paths record over an EXISTING project root, rather than a fresh temp one. */
function daemonPathsOver(root: string): PostRunDaemonPaths {
  return {
    root,
    agentQaRoot: join(root, '.agent-qa'),
    knowledgeRoot: join(root, 'agent-qa-knowledge'),
    gate: join(root, 'curation.gate'),
    enteredMarker: {
      first: join(root, 'first.curation-entered.json'),
      restarted: join(root, 'restarted.curation-entered.json'),
    },
    readyMarker: { first: join(root, 'first.ready.json'), restarted: join(root, 'restarted.ready.json') },
    report: { first: join(root, 'first.report.json'), restarted: join(root, 'restarted.report.json') },
  }
}

/**
 * Drive ONE in-process posture arm: trigger, open at the verdict, watch the drain, harvest.
 *
 * `abortStream` is posture (2). Aborting in the BROWSER rather than not starting the door is the
 * only honest spelling of "no socket": the server is unchanged and still willing, so what the arm
 * measures is a client that cannot reach the push channel — a proxy, a corporate middlebox, a
 * browser that dropped the connection — rather than a server configured differently.
 */
async function driveInProcessArm(
  fx: DrainFixture,
  options: { readonly abortStream: boolean },
): Promise<PageObservation> {
  const page = await fx.context.newPage()
  try {
    if (options.abortStream) {
      await page.route('**/post-processing/stream*', (route) => route.abort())
    }
    await armChipObserver(page)

    // THE RUN-DETAIL CHUNK IS EVALUATED IN THIS PAGE BEFORE THE RUN EXISTS. The bundle code-splits
    // and run detail is a lazy chunk, so a first mount of it costs a fetch-and-evaluate — time
    // that would otherwise be spent INSIDE the window this cell has to observe. Warming happens
    // before the trigger, not after, for exactly that reason.
    if (warmRunId !== undefined) {
      await page.goto(`${fx.dashboard.origin}/runs/${encodeURIComponent(warmRunId)}`)
      await page.locator('[data-chips-state]').first().waitFor({ state: 'attached', timeout: 30_000 })
    }

    // The backlog goes in AFTER the page is warm and BEFORE the arm's own run — see
    // `seedForeignBacklog` for what it buys and why it is a real state rather than a delay.
    await seedForeignBacklog(fx, BACKLOG_CHAINS)

    const runId = await triggerDrainableRun(fx.dashboard.origin)
    await armVerdictNavigationObserver(page, runId)
    const traffic = trackPostProcessingTraffic(page, runId)

    // Arrive through the live page: a cold `/runs/:id` on a live row bounces to `/live`.
    await page.goto(`${fx.dashboard.origin}/runs/${encodeURIComponent(runId)}/live`)
    await page.waitForURL(/\/runs\/[^/]+$/u, { timeout: RUN_BUDGET_MS })
    const browserTiming = await page.evaluate(() =>
      (window as unknown as { __verdictNavigation: { verdictAt?: number; navigatedAt?: number } }).__verdictNavigation,
    )

    // The first read is the marker: no `disposition` means the page beat a durable `runFinished`.
    await waitUntil(
      () => traffic.responses.some(isRead),
      'the page to complete its first post-processing read',
      RUN_BUDGET_MS,
      10,
    )
    const atFirstRead = await readChain(fx.dashboard.origin, runId)

    await waitUntil(
      async () => chainTerminal(await readChain(fx.dashboard.origin, runId)),
      `the chain for ${runId} to reach terminal`,
      CHAIN_BUDGET_MS,
      100,
    )
    // The page is given room past the durable terminal to paint it: the last transition is a
    // render, not a row.
    await waitUntil(
      async () => {
        const painted = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-chip]'))
            .map((element) => element.getAttribute('data-chip-status') ?? '?'),
        )
        return painted.length === 2 && painted.every((word) => word === 'complete' || word === 'failed')
      },
      `the page to paint both chips terminal for ${runId}`,
      POLL_MS * 3,
      50,
    )
    return await harvest(page, runId, traffic, {
      hadDisposition: atFirstRead.disposition !== undefined,
      terminal: chainTerminal(atFirstRead),
      ...(browserTiming.verdictAt === undefined ? {} : { browserVerdictAt: browserTiming.verdictAt }),
      ...(browserTiming.navigatedAt === undefined ? {} : { navigatedAt: browserTiming.navigatedAt }),
      durableChips: (await readChain(fx.dashboard.origin, runId)).status.chips,
    })
  } finally {
    await page.close()
  }
}

beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SPAWNED OR SERVED: a stale build measures the previous commit,
  // and `uiDir` points at `dashboard-ui/dist`.
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error(
      `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const context = await browser.newContext()
  const project = drainableSuiteFixtureProject('post-processing-dom')
  const port = await reserveEphemeralPort()
  const dashboard = await spawnDashboard(project.root, project.configPath, port)
  fixture = { dashboard, root: project.root, configPath: project.configPath, browser, context }
  expect(
    dashboard.ready,
    `the built \`agent-qa dashboard\` never reported that it was listening. ${childContext()}`,
  ).toBe(true)

  await warmRunDetailChunk(dashboard.origin, context)

  // Everything below RECORDS and does not assert — see the header. A drive that stopped early
  // leaves `failure` set and every cell says so with its own message.
  try {
    // ---- The warm run: one drainable run driven to terminal, so every arm below can mount run
    // detail once in its own page before the measurement starts. See `warmRunId`.
    const warm = await triggerDrainableRun(dashboard.origin)
    await waitUntil(
      async () => chainTerminal(await readChain(dashboard.origin, warm)),
      `the warm run ${warm} to reach terminal`,
      CHAIN_BUDGET_MS,
      100,
    )
    warmRunId = warm

    // ---- (1) and (1b): the in-process drain, k arms.
    for (let arm = 0; arm < K; arm += 1) {
      recorded.inProcess.push(await driveInProcessArm(fixture, { abortStream: false }))
    }

    // ---- (1b): the push-vs-poll differential at the shipped dashboard's own two doors, k arms.
    for (let arm = 0; arm < K; arm += 1) {
      recorded.differential.push(await drivePushPollArm(fixture))
    }

    // ---- (2): the same posture with the push channel unreachable in the browser, k arms.
    for (let arm = 0; arm < K; arm += 1) {
      recorded.noSocket.push(await driveInProcessArm(fixture, { abortStream: true }))
    }

    // ---- (4): the return visit, on a run that has been terminal for a while.
    const terminalRunId = recorded.inProcess[recorded.inProcess.length - 1]?.runId
    if (terminalRunId !== undefined) {
      const page = await fixture.context.newPage()
      try {
        await armChipObserver(page)
        const traffic = trackPostProcessingTraffic(page, terminalRunId)
        await page.goto(`${dashboard.origin}/runs/${encodeURIComponent(terminalRunId)}`)
        await waitUntil(
          async () => {
            const painted = await page.evaluate(() =>
              Array.from(document.querySelectorAll('[data-chip]'))
                .map((element) => element.getAttribute('data-chip-status') ?? '?'),
            )
            return painted.length === 2 && painted.every((word) => word === 'complete' || word === 'failed')
          },
          `the return visit to paint ${terminalRunId} terminal`,
          POLL_MS,
          25,
        )
        // Held open well past a poll period AND past a reconnect, so "no second read and no socket"
        // is a claim about a window both would have fired in rather than one lucky sample.
        await page.waitForTimeout(POLL_MS * 2)
        const body = await readChain(dashboard.origin, terminalRunId)
        recorded.returnVisit = await harvest(page, terminalRunId, traffic, {
          hadDisposition: body.disposition !== undefined,
          terminal: chainTerminal(body),
        })
      } finally {
        await page.close()
      }
    }

    // ---- The RED in-process run. Its own tail claims analyse, fails to persist the artifact for
    // real, appends the envelope and leaves the chain mid-flight on the retry exit. Triggered
    // BEFORE the daemon exists, so the failing attempt is genuinely this process's.
    const redRunId = await triggerDrainableRun(dashboard.origin)
    await occupyAnalysisArtifactPath(project.root, redRunId)
    await waitUntil(
      async () => (await readChain(dashboard.origin, redRunId)).disposition !== undefined,
      `the red run ${redRunId} to reach runFinished`,
      RUN_BUDGET_MS,
      50,
    )

    // The real daemon over the dashboard's root; the gate opens first, so curation returns.
    const paths = daemonPathsOver(project.root)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(paths.gate, 'open\n', 'utf8')
    daemon = startPostRunDaemon('first', paths)
    await waitForMarker(daemon, paths.readyMarker.first, 'the daemon to hold the lease and serve', DAEMON_BUDGET_MS)

    // The daemon honours the backoff the in-process pump refused to sleep on, so the red chain
    // reaches terminal here — with the failure text still the one THIS process's emitter appended.
    await waitUntil(
      async () => chainTerminal(await readChain(dashboard.origin, redRunId)),
      `the red chain ${redRunId} to reach terminal under the daemon`,
      DAEMON_BUDGET_MS,
      200,
    )
    recorded.redRunEventTypes = recordedEventTypes(project.root, redRunId)

    {
      const page = await fixture.context.newPage()
      try {
        await armChipObserver(page)
        const traffic = trackPostProcessingTraffic(page, redRunId)
        await page.goto(`${dashboard.origin}/runs/${encodeURIComponent(redRunId)}`)
        await waitUntil(
          async () => {
            const painted = await page.evaluate(() =>
              Array.from(document.querySelectorAll('[data-chip="analysis"]'))
                .map((element) => element.getAttribute('data-chip-status') ?? '?'),
            )
            return painted[0] === 'failed'
          },
          `the red run's analysis chip to paint failed`,
          POLL_MS * 3,
          25,
        )
        const body = await readChain(dashboard.origin, redRunId)
        recorded.redRunWillRetry = body.failures?.analysis?.willRetry
        recorded.redRun = await harvest(page, redRunId, traffic, {
          hadDisposition: body.disposition !== undefined,
          terminal: chainTerminal(body),
        })
      } finally {
        await page.close()
      }
    }

    // ---- (3): the HAND-OFF posture. The daemon is suspended for the length of the run so the
    // window between "the chain is enqueued" and "somebody drains it" is a fact rather than a race:
    // the lease is still HELD (its TTL is far longer than this pause), so the dashboard's
    // post-verdict step decides `handedOff` exactly as it would against a busy daemon, and nothing
    // pumps until this file says so.
    daemon.child.kill('SIGSTOP')
    const handedRunId = await triggerDrainableRun(dashboard.origin)
    await waitUntil(
      async () => (await readChain(dashboard.origin, handedRunId)).disposition !== undefined,
      `the handed-off run ${handedRunId} to reach runFinished`,
      RUN_BUDGET_MS,
      50,
    )
    await occupyAnalysisArtifactPath(project.root, handedRunId)

    const handedPage = await fixture.context.newPage()
    try {
      await armChipObserver(handedPage)
      const traffic = trackPostProcessingTraffic(handedPage, handedRunId)
      // OPENED AFTER `runFinished` IS DURABLE, deliberately: the first read therefore says
      // `handedOff`, which is the read on which the client must open NOTHING.
      await handedPage.goto(`${dashboard.origin}/runs/${encodeURIComponent(handedRunId)}`)
      await waitUntil(
        () => traffic.responses.some(isRead),
        'the handed-off page to complete its first read',
        RUN_BUDGET_MS,
        10,
      )
      const atFirstRead = await readChain(dashboard.origin, handedRunId)
      daemon.child.kill('SIGCONT')
      await waitUntil(
        async () => chainTerminal(await readChain(dashboard.origin, handedRunId)),
        `the handed-off chain ${handedRunId} to reach terminal under the daemon`,
        DAEMON_BUDGET_MS,
        200,
      )
      await waitUntil(
        async () => {
          const painted = await handedPage.evaluate(() =>
            Array.from(document.querySelectorAll('[data-chip]'))
              .map((element) => element.getAttribute('data-chip-status') ?? '?'),
          )
          return painted.length === 2 && painted.every((word) => word === 'complete' || word === 'failed')
        },
        `the handed-off page to paint both chips terminal`,
        POLL_MS * 4,
        50,
      )
      recorded.handedOff = await harvest(handedPage, handedRunId, traffic, {
        hadDisposition: atFirstRead.disposition !== undefined,
        terminal: chainTerminal(atFirstRead),
      })
      recorded.handedOffEventTypes = recordedEventTypes(project.root, handedRunId)
    } finally {
      await handedPage.close()
    }

    await stopDaemonGracefully(daemon)
    daemon = undefined

    // ---- The COLD CONTROL. The dashboard is killed FIRST, so what answers below has no server,
    // no relay and no warm cache — only the durable rows and the op that reads them.
    const paintedRunId = recorded.inProcess[recorded.inProcess.length - 1]?.runId ?? redRunId
    const paintedWords = recorded.inProcess[recorded.inProcess.length - 1]?.painted
      ?? recorded.redRun?.painted
      ?? {}
    await dashboard.stop()
    const cold = await spawnCollecting(project.root, [
      CLI_ENTRY,
      '--config',
      project.configPath,
      'fn',
      RUNS_POST_PROCESSING_FUNCTION_ID,
      '--input',
      JSON.stringify({ runId: paintedRunId }),
      '--json',
    ])
    let chips: Record<string, string> = {}
    try {
      chips = (JSON.parse(cold.stdout) as { chips?: Record<string, string> }).chips ?? {}
    } catch { /* recorded verbatim below; the cell reports the bytes */ }
    recorded.coldControl = {
      runId: paintedRunId,
      exit: cold.code,
      chips,
      stdout: cold.stdout,
      stderr: cold.stderr,
    }
    void paintedWords
  } catch (error) {
    recorded.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  }
}, 900_000)

afterAll(async () => {
  const open = daemon
  daemon = undefined
  if (open !== undefined) await stopDaemonGracefully(open).catch(() => undefined)
  await stopAllPostRunDaemons()
  const held = fixture
  fixture = undefined
  if (held !== undefined) {
    await held.dashboard.stop()
    await held.browser.close()
  }
  cleanupTempRoots()
}, 120_000)

/**
 * How long after the read that could have carried it a chip transition was painted.
 *
 * THE TWO STAMPS ARE TAKEN IN DIFFERENT PROCESSES FOR THE SAME MILLISECOND, and the tolerance below
 * is that fact rather than slack. The response stamp is this process's clock at the moment
 * Playwright reports headers; the transition stamp is the page's clock at the moment React commits.
 * The measured lags here are 0–1 ms — the paint really is that close to the bytes — so the two
 * orderings interleave, and a strict `readAt <= at` reported NO timed transition on roughly one run
 * in three (measured, twice inside a mutation leg, which is how it was found). A paint cannot
 * precede the bytes that caused it, so an inversion of a few milliseconds is measurement noise and
 * is clamped rather than dropped; anything larger still reads as the real lag it is.
 */
const STAMP_INTERLEAVE_TOLERANCE_MS = 50

function lagToPreviousRead(observation: PageObservation, at: number): number | undefined {
  const reads = observation.responses.filter(isRead).map((event) => event.at)
  const prior = reads.filter((readAt) => readAt <= at + STAMP_INTERLEAVE_TOLERANCE_MS)
  if (prior.length === 0) return undefined
  return Math.max(0, at - Math.max(...prior))
}

/** Transitions that actually MOVED a chip — the initial empty snapshot is not one. */
function movingTransitions(observation: PageObservation): ChipTransition[] {
  return observation.transitions.filter((transition) => transition.state.length > 0)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length === 0
    ? Number.NaN
    : sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number)
}

describePosix('the post-processing chain on the built bundle behind the shipped dashboard', () => {
  it('(1) the arrival opens AT MOST one stream and paints the chain from durable state', () => {
    driveOk()
    expect(recorded.inProcess.length, 'k arms were measured').toBe(K)
    for (const [index, arm] of recorded.inProcess.entries()) {
      const streams = arm.requests.filter(isStream).length
      expect(
        arm.navigatedAt !== undefined && arm.browserVerdictAt !== undefined
        && arm.navigatedAt >= arm.browserVerdictAt && arm.navigatedAt - arm.browserVerdictAt < 2_000,
        `arm ${String(index)} (${arm.runId}) reached run detail `
        + `${String((arm.navigatedAt ?? 0) - (arm.browserVerdictAt ?? 0))}ms after its browser received the run-stream \`verdict\` frame. The page `
        + 'moves the viewer ON that envelope; an arrival seconds later is a different posture',
      ).toBe(true)
      expect(
        streams,
        `arm ${String(index)} (${arm.runId}) opened ${String(streams)} post-processing streams over the page's life. `
        + 'The client\'s `streamState` moves unopened → open → closed and never backwards, so a second '
        + `EventSource is impossible by construction — this is the cell that would notice. requests: `
        + `${JSON.stringify(arm.requests.map((request) => request.url.split('/').slice(-2).join('/')))}`,
      ).toBeLessThanOrEqual(1)
      // An arm that arrived mid-chain must have subscribed; an implication, as the race varies.
      if (!arm.firstReadTerminal) {
        expect(
          streams,
          `arm ${String(index)} (${arm.runId}) opened onto a chain that was STILL RUNNING and subscribed to `
          + 'nothing. The client opens the dedicated stream on any non-terminal read whose posture is '
          + '`drained` or absent, which is exactly this read',
        ).toBe(1)
      }
      expect(
        arm.requests.filter(isRead).length,
        `arm ${String(index)} (${arm.runId}) never read the route at all`,
      ).toBeGreaterThanOrEqual(1)
      expect(
        arm.painted,
        `arm ${String(index)} (${arm.runId}) did not paint two terminal chips. html: ${arm.html.slice(0, 400)}`,
      ).toEqual({
        analysis: expect.stringMatching(/^(?:complete|failed)$/u),
        curation: expect.stringMatching(/^(?:complete|failed)$/u),
      })
    }
  }, 60_000)

  it('(1b) PUSH beats POLL on the shipped dashboard: the stream carries the settle first', () => {
    driveOk()
    expect(recorded.differential.length, 'k arms were measured').toBe(K)
    for (const [index, arm] of recorded.differential.entries()) {
      expect(
        arm.streamStatus,
        `arm ${String(index)} (${arm.runId}): the shipped dashboard answered ${String(arm.streamStatus)} on its own `
        + 'post-processing stream. 503 here means the command composed a relay for one half of the '
        + 'threading and not the other, which is the missing-relay 503 one seam over',
      ).toBe(200)
      const chipFrames = arm.frames.filter((frame) => frame.type !== 'snapshot' && frame.type !== 'heartbeat')
      expect(
        chipFrames.length,
        `arm ${String(index)} (${arm.runId}) received NO chip frame on the dedicated stream, so the push channel `
        + `carried nothing this run drained. frames: ${JSON.stringify(arm.frames.map((frame) => frame.type))}`,
      ).toBeGreaterThan(0)
      expect(
        arm.streamSettledAt,
        `arm ${String(index)} (${arm.runId}) never saw analysis settle on the stream. `
        + `frames: ${JSON.stringify(arm.frames.map((frame) => frame.type))}`,
      ).toBeDefined()
      expect(arm.pollSettledAt, `arm ${String(index)} (${arm.runId}) never saw analysis settle by poll`).toBeDefined()
      const gap = (arm.pollSettledAt as number) - (arm.streamSettledAt as number)
      expect(
        gap,
        `arm ${String(index)} (${arm.runId}): the poller — running at the client's own `
        + `${String(POLL_MS)}ms period, started at the same instant — learned that analysis had settled `
        + `${String(gap)}ms after the stream did, over ${String(arm.pollReads)} reads. A non-positive number `
        + 'means the push channel told a subscriber nothing the poll floor had not already carried, '
        + 'which is what a silenced relay produces',
      ).toBeGreaterThan(0)
    }
  }, 120_000)

  it('(2) no socket: the SAME terminal words arrive by the durable read, with zero stream responses', () => {
    driveOk()
    expect(recorded.noSocket.length).toBe(K)
    for (const [index, arm] of recorded.noSocket.entries()) {
      // THE ROUTE IS INSTALLED BEFORE THE FIRST NAVIGATION AND STAYS FOR THE PAGE'S WHOLE LIFE, so
      // the push channel is unreachable for every millisecond this arm exists. Whether the client
      // ATTEMPTS one is its own decision: on a chain that is already terminal at the first read it
      // correctly attempts nothing, which makes this particular assertion a guard rather than a
      // measurement. The non-vacuous "settles with no socket" proof is cell (3) — a real daemon
      // draining for seconds while the page opens ZERO streams and moves its chips on its own
      // interval — and cell (4) for the return visit.
      expect(
        arm.responses.filter(isStream).length,
        `arm ${String(index)} (${arm.runId}) received a response on the aborted stream, so the abort did not take `
        + 'and this arm is measuring the push channel it exists to remove',
      ).toBe(0)
      // Against this run's own durable answer, so two runs settling differently cannot red it.
      expect(
        arm.painted,
        `arm ${String(index)} (${arm.runId}) painted ${JSON.stringify(arm.painted)} while the durable read said `
        + `${JSON.stringify(arm.durableChips)}. With the push channel unreachable the poll floor is the `
        + 'only channel there is, so a page that disagrees with the store has invented something',
      ).toEqual(arm.durableChips)
      expect(
        Object.values(arm.painted).every((word) => word === 'complete' || word === 'failed'),
        `arm ${String(index)} (${arm.runId}) never reached terminal words at all: ${JSON.stringify(arm.painted)}`,
      ).toBe(true)
      const lags = movingTransitions(arm)
        .map((transition) => lagToPreviousRead(arm, transition.at))
        .filter((lag): lag is number => lag !== undefined)
      expect(lags.length, `arm ${String(index)} recorded no timed transition`).toBeGreaterThan(0)
      const worst = Math.max(...lags)
      // EVERY PAINT FOLLOWS A READ IT COULD HAVE COME FROM. The poll FLOOR itself — a chain whose
      // chips move over several periods with no socket at all — is measured by cell (3), where a
      // real daemon drains for seconds and the page's only channel is its own interval.
      expect(
        worst,
        `arm ${String(index)} (${arm.runId}) painted a chip ${String(worst)}ms after the read that carried it. The floor `
        + `is ${String(POLL_MS)}ms and a render is not a network round trip, so anything past `
        + `${String(POLL_MS + 1_000)}ms means the page was not repainting off its own poll. lags: ${JSON.stringify(lags)}`,
      ).toBeLessThanOrEqual(POLL_MS + 1_000)
    }
  }, 60_000)

  it('(3) handedOff: a real daemon drains it, the page opens NO stream, and the chips settle by poll', () => {
    driveOk()
    const handed = recorded.handedOff
    expect(handed, `the hand-off posture was never measured. ${childContext()}`).toBeDefined()
    expect(
      handed!.requests.filter(isStream).length,
      'a run whose first read says `handedOff` can never receive a frame from THIS process, and the '
      + 'client is what must know that: the door would answer 204, but a request that was never made '
      + 'is the claim. requests: '
      + JSON.stringify(handed!.requests.map((request) => request.url.split('/').slice(-2).join('/'))),
    ).toBe(0)
    expect(handed!.firstReadHadDisposition, 'the page was opened after `runFinished` was durable').toBe(true)
    expect(
      handed!.requests.filter(isRead).length,
      'the chips settled without a poll, so nothing about the poll floor was measured here',
    ).toBeGreaterThan(1)
    expect(
      handed!.painted,
      `the daemon-drained chain did not settle on the page. html: ${handed!.html.slice(0, 400)}`,
    ).toEqual({ analysis: 'failed', curation: 'complete' })
  }, 120_000)

  it('(3b) the daemon-drained failure says who held the pen, and shows no error text', () => {
    driveOk()
    const handed = recorded.handedOff
    expect(handed, `the hand-off posture was never measured. ${childContext()}`).toBeDefined()
    // The daemon emits no chip envelope, so the record holds no failure line.
    for (const chip of ['analysisStarted', 'analysisFailed', 'curationStarted', 'curationCompleted']) {
      expect(
        recorded.handedOffEventTypes,
        `the daemon appended a ${chip} line to the run's record; if the daemon has learned to emit `
        + 'chips, this cell and FAILED_REASON_ABSENT_TEXT are both out of date',
      ).not.toContain(chip)
    }
    // The absent-reason sentence is on the card's outcome line, so the whole line is asserted.
    expect(
      handed!.analysisOutcome,
      'a failed stage with no recorded reason renders the absence, qualified by the posture that '
      + 'explains it — and nothing else on the line, because there is no reason to show and a '
      + 'producer\'s text appended here would be the lie by omission this rule refuses. '
      + `painted: ${handed!.html.slice(0, 400)}`,
    ).toBe(`${ANALYSIS_FAILED_PREFIX}${REASON_ABSENT_HANDED_OFF}`)
    expect(
      handed!.analysisRetry,
      'and the card claims no retry intent: no chip envelope was ever written, so there is no '
      + '`willRetry` to forward and a retry line here would be invented',
    ).toBeUndefined()
    expect(
      handed!.html.includes('pending'),
      'and the settled chip never reads `pending` — the other lie the absent-reason line replaces',
    ).toBe(false)
    // Clause values vary with durations and zone, so only the timing line's clauses count.
    expect(
      handed!.analysisTiming,
      'a settled stage card that renders no timing line at all is the SC3 gap returning: the reader '
      + 'of a finished run is told the stage failed and nothing about when or for how long. '
      + `outcome: ${JSON.stringify(handed!.analysisOutcome)}, painted: ${handed!.html.slice(0, 400)}`,
    ).toBeDefined()
    const timing = handed!.analysisTiming!
    expect(
      timingClauses(handed!.analysisTiming!)[0],
      'the line no longer opens on the queue moment as a two-digit wall clock, so the one instant a '
      + `reader can match against a log is gone or unreadable. line: ${JSON.stringify(timing)}`,
    ).toMatch(QUEUED_CLAUSE)
    expect(
      timingClauses(handed!.analysisTiming!).some((clause) => STARTED_AFTER_CLAUSE.test(clause)),
      'no clause says how long the stage waited before it started: the durable start instant is no '
      + 'longer reaching the card, or it arrives unreadable, and the queue wait a reader came for is '
      + `missing. line: ${JSON.stringify(timing)}`,
    ).toBe(true)
    expect(
      timingClauses(handed!.analysisTiming!).some((clause) => FINISHED_IN_CLAUSE.test(clause)),
      'no clause says how long the stage ran: the durable start instant is no longer reaching the '
      + 'card on a settled row, so a reader of a finished run learns only when it was queued — the '
      + `SC3 gap exactly. line: ${JSON.stringify(timing)}`,
    ).toBe(true)
    expect(
      handed!.analysisTiming,
      'the line printed a broken number or an unset field as if it were a measurement; an '
      + `unparseable instant must drop its clause, never render it. line: ${JSON.stringify(timing)}`,
    ).not.toMatch(/NaN|Invalid|undefined/u)
  }, 60_000)

  it('(4) return visit: exactly ONE read, no socket, painted terminal', () => {
    driveOk()
    const visit = recorded.returnVisit
    expect(visit, `the return visit was never measured. ${childContext()}`).toBeDefined()
    expect(visit!.firstReadTerminal, 'the run was already over when the visit opened').toBe(true)
    expect(
      visit!.requests.filter(isRead).length,
      'a return visit to a finished run is ONE read: no interval, no reconnect, nothing to clean up '
      + `but the disposer's own no-ops. requests: ${JSON.stringify(visit!.requests.map((r) => r.url.split('/').slice(-2).join('/')))}`,
    ).toBe(1)
    expect(
      visit!.requests.filter(isStream).length,
      'and no push channel: the first read was terminal, so there is nothing a frame could say',
    ).toBe(0)
    expect(visit!.painted).toEqual({
      analysis: expect.stringMatching(/^(?:complete|failed)$/u),
      curation: expect.stringMatching(/^(?:complete|failed)$/u),
    })
  }, 60_000)

  it("the RED run paints `analysis failed` with the producer's own masked reason", () => {
    driveOk()
    const red = recorded.redRun
    expect(red, `the red run was never measured. ${childContext()}`).toBeDefined()
    // The envelope is this dashboard's OWN emitter's — the failing attempt ran in-process, before
    // any daemon existed. Asserted on the record so "the page shows the producer's text" is a claim
    // about a real trail rather than about whatever the route happened to answer.
    expect(
      recorded.redRunEventTypes,
      'the in-process tail must have appended a real analysisFailed envelope for there to be a '
      + `reason to paint. recorded: ${JSON.stringify(recorded.redRunEventTypes)}`,
    ).toContain('analysisFailed')
    expect(red!.painted.analysis, `the analysis chip did not paint failed. html: ${red!.html.slice(0, 400)}`).toBe('failed')
    // The prefix is stripped and the masked reason is checked against the published absences.
    expect(
      red!.analysisOutcome,
      'a failed stage WITH a recorded reason paints the reason — never a blank, never `pending`',
    ).toBeDefined()
    expect(
      (red!.analysisOutcome ?? '').startsWith(ANALYSIS_FAILED_PREFIX),
      `the card's outcome line is not the stage's failure sentence: ${JSON.stringify(red!.analysisOutcome)}`,
    ).toBe(true)
    const redReason = (red!.analysisOutcome ?? '').slice(ANALYSIS_FAILED_PREFIX.length)
    expect(redReason.length, 'the painted reason is not empty').toBeGreaterThan(0)
    expect(
      redReason.length,
      `the text a browser is handed is the producer's bounded string, ${String(redReason.length)} `
      + 'chars here, and this page slices none of it',
    ).toBeLessThanOrEqual(500)
    expect(
      REASON_ABSENT_SENTENCES,
      'and it is the producer\'s OWN reason rather than the absence that stands in for a missing '
      + 'one. The two used to be separate elements, so reading one proved it was not the other; '
      + `they share a line now, so the cell tells them apart itself. read: ${JSON.stringify(redReason)}`,
    ).not.toContain(redReason)
    expect(
      red!.analysisRetry,
      'and the chain says whether it intends to try again — the line the projection paints only when '
      + 'the envelope carried `willRetry`, asserted against what the read route answered: '
      + `${JSON.stringify(recorded.redRunWillRetry)}`,
    ).toBe(recorded.redRunWillRetry === true ? WILL_RETRY_TEXT : undefined)
    expect(
      red!.painted.analysis,
      'never `pending` once the stage is terminal — the folded 399 todo\'s whole complaint',
    ).not.toBe('pending')
  }, 60_000)

  it('CONTROL: a COLD process with no dashboard running answers what the page painted', () => {
    driveOk()
    const cold = recorded.coldControl
    expect(cold, `the cold control was never measured. ${childContext()}`).toBeDefined()
    expect(
      cold!.exit,
      `\`agent-qa fn ${RUNS_POST_PROCESSING_FUNCTION_ID}\` exited ${String(cold!.exit)}. `
      + `stdout: ${JSON.stringify(cold!.stdout.slice(-800))}; stderr: ${JSON.stringify(cold!.stderr.slice(-800))}`,
    ).toBe(0)
    const painted = recorded.inProcess[recorded.inProcess.length - 1]?.painted
    expect(
      cold!.chips,
      'the chips a person read off the page are durable state, so a second composition — a fresh '
      + 'process, no server, no relay, no warm cache — must answer the same words. '
      + `cold: ${JSON.stringify(cold!.chips)}; painted: ${JSON.stringify(painted)}`,
    ).toEqual(painted)
  }, 60_000)
})
