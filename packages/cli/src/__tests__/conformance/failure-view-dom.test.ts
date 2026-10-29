/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` callbacks are compiled as
// TypeScript and EXECUTED in a browser — `run-detail-dom.test.ts`'s reasoning, unchanged.

// THE FAILURE VIEW, ON THE SURFACE A PERSON LOOKS AT (Phase 406 plan 10 · ANLZ-01 / DETL-04 /
// DETL-05, CONTEXT D-14 / D-17 / D-19 / D-20).
//
// WHAT THIS FILE IS THE ACCEPTANCE OF. Phase 406's four ROADMAP criteria are claims about a page:
// that `analyze-run` produces a verdict on a RED run, that per-member outcomes are painted beside
// the one aggregate, that the failure view renders the evidence-linked sentence, and that evidence
// whose bytes are gone reads `evidence-incomplete` rather than vanishing. Every one of those was
// proved a layer at a time upstream — in the op, in the route, in jsdom. This file measures all
// four on the BUILT bundle served by the SHIPPED `agent-qa dashboard` binary, against runs that
// binary really executed, because that is where the milestone's acceptance constraint puts them.
//
// TWO DASHBOARDS, THREE DRIVES. Drive R is a RED run whose analysis the stub AUTHORS (D-14) — the
// path the 399 defect lived on, enqueue → pump → op → route → page, now that 406-07 has fixed the
// egress guardrail that was reading a memory-relevance score as a credit card. The DELETION drive
// is Drive R's own run with one blob removed from under it, so the before/after comparison is of
// the SAME verdict rather than of two runs that merely resemble each other — which is what makes
// "the verdict was not re-graded" a measurable claim at all. Drive G is the green control on its
// own dashboard, torn down after R's.
//
// THE GREEN CONTROL ASSERTS COMPLETION AND ABSENCE, NEVER A SENTENCE. `resolveRunVerdicts` filters
// `passed | skipped | cancelled`, so a run with nothing to explain answers an empty `verdicts[]` by
// construction. A cell that looked for a sentence on green would be asserting the product's own
// definition back at it; what green is FOR here is that the chain still terminates `complete` and the
// page paints no block — the shape a regression that started explaining passing tests would break.
//
// TWO MEMBERS PER RUN, AND THE SECOND ONE IS NOT SYMMETRY. `showMemberChrome` is
// `members.length > 1`: below that threshold `MemberGroup` paints NO `data-member` wrapper and NO
// `data-member-outcome` badge, so on a one-member run the per-member outcome the second ROADMAP
// criterion is about is simply not in the document. Measured this session on the one-member recipe:
// `[data-member]` and `[data-member-outcome]` both answer the empty set. A cell asserting "every
// member wears its outcome" over that set would pass having measured nothing, which is the
// green-for-the-wrong-reason this directory exists to refuse. So both drives declare a SECOND test
// (`POPULATED_PASSING_STEP_TEXT`) and the stub's failing arm is narrowed to the failing step's own
// planning turns (`failOnlyStepText`) — additive knobs whose defaults leave every 405 caller
// byte-identical.
//
// A BROWSER THAT CANNOT LAUNCH IS A RED, NEVER A SKIP — 404-08's law, and there is no conditional
// skip in this file. Nor is a stale `dist` one: the bundle these cells read is built, and
// `buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)` refuses before anything is spawned. A suite that
// exits 0 having measured nothing is indistinguishable from one that measured everything.
//
// THE DRIVING HAPPENS ONCE, IN `beforeAll`, AND THE CELLS ASSERT ON WHAT IT RECORDED. The drive
// records and never asserts, so each named claim can be the only red under its own mutation — which
// is what 406-11 takes each fact away to prove.
//
// WHAT A RED ON (1d) MEANS, STATED BEFORE ANYONE IS TEMPTED TO NARROW IT. A declared value on the
// page, or a planted value inside the verdict the model wrote, is a leak through the fourth producer
// string on this page, and (1d) is the only cell in the repository that watches it on the shipped
// bundle. If one turns up, report the node and the value. It is not an occasion to weaken the scan.

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  RUNS_SUBDIR,
  RUN_EVIDENCE_BLOBS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import { MarkReceiptSchema, RunsMarkOutcomeSchema } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_ANALYSIS_DISCRIMINATOR,
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_EMAIL,
  POPULATED_FAILURE_QUOTE,
  POPULATED_FAILURE_STEP_MARKER,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_PASSING_STEP_TEXT,
  POPULATED_RUN_ANCHORED_BUILDS,
  POPULATED_SECRET_VALUE,
  RUN_BUDGET_MS,
  drivePopulatedRun,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
} from './populated-run-fixture.js'
import type { FixtureServer, PopulatedRunDrive, StubModelServer } from './populated-run-fixture.js'
import {
  PACKAGES_ROOT,
  buildFreshness,
  cleanupTempRoots,
  reserveEphemeralPort,
  spawnDashboard,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

// ---- The refusals ------------------------------------------------------------------------------

// NO PLATFORM SKIP — `run-detail-failure-dom.test.ts`'s refusal, applied to the same class of drive.
const WINDOWS_REFUSAL =
  'the spawned-binary cells in this directory are POSIX-only: the dashboard child is stopped with '
  + 'SIGTERM and the run writes a POSIX runtime root. This file reds rather than skipping on '
  + 'Windows, because a suite that exits 0 having measured nothing is indistinguishable from one '
  + 'that measured everything.'

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT dashboard UI served by the BUILT `agent-qa dashboard` and the built '
  + 'packages it resolves as external workspace dependencies: run `pnpm turbo run build --force` '
  + 'from the agent-qa root first. `--force` is required — a mutation script restores its subjects '
  + 'byte-identically, which turbo treats as a cache hit, so a plain build reports FULL TURBO and '
  + 'refreshes no dist mtime.'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium, against runs the shipped binary '
  + 'really executed: run `pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE '
  + 'SKIPPED WHEN THE BROWSER IS ABSENT — they are the acceptance of phase 406\'s four ROADMAP '
  + 'criteria, and a criterion nobody measured is a criterion nobody met.'

/** How long the page has to mount and paint the failure view. */
const PAGE_BUDGET_MS = 60_000

/** How long the post-run chain has to reach a terminal analysis chip. */
const CHAIN_BUDGET_MS = 120_000

// ---- Reading a published constant ---------------------------------------------------------------

/**
 * One source-level string body as the runtime would see it.
 *
 * `run-detail-failure-dom.test.ts`'s helper, carried here for its reason: a constant whose text
 * contains its own quote would otherwise come back carrying the backslash the source needed, and
 * nothing on the page would ever match it.
 */
function unescapeStringBody(body: string): string {
  const named: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0',
  }
  let out = ''
  let index = 0
  while (index < body.length) {
    const char = body[index] as string
    if (char !== '\\' || index + 1 >= body.length) {
      out += char
      index += 1
      continue
    }
    const next = body[index + 1] as string
    const braced = next === 'u' ? /^u\{([0-9a-fA-F]+)\}/u.exec(body.slice(index + 1)) : null
    const quad = next === 'u' ? /^u([0-9a-fA-F]{4})/u.exec(body.slice(index + 1)) : null
    const hex = next === 'x' ? /^x([0-9a-fA-F]{2})/u.exec(body.slice(index + 1)) : null
    const escape = braced ?? quad ?? hex
    if (escape !== null) {
      out += String.fromCodePoint(Number.parseInt(escape[1] as string, 16))
      index += 1 + escape[0].length
      continue
    }
    out += named[next] ?? next
    index += 2
  }
  return out
}

/**
 * A published constant, read out of the module that publishes it (WINDOWS #297, as 406-09 repaired
 * it: EITHER quote style, body unescaped).
 *
 * WHY THE COPY RATHER THAN AN IMPORT, in this file's own terms. Importing a `dashboard-ui` module
 * into a Node test would drag a renderer in; hardcoding the label would go on passing against a page
 * that says something else. Every copy assertion below therefore reads the shipped word out of the
 * shipped source and compares it to what the shipped bundle painted.
 */
