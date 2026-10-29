/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunDetailProjection } from '@vostride/agent-qa-schema'
import { chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { capture, recordingFixture, type RecordingFixture } from './recording-dom-fixture.js'
import { cleanupTempRoots, trackTempRoot } from './spawned-chat.js'

// Real producer, server, page and CSS. Explicit response arrangements exercise historical
// absence/capture failure and long-duration metadata; they are layout fixtures, not live claims.
let fixture: RecordingFixture
let detail: RunDetailProjection
let url: string
const observations: Record<string, unknown> = {}
beforeAll(async () => {
  fixture = await recordingFixture('review-layout')
  url = `${fixture.dashboard.origin}/runs/${encodeURIComponent(fixture.drive.runId)}`
  detail = await fetch(`${fixture.dashboard.origin}/api/runs/${encodeURIComponent(fixture.drive.runId)}/detail`).then(r => r.json()) as RunDetailProjection
}, 360_000)
afterAll(async () => {
  if (process.env.AGENT_QA_424_CAPTURE_DIR) writeFileSync(join(process.env.AGENT_QA_424_CAPTURE_DIR, 'review-layout-observations.json'), JSON.stringify(observations, null, 2))
  await fixture?.close()
  cleanupTempRoots()
})

it('REVIEW-MINIMAL-OVERVIEW: one and many actions keep annotations aligned at desktop and 400px', async () => {
  const measured = []
  // Explicit geometry arrangement over the shipped page/server. The SVG is synthetic evidence,
  // not an owner capture or a claim about the producer's timing/annotation accuracy.
  const screenshot = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#f7f8fa"/><text x="40" y="60" font-size="28" fill="#263648">Products</text>'
    + [200, 400, 600].map((x, i) => `<rect x="${x - 60}" y="260" width="120" height="80" rx="8" fill="#fff" stroke="#718096"/><text x="${x}" y="305" text-anchor="middle" font-size="18" fill="#263648">Item ${i + 1}</text>`).join('') + '</svg>'
  for (const count of [1, 3]) for (const width of [1280, 400]) {
    const page = await fixture.browser.newPage({ viewport: { width, height: 900 } })
    try {
      const projection = structuredClone(detail)
      const base = projection.subActions.find(sub => sub.artifactRefs?.some(ref => ref.id.startsWith('decision-screenshot:')))!
      expect(base).toBeDefined()
      const ref = base.artifactRefs!.find(ref => ref.id.startsWith('decision-screenshot:'))!
      projection.members = projection.members.filter(member => member.testIndex === base.testIndex)
      projection.steps = projection.steps.filter(step => step.testIndex === base.testIndex && step.stepIndex === base.stepIndex)
      projection.subActions = Array.from({ length: count }, (_, index) => ({
        ...structuredClone(base), subActionIndex: index, recordingOffsetMs: undefined,
        grounding: { descriptor: { role: 'button', name: `\uF291 Products ${index + 1}` }, attempts: [] },
        result: { success: true, annotation: { kind: 'point' as const, viewport: { width: 800, height: 600 },
          point: { x: (index + 1) * 200, y: 300, boundingBox: { x: (index + 1) * 200 - 60, y: 260, width: 120, height: 80 } } } },
      }))
      await page.route(`**/artifacts/${ref.sha}`, route => route.fulfill({ contentType: 'image/svg+xml', body: screenshot }))
      await page.addInitScript(() => localStorage.setItem('agent-qa.run-detail.player-source', 'frames'))
      await arrange(page, projection)
      await page.locator('[data-annotation="point"]').waitFor()
      await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[data-player] img')?.naturalWidth === 800)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const observation = await page.locator('[data-overview]').evaluate((overview, count) => {
        const image = overview.querySelector<HTMLImageElement>('img')!
        const box = image.getBoundingClientRect()
        const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight)
        const dot = overview.querySelector('[data-annotation="point"]')!.getBoundingClientRect()
        const region = overview.querySelector('[data-annotation="region"]')!.getBoundingClientRect()
        const timeline = overview.querySelector('[data-timeline]')!
        return { count, width: innerWidth, image: { width: box.width, height: box.height },
          expectedX: box.x + (box.width - 800 * scale) / 2 + count * 200 * scale,
          expectedY: box.y + (box.height - 600 * scale) / 2 + 300 * scale,
          actualX: dot.x + dot.width / 2, actualY: dot.y + dot.height / 2,
          regionWidth: region.width, expectedRegionWidth: 120 * scale,
          title: overview.querySelector('[data-player-caption]')!.textContent,
          timelineText: timeline.textContent, timelineHeight: timeline.getBoundingClientRect().height,
          markers: timeline.querySelectorAll('[data-timeline-marker], [data-timeline-marker-group]').length,
          signals: timeline.querySelectorAll('[data-step-signal]').length,
          scopeLines: overview.querySelectorAll('[data-evidence-scope]').length,
          connectors: [...document.querySelectorAll('[data-step-id]')].map(step => getComputedStyle(step, '::before').content),
          rows: [...document.querySelectorAll('[data-sub-action]')].map(row => row.textContent),
        }
      }, count)
      measured.push(observation)
      expect(Math.abs(observation.actualX - observation.expectedX), JSON.stringify(observation)).toBeLessThan(1)
      expect(Math.abs(observation.actualY - observation.expectedY)).toBeLessThan(1)
      expect(Math.abs(observation.regionWidth - observation.expectedRegionWidth)).toBeLessThan(1)
      expect(observation.title).toBe(`Clicked 'Products ${count}'`)
      expect(observation.timelineText).toBe('')
      expect(observation.timelineHeight).toBeLessThanOrEqual(64)
      expect(observation.markers).toBeGreaterThan(0)
      expect(observation.signals).toBe(0)
      expect(observation.scopeLines).toBe(0)
      expect(observation.rows).toEqual(Array.from({ length: count }, (_, index) => `Clicked 'Products ${index + 1}'`))
      expect(observation.connectors.every(content => content === 'none' || content === 'normal')).toBe(true)
      await footerGeometry(page, width >= 1280)
      await capture(page, `owner-overview-${count}-actions-${width}`)
      const slider = page.getByRole('slider')
      await slider.focus()
      await slider.press('Home')
      await expect.poll(() => page.locator('[data-player-caption]').textContent()).toBe("Clicked 'Products 1'")
      const track = await page.locator('[data-timeline-track]').boundingBox()
      await page.mouse.click(track!.x + track!.width - 1, track!.y + track!.height / 2)
      await expect.poll(() => page.locator('[data-player-caption]').textContent()).toBe(`Clicked 'Products ${count}'`)
      // Selection renders before the page's replace-navigation effect commits the URL.
      await expect.poll(() => new URL(page.url()).searchParams.get('sub')).toBe(String(count - 1))
      await page.getByRole('tab', { name: /^Network/ }).click()
      expect(await page.locator('[data-timeline]').count()).toBe(0)
      await page.getByRole('tab', { name: 'Overview', exact: true }).click()
      await page.getByRole('radio', { name: 'Video', exact: true }).click()
      expect(await page.locator('[data-annotation]').count()).toBe(0)
      await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)
      await footerGeometry(page, width >= 1280)
      await capture(page, `owner-video-${count}-actions-${width}`)
      await page.getByRole('radio', { name: 'Frames', exact: true }).click()
      await page.locator('[data-annotation="point"]').waitFor()
    } finally { await page.close() }
  }
  observations.ownerOverview = measured
}, 120_000)

