/// <reference lib="dom" />
// Two seeded runs on the built dashboard, served in-process. Whatever changes the selection, the
// selected item's own row must end inside every clipping ancestor of the step list and the window.
// Only the Knowledge read is substituted, in the browser, for the cases that open that tab.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFunctionRegistry, type FunctionDeps } from '@vostride/agent-qa-agent'
import { createEvidenceBlobReader, type LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { DashboardDatabase, createDashboardRunDetailReader, startServer } from '@vostride/agent-qa-dashboard'
import { generateHookId, generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { RETRIEVAL_TRACE_SCHEMA_VERSION, RunKnowledgeProjectionSchema } from '@vostride/agent-qa-schema'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { composeDashboardAgentHost } from '../../commands/dashboard.js'
import { buildFreshness, dashboardUiDist } from './spawned-chat.js'

const BUILDS = [
  { pkg: 'schema', artifact: join('dist', 'index.js') },
  { pkg: 'ids', artifact: join('dist', 'index.js') },
  { pkg: 'agent', artifact: join('dist', 'index.js') },
  { pkg: 'agent-local', artifact: join('dist', 'index.js') },
  { pkg: 'dashboard-server', artifact: join('dist', 'index.js') },
  { pkg: 'dashboard-ui', artifact: join('dist', 'index.html') },
]

const SIZES = [
  { label: '1280x720', viewport: { width: 1280, height: 720 } },
  { label: '390x844', viewport: { width: 390, height: 844 } },
] as const

type RunKey = 'single' | 'suite'
const RUN_LABELS: Record<RunKey, string> = { single: "a single test's run", suite: 'a suite run' }
const MEMBER_NAMES = ['Checkout flow A', 'Checkout flow B', 'Checkout flow C']

interface SeededRun {
  id: string
  testIds: string[]
  stepsPerMember: number
  members: number
  teardownLogId?: string
}

// Which row each case drives to, per run: a step near the end, a start in the middle, and the ends.
const PLAN: Record<RunKey, { nearEnd: string; middle: string; next: string; lastAction: string; firstAction: string }> = {
  single: { nearEnd: '0:37', middle: '0:20', next: '0:21', lastAction: '0:39-0', firstAction: '0:0-0' },
  suite: { nearEnd: '2:12', middle: '1:6', next: '1:7', lastAction: '2:13-0', firstAction: '0:0-0' },
}

interface RowTarget { name: 'data-step-id' | 'data-sub-action-id' | 'data-execution-id' | 'data-hook-id'; value: string }
const step = (value: string): RowTarget => ({ name: 'data-step-id', value })
const action = (value: string): RowTarget => ({ name: 'data-sub-action-id', value })

interface RowState {
  present: boolean
  visible: boolean
  box?: { top: number; bottom: number; height: number }
  scroller?: { tag: string; slot: string | null; className: string; scrollTop: number; clientHeight: number; scrollHeight: number } | null
}

let root: string
let db: DashboardDatabase
let origin: string
let browser: Browser
let closeServer: (() => Promise<void>) | undefined
const runs = {} as Record<RunKey, SeededRun>
const contexts = new Map<string, BrowserContext>()

function seedRun(name: string, members: number, stepsPerMember: number, failedMember?: number): SeededRun {
  const id = generateRunId()
  const testIds: string[] = []
  db.insertRun({
    id, name, status: failedMember === undefined ? 'passed' : 'failed', duration: members * stepsPerMember * 1200,
    startedAt: new Date(0).toISOString(), endedAt: new Date(members * stepsPerMember * 1200).toISOString(),
  })
  for (let testIndex = 0; testIndex < members; testIndex++) {
    const testId = generateTestId()
    testIds.push(testId)
    db.upsertRunMember({
      runId: id, testIndex, testId, name: MEMBER_NAMES[testIndex] ?? name, totalSteps: stepsPerMember,
      outcome: testIndex === failedMember ? 'failed' : 'passed', durationMs: stepsPerMember * 1200,
    })
    for (let stepIndex = 0; stepIndex < stepsPerMember; stepIndex++) {
      db.insertRunStep({
        runId: id, testIndex, stepIndex, stepText: `Open the order page and check line ${String(stepIndex + 1)} of the basket`,
        cacheStatus: 'miss', verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'passed', durationMs: 1200,
      })
      db.insertRunSubAction({
        runId: id, testIndex, stepIndex, subActionIndex: 0, plan: `Click basket line ${String(stepIndex + 1)}`,
        plannedAction: { type: 'click', description: `basket line ${String(stepIndex + 1)}` },
        result: { success: true }, screenStateHash: `screen-${String(testIndex)}-${String(stepIndex)}`,
      })
    }
  }
  return { id, testIds, members, stepsPerMember }
}

function addRunHooks(run: SeededRun) {
  const setupHook = generateHookId()
  const teardownHook = generateHookId()
  db.insertExecutionLog({
    id: `${run.id}:${setupHook}`, runId: run.id, stepId: null, type: 'hook', name: 'Seed the catalogue',
    hookId: setupHook, phase: 'setup', status: 'passed', duration: 40,
  })
  run.teardownLogId = `${run.id}:${teardownHook}`
  db.insertExecutionLog({
    id: run.teardownLogId, runId: run.id, stepId: null, type: 'hook', name: 'Empty the basket',
    hookId: teardownHook, phase: 'teardown', status: 'passed', duration: 30,
  })
}

beforeAll(async () => {
  const freshness = buildFreshness(BUILDS)
  if (freshness.missing.length || freshness.stale.length) {
    throw new Error(`Run pnpm build before browser checks: ${JSON.stringify(freshness)}`)
  }
  root = mkdtempSync(join(tmpdir(), 'agent-qa-selected-step-'))
  db = new DashboardDatabase({ dbPath: join(root, 'dashboard.db') })
  runs.single = seedRun('Basket lines', 1, 40)
  addRunHooks(runs.single)
  runs.suite = seedRun('Basket suite', 3, 14, 1)
  const registry = createFunctionRegistry({
    deps: {
      runDetail: createDashboardRunDetailReader(db),
      evidenceBlobs: createEvidenceBlobReader({ agentQaRoot: root }),
      secretMask: (text: string) => text,
    } as FunctionDeps,
  })
  const agentHost = composeDashboardAgentHost({ registry } as LocalAgentHost)
  const started = await startServer({
    declaredSecretMask: (text) => text, db, port: 0, agentHost, uiDir: dashboardUiDist(),
    configPath: join(root, 'agent-qa.config.yaml'),
  })
  closeServer = started.close
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new Error('The dashboard fixture did not bind')
  origin = `http://127.0.0.1:${String(address.port)}`
  browser = await chromium.launch({ headless: true, args: ['--lang=en-US'] })
  for (const size of SIZES) contexts.set(size.label, await browser.newContext({ viewport: size.viewport }))
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await closeServer?.()
  db?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function runUrl(key: RunKey, query = '') {
  return `${origin}/runs/${encodeURIComponent(runs[key].id)}${query}`
}

async function frames(page: Page, count = 2) {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index++) await new Promise(resolve => requestAnimationFrame(resolve))
  }, count)
}

// The late reads land (the hook rows on the single run, the member chrome on the suite) and any move
// the load started has finished, so a case sets its starting position on a list at rest.
async function settle(page: Page, key: RunKey) {
  await page.locator('[data-step-id]').first().waitFor()
  if (key === 'single') await page.getByText('Empty the basket', { exact: true }).waitFor()
  else await expect.poll(() => page.locator('[data-member-toggle]').count()).toBe(3)
  await frames(page)
  let previous = await listScrollTop(page)
  for (let attempt = 0; attempt < 30; attempt++) {
    await page.waitForTimeout(150)
    const current = await listScrollTop(page)
    if (current === previous) return
    previous = current
  }
  throw new Error(`the step list did not come to rest after the load: scrollTop ${String(previous)}`)
}

async function open(key: RunKey, size: (typeof SIZES)[number], query = '', context?: BrowserContext): Promise<Page> {
  const page = await (context ?? contexts.get(size.label)!).newPage()
  await page.goto(runUrl(key, query))
  await settle(page, key)
  return page
}

function readRow(page: Page, target: RowTarget): Promise<RowState> {
  return page.evaluate(({ name, value }) => {
    const item = Array.from(document.querySelectorAll(`[${name}]`)).find(element => element.getAttribute(name) === value)
    if (item === undefined) return { present: false, visible: false }
    const row = item.firstElementChild instanceof HTMLButtonElement ? item.firstElementChild : item
    const box = row.getBoundingClientRect()
    let visible = box.height > 0 && box.top >= -1 && box.bottom <= window.innerHeight + 1
    let scroller: RowState['scroller'] = null
    for (let element = row.parentElement; element && element !== document.documentElement; element = element.parentElement) {
      const overflowY = getComputedStyle(element).overflowY
      if (overflowY === 'visible') continue
      const top = element.getBoundingClientRect().top + element.clientTop
      if (box.top < top - 1 || box.bottom > top + element.clientHeight + 1) visible = false
      if (scroller === null && element.scrollHeight > element.clientHeight + 1) {
        scroller = {
          tag: element.tagName.toLowerCase(), slot: element.getAttribute('data-slot'),
          className: String(element.className), scrollTop: Math.round(element.scrollTop),
          clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
        }
      }
    }
    return {
      present: true, visible, scroller,
      box: { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) },
    }
  }, target)
}

