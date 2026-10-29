import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type { EmbeddingProfile } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import type {
  BundleStoreConfig,
  EmbedderPort,
  PublishBundleInput,
  PublishBundleOutcome,
  VecCapability,
} from '../index.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

type MigrationOutcome =
  | { flipped: true; profileKey: string }
  | { flipped: false; missing: string[] }

interface MigrationApi {
  setActiveEmbeddingProfile(options: {
    db: DatabaseSync
    vec: VecCapability
    target: {
      profile: EmbeddingProfile
      embedder: EmbedderPort
    }
  }): Promise<MigrationOutcome>
}

function migrationApi(): MigrationApi {
  const candidate = knowledgeLocal as unknown as Partial<MigrationApi>
  if (typeof candidate.setActiveEmbeddingProfile !== 'function') {
    throw new Error('setActiveEmbeddingProfile public API is not implemented')
  }
  return candidate as MigrationApi
}

function embeddingRows(db: DatabaseSync): Map<string, Buffer> {
  return new Map(
    db
      .prepare('SELECT bundle_id, embedding FROM records ORDER BY bundle_id')
      .all()
      .map((row) => {
        if (!(row.embedding instanceof Uint8Array)) {
          throw new TypeError(`record ${String(row.bundle_id)} has no embedding`)
        }
        return [String(row.bundle_id), Buffer.from(row.embedding)] as const
      }),
  )
}

function vecRowids(
  db: DatabaseSync,
  vec: VecCapability,
  profile: EmbeddingProfile,
): string[] | undefined {
  if (vec !== 'vec0') return undefined
  return db
    .prepare(`SELECT record_rowid FROM ${knowledgeLocal.vecTableName(profile)}`)
    .all()
    .map((row) => String(row.record_rowid))
    .sort()
}

