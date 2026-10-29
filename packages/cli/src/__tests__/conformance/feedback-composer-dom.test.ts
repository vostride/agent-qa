/// <reference lib="dom" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { MARKS, MarkReceiptSchema, RunsMarkOutcomeSchema, RunsMarkPreviewResultSchema } from '@vostride/agent-qa-schema'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordingFixture, type RecordingFixture } from './recording-dom-fixture.js'
import { populatedRunSpawnEnv, POPULATED_SECRET_ENV_VAR } from './populated-run-fixture.js'
import { cleanupTempRoots, reserveEphemeralPort, spawnDashboard, trackTempRoot } from './spawned-chat.js'

// Real producer + shipped bundle: the run is recorded by the shipped runner and every door, draft
// and copy below is the built dashboard's own. Nothing is mocked or skipped. Captures go only where
// AGENT_QA_426_CAPTURE_DIR points, never into 424's or 425's directories.
const DESKTOP = { width: 1280, height: 800 }
const MODAL = '[role="dialog"],[aria-modal]'
const NOTE = 'The notice closed before the evidence settled'

type Settled = { detailStatus: number; marks: unknown; stepCount: number; previewStatus: number; previewKind?: string; previewParsed: boolean }
type Triggers = { loaded: number; kinds: string[]; afterEscape: number; selectedAfterEscape: number }
type Pills = { label: string; markKinds: number; leaked: string[] }
type Inspecting = {
  opened: string | null
  selectedAfter: string | null
  pinnedVisible: boolean
  pinnedAfterCopy: boolean
  targetAfterSelect: string | null
  tab: 'network'
  copied: string[]
  composerOpen: boolean
  note: string
  modalCounts: Record<string, number>
}
type MarkPath = {
  rowsAtReply: number
  status?: number
  outcome?: { kind: string; markId?: string }
  rows: Array<{ markId: string; kind: string; origin: string; testIndex: number; stepIndex?: number; disposition: string }>
  newEntryMarkId: string | null
  newEntryFirst: boolean
  newEntryControls: number
  newEntryApplied: number
}

const failures: Record<string, string> = {}
let fixture: RecordingFixture | undefined
let reader: Awaited<ReturnType<typeof spawnDashboard>> | undefined
let settled: Settled | undefined
let triggers: Triggers | undefined
const pills: Pills[] = []
let inspecting: Inspecting | undefined
let markPath: MarkPath | undefined

async function captureTo(page: Page, name: string, zoomed = false) {
  const directory = process.env.AGENT_QA_426_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  // Under real browser zoom a clip is in surface pixels, not page pixels (425's first 200% capture
  // cropped to the top-left quadrant), so the zoomed capture is the viewport scaled by devicePixelRatio.
  const clip = zoomed
    ? await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }))
    : undefined
  await page.screenshot({ path: join(directory, `${name}.png`), ...(clip ? { clip } : { fullPage: true }), animations: 'disabled' })
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function scanPills(page: Page, label: string) {
  const observed = await page.evaluate(marks => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const leaked: string[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.parentElement?.closest('[data-feedback-technical]')) continue
      const text = node.textContent ?? ''
      if (marks.some(kind => text.includes(kind))) leaked.push(text)
    }
    return { markKinds: document.querySelectorAll('[data-mark-kind]').length, leaked }
  }, [...MARKS])
  pills.push({ label, ...observed })
}

async function modalCount(page: Page) {
  return await page.evaluate(selector => document.querySelectorAll(selector).length, MODAL)
}

/** Open the Network tab and copy the first response body its rows offer. */
async function copyFromNetwork(page: Page) {
  await page.getByRole('tab', { name: /^Network/ }).click()
  const panel = page.locator('[role="tabpanel"][data-state="active"]')
  const rows = panel.locator('tbody > tr.cursor-pointer')
  await rows.first().waitFor({ timeout: 10_000 })
  for (let index = 0; index < await rows.count(); index++) {
    await rows.nth(index).click()
    const copy = panel.locator('h4', { hasText: 'Response Body' }).locator('xpath=following-sibling::button')
    if (await copy.count() > 0) {
      await copy.first().click()
      return true
    }
    await rows.nth(index).click()
  }
  return false
}