// Puts every scrolling ancestor of the step list at its top or its bottom, at once.
async function scrollList(page: Page, edge: 'top' | 'bottom') {
  await page.evaluate((edge) => {
    const tree = document.querySelector('[role="tree"]')
    for (let element = tree?.parentElement; element && element !== document.documentElement; element = element.parentElement) {
      const overflowY = getComputedStyle(element).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
        element.scrollTo({ top: edge === 'top' ? 0 : element.scrollHeight, behavior: 'instant' })
      }
    }
  }, edge)
  await frames(page)
}

function listScrollTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const tree = document.querySelector('[role="tree"]')
    for (let element = tree?.parentElement; element && element !== document.documentElement; element = element.parentElement) {
      const overflowY = getComputedStyle(element).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) return element.scrollTop
    }
    return null
  })
}

function describeRow(target: RowTarget, state: RowState | undefined) {
  return `${target.name}="${target.value}" ${JSON.stringify(state)}`
}

async function expectOutOfView(page: Page, target: RowTarget) {
  const state = await readRow(page, target)
  expect(state.visible, `the case must start with the row out of view: ${describeRow(target, state)}`).toBe(false)
}

async function expectInView(page: Page, target: RowTarget) {
  let state: RowState | undefined
  try {
    await expect.poll(async () => (state = await readRow(page, target)).visible, { timeout: 3000 }).toBe(true)
  } catch {
    throw new Error(`the selected row is not in view of the step list: ${describeRow(target, state)}`)
  }
  await expectTimelineMarkerInside(page)
}

