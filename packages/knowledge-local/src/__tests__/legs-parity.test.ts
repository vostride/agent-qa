import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  canonicalJson,
  DEFAULT_EMBEDDING_PROFILE,
  normalizeAnchor,
  RETRIEVAL_TRACE_LEGS,
  type Anchor,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureEmbedCacheTable, putCachedEmbedding } from '../embed-cache.js'
import type { EmbedderPort } from '../embedder-port.js'
import { openIndexWriter, vecTableName, type IndexWriterHandle } from '../index-open.js'
import { buildRetrievalQuery } from '../query-helper.js'
import {
  anchorSeedLeg,
  denseLeg,
  lexicalLeg,
  type RetrievalLegScope,
} from '../retrieval/legs.js'
import { scaffoldKnowledgeRoot } from './fixtures/bundle-fixture.js'

const QUERY_SCOPE = {
  product: 'storefront',
  testKey: 'test:checkout',
  suiteKey: 'suite:smoke',
  productKey: 'product:storefront',
  globalKey: 'scope:global',
} as const satisfies RetrievalLegScope

type ScopeTier = 'global' | 'product' | 'suite' | 'test'
type RecordStatus = 'active' | 'candidate' | 'deprecated' | 'superseded'

interface RecordInput {
  bundleId: string
  product?: string
  scopeTier?: ScopeTier
  scopeKey?: string
  status?: RecordStatus
  vector?: Float32Array
}

