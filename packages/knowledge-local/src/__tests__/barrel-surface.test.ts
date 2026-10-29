import type { IndexEntry } from '@vostride/agent-qa-schema'
import { describe, expect, expectTypeOf, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import type {
  RetrievalQuery,
  RetrievalQueryInput,
  RetrieveOptions,
  RetrieveResult,
} from '../index.js'

const STAGE_SYMBOLS = [
  'admitCandidate',
  'anchorSeedLeg',
  'applyDiversityCaps',
  'applyValidity',
  'classifyQuery',
  'collapseByOrdinal',
  'denseLeg',
  'expandOneHop',
  'fuseWeightedRrf',
  'lexicalLeg',
  'preFilterPredicate',
  'rerankPrecedence',
] as const

describe('knowledge-local barrel surface', () => {
  it('exposes only the composed retrieval entry and query helper as runtime functions', () => {
    const surface = knowledgeLocal as unknown as Record<string, unknown>

    expect(surface.retrieve).toBeTypeOf('function')
    expect(surface.buildRetrievalQuery).toBeTypeOf('function')
    for (const stage of STAGE_SYMBOLS) expect(surface[stage]).toBeUndefined()
  })

  it('exports the public option, result, input, and built-query types', () => {
    expectTypeOf<RetrieveOptions>().toMatchTypeOf<{
      n: number
      product: string
      testKey?: string
      suiteKey?: string
    }>()
    expectTypeOf<RetrieveResult>().toEqualTypeOf<IndexEntry[]>()
    expectTypeOf<RetrievalQueryInput>().toMatchTypeOf<{
      intent: string
      anchors: readonly unknown[]
    }>()
    expectTypeOf<RetrievalQuery>().toHaveProperty('lexicalQuery')
    expectTypeOf<RetrievalQuery>().toHaveProperty('semanticText')
  })
})
