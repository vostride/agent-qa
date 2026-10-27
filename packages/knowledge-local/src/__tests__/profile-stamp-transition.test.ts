import { rebuildAuthorizedIndex } from './fixtures/authorized-rebuild.js'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'
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
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const LEGACY_DEFAULT_PROFILE_KEY = knowledgeLocal.embeddingProfileKey({
  ...DEFAULT_EMBEDDING_PROFILE,
  revision: 'main',
})
const LOCKED_DEFAULT_PROFILE_KEY = knowledgeLocal.embeddingProfileKey(
  DEFAULT_EMBEDDING_PROFILE,
)

describe('embedding profile stamp transitions', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-profile-transition-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publishFixture(): PublishedBundle {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: 'Profile Transition Product',
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
        runId: 'profile-transition-run',
        testId: 'profile-transition-test',
        stepIndex: 0,
      },
      artifacts: [],
    }
    const outcome = publishBundle(config, input)
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  async function publishAndBuild(): Promise<PublishedBundle> {
    const published = publishFixture()
    const report = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(report).toMatchObject({ projected: 1, backfilled: 0, vec: 'brute' })
    return published
  }

  function rewriteProfileState(profileKey: string, embedding: Uint8Array): void {
    rewriteProfileStateWithOptions(profileKey, embedding)
  }

  function rewriteProfileStateWithOptions(
    profileKey: string,
    embedding: Uint8Array,
    options: {
      defaultVecPath?: boolean
      poisonActiveVec?: boolean
      clearTransitionEpoch?: boolean
      clearVecCleanupEpoch?: boolean
    } = {},
  ): knowledgeLocal.VecCapability {
    const writer = options.defaultVecPath
      ? knowledgeLocal.openIndexWriter(knowledgeRoot)
      : knowledgeLocal.openIndexWriter(knowledgeRoot, {
          vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
        })
    try {
      writer.db
        .prepare("UPDATE meta SET v = ? WHERE k = 'embedding_profile'")
        .run(profileKey)
      writer.db
        .prepare("UPDATE records SET embedding = ?, embed_status = 'present'")
        .run(embedding)
      if (options.poisonActiveVec && writer.vec === 'vec0') {
        const record = writer.db
          .prepare(`
            SELECT record_rowid, product, scope_tier, scope_key, status
            FROM records
          `)
          .get()
        if (record === undefined) throw new Error('expected a projected record')
        const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
        const recordRowid = BigInt(Number(record.record_rowid))
        writer.db
          .prepare(`DELETE FROM ${tableName} WHERE record_rowid = ?`)
          .run(recordRowid)
        writer.db
          .prepare(`
            INSERT INTO ${tableName} (
              record_rowid, product, scope_tier, scope_key, status, embedding
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            recordRowid,
            String(record.product),
            String(record.scope_tier),
            String(record.scope_key),
            String(record.status),
            embedding,
          )
      }
      if (options.clearTransitionEpoch) {
        writer.db
          .prepare("DELETE FROM meta WHERE k = 'embedding_transition_epoch'")
          .run()
      }
      if (options.clearVecCleanupEpoch) {
        writer.db
          .prepare("DELETE FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .run()
      }
      return writer.vec
    } finally {
      writer.close()
    }
  }

  function readProfileState(): {
    stamp: unknown
    embedStatus: unknown
    embedding: unknown
  } {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      const meta = reader.db
        .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
        .get()
      const record = reader.db
        .prepare('SELECT embed_status, embedding FROM records')
        .get()
      return {
        stamp: meta?.v,
        embedStatus: record?.embed_status,
        embedding: record?.embedding,
      }
    } finally {
      reader.db.close()
    }
  }

  function readContextualRendering(): string {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      return String(
        reader.db
          .prepare('SELECT contextual_rendering FROM records')
          .get()?.contextual_rendering,
      )
    } finally {
      reader.db.close()
    }
  }

  function readTransitionEpoch(): unknown {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      return reader.db
        .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
        .get()?.v
    } finally {
      reader.db.close()
    }
  }

  function readVecCleanupEpoch(): unknown {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      return reader.db
        .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
        .get()?.v
    } finally {
      reader.db.close()
    }
  }

  it('invalidates already-normalized locked-stamp bytes when the transition epoch is absent', async () => {
    await publishAndBuild()
    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    rewriteProfileStateWithOptions(LOCKED_DEFAULT_PROFILE_KEY, marker, {
      clearTransitionEpoch: true,
    })

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    writer.close()

    expect(readProfileState()).toEqual({
      stamp: LOCKED_DEFAULT_PROFILE_KEY,
      embedStatus: 'pending',
      embedding: null,
    })
    expect(readTransitionEpoch()).toBe('1')
  })

  it('heals a pre-fix normalized index through an ordinary unchanged-bundle rebuild on the forced-brute path', async () => {
    await publishAndBuild()
    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    rewriteProfileStateWithOptions(LOCKED_DEFAULT_PROFILE_KEY, marker, {
      clearTransitionEpoch: true,
    })

    const report = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(report).toMatchObject({
      vec: 'brute',
      projected: 0,
      backfilled: 1,
      removed: 0,
    })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      const record = reader.db
        .prepare('SELECT embed_status, embedding, contextual_rendering FROM records')
        .get()
      const expected = await makeFakeEmbedder().embedDocument(
        String(record?.contextual_rendering),
      )
      expect(record?.embed_status).toBe('present')
      expect(Buffer.from(record?.embedding as Uint8Array)).toEqual(
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
      )
      expect(Buffer.from(record?.embedding as Uint8Array)).not.toEqual(marker)
      expect(
        reader.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
      expect(
        reader.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
          .get()?.v,
      ).toBe('1')
    } finally {
      reader.db.close()
    }
  })

  it('does not re-invalidate once the transition epoch is recorded', async () => {
    await publishAndBuild()
    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    rewriteProfileStateWithOptions(LOCKED_DEFAULT_PROFILE_KEY, marker, {
      clearTransitionEpoch: true,
    })

    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(first).toMatchObject({ vec: 'brute', projected: 0, backfilled: 1 })
    const before = Buffer.from(readProfileState().embedding as Uint8Array)

    const second = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(second).toMatchObject({ vec: 'brute', projected: 0, backfilled: 0 })
    const after = Buffer.from(readProfileState().embedding as Uint8Array)
    expect(after).toEqual(before)
    expect(readTransitionEpoch()).toBe('1')
  })

  it('records the transition epoch on a fresh knowledge root', () => {
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      expect(
        writer.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count,
      ).toBe(0)
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
          .get()?.v,
      ).toBe('1')
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBeUndefined()
    } finally {
      writer.close()
    }
  })

  it('records both epochs on a fresh vec0 writer and preserves current state on repeat open', () => {
    const first = knowledgeLocal.openIndexWriter(knowledgeRoot)
    if (first.vec !== 'vec0') {
      first.close()
      return
    }

    const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
    try {
      expect(
        first.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
          .get()?.v,
      ).toBe('1')
      expect(
        first.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBe('1')
      expect(first.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count).toBe(0)
    } finally {
      first.close()
    }

    const second = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(second.vec).toBe('vec0')
      expect(
        second.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBe('1')
      expect(second.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count).toBe(0)
    } finally {
      second.close()
    }
  })

  it('keeps vec cleanup pending after a brute transition and completes it on next vec0 writer', async () => {
    publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    if (first.vec !== 'vec0') return

    const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
    const setup = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      setup.db
        .prepare(`
          DELETE FROM meta
          WHERE k IN ('embedding_transition_epoch', 'embedding_vec_cleanup_epoch')
        `)
        .run()
    } finally {
      setup.close()
    }

    const brute = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(brute.vec).toBe('brute')
    brute.close()

    expect(readTransitionEpoch()).toBe('1')
    expect(readVecCleanupEpoch()).toBeUndefined()
    expect(readProfileState()).toEqual({
      stamp: LOCKED_DEFAULT_PROFILE_KEY,
      embedStatus: 'pending',
      embedding: null,
    })

    const stale = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(stale.vec).toBe('vec0')
      expect(stale.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count).toBe(1)
    } finally {
      stale.db.close()
    }

    const cleanup = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(cleanup.vec).toBe('vec0')
      expect(cleanup.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count).toBe(0)
      expect(
        cleanup.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBe('1')
      const canonical = cleanup.db
        .prepare('SELECT embed_status, embedding FROM records')
        .get()
      expect(canonical?.embed_status).toBe('pending')
      expect(canonical?.embedding).toBeNull()
    } finally {
      cleanup.close()
    }
  })

  it('marks cleanup pending before an ordinary brute rewrite and heals on next vec0 rebuild', async () => {
    publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    if (first.vec !== 'vec0') return

    expect(readTransitionEpoch()).toBe('1')
    expect(readVecCleanupEpoch()).toBe('1')
    const originalState = readProfileState()
    const originalBytes = Buffer.from(originalState.embedding as Uint8Array)

    const brute = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      expect(brute.vec).toBe('brute')
      expect(
        brute.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
          .get()?.v,
      ).toBeUndefined()
      brute.db
        .prepare("UPDATE records SET embedding = NULL, embed_status = 'pending'")
        .run()
    } finally {
      brute.close()
    }

    const replacement = new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim)
    replacement[0] = 1
    const replacementEmbedder = {
      async embedDocument(): Promise<Float32Array> {
        return replacement
      },
      async embedQuery(): Promise<Float32Array> {
        return replacement
      },
    }
    const bruteRebuild = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: replacementEmbedder,
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(bruteRebuild).toMatchObject({ vec: 'brute', projected: 0, backfilled: 1 })
    expect(readVecCleanupEpoch()).toBeUndefined()

    const healedByBrute = readProfileState()
    const replacementBytes = Buffer.from(
      replacement.buffer,
      replacement.byteOffset,
      replacement.byteLength,
    )
    expect(healedByBrute.embedStatus).toBe('present')
    expect(Buffer.from(healedByBrute.embedding as Uint8Array)).toEqual(replacementBytes)
    expect(Buffer.from(healedByBrute.embedding as Uint8Array)).not.toEqual(originalBytes)

    const vecRebuild = await rebuildAuthorizedIndex({ knowledgeRoot })
    expect(vecRebuild).toMatchObject({ vec: 'vec0', projected: 0, backfilled: 0 })
    expect(readVecCleanupEpoch()).toBe('1')

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const canonical = reader.db
        .prepare('SELECT record_rowid, product, embed_status, embedding FROM records')
        .get()
      expect(canonical?.embed_status).toBe('present')
      expect(Buffer.from(canonical?.embedding as Uint8Array)).toEqual(replacementBytes)

      const nearest = reader.db
        .prepare(`
          SELECT record_rowid, distance
          FROM ${knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)}
          WHERE embedding MATCH ? AND product = ? AND k = 1
        `)
        .get(replacementBytes, String(canonical?.product))
      expect(Number(nearest?.record_rowid)).toBe(Number(canonical?.record_rowid))
      expect(Number(nearest?.distance)).toBeLessThan(1e-6)
    } finally {
      reader.db.close()
    }

    const repeat = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      expect(repeat.vec).toBe('vec0')
      expect(readVecCleanupEpoch()).toBe('1')
      const canonical = repeat.db
        .prepare('SELECT embed_status, embedding FROM records')
        .get()
      expect(canonical?.embed_status).toBe('present')
      expect(Buffer.from(canonical?.embedding as Uint8Array)).toEqual(replacementBytes)
    } finally {
      repeat.close()
    }
  })

  it('rejects stale vec0 hits across a brute transition before rebuild and heals ordinarily', async () => {
    const published = publishFixture()
    const embedder = makeFakeEmbedder()
    const first = await rebuildAuthorizedIndex({ knowledgeRoot, embedder })
    if (first.vec !== 'vec0') return

    const source = knowledgeLocal.scanBundleById({
      knowledgeRoot,
      bundleId: published.id,
    })
    expect(source).toBeDefined()
    const query = await embedder.embedQuery(readContextualRendering())

    const setup = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      setup.db
        .prepare(`
          DELETE FROM meta
          WHERE k IN ('embedding_transition_epoch', 'embedding_vec_cleanup_epoch')
        `)
        .run()
    } finally {
      setup.close()
    }

    const bruteTransition = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    bruteTransition.close()
    expect(readTransitionEpoch()).toBe('1')
    expect(readVecCleanupEpoch()).toBeUndefined()

    const reader = knowledgeLocal.openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader).toMatchObject({ source: 'index', vec: 'vec0' })
      expect(reader.searchDense(query, { product: source!.product, k: 1 })).toEqual([])

      const bruteRebuild = await rebuildAuthorizedIndex({
        knowledgeRoot,
        embedder,
        vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
      })
      expect(bruteRebuild).toMatchObject({
        vec: 'brute',
        projected: 0,
        backfilled: 1,
      })
      expect(readVecCleanupEpoch()).toBeUndefined()
      expect(readProfileState().embedStatus).toBe('present')
      expect(reader.searchDense(query, { product: source!.product, k: 1 })).toEqual([])

      const vecRebuild = await rebuildAuthorizedIndex({ knowledgeRoot })
      expect(vecRebuild).toMatchObject({
        vec: 'vec0',
        projected: 0,
        backfilled: 0,
      })
      expect(readVecCleanupEpoch()).toBe('1')
      const healed = reader.searchDense(query, { product: source!.product, k: 1 })
      expect(healed.map((hit) => hit.bundleId)).toEqual([published.id])
      expect(healed[0]?.distance).toBeLessThan(1e-6)
    } finally {
      reader.close()
    }
  })

  it('rechecks cleanup when reusing a vec0 reader opened before a brute rewrite', async () => {
    const published = publishFixture()
    const originalEmbedder = makeFakeEmbedder()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: originalEmbedder,
    })
    if (first.vec !== 'vec0') return

    const source = knowledgeLocal.scanBundleById({
      knowledgeRoot,
      bundleId: published.id,
    })
    expect(source).toBeDefined()
    const originalQuery = await originalEmbedder.embedQuery(source!.embeddingInput)
    const reader = knowledgeLocal.openKnowledgeReader(knowledgeRoot)

    try {
      expect(reader).toMatchObject({ source: 'index', vec: 'vec0' })
      expect(
        reader
          .searchDense(originalQuery, { product: source!.product, k: 1 })
          .map((hit) => hit.bundleId),
      ).toEqual([published.id])

      const brute = knowledgeLocal.openIndexWriter(knowledgeRoot, {
        vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
      })
      try {
        expect(
          brute.db
            .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
            .get()?.v,
        ).toBeUndefined()
        brute.db
          .prepare("UPDATE records SET embedding = NULL, embed_status = 'pending'")
          .run()
      } finally {
        brute.close()
      }

      const replacement = new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim)
      replacement[1] = 1
      const replacementEmbedder = {
        async embedDocument(): Promise<Float32Array> {
          return replacement
        },
        async embedQuery(): Promise<Float32Array> {
          return replacement
        },
      }
      const bruteRebuild = await rebuildAuthorizedIndex({
        knowledgeRoot,
        embedder: replacementEmbedder,
        vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
      })
      expect(bruteRebuild).toMatchObject({
        vec: 'brute',
        projected: 0,
        backfilled: 1,
      })
      expect(readVecCleanupEpoch()).toBeUndefined()
      expect(reader.searchDense(originalQuery, { product: source!.product, k: 1 })).toEqual([])

      const vecRebuild = await rebuildAuthorizedIndex({ knowledgeRoot })
      expect(vecRebuild).toMatchObject({
        vec: 'vec0',
        projected: 0,
        backfilled: 0,
      })
      const healed = reader.searchDense(replacement, {
        product: source!.product,
        k: 1,
      })
      expect(healed.map((hit) => hit.bundleId)).toEqual([published.id])
      expect(healed[0]?.distance).toBeLessThan(1e-6)
    } finally {
      reader.close()
    }
  })

  it('rejects vec0 candidates without present exact-dimension canonical bytes', async () => {
    const published = publishFixture()
    const embedder = makeFakeEmbedder()
    const first = await rebuildAuthorizedIndex({ knowledgeRoot, embedder })
    if (first.vec !== 'vec0') return

    const source = knowledgeLocal.scanBundleById({
      knowledgeRoot,
      bundleId: published.id,
    })
    expect(source).toBeDefined()
    const query = await embedder.embedQuery(source!.embeddingInput)
    const fullSizeBytes = Buffer.from(
      query.buffer,
      query.byteOffset,
      query.byteLength,
    )
    const reader = knowledgeLocal.openKnowledgeReader(knowledgeRoot)

    try {
      const pendingWriter = knowledgeLocal.openIndexWriter(knowledgeRoot)
      try {
        pendingWriter.db
          .prepare(`
            UPDATE records
            SET embedding = ?, embed_status = 'pending'
            WHERE bundle_id = ?
          `)
          .run(fullSizeBytes, published.id)
      } finally {
        pendingWriter.close()
      }
      expect(readVecCleanupEpoch()).toBe('1')
      expect(reader.searchDense(query, { product: source!.product, k: 1 })).toEqual([])

      const wrongLengthWriter = knowledgeLocal.openIndexWriter(knowledgeRoot)
      try {
        wrongLengthWriter.db
          .prepare(`
            UPDATE records
            SET embedding = ?, embed_status = 'present'
            WHERE bundle_id = ?
          `)
          .run(Buffer.alloc(100, 0x7f), published.id)
      } finally {
        wrongLengthWriter.close()
      }
      expect(readVecCleanupEpoch()).toBe('1')
      expect(reader.searchDense(query, { product: source!.product, k: 1 })).toEqual([])
    } finally {
      reader.close()
    }
  })

  it('clears active vec0 rows inside the transition transaction at writer open', async () => {
    publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(first.projected).toBe(1)

    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    const vec = rewriteProfileStateWithOptions(LOCKED_DEFAULT_PROFILE_KEY, marker, {
      defaultVecPath: true,
      poisonActiveVec: true,
      clearTransitionEpoch: true,
    })

    if (vec === 'vec0') {
      const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
      try {
        expect(writer.vec).toBe('vec0')
        const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
        expect(
          writer.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count,
        ).toBe(0)
        const record = writer.db
          .prepare('SELECT embed_status, embedding FROM records')
          .get()
        expect(record?.embed_status).toBe('pending')
        expect(record?.embedding).toBeNull()
        expect(
          writer.db
            .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
            .get()?.v,
        ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
        expect(
          writer.db
            .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
            .get()?.v,
        ).toBe('1')
      } finally {
        writer.close()
      }
    }
  })

  it('heals a pre-fix normalized index with poisoned active vec0 rows through an ordinary rebuild', async () => {
    publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(first.projected).toBe(1)

    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    const vec = rewriteProfileStateWithOptions(LOCKED_DEFAULT_PROFILE_KEY, marker, {
      defaultVecPath: true,
      poisonActiveVec: true,
      clearTransitionEpoch: true,
    })

    if (vec === 'vec0') {
      const second = await rebuildAuthorizedIndex({
        knowledgeRoot,
        embedder: makeFakeEmbedder(),
      })
      expect(second).toMatchObject({
        vec: 'vec0',
        projected: 0,
        backfilled: 1,
        removed: 0,
      })

      const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
      try {
        const record = reader.db
          .prepare(`
            SELECT record_rowid, product, embed_status, embedding, contextual_rendering
            FROM records
          `)
          .get()
        const expected = await makeFakeEmbedder().embedDocument(
          String(record?.contextual_rendering),
        )
        const expectedBytes = Buffer.from(
          expected.buffer,
          expected.byteOffset,
          expected.byteLength,
        )
        expect(record?.embed_status).toBe('present')
        expect(Buffer.from(record?.embedding as Uint8Array)).toEqual(expectedBytes)
        expect(Buffer.from(record?.embedding as Uint8Array)).not.toEqual(marker)
        expect(
          reader.db
            .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
            .get()?.v,
        ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
        expect(
          reader.db
            .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
            .get()?.v,
        ).toBe('1')

        const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
        expect(
          reader.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count,
        ).toBe(
          reader.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count,
        )
        const nearest = reader.db
          .prepare(`
            SELECT record_rowid, distance
            FROM ${tableName}
            WHERE embedding MATCH ? AND product = ? AND k = 1
          `)
          .get(expectedBytes, String(record?.product))
        expect(Number(nearest?.record_rowid)).toBe(Number(record?.record_rowid))
        expect(Number(nearest?.distance)).toBeLessThan(1e-6)
      } finally {
        reader.db.close()
      }
    }
  })

  it('invalidates present bytes before restamping a legacy main-revision index', async () => {
    await publishAndBuild()
    rewriteProfileState(
      LEGACY_DEFAULT_PROFILE_KEY,
      Buffer.alloc(DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT, 0x7f),
    )

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      expect(writer.db.prepare('SELECT 1 AS usable').get()?.usable).toBe(1)
    } finally {
      writer.close()
    }

    expect(readProfileState()).toEqual({
      stamp: LOCKED_DEFAULT_PROFILE_KEY,
      embedStatus: 'pending',
      embedding: null,
    })
  })

  it('invalidates present bytes under an unknown stored stamp', async () => {
    await publishAndBuild()
    rewriteProfileState(
      'attacker-controlled-profile',
      Buffer.alloc(DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT, 0x7f),
    )

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    writer.close()

    expect(readProfileState()).toEqual({
      stamp: LOCKED_DEFAULT_PROFILE_KEY,
      embedStatus: 'pending',
      embedding: null,
    })
  })

  it.each([
    ['locked default', DEFAULT_EMBEDDING_PROFILE],
    ['static floor', STATIC_FLOOR_EMBEDDING_PROFILE],
  ] as const)('leaves present bytes unchanged for a matching %s stamp', async (_name, profile) => {
    await publishAndBuild()
    const marker = Buffer.alloc(profile.dim * Float32Array.BYTES_PER_ELEMENT, 0x31)
    const profileKey = knowledgeLocal.embeddingProfileKey(profile)
    rewriteProfileState(profileKey, marker)

    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    writer.close()

    const state = readProfileState()
    expect(state.stamp).toBe(profileKey)
    expect(state.embedStatus).toBe('present')
    expect(Buffer.from(state.embedding as Uint8Array)).toEqual(marker)
  })

  it('opens a fresh knowledge root without rows and returns a usable writer', () => {
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      expect(writer.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count).toBe(0)
      expect(
        writer.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
    } finally {
      writer.close()
    }
  })

  it('re-embeds an unchanged legacy-stamped row through the forced-brute backfill path', async () => {
    await publishAndBuild()
    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    rewriteProfileState(LEGACY_DEFAULT_PROFILE_KEY, marker)

    const report = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(report).toMatchObject({
      vec: 'brute',
      projected: 0,
      backfilled: 1,
      removed: 0,
    })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      const record = reader.db
        .prepare('SELECT embed_status, embedding, contextual_rendering FROM records')
        .get()
      const expected = await makeFakeEmbedder().embedDocument(
        String(record?.contextual_rendering),
      )
      expect(record?.embed_status).toBe('present')
      expect(Buffer.from(record?.embedding as Uint8Array)).toEqual(
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
      )
      expect(Buffer.from(record?.embedding as Uint8Array)).not.toEqual(marker)
      expect(
        reader.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(LOCKED_DEFAULT_PROFILE_KEY)
    } finally {
      reader.db.close()
    }
  })

  it('replaces legacy canonical and active vec0 marker bytes on ordinary rebuild', async () => {
    publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(first.projected).toBe(1)

    const marker = Buffer.alloc(
      DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      0x7f,
    )
    rewriteProfileStateWithOptions(LEGACY_DEFAULT_PROFILE_KEY, marker, {
      defaultVecPath: true,
      poisonActiveVec: true,
    })

    const second = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(second).toMatchObject({ projected: 0, backfilled: 1, removed: 0 })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const record = reader.db
        .prepare(`
          SELECT record_rowid, product, embed_status, embedding, contextual_rendering
          FROM records
        `)
        .get()
      const expected = await makeFakeEmbedder().embedDocument(
        String(record?.contextual_rendering),
      )
      const expectedBytes = Buffer.from(
        expected.buffer,
        expected.byteOffset,
        expected.byteLength,
      )
      expect(record?.embed_status).toBe('present')
      expect(Buffer.from(record?.embedding as Uint8Array)).toEqual(expectedBytes)
      expect(Buffer.from(record?.embedding as Uint8Array)).not.toEqual(marker)
      expect(
        reader.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(LOCKED_DEFAULT_PROFILE_KEY)

      if (second.vec === 'vec0') {
        const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
        expect(
          reader.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count,
        ).toBe(
          reader.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count,
        )
        const nearest = reader.db
          .prepare(`
            SELECT record_rowid, distance
            FROM ${tableName}
            WHERE embedding MATCH ? AND product = ? AND k = 1
          `)
          .get(expectedBytes, String(record?.product))
        expect(Number(nearest?.record_rowid)).toBe(Number(record?.record_rowid))
        expect(Number(nearest?.distance)).toBeLessThan(1e-6)
      }
    } finally {
      reader.db.close()
    }
  })

  it('evicts a vec0 row whose present canonical blob has the wrong length', async () => {
    const published = publishFixture()
    const first = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })

    if (first.vec === 'vec0') {
      const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
      let recordRowid: number
      try {
        const record = writer.db
          .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
          .get(published.id)
        if (record === undefined) throw new Error('expected a projected record')
        recordRowid = Number(record.record_rowid)
        writer.db
          .prepare(`
            UPDATE records
            SET embedding = ?, embed_status = 'present'
            WHERE record_rowid = ?
          `)
          .run(Buffer.alloc(100, 0x7f), recordRowid)
      } finally {
        writer.close()
      }

      const second = await rebuildAuthorizedIndex({ knowledgeRoot })
      expect(second).toMatchObject({
        vec: 'vec0',
        projected: 0,
        backfilled: 0,
        removed: 0,
      })

      const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
      try {
        const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
        expect(
          reader.db
            .prepare(`SELECT record_rowid FROM ${tableName} WHERE record_rowid = ?`)
            .get(BigInt(recordRowid)),
        ).toBeUndefined()
      } finally {
        reader.db.close()
      }
    }
  })
})
