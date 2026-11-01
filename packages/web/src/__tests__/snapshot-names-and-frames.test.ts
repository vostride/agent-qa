import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { PlannerConfig } from '@vostride/agent-qa-runner'
import { asRef } from '@vostride/agent-qa-runner'
import { readBindingOutcomeMeta } from '@vostride/agent-qa-schema'
import type { Ref, ScreenState } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { scrollWithRef } from '../scroll-helper.js'
import type { RefMap } from '../types.js'
import {
  act,
  giveUp,
  refFor,
  runScriptedStep,
  scriptedPlanner,
  scriptedVerifier,
} from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const html = (body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>${body}</body></html>`

const NAMES = html(`
  <h2><a href="#shipping">Shipping</a></h2>
  <button type="button"><img alt="Close dialog"></button>
  <table><tr><td><a href="#order-42">Order 42</a></td><td>Paid</td></tr></table>
  <button type="button"><span>Save draft</span></button>
  <button type="button">Checkout</button>`)

const START = html(`
  <a href="/next">Continue to next page</a>
  <form action="/next" method="get">
    <input name="from" value="form" aria-label="Source">
    <button type="submit">Submit order</button>
  </form>`)

const NEXT = html(`
  <div role="region" aria-label="Order history" style="height:150px;overflow:auto">
    <div style="height:2000px">History</div>
  </div>
  <iframe id="panel" src="/frame" style="display:block;border:0;width:380px;height:300px"></iframe>`)

const FRAME = html(`
  <button type="button">Approve</button>
  <div role="region" aria-label="Frame history" style="height:120px;overflow:auto">
    <div style="height:2000px">Frame list</div>
  </div>`)

const PAGES: Record<string, string> = { '/names': NAMES, '/start': START, '/next': NEXT, '/frame': FRAME }

let server: Server
let baseUrl = ''
let adapter: WebPlatformAdapter | undefined

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = PAGES[(req.url ?? '/').split('?')[0]]
    res.writeHead(body === undefined ? 404 : 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body ?? 'not found')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}, 60_000)

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
}, 60_000)

async function open(path: string): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
  adapter = created
  await created.getPage()!.goto(baseUrl + path, { waitUntil: 'load' })
  return created
}

function refMapOf(web: WebPlatformAdapter): RefMap {
  return (web as unknown as { lastRefs: RefMap }).lastRefs
}

function namesOf(screen: ScreenState, role: string): string[] {
  return screen.elements.filter((element) => element.role === role).map((element) => element.name)
}

function scrollDown(ref: Ref) {
  return {
    type: 'scroll',
    mode: 'direction',
    direction: 'down',
    amount: 'page',
    retryOpposite: false,
    ref,
  } as never
}

async function mainScrollTop(page: Page): Promise<number> {
  return page.locator('[aria-label="Order history"]').evaluate((el) => el.scrollTop)
}

async function frameScrollTop(page: Page): Promise<number> {
  return page.frameLocator('#panel').locator('[aria-label="Frame history"]')
    .evaluate((el) => el.scrollTop)
}

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the click landed' }))

describe('names Playwright gives an element from its children, on a page served over HTTP', () => {
  it('an element named by its children keeps its name', async () => {
    const web = await open('/names')
    const screen = await web.observe()

    expect(namesOf(screen, 'heading')).toContain('Shipping')
    expect(namesOf(screen, 'button')).toEqual(
      expect.arrayContaining(['Close dialog', 'Save draft']),
    )
    expect(namesOf(screen, 'row')).toContain('Order 42 Paid')
    expect(namesOf(screen, 'cell')).toContain('Order 42')
  }, 60_000)

  it("a stated name that contradicts the element's name is refused", async () => {
    const web = await open('/names')
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'heading', 'Shipping'),
          target: { role: 'heading', name: 'Checkout' },
        },
        true,
        'Open checkout',
      ),
      () => giveUp('Checkout could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open checkout',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.executed).toHaveLength(0)
    const first = run.result.evidence!.subActions[0]
    expect(first.result.success).toBe(false)
    expect(first.result.error).toMatch(/^target-mismatch: /)
    expect(first.result.metadata?.['targetRefusal']).toMatchObject({
      kind: 'target-mismatch',
      stated: { role: 'heading', name: 'Checkout' },
      observed: { role: 'heading', name: 'Shipping' },
      inputSent: false,
    })
    expect(web.getPage()!.url()).toBe(baseUrl + '/names')
  }, 60_000)
})

const NAVIGATIONS = [
  { how: 'after a link click', role: 'link', name: 'Continue to next page' },
  { how: 'after a form submit', role: 'button', name: 'Submit order' },
] as const

describe.each(NAVIGATIONS)('refs $how from a real URL', ({ role, name }) => {
  // Observes /start, follows its link or submits its form through the adapter, waits for /next.
  async function arriveAtNext(): Promise<{ web: WebPlatformAdapter; startRef: Ref }> {
    const web = await open('/start')
    const startRef = refFor(await web.observe(), role, name)
    const clicked = await web.execute({ type: 'click', ref: asRef(startRef) } as never)
    expect(clicked.success).toBe(true)
    const page = web.getPage()!
    await page.waitForURL(/\/next/)
    await page.frameLocator('#panel').getByRole('button', { name: 'Approve' }).waitFor()
    return { web, startRef }
  }

  it('a container scroll by ref scrolls the container', async () => {
    const { web } = await arriveAtNext()
    const page = web.getPage()!
    const history = refFor(await web.observe(), 'region', 'Order history')

    const scrolled = await web.execute(scrollDown(history))

    expect(scrolled.success).toBe(true)
    const afterAdapter = await mainScrollTop(page)
    expect(afterAdapter).toBeGreaterThan(0)
    const report = await scrollWithRef(page, refMapOf(web), history, 0, 100, 'vertical')
    expect(report.scrolledContainer).toBe('element')
    expect(report.scrolled).toBe(true)
    expect(await mainScrollTop(page)).toBeGreaterThan(afterAdapter)
  }, 60_000)

  it('a ref from the old document is refused as stale', async () => {
    const { web, startRef } = await arriveAtNext()

    const result = await web.execute({ type: 'click', ref: asRef(startRef) } as never)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^stale-observation:/)
    expect(readBindingOutcomeMeta(result)?.outcome).toBe('stale-observation')
  }, 60_000)

  it('a ref inside an iframe is still a child-frame ref', async () => {
    const { web } = await arriveAtNext()
    const page = web.getPage()!
    const screen = await web.observe()
    const frameHistory = refFor(screen, 'region', 'Frame history')
    const approve = refFor(screen, 'button', 'Approve')

    const scrolled = await web.execute(scrollDown(frameHistory))
    expect(scrolled.success).toBe(true)
    expect(await frameScrollTop(page)).toBe(0)
    const report = await scrollWithRef(page, refMapOf(web), frameHistory, 0, 100, 'vertical')
    expect(report.scrolledContainer).toBe('notFound')

    await page.locator('#panel').evaluate((frame) => { frame.remove() })
    const result = await web.execute({ type: 'click', ref: asRef(approve) } as never)

    expect(result.success).toBe(false)
    expect(readBindingOutcomeMeta(result)?.outcome).toBe('frame-detached')
  }, 60_000)
})
