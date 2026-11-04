import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { InterimNode } from '@vostride/agent-qa-runner'
import { snapshotRoot } from '../binding.js'
import { enrichWebNodes, parseAriaSnapshot } from '../observer.js'

const CHECKOUT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body{margin:0} .at{position:absolute;margin:0;box-sizing:border-box;font-size:14px}
</style></head><body>
  <h1 class="at" style="left:0;top:0;width:300px;height:40px">Checkout</h1>
  <button type="button" class="at" data-testid="pay" style="left:10px;top:60px;width:120px;height:40px">Pay</button>
  <button type="button" class="at" disabled style="left:140px;top:60px;width:120px;height:40px">Refund</button>
  <input class="at" aria-label="Coupon" placeholder="Code" style="left:10px;top:110px;width:200px;height:30px">
  <input class="at" type="range" aria-label="Tip" min="0" max="20" value="5" style="left:10px;top:150px;width:200px;height:20px">
  <a class="at" href="#help" title="Help page" style="left:10px;top:180px;width:80px;height:20px">Help</a>
  <div id="toast" class="at" role="dialog" aria-label="Added to bag" style="left:10px;top:210px;width:200px;height:50px">Added</div>
</body></html>`

let browser: Browser
let context: BrowserContext | undefined

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
}, 60_000)

afterEach(async () => {
  await context?.close()
  context = undefined
})

async function observed(): Promise<{
  tab: Page
  nodes: InterimNode[]
  nativeRefs: (string | undefined)[]
}> {
  context = await browser.newContext({ viewport: { width: 800, height: 600 } })
  const tab = await context.newPage()
  await tab.setContent(CHECKOUT)
  const { nodes, nativeRefs } = parseAriaSnapshot(await snapshotRoot(tab))
  return { tab, nodes, nativeRefs }
}

describe('enrichWebNodes on a live page', () => {
  it('gives every node of a page whose refs all resolve its element box, state and labels', async () => {
    const { tab, nodes, nativeRefs } = await observed()

    await enrichWebNodes(tab, nodes, nativeRefs)

    expect(nodes).toEqual([
      {
        role: 'heading',
        name: 'Checkout',
        attributes: { level: '1' },
        bounds: { x: 0, y: 0, width: 300, height: 40 },
        state: { enabled: true, focused: false, visible: true },
      },
      {
        role: 'button',
        name: 'Pay',
        bounds: { x: 10, y: 60, width: 120, height: 40 },
        state: { enabled: true, focused: false, visible: true },
        labels: { testId: 'pay' },
      },
      {
        role: 'button',
        name: 'Refund',
        attributes: { disabled: 'true' },
        bounds: { x: 140, y: 60, width: 120, height: 40 },
        state: { enabled: false, focused: false, visible: true },
      },
      {
        role: 'textbox',
        name: 'Coupon',
        bounds: { x: 10, y: 110, width: 200, height: 30 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Coupon', placeholder: 'Code' },
      },
      {
        role: 'slider',
        name: 'Tip',
        attributes: { valuenow: '5', valuemin: '0', valuemax: '20' },
        bounds: { x: 10, y: 150, width: 200, height: 20 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Tip' },
      },
      {
        role: 'link',
        name: 'Help',
        attributes: { cursor: 'pointer' },
        bounds: { x: 10, y: 180, width: 80, height: 20 },
        state: { enabled: true, focused: false, visible: true },
        labels: { title: 'Help page' },
      },
      {
        role: 'dialog',
        name: 'Added to bag',
        text: 'Added',
        bounds: { x: 10, y: 210, width: 200, height: 50 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Added to bag' },
      },
    ])
  })

  it('enriches the rest without waiting when an element left the page after the snapshot', async () => {
    const { tab, nodes, nativeRefs } = await observed()
    await tab.evaluate("document.getElementById('toast').remove()")
    // A lookup that waited for the element would never return.
    tab.setDefaultTimeout(0)

    await enrichWebNodes(tab, nodes, nativeRefs)

    expect(nodes.find(node => node.role === 'dialog')).toEqual({
      role: 'dialog',
      name: 'Added to bag',
      text: 'Added',
    })
    expect(nodes.find(node => node.name === 'Pay')).toMatchObject({
      bounds: { x: 10, y: 60, width: 120, height: 40 },
      labels: { testId: 'pay' },
    })
  })
})
