// C438-ROW-PARSE (438 D-02, Pitfall 1): a real Chromium ai-mode snapshot parsed by
// parseAriaSnapshot and built by buildScreenState carries each row's static text. The fold adds no
// element: only `row` lines become new elements. Pages are inline snippets.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildScreenState, judgeStatedTarget, rowTextOf } from '@vostride/agent-qa-runner'
import type { ElementInfo, ScreenState } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { parseAriaSnapshot } from '../observer.js'

const ADDRESSES_PAGE = `<!doctype html><html><body>
  <ul>
    <li>
      <p><strong>Work</strong></p>
      <p>7 Elm Street, Springfield</p>
      <button type="button">Edit label</button>
    </li>
    <li>
      <p><strong>Home</strong></p>
      <p>1 Home Street, Springfield</p>
      <button type="button">Edit label</button>
    </li>
    <li>
      <p><strong>Old</strong></p>
      <p>9 Oak Road, Springfield</p>
      <button type="button">Edit label</button>
    </li>
  </ul>
</body></html>`

const CART_PAGE = `<!doctype html><html><body>
  <table>
    <tr><th>Item</th><th>Price</th><th>Action</th></tr>
    <tr><td>Green mug</td><td>$9.00</td><td><button type="button">Remove</button></td></tr>
    <tr><td>Blue mug</td><td>$8.00</td><td><button type="button">Remove</button></td></tr>
  </table>
</body></html>`

const SIBLING_CONTAINER_SNAPSHOT = [
  '- list:',
  '  - listitem:',
  '    - text: 7 Elm Street',
  '    - button "Edit label"',
  '  - listitem:',
  '    - text: 12 Oak Avenue',
  '    - button "Edit label"',
  '- generic:',
  '  - generic:',
  '    - text: Promo 4111 1111',
  '    - button "Add address"',
].join('\n')

const SIBLING_CONTAINER_PAGE = `<!doctype html><html><body>
  <ul>
    <li>
      <p>7 Elm Street</p>
      <button type="button">Edit label</button>
    </li>
    <li>
      <p>12 Oak Avenue</p>
      <button type="button">Edit label</button>
    </li>
  </ul>
  <div role="group"><div>
    <span>Promo 4111 1111</span>
    <button type="button">Add address</button>
  </div></div>
</body></html>`

const IFRAME_AFTER_LIST_PAGE = `<!doctype html><html><body>
  <ul>
    <li>
      <p>7 Elm Street</p>
      <button type="button">Edit label</button>
    </li>
    <li>
      <p>9 Oak Road</p>
      <button type="button">Edit label</button>
    </li>
  </ul>
  <iframe srcdoc="<button>Inner A</button><button>Inner B</button>"></iframe>
</body></html>`

const ORDERS_PAGE = `<!doctype html><html><body>
  <nav aria-label="Main"><ul><li><a href="#">Orders</a></li></ul></nav>
  <main>
    <h1>Orders</h1>
    <button type="button">Export order history</button>
    <p>Total spent: $354.00</p>
    <table>
      <tr><th>Order</th><th>Date</th><th>Total</th></tr>
      <tr><td>1034</td><td>2026-06-05</td><td>$12.00</td></tr>
      <tr><td>1035</td><td>2026-06-06</td><td>$20.00</td></tr>
    </table>
  </main>
</body></html>`

const DROPPED_ROLES = ['paragraph', 'strong', 'text', 'generic', 'emphasis']

function named(state: ScreenState, role: string, name: string): ElementInfo[] {
  return state.elements.filter((element) => element.role === role && element.name === name)
}

function only(state: ScreenState, role: string, name: string): ElementInfo {
  const found = named(state, role, name)
  expect(found).toHaveLength(1)
  return found[0]
}

let adapter: WebPlatformAdapter | undefined

beforeAll(async () => {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
  adapter = created
}, 60_000)

afterAll(async () => {
  await adapter?.cleanup()
  adapter = undefined
}, 60_000)

