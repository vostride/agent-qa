// C439-JUDGED-CASES (439 D-16, D-18, D-20, SC2, SC3): paired cells for the model-judged cases in
// real headless Chromium through the real loop. These cells prove the runner's computed pass and
// its citation discipline, not the model's judgment of totals, positions or dead submits (D-20):
// each scripted verifier reads only the screens and the record the loop hands it and states a
// verdict; the runner decides whether that verdict is cited from what the step saw. Pages are
// served by a loopback server defined here.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AiExtraction, PlannerConfig, StepContext } from '@vostride/agent-qa-runner'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, refFor, runScriptedStep, scriptedPlanner, scriptedVerifier } from './fixtures/scripted-loop.js'
import type { ScriptedTurn, VerifierInput, VerifierVerdict } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }

const SUBTOTALS: Record<string, string> = { '1': '60.00', '2': '25.50' }
const ORDERS_PAGE = (page: string) => `<!doctype html><html><body><main>
  <h1>Orders page ${page}</h1>
  <ul>${page === '1' ? '<li>ORD-1 30.00</li><li>ORD-2 30.00</li>' : '<li>ORD-3 25.50</li>'}</ul>
  <h2>Subtotal: ${SUBTOTALS[page]!}</h2>
  ${page === '1' ? '<a href="/orders/2">Next page</a>' : '<a href="/orders/1">Previous page</a>'}
</main></body></html>`

const GIFT_PAGE = (where: 'top' | 'bottom') => `<!doctype html><html><body><main>
  <h1>Gift list</h1>
  <ul id="gifts"><li>Red scarf</li><li>Green socks</li></ul>
  <label>New item <input id="item"></label>
  <button type="button" onclick="add()">Add</button>
</main>
<script>
  function add() {
    const li = document.createElement('li')
    li.textContent = document.getElementById('item').value
    const list = document.getElementById('gifts')
    ${where === 'top' ? 'list.prepend(li)' : 'list.append(li)'}
  }
</script></body></html>`

const CONTACT_PAGE = (working: boolean) => `<!doctype html><html><body><main>
  <h1>Contact</h1>
  <label>Message <textarea id="message">Hello</textarea></label>
  <button type="button" onclick="${working ? "document.getElementById('reply').textContent = 'Thanks, we received your message'" : ''}">Submit</button>
  <h2 id="reply"></h2>
</main></body></html>`

const DEAD_EFFECTS_PAGE = `<!doctype html><html><body><main>
  <h1>Reports</h1>
  <button type="button">Download report</button>
  <p>Code: SAVE-20</p>
  <button type="button" onclick="navigator.clipboard.writeText('SAVE-10')">Copy code</button>
</main></body></html>`

const PAGES: Record<string, string> = {
  '/orders/1': ORDERS_PAGE('1'),
  '/orders/2': ORDERS_PAGE('2'),
  '/gifts-top': GIFT_PAGE('top'),
  '/gifts-bottom': GIFT_PAGE('bottom'),
  '/contact-dead': CONTACT_PAGE(false),
  '/contact-working': CONTACT_PAGE(true),
  '/dead-effects': DEAD_EFFECTS_PAGE,
}

let server: Server
let baseUrl: string
let adapter: WebPlatformAdapter | undefined

