/// <reference lib="dom" />
// The built dashboard in real Chromium with a hermetic HOME; the cells share one spawned dashboard.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse, parseDocument } from 'yaml'

import { POPULATED_MODEL_ID, startStubModelServer, type StubModelServer } from './populated-run-fixture.js'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  reserveEphemeralPort,
  spawnDashboard,
  trackTempRoot,
  type SpawnedDashboard,
} from './spawned-chat.js'

const DESKTOP = { width: 1280, height: 800 }
const NARROW = { width: 400, height: 800 }
type Viewport = typeof DESKTOP
const labelOf = (viewport: Viewport) => `${String(viewport.width)}x${String(viewport.height)}`

const TABS = ['models', 'targets', 'execution', 'project', 'advanced'] as const
const TAB_LABELS = ['Models', 'Targets', 'Execution', 'Project', 'Advanced']
const INNER_MAIN = 'main main'

// The 21 live legacy links, written out rather than imported, each with the tab it lands on and the
// section heading that must hold focus there.
const LEGACY_LINKS = [
  ['workspace', 'discovery', 'project', 'test-discovery', 'Test discovery'],
  ['workspace', 'files', 'project', 'files', 'Hooks, env and secrets files'],
  ['knowledge', 'store', 'project', 'knowledge', 'Knowledge store'],
  ['services', 'dashboard', 'project', 'dashboard', 'Dashboard'],
  ['services', 'cache', 'execution', 'cache', 'Cache'],
  ['services', 'auth-states', 'targets', 'login-states', 'Saved login states'],
  ['services', 'logging', 'project', 'logging', 'Logging'],
  ['services', 'recording', 'execution', 'recording', 'Recording'],
  ['services', 'accessibility', 'execution', 'accessibility', 'Accessibility'],
  ['services', 'vision', 'models', 'screenshot-size', 'Screenshot size'],
  ['registry', 'llms', 'models', 'models', 'Models'],
  ['registry', 'targets', 'targets', 'targets', 'Targets'],
  ['registry', 'devices', 'targets', 'devices', 'Devices'],
  ['use', 'browser', 'execution', 'browser', 'Browser'],
  ['use', 'timeouts', 'execution', 'timeouts', 'Timeouts'],
  ['use', 'planner', 'models', 'planner-limits', 'Planner limits'],
  ['use', 'log-capture', 'execution', 'log-capture', 'Log capture'],
  ['use', 'mobile', 'targets', 'mobile-app-state', 'Mobile app state'],
  ['use', 'execution-defaults', 'models', 'models', 'Models'],
  ['analytics', 'pass-rate-scope', 'project', 'pass-rate-scope', 'Pass-rate scope'],
] as const

// Invented sentinels only: nothing here exists outside this file.
const SENTINELS = {
  header: 'zz-429-33-HEADER-SENTINEL-4c1e',
  access: 'zz-429-33-ACCESS-HEADER-9b27',
  udid: 'zz-429-33-UDID-SENTINEL-0d61',
  auth: 'zz-429-33-AUTH-JSON-SENTINEL-73fa',
} as const
// Undeclared values written inside comments, which the file view shows as written.
const COMMENT_SENTINELS = {
  above: 'zz-429-41-COMMENTED-HEADER-SENTINEL-5e0a',
  trailing: 'zz-429-41-TRAILING-COMMENT-SENTINEL-a3d8',
} as const
// A plain MCP leaf, which the file view must show in clear and untagged.
const MCP_PORT = '3471'
const PLUGIN_PACKAGE = '@example/agent-qa-auth'
const LONG_TARGET = 'checkout-staging-with-a-deliberately-long-target-name'

const TASK1_CONFIG = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.test.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'knowledge:',
  '  dir: agent-qa-knowledge',
  'services:',
  '  mcp:',
  '    enabled: false',
  `    port: ${MCP_PORT}`,
  'registry:',
  '  llms:',
  '    - name: gpt',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.invalid/v1',
  '      providerHeaders:',
  `        # x-api-key: ${COMMENT_SENTINELS.above}`,
  `        x-org-route: ${SENTINELS.header}`,
  `        x-org-access: ${SENTINELS.access} # was ${COMMENT_SENTINELS.trailing}`,
  '  targets:',
  '    conformance:',
  '      platform: web',
  '      url: https://conformance.invalid',
  `    ${LONG_TARGET}:`,
  '      platform: web',
  '      url: https://checkout-staging.invalid',
  '  devices:',
  '    phone:',
  '      platform: ios',
  '      match:',
  `        udid: ${SENTINELS.udid}`,
  'plugins:',
  '  auth:',
  `    - package: "${PLUGIN_PACKAGE}"`,
  'use:',
  '  llm: gpt',
  '  mobile:',
  '    appState: preserve',
  '',
].join('\n')

const BROWSER_INSTALL_INSTRUCTION =
  'Chromium could not be launched by the pinned playwright-core. Run '
  + '`node node_modules/playwright-core/cli.js install chromium` from packages/cli and re-run; '
  + 'these cells must not be skipped when the browser is absent.'

interface Project {
  readonly root: string
  readonly configPath: string
  readonly authPath: string
}

/** A project the shipped dashboard opens, with its HOME (and so its auth.json) inside the temp root. */
function writeProject(label: string, config: string, auth?: Record<string, unknown>): Project {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-429-33-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, config, 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), `ACCESS_KEY=${SENTINELS.access}\n`, 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  mkdirSync(join(root, 'agent-qa-knowledge'), { recursive: true })
  const authPath = join(hermeticEnv(root).HOME, '.agent-qa', 'auth.json')
  if (auth !== undefined) writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  if (config.includes(PLUGIN_PACKAGE)) plantEmptyAuthPlugin(root)
  return { root, configPath, authPath }
}

