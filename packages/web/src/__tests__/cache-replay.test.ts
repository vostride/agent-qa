// C438-STRICT-REPLAY (438 D-10, D-11, SC3): a cached target replays only onto the one current
// element with its role and exact name. 'Invoice 947' and 'Invoice 946' share a cache key (both
// normalize to 'invoice'), so the second run is a key hit; the stored name decides whether it
// replays. Real headless Chromium through the real runner loop; pages are inline snippets.
// 438-09 (D-11): a key hit that does not replay is a recorded miss with its typed reason.

import { afterEach, describe, expect, it } from 'vitest'
import type { PlannerConfig } from '@vostride/agent-qa-runner'
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
import type { MemoryCache } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const INSTRUCTION = 'Open invoice 947'

function invoicesPage(numbers: readonly number[]): string {
  const links = numbers
    .map((n) => `<div>
      <a href="#" onclick="window.__clicks.push(this.textContent); return false">Invoice ${String(n)}</a>
    </div>`)
    .join('\n    ')
  return `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
    ${links}
</body></html>`
}

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

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the invoice opened' }))

// Run 1: a live planner clicks 'Invoice 947', stating the link it means, and the cache stores it.
async function storeInvoice947(cache: MemoryCache, numbers: readonly number[]) {
  const web = await open(invoicesPage(numbers))
  const planner = scriptedPlanner([
    (screen) => act(
      {
        type: 'click',
        ref: refFor(screen, 'link', 'Invoice 947'),
        target: { role: 'link', name: 'Invoice 947' },
      },
      true,
      'Open invoice 947',
    ),
  ])
  const run = await runScriptedStep({
    adapter: web,
    instruction: INSTRUCTION,
    planner,
    verifier: passes,
    cache,
    plannerConfig: LIMITS,
  })
  return { run, planner, clicks: await pageClicks(web) }
}

// Run 2: the same instruction on a page with the same cache key; the planner only gives up.
async function replay(cache: MemoryCache, numbers: readonly number[]) {
  const web = await open(invoicesPage(numbers))
  const planner = scriptedPlanner([() => giveUp('invoice 947 is not on the page')])
  const run = await runScriptedStep({
    adapter: web,
    instruction: INSTRUCTION,
    planner,
    verifier: passes,
    cache,
    plannerConfig: LIMITS,
  })
  return { run, planner, clicks: await pageClicks(web) }
}

describe('C438-STRICT-REPLAY', () => {
  it('947 stored, replayed against 946 alone, is a miss', async () => {
    const cache = memoryCache()
    const first = await storeInvoice947(cache, [947])
    expect(first.clicks).toEqual(['Invoice 947'])
    expect(first.run.result.status).toBe('passed')
    expect(cache.sets).toHaveLength(1)
    expect(cache.store.get(cache.sets[0])?.groundedLocator).toEqual([
      { role: 'link', name: 'Invoice 947' },
    ])

    const second = await replay(cache, [946])
    expect(cache.gets).toEqual([
      { key: cache.sets[0], hit: false },
      { key: cache.sets[0], hit: true },
    ])
    expect(cache.gets.at(-1)!.hit).toBe(true)
    expect(second.run.executed).toEqual([])
    expect(second.planner.calls).toBe(1)
    expect(second.clicks).toEqual([])
    expect(second.clicks).not.toContain('Invoice 946')
    expect(cache.store.size).toBe(0)
    expect(second.run.result.status).toBe('failed')
  }, 90_000)

  it('947 stored, replayed against both, clicks 947 wherever it sits', async () => {
    const cache = memoryCache()
    const first = await storeInvoice947(cache, [947, 946])
    expect(first.clicks).toEqual(['Invoice 947'])
    expect(cache.store.get(cache.sets[0])?.groundedLocator).toEqual([
      { role: 'link', name: 'Invoice 947' },
    ])

    const second = await replay(cache, [946, 947])
    expect(cache.gets.at(-1)).toEqual({ key: cache.sets[0], hit: true })
    expect(second.planner.calls).toBe(0)
    expect(second.clicks).toEqual(['Invoice 947'])
    expect(second.run.result.evidence?.cacheStatus).toBe('hit')
    expect(second.run.result.status).toBe('passed')
  }, 90_000)

  it('the 946 miss is recorded with its reason', async () => {
    const missCache = memoryCache()
    await storeInvoice947(missCache, [947])
    const miss = await replay(missCache, [946])
    expect(missCache.gets.at(-1)).toEqual({ key: missCache.sets[0], hit: true })
    expect(miss.run.result.evidence?.cacheStatus).toBe('miss')
    expect(miss.run.result.evidence?.cacheMiss).toEqual({ reason: 'strict-absent' })

    const hitCache = memoryCache()
    await storeInvoice947(hitCache, [947, 946])
    const hit = await replay(hitCache, [946, 947])
    expect(hitCache.gets.at(-1)).toEqual({ key: hitCache.sets[0], hit: true })
    expect(hit.clicks).toEqual(['Invoice 947'])
    expect(hit.run.result.evidence?.cacheStatus).toBe('hit')
    expect(hit.run.result.evidence).not.toHaveProperty('cacheMiss')
  }, 120_000)
})