describe('active embedding profile migration', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-profile-migration-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function input(label: string): PublishBundleInput {
    const key = slugBranch(label)
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: label },
          { t: 'page', route: `/${key}` },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key },
        summary: `${label} control`,
        body: `Selecting ${label} performs the recorded action.`,
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'profile-migration-run',
        testId: `profile-migration-${key}`,
        stepIndex: 0,
      },
      artifacts: [],
    }
  }

  function publishNamed(label: string): PublishedBundle {
    const outcome = publishBundle(config('Migration Product'), input(label))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  async function projectDefault(): Promise<void> {
    await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
    })
  }

  it('atomically flips three bundles to the floor and evicts the outgoing model cache', async () => {
    const published = [publishNamed('Alpha'), publishNamed('Bravo'), publishNamed('Charlie')]
    await projectDefault()

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      knowledgeLocal.ensureEmbedCacheTable(writer.db)
      knowledgeLocal.putCachedEmbedding({
        db: writer.db,
        profile: DEFAULT_EMBEDDING_PROFILE,
        leg: 'doc',
        rendering: 'outgoing cache sentinel',
        vector: await makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim).embedDocument(
          'outgoing cache sentinel',
        ),
      })

      const targetKey = knowledgeLocal.embeddingProfileKey(
        STATIC_FLOOR_EMBEDDING_PROFILE,
      )
      const outcome = await migrationApi().setActiveEmbeddingProfile({
        db: writer.db,
        vec: writer.vec,
        target: {
          profile: STATIC_FLOOR_EMBEDDING_PROFILE,
          embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
        },
      })

      expect(outcome).toEqual({ flipped: true, profileKey: targetKey })
      expect(knowledgeLocal.resolveActiveProfile(writer.db)).toBe(
        STATIC_FLOOR_EMBEDDING_PROFILE,
      )
      const records = writer.db
        .prepare('SELECT bundle_id, embed_status, embedding FROM records ORDER BY bundle_id')
        .all()
      expect(records.map((row) => String(row.bundle_id))).toEqual(
        published.map(({ id }) => id).sort(),
      )
      expect(records).toHaveLength(3)
      for (const row of records) {
        expect(row.embed_status).toBe('present')
        expect(row.embedding).toBeInstanceOf(Uint8Array)
        expect((row.embedding as Uint8Array).byteLength).toBe(
          STATIC_FLOOR_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
        )
      }
      expect(
        writer.db
          .prepare('SELECT model_id FROM embed_cache WHERE model_id = ?')
          .all(DEFAULT_EMBEDDING_PROFILE.model_id),
      ).toHaveLength(0)
      expect(
        writer.db
          .prepare('SELECT model_id FROM embed_cache WHERE model_id = ?')
          .all(STATIC_FLOOR_EMBEDDING_PROFILE.model_id),
      ).toHaveLength(3)

      if (writer.vec === 'vec0') {
        expect(
          writer.db
            .prepare(
              `SELECT record_rowid FROM ${knowledgeLocal.vecTableName(
                STATIC_FLOOR_EMBEDDING_PROFILE,
              )}`,
            )
            .all(),
        ).toHaveLength(3)
      }
    } finally {
      writer.close()
    }
  })

  it('refuses a row-count-equal staging set when frozen member C is missing', async () => {
    const a = publishNamed('Alpha')
    const b = publishNamed('Bravo')
    const c = publishNamed('Charlie')
    await projectDefault()

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      knowledgeLocal.ensureEmbedCacheTable(writer.db)
      knowledgeLocal.putCachedEmbedding({
        db: writer.db,
        profile: DEFAULT_EMBEDDING_PROFILE,
        leg: 'doc',
        rendering: 'refusal cache sentinel',
        vector: await makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim).embedDocument(
          'refusal cache sentinel',
        ),
      })
      const beforeEmbeddings = embeddingRows(writer.db)
      const cRendering = String(
        writer.db
          .prepare('SELECT embedding_input FROM records WHERE bundle_id = ?')
          .get(c.id)?.embedding_input,
      )
      const floorBase = makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim)
      const targetKey = knowledgeLocal.embeddingProfileKey(
        STATIC_FLOOR_EMBEDDING_PROFILE,
      )
      let injected = false
      let expectedAfterInjectionEmbeddings: Map<string, Buffer> | undefined
      let expectedAfterInjectionVecRowids: string[] | undefined

      const targetEmbedder: EmbedderPort = {
        async embedDocument(rendering: string): Promise<Float32Array> {
          if (rendering === cRendering) throw new Error('fixture refuses frozen member C')
          const vector = await floorBase.embedDocument(rendering)
          if (!injected && rendering !== cRendering) {
            injected = true
            const d = publishNamed('Delta')
            await projectDefault()
            const dRow = writer.db
              .prepare(
                'SELECT record_rowid, embedding_input FROM records WHERE bundle_id = ?',
              )
              .get(d.id)
            if (dRow === undefined) throw new Error('mid-migration D was not projected')
            expectedAfterInjectionEmbeddings = embeddingRows(writer.db)
            expectedAfterInjectionVecRowids = vecRowids(
              writer.db,
              writer.vec,
              DEFAULT_EMBEDDING_PROFILE,
            )
            const dVector = await floorBase.embedDocument(String(dRow.embedding_input))
            writer.db
              .prepare(`
                INSERT INTO profile_embed_status (
                  record_rowid, profile_key, status, embedding
                ) VALUES (?, ?, 'present', ?)
              `)
              .run(
                Number(dRow.record_rowid),
                targetKey,
                Buffer.from(dVector.buffer, dVector.byteOffset, dVector.byteLength),
              )
          }
          return vector
        },
        embedQuery(rendering: string): Promise<Float32Array> {
          return floorBase.embedQuery(rendering)
        },
      }

      const outcome = await migrationApi().setActiveEmbeddingProfile({
        db: writer.db,
        vec: writer.vec,
        target: {
          profile: STATIC_FLOOR_EMBEDDING_PROFILE,
          embedder: targetEmbedder,
        },
      })

      expect(outcome).toEqual({ flipped: false, missing: [c.id] })
      expect(
        writer.db
          .prepare(
            "SELECT record_rowid FROM profile_embed_status WHERE profile_key = ? AND status = 'present'",
          )
          .all(targetKey),
      ).toHaveLength(3)
      expect(knowledgeLocal.resolveActiveProfile(writer.db)).toBe(DEFAULT_EMBEDDING_PROFILE)
      expect(expectedAfterInjectionEmbeddings).toBeDefined()
      expect(embeddingRows(writer.db)).toEqual(expectedAfterInjectionEmbeddings)
      for (const bundle of [a, b, c]) {
        expect(embeddingRows(writer.db).get(bundle.id)).toEqual(beforeEmbeddings.get(bundle.id))
      }
      expect(vecRowids(writer.db, writer.vec, DEFAULT_EMBEDDING_PROFILE)).toEqual(
        expectedAfterInjectionVecRowids,
      )
      expect(
        writer.db
          .prepare('SELECT model_id FROM embed_cache WHERE model_id = ?')
          .all(DEFAULT_EMBEDDING_PROFILE.model_id),
      ).toHaveLength(1)
    } finally {
      writer.close()
    }
  })

  it('leaves a mid-migration add pending after the flip and unchanged rebuild backfill heals it', async () => {
    publishNamed('Alpha')
    publishNamed('Bravo')
    await projectDefault()

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    let d: PublishedBundle | undefined
    try {
      const floorBase = makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim)
      let added = false
      const targetEmbedder: EmbedderPort = {
        async embedDocument(rendering: string): Promise<Float32Array> {
          if (!added) {
            added = true
            d = publishNamed('Delta')
            await projectDefault()
          }
          return floorBase.embedDocument(rendering)
        },
        embedQuery(rendering: string): Promise<Float32Array> {
          return floorBase.embedQuery(rendering)
        },
      }

      await expect(
        migrationApi().setActiveEmbeddingProfile({
          db: writer.db,
          vec: writer.vec,
          target: {
            profile: STATIC_FLOOR_EMBEDDING_PROFILE,
            embedder: targetEmbedder,
          },
        }),
      ).resolves.toEqual({
        flipped: true,
        profileKey: knowledgeLocal.embeddingProfileKey(
          STATIC_FLOOR_EMBEDDING_PROFILE,
        ),
      })
      expect(d).toBeDefined()
      expect(
        writer.db
          .prepare('SELECT embed_status, embedding FROM records WHERE bundle_id = ?')
          .get(d!.id),
      ).toMatchObject({ embed_status: 'pending', embedding: null })
    } finally {
      writer.close()
    }

    const report = await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
    })
    expect(report.backfilled).toBe(1)

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const healed = reader.db
        .prepare('SELECT embed_status, embedding FROM records WHERE bundle_id = ?')
        .get(d!.id)
      expect(healed?.embed_status).toBe('present')
      expect(healed?.embedding).toBeInstanceOf(Uint8Array)
      expect((healed?.embedding as Uint8Array).byteLength).toBe(
        STATIC_FLOOR_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      )
    } finally {
      reader.db.close()
    }
  })
})