async function snapshotOf(html: string): Promise<string> {
  const page = adapter!.getPage()!
  await page.setContent(html)
  return page.locator(':root').ariaSnapshot({ mode: 'ai' })
}

function build(snapshot: string): ScreenState {
  return buildScreenState({
    platform: 'web',
    nodes: parseAriaSnapshot(snapshot).nodes,
    viewport: { width: 1280, height: 720 },
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
    coordSpace: 'viewport',
    timestamp: 1700000000000,
  }).state
}

function rowLineCount(snapshot: string): number {
  return snapshot.split('\n').filter((line) => /^\s*-\s*row\b/.test(line)).length
}

function withoutRowLines(snapshot: string): string {
  return snapshot.replace(/^(\s*-\s*)row\b/gm, '$1rowgroup')
}

describe('C438-ROW-PARSE', () => {
  it('the address list yields three listitems carrying their row text', async () => {
    const state = build(await snapshotOf(ADDRESSES_PAGE))
    const items = state.elements.filter((element) => element.role === 'listitem')

    expect(items).toHaveLength(3)
    expect(items[0].text).toContain('Work')
    expect(items[0].text).toContain('7 Elm Street, Springfield')
    expect(items[1].text).toContain('Home')
    expect(items[1].text).toContain('1 Home Street, Springfield')
    expect(items[2].text).toContain('Old')
    expect(items[2].text).toContain('9 Oak Road, Springfield')
    expect(state.tree).toContain('text: "Work 7 Elm Street, Springfield"')
  }, 60_000)

  it("each Edit label's row text names its own address", async () => {
    const state = build(await snapshotOf(ADDRESSES_PAGE))
    const buttons = state.elements.filter((element) => element.name === 'Edit label')

    expect(buttons).toHaveLength(3)
    expect(rowTextOf(buttons[0], state.elements)).toContain('7 Elm Street')
    expect(rowTextOf(buttons[1], state.elements)).toContain('1 Home Street')
    expect(rowTextOf(buttons[2], state.elements)).toContain('9 Oak Road')
  }, 60_000)

  it("the cart table yields row elements and each Remove button's row names its mug", async () => {
    const state = build(await snapshotOf(CART_PAGE))
    const rows = state.elements.filter((element) => element.role === 'row')
    const removes = state.elements.filter(
      (element) => element.role === 'button' && element.name === 'Remove',
    )

    expect(rows).toHaveLength(3)
    expect(removes).toHaveLength(2)
    expect(rowTextOf(removes[0], state.elements)).toContain('Green mug')
    expect(rowTextOf(removes[0], state.elements)).not.toContain('Blue mug')
    expect(rowTextOf(removes[1], state.elements)).toContain('Blue mug')
    expect(rowTextOf(removes[1], state.elements)).not.toContain('Green mug')
  }, 60_000)

  it('no dropped line becomes an element', async () => {
    for (const html of [ADDRESSES_PAGE, CART_PAGE]) {
      const state = build(await snapshotOf(html))
      const roles = state.elements.map((element) => element.role)
      for (const dropped of DROPPED_ROLES) expect(roles).not.toContain(dropped)
    }
  }, 60_000)

  it('the element count is the count without the fold plus the row lines', async () => {
    for (const html of [ADDRESSES_PAGE, CART_PAGE]) {
      const snapshot = await snapshotOf(html)
      const withFold = parseAriaSnapshot(snapshot).nodes.length
      const withoutRows = parseAriaSnapshot(withoutRowLines(snapshot)).nodes.length
      expect(withFold).toBe(withoutRows + rowLineCount(snapshot))
    }
    expect(build(await snapshotOf(ADDRESSES_PAGE)).elements.map((element) => element.role)).toEqual(
      ['listitem', 'button', 'listitem', 'button', 'listitem', 'button'],
    )
    const cart = build(await snapshotOf(CART_PAGE)).elements.map((element) => element.role)
    expect(cart).toEqual([
      'row',
      'row', 'cell', 'cell', 'cell', 'button',
      'row', 'cell', 'cell', 'cell', 'button',
    ])
  }, 60_000)

  it("a later sibling container's text and controls never fold into the preceding row", () => {
    const state = build(SIBLING_CONTAINER_SNAPSHOT)
    const items = state.elements.filter((element) => element.role === 'listitem')
    const addAddress = only(state, 'button', 'Add address')

    expect(items).toHaveLength(2)
    expect(items[1].text).toBe('12 Oak Avenue')
    expect(addAddress.hierarchy?.parentRef).toBeUndefined()
    expect(rowTextOf(addAddress, state.elements)).toBeUndefined()
    expect(
      judgeStatedTarget(
        { role: 'button', name: 'Add address', row: 'Oak Avenue' },
        addAddress,
        state.elements,
      ),
    ).toEqual({ verdict: 'agrees', rowStated: true, rowKnown: false })
  })

  it('in real Chromium a control after the list has no row and the last row keeps only its own text', async () => {
    const snapshot = await snapshotOf(SIBLING_CONTAINER_PAGE)
    expect(snapshot).toMatch(/^\s*-\s*group\b/m)
    const state = build(snapshot)
    const items = state.elements.filter((element) => element.role === 'listitem')
    const addAddress = only(state, 'button', 'Add address')

    expect(items).toHaveLength(2)
    expect(items[1].text).toBe('12 Oak Avenue')
    expect(addAddress.hierarchy?.parentRef).toBeUndefined()
    expect(rowTextOf(addAddress, state.elements)).toBeUndefined()
    expect(
      judgeStatedTarget(
        { role: 'button', name: 'Add address', row: 'Oak Avenue' },
        addAddress,
        state.elements,
      ),
    ).toEqual({ verdict: 'agrees', rowStated: true, rowKnown: false })
  }, 60_000)

  it("a stated row with a sibling container's words is refused on the last row's button", async () => {
    const state = build(await snapshotOf(SIBLING_CONTAINER_PAGE))
    const editLabels = named(state, 'button', 'Edit label')

    expect(editLabels).toHaveLength(2)
    const judgement = judgeStatedTarget(
      { role: 'button', name: 'Edit label', row: 'Promo' },
      editLabels[1],
      state.elements,
    )
    expect(judgement.verdict).toBe('contradicts')
    expect(judgement.verdict === 'contradicts' ? judgement.reasons : []).toEqual(['row'])
  }, 60_000)

  it('an iframe after a list is parented under no row', async () => {
    const page = adapter!.getPage()!
    await page.setContent(IFRAME_AFTER_LIST_PAGE)
    await page.frameLocator('iframe').getByRole('button', { name: 'Inner B' }).waitFor()
    const state = build(await page.locator(':root').ariaSnapshot({ mode: 'ai' }))
    const innerA = only(state, 'button', 'Inner A')
    const innerB = only(state, 'button', 'Inner B')
    const editLabels = named(state, 'button', 'Edit label')

    expect(rowTextOf(innerA, state.elements)).toBeUndefined()
    expect(rowTextOf(innerB, state.elements)).toBeUndefined()
    expect(editLabels).toHaveLength(2)
    const lastRow = rowTextOf(editLabels[1], state.elements)
    expect(lastRow).toContain('9 Oak Road')
    expect(lastRow).not.toContain('Inner A')
    expect(lastRow).not.toContain('Inner B')
  }, 60_000)

  it('a table after a heading, a button and a navigation is parented under none of them', async () => {
    const state = build(await snapshotOf(ORDERS_PAGE))
    const navigation = only(state, 'navigation', 'Main')
    const exportButton = only(state, 'button', 'Export order history')
    const heading = only(state, 'heading', 'Orders')
    const rows = state.elements.filter((element) => element.role === 'row')

    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.hierarchy?.parentRef).not.toBe(exportButton.ref)
      expect(row.hierarchy?.parentRef).not.toBe(navigation.ref)
    }
    expect(heading.hierarchy?.parentRef).not.toBe(navigation.ref)
    expect(navigation.text ?? '').not.toContain('Total spent')
  }, 60_000)
})
