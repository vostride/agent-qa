// The one producer of refs, names and tree rendering, so identity matches across platforms.

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

// Structural links are indices, because the builder mints refs afterwards in document order.
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
  // Only real platform signals; absent booleans take documented defaults, never fabricated values.
  state?: Partial<ElementState>
  labels?: ElementLabels
  /** Raw platform bag, passed through to ElementInfo.attributes (default {}). */
  attributes?: Record<string, string>
  /** Static text folded in from children that are not nodes; copied to ElementInfo.text. */
  text?: string
  /** Adapter-private hint (e.g. android class / XCUI type); the builder ignores it. */
  nativeType?: string
  // The builder maps `containerIndex` to the minted container Ref.
  scrollContext?: { containerIndex?: number; offsetX: number; offsetY: number }
}

export interface BuildScreenStateInput {
  platform: Platform
  /** Document order — this is the ref-minting order. */
  nodes: InterimNode[]
  viewport: { width: number; height: number }
  // Exact on web, best-effort on mobile from scrollable-node bounds.
  scroll: { offsetX: number; offsetY: number; contentWidth: number; contentHeight: number }
  coordSpace: 'viewport' | 'content' | 'screen'
  /** Caller-supplied — keeps the builder pure and deterministic. */
  timestamp: number
  url?: string
}

// `index` is the live node's place in the input array, private to execute-time resolution.
export interface RefBinding {
  index: number
}

export interface BuildScreenStateResult {
  /** Schema type — never redefined. */
  state: ScreenState
  /** Execute-time ref -> live-node resolution; stays adapter-private. */
  binding: Record<Ref, RefBinding>
}

// `full` carries the real image dimensions; `textOnly` attaches no image.
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

  // Pass 0: mint sequential refs in document order; the single brand point.
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

    // A node with bounds gets a refMap entry; one without gets none, never zero geometry.
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

// Row text is a JSON string, so app text with a quote or backslash cannot forge a ref or line.
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

// Builds fresh metadata and a new ScreenState; the input is never mutated.
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
