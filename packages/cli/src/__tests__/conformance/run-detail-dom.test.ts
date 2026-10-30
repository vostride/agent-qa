/// <reference lib="dom" />
// The DOM lib is referenced HERE because this file's `page.evaluate` callbacks are compiled as
// TypeScript and EXECUTED in a browser — `dashboard-dom.test.ts`'s reasoning, unchanged.

// A declared secret becomes `[secret:<name>]` inside the loop, so the page shows that.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { slugBranch } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_EMAIL,
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

// NO PLATFORM SKIP, on `populated-run.test.ts`'s law applied to itself: a conditional `describe`
// that exits 0 having measured nothing is indistinguishable from one that measured everything, and
// this file is the phase's acceptance. Windows is a recorded drive failure naming the reason.
const WINDOWS_REFUSAL =
  'the spawned-binary cells in this directory are POSIX-only: the dashboard child is stopped with '
  + 'SIGTERM and the run writes a POSIX runtime root. This file reds rather than skipping on '
  + 'Windows, because a suite that exits 0 having measured nothing is indistinguishable from one '
  + 'that measured everything.'

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT dashboard UI served by the BUILT `agent-qa dashboard` and the built '
  + 'packages it resolves as external workspace dependencies: run `pnpm turbo run build --force` '
  + 'from the agent-qa root first. `--force` is required — a mutation script restores its subjects '
  + 'byte-identically, which turbo treats as a cache hit, so a plain build '
  + 'reports FULL TURBO and refreshes no dist mtime.'

const BROWSER_INSTALL_INSTRUCTION =
  'these cells drive the BUILT dashboard UI in a real Chromium, against a run the shipped binary '
  + 'really executed: run `pnpm exec playwright install chromium` and re-run. THEY MUST NOT BE '
  + 'SKIPPED WHEN THE BROWSER IS ABSENT — they are the only cells in this repository that measure '
  + 'the run-detail page on the artifact a person installs, and they are the acceptance for this '
  + "phase's criteria 1 and 2."

/** How long the page has to mount, paint the tree and settle the overview. */
const PAGE_BUDGET_MS = 60_000

/** How long the respawned dashboard has to say it is listening on the same port. */
const RESPAWN_BUDGET_MS = 60_000

/** How long the detached post-run tail is given before the dashboard is stopped for the scan. */
const TAIL_GRACE_MS = 2_000

/** How long a focused token line is given to open its usage card before the absence is taken as real. */
const USAGE_CARD_OPEN_BUDGET_MS = 5_000

// A shape, not the minter's output: rebuilding the page's own string would pass any agreed string.
const ARTIFACT_ROUTE_RE = new RegExp('/api/runs/[^/]+/artifacts/[0-9a-f]{64}$', 'u')

/**
 * A published constant, read out of the module that publishes it.
 *
 * `post-processing-dom.test.ts`'s `publishedRecordSentence`, narrowed to a top-level `export const`.
 * Extracted rather than imported for that file's own reason: importing a `dashboard-ui` module into
 * a Node test would drag a renderer in. Either way the cell fails when the sentence moves, which is
 * the point — a hardcoded copy would go on passing against a page that says something else.
 */
function publishedConstant(relativePath: string, name: string): string {
  const source = readFileSync(join(PACKAGES_ROOT, 'dashboard-ui', 'src', relativePath), 'utf8')
  const entry = new RegExp(`export const ${name}(?::\\s*string)?\\s*=\\s*'([^']*)'`, 'u').exec(source)
  if (entry === null) {
    throw new Error(`${name} is no longer a single-quoted top-level constant in ${relativePath}`)
  }
  return entry[1] as string
}

const TOKENS_NOT_MEASURED_LABEL = publishedConstant('lib/run-detail-view.ts', 'TOKENS_NOT_MEASURED_LABEL')

/**
 * The accessible name of one overview reasoning section, read out of the panel that names it.
 *
 * WHY A CELL NEEDS THIS AT ALL. The overview's reasoning sections are collapsibles that start
 * CLOSED, and the content is unmounted rather than hidden — so the plan is not in the document
 * until somebody opens it. That is the page as shipped and this cell does what a person does:
 * clicks the section by its name. Reading the name out of the panel keeps a copy rename from
 * turning into a mystery timeout here.
 */
function publishedSectionLabel(key: string): string {
  const source = readFileSync(
    join(PACKAGES_ROOT, 'dashboard-ui', 'src', 'components', 'run-detail', 'tab-overview.tsx'),
    'utf8',
  )
  const entry = new RegExp(`key:\\s*"${key}",\\s*\\n\\s*label:\\s*"([^"]+)"`, 'u').exec(source)
  if (entry === null) {
    throw new Error(`the overview no longer declares a section keyed \`${key}\` with a label`)
  }
  return entry[1] as string
}