async function arrange(page: Page, projection: RunDetailProjection) {
  await page.route('**/api/runs/*/detail', route => route.fulfill({ json: projection }))
  await page.goto(url)
  await page.locator('[data-step-id]').first().waitFor()
  await page.locator('[data-step-id]').first().locator(':scope > button').click()
}

async function footerGeometry(page: Page, desktop = false) {
  const geometry = await page.locator('[data-player]').evaluate(player => {
    const preview = player.querySelector('[data-player-preview]')!
    const footer = player.querySelector('[data-player-footer]')!
    const media = preview.querySelector('[data-media-viewport]') ?? preview
    const caption = footer.querySelector('[data-player-caption]')!.getBoundingClientRect()
    const controls = footer.querySelector('[data-player-controls]')!.getBoundingClientRect()
    const scrub = footer.querySelector('[data-timeline]')!.getBoundingClientRect()
    const rect = footer.getBoundingClientRect()
    return {
      source: player.getAttribute('data-player-source'), width: innerWidth,
      ordered: preview.nextElementSibling === footer && Boolean(footer.firstElementChild?.matches('[data-player-timeline-row]')),
      mediaGap: rect.top - media.getBoundingClientRect().bottom, footerHeight: rect.height,
      controlsBelowBar: controls.top >= scrub.bottom, captionBelowBar: caption.top >= scrub.bottom,
      sameRow: Math.abs(caption.top + caption.height / 2 - controls.top - controls.height / 2) < 1,
      nonOverlap: caption.right <= controls.left || caption.bottom <= controls.top,
      contained: [caption, controls].every(box => box.left >= rect.left && box.right <= rect.right),
      metadata: document.querySelectorAll('[data-overview] [data-token-summary], [data-overview] [data-screen-state], [data-overview] [data-screen-state-change]').length,
    }
  })
  expect(geometry.ordered, JSON.stringify(geometry)).toBe(true)
  expect(geometry.mediaGap).toBeGreaterThanOrEqual(0)
  expect(geometry.mediaGap).toBeLessThanOrEqual(4)
  expect(geometry.controlsBelowBar).toBe(true)
  expect(geometry.captionBelowBar).toBe(true)
  expect(geometry.nonOverlap).toBe(true)
  expect(geometry.contained).toBe(true)
  expect(geometry.metadata).toBe(0)
  expect(geometry.footerHeight).toBeLessThanOrEqual(desktop ? 160 : 300)
  ;((observations.footers ??= []) as unknown[]).push(geometry)
}

