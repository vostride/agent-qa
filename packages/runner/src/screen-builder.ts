// Pure, platform-agnostic screen-state builder for the PlatformAdapter observe leg.
// CRITICAL: provider-neutral + storage-neutral. No browser/mobile driver imports,
// no node:* imports, no model/core/adapter package imports, and no hashing here
// (the cache-key hash swap is Phase 356). Imports only from @vostride/agent-qa-schema.
//
// This is the single implementation of ref minting, name normalization,
// elements/refMap/metadata assembly, and deterministic tree rendering
// that all three platform adapters invoke. Identity byte-equality
// across platforms depends on there being exactly one producer.

import {
  asRef,
  isToggleElement,
  normalizeAccessibleName,
  type BoundingBox,
  type ElementBounds,
  type ElementInfo,
  type ElementLabels,
  type ElementState,
  type Platform,
  type Point,
  type Ref,
  type ScreenState,
  type ScreenStateMetadata,
  type ScreenStateMetadataBase,
  type ScrollContext,
} from '@vostride/agent-qa-schema'
import { ROW_CONTAINER_ROLES } from './grounding/row-text.js'

/**
 * Adapter -> builder input for a single observed node.
 *
 * Structural links are carried as INDICES because refs do not exist yet — the
 * builder mints them in document order (RESEARCH Pitfall #7).
 */
export interface InterimNode {
  /** Schema role vocabulary — adapters map native roles BEFORE the builder. */
  role: string
  /** Raw accessible name; the builder normalizes it (ElementInfo.name = name ?? ''). */
  name?: string
  value?: string
  /** Index of the nearest INCLUDED ancestor in the same nodes array. */
  parentIndex?: number
  bounds?: { x: number; y: number; width: number; height: number }
  /** Optional; the builder derives the geometric center from bounds when absent. */
  center?: { x: number; y: number }
  /**
   * ONLY real platform signals (D-08 — never fabricated). The builder derives the
   * required booleans from documented defaults when a signal is absent:
   *   enabled  = state.enabled  ?? true  (absence of a disabled signal means enabled)
   *   focused  = state.focused  ?? false
   *   visible  = state.visible  ?? true  (present in the a11y tree means exposed;
   *                                       adapters set false explicitly for offscreen)
   * Optional bits (selected/checked/editable/clickable) pass through only when the
   * platform supplied them — typed-absent otherwise.
   */
  state?: Partial<ElementState>
  labels?: ElementLabels
  /** Raw platform bag, passed through to ElementInfo.attributes (default {}). */
  attributes?: Record<string, string>
  /** Static text folded in from children that are not nodes; copied to ElementInfo.text. */
  text?: string
  /** Adapter-private hint (e.g. android class / XCUI type); the builder ignores it. */
  nativeType?: string
  /** D-10; the builder maps containerIndex -> the minted container Ref. */
  scrollContext?: { containerIndex?: number; offsetX: number; offsetY: number }
}

export interface BuildScreenStateInput {
  platform: Platform
  /** Document order — this is the ref-minting order. */
  nodes: InterimNode[]
  viewport: { width: number; height: number }
  /**
   * EXACT on web; BEST-EFFORT on mobile — mobile callers pass a best-effort
   * scroll derived from scrollable-node bounds. The field is precise only on web.
   */
  scroll: { offsetX: number; offsetY: number; contentWidth: number; contentHeight: number }
  coordSpace: 'viewport' | 'content' | 'screen'
  /** Caller-supplied — keeps the builder pure and deterministic. */
  timestamp: number
  url?: string
}

/**
 * Execute-time resolution stays adapter-private: `index` is the live node's place in the
 * input nodes array. No same-screen position is minted for anything to pick by.
 */
export interface RefBinding {
  index: number
}

export interface BuildScreenStateResult {
  /** Schema type — never redefined. */
  state: ScreenState
  /** Execute-time ref -> live-node resolution; stays adapter-private. */
  binding: Record<Ref, RefBinding>
}

/**
 * The capture stamp the loop applies after compression. `full` carries the
 * real image dimensions; `textOnly` attaches no image.
 */
export type CaptureStamp =
  | { mode: 'full'; imageWidth: number; imageHeight: number }
  | { mode: 'textOnly' }

function deriveState(signals: Partial<ElementState> | undefined): ElementState {
  const s = signals ?? {}
  const state: ElementState = {
    enabled: s.enabled ?? true,
    focused: s.focused ?? false,
    visible: s.visible ?? true,
  }
  if (s.selected !== undefined) state.selected = s.selected
  if (s.checked !== undefined) state.checked = s.checked
  if (s.editable !== undefined) state.editable = s.editable
  if (s.clickable !== undefined) state.clickable = s.clickable
  return state
}

