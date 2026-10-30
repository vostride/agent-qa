// Builds a valid `ScreenState` from loosely-shaped element overrides via `makeScreenState`.
import { asRef, normalizeAccessibleName } from '@vostride/agent-qa-schema'
import type { ScreenState, ElementInfo, ElementBounds } from '@vostride/agent-qa-schema'
import { makeScreenState as makeBaseScreenState } from '../../testing/screen-fixtures.js'

interface LooseBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface LooseElement {
  ref?: string
  role: string
  name: string
  nameNormalized?: string
  value?: string
  bounds?: LooseBounds
  center?: { x: number; y: number }
  state?: Partial<ElementInfo['state']>
  labels?: ElementInfo['labels']
  hierarchy?: ElementInfo['hierarchy']
  attributes?: Record<string, string>
}

export interface LooseMetadata {
  coordSpace?: 'viewport' | 'content' | 'screen'
  viewportWidth?: number
  viewportHeight?: number
  scroll?: ScreenState['metadata']['scroll']
}

export interface LooseScreenState {
  platform?: ScreenState['platform']
  tree?: string
  url?: string
  timestamp?: number
  elements?: LooseElement[]
  refMap?: Record<string, { bounds?: LooseBounds; center?: { x: number; y: number } }>
  metadata?: LooseMetadata
}

function centerOf(bounds: LooseBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function toElementInfo(e: LooseElement, index: number): ElementInfo {
  const el: ElementInfo = {
    ref: asRef(e.ref ?? `e${index + 1}`),
    role: e.role,
    name: e.name,
    nameNormalized: e.nameNormalized ?? normalizeAccessibleName(e.name),
    state: { enabled: true, focused: false, visible: true, ...e.state },
    labels: e.labels ?? {},
    attributes: e.attributes ?? {},
  }
  if (e.value !== undefined) el.value = e.value
  if (e.bounds) el.bounds = e.bounds
  if (e.center) el.center = e.center
  if (e.hierarchy) el.hierarchy = e.hierarchy
  return el
}

function toRefMap(
  loose: Record<string, { bounds?: LooseBounds; center?: { x: number; y: number } }>,
): Record<string, ElementBounds> {
  const out: Record<string, ElementBounds> = {}
  for (const key of Object.keys(loose)) {
    const entry = loose[key]
    if (!entry.bounds) continue
    out[asRef(key)] = { bounds: entry.bounds, center: entry.center ?? centerOf(entry.bounds) }
  }
  return out
}

function toMetadata(base: ScreenState['metadata'], m: LooseMetadata | undefined): ScreenState['metadata'] {
  return {
    captureMode: 'textOnly',
    coordSpace: m?.coordSpace ?? base.coordSpace,
    viewportWidth: m?.viewportWidth ?? base.viewportWidth,
    viewportHeight: m?.viewportHeight ?? base.viewportHeight,
    scroll: m?.scroll ?? base.scroll,
  }
}

/**
 * Build a valid v2 `ScreenState` from loosely-shaped legacy overrides. Test files
 * supply their per-file defaults (tree/url/elements) plus test-specific overrides;
 * this fills every required v2 field via the shared runner factory.
 */
export function buildAgentScreenState(overrides: LooseScreenState = {}): ScreenState {
  const base = makeBaseScreenState()
  const patch: Partial<ScreenState> = {}
  if (overrides.platform !== undefined) patch.platform = overrides.platform
  if (overrides.tree !== undefined) patch.tree = overrides.tree
  if (overrides.timestamp !== undefined) patch.timestamp = overrides.timestamp
  if (overrides.elements !== undefined) patch.elements = overrides.elements.map(toElementInfo)
  if (overrides.refMap !== undefined) patch.refMap = toRefMap(overrides.refMap)
  patch.metadata = toMetadata(base.metadata, overrides.metadata)
  const result: ScreenState = { ...base, ...patch }
  // Callers own url presence via their per-file default; never leak the factory's
  // default url into fixtures that omitted one.
  if (overrides.url !== undefined) {
    result.url = overrides.url
  } else {
    delete result.url
  }
  return result
}
