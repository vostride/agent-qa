// C438-IDENTICAL-CONTROLS (438 D-12, D-14, SC4): AUTO-15 on two identical 'Okay' buttons. A step
// that does not say which one clicks nothing and ends infeasible naming both; a step that names
// the second clicks the second, and keeps clicking it after the two swap places. Real headless
// Chromium through the real runner loop; the page is an inline snippet. The cache and heal legs
// refuse too: a stored Okay never replays onto either, and a replaced Okay is not provably either.

import { afterEach, describe, expect, it } from 'vitest'
import type { Action, ExecuteOptions, PlannerConfig } from '@vostride/agent-qa-runner'
import { readBindingOutcomeMeta } from '@vostride/agent-qa-schema'
import type { Ref, ScreenState } from '@vostride/agent-qa-schema'
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
import type { ScriptedTurn } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const OKAY = { role: 'button', name: 'Okay' }

// Each button logs the position it was created at, so a click names the element, not the place.
const TWO_OKAY_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <div id="actions">
    <button type="button" onclick="window.__clicks.push('first')">Okay</button>
    <button type="button" onclick="window.__clicks.push('second')">Okay</button>
  </div>
</body></html>`

const ONE_OKAY_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <div id="actions">
    <button type="button" onclick="window.__clicks.push('only')">Okay</button>
  </div>
</body></html>`

const opened: WebPlatformAdapter[] = []

afterEach(async () => {
  for (const web of opened.splice(0)) await web.cleanup()
}, 120_000)

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

type Page = NonNullable<ReturnType<WebPlatformAdapter['getPage']>>

// The second Okay moves in front of the first; both nodes are kept.
const swapOkays = (page: Page) => page.evaluate(() => {
  type Node = { parentElement: { insertBefore(node: Node, before: Node): void } }
  const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): Node[] } }).document
  const [first, second] = doc.querySelectorAll('#actions > button')
  first.parentElement.insertBefore(second, first)
})

// The lone Okay is replaced by two new, identical Okay buttons.
const replaceWithTwoOkays = (page: Page) => page.evaluate(() => {
  const doc = (globalThis as unknown as {
    document: { getElementById(id: string): { innerHTML: string } }
  }).document
  doc.getElementById('actions').innerHTML = `
    <button type="button" onclick="window.__clicks.push('first')">Okay</button>
    <button type="button" onclick="window.__clicks.push('second')">Okay</button>`
})

interface Changing {
  adapter: WebPlatformAdapter
  /** The adapter's result for the first dispatch, before any heal. */
  firstResult: () => Awaited<ReturnType<WebPlatformAdapter['execute']>> | undefined
}

