// Web execute() compound behaviors used by the web adapter (adapter.ts). The runner owns the pure
// verdict machine (compareFillReread) and loop discipline (runUntilVisibleLoop /
// runDirectionScroll / runToEndScroll over injected ScrollPrimitives); this module supplies the
// Playwright primitives and stitches them into ONE ActionResult per compound.

import type { Frame, JSHandle, Locator, Page } from 'playwright-core'
import type { ActionResult } from '@vostride/agent-qa-runner'
import {
  compareFillReread,
  runUntilVisibleLoop,
  runDirectionScroll,
  runToEndScroll,
  swipeSignalFromOffsets,
  scrollerSetSwipeSignal,
  type DocumentScrollOffsets,
  type ScrollPrimitives,
  type SwipeSignal,
  type Direction,
  type TargetVisibility,
} from '@vostride/agent-qa-runner'
import type { Fill, Scroll, Ref } from '@vostride/agent-qa-schema'
import { parseAriaSnapshot } from './observer.js'
import { scrollWithRef } from './scroll-helper.js'
import type { RefMap } from './types.js'

type BoundingBox = { x: number; y: number; width: number; height: number }

// `inputValue()` throws outside input, textarea and select; unreadable is `undefined`, never `''`.
export async function safeInputValue(locator: Locator): Promise<string | undefined> {
  try {
    return await locator.inputValue()
  } catch {
    try {
      const value = await locator.evaluate((el) => {
        const node = el as unknown as { value?: unknown; textContent?: unknown }
        return (node.value ?? node.textContent) as unknown
      })
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }
}

export async function runWebFillCompound(
  locator: Locator,
  boundingBox: BoundingBox | undefined,
  action: Pick<Fill, 'text' | 'clearMode' | 'submit'>,
): Promise<ActionResult> {
  const isAppend = action.clearMode === 'append'
  // The prior value is read before any typing, because append expects prior plus typed.
  const prior = isAppend ? (await safeInputValue(locator)) ?? '' : ''
  // Secure detection is web-live: the ARIA snapshot carries no input type.
  const secure = (await locator.getAttribute('type')) === 'password'

  if (isAppend) {
    await locator.click()
    await locator.press('End')
    await locator.pressSequentially(action.text)
  } else {
    await locator.fill(action.text)
  }

  const expected = isAppend ? prior + action.text : action.text
  const actual = await safeInputValue(locator)
  const box = boundingBox ? { boundingBox } : {}

  if (actual === undefined) {
    return { success: true, ...box, metadata: { fillVerdict: { verb: 'fill', verdict: 'unverified' } } }
  }

  const verdict = compareFillReread({ expected, actual, secure })
  if (verdict.ok && action.submit) {
    await locator.press('Enter')
  }
  const metadata = {
    ...(verdict.meta ? { fillReread: verdict.meta } : {}),
    fillVerdict: {
      verb: 'fill',
      verdict: verdict.verdict,
      ...(verdict.secure ? { secure: true } : {}),
    },
  }
  return verdict.ok
    ? { success: true, ...box, metadata }
    : { success: false, error: verdict.selfCorrectingError, ...box, metadata }
}

function deltaFor(direction: Direction, magnitude: number): { dx: number; dy: number; axis: 'horizontal' | 'vertical' } {
  switch (direction) {
    case 'down':
      return { dx: 0, dy: magnitude, axis: 'vertical' }
    case 'up':
      return { dx: 0, dy: -magnitude, axis: 'vertical' }
    case 'right':
      return { dx: magnitude, dy: 0, axis: 'horizontal' }
    case 'left':
      return { dx: -magnitude, dy: 0, axis: 'horizontal' }
  }
}

// rAF settle between gestures — reuses the pre-flip scroll settle discipline.
async function settle(page: Page): Promise<void> {
  await page.evaluate(`new Promise(resolve => {
    const t = setTimeout(() => resolve('timeout'), 500);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(t);
      resolve('raf');
    }));
  })`)
}

type Axis = 'horizontal' | 'vertical'
type PointerChain = { before: DocumentScrollOffsets[]; after: DocumentScrollOffsets[] }

// In-page, before the wheel: every element that can scroll on the swiped axis (range above 0 and
// a scrolling overflow) plus the document scroller, mapped to its offsets, and a once-only passive
// wheel listener on window that records the event target. The state is returned as a handle only;
// nothing is written to window or the DOM.
function snapshotScrollers(axis: Axis): unknown {
  type El = {
    scrollLeft: number
    scrollTop: number
    scrollWidth: number
    scrollHeight: number
    clientWidth: number
    clientHeight: number
  }
  const g = globalThis as unknown as {
    document: {
      scrollingElement: El | null
      documentElement: El
      body: El | null
      querySelectorAll(selector: string): ArrayLike<El>
    }
    getComputedStyle(el: El): { overflowX: string; overflowY: string }
    addEventListener(type: string, listener: (event: { target: unknown }) => void, options: object): void
  }
  const doc = g.document
  const root = doc.scrollingElement ?? doc.documentElement
  const read = (el: El) => ({
    x: el.scrollLeft,
    y: el.scrollTop,
    maxX: el.scrollWidth - el.clientWidth,
    maxY: el.scrollHeight - el.clientHeight,
  })
  const scrolls = (value: string): boolean => value === 'auto' || value === 'scroll' || value === 'overlay'
  const rootStyle = g.getComputedStyle(doc.documentElement)
  const bodyPropagates = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
  const offsets = new Map<El, ReturnType<typeof read>>()
  offsets.set(root, read(root))
  const all = doc.querySelectorAll('*')
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]
    if (el === root || el === doc.documentElement) continue
    if (el === doc.body && bodyPropagates) continue
    const o = read(el)
    if (!((axis === 'vertical' ? o.maxY : o.maxX) > 0)) continue
    const style = g.getComputedStyle(el)
    if (!scrolls(axis === 'vertical' ? style.overflowY : style.overflowX)) continue
    offsets.set(el, o)
  }
  const state: { offsets: typeof offsets; target: unknown; listener: (event: { target: unknown }) => void } = {
    offsets,
    target: null,
    listener: () => undefined,
  }
  state.listener = (event) => {
    state.target = event.target
  }
  g.addEventListener('wheel', state.listener, { capture: true, once: true, passive: true })
  return state
}