// run-header-layout-dom's geometry vocabulary, reused as-is.
type Box = { x: number; y: number; right: number; bottom: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5
const inside = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.right <= b.right + 0.5 && a.y >= b.y - 0.5 && a.bottom <= b.bottom + 0.5
const insideX = (a: Box, b: Box) => a.x >= b.x - 0.5 && a.right <= b.right + 0.5

type Item = { key: string; box: Box; clip: Box; contains: number[] }
type Text = { key: string; kind: 'badge' | 'indicator' | 'token' | 'duration' | 'other'; text: string; box: Box; fontSize: number; fontWeight: number }
type HeaderGeometry = {
  label: string
  innerWidth: number
  dpr: number
  header: Box
  entryCount: number
  rowEntryCount: number
  entry: number
  entryOnTop: boolean
  entryHit: string | null
  items: Item[]
  texts: Text[]
}
// `scrolls` marks an element whose nearest clip is a vertical scroller: scrolling out of view is not
// clipping, so only its horizontal extent is held to the clip. `scope` names that clip, so content
// scrolled under the footer is compared by what the scroller actually shows.
type ComposerItem = Item & { scrolls: boolean; scope: number }
const visible = (item: ComposerItem): Box | undefined => {
  if (!item.scrolls) return item.box
  const x = Math.max(item.box.x, item.clip.x)
  const y = Math.max(item.box.y, item.clip.y)
  const right = Math.min(item.box.right, item.clip.right)
  const bottom = Math.min(item.box.bottom, item.clip.bottom)
  return right > x && bottom > y ? { x, y, right, bottom, width: right - x, height: bottom - y } : undefined
}
type ComposerGeometry = {
  label: string
  innerWidth: number
  dpr: number
  layout: string | null
  viewport: Box
  group: Box
  tree: Box
  evidence: Box
  panel: Box
  composer: Box
  header: Box
  body: Box
  footer: Box
  shrink: { header: string; footer: string }
  bodyOverflowY: string
  regions: number
  scrollers: string[]
  horizontalScrollers: string[]
  items: ComposerItem[]
}
type Zoom = { factor: number; beforeWidth: number; afterWidth: number; beforeDpr: number; afterDpr: number }
type Remount = {
  layouts: { opened: string | null; narrow: string | null; restored: string | null }
  panes: { before: number[]; after: number[] }
  composer: boolean
  player: { present: boolean; section: boolean; video: boolean; sameVideo: boolean; before?: number; after?: number; elapsedBefore?: string | null; elapsedAfter?: string | null }
  network: { tree: boolean; panel: boolean; selectedBefore: string | null; selectedAfter: string | null; layouts: { narrow: string | null; restored: string | null } }
}
type Contrast = { theme: 'dark' | 'light'; count: number; min: number; minKey: string; below: Array<{ key: string; ratio: number }>; samples: Array<{ key: string; ratio: number; fg: number[]; bg: number[] }> }
type StepRow = { label: string; stepId: string | null; width: number; name: Box; duration: Box; door: Box; flexWrap: string }
type Aria = { heading: string; snapshot: string; state: string | null; outcomeClass: string | null; scopeLine: string }

const DESKTOP_LABEL = '1280x800'
const NARROW_LABEL = '400x800'
const ZOOM_LABEL = 'zoom2-from-1280x800'
const GEOMETRY_LABELS = [DESKTOP_LABEL, NARROW_LABEL, ZOOM_LABEL]
// WINDOWS #480's band, composer closed: 808px and 888px headers beside the 192px sidebar.
const MID_WIDTHS = [1000, 1080]
const HEADER_LABELS = [DESKTOP_LABEL, ...MID_WIDTHS.map(width => `${width}x800`), NARROW_LABEL, ZOOM_LABEL]
const DOCKED_NARROW_LABEL = '1000x800-docked'
const ROW_WRAP_BELOW_PX = 224
// CHOICE_LABELS in FEEDBACK_CHOICE_ORDER, per the target's recorded outcome class.
const CHOICE_ORDER: Record<string, string[]> = {
  failed: ['This should have passed', 'This is a real product bug', 'This should have failed'],
  passed: ['This should have failed', 'This is a real product bug', 'This should have passed'],
}
// ariaSnapshot() is YAML: a line whose name needs quoting arrives as `- 'role "name"':`.
const unquoted = (line: string) => {
  const trimmed = line.trim()
  const quoted = /^- '(.*)'(:?)$/.exec(trimmed)
  return quoted ? `- ${quoted[1]!.replace(/''/g, "'")}${quoted[2]}` : trimmed
}

const headerGeometries: HeaderGeometry[] = []
const composerGeometries: ComposerGeometry[] = []
let zoom: Zoom | undefined
let remount: Remount | undefined
const contrast: Contrast[] = []
let aria: Aria | undefined
const stepRows: StepRow[] = []
let zoomContext: BrowserContext | undefined

async function settleHeader(page: Page) {
  await page.locator('[data-verdict-badge]').waitFor()
  await page.locator('[data-feedback-entry="test"]').waitFor({ timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await frames(page)
}

/** 425's header measurement, on this file's own feedback-bound host, with the entry named. */
async function measureHeader(page: Page, label: string) {
  await settleHeader(page)
  const geometry = await page.evaluate(() => {
    const box = (element: Element): Box => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const badge = document.querySelector('[data-verdict-badge]')!
    const row = badge.parentElement!
    let header = row
    while (header && !header.classList.contains('@container')) header = header.parentElement!
    if (!header) throw new Error('No @container header block above the verdict badge')
    const named = (element: Element) => {
      for (const attribute of ['data-feedback-entry', 'data-verdict-badge', 'data-chip', 'data-chips-state', 'data-run-token-summary', 'data-run-duration']) {
        if (element.hasAttribute(attribute)) return `${attribute}=${element.getAttribute(attribute) || ''}`
      }
      return `${element.tagName.toLowerCase()}[${element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 24)}]`
    }
    const clipOf = (element: Element) => {
      for (let node = element.parentElement; node && node !== header; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX === 'hidden' || style.overflowY === 'hidden') return box(node)
      }
      return box(header)
    }
    const collected = [...header.querySelectorAll('[data-feedback-entry], [data-verdict-badge], [data-chip], [data-chips-state="unavailable"], [data-run-token-summary], [data-run-duration], button, a')]
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    const items = collected.map(element => ({
      key: named(element), box: box(element), clip: clipOf(element),
      contains: collected.flatMap((other, index) => other !== element && element.contains(other) ? [index] : []),
    }))
    const texts = [...header.querySelectorAll('*')]
      .filter(element => [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim()))
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      .map(element => {
        const style = getComputedStyle(element)
        const kind = element.hasAttribute('data-verdict-badge') ? 'badge'
          : element.closest('[data-run-token-summary]') ? 'token'
          : element.closest('[data-run-duration]') ? 'duration'
          : element.closest('[data-chip], [data-chips-state]') ? 'indicator'
          : 'other'
        return { key: named(element), kind, text: (element.textContent ?? '').trim().slice(0, 48),
          box: box(element), fontSize: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight) }
      })
    const entry = collected.findIndex(element => element.getAttribute('data-feedback-entry') === 'test')
    // What a pointer at the entry's centre would hit: a sibling painted over it takes the click.
    const target = collected[entry]?.getBoundingClientRect()
    const hit = target ? document.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2) : null
    return {
      innerWidth, dpr: devicePixelRatio, header: box(header), items, texts, entry,
      entryOnTop: hit !== null && collected[entry]!.contains(hit),
      entryHit: hit === null ? null : named(collected.filter(element => element.contains(hit)).at(-1) ?? hit),
      entryCount: document.querySelectorAll('[data-feedback-entry="test"]').length,
      rowEntryCount: row.querySelectorAll(':scope > [data-feedback-entry="test"]').length,
    }
  })
  headerGeometries.push({ label, ...geometry } as HeaderGeometry)
}

async function openComposerWithPreview(page: Page) {
  await page.locator('[data-feedback-entry="test"]').click()
  const composer = page.locator('[data-feedback-composer]')
  await composer.waitFor()
  await composer.locator('[data-feedback-choice] [role="radio"]').first().click()
  await composer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor({ timeout: 15_000 })
  await frames(page)
  return composer
}

