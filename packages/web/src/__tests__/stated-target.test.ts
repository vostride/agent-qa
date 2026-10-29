import { afterEach, describe, expect, it } from 'vitest'
import type { Action, ExecuteOptions, PlannerConfig } from '@vostride/agent-qa-runner'
import { WebPlatformAdapter } from '../adapter.js'
import {
  act,
  giveUp,
  refFor,
  runScriptedStep,
  scriptedPlanner,
  scriptedVerifier,
} from './fixtures/scripted-loop.js'
import type { ScriptedStepRun } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const EVENT_LOG = `<script>
  window.__events = []
  for (const el of document.querySelectorAll('button, input, a')) {
    for (const type of ['click', 'focus']) {
      el.addEventListener(type, () => window.__events.push({ id: el.id, type }))
    }
  }
</script>`

const SUBMIT_PAGE = `<!doctype html><html><body>
  <form onsubmit="return false">
    <input id="field" type="text">
    <button id="submit" type="button">Submit</button>
  </form>
  ${EVENT_LOG}
</body></html>`

const INVOICES_PAGE = `<!doctype html><html><body>
  <ul>
    <li><a id="inv946" href="#invoice-946">Invoice 946</a></li>
    <li><a id="inv947" href="#invoice-947">Invoice 947</a></li>
  </ul>
  ${EVENT_LOG}
</body></html>`

const SIGN_IN_PAGE = `<!doctype html><html><body>
  <button id="signin" type="button">Sign in</button>
  ${EVENT_LOG}
</body></html>`

const PAY_PAGE = `<!doctype html><html><body>
  <button id="pay" type="button">Pay $1,234.50</button>
  ${EVENT_LOG}
</body></html>`

const GROUPED_PAGE = `<!doctype html><html><body>
  <button id="grouped" type="button">1,234</button>
  ${EVENT_LOG}
</body></html>`

const GROUPED_ROWS_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul>
    <li>
      <p>Invoice 1,234 due 2026-11-01</p>
      <button type="button" onclick="window.__clicks.push('1,234')">Open</button>
    </li>
    <li>
      <p>Invoice 1,235 due 2026-11-02</p>
      <button type="button" onclick="window.__clicks.push('1,235')">Open</button>
    </li>
  </ul>
</body></html>`

const ADDRESSES_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul>
    <li>
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

const CLICKABLE_ROWS_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul>
    <li onclick="window.__clicks.push('7 Elm Street, Springfield')">
      <p><strong>Work</strong></p>
      <p>7 Elm Street, Springfield</p>
    </li>
    <li onclick="window.__clicks.push('1 Home Street, Springfield')">
      <p><strong>Home</strong></p>
      <p>1 Home Street, Springfield</p>
    </li>
    <li onclick="window.__clicks.push('9 Oak Road, Springfield')">
      <p><strong>Old</strong></p>
      <p>9 Oak Road, Springfield</p>
    </li>
  </ul>
</body></html>`

const NESTED_TREE_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <ul role="tree" aria-label="Years">
    <li role="treeitem" aria-label="2024" aria-expanded="true">
      <ul role="group">
        <li role="treeitem" onclick="window.__clicks.push('2024 Invoices')">Invoices</li>
      </ul>
    </li>
    <li role="treeitem" aria-label="2025" aria-expanded="true">
      <ul role="group">
        <li role="treeitem" onclick="window.__clicks.push('2025 Invoices')">Invoices</li>
      </ul>
    </li>
  </ul>
</body></html>`

const LONE_EDIT_PAGE = `<!doctype html><html><head><script>window.__clicks = []</script></head><body>
  <button type="button" onclick="window.__clicks.push('lone')">Edit label</button>
