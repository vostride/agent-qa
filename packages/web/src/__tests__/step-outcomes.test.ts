// C436-OUTCOME-EVIDENCE (436 D-28, SC1): model-free acceptance through the real runner loop and a
// real headless Chromium. A scripted planner and verifier drive executeStep over WebPlatformAdapter
// against loopback fixture pages whose outcomes are known. Every cell also checks that the loop
// dispatched exactly what the planner planned (no loop-initiated retry).

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { screenIdentityHash } from '@vostride/agent-qa-schema'
import type { DownloadEvidence } from '@vostride/agent-qa-schema'
import type { PlannerConfig, StepResult, Verifier } from '@vostride/agent-qa-runner'
import { WebPlatformAdapter } from '../adapter.js'
import { ORDERS_CSV_BYTES, startOutcomePages } from './fixtures/outcome-pages.js'
import type { OutcomePages } from './fixtures/outcome-pages.js'
import {
  act,
  giveUp,
  memoryCache,
  refFor,
  runScriptedStep,
  scriptedPlanner,
  scriptedVerifier,
} from './fixtures/scripted-loop.js'
import type { ScriptedPlanner, ScriptedStepRun, VerifierInput, VerifierVerdict } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const ORDERS_SHA256 = createHash('sha256').update(ORDERS_CSV_BYTES).digest('hex')
const ORDERS_DOWNLOAD: DownloadEvidence = {
  suggestedFilename: 'orders.csv',
  extension: '.csv',
  size: Buffer.byteLength(ORDERS_CSV_BYTES),
  sha256: ORDERS_SHA256,
  state: 'completed',
}

let pages: OutcomePages | undefined
let adapter: WebPlatformAdapter | undefined
let drafts: DraftServer | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  await pages?.close()
  pages = undefined
  await drafts?.close()
  drafts = undefined
}, 60_000)

interface DraftServer {
  url: string
  saved: string[]
  close(): Promise<void>
}

// the background save is re-read after a reload, so its page is served
// here and renders what the server kept; "Save draft" still changes nothing on the page.
async function draftServer(): Promise<DraftServer> {
  const saved: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/api/save') {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        saved.push(body)
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ saved: saved.length }))
      })
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><html><body><main>
  <h1>Draft</h1>
  <h2>${saved.length > 0 ? `Saved draft: ${saved.at(-1)!}` : 'No saved draft'}</h2>
  <label>Draft <input id="draft" value="Quarterly report draft"></label>
  <button type="button" onclick="fetch('/api/save', { method: 'POST', body: document.getElementById('draft').value })">Save draft</button>
</main></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://localhost:${String(port)}/draft`,
    saved,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function open(path: string): Promise<{ web: WebPlatformAdapter; site: OutcomePages }> {
  const site = await startOutcomePages()
  pages = site
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.goto(site.url(path))
  return { web: created, site }
}

/** Every dispatch was one the planner (or the cache) planned. */
function expectOutcomeOnly(run: ScriptedStepRun, plannedActions: number): void {
  const evidence = run.result.evidence
  expect(evidence, 'the loop recorded step evidence').toBeDefined()
  expect(run.executed).toHaveLength(plannedActions)
  expect(evidence!.limitUsage?.actionsUsed).toBe(plannedActions)
}

function liveActions(planner: ScriptedPlanner): number {
  return planner.plannedActions
}

function sameIdentity(result: StepResult, index: number): void {
  const subAction = result.evidence!.subActions[index]
  expect(subAction.stateAfter, 'the verifier re-observation is the stateAfter').toBeDefined()
  expect(screenIdentityHash(subAction.stateAfter!)).toBe(screenIdentityHash(subAction.stateBefore))
}

function downloadsCheck(expected: number) {
  return (input: VerifierInput): VerifierVerdict => {
    const downloads = input.operationEvidence?.downloads ?? []
    const matching = downloads.filter((d) =>
      d.state === 'completed'
      && d.suggestedFilename === 'orders.csv'
      && d.extension === '.csv'
      && d.sha256 === ORDERS_SHA256)
    return matching.length === expected && downloads.length === expected
      ? {
          pass: true,
          reason: `orders.csv was downloaded ${String(expected)} time(s) with the served digest`,
          citations: [{ source: 'action', quote: 'Download "orders.csv" (.csv): completed' }],
        }
      : { pass: false, reason: 'orders.csv was not downloaded' }
  }
}

