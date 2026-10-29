// C439-AUTO12 (439 D-16, D-18, SC2): the runner's own checks in real headless Chromium through the
// real loop. A dialog left open, a control short of the limit the screen reports, a narrowed
// re-check standing in for a failed one, and an app's own "Saved" claim each fail to prove their
// condition, while each twin passes. The verifier is written inline and returns the per-condition
// shape; pages are inline snippets, and the persistence pair is served by a loopback server here.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ConditionJudgment,
  DialogAccount,
  PlannerConfig,
  VerificationResult,
  Verifier,
  VerifyResult,
} from '@vostride/agent-qa-runner'
import type { CitationSource, ScreenState } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, refFor, runScriptedStep, scriptedPlanner } from './fixtures/scripted-loop.js'
import type { ScriptedTurn } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const SAVE_STEP = 'Click Save'

const DIALOG_PAGE = (onSave: string) => `<!doctype html><html><body><main>
  <h2 id="status">Draft</h2>
  <button type="button" onclick="document.getElementById('status').textContent = 'Saved'; ${onSave}">Save</button>
  <dialog id="unsaved" aria-label="Unsaved changes"><p>Discard?</p><button type="button">Discard</button></dialog>
</main></body></html>`
const DIALOG_LEFT_OPEN = DIALOG_PAGE("document.getElementById('unsaved').showModal()")
const DIALOG_CLOSED = DIALOG_PAGE(
  "const d = document.getElementById('unsaved'); d.showModal(); d.close()",
)
const COOKIE_PAGE = `<!doctype html><html><body><main>
  <h2 id="status">Draft</h2>
  <button type="button" onclick="document.getElementById('status').textContent = 'Saved'">Save</button>
</main>
<div role="dialog" aria-label="Cookies"><p>We use cookies</p></div>
</body></html>`

const BRIGHTNESS_STEP = 'Set the brightness to its maximum'
const SLIDER_PAGE = (value: number) => `<!doctype html><html><body><main>
  <div role="slider" aria-label="Brightness" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="65535" tabindex="0">${value}</div>
</main></body></html>`
const VOLUME_STEP = 'Set the volume to its maximum'
const NUMBER_PAGE = `<!doctype html><html><body><main>
  <input type="number" aria-label="Volume" value="50">
</main></body></html>`

const ORDER_STEP = 'Verify the order row reads ORD-1001,42.50'
const ORDER_QUOTE = 'the order row reads ORD-1001,42.50'
const ORDER_PAGE = (row: string) => `<!doctype html><html><body><main>
  <h2>Orders</h2><div id="row">${row}</div>
</main></body></html>`
const ROW_EXPR = "document.getElementById('row').textContent"

const DEALS_STEP = 'Turn on deals emails and verify the setting is saved'

interface SettingsServer {
  url: string
  close(): Promise<void>
}

/** A settings page whose Save says "Saved"; only a working server keeps the setting. */
async function settingsServer(mode: 'working' | 'dead'): Promise<SettingsServer> {
  let deals = false
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/save') {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        if (mode === 'working') deals = body === 'on'
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><html><body><main>
  <h1>Settings</h1>
  <h2>Deals emails: ${deals ? 'on' : 'off'}</h2>
  <input type="checkbox" role="switch" id="deals" aria-label="Deals emails" ${deals ? 'checked' : ''}>
  <button type="button" onclick="save()">Save</button>
  <h3 id="status"></h3>
</main>
<script>
  async function save() {
    const on = document.getElementById('deals').checked ? 'on' : 'off'
    await fetch('/save', { method: 'POST', body: on })
    document.getElementById('status').textContent = 'Saved'
  }
</script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://localhost:${String(port)}/settings`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let adapter: WebPlatformAdapter | undefined
let settings: SettingsServer | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  await settings?.close()
  settings = undefined
}, 60_000)

async function open(html: string): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.setContent(html)
  return created
}

function condition(
  quote: string,
  citations: { source: CitationSource; quote: string }[],
  overrides: Partial<ConditionJudgment> = {},
): ConditionJudgment {
  return {
    quote,
    verdict: 'met',
    needs: 'none',
    controlRef: '',
    file: { name: '', match: 'none', text: '' },
    citations,
    reasoning: 'The record shows it',
    ...overrides,
  }
}