it('REVIEW-ABSENCE-LAYOUT: assembled evidence tabs preserve flex centering and 8px gaps', async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 400, height: 800 } })
  const measured = []
  try {
    for (const reason of ['unavailable', 'failed'] as const) {
      const projection = structuredClone(detail)
      for (const step of projection.steps) step.evidence = {
        variables: { kind: 'variables', state: 'absent', reason },
        console: { kind: 'console', state: 'absent', reason },
        network: { kind: 'network', state: 'absent', reason },
        a11y: { kind: 'a11y', state: 'absent', reason },
      }
      for (const sub of projection.subActions) sub.ariaEvidence = { kind: 'aria', state: 'absent', reason }
      await page.unroute('**/api/runs/*/detail')
      await arrange(page, projection)
      for (const [label, kind] of [['Variables', 'variables'], ['Network', 'network'], ['Console', 'console'], ['A11y', 'a11y'], ['ARIA Tree', 'aria']]) {
        await page.getByRole('tab', { name: new RegExp(`^${label}`) }).click()
        const pane = page.locator(`[role="tabpanel"][data-state="active"] [data-evidence-kind="${kind}"]`)
        await pane.waitFor()
        measured.push(await pane.evaluate((pane, reason) => {
          const style = getComputedStyle(pane)
          const box = pane.getBoundingClientRect()
          const icon = pane.querySelector('svg')!.getBoundingClientRect()
          const title = pane.querySelector('span')!.getBoundingClientRect()
          return { kind: pane.getAttribute('data-evidence-kind'), reason, display: style.display,
            gap: style.gap, centerDelta: Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2),
            measuredGap: title.y - icon.bottom, role: pane.getAttribute('role'), state: pane.getAttribute('data-evidence-state') }
        }, reason))
        await capture(page, `review-${kind}-${reason}-400`)
      }
    }
    observations.absence = measured
    for (const row of measured) {
      expect(row.display, JSON.stringify(row)).toBe('flex')
      expect(row.gap).toBe('8px')
      expect(row.centerDelta).toBeLessThan(1)
      expect(row.measuredGap).toBeCloseTo(8, 0)
      expect(row.state).toBe(row.reason)
      expect(row.role).toBe(row.reason === 'failed' ? 'alert' : 'status')
    }
  } finally { await page.close() }
}, 120_000)