function publishedConstant(relativePath: string, name: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const entry = new RegExp(
    `export const ${name}(?::\\s*string)?\\s*=\\s*(['"])((?:\\\\.|[^\\\\])*?)\\1`,
    'u',
  ).exec(source)
  if (entry === null) {
    throw new Error(
      `${name} is no longer a single- or double-quoted top-level constant in ${relativePath}`,
    )
  }
  return unescapeStringBody(entry[2] as string)
}

/** The provenance chip's first half when the model authored the verdict (D-10). */
const LLM_VERDICT_LABEL = publishedConstant('lib/analysis-view.ts', 'LLM_VERDICT_LABEL')

/** The word BOTH `evidence-incomplete` variants wear (406-05 · D-18). */
const EVIDENCE_INCOMPLETE_LABEL = publishedConstant('lib/run-detail-view.ts', 'EVIDENCE_INCOMPLETE_LABEL')

/**
 * The provenance line the block must read, composed from the SAME formula the product uses.
 *
 * `provenanceLabel` is a function, not a constant, so it cannot be read the way a label can. The
 * formula is therefore restated here — `${LLM_VERDICT_LABEL} · ${confidence.toFixed(2)}` — over the
 * label read by constant and the confidence the stub scripts, which is what keeps a copy change in
 * `analysis-view.ts` from being invisible to this cell while still not hardcoding the sentence.
 */
function expectedProvenance(confidence: number): string {
  return `${LLM_VERDICT_LABEL} · ${confidence.toFixed(2)}`
}

/**
 * The member-level count line, composed from `missingEvidenceLine`'s own formula (D-19).
 *
 * Same reasoning as {@link expectedProvenance}: the plural agrees with the TOTAL, because the noun
 * it modifies is the set the member cited rather than the subset that vanished.
 */
function expectedMissingEvidenceLine(missing: number, total: number): string {
  const noun = total === 1 ? 'cited artifact' : 'cited artifacts'
  return `${String(missing)} of ${String(total)} ${noun} unavailable`
}

/** The confidence the stub's `authored` arm scripts — the number the provenance must print. */
const AUTHORED_CONFIDENCE = 0.86

/** A 64-hex sha, the only name shape `FsEvidenceArtifactStore` addresses a blob by. */
const BLOB_SHA_RE = /^[0-9a-f]{64}$/u

// ---- What one visit records ---------------------------------------------------------------------

/** Everything one page visit harvested off the run-detail page. */
interface PageHarvest {
  /** Where the browser ended up — a bounce to `/live` would show here rather than as a hang. */
  readonly finalUrl: string
  /** Why the failure view never attached, when it never did. Recorded, so cells red on the FACT. */
  readonly waitFailure?: string
  /** Every `data-member` wrapper, in document order — empty when the run painted no chrome. */
  readonly members: readonly string[]
  /** Every member badge's RAW outcome word, in document order. */
  readonly memberOutcomes: readonly string[]
  /** `data-verdict-producer` of every block on the page, in document order. */
  readonly verdictProducers: readonly string[]
  /** `data-verdict-producer` of the blocks INSIDE `[data-member="0"]` — the join, measured. */
  readonly memberZeroProducers: readonly string[]
  /** `data-verdict-confidence`, as the block published it. */
  readonly verdictConfidences: readonly string[]
  /** Every `[data-verdict-sentence]`'s text — the op's own bytes, painted. */
  readonly sentences: readonly string[]
  /** Every `[data-verdict-provenance]`'s text. */
  readonly provenances: readonly string[]
  /** Every `[data-verdict-marker]`'s word — empty on a terminal chain (D-09 / D-11). */
  readonly markers: readonly string[]
  /** Every clickable cited artifact's sha. */
  readonly citedArtifacts: readonly string[]
  /** `<state>:<sha>` for every cited artifact rendered as an absence instead of a link. */
  readonly citedArtifactStates: readonly string[]
  /** Every `[data-evidence-missing]` count line, as `<attribute> :: <text>`. */
  readonly missingEvidence: readonly string[]
  /** Every unavailable state with the incomplete flag on the page (D-18). */
  readonly evidenceStates: readonly string[]
  /** Every `data-artifact-state` — the overview pane's own word. */
  readonly artifactStates: readonly string[]
  /** `<stage>=<status>` for every post-processing chip. */
  readonly chips: readonly string[]
  /** How many sub-action rows the tree painted — the harvest clicks the first. */
  readonly subActionCount: number
  /** Every non-blank text node under `<body>` — the medium a person reads. */
  readonly textNodes: readonly string[]
  /** `document.body.innerText`, for the whole-page containment questions. */
  readonly bodyText: string
  /** Every `[data-verdict-block]`'s own `textContent` — (1d)'s scoped subject. */
  readonly verdictBlockText: string
  /** Every artifact-byte URL this page asked for. */
  readonly artifactRequests: readonly string[]
  readonly artifactResponses: readonly string[]
  readonly playheadBeforeCitation: string | null
  readonly playheadAfterCitation: string | null
  readonly playerSource: string | null
  readonly playerImage: string | null
  readonly drawerOpened: boolean
}

/** One `analyze-run` job row, read out of the durable store after the dashboard exited. */
interface JobRow {
  readonly kind: string
  readonly status: string
  readonly attempts: number
  readonly last_failure_reason: string | null
}

/** Everything `beforeAll` measured, or the reason it could not. */
interface Recorded {
  mark?: MarkHarvest
  /** Drive R's own run. */
  red?: PopulatedRunDrive
  /** Drive R's terminal post-processing chips, off the read route. */
  redChips?: Record<string, string>
  /** Why the chain never settled, when it did not. */
  redChainFailure?: string
  /** `runs/<slug>/analysis.json`'s verdicts, as the durable file holds them. */
  analysisJsonVerdicts?: { perTest?: number; producer?: string; evidence?: unknown }[]
  /** Whether `analysis.json` exists at all. */
  analysisJsonExists: boolean
  /** Every row in `agent-jobs.db`. */
  jobRows: JobRow[]
  /** Which arm answered each stub request, in arrival order. */
  stubKinds: string[]
  /** `GET /api/runs/:id/analysis`, before and after the deletion. */
  analysisBefore?: AnalysisBody
  analysisAfter?: AnalysisBody
  /** `GET /api/runs/:id/detail`'s sub-action refs, before and after the deletion. */
  detailRefsBefore?: ArtifactRefWire[]
  detailRefsAfter?: ArtifactRefWire[]
  /** Every 64-hex blob the run wrote, read off disk before the unlink. */
  blobsOnDisk: string[]
  /** The one sha the deletion removed. */
  deletedSha?: string
  /** The unlink's own failure, when the path could not be removed. */
  deletionFailure?: string
  before?: PageHarvest
  after?: PageHarvest
  /** Drive G. */
  green?: PopulatedRunDrive
  greenChips?: Record<string, string>
  greenHarvest?: PageHarvest
  browserPresent: boolean
  redDashboardStderr?: string
  greenDashboardStderr?: string
  failure?: string
}

/** The `analysis.get` body as the wire carries it — only the fields these cells read. */
interface AnalysisBody {
  readonly verdicts?: {
    readonly perTest?: number
    readonly producer?: string
    readonly confidence?: number
    readonly evidence?: { readonly citedArtifacts?: ArtifactRefWire[] }
  }[]
  readonly sentences?: { readonly perTest?: number; readonly sentence?: string }[]
}

/** One artifact ref as either op serves it (D-01 / D-17). */
interface ArtifactRefWire {
  readonly id?: string
  readonly sha?: string
  readonly present?: boolean
  readonly evidenceIncomplete?: boolean
}

const recorded: Recorded = {
  analysisJsonExists: false,
  jobRows: [],
  stubKinds: [],
  blobsOnDisk: [],
  browserPresent: false,
}

let redTarget: FixtureServer | undefined
let redStub: StubModelServer | undefined
let redDashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let greenTarget: FixtureServer | undefined
let greenStub: StubModelServer | undefined
let greenDashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let browser: Browser | undefined
const contexts: BrowserContext[] = []

