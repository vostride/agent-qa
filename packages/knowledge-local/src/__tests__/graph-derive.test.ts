import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type {
  Anchor,
  BundleRelation,
  DistilledObservation,
  GraphEdgeType,
  GraphNodeType,
} from '@vostride/agent-qa-schema'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, graphNodeId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { verifyBundleIntegrity } from '../bundle-read.js'
import type { BundleStoreConfig, PublishBundleInput } from '../bundle-publish.test-helper.js'
import {
  deriveEquivalentToBridges,
  deriveLocatesViaEdges,
  deriveObservationEdges,
} from '../graph-derive.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import {
  publishObservationFixture,
  writeObservationLines,
} from './fixtures/observation-fixture.js'
import type {
  DerivedGraphEdge,
  DerivedGraphNode,
  GraphDerivationContext,
} from '../graph-derive.js'

const context: GraphDerivationContext = {
  bundleId: 'r_graph_fixture',
  recordRowid: 17,
  product: 'checkout-app',
  createdAtOrdinal: 41,
}

function observation(
  overrides: Partial<DistilledObservation> = {},
): DistilledObservation {
  return {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'submit checkout', ordinal: 3 },
    platform: 'web',
    test: { id: 'checkout-happy-path' },
    procedure: { id: 'complete-checkout' },
    flow: { name: 'checkout', precedes: 'confirmation' },
    surface: { kind: 'page', naturalKey: '/checkout' },
    element: { naturalKey: 'button:submit order' },
    locator: { selector: '[data-testid="submit-order"]' },
    error: { naturalKey: 'submit remained disabled' },
    observedAtOrdinal: 44,
    ...overrides,
  }
}

function edgeKey(edge: DerivedGraphEdge): string {
  return `${edge.srcNodeId}\u0000${edge.edgeType}\u0000${edge.dstNodeId}`
}

function expectEdge(
  edges: readonly DerivedGraphEdge[],
  source: [GraphNodeType, Parameters<typeof graphNodeId>[1]],
  edgeType: GraphEdgeType,
  target: [GraphNodeType, Parameters<typeof graphNodeId>[1]],
): void {
  expect(edges).toContainEqual(expect.objectContaining({
    srcNodeId: graphNodeId(...source),
    edgeType,
    dstNodeId: graphNodeId(...target),
    recordRowid: context.recordRowid,
    bundleId: context.bundleId,
    product: context.product,
    recencyOrdinal: 44,
  }))
}

