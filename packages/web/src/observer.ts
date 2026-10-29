import type { Page } from 'playwright-core'
import type { ElementState, ElementLabels } from '@vostride/agent-qa-schema'
import type { InterimNode } from '@vostride/agent-qa-runner'

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
  // WAI-ARIA 1.2 standalone widget roles
  'gridcell', 'scrollbar', 'separator',
  // WAI-ARIA 1.2 composite widget roles (interactive containers)
  'grid', 'menu', 'menubar', 'tree', 'treegrid',
])

// 'dialog' and 'alertdialog' are kept so an open dialog is on the screen the judge reads.
const CONTENT_ROLES = new Set([
  'heading', 'cell', 'listitem', 'article', 'region', 'navigation',
  'progressbar', 'tabpanel', 'row', 'dialog', 'alertdialog',
])

const LIMIT_KEYS = ['valuenow', 'valuemin', 'valuemax'] as const

const LINE_PATTERN = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/
// Playwright wraps ARIA entries in single quotes when element names contain
// colons or other characters that are ambiguous in its snapshot format.
// e.g. - 'button "Spoken Language: Any"'
const QUOTED_LINE_PATTERN = /^(\s*-\s*)'(\w+)(?:\s+"([^"]*)")?(.*)'\s*$/
// Playwright's ai-mode snapshot annotates each element with a native reference,
// e.g. `- button "Login" [ref=e5]`. These refs are adapter-PRIVATE handles for
// aria-ref locators; they are NEVER copied into the node identity.
const REF_ANNOTATION = /\[ref=([A-Za-z0-9_-]+)\]/
const BRACKET_ATTR = /\[(\w+)(?:=([^\]]*))?\]/g
// The inline text after a line's bracket annotations: `- paragraph [ref=e7]: 7 Elm Street`.
const INLINE_TEXT = /^(?:\s*\[[^\]]*\])*\s*:\s*(.*)$/

function inlineText(suffix: string | undefined): string | undefined {
  const raw = suffix?.match(INLINE_TEXT)?.[1]?.trim()
  if (!raw) return undefined
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
    } catch {
      return raw.slice(1, -1)
    }
  }
  return raw
}

function appendText(node: InterimNode, text: string | undefined): void {
  const tidy = text?.replace(/\s+/g, ' ').trim()
  if (!tidy) return
  node.text = node.text === undefined ? tidy : `${node.text} ${tidy}`
}

/**
 * Parse a Playwright ARIA snapshot into platform-neutral runner interim nodes.
 *
 * Emits nodes in document order with role/name/attributes and a `parentIndex`
 * derived from indentation depth: the nearest kept entry among the line's true
 * ancestors; a dropped line still bounds its subtree (438 gap round, CR-02). A line
 * whose role is not kept never becomes a node: its quoted name and inline text fold
 * into the nearest kept entry among the line's true ancestors (438 D-02, the row
 * text), and a kept content line's own inline text becomes its `text`. Playwright
 * ai-mode `[ref=eN]` annotations are captured into an index-aligned `nativeRefs`
 * array (adapter-private native handles) and are never written into the node. Accepts both ai-mode (annotated) and default-mode
 * (unannotated) snapshot text.
 *
 * No ref minting and no tree rendering happen here — the shared runner builder
 * owns both.
 */