/** The context every failure message carries: what the two runs and the three visits did. */
function context(): string {
  const before = recorded.before
  const after = recorded.after
  const green = recorded.greenHarvest
  return [
    '',
    `mark drive: ${JSON.stringify(recorded.mark ?? null)}`,
    `red run: ${recorded.red?.runId ?? '(none)'}; finished: ${String(recorded.red?.finished ?? false)}; `
    + `last type: ${recorded.red?.lastType ?? '(none)'}`,
    `red chips: ${JSON.stringify(recorded.redChips ?? null)}; `
    + `chain failure: ${recorded.redChainFailure ?? '(none)'}`,
    `job rows: ${JSON.stringify(recorded.jobRows)}`,
    `stub arms: ${recorded.stubKinds.join(', ') || '(none)'}`,
    `analysis.json exists: ${String(recorded.analysisJsonExists)}; verdicts: `
    + `${JSON.stringify(recorded.analysisJsonVerdicts ?? null).slice(0, 500)}`,
    `blobs on disk: ${recorded.blobsOnDisk.join(', ') || '(none)'}; `
    + `deleted: ${recorded.deletedSha ?? '(none)'}; `
    + `deletion failure: ${recorded.deletionFailure ?? '(none)'}`,
    `analysis wire (before): ${JSON.stringify(recorded.analysisBefore ?? null).slice(0, 700)}`,
    `analysis wire (after): ${JSON.stringify(recorded.analysisAfter ?? null).slice(0, 700)}`,
    `detail refs (before): ${JSON.stringify(recorded.detailRefsBefore ?? null).slice(0, 400)}`,
    `detail refs (after): ${JSON.stringify(recorded.detailRefsAfter ?? null).slice(0, 400)}`,
    `chromium present: ${String(recorded.browserPresent)}`,
    `red page: url ${before?.finalUrl ?? '(never opened)'}; `
    + `wait failure: ${before?.waitFailure?.split('\n')[0] ?? '(none)'}; `
    + `members [${(before?.members ?? []).join(', ')}]; `
    + `outcomes [${(before?.memberOutcomes ?? []).join(', ')}]; `
    + `producers [${(before?.verdictProducers ?? []).join(', ')}]; `
    + `member-0 producers [${(before?.memberZeroProducers ?? []).join(', ')}]; `
    + `provenance [${(before?.provenances ?? []).join(' | ')}]; `
    + `markers [${(before?.markers ?? []).join(', ')}]; `
    + `cited [${(before?.citedArtifacts ?? []).join(', ')}]; `
    + `cited states [${(before?.citedArtifactStates ?? []).join(', ')}]; `
    + `artifact states [${(before?.artifactStates ?? []).join(', ')}]; `
    + `chips [${(before?.chips ?? []).join(', ')}]; `
    + `sub-actions ${String(before?.subActionCount ?? 0)}; `
    + `artifact requests ${String((before?.artifactRequests ?? []).length)}`,
    `red sentence: ${JSON.stringify((before?.sentences ?? []).join(' | ').slice(0, 500))}`,
    `red page after deletion: `
    + `wait failure: ${after?.waitFailure?.split('\n')[0] ?? '(none)'}; `
    + `outcomes [${(after?.memberOutcomes ?? []).join(', ')}]; `
    + `producers [${(after?.verdictProducers ?? []).join(', ')}]; `
    + `cited [${(after?.citedArtifacts ?? []).join(', ')}]; `
    + `cited states [${(after?.citedArtifactStates ?? []).join(', ')}]; `
    + `evidence states [${(after?.evidenceStates ?? []).join(', ')}]; `
    + `artifact states [${(after?.artifactStates ?? []).join(', ')}]; `
    + `missing [${(after?.missingEvidence ?? []).join(' | ')}]; `
    + `artifact requests ${JSON.stringify(after?.artifactRequests ?? [])}`,
    `green run: ${recorded.green?.runId ?? '(none)'}; `
    + `finished: ${String(recorded.green?.finished ?? false)}; `
    + `chips: ${JSON.stringify(recorded.greenChips ?? null)}; `
    + `page chips [${(green?.chips ?? []).join(', ')}]; `
    + `outcomes [${(green?.memberOutcomes ?? []).join(', ')}]; `
    + `blocks ${String((green?.verdictProducers ?? []).length)}; `
    + `wait failure: ${green?.waitFailure?.split('\n')[0] ?? '(none)'}`,
    recorded.failure === undefined ? '' : `drive failure: ${recorded.failure}`,
    `red dashboard stderr: ${(recorded.redDashboardStderr ?? '').slice(-900)}`,
    `green dashboard stderr: ${(recorded.greenDashboardStderr ?? '').slice(-900)}`,
  ].join('\n')
}

/** The recorded drive, or a failure the cells report with their own message. */
function driveOk(): void {
  expect(
    recorded.failure,
    `the measurement drive stopped early. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeUndefined()
}

/** One harvest, asserted present so every cell below reads a real page. */
function harvestOf(which: 'before' | 'after' | 'greenHarvest'): PageHarvest {
  driveOk()
  const held = recorded[which]
  expect(
    held,
    `the ${which} run-detail page was never observed. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeDefined()
  return held as PageHarvest
}

// ---- The instruments ----------------------------------------------------------------------------

interface MarkHarvest {
  historyChoice: string | null
  historyDisposition: string | null
  elapsedMs: number
  rows: unknown[]
  disposition?: unknown
  hostileElements: number
  approvalSeen: boolean
  dialogCountAtApproval?: number
  /** 432-14: how many run-confirm streams the page opened. The channel is deleted, so zero. */
  confirmChannels: number
  previewStatus?: number
  responseStatus?: number
  responseBody?: unknown
  confirmFrames: Array<{ event: string; data: string }>
  markedAtWithinDrive: boolean
  /** 432-42 (D-25): the new history entry's text, its controls and its applied line. */
  historyText?: string
  historyControls?: number
  historyApplied?: number
  failure?: string
}

/** Record independently: an absent feedback entry may red (4a), never abort the older ten cells. */
async function observeMark(context_: BrowserContext, origin: string, runId: string, runDir: string): Promise<MarkHarvest> {
  const page = await context_.newPage()
  const harvest: MarkHarvest = { historyChoice: null, historyDisposition: null, elapsedMs: 0, rows: [],
    hostileElements: 0, approvalSeen: false, confirmChannels: 0, confirmFrames: [], markedAtWithinDrive: false }
  const started = Date.now()
  try {
    await page.addInitScript(() => {
      const frames: Array<{ event: string; data: string }> = []
      const channels: string[] = []
      ;(window as unknown as { markFrames: typeof frames }).markFrames = frames
      ;(window as unknown as { markChannels: typeof channels }).markChannels = channels
      const Native = window.EventSource
      class RecordedChannel extends Native {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init)
          if (String(url).includes('run-confirm')) channels.push(String(url))
          if (String(url) === '/api/run-confirm/channel') {
            for (const event of ['confirm_scope', 'confirm_request', 'confirm_resolved']) {
              this.addEventListener(event, frame => frames.push({ event,
                data: (frame as MessageEvent<string>).data }))
            }
          }
        }
      }
      window.EventSource = RecordedChannel
    })
    page.on('response', reply => {
      if (reply.request().method() !== 'POST') return
      if (reply.url().endsWith('/mark')) harvest.responseStatus = reply.status()
      if (reply.url().endsWith('/mark-preview')) harvest.previewStatus = reply.status()
    })
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    // 432-14 (D-14): the page opens no confirm stream any more, so presence is the entry itself.
    await page.locator('[data-feedback-entry="test"]').click({ timeout: 10_000 })
    const composer = page.locator('[data-feedback-composer]')
    await composer.locator('[data-feedback-choice="false-fail"] [role="radio"]').click({ timeout: 10_000 })
    await composer.locator('[data-feedback-note]').fill('<img data-agent-qa-hostile-mark src=x onerror=alert(1)>')
    await composer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor({ timeout: 15_000 })
    const response = page.waitForResponse(reply => reply.url().endsWith('/mark') && reply.request().method() === 'POST')
      .catch(() => undefined)
    await composer.locator('[data-feedback-submit]').click()
    // 432-13: the mark is sent on the click; `approvalSeen` records whether an approval group rendered.
    const reply = await response
    harvest.approvalSeen = await composer.locator('[data-feedback-approval]').count() > 0
    harvest.confirmChannels = (await page.evaluate(() =>
      (window as unknown as { markChannels: string[] }).markChannels)).length
    harvest.dialogCountAtApproval = await page.evaluate(() =>
      document.querySelectorAll('[role="dialog"],[aria-modal]').length)
    if (reply === undefined) throw new Error('mark route returned no response')
    harvest.responseBody = await reply.json()
    const result = RunsMarkOutcomeSchema.parse(harvest.responseBody)
    if (result.kind !== 'marked') throw new Error(`mark did not persist: ${result.kind}`)
    harvest.disposition = result.receipt.disposition
    const entry = composer.locator('[data-feedback-history="target"] [data-history-entry][data-history-new]')
    await entry.waitFor({ timeout: 15_000 })
    harvest.historyChoice = await entry.locator(':scope > div:first-child .font-medium').textContent()
    harvest.historyDisposition = await entry.locator('[data-history-disposition]').textContent()
    harvest.historyText = (await entry.textContent()) ?? ''
    harvest.historyControls = await entry.locator('button, a, [role="button"], [role="link"]').count()
    harvest.historyApplied = await entry.locator('[data-history-applied]').count()
    harvest.hostileElements = await page.locator('[data-agent-qa-hostile-mark]').count()
  } catch (error) {
    harvest.failure = error instanceof Error ? error.message : String(error)
  } finally {
    const ended = Date.now()
    harvest.elapsedMs = ended - started
    const ledger = join(runDir, 'marks.jsonl')
    harvest.rows = existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => MarkReceiptSchema.parse(JSON.parse(line))) : []
    const markedAt = (harvest.rows[0] as { markedAt?: number } | undefined)?.markedAt
    harvest.markedAtWithinDrive = markedAt !== undefined && markedAt >= started && markedAt <= ended
    harvest.confirmFrames = await page.evaluate(() =>
      (window as unknown as { markFrames: Array<{ event: string; data: string }> }).markFrames ?? [])
      .catch(() => [])
    await page.close()
  }
  process.stderr.write(`419 mark fixture: ${JSON.stringify(harvest)}\n`)
  return harvest
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  budgetMs: number,
  everyMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((tick) => { setTimeout(tick, everyMs) })
  }
}