describe('deterministic graph derivation', () => {
  it('derives every observation-backed edge class with observation recency', () => {
    const { edges } = deriveObservationEdges([observation()], context)
    const stepKey = { naturalKey: 'submit checkout', ordinal: 3 }

    expectEdge(edges, ['test', 'checkout-happy-path'], 'contains', ['step', stepKey])
    expectEdge(
      edges,
      ['procedure', 'complete-checkout'],
      'composed-of',
      ['step', stepKey],
    )
    expectEdge(
      edges,
      ['step', stepKey],
      'uses',
      ['web-element', 'button:submit order'],
    )
    expectEdge(edges, ['step', stepKey], 'on', ['web-page', '/checkout'])
    expectEdge(edges, ['step', stepKey], 'part-of', ['flow', 'checkout'])
    expectEdge(edges, ['flow', 'checkout'], 'precedes', ['flow', 'confirmation'])
    expectEdge(
      edges,
      ['error', 'submit remained disabled'],
      'caused-by',
      ['web-element', 'button:submit order'],
    )
    expect(edges).toHaveLength(7)
  })

  it('derives selector locator edges only when the bundle platform is resolved', () => {
    const anchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'Submit order' },
      { t: 'selector', literal: '[data-testid="submit-order"]' },
    ]

    const resolved = deriveLocatesViaEdges(anchors, 'web', context)
    expect(resolved.edges).toEqual([
      expect.objectContaining({
        srcNodeId: graphNodeId('web-element', { role: 'button', name: 'submit order' }),
        edgeType: 'locates-via',
        dstNodeId: graphNodeId('web-locator', '[data-testid="submit-order"]'),
        recencyOrdinal: context.createdAtOrdinal,
      }),
    ])
    expect(deriveLocatesViaEdges(anchors, undefined, context).edges).toEqual([])
  })

  it.each([
    ['web only', ['web-element'], 0],
    ['mobile only', ['mobile-element'], 0],
    ['web and mobile', ['web-element', 'mobile-element'], 1],
    ['unresolved and web', ['element', 'web-element'], 0],
  ] as const)(
    'applies the platform-strict equivalent-to matrix: %s',
    (_label, elementTypes, expectedBridges) => {
      const stepNodeId = graphNodeId('step', { naturalKey: 'submit checkout', ordinal: 3 })
      const nodes: DerivedGraphNode[] = [
        {
          nodeId: stepNodeId,
          type: 'step',
          naturalKey: { naturalKey: 'submit checkout', ordinal: 3 },
          product: context.product,
        },
        ...elementTypes.map((type, index): DerivedGraphNode => ({
          nodeId: graphNodeId(type, `${type}-${index}`),
          type,
          naturalKey: `${type}-${index}`,
          product: context.product,
        })),
      ]
      const edges: DerivedGraphEdge[] = nodes.slice(1).map((node, index) => ({
        srcNodeId: stepNodeId,
        edgeType: 'uses',
        dstNodeId: node.nodeId,
        recordRowid: context.recordRowid + index,
        bundleId: `${context.bundleId}-${index}`,
        product: context.product,
        recencyOrdinal: 44 + index,
      }))

      const bridges = deriveEquivalentToBridges(nodes, edges)

      expect(bridges).toHaveLength(expectedBridges)
      for (const bridge of bridges) {
        expect(bridge.edgeType).toBe('equivalent-to')
        expect(nodes.find((node) => node.nodeId === bridge.srcNodeId)?.type)
          .toBe('web-element')
        expect(nodes.find((node) => node.nodeId === bridge.dstNodeId)?.type)
          .toBe('mobile-element')
      }
    },
  )

  it('emits every deterministic web-to-mobile pair in node-id order', () => {
    const observations = [
      observation({
        platform: 'mobile',
        surface: { kind: 'screen', naturalKey: 'CheckoutActivity' },
        element: { naturalKey: 'mobile-submit-b' },
        observedAtOrdinal: 48,
      }),
      observation({ element: { naturalKey: 'web-submit-b' }, observedAtOrdinal: 47 }),
      observation({
        platform: 'mobile',
        surface: { kind: 'screen', naturalKey: 'CheckoutActivity' },
        element: { naturalKey: 'mobile-submit-a' },
        observedAtOrdinal: 46,
      }),
      observation({ element: { naturalKey: 'web-submit-a' }, observedAtOrdinal: 45 }),
    ]
    const projection = deriveObservationEdges(observations, context)
    const bridges = deriveEquivalentToBridges(projection.nodes, projection.edges)

    expect(bridges).toHaveLength(4)
    expect(bridges.map(edgeKey)).toEqual([...bridges].sort((a, b) =>
      edgeKey(a).localeCompare(edgeKey(b))).map(edgeKey))
  })

  it('sorts edge output independently of observation enumeration order', () => {
    const observations = [
      observation(),
      observation({
        step: { naturalKey: 'confirm checkout', ordinal: 4 },
        element: { naturalKey: 'button:confirm order' },
        observedAtOrdinal: 45,
      }),
    ]

    const forward = deriveObservationEdges(observations, context).edges
    const reversed = deriveObservationEdges([...observations].reverse(), context).edges

    expect(forward).toEqual(reversed)
    expect(forward.map(edgeKey)).toEqual([...forward].sort((a, b) =>
      edgeKey(a).localeCompare(edgeKey(b))).map(edgeKey))
  })
})

function graphRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare(`
    SELECT
      graph_edges.src_node_id,
      graph_edges.edge_type,
      graph_edges.dst_node_id,
      records.bundle_id,
      graph_edges.recency_ordinal
    FROM graph_edges
    JOIN records ON records.record_rowid = graph_edges.record_rowid
    ORDER BY
      graph_edges.src_node_id,
      graph_edges.edge_type,
      graph_edges.dst_node_id,
      records.bundle_id
  `).all() as Record<string, unknown>[]
}

