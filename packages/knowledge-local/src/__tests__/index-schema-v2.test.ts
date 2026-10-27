import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { DEFAULT_EMBEDDING_PROFILE } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import type {
  BundleStoreConfig,
  PublishBundleInput,
  PublishBundleOutcome,
} from '../index.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const MISSING_VEC_LOADABLE = 'missing-sqlite-vec-extension'

function columnNames(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name))
}

function replaceWithLegacyV1Shape(db: DatabaseSync, vecTable: string | undefined): void {
  db.exec(`
    DROP TABLE fts_records;
    DROP TABLE graph_edges;
    DROP TABLE records;

    CREATE TABLE records (
      record_rowid INTEGER PRIMARY KEY,
      bundle_id TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL,
      mutable_state_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      subtype TEXT,
      scope_tier TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      status TEXT NOT NULL,
      trust REAL NOT NULL,
      confirmed INTEGER NOT NULL,
      contradicted INTEGER NOT NULL,
      helpful INTEGER NOT NULL,
      harmful INTEGER NOT NULL,
      opened_at_ordinal REAL NOT NULL,
      closed_at_ordinal REAL,
      created_at_ordinal REAL NOT NULL,
      origin_class TEXT NOT NULL,
      summary TEXT NOT NULL,
      embedding_input TEXT NOT NULL,
      embed_status TEXT NOT NULL DEFAULT 'pending',
      embedding BLOB
    );

    CREATE VIRTUAL TABLE fts_records USING fts5(
      identity,
      content,
      tokenize = "unicode61 tokenchars '#-_./:[]=>@'"
    );

    CREATE TABLE graph_edges (
      src_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      dst_node_id TEXT NOT NULL,
      record_rowid INTEGER NOT NULL,
      product TEXT NOT NULL,
      UNIQUE(src_node_id, edge_type, dst_node_id, record_rowid)
    );
  `)

  if (vecTable !== undefined) {
    db.exec(`
      DROP TABLE ${vecTable};
      CREATE VIRTUAL TABLE ${vecTable} USING vec0(
        record_rowid integer primary key,
        product text partition key,
        embedding float[${DEFAULT_EMBEDDING_PROFILE.dim}] distance_metric=cosine
      );
    `)
    const values = new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim)
    values[0] = 1
    db.prepare(
      `INSERT INTO ${vecTable} (record_rowid, product, embedding) VALUES (?, ?, ?)`,
    ).run(999n, 'stale-product', Buffer.from(values.buffer))
  }

  db.prepare("UPDATE meta SET v = '1' WHERE k = 'index_schema_version'").run()
}

