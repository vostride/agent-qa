import { afterEach, describe, expect, it } from 'vitest'
import type { Action, ExecuteOptions, PlannerConfig } from '@vostride/agent-qa-runner'
import { asRef } from '@vostride/agent-qa-runner'
import { readBindingOutcomeMeta } from '@vostride/agent-qa-schema'
import type { BindingOutcome } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { buildScrollPrimitives } from '../compound-web.js'
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

const ADDRESSES_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul id="addresses">
    <li id="elm">
      <p><strong>Work</strong></p>
      <p>7 Elm Street, Springfield</p>
      <button type="button" onclick="window.__clicks.push('7 Elm Street, Springfield')">Edit label</button>
    </li>
    <li>
      <p><strong>Home</strong></p>
      <p>1 Home Street, Springfield</p>
      <button type="button" onclick="window.__clicks.push('1 Home Street, Springfield')">Edit label</button>
    </li>
    <li>
      <p><strong>Old</strong></p>
      <p>9 Oak Road, Springfield</p>
      <button type="button" onclick="window.__clicks.push('9 Oak Road, Springfield')">Edit label</button>
    </li>
  </ul>
</body></html>`

const INVOICES_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <a href="#invoice-947" onclick="window.__clicks.push('Invoice 947')">Invoice 947</a>
  <a href="#invoice-946" onclick="window.__clicks.push('Invoice 946')">Invoice 946</a>
</body></html>`

// The Elm row's own li moves to the end of its list: the same nodes, a new position.
const MOVE_ELM_TO_BOTTOM = `(() => {
  const elm = document.getElementById('elm')
  elm.parentElement.appendChild(elm)
})()`

let adapter: WebPlatformAdapter | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
}, 60_000)

async function open(html: string): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
  adapter = created
  await created.getPage()!.setContent(html)
  return created
}

async function pageClicks(web: WebPlatformAdapter): Promise<string[]> {
  return web.getPage()!.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks)
}

function refMapOf(web: WebPlatformAdapter): RefMap {
  return (web as unknown as { lastRefs: RefMap }).lastRefs
}

const ARTICLE_INVOICES_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <article>
    <p id="status">Status: 2 invoices due this week</p>
    <table>
      <tr onclick="window.__clicks.push('Invoice 947')"><td>Invoice 947</td><td><button type="button">Pay</button></td></tr>
      <tr onclick="window.__clicks.push('Invoice 946')"><td>Invoice 946</td><td><button type="button">Pay</button></td></tr>
    </table>
  </article>
</body></html>`

const CHANGE_ARTICLE_STATUS = `document.getElementById('status').textContent = 'Status: 1 invoice due today'`

// Runs a page script once, right before the first dispatch reaches the adapter.
function changingBeforeDispatch(web: WebPlatformAdapter, script: string): WebPlatformAdapter {
  let changed = false
  return new Proxy(web, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          if (!changed) {
            changed = true
            await target.getPage()!.evaluate(script)
          }
          return target.execute(action as never, options)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the click landed' }))

describe('dispatch binds to the observed element through aria-ref', () => {
  it('a moved row is followed, never the row now at its old position', async () => {
    const web = await open(ADDRESSES_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Edit label', 0),
          target: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
        },
        true,
        'Edit the Elm Street label',
      ),
      () => giveUp('the Elm Street label could not be edited'),
    ])
    const run = await runScriptedStep({
      adapter: changingBeforeDispatch(web, MOVE_ELM_TO_BOTTOM),
      instruction: "Edit the label of the address '7 Elm Street'",
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
    expect(planner.calls).toBe(1)
    expect(run.executed).toHaveLength(1)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('the resolver defect: Invoice 946 beside Invoice 947 is clicked', async () => {
    const web = await open(INVOICES_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'link', 'Invoice 946'),
          target: { role: 'link', name: 'Invoice 946' },
        },
        true,
        'Open invoice 946',
      ),
      () => giveUp('invoice 946 could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open Invoice 946',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(await pageClicks(web)).toEqual(['Invoice 946'])
    expect(run.executed).toHaveLength(1)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('an unchanged page dispatches through aria-ref', async () => {
    const web = await open(ADDRESSES_PAGE)
    const state = await web.observe()
    const ref = refFor(state, 'button', 'Edit label', 0)
    const entry = refMapOf(web)[ref] as Record<string, unknown> | undefined

    expect(entry).toBeDefined()
    expect(entry!['nativeRef']).toMatch(/^e\d+$/)
    expect(entry!['role']).toBe('button')
    expect(entry!['name']).toBe('Edit label')
    expect(entry!['rowText']).toBe('Work 7 Elm Street, Springfield Edit label')

    const result = await web.execute({ type: 'click', ref: asRef(ref) } as never)

    expect(result.success).toBe(true)
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
  }, 60_000)

  it('a row inside an article whose status line changes between observe and dispatch is dispatched onto the same row', async () => {
    const web = await open(ARTICLE_INVOICES_PAGE)
    const state = await web.observe()
    const rows = state.elements.filter(
      (element) => element.role === 'row' && element.name.includes('Invoice 947'),
    )
    expect(rows).toHaveLength(1)
    const ref = rows[0].ref
    expect(refMapOf(web)[ref]?.rowText).toContain('Invoice 947')

    await web.getPage()!.evaluate(CHANGE_ARTICLE_STATUS)
    const result = await web.execute({ type: 'click', ref: asRef(ref) } as never)

    expect(result.error).toBeUndefined()
    expect(readBindingOutcomeMeta(result)).toBeUndefined()
    expect(result.success).toBe(true)
    expect(await pageClicks(web)).toEqual(['Invoice 947'])
  }, 60_000)
})

// The address rows above a tall tail, so a scroll moves the page.
const TALL_ADDRESSES_PAGE = ADDRESSES_PAGE.replace(
  '</ul>',
  '</ul><div style="height: 3000px">Page tail</div>',
)

const frameButton = (name: string): string =>
  `<button type='button' onclick='parent.__clicks.push(&quot;${name}&quot;)'>${name}</button>`

const FRAMED_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <button type="button" onclick="window.__clicks.push('Main')">Main action</button>
  <iframe id="payments" srcdoc="${frameButton('Approve')}${frameButton('Decline')}"></iframe>
</body></html>`