async function measureComposer(page: Page, label: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await frames(page)
  const geometry = await page.evaluate(() => {
    const box = (element: Element): Box => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const composer = document.querySelector('[data-feedback-composer]')!
    const panel = composer.closest('[data-panel]')!
    const group = panel.closest('[data-group]')!
    const evidence = document.querySelector('[data-tour-id="tour-run-detail-reasoning"]')!.closest('[data-panel]')!
    const tree = document.querySelector('ul[role="tree"]')!.closest('[data-panel]')!
    const parts = [...composer.children]
    const header = parts[0]!
    const footer = parts[parts.length - 1]!
    const middle = parts.slice(1, -1)
    if (middle.length !== 1) throw new Error(`The composer has ${String(middle.length)} body regions`)
    const body = middle[0]!
    const hidden = (element: Element) => element.closest('[aria-hidden="true"], .sr-only') !== null
    const named = (element: Element) => {
      const data = [...element.attributes].find(attribute => attribute.name.startsWith('data-feedback') || attribute.name.startsWith('data-preview') || attribute.name.startsWith('data-history'))
      const text = (element.getAttribute('aria-label') ?? (element.textContent ?? '').trim()).slice(0, 32)
      return `${element.tagName.toLowerCase()}${element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''}${data ? `[${data.name}]` : ''}[${text}]`
    }
    const scopes: Element[] = []
    const scopeOf = (node: Element) => {
      if (!scopes.includes(node)) scopes.push(node)
      return scopes.indexOf(node)
    }
    const clipOf = (element: Element) => {
      for (let node = element.parentElement; node && node !== panel; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const scrolls = (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1
          return { clip: box(node), scrolls, scope: scopeOf(node) }
        }
      }
      return { clip: box(composer), scrolls: false, scope: -1 }
    }
    const textBearing = (element: Element) => [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())
    const control = (element: Element) => element.matches('button, textarea, input, select, a, [role="radio"], [role="combobox"], [role="checkbox"]')
    const collected = [...composer.querySelectorAll('*')]
      .filter(element => textBearing(element) || control(element))
      .filter(element => !hidden(element))
      .filter(element => { const r = element.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(element).visibility === 'visible' })
    const items = collected.map(element => ({
      key: named(element), box: box(element), ...clipOf(element),
      contains: collected.flatMap((other, index) => other !== element && element.contains(other) ? [index] : []),
    }))
    const all = [composer, ...composer.querySelectorAll('*')]
    const scrollers = all.filter(element => {
      const style = getComputedStyle(element)
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1
    }).map(element => element === body ? 'body' : named(element))
    const horizontalScrollers = all.filter(element => {
      const style = getComputedStyle(element)
      return (style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 1
    }).map(named)
    return {
      innerWidth, dpr: devicePixelRatio, layout: composer.getAttribute('data-feedback-layout'),
      viewport: { x: 0, y: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight },
      group: box(group), tree: box(tree), evidence: box(evidence), panel: box(panel), composer: box(composer),
      header: box(header), body: box(body), footer: box(footer),
      shrink: { header: getComputedStyle(header).flexShrink, footer: getComputedStyle(footer).flexShrink },
      bodyOverflowY: getComputedStyle(body).overflowY,
      regions: document.querySelectorAll('[data-feedback-composer]').length,
      scrollers, horizontalScrollers, items,
    }
  })
  composerGeometries.push({ label, ...geometry } as ComposerGeometry)
}

async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate(theme => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.classList.toggle('light', theme === 'light')
  }, theme)
  await frames(page)
  // Controls carry transition-all, so an inherited colour is still animating from the old theme
  // for 150ms after the class flips; read only once every transition has landed.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter(animation => animation instanceof CSSTransition).map(animation => animation.finished.catch(() => undefined))))
  await frames(page)
}

/** WCAG 2.x contrast of every 12px text element in the composer, colours resolved by the browser. */
async function measureContrast(page: Page, theme: 'dark' | 'light') {
  await setTheme(page, theme)
  const measured = await page.evaluate(() => {
    // oklch() and color-mix() reach getComputedStyle unconverted, so the canvas does the conversion.
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (color: string) => {
      context.fillStyle = '#010203'
      context.fillStyle = color
      if (context.fillStyle === '#010203' && color !== 'rgb(1, 2, 3)') throw new Error(`The canvas rejected ${color}`)
      context.clearRect(0, 0, 1, 1)
      context.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!, a! / 255]
    }
    const over = (top: number[], bottom: number[]) => [0, 1, 2].map(index => top[index]! * top[3]! + bottom[index]! * (1 - top[3]!)).concat(1)
    const luminance = (color: number[]) => {
      const [r, g, b] = color.slice(0, 3).map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const page = rgba(getComputedStyle(document.body).backgroundColor)
    const base = page[3]! > 0 ? over(page, [255, 255, 255, 1]) : [255, 255, 255, 1]
    const background = (element: Element) => {
      const layers: number[][] = []
      for (let node: Element | null = element; node; node = node.parentElement) {
        const layer = rgba(getComputedStyle(node).backgroundColor)
        if (layer[3]! > 0) layers.push(layer)
        if (layer[3]! >= 1) break
      }
      return layers.reverse().reduce((below, layer) => over(layer, below), base)
    }
    const opacity = (element: Element) => {
      let value = 1
      for (let node: Element | null = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity)
      return value
    }
    const composer = document.querySelector('[data-feedback-composer]')!
    return [...composer.querySelectorAll('*')]
      .filter(element => [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim()))
      .filter(element => element.closest('.sr-only') === null)
      .filter(element => {
        const style = getComputedStyle(element)
        const r = element.getBoundingClientRect()
        return style.fontSize === '12px' && style.visibility === 'visible' && r.width > 1 && r.height > 1
      })
      .map(element => {
        const text = rgba(getComputedStyle(element).color)
        text[3] = text[3]! * opacity(element)
        const bg = background(element)
        const fg = over(text, bg)
        const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
        const data = [...element.attributes].find(attribute => attribute.name.startsWith('data-'))
        return { key: `${element.tagName.toLowerCase()}${data ? `[${data.name}]` : ''}[${(element.textContent ?? '').trim().slice(0, 40)}]`,
          ratio: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100, fg: fg.slice(0, 3), bg: bg.slice(0, 3) }
      })
  })
  const min = measured.reduce((lowest, sample) => sample.ratio < lowest.ratio ? sample : lowest, measured[0] ?? { key: 'none', ratio: 0 })
  contrast.push({ theme, count: measured.length, min: min.ratio, minKey: min.key,
    below: measured.filter(sample => sample.ratio < 4.5).map(({ key, ratio }) => ({ key, ratio })), samples: measured })
}

/** The tree row that carries the step door: name, duration and door, and whether the row wrapped. */
async function measureStepRow(page: Page, label: string) {
  await frames(page)
  const row = await page.evaluate(() => {
    const box = (element: Element): Box => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const door = document.querySelector('li[data-step-id] [data-feedback-entry="step"]')
    if (!door) throw new Error('No tree row carries the step door')
    const row = door.closest('li[data-step-id]')!
    const button = row.querySelector(':scope > button')!
    return { stepId: row.getAttribute('data-step-id'), width: row.clientWidth,
      name: box(button.querySelector(':scope > div.min-w-0')!), duration: box(button.querySelector(':scope > span:last-child')!),
      door: box(door), flexWrap: getComputedStyle(button).flexWrap }
  })
  stepRows.push({ label, ...row })
}