function centerOf(bounds: BoundingBox): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

/**
 * Assemble a schema v2 ScreenState plus an adapter-private ref->node binding from a
 * platform-neutral interim node list. Pure and deterministic: identical input always
 * yields byte-identical output.
 */
export function buildScreenState(input: BuildScreenStateInput): BuildScreenStateResult {
  const { nodes } = input

  // Pass 0: mint sequential refs in document order (D-03; the single brand point).
  const refs: Ref[] = nodes.map((_, i) => asRef(`e${i + 1}`))

  // Pass 1: invert parentIndex links into child ref lists.
  const childRefs: Array<Ref[]> = nodes.map(() => [])
  for (let i = 0; i < nodes.length; i++) {
    const parentIndex = nodes[i].parentIndex
    if (parentIndex !== undefined && parentIndex >= 0 && parentIndex < nodes.length) {
      childRefs[parentIndex].push(refs[i])
    }
  }

  // Pass 2: assemble elements, refMap, and binding.
  const elements: ElementInfo[] = []
  const refMap: Record<Ref, ElementBounds> = {}
  const binding: Record<Ref, RefBinding> = {}

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const ref = refs[i]
    const name = node.name ?? ''
    const nameNormalized = normalizeAccessibleName(name)

    // the per-screen position is no longer minted.
    binding[ref] = { index: i }

    const bounds: BoundingBox | undefined = node.bounds
    const center: Point | undefined =
      node.center ?? (bounds !== undefined ? centerOf(bounds) : undefined)

    const parentRef =
      node.parentIndex !== undefined &&
      node.parentIndex >= 0 &&
      node.parentIndex < nodes.length
        ? refs[node.parentIndex]
        : undefined
    const children = childRefs[i]
    const hierarchy =
      parentRef !== undefined || children.length > 0
        ? {
            ...(parentRef !== undefined ? { parentRef } : {}),
            ...(children.length > 0 ? { childRefs: children } : {}),
          }
        : undefined

    const element: ElementInfo = {
      ref,
      role: node.role,
      name,
      nameNormalized,
      state: deriveState(node.state),
      labels: node.labels ?? {},
      attributes: node.attributes ?? {},
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(bounds !== undefined ? { bounds } : {}),
      ...(center !== undefined ? { center } : {}),
      ...(hierarchy !== undefined ? { hierarchy } : {}),
      ...(node.text !== undefined && node.text.length > 0 ? { text: node.text } : {}),
    }
    elements.push(element)

    // refMap geometry rule (RESEARCH Pitfall #3): a node WITH bounds gets an entry;
    // a node WITHOUT bounds gets NO entry — never fabricate zero geometry.
    if (bounds !== undefined && center !== undefined) {
      const entry: ElementBounds = { bounds, center }
      if (node.scrollContext !== undefined) {
        const containerIndex = node.scrollContext.containerIndex
        const scrollContext: ScrollContext = {
          offsetX: node.scrollContext.offsetX,
          offsetY: node.scrollContext.offsetY,
          ...(containerIndex !== undefined &&
          containerIndex >= 0 &&
          containerIndex < nodes.length
            ? { container: refs[containerIndex] }
            : {}),
        }
        entry.scrollContext = scrollContext
      }
      refMap[ref] = entry
    }
  }

  // The builder always stamps the honest observe-time modality: textOnly (no image
  // attached yet). The loop upgrades to `full` after compression via stampCaptureMode.
  const metadata: ScreenStateMetadata = {
    captureMode: 'textOnly',
    coordSpace: input.coordSpace,
    viewportWidth: input.viewport.width,
    viewportHeight: input.viewport.height,
    scroll: {
      offsetX: input.scroll.offsetX,
      offsetY: input.scroll.offsetY,
      contentWidth: input.scroll.contentWidth,
      contentHeight: input.scroll.contentHeight,
    },
  }

  const state: ScreenState = {
    platform: input.platform,
    tree: renderScreenTree(elements, metadata),
    elements,
    refMap,
    timestamp: input.timestamp,
    metadata,
    ...(input.url !== undefined ? { url: input.url } : {}),
  }

  return { state, binding }
}

const LINE_BREAKS = /\s*[\r\n\u2028\u2029]+\s*/g
const ROW_TEXT_CAP = 120

