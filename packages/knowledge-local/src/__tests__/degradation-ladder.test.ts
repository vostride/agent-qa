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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BundleStoreConfig,
  PublishBundleInput,
  PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

const transformersMock = vi.hoisted(() => ({ loads: 0 }))

vi.mock('@huggingface/transformers', () => {
  transformersMock.loads += 1
  throw new Error('forced transformers module import failure')
})

type KnowledgeLocal = typeof import('../index.js')
type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

let knowledgeLocal: KnowledgeLocal

function moduleUnavailableError(): Error {
  return Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

beforeAll(async () => {
  knowledgeLocal = await import('../index.js')
})

describe('automatic embedding degradation ladder', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-degradation-ladder-'))
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

  function publishNamed(productKey: string, label: string): PublishedBundle {
    const input: PublishBundleInput = {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: label },
          { t: 'page', route: `/${slugBranch(label)}` },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: slugBranch(productKey) },
        summary: `${label} degradation fixture`,
        body: `Selecting ${label} exercises the automatic embedding ladder.`,
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'degradation-ladder-run',
        testId: `degradation-ladder-${slugBranch(label)}`,
        stepIndex: 0,
      },
      artifacts: [],
    }
    const outcome = publishBundle(config(productKey), input)
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  it('completes a deferred rebuild and later heals every pending row through backfill', async () => {
    publishNamed('Deferred Product', 'Deferred first')
    publishNamed('Deferred Product', 'Deferred second')

    const deferred = await knowledgeLocal.acquireEmbedder({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      probes: {
        discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
        createNativeEmbedder: vi.fn().mockRejectedValue(
          Object.assign(new Error('model artifact is not present in the local cache'), {
            code: 'ENOENT',
          }),
        ),
      },
    })
    expect(deferred).toEqual({ kind: 'deferred', reason: 'cold-artifact' })

    const first = await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: deferred.kind === 'ready' ? deferred.embedder : undefined,
    })
    expect(first).toMatchObject({ projected: 2, backfilled: 0, removed: 0 })

    const pendingReader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    let pendingRowids: unknown[]
    try {
      const pending = rows(
        pendingReader.db,
        'SELECT record_rowid, embed_status, embedding FROM records ORDER BY record_rowid',
      )
      pendingRowids = pending.map((row) => row.record_rowid)
      expect(pending).toHaveLength(2)
      expect(pending.every((row) => row.embed_status === 'pending')).toBe(true)
      expect(pending.every((row) => row.embedding === null)).toBe(true)
      expect(rows(pendingReader.db, 'SELECT rowid FROM fts_records')).toHaveLength(2)
      expect(rows(pendingReader.db, 'SELECT record_rowid FROM anchors')).toHaveLength(6)
    } finally {
      pendingReader.db.close()
    }

    const ready = await knowledgeLocal.acquireEmbedder({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      probes: {
        discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
        createNativeEmbedder: vi.fn().mockResolvedValue(
          makeFakeEmbedder(DEFAULT_EMBEDDING_PROFILE.dim),
        ),
      },
    })
    if (ready.kind !== 'ready') throw new Error('expected a ready fake embedder')

    const second = await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: ready.embedder,
    })
    expect(second).toMatchObject({ projected: 0, backfilled: 2, removed: 0 })

    const presentReader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const present = rows(
        presentReader.db,
        'SELECT record_rowid, embed_status, embedding FROM records ORDER BY record_rowid',
      )
      expect(present.map((row) => row.record_rowid)).toEqual(pendingRowids)
      expect(present.every((row) => row.embed_status === 'present')).toBe(true)
      expect(
        present.every(
          (row) =>
            row.embedding instanceof Uint8Array
            && row.embedding.byteLength
              === DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
        ),
      ).toBe(true)
    } finally {
      presentReader.db.close()
    }
  })

  it('backfills under the acquired real static-floor profile at 512 dimensions', async () => {
    const published = publishNamed('Floor Product', 'Floor-backed row')
    expect(await knowledgeLocal.rebuildIndex({ knowledgeRoot })).toMatchObject({
      projected: 1,
      backfilled: 0,
    })

    const floorKey = knowledgeLocal.embeddingProfileKey(STATIC_FLOOR_EMBEDDING_PROFILE)
    const stampWriter = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      stampWriter.db
        .prepare("UPDATE meta SET v = ? WHERE k = 'embedding_profile'")
        .run(floorKey)
    } finally {
      stampWriter.close()
    }

    const acquired = await knowledgeLocal.acquireEmbedder({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      probes: {
        discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
        createNativeEmbedder: vi.fn().mockRejectedValue(moduleUnavailableError()),
      },
    })
    expect(acquired).toMatchObject({
      kind: 'ready',
      rung: 'floor',
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
    })
    if (acquired.kind !== 'ready') throw new Error('expected the real floor embedder')

    const report = await knowledgeLocal.rebuildIndex({
      knowledgeRoot,
      embedder: acquired.embedder,
    })
    expect(report).toMatchObject({ projected: 0, backfilled: 1, removed: 0 })

    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      expect(reader.db.prepare("SELECT v FROM meta WHERE k = 'embedding_profile'").get()?.v)
        .toBe(floorKey)
      const record = reader.db
        .prepare('SELECT embed_status, embedding FROM records WHERE bundle_id = ?')
        .get(published.id)
      expect(record?.embed_status).toBe('present')
      expect(record?.embedding).toBeInstanceOf(Uint8Array)
      expect((record?.embedding as Uint8Array).byteLength).toBe(
        STATIC_FLOOR_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      )
    } finally {
      reader.db.close()
    }
  })

  it('imports the public barrel without loading transformers and falls to the floor when it breaks', async () => {
    expect(knowledgeLocal.acquireEmbedder).toBeTypeOf('function')
    expect(transformersMock.loads).toBe(0)

    const acquired = await knowledgeLocal.acquireEmbedder({
      preferredProfile: DEFAULT_EMBEDDING_PROFILE,
      allowDownload: false,
      probes: {
        discoverWorker: vi.fn().mockResolvedValue({ kind: 'no-worker' }),
      },
    })

    expect(transformersMock.loads).toBe(1)
    expect(acquired).toMatchObject({
      kind: 'ready',
      rung: 'floor',
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
    })
  })
})
