import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import type { PlatformAdapter, RecordingCapability } from '@vostride/agent-qa-runner'
import { WebPlatformAdapter } from '../adapter.js'
import { createScreencastRecording } from '../recording.js'
import { startLiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'
import type { LiveStreamFixturePage } from './fixtures/live-stream-fixture-page.js'

let fixture: LiveStreamFixturePage
let adapter: WebPlatformAdapter
let videoDir: string

beforeAll(async () => { fixture = await startLiveStreamFixturePage() })
afterAll(async () => { await fixture?.close() })
beforeEach(async () => {
  videoDir = await mkdtemp(join(tmpdir(), 'agent-qa-recording-'))
  adapter = new WebPlatformAdapter()
  try {
    await adapter.setup({
      platform: 'web',
      browser: { name: 'chromium', headless: true },
      recording: { enabled: true, videoDir },
    })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', {
      cause: error,
    })
  }
  await adapter.getPage()!.goto(`${fixture.url}?animate=1`)
}, 60_000)
afterEach(async () => {
  await adapter?.cleanup()
  await rm(videoDir, { recursive: true, force: true })
}, 60_000)

function recording(): RecordingCapability {
  const capability = (adapter as PlatformAdapter<'web'>).recording
  expect(capability, 'initialized web adapter exposes recording').toBeDefined()
  return capability!
}

it('REC-WEB-TWO-MEMBERS: shared context yields distinct finalized recordings', async () => {
  const capability = recording()
  expect(recording()).toBe(capability)
  const page = adapter.getPage()!
  const context = page.context()
  const paths: string[] = []
  const hashes: string[] = []
  for (const color of ['red', 'blue']) {
    await page.evaluate((background) => {
      ;(globalThis as any).document.body.style.background = background
    }, color)
    await capability.start()
    await page.waitForTimeout(350)
    const stopped = await capability.stop()
    expect(stopped?.contentType).toBe('video/webm')
    paths.push(stopped!.stagingPath)
    hashes.push(createHash('sha256').update(await readFile(stopped!.stagingPath)).digest('hex'))
    expect(page.context()).toBe(context)
  }
  expect(new Set(paths).size).toBe(2)
  expect(new Set(hashes).size).toBe(2)
  expect(hashes).not.toContain(createHash('sha256').update('').digest('hex'))
}, 60_000)

it('REC-WEB-FINAL-AFTER-STOP: staging appears only after finalization with EBML bytes', async () => {
  const capability = recording()
  await capability.start()
  await adapter.getPage()!.waitForTimeout(350)
  expect(await readdir(videoDir)).toEqual([])
  const stopping = capability.stop()
  expect(await readdir(videoDir)).toEqual([])
  const stopped = await stopping
  const bytes = await readFile(stopped!.stagingPath)
  expect(bytes.length).toBeGreaterThan(4)
  expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
  expect(await readdir(videoDir)).toHaveLength(1)
}, 60_000)

it('REC-WEB-ZERO-MONOTONIC: zero is measured when start resolves', async () => {
  const capability = recording()
  const before = performance.now()
  const { zeroMs } = await capability.start()
  const after = performance.now()
  expect(Number.isFinite(zeroMs)).toBe(true)
  expect(zeroMs).toBeGreaterThanOrEqual(before)
  expect(zeroMs).toBeLessThanOrEqual(after)
  await capability.stop()
})

it('REC-WEB-DOUBLE-START-THROWS: overlapping starts reject', async () => {
  const capability = recording()
  const starting = capability.start()
  await expect(capability.start()).rejects.toThrow(/already/i)
  await starting
  await expect(capability.start()).rejects.toThrow(/already/i)
  await capability.stop()
})

it('REC-WEB-STOP-WITHOUT-START: idle stop resolves undefined', async () => {
  await expect(recording().stop()).resolves.toBeUndefined()
})

it('REC-ANNOTATION-REAL-FRAME: witnesses actual recorded-page dispatch time and observed identity pixels', async () => {
  const capability = recording()
  const page = adapter.getPage()!
  await capability.start()
  await page.waitForTimeout(350)
  const finish = capability.beginAnnotation?.()
  expect(finish).toBeTypeOf('function')
  await page.waitForTimeout(120)
  const witness = finish?.()
  expect(witness).toMatchObject({ scene: 'recorded-page', transform: 'identity', ...page.viewportSize() })
  expect(witness!.startMs).toBeGreaterThanOrEqual(0)
  expect(witness!.endMs - witness!.startMs).toBeGreaterThanOrEqual(100)
  const stale = capability.beginAnnotation?.()
  await page.setViewportSize({ width: 600, height: 400 })
  expect(stale?.()).toBeUndefined()
  await page.waitForTimeout(100)
  expect(capability.beginAnnotation?.()).toBeUndefined()
  await capability.stop()
  expect(capability.beginAnnotation?.()).toBeUndefined()
})

it('REC-ANNOTATION-PAGE-OWNERSHIP: page switches cannot inherit the original recording witness', async () => {
  const capability = recording()
  await capability.start()
  await adapter.getPage()!.waitForTimeout(350)
  const finish = capability.beginAnnotation?.()
  expect(finish).toBeTypeOf('function')
  const other = await adapter.getPage()!.context().newPage()
  await other.goto(fixture.url)
  await adapter.execute({ type: 'tab', action: 'switch', index: 1 })
  expect(finish?.()).toBeUndefined()
  expect(capability.beginAnnotation?.()).toBeUndefined()
  await adapter.execute({ type: 'tab', action: 'switch', index: 0 })
  expect(finish?.()).toBeUndefined()
  await capability.stop()
})

it('REC-ANNOTATION-NONIDENTITY: custom video bounds withhold an unproven transform', async () => {
  const capability = createScreencastRecording(() => adapter.getPage(), { enabled: true, videoDir,
    videoSize: { width: 640, height: 360 } }, () => 0)
  await capability.start()
  await adapter.getPage()!.waitForTimeout(350)
  expect(capability.beginAnnotation?.()).toBeUndefined()
  await capability.stop()
})