beforeAll(async () => {
  server = createServer((request, response) => {
    const html = PAGES[request.url ?? '/']
    response.writeHead(html === undefined ? 404 : 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(html ?? 'not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://localhost:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
}, 60_000)

async function open(path: string): Promise<WebPlatformAdapter> {
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.goto(baseUrl + path)
  return created
}

/** The final screen's line for the first element with this role, as the tree renders it. */
function firstLine(screen: ScreenState, role: string): string | undefined {
  return screen.tree.split('\n').map((line) => line.trim()).find((line) => line.startsWith(`- ${role} `))
}

/** What the scripted extractData read: the page number and subtotal shown on the screen. */
async function extractPage(_query: string, screen: ScreenState): Promise<AiExtraction> {
  const page = screen.elements.find((element) => element.name.startsWith('Orders page '))
  const subtotal = /Subtotal: ([\d.]+)/.exec(screen.tree)
  return {
    outcome: 'extracted',
    fields: {
      page: page?.name.replace('Orders page ', '') ?? 'unknown',
      subtotal: subtotal?.[1] ?? 'unknown',
    },
  }
}

const readLine = (page: string) => `page = ${page}, subtotal = ${SUBTOTALS[page]!}`
const extract = { type: 'extractAI', query: 'the page subtotal' }
const extractTurn = (complete: boolean): ScriptedTurn => () => act(extract, complete, 'Read this page subtotal')
const nextPage: ScriptedTurn = (screen) => act({ type: 'click', ref: refFor(screen, 'link', 'Next page') }, false, 'Go to page 2')

function rememberFailures(turns: ScriptedTurn[], seen: string[]): ScriptedTurn[] {
  return turns.map((turn) => (screen: ScreenState, context: StepContext) => {
    if (context.failureContext !== undefined) seen.push(context.failureContext)
    return turn(screen, context)
  })
}

const TOTAL_STEP = 'Read the order total across all pages'
const GIFT_STEP = 'Add Blue mug to the gift list and verify it is at the top'
const CONTACT_STEP = 'Submit the contact form'
const DOWNLOAD_STEP = 'Download the report'
const COPY_STEP = 'Copy the code shown on the page'

describe('a verdict passes only on pages and screens the step saw', () => {
  it('a total over all pages passes when every page was read', async () => {
    const web = await open('/orders/1')
    const planner = scriptedPlanner([extractTurn(false), nextPage, extractTurn(true)])
    const verifier = Object.assign(
      scriptedVerifier((input: VerifierInput): VerifierVerdict => {
        const reads = (input.record?.reads ?? []).filter((read) => read.kind === 'extractAI')
        return {
          pass: true,
          reason: 'The total over both pages is 85.50',
          citations: reads.map((read) => ({ source: 'read' as const, quote: read.text.split(': ').slice(1).join(': ') })),
        }
      }),
      { extractData: extractPage },
    )

    const run = await runScriptedStep({ adapter: web, instruction: TOTAL_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    const condition = run.result.evidence!.conditionVerdicts!.conditions[0]!
    expect(condition.verdict).toBe('met')
    expect(condition.citations.map((citation) => [citation.source, citation.quote, citation.found])).toEqual([
      ['read', readLine('1'), true],
      ['read', readLine('2'), true],
    ])
  }, 60_000)

  it('a total citing a page the step never read is unverified', async () => {
    const web = await open('/orders/1')
    const planner = scriptedPlanner([nextPage, extractTurn(true), () => giveUp('The total could not be proven')])
    const verifier = Object.assign(
      scriptedVerifier((): VerifierVerdict => ({
        pass: true,
        reason: 'The total over both pages is 85.50',
        citations: [{ source: 'read', quote: readLine('1') }],
      })),
      { extractData: extractPage },
    )

    const run = await runScriptedStep({ adapter: web, instruction: TOTAL_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).not.toBe('passed')
    expect(run.result.status).toBe('failed')
    const condition = run.result.evidence!.conditionVerdicts!.conditions[0]!
    expect(condition).toMatchObject({ verdict: 'unverified', judged: 'met', guard: 'citation-missing' })
    expect(condition.citations[0]).toMatchObject({ quote: readLine('1'), found: false })
  }, 60_000)

  const addBlueMug: ScriptedTurn[] = [
    (screen) => act({
      type: 'fill',
      ref: refFor(screen, 'textbox', 'New item'),
      text: 'Blue mug',
      clearMode: 'replace',
      submit: false,
    }, false, 'Type the new item'),
    (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Add') }, true, 'Add the item'),
  ]
  const positionCheck = (input: VerifierInput): VerifierVerdict => {
    const line = firstLine(input.after, 'listitem')
    const first = line !== undefined ? /text: "([^"]*)"/.exec(line)?.[1] : undefined
    const citations = line !== undefined ? [{ source: 'final-screen' as const, quote: line }] : []
    return first === 'Blue mug'
      ? { pass: true, reason: 'Blue mug is the first item of the gift list', citations }
      : { pass: false, verdict: 'not-met', reason: `The first item is ${first ?? 'missing'}, not Blue mug`, citations }
  }

  it('a created item at its destination and position passes on the final screen', async () => {
    const web = await open('/gifts-top')
    const verifier = scriptedVerifier(positionCheck)

    const run = await runScriptedStep({
      adapter: web,
      instruction: GIFT_STEP,
      planner: scriptedPlanner(addBlueMug),
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    const condition = run.result.evidence!.conditionVerdicts!.conditions[0]!
    expect(condition.verdict).toBe('met')
    expect(condition.citations[0]).toMatchObject({ source: 'final-screen', found: true })
    expect(condition.citations[0]!.quote).toContain('text: "Blue mug"')
  }, 60_000)

  it('the same item in the wrong position does not pass', async () => {
    const web = await open('/gifts-bottom')
    const verifier = scriptedVerifier(positionCheck)

    const run = await runScriptedStep({
      adapter: web,
      instruction: GIFT_STEP,
      planner: scriptedPlanner([...addBlueMug, () => giveUp('Blue mug is not at the top')]),
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    const condition = run.result.evidence!.conditionVerdicts!.conditions[0]!
    expect(condition.verdict).toBe('not-met')
    expect(condition.citations[0]!.quote).toContain('text: "Red scarf"')
    expect(run.result.evidence!.subActions.some((sub) => sub.plannedAction?.type === 'click')).toBe(true)
  }, 60_000)

  it('a dead submit never passes', async () => {
    const submitCheck = (input: VerifierInput): VerifierVerdict => {
      const reply = input.after.elements.find((element) => element.name === 'Thanks, we received your message')
      return reply !== undefined
        ? {
            pass: true,
            reason: 'The form answered the submit',
            citations: [{ source: 'final-screen', quote: 'heading "Thanks, we received your message"' }],
          }
        : { pass: false, verdict: 'unverified', reason: 'No response tied to the submit is on the screen' }
    }
    const submit: ScriptedTurn = (screen) =>
      act({ type: 'click', ref: refFor(screen, 'button', 'Submit') }, true, 'Submit the form')

    const web = await open('/contact-dead')
    const failures: string[] = []
    const dead = await runScriptedStep({
      adapter: web,
      instruction: CONTACT_STEP,
      planner: scriptedPlanner(rememberFailures([submit, () => giveUp('Nothing answered the submit')], failures)),
      verifier: scriptedVerifier(submitCheck),
      plannerConfig: LIMITS,
    })

    expect(dead.result.status).toBe('failed')
    expect(dead.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({ verdict: 'unverified' })
    expect(dead.result.error).toContain(`Unverified: "${CONTACT_STEP}"`)
    expect(failures.at(-1)).toContain('Unverified:')

    await web.getPage()!.goto(`${baseUrl}/contact-working`)
    const working = await runScriptedStep({
      adapter: web,
      instruction: CONTACT_STEP,
      planner: scriptedPlanner([submit]),
      verifier: scriptedVerifier(submitCheck),
      plannerConfig: LIMITS,
    })

    expect(working.result.status).toBe('passed')
    expect(working.result.evidence!.conditionVerdicts!.conditions[0]!.citations[0]).toMatchObject({
      source: 'final-screen',
      quote: 'heading "Thanks, we received your message"',
      found: true,
    })
  }, 60_000)

  it('an unchanged-page download or copy without its effect does not pass', async () => {
    const web = await open('/dead-effects')
    const download = await runScriptedStep({
      adapter: web,
      instruction: DOWNLOAD_STEP,
      planner: scriptedPlanner([
        (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Download report') }, true, 'Download the report'),
        () => giveUp('No download started'),
      ]),
      verifier: scriptedVerifier((input): VerifierVerdict => {
        const completed = (input.operationEvidence?.downloads ?? []).filter((d) => d.state === 'completed')
        return completed.length > 0
          ? { pass: true, reason: 'The report was downloaded', citations: [{ source: 'action', quote: 'Download "' }] }
          : { pass: false, verdict: 'unverified', reason: 'No completed download is recorded for the step' }
      }),
      plannerConfig: LIMITS,
    })

    expect(download.result.status).toBe('failed')
    expect(download.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({ verdict: 'unverified' })
    expect(download.result.evidence!.subActions[0]!.operationEvidence?.downloads).toBeUndefined()

    const copy = await runScriptedStep({
      adapter: web,
      instruction: COPY_STEP,
      planner: scriptedPlanner([
        (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Copy code') }, true, 'Copy the code'),
        () => giveUp('The copied value is not the code shown'),
      ]),
      verifier: scriptedVerifier((input): VerifierVerdict => {
        const shown = /Code: (\S+)/.exec(input.after.tree)?.[1]
        const write = input.operationEvidence?.clipboard?.at(-1)
        if (write === undefined) return { pass: false, verdict: 'unverified', reason: 'Nothing was copied' }
        const line = `Clipboard write (${write.source}): "${write.text}"`
        return write.text === shown && write.readBack === 'matched'
          ? { pass: true, reason: 'The shown code was copied', citations: [{ source: 'action', quote: line }] }
          : { pass: false, reason: `The clipboard holds ${write.text}, not ${shown ?? 'the code'}`, citations: [{ source: 'action', quote: line }] }
      }),
      plannerConfig: LIMITS,
    })

    expect(copy.result.status).toBe('failed')
    expect(copy.result.evidence!.subActions[0]!.operationEvidence?.clipboard?.[0]).toMatchObject({
      text: 'SAVE-10',
      readBack: 'matched',
    })
    const copied = copy.result.evidence!.conditionVerdicts!.conditions[0]!
    expect(copied.verdict).toBe('not-met')
    expect(copied.citations[0]).toMatchObject({ source: 'action', quote: 'Clipboard write (writeText): "SAVE-10"' })
  }, 60_000)
})