// In-page, after the wheel: the chain is the recorded target and its ancestors that were
// snapshotted, in order, then the document scroller. Returns the aligned before/after offsets, or
// nothing (and removes the listener) when no wheel event was observed.
function readPointerChain(state: unknown): unknown {
  type El = {
    scrollLeft: number
    scrollTop: number
    scrollWidth: number
    scrollHeight: number
    clientWidth: number
    clientHeight: number
    parentElement: El | null
  }
  const g = globalThis as unknown as {
    document: { scrollingElement: El | null; documentElement: El }
    removeEventListener(type: string, listener: unknown, options: object): void
  }
  const s = state as { offsets: Map<El, unknown>; target: El | null; listener: unknown }
  if (!s.target) {
    g.removeEventListener('wheel', s.listener, { capture: true })
    return undefined
  }
  const root = g.document.scrollingElement ?? g.document.documentElement
  const chain: El[] = []
  for (let el: El | null = s.target; el; el = el.parentElement) {
    if (s.offsets.has(el) && !chain.includes(el)) chain.push(el)
  }
  if (!chain.includes(root)) chain.push(root)
  return {
    before: chain.map((el) => s.offsets.get(el)),
    after: chain.map((el) => ({
      x: el.scrollLeft,
      y: el.scrollTop,
      maxX: el.scrollWidth - el.clientWidth,
      maxY: el.scrollHeight - el.clientHeight,
    })),
  }
}

