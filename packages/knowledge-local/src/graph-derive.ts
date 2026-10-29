// `part-of` is element-to-surface containment; `on` is only for step-to-page or step-to-screen.
import {
  anchorGraphNode,
  graphNodeId,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  DistilledObservation,
  GraphEdgeType,
  GraphNodeNaturalKey,
  GraphNodeType,
  Platform,
} from '@vostride/agent-qa-schema'

export interface GraphDerivationContext {
  bundleId: string
  recordRowid: number
  product: string
  createdAtOrdinal: number
}

export interface DerivedGraphNode {
  nodeId: string
  type: GraphNodeType
  naturalKey: GraphNodeNaturalKey
  product: string
}

export interface DerivedGraphEdge {
  srcNodeId: string
  edgeType: GraphEdgeType
  dstNodeId: string
  recordRowid: number
  bundleId: string
  product: string
  recencyOrdinal: number
}

export interface GraphDerivation {
  nodes: DerivedGraphNode[]
  edges: DerivedGraphEdge[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareEdges(left: DerivedGraphEdge, right: DerivedGraphEdge): number {
  return compareText(left.srcNodeId, right.srcNodeId)
    || compareText(left.edgeType, right.edgeType)
    || compareText(left.dstNodeId, right.dstNodeId)
    || compareText(left.bundleId, right.bundleId)
    || left.recordRowid - right.recordRowid
}

function compareNodes(left: DerivedGraphNode, right: DerivedGraphNode): number {
  return compareText(left.nodeId, right.nodeId) || compareText(left.product, right.product)
}

function edgeIdentity(edge: DerivedGraphEdge): string {
  return [
    edge.srcNodeId,
    edge.edgeType,
    edge.dstNodeId,
    edge.bundleId,
    edge.recordRowid,
  ].join('\u0000')
}

function node(type: GraphNodeType, naturalKey: GraphNodeNaturalKey, product: string): DerivedGraphNode {
  return { nodeId: graphNodeId(type, naturalKey), type, naturalKey, product }
}

class DerivationBuilder {
  readonly #nodes = new Map<string, DerivedGraphNode>()
  readonly #edges = new Map<string, DerivedGraphEdge>()

  addNode(value: DerivedGraphNode): void {
    const key = `${value.nodeId}\u0000${value.product}`
    if (!this.#nodes.has(key)) this.#nodes.set(key, value)
  }

  addEdge(value: DerivedGraphEdge): void {
    const key = edgeIdentity(value)
    const current = this.#edges.get(key)
    if (current === undefined || value.recencyOrdinal > current.recencyOrdinal) {
      this.#edges.set(key, value)
    }
  }

  connect(
    source: DerivedGraphNode,
    edgeType: GraphEdgeType,
    target: DerivedGraphNode,
    context: GraphDerivationContext,
    recencyOrdinal: number,
  ): void {
    this.addNode(source)
    this.addNode(target)
    this.addEdge({
      srcNodeId: source.nodeId,
      edgeType,
      dstNodeId: target.nodeId,
      recordRowid: context.recordRowid,
      bundleId: context.bundleId,
      product: context.product,
      recencyOrdinal,
    })
  }

  result(): GraphDerivation {
    return {
      nodes: [...this.#nodes.values()].sort(compareNodes),
      edges: [...this.#edges.values()].sort(compareEdges),
    }
  }
}

function observationStep(
  observation: DistilledObservation,
  product: string,
): DerivedGraphNode {
  return node(
    'step',
    { naturalKey: observation.step.naturalKey, ordinal: observation.step.ordinal },
    product,
  )
}

function observationElement(
  observation: DistilledObservation,
  product: string,
): DerivedGraphNode | undefined {
  if (observation.element === undefined || observation.platform === undefined) return undefined
  return node(
    observation.platform === 'web' ? 'web-element' : 'mobile-element',
    observation.element.naturalKey,
    product,
  )
}

/** Derive the complete observation-backed §6.1 edge vocabulary for one bundle. */
export function deriveObservationEdges(
  observations: readonly DistilledObservation[],
  context: GraphDerivationContext,
): GraphDerivation {
  const builder = new DerivationBuilder()

  for (const observation of observations) {
    const step = observationStep(observation, context.product)
    const element = observationElement(observation, context.product)
    const recency = observation.observedAtOrdinal

    if (observation.test !== undefined) {
      builder.connect(
        node('test', observation.test.id, context.product),
        'contains',
        step,
        context,
        recency,
      )
    }
    if (observation.procedure !== undefined) {
      builder.connect(
        node('procedure', observation.procedure.id, context.product),
        'composed-of',
        step,
        context,
        recency,
      )
    }
    if (element !== undefined) {
      builder.connect(step, 'uses', element, context, recency)
    }
    if (observation.surface !== undefined) {
      builder.connect(
        step,
        'on',
        node(
          observation.surface.kind === 'page' ? 'web-page' : 'mobile-screen',
          observation.surface.naturalKey,
          context.product,
        ),
        context,
        recency,
      )
    }
    if (observation.flow !== undefined) {
      const flow = node('flow', observation.flow.name, context.product)
      builder.connect(step, 'part-of', flow, context, recency)
      if (observation.flow.precedes !== undefined) {
        builder.connect(
          flow,
          'precedes',
          node('flow', observation.flow.precedes, context.product),
          context,
          recency,
        )
      }
    }
    if (observation.error !== undefined && element !== undefined) {
      builder.connect(
        node('error', observation.error.naturalKey, context.product),
        'caused-by',
        element,
        context,
        recency,
      )
    }
  }

  return builder.result()
}

/** Derive element→locator edges from bundle anchors using anchorGraphNode's platform gate. */
export function deriveLocatesViaEdges(
  anchors: readonly Anchor[],
  platform: Platform | undefined,
  context: GraphDerivationContext,
): GraphDerivation {
  const builder = new DerivationBuilder()
  const elements: DerivedGraphNode[] = []
  const locators: DerivedGraphNode[] = []

  for (const anchor of anchors) {
    const projected = anchorGraphNode(anchor, platform)
    if (projected === null) continue
    const derived = { ...projected, product: context.product }
    if (
      derived.type === 'element'
      || derived.type === 'web-element'
      || derived.type === 'mobile-element'
    ) {
      elements.push(derived)
    } else if (
      derived.type === 'web-locator'
      || derived.type === 'android-locator'
      || derived.type === 'ios-locator'
    ) {
      locators.push(derived)
    }
  }

  for (const element of elements.sort(compareNodes)) {
    for (const locator of locators.sort(compareNodes)) {
      builder.connect(
        element,
        'locates-via',
        locator,
        context,
        context.createdAtOrdinal,
      )
    }
  }

  return builder.result()
}

function preferSupport(
  left: DerivedGraphEdge | undefined,
  right: DerivedGraphEdge,
): DerivedGraphEdge {
  if (left === undefined || right.recencyOrdinal > left.recencyOrdinal) return right
  if (right.recencyOrdinal < left.recencyOrdinal) return left
  return compareText(right.bundleId, left.bundleId) < 0
    || (right.bundleId === left.bundleId && right.recordRowid < left.recordRowid)
    ? right
    : left
}

/**
 * Join uses-edges by product and shared step identity. Only explicit web/mobile element node types
 * participate; the unresolved shared `element` type is intentionally invisible to this join.
 */
export function deriveEquivalentToBridges(
  nodes: readonly DerivedGraphNode[],
  edges: readonly DerivedGraphEdge[],
): DerivedGraphEdge[] {
  const nodeTypes = new Map(nodes.map((value) => [value.nodeId, value.type]))
  const groups = new Map<string, {
    web: Map<string, DerivedGraphEdge>
    mobile: Map<string, DerivedGraphEdge>
  }>()

  for (const edge of [...edges].sort(compareEdges)) {
    if (edge.edgeType !== 'uses') continue
    const type = nodeTypes.get(edge.dstNodeId)
    if (type !== 'web-element' && type !== 'mobile-element') continue
    const key = `${edge.product}\u0000${edge.srcNodeId}`
    const group = groups.get(key) ?? { web: new Map(), mobile: new Map() }
    const side = type === 'web-element' ? group.web : group.mobile
    side.set(edge.dstNodeId, preferSupport(side.get(edge.dstNodeId), edge))
    groups.set(key, group)
  }

  const bridges: DerivedGraphEdge[] = []
  for (const key of [...groups.keys()].sort(compareText)) {
    const group = groups.get(key)!
    const web = [...group.web.entries()].sort(([left], [right]) => compareText(left, right))
    const mobile = [...group.mobile.entries()]
      .sort(([left], [right]) => compareText(left, right))

    for (const [webNodeId, webSupport] of web) {
      for (const [mobileNodeId, mobileSupport] of mobile) {
        const support = preferSupport(webSupport, mobileSupport)
        bridges.push({
          srcNodeId: webNodeId,
          edgeType: 'equivalent-to',
          dstNodeId: mobileNodeId,
          recordRowid: support.recordRowid,
          bundleId: support.bundleId,
          product: support.product,
          recencyOrdinal: support.recencyOrdinal,
        })
      }
    }
  }

  return bridges.sort(compareEdges)
}
