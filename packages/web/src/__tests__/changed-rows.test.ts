// C438-REORDERED-ROWS (438 D-09, SC2): what happens when the rows the planner looked at change
// before its action reaches the page. Real headless Chromium through the real runner loop; pages
// are inline snippets. 438-06 holds the navigated leg; 438-07 the replaced and recycled legs (the
// strict heal, D-07, D-08); 438-08 the cached leg (strict replay through the row words, D-10,
// D-11); 438-09 the cached miss leg (no row words, so the repeated label is a recorded miss).

import { afterEach, describe, expect, it } from 'vitest'
import type { Action, ExecuteOptions, PlannerConfig } from '@vostride/agent-qa-runner'
import { readBindingOutcomeMeta } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import {
  act,
  giveUp,
  memoryCache,
  refFor,
  runScriptedStep,
  scriptedPlanner,
  scriptedVerifier,
} from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const ROWS_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
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

const ELM_TARGET = { role: 'button', name: 'Edit label', row: '7 Elm Street' }

const opened: WebPlatformAdapter[] = []

afterEach(async () => {
  for (const web of opened.splice(0)) await web.cleanup()
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
  opened.push(created)
  await created.getPage()!.setContent(html)
  return created
}

async function pageClicks(web: WebPlatformAdapter): Promise<string[]> {
  return web.getPage()!.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks)
}

interface Navigating {
  adapter: WebPlatformAdapter
  /** The new document's `__clicks`, read right after the first dispatch returned. */
  clicksAfterFirst: () => string[] | undefined
}