// Playwright cannot read the pointer and a passive listener runs after scrolling.
async function wheelPointerChain(page: Page, dx: number, dy: number, axis: Axis): Promise<PointerChain | undefined> {
  let handle: JSHandle | undefined
  try {
    handle = await page.evaluateHandle(snapshotScrollers, axis)
  } catch {
    handle = undefined
  }
  await page.mouse.wheel(dx, dy)
  await settle(page)
  if (!handle) return undefined
  try {
    const chain = (await handle.evaluate(readPointerChain)) as Partial<PointerChain> | undefined
    if (!chain || typeof chain !== 'object' || !Array.isArray(chain.before) || !Array.isArray(chain.after)) {
      return undefined
    }
    return { before: chain.before, after: chain.after }
  } catch {
    return undefined
  } finally {
    await handle.dispose().catch(() => undefined)
  }
}

type ProbeBox = { left: number; top: number; right: number; bottom: number }
type Judged = { state: TargetVisibility; rect?: ProbeBox }

// The longest a child frame may take to answer its liveness check.
export const FRAME_PROBE_TIMEOUT_MS = 1_000

// Self-contained: Playwright serializes this function into each frame.
function judgeCandidates(elements: unknown[]): unknown {
  const g = globalThis as any
  const doc = g.document
  const root = doc.documentElement
  const rootStyle = g.getComputedStyle(root)
  const bodyPropagates = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
  const parentOf = (node: any): any => node.assignedSlot ?? node.parentElement ?? node.parentNode?.host ?? null
  const clips = (node: any): boolean => {
    const style = g.getComputedStyle(node)
    return style.overflowX !== 'visible' || style.overflowY !== 'visible'
  }
  const escapes = (node: any): boolean => {
    const position = g.getComputedStyle(node).position
    return position === 'fixed' || position === 'absolute'
  }
  const contentRects = (node: any): any[] => {
    const range = doc.createRange()
    range.selectNodeContents(node)
    return Array.from(range.getClientRects())
  }
  const replaced = /^(IMG|VIDEO|CANVAS|IFRAME|EMBED|OBJECT|SVG|INPUT|TEXTAREA|SELECT)$/
  const unpainted = (s: any): boolean =>
    s.backgroundImage === 'none' && /^(transparent|rgba\(.*,\s*0\))$/.test(s.backgroundColor)
  const emptyPseudo = (p: any): boolean =>
    p.content === 'none' || p.content === 'normal' || (p.content === '""' && unpainted(p))
  const transparent = (node: any, x: number, y: number): boolean => {
    const s = g.getComputedStyle(node)
    if (s.opacity === '0') return true
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false
    if (replaced.test(node.tagName)) return false
    // A shadow tree's boxes are retargeted to its host, so a host is never seen through.
    if (node.shadowRoot || node.tagName.includes('-')) return false
    if (!unpainted(s) || s.backdropFilter !== 'none') return false
    if (!emptyPseudo(g.getComputedStyle(node, '::before'))) return false
    if (!emptyPseudo(g.getComputedStyle(node, '::after'))) return false
    return !contentRects(node).some(
      (t) => t.left <= x && x <= t.right && t.top <= y && y <= t.bottom,
    )
  }
  const judge = (el: any): unknown => {
    const style = g.getComputedStyle(el)
    if (style.visibility !== 'visible') return { state: 'hidden' }
    for (let n = el; n; n = parentOf(n)) {
      if (g.getComputedStyle(n).opacity === '0') return { state: 'hidden' }
    }
    let r = el.getBoundingClientRect()
    const byText = style.display === 'contents' || r.width === 0 || r.height === 0
    if (byText) {
      // A zero-area box that clips its own content shows none of its text.
      const clipped = clips(el) || style.clip !== 'auto' || style.clipPath !== 'none'
      if (style.display !== 'contents' && clipped) return { state: 'unknown' }
      const rects = contentRects(el).filter((t) => t.width > 0 && t.height > 0)
      if (rects.length === 0) return { state: 'unknown' }
      r = {
        left: Math.min(...rects.map((t) => t.left)),
        top: Math.min(...rects.map((t) => t.top)),
        right: Math.max(...rects.map((t) => t.right)),
        bottom: Math.max(...rects.map((t) => t.bottom)),
      }
    } else if (r.width < 2 || r.height < 2) {
      return { state: 'hidden' }
    }
    let left = Math.max(r.left, 0)
    let top = Math.max(r.top, 0)
    let right = Math.min(r.right, g.innerWidth)
    let bottom = Math.min(r.bottom, g.innerHeight)
    if (!(right > left && bottom > top)) return { state: 'hidden' }
    let positioned = escapes(el)
    for (let a = parentOf(el); a && a !== root; a = parentOf(a)) {
      if (!(a === doc.body && bodyPropagates) && !positioned && clips(a)) {
        const b = a.getBoundingClientRect()
        const cl = b.left + a.clientLeft
        const ct = b.top + a.clientTop
        left = Math.max(left, cl)
        top = Math.max(top, ct)
        right = Math.min(right, cl + a.clientWidth)
        bottom = Math.min(bottom, ct + a.clientHeight)
        if (!(right > left && bottom > top)) return { state: 'unknown' }
      }
      if (escapes(a)) positioned = true
    }
    if (right - left < 2 || bottom - top < 2) return { state: 'unknown' }
    const x = (left + right) / 2
    const y = (top + bottom) / 2
    const seen = { state: 'visible', rect: { left, top, right, bottom } }
    for (const hit of el.getRootNode().elementsFromPoint(x, y)) {
      if (hit === el || el.contains(hit)) return seen
      if (style.pointerEvents === 'none' || byText) {
        for (let a = parentOf(el); a; a = parentOf(a)) {
          if (a === hit) return seen
        }
      }
      if (!transparent(hit, x, y)) return { state: 'unknown' }
    }
    return { state: 'unknown' }
  }
  return elements.map(judge)
}

