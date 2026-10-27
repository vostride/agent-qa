import { existsSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  asEvidenceToken,
  BundleOutcomeEventSchema,
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type { EmbeddingProfile } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const vecLoadable = vi.hoisted(() => ({ override: undefined as string | undefined }))

vi.mock('../sqlite-vec-loadable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sqlite-vec-loadable.js')>()
  return {
    ...actual,
    getLoadablePath: () => vecLoadable.override ?? actual.getLoadablePath(),
  }
})

import * as knowledgeLocal from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import * as indexOpen from '../index-open.js'
import { projectBundleIndexRow } from '../index-rebuild.js'
import type {
  BundleStoreConfig,
  PublishBundleInput,
  PublishBundleOutcome,
  WriterLeaseAuthority,
} from '../index.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

interface SchemaVecAuthorityApi {
  SCHEMA_OWNED_EMBEDDING_PROFILES: readonly [EmbeddingProfile, EmbeddingProfile]
  materializedSchemaVecTableNames(db: DatabaseSync): string[]
  deleteRecordFromAllSchemaVecTables(db: DatabaseSync, recordRowid: number): void
}

function schemaVecAuthorityApi(): SchemaVecAuthorityApi {
  const candidate = indexOpen as unknown as Partial<SchemaVecAuthorityApi>
  if (
    candidate.SCHEMA_OWNED_EMBEDDING_PROFILES === undefined
    || typeof candidate.materializedSchemaVecTableNames !== 'function'
    || typeof candidate.deleteRecordFromAllSchemaVecTables !== 'function'
  ) {
    throw new Error('schema-owned vec table authority is not implemented')
  }
  return candidate as SchemaVecAuthorityApi
}

function tableRows(
  db: DatabaseSync,
  profile: EmbeddingProfile,
): Array<{ recordRowid: number; bundleId: string }> {
  return db.prepare(`
    SELECT vec.record_rowid, records.bundle_id
    FROM ${knowledgeLocal.vecTableName(profile)} AS vec
    JOIN records ON records.record_rowid = vec.record_rowid
    ORDER BY records.bundle_id
  `).all().map((row) => ({
    recordRowid: Number(row.record_rowid),
    bundleId: String(row.bundle_id),
  }))
}

function hasVecRow(
  db: DatabaseSync,
  profile: EmbeddingProfile,
  recordRowid: number,
): boolean {
  return db
    .prepare(`SELECT 1 FROM ${knowledgeLocal.vecTableName(profile)} WHERE record_rowid = ?`)
    .get(BigInt(recordRowid)) !== undefined
}

