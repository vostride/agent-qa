/// <reference lib="dom" />
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunDetailProjection } from '@vostride/agent-qa-schema'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import type { Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordingFixture, capture, type RecordingFixture } from './recording-dom-fixture.js'
import { cleanupTempRoots } from './spawned-chat.js'

// The local model scripts actions; actual Chromium, runner, persisted read, media bytes,
// HTTP ranges and shipped dashboard provide the positive recording witness.
let fixture: RecordingFixture
let detail: RunDetailProjection
let url: string
const observations: Record<string, unknown> = {}
beforeAll(async () => {
  fixture = await recordingFixture('suite-player', false, true, true)
  url = `${fixture.dashboard.origin}/runs/${encodeURIComponent(fixture.drive.runId)}`
  detail = await fetch(`${fixture.dashboard.origin}/api/runs/${encodeURIComponent(fixture.drive.runId)}/detail`).then(r => r.json()) as RunDetailProjection
}, 360_000)
afterAll(async () => {
  if (process.env.AGENT_QA_CAPTURE_DIR) writeFileSync(join(process.env.AGENT_QA_CAPTURE_DIR, 'suite-player-observations.json'), JSON.stringify(observations, null, 2))
  await fixture?.close()
  cleanupTempRoots()
})

async function ready(page: Page) {
  await page.goto(url)
  await page.locator('[data-step-id]').first().waitFor()
  await page.locator('[data-media-durations-ready="true"]').waitFor()
}
async function mediaReady(page: Page) {
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
}
async function seek(page: Page, seconds: number) {
  await page.locator('video').evaluate(async (video, seconds) => {
    const media = video as HTMLVideoElement
    media.pause()
    if (Math.abs(media.currentTime - seconds) < 0.0001) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seeked timeout')), 10_000)
      media.addEventListener('seeked', () => { clearTimeout(timer); resolve() }, { once: true })
      media.currentTime = seconds
    })
  }, seconds)
}