// In-page, in the parent frame: projects a box from a child frame's viewport through its frame
// element into the parent's viewport, or null when it cannot be judged: a frame element whose
// computed visibility is not `visible`, opacity 0 or a transform or zoom on the frame element or a
// flat-tree ancestor, an empty result after the content box, clipping ancestors and the viewport,
// or a hit test at its centre that lands on anything but the frame element.
// Its flat-tree walk and clip rules are a copy of judgeCandidates', without the positioned skip.
function projectThroughFrame(frameElement: unknown, box: ProbeBox): unknown {
  const g = globalThis as any
  const doc = g.document
  const root = doc.documentElement
  const el = frameElement as any
  const rootStyle = g.getComputedStyle(root)
  const bodyPropagates = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
  const parentOf = (node: any): any => node.assignedSlot ?? node.parentElement ?? node.parentNode?.host ?? null
  const clips = (node: any): boolean => {
    const style = g.getComputedStyle(node)
    return style.overflowX !== 'visible' || style.overflowY !== 'visible'
  }
  if (g.getComputedStyle(el).visibility !== 'visible') return null
  for (let n = el; n; n = parentOf(n)) {
    if (g.getComputedStyle(n).opacity === '0') return null
  }
  for (let n = el; n; n = parentOf(n)) {
    const style = g.getComputedStyle(n)
    if (style.transform !== 'none') return null
    const zoom = Number.parseFloat(style.zoom)
    if (Number.isFinite(zoom) && zoom !== 1) return null
  }
  const style = g.getComputedStyle(el)
  const padLeft = Number.parseFloat(style.paddingLeft) || 0
  const padTop = Number.parseFloat(style.paddingTop) || 0
  const padRight = Number.parseFloat(style.paddingRight) || 0
  const padBottom = Number.parseFloat(style.paddingBottom) || 0
  const r = el.getBoundingClientRect()
  const ox = r.left + el.clientLeft + padLeft
  const oy = r.top + el.clientTop + padTop
  let left = Math.max(box.left + ox, ox, 0)
  let top = Math.max(box.top + oy, oy, 0)
  let right = Math.min(box.right + ox, ox + el.clientWidth - padLeft - padRight, g.innerWidth)
  let bottom = Math.min(box.bottom + oy, oy + el.clientHeight - padTop - padBottom, g.innerHeight)
  if (!(right > left && bottom > top)) return null
  for (let a = parentOf(el); a && a !== root; a = parentOf(a)) {
    if (a === doc.body && bodyPropagates) continue
    if (!clips(a)) continue
    const b = a.getBoundingClientRect()
    const cl = b.left + a.clientLeft
    const ct = b.top + a.clientTop
    left = Math.max(left, cl)
    top = Math.max(top, ct)
    right = Math.min(right, cl + a.clientWidth)
    bottom = Math.min(bottom, ct + a.clientHeight)
    if (!(right > left && bottom > top)) return null
  }
  const hit = el.getRootNode().elementFromPoint((left + right) / 2, (top + bottom) / 2)
  if (hit !== el) return null
  return { left, top, right, bottom }
}

