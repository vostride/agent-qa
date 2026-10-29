/**
 * The deterministic memory.md §5.5.8 query door. Every identity anchor is normalized
 * through the schema authority before keys or matching helpers are derived. Raw selector atoms
 * remain lexical-only; dense text and fallback regions are assembled from structured fields.
 */
import {
  canonicalJson,
  normalizeAnchor,
  type Anchor,
  type ElementInfo,
  type ScreenState,
} from '@vostride/agent-qa-schema'

import { QUERY_CLASS_WEIGHTS } from './retrieval/constants.js'
import { classifyQuery, type QueryClass } from './retrieval/query-class.js'

export interface RetrievalQueryInput {
  screenState?: ScreenState
  intent: string
  anchors: readonly Anchor[]
}

export interface FallbackRendering {
  anchorIndex: number
  lookupKey: string
  text: string
  reconfirmToken: string
  fallback: true
  anchorExact: false
}

export interface RetrievalQuery {
  lexicalQuery: string
  semanticText: string
  normalizedAnchors: Anchor[]
  anchorLookupKeys: string[]
  queryClass: QueryClass
  weights: (typeof QUERY_CLASS_WEIGHTS)[QueryClass]
  fallbackRenderings: FallbackRendering[]
}

type ScreenRegionElement = {
  relation: 'anchor' | 'parent' | 'child' | 'previous' | 'next' | 'screen'
  role: string
  name: string
  labels: string[]
}

const RELATION_ORDER: Record<ScreenRegionElement['relation'], number> = {
  anchor: 0,
  parent: 1,
  child: 2,
  previous: 3,
  next: 4,
  screen: 5,
}

function normalizedElementAnchor(element: ElementInfo): Extract<Anchor, { t: 'el' }> {
  return normalizeAnchor({ t: 'el', role: element.role, name: element.name }) as Extract<
    Anchor,
    { t: 'el' }
  >
}

/**
 * The role+name key used by the vec:none scan rung's widened D-16 comparison. Indexed callers
 * continue to use anchorLookupKey(), which retains the complete normalized identity.
 */
export function widenedRoleNameKey(anchor: Anchor): string | undefined {
  const normalized = normalizeAnchor(anchor)
  if (normalized.t !== 'el') return undefined
  return canonicalJson({ name: normalized.name, role: normalized.role })
}

export function anchorLookupKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

function rawLexicalTerms(anchor: Anchor): string[] {
  switch (anchor.t) {
    case 'page':
      return [anchor.route]
    case 'flow':
      return [anchor.name]
    case 'el':
      return [anchor.role, anchor.name]
    case 'platform':
      return [anchor.platform]
    case 'selector':
      return [anchor.literal]
    case 'error':
      return [anchor.message]
  }
}

function normalizedLexicalTerms(anchor: Anchor): string[] {
  switch (anchor.t) {
    case 'page':
      return [anchor.route]
    case 'flow':
      return [anchor.name]
    case 'el':
      return [anchor.role, anchor.name]
    case 'platform':
      return [anchor.platform]
    case 'selector':
      return [anchor.literal]
    case 'error':
      return [anchor.message]
  }
}

function semanticAnchor(anchor: Anchor): Record<string, string | number> | undefined {
  switch (anchor.t) {
    case 'page':
      return { kind: 'page', route: anchor.route }
    case 'flow':
      return { kind: 'flow', name: anchor.name }
    case 'el':
      return {
        kind: 'element',
        role: anchor.role,
        name: anchor.name,
        ...(anchor.ordinal === undefined ? {} : { ordinal: anchor.ordinal }),
      }
    case 'platform':
      return { kind: 'platform', platform: anchor.platform }
    case 'selector':
      return undefined
    case 'error':
      return { kind: 'error', message: anchor.message }
  }
}

function reconfirmToken(anchor: Anchor): string | undefined {
  switch (anchor.t) {
    case 'page':
      return anchor.route
    case 'flow':
      return anchor.name
    case 'el':
      return anchor.name
    case 'platform':
    case 'selector':
      return undefined
    case 'error':
      return anchor.message
  }
}

function normalizedLabels(element: ElementInfo): string[] {
  const values = [
    element.labels.ariaLabel,
    element.labels.placeholder,
    element.labels.title,
  ]
  return [...new Set(values.flatMap((value) => {
    if (value === undefined) return []
    const normalized = normalizeAnchor({ t: 'flow', name: value })
    return normalized.t !== 'flow' || normalized.name === '' ? [] : [normalized.name]
  }))].sort()
}

function regionElement(
  element: ElementInfo,
  relation: ScreenRegionElement['relation'],
): ScreenRegionElement {
  const normalized = normalizedElementAnchor(element)
  return {
    relation,
    role: normalized.role,
    name: normalized.name,
    labels: normalizedLabels(element),
  }
}