function renderedRowText(element: ElementInfo): string | undefined {
  if (!ROW_CONTAINER_ROLES.includes(element.role)) return undefined
  const oneLine = element.text?.replace(LINE_BREAKS, ' ')
  if (!oneLine) return undefined
  const chars = Array.from(oneLine)
  return chars.length > ROW_TEXT_CAP ? `${chars.slice(0, ROW_TEXT_CAP).join('')}…` : oneLine
}

function depthOf(element: ElementInfo, byRef: Map<Ref, ElementInfo>): number {
  let depth = 0
  const seen = new Set<Ref>()
  let parentRef = element.hierarchy?.parentRef
  while (parentRef !== undefined && !seen.has(parentRef)) {
    seen.add(parentRef)
    depth++
    parentRef = byRef.get(parentRef)?.hierarchy?.parentRef
  }
  return depth
}

/**
 * Deterministic LLM-facing tree text, derived from the structured elements —
 * one grammar for all platforms. Exported so Phase 357's slim/rich dual-projection is
 * a renderer-only change with zero adapter edits.
 *
 * Grammar (pinned; RESEARCH Pitfall #10):
 *   [Viewport: {viewportWidth}x{viewportHeight}] [{elements.length} elements]
 *   {2 spaces × depth}- {role}{ "name"?} [ref={ref}]{ @(x,y wxh)?}{ [disabled]?}{ [offscreen]?}{ [checked]?}{ [selected]?}{ [editable]?}{ text: <row text as a JSON string>?}
 * depth = length of the parentRef chain (root elements depth 0).
 * A rendered name collapses each line break, with the whitespace around it, to one space, so
 * every element stays on one line; element.name and value keep the raw text.
 * ` text: "…"` appears only on a row container (ROW_CONTAINER_ROLES) whose element.text is
 * non-empty (438 D-02: the planner must see a row to state it); line breaks collapse the same
 * way and the rendered text is capped at 120 characters plus `…`. The row text is a JSON string
 * (JSON.stringify, as quoted() renders names in the refusal line), so a quote or backslash in app
 * text cannot end the string or forge a ref, flag or line (438 gap round, WR-02, T-438-04).
 * element.text keeps the full text the judge and replay compare against.
 */
export function renderScreenTree(
  elements: ElementInfo[],
  metadata: ScreenStateMetadata,
): string {
  const byRef = new Map<Ref, ElementInfo>()
  for (const element of elements) {
    byRef.set(element.ref, element)
  }

  const header = `[Viewport: ${metadata.viewportWidth}x${metadata.viewportHeight}] [${elements.length} elements]`

  const lines = elements.map(element => {
    const indent = '  '.repeat(depthOf(element, byRef))
    let line = `${indent}- ${element.role}`
    if (element.name) line += ` "${element.name.replace(LINE_BREAKS, ' ')}"`
    line += ` [ref=${element.ref}]`
    if (element.bounds) {
      const b = element.bounds
      line += ` @(${b.x},${b.y} ${b.width}x${b.height})`
    }
    if (!element.state.enabled) line += ' [disabled]'
    if (element.state.visible === false) line += ' [offscreen]'
    if (element.state.checked === true && isToggleElement(element)) line += ' [checked]'
    if (element.state.selected === true) line += ' [selected]'
    if (element.state.editable === true) line += ' [editable]'
    const rowText = renderedRowText(element)
    if (rowText !== undefined) line += ` text: ${JSON.stringify(rowText)}`
    return line
  })

  return [header, ...lines].join('\n')
}

/**
 * Pure re-stamp of the discriminated captureMode metadata member. Constructs a
 * fresh metadata object from the base fields and returns a NEW ScreenState — zero `as`
 * casts, zero mutation of the input.
 */
export function stampCaptureMode(state: ScreenState, capture: CaptureStamp): ScreenState {
  const base: ScreenStateMetadataBase = {
    coordSpace: state.metadata.coordSpace,
    viewportWidth: state.metadata.viewportWidth,
    viewportHeight: state.metadata.viewportHeight,
    scroll: {
      offsetX: state.metadata.scroll.offsetX,
      offsetY: state.metadata.scroll.offsetY,
      contentWidth: state.metadata.scroll.contentWidth,
      contentHeight: state.metadata.scroll.contentHeight,
    },
  }

  const metadata: ScreenStateMetadata =
    capture.mode === 'full'
      ? { ...base, captureMode: 'full', imageWidth: capture.imageWidth, imageHeight: capture.imageHeight }
      : { ...base, captureMode: 'textOnly' }

  return { ...state, metadata }
}
