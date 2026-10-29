/// <reference lib="dom" />
// Real Chromium, shipped UI and the composed mark and detail routes. No provider calls.
// An absent browser or stale build fails, never skips. Each cell owns an independent ledger.
// a mark asks nobody. The first three cells, the draft-retention matrix and the
// themes cell were re-spelled from approve/deny/no-channel onto the one-click mark; the approval
// group is asserted never to render. 432-14: the composer's approval component, the page's confirm
// channel and the scope the mark carried are deleted, so the page opens no stream and one submit is
// one request carrying the composer's own body.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { DashboardDatabase, createDashboardRunDetailReader, startServer } from '@vostride/agent-qa-dashboard'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { composeDashboardDoor } from '../dashboard.js'
import { markFixture } from '../../gates/__tests__/feedback-fixture.js'
import { DASHBOARD_ANCHORED_BUILDS, PACKAGES_ROOT, REBUILD_INSTRUCTION, buildFreshness } from '../../__tests__/conformance/spawned-chat.js'

const UI_DIR = join(PACKAGES_ROOT, 'dashboard-ui', 'dist')
// Only the home-path seam is isolated; authority and ledger writes stay real.
const { scratchHome } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  return { scratchHome: fs.mkdtempSync(`${os.tmpdir()}/419-mark-ui-auth-`) }
})
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => scratchHome }))
const RECHECK_DIR = process.env.AGENT_QA_MARK_UI_RECHECK_DIR
// the two doors into the one composer.
const TEST_ENTRY = '[data-feedback-entry="test"]'
const STEP_ENTRY = '[data-step-id="0:0"] [data-feedback-entry="step"]'
const COMPOSER = '[data-feedback-composer]'
type Door = 'test' | 'step'
const DOORS: Record<Door, { entry: string; address: string }> = {
  test: { entry: TEST_ENTRY, address: '0:run' },
  step: { entry: STEP_ENTRY, address: '0:0' },
}
// Literals equal to dashboard-ui's view constants (it publishes no library entry).
const APPROVAL_TITLE = 'Approval needed to record this mark'
const DRAFT_KEPT_STATUS = 'Draft kept. Check the message above before sending again.'
const CHOICE_LABELS = { 'false-fail': 'This should have passed', 'false-pass': 'This should have failed',
  'confirmed-bug': 'This is a real product bug' } as const
async function retainCapture(page: Page, name: string) {
  if (!RECHECK_DIR) return
  mkdirSync(RECHECK_DIR, { recursive: true })
  await page.mouse.move(1400, 100)
  await page.screenshot({ path: join(RECHECK_DIR, name), fullPage: true, animations: 'disabled' })
}
const closers: Array<() => Promise<void>> = []
let browser: Browser
beforeAll(async () => {
  expect(buildFreshness(DASHBOARD_ANCHORED_BUILDS), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  expect(existsSync(chromium.executablePath()), 'chromium present: false').toBe(true)
  browser = await chromium.launch({ headless: true })
}, 30_000)
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
afterAll(async () => { await browser?.close(); rmSync(scratchHome, { recursive: true, force: true }) })

interface Wire { eventSources: string[]; marks: Array<Record<string, unknown>> }
async function recordWire(page: Page) {
  await page.addInitScript(() => {
    const wire: Wire = { eventSources: [], marks: [] }
    ;(window as unknown as { markWire: Wire }).markWire = wire
    const Native = window.EventSource
    class Recorded extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        wire.eventSources.push(String(url))
      }
    }
    window.EventSource = Recorded
  })
}
/** Every POST to the mark route, bodies parsed, off Chromium's own request events. */
function recordMarks(page: Page): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  page.on('request', request => {
    if (!request.url().endsWith('/mark') || request.method() !== 'POST') return
    const raw = request.postData()
    bodies.push(raw === null ? {} : JSON.parse(raw) as Record<string, unknown>)
  })
  return bodies
}
async function wire(page: Page): Promise<Wire> {
  return await page.evaluate(() => (window as unknown as { markWire: Wire }).markWire)
}