async function resizeTo(page: Page, width: number, layout: 'docked' | 'stacked') {
  await page.setViewportSize({ width, height: DESKTOP.height })
  await page.locator(`[data-feedback-composer][data-feedback-layout="${layout}"]`).waitFor({ timeout: 10_000 })
  await frames(page)
  return await page.locator('[data-feedback-composer]').getAttribute('data-feedback-layout')
}

/**
 * RESEARCH A4 on the shipped bundle: react-resizable-panels is assumed to keep a panel's children
 * mounted when the arrangement's panel ids change. Stored nodes are compared across a round trip.
 */
async function paneWidths(page: Page) {
  return await page.evaluate(() => ['run-tree', 'run-evidence', 'run-feedback']
    .map(id => Math.round(document.getElementById(id)?.getBoundingClientRect().width ?? -1)))
}

async function observeRemount(page: Page): Promise<Remount> {
  const opened = await page.locator('[data-feedback-composer]').getAttribute('data-feedback-layout')
  const panesBefore = await paneWidths(page)
  await page.getByRole('tab', { name: /^Overview/ }).click()
  const present = await page.locator('[data-player]').first().waitFor({ timeout: 10_000 }).then(() => true, () => false)
  const before = await page.evaluate(async () => {
    const held = window as unknown as Record<string, Element | null>
    held.heldComposer = document.querySelector('[data-feedback-composer]')
    held.heldPlayer = document.querySelector('[data-player]')
    const video = document.querySelector('[data-player] video')
    held.heldVideo = video
    if (video instanceof HTMLVideoElement) {
      if (video.readyState < 1) await new Promise(resolve => { video.addEventListener('loadedmetadata', resolve, { once: true }); setTimeout(resolve, 5_000) })
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const seeked = new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 5_000) })
        video.pause()
        video.currentTime = video.duration / 2
        await seeked
      }
    }
    return { time: video instanceof HTMLVideoElement ? video.currentTime : undefined,
      elapsed: document.querySelector('[data-player-time]')?.getAttribute('data-player-elapsed-ms') ?? null }
  })
  const narrow = await resizeTo(page, 400, 'stacked')
  const restored = await resizeTo(page, DESKTOP.width, 'docked')
  const playerAfter = await page.evaluate(() => {
    const held = window as unknown as Record<string, Element | null>
    const video = document.querySelector('[data-player] video')
    return { composer: held.heldComposer === document.querySelector('[data-feedback-composer]'),
      section: held.heldPlayer !== null && held.heldPlayer === document.querySelector('[data-player]'),
      video: video !== null, sameVideo: held.heldVideo !== null && held.heldVideo === video,
      time: video instanceof HTMLVideoElement ? video.currentTime : undefined,
      elapsed: document.querySelector('[data-player-time]')?.getAttribute('data-player-elapsed-ms') ?? null }
  })

  const network = page.getByRole('tab', { name: /^Network/ })
  await network.click()
  await page.locator('[role="tabpanel"][data-state="active"]').waitFor()
  const selectedBefore = await network.getAttribute('aria-selected')
  await page.evaluate(() => {
    const held = window as unknown as Record<string, Element | null>
    held.heldTree = document.querySelector('ul[role="tree"]')
    held.heldPanel = document.querySelector('[role="tabpanel"][data-state="active"]')
  })
  const networkNarrow = await resizeTo(page, 400, 'stacked')
  const networkRestored = await resizeTo(page, DESKTOP.width, 'docked')
  const held = await page.evaluate(() => {
    const held = window as unknown as Record<string, Element | null>
    return { tree: held.heldTree !== null && held.heldTree === document.querySelector('ul[role="tree"]'),
      panel: held.heldPanel !== null && held.heldPanel === document.querySelector('[role="tabpanel"][data-state="active"]') }
  })
  return {
    layouts: { opened, narrow, restored },
    panes: { before: panesBefore, after: await paneWidths(page) },
    composer: playerAfter.composer,
    player: { present, section: playerAfter.section, video: playerAfter.video, sameVideo: playerAfter.sameVideo,
      before: before.time, after: playerAfter.time, elapsedBefore: before.elapsed, elapsedAfter: playerAfter.elapsed },
    network: { ...held, selectedBefore, selectedAfter: await network.getAttribute('aria-selected'),
      layouts: { narrow: networkNarrow, restored: networkRestored } },
  }
}

async function driveLayout(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: DESKTOP })
  const page = await context.newPage()
  await page.goto(url)
  await measureHeader(page, DESKTOP_LABEL)
  await page.locator('[data-feedback-entry="test"]').click()
  const composer = page.locator('[data-feedback-composer]')
  await composer.waitFor()
  await composer.locator('[data-feedback-choice]').first().waitFor()
  await frames(page)
  aria = { heading: (await composer.locator('h2').innerText()).replace(/\s+/g, ' ').trim(),
    snapshot: await composer.ariaSnapshot(), state: await composer.getAttribute('data-feedback-state'),
    outcomeClass: await composer.locator('[data-feedback-choices]').getAttribute('data-feedback-outcome-class'),
    scopeLine: await composer.locator('[data-feedback-scope-line]').innerText() }
  await composer.locator('[data-feedback-choice] [role="radio"]').first().click()
  await composer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor({ timeout: 15_000 })
  await frames(page)
  await measureComposer(page, DESKTOP_LABEL)
  await measureStepRow(page, DESKTOP_LABEL)
  await captureTo(page, 'composer-1280')
  await measureContrast(page, 'dark')
  await measureContrast(page, 'light')
  await setTheme(page, 'dark')
  remount = await observeRemount(page)
  // 426-04's container query: a docked page this narrow leaves the tree's door row under 14rem.
  await resizeTo(page, 1000, 'docked')
  await measureStepRow(page, DOCKED_NARROW_LABEL)
  await page.close()

  const mid = await context.newPage()
  for (const width of MID_WIDTHS) {
    await mid.setViewportSize({ width, height: DESKTOP.height })
    if (mid.url() === 'about:blank') await mid.goto(url)
    await measureHeader(mid, `${width}x800`)
  }
  await mid.close()

  const narrow = await context.newPage()
  await narrow.setViewportSize({ width: 400, height: DESKTOP.height })
  await narrow.goto(url)
  await measureHeader(narrow, NARROW_LABEL)
  await openComposerWithPreview(narrow)
  await measureComposer(narrow, NARROW_LABEL)
  await measureStepRow(narrow, NARROW_LABEL)
  await captureTo(narrow, 'composer-400')
  await context.close()

  // Real browser zoom, not device density: 425's isolated MV3 extension calls Chrome's own
  // setZoom/getZoom on the fixture tab.
  // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
  const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-426-zoom-')))
  const extension = join(zoomRoot, 'extension')
  mkdirSync(extension)
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'Local composer zoom probe', version: '1.0',
    host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
  writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
  zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
    channel: 'chromium', headless: true, viewport: DESKTOP,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
  const zoomPage = await zoomContext.newPage()
  await zoomPage.goto(url)
  await settleHeader(zoomPage)
  const before = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
  // The page rewrites its own URL once a step is selected, so the tab is found by origin.
  const factor = await worker.evaluate(async origin => {
    const tabs = (globalThis as unknown as { chrome: { tabs: {
      query(query: object): Promise<Array<{ id?: number; url?: string }>>
      setZoom(id: number, factor: number): Promise<void>
      getZoom(id: number): Promise<number>
    } } }).chrome.tabs
    const [tab, ...others] = (await tabs.query({})).filter(candidate => candidate.url?.startsWith(`${origin}/runs/`))
    if (tab?.id === undefined || others.length > 0) throw new Error(`The isolated extension found ${String(others.length + (tab ? 1 : 0))} fixture tabs`)
    await tabs.setZoom(tab.id, 2)
    return await tabs.getZoom(tab.id)
  }, new URL(url).origin)
  await zoomPage.waitForFunction(dpr => devicePixelRatio >= dpr * 1.99, before.dpr)
  const after = await zoomPage.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
  zoom = { factor, beforeWidth: before.width, afterWidth: after.width, beforeDpr: before.dpr, afterDpr: after.dpr }
  await measureHeader(zoomPage, ZOOM_LABEL)
  await openComposerWithPreview(zoomPage)
  await measureComposer(zoomPage, ZOOM_LABEL)
  await measureStepRow(zoomPage, ZOOM_LABEL)
  await captureTo(zoomPage, 'composer-browser-200-percent', true)
  await zoomContext.close()
  zoomContext = undefined
}