const EXPORT_STEP = 'Export the orders as CSV'
const exportCsv = (screen: Parameters<typeof refFor>[0]) =>
  act({ type: 'click', ref: refFor(screen, 'button', 'Export CSV') }, true, 'Export the orders as CSV')

describe('model-free step outcomes through the real loop', () => {
  it('a download on an unchanged page passes on its name, extension and digest', async () => {
    const { web } = await open('/download')
    const planner = scriptedPlanner([exportCsv])
    const verifier = scriptedVerifier(downloadsCheck(1))

    const run = await runScriptedStep({ adapter: web, instruction: EXPORT_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(verifier.calls).toBe(1)
    expect(verifier.inputs[0].operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD])
    expect(run.result.evidence!.subActions[0].operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD])
    expect(run.result.evidence!.conditionVerdicts!.conditions[0]!.citations).toEqual([
      { source: 'action', quote: 'Download "orders.csv" (.csv): completed', found: true },
    ])
    sameIdentity(run.result, 0)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('the same download passes from the cache', async () => {
    const { web } = await open('/download')
    const cache = memoryCache()
    const first = await runScriptedStep({
      adapter: web,
      instruction: EXPORT_STEP,
      planner: scriptedPlanner([exportCsv]),
      verifier: scriptedVerifier(downloadsCheck(1)),
      cache,
      plannerConfig: LIMITS,
    })
    expect(first.result.status).toBe('passed')
    expect(cache.sets).toHaveLength(1)

    await web.getPage()!.reload()
    const planner = scriptedPlanner([exportCsv])
    const verifier = scriptedVerifier(downloadsCheck(1))
    const run = await runScriptedStep({ adapter: web, instruction: EXPORT_STEP, planner, verifier, cache, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(planner.calls).toBe(0)
    expect(cache.gets.at(-1)?.hit).toBe(true)
    expect(run.result.evidence!.limitUsage?.planningCallsUsed).toBe(0)
    expect(run.result.evidence!.subActions[0].operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD])
    expect(verifier.inputs[0].operationEvidence?.downloads?.[0]?.sha256).toBe(
      first.result.evidence!.subActions[0].operationEvidence?.downloads?.[0]?.sha256,
    )
    sameIdentity(run.result, 0)
    expectOutcomeOnly(run, 1)
  }, 60_000)

  it('the same download passes after a verifier rejection', async () => {
    const { web } = await open('/download')
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Prepare export') }, true, 'Prepare the export'),
      exportCsv,
    ])
    const verifier = scriptedVerifier(downloadsCheck(1))

    const run = await runScriptedStep({ adapter: web, instruction: EXPORT_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(planner.calls).toBe(2)
    expect(verifier.calls).toBe(2)
    expect(verifier.inputs[0].operationEvidence).toBeUndefined()
    expect(verifier.inputs[1].operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD])
    const [prepare, exported] = run.result.evidence!.subActions
    expect(prepare.operationEvidence).toBeUndefined()
    expect(exported.operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD])
    sameIdentity(run.result, 0)
    sameIdentity(run.result, 1)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('downloading the same file twice records two identical digests', async () => {
    const { web } = await open('/download')
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Export CSV') }, false, 'First copy'),
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Export CSV') }, true, 'Second copy'),
    ])
    const verifier = scriptedVerifier(downloadsCheck(2))

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Export the orders as CSV twice',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(verifier.inputs[0].operationEvidence?.downloads).toEqual([ORDERS_DOWNLOAD, ORDERS_DOWNLOAD])
    const digests = run.result.evidence!.subActions.map((s) => s.operationEvidence?.downloads?.[0]?.sha256)
    expect(digests).toEqual([ORDERS_SHA256, ORDERS_SHA256])
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  describe('an app clipboard copy passes on the read-back value', () => {
    const COPY_STEP = 'Copy the order number'
    const copyOrder = (screen: Parameters<typeof refFor>[0]) =>
      act({ type: 'click', ref: refFor(screen, 'button', 'Copy order number') }, true, 'Copy the order number')
    const clipboardCheck = (input: VerifierInput): VerifierVerdict => {
      const writes = input.operationEvidence?.clipboard ?? []
      return writes.some((w) => w.text === 'ORDER-4471' && w.readBack === 'matched')
        ? {
            pass: true,
            reason: 'ORDER-4471 was copied and read back',
            citations: [{ source: 'action', quote: COPIED_LINE }],
          }
        : { pass: false, reason: 'the order number was not copied' }
    }
    const COPIED = [{ source: 'writeText', text: 'ORDER-4471', truncated: false, readBack: 'matched' }]
    const COPIED_LINE = 'Clipboard write (writeText): "ORDER-4471", read back matched'

    it('live', async () => {
      const { web } = await open('/clipboard')
      const planner = scriptedPlanner([copyOrder])
      const verifier = scriptedVerifier(clipboardCheck)

      const run = await runScriptedStep({ adapter: web, instruction: COPY_STEP, planner, verifier, plannerConfig: LIMITS })

      expect(run.result.status).toBe('passed')
      expect(verifier.inputs[0].operationEvidence?.clipboard).toEqual(COPIED)
      expect(run.result.evidence!.subActions[0].operationEvidence?.clipboard).toEqual(COPIED)
      expect(run.result.evidence!.conditionVerdicts!.conditions[0]!.citations).toEqual([
        { source: 'action', quote: COPIED_LINE, found: true },
      ])
      sameIdentity(run.result, 0)
      expectOutcomeOnly(run, liveActions(planner))
    }, 60_000)

    it('cached', async () => {
      const { web } = await open('/clipboard')
      const cache = memoryCache()
      const first = await runScriptedStep({
        adapter: web,
        instruction: COPY_STEP,
        planner: scriptedPlanner([copyOrder]),
        verifier: scriptedVerifier(clipboardCheck),
        cache,
        plannerConfig: LIMITS,
      })
      expect(first.result.status).toBe('passed')
      // the replay stands for a later run, whose clipboard does not already
      // hold the copied text; rewriting identical text reads `unavailable` (owner ruling on D-21).
      await web.getPage()!.evaluate("navigator.clipboard.writeText('BEFORE-REPLAY')")

      const planner = scriptedPlanner([copyOrder])
      const verifier = scriptedVerifier(clipboardCheck)
      const run = await runScriptedStep({ adapter: web, instruction: COPY_STEP, planner, verifier, cache, plannerConfig: LIMITS })

      expect(run.result.status).toBe('passed')
      expect(planner.calls).toBe(0)
      expect(cache.gets.at(-1)?.hit).toBe(true)
      expect(run.result.evidence!.subActions[0].operationEvidence?.clipboard).toEqual(COPIED)
      sameIdentity(run.result, 0)
      expectOutcomeOnly(run, 1)
    }, 60_000)
  })

  const SAVE_STEP = 'Save the draft'
  const saveCheck = (site: OutcomePages) => (): VerifierVerdict =>
    site.state.saved.length === 1 && site.state.saved[0] === 'Quarterly report draft'
      ? { pass: true, reason: 'the draft was saved on the server' }
      : { pass: false, reason: 'The draft was not saved' }

  it('a background save on an unchanged page passes on the persisted state', async () => {
    const { web } = await open('/save')
    const server = await draftServer()
    drafts = server
    await web.getPage()!.goto(server.url)
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Save draft') }, false, 'Save the draft'),
      () => act({ type: 'navigate', to: 'reload' }, true, 'Reload to re-read the saved draft'),
    ])
    const reread = 'heading "Saved draft: Quarterly report draft"'
    const verifier = scriptedVerifier((input): VerifierVerdict =>
      input.after.tree.includes(reread)
        ? {
            pass: true,
            reason: 'After the reload the page shows the saved draft',
            needs: 'persistence',
            citations: [{ source: 'final-screen', quote: reread }],
          }
        : { pass: false, reason: 'The draft was not saved' })

    const run = await runScriptedStep({ adapter: web, instruction: SAVE_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(server.saved).toEqual(['Quarterly report draft'])
    expect(run.result.evidence!.subActions[0].operationEvidence).toBeUndefined()
    expect(run.result.evidence!.conditionVerdicts!.conditions[0]).toMatchObject({
      verdict: 'met',
      needs: 'persistence',
      citations: [{ source: 'final-screen', quote: reread, found: true }],
    })
    const [save, reload] = run.result.evidence!.subActions
    expect(screenIdentityHash(reload!.stateBefore), 'the save left the page unchanged').toBe(
      screenIdentityHash(save!.stateBefore),
    )
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('a dead Save beside a ticking clock never passes', async () => {
    const { web, site } = await open('/dead-save')
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Save') }, true, 'Save the draft'),
      () => act({ type: 'keypress', keys: ['Enter'] }, true, 'Save did not save; press Enter in the form'),
      () => giveUp('The draft was not saved: Save and Enter in the form both left no saved draft'),
    ])
    const verifier = scriptedVerifier(saveCheck(site))

    const run = await runScriptedStep({ adapter: web, instruction: SAVE_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('failed')
    expect(run.result.error).toContain('The draft was not saved')
    expect(run.result.evidence!.limitStop).toBeUndefined()
    expect(site.state.saved).toEqual([])
    expect(planner.calls).toBe(3)
    // Two rejected completions, then the give-up's own judgment.
    expect(verifier.calls).toBe(3)
    expect(run.result.evidence!.conditionVerdicts?.ending).toBe('give-up')
    const clocks = run.result.evidence!.subActions
      .map((s) => s.stateBefore.elements.find((e) => e.role === 'heading' && e.name.startsWith('Local time'))?.name)
    expect(new Set(clocks).size, 'the clock ticked between observations').toBeGreaterThan(1)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('the same dead Save under a planner that keeps trying stops at the limit, unverified', async () => {
    const { web, site } = await open('/dead-save')
    const planner = scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'button', 'Save') }, true, 'Save the draft'),
    ])
    const verifier = scriptedVerifier(saveCheck(site))

    const run = await runScriptedStep({
      adapter: web,
      instruction: SAVE_STEP,
      planner,
      verifier,
      plannerConfig: { maxActions: 4, maxPlanningTurns: 30, previousStepCount: 0 },
    })

    expect(run.result.status).toBe('failed')
    expect(run.result.evidence!.limitStop).toMatchObject({
      limit: 'actions',
      configured: 4,
      used: 4,
      requestedOutcome: 'unverified',
      lastVerifierRejection: 'Not met: "Save the draft" (The draft was not saved)',
    })
    expect(site.state.saved).toEqual([])
    expect(planner.calls).toBe(4)
    // Four rejected completions, then the limit stop's own judgment.
    expect(verifier.calls).toBe(5)
    expect(run.result.evidence!.conditionVerdicts?.ending).toBe('limit-stop')
    expect(run.result.error).toBe(
      'Stopped: action limit reached — 4 of 4 actions used — Not met: "Save the draft" (The draft was not saved)',
    )
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  const DIALOG_STEP = 'Open the invite dialog'
  const dialogCheck = (input: VerifierInput): VerifierVerdict => {
    const open = input.after.elements.some((e) => e.role === 'heading' && e.name === 'Invite a teammate')
      && input.after.elements.some((e) => e.role === 'button' && e.name === 'Send invite')
    return open
      ? { pass: true, reason: 'the invite dialog is open' }
      : { pass: false, reason: 'The invite dialog did not open' }
  }
  const inviteTurns = [
    (screen: Parameters<typeof refFor>[0]) =>
      act({ type: 'click', ref: refFor(screen, 'button', 'Invite teammate') }, true, 'Open the invite dialog'),
    () => act({ type: 'keypress', keys: ['Enter'] }, true, 'The click opened nothing; press Enter on the button'),
    () => giveUp('The invite dialog did not open after a click and Enter on Invite teammate'),
  ]

  it('a button that never opens the requested dialog never passes', async () => {
    await open('/dead-dialog')
    const planner = scriptedPlanner(inviteTurns)
    const verifier = scriptedVerifier(dialogCheck)

    const run = await runScriptedStep({ adapter: adapter!, instruction: DIALOG_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('failed')
    expect(run.result.error).toContain('The invite dialog did not open')
    // Two rejected completions, then the give-up's own judgment.
    expect(verifier.calls).toBe(3)
    expect(run.result.evidence!.conditionVerdicts?.ending).toBe('give-up')
    expect(verifier.inputs.every((input) => !dialogCheck(input).pass)).toBe(true)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('the same button passes when it opens the dialog (the dead dialog\'s twin)', async () => {
    await open('/dialog')
    const planner = scriptedPlanner(inviteTurns)
    // the open invite dialog is the requested outcome, so the verifier accounts it as
    // unrelated (it shows nothing left undone); an unaccounted open dialog would block the pass.
    const scripted = scriptedVerifier(dialogCheck)
    const verifier: Verifier = {
      async verify(...args) {
        const result = await scripted.verify(...args)
        return {
          ...result,
          verification: {
            ...result.verification,
            dialogs: [{ name: '', account: 'unrelated', reasoning: 'the requested invite dialog' }],
          },
        }
      },
    }

    const run = await runScriptedStep({ adapter: adapter!, instruction: DIALOG_STEP, planner, verifier, plannerConfig: LIMITS })

    expect(run.result.status).toBe('passed')
    expect(planner.calls).toBe(1)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('five counter presses complete when the count is 5', async () => {
    const { web, site } = await open('/counter')
    const press = (last: boolean) => (screen: Parameters<typeof refFor>[0]) =>
      act({ type: 'click', ref: refFor(screen, 'button', 'Add one') }, last, 'Press Add one')
    const planner = scriptedPlanner([press(false), press(false), press(false), press(false), press(true)])
    const verifier = scriptedVerifier(() => site.state.counter === 5
      ? { pass: true, reason: 'the count is 5' }
      : { pass: false, reason: `the count is ${String(site.state.counter)}` })

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Press Add one five times',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(site.state.counter).toBe(5)
    expect(verifier.calls).toBe(1)
    const identities = run.result.evidence!.subActions.map((s) => screenIdentityHash(s.stateBefore))
    expect(identities).toHaveLength(5)
    expect(new Set(identities).size, 'every press started from the same screen').toBe(1)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('five same-label rows are each archived once', async () => {
    const { web, site } = await open('/rows')
    const archive = (nth: number) => (screen: Parameters<typeof refFor>[0]) =>
      act({ type: 'click', ref: refFor(screen, 'button', 'Archive', nth) }, nth === 4, `Archive row ${String(nth + 1)}`)
    const planner = scriptedPlanner([0, 1, 2, 3, 4].map(archive))
    const expected = ['order-1001', 'order-1002', 'order-1003', 'order-1004', 'order-1005']
    const verifier = scriptedVerifier(() =>
      JSON.stringify(site.state.archived) === JSON.stringify(expected)
        ? { pass: true, reason: 'every row was archived once' }
        : { pass: false, reason: `archived ${site.state.archived.join(', ')}` })

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Archive every order',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(site.state.archived).toEqual(expected)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('the overflow menu is used three times on three rows', async () => {
    const { web, site } = await open('/overflow')
    const turns = [0, 1, 2].flatMap((nth) => [
      (screen: Parameters<typeof refFor>[0]) =>
        act({ type: 'click', ref: refFor(screen, 'button', 'More actions', nth) }, false, `Open the menu of row ${String(nth + 1)}`),
      (screen: Parameters<typeof refFor>[0]) =>
        act({ type: 'click', ref: refFor(screen, 'menuitem', 'Archive') }, nth === 2, `Archive row ${String(nth + 1)}`),
    ])
    const planner = scriptedPlanner(turns)
    const expected = ['order-2001', 'order-2002', 'order-2003']
    const verifier = scriptedVerifier(() =>
      JSON.stringify(site.state.archived) === JSON.stringify(expected)
        ? { pass: true, reason: 'the three rows were archived from their menus' }
        : { pass: false, reason: `archived ${site.state.archived.join(', ')}` })

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Archive the three orders from their More actions menus',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    expect(site.state.archived).toEqual(expected)
    expect(run.executed).toHaveLength(6)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  // The web native search waits Playwright's default action timeout (30 s) for a target that is
  // not in the DOM yet; a short page default keeps these cells quick and changes no result.
  const NATIVE_SEARCH_TIMEOUT_MS = 2_000

  it('a same-hash scroll does not reverse or retry', async () => {
    const { web } = await open('/long-list')
    const page = web.getPage()!
    page.setDefaultTimeout(NATIVE_SEARCH_TIMEOUT_MS)

    // The fixture's premise: moving the list by a page leaves the screen identity unchanged.
    const unmoved = screenIdentityHash(await web.observe())
    await page.evaluate(() => {
      const list = (globalThis as unknown as { document: { getElementById(id: string): { scrollTop: number } } })
        .document.getElementById('list')
      list.scrollTop = 720
    })
    expect(screenIdentityHash(await web.observe())).toBe(unmoved)
    await page.evaluate(() => {
      const list = (globalThis as unknown as { document: { getElementById(id: string): { scrollTop: number } } })
        .document.getElementById('list')
      list.scrollTop = 0
    })

    const planner = scriptedPlanner([
      (screen) => act({
        type: 'scroll',
        mode: 'untilVisible',
        text: 'Item 80',
        ref: refFor(screen, 'region', 'Order history list'),
        direction: 'down',
        maxSwipes: 12,
        retryOpposite: true,
      }, true, 'Scroll the order history to Item 80'),
    ])
    const verifier = scriptedVerifier((input) => {
      const viewportHeight = (input.after.metadata.viewportHeight as number | undefined) ?? 0
      const item = input.after.elements.find((e) => e.role === 'button' && e.name === 'Item 80')
      const inView = item?.bounds !== undefined && item.bounds.y >= 0 && item.bounds.y + item.bounds.height <= viewportHeight
      return inView ? { pass: true, reason: 'Item 80 is in view' } : { pass: false, reason: 'Item 80 is not in view' }
    })

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Scroll the order history until Item 80 is visible',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('passed')
    const meta = run.result.evidence!.subActions[0].result.metadata?.['scrollUntilVisible']
    expect(meta).toMatchObject({ reversedOnce: false, outcome: 'found', endedBy: 'target-visible' })
    expect((meta as { swipes: number }).swipes, 'the list moved by several swipes before the item appeared').toBeGreaterThan(1)
    expect(planner.calls).toBe(1)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)

  it('an unrelated update is not movement', async () => {
    const { web } = await open('/unrelated-update')
    web.getPage()!.setDefaultTimeout(NATIVE_SEARCH_TIMEOUT_MS)
    const planner = scriptedPlanner([
      () => act({
        type: 'scroll',
        mode: 'untilVisible',
        text: 'Archived order 12',
        direction: 'down',
        maxSwipes: 4,
        retryOpposite: false,
      }, false, 'Look for Archived order 12 in the feed'),
      () => giveUp('Archived order 12 is not in the activity feed'),
    ])
    const verifier = scriptedVerifier(() => ({ pass: false, reason: 'Archived order 12 is not visible' }))

    const run = await runScriptedStep({
      adapter: web,
      instruction: 'Scroll the activity feed until Archived order 12 is visible',
      planner,
      verifier,
      plannerConfig: LIMITS,
    })

    expect(run.result.status).toBe('failed')
    expect(run.result.evidence!.subActions[0].result.metadata?.['scrollUntilVisible']).toEqual({
      swipes: 4,
      reversedOnce: false,
      outcome: 'unresolved',
      endedBy: 'max-swipes',
    })
    const tickers = run.result.evidence!.subActions
      .map((s) => s.stateBefore.elements.find((e) => e.role === 'heading' && e.name.startsWith('Updated'))?.name)
    expect(new Set(tickers).size, 'the ticker changed while the feed did not move').toBe(2)
    // No completion is claimed; the one call is the give-up's own judgment.
    expect(verifier.calls).toBe(1)
    expect(run.result.evidence!.conditionVerdicts?.ending).toBe('give-up')
    expect(planner.calls).toBe(2)
    expectOutcomeOnly(run, liveActions(planner))
  }, 60_000)
})
