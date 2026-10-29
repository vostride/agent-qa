import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionPlan, PlannerConfig, PlatformConfig } from '@vostride/agent-qa-runner'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, runScriptedStep, scriptedPlanner, scriptedVerifier } from './fixtures/scripted-loop.js'
import type { ScriptedStepRun, ScriptedTurn } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const CART_PAGE = `<!doctype html><html><body><main>
  <h1>Cart</h1>
  <p id="status">Loading</p>
  <button type="button">Place order</button>
</main></body></html>`
const LATE_PAGE = `<!doctype html><html><body><main>
  <h1>Checkout</h1>
  <p id="late"></p>
  <script>setTimeout(() => { document.getElementById('late').textContent = 'Payment accepted' }, 100)</script>
</main></body></html>`
const PING_PAGE = `<!doctype html><html><body><main><h1>Status</h1></main></body></html>`

let adapter: WebPlatformAdapter | undefined
let server: Server | undefined
const hanging: ServerResponse[] = []

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  for (const response of hanging.splice(0)) response.destroy()
  const open = server
  server = undefined
  if (open) await new Promise<void>((done) => open.close(() => done()))
}, 60_000)

async function launch(timeouts?: PlatformConfig['timeouts']): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true }, timeouts })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  return created
}

async function withContent(html: string): Promise<WebPlatformAdapter> {
  const web = await launch()
  await web.getPage()!.setContent(html)
  return web
}

async function servePing(): Promise<string> {
  const created = createServer((request, response) => {
    if (request.url === '/hang') {
      hanging.push(response)
      return
    }
    if (request.url === '/api/ping') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"pong":true}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(PING_PAGE)
  })
  server = created
  await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
  return `http://127.0.0.1:${String((created.address() as AddressInfo).port)}/`
}

const assertTurn = (action: ActionPlan['action'], stepComplete = false): ScriptedTurn =>
  () => act(action, stepComplete, 'Check the value')

function subResult(run: ScriptedStepRun, index: number): { success: boolean; error?: string } {
  const sub = run.result.evidence!.subActions[index]
  return sub.result as { success: boolean; error?: string }
}

const rejectAll = () => scriptedVerifier(() => ({ pass: false, reason: 'Not shown' }))

describe('waits and assertions through the real loop', () => {
  it('a text that never appears fails the wait and the planner sees why', async () => {
    const web = await withContent(CART_PAGE)
    const seen: { failureContext?: string } = {}
    const planner = scriptedPlanner([
      assertTurn({ type: 'waitFor', on: 'text', text: 'Order placed', timeoutMs: 300 }),
      (_screen, context) => {
        seen.failureContext = context.failureContext
        return giveUp('The order was never placed')
      },
    ])

    const run = await runScriptedStep({
      adapter: web, instruction: 'Wait for the order to be placed', planner, verifier: rejectAll(), plannerConfig: LIMITS,
    })

    const message = 'waitFor: text "Order placed" did not appear within 300ms.'
    expect(subResult(run, 0)).toMatchObject({ success: false, error: message })
    expect(seen.failureContext).toContain(message)
    expect(run.result.status).toBe('failed')
  }, 60_000)

  it('a text that never goes and a selector that never appears fail', async () => {
    const web = await withContent(CART_PAGE)

    await expect(web.execute({ type: 'waitFor', on: 'gone', text: 'Loading', timeoutMs: 300 }))
      .resolves.toEqual({ success: false, error: 'waitFor: text "Loading" was still present after 300ms.' })
    await expect(web.execute({ type: 'waitFor', on: 'selector', selector: '#receipt', timeoutMs: 300 }))
      .resolves.toEqual({ success: false, error: 'waitFor: selector "#receipt" did not appear within 300ms.' })

    await web.getPage()!.setContent(LATE_PAGE)
    await expect(web.execute({ type: 'waitFor', on: 'text', text: 'Payment accepted', timeoutMs: 5_000 }))
      .resolves.toEqual({ success: true })
  }, 60_000)

  it('a network assertion reads without consuming', async () => {
    const web = await launch()
    const url = await servePing()
    await web.getPage()!.goto(url)
    await web.getPage()!.evaluate(() => fetch('/api/ping').then((response) => response.text()))
    await expect.poll(() => web.peekNetworkLogs('/api/ping').length).toBe(1)
    const check = { type: 'assertValue', source: 'network', op: 'contains', expected: '/api/ping' } as ActionPlan['action']
    const verifier = scriptedVerifier(() => ({ pass: true, reason: 'The ping request was made' }))

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Check that the status page pinged the API',
      planner: scriptedPlanner([assertTurn(check), assertTurn(check, true)]),
      verifier,
      plannerConfig: LIMITS,
    })

    expect(subResult(run, 0).success).toBe(true)
    expect(subResult(run, 1).success).toBe(true)
    expect(run.result.status).toBe('passed')
    expect(web.drainNetworkLogs('/api/ping').map((entry) => entry.url)).toEqual([`${url}api/ping`])
  }, 60_000)

  it('an empty network log never satisfies isDefined', async () => {
    const web = await withContent(PING_PAGE)
    expect(web.peekNetworkLogs()).toEqual([])

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Check that a request was made',
      planner: scriptedPlanner([
        assertTurn({ type: 'assertValue', source: 'network', op: 'isDefined' }),
        () => giveUp('No request was made'),
      ]),
      verifier: rejectAll(),
      plannerConfig: LIMITS,
    })

    expect(subResult(run, 0).success).toBe(false)
    expect(run.result.status).toBe('failed')
  }, 60_000)

  it("inspect console returns a page's console.warn under the warn level", async () => {
    const web = await withContent(
      '<!doctype html><html><body><script>console.warn("low stock")</script></body></html>',
    )

    const result = await web.execute({ type: 'inspect', what: 'console', level: 'warn' })

    expect(result.success).toBe(true)
    expect(result.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'warn', text: expect.stringContaining('low stock') }),
      ]),
    )
  }, 60_000)

  it('a navigation that never answers fails at timeouts.navigation', async () => {
    const url = await servePing()
    const web = await launch({ navigation: 400 })

    const result = await web.execute({ type: 'navigate', to: 'url', url: `${url}hang` })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Timeout 400ms exceeded')
  }, 60_000)

  it('an expr that evaluates to undefined is unread, null is a read', async () => {
    const web = await withContent(PING_PAGE)
    const verifier = scriptedVerifier(() => ({ pass: true, reason: 'The value is null' }))

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Check that the value is null',
      planner: scriptedPlanner([
        assertTurn({ type: 'assertValue', expr: 'undefined', op: 'isNull' }),
        assertTurn({ type: 'assertValue', expr: 'null', op: 'isNull' }, true),
      ]),
      verifier,
      plannerConfig: LIMITS,
    })

    expect(subResult(run, 0).success).toBe(false)
    expect(subResult(run, 1).success).toBe(true)
    expect(run.result.status).toBe('passed')
  }, 60_000)
})