</body></html>`

const HOME_ROW_BODY = `<ul>
    <li>
      <p><strong>Home</strong></p>
      <p>1 Home Street, Springfield</p>
      <button type="button" onclick="window.__clicks.push('1 Home Street, Springfield')">Edit label</button>
    </li>
  </ul>`

// Replaces the page body once, right before the first dispatch reaches the adapter.
function replacingBodyBeforeDispatch(web: WebPlatformAdapter, body: string): WebPlatformAdapter {
  let replaced = false
  return new Proxy(web, {
    get(target, property) {
      if (property === 'execute') {
        return async (action: Action, options?: ExecuteOptions) => {
          if (!replaced) {
            replaced = true
            await target.getPage()!.evaluate((html) => {
              const doc = (globalThis as unknown as { document: { body: { innerHTML: string } } })
                .document
              doc.body.innerHTML = html
            }, body)
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

interface PageEvent {
  id: string
  type: string
}

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

async function events(web: WebPlatformAdapter): Promise<PageEvent[]> {
  return web.getPage()!.evaluate(() => (globalThis as unknown as { __events: PageEvent[] }).__events)
}

async function addressClicks(web: WebPlatformAdapter): Promise<string[]> {
  return web.getPage()!.evaluate(() => (globalThis as unknown as { __clicks: string[] }).__clicks)
}

function clicks(log: readonly PageEvent[]): PageEvent[] {
  return log.filter((entry) => entry.type === 'click')
}

function refusalOf(run: ScriptedStepRun): Record<string, unknown> | undefined {
  const first = run.result.evidence!.subActions[0]
  return first.result.metadata?.['targetRefusal'] as Record<string, unknown> | undefined
}

const passes = scriptedVerifier(() => ({ pass: true, reason: 'the click landed' }))

describe('a stated target is checked against its ref', () => {
  it('a stated target that agrees with its ref is clicked', async () => {
    const web = await open(SUBMIT_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Submit'),
          target: { role: 'button', name: 'Submit' },
        },
        true,
        'Submit the form',
      ),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Click Submit',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(clicks(await events(web))).toEqual([{ id: 'submit', type: 'click' }])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it('the MiniWoB shape is refused: Submit stated, an empty textbox ref', async () => {
    const web = await open(SUBMIT_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'textbox', ''),
          target: { role: 'button', name: 'Submit' },
        },
        true,
        'Submit the form',
      ),
      () => giveUp('The Submit button could not be clicked'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Click Submit',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.executed).toHaveLength(0)
    expect(await events(web)).toEqual([])
    const first = run.result.evidence!.subActions[0]
    expect(first.result.success).toBe(false)
    expect(first.result.error).toMatch(/^target-mismatch: /)
    const refusal = refusalOf(run)
    expect(refusal).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      path: 'live',
      stated: { role: 'button', name: 'Submit' },
      observed: { role: 'textbox', name: '' },
      inputSent: false,
    })
    expect(refusal?.['reasons']).toContain('role-kind')
    expect(planner.calls).toBe(2)
  }, 60_000)

  it('"Invoice 947" stated against "Invoice 946" is refused', async () => {
    const web = await open(INVOICES_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'link', 'Invoice 946'),
          target: { role: 'link', name: 'Invoice 947' },
        },
        true,
        'Open invoice 947',
      ),
      () => giveUp('Invoice 947 could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open invoice 947',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.executed).toHaveLength(0)
    expect(clicks(await events(web))).toEqual([])
    const refusal = refusalOf(run)
    expect(refusal).toMatchObject({
      kind: 'target-mismatch',
      stated: { role: 'link', name: 'Invoice 947' },
      observed: { role: 'link', name: 'Invoice 946' },
      inputSent: false,
    })
    expect(refusal?.['reasons']).toContain('name-number')
  }, 60_000)

  it('"Pay $1234.50" stated against "Pay $1,234.50" is clicked', async () => {
    const web = await open(PAY_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Pay $1,234.50'),
          target: { role: 'button', name: 'Pay $1234.50' },
        },
        true,
        'Pay $1234.50',
      ),
      () => giveUp('The payment could not be made'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Pay $1234.50',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(clicks(await events(web))).toEqual([{ id: 'pay', type: 'click' }])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it('"1234" stated against "1,234" is clicked', async () => {
    const web = await open(GROUPED_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', '1,234'),
          target: { role: 'button', name: '1234' },
        },
        true,
        'Pick 1234',
      ),
      () => giveUp('1234 could not be picked'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Pick 1234',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(refusalOf(run)).toBeUndefined()
    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(clicks(await events(web))).toEqual([{ id: 'grouped', type: 'click' }])
  }, 60_000)

  it('a paraphrase is not a contradiction', async () => {
    const web = await open(SIGN_IN_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Sign in'),
          target: { role: 'button', name: 'Log in' },
        },
        true,
        'Log in',
      ),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Log in',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(clicks(await events(web))).toEqual([{ id: 'signin', type: 'click' }])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it('a ref-only action is dispatched as before', async () => {
    const web = await open(SUBMIT_PAGE)
    const planner = scriptedPlanner([
      (screen) =>
        act({ type: 'click', ref: refFor(screen, 'button', 'Submit') }, true, 'Submit the form'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Click Submit',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(clicks(await events(web))).toEqual([{ id: 'submit', type: 'click' }])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it('a contradiction on the heal path is refused naming both identities', async () => {
    const web = await open(LONE_EDIT_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        {
          type: 'click',
          ref: refFor(screen, 'button', 'Edit label'),
          target: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
        },
        true,
        'Edit the Elm Street label',
      ),
      () => giveUp('The Elm Street label could not be edited'),
    ])
    const run = await runScriptedStep({
      adapter: replacingBodyBeforeDispatch(web, HOME_ROW_BODY),
      instruction: 'Edit the label of the 7 Elm Street address',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(await addressClicks(web)).toEqual([])
    expect(run.executed).toHaveLength(1)
    const first = run.result.evidence!.subActions[0]
    expect(first.result.success).toBe(false)
    expect(first.result.error).toMatch(/^target-mismatch: /)
    expect(first.result.error).toContain('"7 Elm Street"')
    expect(first.result.error).toContain('1 Home Street')
    const refusal = refusalOf(run)
    expect(refusal).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      path: 'heal',
      stated: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      observed: { role: 'button', name: 'Edit label' },
      reasons: ['row'],
      rowStated: true,
      inputSent: false,
    })
    const observed = refusal?.['observed'] as { row?: string } | undefined
    expect(observed?.row).toContain('1 Home Street')
    const attempts = first.grounding?.attempts ?? []
    expect(attempts.at(-1)).toMatchObject({ stage: 'tree-search', outcome: 'resolved' })
    expect(run.result.evidence?.limitUsage?.actionsUsed).toBe(1)
    expect(planner.calls).toBe(2)
  }, 60_000)
})

describe('a stated row is checked against the ref\'s row', () => {
  async function runEditLabel(
    nth: number,
    target: { role: string; name: string; row?: string },
    fallback = true,
  ) {
    const web = await open(ADDRESSES_PAGE)
    const planner = scriptedPlanner([
      (screen) => act(
        { type: 'click', ref: refFor(screen, 'button', 'Edit label', nth), target },
        true,
        'Edit the address label',
      ),
      ...(fallback ? [() => giveUp('The address label could not be edited')] : []),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Edit the label of the 7 Elm Street address',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })
    return { web, run }
  }

  it("the stated row agrees: Elm's Edit label is clicked", async () => {
    const { web, run } = await runEditLabel(0, {
      role: 'button',
      name: 'Edit label',
      row: '7 Elm Street',
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['7 Elm Street, Springfield'])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it("a stated row that is not the ref's row is refused naming both rows", async () => {
    const { web, run } = await runEditLabel(1, {
      role: 'button',
      name: 'Edit label',
      row: '7 Elm Street',
    })

    expect(run.executed).toHaveLength(0)
    expect(await addressClicks(web)).toEqual([])
    const first = run.result.evidence!.subActions[0]
    expect(first.result.success).toBe(false)
    expect(first.result.error).toMatch(/^target-mismatch: /)
    const refusal = refusalOf(run)
    expect(refusal).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      stated: { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      observed: { role: 'button', name: 'Edit label' },
      reasons: ['row'],
      rowStated: true,
      inputSent: false,
    })
    const observed = refusal?.['observed'] as { row?: string } | undefined
    expect(observed?.row).toContain('1 Home Street')
  }, 60_000)

  it('row words left out are not a contradiction', async () => {
    const { web, run } = await runEditLabel(1, { role: 'button', name: 'Edit label' }, false)

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['1 Home Street, Springfield'])
    expect(refusalOf(run)).toBeUndefined()
    const grounding = run.result.evidence!.subActions[0].grounding
    expect(grounding?.stated).toEqual({ role: 'button', name: 'Edit label' })
    expect(grounding?.stated).not.toHaveProperty('row')
  }, 60_000)

  it('an abbreviated row still agrees', async () => {
    const { web, run } = await runEditLabel(0, { role: 'button', name: 'Edit label', row: 'Elm St' })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['7 Elm Street, Springfield'])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  async function runRowClick(target: { role: string; name: string; row?: string }) {
    const web = await open(CLICKABLE_ROWS_PAGE)
    const planner = scriptedPlanner([
      (screen) => {
        const row = screen.elements.find(
          (element) => element.role === 'listitem' && element.text?.includes('1 Home Street'),
        )
        if (row === undefined) throw new Error('no listitem with the text 1 Home Street')
        return act({ type: 'click', ref: row.ref, target }, true, 'Open the address')
      },
      () => giveUp('The address could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open the 7 Elm Street address',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })
    return { web, run }
  }

  it("a listitem ref stated with another row's words is refused", async () => {
    const { web, run } = await runRowClick({
      role: 'listitem',
      name: 'Address',
      row: '7 Elm Street',
    })

    expect(run.executed).toHaveLength(0)
    expect(await addressClicks(web)).toEqual([])
    expect(refusalOf(run)).toMatchObject({
      kind: 'target-mismatch',
      lane: 'ref',
      path: 'live',
      reasons: ['row'],
      inputSent: false,
    })
  }, 60_000)

  it('a listitem ref stated with its own row words is clicked', async () => {
    const { web, run } = await runRowClick({
      role: 'listitem',
      name: 'Address',
      row: '1 Home Street',
    })

    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['1 Home Street, Springfield'])
    expect(refusalOf(run)).toBeUndefined()
  }, 60_000)

  it('a nested treeitem stated with its parent row is clicked', async () => {
    const web = await open(NESTED_TREE_PAGE)
    const planner = scriptedPlanner([
      (screen) => {
        const parent = screen.elements.find(
          (element) => element.role === 'treeitem' && element.name === '2025',
        )
        const item = screen.elements.find(
          (element) =>
            element.role === 'treeitem'
            && element.name === 'Invoices'
            && parent !== undefined
            && element.hierarchy?.parentRef === parent.ref,
        )
        if (item === undefined) throw new Error('no treeitem "Invoices" under treeitem "2025"')
        return act(
          {
            type: 'click',
            ref: item.ref,
            target: { role: 'treeitem', name: 'Invoices', row: '2025' },
          },
          true,
          'Open the 2025 invoices',
        )
      },
      () => giveUp('The 2025 invoices could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open the invoices of 2025',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(refusalOf(run)).toBeUndefined()
    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['2025 Invoices'])
  }, 60_000)

  it('a row stated "Invoice 1234" against "Invoice 1,234" is clicked', async () => {
    const web = await open(GROUPED_ROWS_PAGE)
    const planner = scriptedPlanner([
      (screen) => {
        const row = screen.elements.find(
          (element) => element.role === 'listitem' && element.text?.includes('Invoice 1,234'),
        )
        const button = screen.elements.find(
          (element) =>
            element.role === 'button'
            && element.name === 'Open'
            && row !== undefined
            && element.hierarchy?.parentRef === row.ref,
        )
        if (button === undefined) throw new Error('no button "Open" in the Invoice 1,234 row')
        return act(
          {
            type: 'click',
            ref: button.ref,
            target: { role: 'button', name: 'Open', row: 'Invoice 1234' },
          },
          true,
          'Open invoice 1234',
        )
      },
      () => giveUp('Invoice 1234 could not be opened'),
    ])
    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Open invoice 1234',
      planner,
      verifier: passes,
      plannerConfig: LIMITS,
    })

    expect(refusalOf(run)).toBeUndefined()
    expect(run.result.status).toBe('passed')
    expect(run.executed).toHaveLength(1)
    expect(await addressClicks(web)).toEqual(['1,234'])
  }, 60_000)
})
