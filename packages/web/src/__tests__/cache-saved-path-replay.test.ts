// An address step saved on real headless Chromium replays from the cache on an unchanged page.
// The page is an inline snippet; no model is called.

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

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const INSTRUCTION = 'Enter the delivery address and continue to the delivery options'

const REPORT_TEXT = 'Delivery options are shown'

const ADDRESS_PAGE = `<!doctype html><html><body>
  <main id="checkout">
    <form id="address" onsubmit="return false">
      <label>Street address <input type="text" name="street"></label>
      <label>City <input type="text" name="city"></label>
      <label>Postal code <input type="text" name="postal"></label>
      <button type="button" onclick="showDelivery()">Continue to delivery</button>
    </form>
  </main>
  <script>
    function showDelivery() {
      document.getElementById('checkout').innerHTML = '<h1>Delivery options</h1>'
        + '<label><input type="radio" name="speed" value="standard"> Standard delivery</label>'
        + '<label><input type="radio" name="speed" value="express"> Express delivery</label>'
    }
  </script>
</body></html>`

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

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the delivery options are shown' }))

function fill(name: string, text: string) {
  return (screen: Parameters<typeof refFor>[0]) =>
    act(
      {
        type: 'fill',
        ref: refFor(screen, 'textbox', name),
        text,
        clearMode: 'replace',
        submit: false,
      },
      false,
      `Enter the ${name.toLowerCase()}`,
    )
}

describe('a saved address step on real Chromium', () => {
  it('a step saved with a closing report it does not need replays on an unchanged page with no planner call', async () => {
    const cache = memoryCache()
    const first = await runScriptedStep({
      adapter: await open(ADDRESS_PAGE),
      instruction: INSTRUCTION,
      planner: scriptedPlanner([
        fill('Street address', '12 Harbour Road'),
        fill('City', 'Portsmouth'),
        fill('Postal code', 'PO1 3AX'),
        (screen) =>
          act(
            { type: 'click', ref: refFor(screen, 'button', 'Continue to delivery') },
            false,
            'Continue to delivery',
          ),
        () => act({ type: 'reportValue', value: REPORT_TEXT }, true, 'Report the delivery page'),
      ]),
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })

    expect(first.result.status).toBe('passed')
    expect(cache.sets).toHaveLength(4)
    expect(cache.sets.map((key) => cache.store.get(key)!.completesStep)).toEqual([
      false,
      false,
      false,
      true,
    ])

    cache.gets.length = 0
    cache.sets.length = 0
    const planner = scriptedPlanner([() => giveUp('no live turn expected')])
    const second = await runScriptedStep({
      adapter: await open(ADDRESS_PAGE),
      instruction: INSTRUCTION,
      planner,
      verifier: passes,
      cache,
      plannerConfig: LIMITS,
    })

    expect(second.result.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets).toHaveLength(4)
    expect(cache.gets.every((get) => get.hit)).toBe(true)
    expect(second.result.evidence!.cacheStatus).toBe('hit')
    expect(second.result.evidence!.reportedValue).toBeUndefined()
    expect(second.executed.map((action) => action.type)).toEqual(['fill', 'fill', 'fill', 'click'])
    const stored = JSON.stringify([...cache.store.values()])
    expect(stored).not.toContain('reportValue')
    expect(stored).not.toContain(REPORT_TEXT)
  }, 90_000)
})
