import { describe, expect, it } from 'vitest'

import type { GraphEdgeType } from '../identity/graph-node'
import {
  BUNDLE_SCHEMA_VERSION,
  BundleRelationsSchema,
} from '../knowledge/bundle-files'
import { graphNodeId } from '../identity/graph-node'

const GRAPH_EDGE_TYPES = {
  about: true,
  'part-of': true,
  supersedes: true,
  'superseded-by': true,
  'derived-from': true,
  'conflicts-with': true,
  'relates-to': true,
  'renamed-from': true,
  contains: true,
  'composed-of': true,
  precedes: true,
  on: true,
  'locates-via': true,
  uses: true,
  'caused-by': true,
  'equivalent-to': true,
} as const satisfies Record<GraphEdgeType, true>

const equivalentRelation = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  relations: [{
    type: 'equivalent-to' as const,
    targetId: 'fact-el-submit-button-0123456789abcdef',
    addedAtOrdinal: 44,
    curationJobId: 'curation-equivalent-elements',
  }],
}

describe('graph edge ontology', () => {
  it('covers every graph edge type at the type boundary', () => {
    expect(Object.keys(GRAPH_EDGE_TYPES)).toHaveLength(16)
  })

  it('does not re-key the pre-phase graph node identity', () => {
    expect(graphNodeId('step', 'checkout:3'))
      .toBe('64c1ad5d0a4f43e1016118459107f3155930a5d826b2473611bf42a04fa677db')
  })

  it('accepts equivalent-to only when every persisted relation field is present', () => {
    expect(BundleRelationsSchema.parse(equivalentRelation)).toEqual(equivalentRelation)

    for (const field of ['targetId', 'addedAtOrdinal', 'curationJobId'] as const) {
      const relation: Record<string, unknown> = { ...equivalentRelation.relations[0] }
      delete relation[field]
      expect(BundleRelationsSchema.safeParse({
        ...equivalentRelation,
        relations: [relation],
      }).success).toBe(false)
    }
  })

  it.each([
    'contains',
    'composed-of',
    'precedes',
    'on',
    'locates-via',
    'uses',
    'caused-by',
    'unknown-edge',
  ])('rejects non-persisted relation type %s', (type) => {
    expect(BundleRelationsSchema.safeParse({
      ...equivalentRelation,
      relations: [{ ...equivalentRelation.relations[0], type }],
    }).success).toBe(false)
  })

  it('keeps the committed bundle schema version at 2', () => {
    expect(BUNDLE_SCHEMA_VERSION).toBe(2)
  })
})