describe('disposable index schema reset', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-index-schema-v2-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publishFixture(
    overrides: Partial<PublishBundleInput> = {},
  ): PublishedBundle {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: 'Schema V2 Product',
    }
    const input: PublishBundleInput = {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'schema-v2-run',
        testId: 'schema-v2-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
    const outcome = publishBundle(config, input)
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  it('bootstraps fresh writers with the complete current projection shape', () => {
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(knowledgeLocal.INDEX_SCHEMA_VERSION).toBe(2)
      expect(knowledgeLocal.INDEX_RENDERING_SCHEMA_VERSION).toBe(2)
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
          .get()?.v,
      ).toBe('2')
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'rendering_schema_version'")
          .get()?.v,
      ).toBe('2')
      expect(columnNames(writer.db, 'records')).toEqual(
        expect.arrayContaining([
          'last_confirmed_ordinal',
          'situating_line',
          'contextual_rendering',
        ]),
      )
      expect(columnNames(writer.db, 'fts_records')).toEqual([
        'identity',
        'content',
        'context',
      ])
      expect(columnNames(writer.db, 'graph_edges')).toContain('recency_ordinal')
      expect(() =>
        writer.db
          .prepare('INSERT INTO fts_records VALUES (?, ?, ?)')
          .run('schema identity', 'schema content', 'schema context'),
      ).not.toThrow()

      if (writer.vec === 'vec0') {
        expect(
          columnNames(
            writer.db,
            knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE),
          ),
        ).toEqual([
          'record_rowid',
          'product',
          'scope_tier',
          'scope_key',
          'status',
          'embedding',
        ])
      }
    } finally {
      writer.close()
    }
  })

  it('rejects v1 on the read side and atomically resets it before rebuild', async () => {
    const published = publishFixture()
    const setup = knowledgeLocal.openIndexWriter(knowledgeRoot)
    replaceWithLegacyV1Shape(setup.db, undefined)
    expect(knowledgeLocal.probeIndexHealth(setup.db)).toMatchObject({
      ok: false,
      probe: 'schema-version',
    })
    setup.close()

    const reset = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(
        reset.db
          .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
          .get()?.v,
      ).toBe('2')
      expect(columnNames(reset.db, 'records')).toContain('contextual_rendering')
      expect(columnNames(reset.db, 'records')).toContain('last_confirmed_ordinal')
      expect(columnNames(reset.db, 'fts_records')).toEqual([
        'identity',
        'content',
        'context',
      ])
      expect(columnNames(reset.db, 'graph_edges')).toContain('recency_ordinal')
      expect(reset.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(0)
      expect(() =>
        reset.db
          .prepare('INSERT INTO fts_records VALUES (?, ?, ?)')
          .run('healed identity', 'healed content', 'healed context'),
      ).not.toThrow()
    } finally {
      reset.close()
    }

    const report = await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    expect(report).toMatchObject({ projected: 1, scanIssues: [] })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(knowledgeLocal.probeIndexHealth(reader.db)).toEqual({ ok: true })
      expect(
        reader.db
          .prepare('SELECT bundle_id FROM records WHERE bundle_id = ?')
          .get(published.id),
      ).toEqual({ bundle_id: published.id })
    } finally {
      reader.db.close()
    }
  })

  it('defers legacy vec0 disposal on brute writers and recreates it on vec0 recovery', () => {
    const vecTable = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
    const setup = knowledgeLocal.openIndexWriter(knowledgeRoot)
    if (setup.vec !== 'vec0') {
      setup.close()
      return
    }
    replaceWithLegacyV1Shape(setup.db, vecTable)
    setup.close()

    const brute = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, MISSING_VEC_LOADABLE),
    })
    try {
      expect(brute.vec).toBe('brute')
      expect(
        brute.db
          .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
          .get()?.v,
      ).toBe('2')
      expect(
        brute.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get(),
      ).toBeUndefined()
      expect(columnNames(brute.db, 'fts_records')).toEqual([
        'identity',
        'content',
        'context',
      ])
    } finally {
      brute.close()
    }

    const recovered = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(recovered.vec).toBe('vec0')
      expect(columnNames(recovered.db, vecTable)).toEqual([
        'record_rowid',
        'product',
        'scope_tier',
        'scope_key',
        'status',
        'embedding',
      ])
      expect(
        recovered.db.prepare(`SELECT COUNT(*) AS count FROM ${vecTable}`).get()?.count,
      ).toBe(0)
      expect(
        recovered.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBe('1')
    } finally {
      recovered.close()
    }
  })

  it('projects v2 renderings, FTS context, and ordinal edge recency', async () => {
    const target = publishFixture()
    const sourceCreatedAtOrdinal = 73
    const relationAddedAtOrdinal = 84
    const source = publishFixture({
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Schema v2 source' },
          { t: 'page', route: '/schema-v2-source' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'schema-v2-source' },
        summary: 'Schema v2 projection source',
        body: 'The schema v2 source records deterministic projection fields.',
      }),
      createdAtOrdinal: sourceCreatedAtOrdinal,
      relations: [
        {
          type: 'relates-to',
          targetId: target.id,
          addedAtOrdinal: relationAddedAtOrdinal,
          curationJobId: 'schema-v2-relation-job',
        },
      ],
    })

    expect(await knowledgeLocal.rebuildIndex({ knowledgeRoot })).toMatchObject({
      projected: 2,
      scanIssues: [],
    })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const records = reader.db
        .prepare(`
          SELECT record_rowid, bundle_id, embedding_input,
                 situating_line, contextual_rendering
          FROM records
          ORDER BY bundle_id
        `)
        .all()
      expect(records).toHaveLength(2)
      for (const record of records) {
        expect(String(record.situating_line)).toMatch(
          /^Page: \/(?:login|schema-v2-source)\.$/,
        )
        expect(record.contextual_rendering).toBe(
          `${String(record.embedding_input)}\n${String(record.situating_line)}`,
        )
      }

      const sourceRecord = records.find((record) => record.bundle_id === source.id)
      expect(sourceRecord).toBeDefined()
      const sourceRowid = Number(sourceRecord?.record_rowid)
      const fts = reader.db
        .prepare(`
          SELECT identity, content, context
          FROM fts_records
          WHERE rowid = ?
        `)
        .get(sourceRowid)
      expect(String(fts?.identity)).toContain('Schema v2 source')
      expect(fts?.content).toBe(sourceRecord?.embedding_input)
      expect(fts?.context).toBe(sourceRecord?.situating_line)

      expect(
        reader.db
          .prepare(`
            SELECT recency_ordinal
            FROM graph_edges
            WHERE record_rowid = ? AND edge_type = 'relates-to'
          `)
          .get(sourceRowid)?.recency_ordinal,
      ).toBe(relationAddedAtOrdinal)
      expect(
        reader.db
          .prepare(`
            SELECT recency_ordinal
            FROM graph_edges
            WHERE record_rowid = ? AND edge_type = 'about'
            LIMIT 1
          `)
          .get(sourceRowid)?.recency_ordinal,
      ).toBe(sourceCreatedAtOrdinal)
    } finally {
      reader.db.close()
    }
  })
})