async function controls(page: Page, name: string, axis: 'time' | 'ordinal') {
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const initialSource = await page.locator('[data-player]').getAttribute('data-player-source')
  expect(initialSource).toBe(axis === 'ordinal' ? 'frames' : 'video')
  expect(await page.evaluate(() => localStorage.getItem('agent-qa.run-detail.player-source'))).toBe('video')
  await page.getByRole('radio', { name: 'Video', exact: true }).click()
  await page.locator('video').waitFor()
  await page.waitForFunction(() => document.querySelector('video')!.readyState >= 1)
  await footerGeometry(page)
  const railBefore = await page.locator('[data-timeline-track]').boundingBox()
  // Explicit long-duration layout data, including late elapsed time. Do not seek
  // real short fixture bytes to an invented 111-hour instant.
  await page.locator('video').evaluate(video => {
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 399_999 })
    video.dispatchEvent(new Event('timeupdate'))
  })
  await expect.poll(() => page.locator('[data-player-time]').textContent()).toBe('111:06:39 / 111:06:40')
  const railAfter = await page.locator('[data-timeline-track]').boundingBox()
  expect(railAfter!.x).toBe(railBefore!.x)
  expect(railAfter!.width).toBe(railBefore!.width)
  expect(railAfter!.width).toBeGreaterThan(70)
  for (const token of await page.locator('[data-player-timestamp]').all()) {
    const geometry = await token.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, font: getComputedStyle(element).fontSize, viewport: innerWidth }
    })
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.font).toBe('12px')
  }
  const result = await page.locator('[data-player]').evaluate(player => {
    const box = player.getBoundingClientRect()
    const controls = [...player.querySelectorAll('[data-slot="toggle-group-item"],button[aria-label="Play recording"],button[aria-label="Playback speed"],[data-player-time]')]
    return { viewport: innerWidth, dpr: devicePixelRatio, left: box.left, right: box.right,
      controls: controls.map(element => { const r = element.getBoundingClientRect(); return {
        label: element.textContent || element.getAttribute('aria-label'), left: r.left, right: r.right,
        width: r.width, font: getComputedStyle(element).fontSize, toggle: element.hasAttribute('data-slot') && element.getAttribute('data-slot') === 'toggle-group-item',
      } }) }
  })
  await capture(page, name)
  await page.locator('video').evaluate(video => { Reflect.deleteProperty(video, 'currentTime') })
  // Keep the actual element identity across speed/time/play state updates; a remount resets media.
  await page.locator('video').evaluate(video => video.setAttribute('data-review-identity', 'original'))
  const rates = []
  for (const speed of [0.5, 1, 2, 4, 8, 16]) {
    await page.getByRole('combobox', { name: 'Playback speed', exact: true }).click()
    expect(await page.getByRole('option').allTextContents()).toEqual(['0.5×', '1×', '2×', '4×', '8×', '16×'])
    await page.getByRole('option', { name: `${speed}×`, exact: true }).click()
    const rate = await page.locator('video[data-review-identity="original"]').evaluate(video => (video as HTMLVideoElement).playbackRate)
    expect(rate).toBe(speed)
    rates.push(rate)
  }
  await page.locator('video').evaluate(video => video.addEventListener('play', () => video.setAttribute('data-review-played', 'true'), { once: true }))
  await page.getByRole('button', { name: 'Play recording', exact: true }).click()
  await page.locator('video[data-review-played="true"]').waitFor()
  const video = await page.locator('video').elementHandle()
  await page.getByRole('radio', { name: 'Frames', exact: true }).click()
  expect(await video!.evaluate(video => (video as HTMLVideoElement).paused)).toBe(true)
  return { initialSource, rates, ...result }
}

it('REVIEW-VIDEO-CONTROLS: timed and ordinal long-duration controls fit at 400px and actual browser zoom', async () => {
  const measured = []
  const page = await fixture.browser.newPage({ viewport: { width: 400, height: 800 } })
  const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-review-zoom-')))
  const extension = join(zoomRoot, 'extension')
  mkdirSync(extension)
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local review zoom probe', version: '1.0',
    host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
  writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
  const zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  try {
    const zoomPage = await zoomContext.newPage()
    for (const target of [page, zoomPage]) {
      await target.addInitScript(() => localStorage.setItem('agent-qa.run-detail.player-source', 'video'))
      // This cell is explicitly a long-duration layout arrangement. The positive
      // producer/media alignment proof lives in run-detail-suite-player-dom without this override.
      await target.addInitScript(() => Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 400_000 }))
    }
    for (const axis of ['time', 'ordinal'] as const) {
      const projection = structuredClone(detail)
      for (const member of projection.members) if (member.recording?.state === 'present') member.recording.durationMs = 400_000_000
      if (axis === 'ordinal') delete projection.subActions[0]!.recordingOffsetMs
      await page.unroute('**/api/runs/*/detail')
      await arrange(page, projection)
      measured.push({ axis, ...(await controls(page, `review-video-${axis}-400`, axis)) })
      await zoomPage.unroute('**/api/runs/*/detail')
      await arrange(zoomPage, projection)
      const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
      const factor = await worker.evaluate(async url => {
        const tabs = (globalThis as unknown as { chrome: { tabs: {
          query(query: { url: string }): Promise<Array<{ id?: number }>>
          setZoom(id: number, factor: number): Promise<void>
          getZoom(id: number): Promise<number>
        } } }).chrome.tabs
        const [tab] = await tabs.query({ url })
        if (tab?.id === undefined) throw new Error('No fixture tab')
        await tabs.setZoom(tab.id, 2)
        return tabs.getZoom(tab.id)
      }, zoomPage.url())
      await zoomPage.waitForFunction(() => devicePixelRatio === 2 && innerWidth === 640)
      measured.push({ axis, factor, ...(await controls(zoomPage, `review-video-${axis}-zoom`, axis)) })
    }
    observations.controls = measured
    for (const row of measured) {
      expect(row.controls).toHaveLength(5)
      for (const control of row.controls) {
        expect(control.left, JSON.stringify({ row, control })).toBeGreaterThanOrEqual(row.left)
        expect(control.right, JSON.stringify({ row, control })).toBeLessThanOrEqual(Math.min(row.right, row.viewport))
        if (control.toggle) expect(control.font).toBe('12px')
      }
    }
  } finally { await page.close(); await zoomContext.close() }
}, 120_000)