describe('contextual feedback on the shipped bundle', () => {
  beforeAll(async () => {
    try {
      // The layout recipe records six steps for member 0, so a second step exists to select while
      // composing, and the first step's page load leaves a response body to copy.
      fixture = await recordingFixture('feedback-layout', false, true)
      await fixture.dashboard.stop()
      const env = populatedRunSpawnEnv()
      // A cold reader without the planted credential environment: the fixture's synthetic values
      // stay masked, so the captures carry nothing this repository did not invent.
      delete env[POPULATED_SECRET_ENV_VAR]
      const port = await reserveEphemeralPort()
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, port, 60_000, env)
      if (!reader.ready) throw new Error(reader.stderr())
      const runId = fixture.drive.runId
      const url = `${reader.origin}/runs/${encodeURIComponent(runId)}`

      const context = await fixture.browser.newContext({ viewport: DESKTOP })
      // Observe what the shipped button writes without depending on desktop clipboard permissions.
      await context.addInitScript(() => {
        const copied: string[] = []
        ;(window as unknown as { copied: string[] }).copied = copied
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async (text: string) => { copied.push(text) } },
        })
      })
      const page = await context.newPage()
      await page.goto(url)
      await page.locator('[data-feedback-entry="step"]').waitFor({ timeout: 15_000 })
      await frames(page)

      // Open Question 4, observed rather than assumed: the host binds feedback, so member 0
      // carries a marks array, and the consequences read answers for it on this run.
      settled = await page.evaluate(async runId => {
        const detail = await fetch(`/api/runs/${encodeURIComponent(runId)}/detail`)
        const body = await detail.json() as { members?: Array<{ testIndex: number; testId?: string; marks?: unknown }>; steps?: Array<{ testIndex?: number }> }
        const member = body.members?.find(entry => entry.testIndex === 0)
        // The layout recipe is a two-member suite, so an unaddressed read is the ambiguous arm.
        const preview = await fetch(`/api/runs/${encodeURIComponent(runId)}/mark-preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, kind: 'false-fail', ...(member?.testId === undefined ? {} : { testId: member.testId }) }),
        })
        return { detailStatus: detail.status, marks: member?.marks,
          stepCount: (body.steps ?? []).filter(step => step.testIndex === 0).length,
          previewStatus: preview.status, previewBody: await preview.json() as unknown }
      }, runId).then(({ previewBody, ...rest }) => {
        const parsed = RunsMarkPreviewResultSchema.safeParse(previewBody)
        return { ...rest, previewParsed: parsed.success, previewKind: parsed.success ? parsed.data.kind : undefined }
      })

      const doors = page.locator('[data-feedback-entry]')
      const loaded = await doors.count()
      const kinds = await doors.evaluateAll(elements => elements.map(element => element.getAttribute('data-feedback-entry') ?? ''))
      await scanPills(page, 'loaded')
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
      await page.keyboard.press('Escape')
      await page.locator('[role="treeitem"][aria-selected="true"]').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
      await frames(page)
      triggers = { loaded, kinds, afterEscape: await doors.count(),
        selectedAfterEscape: await page.locator('[role="treeitem"][aria-selected="true"]').count() }

      // SC4: compose on one step, then select a different step, open an evidence tab and copy a
      // value. Only the first step's network record carries a response body (the page load); the
      // later steps' failing fetch is recorded without one, so its panel offers nothing to copy.
      // The draft therefore sits on step 2 and the inspection happens on step 1.
      const modalCounts: Record<string, number> = {}
      const composed = page.locator('[data-step-id="0:1"]')
      const inspected = page.locator('[data-step-id="0:0"]')
      await composed.locator(':scope > button').click()
      await composed.locator('[data-feedback-entry="step"]').click()
      const composer = page.locator('[data-feedback-composer]')
      await composer.waitFor()
      const opened = await composer.getAttribute('data-feedback-target')
      modalCounts.composerOpen = await modalCount(page)
      await composer.locator('[data-feedback-choice] [role="radio"]').first().click()
      await composer.locator('[data-feedback-note]').fill(NOTE)
      await composer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor({ timeout: 15_000 })
      modalCounts.drafted = await modalCount(page)
      await scanPills(page, 'composer-open-preview-current')

      await inspected.locator(':scope > button').click()
      const pinned = composer.locator('[data-feedback-pinned]')
      await pinned.waitFor({ timeout: 5_000 })
      const pinnedVisible = await pinned.isVisible()
      const targetAfterSelect = await composer.getAttribute('data-feedback-target')
      const selectedAfter = await page.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-step-id')
      modalCounts.otherStepSelected = await modalCount(page)

      if (!await copyFromNetwork(page)) {
        // The plan's named fallback does not exist on the shipped page: the Variables tab renders
        // no copy control and the masked chip is presentational by design (405-11 D-10).
        throw new Error('The inspected step\'s Network panel offered no copy control, and the Variables tab renders none')
      }
      await page.waitForFunction(() => (window as unknown as { copied: string[] }).copied.length > 0, undefined, { timeout: 5_000 })
      modalCounts.copied = await modalCount(page)
      const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied)
      const composerOpen = await composer.isVisible()
      const note = await composer.locator('[data-feedback-note]').inputValue()
      const pinnedAfterCopy = await pinned.isVisible()
      await frames(page)
      await captureTo(page, 'compose-while-inspecting')
      modalCounts.captured = await modalCount(page)
      inspecting = { opened, selectedAfter, pinnedVisible, pinnedAfterCopy, targetAfterSelect, tab: 'network',
        copied, composerOpen, note, modalCounts }
      await context.close()

      // The layout drive runs before any mark exists so the composer opens idle. Its own failure
      // key keeps the mark drive below independent of it.
      try { await driveLayout(fixture.browser, url) } catch (error) { failures.layout = String(error) }

      // A real mark from the header entry, recorded on the click: `rowsAtReply` is read right after
      // the reply.
      const ledger = join(fixture.project.agentQaRoot, RUNS_SUBDIR, slugBranch(runId), 'marks.jsonl')
      const rows = () => existsSync(ledger)
        ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => MarkReceiptSchema.parse(JSON.parse(line)))
        : []
      const markContext = await fixture.browser.newContext({ viewport: DESKTOP })
      const markPage = await markContext.newPage()
      await markPage.goto(url)
      await markPage.locator('[data-feedback-entry="test"]').click({ timeout: 10_000 })
      const markComposer = markPage.locator('[data-feedback-composer]')
      await markComposer.locator('[data-feedback-choice] [role="radio"]').first().click()
      await markComposer.locator('[data-feedback-preview][data-preview-current="true"]').waitFor({ timeout: 15_000 })
      const response = markPage.waitForResponse(reply => reply.url().endsWith('/mark') && reply.request().method() === 'POST')
      await markComposer.locator('[data-feedback-submit]').click()
      const reply = await response
      const rowsAtReply = rows().length
      const parsed = RunsMarkOutcomeSchema.parse(await reply.json())
      const entries = markComposer.locator('[data-feedback-history="target"] [data-history-entry]')
      await markComposer.locator('[data-feedback-history="target"] [data-history-entry][data-history-new]').waitFor({ timeout: 15_000 })
      const newEntryMarkId = await markComposer.locator('[data-feedback-history="target"] [data-history-entry][data-history-new]').getAttribute('data-mark-id')
      const newEntryFirst = await entries.first().getAttribute('data-history-new') === 'true'
      const newEntry = markComposer.locator('[data-feedback-history="target"] [data-history-entry][data-history-new]')
      const newEntryControls = await newEntry.locator('button, a, [role="button"], [role="link"]').count()
      const newEntryApplied = await newEntry.locator('[data-history-applied]').count()
      markPath = { rowsAtReply,
        status: reply.status(),
        outcome: { kind: parsed.kind, ...('receipt' in parsed ? { markId: parsed.receipt.markId } : {}) },
        rows: rows().map(({ markId, kind, origin, testIndex, stepIndex, disposition }) =>
          ({ markId, kind, origin, testIndex, stepIndex, disposition: disposition.kind })),
        newEntryMarkId, newEntryFirst, newEntryControls, newEntryApplied }
      await markContext.close()

      if (process.env.AGENT_QA_426_CAPTURE_DIR) {
        writeFileSync(join(process.env.AGENT_QA_426_CAPTURE_DIR, 'feedback-observation.json'),
          JSON.stringify({ runId, settled, triggers, pills, inspecting, markPath,
            layout: { zoom, headerGeometries, composerGeometries, stepRows, remount, contrast, aria } }, null, 2))
      }
    } catch (error) { failures.drive = String(error) }
  }, 360_000)

  afterAll(async () => { await zoomContext?.close(); await reader?.stop(); await fixture?.close(); cleanupTempRoots() })

  it('FEEDBACK-FIXTURE-SETTLED', () => {
    expect(failures.drive, 'the drive threw before every observation was recorded').toBeUndefined()
    expect(settled?.detailStatus, JSON.stringify(settled)).toBe(200)
    expect(Array.isArray(settled!.marks), `member 0 carries no marks array: ${JSON.stringify(settled)}`).toBe(true)
    expect(settled!.stepCount, 'member 0 needs a second step to select while composing').toBeGreaterThanOrEqual(2)
    expect(settled!.previewStatus, JSON.stringify(settled)).toBe(200)
    expect(settled!.previewParsed, `mark-preview body failed RunsMarkPreviewResultSchema: ${JSON.stringify(settled)}`).toBe(true)
    expect(['consequences', 'quarantined'], JSON.stringify(settled)).toContain(settled!.previewKind)
  })

  it('TRIGGER-COUNT-ON-BINARY', () => {
    expect(triggers, JSON.stringify(failures)).toBeDefined()
    expect(triggers!.loaded, JSON.stringify(triggers)).toBe(2)
    expect([...triggers!.kinds].sort(), JSON.stringify(triggers)).toEqual(['step', 'test'])
    expect(triggers!.selectedAfterEscape, JSON.stringify(triggers)).toBe(0)
    expect(triggers!.afterEscape, JSON.stringify(triggers)).toBe(1)
  })

  it('NO-PILL-ON-BINARY', () => {
    expect(pills.map(scan => scan.label), JSON.stringify(failures)).toEqual(['loaded', 'composer-open-preview-current'])
    for (const scan of pills) {
      expect(scan.markKinds, scan.label).toBe(0)
      expect(scan.leaked, scan.label).toEqual([])
    }
  })

  it('COMPOSE-WHILE-INSPECTING', () => {
    expect(inspecting, JSON.stringify(failures)).toBeDefined()
    const where = JSON.stringify(inspecting)
    expect(inspecting!.opened, where).toBe('0:1')
    expect(inspecting!.selectedAfter, where).toBe('0:0')
    expect(inspecting!.pinnedVisible, where).toBe(true)
    expect(inspecting!.pinnedAfterCopy, where).toBe(true)
    expect(inspecting!.targetAfterSelect, where).toBe(inspecting!.opened)
    expect(inspecting!.copied.length, where).toBeGreaterThan(0)
    expect(inspecting!.copied.every(text => text.length > 0), where).toBe(true)
    expect(inspecting!.composerOpen, where).toBe(true)
    expect(inspecting!.note, where).toBe(NOTE)
    expect(Object.keys(inspecting!.modalCounts), where).toEqual(['composerOpen', 'drafted', 'otherStepSelected', 'copied', 'captured'])
    for (const [moment, count] of Object.entries(inspecting!.modalCounts)) expect(count, `${moment}: ${where}`).toBe(0)
  })

  it('MARK-RECORDED-ON-CLICK', () => {
    expect(markPath, JSON.stringify(failures)).toBeDefined()
    const where = JSON.stringify(markPath)
    // The mark is one click, and the ledger holds its row as the reply lands.
    expect(markPath!.rowsAtReply, where).toBe(1)
    expect(markPath!.status, where).toBe(200)
    expect(markPath!.outcome?.kind, where).toBe('marked')
    expect(markPath!.rows, where).toHaveLength(1)
    expect(markPath!.rows[0]!.markId, where).toBe(markPath!.outcome!.markId)
    expect(markPath!.rows[0]!.origin, where).toBe('user')
    expect(markPath!.newEntryMarkId, where).toBe(markPath!.outcome!.markId)
    expect(markPath!.newEntryFirst, where).toBe(true)
    // The new history entry says what changed in one line when a fix was applied and carries no
    // control.
    expect(markPath!.newEntryControls, where).toBe(0)
    expect(markPath!.newEntryApplied, where).toBe(markPath!.rows[0]!.disposition === 'applied' ? 1 : 0)
  })

  it('HEADER-ENTRY-GEOMETRY', () => {
    expect(headerGeometries.map(geometry => geometry.label), JSON.stringify(failures)).toEqual(HEADER_LABELS)
    for (const geometry of headerGeometries) {
      const where = `${geometry.label} innerWidth=${geometry.innerWidth} dpr=${geometry.dpr}`
      expect(geometry.entryCount, `${where}: header entries on the page`).toBe(1)
      expect(geometry.rowEntryCount, `${where}: header entries in the verdict row`).toBe(1)
      const entry = geometry.items[geometry.entry]
      expect(entry, `${where}: the header entry was not measured`).toBeDefined()
      expect(inside(entry!.box, entry!.clip), `${where}: entry ${JSON.stringify(entry!.box)} escapes its clip ${JSON.stringify(entry!.clip)}`).toBe(true)
      expect(inside(entry!.box, geometry.header), `${where}: entry ${JSON.stringify(entry!.box)} escapes the header ${JSON.stringify(geometry.header)}`).toBe(true)
      for (const [index, item] of geometry.items.entries()) {
        if (index === geometry.entry || item.contains.includes(geometry.entry) || entry!.contains.includes(index)) continue
        expect(overlaps(entry!.box, item.box), `${where}: entry ${JSON.stringify(entry!.box)} overlaps ${item.key} ${JSON.stringify(item.box)}`).toBe(false)
      }
      expect(geometry.entryOnTop, `${where}: a pointer at the entry's centre hits ${geometry.entryHit}`).toBe(true)
      // 425's BADGE-DOMINANT-GEOMETRY measurement, unchanged.
      const badge = geometry.texts.find(text => text.kind === 'badge')
      expect(badge, `${where}: no text-bearing verdict badge`).toBeDefined()
      expect(badge!.fontSize, `${where}: badge font-size`).toBe(14)
      expect(badge!.fontWeight, `${where}: badge font-weight`).toBe(500)
      for (const text of geometry.texts) {
        if (text === badge) continue
        expect(badge!.box.height >= text.box.height - 0.5,
          `${where}: badge height ${badge!.box.height} is not at least ${text.key} height ${text.box.height}`).toBe(true)
        if (text.kind === 'indicator' || text.kind === 'token' || text.kind === 'duration') {
          expect(text.fontSize, `${where}: ${text.kind} ${text.key} font-size`).toBe(12)
        }
      }
    }
  })

  it('COMPOSER-STACKS-NARROW', () => {
    expect(composerGeometries.map(geometry => geometry.label), JSON.stringify(failures)).toEqual(GEOMETRY_LABELS)
    expect(zoom?.factor, JSON.stringify(zoom)).toBe(2)
    expect(zoom!.afterWidth, JSON.stringify(zoom)).toBe(zoom!.beforeWidth / 2)
    expect(zoom!.afterDpr, JSON.stringify(zoom)).toBe(zoom!.beforeDpr * 2)
    for (const geometry of composerGeometries) {
      const where = `${geometry.label} innerWidth=${geometry.innerWidth} composer=${JSON.stringify(geometry.composer)} evidence=${JSON.stringify(geometry.evidence)} group=${JSON.stringify(geometry.group)}`
      expect(geometry.regions, where).toBe(1)
      if (geometry.label === DESKTOP_LABEL) {
        expect(geometry.layout, where).toBe('docked')
        expect(geometry.composer.x >= geometry.evidence.right - 1, `${where}: the docked composer is not right of the evidence`).toBe(true)
        expect(geometry.composer.y < geometry.evidence.bottom && geometry.evidence.y < geometry.composer.bottom, `${where}: docked panes do not share a row`).toBe(true)
        continue
      }
      expect(geometry.layout, where).toBe('stacked')
      expect(geometry.innerWidth, where).toBeLessThan(768)
      expect(geometry.evidence.y >= geometry.tree.bottom - 1, `${where}: the evidence is not below the tree ${JSON.stringify(geometry.tree)}`).toBe(true)
      expect(geometry.composer.y >= geometry.evidence.bottom - 1, `${where}: the stacked composer is not below the evidence`).toBe(true)
      expect(geometry.composer.width >= geometry.group.width - 2, `${where}: the stacked composer does not span the group`).toBe(true)
      expect(geometry.panel.bottom <= geometry.viewport.bottom + 0.5, `${where}: the composer panel runs past the viewport`).toBe(true)
    }
  })

  it('COMPOSER-NO-OVERLAP', () => {
    expect(composerGeometries.map(geometry => geometry.label), JSON.stringify(failures)).toEqual(GEOMETRY_LABELS)
    for (const geometry of composerGeometries) {
      const where = `${geometry.label} innerWidth=${geometry.innerWidth} dpr=${geometry.dpr}`
      expect(geometry.items.length, where).toBeGreaterThan(10)
      for (const part of ['header', 'footer'] as const) {
        expect(inside(geometry[part], geometry.composer), `${where}: ${part} ${JSON.stringify(geometry[part])} escapes the composer ${JSON.stringify(geometry.composer)}`).toBe(true)
        expect(inside(geometry[part], geometry.viewport), `${where}: ${part} ${JSON.stringify(geometry[part])} is outside the viewport`).toBe(true)
        expect(geometry.shrink[part], `${where}: ${part} flex-shrink`).toBe('0')
      }
      expect(geometry.bodyOverflowY, where).toBe('auto')
      expect(geometry.scrollers, `${where}: scrolling elements inside the composer`).toEqual(['body'])
      expect(geometry.horizontalScrollers, `${where}: horizontal scrollers inside the composer`).toEqual([])
      for (const [index, item] of geometry.items.entries()) {
        const held = item.scrolls ? insideX(item.box, item.clip) : inside(item.box, item.clip)
        expect(held, `${where}: ${item.key} ${JSON.stringify(item.box)} is clipped by ${JSON.stringify(item.clip)}`).toBe(true)
        for (const [other, candidate] of geometry.items.entries()) {
          if (other <= index || item.contains.includes(other) || candidate.contains.includes(index)) continue
          const [a, b] = item.scope === candidate.scope ? [item.box, candidate.box] : [visible(item), visible(candidate)]
          if (a === undefined || b === undefined) continue
          expect(overlaps(a, b), `${where}: ${item.key} ${JSON.stringify(a)} overlaps ${candidate.key} ${JSON.stringify(b)}`).toBe(false)
        }
      }
    }
  })

  it('LAYOUT-SWITCH-NO-REMOUNT', () => {
    expect(remount, JSON.stringify(failures)).toBeDefined()
    const where = JSON.stringify(remount)
    expect(remount!.layouts, where).toEqual({ opened: 'docked', narrow: 'stacked', restored: 'docked' })
    expect(remount!.composer, where).toBe(true)
    // Back at the same width after two round trips, the docked panes are where they started: the
    // tree is not squeezed and the composer is not pinned at its cap.
    expect(remount!.panes.before.every(width => width > 200), where).toBe(true)
    for (const [index, width] of remount!.panes.after.entries()) {
      expect(Math.abs(width - remount!.panes.before[index]!), `${where}: pane ${String(index)}`).toBeLessThanOrEqual(1)
    }
    // 426-11's handed-over A4 check: the player itself survives the switch, and with it its position.
    expect(remount!.player.present, where).toBe(true)
    expect(remount!.player.section, where).toBe(true)
    if (remount!.player.video) {
      expect(remount!.player.sameVideo, where).toBe(true)
      expect(remount!.player.after, where).toBeCloseTo(remount!.player.before!, 2)
    }
    expect(remount!.player.elapsedAfter, where).toBe(remount!.player.elapsedBefore)
    expect(remount!.network.layouts, where).toEqual({ narrow: 'stacked', restored: 'docked' })
    expect(remount!.network.tree, where).toBe(true)
    expect(remount!.network.panel, where).toBe(true)
    expect(remount!.network.selectedBefore, where).toBe('true')
    expect(remount!.network.selectedAfter, where).toBe('true')
  })

  // 426-04's container query, which jsdom cannot run: the door row moves its duration onto its own
  // line below 14rem and keeps it beside the name above, and name, duration and door never meet.
  it('STEP-ROW-DOOR-WRAP', () => {
    expect(stepRows.map(row => row.label), JSON.stringify(failures)).toEqual([DESKTOP_LABEL, DOCKED_NARROW_LABEL, NARROW_LABEL, ZOOM_LABEL])
    expect(stepRows.some(row => row.width < ROW_WRAP_BELOW_PX), JSON.stringify(stepRows)).toBe(true)
    expect(stepRows.some(row => row.width >= ROW_WRAP_BELOW_PX), JSON.stringify(stepRows)).toBe(true)
    for (const row of stepRows) {
      const where = `${row.label} row ${row.stepId} width=${row.width}: ${JSON.stringify(row)}`
      const narrow = row.width < ROW_WRAP_BELOW_PX
      expect(row.flexWrap, where).toBe(narrow ? 'wrap' : 'nowrap')
      expect(row.duration.y >= row.name.bottom - 1, `${where}: duration on its own line`).toBe(narrow)
      expect(row.name.width, `${where}: the name column collapsed`).toBeGreaterThan(40)
      expect(overlaps(row.name, row.duration), `${where}: name meets duration`).toBe(false)
      expect(overlaps(row.name, row.door), `${where}: name meets door`).toBe(false)
      expect(overlaps(row.duration, row.door), `${where}: duration meets door`).toBe(false)
    }
  })

  it('COMPOSER-CONTRAST', () => {
    expect(contrast.map(entry => entry.theme), JSON.stringify(failures)).toEqual(['dark', 'light'])
    for (const entry of contrast) {
      const where = `${entry.theme}: ${JSON.stringify(entry.below)}`
      expect(entry.count, `${entry.theme}: no 12px text was measured`).toBeGreaterThan(5)
      expect(entry.below, where).toEqual([])
      expect(entry.min, where).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('COMPOSER-ARIA-SNAPSHOT', () => {
    expect(aria, JSON.stringify(failures)).toBeDefined()
    const lines = aria!.snapshot.split('\n')
    const flat = lines.map(unquoted)
    const where = aria!.snapshot
    expect(aria!.state, where).toBe('composing')
    expect(aria!.heading.length, where).toBeGreaterThan(0)
    expect(flat[0], where).toBe(`- region ${JSON.stringify(aria!.heading)}:`)
    expect(flat.some(line => line.startsWith(`- heading ${JSON.stringify(aria!.heading)} [level=2]`)), where).toBe(true)
    const group = lines.findIndex(line => /^\s*- radiogroup\b/.test(line))
    expect(group, where).toBeGreaterThan(0)
    const indent = lines[group]!.search(/\S/)
    const children: string[] = []
    for (const line of lines.slice(group + 1)) {
      if (line.search(/\S/) <= indent) break
      children.push(unquoted(line))
    }
    const radios = children.filter(line => line.startsWith('- radio '))
    expect(radios, where).toHaveLength(3)
    // This fixture's run passed, so the header door's target is a passed test: the passed order is
    // what the page must present, and the scope line says so in words.
    expect(aria!.outcomeClass, where).toBe('passed')
    expect(aria!.scopeLine, where).toContain('recorded: passed')
    for (const [index, label] of CHOICE_ORDER[aria!.outcomeClass!]!.entries()) {
      expect(radios[index]!.startsWith(`- radio "${label} `), `${where}\nradio ${String(index + 1)} is not ${label}`).toBe(true)
    }
    expect(radios.every(line => !line.includes('[checked]')), where).toBe(true)
    expect(flat.some(line => line.startsWith('- textbox "Note (optional)"')), where).toBe(true)
    expect(flat.some(line => line.startsWith('- button "Send feedback"')), where).toBe(true)
  })
})