describe('fail-closed retrieval legs', () => {
  let root: string
  let knowledgeRoot: string
  let writer: IndexWriterHandle
  let db: DatabaseSync

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-retrieval-legs-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
    writer = openIndexWriter(knowledgeRoot)
    db = writer.db
  })

  afterEach(() => {
    writer.close()
    rmSync(root, { recursive: true, force: true })
  })

  function insertRecord(input: RecordInput): number {
    const product = input.product ?? QUERY_SCOPE.product
    const scopeTier = input.scopeTier ?? 'test'
    const scopeKey = input.scopeKey ?? QUERY_SCOPE.testKey
    const status = input.status ?? 'active'
    const bytes = input.vector === undefined
      ? null
      : Buffer.from(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength)
    const result = db.prepare(`
      INSERT INTO records (
        bundle_id, product, mutable_state_hash, kind, subtype,
        scope_tier, scope_key, status, trust,
        confirmed, contradicted, helpful, harmful,
        opened_at_ordinal, closed_at_ordinal, created_at_ordinal,
        origin_class, summary, embedding_input,
        situating_line, contextual_rendering, embed_status, embedding
      ) VALUES (
        ?, ?, ?, 'fact', NULL,
        ?, ?, ?, 0.75,
        1, 0, 0, 0,
        1, NULL, 1,
        'agent-verified', ?, ?,
        '', ?, ?, ?
      )
    `).run(
      input.bundleId,
      product,
      `hash-${input.bundleId}`,
      scopeTier,
      scopeKey,
      status,
      input.bundleId,
      input.bundleId,
      input.bundleId,
      input.vector === undefined ? 'pending' : 'present',
      bytes,
    )
    const recordRowid = Number(result.lastInsertRowid)

    if (input.vector !== undefined && writer.vec === 'vec0') {
      db.prepare(`
        INSERT INTO ${vecTableName(DEFAULT_EMBEDDING_PROFILE)} (
          record_rowid, product, scope_tier, scope_key, status, embedding
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(BigInt(recordRowid), product, scopeTier, scopeKey, status, bytes)
    }
    return recordRowid
  }

  function insertFts(
    recordRowid: number,
    input: { identity?: string; content?: string; context?: string },
  ): void {
    db.prepare(`
      INSERT INTO fts_records (rowid, identity, content, context)
      VALUES (?, ?, ?, ?)
    `).run(recordRowid, input.identity ?? '', input.content ?? '', input.context ?? '')
  }

  function insertAnchor(recordRowid: number, anchor: Anchor): void {
    db.prepare(`
      INSERT INTO anchors (record_rowid, product, t, raw_json, normalized_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      recordRowid,
      QUERY_SCOPE.product,
      anchor.t,
      canonicalJson(anchor),
      canonicalJson(normalizeAnchor(anchor)),
    )
  }

  function unitVector(cosineToQuery: number): Float32Array {
    const vector = new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim)
    vector[0] = cosineToQuery
    vector[1] = Math.sqrt(1 - cosineToQuery * cosineToQuery)
    return vector
  }

  it('scores weighted BM25 on the positive scale and pre-filters withdrawn and sibling rows', () => {
    const identity = insertRecord({ bundleId: 'identity-match' })
    const context = insertRecord({ bundleId: 'context-match' })
    const sibling = insertRecord({
      bundleId: 'sibling-match',
      product: 'payments',
      scopeTier: 'product',
      scopeKey: QUERY_SCOPE.productKey,
    })
    const superseded = insertRecord({
      bundleId: 'superseded-match',
      status: 'superseded',
    })
    insertFts(identity, { identity: 'checkout' })
    insertFts(context, { context: 'checkout' })
    insertFts(sibling, { identity: 'checkout' })
    insertFts(superseded, { identity: 'checkout' })

    const candidates = lexicalLeg(db, 'checkout', QUERY_SCOPE, 10)

    expect(candidates.map(({ bundleId }) => bundleId)).toEqual([
      'identity-match',
      'context-match',
    ])
    expect(candidates.every(({ rawScores }) => (rawScores.bm25Positive ?? 0) > 0)).toBe(true)
    expect(candidates[0]!.rawScores.bm25Positive).toBeGreaterThan(
      candidates[1]!.rawScores.bm25Positive!,
    )
    expect(
      lexicalLeg(db, 'checkout OR sibling', QUERY_SCOPE, 10).map(
        ({ bundleId }) => bundleId,
      ),
    ).toEqual(['identity-match', 'context-match'])
  })

  it('passes realistic multi-token query-helper output unchanged into lexical recall', () => {
    const gold = insertRecord({ bundleId: 'checkout-button-gold' })
    const unrelated = insertRecord({ bundleId: 'shipping-address-unrelated' })
    const sibling = insertRecord({
      bundleId: 'checkout-button-sibling',
      product: 'payments',
      scopeTier: 'product',
      scopeKey: QUERY_SCOPE.productKey,
    })
    const withdrawn = insertRecord({
      bundleId: 'checkout-button-withdrawn',
      status: 'superseded',
    })
    insertFts(gold, { identity: 'checkout button' })
    insertFts(unrelated, { identity: 'shipping address' })
    insertFts(sibling, { identity: 'checkout button' })
    insertFts(withdrawn, { identity: 'checkout button' })

    const query = buildRetrievalQuery({
      intent: 'Complete checkout securely',
      anchors: [
        { t: 'el', role: 'Button', name: 'Checkout now' },
        { t: 'selector', literal: '#checkout-submit' },
        { t: 'platform', platform: 'web' },
      ],
    })
    expect(new Set(query.lexicalQuery.split(/\s+/)).size).toBeGreaterThan(4)

    const first = lexicalLeg(db, query.lexicalQuery, QUERY_SCOPE, 10)
    const second = lexicalLeg(db, query.lexicalQuery, QUERY_SCOPE, 10)

    expect(first.map(({ bundleId }) => bundleId)).toEqual(['checkout-button-gold'])
    expect(first[0]?.rawScores.bm25Positive).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('keeps operator, quote, parenthesis, wildcard, and selector-shaped helper text inert', () => {
    const literalRows = [
      ['literal-or', 'OR'],
      ['literal-and', 'AND'],
      ['literal-not', 'NOT'],
      ['literal-near', 'NEAR'],
      ['literal-paren', 'paren'],
      ['literal-anchor', 'anchor'],
      ['literal-quote', 'quote'],
      ['literal-checkout', 'checkout'],
    ] as const
    for (const [bundleId, token] of literalRows) {
      const recordRowid = insertRecord({ bundleId })
      insertFts(recordRowid, { identity: token })
    }
    const wildcardPrefixOnly = insertRecord({ bundleId: 'wildcard-prefix-only' })
    const unrelated = insertRecord({ bundleId: 'operator-unrelated' })
    insertFts(wildcardPrefixOnly, { identity: 'checkoutish' })
    insertFts(unrelated, { identity: 'shipping' })

    const query = buildRetrievalQuery({
      intent: 'OR AND NOT NEAR (paren) checkout*',
      anchors: [
        { t: 'flow', name: 'Anchor "quote"' },
        { t: 'selector', literal: '[data-testid="checkout*"]' },
      ],
    })
    expect(query.lexicalQuery).toContain('Anchor "quote"')
    expect(query.lexicalQuery).toContain('[data-testid="checkout*"]')

    const first = lexicalLeg(db, query.lexicalQuery, QUERY_SCOPE, 20)
    const second = lexicalLeg(db, query.lexicalQuery, QUERY_SCOPE, 20)

    expect(new Set(first.map(({ bundleId }) => bundleId))).toEqual(
      new Set(literalRows.map(([bundleId]) => bundleId)),
    )
    expect(first.map(({ bundleId }) => bundleId)).not.toContain('wildcard-prefix-only')
    expect(first.map(({ bundleId }) => bundleId)).not.toContain('operator-unrelated')
    expect(second).toEqual(first)
  })

  it('merges product and partition-unconstrained global vec0 results with brute parity', async () => {
    expect(writer.vec).toBe('vec0')
    insertRecord({ bundleId: 'product-near', vector: unitVector(0.99) })
    insertRecord({
      bundleId: 'global-middle',
      product: 'shared-partition',
      scopeTier: 'global',
      scopeKey: QUERY_SCOPE.globalKey,
      vector: unitVector(0.9),
    })
    insertRecord({ bundleId: 'product-far', vector: unitVector(0.8) })
    insertRecord({
      bundleId: 'sibling-nearest',
      product: 'payments',
      scopeTier: 'product',
      scopeKey: QUERY_SCOPE.productKey,
      vector: unitVector(1),
    })
    insertRecord({
      bundleId: 'withdrawn-nearest',
      status: 'superseded',
      vector: unitVector(1),
    })

    const semanticText = 'checkout dense query'
    const queryVector = unitVector(1)
    ensureEmbedCacheTable(db)
    putCachedEmbedding({
      db,
      profile: DEFAULT_EMBEDDING_PROFILE,
      leg: 'query',
      rendering: semanticText,
      vector: queryVector,
    })
    const cacheOnlyEmbedder: EmbedderPort = {
      async embedDocument(): Promise<Float32Array> {
        throw new Error('dense reader must not embed a document')
      },
      async embedQuery(): Promise<Float32Array> {
        throw new Error('query should resolve from the check-only cache')
      },
    }

    const vecCandidates = await denseLeg(
      { db, vec: 'vec0' },
      semanticText,
      QUERY_SCOPE,
      3,
      { embedder: cacheOnlyEmbedder },
    )
    const bruteCandidates = await denseLeg(
      { db, vec: 'brute' },
      semanticText,
      QUERY_SCOPE,
      3,
      { embedder: cacheOnlyEmbedder },
    )

    const expectedIds = ['product-near', 'global-middle', 'product-far']
    expect(vecCandidates.map(({ bundleId }) => bundleId)).toEqual(expectedIds)
    expect(bruteCandidates.map(({ bundleId }) => bundleId)).toEqual(expectedIds)
    expect(vecCandidates[1]).toMatchObject({
      bundleId: 'global-middle',
      product: 'shared-partition',
    })
    expect(vecCandidates.every(({ rawScores }) => rawScores.cosine !== undefined)).toBe(true)
  })

  it('seeds only exact normalized-json anchors and never widens indexed identity', () => {
    const exact = insertRecord({ bundleId: 'exact-anchor' })
    const ordinalOnly = insertRecord({ bundleId: 'ordinal-anchor' })
    insertAnchor(exact, { t: 'el', role: 'button', name: 'Checkout (3)' })
    insertAnchor(ordinalOnly, {
      t: 'el',
      role: 'button',
      name: 'Checkout (7)',
      ordinal: 2,
    })

    const candidates = anchorSeedLeg(
      db,
      [{ t: 'el', role: ' BUTTON ', name: ' checkout (9) ' }],
      QUERY_SCOPE,
    )

    expect(candidates.map(({ bundleId }) => bundleId)).toEqual(['exact-anchor'])
    expect(candidates[0]).toMatchObject({
      rawScores: { anchorExact: true },
    })
  })

  // `schema` cannot import the private `CandidateLeg`, so only this package can compare the two.
  it('emits exactly the leg names the trace vocabulary declares', async () => {
    const rowid = insertRecord({ bundleId: 'tri-leg', vector: unitVector(1) })
    insertFts(rowid, { identity: 'checkout' })
    insertAnchor(rowid, { t: 'el', role: 'button', name: 'Checkout (3)' })

    const semanticText = 'checkout dense query'
    ensureEmbedCacheTable(db)
    putCachedEmbedding({
      db,
      profile: DEFAULT_EMBEDDING_PROFILE,
      leg: 'query',
      rendering: semanticText,
      vector: unitVector(1),
    })
    const cacheOnlyEmbedder: EmbedderPort = {
      async embedDocument(): Promise<Float32Array> {
        throw new Error('leg vocabulary probe must not embed a document')
      },
      async embedQuery(): Promise<Float32Array> {
        throw new Error('query should resolve from the check-only cache')
      },
    }

    const lexical = lexicalLeg(db, 'checkout', QUERY_SCOPE, 10)
    const anchor = anchorSeedLeg(
      db,
      [{ t: 'el', role: 'button', name: 'Checkout (3)' }],
      QUERY_SCOPE,
    )
    const dense = await denseLeg(
      { db, vec: 'brute' },
      semanticText,
      QUERY_SCOPE,
      10,
      { embedder: cacheOnlyEmbedder },
    )

    // Every leg must actually have answered, or the observed vocabulary would agree by being
    // smaller rather than by being right.
    expect(lexical.length).toBeGreaterThan(0)
    expect(anchor.length).toBeGreaterThan(0)
    expect(dense.length).toBeGreaterThan(0)

    const observed = new Set(
      [...lexical, ...anchor, ...dense].flatMap(({ legRanks }) => Object.keys(legRanks)),
    )
    expect([...observed].sort()).toEqual([...RETRIEVAL_TRACE_LEGS].sort())
  })
})