// One captured pointer, through every member and back. Identity is checked at every
// move so a replacement track cannot pass merely by processing independent clicks.
function clockLabel(seconds: number) {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
// Summed in whole microseconds, durations that make a whole second total exactly that second;
// added as floats they can fall just short of it and read the second before.
function suiteSeconds(durations: readonly number[]) {
  return durations.reduce((sum, value) => sum + Math.round(value * 1_000_000), 0) / 1_000_000
}
async function assertSuiteClock(page: Page, durations: number[], member: number) {
  const prefix = suiteSeconds(durations.slice(0, member))
  const total = suiteSeconds(durations)
  await expect.poll(() => page.locator('[data-player-time]').evaluate((element, prefix) =>
    Math.abs(Number((element as HTMLElement).dataset.playerElapsedMs) / 1000 - prefix - document.querySelector('video')!.currentTime), prefix)).toBeLessThan(0.001)
  const row = await page.locator('[data-player-time]').evaluate(element => ({ elapsedMs: Number((element as HTMLElement).dataset.playerElapsedMs), totalMs: Number((element as HTMLElement).dataset.playerTotalMs), text: element.textContent }))
  expect(row.totalMs / 1000).toBeCloseTo(total, 5)
  expect(row.text).toBe(`${clockLabel(row.elapsedMs / 1000)} / ${clockLabel(total)}`)
  return row
}

async function dragSuite(page: Page, durations?: number[]) {
  const track = page.locator('[data-timeline-track]')
  await track.evaluate(element => { (window as unknown as { dragTrack: Element }).dragTrack = element })
  const bounds = (await track.boundingBox())!
  const spans = await page.locator('[data-timeline-member-span]').evaluateAll(elements => elements.map(element => {
    const style = (element as HTMLElement).style
    return { start: parseFloat(style.left) / 100, width: parseFloat(style.width) / 100 }
  }))
  const centres = durations ? detail.subActions.map(action => {
    const span = spans[action.testIndex]!
    const witness = action.result.annotation?.recording
    const offset = witness ? (witness.startMs + witness.endMs) / 2 : action.recordingOffsetMs!
    return span.start + span.width * offset / 1000 / durations[action.testIndex]!
  }) : []
  const positions = spans.flatMap(span => {
    const candidates = durations ? Array.from({ length: 81 }, (_, index) => (index + 10) / 100)
      .filter(local => centres.every(centre => Math.abs(span.start + span.width * local - centre) * bounds.width > 14)) : [0.55, 0.7, 0.85]
    expect(candidates.length, 'Three real free-time positions outside the existing 12px magnetic snap').toBeGreaterThanOrEqual(3)
    return [candidates[0]!, candidates[Math.floor(candidates.length / 2)]!, candidates.at(-1)!]
      .map(local => ({ fraction: span.start + span.width * local, local }))
  })
  const rows = []
  await page.mouse.move(bounds.x + bounds.width * 0.03, bounds.y + 2)
  await page.mouse.down()
  try {
    for (const target of [...positions, ...positions.slice().reverse()]) {
      await page.mouse.move(bounds.x + bounds.width * target.fraction, bounds.y + 2)
      const member = spans.findIndex(span => target.fraction >= span.start && target.fraction < span.start + span.width)
      await expect.poll(() => page.locator('[data-sub-action][aria-selected="true"]').getAttribute('data-sub-action-id')).toMatch(new RegExp(`^${member}:`))
      expect(await track.evaluate(element => element === (window as unknown as { dragTrack: Element }).dragTrack)).toBe(true)
      if (durations) {
        await mediaReady(page)
        await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo(durations[member]! * target.local, 1)
        observations[`clock-drag-${member}`] = await assertSuiteClock(page, durations, member)
      }
      rows.push({ member, fraction: target.fraction, stableTrack: true })
    }
  } finally { await page.mouse.up() }
  return rows
}

function memberSha(testIndex: number) {
  const recording = detail.members.find(member => member.testIndex === testIndex)?.recording
  if (recording?.state !== 'present') throw new Error(`member ${testIndex} has no present recording`)
  return recording.ref.sha
}
const SETTLED_SEEK_TIMEOUT_MS = 10_000
// A click on a new member's source can start more than one seek. The recorder keeps the
// position of the first `seeked` on that source after which no further seek starts.
async function armSettledSeek(page: Page, sha: string) {
  await page.evaluate(sha => {
    const recorder = window as unknown as { settledSeek?: Promise<number>; settledSeekSource?: string }
    recorder.settledSeekSource = sha
    recorder.settledSeek = new Promise<number>(resolve => {
      const settled = (event: Event) => {
        const media = event.target as HTMLMediaElement
        if (!media.currentSrc.includes(sha)) return
        const position = media.currentTime
        // Capture runs before the player's own `seeked` listener; look once dispatch is over.
        setTimeout(() => {
          if (media.seeking || !media.currentSrc.includes(sha)) return
          document.removeEventListener('seeked', settled, true)
          resolve(position)
        }, 0)
      }
      document.addEventListener('seeked', settled, true)
    })
  }, sha)
}
type TailSample = { member0: boolean; time: number; left: string }
async function armTailRecorder(page: Page, sha: string) {
  await page.evaluate(sha => {
    const recorder = window as unknown as { tailSamples?: Promise<TailSample[]> }
    recorder.tailSamples = new Promise<TailSample[]>(resolve => {
      const samples: TailSample[] = []
      const playhead = () => (document.querySelector('[data-timeline-playhead]') as HTMLElement).style.left
      let last = document.querySelector('video')!.currentTime
      let lastLeft = playhead()
      let frames = 0
      // A frame counts once both the media time and the playhead have moved since the last one.
      const frame = () => {
        const video = document.querySelector('video')!
        const left = playhead()
        if (video.currentTime !== last && left !== lastLeft) {
          last = video.currentTime
          lastLeft = left
          const member0 = video.currentSrc.includes(sha)
          samples.push({ member0, time: video.currentTime, left })
          if (!member0 || samples.length >= 4) return resolve(samples)
        }
        if (++frames >= 1_200) return resolve(samples)
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, sha)
}
async function settledSeek(page: Page) {
  return page.evaluate(bound => {
    const recorder = window as unknown as { settledSeek: Promise<number>; settledSeekSource: string }
    let timer = 0
    const expired = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(`no settled seek on source ${recorder.settledSeekSource} within ${bound} ms`)), bound)
    })
    return Promise.race([recorder.settledSeek, expired]).finally(() => window.clearTimeout(timer))
  }, SETTLED_SEEK_TIMEOUT_MS)
}

type MemberSpan = { member: number; start: number; width: number }
async function memberSpans(page: Page): Promise<MemberSpan[]> {
  return page.locator('[data-timeline-member-span]').evaluateAll(elements => elements.map(element => {
    const style = (element as HTMLElement).style
    return {
      member: Number(element.getAttribute('data-timeline-member-span')),
      start: parseFloat(style.left) / 100,
      width: parseFloat(style.width) / 100,
    }
  }))
}
function freeMemberAt(spans: readonly MemberSpan[], fraction: number) {
  const span = spans.find(span => fraction >= span.start && fraction < span.start + span.width)
  if (!span) throw new Error(`no timeline member spans ${fraction}`)
  return span.member
}

async function clickMarker(page: Page, ordinal: number) {
  const marker = page.locator(`[data-timeline-marker="${ordinal}"]`)
  if (await marker.count()) { await marker.click(); return }
  const groups = page.locator('[data-timeline-marker-group]')
  for (let index = 0; index < await groups.count(); index++) {
    await groups.nth(index).click()
    if (await marker.count()) { await marker.click(); return }
    await page.keyboard.press('Escape')
  }
  throw new Error(`Missing action marker ${ordinal}`)
}

async function lensProof(page: Page, point: { x: number; y: number }, name: string) {
  // Fullscreen changes the contain rectangle through ResizeObserver; target the
  // settled media pixels, not the transient pre-observer rectangle.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const media = page.locator('[data-media-transform] > video, [data-media-transform] > img')
  // Wait until the media has a natural size and a box, or `mouse.move` gets a non-finite point.
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement | HTMLImageElement>('[data-media-transform] > video, [data-media-transform] > img')
    if (element === null) return false
    const natural = element instanceof HTMLVideoElement ? element.videoWidth * element.videoHeight : element.naturalWidth * element.naturalHeight
    const rect = element.getBoundingClientRect()
    return natural > 0 && rect.width > 0 && rect.height > 0
  }, undefined, { timeout: 30_000 })
  const origin = await media.evaluate((element, point) => {
    const rect = element.getBoundingClientRect()
    const width = element instanceof HTMLVideoElement ? element.videoWidth : (element as HTMLImageElement).naturalWidth
    const height = element instanceof HTMLVideoElement ? element.videoHeight : (element as HTMLImageElement).naturalHeight
    return { x: rect.x + point.x / width * rect.width, y: rect.y + point.y / height * rect.height }
  }, point)
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
    throw new Error(`The lens origin for ${name} is not a point on the page: ${JSON.stringify(origin)}`)
  }
  if (await page.getByRole('button', { name: 'Enable magnifier', exact: true }).count()) await page.getByRole('button', { name: 'Enable magnifier', exact: true }).click()
  const pressed = page.getByRole('button', { name: 'Disable magnifier', exact: true })
  expect(await pressed.getAttribute('aria-pressed')).toBe('true')
  expect(await pressed.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await page.mouse.move(origin.x, origin.y)
  await page.locator('[data-media-lens]').waitFor({ state: 'visible' })
  const pixels = await page.locator('[data-media-lens]').evaluate((lens, origin) => {
    const canvas = lens.querySelector('canvas')!
    const media = document.querySelector<HTMLVideoElement | HTMLImageElement>('[data-media-transform] > video, [data-media-transform] > img')!
    const box = media.getBoundingClientRect()
    const nativeWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
    const nativeHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
    const scale = box.width / nativeWidth * 2.5
    const oracle = document.createElement('canvas')
    oracle.width = canvas.width; oracle.height = canvas.height
    const context = oracle.getContext('2d')!
    context.drawImage(media, (origin.x - box.x) / box.width * nativeWidth - canvas.width / scale / 2,
      (origin.y - box.y) / box.height * nativeHeight - canvas.height / scale / 2,
      canvas.width / scale, canvas.height / scale, 0, 0, canvas.width, canvas.height)
    const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
    const colours = new Set<number>()
    let error = 0
    for (let index = 0; index < actual.length; index++) error += Math.abs(actual[index]! - expected[index]!)
    for (let index = 0; index < actual.length; index += 4) colours.add(actual[index]! * 65536 + actual[index + 1]! * 256 + actual[index + 2]!)
    const dot = lens.querySelector('[data-annotation="point"]')?.getBoundingClientRect()
    const pixelsBox = canvas.getBoundingClientRect()
    const viewport = document.querySelector('[data-media-viewport]')!.getBoundingClientRect()
    const rect = lens.getBoundingClientRect()
    return { meanPixelError: error / actual.length, colours: colours.size,
      coordinates: { origin, box: box.toJSON(), dot: dot?.toJSON(), pixelsBox: pixelsBox.toJSON(), transform: lens.querySelector('[data-lens-annotation]')?.getAttribute('style') },
      annotationError: dot ? Math.hypot(dot.x + dot.width / 2 - pixelsBox.x - canvas.width / 2, dot.y + dot.height / 2 - pixelsBox.y - canvas.height / 2) : null,
      bounded: rect.left >= viewport.left && rect.right <= viewport.right && rect.top >= viewport.top && rect.bottom <= viewport.bottom }
  }, origin)
  observations[name] = pixels
  await capture(page, name)
  expect(pixels.meanPixelError, JSON.stringify(pixels)).toBeLessThan(2)
  expect(pixels.colours).toBeGreaterThan(10)
  expect(pixels.annotationError, 'The supported action is annotated inside the lens').not.toBeNull()
  expect(pixels.annotationError, JSON.stringify(pixels)).toBeLessThan(1)
  expect(pixels.bounded).toBe(true)
  return pixels
}

