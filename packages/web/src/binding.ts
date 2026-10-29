// A default-mode or sub-locator snapshot replaces Playwright's ref map and unbinds every ref.

import type { JSHandle, Page } from 'playwright-core'
import type { ActionResult } from '@vostride/agent-qa-runner'
import { buildScreenState, rowTextOf } from '@vostride/agent-qa-runner'
import { parseAriaSnapshot } from './observer.js'
import type { RefMap } from './types.js'

export type BindingOutcome =
  | 'stale-observation'
  | 'frame-detached'
  | 'binding-lost'
  | 'binding-changed'

export type BindingCheck = { outcome: 'ok' } | { outcome: BindingOutcome }

/** The document an observation was taken from, on the page it was taken from. */
export interface ObservationEpoch {
  page: Page
  document: JSHandle
}

export interface SnapshotRootOptions {
  /** The first attempt's bound; absent means Playwright's default and no retry. */
  timeoutMs?: number
  /** The bound of the one retry after a TimeoutError on the first attempt. */
  retryTimeoutMs?: number
}

type BindingEntry = RefMap[string]

// The action lanes that name an observed element; each is re-checked before dispatch.
const BINDING_LANES = ['ref', 'fromRef', 'toRef'] as const

const FRAME_REF = /^f\d+e/
const INVALID_FRAME = /invalid frame/i

const WHAT_CHANGED: Record<BindingOutcome, string> = {
  'stale-observation': 'the page holds a new document since the observation',
  'frame-detached': 'the frame that held the observed element is gone',
  'binding-lost': 'the observed element is no longer on the page',
  'binding-changed': 'the observed element now has a different role, name or row',
}

// Hide framework-injected [data-agent-qa-internal] overlays from the snapshot (they would
// otherwise get ai-mode refs and pollute the state), then restore them.
function hideAgentQaElements() {
  const doc = (globalThis as any).document
  doc.querySelectorAll('[data-agent-qa-internal]').forEach((el: any) => {
    el.style.display = 'none'
    el.setAttribute('aria-hidden', 'true')
  })
}

function restoreAgentQaElements() {
  const doc = (globalThis as any).document
  doc.querySelectorAll('[data-agent-qa-internal]').forEach((el: any) => {
    el.style.display = ''
    el.removeAttribute('aria-hidden')
  })
}

/** The page's `:root` ai-mode snapshot with overlays hidden, always restoring them. */
export async function snapshotRoot(page: Page, options: SnapshotRootOptions = {}): Promise<string> {
  const { timeoutMs, retryTimeoutMs } = options
  await page.evaluate(hideAgentQaElements)
  try {
    if (timeoutMs === undefined) return await page.locator(':root').ariaSnapshot({ mode: 'ai' })
    return await page.locator(':root').ariaSnapshot({ mode: 'ai', timeout: timeoutMs })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'TimeoutError')) throw error
        return page.locator(':root').ariaSnapshot({
          mode: 'ai',
          ...(retryTimeoutMs !== undefined ? { timeout: retryTimeoutMs } : {}),
        })
      })
  } finally {
    await page.evaluate(restoreAgentQaElements)
  }
}

/** The page's current main-frame document; it is destroyed when the page loads a new one. */
export async function captureEpoch(page: Page): Promise<ObservationEpoch> {
  const document = await page.evaluateHandle(() => (globalThis as any).document)
  return { page, document }
}

export async function disposeEpoch(epoch: ObservationEpoch | undefined): Promise<void> {
  try {
    await epoch?.document.dispose()
  } catch {
    // The document is already gone with its context.
  }
}

/** Whether a native ref names an element inside a child frame (`f<n>e<m>`). */
export function isChildFrameRef(nativeRef: string): boolean {
  return FRAME_REF.test(nativeRef)
}

/** Whether the page still holds the observed document. */
export async function checkDocument(
  page: Page,
  epoch: ObservationEpoch | undefined,
): Promise<BindingCheck> {
  if (epoch === undefined || epoch.page !== page) return { outcome: 'stale-observation' }
  try {
    const same = await epoch.document.evaluate((d) => d === (globalThis as any).document)
    return same === true ? { outcome: 'ok' } : { outcome: 'stale-observation' }
  } catch {
    return { outcome: 'stale-observation' }
  }
}

async function frameDetached(page: Page, nativeRef: string): Promise<boolean> {
  if (!isChildFrameRef(nativeRef)) return false
  try {
    await page.locator('aria-ref=' + nativeRef).count()
    return false
  } catch (error) {
    return error instanceof Error && INVALID_FRAME.test(error.message)
  }
}

function tidy(text: string | undefined): string | undefined {
  return text?.replace(/\s+/g, ' ').trim()
}

/**
 * Whether the element bound at observation is still the one the planner saw: the same document,
 * the native ref still present, and the same role, tidied exact name and row text (both rows
 * unknown counts as the same row).
 */
export async function checkBinding(
  page: Page,
  epoch: ObservationEpoch | undefined,
  entry: BindingEntry,
  snapshot?: SnapshotRootOptions,
): Promise<BindingCheck> {
  const document = await checkDocument(page, epoch)
  if (document.outcome !== 'ok') return document

  const { nodes, nativeRefs } = parseAriaSnapshot(await snapshotRoot(page, snapshot))
  const index = nativeRefs.indexOf(entry.nativeRef)
  if (index < 0) {
    const detached = await frameDetached(page, entry.nativeRef)
    return { outcome: detached ? 'frame-detached' : 'binding-lost' }
  }

  const { state } = buildScreenState({
    platform: 'web',
    nodes,
    viewport: { width: 0, height: 0 },
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 0, contentHeight: 0 },
    coordSpace: 'viewport',
    timestamp: 0,
  })
  const current = state.elements[index]
  if (
    current === undefined
    || current.role !== entry.role
    || tidy(current.name) !== tidy(entry.name)
    || tidy(rowTextOf(current, state.elements)) !== tidy(entry.rowText)
  ) {
    return { outcome: 'binding-changed' }
  }
  return { outcome: 'ok' }
}

/** The refs an action names in its ref, fromRef and toRef lanes, in that order. */
export function laneRefs(action: object): string[] {
  const refs: string[] = []
  for (const lane of BINDING_LANES) {
    const ref: unknown = Reflect.get(action, lane)
    if (typeof ref === 'string') refs.push(ref)
  }
  return refs
}

/** The typed result of a refused dispatch: nothing reached the page. */
export function bindingRefusal(outcome: BindingOutcome, ref: string): ActionResult {
  return {
    success: false,
    error: `${outcome}: ref ${ref} — ${WHAT_CHANGED[outcome]}; nothing was sent`,
    metadata: { binding: { outcome, ref, inputSent: false } },
  }
}