interface JudgingVerifier extends Verifier {
  readonly calls: number
}

/** A verifier whose per-condition output is computed from the settled final screen it is given. */
function judgingVerifier(judge: (after: ScreenState) => VerificationResult): JudgingVerifier {
  let calls = 0
  return {
    get calls() { return calls },
    async verify(_step, _before, after): Promise<VerifyResult> {
      calls++
      return { verification: judge(after) }
    },
  }
}

function verification(conditions: ConditionJudgment[], dialogs: DialogAccount[] = []): VerificationResult {
  return { conditions, dialogs, isAppError: false, reasoning: 'overall' }
}

const saveMet = (dialogs: DialogAccount[] = []) =>
  judgingVerifier(() => verification([condition(SAVE_STEP, [{ source: 'action', quote: '→ success' }])], dialogs))

const clickSave: ScriptedTurn = (screen) =>
  act({ type: 'click', ref: refFor(screen, 'button', 'Save') }, true, 'Saved the draft')

function thenGiveUp(first: ScriptedTurn, seen: { failureContext?: string }): ScriptedTurn[] {
  return [
    first,
    (_screen, context) => {
      seen.failureContext = context.failureContext
      return giveUp('The step could not be proven')
    },
  ]
}

/** "Turn on deals emails" met on the click; "the setting is saved" judged from the final screen. */
function dealsVerifier(): JudgingVerifier {
  return judgingVerifier((after) => {
    const has = (name: string) => after.elements.some((e) => e.role === 'heading' && e.name === name)
    const saved = has('Saved')
      ? condition('the setting is saved', [{ source: 'final-screen', quote: 'heading "Saved"' }], { needs: 'persistence' })
      : has('Deals emails: on')
        ? condition('the setting is saved', [{ source: 'final-screen', quote: 'heading "Deals emails: on"' }], { needs: 'persistence' })
        : condition('the setting is saved', [{ source: 'final-screen', quote: 'heading "Deals emails: off"' }], {
          needs: 'persistence',
          verdict: 'not-met',
          reasoning: 'After the reload the setting reads off',
        })
    return verification([
      condition('Turn on deals emails', [{ source: 'action', quote: '→ success' }]),
      saved,
    ])
  })
}

const toggleDeals: ScriptedTurn = (screen) =>
  act({ type: 'click', ref: refFor(screen, 'switch', 'Deals emails') }, false, 'Turn on deals emails')
const saveDeals = (complete: boolean): ScriptedTurn => (screen) =>
  act({ type: 'click', ref: refFor(screen, 'button', 'Save') }, complete, 'Save the setting')
const reload = (complete: boolean): ScriptedTurn => () =>
  act({ type: 'navigate', to: 'reload' }, complete, 'Reload to re-read the setting')

async function openSettings(mode: 'working' | 'dead'): Promise<WebPlatformAdapter> {
  settings = await settingsServer(mode)
  const web = await open('<!doctype html><html><body></body></html>')
  await web.getPage()!.goto(settings.url)
  return web
}