// The Elm and Oak rows trade their text; every li and button node stays where it was.
const SWAP_ELM_AND_OAK_TEXT = `(() => {
  const [elm, , oak] = document.querySelectorAll('#addresses > li')
  const elmTexts = elm.querySelectorAll('p')
  const oakTexts = oak.querySelectorAll('p')
  elmTexts.forEach((p, i) => {
    const text = p.innerHTML
    p.innerHTML = oakTexts[i].innerHTML
    oakTexts[i].innerHTML = text
  })
})()`

// Identical markup, new nodes.
const REWRITE_LIST = `(() => {
  const list = document.getElementById('addresses')
  list.innerHTML = list.innerHTML
})()`

const REMOVE_FRAME = `document.getElementById('payments').remove()`

const PUSH_STATE = `history.pushState({}, '', '#moved')`

function bindingOutcomeOf(
  result: { metadata?: Record<string, unknown> },
): BindingOutcome | undefined {
  return readBindingOutcomeMeta(result)?.outcome
}

async function clickAfter(
  web: WebPlatformAdapter,
  ref: string,
  change: (page: NonNullable<ReturnType<WebPlatformAdapter['getPage']>>) => Promise<unknown>,
) {
  await change(web.getPage()!)
  return web.execute({ type: 'click', ref: asRef(ref) } as never)
}

describe('binding outcomes when the page changes between observe and dispatch', () => {
  it('recycled: the Elm row text swapped under the same nodes is binding-changed', async () => {
    const web = await open(ADDRESSES_PAGE)
    const elm = refFor(await web.observe(), 'button', 'Edit label', 0)

    const result = await clickAfter(web, elm, (page) => page.evaluate(SWAP_ELM_AND_OAK_TEXT))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^binding-changed:/)
    expect(bindingOutcomeOf(result)).toBe('binding-changed')
    expect(readBindingOutcomeMeta(result)).toEqual({
      outcome: 'binding-changed',
      ref: elm,
      inputSent: false,
    })
    expect(await pageClicks(web)).toEqual([])
  }, 60_000)

  it('replaced: the list rewritten with identical markup is binding-lost', async () => {
    const web = await open(ADDRESSES_PAGE)
    const elm = refFor(await web.observe(), 'button', 'Edit label', 0)

    const result = await clickAfter(web, elm, (page) => page.evaluate(REWRITE_LIST))

    expect(result.success).toBe(false)
    expect(bindingOutcomeOf(result)).toBe('binding-lost')
    expect(await pageClicks(web)).toEqual([])
  }, 60_000)

  it('frame detached: a button in a removed iframe is frame-detached', async () => {
    const web = await open(FRAMED_PAGE)
    const state = await web.observe()
    const approve = refFor(state, 'button', 'Approve')
    expect(refMapOf(web)[approve]?.nativeRef).toMatch(/^f\d+e\d+$/)

    const result = await clickAfter(web, approve, (page) => page.evaluate(REMOVE_FRAME))

    expect(result.success).toBe(false)
    expect(bindingOutcomeOf(result)).toBe('frame-detached')
    expect(await pageClicks(web)).toEqual([])
  }, 60_000)

  it('pushState: a same-document URL change keeps the binding and the click lands', async () => {
    const web = await open(ADDRESSES_PAGE)
    const elm = refFor(await web.observe(), 'button', 'Edit label', 0)

    const result = await clickAfter(web, elm, (page) => page.evaluate(PUSH_STATE))

    expect(result.success).toBe(true)
    expect(bindingOutcomeOf(result)).toBeUndefined()
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
  }, 60_000)

  it("a scroll compound's interim snapshot keeps the binding", async () => {
    const web = await open(TALL_ADDRESSES_PAGE)
    const elm = refFor(await web.observe(), 'button', 'Edit label', 0)
    const page = web.getPage()!

    const scrolled = await web.execute({
      type: 'scroll',
      mode: 'direction',
      direction: 'down',
      amount: 'page',
      retryOpposite: false,
    } as never)
    expect(scrolled.success).toBe(true)
    expect(await page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY))
      .toBeGreaterThan(0)
    // The web compound decides visibility with its own probe, so the interim tree is read here.
    const interim = await buildScrollPrimitives(page, refMapOf(web), 720).readInterimTree()
    expect(interim.length).toBeGreaterThan(0)
    expect(await pageClicks(web)).toEqual([])

    const result = await web.execute({ type: 'click', ref: asRef(elm) } as never)

    expect(result.success).toBe(true)
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
  }, 60_000)

  it('a default-mode snapshot taken by someone else is repaired by the re-check', async () => {
    const web = await open(ADDRESSES_PAGE)
    const elm = refFor(await web.observe(), 'button', 'Edit label', 0)
    const nativeRef = refMapOf(web)[elm]!.nativeRef

    const result = await clickAfter(web, elm, async (page) => {
      await page.locator(':root').ariaSnapshot()
      expect(await page.locator('aria-ref=' + nativeRef).count()).toBe(0)
    })

    expect(result.success).toBe(true)
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
  }, 60_000)
})
