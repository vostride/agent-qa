/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots } from './spawned-chat.js'
import { capture, recordingFixture, type RecordingFixture } from './recording-dom-fixture.js'

// Drive once, assert recorded facts per cell. No missing browser, stale bundle or failed
// producer can turn this file green by skipping. No binary media fixture is committed.
const held: RecordingFixture[] = []
const ledger: Array<{ url: string; status: number; contentType: string; range?: string; etag?: string }> = []
let failure: string | undefined
let seekFailure: string | undefined
let src = ''
let seek: { length: number; end: number; requested: number; actual: number } | undefined
let parent: { selected: string | null; childCount: number; sliderMatchesAction: boolean; caption: string; image: string; answered: boolean; latestFrame: boolean } | undefined
let off: { initial: string | null; state: string | null; kind: string | null } | undefined

describe('recording and parent selection on the shipped bundle', () => {
  beforeAll(async () => {
    try {
      const fixture = await recordingFixture('recording-dom')
      held.push(fixture)
      const context = await fixture.browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      page.on('response', response => {
        const headers = response.headers()
        ledger.push({ url: response.url(), status: response.status(), contentType: headers['content-type'] ?? '',
          range: headers['content-range'], etag: headers.etag })
      })
      await page.goto(`${fixture.dashboard.origin}/runs/${encodeURIComponent(fixture.drive.runId)}`)
      await page.locator('[data-step-id]').first().waitFor()
      try {
        await page.locator('video').waitFor({ timeout: 15_000 })
        src = await page.locator('video').evaluate(video => (video as HTMLVideoElement).currentSrc)
        await page.waitForFunction(() => {
          const video = document.querySelector('video')
          return video && video.readyState >= 1
        }, undefined, { timeout: 15_000 })
        seek = await page.locator('video').evaluate(async element => {
          const video = element as HTMLVideoElement
          const length = video.seekable.length
          const end = length ? video.seekable.end(0) : 0
          const requested = end / 2
          if (requested > 0) await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('No seeked event')), 10_000)
            video.addEventListener('seeked', () => { clearTimeout(timeout); resolve() }, { once: true })
            video.currentTime = requested
          })
          return { length, end, requested, actual: video.currentTime }
        })
      } catch (error) { seekFailure = String(error) }

      const row = page.locator('[data-step-id]').first()
      await row.locator(':scope > button').click()
      await page.getByRole('radio', { name: 'Frames', exact: true }).click()
      await page.locator('[data-artifact-state="available"] img').waitFor()
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('[data-artifact-state="available"] img')
        return image?.complete && image.naturalWidth > 0
      })
      parent = await row.evaluate(row => {
        const slider = document.querySelector('[data-overview] [role="slider"]')
        const children = [...row.querySelectorAll('[data-sub-action]')]
        const current = row.querySelector('[data-playhead-row]')
        const image = document.querySelector<HTMLImageElement>('[data-artifact-state="available"] img')
        return {
          selected: row.getAttribute('aria-selected'), childCount: children.length,
          sliderMatchesAction: slider?.getAttribute('aria-valuetext')?.includes(`sub-action ${children.length} of ${children.length}`) === true,
          caption: document.querySelector('[data-player-caption]')?.textContent ?? '',
          image: image?.src ?? '', answered: !!image?.complete && image.naturalWidth > 0,
          latestFrame: current === children.at(-1),
        }
      })
      await capture(page, 'parent-step-parks-playhead')
      if (process.env.AGENT_QA_424_CAPTURE_DIR) writeFileSync(
        join(process.env.AGENT_QA_424_CAPTURE_DIR, 'recording-observation.json'),
        JSON.stringify({ src, seek, parent, ledger: ledger.filter(response => response.url.includes('/artifacts/')) }, null, 2),
      )
      await context.close()

      const disabled = await recordingFixture('recording-off-dom', true)
      held.push(disabled)
      const offPage = await disabled.browser.newPage()
      await offPage.goto(`${disabled.dashboard.origin}/runs/${encodeURIComponent(disabled.drive.runId)}`)
      await offPage.locator('[data-player]').waitFor()
      const initial = await offPage.locator('[data-player]').getAttribute('data-player-source')
      await offPage.getByRole('radio', { name: /^Video/ }).click()
      const absence = offPage.locator('[data-evidence-kind="video"]')
      await absence.waitFor()
      off = { initial, state: await absence.getAttribute('data-evidence-state'), kind: await absence.getAttribute('data-evidence-kind') }
      await offPage.close()
    } catch (error) { failure = String(error) }
  }, 360_000)

  afterAll(async () => {
    for (const fixture of held) await fixture.close()
    cleanupTempRoots()
  })

  it('RECORDING-SEEKABLE', () => {
    expect(failure).toBeUndefined()
    expect(seekFailure).toBeUndefined()
    expect(src).toMatch(/\/api\/runs\/[^/]+\/artifacts\/[a-f0-9]{64}$/u)
    expect(seek?.length).toBe(1)
    expect(seek!.end).toBeGreaterThan(0)
    expect(Math.abs(seek!.actual - seek!.requested)).toBeLessThan(Math.min(1, seek!.requested / 2))
  })
  it('RECORDING-RANGE-206', () => {
    expect(failure).toBeUndefined()
    const ranged = ledger.find(response => response.url === src && response.status === 206)
    expect(ranged, JSON.stringify(ledger.filter(response => response.url.includes('/artifacts/')))).toBeDefined()
    expect(ranged!.range).toMatch(/^bytes \d+-\d+\/\d+$/u)
    expect(ranged!.contentType).toBe('video/webm')
    expect(ranged!.etag).toBe(`"${src.split('/').at(-1)}"`)
  })
  it('PARENT-STEP-PARKS-PLAYHEAD', () => {
    expect(failure).toBeUndefined()
    expect(parent).toMatchObject({ selected: 'true', sliderMatchesAction: true, answered: true, latestFrame: true })
    expect(parent!.childCount).toBeGreaterThanOrEqual(2)
    expect(parent!.caption).toContain('Clicked')
    expect(parent!.caption).not.toMatch(/#2|passed|Sub-action/u)
    expect(parent!.image).toMatch(/\/api\/runs\/[^/]+\/artifacts\/[a-f0-9]{64}$/u)
    expect(ledger.some(response => response.url === parent!.image && response.status === 200)).toBe(true)
  })
  it('RECORDING-OFF-OPENS-FRAMES', () => {
    expect(failure).toBeUndefined()
    expect(off).toEqual({ initial: 'frames', state: 'not-captured', kind: 'video' })
  })
})