async function expectTimelineMarkerInside(page: Page) {
  const boxes = await page.evaluate(() => {
    const active = document.querySelector('[data-timeline-active]')
    const strip = document.querySelector('[data-timeline]')
    if (!active || !strip) return null
    const a = active.getBoundingClientRect()
    const s = strip.getBoundingClientRect()
    return { active: { left: a.left, right: a.right }, strip: { left: s.left, right: s.right } }
  })
  if (boxes === null) return
  expect(boxes.active.left >= boxes.strip.left - 1 && boxes.active.right <= boxes.strip.right + 1,
    `the timeline's active marker lies inside its strip: ${JSON.stringify(boxes)}`).toBe(true)
}

function focusIsBody(page: Page) {
  return page.evaluate(() => document.activeElement === document.body)
}

async function capture(page: Page, name: string) {
  const directory = process.env.AGENT_QA_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.screenshot({ path: join(directory, `${name.replace(/[^a-z0-9]+/giu, '-')}.png`) })
}

async function withPage(key: RunKey, size: (typeof SIZES)[number], query: string, name: string, body: (page: Page) => Promise<void>) {
  const page = await open(key, size, query)
  try {
    await body(page)
    await capture(page, name)
  } finally {
    await page.close()
  }
}

function knowledgeProjection(run: SeededRun, addresses: { testIndex: number; stepIndex: number }[]) {
  const recordId = 'fact-el-button-basket-line-0f9a1c2b3d4e5f60'
  const summary = 'Each basket line opens its own detail panel'
  const rung = { schemaVersion: 2 as const, rung: 'bundle-scan' as const, reason: 'index-locked' as const }
  const line = {
    id: recordId, kind: 'fact', summary, trust: 0.87, status: 'active', servedAsCanary: false, tier: 'confirmed',
    recordContent: {
      content: `${summary}.`, summary, kind: 'fact',
      applicability: { product: 'basket', scope: 'basket', anchors: ['page:/basket'], openedAtOrdinal: 1 },
      currentStatus: 'active',
      currentTrust: { confirmations: 2, contradictions: 0, evidenceTokens: ['receipt-1'], lastEventOrdinal: 2 },
    },
  }
  return RunKnowledgeProjectionSchema.parse({
    kind: 'ready', runId: run.id, buildOrdinal: 1, knowledgeStore: 'bound', retrievalRung: rung,
    steps: addresses.map(({ testIndex, stepIndex }) => ({
      testId: run.testIds[testIndex], testIndex, stepIndex,
      stepText: `Open the order page and check line ${String(stepIndex + 1)} of the basket`,
      served: { channel1: [line], channel2: [], channel3: [] },
      trace: { kind: 'answered', trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: [{ recordId, leg: 'anchor', rank: 1, score: 1.2 }], truncated: [] } },
      retrievalRung: rung,
    })),
    curation: { status: 'pending' },
    learned: { changes: [], canaryAttributions: [] },
  })
}

