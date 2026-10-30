/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { guardRunAnalysisArtifact, slugBranch, type RunDetailProjection } from '@vostride/agent-qa-schema'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, recordingFixture, zoomFixtureTab, type RecordingFixture } from './recording-dom-fixture.js'
import { populatedRunSpawnEnv, POPULATED_SECRET_ENV_VAR } from './populated-run-fixture.js'
import { cleanupTempRoots, reserveEphemeralPort, spawnDashboard, trackTempRoot } from './spawned-chat.js'

// Real producer + shipped bundle. Only historical/orphan test arrangements edit the temporary
// durable fixture, explicitly below; no route mocks, fake media, skips or user-workspace captures.
type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.right <= b.right + 0.5 && a.y >= b.y - 0.5 && a.bottom <= b.bottom + 0.5
const failures: Record<string, string> = {}
let fixture: RecordingFixture | undefined
let reader: Awaited<ReturnType<typeof spawnDashboard>> | undefined
let zoomContext: BrowserContext | undefined
let zoom: { factor: number; beforeWidth: number; afterWidth: number; beforeDpr: number; afterDpr: number } | undefined
let timeline: { box: Box; track: Box; thumb: Box; text: string; markers: number; signals: number; inOverview: boolean; percentageMax: number; context: string } | undefined
const tabs: Array<{ width: number; document: number; viewport: number; scroll: number; client: number; moved: number; triggers: Array<{ box: Box; count?: Box; contentFits: boolean }> }> = []
const lightboxes: Array<{ width: number; document: number; viewport: number; height: number; image: Box; dialog: Box; close: Box; notePadding: string[]; loaded: boolean }> = []
let notice: { dismiss: Box; viewport: number; explanation: Box; pane: Box; lines: number; textWidth: number; font: string; totalTextWidth: number; message: string; text: Box; lineBoxes: Box[]; icon: Box } | undefined
let inputTexts: Array<{ width: number; text: Box; row: Box; clip: Box; content: string; visible: boolean }> = []

async function measureInputText(page: Page) {
  const fill = page.locator('[data-sub-action] [data-action-family="input"]').first()
  await fill.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  inputTexts.push(...await fill.locator('.truncate').evaluateAll(elements => {
    const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    return elements.map(text => ({ width: innerWidth, text: box(text), row: box(text.closest('[data-sub-action]')!),
      clip: box(text.closest('[data-action-family]')!), content: (text.textContent ?? '').trim(),
      visible: getComputedStyle(text).visibility !== 'hidden' && text.getBoundingClientRect().width > 0 }))
  }))
}

async function measureTabs(page: Page, name: string) {
  const list = page.locator('[role="tablist"]').first()
  await list.waitFor()
  const result = await list.evaluate(list => {
    const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const client = list.clientWidth
    list.scrollLeft = list.scrollWidth
    return {
      width: innerWidth, document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
      scroll: list.scrollWidth, client, moved: list.scrollLeft,
      triggers: [...list.querySelectorAll('[role="tab"]')].map(trigger => {
        const count = trigger.querySelector('[data-tab-count]')
        return { box: box(trigger), ...(count ? { count: box(count) } : {}), contentFits: trigger.scrollWidth <= trigger.clientWidth + 1 }
      }),
    }
  })
  tabs.push(result)
  await capture(page, name)
  await list.evaluate(list => { list.scrollLeft = 0 })
}