// Loads a new document holding `html` once, right before the first dispatch reaches the adapter.
// `page.goto` is a real navigation; `page.setContent` would keep the document.
function navigatingBeforeDispatch(web: WebPlatformAdapter, html: string): Navigating {
  let navigated = false
  let clicksAfterFirst: string[] | undefined
  const proxy = new Proxy(web, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          if (navigated) return target.execute(action as never, options)
          navigated = true
          await target.getPage()!.goto('data:text/html,' + encodeURIComponent(html))
          const result = await target.execute(action as never, options)
          clicksAfterFirst = await pageClicks(target)
          return result
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  return { adapter: proxy, clicksAfterFirst: () => clicksAfterFirst }
}

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the click landed' }))

const ELM = { label: 'Work', street: '7 Elm Street, Springfield' }
const HOME = { label: 'Home', street: '1 Home Street, Springfield' }
const OAK = { label: 'Old', street: '9 Oak Road, Springfield' }

// Each button logs the street its row shows when it is clicked, so a click follows the row's
// current content, not the content it had when the planner looked.
function rowsMarkup(rows: readonly { label: string; street: string }[]): string {
  return rows.map((row) => `<li>
      <p><strong>${row.label}</strong></p>
      <p class="street">${row.street}</p>
      <button type="button" onclick="window.__clicks.push(this.parentElement.querySelector('.street').textContent)">Edit label</button>
    </li>`).join('\n')
}

const LIVE_ROWS_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul id="addresses">
    ${rowsMarkup([ELM, HOME, OAK])}
  </ul>
</body></html>`

type PageChange = (page: NonNullable<ReturnType<WebPlatformAdapter['getPage']>>) => Promise<void>

function replaceRows(rows: readonly { label: string; street: string }[]): PageChange {
  const markup = rowsMarkup(rows)
  return (page) => page.evaluate((html) => {
    const doc = (globalThis as unknown as { document: { getElementById(id: string): { innerHTML: string } } }).document
    doc.getElementById('addresses').innerHTML = html
  }, markup)
}

// The first and third rows exchange their label and street text; every node stays where it was.
const swapElmAndOak: PageChange = (page) => page.evaluate(() => {
  type Node = { textContent: string; querySelector(selector: string): Node }
  const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): Node[] } }).document
  const rows = doc.querySelectorAll('#addresses > li')
  for (const selector of ['strong', '.street']) {
    const first = rows[0].querySelector(selector)
    const third = rows[2].querySelector(selector)
    const text = first.textContent
    first.textContent = third.textContent
    third.textContent = text
  }
})

// The Elm row moves to the bottom of the list; every node is kept, so a binding follows it.
const moveElmToBottom: PageChange = (page) => page.evaluate(() => {
  type Node = { parentElement: { appendChild(node: Node): void } }
  const doc = (globalThis as unknown as { document: { querySelector(s: string): Node } }).document
  const elm = doc.querySelector('#addresses > li')
  elm.parentElement.appendChild(elm)
})

interface Changing {
  adapter: WebPlatformAdapter
  /** The adapter's result for the first dispatch, before any heal. */
  firstResult: () => Awaited<ReturnType<WebPlatformAdapter['execute']>> | undefined
  /** `__clicks` right after the first dispatch returned. */
  clicksAfterFirst: () => string[] | undefined
}

// Changes the page once, right before the first dispatch reaches the adapter.
function changingBeforeDispatch(web: WebPlatformAdapter, change: PageChange): Changing {
  let changed = false
  let firstResult: Awaited<ReturnType<WebPlatformAdapter['execute']>> | undefined
  let clicksAfterFirst: string[] | undefined
  const proxy = new Proxy(web, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          if (changed) return target.execute(action as never, options)
          changed = true
          await change(target.getPage()!)
          const result = await target.execute(action as never, options)
          firstResult = result
          clicksAfterFirst = await pageClicks(target)
          return result
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  return {
    adapter: proxy,
    firstResult: () => firstResult,
    clicksAfterFirst: () => clicksAfterFirst,
  }
}

interface Leg {
  change: PageChange
  /** The street the row at Elm's observed position shows after the change. */
  streetAtOldIndex: string
}

const LEGS = {
  replacedProvable: { change: replaceRows([HOME, OAK, ELM]), streetAtOldIndex: HOME.street },
  replacedGone: { change: replaceRows([HOME, OAK]), streetAtOldIndex: HOME.street },
  replacedTwice: { change: replaceRows([HOME, ELM, ELM]), streetAtOldIndex: HOME.street },
  recycled: { change: swapElmAndOak, streetAtOldIndex: OAK.street },
} satisfies Record<string, Leg>

async function runLeg(leg: Leg) {
  const web = await open(LIVE_ROWS_PAGE)
  const changing = changingBeforeDispatch(web, leg.change)
  const failureContexts: (string | undefined)[] = []
  const planner = scriptedPlanner([
    (screen) => act(
      { type: 'click', ref: refFor(screen, 'button', 'Edit label', 0), target: ELM_TARGET },
      true,
      'Edit the Elm Street label',
    ),
    (_screen, context) => {
      failureContexts.push(context.failureContext)
      return giveUp('the Elm Street label could not be edited')
    },
  ])
  const run = await runScriptedStep({
    adapter: changing.adapter,
    instruction: "Edit the label of the address '7 Elm Street'",
    planner,
    verifier: passes,
    plannerConfig: LIMITS,
  })
  return {
    run,
    planner,
    failureContexts,
    firstOutcome: readBindingOutcomeMeta(changing.firstResult())?.outcome,
    clicksAfterFirst: changing.clicksAfterFirst(),
    clicks: await pageClicks(web),
  }
}

describe('C438-REORDERED-ROWS', () => {
  it('navigated: stale-observation, nothing sent, never healed', async () => {
    const web = await open(ROWS_PAGE)
    const navigating = navigatingBeforeDispatch(web, ROWS_PAGE)
    const editElm = (screen: Parameters<typeof refFor>[0]) => act(
      { type: 'click', ref: refFor(screen, 'button', 'Edit label', 0), target: ELM_TARGET },
      true,
      'Edit the Elm Street label',
    )
    const planner = scriptedPlanner([
      editElm,
      editElm,
      () => giveUp('the Elm Street label could not be edited'),
    ])
    const run = await runScriptedStep({
      adapter: navigating.adapter,
      instruction: "Edit the label of the address '7 Elm Street'",
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    const [first, second] = run.result.evidence!.subActions
    expect(first.result.success).toBe(false)
    expect(first.result.error).toMatch(/^stale-observation:/)
    expect(readBindingOutcomeMeta(first.result)).toEqual({
      outcome: 'stale-observation',
      ref: (first.plannedAction as { ref?: string }).ref,
      inputSent: false,
    })
    const stages = (first.grounding?.attempts ?? []).map((attempt) => attempt.stage)
    expect(stages).not.toContain('tree-search')
    expect(navigating.clicksAfterFirst()).toEqual([])

    expect(second.result.success).toBe(true)
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
    expect(planner.calls).toBe(2)
    expect(run.executed).toHaveLength(2)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('replaced and provable: re-found and clicked', async () => {
    const { run, planner, firstOutcome, clicksAfterFirst, clicks } = await runLeg(
      LEGS.replacedProvable,
    )

    expect(firstOutcome).toBe('binding-lost')
    expect(clicksAfterFirst).toEqual([])
    expect(clicks).toEqual(['7 Elm Street, Springfield'])
    expect(planner.calls).toBe(1)
    expect(run.executed).toHaveLength(2)
    expect(run.result.evidence?.limitUsage?.actionsUsed).toBe(2)
    expect(run.result.status).toBe('passed')
    const [healed] = run.result.evidence!.subActions
    expect(healed.result.success).toBe(true)
    const attempts = healed.grounding?.attempts ?? []
    expect(attempts.at(-1)).toMatchObject({ stage: 'tree-search', outcome: 'resolved' })
    expect(healed.grounding?.descriptor.name).toBe('Edit label')
    expect(healed.grounding?.descriptor.ordinal).toBeUndefined()
    expect(healed.grounding?.descriptor.row).toContain('7 Elm Street')
  }, 90_000)

  it('replaced and gone: refused', async () => {
    const { run, planner, failureContexts, clicks } = await runLeg(LEGS.replacedGone)

    expect(clicks).toEqual([])
    expect(run.executed).toHaveLength(1)
    const [first] = run.result.evidence!.subActions
    expect(first.result.success).toBe(false)
    expect(readBindingOutcomeMeta(first.result)).toEqual({
      outcome: 'binding-lost',
      ref: (first.plannedAction as { ref?: string }).ref,
      inputSent: false,
      heal: 'absent',
    })
    expect(planner.calls).toBe(2)
    expect(failureContexts[0]).toMatch(/no single current element is provably the same/)
    expect(run.result.evidence?.limitUsage?.actionsUsed).toBe(1)
    expect(run.result.status).toBe('failed')
  }, 90_000)

  it('replaced into two identical rows: refused', async () => {
    const { run, planner, clicks } = await runLeg(LEGS.replacedTwice)

    expect(clicks).toEqual([])
    expect(run.executed).toHaveLength(1)
    const [first] = run.result.evidence!.subActions
    expect(readBindingOutcomeMeta(first.result)).toMatchObject({
      outcome: 'binding-lost',
      inputSent: false,
      heal: 'not-unique',
    })
    expect(planner.calls).toBe(2)
    expect(run.result.status).toBe('failed')
  }, 90_000)

  it('recycled: the click follows the content', async () => {
    const { run, planner, firstOutcome, clicksAfterFirst, clicks } = await runLeg(LEGS.recycled)

    expect(firstOutcome).toBe('binding-changed')
    expect(clicksAfterFirst).toEqual([])
    expect(clicks).toEqual(['7 Elm Street, Springfield'])
    expect(planner.calls).toBe(1)
    expect(run.executed).toHaveLength(2)
    expect(run.result.status).toBe('passed')
    const [healed] = run.result.evidence!.subActions
    const attempts = healed.grounding?.attempts ?? []
    expect(attempts.at(-1)).toMatchObject({ stage: 'tree-search', outcome: 'resolved' })
  }, 90_000)

  it('never the row at the old position', async () => {
    for (const leg of Object.values(LEGS)) {
      const { clicks } = await runLeg(leg)
      expect(clicks).not.toContain(leg.streetAtOldIndex)
    }
  }, 240_000)

  it('cached: a real hit through the row words lands on Elm\'s row', async () => {
    const cache = memoryCache()
    const instruction = "Edit the label of the address '7 Elm Street'"

    const live = await open(LIVE_ROWS_PAGE)
    const livePlanner = scriptedPlanner([
      (screen) => act(
        { type: 'click', ref: refFor(screen, 'button', 'Edit label', 0), target: ELM_TARGET },
        true,
        'Edit the Elm Street label',
      ),
    ])
    const first = await runScriptedStep({
      adapter: live,
      instruction,
      planner: livePlanner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })
    expect(first.result.status).toBe('passed')
    expect(await pageClicks(live)).toEqual(['7 Elm Street, Springfield'])
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])?.groundedLocator).toEqual([
      { role: 'button', name: 'Edit label', row: '7 Elm Street' },
    ])

    const web = await open(LIVE_ROWS_PAGE)
    const changing = changingBeforeDispatch(web, moveElmToBottom)
    const planner = scriptedPlanner([() => giveUp('the cached Elm Street label did not replay')])
    const run = await runScriptedStep({
      adapter: changing.adapter,
      instruction,
      planner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })

    expect(cache.gets.at(-1)).toEqual({ key: cache.sets[0], hit: true })
    expect(run.result.evidence?.cacheStatus).toBe('hit')
    expect(planner.calls).toBe(0)
    expect(changing.clicksAfterFirst()).toEqual(['7 Elm Street, Springfield'])
    expect(await pageClicks(web)).toEqual(['7 Elm Street, Springfield'])
    expect(run.executed).toHaveLength(1)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('cached without row words: the repeated label is a miss', async () => {
    const cache = memoryCache()
    const instruction = "Edit the label of the address '7 Elm Street'"

    const live = await open(LIVE_ROWS_PAGE)
    const livePlanner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Edit label', 0),
          target: { role: 'button', name: 'Edit label' },
        },
        true,
        'Edit the first address label',
      ),
    ])
    const first = await runScriptedStep({
      adapter: live,
      instruction,
      planner: livePlanner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })
    expect(first.result.status).toBe('passed')
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])?.groundedLocator).toEqual([
      { role: 'button', name: 'Edit label' },
    ])

    const web = await open(LIVE_ROWS_PAGE)
    const planner = scriptedPlanner([() => giveUp('the cached label did not replay')])
    const run = await runScriptedStep({
      adapter: web,
      instruction,
      planner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })

    expect(cache.gets.at(-1)).toEqual({ key: cache.sets[0], hit: true })
    expect(run.result.evidence?.cacheStatus).toBe('miss')
    expect(run.result.evidence?.cacheMiss).toEqual({ reason: 'strict-not-unique' })
    expect(planner.calls).toBe(1)
    expect(run.executed).toEqual([])
    expect(await pageClicks(web)).toEqual([])
    expect(cache.store.size).toBe(0)
  }, 90_000)
})