/** The declared plugin must resolve or the dashboard refuses to start; this one registers nothing. */
function plantEmptyAuthPlugin(root: string) {
  const dir = join(root, 'node_modules', ...PLUGIN_PACKAGE.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: PLUGIN_PACKAGE, version: '0.0.0', type: 'module', exports: './index.js' })}\n`, 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export const providers = []\n', 'utf8')
}

/** The operator's own auth.json, fingerprinted so a cell can prove the run never touched it. */
function realAuthFingerprint(): string {
  const path = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, 'agent-qa', 'auth.json')
    : join(homedir(), '.agent-qa', 'auth.json')
  if (!existsSync(path)) return 'absent'
  const stat = statSync(path)
  return `${String(stat.size)}:${String(stat.mtimeMs)}`
}

async function launchBrowser(dashboard: SpawnedDashboard): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true })
  } catch (error) {
    await dashboard.stop()
    throw new Error(`${BROWSER_INSTALL_INSTRUCTION} underlying error: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const PRODUCT_TOUR_COOKIE = 'agent_qa_product_tour_state'
const TOUR_SKIPPED = encodeURIComponent(JSON.stringify({
  schemaVersion: 2, tourVersion: 'foundation-v1', skippedAt: '2026-09-27T00:00:00.000Z',
}))

// Every page records any dialog that ever mounts, and every uncaught error, from its first byte.
const DIALOG_WATCH = `(() => {
  const seen = []
  window.__dialogsSeen = seen
  const scan = () => {
    for (const element of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal]')) {
      const text = element.outerHTML.slice(0, 160)
      if (!seen.includes(text)) seen.push(text)
    }
  }
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'aria-modal'] })
})()`

interface OpenedPage {
  readonly page: Page
  readonly context: BrowserContext
  readonly errors: string[]
}

class Harness {
  readonly dialogs: string[] = []
  private readonly open = new Set<OpenedPage>()

  constructor(readonly browser: Browser, readonly origin: string) {}

  async page(viewport: Viewport): Promise<OpenedPage> {
    const context = await this.browser.newContext({ viewport })
    // A returning person: the first-visit product tour (a global, non-modal overlay outside Config)
    // was skipped, so it neither covers the captures nor counts as a Config dialog.
    await context.addCookies([{ name: PRODUCT_TOUR_COOKIE, value: TOUR_SKIPPED, url: this.origin }])
    await context.addInitScript(DIALOG_WATCH)
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(String(error)) })
    const opened = { page, context, errors }
    this.open.add(opened)
    return opened
  }

  async close(opened: OpenedPage): Promise<void> {
    if (!this.open.delete(opened)) return
    for (const page of opened.context.pages()) {
      const seen = await page.evaluate(() => (window as unknown as { __dialogsSeen?: string[] }).__dialogsSeen ?? []).catch(() => [])
      this.dialogs.push(...seen)
      // Let in-flight handlers finish, or closing the context rejects `Request context disposed`.
      await page.unrouteAll({ behavior: 'wait' })
    }
    await opened.context.close()
  }

  async closeAll(): Promise<void> {
    for (const opened of [...this.open]) await this.close(opened)
    await this.browser.close()
  }
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function openConfig(harness: Harness, page: Page, path: string) {
  await page.goto(`${harness.origin}${path}`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-config-page][data-config-state="ready"]').waitFor({ timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await frames(page)
}

async function openTab(harness: Harness, page: Page, tab: string) {
  await openConfig(harness, page, `/config/${tab}`)
  await page.locator(`[data-config-panel="${tab}"][data-state="active"]`).waitFor({ timeout: 15_000 })
  await frames(page)
}

function captureDir(): string | undefined {
  const directory = process.env.AGENT_QA_CAPTURE_DIR
  if (!directory) return undefined
  mkdirSync(directory, { recursive: true })
  return directory
}

/** The whole page in one picture: the viewport grown by whatever the inner main scrolls. */
async function captureFullPage(page: Page, name: string) {
  const directory = captureDir()
  if (!directory) return
  const size = page.viewportSize()!
  const extra = await page.evaluate((selector) => {
    const main = document.querySelector<HTMLElement>(selector)
    return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0
  }, INNER_MAIN)
  await page.setViewportSize({ width: size.width, height: size.height + extra })
  await frames(page)
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
  await page.setViewportSize(size)
  await frames(page)
}

