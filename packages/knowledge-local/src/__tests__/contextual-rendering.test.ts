import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { canonicalJson, graphNodeId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildSituatingLine,
  computeRenderingDrift,
  renderContextual,
} from '../contextual-rendering.js'
import { appendRelation } from '../bundle-append.js'
import type { EmbedderPort } from '../embedder-port.js'
import {
  INDEX_RENDERING_SCHEMA_VERSION,
  openIndexReaderConnection,
  openIndexWriter,
} from '../index-open.js'
import { rebuildIndex } from '../index-rebuild.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../bundle-publish.test-helper.js'
import { SITUATING_LINE_MAX_CHARS } from '../retrieval/constants.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type RecordKind = 'fact' | 'procedure' | 'caution'

describe('deterministic contextual rendering', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE records (
        record_rowid INTEGER PRIMARY KEY,
        bundle_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        trust REAL NOT NULL
      );
      CREATE TABLE graph_nodes (
        node_id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL,
        natural_key_json TEXT NOT NULL,
        product TEXT NOT NULL
      );
      CREATE TABLE graph_edges (
        src_node_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        dst_node_id TEXT NOT NULL,
        record_rowid INTEGER NOT NULL,
        product TEXT NOT NULL,
        recency_ordinal INTEGER NOT NULL
      );
    `)
  })

  afterEach(() => {
    db.close()
  })

  function insertRecord(
    recordRowid: number,
    bundleId: string,
    kind: RecordKind,
    summary: string,
    trust: number,
  ): string {
    db.prepare(`
      INSERT INTO records (record_rowid, bundle_id, kind, summary, trust)
      VALUES (?, ?, ?, ?, ?)
    `).run(recordRowid, bundleId, kind, summary, trust)
    return insertNode(kind, bundleId)
  }

  function insertNode(type: string, naturalKey: unknown): string {
    const nodeId = graphNodeId(type as never, naturalKey as never)
    db.prepare(`
      INSERT INTO graph_nodes (node_id, node_type, natural_key_json, product)
      VALUES (?, ?, ?, ?)
    `).run(nodeId, type, canonicalJson(naturalKey as never), 'checkout')
    return nodeId
  }

  function insertEdge(input: {
    source: string
    type: string
    target: string
    recordRowid: number
    recency: number
  }): void {
    db.prepare(`
      INSERT INTO graph_edges (
        src_node_id, edge_type, dst_node_id, record_rowid, product, recency_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.source,
      input.type,
      input.target,
      input.recordRowid,
      'checkout',
      input.recency,
    )
  }

  it('renders owning page and flow, one lineage neighbor, and one attached caution', () => {
    const current = insertRecord(1, 'current-fact', 'fact', 'Current checkout fact', 0.7)
    const previous = insertRecord(2, 'previous-fact', 'fact', 'Previous checkout selector', 0.9)
    const caution = insertRecord(
      3,
      'checkout-caution',
      'caution',
      'Confirm the cart total first',
      0.8,
    )
    const element = insertNode('web-element', { role: 'button', name: 'Continue' })
    const page = insertNode('web-page', '/checkout')
    const flow = insertNode('flow', 'checkout')

    insertEdge({ source: current, type: 'about', target: element, recordRowid: 1, recency: 10 })
    insertEdge({ source: element, type: 'part-of', target: page, recordRowid: 1, recency: 11 })
    insertEdge({ source: element, type: 'part-of', target: flow, recordRowid: 1, recency: 12 })
    insertEdge({ source: current, type: 'supersedes', target: previous, recordRowid: 1, recency: 13 })
    insertEdge({ source: current, type: 'relates-to', target: caution, recordRowid: 1, recency: 14 })

    const line = buildSituatingLine(db, 1)

    expect(line).toContain('Page: /checkout.')
    expect(line).toContain('Flow: checkout.')
    expect(line).toContain('Supersession: Previous checkout selector.')
    expect(line).toContain('Caution: Confirm the cart total first.')
    expect(line.length).toBeLessThanOrEqual(SITUATING_LINE_MAX_CHARS)
  })

  it('orders candidates by trust, recency ordinal, and node id before whole-clause truncation', () => {
    const current = insertRecord(1, 'current-fact', 'fact', 'Current checkout fact', 0.5)
    const element = insertNode('web-element', { role: 'button', name: 'Continue' })
    insertEdge({ source: current, type: 'about', target: element, recordRowid: 1, recency: 1 })

    const high = `high-${'a'.repeat(88)}`
    const newer = `newer-${'b'.repeat(88)}`
    const lower = `lower-${'c'.repeat(88)}`
    const highPage = insertNode('web-page', high)
    const newerPage = insertNode('web-page', newer)
    const lowerPage = insertNode('web-page', lower)
    insertRecord(2, 'high-support', 'fact', 'high support', 0.9)
    insertRecord(3, 'newer-support', 'fact', 'newer support', 0.8)
    insertRecord(4, 'lower-support', 'fact', 'lower support', 0.8)
    insertEdge({ source: element, type: 'part-of', target: highPage, recordRowid: 2, recency: 5 })
    insertEdge({ source: element, type: 'part-of', target: newerPage, recordRowid: 3, recency: 9 })
    insertEdge({ source: element, type: 'part-of', target: lowerPage, recordRowid: 4, recency: 3 })

    const first = buildSituatingLine(db, 1)
    const second = buildSituatingLine(db, 1)

    expect(first).toBe(second)
    expect(first).toBe(`Page: ${high}. Page: ${newer}.`)
    expect(first).not.toContain(lower)
    expect(first.length).toBeLessThanOrEqual(SITUATING_LINE_MAX_CHARS)
  })

  it('keeps self fields byte-identical when no qualifying neighbor exists', () => {
    insertRecord(1, 'isolated-fact', 'fact', 'Isolated fact', 0.5)

    expect(buildSituatingLine(db, 1)).toBe('')
    expect(renderContextual('self fields', '')).toBe('self fields')
  })

  it('assembles two parts without whitespace drift and compares stored bytes strictly', () => {
    expect(renderContextual('self fields', 'Page: /checkout.')).toBe(
      'self fields\nPage: /checkout.',
    )
    expect(computeRenderingDrift('same bytes', 'same bytes')).toBe(false)
    expect(computeRenderingDrift('same bytes\n', 'same bytes')).toBe(true)
  })
})

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