async function scene() {
  const fixture = markFixture()
  // 2026-10-14 (441-16, E3): the door's run reads refuse without a readable secrets file.
  writeFileSync(join(fixture.root, '.env.secrets.local'), '')
  const config = parse(readFileSync(fixture.configPath, 'utf8'))
  // the fixture declares no `safety` block (the key is deleted), so there is no
  // trust mode to remove; the config is re-serialized unchanged.
  expect(config.safety).toBeUndefined()
  writeFileSync(fixture.configPath, stringify(config))
  const db = new DashboardDatabase({ dbPath: ':memory:' })
  const { handoff } = fixture
  const member = handoff.tests[0]!
  db.insertRun({ id: handoff.runId, name: member.testName, filePath: member.filePath, status: 'failed',
    duration: 1000, startedAt: '2026-09-08T00:00:00.000Z', endedAt: '2026-09-08T00:00:01.000Z' })
  db.upsertRunMember({ runId: handoff.runId, testIndex: 0, testId: member.testId, name: member.testName,
    filePath: member.filePath, outcome: 'failed', totalSteps: member.steps.length })
  member.steps.forEach((step, stepIndex) => db.insertRunStep({ runId: handoff.runId, testIndex: 0, stepIndex,
    stepText: step.stepText, cacheStatus: 'miss', verifierVerdict: step.verifierVerdict,
    selfHealOccurred: false, briefDigest: 'fixture-brief', status: 'failed' }))
  const door = composeDashboardDoor({ agentQaRoot: fixture.agentQaRoot, configPath: fixture.configPath,
    boundOrigin: () => undefined, runDetail: createDashboardRunDetailReader(db) })
  const signals = ['SIGINT', 'SIGTERM'] as const
  const beforeListeners = signals.map(signal => new Set(process.listeners(signal)))
  const server = await startServer({ declaredSecretMask: (text) => text, db, port: 0, uiDir: UI_DIR, configPath: fixture.configPath,
    workspacePaths: resolveWorkspacePaths({ config, configPath: fixture.configPath }), agentHost: door.agentHost })
  const ownedListeners = signals.map((signal, index) => process.listeners(signal).filter(listener => !beforeListeners[index].has(listener)))
  closers.push(async () => {
    server.close()
    await door.host.close()
    signals.forEach((signal, index) => ownedListeners[index].forEach(listener => process.removeListener(signal, listener)))
    rmSync(fixture.root, { recursive: true, force: true })
  })
  const address = server.server.address()
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind a port')
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  closers.push(() => context.close())
  const outsideLoopback: string[] = []
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue()
    outsideLoopback.push(url.origin)
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  await recordWire(page)
  const marks = recordMarks(page)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}/runs/${handoff.runId}`)
  await page.locator(TEST_ENTRY).waitFor()
  const ledger = join(fixture.runDir, 'marks.jsonl')
  const rows = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { page, pageErrors, rows, marks, outsideLoopback, runId: handoff.runId }
}

/** the page holds no stream to be asked on, whichever view it is showing. */
async function noConfirmChannel(page: Page) {
  expect((await wire(page)).eventSources.filter(url => url.includes('run-confirm'))).toEqual([])
}
/** The step door lives on the selected row only, so the row is selected first. */
async function revealStepEntry(page: Page) {
  const row = page.locator('[data-step-id="0:0"]')
  if (await row.getAttribute('aria-selected') !== 'true') await row.locator(':scope > button').click()
  await page.locator(STEP_ENTRY).waitFor()
}
async function openComposer(page: Page, door: Door): Promise<Locator> {
  const composer = page.locator(COMPOSER)
  if (await composer.count() > 0 && await composer.getAttribute('data-feedback-target') === DOORS[door].address) return composer
  if (door === 'step') await revealStepEntry(page)
  await page.locator(DOORS[door].entry).click()
  await page.locator(`${COMPOSER}[data-feedback-target="${DOORS[door].address}"]`).waitFor()
  return composer
}
const choice = (composer: Locator, kind: string) => composer.locator(`[data-feedback-choice="${kind}"] [role="radio"]`)
async function previewCurrent(composer: Locator) {
  await composer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor()
}
async function fillDraft(page: Page, door: Door, kind = 'confirmed-bug') {
  const composer = await openComposer(page, door)
  await choice(composer, kind).click()
  await composer.locator('[data-feedback-note]').fill('Retain this review note')
  await previewCurrent(composer)
  return composer
}
async function expectDraft(composer: Locator) {
  expect(await composer.locator('[data-feedback-note]').inputValue()).toBe('Retain this review note')
  expect(await choice(composer, 'confirmed-bug').getAttribute('aria-checked')).toBe('true')
}
function status(composer: Locator) {
  return composer.locator('[data-feedback-status]')
}
async function settled(composer: Locator, text: string) {
  await status(composer).filter({ hasText: text }).waitFor()
}
/** The recorded sentence, composed as feedbackRecordedText composes it from the history's disposition line. */
async function recordedSentence(composer: Locator) {
  const entry = composer.locator('[data-feedback-history="target"] [data-history-entry][data-history-new]')
  await entry.waitFor()
  // the history line now carries what the fix changed after the
  // disposition, so the recorded sentence is composed from the line's disposition lead alone.
  const disposition = await entry.locator('[data-history-disposition-lead]').textContent() ?? ''
  return `Feedback recorded — ${disposition.replace(/^Recorded — /, '')}.`
}
function targetEntries(composer: Locator) {
  return composer.locator('[data-feedback-history="target"] [data-history-entry]')
}
async function entryChoice(entry: Locator) {
  return await entry.locator(':scope > div:first-child .font-medium').textContent()
}
function approval(page: Page) {
  return page.getByRole('group', { name: APPROVAL_TITLE, exact: true })
}
async function tabTo(page: Page, selector: string) {
  for (let index = 0; index < 100; index++) {
    if (await page.locator(selector).evaluate(element => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Keyboard could not reach ${selector}`)
}
function healthy(s: Awaited<ReturnType<typeof scene>>) {
  expect(s.pageErrors).toEqual([])
  expect(s.outsideLoopback).toEqual([])
  expect(new URL(s.page.url()).pathname).toBe(`/runs/${s.runId}`)
}