describe('observation graph rebuild integration', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-observation-graph-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey = 'Observation Product'): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function input(overrides: Partial<PublishBundleInput> = {}): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Submit order' },
          { t: 'selector', literal: '[data-testid="submit-order"]' },
          { t: 'platform', platform: 'web' },
        ],
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'observation-graph-run',
        testId: 'observation-graph-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
  }

  async function rebuild(): Promise<knowledgeLocal.RebuildReport> {
    return knowledgeLocal.rebuildIndex({ knowledgeRoot })
  }

  it('loads optional observation evidence without changing bundle integrity', async () => {
    const carrying = publishObservationFixture(config(), input(), [observation()])
    const absent = publishObservationFixture(
      config('No Observation Product'),
      input({
        draft: makeBundleDraftFixture({
          anchors: [{ t: 'platform', platform: 'android' }],
          scope: { tier: 'product', key: 'no-observation-product' },
        }),
      }),
      [],
    )
    rmSync(join(absent.dir, 'observations.jsonl'))

    expect(verifyBundleIntegrity(carrying.dir)).toEqual({ ok: true, violations: [] })
    expect(verifyBundleIntegrity(absent.dir)).toEqual({ ok: true, violations: [] })

    const report = await rebuild()
    expect(report.scanIssues).toEqual([])

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const edges = graphRows(reader.db)
      const carryingEdges = edges.filter((edge) => edge.bundle_id === carrying.id)
      expect(carryingEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          src_node_id: graphNodeId('test', 'checkout-happy-path'),
          edge_type: 'contains',
          dst_node_id: graphNodeId('step', {
            naturalKey: 'submit checkout',
            ordinal: 3,
          }),
          recency_ordinal: 44,
        }),
        expect.objectContaining({
          src_node_id: graphNodeId('web-element', {
            role: 'button',
            name: 'submit order',
          }),
          edge_type: 'locates-via',
          dst_node_id: graphNodeId(
            'web-locator',
            '[data-testid="submit-order"]',
          ),
          recency_ordinal: 42,
        }),
      ]))
      expect(edges.filter((edge) => edge.bundle_id === absent.id)).toEqual([])
    } finally {
      reader.db.close()
    }
  })

  it('reports and skips a malformed observation line while retaining valid lines', async () => {
    const published = publishObservationFixture(config(), input(), [
      observation({ observedAtOrdinal: 45 }),
      '{"schemaVersion":2,"step":',
      observation({
        step: { naturalKey: 'confirm checkout', ordinal: 4 },
        element: { naturalKey: 'button:confirm order' },
        observedAtOrdinal: 46,
      }),
    ])

    const report = await rebuild()
    expect(report.projected).toBe(1)
    expect(report.scanIssues).toHaveLength(1)
    expect(report.scanIssues[0]).toContain(`${published.dir}/observations.jsonl:2`)

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const uses = graphRows(reader.db).filter((edge) => edge.edge_type === 'uses')
      expect(uses).toHaveLength(2)
      expect(uses.map((edge) => Number(edge.recency_ordinal)).sort()).toEqual([45, 46])
    } finally {
      reader.db.close()
    }
  })

  it('retains curated equivalent-to relations with their added ordinal', async () => {
    const target = publishObservationFixture(
      config('Bridge Target'),
      input({
        draft: makeBundleDraftFixture({
          scope: { tier: 'product', key: 'bridge-target' },
          summary: 'Bridge target',
        }),
      }),
      [],
    )
    rmSync(join(target.dir, 'observations.jsonl'))
    const relation: BundleRelation = {
      type: 'equivalent-to',
      targetId: target.id,
      addedAtOrdinal: 57,
      curationJobId: 'curated-equivalent-bridge',
    }
    const source = publishObservationFixture(
      config('Bridge Source'),
      input({
        draft: makeBundleDraftFixture({
          scope: { tier: 'product', key: 'bridge-source' },
          summary: 'Bridge source',
        }),
        relations: [relation],
      }),
      [],
    )
    rmSync(join(source.dir, 'observations.jsonl'))

    expect((await rebuild()).scanIssues).toEqual([])
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(graphRows(reader.db)).toContainEqual(expect.objectContaining({
        src_node_id: graphNodeId('fact', source.id),
        edge_type: 'equivalent-to',
        dst_node_id: graphNodeId('fact', target.id),
        bundle_id: source.id,
        recency_ordinal: 57,
      }))
    } finally {
      reader.db.close()
    }
  })

  it('re-reads observation evidence for an unchanged bundle', async () => {
    const published = publishObservationFixture(config(), input(), [observation()])
    expect((await rebuild()).projected).toBe(1)
    writeObservationLines(published.dir, [
      observation({
        step: { naturalKey: 'confirm checkout', ordinal: 4 },
        observedAtOrdinal: 61,
      }),
    ])

    expect((await rebuild()).projected).toBe(0)
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(graphRows(reader.db)).toContainEqual(expect.objectContaining({
        src_node_id: graphNodeId('test', 'checkout-happy-path'),
        edge_type: 'contains',
        dst_node_id: graphNodeId('step', {
          naturalKey: 'confirm checkout',
          ordinal: 4,
        }),
        bundle_id: published.id,
        recency_ordinal: 61,
      }))
    } finally {
      reader.db.close()
    }
  })
})