async function openWithKnowledge(key: RunKey, size: (typeof SIZES)[number], query: string, addresses: { testIndex: number; stepIndex: number }[]) {
  const page = await contexts.get(size.label)!.newPage()
  const body = JSON.stringify(knowledgeProjection(runs[key], addresses))
  await page.route(`**/api/runs/${encodeURIComponent(runs[key].id)}/knowledge`, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body }))
  await page.goto(runUrl(key, query))
  await settle(page, key)
  return page
}

function address(key: string) {
  const [testIndex, stepIndex] = key.split(':').map(Number)
  return { testIndex: testIndex!, stepIndex: stepIndex! }
}

for (const size of SIZES) {
  for (const key of ['single', 'suite'] as const) {
    const where = `at ${size.label} on ${RUN_LABELS[key]}`
    const plan = PLAN[key]

    it(`a plain load leaves the step list at its top ${where}`, async () => {
      await withPage(key, size, '', `plain-load-${key}-${size.label}`, async (page) => {
        await page.waitForTimeout(500)
        await frames(page)
        const first = await readRow(page, step('0:0'))
        expect(first.visible, describeRow(step('0:0'), first)).toBe(true)
        expect(await listScrollTop(page)).toBe(0)
      })
    })

    it(`a link to a step opens with that step in view ${where}`, async () => {
      await withPage(key, size, `?step=${plan.nearEnd}`, `step-link-${key}-${size.label}`, async (page) => {
        await expectInView(page, step(plan.nearEnd))
      })
    })

    it(`a link to an action opens with that action in view ${where}`, async () => {
      await withPage(key, size, `?step=${plan.nearEnd}&sub=0`, `action-link-${key}-${size.label}`, async (page) => {
        await expectInView(page, action(`${plan.nearEnd}-0`))
      })
    })

    it(`j and k bring the next and previous item into view ${where}`, async () => {
      await withPage(key, size, `?step=${plan.middle}`, `j-k-${key}-${size.label}`, async (page) => {
        await scrollList(page, 'top')
        await expectOutOfView(page, action(`${plan.next}-0`))
        await page.keyboard.press('j')
        await expectInView(page, action(`${plan.next}-0`))
        expect(await focusIsBody(page)).toBe(true)
        await scrollList(page, 'bottom')
        await expectOutOfView(page, action(`${plan.middle}-0`))
        await page.keyboard.press('k')
        await expectInView(page, action(`${plan.middle}-0`))
        expect(await focusIsBody(page)).toBe(true)
      })
    })

    it(`Shift with the arrow keys brings the next and previous step into view ${where}`, async () => {
      await withPage(key, size, `?step=${plan.middle}`, `shift-arrows-${key}-${size.label}`, async (page) => {
        await scrollList(page, 'top')
        await expectOutOfView(page, step(plan.next))
        await page.keyboard.press('Shift+ArrowDown')
        await expectInView(page, step(plan.next))
        expect(await focusIsBody(page)).toBe(true)
        await scrollList(page, 'bottom')
        await expectOutOfView(page, step(plan.middle))
        await page.keyboard.press('Shift+ArrowUp')
        await expectInView(page, step(plan.middle))
        expect(await focusIsBody(page)).toBe(true)
      })
    })

    it(`the arrow keys bring the next and previous action into view ${where}`, async () => {
      await withPage(key, size, `?step=${plan.middle}`, `arrows-${key}-${size.label}`, async (page) => {
        await scrollList(page, 'top')
        await expectOutOfView(page, action(`${plan.next}-0`))
        await page.keyboard.press('ArrowRight')
        await expectInView(page, action(`${plan.next}-0`))
        expect(await focusIsBody(page)).toBe(true)
        await scrollList(page, 'bottom')
        await expectOutOfView(page, action(`${plan.middle}-0`))
        await page.keyboard.press('ArrowLeft')
        await expectInView(page, action(`${plan.middle}-0`))
        expect(await focusIsBody(page)).toBe(true)
      })
    })

    it(`the timeline slider's End and Home keys bring the last and first action into view ${where}`, async () => {
      await withPage(key, size, '', `slider-${key}-${size.label}`, async (page) => {
        const sliderFocused = () => page.evaluate(() => document.activeElement?.hasAttribute('data-timeline-playhead') ?? false)
        await page.locator('[data-timeline-playhead]').evaluate(element => (element as HTMLElement).focus({ preventScroll: true }))
        await expectOutOfView(page, action(plan.lastAction))
        await page.keyboard.press('End')
        await expectInView(page, action(plan.lastAction))
        expect(await sliderFocused()).toBe(true)
        await expectOutOfView(page, action(plan.firstAction))
        await page.keyboard.press('Home')
        await expectInView(page, action(plan.firstAction))
        expect(await sliderFocused()).toBe(true)
      })
    })

    it(`a click on a row the list cuts off brings the whole row into view ${where}`, async () => {
      await withPage(key, size, '', `click-${key}-${size.label}`, async (page) => {
        const cut = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('[data-step-id], [data-sub-action-id]'))
          for (const item of rows) {
            const row = item.firstElementChild
            if (!(row instanceof HTMLButtonElement)) continue
            const box = row.getBoundingClientRect()
            let clip: { top: number; bottom: number } | null = null
            for (let element = row.parentElement; element && element !== document.documentElement; element = element.parentElement) {
              const overflowY = getComputedStyle(element).overflowY
              if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
                const top = element.getBoundingClientRect().top + element.clientTop
                clip = { top, bottom: Math.min(top + element.clientHeight, window.innerHeight) }
                break
              }
            }
            if (clip === null) continue
            if (box.top >= clip.top && box.top + 6 < clip.bottom && box.bottom > clip.bottom + 1) {
              const name = item.hasAttribute('data-step-id') ? 'data-step-id' : 'data-sub-action-id'
              return { name, value: item.getAttribute(name)!, x: box.left + 12, y: box.top + 3 }
            }
          }
          return null
        })
        expect(cut, 'a row the list cuts off at its bottom').not.toBeNull()
        const target = { name: cut!.name, value: cut!.value } as RowTarget
        await expectOutOfView(page, target)
        await page.mouse.click(cut!.x, cut!.y)
        await expectInView(page, target)
        const focused = await page.evaluate(({ name, value }) => document.activeElement?.parentElement?.getAttribute(name) === value, target)
        expect(focused, 'focus stays on the clicked row').toBe(true)
      })
    })

    it(`a Knowledge step number brings its step into view ${where}`, async () => {
      const target = address(plan.nearEnd)
      const page = await openWithKnowledge(key, size, '?tab=knowledge', [{ testIndex: 0, stepIndex: 0 }, target])
      try {
        const reference = page.locator(`[data-step-ref][data-step-ref-test="${String(target.testIndex)}"][data-step-ref-step="${String(target.stepIndex)}"]`).first()
        await reference.waitFor()
        await expectOutOfView(page, step(plan.nearEnd))
        await reference.click()
        await expectInView(page, step(plan.nearEnd))
        expect(await reference.evaluate(element => element === document.activeElement), 'focus stays on the step number').toBe(true)
        await capture(page, `knowledge-${key}-${size.label}`)
      } finally {
        await page.close()
      }
    })

    it(`switching tabs leaves the step list where it was ${where}`, async () => {
      await withPage(key, size, `?step=${plan.nearEnd}`, `tab-switch-${key}-${size.label}`, async (page) => {
        await scrollList(page, 'top')
        expect(await listScrollTop(page)).toBe(0)
        await page.keyboard.press('2')
        await expect.poll(() => page.url()).toContain('tab=env')
        await frames(page)
        await page.waitForTimeout(500)
        expect(await listScrollTop(page)).toBe(0)
      })
    })

    it(`with reduced motion the step list jumps without animating ${where}`, async () => {
      const context = await browser.newContext({ viewport: size.viewport, reducedMotion: 'reduce' })
      try {
        const page = await open(key, size, `?step=${plan.middle}`, context)
        await scrollList(page, 'top')
        await expectOutOfView(page, action(`${plan.next}-0`))
        await page.keyboard.press('j')
        await frames(page)
        const state = await readRow(page, action(`${plan.next}-0`))
        expect(state.visible, `two frames after j: ${describeRow(action(`${plan.next}-0`), state)}`).toBe(true)
        await capture(page, `reduced-motion-${key}-${size.label}`)
      } finally {
        await context.close()
      }
    })
  }

  it(`Escape then k brings the teardown hook into view at ${size.label} on a single test's run`, async () => {
    await withPage('single', size, '', `teardown-hook-${size.label}`, async (page) => {
      const hook: RowTarget = { name: 'data-hook-id', value: runs.single.teardownLogId! }
      await expectOutOfView(page, hook)
      await page.keyboard.press('Escape')
      await page.keyboard.press('k')
      await expectInView(page, hook)
      expect(await focusIsBody(page)).toBe(true)
    })
  })

  it(`choosing a member in the filter brings its first step into view, and so does widening back to all tests at ${size.label} on a suite run`, async () => {
    await withPage('suite', size, '', `member-filter-${size.label}`, async (page) => {
      await scrollList(page, 'bottom')
      await page.locator('[data-member-filter]').click()
      await page.getByRole('option', { name: MEMBER_NAMES[2], exact: true }).click()
      await expect.poll(() => page.url()).toContain('member=2')
      await expectInView(page, step('2:0'))
      await page.locator('[data-member-filter]').click()
      await page.getByRole('option', { name: /^All tests/u }).click()
      await expect.poll(() => page.url()).not.toContain('member=')
      await expect.poll(() => page.locator('[data-member-toggle]').count()).toBe(3)
      await expectInView(page, step('2:0'))
    })
  })

  it(`a step chosen inside a collapsed member opens the member and brings the step into view at ${size.label} on a suite run`, async () => {
    await withPage('suite', size, '?step=1:13', `collapsed-member-${size.label}`, async (page) => {
      await page.locator('[data-member="2"] [data-member-toggle]').evaluate(element => (element as HTMLElement).click())
      await expect.poll(() => page.locator('[data-member="2"] [data-member-toggle]').getAttribute('aria-expanded')).toBe('false')
      await scrollList(page, 'top')
      await expectOutOfView(page, step('2:0'))
      await page.keyboard.press('Shift+ArrowDown')
      await expectInView(page, step('2:0'))
      expect(await page.locator('[data-member="2"] [data-member-toggle]').getAttribute('aria-expanded')).toBe('true')
      expect(await focusIsBody(page)).toBe(true)
    })
  })

  it(`a Knowledge step number in a member the filter hides widens the filter and brings the step into view at ${size.label} on a suite run`, async () => {
    const page = await contexts.get(size.label)!.newPage()
    try {
      const body = JSON.stringify(knowledgeProjection(runs.suite, [{ testIndex: 0, stepIndex: 0 }, address('2:12')]))
      await page.route(`**/api/runs/${encodeURIComponent(runs.suite.id)}/knowledge`, route =>
        route.fulfill({ status: 200, contentType: 'application/json', body }))
      await page.goto(runUrl('suite', '?tab=knowledge&member=0'))
      await page.locator('[data-step-id]').first().waitFor()
      const reference = page.locator('[data-step-ref][data-step-ref-test="2"][data-step-ref-step="12"]').first()
      await reference.waitFor()
      await expectOutOfView(page, step('2:12'))
      await reference.click()
      await expect.poll(() => page.url()).not.toContain('member=')
      await expectInView(page, step('2:12'))
      expect(await reference.evaluate(element => element === document.activeElement), 'focus stays on the step number').toBe(true)
      await capture(page, `knowledge-hidden-member-${size.label}`)
    } finally {
      await page.close()
    }
  })
}