async function submit(page: Page, door: Door = 'test', kind = 'confirmed-bug') {
  const composer = await openComposer(page, door)
  await choice(composer, kind).click()
  await previewCurrent(composer)
  await composer.locator('[data-feedback-submit]').click()
  return composer
}

describe('real browser mark confirmation', () => {
  // RE-SPELLED 2026-09-30: was 'asks on /api/run-confirm/channel; accept appends one
  // receipt and refetches its history'. One click records it; nothing is asked on the channel.
  it('records on one click with no approval; appends one receipt and refetches its history', async () => {
    const s = await scene()
    await noConfirmChannel(s.page)
    expect(s.rows()).toHaveLength(0)
    const composer = await submit(s.page)
    const recorded = await recordedSentence(composer)
    await settled(composer, recorded)
    expect(await status(composer).textContent()).toBe(recorded)
    expect(await approval(s.page).count()).toBe(0)
    expect(await s.page.locator('[role="dialog"], [aria-modal]').count()).toBe(0)
    await noConfirmChannel(s.page)
    expect(await targetEntries(composer).count()).toBe(1)
    expect(await entryChoice(targetEntries(composer).first())).toBe(CHOICE_LABELS['confirmed-bug'])
    expect(await targetEntries(composer).first().getAttribute('data-history-active')).toBe('true')
    await s.page.locator(`${TEST_ENTRY}[data-feedback-marked="true"]`).waitFor()
    expect(s.rows()).toHaveLength(1)
    expect(s.rows()[0]).toMatchObject({ kind: 'confirmed-bug', origin: 'user', ordinal: 1 })
    expect(s.pageErrors).toEqual([])
  }, 45_000)

  // RE-SPELLED 2026-09-30: was 'without a confirm channel renders its reason only and
  // appends no ledger line'. The channel is not needed: the mark is recorded without it. 432-14:
  // no page holds a channel any more, so this is every mark, and the cell no longer blocks one.
  it('without a confirm channel still records the mark, with no refusal rendered', async () => {
    const s = await scene()
    const response = s.page.waitForResponse(response => response.url().endsWith('/mark') && response.request().method() === 'POST')
    const composer = await submit(s.page)
    expect((await response).status()).toBe(200)
    await settled(composer, await recordedSentence(composer))
    expect(await composer.locator('[data-feedback-denied]').count()).toBe(0)
    expect(await targetEntries(composer).count()).toBe(1)
    await s.page.locator(`${TEST_ENTRY}[data-feedback-marked="true"]`).waitFor()
    expect(s.rows()).toHaveLength(1)
    await noConfirmChannel(s.page)
    expect(s.pageErrors).toEqual([])
  }, 45_000)

  // RE-SPELLED 2026-09-30: was 'deny renders the typed denial and appends no ledger
  // line'. There is no deny to give: no approval group renders and nothing is parked.
  it('offers no deny: the approval group never renders and nothing is parked', async () => {
    const s = await scene()
    const composer = await submit(s.page)
    await settled(composer, await recordedSentence(composer))
    expect(await approval(s.page).count()).toBe(0)
    expect(await composer.locator('[data-feedback-approval] [data-confirm-answer]').count()).toBe(0)
    expect(s.rows()).toHaveLength(1)
    expect(s.marks).toHaveLength(1)
    expect(s.pageErrors).toEqual([])
  }, 45_000)

  // RE-SPELLED 2026-09-30: the 'deny' and 'no-channel' failures no longer exist — both
  // record the mark — so the retention matrix ranges the two failures that still keep a draft.
  for (const door of ['test', 'step'] as const) {
    it.each(['transport', 'refetch'])('retains the ' + door + ' draft after %s with actual ledger accounting', async failure => {
      const s = await scene()
      const composer = await fillDraft(s.page, door)
      expect(s.rows()).toHaveLength(0)
      let accepted = false
      if (failure === 'transport') await s.page.route('**/mark', route => route.abort('failed'))
      if (failure === 'refetch') {
        s.page.on('response', response => { if (response.url().endsWith('/mark') && response.status() === 200) accepted = true })
        await s.page.route('**/detail', route => accepted ? route.abort('failed') : route.continue())
      }
      await tabTo(s.page, `${COMPOSER} [data-feedback-submit]`)
      await s.page.keyboard.press('Enter')
      await settled(composer, DRAFT_KEPT_STATUS)
      await expectDraft(composer)
      expect(await approval(s.page).count()).toBe(0)
      expect(await composer.locator('[data-feedback-denied]').getAttribute('role')).toBe('alert')
      expect(await status(composer).textContent()).toBe(DRAFT_KEPT_STATUS)
      expect(s.rows()).toHaveLength(failure === 'refetch' ? 1 : 0)
      if (failure === 'refetch') {
        expect(await composer.locator('[data-feedback-denied]').textContent()).toContain('Reload this run')
        expect(await s.page.locator(DOORS[door].entry).getAttribute('data-feedback-marked')).toBe('false')
      }
      healthy(s)
      await s.page.unroute(failure === 'transport' ? '**/mark' : '**/detail')
      // Explicit retry, with no confirmation; already-marked remains one ledger row.
      await composer.locator('[data-feedback-submit]').click()
      const recorded = await recordedSentence(composer)
      await settled(composer, recorded)
      expect(s.rows()).toHaveLength(1)
      expect(await composer.locator('[data-feedback-note]').inputValue()).toBe('')
      expect(await s.page.locator(DOORS[door].entry).getAttribute('data-feedback-marked')).toBe('true')
      healthy(s)
    }, 45_000)
  }

  it('one submit is one mark request, and a reload shows the applied change', async () => {
    const s = await scene()
    await noConfirmChannel(s.page)
    // false-fail is the choice whose fix the fixture's mark host applies (the themes cell's own).
    const composer = await submit(s.page, 'test', 'false-fail')
    await settled(composer, await recordedSentence(composer))
    expect(s.marks, 'one submit did not send exactly one mark request').toHaveLength(1)
    expect(s.marks[0]).toMatchObject({ kind: 'false-fail' })
    expect(s.marks[0]).not.toHaveProperty('confirm' + 'Scope')
    expect(s.rows()).toHaveLength(1)

    await s.page.reload()
    await s.page.locator(`${TEST_ENTRY}[data-feedback-marked="true"]`).waitFor()
    const reopened = await openComposer(s.page, 'test')
    const entry = targetEntries(reopened).first()
    await entry.waitFor()
    expect(await entryChoice(entry)).toBe(CHOICE_LABELS['false-fail'])
    const applied = entry.locator('[data-history-applied]')
    expect(['knowledge', 'test-file']).toContain(await applied.getAttribute('data-history-applied'))
    expect(await s.page.locator('[data-history-review], [data-review-command]').count()).toBe(0)
    expect(await approval(s.page).count()).toBe(0)
    expect(await s.page.locator('[data-feedback-approval], [data-feedback-approval-waiting], [data-confirm-answer]').count()).toBe(0)
    expect(await s.page.locator('[role="dialog"], [aria-modal]').count()).toBe(0)
    await noConfirmChannel(s.page)
    expect(s.marks).toHaveLength(1)
    healthy(s)
  }, 60_000)

  it('renders readable selected controls in both themes and retains requested captures', async () => {
    const s = await scene()
    const measurements: unknown[] = []
    for (const theme of ['dark', 'light']) {
      await s.page.evaluate(theme => localStorage.setItem('vite-ui-theme', theme), theme)
      await s.page.reload()
      await s.page.locator(TEST_ENTRY).waitFor()
      for (const door of ['test', 'step'] as const) {
        if (door === 'step') await revealStepEntry(s.page)
        await tabTo(s.page, DOORS[door].entry)
        await s.page.keyboard.press('Enter')
        await s.page.locator(`${COMPOSER}[data-feedback-target="${DOORS[door].address}"]`).waitFor()
        const composer = s.page.locator(COMPOSER)
        for (const kind of ['false-fail', 'false-pass', 'confirmed-bug']) {
          await choice(composer, kind).click()
          expect(await choice(composer, kind).getAttribute('aria-checked')).toBe('true')
          expect(await composer.locator('[role="radio"][aria-checked="true"]').count()).toBe(1)
          expect(await composer.locator('[data-feedback-submit]').textContent()).toBe('Send feedback')
        }
        await previewCurrent(composer)
        await s.page.mouse.move(1400, 100)
        await composer.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))) })
        const measures = await composer.locator('[data-feedback-choice], [data-feedback-submit], [data-feedback-close]').evaluateAll(elements => elements.map(element => {
          const style = getComputedStyle(element), bounds = element.getBoundingClientRect()
          const radio = element.querySelector('[role="radio"]')
          return { text: element.textContent, font: parseFloat(style.fontSize), width: bounds.width, height: bounds.height, pressed: radio?.getAttribute('aria-checked') ?? null, border: style.borderColor, background: style.backgroundColor }
        }))
        expect(measures).toHaveLength(5)
        for (const measure of measures) {
          expect(measure.font).toBeGreaterThanOrEqual(12)
          expect(measure.width).toBeGreaterThanOrEqual(32)
          expect(measure.height).toBeGreaterThanOrEqual(32)
        }
        expect(measures.find(m => m.pressed === 'true')?.border).not.toBe(measures.find(m => m.pressed === 'false')?.border)
        measurements.push({ theme, door, measures })
      }
      // Explicit output opt-in must retain this browser scene, without touching prior evidence.
      await retainCapture(s.page, `marks-${theme}.png`)
      if (RECHECK_DIR) expect(existsSync(join(RECHECK_DIR, `marks-${theme}.png`))).toBe(true)
    }
    expect(s.rows()).toHaveLength(0)
    // no approval group is rendered, so the mark is sent with Enter on the submit control.
    const composer = await openComposer(s.page, 'test')
    await choice(composer, 'false-fail').click()
    await previewCurrent(composer)
    await tabTo(s.page, `${COMPOSER} [data-feedback-submit]`)
    await s.page.keyboard.press('Enter')
    await settled(composer, await recordedSentence(composer))
    expect(await approval(s.page).count()).toBe(0)
    expect(await s.page.locator('[role="dialog"], [aria-modal]').count()).toBe(0)
    expect(s.rows()).toHaveLength(1)
    expect(await composer.locator('[data-feedback-note]').inputValue()).toBe('')
    // RE-SPELLED 432-09 from '423 D-19: the drafted receipt's review control copies a
    // runnable CLI command': the mark applied its fix, so the entry states what changed, as text,
    // and offers no review control or link.
    const applied = targetEntries(composer).first().locator('[data-history-applied]')
    expect(['knowledge', 'test-file']).toContain(await applied.getAttribute('data-history-applied'))
    expect(await applied.isVisible()).toBe(true)
    expect(await composer.locator('[data-history-review], [data-review-command], a[href]').count()).toBe(0)
    await openComposer(s.page, 'step')
    expect(await status(composer).textContent()).toBe('')
    expect(await choice(composer, 'confirmed-bug').getAttribute('aria-checked')).toBe('true')
    await composer.locator('[data-feedback-submit]').click()
    await settled(composer, await recordedSentence(composer))
    expect(s.rows()).toHaveLength(2)
    expect(s.rows().map(row => row.stepIndex)).toEqual([undefined, 0])
    expect(await targetEntries(composer).count()).toBe(1)
    expect(await entryChoice(targetEntries(composer).first())).toBe(CHOICE_LABELS['confirmed-bug'])
    expect(await s.page.locator(STEP_ENTRY).getAttribute('data-feedback-marked')).toBe('true')
    expect(await s.page.locator(TEST_ENTRY).getAttribute('data-feedback-marked')).toBe('true')
    healthy(s)
    await openComposer(s.page, 'test')
    expect(await entryChoice(targetEntries(composer).first())).toBe(CHOICE_LABELS['false-fail'])
    const detailUrl = s.page.url()
    await applied.click()
    expect(await s.page.locator('[data-history-review], [data-review-command]').count()).toBe(0)
    expect(s.page.url()).toBe(detailUrl)
    expect(s.pageErrors).toEqual([])
    expect(s.outsideLoopback).toEqual([])
    if (RECHECK_DIR) writeFileSync(join(RECHECK_DIR, 'measurements.json'), JSON.stringify({
      captured: new Date().toISOString(), viewport: { width: 1440, height: 1100 },
      chromium: browser.version(), executable: chromium.executablePath(),
      freshness: buildFreshness(DASHBOARD_ANCHORED_BUILDS), measurements,
      pageErrors: s.pageErrors, outsideLoopback: s.outsideLoopback,
      keyboard: 'Tab and Enter reached both doors and the submit control (no approval controls since 432-13)',
      finalMarks: s.rows().map(({ kind, ordinal, stepIndex }) => ({ kind, ordinal, stepIndex })),
      ownerPersonallyTested: false, assistiveTechnology: 'unverified',
    }, null, 2))
  }, 60_000)
})