describe('contextual rendering rebuild integration', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-contextual-rendering-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Contextual Rendering Product',
    }
  }

  function publish(
    overrides: Partial<PublishBundleInput> = {},
  ): PublishedBundle {
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'contextual-rendering-run',
        testId: 'contextual-rendering-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    })
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function manifestHash(bundle: PublishedBundle): string {
    const parsed = JSON.parse(
      readFileSync(join(bundle.dir, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    return String(parsed.mutableStateHash)
  }

  function projection(bundleId: string): Record<string, unknown> {
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      const row = reader.db.prepare(`
        SELECT
          records.record_rowid,
          records.embedding_input,
          records.situating_line,
          records.contextual_rendering,
          records.embed_status,
          records.embedding,
          hex(records.embedding) AS embedding_hex,
          fts_records.context AS fts_context
        FROM records
        JOIN fts_records ON fts_records.rowid = records.record_rowid
        WHERE records.bundle_id = ?
      `).get(bundleId)
      expect(row).toBeDefined()
      return row as Record<string, unknown>
    } finally {
      reader.db.close()
    }
  }

  it('renders after graph convergence and embeds the exact contextual bytes', async () => {
    const fact = publish({
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Checkout now' },
          { t: 'page', route: '/checkout' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'contextual-rendering-product' },
        summary: 'Checkout control on the checkout page',
        body: 'Selecting Checkout now opens payment.',
      }),
    })
    const base = makeFakeEmbedder()
    const documentCalls: string[] = []
    const embedder: EmbedderPort = {
      async embedDocument(rendering) {
        documentCalls.push(rendering)
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }

    const report = await rebuildIndex({ knowledgeRoot, embedder })
    const row = projection(fact.id)

    expect(report).toMatchObject({ projected: 1, backfilled: 0 })
    expect(row.situating_line).toContain('Page: /checkout.')
    expect(row.contextual_rendering).toBe(
      `${String(row.embedding_input)}\n${String(row.situating_line)}`,
    )
    expect(row.fts_context).toBe(row.situating_line)
    expect(documentCalls).toEqual([row.contextual_rendering])
  })

  it('avoids no-drift thrash and invalidates only a record affected by neighbor relations', async () => {
    const fact = publish({
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Pay now' },
          { t: 'page', route: '/payment' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'payment-fact' },
        summary: 'Pay now submits the order',
        body: 'Selecting Pay now submits the current order.',
      }),
    })
    const caution = publish({
      draft: makeBundleDraftFixture({
        kind: 'caution',
        anchors: [
          { t: 'el', role: 'Button', name: 'Pay now' },
          { t: 'page', route: '/payment' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'payment-caution' },
        summary: 'Confirm the cart total before payment',
        body: 'Submitting an outdated cart can charge the wrong total.',
      }),
      discriminant: makeDiscriminantFixture('caution'),
      createdAtOrdinal: 43,
    })
    const factManifestHash = manifestHash(fact)

    await rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })
    const first = projection(fact.id)
    const noDriftCalls: string[] = []
    const base = makeFakeEmbedder()
    const noDriftEmbedder: EmbedderPort = {
      async embedDocument(rendering) {
        noDriftCalls.push(rendering)
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }

    const unchanged = await rebuildIndex({
      knowledgeRoot,
      embedder: noDriftEmbedder,
    })
    expect(unchanged).toMatchObject({ projected: 0, backfilled: 0 })
    expect(noDriftCalls).toEqual([])
    expect(projection(fact.id)).toEqual(first)

    expect(
      appendRelation(config(), caution.id, {
        type: 'relates-to',
        targetId: fact.id,
        addedAtOrdinal: 44,
        curationJobId: 'contextual-rendering-relation-job',
      }),
    ).toEqual({ kind: 'appended' })
    expect(manifestHash(fact)).toBe(factManifestHash)

    const invalidated = await rebuildIndex({ knowledgeRoot })
    expect(invalidated).toMatchObject({ projected: 1, backfilled: 0 })
    const pending = projection(fact.id)
    expect(pending.situating_line).toContain(
      'Caution: Confirm the cart total before payment.',
    )
    expect(pending.contextual_rendering).toBe(
      `${String(pending.embedding_input)}\n${String(pending.situating_line)}`,
    )
    expect(pending.fts_context).toBe(pending.situating_line)
    expect(pending.embed_status).toBe('pending')
    expect(pending.embedding).toBeNull()

    const changedCalls: string[] = []
    const changedEmbedder: EmbedderPort = {
      async embedDocument(rendering) {
        changedCalls.push(rendering)
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }
    const backfilled = await rebuildIndex({
      knowledgeRoot,
      embedder: changedEmbedder,
    })
    expect(backfilled).toMatchObject({ projected: 0, backfilled: 1 })
    expect(changedCalls).toEqual([pending.contextual_rendering])
    expect(projection(fact.id).embed_status).toBe('present')
    expect(manifestHash(fact)).toBe(factManifestHash)
  })

  it('forces a stale rendering epoch exactly once and stamps it only after rebuild', async () => {
    publish({
      draft: makeBundleDraftFixture({
        scope: { tier: 'product', key: 'rendering-epoch-fact' },
        summary: 'Rendering epoch fact',
        body: 'The rendering epoch fact remains content-stable.',
      }),
    })
    publish({
      draft: makeBundleDraftFixture({
        kind: 'caution',
        scope: { tier: 'product', key: 'rendering-epoch-caution' },
        summary: 'Rendering epoch caution',
        body: 'The rendering epoch caution remains content-stable.',
      }),
      discriminant: makeDiscriminantFixture('caution'),
      createdAtOrdinal: 43,
    })
    await rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })

    const beforeReader = openIndexReaderConnection(knowledgeRoot)
    const before = beforeReader.db.prepare(`
      SELECT bundle_id, contextual_rendering, embed_status, hex(embedding) AS embedding_hex
      FROM records
      ORDER BY bundle_id
    `).all()
    beforeReader.db.close()
    expect(before).toHaveLength(2)
    expect(before.every((row) => row.embed_status === 'present')).toBe(true)

    const stamper = openIndexWriter(knowledgeRoot)
    stamper.db
      .prepare("UPDATE meta SET v = '1' WHERE k = 'rendering_schema_version'")
      .run()
    stamper.close()

    const stale = openIndexWriter(knowledgeRoot) as ReturnType<typeof openIndexWriter> & {
      renderingEpochStale?: boolean
    }
    try {
      expect(
        stale.db
          .prepare("SELECT v FROM meta WHERE k = 'rendering_schema_version'")
          .get()?.v,
      ).toBe('1')
      expect(stale.renderingEpochStale).toBe(true)
      expect(
        stale.db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM records
            WHERE embed_status = 'pending' AND embedding IS NULL
          `)
          .get()?.count,
      ).toBe(2)
    } finally {
      stale.close()
    }

    const base = makeFakeEmbedder()
    const staleCalls: string[] = []
    const staleEmbedder: EmbedderPort = {
      async embedDocument(rendering) {
        staleCalls.push(rendering)
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }
    const forced = await rebuildIndex({ knowledgeRoot, embedder: staleEmbedder })
    expect(forced).toMatchObject({ projected: 0, backfilled: 2 })

    const healedReader = openIndexReaderConnection(knowledgeRoot)
    const healed = healedReader.db.prepare(`
      SELECT bundle_id, contextual_rendering, embed_status, hex(embedding) AS embedding_hex
      FROM records
      ORDER BY bundle_id
    `).all()
    expect(
      healedReader.db
        .prepare("SELECT v FROM meta WHERE k = 'rendering_schema_version'")
        .get()?.v,
    ).toBe(String(INDEX_RENDERING_SCHEMA_VERSION))
    healedReader.db.close()
    expect(staleCalls.sort()).toEqual(
      healed.map((row) => String(row.contextual_rendering)).sort(),
    )
    expect(healed).toEqual(before)

    const matching = openIndexWriter(knowledgeRoot) as ReturnType<typeof openIndexWriter> & {
      renderingEpochStale?: boolean
    }
    expect(matching.renderingEpochStale).toBe(false)
    matching.close()

    const happyCalls: string[] = []
    const happyEmbedder: EmbedderPort = {
      async embedDocument(rendering) {
        happyCalls.push(rendering)
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }
    expect(await rebuildIndex({ knowledgeRoot, embedder: happyEmbedder })).toMatchObject({
      projected: 0,
      backfilled: 0,
    })
    expect(happyCalls).toEqual([])
    const afterReader = openIndexReaderConnection(knowledgeRoot)
    expect(afterReader.db.prepare(`
      SELECT bundle_id, contextual_rendering, embed_status, hex(embedding) AS embedding_hex
      FROM records
      ORDER BY bundle_id
    `).all()).toEqual(healed)
    afterReader.db.close()
  })
})