export function parseAriaSnapshot(ariaTree: string): {
  nodes: InterimNode[]
  nativeRefs: (string | undefined)[]
} {
  const lines = ariaTree.split('\n')
  const nodes: InterimNode[] = []
  const nativeRefs: (string | undefined)[] = []
  // Every matched line's depth; `index` (into the FILTERED nodes array) only on kept lines.
  const ancestors: Array<{ depth: number; index?: number }> = []

  for (const line of lines) {
    const match = line.match(LINE_PATTERN) || line.match(QUOTED_LINE_PATTERN)
    if (!match) continue

    const [, , role, name, suffix] = match
    const roleLower = role.toLowerCase()

    // Indentation depth: Playwright indents snapshot children by 2 spaces per level.
    const leadingSpaces = line.length - line.trimStart().length
    const depth = Math.floor(leadingSpaces / 2)

    while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= depth) {
      ancestors.pop()
    }
    let keptAncestor: number | undefined
    for (let k = ancestors.length - 1; k >= 0; k--) {
      if (ancestors[k].index !== undefined) {
        keptAncestor = ancestors[k].index
        break
      }
    }

    if (!INTERACTIVE_ROLES.has(roleLower) && !CONTENT_ROLES.has(roleLower)) {
      if (keptAncestor !== undefined) {
        appendText(nodes[keptAncestor], name)
        appendText(nodes[keptAncestor], inlineText(suffix))
      }
      ancestors.push({ depth })
      continue
    }

    const parentIndex = keptAncestor

    // Capture the adapter-private native ref (ai-mode) — never copied into the node.
    const refMatch = suffix?.match(REF_ANNOTATION)
    const nativeRef = refMatch ? refMatch[1] : undefined

    // Remaining bracket annotations become the raw attribute bag (ref excluded).
    const attributes: Record<string, string> = {}
    if (suffix) {
      for (const am of suffix.matchAll(BRACKET_ATTR)) {
        if (am[1] === 'ref') continue
        attributes[am[1]] = am[2] ?? 'true'
      }
    }

    const node: InterimNode = { role: roleLower }
    if (name) node.name = name
    if (parentIndex !== undefined) node.parentIndex = parentIndex
    if (Object.keys(attributes).length > 0) node.attributes = attributes
    // Only signals actually present in the snapshot text populate state; the
    // builder derives all defaults. A [disabled] annotation is the only state
    // signal the default snapshot text carries.
    if ('disabled' in attributes) node.state = { enabled: false }
    // A control's inline text is its value (a password field's included), never static text.
    if (CONTENT_ROLES.has(roleLower)) appendText(node, inlineText(suffix))

    const index = nodes.length
    nodes.push(node)
    nativeRefs.push(nativeRef)
    ancestors.push({ depth, index })
  }

  return { nodes, nativeRefs }
}

/**
 * Capture exact web scroll state (Pitfall #2 / D-10). Web scroll is precise:
 * real `window.scrollX/Y` offsets and `document.documentElement.scrollWidth/Height`
 * content size — never hardcoded zeros. Best-effort: on failure it degrades to the
 * Playwright viewport size and zero scroll rather than throwing.
 */
export async function captureWebScroll(page: Page): Promise<{
  viewport: { width: number; height: number }
  scroll: { offsetX: number; offsetY: number; contentWidth: number; contentHeight: number }
}> {
  const fallbackViewport = page.viewportSize() ?? { width: 0, height: 0 }
  try {
    const raw = await page.evaluate(() => {
      const w = globalThis as any
      const docEl = w.document.documentElement
      return {
        width: w.innerWidth,
        height: w.innerHeight,
        offsetX: w.scrollX,
        offsetY: w.scrollY,
        contentWidth: docEl.scrollWidth,
        contentHeight: docEl.scrollHeight,
      }
    })
    if (raw && typeof raw === 'object') {
      return {
        viewport: {
          width: numberOr(raw.width, fallbackViewport.width),
          height: numberOr(raw.height, fallbackViewport.height),
        },
        scroll: {
          offsetX: numberOr(raw.offsetX, 0),
          offsetY: numberOr(raw.offsetY, 0),
          contentWidth: numberOr(raw.contentWidth, 0),
          contentHeight: numberOr(raw.contentHeight, 0),
        },
      }
    }
  } catch {
    // Scroll capture is best-effort — never block observation.
  }
  return {
    viewport: fallbackViewport,
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 0, contentHeight: 0 },
  }
}

/**
 * Resolve exact per-element geometry, state, and labels through Playwright
 * `aria-ref=` locators (the engine's own ground truth) instead of the removed
 * in-page inferred-role heuristic. The ai-mode native refs stay adapter-private
 * handles; builder-minted refs remain the only public identity.
 *
 * Enrichment mutates the interim nodes in place and is best-effort: a node whose
 * ref fails to resolve (or has no ref) keeps `bounds` absent — the builder's
 * geometry rule turns that into no refMap entry, never zero-geometry fabrication
 * (D-08, Pitfall #3). Enrichment failure degrades to unenriched nodes; it never
 * throws out of observation.
 */