async function captureViewport(page: Page, name: string) {
  const directory = captureDir()
  if (!directory) return
  await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

const UNNAMED_CONTROL = /^\s*- (button|textbox|checkbox|switch|radio|tab|combobox|spinbutton|slider|link)\b(?! ")/

function unnamedControls(snapshot: string): string[] {
  return snapshot.split('\n').filter((line) => UNNAMED_CONTROL.test(line))
}

describe('Config tabs, links, geometry, masking and names on the shipped bundle', () => {
  let dashboard: SpawnedDashboard | undefined
  let harness: Harness | undefined
  let project: Project | undefined

  beforeAll(async () => {
    const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
    expect(freshness, REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

    project = writeProject('tabs', TASK1_CONFIG, {
      gpt: { type: 'api', provider: 'anthropic-compatible', key: SENTINELS.auth },
    })
    const spawned = await spawnDashboard(project.root, project.configPath, await reserveEphemeralPort())
    expect(spawned.ready, `the built dashboard never listened. stdout: ${spawned.stdout().slice(-1200)} stderr: ${spawned.stderr().slice(-1200)}`).toBe(true)
    dashboard = spawned
    harness = new Harness(await launchBrowser(spawned), spawned.origin)
  }, 180_000)

  afterAll(async () => {
    await harness?.closeAll()
    await dashboard?.stop()
    cleanupTempRoots()
  })

  function live(): Harness {
    expect(harness, 'the shipped dashboard or the browser did not stand up; see beforeAll').toBeDefined()
    return harness!
  }

  it('TABS-FIVE-IN-ORDER-SHIPPED', async () => {
    const h = live()
    for (const viewport of [DESKTOP, NARROW]) {
      const opened = await h.page(viewport)
      const { page } = opened
      await openConfig(h, page, '/config')
      await page.waitForURL((url) => url.pathname === '/config/models', { timeout: 10_000 })
      const read = await page.evaluate(() => {
        const root = document.querySelector('[data-config-page]')!
        const lists = [...root.querySelectorAll('[role="tablist"]')]
        return {
          lists: lists.length,
          label: lists[0]?.getAttribute('aria-label') ?? null,
          tabs: [...(lists[0]?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => (tab.textContent ?? '').trim()),
          selected: [...root.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.getAttribute('data-config-tab')),
          selects: document.querySelectorAll('select').length,
          stripCombos: root.querySelectorAll('[data-config-tabbar] select, [data-config-tabbar] [role="combobox"]').length,
          tourNav: document.querySelectorAll('[data-tour-id="tour-config-nav"]').length,
          tourSection: document.querySelectorAll('[data-tour-id="tour-config-section"]').length,
          fileIssues: document.querySelectorAll('[data-config-file-issues], [data-config-load-error]').length,
        }
      })
      const where = `${labelOf(viewport)}: ${JSON.stringify(read)}`
      expect(read.lists, where).toBe(1)
      expect(read.label, where).toBe('Config sections')
      expect(read.tabs, where).toEqual(TAB_LABELS)
      expect(read.selected, where).toEqual(['models'])
      expect(read.selects, where).toBe(0)
      expect(read.stripCombos, where).toBe(0)
      expect(read.tourNav, where).toBe(1)
      expect(read.tourSection, where).toBe(1)
      expect(read.fileIssues, `${where}: the fixture config must load clean`).toBe(0)
      expect(opened.errors, where).toEqual([])
      await h.close(opened)
    }
  }, 120_000)

  it('LEGACY-LINKS-SHIPPED', async () => {
    const h = live()
    const opened = await h.page(DESKTOP)
    const { page } = opened
    const landed: string[] = []
    for (const [bucket, item] of LEGACY_LINKS) {
      await openConfig(h, page, `/config?bucket=${bucket}&item=${item}`)
      await page.waitForFunction(() => location.search === '' && location.pathname.startsWith('/config/'), undefined, { timeout: 10_000 })
      await page.waitForFunction(() => document.activeElement?.tagName === 'H2', undefined, { timeout: 5_000 }).catch(() => undefined)
      const at = await page.evaluate(() => {
        const active = document.activeElement
        return `${location.pathname} ${active?.tagName.toLowerCase() ?? 'none'}#${active?.id ?? ''} ${(active?.textContent ?? '').trim()}`
      })
      landed.push(`${bucket}:${item} -> ${at}`)
    }
    const expected = LEGACY_LINKS.map(([bucket, item, tab, section, heading]) =>
      `${bucket}:${item} -> /config/${tab} h2#config-section-${section}-heading ${heading}`)
    expect(landed).toEqual(expected)
    expect(landed.length, 'the witness: there are legacy links to follow').toBeGreaterThan(0)
    expect(opened.errors).toEqual([])
    await h.close(opened)
  }, 240_000)

  it('STATUS-NEVER-SCROLLS-AWAY', async () => {
    const h = live()
    for (const viewport of [NARROW, DESKTOP]) {
      const opened = await h.page(viewport)
      const { page } = opened
      await openTab(h, page, 'targets')
      await page.getByRole('button', { name: `Delete target ${LONG_TARGET}`, exact: true }).click()
      await page.locator('[data-save-status="undo"]').waitFor({ timeout: 10_000 })
      // Scroll whichever element owns the page's vertical scroll all the way down.
      await page.evaluate((selector) => {
        const main = document.querySelector<HTMLElement>(selector)!
        main.scrollTop = main.scrollHeight
        document.scrollingElement!.scrollTop = document.scrollingElement!.scrollHeight
      }, INNER_MAIN)
      await frames(page)
      await frames(page)
      const read = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }
        }
        return {
          innerWidth, innerHeight,
          status: box('[data-save-status]'),
          strip: box('[data-config-tabs-scroll]'),
          active: box('[data-config-tab][aria-selected="true"]'),
          line: document.querySelector('[data-save-undo-line]')?.getAttribute('aria-label') ?? null,
          scrolled: document.querySelector('main main')!.scrollTop + document.scrollingElement!.scrollTop,
        }
      })
      await captureViewport(page, `status-undo-${labelOf(viewport)}`)
      const where = `${labelOf(viewport)}: ${JSON.stringify(read)}`
      expect(read.line, where).toBe(`Deleted target ${LONG_TARGET}`)
      expect(read.scrolled, `${where}: the page must actually have scrolled`).toBeGreaterThan(0)
      expect(read.status.left, where).toBeGreaterThanOrEqual(0)
      expect(read.status.top, `${where}: the status scrolled away`).toBeGreaterThanOrEqual(0)
      expect(read.status.right, where).toBeLessThanOrEqual(read.innerWidth)
      expect(read.status.bottom, where).toBeLessThanOrEqual(read.innerHeight)
      const overlaps = read.status.left < read.strip.right && read.strip.left < read.status.right
        && read.status.top < read.strip.bottom && read.strip.top < read.status.bottom
      expect(overlaps, `${where}: the status box overlaps the tab scroll box`).toBe(false)
      // As much of the active tab as the strip can hold is inside it: all of it when it fits.
      const visible = Math.min(read.active.right, read.strip.right) - Math.max(read.active.left, read.strip.left)
      expect(visible, `${where}: the active tab is not scrolled into view`).toBeGreaterThanOrEqual(Math.min(read.active.width, read.strip.width) - 1)
      expect(readFileSync(project!.configPath, 'utf8')).not.toContain(`${LONG_TARGET}:`)

      await page.getByRole('button', { name: 'Undo', exact: true }).click()
      await page.locator(`[data-target="${LONG_TARGET}"]`).waitFor({ timeout: 10_000 })
      await expect.poll(() => readFileSync(project!.configPath, 'utf8'), { timeout: 10_000 }).toContain(`${LONG_TARGET}:`)
      expect(opened.errors).toEqual([])
      await h.close(opened)
    }
  }, 120_000)

  it('NO-SIDEWAYS-SCROLL', async () => {
    const h = live()
    for (const viewport of [DESKTOP, NARROW]) {
      const opened = await h.page(viewport)
      const { page } = opened
      for (const tab of TABS) {
        await openTab(h, page, tab)
        const read = await page.evaluate(() => {
          const scroll = (element: Element | null) => ({ scrollWidth: element?.scrollWidth ?? -1, clientWidth: element?.clientWidth ?? -1 })
          return {
            document: scroll(document.scrollingElement),
            inset: scroll(document.querySelector('main[data-slot="sidebar-inset"]')),
            main: scroll(document.querySelector('main main')),
            innerWidth,
          }
        })
        const where = `${labelOf(viewport)} ${tab}: ${JSON.stringify(read)}`
        expect(read.innerWidth, where).toBe(viewport.width)
        for (const box of [read.document, read.inset, read.main]) {
          expect(box.clientWidth, where).toBeGreaterThan(0)
          expect(box.scrollWidth, where).toBeLessThanOrEqual(box.clientWidth + 1)
        }
        await captureFullPage(page, `config-${tab}-${labelOf(viewport)}`)
      }
      expect(opened.errors).toEqual([])
      await h.close(opened)
    }
  }, 240_000)

  it('FILE-VIEW-MASKING-SHIPPED', async () => {
    const h = live()
    const opened = await h.page(DESKTOP)
    const { page } = opened
    const leaks: string[] = []
    for (const tab of TABS) {
      await openTab(h, page, tab)
      const html = await page.evaluate(() => document.documentElement.outerHTML)
      for (const [kind, sentinel] of Object.entries({ auth: SENTINELS.auth, access: SENTINELS.access })) if (html.includes(sentinel)) leaks.push(`${tab}: ${kind}`)
    }
    expect(leaks, 'an auth.json or declared value reached the page').toEqual([])

    const view = page.locator('[data-config-file-view]')
    await view.waitFor({ timeout: 10_000 })
    const lines = await view.locator('li[data-line]').evaluateAll((items) => items.map((item) => ({
      text: (item.textContent ?? '').trim(),
      masking: item.getAttribute('data-masking-class'),
    })))
    const lineWith = (fragment: string) => lines.find((line) => line.text.includes(fragment))
    expect(lineWith(`port: ${MCP_PORT}`), JSON.stringify(lines)).toEqual({ text: `port: ${MCP_PORT}`, masking: null })
    // No line is classed by path; an undeclared value or comment reads as written and the access
    // header, declared in the secrets file, as its marker.
    expect(lines.filter((line) => line.masking !== null), JSON.stringify(lines)).toEqual([])
    expect(lineWith('x-org-route:')?.text).toBe(`x-org-route: ${SENTINELS.header}`)
    expect(lineWith('x-org-access:')?.text).toBe(`x-org-access: [secret:ACCESS_KEY] # was ${COMMENT_SENTINELS.trailing}`)
    expect(lineWith('# x-api-key:')?.text).toBe(`# x-api-key: ${COMMENT_SENTINELS.above}`)
    expect(lineWith('plugins:'), 'the plugins block is missing from the file view').toBeDefined()
    expect(lineWith(PLUGIN_PACKAGE), 'the plugin entry is missing from the file view').toBeDefined()
    expect(await view.isVisible()).toBe(true)
    await captureFullPage(page, `config-file-masked-${labelOf(DESKTOP)}`)
    expect(opened.errors).toEqual([])
    await h.close(opened)
  }, 120_000)

  it('ARIA-NAMES-SHIPPED', async () => {
    const h = live()
    const found: string[] = []
    for (const viewport of [DESKTOP, NARROW]) {
      const opened = await h.page(viewport)
      const { page } = opened
      for (const tab of TABS) {
        await openTab(h, page, tab)
        const snapshot = await page.locator(INNER_MAIN).ariaSnapshot()
        expect(snapshot.length, `${tab}: an empty ARIA snapshot measures nothing`).toBeGreaterThan(200)
        expect(snapshot, `${tab}: the snapshot holds no tab at all`).toContain('- tab "Models"')
        for (const line of unnamedControls(snapshot)) found.push(`${labelOf(viewport)} ${tab}: ${line.trim()}`)
      }
      expect(opened.errors).toEqual([])
      await h.close(opened)
    }
    expect(found, 'unnamed controls in the Config ARIA snapshot').toEqual([])
  }, 180_000)
})