// Changes the page once, right before the first dispatch reaches the adapter.
function changingBeforeDispatch(
  web: WebPlatformAdapter,
  change: (page: Page) => Promise<void>,
): Changing {
  let changed = false
  let firstResult: Awaited<ReturnType<WebPlatformAdapter['execute']>> | undefined
  const adapter = new Proxy(web, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          if (changed) return target.execute(action as never, options)
          changed = true
          await change(target.getPage()!)
          firstResult = await target.execute(action as never, options)
          return firstResult
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
  return { adapter, firstResult: () => firstResult }
}

function okayRefs(screen: ScreenState): Ref[] {
  return screen.elements
    .filter((element) => element.role === OKAY.role && element.name === OKAY.name)
    .map((element) => element.ref)
}

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the click landed' }))

const clickSecondOkay: ScriptedTurn = (screen) => act(
  { type: 'click', ref: refFor(screen, 'button', 'Okay', 1), target: OKAY },
  true,
  'Click the second Okay button',
)

describe('two identical Okay buttons', () => {
  it('descriptor path: an ambiguous step clicks nothing', async () => {
    const web = await open(TWO_OKAY_PAGE)
    const failureContexts: (string | undefined)[] = []
    const candidates: Ref[][] = []
    const planner = scriptedPlanner([
      () => act({ type: 'click', target: OKAY }, true, 'Click the Okay button'),
      (screen, context) => {
        failureContexts.push(context.failureContext)
        const refs = okayRefs(screen)
        candidates.push(refs)
        return {
          reasoning: 'Two identical Okay buttons; the step does not say which',
          action: { type: 'delay', ms: 0 },
          confidence: 0.9,
          stepComplete: false,
          stepFailed: true,
          failureKind: 'infeasible',
          failureReason: `The step does not say which Okay button: candidates ${refs.join(' and ')}`,
        }
      },
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Click the okay button',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.executed).toEqual([])
    expect(await pageClicks(web)).toEqual([])
    expect(planner.calls).toBe(2)
    const [refused] = run.result.evidence!.subActions
    expect(refused.result.success).toBe(false)
    expect(refused.result.error).toMatch(/^2 elements match .*the descriptor is ambiguous/)
    expect(failureContexts[0]).toMatch(/2 elements match/)
    expect(candidates[0]).toHaveLength(2)
    const termination = run.result.evidence?.termination
    expect(termination?.kind).toBe('infeasible')
    for (const ref of candidates[0]) expect(termination?.reason).toContain(ref)
    expect(run.result.status).toBe('failed')
  }, 90_000)

  it('"the second okay button" clicks the second', async () => {
    const web = await open(TWO_OKAY_PAGE)
    const planner = scriptedPlanner([clickSecondOkay])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Click the second okay button',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(await pageClicks(web)).toEqual(['second'])
    expect(run.executed).toHaveLength(1)
    expect(planner.calls).toBe(1)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('the second stays the second when they swap', async () => {
    const web = await open(TWO_OKAY_PAGE)
    const planner = scriptedPlanner([clickSecondOkay])
    const run = await runScriptedStep({
      adapter: changingBeforeDispatch(web, swapOkays).adapter,
      instruction: 'Click the second okay button',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    const order = await web.getPage()!.evaluate(() => {
      const doc = (globalThis as unknown as {
        document: { querySelectorAll(s: string): { getAttribute(name: string): string }[] }
      }).document
      return [...doc.querySelectorAll('#actions > button')].map((b) => b.getAttribute('onclick'))
    })
    expect(order[0]).toContain('second')
    expect(await pageClicks(web)).toEqual(['second'])
    expect(run.executed).toHaveLength(1)
    expect(run.result.status).toBe('passed')
  }, 90_000)

  it('cache path: a stored Okay never replays onto either', async () => {
    const cache = memoryCache()
    const instruction = 'Click the okay button'

    const live = await open(TWO_OKAY_PAGE)
    const livePlanner = scriptedPlanner([clickSecondOkay])
    const first = await runScriptedStep({
      adapter: live,
      instruction,
      planner: livePlanner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })
    expect(first.result.status).toBe('passed')
    expect(await pageClicks(live)).toEqual(['second'])
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])?.groundedLocator).toEqual([OKAY])

    const web = await open(TWO_OKAY_PAGE)
    const planner = scriptedPlanner([() => giveUp('the step does not say which Okay button')])
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
    expect(await pageClicks(live)).toEqual(['second'])
    expect(run.result.status).toBe('failed')
  }, 90_000)

  it('heal path: a replaced Okay is not provably either', async () => {
    const web = await open(ONE_OKAY_PAGE)
    const changing = changingBeforeDispatch(web, replaceWithTwoOkays)
    const planner = scriptedPlanner([
      (screen) => act(
        { type: 'click', ref: refFor(screen, 'button', 'Okay'), target: OKAY },
        true,
        'Click the Okay button',
      ),
      () => giveUp('the Okay button was replaced by two identical ones'),
    ])
    const run = await runScriptedStep({
      adapter: changing.adapter,
      instruction: 'Click the okay button',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(readBindingOutcomeMeta(changing.firstResult())?.outcome).toBe('binding-lost')
    expect(run.executed).toHaveLength(1)
    const [first] = run.result.evidence!.subActions
    expect(first.result.success).toBe(false)
    expect(readBindingOutcomeMeta(first.result)).toEqual({
      outcome: 'binding-lost',
      ref: (first.plannedAction as { ref?: string }).ref,
      inputSent: false,
      heal: 'not-unique',
    })
    expect(planner.calls).toBe(2)
    expect(await pageClicks(web)).toEqual([])
    expect(run.result.status).toBe('failed')
  }, 90_000)
})
