/// <reference lib="dom" />
// The DOM lib is referenced because the `addInitScript` / `evaluate` callbacks below are compiled
// as TypeScript here and EXECUTED in a browser — `EventSource`, `MutationObserver` and `Element`
// are otherwise unresolved names under `tsc --noEmit` while running perfectly under vitest.
// `conformance/dashboard-dom.test.ts` carries the same reference for the same reason.

// THE RUN TRIGGER'S CONFIRM LOOP, CLOSED THROUGH A REAL BROWSER (Phase 401, UAT item 15 / Truth 6).
//
// SINCE 432-13 (D-14/D-15) there was no loop to close: the run button's run asked nobody. SINCE
// 432-14 there is nothing left of the loop at all — no channel the page holds open, no scope the
// trigger carries, no dialog in the bundle. The cells below drive the same real clicks and pin that
// a click is one request and the run starts at once. History below kept as written.
//
// WHAT WAS UNVERIFIED, AND WHY IT STAYED THAT WAY. 401-09 built both halves of this loop and could
// measure neither end against the other: the SERVER end is driven end-to-end by
// `run-trigger-confirm.test.ts` over `fetch`-parsed SSE, and the DIALOG's render was driven in jsdom,
// which has no `EventSource`. The wire itself was source-pinned.
//
// SO THIS FILE PUTS A REAL CHROMIUM IN FRONT OF A REALLY-RUNNING DASHBOARD. The server is
// `startServer` with the shipped `uiDir`, so what the browser downloads is `dashboard-ui`'s own
// `vite build` output — the bundle a person installs. The door is `composeDashboardDoor` /
// `createDashboardRunDoor`, the same composers `agent-qa dashboard` calls, which is why this file
// lives in `packages/cli` beside its server-side sibling (`dashboard-server` may not name
// `@vostride/agent-qa-agent*`; validate:arch).
//
// NOTHING BELOW SUBSTITUTES FOR THE TRANSPORT. The page's `EventSource` is REPLACED BY A SUBCLASS
// OF THE NATIVE ONE, which calls `super(url)` and records the URL. The page's requests are read off
// Chromium's own request events, bodies included.
//
// AND THE RUN IS STARTED BY CLICKING THE PRODUCT'S OWN BUTTON. The cells select a row on the tests
// page and walk the real Run → Run path.
//
// A BROWSER THAT CANNOT LAUNCH IS A RED, NEVER A SKIP, and a stale `dist` is a red before that:
// `dashboard-dom.test.ts`'s two rules, inherited verbatim. There is no environment predicate in
// this file.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// 2026-10-19 (444.1-24, D-39): each drive and its detached tail are awaited before removal.
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

import { DashboardDatabase, startServer } from '@vostride/agent-qa-dashboard'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

import { composeDashboardDoor, createDashboardRunDoor } from '../dashboard.js'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { AuditRow } from '../../composition/__tests__/in-process-run-fixture.js'
import {
  DASHBOARD_ANCHORED_BUILDS,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
} from '../../__tests__/conformance/spawned-chat.js'

type Fixture = ReturnType<typeof createInProcessFixture>

/** The built UI the server hands the browser — the thing `agent-qa dashboard` serves. */
const UI_DIR = join(PACKAGES_ROOT, 'dashboard-ui', 'dist')

/**
 * The machine's OWN browsers root, read at module load.
 *
 * READ HERE AND NOWHERE ELSE, because `openScene` below overwrites `PLAYWRIGHT_BROWSERS_PATH` with
 * an empty directory — deliberately, so an approved run cannot launch a browser and knock on the
 * counting target a second time. This file needs a REAL chromium for its own driving, so the value
 * is captured before any scene has run and restored around the one launch.
 */
const BROWSERS_PATH_AT_LOAD = process.env.PLAYWRIGHT_BROWSERS_PATH

// ---- the recorder the page carries -------------------------------------------------------------

interface TriggerRequest {
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}

/** One rendered state of any confirm or approval surface, as the DOM held it. */
interface DialogShot {
  readonly present: boolean
  readonly text?: string
}

interface PageWire {
  /** Every URL the page opened an `EventSource` on, in order. */
  readonly eventSources: readonly string[]
  readonly dialogs: readonly DialogShot[]
}

