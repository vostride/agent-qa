import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  expandOneHop,
  type ExpansionQueryScope,
  type ExpansionSeed,
} from '../retrieval/expansion.js'
import {
  FAN_IN_THRESHOLD_K,
  FAN_OUT_CAP,
  HUB_DEGREE_THRESHOLD,
} from '../retrieval/constants.js'
import { fuseWeightedRrf } from '../retrieval/fusion.js'

const QUERY_SCOPE = {
  product: 'storefront',
  testKey: 'test:checkout',
  suiteKey: 'suite:smoke',
  productKey: 'product:storefront',
  globalKey: 'scope:global',
} as const satisfies ExpansionQueryScope

type ScopeTier = 'global' | 'product' | 'suite' | 'test'
type RecordStatus = 'active' | 'candidate' | 'deprecated' | 'superseded'

interface InsertRecordOptions {
  product?: string
  scopeTier?: ScopeTier
  scopeKey?: string
  status?: RecordStatus
  trust?: number
}

interface RankedNeighbor {
  bundleId: string
  nodeId: string
  trust: number
  recencyOrdinal: number
}

describe('deterministic one-hop expansion', () => {
  let db: DatabaseSync
  let nextRecordRowid: number
  let recordRowids: Map<string, number>

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE records (
        record_rowid INTEGER PRIMARY KEY,
        bundle_id TEXT NOT NULL UNIQUE,
        product TEXT NOT NULL,
        scope_tier TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        status TEXT NOT NULL,
        trust REAL NOT NULL
      );
      CREATE TABLE graph_edges (
        src_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        dst_node_id TEXT NOT NULL,
        record_rowid INTEGER NOT NULL,
        product TEXT NOT NULL,
        recency_ordinal INTEGER NOT NULL,
        UNIQUE(src_node_id, edge_type, dst_node_id, record_rowid)
      );
    `)
    nextRecordRowid = 1
    recordRowids = new Map()
  })

  afterEach(() => {
    db.close()
  })

  function insertRecord(bundleId: string, options: InsertRecordOptions = {}): number {
    const recordRowid = nextRecordRowid
    nextRecordRowid += 1
    db.prepare(`
      INSERT INTO records (
        record_rowid, bundle_id, product, scope_tier, scope_key, status, trust
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordRowid,
      bundleId,
      options.product ?? QUERY_SCOPE.product,
      options.scopeTier ?? 'test',
      options.scopeKey ?? QUERY_SCOPE.testKey,
      options.status ?? 'active',
      options.trust ?? 0.5,
    )
    recordRowids.set(bundleId, recordRowid)
    return recordRowid
  }

  function insertEdge(input: {
    source: string
    target: string
    candidateBundleId: string
    recencyOrdinal: number
    edgeType?: string
  }): void {
    const recordRowid = recordRowids.get(input.candidateBundleId)
    if (recordRowid === undefined) {
      throw new Error(`missing candidate record ${input.candidateBundleId}`)
    }
    db.prepare(`
      INSERT INTO graph_edges (
        src_node_id, edge_type, dst_node_id, record_rowid, product, recency_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.edgeType ?? 'about',
      input.target,
      recordRowid,
      QUERY_SCOPE.product,
      input.recencyOrdinal,
    )
  }

  function expand(seeds: readonly ExpansionSeed[], n = 10) {
    return expandOneHop(db, seeds, QUERY_SCOPE, n)
  }

  it('returns incoming and outgoing one-hop records without feeding candidates into a second hop', () => {
    insertRecord('seed', { trust: 1 })
    insertRecord('one-hop-outgoing', { trust: 0.9 })
    insertRecord('one-hop-incoming', { trust: 0.8 })
    insertRecord('two-hops-away', { trust: 0.99 })

    insertEdge({
      source: 'node:seed',
      target: 'node:one-hop',
      candidateBundleId: 'one-hop-outgoing',
      recencyOrdinal: 20,
    })
    insertEdge({
      source: 'node:incoming',
      target: 'node:seed',
      candidateBundleId: 'one-hop-incoming',
      recencyOrdinal: 19,
    })
    insertEdge({
      source: 'node:one-hop',
      target: 'node:two-hop',
      candidateBundleId: 'two-hops-away',
      recencyOrdinal: 30,
    })

    expect(expand([{ bundleId: 'seed', nodeIds: ['node:seed'] }])).toMatchObject([
      { bundleId: 'one-hop-outgoing', source: 'expanded', seedBundleIds: ['seed'] },
      { bundleId: 'one-hop-incoming', source: 'expanded', seedBundleIds: ['seed'] },
    ])
  })

  it('caps each seed node at the deterministic trust, recency, then node-id top 32', () => {
    insertRecord('seed', { trust: 1 })
    const neighbors: RankedNeighbor[] = Array.from({ length: 40 }, (_, index) => {
      const suffix = String(index).padStart(2, '0')
      return {
        bundleId: `neighbor:${suffix}`,
        nodeId: `neighbor:${suffix}`,
        trust: (index % 4) / 10 + 0.5,
        recencyOrdinal: Math.floor(index / 4),
      }
    })
    for (const neighbor of neighbors) {
      insertRecord(neighbor.bundleId, { trust: neighbor.trust })
      insertEdge({
        source: 'node:seed',
        target: neighbor.nodeId,
        candidateBundleId: neighbor.bundleId,
        recencyOrdinal: neighbor.recencyOrdinal,
      })
    }

    const expected = [...neighbors]
      .sort(
        (left, right) =>
          right.trust - left.trust
          || right.recencyOrdinal - left.recencyOrdinal
          || left.nodeId.localeCompare(right.nodeId),
      )
      .slice(0, FAN_OUT_CAP)
      .map(({ bundleId }) => bundleId)

    const first = expand([{ bundleId: 'seed', nodeIds: ['node:seed'] }], 100)
    const second = expand([{ bundleId: 'seed', nodeIds: ['node:seed'] }], 100)

    expect(first).toHaveLength(FAN_OUT_CAP)
    expect(first.map(({ bundleId }) => bundleId)).toEqual(expected)
    expect(second).toEqual(first)
  })

  it('skips a hub as both the seed-side node and the opposite endpoint', () => {
    insertRecord('seed', { trust: 1 })
    insertRecord('hub-adjacent', { trust: 0.99 })
    insertRecord('hub-only-target', { trust: 0.98 })
    insertEdge({
      source: 'node:seed',
      target: 'node:hub',
      candidateBundleId: 'hub-adjacent',
      recencyOrdinal: 100,
    })
    for (let index = 0; index < HUB_DEGREE_THRESHOLD; index += 1) {
      insertEdge({
        source: 'node:hub',
        target: `node:hub-spoke:${index}`,
        candidateBundleId: 'hub-only-target',
        recencyOrdinal: index,
        edgeType: `spoke:${index}`,
      })
    }

    expect(expand([{ bundleId: 'seed', nodeIds: ['node:seed'] }])).toEqual([])
    expect(expand([{ bundleId: 'seed', nodeIds: ['node:hub'] }], 100)).toEqual([])
  })

  it('applies the shared fail-closed pre-filter before admitting an expanded record', () => {
    insertRecord('seed', { trust: 1 })
    insertRecord('admitted', { trust: 0.7 })
    insertRecord('superseded', { status: 'superseded', trust: 0.9 })
    insertRecord('sibling-product', {
      product: 'payments',
      scopeTier: 'product',
      scopeKey: QUERY_SCOPE.productKey,
      trust: 0.8,
    })
    for (const [index, bundleId] of ['admitted', 'superseded', 'sibling-product'].entries()) {
      insertEdge({
        source: 'node:seed',
        target: `node:${bundleId}`,
        candidateBundleId: bundleId,
        recencyOrdinal: 10 - index,
      })
    }

    expect(expand([{ bundleId: 'seed', nodeIds: ['node:seed'] }])).toMatchObject([
      { bundleId: 'admitted' },
    ])
  })

  it('deduplicates one candidate reached through multiple nodes and distinct seeds without a boost', () => {
    for (const seed of ['seed-a', 'seed-b', 'seed-c']) {
      insertRecord(seed, { trust: 1 })
    }
    insertRecord('shared-candidate', { trust: 0.73 })
    insertEdge({
      source: 'node:seed-a',
      target: 'node:shared:a',
      candidateBundleId: 'shared-candidate',
      recencyOrdinal: 20,
    })
    insertEdge({
      source: 'node:seed-a:alternate',
      target: 'node:shared:a:alternate',
      candidateBundleId: 'shared-candidate',
      recencyOrdinal: 19,
    })
    insertEdge({
      source: 'node:seed-b',
      target: 'node:shared:b',
      candidateBundleId: 'shared-candidate',
      recencyOrdinal: 25,
    })
    insertEdge({
      source: 'node:seed-c',
      target: 'node:shared:c',
      candidateBundleId: 'shared-candidate',
      recencyOrdinal: 30,
    })

    const singleSeed = expand([{ bundleId: 'seed-c', nodeIds: ['node:seed-c'] }])
    const multiSeed = expand([
      { bundleId: 'seed-a', nodeIds: ['node:seed-a', 'node:seed-a:alternate'] },
      { bundleId: 'seed-b', nodeIds: ['node:seed-b'] },
      { bundleId: 'seed-c', nodeIds: ['node:seed-c'] },
    ])

    expect(multiSeed).toHaveLength(1)
    expect(multiSeed[0]).toMatchObject({
      bundleId: 'shared-candidate',
      trust: 0.73,
      recencyOrdinal: 30,
      source: 'expanded',
      seedBundleIds: ['seed-a', 'seed-b', 'seed-c'],
    })
    const { seedBundleIds: _singleAttribution, ...singleRankFields } = singleSeed[0]!
    const { seedBundleIds: _multiAttribution, ...multiRankFields } = multiSeed[0]!
    expect(multiRankFields).toEqual(singleRankFields)
  })

  it('excludes fan-in above the threshold only from expansion while direct fusion remains eligible', () => {
    const seeds = Array.from({ length: FAN_IN_THRESHOLD_K + 1 }, (_, index) => {
      const bundleId = `fan-in-seed:${index}`
      const nodeId = `node:fan-in-seed:${index}`
      insertRecord(bundleId, { trust: 1 })
      return { bundleId, nodeIds: [nodeId] }
    })
    insertRecord('ubiquitous-candidate', { trust: 0.99 })
    for (const [index, seed] of seeds.entries()) {
      insertEdge({
        source: seed.nodeIds[0]!,
        target: `node:ubiquitous:${index}`,
        candidateBundleId: 'ubiquitous-candidate',
        recencyOrdinal: 100 - index,
      })
    }

    expect(expand(seeds, 100)).toEqual([])

    const direct = fuseWeightedRrf([{
      weight: 1,
      ranked: [{
        bundleId: 'ubiquitous-candidate',
        source: 'direct',
        legRanks: { lexical: 1 },
        rawScores: { bm25Positive: 1 },
      }],
    }])
    expect(direct.map(({ bundleId }) => bundleId)).toEqual(['ubiquitous-candidate'])
  })

  it('walls global candidates and global seeds while crossing tiers inside the query product', () => {
    insertRecord('product-seed', { scopeTier: 'test', trust: 1 })
    insertRecord('global-seed', {
      product: 'shared',
      scopeTier: 'global',
      scopeKey: QUERY_SCOPE.globalKey,
      trust: 1,
    })
    insertRecord('test-candidate', { scopeTier: 'test', trust: 0.9 })
    insertRecord('suite-candidate', {
      scopeTier: 'suite',
      scopeKey: QUERY_SCOPE.suiteKey,
      trust: 0.8,
    })
    insertRecord('product-candidate', {
      scopeTier: 'product',
      scopeKey: QUERY_SCOPE.productKey,
      trust: 0.7,
    })
    insertRecord('global-candidate', {
      product: 'shared',
      scopeTier: 'global',
      scopeKey: QUERY_SCOPE.globalKey,
      trust: 0.99,
    })

    for (const [index, bundleId] of [
      'test-candidate',
      'suite-candidate',
      'product-candidate',
      'global-candidate',
    ].entries()) {
      insertEdge({
        source: 'node:product-seed',
        target: `node:${bundleId}`,
        candidateBundleId: bundleId,
        recencyOrdinal: 50 - index,
      })
    }
    insertEdge({
      source: 'node:global-seed',
      target: 'node:product-from-global',
      candidateBundleId: 'test-candidate',
      recencyOrdinal: 60,
    })

    expect(
      expand([{ bundleId: 'product-seed', nodeIds: ['node:product-seed'] }]),
    ).toMatchObject([
      { bundleId: 'test-candidate' },
      { bundleId: 'suite-candidate' },
      { bundleId: 'product-candidate' },
    ])
    expect(
      expand([{ bundleId: 'global-seed', nodeIds: ['node:global-seed'] }]),
    ).toEqual([])
  })

  it('contains a high-trust poisoned global record under every seed selection', () => {
    const seeds = ['poison-seed-a', 'poison-seed-b', 'poison-seed-c'].map(
      (bundleId, index) => {
        const nodeId = `node:${bundleId}`
        insertRecord(bundleId, { trust: 1 })
        return { bundleId, nodeIds: [nodeId], index }
      },
    )
    insertRecord('poisoned-global', {
      product: 'shared',
      scopeTier: 'global',
      scopeKey: QUERY_SCOPE.globalKey,
      trust: 10,
    })
    for (const seed of seeds) {
      insertEdge({
        source: seed.nodeIds[0]!,
        target: `node:poisoned-global:${seed.index}`,
        candidateBundleId: 'poisoned-global',
        recencyOrdinal: 1_000 - seed.index,
      })
    }

    const expansionSeeds = seeds.map(({ bundleId, nodeIds }) => ({ bundleId, nodeIds }))
    for (const seed of expansionSeeds) {
      expect(expand([seed])).toEqual([])
    }
    expect(expand(expansionSeeds)).toEqual([])
  })
})
