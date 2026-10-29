/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` callbacks are compiled as
// TypeScript and EXECUTED in a browser — `run-detail-dom.test.ts`'s reasoning, unchanged.

// A FAILED RUN'S SUMMARY, IN THE MEDIUM A PERSON LOOKS AT (Phase 405 plan 14 · DETL-02, WINDOWS #287).
//
// WHAT THIS FILE MEASURES THAT ITS SIBLING CANNOT. `run-detail-dom.test.ts` drives 405-09's
// populated run, and that run PASSES — so `run.status === 'failed' && run.failureSummary` is false
// and the failure banner never mounts. The banner was therefore the one render site on the rebuilt
// page still painting a producer string RAW, invisible to every cell in the repository: 405-11 put
// the overview's strings through the chip seam, 405-12 read a marker delimiter out of a sub-action
// row and fixed it one row away, and neither could see this one. The verifier found it by reading
// (VERIFICATION.md criterion 2, missing item 3) and WINDOWS #287 recorded the three things a fix
// needs — a failing-run producer, parse-before-truncate, and a cell that measures it on the shipped
// artifact. This file is the third.
//
// THE PRODUCER IS THE SAME ONE, WITH ONE BOOLEAN MOVED. Same stub model server, same target page,
// same project recipe, same credential-free posture — `startStubModelServer({ plannerOutcome:
// 'stepFailed' })` sets the shipped `stepFailed` plan field on the planner's tool call, which is
// the product's own path to a step the planner declares impossible. Nothing in the runner changes
// to make this run fail, which is what keeps the run a RUN rather than an arrangement.
//
// A BROWSER THAT CANNOT LAUNCH IS A RED, NEVER A SKIP — 404-08's law, restated by
// `run-detail-dom.test.ts`'s own header and carried here without softening. There is no conditional
// skip in this file. A suite that exits 0 having measured nothing is indistinguishable from one
// that measured everything, and what this file measures is a leak.
//
// THE DRIVING HAPPENS ONCE, IN `beforeAll`, AND THE CELLS ASSERT ON WHAT IT RECORDED. The drive
// records and never asserts, so each named claim can be the only red under its own mutation.
//
// NO RESTART LEG. Since 441-15 (D-07) the dashboard serves the text a run stored and restores
// nothing, so a second process would read exactly what the first one does. Cell (3e) reads the
// banner's text on the FIRST process, which is the fact this file needs.
//
// THE CLIPBOARD IS MEASURED HERE TOO, AND ON THE SHIPPED BUNDLE (3g · T-405-43). With the banner
// COLLAPSED it once carried 47 words against 21 on the page, including a value the reader was never
// shown. The cell reads the clipboard back through `navigator.clipboard.readText()` after clicking
// copy in the TRUNCATED state, which is why this file's browser context is granted
// `clipboard-read`/`clipboard-write`.
//
// THE DECLARED MARKER IS TEXT (441 D-28). The run stores a declared value as `[secret:<name>]`, and
// the banner and the artifact drawer show that string as written, with no chip (C441-DISPLAY).
//
// WHAT A RED ON (3f) MEANS, STATED BEFORE ANYONE IS TEMPTED. `runs.failure_summary` is an at-rest
// sink no PASSING run ever writes, so this file's scan covers ground 405-12's cannot. If a planted
// value turns up there, in `events.jsonl` or in an SSE frame, that is a NEW DETL-02 at-rest
// finding: stop and report the sink and the value. It is not an occasion to narrow the scan.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { slugBranch } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_EMAIL,
  POPULATED_FAILURE_STEP_TEXT,
  POPULATED_RUN_ANCHORED_BUILDS,
  POPULATED_SECRET_NAME,
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

// NO PLATFORM SKIP — `run-detail-dom.test.ts`'s refusal, applied to the same class of drive.
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
  'these cells drive the BUILT dashboard UI in a real Chromium, against a run the shipped binary '
  + 'really executed and really FAILED: run `pnpm exec playwright install chromium` and re-run. '
  + 'THEY MUST NOT BE SKIPPED WHEN THE BROWSER IS ABSENT — they are the only cells in this '
  + 'repository that measure the failure banner at all, and the banner is the render site '
  + 'WINDOWS #287 was opened about.'

/** How long the page has to mount and paint the banner. */
const PAGE_BUDGET_MS = 60_000

/** How long the detached post-run tail is given before the dashboard is stopped for the scan. */
const TAIL_GRACE_MS = 2_000

/**
 * One source-level string body as the runtime would see it.
 *
 * JAVASCRIPT'S OWN RULE, WHICH IS THE ONLY ONE THAT MAKES THE READ FAITHFUL: a backslash escapes
 * the character after it, `\n`/`\t`/`\r` and the two unicode forms name characters, and every
 * other escape is the character itself. Without this, a constant whose text merely contains its own
 * quote — the case that made the helper below quote-agnostic — would come back carrying the
 * backslash the source needed and nothing on the page would ever match it.
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
 * A published constant, read out of the module that publishes it.
 *
 * `run-detail-dom.test.ts`'s helper, for its reason: importing a `dashboard-ui` module into a Node
 * test would drag a renderer in, and a hardcoded copy would go on passing against a page that says
 * something else.
 *
 * EITHER QUOTE STYLE, AND THE STYLE IS NOT THE CONSTANT'S BUSINESS (WINDOWS #297). This read used
 * to accept single quotes only, so a DOUBLE-quoted constant (one whose text carries an apostrophe)
 * could not be read at all, and a Prettier or ESLint quote-style change turned a working read into
 * a `beforeAll` throw that red every cell at once, for a formatting reason. The body is matched to
 * the MATCHING quote across escaped pairs, so a `\'` inside a single-quoted constant does not end
 * it early.
 *
 * A TEMPLATE LITERAL IS STILL REFUSED, deliberately: its body can interpolate, and a helper that
 * returned the source text of `${...}` would be publishing a string nothing renders.
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

// ── THE HELPER'S OWN CELL (WINDOWS #297). It is outside the drive's `describe` deliberately: it
// reads one source file and nothing else, so it must not pull a spawned binary, a browser and a
// real run in behind it. A helper whose failure mode is "throws in `beforeAll` and reds every cell
// in the file at once" is worth three cells of its own.
describe('publishedConstant reads a constant whatever quotes it carries', () => {
  it('publishedConstant reads a DOUBLE-quoted constant with its apostrophe intact', () => {
    const title = publishedConstant('lib/config-copy.ts', 'CONFIG_LOAD_FAILED_TITLE')
    expect(title).toBe("Couldn't load the config")
    // The body is the RUNTIME string, not the source text: no backslash survives the read.
    expect(title).not.toContain('\\')
  })

  it('publishedConstant still reads a SINGLE-quoted constant, unchanged', () => {
    expect(publishedConstant('lib/run-detail-view.ts', 'TOKEN_USAGE_TRIGGER_LABEL'))
      .toBe('Token usage — details')
  })

  it('publishedConstant refuses a name it cannot find rather than answering an empty string', () => {
    expect(() => publishedConstant('lib/run-detail-view.ts', 'NOT_A_PUBLISHED_CONSTANT'))
      .toThrow(/single- or double-quoted/u)
  })
})

/** The declared value as the run stores it, and as every surface shows it (441 D-28). */
const DECLARED_SECRET_MARKER = `[secret:${POPULATED_SECRET_NAME}]`

/** One response the browser actually received, as the cells that read it consume it. */
interface RecordedResponse {
  readonly url: string
  readonly status: number
  readonly contentType: string
  /** The body of an API REFUSAL, bounded — only for `status >= 400` under `/api/`. */
  readonly refusalBody?: string
}

/** One state of the banner — the truncated preview, or the expanded full text. */
interface BannerState {
  /** `data-failure-banner-state`, or nothing when the banner never rendered. */
  readonly state?: string
  /** The banner's own `textContent` — what cell (3e) reads the restored value out of. */
  readonly bannerText: string
  /**
   * `[data-failure-banner-text]`'s `textContent` — the SENTENCE, without the buttons around it.
   *
   * (3g) compares the clipboard against THIS rather than against `bannerText`, because the live
   * region that announces a completed copy is inside the banner and would otherwise become part of
   * the string the copy of the page is measured against.
   */
  readonly renderedText: string
  /** Every `data-masked` category INSIDE the banner, in document order. */
  readonly maskedCategories: readonly string[]
  /** Every non-blank text node under `<body>` — the medium a person reads. */
  readonly textNodes: readonly string[]
  /** `document.body.innerText`, for the whole-page containment questions. */
  readonly bodyText: string
}

/** Everything one page visit recorded. */
interface PageObservation {
  /** Where the browser ended up — a bounce to `/live` would show here rather than as a hang. */
  readonly finalUrl: string
  /** Why the banner never attached, when it never did. Recorded, so the cells red on the FACT. */
  readonly waitFailure?: string
  /**
   * Whether a `[data-failure-banner-toggle]` was present AND its click RESOLVED.
   *
   * BOTH HALVES, BECAUSE THE FLAG IS A CELL'S DIAGNOSIS (WINDOWS #293). It was set unconditionally
   * on the line after a click whose rejection was swallowed, so an element that existed and could
   * not be clicked — detached, obscured, timed out — reported `true`, and cell (3d) then red one
   * assertion later with a message naming the wrong cause on the slowest suite in the repository.
   */
  readonly toggled: boolean
  /** Why the toggle click did not resolve, when it did not. Recorded, never thrown. */
  readonly toggleFailure?: string
  /** What `navigator.clipboard.readText()` answered after copy was clicked while COLLAPSED. */
  readonly clipboard?: string
  /** Why the clipboard could not be measured, when it could not. Recorded, never thrown. */
  readonly clipboardFailure?: string
  /** `data-failure-banner-state` as it read at the moment copy was clicked — (3g)'s precondition. */
  readonly clipboardCopiedState?: string
  /** `data-copy-status` after the wait, so a refused write names itself instead of timing out mutely. */
  readonly clipboardCopyStatus?: string
  readonly truncated: BannerState
  readonly full: BannerState
  /** The artifact drawer, opened with `i` after the banner was read. */
  readonly drawer: DrawerObservation
  /** Every response this page received. */
  readonly responses: readonly RecordedResponse[]
  /** The records on the failing path the failure view lists on THIS run. */
  readonly memoryOnPath: MemoryOnPathObservation
}

/**
 * The on-path half of the same visit, recorded on both sides of the seam: `analysisBody` is what
 * the shipped binary put on the wire and `onPathRecords` is what the shipped bundle painted from it.
 */
interface MemoryOnPathObservation {
  /** How many verdict blocks painted. Zero would make the absence claim below vacuous. */
  readonly verdictBlocks: number
  /** Every on-path record chip the page named. */
  readonly onPathRecords: readonly string[]
  /** `GET /api/runs/:id/analysis`'s body, bounded — the wire half of the claim. */
  readonly analysisBody?: string
  /** Why the verdict block never attached, when it never did. Recorded, never thrown. */
  readonly waitFailure?: string
}

/** The artifact drawer as the page painted it, with the suite member's raw YAML expanded. */
interface DrawerObservation {
  /** The drawer's `innerText` once the member's raw YAML is open. */
  readonly text: string
  /** The member's raw YAML block's own text. */
  readonly rawYaml: string
  /** How many `[data-masked]` elements the WHOLE page holds with the drawer open. */
  readonly maskedElements: number
  /** Why the drawer or its raw YAML never appeared, when it did not. Recorded, never thrown. */
  readonly waitFailure?: string
}

/** Everything `beforeAll` measured, or the reason it could not. */
interface Recorded {
  drive?: PopulatedRunDrive
  /** Envelope types in arrival order — what every failure message quotes. */
  envelopeTypes: string[]
  /** The `testFinished` payload the door served, as data. */
  testFinished?: { outcome?: unknown; failureSummary?: unknown }
  /** The run row `GET /api/runs/:id` answered with, for the context block only. */
  runRow?: { status?: unknown; failureSummary?: unknown }
  observed?: PageObservation
  /** Every run-stream frame the drive collected, serialised — the masked-side wire scan. */
  sseFrames?: string
  /** `runs/<slug>/events.jsonl` as text, read after the dashboard exited. */
  eventsLog?: string
  /** Every byte of the runtime databases and their write-ahead sidecars. */
  dbBytes?: Buffer
  /** The database files scanned, named so a clean scan is not a scan of nothing. */
  scannedDbFiles: string[]
  /** Whether `playwright-core` can name an installed Chromium at all. */
  browserPresent: boolean
  stub?: StubModelServer
  runDir?: string
  dashboardStderr?: string
  failure?: string
}

const recorded: Recorded = {
  envelopeTypes: [],
  scannedDbFiles: [],
  browserPresent: false,
}

let targetServer: FixtureServer | undefined
let stubServer: StubModelServer | undefined
let dashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let browser: Browser | undefined
const contexts: BrowserContext[] = []

/** The context every failure message carries: what the run and the page did, in one block. */
function context(): string {
  const drive = recorded.drive
  const observed = recorded.observed
  return [
    '',
    `envelope types: ${recorded.envelopeTypes.join(', ') || '(none)'}`,
    `finished: ${String(drive?.finished ?? false)}; last type: ${drive?.lastType ?? '(none)'}; `
    + `elapsed: ${String(drive?.elapsedMs ?? 0)}ms`,
    `testFinished: ${JSON.stringify(recorded.testFinished ?? null).slice(0, 900)}`,
    `run row: ${JSON.stringify(recorded.runRow ?? null).slice(0, 900)}`,
    `chromium present: ${String(recorded.browserPresent)}`,
    `visit url: ${observed?.finalUrl ?? '(never opened)'}`,
    `banner wait failure: ${observed?.waitFailure?.split('\n')[0] ?? '(none)'}`,
    `truncated state: ${observed?.truncated.state ?? '(no banner)'}; `
    + `toggled: ${String(observed?.toggled ?? false)}; `
    + `toggle failure: ${observed?.toggleFailure ?? '(none)'}; `
    + `full state: ${observed?.full.state ?? '(no banner)'}`,
    `banner text (truncated): ${JSON.stringify((observed?.truncated.bannerText ?? '').slice(0, 400))}`,
    `banner text (full): ${JSON.stringify((observed?.full.bannerText ?? '').slice(0, 800))}`,
    `banner chips (truncated): ${(observed?.truncated.maskedCategories ?? []).join(', ') || '(none)'}; `
    + `(full): ${(observed?.full.maskedCategories ?? []).join(', ') || '(none)'}`,
    `clipboard: state at copy: ${observed?.clipboardCopiedState ?? '(never clicked)'}; `
    + `copy status: ${observed?.clipboardCopyStatus ?? '(none)'}; `
    + `failure: ${observed?.clipboardFailure ?? '(none)'}`,
    `clipboard text: ${JSON.stringify((observed?.clipboard ?? '').slice(0, 800))}`,
    `rendered text (truncated): ${JSON.stringify((observed?.truncated.renderedText ?? '').slice(0, 800))}`,
    `drawer: wait failure: ${observed?.drawer.waitFailure?.split('\n')[0] ?? '(none)'}; `
    + `masked elements: ${String(observed?.drawer.maskedElements ?? 0)}`,
    `drawer raw yaml: ${JSON.stringify((observed?.drawer.rawYaml ?? '').slice(0, 600))}`,
    `page api traffic: ${
      (observed?.responses ?? [])
        .filter((response) => response.url.includes('/api/'))
        .map((response) =>
          `${String(response.status)} ${response.url.replace(/^https?:\/\/[^/]+/u, '')}`
          + (response.refusalBody === undefined ? '' : ` -> ${response.refusalBody}`))
        .join(' | ') || '(none)'
    }`,
    `memory on path: verdict blocks: ${String(observed?.memoryOnPath.verdictBlocks ?? 0)}; `
    + `on-path: ${(observed?.memoryOnPath.onPathRecords ?? []).join(', ') || '(none)'}; `
    + `wait failure: ${observed?.memoryOnPath.waitFailure?.split('\n')[0] ?? '(none)'}`,
    `analysis body: ${JSON.stringify((observed?.memoryOnPath.analysisBody ?? '').slice(0, 900))}`,
    `page text: ${JSON.stringify((observed?.truncated.bodyText ?? '').slice(0, 600))}`,
    recorded.failure === undefined ? '' : `drive failure: ${recorded.failure}`,
    `dashboard stderr: ${(recorded.dashboardStderr ?? '').slice(-1_200)}`,
  ].join('\n')
}

/** The recorded drive, or a failure the cells report with their own message. */
function driveOk(): void {
  expect(
    recorded.failure,
    `the measurement drive stopped early. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeUndefined()
}

/** The visit's observation, asserted present so every cell below reads a real page. */
function visit(): PageObservation {
  driveOk()
  const observed = recorded.observed
  expect(
    observed,
    `the run-detail page was never observed. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeDefined()
  return observed as PageObservation
}

/**
 * Harvest one banner state: the attribute, any chip inside it, and every text node on the page.
 */
async function harvestBanner(page: Page): Promise<BannerState> {
  return page.evaluate(() => {
    const nodes: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const value = node.nodeValue ?? ''
      if (value.trim() !== '') nodes.push(value)
    }
    const banner = document.querySelector('[data-failure-banner]')
    const masked = banner === null
      ? []
      : Array.from(banner.querySelectorAll('[data-masked]'))
    return {
      state: banner?.getAttribute('data-failure-banner-state') ?? undefined,
      bannerText: (banner?.textContent ?? ''),
      renderedText: (banner?.querySelector('[data-failure-banner-text]')?.textContent ?? ''),
      maskedCategories: masked.map((element) => element.getAttribute('data-masked') ?? '?'),
      textNodes: nodes,
      bodyText: document.body.innerText,
    }
  })
}

/** How long the copy button has to reach `data-copy-status="copied"` before (3g) gives up. */
const CLIPBOARD_BUDGET_MS = 15_000

/**
 * Open one failed run's detail page, harvest the banner in BOTH of its states, and read the
 * clipboard the copy button writes while the banner is still COLLAPSED.
 *
 * THE TOGGLE IS CLICKED, NOT SIMULATED. The expanded state is what a person gets by pressing the
 * chevron, and the claim these cells make is about what the shipped bundle renders when they do.
 *
 * THE COPY IS CLICKED BEFORE THE TOGGLE AND THE ORDER IS THE MEASUREMENT. (3g)'s whole subject is
 * what leaves a COLLAPSED banner; a copy taken after the expand would be measuring the state the
 * defect was already correct in. The state attribute is re-read at the moment of the click and
 * recorded, so the cell asserts its own precondition rather than assuming it.
 */
async function observeFailureBanner(
  context_: BrowserContext,
  origin: string,
  runId: string,
): Promise<PageObservation> {
  const page: Page = await context_.newPage()
  let waitFailure: string | undefined
  let toggled = false
  let toggleFailure: string | undefined
  const responses: RecordedResponse[] = []
  const pendingBodies: Promise<void>[] = []
  let analysisBody: string | undefined
  page.on('response', (response) => {
    const record: {
      url: string
      status: number
      contentType: string
      refusalBody?: string
    } = {
      url: response.url(),
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
    }
    responses.push(record as RecordedResponse)
    if (record.status >= 400 && record.url.includes('/api/')) {
      pendingBodies.push(
        response.text().then(
          (body) => { record.refusalBody = body.slice(0, 400) },
          () => { record.refusalBody = '(body unreadable)' },
        ),
      )
    }
    // THE ANALYSIS BODY, ON A 200 — the wire half of (3h). It is read here rather than re-fetched
    // because a second request is a second answer, and the claim is about the bytes THIS page got.
    if (record.status === 200 && /\/api\/runs\/[^/]+\/analysis$/u.test(record.url)) {
      pendingBodies.push(
        response.text().then(
          (body) => { analysisBody = body.slice(0, 20_000) },
          () => { analysisBody = '(body unreadable)' },
        ),
      )
    }
  })
  try {
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    // EVERY WAIT RECORDS RATHER THAN THROWS — `run-detail-dom.test.ts`'s law. A timeout is a fact
    // about the page, and the cells red on the missing FACT with the whole observation quoted.
    await page.locator('[data-failure-banner]')
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch((error: unknown) => {
        waitFailure = error instanceof Error ? error.message : String(error)
      })

    const truncated = await harvestBanner(page)

    // THE CLIPBOARD, WHILE THE BANNER IS STILL COLLAPSED (3g).
    //
    // THE WRITE IS A PROMISE AND THE READ RACES IT, so the wait is on the button's own
    // `data-copy-status`, which the component sets to `copied` only after `writeText` RESOLVES —
    // not on a sleep, and not on the icon. When the write is refused (an unfocused document is the
    // usual reason) the attribute reads `failed` instead, and that word is what the recorded
    // failure carries, so a red names the cause rather than reporting a mute timeout.
    let clipboard: string | undefined
    let clipboardFailure: string | undefined
    let clipboardCopiedState: string | undefined
    let clipboardCopyStatus: string | undefined
    const copy = page.locator('[data-failure-banner-copy]')
    if ((await copy.count()) === 0) {
      clipboardFailure = 'the banner rendered no `[data-failure-banner-copy]` button to click'
    } else {
      clipboardFailure = await copy.first().click().then(
        () => undefined,
        (error: unknown) =>
          `the copy button could not be clicked: ${
            error instanceof Error ? error.message : String(error)}`,
      )
      clipboardCopiedState = (await page.locator('[data-failure-banner]')
        .getAttribute('data-failure-banner-state')) ?? undefined
      if (clipboardFailure === undefined) {
        const settled = await page
          .locator('[data-failure-banner-copy][data-copy-status="copied"]')
          .waitFor({ state: 'attached', timeout: CLIPBOARD_BUDGET_MS })
          .then(() => true, () => false)
        clipboardCopyStatus = (await copy.first().getAttribute('data-copy-status')) ?? undefined
        if (!settled) {
          clipboardFailure =
            'the copy button never reported a resolved write — `data-copy-status` last read '
            + `\`${clipboardCopyStatus ?? '(absent)'}\`. \`failed\` means the browser refused `
            + '`navigator.clipboard.writeText`, which is what an unfocused document or an ungranted '
            + '`clipboard-write` permission looks like.'
        } else {
          const read = await page.evaluate(async () => await navigator.clipboard.readText()).then(
            (text) => ({ text }),
            (error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          if ('error' in read) {
            clipboardFailure = `\`navigator.clipboard.readText()\` refused: ${read.error}`
          } else {
            clipboard = read.text
          }
        }
      }
    }

    // THE FLAG RECORDS THE CLICK'S OUTCOME, NOT ITS ATTEMPT (WINDOWS #293). `toggled = true` used
    // to sit unconditionally after a `.catch(() => undefined)`, so a click that threw still
    // reported success and (3d) blamed a missing element for a click that failed on a present one.
    const toggle = page.locator('[data-failure-banner-toggle]')
    if ((await toggle.count()) > 0) {
      toggleFailure = await toggle.first().click().then(
        () => undefined,
        (error: unknown) =>
          `the toggle was present but the click did not resolve: ${
            error instanceof Error ? error.message : String(error)}`,
      )
      toggled = toggleFailure === undefined
      await page.locator('[data-failure-banner-state="full"]')
        .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
        .catch(() => undefined)
    }
    const full = await harvestBanner(page)

    // The wait is on the verdict block rather than on an on-path element, because this run lists
    // no records: waiting for one would time out and record nothing about the block.
    let blockWaitFailure: string | undefined
    await page.locator('[data-verdict-block]')
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch((error: unknown) => {
        blockWaitFailure = error instanceof Error ? error.message : String(error)
      })
    const painted = await page.evaluate(() => {
      const read = (selector: string, attribute: string) =>
        Array.from(document.querySelectorAll(selector))
          .map((element) => element.getAttribute(attribute) ?? '?')
      return {
        verdictBlocks: document.querySelectorAll('[data-verdict-block]').length,
        onPathRecords: read('[data-misdirection-on-path-record]', 'data-misdirection-on-path-record'),
      }
    })

    const drawer = await observeArtifactDrawer(page)

    // Every refusal body read before the observation is handed back, so the record is complete.
    await Promise.all(pendingBodies)

    return {
      memoryOnPath: {
        ...painted,
        ...(analysisBody === undefined ? {} : { analysisBody }),
        ...(blockWaitFailure === undefined ? {} : { waitFailure: blockWaitFailure }),
      },
      finalUrl: page.url(),
      ...(waitFailure === undefined ? {} : { waitFailure }),
      toggled,
      ...(toggleFailure === undefined ? {} : { toggleFailure }),
      ...(clipboard === undefined ? {} : { clipboard }),
      ...(clipboardFailure === undefined ? {} : { clipboardFailure }),
      ...(clipboardCopiedState === undefined ? {} : { clipboardCopiedState }),
      ...(clipboardCopyStatus === undefined ? {} : { clipboardCopyStatus }),
      truncated,
      full,
      drawer,
      responses,
    }
  } finally {
    await page.close()
  }
}

/**
 * Open the artifact drawer with its `i` shortcut, expand the suite member's raw YAML and read it.
 *
 * The run's test source is captured through the run's mask, so the member's step reads with the
 * stored `[secret:<name>]` the drawer shows as written (441 D-28).
 */
async function observeArtifactDrawer(page: Page): Promise<DrawerObservation> {
  let waitFailure: string | undefined
  const record = (error: unknown) => {
    waitFailure ??= error instanceof Error ? error.message : String(error)
  }
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
  await page.keyboard.press('i')
  const dialog = page.getByRole('dialog')
  const members = dialog.locator('[data-drawer-section="suite-members"]')
  await members.waitFor({ state: 'visible', timeout: PAGE_BUDGET_MS }).catch(record)
  for (const name of ['Member snapshots', 'Raw member YAML']) {
    if (waitFailure !== undefined) break
    await members.getByRole('button', { name, exact: true }).first()
      .click({ timeout: PAGE_BUDGET_MS }).catch(record)
  }
  const raw = members.locator('pre')
  if (waitFailure === undefined) {
    await raw.first().waitFor({ state: 'visible', timeout: PAGE_BUDGET_MS }).catch(record)
  }
  return {
    text: (await dialog.count()) > 0 ? await dialog.first().innerText() : '',
    rawYaml: (await raw.count()) > 0 ? (await raw.first().textContent()) ?? '' : '',
    maskedElements: await page.locator('[data-masked]').count(),
    ...(waitFailure === undefined ? {} : { waitFailure }),
  }
}

describe('the shipped dashboard paints a FAILED run\'s summary as stored text', () => {
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

    targetServer = await startTargetPageServer()
    stubServer = await startStubModelServer({ plannerOutcome: 'stepFailed' })
    recorded.stub = stubServer

    const project = populatedRunFixtureProject(
      'run-detail-failure-dom',
      { modelBaseUrl: stubServer.baseUrl, targetUrl: targetServer.url },
      { stepText: POPULATED_FAILURE_STEP_TEXT },
    )

    const port = await reserveEphemeralPort()
    dashboard = await spawnDashboard(
      project.root,
      project.configPath,
      port,
      60_000,
      populatedRunSpawnEnv(),
    )
    if (!dashboard.ready) {
      recorded.dashboardStderr = dashboard.stderr()
      recorded.failure = 'the spawned `agent-qa dashboard` never said it was listening'
      return
    }

    try {
      recorded.drive = await drivePopulatedRun(dashboard, project, RUN_BUDGET_MS)
      recorded.envelopeTypes = recorded.drive.envelopes.map((envelope) => envelope.type)
      recorded.sseFrames = JSON.stringify(recorded.drive.envelopes)

      const finished = recorded.drive.envelopes.find((envelope) => envelope.type === 'testFinished')
      if (finished !== undefined) {
        recorded.testFinished = (finished as unknown as {
          payload: { outcome?: unknown; failureSummary?: unknown }
        }).payload
      }

      // THE RUN ROW AS THE DISPLAY DOOR SERVES IT, for the context block. The cells below assert on
      // the DOM; this is here so a red names the string the page was handed rather than only the
      // string it painted.
      const row = await fetch(
        `${dashboard.origin}/api/runs/${encodeURIComponent(recorded.drive.runId)}`,
      ).then(
        async (response) => await response.json() as { run?: { status?: unknown; failureSummary?: unknown } },
        () => undefined,
      )
      if (row?.run !== undefined) {
        recorded.runRow = { status: row.run.status, failureSummary: row.run.failureSummary }
      }

      // `clipboard-read`/`clipboard-write` ARE GRANTED ON THE CONTEXT because (3g) reads back what
      // the copy button wrote. Without them Chromium refuses `writeText` in the page and the cell
      // would red on a permission rather than on the fact it is measuring.
      const visitContext = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write'],
      })
      contexts.push(visitContext)
      recorded.observed = await observeFailureBanner(
        visitContext,
        dashboard.origin,
        recorded.drive.runId,
      )
    } catch (error) {
      recorded.failure = error instanceof Error ? error.message : String(error)
    }

    // The detached tail is given a moment before its writer is taken away.
    await new Promise<void>((tick) => { setTimeout(tick, TAIL_GRACE_MS) })
    recorded.dashboardStderr = dashboard.stderr()
    await dashboard.stop()

    const runId = recorded.drive?.runId
    if (runId !== undefined) {
      const runDir = join(project.agentQaRoot, 'runs', slugBranch(runId))
      recorded.runDir = runDir
      const eventsPath = join(runDir, 'events.jsonl')
      if (existsSync(eventsPath)) recorded.eventsLog = readFileSync(eventsPath, 'utf8')
    }

    // EVERY database this host wrote AND their write-ahead sidecars, scanned after the process that
    // owns them exited: a `-wal` a scan never opened can hold the bytes the scan concluded were
    // absent.
    const chunks: Buffer[] = []
    for (const entry of existsSync(project.agentQaRoot) ? readdirSync(project.agentQaRoot) : []) {
      if (!/\.db(?:-[a-z]+)?$/u.test(entry)) continue
      recorded.scannedDbFiles.push(entry)
      chunks.push(readFileSync(join(project.agentQaRoot, entry)))
    }
    recorded.dbBytes = Buffer.concat(chunks)
  }, RUN_BUDGET_MS + 240_000)

  afterAll(async () => {
    for (const held of contexts) await held.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await dashboard?.stop()
    await stubServer?.close()
    await targetServer?.close()
    cleanupTempRoots()
  })

  it('(3a) the producer: the shipped binary really failed this run, with the declared marker and the email as written in its summary on the wire', () => {
    driveOk()
    expect(
      recorded.drive?.finished,
      'the failing run never reached `runFinished` inside the budget. The `stepFailed` knob sets a '
      + 'plan field on the planner\'s tool call and nothing else; a run that never finishes means '
      + `the loop took a different path, not that the fixture asked for one.${context()}`,
    ).toBe(true)
    expect(
      recorded.testFinished,
      `the run served no \`testFinished\` envelope to read an outcome off.${context()}`,
    ).toBeDefined()
    expect(
      recorded.testFinished?.outcome,
      'the member did not fail. Without a failed member the run row is not `failed`, the banner '
      + `never mounts, and every cell below would be measuring a page that renders nothing.${context()}`,
    ).toBe('failed')
    const summary = recorded.testFinished?.failureSummary
    expect(
      typeof summary,
      `the \`testFinished\` payload carried no \`failureSummary\` string.${context()}`,
    ).toBe('string')
    expect(
      summary,
      'the failure summary on the wire carries no declared marker. `projectTestFinished` routes the '
      + 'summary through the run\'s redactor; a summary without the marker means the projection '
      + `stopped masking it or the declared value stopped reaching it.${context()}`,
    ).toContain(`[secret:${POPULATED_SECRET_NAME}]`)
    expect(
      summary,
      `the failure summary on the wire does not carry the planted email as written (D-23).${context()}`,
    ).toContain(POPULATED_EMAIL)
    expect(
      (summary as string).includes(POPULATED_DECLARED_SECRET_VALUE),
      `the declared step secret is IN CLEAR in the failure summary on the wire.${context()}`,
    ).toBe(false)
  })

  it('(3b) the banner rendered on the shipped bundle, in its truncated state', () => {
    const observed = visit()
    expect(
      observed.waitFailure,
      'the failure banner never attached to the run-detail page. The run failed with a summary, so '
      + 'either the row was not written `failed`, the single-run arm dropped `failureSummary`, or '
      + `the page stopped rendering the banner.${context()}`,
    ).toBeUndefined()
    expect(
      observed.truncated.state,
      'the banner did not open in its truncated state. The fixture\'s summary is over the preview '
      + 'budget by construction, so a banner that starts full means the truncation stopped running '
      + `— and the truncated-state claims below would be measuring the full text.${context()}`,
    ).toBe('truncated')

    // AND THE ATTRIBUTE IS CHECKED AGAINST THE TEXT, because an attribute is only worth reading if
    // it can disagree with what is on the page. `data-failure-banner-state` was once derived from
    // the toggle's `useState(false)` alone, which made `truncated` a compile-time constant on
    // mount: this cell would have gone on passing with the truncation deleted outright. The two
    // assertions below are the fact the sentence above claims — the preview really is SHORTER than
    // the full text, and it really was cut — and mutation leg M6 (`truncateText` returns its input
    // unchanged) is the measurement that this cell can lose them.
    expect(
      observed.truncated.bannerText.length,
      'the truncated banner is not shorter than the expanded one, so no truncation happened. The '
      + 'fixture\'s summary is over the preview budget by construction; equal lengths mean the '
      + `preview is the whole sentence and the two banner states are one claim.${context()}`,
    ).toBeLessThan(observed.full.bannerText.length)
    expect(
      observed.truncated.bannerText,
      'the truncated banner carries no ellipsis, which `truncateText` appends if and only if '
      + `it cut something — so the preview was never over the budget.${context()}`,
    ).toContain('...')
  })

  it('(3c) truncated state: the email is shown as written', () => {
    const observed = visit()
    expect(
      observed.truncated.bodyText.includes(POPULATED_EMAIL),
      'the planted address is not shown as written in the truncated banner. The fixture plants the '
      + 'email inside the preview budget deliberately; if the sentence drifted past the budget, fix '
      + `the FIXTURE, never the budget (D-23).${context()}`,
    ).toBe(true)
    expect(
      observed.truncated.maskedCategories,
      `the truncated banner painted a masked-value chip; stored text is shown as written (D-28).${context()}`,
    ).toEqual([])
  })

  it('(3d) full state: the same facts hold after the banner is expanded', () => {
    const observed = visit()
    expect(
      observed.toggled,
      'the expanded state was never reached: either the banner rendered no '
      + '`[data-failure-banner-toggle]`, or one was present and the click on it did not resolve — '
      + '`toggle failure` in the block below names which. A summary over the preview budget must '
      + `offer the toggle; without it the full text is unreadable and this claim is unmeasurable.${
        context()}`,
    ).toBe(true)
    expect(
      observed.full.state,
      `the banner did not reach its full state after the toggle was clicked.${context()}`,
    ).toBe('full')
    expect(
      observed.full.maskedCategories,
      `the expanded banner painted a masked-value chip; stored text is shown as written (D-28).${context()}`,
    ).toEqual([])
    expect(
      observed.full.bodyText.includes(POPULATED_EMAIL),
      `the planted address is not shown as written once the banner is expanded (D-23).${context()}`,
    ).toBe(true)
  })

  it('(3e) full state: the env credential is shown as written INSIDE the banner, and not in the preview', () => {
    const observed = visit()
    expect(
      observed.full.bannerText.includes(POPULATED_SECRET_VALUE),
      'the `_SECRET`-named environment credential is NOT in the expanded banner. It is not a '
      + 'declared secret, so the run records it as written in `run.failureSummary` and the banner '
      + `shows it as written (D-07, D-23).${context()}`,
    ).toBe(true)
    // AND IT IS OUTSIDE THE PREVIEW, which is what makes (3c) and (3e) two claims. The fixture puts
    // the credential past the word budget on purpose; if it drifted into the preview, the truncated
    // cell would be asserting about a string that already carries everything.
    expect(
      observed.truncated.bannerText.includes(POPULATED_SECRET_VALUE),
      'the env credential is already visible in the TRUNCATED banner, so the preview is '
      + 'not shorter than the full text in the way the fixture\'s word arithmetic says it is. Fix '
      + `the fixture's sentence, not this cell.${context()}`,
    ).toBe(false)
  })

  it('(3f) at rest on a FAILING run: the declared value is in neither the SSE frames, the events log nor the database, and the email and the env credential are there as written', () => {
    driveOk()
    expect(
      recorded.sseFrames,
      `the drive collected no run-stream frames to scan.${context()}`,
    ).toBeDefined()
    expect(
      recorded.eventsLog,
      `the run wrote no \`events.jsonl\` to scan at ${recorded.runDir ?? '(no run dir)'}${context()}`,
    ).toBeDefined()
    expect(
      recorded.scannedDbFiles.length,
      `no runtime database file was found to scan — a clean scan of nothing is not a claim.${context()}`,
    ).toBeGreaterThan(0)

    // `runs.failure_summary` IS A SINK NO PASSING RUN EVER WROTE, so this scan covers ground the
    // passing-run differential cannot. A red here is a NEW DETL-02 at-rest finding: report the sink
    // and the value. It is not an occasion to narrow the scan.
    expect(
      (recorded.sseFrames ?? '').includes(POPULATED_DECLARED_SECRET_VALUE),
      `the declared step secret appears IN CLEAR in the run-stream frames of a FAILING run.${context()}`,
    ).toBe(false)
    expect(
      (recorded.eventsLog ?? '').includes(POPULATED_DECLARED_SECRET_VALUE),
      `the declared step secret appears IN CLEAR in this failing run's events.jsonl.${context()}`,
    ).toBe(false)
    expect(
      (recorded.dbBytes ?? Buffer.alloc(0)).includes(Buffer.from(POPULATED_DECLARED_SECRET_VALUE, 'utf8')),
      'the declared step secret appears IN CLEAR in the dashboard\'s own SQLite bytes '
      + `(${recorded.scannedDbFiles.join(', ')}) — `
      + `\`runs.failure_summary\` is the sink a passing run never writes.${context()}`,
    ).toBe(false)

    // Undeclared values are recorded as written (D-01, D-12, D-23).
    for (const [what, value] of [
      ['the env credential', POPULATED_SECRET_VALUE],
      ['the planted email address', POPULATED_EMAIL],
    ] as const) {
      expect(
        (recorded.sseFrames ?? '').includes(value),
        `${what} is not in the run-stream frames of this failing run as written.${context()}`,
      ).toBe(true)
      expect(
        (recorded.eventsLog ?? '').includes(value),
        `${what} is not in this failing run's events.jsonl as written.${context()}`,
      ).toBe(true)
    }
  })

  it('(3g) the clipboard carries ONLY what the collapsed banner rendered', () => {
    const observed = visit()
    expect(
      observed.clipboardFailure,
      `the clipboard could not be measured at all, so this cell asserts nothing.${context()}`,
    ).toBeUndefined()

    // THE PRECONDITION IS ASSERTED, NOT ASSUMED. This cell's whole subject is what leaves a
    // COLLAPSED banner; measured from an expanded one it would be asserting a tautology.
    expect(
      observed.clipboardCopiedState,
      'the copy button was clicked while the banner was NOT collapsed, so what this cell read is '
      + `not the fact it names.${context()}`,
    ).toBe('truncated')

    const clipboard = observed.clipboard ?? ''
    expect(
      clipboard,
      `the copy button reported a resolved write and the clipboard is EMPTY.${context()}`,
    ).not.toBe('')

    // THE FACT. The fixture plants the env credential at word 23 — three words past the preview
    // budget, so it is NOT on a collapsed page, and so it must not be on the clipboard either.
    expect(
      clipboard.includes(POPULATED_SECRET_VALUE),
      'the env credential is on the clipboard, copied from a COLLAPSED banner that never '
      + 'showed it. The clipboard is a second medium a person reads: it carries what was RENDERED '
      + `and nothing else.${context()}`,
    ).toBe(false)
    expect(
      clipboard.includes(POPULATED_EMAIL),
      'the planted address is not on the clipboard as written. The collapsed banner renders it at '
      + `word 16, so the clipboard carries it as the page showed it (D-23).${context()}`,
    ).toBe(true)

    // AND IT IS THE RENDERED SENTENCE, WORD FOR WORD — the containment above cannot see a copy that
    // carries three EXTRA words none of which happened to be planted.
    expect(
      clipboard,
      'the clipboard is not the sentence the collapsed banner rendered. A copy that carries more '
      + 'than the page did is the defect this cell exists for; a copy that carries LESS would mean '
      + `the copy path is truncating a second time.${context()}`,
    ).toBe(observed.truncated.renderedText)
  })

  describe('declared markers on a failed run', () => {
    it('a failed run shows a declared marker as text in its banner and artifact drawer', () => {
      const observed = visit()
      expect(
        observed.truncated.renderedText,
        'the collapsed banner does not show the declared value\'s stored `[secret:<name>]` as text. '
        + `The failing step references the value declared in the fixture's secrets file (D-28).${context()}`,
      ).toContain(DECLARED_SECRET_MARKER)
      expect(
        observed.truncated.textNodes.some((text) => text.includes(DECLARED_SECRET_MARKER)),
        `no text node holds the stored marker as written.${context()}`,
      ).toBe(true)
      expect(
        observed.drawer.waitFailure,
        `the artifact drawer or its suite member's raw YAML never appeared.${context()}`,
      ).toBeUndefined()
      expect(
        observed.drawer.rawYaml,
        'the artifact drawer\'s member YAML does not show the stored marker as written. The run '
        + `captures its test source through its own mask (D-28).${context()}`,
      ).toContain(DECLARED_SECRET_MARKER)
      expect(observed.drawer.text, context()).toContain(DECLARED_SECRET_MARKER)
      expect(
        observed.drawer.maskedElements,
        `the page painted a masked-value chip with the drawer open (D-28).${context()}`,
      ).toBe(0)
      expect(observed.drawer.text, context()).not.toMatch(/masked (?:secret|email)/u)
      expect(observed.truncated.bodyText, context()).not.toMatch(/masked (?:secret|email)/u)
      expect(
        (observed.drawer.text + observed.full.bannerText).includes(POPULATED_DECLARED_SECRET_VALUE),
        `the declared value is IN CLEAR in the banner or the drawer.${context()}`,
      ).toBe(false)
    })
  })

  // This run served no low-trust memory, so its verdict declares no `memoryOnPath` and the
  // failure view lists no record. Both sides of the seam are asserted, and the block count first,
  // because an absence measured on a page with no blocks is an absence of nothing.
  it('a run with no low-trust memory on its path carries no memoryOnPath and lists no record', () => {
    const observed = visit()
    expect(
      observed.memoryOnPath.waitFailure,
      'no `[data-verdict-block]` ever attached, so the absence below is an absence of nothing. '
      + 'The failure view paints a block for every member `analysis.get` answers a verdict for, '
      + `and this run failed one.${context()}`,
    ).toBeUndefined()
    expect(
      observed.memoryOnPath.verdictBlocks,
      `the page painted no verdict block for a run with a failed member.${context()}`,
    ).toBeGreaterThan(0)

    const body = observed.memoryOnPath.analysisBody
    expect(
      body,
      `the page never received a 200 from \`/api/runs/:id/analysis\`.${context()}`,
    ).toBeDefined()
    const analysis = JSON.parse(body as string) as {
      verdicts?: { memoryOnPath?: unknown }[]
    }
    expect(
      (analysis.verdicts ?? []).length,
      `the analysis answered no verdicts at all, so the wire claim below is vacuous.${context()}`,
    ).toBeGreaterThan(0)
    expect(
      (analysis.verdicts ?? []).filter((verdict) => 'memoryOnPath' in verdict).length,
      `a verdict declares memoryOnPath on a run that served no low-trust memory.${context()}`,
    ).toBe(0)
    expect(
      observed.memoryOnPath.onPathRecords,
      `an on-path record is named on a run whose verdict declared none.${context()}`,
    ).toEqual([])
  })
})