// ---- The continuous add flow, keyboard recovery and outside edits ----

const TYPED_KEY = 'zz-429-33-typed-key-not-a-credential-5e0a'
const CONNECTED_SAVED = (name: string) => `Connected. Saved as ${name}.`
const BECAME_DEFAULT = "It's now the default model."

// No model and no default, so the first model a flow saves becomes the default.
const TASK2_CONFIG = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.test.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  'use:',
  '  mobile:',
  '    appState: preserve',
  '  browser:',
  '    name: chromium',
  '    headless: false',
  '',
].join('\n')

interface Poll {
  readonly at: number
  readonly bytes: string
}

/** Reads the config file every few milliseconds, keeping each distinct content and when it appeared. */
function watchFile(path: string) {
  const seen: Poll[] = [{ at: Date.now(), bytes: readFileSync(path, 'utf8') }]
  const timer = setInterval(() => {
    let bytes: string
    try { bytes = readFileSync(path, 'utf8') } catch { return }
    if (bytes !== seen[seen.length - 1]!.bytes) seen.push({ at: Date.now(), bytes })
  }, 4)
  return {
    seen,
    stop: () => clearInterval(timer),
  }
}

async function activeSummary(page: Page) {
  return await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    const input = element as HTMLInputElement | null
    return {
      id: element?.id ?? '',
      tag: element?.tagName.toLowerCase() ?? '',
      role: element?.getAttribute('role') ?? '',
      value: element?.getAttribute('value') ?? '',
      label: (input?.labels?.[0]?.textContent ?? element?.getAttribute('aria-label') ?? '').trim(),
      text: (element?.textContent ?? '').trim(),
    }
  })
}