export async function enrichWebNodes(
  page: Page,
  nodes: InterimNode[],
  nativeRefs: (string | undefined)[],
): Promise<void> {
  try {
    // Resolve element handles for nodes that carry a native ref.
    const handles: unknown[] = []
    const targetIndices: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const ref = nativeRefs[i]
      if (!ref) continue
      try {
        const handle = await page.locator('aria-ref=' + ref).elementHandle()
        if (handle) {
          handles.push(handle)
          targetIndices.push(i)
        }
      } catch {
        // Unresolved ref → node keeps bounds absent (honest absence).
      }
    }
    if (handles.length === 0) return

    // One batched page.evaluate reads bounds/state/labels for every resolved handle.
    const raw = await page.evaluate((els: any[]) => {
      const w = globalThis as any
      const active = w.document.activeElement
      return els.map((el: any) => {
        if (!el) return null
        const rect = typeof el.getBoundingClientRect === 'function'
          ? el.getBoundingClientRect()
          : null
        const style = typeof w.getComputedStyle === 'function' ? w.getComputedStyle(el) : null
        const hidden = style
          ? style.visibility === 'hidden' || style.display === 'none'
          : false
        const hasBox = !!rect && rect.width > 0 && rect.height > 0
        const disabled =
          el.disabled === true ||
          (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled')) ||
          (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true')
        const attr = (n: string) =>
          typeof el.getAttribute === 'function' ? el.getAttribute(n) : null
        const inputType = el.tagName === 'INPUT' && typeof el.type === 'string' ? el.type : ''
        const isRange = inputType === 'range'
        const isNumber = inputType === 'number'
        return {
          bounds: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
          enabled: !disabled,
          focused: el === active,
          visible: hasBox && !hidden,
          testId: attr('data-testid'),
          ariaLabel: attr('aria-label'),
          placeholder: attr('placeholder'),
          title: attr('title'),
          valuenow: attr('aria-valuenow') ?? (isRange || isNumber ? String(el.value) : null),
          valuemin: attr('aria-valuemin') ?? (isRange ? el.min || '0' : isNumber ? el.min || null : null),
          valuemax: attr('aria-valuemax') ?? (isRange ? el.max || '100' : isNumber ? el.max || null : null),
        }
      })
    }, handles)

    if (!Array.isArray(raw)) return

    // Coerce untrusted evaluate results to expected primitives before writing them
    // into the interim nodes: numbers for geometry, strings for labels;
    // malformed entries degrade to absent fields.
    for (let k = 0; k < targetIndices.length; k++) {
      const info = raw[k]
      if (!info || typeof info !== 'object') continue
      const node = nodes[targetIndices[k]]

      const bounds = coerceBounds((info as any).bounds)
      if (bounds) node.bounds = bounds

      const state: Partial<ElementState> = { ...(node.state ?? {}) }
      if (typeof (info as any).enabled === 'boolean') state.enabled = (info as any).enabled
      if (typeof (info as any).focused === 'boolean') state.focused = (info as any).focused
      if (typeof (info as any).visible === 'boolean') state.visible = (info as any).visible
      if (Object.keys(state).length > 0) node.state = state

      const labels: ElementLabels = { ...(node.labels ?? {}) }
      const testId = coerceString((info as any).testId)
      if (testId) labels.testId = testId
      const ariaLabel = coerceString((info as any).ariaLabel)
      if (ariaLabel) labels.ariaLabel = ariaLabel
      const placeholder = coerceString((info as any).placeholder)
      if (placeholder) labels.placeholder = placeholder
      const title = coerceString((info as any).title)
      if (title) labels.title = title
      if (Object.keys(labels).length > 0) node.labels = labels

      // a control's reported value and limits; attributes are neither hashed nor rendered.
      const limits: Record<string, string> = {}
      for (const key of LIMIT_KEYS) {
        const value = coerceString((info as any)[key])
        if (value) limits[key] = value
      }
      if (Object.keys(limits).length > 0) node.attributes = { ...(node.attributes ?? {}), ...limits }
    }
  } catch {
    // Enrichment is best-effort — degrade to unenriched nodes, never throw.
  }
}

function coerceBounds(
  value: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const x = v.x, y = v.y, width = v.width, height = v.height
  if (
    typeof x === 'number' && Number.isFinite(x) &&
    typeof y === 'number' && Number.isFinite(y) &&
    typeof width === 'number' && Number.isFinite(width) &&
    typeof height === 'number' && Number.isFinite(height)
  ) {
    return { x, y, width, height }
  }
  return undefined
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Coerce an untrusted value to a finite number, falling back when malformed. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