const REASONING_SECTION_LABEL = publishedSectionLabel('reasoning')

const DECLARED_SECRET_MARKER = `[secret:${POPULATED_SECRET_NAME}]`

/** One response the browser actually received, as the cells that read it consume it. */
interface RecordedResponse {
  readonly url: string
  readonly status: number
  readonly contentType: string
  /**
   * The body of an API REFUSAL, bounded.
   *
   * ONLY FOR `status >= 400`, and only under `/api/`. A page that renders nothing renders nothing
   * for a reason the door already named in a one-key body, and a diagnosis that stopped at the
   * status code would send a reader back to reproduce the whole run just to read that word.
   */
  readonly refusalBody?: string
}

/** Everything one page visit recorded. */
interface PageObservation {
  // Where the browser ended up; a bounce to `/live` shows here rather than as a hang.
  readonly finalUrl: string
  /** Why the tree never attached, when it never did. Recorded, so the cells red on the FACT. */
  readonly waitFailure?: string
  /** The `[data-sub-action-plan]` text, as painted. */
  readonly planText: string
  readonly treeActionFamily?: string
  readonly treePlanCount: number
  /** How many `[data-sub-action]` rows the durable tree drew. */
  readonly subActionCount: number
  /** How many `[data-step-id]` rows the durable tree drew. */
  readonly stepCount: number
  /** `data-artifact-state` on the screenshot pane, or nothing when neither state rendered. */
  readonly artifactState?: string
  readonly initialPlayerSource?: string
  /** The decision screenshot's `src`, if the page rendered an `<img>` at all. */
  readonly screenshotSrc?: string
  // Retired Overview metadata must stay absent.
  readonly tokenSummary?: string
  readonly stepTokens?: number
  /** The `[data-run-token-summary]` sentence from the navbar, as painted. */
  readonly runTokenSummary?: string
  // The run's token totals off the same `/detail` response the page rendered from.
  readonly runTokens?: import('@vostride/agent-qa-schema').RunTokenTotals
  /** Whether focusing `[data-run-token-summary]` attached `[data-usage-card]` inside the budget. */
  readonly usageCardOpened?: boolean
  /** Every visible `[data-usage-line]` in the opened card, in document order, kind beside text. */
  readonly usageCardLines?: readonly { readonly kind: string; readonly text: string }[]
  /** Recorded source fact, independent of its retired Overview chip. */
  readonly screenStateHash?: string
  readonly screenStateChip?: string
  /** Every `data-masked` category the page painted, in document order. */
  readonly maskedCategories: readonly string[]
  /** Every `[data-masked]` chip's visible text. */
  readonly maskedChipText: readonly string[]
  /** The first step row's label, as painted. */
  readonly stepRowText: string
  /** Every non-blank text node under `<body>` — the medium a person reads. */
  readonly textNodes: readonly string[]
  /** `document.body.innerText`, for the whole-page containment questions. */
  readonly bodyText: string
  /** Every response this page received. */
  readonly responses: readonly RecordedResponse[]
}

/** Everything `beforeAll` measured, or the reason it could not. */
interface Recorded {
  drive?: PopulatedRunDrive
  /** Envelope types in arrival order — what every failure message quotes. */
  envelopeTypes: string[]
  /** The first visit, on the process that executed the run. */
  first?: PageObservation
  /** The second visit, on a dashboard process that has never seen this run execute. */
  afterRestart?: PageObservation
  /** Every run-stream frame the drive collected, serialised — the masked-side wire scan. */
  sseFrames?: string
  /** `runs/<slug>/events.jsonl` as text, read after both dashboards exited. */
  eventsLog?: string
  /** Every byte of the runtime databases and their write-ahead sidecars. */
  dbBytes?: Buffer
  /** The database files scanned, named so a clean scan is not a scan of nothing. */
  scannedDbFiles: string[]
  /** Whether `playwright-core` can name an installed Chromium at all. */
  browserPresent: boolean
  /** Whether the respawned dashboard said it was listening. */
  respawned: boolean
  stub?: StubModelServer
  runDir?: string
  dashboardStderr?: string
  respawnStderr?: string
  failure?: string
}

const recorded: Recorded = {
  envelopeTypes: [],
  scannedDbFiles: [],
  browserPresent: false,
  respawned: false,
}

let targetServer: FixtureServer | undefined
let stubServer: StubModelServer | undefined
let dashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let respawned: (SpawnedDashboard & { readonly ready: boolean }) | undefined
let browser: Browser | undefined
const contexts: BrowserContext[] = []

