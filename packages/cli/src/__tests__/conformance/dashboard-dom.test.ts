/// <reference lib="dom" />
// The DOM lib is referenced here alone: this file's `page.evaluate` callbacks run in a browser.

// A browser that cannot launch is a red, never a skip: a skip exits 0 and proves nothing.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { chromium } from 'playwright-core'
import type { Browser, Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ANCHORED_BUILDS,
  CLI_PACKAGE_ROOT,
  DASHBOARD_ANCHORED_BUILDS,
  PACKAGES_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  reserveEphemeralPort,
  spawnDashboard,
  trackTempRoot,
} from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

/**
 * What a caller is told when Chromium cannot be launched.
 *
 * The pinned `playwright-core` brings its own browser revision, so the fix is that package's own
 * installer rather than a global one — named here because a failure message that says only "browser
 * not found" costs the reader the search.
 */
const BROWSER_INSTALL_INSTRUCTION =
  'Chromium could not be launched by the pinned playwright-core. Run '
  + '`node node_modules/playwright-core/cli.js install chromium` from packages/cli (or the '
  + 'workspace-resolved equivalent) and re-run. THESE CELLS MUST NOT BE SKIPPED WHEN THE BROWSER '
  + 'IS ABSENT: they measure the shipped dashboard bundle in the medium a person actually sees, '
  + 'and a skip would report a green suite that measured nothing.'

/** The one dashboard every cell in this file drives, and the browser that drives it. */
interface DomFixture {
  readonly dashboard: SpawnedDashboard
  readonly browser: Browser
  readonly origin: string
}

let fixture: DomFixture | undefined

/**
 * Stand the whole instrument up once: freshness, dashboard, browser.
 *
 * ONE DASHBOARD AND ONE BROWSER FOR THE FILE, because both cost seconds and the cells below are
 * independent of each other's state — each opens its own page.
 */