describe('multi-profile vector forgetting acceptance', () => {
  let root: string
  let knowledgeRoot: string
  let gcWriterAuthority: WriterLeaseAuthority | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-multi-profile-forgetting-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
    vecLoadable.override = undefined
    gcWriterAuthority = undefined
  })

  afterEach(() => {
    vecLoadable.override = undefined
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey = 'Multi Profile Product'): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function writerAuthority(): WriterLeaseAuthority {
    if (gcWriterAuthority !== undefined) return gcWriterAuthority
    const acquired = knowledgeLocal.acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected GC writer authority')
    gcWriterAuthority = {
      knowledgeRoot,
      leaseId: acquired.leaseId,
      epoch: acquired.epoch,
    }
    return gcWriterAuthority
  }

  function input(label: string): PublishBundleInput {
    const key = slugBranch(label)
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: label },
          { t: 'page', route: `/multi-profile/${key}` },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key },
        summary: `${label} multi-profile control`,
        body: `Selecting ${label} exercises the multi-profile forgetting fixture.`,
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `multi-profile-${key}-run`,
        testId: `multi-profile-${key}-test`,
        stepIndex: 0,
      },
      artifacts: [],
    }
  }

  function publish(label: string): PublishedBundle {
    const outcome = publishBundle(config(), input(label))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function publishGcGeneration(generation: number): PublishedBundle {
    const outcome = publishBundle(config(), {
      draft: makeBundleDraftFixture({
        subtype: 'measurement',
        anchors: [
          { t: 'el', role: 'button', name: 'GC chain control' },
          { t: 'page', route: '/multi-profile/gc-chain' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'multi-profile-gc-chain' },
        summary: `GC chain generation ${generation}`,
        body: `Canonical multi-profile GC generation ${generation}.`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'measurement',
        metricKey: `multi-profile-gc-generation-${generation}`,
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 60 + generation,
      screenStates: [],
      initialEvents: [
        {
          type: 'promoted',
          evidenceToken: asEvidenceToken(`multi-profile-gc-promoted-${generation}`),
          curationJobId: `multi-profile-gc-publish-${generation}`,
          buildOrdinal: 60 + generation,
        },
      ],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'multi-profile GC acceptance fixture',
      },
      artifacts: [],
    })
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected GC generation publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function supersedeForGc(target: PublishedBundle, replacement: PublishedBundle): void {
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'superseded',
      evidenceToken: asEvidenceToken('multi-profile-gc-superseded'),
      curationJobId: 'multi-profile-gc-supersede-job',
      buildOrdinal: 70,
      byRecordId: replacement.id,
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'window-close',
      evidenceToken: asEvidenceToken('multi-profile-gc-window-close'),
      curationJobId: 'multi-profile-gc-supersede-job',
      buildOrdinal: 70,
      closedAtOrdinal: 70,
    })).toEqual({ kind: 'appended' })
  }

  async function migratePublishedRecords(
    records: readonly PublishedBundle[],
  ): Promise<Map<string, number>> {
    await expect(knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
    })).resolves.toMatchObject({
      vec: 'vec0',
      projected: records.length,
      pendingEmbeddings: 0,
    })

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      await expect(knowledgeLocal.setActiveEmbeddingProfile({
        db: writer.db,
        vec: writer.vec,
        target: {
          profile: STATIC_FLOOR_EMBEDDING_PROFILE,
          embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
        },
      })).resolves.toMatchObject({ flipped: true })

      const rowids = new Map(
        writer.db
          .prepare('SELECT bundle_id, record_rowid FROM records ORDER BY bundle_id')
          .all()
          .map((row) => [String(row.bundle_id), Number(row.record_rowid)] as const),
      )
      const expectedIds = records.map(({ id }) => id).sort()
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(tableRows(writer.db, profile).map(({ bundleId }) => bundleId)).toEqual(expectedIds)
      }
      return rowids
    } finally {
      writer.close()
    }
  }

  async function migrateTwoRecords(): Promise<{
    target: PublishedBundle
    live: PublishedBundle
    targetRowid: number
    liveRowid: number
  }> {
    const target = publish('Target record')
    const live = publish('Live neighbor')
    await expect(knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
    })).resolves.toMatchObject({ vec: 'vec0', projected: 2, pendingEmbeddings: 0 })

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(writer.vec).toBe('vec0')
      await expect(knowledgeLocal.setActiveEmbeddingProfile({
        db: writer.db,
        vec: writer.vec,
        target: {
          profile: STATIC_FLOOR_EMBEDDING_PROFILE,
          embedder: makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim),
        },
      })).resolves.toEqual({
        flipped: true,
        profileKey: knowledgeLocal.embeddingProfileKey(STATIC_FLOOR_EMBEDDING_PROFILE),
      })

      const recordRows = new Map(
        writer.db
          .prepare('SELECT bundle_id, record_rowid FROM records ORDER BY bundle_id')
          .all()
          .map((row) => [String(row.bundle_id), Number(row.record_rowid)] as const),
      )
      const targetRowid = recordRows.get(target.id)
      const liveRowid = recordRows.get(live.id)
      if (targetRowid === undefined || liveRowid === undefined) {
        throw new Error('migrated record rowids are missing')
      }

      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(tableRows(writer.db, profile).map(({ bundleId }) => bundleId)).toEqual(
          [live.id, target.id].sort(),
        )
      }
      return { target, live, targetRowid, liveRowid }
    } finally {
      writer.close()
    }
  }

  function deprecate(target: PublishedBundle): void {
    expect(knowledgeLocal.appendOutcomeEvent(
      config(),
      target.id,
      BundleOutcomeEventSchema.parse({
        type: 'deprecated',
        evidenceToken: 'multi-profile-structural-scrub',
        curationJobId: 'multi-profile-structural-scrub-job',
        buildOrdinal: 50,
        reason: 'withdraw multi-profile target',
      }),
    )).toEqual({ kind: 'appended' })
  }

  function enqueuePurgeCandidate(): string {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: {
        sourceRunId: 'multi-profile-purge-queue-run',
        scope: { tier: 'product', key: 'multi-profile-purge' },
        buildOrdinal: 80,
        executionContext: 'local-interactive',        kind: 'fact',
        subtype: 'selector',
        anchors: [
          { t: 'el', role: 'Button', name: 'Target record' },
          { t: 'page', route: '/multi-profile/target-record' },
          { t: 'platform', platform: 'web' },
        ],
        summarySeed: 'Multi-profile purge queue target',
        bodySeed: 'Queue payload sharing the purge target anchors.',
        distilledObservations: [],
        evidenceToken: 'multi-profile-purge-queue-evidence',
        attributingObservationId: 'multi-profile-purge-queue-observation',
        emittedAt: '2026-07-16T00:00:00.000Z',
      },
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') {
      throw new Error(`expected purge queue admission, got ${outcome.kind}`)
    }
    return outcome.candidateId
  }

  function receiptPath(recordId: string): string {
    return join(knowledgeRoot, 'memory', 'receipts', `purge-${recordId}.json`)
  }

  it('materialized table authority is closed, ordered, capability-independent, and idempotent', async () => {
    const authority = schemaVecAuthorityApi()
    const migrated = await migrateTwoRecords()
    expect(authority.SCHEMA_OWNED_EMBEDDING_PROFILES).toEqual([
      DEFAULT_EMBEDDING_PROFILE,
      STATIC_FLOOR_EMBEDDING_PROFILE,
    ])

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      writer.db.exec(`
        CREATE TABLE vec_non_schema_sentinel (
          record_rowid INTEGER PRIMARY KEY,
          marker TEXT NOT NULL
        )
      `)
      writer.db
        .prepare('INSERT INTO vec_non_schema_sentinel (record_rowid, marker) VALUES (?, ?)')
        .run(migrated.targetRowid, 'preserve')
      expect(authority.materializedSchemaVecTableNames(writer.db)).toEqual([
        knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE),
        knowledgeLocal.vecTableName(STATIC_FLOOR_EMBEDDING_PROFILE),
      ])

      authority.deleteRecordFromAllSchemaVecTables(writer.db, Number.MAX_SAFE_INTEGER)
      for (const profile of authority.SCHEMA_OWNED_EMBEDDING_PROFILES) {
        expect(tableRows(writer.db, profile)).toHaveLength(2)
      }
      expect(
        writer.db
          .prepare('SELECT marker FROM vec_non_schema_sentinel WHERE record_rowid = ?')
          .get(migrated.targetRowid)?.marker,
      ).toBe('preserve')
    } finally {
      writer.close()
    }

    vecLoadable.override = join(root, 'missing-sqlite-vec-extension')
    const brute = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(brute.vec).toBe('brute')
      expect(authority.materializedSchemaVecTableNames(brute.db)).toEqual([
        knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE),
        knowledgeLocal.vecTableName(STATIC_FLOOR_EMBEDDING_PROFILE),
      ])
    } finally {
      brute.close()
    }

    const empty = new (await import('node:sqlite')).DatabaseSync(':memory:')
    try {
      expect(authority.materializedSchemaVecTableNames(empty)).toEqual([])
    } finally {
      empty.close()
    }
  })

  it('structural scrub removes the target from outgoing and active vec0 tables only', async () => {
    const migrated = await migrateTwoRecords()
    deprecate(migrated.target)

    projectBundleIndexRow({ knowledgeRoot, bundleId: migrated.target.id })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(tableRows(reader.db, profile)).toEqual([
          { recordRowid: migrated.liveRowid, bundleId: migrated.live.id },
        ])
      }
      expect(
        reader.db
          .prepare('SELECT status, embed_status, embedding FROM records WHERE bundle_id = ?')
          .get(migrated.target.id),
      ).toMatchObject({ status: 'deprecated', embed_status: 'scrubbed', embedding: null })
      expect(
        reader.db
          .prepare('SELECT COUNT(*) AS count FROM anchors WHERE record_rowid = ?')
          .get(migrated.targetRowid)?.count,
      ).toBe(3)
    } finally {
      reader.db.close()
    }
  })

  it('structural scrub fails closed and rolls back when migrated vec0 tables are unloaded', async () => {
    const migrated = await migrateTwoRecords()
    deprecate(migrated.target)
    vecLoadable.override = join(root, 'missing-sqlite-vec-extension')

    expect(() => projectBundleIndexRow({
      knowledgeRoot,
      bundleId: migrated.target.id,
    })).toThrow(/schema-owned vec table/u)

    vecLoadable.override = undefined
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(tableRows(reader.db, profile).map(({ bundleId }) => bundleId)).toEqual(
          [migrated.live.id, migrated.target.id].sort(),
        )
      }
      expect(
        reader.db
          .prepare('SELECT status FROM records WHERE bundle_id = ?')
          .get(migrated.target.id)?.status,
      ).toBe('candidate')
      expect(
        reader.db
          .prepare('SELECT 1 FROM fts_records WHERE rowid = ?')
          .get(migrated.targetRowid),
      ).toBeDefined()
    } finally {
      reader.db.close()
    }
  })

  it('GC cleanup removes a trimmed target from every profile and preserves live neighbors', async () => {
    const target = publishGcGeneration(1)
    const replacement = publishGcGeneration(2)
    const unrelated = publish('GC unrelated live record')
    const rowids = await migratePublishedRecords([target, replacement, unrelated])
    const targetRowid = rowids.get(target.id)
    if (targetRowid === undefined) throw new Error('GC target rowid is missing')

    supersedeForGc(target, replacement)
    const gc = knowledgeLocal.runKnowledgeGc({
      knowledgeRoot,
      horizon: { kind: 'none' },
      retainK: 0,
    }, writerAuthority())
    expect(gc.trimmedRecordIds).toEqual([target.id])
    expect(existsSync(target.dir)).toBe(false)
    expect(existsSync(replacement.dir)).toBe(true)
    expect(existsSync(unrelated.dir)).toBe(true)

    await expect(knowledgeLocal.rebuildIndex({ knowledgeRoot })).resolves.toMatchObject({
      vec: 'vec0',
      removed: 1,
    })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(reader.db, profile, targetRowid)).toBe(false)
        expect(tableRows(reader.db, profile).map(({ bundleId }) => bundleId)).toEqual(
          [replacement.id, unrelated.id].sort(),
        )
      }
      expect(
        reader.db.prepare('SELECT 1 FROM records WHERE record_rowid = ?').get(targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?').get(targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM anchors WHERE record_rowid = ?').get(targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM graph_edges WHERE record_rowid = ?').get(targetRowid),
      ).toBeUndefined()
    } finally {
      reader.db.close()
    }

    await expect(knowledgeLocal.rebuildIndex({ knowledgeRoot })).resolves.toMatchObject({
      removed: 0,
    })
    const secondReader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(secondReader.db, profile, targetRowid)).toBe(false)
        expect(tableRows(secondReader.db, profile).map(({ bundleId }) => bundleId)).toEqual(
          [replacement.id, unrelated.id].sort(),
        )
      }
    } finally {
      secondReader.db.close()
    }
  })

  it('GC cleanup fails closed and rolls back when migrated vec0 tables are unloaded', async () => {
    const target = publishGcGeneration(1)
    const replacement = publishGcGeneration(2)
    const unrelated = publish('GC brute live record')
    const rowids = await migratePublishedRecords([target, replacement, unrelated])
    const targetRowid = rowids.get(target.id)
    if (targetRowid === undefined) throw new Error('GC brute target rowid is missing')

    supersedeForGc(target, replacement)
    expect(knowledgeLocal.runKnowledgeGc({
      knowledgeRoot,
      horizon: { kind: 'none' },
      retainK: 0,
    }, writerAuthority()).trimmedRecordIds).toEqual([target.id])

    let report: knowledgeLocal.RebuildReport | undefined
    await expect((async () => {
      report = await knowledgeLocal.rebuildIndex({
        knowledgeRoot,
        vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
      })
    })()).rejects.toThrow(/schema-owned vec table/u)
    expect(report).toBeUndefined()

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(reader.db, profile, targetRowid)).toBe(true)
        expect(tableRows(reader.db, profile).map(({ bundleId }) => bundleId)).toEqual(
          [replacement.id, target.id, unrelated.id].sort(),
        )
      }
      expect(
        reader.db.prepare('SELECT 1 FROM records WHERE record_rowid = ?').get(targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?').get(targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM anchors WHERE record_rowid = ?').get(targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM graph_edges WHERE record_rowid = ?').get(targetRowid),
      ).toBeDefined()
    } finally {
      reader.db.close()
    }
  })

  it('sovereign purge removes the target from every profile before publishing success', async () => {
    const migrated = await migrateTwoRecords()
    const sentinelWriter = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      sentinelWriter.db.exec(`
        CREATE TABLE vec_non_schema_purge_sentinel (
          record_rowid INTEGER PRIMARY KEY,
          marker TEXT NOT NULL
        )
      `)
      sentinelWriter.db
        .prepare(`
          INSERT INTO vec_non_schema_purge_sentinel (record_rowid, marker)
          VALUES (?, ?)
        `)
        .run(migrated.targetRowid, 'preserve')
    } finally {
      sentinelWriter.close()
    }

    const first = knowledgeLocal.purgeRecord({
      knowledgeRoot,
      recordId: migrated.target.id,
      initiator: 'multi-profile-purge-user',
      purgedAtOrdinal: 43,
    })
    expect(first.kind).toBe('purged')
    expect(existsSync(migrated.target.dir)).toBe(false)
    expect(existsSync(receiptPath(migrated.target.id))).toBe(true)

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(reader.db, profile, migrated.targetRowid)).toBe(false)
        expect(hasVecRow(reader.db, profile, migrated.liveRowid)).toBe(true)
      }
      expect(
        reader.db.prepare('SELECT 1 FROM records WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?')
          .get(migrated.targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM anchors WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeUndefined()
      expect(
        reader.db.prepare('SELECT 1 FROM graph_edges WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeUndefined()
      expect(
        reader.db
          .prepare('SELECT marker FROM vec_non_schema_purge_sentinel WHERE record_rowid = ?')
          .get(migrated.targetRowid)?.marker,
      ).toBe('preserve')
    } finally {
      reader.db.close()
    }

    const second = knowledgeLocal.purgeRecord({
      knowledgeRoot,
      recordId: migrated.target.id,
      initiator: 'different-user-must-not-overwrite',
    })
    expect(second.kind).toBe('already-purged')
    if (first.kind !== 'purged' || second.kind !== 'already-purged') {
      throw new Error('expected purged then already-purged outcomes')
    }
    expect(second.receipt).toEqual(first.receipt)

    const repeatReader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(repeatReader.db, profile, migrated.targetRowid)).toBe(false)
        expect(hasVecRow(repeatReader.db, profile, migrated.liveRowid)).toBe(true)
      }
    } finally {
      repeatReader.db.close()
    }
  })

  it('sovereign purge fails closed before bundle queue and receipt deletion under brute', async () => {
    const migrated = await migrateTwoRecords()
    const queuedCandidateId = enqueuePurgeCandidate()
    const queuedCandidateDir = knowledgeLocal.queuedCandidateDir(
      knowledgeRoot,
      queuedCandidateId,
    )
    expect(existsSync(queuedCandidateDir)).toBe(true)

    vecLoadable.override = join(root, 'missing-sqlite-vec-extension')
    let outcome: knowledgeLocal.PurgeRecordOutcome | undefined
    expect(() => {
      outcome = knowledgeLocal.purgeRecord({
        knowledgeRoot,
        recordId: migrated.target.id,
        initiator: 'multi-profile-purge-user',
        purgedAtOrdinal: 43,
      })
    }).toThrow(/schema-owned vec table/u)
    expect(outcome).toBeUndefined()
    expect(existsSync(migrated.target.dir)).toBe(true)
    expect(existsSync(queuedCandidateDir)).toBe(true)
    expect(existsSync(receiptPath(migrated.target.id))).toBe(false)

    vecLoadable.override = undefined
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      for (const profile of [
        DEFAULT_EMBEDDING_PROFILE,
        STATIC_FLOOR_EMBEDDING_PROFILE,
      ]) {
        expect(hasVecRow(reader.db, profile, migrated.targetRowid)).toBe(true)
        expect(hasVecRow(reader.db, profile, migrated.liveRowid)).toBe(true)
      }
      expect(
        reader.db.prepare('SELECT 1 FROM records WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?')
          .get(migrated.targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM anchors WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeDefined()
      expect(
        reader.db.prepare('SELECT 1 FROM graph_edges WHERE record_rowid = ?')
          .get(migrated.targetRowid),
      ).toBeDefined()
    } finally {
      reader.db.close()
    }
  })
})