/** The context every failure message carries: what the run and the page did, in one block. */
function context(): string {
  const drive = recorded.drive
  return [
    '',
    `envelope types: ${recorded.envelopeTypes.join(', ') || '(none)'}`,
    `finished: ${String(drive?.finished ?? false)}; last type: ${drive?.lastType ?? '(none)'}; `
    + `elapsed: ${String(drive?.elapsedMs ?? 0)}ms`,
    `chromium present: ${String(recorded.browserPresent)}`,
    `first visit url: ${recorded.first?.finalUrl ?? '(never opened)'}`,
    `first visit wait failure: ${recorded.first?.waitFailure?.split('\n')[0] ?? '(none)'}`,
    `steps drawn: ${String(recorded.first?.stepCount ?? 0)}; `
    + `sub-actions drawn: ${String(recorded.first?.subActionCount ?? 0)}`,
    // THE PAGE'S OWN API TRAFFIC, because every way this page can be empty is a question it either
    // never asked or got a refusal to — and neither is visible in the DOM it did not draw.
    `page api traffic: ${
      (recorded.first?.responses ?? [])
        .filter((response) => response.url.includes('/api/'))
        .map((response) =>
          `${String(response.status)} ${response.url.replace(/^https?:\/\/[^/]+/u, '')}`
          + (response.refusalBody === undefined ? '' : ` -> ${response.refusalBody}`))
        .join(' | ') || '(none)'
    }`,
    `page text: ${JSON.stringify((recorded.first?.bodyText ?? '').slice(0, 600))}`,
    `artifact state: ${recorded.first?.artifactState ?? '(none)'}; `
    + `screenshot src: ${recorded.first?.screenshotSrc ?? '(none)'}`,
    `recorded step tokens: ${JSON.stringify(recorded.first?.stepTokens ?? null)}`,
    `screen state: ${recorded.first?.screenStateHash ?? '(none)'}`,
    `masked chips: ${(recorded.first?.maskedCategories ?? []).join(', ') || '(none)'}`,
    `respawned: ${String(recorded.respawned)}; `
    + `after-restart url: ${recorded.afterRestart?.finalUrl ?? '(never opened)'}`,
    `warnings: ${
      (drive?.envelopes ?? [])
        .filter((envelope) => envelope.type === 'runWarning' || envelope.type === 'testFinished')
        .map((envelope) => JSON.stringify((envelope as unknown as { payload: unknown }).payload).slice(0, 700))
        .join(' | ') || '(none)'
    }`,
    recorded.failure === undefined ? '' : `drive failure: ${recorded.failure}`,
    `dashboard stderr: ${(recorded.dashboardStderr ?? '').slice(-1_200)}`,
    `respawn stderr: ${(recorded.respawnStderr ?? '').slice(-1_200)}`,
  ].join('\n')
}

