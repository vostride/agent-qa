// C439-WAITS-AND-READS (439 D-13, D-14, SC3): in real headless Chromium through the real loop, a
// wait passes only when its condition held and an assertion passes only on a value it actually
// read. A network assertion peeks at the log, so the step-end drain still sees what it read. The
// pages are inline; the network cells use a loopback server defined here.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionPlan, PlannerConfig } from '@vostride/agent-qa-runner'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, runScriptedStep, scriptedPlanner, scriptedVerifier } from './fixtures/436-scripted-loop.js'
import type { ScriptedStepRun, ScriptedTurn } from './fixtures/436-scripted-loop.js'

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

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  const open = server
  server = undefined
  if (open) await new Promise<void>((done) => open.close(() => done()))
}, 60_000)

async function launch(): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
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

describe('C439-WAITS-AND-READS', () => {
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