describe('evidence layout backstops on the shipped bundle', () => {
  beforeAll(async () => {
    try {
      fixture = await recordingFixture('evidence-layout', false, true)
      // Finish the post-run tail before modifying synthetic history. The primary production
      // recording run above stays untouched; only this separate layout fixture is arranged.
      const origin = fixture.dashboard.origin
      let settled = false
      for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
        const response = await fetch(`${origin}/api/runs/${encodeURIComponent(fixture!.drive.runId)}/post-processing`)
        const body = await response.json() as { status?: { chips?: Record<string, string> } }
        if (['analysis', 'curation'].every(key => ['complete', 'failed'].includes(body.status?.chips?.[key] ?? ''))) {
          settled = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!settled) throw new Error('Post-run writer did not settle')
      await fixture.dashboard.stop()
      const env = populatedRunSpawnEnv()
      // The fill value is no declared secret, so the page renders it as typed.
      delete env[POPULATED_SECRET_ENV_VAR]
      const port = await reserveEphemeralPort()
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, port, 60_000, env)
      if (!reader.ready) throw new Error(reader.stderr())
      const url = `${reader.origin}/runs/${encodeURIComponent(fixture.drive.runId)}`
      const context = await fixture.browser.newContext({ viewport: { width: 400, height: 800 } })
      const page = await context.newPage()
      await page.goto(url)
      await page.locator('[data-timeline]').waitFor()
      const row = page.locator('[data-step-id]').first()
      await row.locator(':scope > button').click()
      await page.getByRole('radio', { name: 'Frames', exact: true }).click()

      timeline = await page.locator('[data-timeline]').evaluate(timeline => {
        const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
        const slider = timeline.querySelector('[role="slider"]')!
        return { box: box(timeline), track: box(timeline.querySelector('[data-timeline-track]')!), thumb: box(slider),
          text: timeline.textContent ?? '', markers: timeline.querySelectorAll('[data-timeline-marker], [data-timeline-marker-group]').length,
          signals: timeline.querySelectorAll('[data-step-signal], [data-timeline-readout]').length,
          inOverview: !!timeline.closest('[data-overview]'), percentageMax: Number(slider.getAttribute('aria-valuemax')),
          context: slider.getAttribute('aria-valuetext') ?? '',
        }
      })
      await capture(page, 'timeline-400')
      await measureTabs(page, 'tab-strip-400')
      await measureInputText(page)
      await capture(page, 'input-text-400')
      await page.setViewportSize({ width: 1280, height: 800 })
      await measureInputText(page)
      await capture(page, 'input-text-desktop')
      await page.setViewportSize({ width: 1920, height: 800 })
      await measureInputText(page)
      await capture(page, 'input-text-wide-control')
      await page.setViewportSize({ width: 400, height: 800 })

      // Density and real browser zoom are separate checks. The temporary MV3 extension exists
      // only in an isolated test profile and uses Chrome's own setZoom/getZoom APIs.
      // https://playwright.dev/docs/chrome-extensions
      // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
      const dense = await fixture.browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
      const densePage = await dense.newPage()
      await densePage.goto(url)
      await measureTabs(densePage, 'tab-strip-desktop-2x-density')
      await dense.close()
      const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-424-zoom-')))
      const extension = join(zoomRoot, 'extension')
      mkdirSync(extension)
      writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
        name: 'Local evidence zoom probe', version: '1.0',
        host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
      writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
      zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
        channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      })
      const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
      const zoomPage = await zoomContext.newPage()
      await zoomPage.goto(url)
      const before = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
      const factor = await zoomFixtureTab(worker, url, 2)
      await zoomPage.waitForFunction(dpr => devicePixelRatio >= dpr * 1.99, before.dpr)
      const after = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
      zoom = { factor, beforeWidth: before.width, afterWidth: after.width, beforeDpr: before.dpr, afterDpr: after.dpr }
      await measureTabs(zoomPage, 'tab-strip-browser-200-percent')
      await zoomContext.close()
      zoomContext = undefined

      // SQL NULL in the additive fields is the migrated older shape; no new data is invented.
      await reader.stop()
      const db = new DatabaseSync(join(fixture.project.agentQaRoot, 'runs.db'))
      db.prepare('UPDATE run_members SET recording_json = NULL WHERE run_id = ?').run(fixture.drive.runId)
      db.prepare('UPDATE run_steps SET evidence_json = NULL WHERE run_id = ?').run(fixture.drive.runId)
      db.prepare('UPDATE run_sub_actions SET evidence_state_json = NULL, recording_offset_ms = NULL WHERE run_id = ?').run(fixture.drive.runId)
      db.close()
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, port, 60_000, env)
      await page.goto(url)
      await page.locator('[data-run-notice]').waitFor()
      await page.getByRole('tab', { name: /^Variables/ }).click()
      await page.locator('[data-evidence-state="unavailable"]').waitFor()
      notice = await page.evaluate(() => {
        const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
        const notice = document.querySelector('[data-run-notice]')!
        const text = notice.querySelector(':scope > span')!
        const pane = document.querySelector('[data-evidence-state="unavailable"]')!
        const style = getComputedStyle(text)
        const canvas = document.createElement('canvas').getContext('2d')!
        canvas.font = style.font
        const range = document.createRange()
        range.selectNodeContents(text)
        const lineBoxes = [...range.getClientRects()].map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }))
        return { dismiss: box(notice.querySelector('button')!), viewport: innerWidth,
          explanation: box(pane.querySelector('p')!), pane: box(pane),
          lines: box(text).height / parseFloat(style.lineHeight), textWidth: box(text).width,
          font: style.font, totalTextWidth: canvas.measureText(text.textContent ?? '').width, message: text.textContent ?? '',
          text: box(text), lineBoxes, icon: box(notice.querySelector(':scope > svg')!) }
      })
      await capture(page, 'notice-and-absence-400')
      await capture(page, 'notice-wrap-400')

      // Orphan citation fixture: preserve a real screenshot blob, remove only its marker refs,
      // and seed the typed analysis artifact citing it. No browser response is intercepted.
      const detail = await fetch(`${reader.origin}/api/runs/${encodeURIComponent(fixture.drive.runId)}/detail`).then(r => r.json()) as RunDetailProjection
      const ref = detail.subActions.flatMap(sub => sub.artifactRefs ?? []).find(ref => ref.id.startsWith('decision-screenshot:'))
      if (!ref) throw new Error('Real producer emitted no screenshot for orphan layout fixture')
      await reader.stop()
      const orphanDb = new DatabaseSync(join(fixture.project.agentQaRoot, 'runs.db'))
      orphanDb.prepare('UPDATE run_sub_actions SET artifact_refs = NULL WHERE run_id = ?').run(fixture.drive.runId)
      orphanDb.prepare("UPDATE run_members SET outcome = 'failed' WHERE run_id = ? AND test_index = 0").run(fixture.drive.runId)
      orphanDb.close()
      const analysisPath = join(fixture.project.agentQaRoot, 'runs', slugBranch(fixture.drive.runId), 'analysis.json')
      const artifact = JSON.parse(readFileSync(analysisPath, 'utf8'))
      artifact.verdicts = [{ class: 'app_bug', producer: 'analyze-run', confidence: 1, perTest: 0,
        memoryMisdirectionRuledOut: true, evidence: { citedSteps: [0], citedAnchors: [], citedArtifacts: [{ id: ref.id, sha: ref.sha }], rationale: 'Synthetic orphan layout fixture' } }]
      artifact.parts = []
      guardRunAnalysisArtifact(artifact)
      writeFileSync(analysisPath, JSON.stringify(artifact))
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, port, 60_000, env)
      for (const width of [400, 1280]) {
        await page.setViewportSize({ width, height: 800 })
        await page.goto(url)
        await page.locator('button[data-cited-artifact]').first().click()
        await page.locator('[data-player-lightbox] img').waitFor()
        await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-player-lightbox] img')?.naturalWidth)
        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-player-lightbox]')!).opacity === '1')
        lightboxes.push(await page.evaluate(() => {
          const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
          const image = document.querySelector<HTMLImageElement>('[data-player-lightbox] img')!
          const note = getComputedStyle(document.querySelector('[data-player-lightbox] [data-slot="dialog-description"]')!)
          return { width: innerWidth, viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth,
            height: innerHeight, close: box(document.querySelector('[data-player-lightbox] [aria-label="Close screenshot"]')!),
            notePadding: [note.paddingTop, note.paddingBottom],
            image: box(image), dialog: box(document.querySelector('[data-player-lightbox]')!), loaded: image.complete && image.naturalWidth > 0 }
        }))
        await capture(page, `lightbox-${width}`)
        await page.getByRole('button', { name: 'Close screenshot', exact: true }).click()
        await page.locator('[data-player-lightbox]').waitFor({ state: 'hidden' })
      }
      if (process.env.AGENT_QA_CAPTURE_DIR) writeFileSync(join(process.env.AGENT_QA_CAPTURE_DIR, 'layout-observation.json'), JSON.stringify({ timeline, tabs, zoom, notice, lightboxes, inputTexts }, null, 2))
      await context.close()
    } catch (error) { failures.drive = String(error) }
  }, 360_000)

  afterAll(async () => { await zoomContext?.close(); await reader?.stop(); await fixture?.close(); cleanupTempRoots() })
  it('LAYOUT-TIMELINE-400', () => {
    expect(timeline, JSON.stringify(failures)).toBeDefined()
    expect(timeline!.inOverview).toBe(true)
    expect(timeline!.text).toBe('')
    expect(timeline!.markers).toBeGreaterThan(0)
    expect(timeline!.signals).toBe(0)
    expect(timeline!.box.height).toBeLessThanOrEqual(64)
    expect(inside(timeline!.track, timeline!.box)).toBe(true)
    expect(inside(timeline!.thumb, timeline!.box)).toBe(true)
    expect(timeline!.percentageMax).toBe(100)
    expect(timeline!.context).toMatch(/sub-action \d+ of 14/)
  })
  it('LAYOUT-TAB-STRIP-400-AND-ZOOM', () => {
    expect(tabs.length, JSON.stringify(failures)).toBe(3)
    expect(zoom?.factor, JSON.stringify(failures)).toBe(2)
    expect(zoom!.afterWidth).toBe(zoom!.beforeWidth / 2)
    expect(zoom!.afterDpr).toBe(zoom!.beforeDpr * 2)
    for (const tab of tabs) {
      expect(tab.document).toBeLessThanOrEqual(tab.viewport)
      expect(tab.triggers.length).toBe(7)
      if (tab.scroll > tab.client) expect(tab.moved).toBeGreaterThan(0)
      for (const trigger of tab.triggers) {
        expect(trigger.contentFits).toBe(true)
        if (trigger.count) expect(inside(trigger.count, trigger.box)).toBe(true)
      }
    }
  })
  it('LAYOUT-NOTICE-AND-ABSENCE-400', () => {
    expect(notice, JSON.stringify(failures)).toBeDefined()
    expect(notice!.dismiss.right).toBeLessThanOrEqual(notice!.viewport)
    expect(notice!.explanation.width).toBeLessThanOrEqual(notice!.pane.width)
    // The 400px pane affords 304px of text, while the locked 12px copy measures 693px.
    // The owner approved three readable lines at 400px. Preserve the copy/chrome and
    // prove that every line and the dismissal remain visible without overlap.
    expect(notice!.lines).toBe(3)
    expect(notice!.message).toBe('This run was recorded before evidence was saved. Variables, network, console, ARIA, accessibility and video were not recorded.')
    for (const line of notice!.lineBoxes) expect(inside(line, notice!.text)).toBe(true)
    expect(overlaps(notice!.text, notice!.dismiss)).toBe(false)
    expect(overlaps(notice!.text, notice!.icon)).toBe(false)
  })
  it('LAYOUT-LIGHTBOX-FITS', () => {
    expect(lightboxes.length, JSON.stringify(failures)).toBe(2)
    for (const lightbox of lightboxes) {
      expect(lightbox.loaded).toBe(true)
      expect(lightbox.document).toBeLessThanOrEqual(lightbox.viewport)
      expect(inside(lightbox.image, lightbox.dialog)).toBe(true)
      expect(lightbox.dialog.x).toBeGreaterThanOrEqual(0)
      expect(lightbox.dialog.right).toBeLessThanOrEqual(lightbox.viewport)
      expect(lightbox.dialog.y).toBeGreaterThanOrEqual(0)
      expect(lightbox.dialog.bottom).toBeLessThanOrEqual(lightbox.height)
      expect(inside(lightbox.close, lightbox.dialog)).toBe(true)
      expect(lightbox.notePadding).toEqual(['32px', '32px'])
    }
  })
  it('LAYOUT-INPUT-TEXT-TRUNCATION', () => {
    expect(inputTexts.map(entry => entry.width).sort((a, b) => a - b), JSON.stringify(failures)).toEqual([400, 1280, 1920])
    for (const entry of inputTexts) {
      expect(entry.visible, JSON.stringify(entry)).toBe(true)
      expect(entry.content, JSON.stringify(entry)).toBeTruthy()
      expect(inside(entry.text, entry.row) && inside(entry.text, entry.clip), JSON.stringify(entry)).toBe(true)
    }
  })
})