/** The recorded drive, or a failure the cells report with their own message. */
function driveOk(): void {
  expect(
    recorded.failure,
    `the measurement drive stopped early. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeUndefined()
}

/** The first visit's observation, asserted present so every cell below reads a real page. */
function firstVisit(): PageObservation {
  driveOk()
  const observed = recorded.first
  expect(
    observed,
    `the run-detail page was never observed. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
  ).toBeDefined()
  return observed as PageObservation
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  budgetMs: number,
  everyMs = 50,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out after ${String(budgetMs)}ms waiting for ${what}`)
    await new Promise<void>((tick) => { setTimeout(tick, everyMs) })
  }
}

// The sub-action is clicked, not deep-linked, and the artifact response is awaited before harvest.
async function observeRunDetail(
  context_: BrowserContext,
  origin: string,
  runId: string,
): Promise<PageObservation> {
  const page: Page = await context_.newPage()
  let waitFailure: string | undefined
  let initialPlayerSource: string | undefined
  const responses: RecordedResponse[] = []
  const pendingBodies: Promise<void>[] = []
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
  })
  try {
    await page.goto(`${origin}/runs/${encodeURIComponent(runId)}`)
    // EVERY WAIT RECORDS RATHER THAN THROWS, and the harvest below runs whatever happened. A drive
    // that threw here would leave every cell reporting "the drive stopped early" and NOTHING about
    // the page a person would have been looking at — which is the one thing a reader needs. A
    // timeout is a fact about the page (`waitFailure`), and the cells red on the missing FACT with
    // the whole observation quoted.
    await page.locator('[data-step-id]').first()
      .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
      .catch((error: unknown) => {
        waitFailure = error instanceof Error ? error.message : String(error)
      })

    const subActions = page.locator('[data-sub-action]')
    if ((await subActions.count()) > 0) {
      await subActions.first().locator('button').first().click()
      initialPlayerSource = await page.locator('[data-player]').getAttribute('data-player-source') ?? undefined
      await page.locator('[data-player] [data-slot="toggle-group-item"]').filter({ hasText: /^Frames$/ }).click()
      // THE REASONING SECTION IS OPENED THE WAY A PERSON OPENS IT. It is a collapsible that starts
      // closed and UNMOUNTS its content, so the plan is not in the document until the section is
      // clicked — a cell that read the DOM without clicking would report "the page painted no
      // reasoning" about a page that paints it perfectly one click away.
      const reasoning = page.getByRole('button', { name: REASONING_SECTION_LABEL }).first()
      if ((await reasoning.count()) > 0) await reasoning.click().catch(() => undefined)
      await page
        .locator('[data-reasoning-children] [data-sub-action-plan]')
        .first()
        .waitFor({ state: 'attached', timeout: PAGE_BUDGET_MS })
        .catch(() => undefined)
    }

    // The screenshot pane is the one fact whose completion is a NETWORK event rather than a paint.
    await waitUntil(
      async () => {
        if ((await page.locator('[data-artifact-state]').count()) === 0) return true
        const src = await page.locator('[data-artifact-state="available"] img').first()
          .getAttribute('src').catch(() => null)
        if (src === null) return true
        return responses.some((response) => response.url.endsWith(src))
      },
      'the browser to complete its decision-screenshot request',
      PAGE_BUDGET_MS,
      50,
    ).catch(() => undefined)

    // `textContent` RATHER THAN `innerText`, and the difference is a measured one. The reasoning
    // section lives inside an accordion, and `innerText` answers '' for a node inside a collapsed
    // panel — so a cell reading it would report "the page painted no reasoning" for a page that
    // painted it perfectly and had it one click away. The claim these cells make is about what the
    // page RENDERED for this sub-action; whether a person has expanded the section is a different
    // question, and `bodyText` below is where the visible-medium claims are made.
    const textOf = async (selector: string): Promise<string | undefined> => {
      const node = page.locator(selector).first()
      if ((await node.count()) === 0) return undefined
      return ((await node.textContent()) ?? '').trim()
    }
    const attributeOf = async (selector: string, name: string): Promise<string | undefined> => {
      const node = page.locator(selector).first()
      if ((await node.count()) === 0) return undefined
      return (await node.getAttribute(name)) ?? undefined
    }

    const harvested = await page.evaluate(() => {
      const nodes: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? ''
        if (value.trim() !== '') nodes.push(value)
      }
      const masked = Array.from(document.querySelectorAll('[data-masked]'))
      return {
        textNodes: nodes,
        bodyText: document.body.innerText,
        maskedCategories: masked.map((element) => element.getAttribute('data-masked') ?? '?'),
        maskedChipText: masked.map((element) => (element.textContent ?? '').trim()),
        stepRowText: (document.querySelector('[data-step-id] > button')?.textContent ?? '').trim(),
        subActionCount: document.querySelectorAll('[data-sub-action]').length,
        stepCount: document.querySelectorAll('[data-step-id]').length,
      }
    })

    // Every refusal body read before the observation is handed back, so the record is complete.
    await Promise.all(pendingBodies)

    const artifactState = await attributeOf('[data-artifact-state]', 'data-artifact-state')
    const screenshotSrc = await attributeOf('[data-artifact-state="available"] img', 'src')
    const planText = (await textOf('[data-reasoning-children] [data-sub-action-plan]')) ?? ''
    const treeActionFamily = await attributeOf('[data-sub-action] [data-action-family]', 'data-action-family')
    const treePlanCount = await page.locator('[data-sub-action] [data-sub-action-plan]').count()
    const tokenSummary = await textOf('[data-token-summary]')
    // The token root's text includes its `sr-only` name, which is dropped to read the sentence.
    const runTokenSummary = await page.evaluate(() => {
      const root = document.querySelector('[data-run-token-summary]')
      if (root === null) return undefined
      const clone = root.cloneNode(true) as HTMLElement
      for (const hidden of Array.from(clone.querySelectorAll('.sr-only'))) hidden.remove()
      return (clone.textContent ?? '').trim()
    })
    const screenStateChip = await attributeOf('[data-screen-state]', 'data-screen-state')
    // Opened by focus; hidden Radix copies in the portalled card are dropped, so lines read once.
    let usageCardOpened: boolean | undefined
    let usageCardLines: { kind: string; text: string }[] | undefined
    const usageTrigger = page.locator('[data-run-token-summary]').first()
    if ((await usageTrigger.count()) > 0) {
      await usageTrigger.focus().catch(() => undefined)
      usageCardOpened = await page.locator('[data-usage-card]').first()
        .waitFor({ state: 'attached', timeout: USAGE_CARD_OPEN_BUDGET_MS })
        .then(() => true)
        .catch(() => false)
      if (usageCardOpened) {
        usageCardLines = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-usage-card] [data-usage-line]'))
            .filter((line) => line.closest('[role="tooltip"]') === null)
            .map((line) => ({
              kind: line.getAttribute('data-usage-line') ?? '?',
              text: (line as HTMLElement).innerText.trim(),
            })),
        )
      }
    }
    const detailResponse = await page.request.get(`${origin}/api/runs/${encodeURIComponent(runId)}/detail`)
    expect(detailResponse.status()).toBe(200)
    const detail = await detailResponse.json() as import('@vostride/agent-qa-schema').RunDetailProjection
    const stepTokens = detail.steps[0]?.tokenUsage?.totalTokens
    const runTokens = detail.tokens
    const screenStateHash = detail.subActions[0]?.screenStateHash

    return {
      finalUrl: page.url(),
      initialPlayerSource,
      ...(waitFailure === undefined ? {} : { waitFailure }),
      planText,
      treeActionFamily,
      treePlanCount,
      subActionCount: harvested.subActionCount,
      stepCount: harvested.stepCount,
      ...(artifactState === undefined ? {} : { artifactState }),
      ...(screenshotSrc === undefined ? {} : { screenshotSrc }),
      ...(tokenSummary === undefined ? {} : { tokenSummary }),
      ...(stepTokens === undefined ? {} : { stepTokens }),
      ...(runTokenSummary === undefined ? {} : { runTokenSummary }),
      ...(runTokens === undefined ? {} : { runTokens }),
      ...(usageCardOpened === undefined ? {} : { usageCardOpened }),
      ...(usageCardLines === undefined ? {} : { usageCardLines }),
      ...(screenStateHash === undefined ? {} : { screenStateHash }),
      ...(screenStateChip === undefined ? {} : { screenStateChip }),
      maskedCategories: harvested.maskedCategories,
      maskedChipText: harvested.maskedChipText,
      stepRowText: harvested.stepRowText,
      textNodes: harvested.textNodes,
      bodyText: harvested.bodyText,
      responses,
    }
  } finally {
    await page.close()
  }
}

describe('the shipped dashboard renders run detail populated and unmasked', () => {
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
    stubServer = await startStubModelServer()
    recorded.stub = stubServer

    const project = populatedRunFixtureProject('run-detail-dom', {
      modelBaseUrl: stubServer.baseUrl,
      targetUrl: targetServer.url,
    })

    // The same port across the restart, so only the process changes.
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

      const firstContext = await browser.newContext()
      contexts.push(firstContext)
      recorded.first = await observeRunDetail(firstContext, dashboard.origin, recorded.drive.runId)

      // The masking process is killed; its replacement never saw the run, so it cannot remember.
      recorded.dashboardStderr = dashboard.stderr()
      await dashboard.stop()
      respawned = await spawnDashboard(
        project.root,
        project.configPath,
        port,
        RESPAWN_BUDGET_MS,
        populatedRunSpawnEnv(),
      )
      recorded.respawned = respawned.ready
      recorded.respawnStderr = respawned.stderr()
      if (respawned.ready) {
        // A FRESH BROWSER CONTEXT, so nothing the first visit cached can carry an answer across.
        const secondContext = await browser.newContext()
        contexts.push(secondContext)
        recorded.afterRestart = await observeRunDetail(
          secondContext,
          respawned.origin,
          recorded.drive.runId,
        )
      }
    } catch (error) {
      recorded.failure = error instanceof Error ? error.message : String(error)
    }

    // The detached tail is given a moment before its writer is taken away.
    await new Promise<void>((tick) => { setTimeout(tick, TAIL_GRACE_MS) })
    await respawned?.stop()
    await dashboard.stop()

    const runId = recorded.drive?.runId
    if (runId !== undefined) {
      const runDir = join(project.agentQaRoot, 'runs', slugBranch(runId))
      recorded.runDir = runDir
      const eventsPath = join(runDir, 'events.jsonl')
      if (existsSync(eventsPath)) recorded.eventsLog = readFileSync(eventsPath, 'utf8')
    }

    // EVERY database this host wrote AND their write-ahead sidecars, scanned after the processes
    // that own them exited — `populated-run.test.ts`'s reasoning, unchanged: a `-wal` a scan never
    // opened can hold the bytes the scan concluded were absent.
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
    await respawned?.stop()
    await dashboard?.stop()
    await stubServer?.close()
    await targetServer?.close()
    cleanupTempRoots()
  })

  it('(1a) reasoning: the planner\'s own sentence is painted, non-empty', () => {
    const observed = firstVisit()
    expect(
      observed.planText,
      'the overview painted no `[data-sub-action-plan]` text for the selected sub-action. The '
      + 'reasoning is the `plan` string the projection carries; an empty node means the row, the '
      + `op, the route or the render lost it.${context()}`,
    ).not.toBe('')
    expect(observed.treeActionFamily, `the tree row has no action-family icon.${context()}`).toBeTruthy()
    expect(observed.treePlanCount, 'planner reasoning belongs in Overview, outside the tree').toBe(0)
  })

  it('(1b) sub-action timeline: the durable tree draws at least one recorded sub-action', () => {
    const observed = firstVisit()
    expect(
      observed.subActionCount,
      'the durable tree drew no `[data-sub-action]` row. The run recorded one, so either the '
      + 'subscriber wrote no `run_sub_actions` row, the projection dropped it, or the tree stopped '
      + `rendering it.${context()}`,
    ).toBeGreaterThanOrEqual(1)
  })

  it('(1c) decision screenshot: an <img> on the artifact route whose response was 200 image/png', () => {
    const observed = firstVisit()
    expect(observed.initialPlayerSource, context()).toBe('video')
    expect(
      observed.artifactState,
      'the overview rendered no screenshot pane at all for the selected sub-action. A ref-bearing '
      + `sub-action must reach either the available or the unavailable state.${context()}`,
    ).toBe('available')

    const src = observed.screenshotSrc ?? ''
    expect(
      src,
      'the decision screenshot is not addressed through the run-scoped content-addressed artifact '
      + `route.${context()}`,
    ).toMatch(ARTIFACT_ROUTE_RE)

    const served = observed.responses.filter((response) => response.url.endsWith(src))
    expect(
      served.map((response) => `${String(response.status)} ${response.contentType}`),
      'the browser issued no response for the screenshot `src` this page painted — the image is a '
      + `URL nobody fetched, which is not the same claim as a picture a person saw.${context()}`,
    ).not.toEqual([])
    expect(
      served.map((response) => response.status),
      `the artifact route did not answer 200 for the src the page painted.${context()}`,
    ).toContain(200)
    expect(
      served.some((response) => response.contentType.includes('image/png')),
      'the artifact route answered the screenshot request with something that is not a PNG: '
      + `${served.map((response) => response.contentType).join(', ')}${context()}`,
    ).toBe(true)
  })

  // The Overview row is gone, but a final step publication dropping usage must still red.
  it('(1d) token usage: recorded step spend survives removal of the redundant Overview row', () => {
    const observed = firstVisit()
    expect(
      observed.stepTokens,
      `the detail read lost the recorded step usage.${context()}`,
    ).toBeDefined()
    expect(
      observed.stepTokens,
      'the page reports this step as unmeasured. The stub answers non-zero `usage` on every arm, '
      + 'so an unmeasured reading means the step scope observed no model call, the member\'s final '
      + 'publication (`step-read-finalization.ts`) dropped its usage, or the projection lost it. '
      + 'Removing exactly that publication\'s usage must red '
      + `this cell alone.${context()}`,
    ).toBeGreaterThan(0)
    expect(observed.tokenSummary).toBeUndefined()
  })

  // The header sentence is composed from the same `/detail` response and `Intl` format.
  it("(1f) header token pair: the navbar spells the run's in/out pair from the detail read", () => {
    const observed = firstVisit()
    const tokens = observed.runTokens
    expect(tokens, `the detail read carries no run token totals at all.${context()}`).toBeDefined()
    expect(
      observed.runTokenSummary,
      'the header painted no `[data-run-token-summary]` root. The run\'s spend is the one accounting '
      + `number on this page; an absent root is the number going missing.${context()}`,
    ).toBeDefined()

    const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    const { measuredSteps, promptTokens, completionTokens } = tokens ?? { measuredSteps: 0 }
    const expected =
      measuredSteps > 0 && promptTokens !== undefined && completionTokens !== undefined
        ? `${compact.format(promptTokens)} in · ${compact.format(completionTokens)} out`
        : TOKENS_NOT_MEASURED_LABEL
    expect(
      observed.runTokenSummary,
      'the header must spell the run\'s spend as the labelled in/out pair the detail read carries — '
      + 'and an unmeasured run must say so rather than reading zero, which is a measurement nobody '
      + `took. tokens: ${JSON.stringify(tokens)}${context()}`,
    ).toBe(expected)
    expect(
      observed.runTokenSummary ?? '',
      'and the coverage caveat stays OUT of the header sentence. "of N steps" is a caveat '
      + 'about the number rather than the number, and the header is a glance; it belongs in the '
      + `usage card, where a reader who wants it is already looking.${context()}`,
    ).not.toMatch(/of \d+ steps/u)
  })

  // The real header trigger on the built product opens the card with the run's own totals.
  it('(1g) usage card: the header trigger opens the portalled card and its lines carry the run\'s own totals', () => {
    const observed = firstVisit()
    const tokens = observed.runTokens
    expect(tokens, `the detail read carries no run token totals at all.${context()}`).toBeDefined()
    expect(
      observed.usageCardOpened,
      'focusing the header\'s token line never attached `[data-usage-card]`: the compact pair is a '
      + 'door to the breakdown, and on the shipped bundle the door does not open, so the total, the '
      + 'cached input, the coverage caveat and the model identity are unreachable. undefined here '
      + `means the trigger itself was never painted.${context()}`,
    ).toBe(true)
    const lines = observed.usageCardLines ?? []
    expect(
      lines.length,
      `the card opened and painted no \`[data-usage-line]\` at all — an empty box where the spend should be.${context()}`,
    ).toBeGreaterThan(0)
    const totals = lines.filter((line) => line.kind === 'totals')
    expect(
      totals.length,
      'the card must carry exactly one totals line: none means the one sentence every run has is '
      + 'missing, and two means the card is stating the spend twice or the harvest read the '
      + `screen-reader duplicate. lines: ${JSON.stringify(lines)}${context()}`,
    ).toBe(1)

    const full = new Intl.NumberFormat('en-US')
    const { measuredSteps, promptTokens, completionTokens, totalTokens } = tokens ?? { measuredSteps: 0 }
    const expected =
      measuredSteps > 0
      && totalTokens !== undefined
      && promptTokens !== undefined
      && completionTokens !== undefined
        ? `${full.format(totalTokens)} total · ${full.format(promptTokens)} in · ${full.format(completionTokens)} out`
        : TOKENS_NOT_MEASURED_LABEL
    expect(
      totals[0]?.text,
      'the card\'s totals line must spell the spend the detail read carries, in full digits — the '
      + 'number the header\'s compact pair sends a reader here to check. A different number is the '
      + 'card and the header disagreeing about one run, and a zero for an unmeasured run is a '
      + `measurement nobody took. tokens: ${JSON.stringify(tokens)}${context()}`,
    ).toBe(expected)
    if (measuredSteps === 0) {
      expect(
        lines.filter((line) => line.kind === 'coverage'),
        'the card said nobody measured this run and then followed it with a coverage caveat about '
        + 'totals that do not exist: an undercount of nothing is the absent-vs-zero collapse. '
        + `lines: ${JSON.stringify(lines)}${context()}`,
      ).toEqual([])
    }
  })

  it('(1e) screen context: recorded hash survives removal of the redundant Overview chip', () => {
    const observed = firstVisit()
    expect(
      observed.screenStateHash,
      `the detail read lost the sub-action screen-state hash.${context()}`,
    ).toBeDefined()
    expect(
      observed.screenStateHash ?? '',
      `the detail read carries an empty screen-state hash.${context()}`,
    ).not.toBe('')
    expect(observed.screenStateChip).toBeUndefined()
  })

  it('(2a) the env credential is VISIBLE on the page as written', () => {
    const observed = firstVisit()
    expect(
      observed.bodyText.includes(POPULATED_SECRET_VALUE),
      'the `_SECRET`-named environment credential is NOT visible on run detail. It is not a '
      + 'declared secret, so the run records it as written and the page shows it as written'
      + `.${context()}`,
    ).toBe(true)

    // THE TWO VALUES SHARE ONE SENTENCE, and this is where that is held: without it, (2a) and (2e)
    // could drift onto two unrelated strings and both go on passing about nothing in particular.
    expect(
      observed.planText,
      'the env credential and the declared lane\'s named marker are not in the same recorded '
      + 'sentence, so cells (2a) and (2e) are no longer contrasting two lanes of one string. The '
      + `fixture plants both in the planner's reasoning.${context()}`,
    ).toContain(POPULATED_SECRET_VALUE)
    expect(
      observed.planText,
      'the same sentence no longer carries the declared lane\'s named marker — see the message '
      + `on cell (2e), which owns that fact.${context()}`,
    ).toContain(DECLARED_SECRET_MARKER)
  })

  it('(2b) the declared value is in neither the SSE frames, the log nor the database, and the email and the env credential are there as written', () => {
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

    expect(
      (recorded.sseFrames ?? '').includes(POPULATED_DECLARED_SECRET_VALUE),
      `the declared step secret appears IN CLEAR in the run-stream frames the local door served.${context()}`,
    ).toBe(false)
    expect(
      (recorded.eventsLog ?? '').includes(POPULATED_DECLARED_SECRET_VALUE),
      `the declared step secret appears IN CLEAR in this run's events.jsonl.${context()}`,
    ).toBe(false)
    expect(
      (recorded.dbBytes ?? Buffer.alloc(0)).includes(Buffer.from(POPULATED_DECLARED_SECRET_VALUE, 'utf8')),
      'the declared step secret appears IN CLEAR in the dashboard\'s own SQLite bytes '
      + `(${recorded.scannedDbFiles.join(', ')}).${context()}`,
    ).toBe(false)

    // Undeclared values are recorded as written.
    for (const [what, value] of [
      ['the env credential', POPULATED_SECRET_VALUE],
      ['the planted email address', POPULATED_EMAIL],
    ] as const) {
      expect(
        (recorded.sseFrames ?? '').includes(value),
        `${what} is not in the run-stream frames as written.${context()}`,
      ).toBe(true)
      expect(
        (recorded.eventsLog ?? '').includes(value),
        `${what} is not in this run's events.jsonl as written.${context()}`,
      ).toBe(true)
    }
  })

  it('(2c) the email renders as written, with no chip', () => {
    const observed = firstVisit()
    expect(
      observed.bodyText.includes(POPULATED_EMAIL),
      `the planted address is not shown as written on the page.${context()}`,
    ).toBe(true)
    expect(
      observed.maskedCategories,
      `the page painted a \`[data-masked="email"]\` chip for an address the run recorded as written.${context()}`,
    ).not.toContain('email')
  })

  it('(2d) after the dashboard is killed and respawned, the env credential is still shown as written', () => {
    driveOk()
    expect(
      recorded.respawned,
      `the replacement \`agent-qa dashboard\` never said it was listening.${context()}`,
    ).toBe(true)
    const observed = recorded.afterRestart
    expect(
      observed,
      `the run-detail page was never re-observed after the restart.${context()}`,
    ).toBeDefined()
    expect(
      (observed as PageObservation).bodyText.includes(POPULATED_SECRET_VALUE),
      'the env credential is not shown as written by a dashboard that never saw this run execute; '
      + `the run recorded it as written, so the page reads it from the record.${context()}`,
    ).toBe(true)
  })

  it('(2e) the DECLARED-secret lane is irreversible: the value is absent and its named marker is what a person sees', () => {
    const observed = firstVisit()
    const marker = DECLARED_SECRET_MARKER

    // The at-rest half of criterion 2 HOLDS for this lane, and this is where that is stated on the
    // page rather than only in the log: the declared value is nowhere a person can read it.
    expect(
      observed.bodyText.includes(POPULATED_DECLARED_SECRET_VALUE),
      'a value declared in the project\'s secret store is VISIBLE on run detail. The runner\'s '
      + `redactor is supposed to have consumed it before anything was recorded.${context()}`,
    ).toBe(false)

    // The redactor writes the marker before evidence exists, so nothing can restore the value.
    expect(
      observed.planText,
      'the declared step credential no longer resolves to the redactor\'s named marker in the '
      + 'planner\'s recorded reasoning. Either the redaction lane changed — in which case WINDOWS '
      + '#286 must be re-measured, because the two-lane finding it records is what this cell holds '
      + `— or the reasoning stopped carrying the credential at all.${context()}`,
    ).toContain(marker)
  })

  describe('declared markers on run detail', () => {
    it('run detail shows a declared marker as text', () => {
      const observed = firstVisit()
      expect(
        observed.stepRowText,
        'the step row does not show the declared value\'s stored `[secret:<name>]` as text. The '
        + `step text references the value declared in the fixture's secrets file.${context()}`,
      ).toContain(DECLARED_SECRET_MARKER)
      expect(
        observed.textNodes.some((text) => text.includes(DECLARED_SECRET_MARKER)),
        `no text node holds the stored marker as written.${context()}`,
      ).toBe(true)
      expect(
        observed.maskedCategories,
        `the page painted a masked-value chip; a stored marker is shown as text.${context()}`,
      ).toEqual([])
      expect(observed.bodyText, context()).not.toMatch(/masked (?:secret|email)/u)
    })
  })
})
