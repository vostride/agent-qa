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

describe('active embedding profile resolution', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-active-profile-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publishFixture(): PublishedBundle {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: 'Static Floor Product',
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
        runId: 'active-profile-run',
        testId: 'active-profile-test',
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

  it('falls back to the default for an absent or unknown meta stamp', () => {
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      writer.db.prepare("DELETE FROM meta WHERE k = 'embedding_profile'").run()
      expect(knowledgeLocal.resolveActiveProfile(writer.db)).toBe(
        DEFAULT_EMBEDDING_PROFILE,
      )

      writer.db
        .prepare("INSERT INTO meta (k, v) VALUES ('embedding_profile', ?)")
        .run('attacker-controlled-profile')
      expect(knowledgeLocal.resolveActiveProfile(writer.db)).toBe(
        DEFAULT_EMBEDDING_PROFILE,
      )
    } finally {
      writer.close()
    }
  })

  it('keeps a floor-stamped index isolated at 512 dimensions end to end', async () => {
    const published = publishFixture()
    const floorKey = knowledgeLocal.embeddingProfileKey(STATIC_FLOOR_EMBEDDING_PROFILE)
    expect(floorKey).not.toBe(
      knowledgeLocal.embeddingProfileKey(DEFAULT_EMBEDDING_PROFILE),
    )
    expect(knowledgeLocal.vecTableName(STATIC_FLOOR_EMBEDDING_PROFILE)).not.toBe(
      knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE),
    )

    const stampWriter = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      stampWriter.db
        .prepare("UPDATE meta SET v = ? WHERE k = 'embedding_profile'")
        .run(floorKey)
    } finally {
      stampWriter.close()
    }

    await expect(
      rebuildAuthorizedIndex({
        knowledgeRoot,
        embedder: makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
      }),
    ).rejects.toThrow('embedder returned 384 dimensions; expected 512')

    const floorEmbedder = makeFakeEmbedder(STATIC_FLOOR_EMBEDDING_PROFILE.dim)
    const report = await rebuildAuthorizedIndex({
      knowledgeRoot,
      embedder: floorEmbedder,
    })
    expect(report).toMatchObject({ projected: 0, backfilled: 1 })

    const connection = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        connection.db
          .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
          .get()?.v,
      ).toBe(floorKey)
      const record = connection.db
        .prepare('SELECT embedding FROM records WHERE bundle_id = ?')
        .get(published.id)
      expect(record?.embedding).toBeInstanceOf(Uint8Array)
      expect((record?.embedding as Uint8Array).byteLength).toBe(
        STATIC_FLOOR_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      )

      if (report.vec === 'vec0') {
        const tableName = knowledgeLocal.vecTableName(STATIC_FLOOR_EMBEDDING_PROFILE)
        expect(
          connection.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName),
        ).toMatchObject({ name: tableName })
        expect(
          connection.db.prepare(`SELECT record_rowid FROM ${tableName}`).all(),
        ).toHaveLength(1)
      }
    } finally {
      connection.db.close()
    }

    const indexed = knowledgeLocal.scanBundleById({
      knowledgeRoot,
      bundleId: published.id,
    })
    expect(indexed).toBeDefined()
    const query = await floorEmbedder.embedQuery(indexed!.embeddingInput)
    const reader = knowledgeLocal.openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.searchDense(query, { k: 1 })[0]?.bundleId).toBe(published.id)
    } finally {
      reader.close()
    }
  })
})
