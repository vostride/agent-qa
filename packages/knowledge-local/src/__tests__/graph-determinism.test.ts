import { renameSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION, graphNodeId } from '@vostride/agent-qa-schema'
import type {
  BundleRelation,
  DistilledObservation,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import type { BundleStoreConfig, PublishBundleInput } from '../bundle-publish.test-helper.js'
import { loadBundle } from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import {
  publishObservationFixture,
  type PublishedObservationFixture,
} from './fixtures/observation-fixture.js'

interface GraphDumpRow {
  src_node_id: string
  edge_type: string
  dst_node_id: string
  bundle_id: string
  product: string
  recency_ordinal: number
}

function dumpGraphEdges(db: DatabaseSync): GraphDumpRow[] {
  return db.prepare(`
    SELECT
      graph_edges.src_node_id,
      graph_edges.edge_type,
      graph_edges.dst_node_id,
      records.bundle_id,
      graph_edges.product,
      graph_edges.recency_ordinal
    FROM graph_edges
    JOIN records ON records.record_rowid = graph_edges.record_rowid
    ORDER BY
      graph_edges.src_node_id,
      graph_edges.edge_type,
      graph_edges.dst_node_id,
      records.bundle_id
  `).all() as unknown as GraphDumpRow[]
}

function observation(
  platform: 'web' | 'mobile',
  elementNaturalKey: string,
  observedAtOrdinal: number,
): DistilledObservation {
  return {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'submit checkout', ordinal: 3 },
    platform,
    test: { id: 'checkout-happy-path' },
    procedure: { id: 'complete-checkout' },
    flow: { name: 'checkout', precedes: 'confirmation' },
    surface: {
      kind: platform === 'web' ? 'page' : 'screen',
      naturalKey: platform === 'web' ? '/checkout' : 'CheckoutActivity',
    },
    element: { naturalKey: elementNaturalKey },
    error: { naturalKey: `${platform} submit failed` },
    observedAtOrdinal,
  }
}

describe('GRPH-01 graph rebuild determinism', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-graph-determinism-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(knowledgeRoot: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Checkout Application',
    }
  }

  function input(
    platform: 'web' | 'android',
    label: string,
    relations: readonly BundleRelation[] = [],
  ): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: `${label} submit` },
          {
            t: 'selector',
            literal: platform === 'web'
              ? '[data-testid="submit-order"]'
              : 'com.example:id/submit_order',
          },
          {
            t: 'page',
            route: platform === 'web' ? '/checkout' : 'CheckoutActivity',
          },
          { t: 'platform', platform },
        ],
        scope: { tier: 'product', key: `checkout-${label.toLowerCase()}` },
        summary: `${label} checkout submission`,
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: platform === 'web' ? 42 : 43,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [...relations],
      provenance: {
        mode: 'run-linked',
        runId: `graph-determinism-${label.toLowerCase()}`,
        testId: 'checkout-happy-path',
        stepIndex: 3,
      },
      artifacts: [],
    }
  }

  function buildFixtureTree(knowledgeRoot: string): PublishedObservationFixture[] {
    scaffoldKnowledgeRoot(knowledgeRoot)
    const mobile = publishObservationFixture(
      config(knowledgeRoot),
      input('android', 'Mobile'),
      [observation('mobile', 'mobile:submit order', 46)],
    )
    const relation: BundleRelation = {
      type: 'equivalent-to',
      targetId: mobile.id,
      addedAtOrdinal: 47,
      curationJobId: 'graph-determinism-curated-bridge',
    }
    const web = publishObservationFixture(
      config(knowledgeRoot),
      input('web', 'Web', [relation]),
      [observation('web', 'web:submit order', 45)],
    )
    return [mobile, web]
  }

  async function rebuildAndDump(knowledgeRoot: string): Promise<GraphDumpRow[]> {
    const report = await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    expect(report.scanIssues).toEqual([])
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      return dumpGraphEdges(reader.db)
    } finally {
      reader.db.close()
    }
  }

  function permuteDirectoryNames(
    knowledgeRoot: string,
    published: readonly PublishedObservationFixture[],
  ): void {
    const sorted = [...published].sort((left, right) =>
      basename(left.dir).localeCompare(basename(right.dir)))
    const staged = sorted.map((bundle, index) => {
      const stagedDir = join(dirname(bundle.dir), `.permutation-${index}`)
      renameSync(bundle.dir, stagedDir)
      return stagedDir
    })
    for (const [index, stagedDir] of staged.entries()) {
      renameSync(stagedDir, join(dirname(stagedDir), `permuted-${sorted.length - index}`))
    }

    const enumeratedIds = enumerateBundleDirs(knowledgeRoot).map(({ dir }) => {
      const outcome = loadBundle(dir)
      if (outcome.kind !== 'loaded') throw new Error(`expected loaded, got ${outcome.kind}`)
      return outcome.bundle.manifest.id
    })
    expect(enumeratedIds).toEqual(sorted.map((bundle) => bundle.id).reverse())
  }

  it('produces the identical bundle-keyed edge dump when rebuilt twice', async () => {
    const knowledgeRoot = join(root, 'same-tree', 'agent-qa-knowledge')
    const [mobile, web] = buildFixtureTree(knowledgeRoot)

    const first = await rebuildAndDump(knowledgeRoot)
    const second = await rebuildAndDump(knowledgeRoot)

    expect(second).toEqual(first)
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_type: 'about' }),
      expect.objectContaining({ edge_type: 'locates-via' }),
      expect.objectContaining({ edge_type: 'uses' }),
      expect.objectContaining({
        src_node_id: graphNodeId('web-element', 'web:submit order'),
        edge_type: 'equivalent-to',
        dst_node_id: graphNodeId('mobile-element', 'mobile:submit order'),
      }),
      expect.objectContaining({
        src_node_id: graphNodeId('fact', web!.id),
        edge_type: 'equivalent-to',
        dst_node_id: graphNodeId('fact', mobile!.id),
        bundle_id: web!.id,
        recency_ordinal: 47,
      }),
    ]))
  })

  it('produces the identical dump after bundle enumeration is permuted', async () => {
    const canonicalRoot = join(root, 'canonical', 'agent-qa-knowledge')
    buildFixtureTree(canonicalRoot)
    const canonical = await rebuildAndDump(canonicalRoot)

    const permutedRoot = join(root, 'permuted', 'agent-qa-knowledge')
    const published = buildFixtureTree(permutedRoot)
    permuteDirectoryNames(permutedRoot, published)
    const permuted = await rebuildAndDump(permutedRoot)

    expect(permuted).toEqual(canonical)
  })
})