/** Tab (or Shift+Tab) until the focused element satisfies the test; keyboard only. */
async function tabTo(page: Page, wanted: (active: Awaited<ReturnType<typeof activeSummary>>) => boolean, key: 'Tab' | 'Shift+Tab' = 'Tab') {
  const path: string[] = []
  for (let press = 0; press < 40; press++) {
    const active = await activeSummary(page)
    if (wanted(active)) return active
    path.push(`${active.tag}[${active.role}] ${active.label || active.text.slice(0, 24)}`)
    await page.keyboard.press(key)
  }
  throw new Error(`${key} never reached the wanted control; it passed: ${path.join(' | ')}`)
}

async function selectAllAndType(page: Page, text: string) {
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text)
}

describe('the continuous add flow, keyboard recovery and outside edits on the shipped bundle', () => {
  let dashboard: SpawnedDashboard | undefined
  let harness: Harness | undefined
  let project: Project | undefined
  let stub: StubModelServer | undefined
  let realAuthBefore = ''

  beforeAll(async () => {
    const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
    expect(freshness, REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })

    realAuthBefore = realAuthFingerprint()
    stub = await startStubModelServer()
    project = writeProject('add', TASK2_CONFIG)
    const spawned = await spawnDashboard(project.root, project.configPath, await reserveEphemeralPort())
    expect(spawned.ready, `the built dashboard never listened. stdout: ${spawned.stdout().slice(-1200)} stderr: ${spawned.stderr().slice(-1200)}`).toBe(true)
    dashboard = spawned
    harness = new Harness(await launchBrowser(spawned), spawned.origin)
  }, 180_000)

  afterAll(async () => {
    if (project !== undefined) chmodSync(project.root, 0o700)
    await harness?.closeAll()
    await dashboard?.stop()
    await stub?.close()
    cleanupTempRoots()
  })

  function live() {
    expect(harness, 'the shipped dashboard or the browser did not stand up; see beforeAll').toBeDefined()
    return { h: harness!, project: project!, stub: stub! }
  }

  /** Back to no model and no default, with no stored credential: the next add becomes the default. */
  function resetProject(target: Project) {
    writeFileSync(target.configPath, TASK2_CONFIG, 'utf8')
    rmSync(target.authPath, { force: true })
  }

  async function capture(page: Page, name: string) {
    await captureFullPage(page, name)
  }

  function expectSaved(target: Project, name: string, baseUrl: string) {
    const config = parse(readFileSync(target.configPath, 'utf8')) as {
      registry?: { llms?: Array<Record<string, unknown>> }
      use?: { llm?: unknown }
    }
    expect(config.registry?.llms, 'the saved definition').toEqual([
      { name, provider: 'openai-compatible', model: POPULATED_MODEL_ID, baseURL: baseUrl },
    ])
    expect(config.use?.llm, 'the new model became the default').toBe(name)
    expect(readFileSync(target.configPath, 'utf8')).not.toContain(TYPED_KEY)
    const auth = JSON.parse(readFileSync(target.authPath, 'utf8')) as Record<string, unknown>
    expect(auth[name], 'the hermetic auth.json holds the typed key under the name').toEqual({
      type: 'api', provider: 'openai-compatible', key: TYPED_KEY,
    })
  }

  it('ADD-FLOW-NO-INTERMEDIATE-SAVE', async () => {
    const { h, project: target, stub: model } = live()
    for (const viewport of [DESKTOP, NARROW]) {
      resetProject(target)
      const name = viewport === DESKTOP ? 'stub-desktop' : 'stub-narrow'
      const label = labelOf(viewport)
      const opened = await h.page(viewport)
      const { page } = opened
      const original = readFileSync(target.configPath, 'utf8')
      await openConfig(h, page, '/config/models?add')
      const row = page.locator('li[data-model-draft]')
      await row.waitFor({ timeout: 10_000 })
      const watch = watchFile(target.configPath)
      try {
        await capture(page, `add-flow-${label}-1-choices`)
        await row.getByRole('radio', { name: /^OpenAI-compatible API key/ }).click()
        await row.getByLabel('Base URL', { exact: true }).waitFor({ timeout: 5_000 })
        await capture(page, `add-flow-${label}-2-chosen`)
        await row.getByLabel('Base URL', { exact: true }).fill(model.baseUrl)
        await row.getByLabel('Model', { exact: true }).fill(POPULATED_MODEL_ID)
        await row.getByLabel('API key', { exact: true }).fill(TYPED_KEY)
        await row.getByLabel('Name', { exact: true }).fill(name)
        await row.getByLabel('Name', { exact: true }).blur()
        await frames(page)
        await capture(page, `add-flow-${label}-3-filled`)
        expect(watch.seen.map((poll) => poll.bytes), `${label}: the config changed before Connect`).toEqual([original])

        const probesBefore = model.requests.length
        const connectAt = Date.now()
        await row.getByRole('button', { name: 'Connect', exact: true }).click()
        const saved = page.locator(`li[data-model-row][data-model-name="${name}"]`)
        await saved.filter({ hasText: CONNECTED_SAVED(name) }).waitFor({ timeout: 30_000 })
        await expect.poll(() => watch.seen.length, { timeout: 5_000 }).toBeGreaterThan(1)
        await capture(page, `add-flow-${label}-4-saved`)
        watch.stop()

        const probes = model.requests.slice(probesBefore).filter((request) => request.kind === 'text')
        const changes = watch.seen.slice(1)
        expect(probes.length, `${label}: Connect never reached the stub model server`).toBe(1)
        expect(probes[0]!.status).toBe(200)
        expect(changes, `${label}: the config was written more than once`).toHaveLength(1)
        expect(watch.seen[0]!.bytes, `${label}: the first read is not the file as it was`).toBe(original)
        expect(changes[0]!.at, `${label}: the config changed before the connection test ran`).toBeGreaterThanOrEqual(probes[0]!.at)
        expect(changes[0]!.at).toBeGreaterThanOrEqual(connectAt)
        for (const poll of watch.seen) expect(poll.bytes.includes(TYPED_KEY), `${label}: the key reached the config file`).toBe(false)
        expectSaved(target, name, model.baseUrl)
        const rowText = (await saved.textContent()) ?? ''
        expect(rowText, `${label}: ${rowText}`).toContain(`${CONNECTED_SAVED(name)} ${BECAME_DEFAULT}`)
        expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(TYPED_KEY)
      } finally {
        watch.stop()
      }
      expect(opened.errors).toEqual([])
      await h.close(opened)
    }
    expect(h.dialogs, 'a dialog mounted during the add flow').toEqual([])
  }, 180_000)

  it('KEYBOARD-ADD-AT-400', async () => {
    const { h, project: target, stub: model } = live()
    resetProject(target)
    const name = 'stub-keyboard'
    const label = labelOf(NARROW)
    const opened = await h.page(NARROW)
    const { page } = opened
    await openConfig(h, page, '/config/models?add')
    await page.locator('li[data-model-draft]').waitFor({ timeout: 10_000 })
    await page.evaluate(() => {
      const counts = { pointer: 0 }
      ;(window as unknown as { __pointer: typeof counts }).__pointer = counts
      for (const type of ['pointerdown', 'mousedown', 'click']) {
        window.addEventListener(type, (event) => { if ((event as MouseEvent).detail > 0 || type !== 'click') counts.pointer += 1 }, true)
      }
    })
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'radio', undefined, { timeout: 5_000 })
    await capture(page, `add-keyboard-${label}-1-choices`)
    const walked: string[] = []
    for (let press = 0; press < 6; press++) {
      const now = await activeSummary(page)
      const checked = await page.evaluate(() => document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('value') ?? 'none')
      walked.push(`${now.value}:${checked}`)
      if (now.value === 'openai-compatible-key') break
      // Held like a real keypress: Radix moves roving focus in a timeout and checks the radio only
      // while the arrow is still down, so a zero-length press never checks anything.
      await page.keyboard.press('ArrowDown', { delay: 60 })
      await frames(page)
    }
    const chosen = await activeSummary(page)
    expect(chosen.value, `${JSON.stringify(chosen)} walked ${walked.join(' > ')}`).toBe('openai-compatible-key')
    await page.waitForFunction(() => document.querySelector('[data-connection-choice="openai-compatible-key"] [role="radio"]')?.getAttribute('aria-checked') === 'true', undefined, { timeout: 3_000 }).catch(() => undefined)
    const checked = await page.evaluate(() => [...document.querySelectorAll('[role="radio"][aria-checked="true"]')].map((radio) => radio.getAttribute('value')))
    expect(checked, `arrow keys moved focus without choosing; walked ${walked.join(' > ')}`).toEqual(['openai-compatible-key'])

    await tabTo(page, (active) => active.label === 'Base URL')
    await page.keyboard.type(model.baseUrl)
    await tabTo(page, (active) => active.label === 'Model')
    await page.keyboard.type(POPULATED_MODEL_ID)
    await tabTo(page, (active) => active.label === 'API key')
    await page.keyboard.type(TYPED_KEY)
    await tabTo(page, (active) => active.label === 'Name')
    await selectAllAndType(page, name)
    await capture(page, `add-keyboard-${label}-2-filled`)
    await tabTo(page, (active) => active.tag === 'button' && active.text === 'Connect')
    const original = readFileSync(target.configPath, 'utf8')
    expect(original, 'nothing was saved while the fields were typed').toBe(TASK2_CONFIG)
    await page.keyboard.press('Enter')
    const saved = page.locator(`li[data-model-row][data-model-name="${name}"]`)
    await saved.filter({ hasText: CONNECTED_SAVED(name) }).waitFor({ timeout: 30_000 })
    await page.waitForFunction((row) => document.activeElement?.closest(`li[data-model-name="${row}"]`) !== null
      && document.activeElement?.hasAttribute('data-model-row-toggle') === true, name, { timeout: 5_000 }).catch(() => undefined)
    await capture(page, `add-keyboard-${label}-3-saved`)

    expectSaved(target, name, model.baseUrl)
    expect((await saved.textContent()) ?? '').toContain(`${CONNECTED_SAVED(name)} ${BECAME_DEFAULT}`)
    const landed = await page.evaluate((row) => ({
      inRow: document.activeElement?.closest(`li[data-model-name="${row}"]`) !== null,
      toggle: document.activeElement?.hasAttribute('data-model-row-toggle') ?? false,
    }), name)
    expect(landed, 'focus did not land on the saved row').toEqual({ inRow: true, toggle: true })
    const pointer = await page.evaluate(() => (window as unknown as { __pointer: { pointer: number } }).__pointer.pointer)
    expect(pointer, 'a pointer event fired during the keyboard-only flow').toBe(0)
    expect(opened.errors).toEqual([])
    await h.close(opened)
    expect(h.dialogs, 'a dialog mounted during the keyboard add flow').toEqual([])
  }, 120_000)

  it('AUTOSAVE-ERROR-RECOVERY-BY-KEYBOARD', async () => {
    const { h, project: target } = live()
    const label = labelOf(NARROW)
    const opened = await h.page(NARROW)
    const { page } = opened
    await openTab(h, page, 'execution')
    const step = page.getByLabel('Step timeout', { exact: true })
    const stepId = await step.getAttribute('id')
    expect(stepId).toBeTruthy()
    await step.focus()
    const before = readFileSync(target.configPath, 'utf8')
    const mode = statSync(target.root).mode & 0o777
    chmodSync(target.root, 0o500)
    let afterTab: Awaited<ReturnType<typeof activeSummary>>
    let failedRead: { status: string | null; text: string; announced: string }
    try {
      await selectAllAndType(page, '45s')
      await page.keyboard.press('Tab')
      afterTab = await activeSummary(page)
      await page.locator('[data-save-status="failed"]').waitFor({ timeout: 10_000 })
      failedRead = await page.evaluate(() => ({
        status: document.querySelector('[data-save-status]')?.getAttribute('data-save-status') ?? null,
        text: [...(document.querySelector('[data-save-status]')?.children ?? [])]
          .map((child) => (child.textContent ?? '').trim()).filter((part) => part !== '').join(' '),
        announced: (document.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? '').trim(),
      }))
      await capture(page, `recovery-${label}-1-failed`)
      const stillFocused = await activeSummary(page)
      expect(stillFocused, 'the failure moved focus').toEqual(afterTab)
      expect(readFileSync(target.configPath, 'utf8'), 'a refused write changed the file').toBe(before)
    } finally {
      chmodSync(target.root, mode)
    }
    expect(afterTab.label, 'Tab left Step timeout for the next field').not.toBe('Step timeout')
    expect(failedRead.text).toBe("Couldn't save · Retry")
    expect(failedRead.announced).toBe("Couldn't save")
    expect(await step.getAttribute('data-field-state') ?? await page.locator('[data-field-path="use.timeout.step"]').getAttribute('data-field-state')).not.toBe('clean')

    await tabTo(page, (active) => active.tag === 'button' && active.text === 'Retry', 'Shift+Tab')
    await capture(page, `recovery-${label}-2-retry-focused`)
    await page.keyboard.press('Enter')
    await page.locator('[data-save-status="saved"]').waitFor({ timeout: 10_000 })
    await capture(page, `recovery-${label}-3-saved`)
    const config = parse(readFileSync(target.configPath, 'utf8')) as { use?: { timeout?: { step?: unknown } } }
    expect(config.use?.timeout?.step, 'Retry did not land the held value').toBe('45s')
    await page.waitForFunction((id) => document.activeElement?.id === id, stepId, { timeout: 5_000 }).catch(() => undefined)
    const focused = await activeSummary(page)
    expect(focused.id, `focus after Retry: ${JSON.stringify(focused)}`).toBe(stepId)
    expect(opened.errors).toEqual([])
    await h.close(opened)
    expect(h.dialogs, 'a dialog mounted during the error recovery').toEqual([])
  }, 120_000)

  it('OUTSIDE-EDIT-SHIPPED', async () => {
    const { h, project: target } = live()
    const opened = await h.page(DESKTOP)
    const { page } = opened
    await openTab(h, page, 'execution')
    const headless = page.getByRole('switch', { name: 'Headless', exact: true })
    expect(await headless.getAttribute('aria-checked')).toBe('false')
    await page.evaluate(() => { (window as unknown as { __sameDocument: string }).__sameDocument = 'yes' })
    await capture(page, `outside-edit-${labelOf(DESKTOP)}-1-before`)

    const doc = parseDocument(readFileSync(target.configPath, 'utf8'))
    doc.setIn(['use', 'browser', 'headless'], true)
    writeFileSync(target.configPath, String(doc), 'utf8')
    await expect.poll(async () => await headless.getAttribute('aria-checked'), { timeout: 5_000, interval: 100 }).toBe('true')
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: string }).__sameDocument), 'the page reloaded').toBe('yes')
    await capture(page, `outside-edit-${labelOf(DESKTOP)}-2-picked-up`)

    await page.getByLabel('Step timeout', { exact: true }).focus()
    await selectAllAndType(page, '50s')
    await page.keyboard.press('Tab')
    await expect.poll(() => (parse(readFileSync(target.configPath, 'utf8')) as { use?: { timeout?: { step?: unknown } } }).use?.timeout?.step, { timeout: 10_000 }).toBe('50s')
    const config = parse(readFileSync(target.configPath, 'utf8')) as { use?: { browser?: { headless?: unknown }; timeout?: { step?: unknown } } }
    expect(config.use?.browser?.headless, 'the human autosave dropped the outside edit').toBe(true)
    expect(config.use?.timeout?.step).toBe('50s')
    expect(opened.errors).toEqual([])
    await h.close(opened)
    expect(h.dialogs, 'a dialog mounted during the outside edit').toEqual([])
    expect(realAuthFingerprint(), "the operator's own auth.json changed during the run").toBe(realAuthBefore)
  }, 120_000)

  // The poll answers the first revision until the page's own write lands, so only it re-reads.
  it('OUTSIDE-EDIT-INTERLEAVED-SHIPPED', async () => {
    const { h, project: target } = live()
    resetProject(target)
    const opened = await h.page(DESKTOP)
    const { page } = opened
    let served: string | undefined
    const configReads: number[] = []
    let patchedAt: number | undefined
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.pathname === '/api/config') configReads.push(Date.now())
    })
    await page.route('**/api/config/revision', async (route) => {
      if (served === undefined) {
        await route.continue()
        return
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: served }) })
    })
    await page.route('**/api/config', async (route) => {
      const request = route.request()
      if (request.method() !== 'PATCH') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const body = (await response.json()) as { revision?: unknown }
      if (typeof body.revision === 'string') served = body.revision
      patchedAt = Date.now()
      await route.fulfill({ response })
    })
    const firstRead = page.waitForResponse((response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/config')
    await openTab(h, page, 'models')
    const first = (await (await firstRead).json()) as { revision?: unknown }
    expect(typeof first.revision, 'the first read carries no revision').toBe('string')
    served = first.revision as string
    const earlier = page.getByLabel('Earlier steps the planner sees', { exact: true })
    expect(await earlier.inputValue(), 'the fixture must start with no use.planner block').toBe('')
    await page.evaluate(() => { (window as unknown as { __sameDocument: string }).__sameDocument = 'yes' })
    await capture(page, `outside-interleaved-${labelOf(DESKTOP)}-1-before`)

    const doc = parseDocument(readFileSync(target.configPath, 'utf8'))
    doc.setIn(['use', 'planner'], doc.createNode({ maxActions: 99, maxPlanningTurns: 99, previousStepCount: 77 }))
    writeFileSync(target.configPath, String(doc), 'utf8')
    const patched = page.waitForResponse((response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/config')
    await page.getByLabel('Largest screenshot', { exact: true }).focus()
    await selectAllAndType(page, '512k')
    await page.keyboard.press('Tab')
    const answer = (await (await patched).json()) as { revision?: unknown; baseRevision?: unknown }
    const readsBeforePatch = configReads.filter((at) => patchedAt === undefined || at < patchedAt).length

    await expect.poll(async () => await earlier.inputValue(), { timeout: 5_000, interval: 100 }).toBe('77')
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: string }).__sameDocument), 'the page reloaded').toBe('yes')
    expect(typeof answer.baseRevision, `the write answer names no base: ${JSON.stringify(answer)}`).toBe('string')
    expect(answer.baseRevision, 'the write merged onto the outside edit, so its base is not the first read').not.toBe(first.revision)
    expect(configReads.length, 'the page never re-read after its own write merged the outside edit').toBeGreaterThan(readsBeforePatch)
    await capture(page, `outside-interleaved-${labelOf(DESKTOP)}-2-re-read`)

    await page.getByLabel('Most actions per step', { exact: true }).focus()
    await selectAllAndType(page, '50')
    await page.keyboard.press('Tab')
    const plannerOnDisk = () => (parse(readFileSync(target.configPath, 'utf8')) as { use?: { planner?: unknown } }).use?.planner
    await expect.poll(plannerOnDisk, { timeout: 10_000 }).toEqual({ maxActions: 50, maxPlanningTurns: 99, previousStepCount: 77 })
    const config = parse(readFileSync(target.configPath, 'utf8')) as { services?: { vision?: { screenshotSize?: unknown } } }
    expect(config.services?.vision?.screenshotSize).toBe('512k')
    expect(opened.errors).toEqual([])
    await h.close(opened)
    expect(h.dialogs, 'a dialog mounted during the interleaved outside edit').toEqual([])
    expect(realAuthFingerprint(), "the operator's own auth.json changed during the run").toBe(realAuthBefore)
  }, 120_000)
})
