// A ref that does not resolve or is in a child frame scrolls nothing; the swipe reads `unknown`.

import type { Page } from 'playwright-core'
import type { Ref } from '@vostride/agent-qa-schema'
import { ElementResolver } from './element-resolver.js'
import type { RefMap } from './types.js'

export interface ScrollResult {
  bounds: { x: number; y: number; width: number; height: number } | null
  scrolledContainer: 'element' | 'ancestor' | 'documentElement' | 'notFound'
  scrolled: boolean
  /** The scrolled container's offset on the swiped axis before and after, and its largest offset. */
  offsets?: { before: number; after: number; max: number }
}

const NOT_FOUND: ScrollResult = { bounds: null, scrolledContainer: 'notFound', scrolled: false }

// Bounds the evaluate's own wait if the element detaches between count() and evaluate().
const EVALUATE_TIMEOUT_MS = 1_000

export async function scrollWithRef(
  page: Page,
  lastRefs: RefMap,
  ref: Ref,
  deltaX: number,
  deltaY: number,
  scrollAxis: 'horizontal' | 'vertical',
): Promise<ScrollResult> {
  if (lastRefs[ref]?.inChildFrame === true) return NOT_FOUND
  try {
    const locator = new ElementResolver(page, lastRefs).resolve(ref)
    if ((await locator.count()) === 0) return NOT_FOUND
    const scrolled = await locator.evaluate(
      (target: unknown, args: [number, number, string]) => {
        const [dx, dy, axis] = args
        const win = globalThis as any
        const doc = win.document
        const el = target as any

        const prop = axis === 'horizontal' ? 'scrollLeft' : 'scrollTop'
        const maxOf = (node: any): number => axis === 'horizontal'
          ? node.scrollWidth - node.clientWidth
          : node.scrollHeight - node.clientHeight
        const boundsOf = () => {
          const rect = el.getBoundingClientRect()
          return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
        }
        const scrollable = (node: any): boolean => {
          const style = win.getComputedStyle(node)
          const overflow = axis === 'horizontal' ? style.overflowX : style.overflowY
          return (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') && maxOf(node) > 0
        }

        // A body whose overflow propagates to the viewport is not a scroll container; the
        // document scroller stands for the page in standards and quirks mode alike.
        const scroller = doc.scrollingElement
        const rootStyle = win.getComputedStyle(doc.documentElement)
        const bodyPropagates = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible'
        const isDocumentScroller = (node: any): boolean =>
          node === doc.documentElement || node === scroller || (bodyPropagates && node === doc.body)
        const parentOf = (node: any): any => {
          if (node.assignedSlot) return node.assignedSlot
          if (node.parentElement) return node.parentElement
          const parent = node.parentNode
          return parent && parent.host ? parent.host : null
        }

        // The element itself, then its nearest scrollable ancestor over the flat tree.
        if (!isDocumentScroller(el)) {
          if (scrollable(el)) {
            const before = el[prop]
            el.scrollBy(dx, dy)
            const after = el[prop]
            return { bounds: boundsOf(), scrolledContainer: 'element', scrolled: before !== after, offsets: { before, after, max: maxOf(el) } }
          }
          for (let parent = parentOf(el); parent && !isDocumentScroller(parent); parent = parentOf(parent)) {
            if (!scrollable(parent)) continue
            const before = parent[prop]
            parent.scrollBy(dx, dy)
            const after = parent[prop]
            return { bounds: boundsOf(), scrolledContainer: 'ancestor', scrolled: before !== after, offsets: { before, after, max: maxOf(parent) } }
          }
        }

        // The document scroller, whose offsets prove something only when it has range on this axis.
        if (!scroller) {
          const x = win.scrollX
          const y = win.scrollY
          win.scrollBy(dx, dy)
          return { bounds: boundsOf(), scrolledContainer: 'documentElement', scrolled: x !== win.scrollX || y !== win.scrollY }
        }
        const before = scroller[prop]
        scroller.scrollBy(dx, dy)
        const after = scroller[prop]
        const max = maxOf(scroller)
        return {
          bounds: boundsOf(),
          scrolledContainer: 'documentElement',
          scrolled: before !== after,
          ...(max > 0 ? { offsets: { before, after, max } } : {}),
        }
      },
      [deltaX, deltaY, scrollAxis] as [number, number, string],
      { timeout: EVALUATE_TIMEOUT_MS },
    )
    return scrolled && typeof scrolled === 'object' ? (scrolled as ScrollResult) : NOT_FOUND
  } catch {
    return NOT_FOUND
  }
}