/**
 * Install the two instruments, before any of the app's own script runs.
 *
 * `EventSource` IS SUBCLASSED, NOT REPLACED — see this file's header. `MutationObserver` records
 * every DISTINCT rendered state of any approval surface, which is what makes "nothing was shown" an
 * assertion over what the DOM actually held rather than over one lucky snapshot.
 */
async function installWireRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const wire = { eventSources: [] as string[], dialogs: [] as unknown[] }
    ;(window as unknown as { __wire: typeof wire }).__wire = wire

    const NativeEventSource = window.EventSource
    class RecordingEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        wire.eventSources.push(String(url))
      }
    }
    ;(window as unknown as { EventSource: unknown }).EventSource = RecordingEventSource

    const shoot = (): void => {
      const el = document.querySelector(
        '[data-run-confirm-dialog], [data-feedback-approval], [data-confirm-answer], [aria-label*="Approval"]',
      )
      const shot = el === null ? { present: false } : { present: true, text: el.textContent ?? '' }
      const last = wire.dialogs[wire.dialogs.length - 1]
      if (last === undefined || JSON.stringify(last) !== JSON.stringify(shot)) {
        wire.dialogs.push(shot)
      }
    }
    // OBSERVED ON `document`, NOT ON `documentElement`. This script runs at document-start, before
    // the parser has created `<html>` — `observe(document.documentElement, …)` throws there.
    new MutationObserver(shoot).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  })
}

async function readWire(page: Page): Promise<PageWire> {
  return await page.evaluate(
    () => (window as unknown as { __wire: PageWire }).__wire,
  ) as PageWire
}

/** Every request the page sent to the trigger route, bodies parsed, in order. */
function recordTriggers(page: Page): TriggerRequest[] {
  const triggers: TriggerRequest[] = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/runs/trigger')) return
    const raw = request.postData()
    triggers.push({
      method: request.method(),
      body: raw === null ? undefined : JSON.parse(raw) as Record<string, unknown>,
    })
  })
  return triggers
}

// ---- the scene ---------------------------------------------------------------------------------

interface Scene {
  readonly origin: string
  readonly fixture: Fixture
  readonly db: DashboardDatabase
  settled(): { runId: string; status: string; details: Record<string, unknown> }[]
  /** The run's OWN bus envelopes, in seq order, recorded off its session (405-07). */
  buffered(runId: string): Record<string, unknown>[]
  close(): Promise<void>
}

const openScenes: Scene[] = []
const openContexts: BrowserContext[] = []
let browser: Browser | undefined

/**
 * The dashboard as the shipped command starts it, WITH ITS BUILT UI ATTACHED.
 *
 * This is `run-trigger-confirm.test.ts`'s `openScene` plus `uiDir` — the one thing that turns an
 * API-only server into something a browser can be pointed at. Everything else is that file's
 * recipe, deliberately: two answers to "how is this dashboard composed" would be two dashboards.
 */
async function openScene(input: { fixture: Fixture }): Promise<Scene> {
  const { fixture } = input
  // AN EMPTY BROWSERS ROOT, kept for parity with `run-trigger-confirm.test.ts` — AND MEASURED
  // NOT TO WORK HERE, which is worth stating rather than leaving as a comment that lies.
  // `playwright-core` resolves its browsers root ONCE, at first use, and caches it: this file
  // launches a real chromium in `beforeAll`, so by the time this line runs the registry has
  // already memoised the machine's own cache and the RUN's own `chromium.launch()` succeeds.
  // (Verified directly: `chromium.executablePath()` returns the same path after
  // `PLAYWRIGHT_BROWSERS_PATH` is reassigned.) The consequence is deliberate and named: an
  // approved run in this file drives a REAL browser at the counting target, so `target.hits` is a
  // membership assertion here, never a count. The five-artifact set below is what carries the
  // "the run started" claim, exactly as it does in the sibling.
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot

  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const runDoor = await createDashboardRunDoor({ db })
  const door = composeDashboardDoor({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    boundOrigin: () => undefined,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(door.host)

  const settled: { runId: string; status: string; details: Record<string, unknown> }[] = []
  runDoor.backend.on(
    'run-settled',
    (runId: string, status: string, details: Record<string, unknown>) => {
      settled.push({ runId, status, details })
    },
  )

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    uiDir: UI_DIR,
    configPath: fixture.configPath,
    workspacePaths: resolveWorkspacePaths({
      config: parseYaml(readFileSync(fixture.configPath, 'utf8')) as never,
      configPath: fixture.configPath,
    }),
    executionBackend: runDoor.backend,
    agentHost: door.agentHost,
  })
  // 2026-08-27 (405-07, D-19): the run's OWN bus, watched through the door's published
  // `observeSessions`. This used to read the backend's per-run replay buffer, which existed for one
  // SSE route and was deleted with it; `subscribe(1, …)` is replay-then-live from the first seq, so
  // a recorder registered here sees every envelope of every run this door starts.
  const recordedEnvelopes = new Map<string, Record<string, unknown>[]>()
  runDoor.observeSessions((session) => {
    const id = session.id as unknown as string
    const own: Record<string, unknown>[] = []
    recordedEnvelopes.set(id, own)
    session.subscribe(1, (envelope) => { own.push(envelope as unknown as Record<string, unknown>) })
  })

  // `startServer` echoes the port it was ASKED for, so an ephemeral bind is read off the socket.
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new TypeError('the server bound no port')

  const scene: Scene = {
    origin: `http://127.0.0.1:${String(address.port)}`,
    fixture,
    db,
    settled: () => settled,
    buffered: (runId) => recordedEnvelopes.get(runId) ?? [],
    close: async () => {
      started.close()
      await door.host.close()
    },
  }
  openScenes.push(scene)
  return scene
}