function candidatesIn(scope: Page | Frame, target: string): Locator {
  return scope
    .getByText(target)
    .or(scope.getByLabel(target))
    .or(scope.getByAltText(target))
    .or(scope.getByTitle(target))
}

async function judgeIn(scope: Page | Frame, target: string): Promise<Judged[]> {
  const judged = await candidatesIn(scope, target).evaluateAll(judgeCandidates)
  if (!Array.isArray(judged)) throw new Error('probe answered no list')
  return judged.map((candidate: Partial<Judged> | null) => {
    const state = candidate?.state
    if (state === 'visible' && candidate?.rect) return { state, rect: candidate.rect }
    return { state: state === 'hidden' ? 'hidden' : 'unknown' }
  })
}

function combine(states: readonly TargetVisibility[]): TargetVisibility {
  if (states.includes('visible')) return 'visible'
  if (states.includes('unknown')) return 'unknown'
  return 'hidden'
}

// A child frame's box, projected through each ancestor frame element up to the main frame.
async function projectToMainFrame(frame: Frame, box: ProbeBox): Promise<boolean> {
  let current = frame
  let projected = box
  for (let parent = current.parentFrame(); parent; parent = current.parentFrame()) {
    const handle = await current.frameElement()
    try {
      const next = (await handle.evaluate(projectThroughFrame, projected)) as ProbeBox | null
      if (!next || typeof next !== 'object') return false
      projected = next
    } finally {
      await handle.dispose().catch(() => undefined)
    }
    current = parent
  }
  return true
}

// A candidate that is not visible inside its own frame may sit where the page search cannot move
// it, so it is unknown, never hidden; so is one the projection cannot follow to the main frame.
async function probeChildFrame(frame: Frame, target: string): Promise<TargetVisibility> {
  try {
    const states: TargetVisibility[] = []
    for (const candidate of await judgeIn(frame, target)) {
      if (candidate.state === 'visible' && candidate.rect && (await projectToMainFrame(frame, candidate.rect))) {
        return 'visible'
      }
      states.push('unknown')
    }
    return combine(states)
  } catch {
    return 'unknown'
  }
}

// Child-frame liveness checks still running after their bound, per search.
type PendingFrames = WeakMap<Frame, Promise<unknown>>

// Only the liveness check is bounded; a frame that answers is judged without a bound.
async function probeChildFrameBounded(frame: Frame, target: string, pending: PendingFrames): Promise<TargetVisibility> {
  if (frame.url() === '' || pending.has(frame)) return 'unknown'
  const liveness = frame.evaluate('1')
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { resolve('timeout') }, FRAME_PROBE_TIMEOUT_MS)
  })
  let answer: 'alive' | 'timeout'
  try {
    answer = await Promise.race([liveness.then(() => 'alive' as const), bound])
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
  if (answer === 'alive') return await probeChildFrame(frame, target)
  pending.set(frame, liveness)
  const release = (): void => {
    if (pending.get(frame) === liveness) pending.delete(frame)
  }
  liveness.then(release, release)
  return 'unknown'
}

