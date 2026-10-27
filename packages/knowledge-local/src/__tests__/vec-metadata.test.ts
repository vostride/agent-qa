import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  DEFAULT_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import type {
  BundleStoreConfig,
  PublishBundleOutcome,
} from '../index.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

describe('vec0 metadata lifecycle', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-vec-metadata-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Vec Metadata Product',
    }
  }

  function publishFixture(): PublishedBundle {
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        scope: { tier: 'product', key: 'vec-metadata-scope' },
        summary: 'Vec metadata projection fixture',
        body: 'The vec accelerator mirrors serving metadata from its record.',
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'vec-metadata-run',
        testId: 'vec-metadata-test',
        stepIndex: 0,
      },
      artifacts: [],
    })
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  it('stores scope and status metadata beside each embedding', async () => {
    const published = publishFixture()
    const report = await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(report.vec).toBe('vec0')

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const record = reader.db
        .prepare(`
          SELECT record_rowid, product, scope_tier, scope_key, status
          FROM records
          WHERE bundle_id = ?
        `)
        .get(published.id)
      expect(record).toBeDefined()
      const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
      expect(
        reader.db
          .prepare(`
            SELECT product, scope_tier, scope_key, status
            FROM ${tableName}
            WHERE record_rowid = ?
          `)
          .get(BigInt(Number(record?.record_rowid))),
      ).toEqual({
        product: record?.product,
        scope_tier: record?.scope_tier,
        scope_key: record?.scope_key,
        status: record?.status,
      })
    } finally {
      reader.db.close()
    }
  })

  it('physically removes a superseded record before raw filtered KNN', async () => {
    const published = publishFixture()
    const embedder = makeFakeEmbedder()
    expect(await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder })).toMatchObject({
      vec: 'vec0',
      projected: 1,
    })

    const before = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    const record = before.db
      .prepare(`
        SELECT record_rowid, product, embedding_input
        FROM records
        WHERE bundle_id = ?
      `)
      .get(published.id)
    before.db.close()
    expect(record).toBeDefined()

    expect(
      knowledgeLocal.appendOutcomeEvent(
        config(),
        published.id,
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'vec-metadata-superseded',
          curationJobId: 'vec-metadata-superseded-job',
          buildOrdinal: 43,
          byRecordId: 'fact-replacement-0123456789abcdef',
        }),
      ),
    ).toEqual({ kind: 'appended' })
    expect(await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder })).toMatchObject({
      vec: 'vec0',
      projected: 1,
    })

    const query = await embedder.embedQuery(String(record?.embedding_input))
    const queryBytes = Buffer.from(query.buffer, query.byteOffset, query.byteLength)
    const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db
          .prepare(`
            SELECT record_rowid, distance
            FROM ${tableName}
            WHERE embedding MATCH ?
              AND product = ?
              AND k = ?
              AND status != 'deprecated'
              AND status != 'superseded'
            ORDER BY distance
          `)
          .all(queryBytes, String(record?.product), 10),
      ).toEqual([])
      expect(
        reader.db
          .prepare(`SELECT status FROM ${tableName} WHERE record_rowid = ?`)
          .get(BigInt(Number(record?.record_rowid))),
      ).toBeUndefined()
      expect(
        reader.db
          .prepare(`
            SELECT status, embed_status, embedding
            FROM records
            WHERE record_rowid = ?
          `)
          .get(Number(record?.record_rowid)),
      ).toEqual({ status: 'superseded', embed_status: 'scrubbed', embedding: null })
    } finally {
      reader.db.close()
    }
  })

  it('repairs metadata drift even when the bundle hash is unchanged', async () => {
    const published = publishFixture()
    expect(
      await knowledgeLocal.rebuildIndex({
        knowledgeRoot,
        embedder: makeFakeEmbedder(),
      }),
    ).toMatchObject({ vec: 'vec0', projected: 1 })

    const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    const record = writer.db
      .prepare(`
        SELECT record_rowid, product, scope_tier, scope_key, status
        FROM records
        WHERE bundle_id = ?
      `)
      .get(published.id)
    expect(record).toBeDefined()
    writer.db
      .prepare(`
        UPDATE ${tableName}
        SET scope_tier = 'global', scope_key = 'tampered', status = 'superseded'
        WHERE record_rowid = ?
      `)
      .run(BigInt(Number(record?.record_rowid)))
    writer.close()

    expect(await knowledgeLocal.rebuildIndex({ knowledgeRoot })).toMatchObject({
      vec: 'vec0',
      projected: 0,
    })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db
          .prepare(`
            SELECT product, scope_tier, scope_key, status
            FROM ${tableName}
            WHERE record_rowid = ?
          `)
          .get(BigInt(Number(record?.record_rowid))),
      ).toEqual({
        product: record?.product,
        scope_tier: record?.scope_tier,
        scope_key: record?.scope_key,
        status: record?.status,
      })
    } finally {
      reader.db.close()
    }
  })
})