beforeAll(async () => {
  // FIRST, AND BEFORE ANYTHING IS SPAWNED. A stale build is worse than an absent one.
  const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
  expect(freshness, REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

  const project = dashboardFixtureProject('dom')
  const port = await reserveEphemeralPort()
  const dashboard = await spawnDashboard(project.root, project.configPath, port)
  expect(
    dashboard.ready,
    'the built `agent-qa dashboard` command never reported that it was listening. its stdout: '
    + `${JSON.stringify(dashboard.stdout().slice(-1200))}; its stderr: `
    + `${JSON.stringify(dashboard.stderr().slice(-1200))}`,
  ).toBe(true)

  let browser: Browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    await dashboard.stop()
    throw new Error(
      `${BROWSER_INSTALL_INSTRUCTION} underlying error: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  fixture = { dashboard, browser, origin: dashboard.origin }
}, 180_000)

afterAll(async () => {
  const held = fixture
  fixture = undefined
  if (held !== undefined) {
    await held.browser.close()
    await held.dashboard.stop()
  }
  cleanupTempRoots()
})

/** The fixture, or a failure that names what did not stand up rather than a `undefined` read. */
function live(): DomFixture {
  expect(fixture, 'the DOM fixture did not stand up; see the beforeAll failure above').toBeDefined()
  if (fixture === undefined) throw new Error('unreachable: the assertion above has already failed')
  return fixture
}

/**
 * Open one page on a served route and wait for the page's own ready selector.
 *
 * WAITING ON THE PAGE rather than on `load`: the app is a client-routed SPA, so the document
 * finishes loading long before React has mounted the route, and a cell that asserted at `load`
 * would be asserting about an empty shell.
 */
async function openApp(path: string, ready: string): Promise<Page> {
  const { browser, origin } = live()
  const page = await browser.newPage()
  const failures: string[] = []
  page.on('pageerror', (error) => { failures.push(String(error)) })
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(ready, { timeout: 30_000 })
  expect(
    failures,
    `the built bundle threw while mounting ${path}, so everything below would be measuring a `
    + 'half-rendered page',
  ).toEqual([])
  return page
}

const RUNS_READY = '[data-tour-id="tour-runs-table"]'

/** Each page an absence is measured on, with the selector that says the page itself mounted. */
const PAGES = [
  ['/runs', RUNS_READY],
  ['/tests', '[data-tour-id="tour-tests-table"]'],
  ['/config', '[data-config-page]'],
] as const

// The removed launcher's test id, built from halves so a text search for it finds only its return.
const OLD_LAUNCHER = `[data-testid="${'chat-panel' + '-launcher'}"]`

/** How many conversation affordances a page offers: the link, the panel, its opener, its launcher. */
async function conversationAffordances(page: Page): Promise<Record<string, number>> {
  return {
    link: await page.locator('a[href="/chat"]').count(),
    panel: await page.locator('[data-chat-panel]').count(),
    panelOpen: await page.locator('[data-chat-panel-open]').count(),
    launcher: await page.locator(OLD_LAUNCHER).count(),
  }
}

const NONE = { link: 0, panel: 0, panelOpen: 0, launcher: 0 }

describe('the shipped dashboard has no conversation', () => {
  it('NO-CHAT-IN-SHIPPED-BUNDLE: /chat lands on Runs and no page links to or mounts a conversation',
    async () => {
      // THE HARNESS'S OWN TRACER as well as an absence: it needs the build fresh, the shipped
      // command bound to a port, the server serving the bundle and the bundle mounted in a real
      // browser. The ready selector is the runs page's, so `/chat` reaching it IS the catch-all.
      const page = await openApp('/chat', RUNS_READY)
      try {
        expect(new URL(page.url()).pathname, 'the served /chat did not land on Runs').toBe('/runs')
        expect(await conversationAffordances(page)).toEqual(NONE)
        const bundle = `${PACKAGES_ROOT}/dashboard-ui/dist/index.html`
        expect(
          existsSync(bundle),
          `the served bundle is missing at ${relative(PACKAGES_ROOT, bundle)}; ${REBUILD_INSTRUCTION}`,
        ).toBe(true)
      } finally {
        await page.close()
      }
    }, 120_000)

  // Each explorer-shaped path reaches the runs page's ready selector, so the catch-all served it.
  it('NO-EXPLORER-IN-SHIPPED-BUNDLE: memory and knowledge explorer paths land on Runs and nothing links to one',
    async () => {
      const paths = [
        '/memory',
        '/memories',
        '/Memory',
        '/knowledge',
        '/knowledge/',
        '/knowledges',
        '/knowledge-base',
        '/memory/MEM-1',
        '/knowledge/explorer',
      ]
      const explorerLinks = 'a[href*="/memor" i], a[href^="/knowledge" i]'
      for (const path of paths) {
        const page = await openApp(path, RUNS_READY)
        try {
          expect(new URL(page.url()).pathname, `the served ${path} did not land on Runs`).toBe('/runs')
          expect(await page.locator(explorerLinks).count(), `${path}: a link names an explorer`).toBe(0)
        } finally {
          await page.close()
        }
      }

      const page = await openApp('/runs', RUNS_READY)
      try {
        await page.keyboard.press('Control+k')
        const pageItems = page.locator('[cmdk-item][data-value^="page-"]')
        await pageItems.first().waitFor({ timeout: 30_000 })
        const entries = await pageItems.evaluateAll((items) =>
          items.map((item) => `${item.getAttribute('data-value') ?? ''} ${item.textContent ?? ''}`))
        expect(
          entries.some((entry) => entry.startsWith('page-Runs')),
          `the palette read found no Runs page entry, so an absence below would measure nothing: ${entries.join(' | ')}`,
        ).toBe(true)
        expect(entries.filter((entry) => /memor|knowledge/i.test(entry))).toEqual([])
      } finally {
        await page.close()
      }
    }, 120_000)

  it('NO-CHAT-MOUNT-ON-ANY-PAGE: /runs, /tests and /config offer no panel, opener or launcher',
    async () => {
      for (const [path, ready] of PAGES) {
        const page = await openApp(path, ready)
        try {
          expect(await conversationAffordances(page), path).toEqual(NONE)
        } finally {
          await page.close()
        }
      }
    }, 180_000)

  it('NO-CHAT-REMEDY-SENTENCES-IN-BUNDLE: no shipped script carries the removed remedy prose', () => {
    const dist = join(PACKAGES_ROOT, 'dashboard-ui', 'dist')
    const assets = join(dist, 'assets')
    expect(existsSync(assets), REBUILD_INSTRUCTION).toBe(true)
    const scripts = readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .map((name) => [name, readFileSync(join(assets, name), 'utf8')] as const)

    // The known answer: copy the sidebar ships, so the scan is shown reading real bundle text.
    expect(
      scripts.some(([, text]) => text.includes('Take product tour')),
      'the scan found no known sidebar copy, so an absence below would measure nothing',
    ).toBe(true)

    const removed = ['keep this chat open ' + 'and re-run it', 'start a new chat ' + 'session to run it']
    const hits = scripts.flatMap(([name, text]) =>
      removed.filter((needle) => text.includes(needle)).map((needle) => `${name}: ${needle}`),
    )
    expect(hits).toEqual([])
  })
})

describe('the instrument this file runs on, asserted rather than assumed', () => {
  it('drives the AUDITED playwright-core pin and never a version resolved at install time', () => {
    // The exact `playwright-core` pin: a range lets the audited and the installed artifact differ.
    const manifest = JSON.parse(
      readFileSync(join(CLI_PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const declared = {
      ...(manifest.devDependencies ?? {}),
      ...(manifest.dependencies ?? {}),
    }['playwright-core']
    expect(
      declared,
      'this package no longer declares playwright-core, so the browser these cells launch is '
      + 'whatever a hoist happened to leave in node_modules — an unaudited artifact',
    ).toBe('1.61.0')

    // And the runtime the cells actually launched is that package's own browser, not a system one.
    expect(
      typeof chromium.executablePath(),
      'playwright-core resolved no browser executable path at all',
    ).toBe('string')
  })

  it('guards the freshness of the dashboard SERVER and UI dists, not only the chat five', () => {
    // A browser's bundle comes through `dashboard-server`, so both builds are checked as fresh.
    const guarded = DASHBOARD_ANCHORED_BUILDS.map((build) => `${build.pkg}/${build.artifact}`)
    expect(guarded).toContain(join('dashboard-server', 'dist', 'index.js'))
    expect(guarded).toContain(join('dashboard-ui', 'dist', 'index.html'))
    // The chat five are still in it: this list EXTENDS the shared one rather than replacing it, so
    // a `cli` dist a revision behind still refuses here too.
    for (const build of ANCHORED_BUILDS) {
      expect(guarded).toContain(`${build.pkg}/${build.artifact}`)
    }
  })

  it('REFUSES a missing dashboard dist and a stale one, by name (the guard, driven)', () => {
    // The guard's refusing branches, reached with a synthetic package tree rather than by deleting
    // a real `dist`. `parity-anchors.test.ts` drives the same two branches for the chat list; this
    // drives them for the two entries this plan added, so the extension is measured rather than
    // asserted about.
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-guard-')))
    const builds = [{ pkg: 'dashboard-ui', artifact: join('dist', 'index.html') }]
    mkdirSync(join(root, 'dashboard-ui', 'src'), { recursive: true })
    writeFileSync(join(root, 'dashboard-ui', 'src', 'app.css'), 'body{}', 'utf8')

    expect(
      buildFreshness(builds, root).missing,
      'the guard did not notice an absent bundle',
    ).toEqual([join('dashboard-ui', 'dist', 'index.html')])

    mkdirSync(join(root, 'dashboard-ui', 'dist'), { recursive: true })
    const bundle = join(root, 'dashboard-ui', 'dist', 'index.html')
    writeFileSync(bundle, '<!doctype html>', 'utf8')
    const past = new Date(Date.now() - 60_000)
    utimesSync(bundle, past, past)
    expect(
      buildFreshness(builds, root).stale,
      'the guard did not notice a bundle older than the source it was built from — and a `.css` '
      + 'edit is exactly the kind a computed-style cell depends on',
    ).toEqual([
      `${join('dashboard-ui', 'src', 'app.css')} is newer than `
      + `${join('dashboard-ui', 'dist', 'index.html')}`,
    ])

    // And the passing arm, so the guard is watched agreeing as well as refusing. The stamp is a
    // MINUTE ahead rather than `new Date()`: the source above was written in the same millisecond
    // band, and a guard comparing `newer > artifact` at that resolution reports a stale bundle for
    // a build that really did follow its source — a flake in the control rather than in the guard.
    const built = new Date(Date.now() + 60_000)
    utimesSync(bundle, built, built)
    expect(buildFreshness(builds, root)).toEqual({ missing: [], stale: [] })
  })
})