it('SUITE-BROWSER-ORDER: arrows cross steps and members in both directions with one boxed action', async () => {
  expect(detail.members).toHaveLength(3)
  // Arrange the historical last-member write only in this isolated fixture database.
  // Both actual consumer pages must receive the measured sum from fresh server reads.
  const database = new DashboardDatabase({ dbPath: join(fixture.project.root, '.agent-qa', 'runs.db') })
  const storedDuration = database.getRun(fixture.drive.runId)!.duration
  const executionMs = detail.members.reduce((sum, member) => sum + member.durationMs!, 0)
  database.updateRun(fixture.drive.runId, { duration: detail.members.at(-1)!.durationMs! })
  const seconds = executionMs / 1000
  const executionLabel = executionMs < 1000 ? `${Math.round(executionMs)}ms`
    : seconds < 60 ? `${Math.round(seconds * 10) / 10}s`
      : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60) ? ` ${Math.round(seconds % 60)}s` : ''}`
  const addresses = detail.subActions.map(sub => `${sub.testIndex}:${sub.stepIndex}:${sub.subActionIndex}`)
  expect(addresses.length).toBeGreaterThanOrEqual(14)
  const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await ready(page)
    const sharedRun = await fetch(`${fixture.dashboard.origin}/api/runs/${fixture.drive.runId}`).then(response => response.json()) as { run: { duration: number } }
    expect(sharedRun.run.duration).toBeCloseTo(executionMs, 7)
    await page.getByText(executionLabel, { exact: true }).waitFor()
    await capture(page, 'suite-execution-duration-header')
    await page.getByRole('radio', { name: 'Frames', exact: true }).click()
    await page.getByRole('slider').press('Home')
    await page.getByRole('slider').evaluate(element => (element as HTMLElement).blur())
    const selected = () => page.evaluate(() => {
      const row = document.querySelector('[data-sub-action][aria-selected="true"]')
      return row?.getAttribute('data-sub-action-id')
    })
    const visit = []
    for (let index = 0; index < addresses.length; index++) {
      const [test, step, sub] = addresses[index]!.split(':')
      await expect.poll(() => selected()).toBe(`${test}:${step}-${sub}`)
      const row = page.locator('[data-sub-action][aria-selected="true"]')
      expect(await row.count()).toBe(1)
      expect(await row.locator(':scope > button').getAttribute('class')).toContain('ring-primary/60')
      expect(await row.locator(':scope > button').getAttribute('class')).not.toContain('border-l')
      visit.push(await selected())
      if (index < addresses.length - 1) await page.keyboard.press('ArrowDown')
    }
    for (const address of addresses.slice(0, -1).reverse()) {
      await page.keyboard.press('ArrowUp')
      const [test, step, sub] = address.split(':')
      await expect.poll(() => selected()).toBe(`${test}:${step}-${sub}`)
    }
    expect(await page.locator('[data-timeline]').count()).toBe(1)
    expect(await page.locator('[data-timeline-member-span]').count()).toBe(3)
    observations.order = visit
    await capture(page, 'suite-action-box-desktop')
    await page.goto(`${fixture.dashboard.origin}/runs`)
    const row = page.locator(`[data-runs-row-surface="${fixture.drive.runId}"]`)
    await row.getByText(executionLabel, { exact: true }).waitFor()
    await capture(page, 'suite-execution-duration-list')
    observations.executionDuration = { measuredMembers: detail.members.map(member => member.durationMs), executionMs, executionLabel, historicalLastMember: detail.members.at(-1)!.durationMs, headerAndList: true }
  } finally {
    database.updateRun(fixture.drive.runId, { duration: storedDuration })
    database.close()
    await page.close()
  }
}, 120_000)

it('SUITE-BROWSER-ANNOTATION: new recorded intervals align in normal, magnifier and fullscreen', async () => {
  const sub = detail.subActions.find(sub => sub.result?.annotation?.kind === 'point' && sub.result.annotation.recording)
  expect(sub, 'real runner persisted a measured click and recording witness').toBeDefined()
  const annotation = sub!.result!.annotation!
  if (annotation.kind !== 'point' || !annotation.recording) throw new Error('No point witness')
  const witness = annotation.recording
  expect(witness.endMs).toBeGreaterThan(witness.startMs)
  const rows = []
  for (const width of [1280, 400]) {
    const page = await fixture.browser.newPage({ viewport: { width, height: 900 } })
    try {
      const grounding = structuredClone(detail)
      const named = grounding.subActions.find(action => action.testIndex === sub!.testIndex && action.stepIndex === sub!.stepIndex && action.subActionIndex === sub!.subActionIndex)!
      named.grounding = { descriptor: { role: 'button', name: '\uE001 Café 日本語 \u{F0001} [secret:PW]' }, attempts: [] }
      await page.route('**/api/runs/*/detail', route => route.fulfill({ json: grounding }))
      await ready(page)
      await page.getByRole('radio', { name: 'Video', exact: true }).click()
      await mediaReady(page)
      await clickMarker(page, detail.subActions.indexOf(sub!) + 1)
      await expect.poll(() => page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeCloseTo((witness.startMs + witness.endMs) / 2000, 3)
      await page.locator('[data-annotation="point"]').waitFor()
      expect(await page.getByRole('button', { name: 'Hide annotations', exact: true }).getAttribute('aria-pressed')).toBe('true')
      observations[`default-annotation-${width}`] = { enabledBeforeAnyToggle: true, visible: true }
      await page.getByRole('button', { name: 'Grounding', exact: true }).click()
      const descriptor = page.locator('[data-grounding-descriptor]')
      expect(await descriptor.textContent()).toContain('button Café 日本語')
      expect(await descriptor.textContent()).not.toMatch(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u)
      expect(await descriptor.textContent()).toContain('[secret:PW]')
      expect(await descriptor.locator('[data-masked]').count()).toBe(0)
      await descriptor.scrollIntoViewIfNeeded()
      await capture(page, `grounding-circle-${width}`)
      await page.locator('[data-player]').scrollIntoViewIfNeeded()

      await page.locator('video').evaluate(video => video.setAttribute('data-witness-video', 'same'))
      const layout = await page.locator('[data-player]').evaluate(player => {
        const rect = (selector: string) => player.querySelector(selector)!.getBoundingClientRect()
        const thumb = rect('[data-timeline-playhead]')
        const track = rect('[data-timeline-track]')
        const time = rect('[data-player-time]')
        const toolbar = rect('[data-player-preview-toolbar]')
        const preview = rect('[data-player-preview]')
        const source = player.querySelector('[data-player-controls] > :last-child')!
        const marker = player.querySelector('[data-timeline-marker-group], [data-timeline-marker]')!
        const icon = marker.querySelector('svg')!.getBoundingClientRect()
        const circle = marker.querySelector('[data-timeline-circle]')!.getBoundingClientRect()
        return { circlePlayhead: !!player.querySelector('[data-playhead-circle]'), thumb: { width: thumb.width, height: thumb.height }, icon: { width: icon.width, height: icon.height },
          circleOnRail: Math.abs(circle.top + circle.height / 2 - track.top - 14) < 1,
          noStems: !player.querySelector('[data-timeline-stem]'), activeMarker: !!player.querySelector('[data-timeline-active="true"]'),
          timeRight: time.left >= track.right, timeAligned: Math.abs(time.top + time.height / 2 - track.top - 14) < 2,
          sourceLast: source.getAttribute('aria-label'), toolbarWidth: toolbar.width,
          toolbarInside: toolbar.right <= preview.right && toolbar.bottom <= preview.bottom,
          noStepZoom: !player.querySelector('[aria-label="Media zoom"], [aria-label="Zoom in"], [aria-label="Zoom out"]') }
      })
      expect(layout.thumb).toEqual(layout.circlePlayhead ? { width: 20, height: 20 } : { width: 6, height: 18 })
      expect(layout.icon).toEqual({ width: 12, height: 12 })
      expect(layout.circleOnRail && layout.noStems && layout.activeMarker).toBe(true)
      expect(layout.timeRight && layout.timeAligned && layout.toolbarInside && layout.noStepZoom).toBe(true)
      expect(layout.sourceLast).toBe('Playback source')
      expect(layout.toolbarWidth).toBeLessThanOrEqual(34)
      observations[`layout-${width}`] = layout
      for (const mode of ['normal', 'magnifier', 'fullscreen'] as const) {
        if (mode === 'fullscreen') {
          await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
          expect(await page.getByRole('button', { name: 'Hide annotations', exact: true }).getAttribute('aria-pressed')).toBe('true')
          expect(await page.locator('[data-media-transform] [data-annotation="point"]').count()).toBe(1)
        }
        const lens = mode !== 'normal' ? await lensProof(page, annotation.point, `new-recording-${mode}-${width}`) : undefined
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        const geometry = await page.locator('[data-player]').evaluate((player, point) => {
          const media = player.querySelector<HTMLVideoElement>('video')!
          const box = media.getBoundingClientRect()
          const dot = player.querySelector('[data-media-transform] [data-annotation="point"]')!.getBoundingClientRect()
          const controls = player.querySelector('[data-player-controls]')!.getBoundingClientRect()
          return { time: media.currentTime, duration: media.duration, videoWidth: media.videoWidth, videoHeight: media.videoHeight,
            deltaX: Math.abs(dot.x + dot.width / 2 - box.x - point.x / media.videoWidth * box.width),
            deltaY: Math.abs(dot.y + dot.height / 2 - box.y - point.y / media.videoHeight * box.height),
            controlsLeft: controls.left, controlsRight: controls.right, viewport: innerWidth,
            identity: media.dataset.witnessVideo, paused: media.paused }
        }, annotation.point)
        expect(geometry.deltaX).toBeLessThan(1)
        expect(geometry.deltaY).toBeLessThan(1)
        expect(geometry.identity).toBe('same')
        expect(geometry.videoWidth).toBe(witness.width)
        expect(geometry.videoHeight).toBe(witness.height)
        expect(geometry.controlsLeft).toBeGreaterThanOrEqual(0)
        expect(geometry.controlsRight).toBeLessThanOrEqual(width)
        rows.push({ width, mode, witness, point: annotation.point, lens, ...geometry })
        await capture(page, `new-recording-${mode}-${width}`)
      }
      await page.keyboard.press('Escape')
      expect(await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).evaluate(button => document.activeElement === button)).toBe(true)
      await lensProof(page, annotation.point, `video-lens-paused-${width}`)
      const before = await page.locator('video').evaluate(video => {
        const source = video as HTMLVideoElement
        return { time: source.currentTime, rate: source.playbackRate, paused: source.paused }
      })
      const live = await page.locator('video').evaluate(async video => {
        const source = video as HTMLVideoElement
        const proto = CanvasRenderingContext2D.prototype
        const original = proto.drawImage
        const samples: { time: number; same: boolean }[] = []
        let seeks = 0
        const seeking = () => { seeks++ }
        source.addEventListener('seeking', seeking)
        proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          if (this.canvas.closest('[data-media-lens]')) samples.push({ time: source.currentTime, same: args[0] === source })
          return Reflect.apply(original, this, args)
        } as typeof original
        try {
          const start = source.currentTime
          await source.play()
          await new Promise<void>((resolve, reject) => {
            const deadline = performance.now() + 3000
            const check = () => {
              if (samples.length >= 4 && samples.at(-1)!.time - start >= 0.12) resolve()
              else if (performance.now() > deadline) reject(new Error('Live lens did not redraw current video'))
              else requestAnimationFrame(check)
            }
            check()
          })
          source.pause()
          return { samples, seeks, rate: source.playbackRate, identity: source.dataset.witnessVideo }
        } finally { proto.drawImage = original; source.removeEventListener('seeking', seeking); source.pause() }
      })
      expect(before.paused).toBe(true)
      expect(live.samples.every(sample => sample.same)).toBe(true)
      expect(live.seeks).toBe(0)
      expect(live.rate).toBe(before.rate)
      expect(live.identity).toBe('same')
      observations[`live-lens-${width}`] = live
      await seek(page, (witness.startMs + witness.endMs) / 2000)
      await lensProof(page, annotation.point, `video-lens-after-seek-${width}`)
      await page.mouse.move(0, 0)
      expect(await page.locator('[data-media-lens]').count()).toBe(0)
      await page.getByRole('button', { name: 'Hide annotations', exact: true }).click()
      expect(await page.locator('[data-annotation]').count()).toBe(0)
      await page.getByRole('button', { name: 'Show annotations', exact: true }).click()
      await page.locator('[data-media-transform] [data-annotation="point"]').waitFor()
      await seek(page, Math.max(0, witness.startMs / 1000 - 0.05))
      expect(await page.locator('[data-annotation]').count()).toBe(0)
      await page.getByRole('radio', { name: 'Frames', exact: true }).click()
      expect(await page.locator('[data-media-lens]').count()).toBe(0)
      await capture(page, `suite-frame-normal-${width}`)
      await lensProof(page, annotation.point, `suite-frame-magnifier-${width}`)
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
      await page.locator('[role="dialog"] img').waitFor()
      await lensProof(page, annotation.point, `suite-frame-fullscreen-lens-${width}`)
      await capture(page, `suite-frame-fullscreen-${width}`)
    } finally { await page.close() }
  }
  observations.newRecording = rows
}, 120_000)

it('SUITE-BROWSER-MEDIA: real progress, marker details, local seeks and continued rate', async () => {
  const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await ready(page)
    await mediaReady(page)
    // Independently decode each actual artifact; stored monotonic durations deliberately
    // differ from the encoded media tail and must not control presentation spans.
    const sources = detail.members.map(member => member.recording?.state === 'present' ? `${fixture.dashboard.origin}/api/runs/${encodeURIComponent(fixture.drive.runId)}/artifacts/${member.recording.ref.sha}` : '')
    const durations = await page.evaluate(async sources => Promise.all(sources.map(src => new Promise<number>((resolve, reject) => {
      const media = document.createElement('video')
      media.preload = 'metadata'
      media.onloadedmetadata = () => { const duration = media.duration; media.removeAttribute('src'); media.load(); resolve(duration) }
      media.onerror = () => reject(new Error('Independent metadata decode failed'))
      media.src = src
    }))), sources)
    expect(durations.every(duration => duration > 0)).toBe(true)
    const stored = detail.members.map(member => member.recording?.state === 'present' ? member.recording.durationMs! / 1000 : 0)
    expect(durations[0]! - stored[0]!).toBeGreaterThan(0.2)
    const track = page.locator('[data-timeline-track]')
    const bounds = (await track.boundingBox())!
    const drag = await dragSuite(page, durations)
    observations.continuousDrag = drag
    const target = drag.find(row => row.member === 1)!.fraction * durations.reduce((sum, value) => sum + value, 0)
    const expectedLocal = target - durations[0]!
    // The player seeks to the marker, then to the click's seek; read once that settles.
    await armSettledSeek(page, memberSha(1))
    await page.mouse.click(bounds.x + bounds.width * target / durations.reduce((sum, value) => sum + value, 0), bounds.y + 2)
    await mediaReady(page)
    await expect.poll(() => page.locator('video').getAttribute('src')).toContain(memberSha(1))
    const local = await settledSeek(page)
    expect(Math.abs(local - expectedLocal)).toBeLessThan(0.15)
    await page.getByRole('slider').press('Home')
    await mediaReady(page)
    const rates = []
    for (const speed of [0.5, 1, 2, 4, 8, 16]) {
      await page.getByRole('combobox', { name: 'Playback speed' }).click()
      await page.getByRole('option', { name: `${speed}×`, exact: true }).click()
      rates.push(await page.locator('video').evaluate(video => (video as HTMLVideoElement).playbackRate))
      const trigger = page.getByRole('combobox', { name: 'Playback speed' })
      expect((await trigger.boundingBox())!.width).toBeLessThanOrEqual(60)
      expect(await trigger.textContent()).toBe(`${speed}×`)
      const textBounds = await trigger.evaluate(element => {
        const value = element.querySelector('[data-slot="select-value"]')!
        const range = document.createRange(); range.selectNodeContents(value)
        return { text: range.getBoundingClientRect().right, value: value.getBoundingClientRect().right,
          chevron: element.querySelector(':scope > svg')!.getBoundingClientRect().left }
      })
      expect(textBounds.text).toBeLessThanOrEqual(textBounds.value + 0.5)
      expect(textBounds.text).toBeLessThanOrEqual(textBounds.chevron)
      await capture(page, `speed-${speed}`)
    }
    expect(rates).toEqual([0.5, 1, 2, 4, 8, 16])
    await page.getByRole('combobox', { name: 'Playback speed' }).click()
    await page.getByRole('option', { name: '1×', exact: true }).click()
    await seek(page, 0)
    await page.locator('video').evaluate(video => {
      video.setAttribute('data-seek-count', '0')
      video.addEventListener('seeking', () => video.setAttribute('data-seek-count', String(Number(video.getAttribute('data-seek-count')) + 1)))
    })
    await page.getByRole('button', { name: 'Play recording', exact: true }).click()
    const samples = await page.evaluate(async () => {
      const values = []
      for (let index = 0; index < 12; index++) {
        await new Promise(resolve => setTimeout(resolve, 40))
        values.push({ time: document.querySelector('video')!.currentTime, left: (document.querySelector('[data-timeline-playhead]') as HTMLElement).style.left })
      }
      return values
    })
    expect(new Set(samples.map(sample => sample.left)).size).toBeGreaterThan(5)
    expect(samples.at(-1)!.time - samples[0]!.time).toBeGreaterThan(0.2)
    expect(await page.locator('video').getAttribute('data-seek-count')).toBe('0')
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    await seek(page, stored[0]! + 0.1)
    // Sampled per frame from before the click, so a slow click or timer cannot carry the tail past
    // member 0 unseen: it stops at 4 member-0 samples or at the first frame on another source.
    await armTailRecorder(page, memberSha(0))
    await page.getByRole('button', { name: 'Play recording', exact: true }).click()
    const tail = await page.evaluate(() => (window as unknown as { tailSamples: Promise<TailSample[]> }).tailSamples)
    const ownTail = tail.filter(sample => sample.member0)
    const boundary = durations[0]! / durations.reduce((sum, value) => sum + value, 0) * 100
    // Fewer than 4 member-0 samples is only the tail running into member 1, never a stall on member 0.
    const endedOnNextMember = tail.length > ownTail.length
    expect(ownTail.length === 4 || (endedOnNextMember && ownTail.length >= 2), `4 member-0 samples, or at least 2 before member 1: ${JSON.stringify(tail)}`).toBe(true)
    expect(ownTail.every((sample, index) => index === 0 || parseFloat(sample.left) > parseFloat(ownTail[index - 1]!.left)), `the playhead moves forward: ${JSON.stringify(tail)}`).toBe(true)
    expect(ownTail.every(sample => parseFloat(sample.left) < boundary), JSON.stringify(tail)).toBe(true)
    expect(ownTail.every((sample, index) => sample.time > stored[0]! && (index === 0 || sample.time > ownTail[index - 1]!.time)), JSON.stringify(tail)).toBe(true)
    await page.locator('video').evaluate(video => video.setAttribute('data-fullscreen-live', 'same'))
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    expect(await page.locator('video[data-fullscreen-live="same"]').evaluate(video => !(video as HTMLVideoElement).paused)).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    const last = detail.subActions.filter(sub => sub.testIndex === 0).at(-1)!
    expect(last.result.annotation?.recording).toBeDefined()
    await clickMarker(page, detail.subActions.indexOf(last) + 1)
    await page.getByRole('button', { name: 'Play recording', exact: true }).click()
    await page.locator('[data-video-action-cue]').waitFor()
    const cueTimes = await page.evaluate(async () => {
      const times = []
      for (let index = 0; index < 4; index++) {
        times.push({ time: document.querySelector('video')!.currentTime, cue: document.querySelector('[data-video-action-cue]')?.textContent })
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return times
    })
    expect(cueTimes.every(sample => sample.cue === 'Last recorded action')).toBe(true)
    expect(cueTimes.at(-1)!.time - cueTimes[0]!.time).toBeGreaterThan(0.1)
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    await capture(page, 'new-recording-labelled-review-cue')
    await page.getByRole('slider').press('Home')
    await mediaReady(page)
    await page.getByRole('combobox', { name: 'Playback speed' }).click()
    await page.getByRole('option', { name: '2×', exact: true }).click()
    const actualDuration = await page.locator('video').evaluate(video => (video as HTMLVideoElement).duration)
    await seek(page, actualDuration - 0.1)
    await page.getByRole('button', { name: 'Play recording', exact: true }).click()
    await expect.poll(() => page.locator('video').getAttribute('src')).toContain(detail.members[1]!.recording!.state === 'present' ? detail.members[1]!.recording!.ref.sha : 'missing')
    await mediaReady(page)
    expect(await page.locator('video').evaluate(video => ({ rate: (video as HTMLVideoElement).playbackRate, paused: (video as HTMLVideoElement).paused }))).toEqual({ rate: 2, paused: false })
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    observations.clockHandoffSecond = await assertSuiteClock(page, durations, 1)
    await seek(page, durations[1]! - 0.1)
    await page.getByRole('button', { name: 'Play recording', exact: true }).click()
    await expect.poll(() => page.locator('video').getAttribute('src')).toContain(detail.members[2]!.recording!.state === 'present' ? detail.members[2]!.recording!.ref.sha : 'missing')
    await mediaReady(page)
    await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
    observations.clockHandoffThird = await assertSuiteClock(page, durations, 2)
    await capture(page, 'suite-clock-third-member')
    await page.getByRole('radio', { name: 'Frames', exact: true }).click()
    expect(await page.locator('[data-player-time]').count()).toBe(0)
    await page.getByRole('radio', { name: 'Video', exact: true }).click()
    await mediaReady(page)
    await assertSuiteClock(page, durations, 2)
    await page.locator('[data-member-filter]').click()
    await page.getByRole('option', { name: detail.members[1]!.name!, exact: true }).click()
    await mediaReady(page)
    observations.filteredClock = await assertSuiteClock(page, [durations[1]!], 0)
    expect(await page.locator('[data-timeline-member-span]').count()).toBe(1)
    await page.locator('[data-member-filter]').click()
    await page.getByRole('option', { name: 'All tests (3)', exact: true }).click()
    await mediaReady(page)
    await assertSuiteClock(page, durations, 1)
    // Actual dispatches can all be tightly clustered. Arrange one visible action only
    // for the independent singleton hover/focus layout control, retaining its real facts.
    const singleton = structuredClone(detail)
    singleton.subActions = singleton.subActions.slice(0, 1)
    await page.route('**/api/runs/*/detail', route => route.fulfill({ json: singleton }))
    await ready(page)
    const marker = page.locator('[data-timeline-track] > button[data-timeline-marker]').first()
    await marker.hover()
    await marker.focus()
    expect(await page.locator('[role="tooltip"], [data-timeline-marker-details]').count()).toBe(0)
    expect(await marker.getAttribute('title')).toBeNull()
    expect(await marker.getAttribute('aria-label')).toContain('Step')
    await marker.click()
    await capture(page, 'suite-singleton-marker')
    // Explicit endpoint arrangement over real recordings: the same mapping must
    // paint and hit-test 0/1. This changes presentation offsets, not media facts.
    const endpoints = structuredClone(detail)
    endpoints.subActions = [endpoints.subActions[0]!, endpoints.subActions[1]!, endpoints.subActions.at(-1)!]
    endpoints.subActions.forEach((action, index) => {
      if (action.result.annotation) delete action.result.annotation.recording
      action.recordingOffsetMs = index < 2 ? 0 : durations[2]! * 1000
    })
    await page.unroute('**/api/runs/*/detail')
    await page.route('**/api/runs/*/detail', route => route.fulfill({ json: endpoints }))
    for (const width of [1280, 400]) {
      await page.setViewportSize({ width, height: 900 })
      await ready(page)
      await mediaReady(page)
      for (const ordinal of [1, 3]) {
        await clickMarker(page, ordinal)
        const expected = ordinal === 1 ? 0 : 1
        const geometry = await page.locator('[data-timeline-track]').evaluate((track, expected) => {
          const rect = track.getBoundingClientRect()
          const slider = track.querySelector('[role="slider"]')!
          const thumb = slider.getBoundingClientRect()
          const circle = track.querySelector('[data-timeline-active] [data-timeline-circle]')!.getBoundingClientRect()
          return { delta: Math.abs(circle.x + circle.width / 2 - (rect.x + rect.width * expected)),
            thumbDelta: Math.abs(thumb.x + thumb.width / 2 - (rect.x + rect.width * expected)),
            pill: getComputedStyle(slider).backgroundColor, hiddenPill: slider.getAttribute('data-playhead-circle'),
            inside: circle.left >= 0 && circle.right <= innerWidth }
        }, expected)
        expect(geometry.delta).toBeLessThan(0.5)
        expect(geometry.thumbDelta).toBeLessThan(0.5)
        expect(geometry.pill).toBe('rgba(0, 0, 0, 0)')
        expect(geometry.hiddenPill).toBe('true')
        expect(geometry.inside).toBe(true)
        observations[`endpoint-${width}-${ordinal}`] = geometry
        await capture(page, `endpoint-${width}-${ordinal}`)
      }
      const rail = (await page.locator('[data-timeline-track]').boundingBox())!
      const freeMember = freeMemberAt(await memberSpans(page), 0.5)
      // Read the playhead once, whole, after the click's settled seek.
      await armSettledSeek(page, memberSha(freeMember))
      await page.mouse.click(rail.x + rail.width * 0.5, rail.y + 2)
      await settledSeek(page)
      await expect.poll(() => page.getByRole('slider').evaluate(element => ({
        left: Math.round(parseFloat((element as HTMLElement).style.left)),
        circle: element.getAttribute('data-playhead-circle'),
        transparent: getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)',
      }))).toEqual({ left: 50, circle: null, transparent: false })
      await capture(page, `free-playhead-${width}`)
    }
    observations.media = { durations, stored, tail, target, local, rates, samples, cueTimes, continuation: true }
  } finally { await page.close() }
}, 120_000)

describe('the suite player\'s seek, span and clock helpers', () => {
  it("a settled-seek wait that sees no seek on the member's source fails with a message within its bound", async () => {
    const page = await fixture.browser.newPage()
    try {
      await armSettledSeek(page, 'no-media-uses-this-source')
      const started = Date.now()
      const failure = await settledSeek(page).then(() => undefined, (error: unknown) => error)
      const elapsed = Date.now() - started
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toMatch(/no settled seek/)
      expect((failure as Error).message).toContain('no-media-uses-this-source')
      expect((failure as Error).message).toContain(`within ${SETTLED_SEEK_TIMEOUT_MS} ms`)
      expect(elapsed).toBeLessThan(SETTLED_SEEK_TIMEOUT_MS + 5_000)
    } finally { await page.close() }
  }, 30_000)

  it('the free-playhead member is read from its data-timeline-member-span attribute, not its DOM position', () => {
    expect(freeMemberAt([{ member: 1, start: 0, width: 0.4 }, { member: 0, start: 0.4, width: 0.6 }], 0.5)).toBe(0)
  })

  it('a point no member spans fails with a message', () => {
    expect(() => freeMemberAt([{ member: 0, start: 0, width: 0.4 }], 0.5)).toThrow(/no timeline member spans 0.5/)
  })

  it('decoded durations that make exactly 16 s total 16 s and read 0:16, though their float sum is 15.999… s', () => {
    const durations = [10.12, 2.96, 2.92]
    expect(durations.reduce((sum, value) => sum + value, 0)).toBeLessThan(16)
    expect(suiteSeconds(durations)).toBe(16)
    expect(clockLabel(suiteSeconds(durations))).toBe('0:16')
  })
})