/** The post-processing read route's own body — `post-processing-dom.test.ts`'s shape. */
interface ChainBody {
  status: { chips: Record<string, string>; notification?: unknown }
}

async function readChain(origin: string, runId: string): Promise<ChainBody | undefined> {
  return await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/post-processing`)
    .then(async (response) => await response.json() as ChainBody)
    .catch(() => undefined)
}

/** The door's own terminal rule, restated over a read body the way the client restates it. */
function chainTerminal(body: ChainBody | undefined): boolean {
  if (body === undefined) return false
  if (body.status.notification !== undefined) return true
  const settled = (chip: string | undefined): boolean => chip === 'complete' || chip === 'failed'
  return settled(body.status.chips.analysis) && settled(body.status.chips.curation)
}

/**
 * Open one run's detail page and harvest everything three drives read.
 *
 * THE SUB-ACTION IS CLICKED, because the overview's decision-screenshot pane renders for the
 * SELECTED sub-action and nothing is selected on arrival — measured this session: a page harvested
 * without the click answers `[data-artifact-state]` the empty set and reads "No screenshot
 * captured", which would make (1c) and (3b) claims about a pane that was never mounted.
 *
 * EVERY WAIT RECORDS RATHER THAN THROWS, and the harvest runs whatever happened —
 * `run-detail-dom.test.ts`'s law. A timeout is a fact about the page, and the cells red on the
 * missing FACT with the whole observation quoted.
 */
async function observeRunDetail(
  context_: BrowserContext,
  origin: string,
  runId: string,
  /** What must attach before the harvest — the failure view on red, a member badge on green. */
  settleSelector: string,
): Promise<PageHarvest> {
  const page: Page = await context_.newPage()
  let waitFailure: string | undefined
  const requests: string[] = []
  const responses: string[] = []
  let playheadBeforeCitation: string | null = null
  page.on('request', (request) => { requests.push(request.url()) })
  page.on('response', response => { if (response.ok()) responses.push(response.url()) })
  try {
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    await page.locator(settleSelector).first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch((error: unknown) => {
        waitFailure = error instanceof Error ? error.message : String(error)
      })

    const subActions = page.locator('[data-sub-action]')
    if ((await subActions.count()) > 0) {
      await subActions.first().locator('button').first().click().catch(() => undefined)
      await page.locator('[data-player] [data-slot="toggle-group-item"]').filter({ hasText: /^Frames$/ }).click()
    }

    const citation = page.locator('[data-cited-artifact]').first()
    if (await citation.count()) {
      await page.locator('[data-player] [data-slot="toggle-group-item"]').filter({ hasText: /^Video$/ }).click()
      await page.locator('[data-sub-action]').first().locator('button').first().focus()
      await page.keyboard.press('Escape')
      playheadBeforeCitation = await page.locator('[data-playhead-row]').getAttribute('data-sub-action-id').catch(() => null)
      await page.getByRole('tab', { name: /^Network/ }).click()
      await citation.click()
    }

    // The screenshot pane is the one fact whose completion is a NETWORK event rather than a paint:
    // wait for the pane to settle into either state before reading which one it settled into.
    await waitUntil(
      async () => (await page.locator('[data-artifact-state]').count()) > 0,
      PAGE_BUDGET_MS,
      50,
    )
    // And then for the bytes, when the pane claims they are there.
    await waitUntil(
      async () => {
        const src = await page.locator('[data-artifact-state="available"] img').first()
          .getAttribute('src').catch(() => null)
        if (src === null) return true
        return responses.some((url) => url.endsWith(src))
      },
      PAGE_BUDGET_MS,
      50,
    )

    const harvested = await page.evaluate(() => {
      const nodes: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? ''
        if (value.trim() !== '') nodes.push(value)
      }
      const attribute = (selector: string, name: string): string[] =>
        Array.from(document.querySelectorAll(selector))
          .map((element) => element.getAttribute(name) ?? '?')
      const text = (selector: string): string[] =>
        Array.from(document.querySelectorAll(selector))
          .map((element) => (element.textContent ?? '').trim())
      return {
        playheadAfterCitation: document.querySelector('[data-playhead-row]')?.getAttribute('data-sub-action-id') ?? null,
        playerSource: document.querySelector('[data-player]')?.getAttribute('data-player-source') ?? null,
        playerImage: document.querySelector('[data-player] img')?.getAttribute('src') ?? null,
        drawerOpened: document.querySelector('[data-slot="sheet-content"]') !== null,
        members: attribute('[data-member]', 'data-member'),
        memberOutcomes: attribute('[data-member-outcome]', 'data-member-outcome'),
        verdictProducers: attribute('[data-verdict-block]', 'data-verdict-producer'),
        memberZeroProducers: attribute(
          '[data-member="0"] [data-verdict-block]',
          'data-verdict-producer',
        ),
        verdictConfidences: attribute('[data-verdict-block]', 'data-verdict-confidence'),
        sentences: text('[data-verdict-sentence]'),
        provenances: text('[data-verdict-provenance]'),
        markers: attribute('[data-verdict-marker]', 'data-verdict-marker'),
        citedArtifacts: attribute('[data-cited-artifact]', 'data-cited-artifact'),
        citedArtifactStates: Array.from(
          document.querySelectorAll('[data-cited-artifact-state]'),
        ).map((element) =>
          `${element.getAttribute('data-cited-artifact-state') ?? '?'}:`
          + `${element.getAttribute('data-cited-artifact-sha') ?? '?'}`),
        missingEvidence: Array.from(document.querySelectorAll('[data-evidence-incomplete]:not([data-evidence-state])')).map(
          (element) =>
            `${element.getAttribute('data-evidence-incomplete') ?? '?'} :: `
            + `${(element.textContent ?? '').trim()}`,
        ),
        evidenceStates: attribute('[data-evidence-state="unavailable"][data-evidence-incomplete]', 'data-evidence-state'),
        artifactStates: attribute('[data-artifact-state]', 'data-artifact-state'),
        chips: Array.from(document.querySelectorAll('[data-chip]')).map((element) =>
          `${element.getAttribute('data-chip') ?? '?'}=`
          + `${element.getAttribute('data-chip-status') ?? '?'}`),
        subActionCount: document.querySelectorAll('[data-sub-action]').length,
        textNodes: nodes,
        bodyText: document.body.innerText,
        verdictBlockText: Array.from(document.querySelectorAll('[data-verdict-block]'))
          .map((element) => element.textContent ?? '')
          .join('\n'),
      }
    })

    return {
      finalUrl: page.url(),
      ...(waitFailure === undefined ? {} : { waitFailure }),
      ...harvested,
      artifactRequests: requests.filter((url) => url.includes('/artifacts/')),
      artifactResponses: responses.filter((url) => url.includes('/artifacts/')),
      playheadBeforeCitation,
    }
  } finally {
    await page.close()
  }
}

/** Read every row of a run's durable job store, after the process that owns it exited. */
function readJobRows(agentQaRoot: string): JobRow[] {
  const path = join(agentQaRoot, 'agent-jobs.db')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db
      .prepare('SELECT kind, status, attempts, last_failure_reason FROM jobs')
      .all() as unknown as JobRow[]
  } finally {
    db.close()
  }
}

// ---- The drives ---------------------------------------------------------------------------------

describe('the shipped dashboard paints a RED run\'s authored verdict, its evidence and its absence', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      recorded.failure = WINDOWS_REFUSAL
      return
    }
    try {
      recorded.browserPresent = existsSync(chromium.executablePath())
    } catch {
      recorded.browserPresent = false
    }

    // FIRST, AND BEFORE ANYTHING IS SPAWNED OR SERVED: a stale build measures the previous commit,
    // and the bundle these cells read is `dashboard-ui/dist`.
    const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
    if (freshness.missing.length > 0 || freshness.stale.length > 0) {
      recorded.failure =
        `${REBUILD_INSTRUCTION} missing: ${freshness.missing.join(', ') || '(none)'}; `
        + `stale: ${freshness.stale.join(', ') || '(none)'}`
      return
    }

    try {
      browser = await chromium.launch({ headless: true })
    } catch (error) {
      recorded.failure =
        `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
        + `${error instanceof Error ? error.message : String(error)}`
      return
    }

    // ---- DRIVE R: the red run whose analysis the model AUTHORS (D-14) ------------------------
    try {
      redTarget = await startTargetPageServer()
      redStub = await startStubModelServer({
        plannerOutcome: 'stepFailed',
        failOnlyStepText: POPULATED_FAILURE_STEP_MARKER,
        analysisOutcome: 'authored',
      })
      const project = populatedRunFixtureProject(
        'failure-view-red',
        { modelBaseUrl: redStub.baseUrl, targetUrl: redTarget.url },
        { stepText: POPULATED_FAILURE_STEP_TEXT, secondStepText: POPULATED_PASSING_STEP_TEXT },
      )
      // The stub can only cite the run's REAL sha once the root exists, which is why this is a
      // setter and not an option — the project's config names the stub's port, so the stub is
      // listening before the root is minted.
      redStub.citeEvidenceFrom(project.agentQaRoot)

      const redPort = await reserveEphemeralPort()
      redDashboard = await spawnDashboard(
        project.root,
        project.configPath,
        redPort,
        60_000,
        populatedRunSpawnEnv(),
      )
      if (!redDashboard.ready) {
        recorded.redDashboardStderr = redDashboard.stderr()
        recorded.failure = 'the spawned `agent-qa dashboard` never said it was listening (red drive)'
        return
      }

      recorded.red = await drivePopulatedRun(redDashboard, project, RUN_BUDGET_MS)
      const runId = recorded.red.runId
      const origin = redDashboard.origin

      const settled = await waitUntil(
        async () => chainTerminal(await readChain(origin, runId)),
        CHAIN_BUDGET_MS,
        200,
      )
      const chain = await readChain(origin, runId)
      recorded.redChips = chain?.status.chips
      if (!settled) {
        recorded.redChainFailure =
          `the post-processing chain never reached a terminal analysis chip inside ${
            String(CHAIN_BUDGET_MS)}ms`
      }

      const analysisOf = async (): Promise<AnalysisBody | undefined> =>
        await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/analysis`)
          .then(async (response) => await response.json() as AnalysisBody)
          .catch(() => undefined)
      const detailRefsOf = async (): Promise<ArtifactRefWire[] | undefined> =>
        await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/detail`)
          .then(async (response) => {
            const body = await response.json() as {
              subActions?: { artifactRefs?: ArtifactRefWire[] }[]
            }
            return (body.subActions ?? []).flatMap((entry) => entry.artifactRefs ?? [])
          })
          .catch(() => undefined)

      recorded.analysisBefore = await analysisOf()
      recorded.detailRefsBefore = await detailRefsOf()

      const runDir = join(project.agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
      const blobsDir = join(runDir, RUN_EVIDENCE_BLOBS_SUBDIR)
      recorded.blobsOnDisk = existsSync(blobsDir)
        ? readdirSync(blobsDir).filter((name) => BLOB_SHA_RE.test(name))
        : []
      const analysisPath = join(runDir, 'analysis.json')
      recorded.analysisJsonExists = existsSync(analysisPath)
      if (recorded.analysisJsonExists) {
        recorded.analysisJsonVerdicts = (
          JSON.parse(readFileSync(analysisPath, 'utf8')) as {
            verdicts?: { perTest?: number; producer?: string; evidence?: unknown }[]
          }
        ).verdicts
      }
      recorded.stubKinds = redStub.requests.map((request) => request.kind)

      const beforeContext = await browser.newContext()
      contexts.push(beforeContext)
      recorded.before = await observeRunDetail(
        beforeContext,
        origin,
        runId,
        '[data-verdict-block]',
      )

      // 419 Wave-0 probe/mark drive: while the original evidence bytes are still available.
      recorded.mark = await observeMark(beforeContext, origin, runId, runDir)

      // ---- THE DELETION (D-20) --------------------------------------------------------------
      //
      // THE ONLY "GC" THAT EXISTS. No retention policy ships, and none is introduced here: the
      // path is composed from THIS fixture project's own runtime root, this run's slug and the sha
      // the verdict cited, and it is asserted to be inside the project before anything is removed
      // (T-406-28). One blob, in a directory the teardown deletes wholesale a moment later.
      const sha = recorded.analysisBefore?.verdicts?.[0]?.evidence?.citedArtifacts?.[0]?.sha
      if (sha === undefined) {
        recorded.deletionFailure = 'the authored verdict cited no evidence blob to delete'
      } else {
        const blobPath = join(blobsDir, sha)
        if (!blobPath.startsWith(project.root)) {
          recorded.deletionFailure =
            `refusing to unlink ${blobPath}: it is outside the fixture project ${project.root}`
        } else {
          try {
            unlinkSync(blobPath)
            recorded.deletedSha = sha
          } catch (error) {
            recorded.deletionFailure =
              `the blob could not be unlinked: ${
                error instanceof Error ? error.message : String(error)}`
          }
        }
      }

      recorded.analysisAfter = await analysisOf()
      recorded.detailRefsAfter = await detailRefsOf()

      // A NEW CONTEXT, not a reload: the claim is what a person arriving at this URL is shown once
      // the bytes are gone, and a warm client cache would answer the previous question.
      const afterContext = await browser.newContext()
      contexts.push(afterContext)
      recorded.after = await observeRunDetail(
        afterContext,
        origin,
        runId,
        '[data-verdict-block]',
      )

      recorded.redDashboardStderr = redDashboard.stderr()
      await redDashboard.stop()
      await redStub.close()
      await redTarget.close()
      redDashboard = undefined
      redStub = undefined
      redTarget = undefined
      recorded.jobRows = readJobRows(project.agentQaRoot)
    } catch (error) {
      recorded.failure = error instanceof Error ? error.message : String(error)
      return
    }

    // ---- DRIVE G: the green control, on its own dashboard ------------------------------------
    try {
      greenTarget = await startTargetPageServer()
      greenStub = await startStubModelServer()
      const project = populatedRunFixtureProject(
        'failure-view-green',
        { modelBaseUrl: greenStub.baseUrl, targetUrl: greenTarget.url },
        { secondStepText: POPULATED_PASSING_STEP_TEXT },
      )
      const greenPort = await reserveEphemeralPort()
      greenDashboard = await spawnDashboard(
        project.root,
        project.configPath,
        greenPort,
        60_000,
        populatedRunSpawnEnv(),
      )
      if (!greenDashboard.ready) {
        recorded.greenDashboardStderr = greenDashboard.stderr()
        recorded.failure =
          'the spawned `agent-qa dashboard` never said it was listening (green drive)'
        return
      }
      recorded.green = await drivePopulatedRun(greenDashboard, project, RUN_BUDGET_MS)
      const origin = greenDashboard.origin
      const runId = recorded.green.runId
      await waitUntil(
        async () => chainTerminal(await readChain(origin, runId)),
        CHAIN_BUDGET_MS,
        200,
      )
      recorded.greenChips = (await readChain(origin, runId))?.status.chips

      const greenContext = await browser.newContext()
      contexts.push(greenContext)
      recorded.greenHarvest = await observeRunDetail(
        greenContext,
        origin,
        runId,
        '[data-member-outcome]',
      )
      recorded.greenDashboardStderr = greenDashboard.stderr()
      await greenDashboard.stop()
      greenDashboard = undefined
    } catch (error) {
      recorded.failure = error instanceof Error ? error.message : String(error)
    }
  }, RUN_BUDGET_MS * 2 + 480_000)

  afterAll(async () => {
    for (const held of contexts) await held.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await redDashboard?.stop()
    await greenDashboard?.stop()
    await redStub?.close()
    await greenStub?.close()
    await redTarget?.close()
    await greenTarget?.close()
    cleanupTempRoots()
  })

  // ---- (1) THE RED RUN, AUTHORED AND PAINTED ----------------------------------------------------

  it('(1a) the producer: the shipped binary AUTHORED this red run\'s verdict, and the job says so', () => {
    driveOk()
    expect(
      recorded.red?.finished,
      'the red run never reached `runFinished` inside the budget. The `stepFailed` knob sets a plan '
      + 'field on the planner\'s tool call and nothing else; a run that never finishes means the '
      + `loop took a different path, not that the fixture asked for one.${context()}`,
    ).toBe(true)
    expect(
      recorded.redChainFailure,
      `the post-processing chain never settled, so there is no authored verdict to measure.${context()}`,
    ).toBeUndefined()

    const analyze = recorded.jobRows.filter((row) => row.kind === 'analyze-run')
    expect(
      analyze.length,
      `the durable job store holds no \`analyze-run\` row for this run.${context()}`,
    ).toBe(1)
    const row = analyze[0] as JobRow
    expect(
      row.status,
      'the `analyze-run` job did not complete. THIS IS THE ANLZ-01 DEFECT\'S OWN SIGNATURE: the 399 '
      + 'runs left this row `failed` with `handler-threw: Guardrail blocked outbound prompt leaf: '
      + 'creditCard`, because the egress guardrail read a memory-relevance score as a card. Read '
      + `\`last_failure_reason\` in the block below before concluding anything else.${context()}`,
    ).toBe('done')
    expect(
      row.last_failure_reason,
      `the \`analyze-run\` job completed but recorded a failure reason.${context()}`,
    ).toBeNull()
    expect(
      row.attempts,
      'the `analyze-run` job needed more than one attempt. A retry means the handler threw at least '
      + `once, which is the shape ANLZ-01 wore.${context()}`,
    ).toBe(1)

    expect(
      recorded.analysisJsonExists,
      `the run wrote no \`analysis.json\`, so nothing durable carries a verdict.${context()}`,
    ).toBe(true)
    const verdicts = recorded.analysisJsonVerdicts ?? []
    expect(
      verdicts.length,
      `\`analysis.json\` holds no verdict for the one failed member.${context()}`,
    ).toBe(1)
    expect(
      verdicts[0]?.producer,
      'the persisted verdict was NOT authored by the model — it carries the deterministic floor\'s '
      + 'producer. The stub answered the author\'s own request shape with a contract-valid object, '
      + 'so a floor here means the answer was rejected, the request never reached the model, or the '
      + `handler degraded.${context()}`,
    ).toBe('analyze-run')

    expect(
      recorded.stubKinds.filter((kind) => kind === 'analysis').length,
      'the stub did not answer exactly one analyze-run AUTHOR request. Zero means the author never '
      + 'called; more than one means the first answer was rejected and the author asked for a '
      + `repair, so the verdict on the page is not the one this fixture scripted.${context()}`,
    ).toBe(1)

    // AND THE CITED SHA IS THE RUN'S OWN. The stub reads the blobs the run in flight wrote, so a
    // fabricated or empty citation would leave (1c) and the whole deletion drive with nothing to
    // take away.
    const cited = recorded.analysisBefore?.verdicts?.[0]?.evidence?.citedArtifacts ?? []
    expect(
      cited.length,
      `the authored verdict cited no artifact, so the evidence link has nothing to open.${context()}`,
    ).toBe(1)
    expect(
      BLOB_SHA_RE.test(cited[0]?.sha ?? ''),
      `the cited artifact's sha is not a 64-hex blob name: ${JSON.stringify(cited[0])}${context()}`,
    ).toBe(true)
    expect(
      recorded.blobsOnDisk,
      'the sha the verdict cited is not one this run actually wrote to `runs/<slug>/blobs/`.'
      + `${context()}`,
    ).toContain(cited[0]?.sha)
    expect(
      cited[0]?.present,
      `the wire does not say the cited artifact's bytes are present BEFORE the deletion.${context()}`,
    ).toBe(true)
  })

  it('(1b) the DOM: member 0 wears an `analyze-run` block whose provenance reads the LLM verdict line', () => {
    const page = harvestOf('before')
    expect(
      page.waitFailure,
      'the failure view never attached to the run-detail page. The run failed with an authored '
      + 'verdict on the wire, so either the analysis route answered nothing, the projection dropped '
      + `the member, or the page stopped rendering the block.${context()}`,
    ).toBeUndefined()

    // THE JOIN, MEASURED. `[data-member="0"]` is `RunDetailMember.testIndex`, which is the op's
    // `perTest` — the key `projectAnalysisView` folds on. A block on the page under the WRONG
    // member is a mis-join no whole-page count can see.
    expect(
      page.memberZeroProducers,
      'the block inside `[data-member="0"]` is not the model\'s. Three things read this way and the '
      + 'received value below says which: an EMPTY list means no member chrome was painted (a '
      + 'one-member run paints none — this fixture declares two on purpose) or the verdict joined a '
      + 'different member handle than the one that failed; `deterministic-classifier` means the '
      + `author degraded to the floor and ANLZ-01's symptom is back on the page.${context()}`,
    ).toEqual(['analyze-run'])
    expect(
      page.verdictProducers,
      'the page painted more or fewer verdict blocks than the one failed member has. A passed or '
      + `skipped member has no verdict by construction and must render none.${context()}`,
    ).toEqual(['analyze-run'])

    expect(
      page.markers,
      'the block carries a lifecycle marker on a TERMINAL chain. `markerFor` answers nothing for '
      + '`complete`; a marker here means the page is keyed off something other than the chip word.'
      + `${context()}`,
    ).toEqual([])

    expect(
      page.provenances,
      'the provenance line is not the LLM-verdict reading. It is composed here from the label read '
      + 'out of `lib/analysis-view.ts` and `confidence.toFixed(2)` — the product\'s own formula — so '
      + 'a red is either a copy change, a producer that is not `analyze-run`, or a confidence the '
      + `stub did not script.${context()}`,
    ).toEqual([expectedProvenance(AUTHORED_CONFIDENCE)])
    expect(
      page.verdictConfidences,
      `the block published a confidence other than the one the model authored.${context()}`,
    ).toEqual([String(AUTHORED_CONFIDENCE)])

    const sentence = page.sentences.join(' | ')
    expect(
      sentence,
      'the painted sentence does not quote the grounding the model cited. The quote is a verbatim '
      + 'contiguous substring of the failing step text, which is what `validateAnalysisAgainstHandoff` '
      + `demands; its absence means the sentence on the page is not this verdict's.${context()}`,
    ).toContain(POPULATED_FAILURE_QUOTE)
    expect(
      sentence,
      'the painted sentence does not carry the discriminator the model authored — the clause that '
      + `says what distinguishes THIS failure from its neighbours.${context()}`,
    ).toContain(POPULATED_ANALYSIS_DISCRIMINATOR)
    expect(
      sentence,
      'the page composed its own sentence instead of painting the op\'s. `analysis.get` is THE '
      + `single producer of a run's verdict sentences; the page copies its bytes through.${context()}`,
    ).toBe((recorded.analysisBefore?.sentences ?? []).map((entry) => entry.sentence).join(' | '))
  })

  it('(1c) the links: the cited screenshot is a real button, nothing is incomplete, and the pane fetched its bytes', () => {
    const page = harvestOf('before')
    const sha = recorded.analysisBefore?.verdicts?.[0]?.evidence?.citedArtifacts?.[0]?.sha
    expect(
      page.citedArtifacts,
      'the cited artifact is not a clickable affordance on the page. The bytes are present, so the '
      + `ref must render as the button that selects its frame on the timeline.${context()}`,
    ).toEqual([sha])
    expect(
      page.citedArtifactStates,
      'a cited artifact rendered as an ABSENCE while its bytes are still on disk. `present === false` '
      + `is the only predicate that may produce this state — presence-unknown is not an absence.${context()}`,
    ).toEqual([])
    expect(
      page.missingEvidence,
      `the member-level count line appeared while nothing is missing.${context()}`,
    ).toEqual([])
    expect(
      page.artifactStates,
      'the overview\'s decision-screenshot pane is not `available`. The harvest clicks the first '
      + 'sub-action, which is what mounts the pane at all; an empty list means no pane mounted and '
      + `the deletion cell below would be comparing against nothing.${context()}`,
    ).toEqual(['available'])
    expect(
      page.artifactRequests.some((url) => url.endsWith(`/artifacts/${sha ?? '(none)'}`)),
      `the page never asked the door for the screenshot bytes it claims to be showing.${context()}`,
    ).toBe(true)
    expect(page.playheadBeforeCitation).toBeNull()
    expect(page.playheadAfterCitation).toBe('0:0-0')
    expect(page.playerSource).toBe('frames')
    expect(page.playerImage).toBe(`/api/runs/${encodeURIComponent(recorded.red!.runId)}/artifacts/${sha}`)
    expect(page.artifactResponses.some(url => url.endsWith(page.playerImage ?? '(none)'))).toBe(true)
    expect(page.drawerOpened).toBe(false)
  })

  it('(1d) masking: no declared value on the page, and no planted value in the verdict the model wrote', () => {
    const page = harvestOf('before')

    expect(
      page.bodyText.includes(POPULATED_DECLARED_SECRET_VALUE),
      'the DECLARED step secret is visible on the page. The runner\'s `SecretRedactor` rewrites it '
      + 'to `[secret:<name>]` before anything is recorded, so it can never legitimately be restored '
      + 'here.'
      + `${context()}`,
    ).toBe(false)

    // THE ENV CREDENTIAL AND THE EMAIL ARE SCOPED TO THE VERDICT BLOCK, DELIBERATELY, AND THE REASON
    // IS A CELL ONE FILE AWAY. Neither is a declared secret, so the run records both as written and
    // the page shows them in the planner's reasoning (D-23) — `run-detail-failure-dom.test.ts` (3e)
    // asserts the credential IS inside the expanded failure banner. A whole-page assertion here
    // would therefore contradict a green cell that measures ratified behaviour. What
    // is this file's to claim is the ANALYSIS's sentence: it quotes the fixture's STEP TEXT, which
    // carries no value at all, so a planted credential turning up inside the block means the author
    // quoted a field it should not have. That is a finding to STOP and report, not a scan to widen.
    expect(
      page.verdictBlockText.includes(POPULATED_SECRET_VALUE),
      'the env credential is INSIDE the authored verdict block. The sentence quotes the '
      + 'failing step\'s text, which carries no value; a credential here means the author grounded '
      + `its quote in a field that holds one.${context()}`,
    ).toBe(false)
    expect(
      page.verdictBlockText.includes(POPULATED_EMAIL),
      `the planted address is INSIDE the authored verdict block.${context()}`,
    ).toBe(false)
  })

  // ---- (2) THE GREEN CONTROL --------------------------------------------------------------------

  it('(2a) green: the chain still terminates and the analysis chip on the page reads `complete`', () => {
    const page = harvestOf('greenHarvest')
    expect(
      recorded.green?.finished,
      `the green run never reached \`runFinished\` inside the budget.${context()}`,
    ).toBe(true)
    expect(
      recorded.greenChips?.analysis,
      'the green run\'s analysis chip is not `complete` on the read route. A run with nothing to explain '
      + 'must still complete its chain — `failed` here would be the chain breaking on the very runs '
      + `that used to work.${context()}`,
    ).toBe('complete')
    expect(
      page.chips,
      `the page did not paint the analysis chip terminal.${context()}`,
    ).toContain('analysis=complete')
  })

  it('(2b) green: every member wears its own PASSED outcome, and there is nothing to explain', () => {
    const page = harvestOf('greenHarvest')
    // THE SET IS ASSERTED NON-EMPTY FIRST. `showMemberChrome` is `members.length > 1`, so a
    // one-member run paints no badge at all and "every member passed" would be vacuously true over
    // zero elements — a cell passing for nothing. The fixture declares two members on purpose.
    expect(
      page.members,
      'the page painted no member chrome, so the per-member outcome this cell is about is not in '
      + `the document at all.${context()}`,
    ).toEqual(['0', '1'])
    expect(
      page.memberOutcomes,
      'not every member of the green run is badged `passed`. The badge carries the RAW outcome word '
      + `off the projection, so a different word here is a different recorded outcome.${context()}`,
    ).toEqual(['passed', 'passed'])
    expect(
      page.verdictProducers,
      'the green run painted a verdict block. `resolveRunVerdicts` filters `passed | skipped | '
      + 'cancelled`, so a run with nothing to explain answers an empty `verdicts[]` — a block here '
      + `means the page is explaining a test that did not fail.${context()}`,
    ).toEqual([])
    expect(
      page.missingEvidence,
      `the green run painted a missing-evidence count line.${context()}`,
    ).toEqual([])
  })

  // ---- (3) THE DELETION FIXTURE (D-20) ----------------------------------------------------------

  it('(3a) after deletion, the WIRE says it first: `present: false` on both ops', () => {
    driveOk()
    expect(
      recorded.deletionFailure,
      `the one blob could not be deleted, so this drive measured nothing.${context()}`,
    ).toBeUndefined()
    expect(
      recorded.deletedSha,
      `no sha was deleted.${context()}`,
    ).toBeDefined()

    const cited = recorded.analysisAfter?.verdicts?.[0]?.evidence?.citedArtifacts ?? []
    expect(
      cited.map((ref) => ref.sha),
      'the cited artifact was DROPPED from the analysis wire once its bytes went away. An absent '
      + 'ref must keep its place carrying `present: false` — a reader who counts the links would '
      + `otherwise conclude the verdict cited fewer things than it did.${context()}`,
    ).toEqual([recorded.deletedSha])
    expect(
      cited[0]?.present,
      'the analysis op still says the cited artifact\'s bytes are present after they were deleted. '
      + '`present` is a STAT at read time, not a value copied from the producer; a stale `true` here '
      + `means the annotation is cached or was never re-derived.${context()}`,
    ).toBe(false)

    const beforeRefs = recorded.detailRefsBefore ?? []
    const afterRefs = recorded.detailRefsAfter ?? []
    expect(
      afterRefs.map(({ id, sha, present }) => ({ id, sha, present })),
      'the detail wire must retain every artifact in order; deleting the cited screenshot changes '
      + `only that blob's availability, leaving the ARIA evidence intact.${context()}`,
    ).toEqual(beforeRefs.map(({ id, sha, present }) => ({
      id,
      sha,
      present: sha === recorded.deletedSha ? false : present,
    })))

    // The verdict cites one screenshot; the member also records independent ARIA evidence.
    // Select the cited identity so neither a new artifact nor its position changes this claim.
    const citedScreenshotId = `decision-screenshot:${recorded.deletedSha}`
    const refs = afterRefs.filter((ref) => ref.id === citedScreenshotId)
    expect(
      refs.map((ref) => ref.sha),
      `the sub-action's artifact ref was dropped from the detail wire.${context()}`,
    ).toEqual([recorded.deletedSha])
    expect(
      refs[0]?.present,
      'the detail op still says the sub-action\'s ref is present after its bytes were deleted. Both '
      + 'ops annotate from the same evidence store; a disagreement between them is two answers to '
      + `one question.${context()}`,
    ).toBe(false)
    // AND THE BEFORE/AFTER PAIR IS WHAT MAKES THIS A MEASUREMENT. A route that answered `false`
    // unconditionally would satisfy every assertion above.
    expect(
      beforeRefs.find((ref) => ref.id === citedScreenshotId)?.present,
      `the detail op said the ref was ABSENT before anything was deleted.${context()}`,
    ).toBe(true)
  })

  it('(3b) after deletion, the overview: the pane is `unavailable`, `incomplete`, and never asked', () => {
    const page = harvestOf('after')
    expect(
      page.artifactStates,
      'the overview\'s decision-screenshot pane is not `unavailable` after its bytes were deleted.'
      + `${context()}`,
    ).toEqual(['unavailable'])
    expect(
      page.evidenceStates,
      'the unavailable pane does not carry `data-evidence-state="unavailable"` with `data-evidence-incomplete`. That pair is '
      + 'the ONE component\'s contract and both ref sites wear it — the pane here and the inline '
      + `chip in (3c) — which is why there are two.${context()}`,
    ).toEqual(['unavailable', 'unavailable'])
    expect(
      page.bodyText,
      `the page does not show the published \`evidence incomplete\` word.${context()}`,
    ).toContain(EVIDENCE_INCOMPLETE_LABEL)

    // A REF KNOWN ABSENT IS NEVER REQUESTED (D-17). The op already said the bytes are gone; asking
    // anyway would turn a known fact into a 404 the page would then have to interpret.
    expect(
      page.artifactRequests.filter(url => url.endsWith(`/artifacts/${recorded.deletedSha}`)),
      'the page asked the door for bytes it had just been told are gone. `present === false` is '
      + 'read BEFORE any `img` is mounted; a request here means the page is learning about absence '
      + `from a failed image load instead of from the op.${context()}`,
    ).toEqual([])
  })

  it('(3c) after deletion, the failure view: the cited link is an incomplete chip with the count line', () => {
    const page = harvestOf('after')
    const sha = recorded.deletedSha ?? '(none)'
    expect(
      page.citedArtifactStates,
      'the cited artifact does not render as `incomplete` under its own sha. It must keep its place '
      + `in the row — never dropped, never a button that opens nothing.${context()}`,
    ).toEqual([`unavailable:${sha}`])
    expect(page.drawerOpened).toBe(false)
    expect(
      page.citedArtifacts,
      'the absent cited artifact is STILL a button. An affordance that opens nothing is the worse '
      + `lie the one component's own header names.${context()}`,
    ).toEqual([])
    expect(
      page.missingEvidence,
      'the member-level count line is not the one `missingEvidenceLine` composes. The attribute is '
      + 'the cell contract (`<missing>/<total>`) and the text is the product\'s own sentence, built '
      + `here from the same formula so a copy change is visible rather than silent.${context()}`,
    ).toEqual([`1/1 :: ${expectedMissingEvidenceLine(1, 1)}`])
  })

  it('(3d) after deletion, UNCHANGED: the outcome badge, the producer and the sentence are byte-identical', () => {
    const before = harvestOf('before')
    const page = harvestOf('after')
    // ONE MISSING SCREENSHOT IS NOT AN UNTRUSTWORTHY VERDICT (D-19). The whole-verdict badge that
    // would say otherwise was rejected; these three are the carriers of that decision.
    expect(
      page.memberOutcomes,
      'a member\'s recorded outcome moved when a screenshot went missing. The badge carries the '
      + `RUN's own word about what happened, and losing evidence does not change what happened.${
        context()}`,
    ).toEqual(before.memberOutcomes)
    expect(
      page.verdictProducers,
      `the verdict's producer changed when its cited screenshot went missing.${context()}`,
    ).toEqual(before.verdictProducers)
    expect(
      page.sentences,
      'the verdict SENTENCE changed when its cited screenshot went missing — the verdict was '
      + 're-graded. `analysis.get` serves the persisted sentence verbatim; presence is annotated '
      + `onto the refs and touches nothing else.${context()}`,
    ).toEqual(before.sentences)
    expect(
      page.provenances,
      `the provenance changed when the cited screenshot went missing.${context()}`,
    ).toEqual(before.provenances)
  })

  // RE-SPELLED 2026-09-30 (432-13): was '... sent and approved inline, lands in history'. The mark
  // is sent with no approval: none renders and no question reaches the channel.
  it('(4a) the header entry opens the composer; false-fail, previewed, sent with no approval, lands in history', () => {
    driveOk()
    const mark = recorded.mark
    expect(mark, `the mark drive was never observed.${context()}`).toBeDefined()
    expect(mark!.failure, context()).toBeUndefined()
    // 432-14: was `scopeSeen` — the page held the confirm channel. It holds none now.
    expect(mark!.confirmChannels, context()).toBe(0)
    expect(mark!.previewStatus, context()).toBe(200)
    expect(mark!.approvalSeen, context()).toBe(false)
    // 426 D-20 survives as: nothing covers the evidence.
    expect(mark!.dialogCountAtApproval, context()).toBe(0)
    expect(mark!.responseStatus, context()).toBe(200)
    expect(mark!.confirmFrames.some(frame => frame.event === 'confirm_request'), context()).toBe(false)
    // Literals, because dashboard-ui publishes no library entry: CHOICE_LABELS['false-fail'] and
    // dispositionText's no-draftable-fix arm in lib/feedback-view.ts.
    expect(mark!.historyChoice, context()).toBe('This should have passed')
    // Wave-0 measured this exact mechanical arm. app_bug belongs to analyze-run; the
    // persisted deterministic classifier says unknown, with no attributable served record.
    expect(mark!.historyDisposition, context()).toBe('Recorded — no fix could be drafted')
    expect(mark!.disposition, context()).toEqual({ kind: 'no-draftable-fix', checked: {
      servedRecords: 0, procedureReads: 0, assertionDrift: false, rootCause: 'unknown',
    } })
    expect(mark!.rows, context()).toHaveLength(1)
    const receipt = MarkReceiptSchema.parse(mark!.rows[0])
    expect(receipt).toMatchObject({ runId: recorded.red!.runId, testIndex: 0,
      origin: 'user', kind: 'false-fail', ordinal: 1 })
    // RESEARCH A5: markedAt is epoch milliseconds, taken during this drive.
    expect(mark!.markedAtWithinDrive, context()).toBe(true)
    expect(mark!.hostileElements, context()).toBe(0)
    // 2026-10-02 (432-42, D-25): applied history on the shipped bundle — no control on the entry,
    // no proposal/review/approval wording, and (no fix was drafted here) no applied line.
    expect(mark!.historyControls, context()).toBe(0)
    expect(mark!.historyText ?? '', context()).not.toMatch(/propos|review|approv|pending|waiting|accept/iu)
    expect(mark!.historyApplied, context()).toBe(0)
  })
})