// `evaluateAll` waits for a frame's context, which a hung frame never gets.
async function probeOnScreen(page: Page, target: string, pending: PendingFrames): Promise<TargetVisibility> {
  let states: TargetVisibility[]
  try {
    states = (await judgeIn(page, target)).map((candidate) => candidate.state)
  } catch {
    return 'unknown'
  }
  if (combine(states) === 'visible') return 'visible'
  try {
    const main = page.mainFrame()
    const children = page.frames().filter((frame) => frame !== main && !frame.isDetached())
    states.push(...(await Promise.all(children.map((frame) => probeChildFrameBounded(frame, target, pending)))))
  } catch {
    states.push('unknown')
  }
  return combine(states)
}

// `readInterimTree` mints no refs, so `lastRefs` stays bound to the pre-compound observation.
export function buildScrollPrimitives(page: Page, lastRefs: RefMap, magnitude: number): ScrollPrimitives {
  const pending: PendingFrames = new WeakMap()
  return {
    async swipeOnce(direction: Direction, ref?: Ref): Promise<SwipeSignal> {
      const { dx, dy, axis } = deltaFor(direction, magnitude)
      if (ref) {
        // A ref that does not resolve moves nothing and carries no offsets: the signal is unknown.
        const scrolled = await scrollWithRef(page, lastRefs, ref, dx, dy, axis)
        if (scrolled.scrolledContainer !== 'notFound') await settle(page)
        return swipeSignalFromOffsets(direction, scrolled.offsets)
      }
      const chain = await wheelPointerChain(page, dx, dy, axis)
      return scrollerSetSwipeSignal(direction, chain?.before, chain?.after)
    },
    async nativeSearchScroll(target: string): Promise<boolean> {
      try {
        await page.getByText(target).first().scrollIntoViewIfNeeded()
        return true
      } catch {
        return false
      }
    },
    async readInterimTree() {
      const tree = await page.locator(':root').ariaSnapshot({ mode: 'ai' })
      return parseAriaSnapshot(tree).nodes
    },
    async probeTargetVisible(target: string): Promise<TargetVisibility> {
      return probeOnScreen(page, target, pending)
    },
  }
}

// The gesture itself succeeds; the outcome rides `metadata.scrollUntilVisible`.
export async function runWebScrollCompound(page: Page, lastRefs: RefMap, action: Scroll): Promise<ActionResult> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  const horizontal = action.direction === 'left' || action.direction === 'right'

  if (action.mode === 'untilVisible') {
    const magnitude = horizontal ? viewport.width : viewport.height
    const primitives = buildScrollPrimitives(page, lastRefs, magnitude)
    const { meta } = await runUntilVisibleLoop(primitives, {
      target: action.text,
      direction: action.direction,
      maxSwipes: action.maxSwipes,
      retryOpposite: action.retryOpposite,
      ...(action.ref ? { ref: action.ref } : {}),
    })
    return { success: true, metadata: { scrollUntilVisible: meta } }
  }

  const factor = action.amount === 'halfPage' ? 0.5 : 1
  const magnitude = Math.round((horizontal ? viewport.width : viewport.height) * factor)
  const primitives = buildScrollPrimitives(page, lastRefs, magnitude)

  if (action.amount === 'toEnd') {
    const { meta } = await runToEndScroll(primitives, action.direction, action.ref)
    return { success: true, metadata: { scrollUntilVisible: meta } }
  }

  const { meta } = await runDirectionScroll(primitives, {
    direction: action.direction,
    ...(action.ref ? { ref: action.ref } : {}),
  })
  return { success: true, metadata: { scrollUntilVisible: meta } }
}

export function webOpenAppError(): ActionResult {
  return {
    success: false,
    error: 'openApp is not executable on web — use navigate(url) with the target app\'s web address instead.',
  }
}