/** Every `run:start` decision the project recorded, in the order they were taken. */
function runStartRows(fixture: Fixture): AuditRow[] {
  return (auditRows(fixture) as AuditRow[])
    .filter((row) => row.action === 'run:start')
    .sort((left, right) => String(left.ts).localeCompare(String(right.ts)))
}

async function waitFor(assertion: () => void, timeoutMs = 180_000): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((settle) => setTimeout(settle, 25))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('Timed out waiting for assertion')
}

// ---- the person at the keyboard -----------------------------------------------------------------

/**
 * Open the dashboard and dismiss the first-visit tour.
 *
 * 432-14: there is no scope frame to wait for any more. The page is ready when the tests table has
 * rendered the fixture's own row, which is what a person waits for before clicking.
 */
async function openDashboard(scene: Scene): Promise<{ page: Page; pageErrors: string[] }> {
  const context = await browser!.newContext()
  openContexts.push(context)
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await installWireRecorder(page)
  await page.goto(`${scene.origin}/tests`, { waitUntil: 'domcontentloaded' })
  await page.locator('tr', { hasText: 'direct.yaml' }).first().waitFor({ timeout: 60_000 })
  expect(pageErrors, 'the built dashboard threw before it rendered the tests table').toEqual([])

  const skip = page.getByRole('button', { name: 'Skip' })
  if (await skip.isVisible()) await skip.click()
  return { page, pageErrors }
}

/** Select one test by its file name — the row a person clicks. */
async function selectTest(page: Page, fileName: string): Promise<void> {
  const row = page.locator('tr', { hasText: fileName })
  await row.locator('button[aria-label="Select row"]').click()
}

/**
 * Click Run → Run, which is the product's own two-step path to a run.
 *
 * THE INNER BUTTON IS SCOPED TO THE POPOVER rather than picked positionally: both are labelled
 * "Run", and a positional pick resolved before the popover rendered would click the trigger again
 * and close it — a flake, and exactly the kind this file must not ship.
 */
async function clickRun(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Run', exact: true }).first().click()
  const popover = page.locator('[data-slot="popover-content"]')
  await popover.waitFor({ state: 'visible' })
  await popover.getByRole('button', { name: 'Run', exact: true }).click()
}

// ---- the file's own preconditions ----------------------------------------------------------------

beforeAll(async () => {
  const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) {
    throw new Error(
      `${REBUILD_INSTRUCTION}\nmissing: ${JSON.stringify(freshness.missing)}\n`
      + `stale: ${JSON.stringify(freshness.stale)}`,
    )
  }
  if (!existsSync(join(UI_DIR, 'index.html'))) {
    throw new Error(`no built dashboard UI at ${UI_DIR} — ${REBUILD_INSTRUCTION}`)
  }
  // Restore the machine's own browsers root for the ONE launch: a previous file in this worker may
  // have pointed it at an empty fixture directory, and this cell needs a real chromium.
  if (BROWSERS_PATH_AT_LOAD === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH_AT_LOAD
  browser = await chromium.launch()
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await Promise.allSettled(tails.splice(0))
  removeInProcessFixtures()
})

