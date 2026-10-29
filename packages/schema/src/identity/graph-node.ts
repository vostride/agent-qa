// Node ids stay stable: ontology members may be added, but this identity is never re-keyed.
import type { Platform } from '../action/index'
import { canonicalJson } from '../determinism/canonical-json'
import { sha256hex } from '../determinism/sha256'
import type { JsonObject } from '../run/run-artifact'
import type { Anchor } from './anchor'
import { normalizeAnchor } from './normalize-anchor'

export type GraphNodeType =
  | 'fact'
  | 'procedure'
  | 'caution'
  | 'unknown'
  | 'policy'
  | 'app'
  | 'suite'
  | 'test'
  | 'step'
  | 'flow'
  | 'error'
  | 'element'
  | 'page'
  | 'web-page'
  | 'web-element'
  | 'web-locator'
  | 'mobile-screen'
  | 'mobile-element'
  | 'android-locator'
  | 'ios-locator'

export type GraphEdgeType =
  | 'about'
  | 'part-of'
  | 'supersedes'
  | 'superseded-by'
  | 'derived-from'
  | 'conflicts-with'
  | 'relates-to'
  | 'renamed-from'
  | 'contains'
  | 'composed-of'
  | 'precedes'
  | 'on'
  | 'locates-via'
  | 'uses'
  | 'caused-by'
  | 'equivalent-to'

export type GraphNodeNaturalKey = string | JsonObject

type GraphNode = {
  type: GraphNodeType
  naturalKey: GraphNodeNaturalKey
  nodeId: string
}

/** Canonical type-plus-natural-key identity; tuple serialization prevents concatenation ambiguity. */
export function graphNodeId(type: GraphNodeType, naturalKey: GraphNodeNaturalKey): string {
  return sha256hex(canonicalJson([type, naturalKey]))
}

function graphNode(type: GraphNodeType, naturalKey: GraphNodeNaturalKey): GraphNode {
  return { type, naturalKey, nodeId: graphNodeId(type, naturalKey) }
}

function elementType(platform?: Platform): GraphNodeType {
  if (platform === 'web') return 'web-element'
  if (platform === undefined) return 'element'
  return 'mobile-element'
}

function pageType(platform?: Platform): GraphNodeType {
  if (platform === 'web') return 'web-page'
  if (platform === undefined) return 'page'
  return 'mobile-screen'
}

export function anchorGraphNode(anchor: Anchor, platform?: Platform): GraphNode | null {
  const normalized = normalizeAnchor(anchor)

  switch (normalized.t) {
    case 'el': {
      const naturalKey: JsonObject =
        normalized.ordinal === undefined
          ? { role: normalized.role, name: normalized.name }
          : { role: normalized.role, name: normalized.name, ordinal: normalized.ordinal }
      return graphNode(elementType(platform), naturalKey)
    }
    case 'page':
      return graphNode(pageType(platform), normalized.route)
    case 'flow':
      return graphNode('flow', normalized.name)
    case 'error':
      return graphNode('error', normalized.message)
    case 'selector': {
      if (platform === undefined) return null
      const type =
        platform === 'web'
          ? 'web-locator'
          : platform === 'android'
            ? 'android-locator'
            : 'ios-locator'
      return graphNode(type, normalized.literal)
    }
    case 'platform':
      return null
  }
}

/** Total record-node mapping: the canonical bundle kind is the graph node type. */
export function recordGraphNode(
  kind: 'fact' | 'procedure' | 'caution' | 'unknown' | 'policy',
  bundleId: string,
): { type: GraphNodeType; naturalKey: string; nodeId: string } {
  return { type: kind, naturalKey: bundleId, nodeId: graphNodeId(kind, bundleId) }
}