function matchingElementIndex(screenState: ScreenState, anchor: Anchor): number {
  const key = widenedRoleNameKey(anchor)
  if (key === undefined) return -1
  const matchingIndexes = screenState.elements.flatMap((element, index) =>
    widenedRoleNameKey(normalizedElementAnchor(element)) === key ? [index] : [],
  )
  if (matchingIndexes.length === 0) return -1

  const normalized = normalizeAnchor(anchor)
  if (normalized.t !== 'el' || normalized.ordinal === undefined) return matchingIndexes[0]!
  const ordinalIndex = Math.max(0, normalized.ordinal - 1)
  return matchingIndexes[ordinalIndex] ?? matchingIndexes[0]!
}

function renderScreenRegion(screenState: ScreenState, anchor: Anchor): string {
  const anchorIndex = matchingElementIndex(screenState, anchor)
  const elementsByRef = new Map(
    screenState.elements.map((element, index) => [element.ref, { element, index }] as const),
  )
  const region = new Map<string, ScreenRegionElement & { screenIndex: number }>()

  function add(element: ElementInfo | undefined, relation: ScreenRegionElement['relation']): void {
    if (element === undefined || region.has(element.ref)) return
    const screenIndex = elementsByRef.get(element.ref)?.index ?? Number.MAX_SAFE_INTEGER
    region.set(element.ref, { ...regionElement(element, relation), screenIndex })
  }

  const matched = anchorIndex === -1 ? undefined : screenState.elements[anchorIndex]
  if (matched === undefined) {
    for (const element of screenState.elements.slice(0, 5)) add(element, 'screen')
  } else {
    add(matched, 'anchor')
    const parent = matched.hierarchy?.parentRef
    add(parent === undefined ? undefined : elementsByRef.get(parent)?.element, 'parent')
    for (const child of matched.hierarchy?.childRefs ?? []) {
      add(elementsByRef.get(child)?.element, 'child')
    }
    add(screenState.elements[anchorIndex - 1], 'previous')
    add(screenState.elements[anchorIndex + 1], 'next')

    if (parent !== undefined) {
      const parentElement = elementsByRef.get(parent)?.element
      for (const sibling of parentElement?.hierarchy?.childRefs ?? []) {
        add(elementsByRef.get(sibling)?.element, 'child')
      }
    }
  }

  const orderedRegion = [...region.values()]
    .sort(
      (left, right) =>
        RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation]
        || left.screenIndex - right.screenIndex
        || left.role.localeCompare(right.role)
        || left.name.localeCompare(right.name),
    )
    .map(({ screenIndex: _screenIndex, ...element }) => element)

  return canonicalJson({
    anchor: semanticAnchor(anchor) ?? { kind: anchor.t },
    kind: 'live-screen-region',
    platform: screenState.platform,
    region: orderedRegion,
  })
}

function buildFallbackRenderings(
  screenState: ScreenState | undefined,
  normalizedAnchors: readonly Anchor[],
  lookupKeys: readonly string[],
): FallbackRendering[] {
  if (screenState === undefined) return []

  return normalizedAnchors.flatMap((anchor, anchorIndex) => {
    const token = reconfirmToken(anchor)
    if (token === undefined || token === '') return []
    return [{
      anchorIndex,
      lookupKey: lookupKeys[anchorIndex]!,
      text: renderScreenRegion(screenState, anchor),
      reconfirmToken: token,
      fallback: true as const,
      anchorExact: false as const,
    }]
  })
}

/**
 * Build both recall inputs from structured runner state. Fallback renderings are candidates only:
 * callers use them after exact/normalized anchor lookup misses and may set the admission
 * anchorExact carve-out only after a lexical hit re-confirms reconfirmToken.
 */
export function buildRetrievalQuery(input: RetrievalQueryInput): RetrievalQuery {
  const normalizedAnchors = input.anchors.map((anchor) => normalizeAnchor(anchor))
  const anchorLookupKeys = normalizedAnchors.map((anchor) => canonicalJson(anchor))
  const lexicalQuery = [
    input.intent.trim(),
    ...input.anchors.flatMap(rawLexicalTerms),
    ...normalizedAnchors.flatMap(normalizedLexicalTerms),
  ]
    .filter((term) => term !== '')
    .join(' ')
  const semanticText = canonicalJson({
    anchors: normalizedAnchors.flatMap((anchor) => {
      const rendered = semanticAnchor(anchor)
      return rendered === undefined ? [] : [rendered]
    }),
    intent: input.intent.trim(),
  })
  const queryClass = classifyQuery(lexicalQuery)

  return {
    lexicalQuery,
    semanticText,
    normalizedAnchors,
    anchorLookupKeys,
    queryClass,
    weights: QUERY_CLASS_WEIGHTS[queryClass],
    fallbackRenderings: buildFallbackRenderings(
      input.screenState,
      normalizedAnchors,
      anchorLookupKeys,
    ),
  }
}