afterEach(async () => {
  while (openContexts.length > 0) await openContexts.pop()!.close()
  while (openScenes.length > 0) await openScenes.pop()!.close()
})

/** The execution context the run published on its own `runStarted` envelope. */
function startedContext(scene: Scene, runId: string): unknown {
  const started = scene.buffered(runId).find((event) => event['type'] === 'runStarted') as
    { payload?: { executionContext?: unknown } } | undefined
  return started?.payload?.executionContext
}

describe('the run trigger confirm loop, closed through a real browser (UAT item 15, Truth 6)', () => {
  // RE-SPELLED 2026-10-01 (432-14): was 'SINGLE CONFIRM — the EventSource carries the scope, and
  // clicking Run starts the run with no dialog' (432-13). The page holds no channel and the trigger
  // carries no scope, so the claim is now the click itself: one request, one run.
  it('C432-BROWSER-RUN-ONE-CLICK: one click is one trigger request, and a non-production run starts at once', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      const scene = await openScene({ fixture })
      const { page, pageErrors } = await openDashboard(scene)
      const triggers = recordTriggers(page)

      const triggeredRunIds: string[] = []
      page.on('response', (response) => {
        if (!response.url().endsWith('/api/runs/trigger')) return
        void response.json().then(
          (body: unknown) => {
            const runId = (body as { runId?: string }).runId
            if (typeof runId === 'string') triggeredRunIds.push(runId)
          },
          () => undefined,
        )
      })

      await selectTest(page, 'direct.yaml')
      await clickRun(page)

      await waitFor(() => { expect(scene.settled()).toHaveLength(1) })
      await waitFor(() => { expect(triggeredRunIds).toHaveLength(1) })
      const runId = triggeredRunIds[0]!

      expect(triggers, 'one click did not send exactly one trigger request').toHaveLength(1)
      expect(triggers[0]!.method).toBe('POST')
      expect(triggers[0]!.body).not.toHaveProperty('confirm' + 'Scope')
      expect(runStartRows(fixture)).toEqual([])
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits, 'the run never touched the target').toContain('/in-process-thing')
      expect(startedContext(scene, runId)).toBe('local-headless')

      const wire = await readWire(page)
      expect(wire.eventSources.filter((url) => url.includes('run-confirm')), 'the page opened a confirm channel')
        .toEqual([])
      expect(wire.dialogs.filter((shot) => shot.present), 'an approval surface was rendered').toEqual([])
      expect(pageErrors).toEqual([])
    } finally {
      await target.close()
    }
  }, 300_000)

  // RE-SPELLED 2026-09-30 (432-13): was 'OVERLAPPING CONFIRMS — the arriving question WAITS ...'
  // (G-401-15). Two clicks now start two runs and no question is raised, queued or reaped.
  it('OVERLAPPING CONFIRMS — two clicks start two runs, and no question is raised, queued or reaped (G-401-15)', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({
        origin: target.origin,
        environment: 'shared',
        parallelRuns: true,
      })
      const scene = await openScene({ fixture })
      const { page } = await openDashboard(scene)
      const triggers = recordTriggers(page)

      const triggeredRunIds: string[] = []
      page.on('response', (response) => {
        if (!response.url().endsWith('/api/runs/trigger')) return
        void response.json().then(
          (body: unknown) => {
            const runId = (body as { runId?: string }).runId
            if (typeof runId === 'string') triggeredRunIds.push(runId)
          },
          () => undefined,
        )
      })

      await selectTest(page, 'direct.yaml')
      await clickRun(page)
      await clickRun(page)

      await waitFor(() => { expect(triggeredRunIds).toHaveLength(2) })
      await waitFor(() => { expect(scene.settled()).toHaveLength(2) })
      expect(triggers).toHaveLength(2)
      for (const runId of triggeredRunIds) {
        expect(scene.buffered(runId).map((event) => event['type']), `${runId} never started`)
          .toContain('runStarted')
      }
      expect(runStartRows(fixture)).toEqual([])

      const wire = await readWire(page)
      expect(wire.eventSources.filter((url) => url.includes('run-confirm'))).toEqual([])
      expect(wire.dialogs.filter((shot) => shot.present)).toEqual([])
      expect(
        await page.evaluate(() => document.body.innerText),
      ).not.toContain('denied — nobody answered before the window closed')
    } finally {
      await target.close()
    }
  }, 300_000)
})