describe('C439-AUTO12', () => {
  it('a confirmation dialog left open after Save never passes', async () => {
    const web = await open(DIALOG_LEFT_OPEN)
    const seen: { failureContext?: string } = {}

    const run = await runScriptedStep({
      adapter: web, instruction: SAVE_STEP, planner: scriptedPlanner(thenGiveUp(clickSave, seen)), verifier: saveMet(), plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(seen.failureContext).toContain('open dialog "Unsaved changes" was not accounted for')
    const block = run.result.evidence!.conditionVerdicts!
    expect(block.conditions[0].verdict).toBe('met')
    expect(block.openDialogs).toEqual([{ name: 'Unsaved changes', account: 'unaccounted' }])
  }, 60_000)

  it('the same step passes when the dialog is closed', async () => {
    const web = await open(DIALOG_CLOSED)

    const run = await runScriptedStep({
      adapter: web, instruction: SAVE_STEP, planner: scriptedPlanner([clickSave]), verifier: saveMet(), plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.result.evidence!.conditionVerdicts!.openDialogs).toBeUndefined()
  }, 60_000)

  it('a cookie banner accounted as unrelated does not block', async () => {
    const web = await open(COOKIE_PAGE)
    const verifier = saveMet([{ name: 'Cookies', account: 'unrelated', reasoning: 'A cookie banner' }])

    const run = await runScriptedStep({
      adapter: web, instruction: SAVE_STEP, planner: scriptedPlanner([clickSave]), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(run.result.evidence!.conditionVerdicts!.openDialogs).toEqual([
      { name: 'Cookies', account: 'unrelated' },
    ])
  }, 60_000)

  it('a dialog that bears on a condition blocks', async () => {
    const web = await open(DIALOG_LEFT_OPEN)
    const verifier = saveMet([
      { name: 'Unsaved changes', account: 'bears-on-condition', reasoning: 'The save is not confirmed' },
    ])
    const seen: { failureContext?: string } = {}

    const run = await runScriptedStep({
      adapter: web, instruction: SAVE_STEP, planner: scriptedPlanner(thenGiveUp(clickSave, seen)), verifier, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(seen.failureContext).toContain('Not met: open dialog "Unsaved changes" bears on a condition')
    expect(run.result.evidence!.conditionVerdicts!.openDialogs).toEqual([
      { name: 'Unsaved changes', account: 'bears-on-condition' },
    ])
  }, 60_000)

  it('a slider short of its maximum is not at its limit', async () => {
    const brightnessMet = judgingVerifier((after) => verification([
      condition(BRIGHTNESS_STEP, [{ source: 'final-screen', quote: 'slider "Brightness"' }], {
        needs: 'limit-max',
        controlRef: refFor(after, 'slider', 'Brightness'),
      }),
    ]))
    const focusSlider: ScriptedTurn = (screen) =>
      act({ type: 'focus', ref: refFor(screen, 'slider', 'Brightness') }, true, 'The brightness is at its maximum')

    const web = await open(SLIDER_PAGE(65272))
    const seen: { failureContext?: string } = {}
    const short = await runScriptedStep({
      adapter: web, instruction: BRIGHTNESS_STEP, planner: scriptedPlanner(thenGiveUp(focusSlider, seen)), verifier: brightnessMet, plannerConfig: LIMITS,
    })
    expect(short.result.status).toBe('failed')
    expect(seen.failureContext).toContain('65272 of 65535')
    expect(short.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      verdict: 'not-met',
      judged: 'met',
      guard: 'limit',
      reason: '65272 of 65535',
    })

    await web.getPage()!.setContent(SLIDER_PAGE(65535))
    const atMax = await runScriptedStep({
      adapter: web, instruction: BRIGHTNESS_STEP, planner: scriptedPlanner([focusSlider]), verifier: brightnessMet, plannerConfig: LIMITS,
    })
    expect(atMax.result.status).toBe('passed')
    expect(atMax.result.evidence!.conditionVerdicts!.conditions[0].verdict).toBe('met')
  }, 60_000)

  it('a range input reports its value and the default limits', async () => {
    const web = await open('<!doctype html><html><body><input type="range" aria-label="Volume" value="100"></body></html>')
    const screen = await web.observe()
    const range = screen.elements.find((element) => element.ref === refFor(screen, 'slider', 'Volume'))!
    expect(range.attributes).toMatchObject({ valuenow: '100', valuemin: '0', valuemax: '100' })
    expect(screen.tree).not.toContain('valuemax')
  }, 60_000)

  it('a control that reports no limit leaves the condition unverified', async () => {
    const volumeMet = judgingVerifier((after) => verification([
      condition(VOLUME_STEP, [{ source: 'final-screen', quote: 'spinbutton "Volume"' }], {
        needs: 'limit-max',
        controlRef: refFor(after, 'spinbutton', 'Volume'),
      }),
    ]))
    const focusVolume: ScriptedTurn = (screen) =>
      act({ type: 'focus', ref: refFor(screen, 'spinbutton', 'Volume') }, true, 'The volume is at its maximum')

    const web = await open(NUMBER_PAGE)
    const run = await runScriptedStep({
      adapter: web, instruction: VOLUME_STEP, planner: scriptedPlanner(thenGiveUp(focusVolume, {})), verifier: volumeMet, plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(run.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'limit',
    })
  }, 60_000)

  it('a narrower passing check cannot replace a failed one', async () => {
    const verifier = judgingVerifier(() => verification([
      condition(ORDER_QUOTE, [{ source: 'read', quote: 'contains "ORD-1001": passed' }]),
    ]))
    const seen: { failureContext?: string } = {}
    const planner = scriptedPlanner([
      () => act({ type: 'assertValue', expr: ROW_EXPR, op: 'contains', expected: 'ORD-1001,42.50' }, false, 'Check the row'),
      () => act({ type: 'assertValue', expr: ROW_EXPR, op: 'contains', expected: 'ORD-1001' }, true, 'The row reads the order'),
      (_screen, context) => {
        seen.failureContext = context.failureContext
        return giveUp('The row does not read ORD-1001,42.50')
      },
    ])

    const web = await open(ORDER_PAGE('ORD-1001,42.00'))
    const run = await runScriptedStep({ adapter: web, instruction: ORDER_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('failed')
    expect(seen.failureContext).toContain('an earlier check asking for more failed')
    expect(run.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      quote: ORDER_QUOTE,
      verdict: 'not-met',
      judged: 'met',
      guard: 'narrowed',
    })
  }, 60_000)

  it('the full check passing first time is met', async () => {
    const verifier = judgingVerifier(() => verification([
      condition(ORDER_QUOTE, [{ source: 'read', quote: 'contains "ORD-1001,42.50": passed' }]),
    ]))
    const planner = scriptedPlanner([
      () => act({ type: 'assertValue', expr: ROW_EXPR, op: 'contains', expected: 'ORD-1001,42.50' }, true, 'The row reads the order'),
    ])

    const web = await open(ORDER_PAGE('ORD-1001,42.50'))
    const run = await runScriptedStep({ adapter: web, instruction: ORDER_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(run.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({ verdict: 'met' })
  }, 60_000)

  it('"Saved" without a re-read after reload is not persistence', async () => {
    const web = await openSettings('dead')
    const seen: { failureContext?: string }[] = []
    const remember = (turn: ScriptedTurn): ScriptedTurn => (screen, context) => {
      seen.push({ failureContext: context.failureContext })
      return turn(screen, context)
    }
    const planner = scriptedPlanner([
      toggleDeals,
      saveDeals(true),
      remember(reload(true)),
      remember(() => giveUp('After the reload the setting reads off')),
    ])

    const run = await runScriptedStep({ adapter: web, instruction: DEALS_STEP, planner, verifier: dealsVerifier(), plannerConfig: LIMITS })

    expect(run.result.status).toBe('failed')
    expect(seen[0].failureContext).toContain('no re-read after a reload or reopen')
    expect(seen[0].failureContext).toContain('Unverified: "the setting is saved"')
    expect(seen[1].failureContext).toContain('Not met: "the setting is saved"')
    const conditions = run.result.evidence!.conditionVerdicts!.conditions
    expect(conditions[1]).toMatchObject({ verdict: 'not-met', needs: 'persistence' })
  }, 60_000)

  it('a re-read after reload proves persistence', async () => {
    const web = await openSettings('working')
    const planner = scriptedPlanner([toggleDeals, saveDeals(false), reload(true)])

    const run = await runScriptedStep({ adapter: web, instruction: DEALS_STEP, planner, verifier: dealsVerifier(), plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(run.result.evidence!.conditionVerdicts!.conditions[1]).toMatchObject({
      verdict: 'met',
      needs: 'persistence',
      citations: [{ source: 'final-screen', quote: 'heading "Deals emails: on"', found: true }],
    })
  }, 60_000)

  it('a reload before the change does not count', async () => {
    const web = await openSettings('working')
    const planner = scriptedPlanner([
      reload(false),
      toggleDeals,
      saveDeals(true),
      () => giveUp('The setting was never re-read after the save'),
    ])

    const run = await runScriptedStep({ adapter: web, instruction: DEALS_STEP, planner, verifier: dealsVerifier(), plannerConfig: LIMITS })

    expect(run.result.status).toBe('failed')
    expect(run.result.evidence!.conditionVerdicts!.conditions[1]).toMatchObject({
      verdict: 'unverified',
      judged: 'met',
      guard: 'no-reload',
    })
  }, 60_000)
})
