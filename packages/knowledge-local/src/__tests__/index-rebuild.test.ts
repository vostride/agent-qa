import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  canonicalJson,
  DEFAULT_EMBEDDING_PROFILE,
  graphNodeId,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleRelation,
  DerivedTrustState,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { appendOutcomeEvent } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle } from '../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../bundle-publish.test-helper.js'
import {
  EMBED_STATUS_PENDING,
  EMBED_STATUS_SCRUBBED,
  EMBED_STATUS_SUPPRESSED,
  projectBundleIndexRow,
  selectPendingEmbeddingRows,
} from '../index-rebuild.js'
import {
  INDEX_DB_FILE,
  INDEX_RENDERING_SCHEMA_VERSION,
  INDEX_SCHEMA_VERSION,
  readIndexMaintenanceState,
} from '../index-open.js'
import {
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
} from '../lease/writer-lease.js'
import { readRebuildRequest, requestRebuild } from '../rebuild-marker.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

interface RebuildReport {
  projected: number
  skippedIncomplete: number
  scanIssues: string[]
  removed: number
  backfilled: number
  vec: 'vec0' | 'brute'
  pendingEmbeddings: number
  maintenanceRemaining: boolean
}

interface RebuildApi {
  rebuildIndex(opts: {
    knowledgeRoot: string
    embedder?: knowledgeLocal.EmbedderPort
    vecLoadablePath?: string
    writerAuthority?: knowledgeLocal.WriterLeaseAuthority
    hooks?: { beforeTransactionCommit?: () => void }
  }): Promise<RebuildReport>
}

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

function rebuildApi(): RebuildApi {
  const candidate = knowledgeLocal as unknown as Partial<RebuildApi>
  if (typeof candidate.rebuildIndex !== 'function') {
    throw new Error('rebuildIndex public API is not implemented')
  }
  return candidate as RebuildApi
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

function snapshotDirectory(dir: string): {
  directoryMtimeMs: number
  files: Record<string, { contents: Buffer; mtimeMs: number; size: number }>
} {
  return {
    directoryMtimeMs: statSync(dir).mtimeMs,
    files: Object.fromEntries(
      readdirSync(dir).sort().map((name) => {
        const path = join(dir, name)
        const stat = statSync(path)
        if (!stat.isFile()) throw new Error(`unexpected index directory entry: ${path}`)
        return [
          name,
          {
            contents: readFileSync(path),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          },
        ]
      }),
    ),
  }
}

describe('derived-index rebuild projection', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-index-rebuild-'))
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

  function input(overrides: Partial<PublishBundleInput> = {}): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'index-rebuild-run',
        testId: 'index-rebuild-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
  }

  function publish(
    productKey: string,
    overrides: Partial<PublishBundleInput> = {},
  ): PublishedBundle {
    const outcome = publishBundle(config(productKey), input(overrides))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function publishNamed(productKey: string, label: string): PublishedBundle {
    const key = slugBranch(label)
    return publish(productKey, {
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
    })
  }

  function openReader(): knowledgeLocal.IndexReaderConnection {
    return knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
  }

  function acquireAuthority(): knowledgeLocal.WriterLeaseAuthority {
    const acquired = knowledgeLocal.acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer lease')
    return { knowledgeRoot, leaseId: acquired.leaseId, epoch: acquired.epoch }
  }

  function expireLease(): void {
    const leasePath = join(knowledgeRoot, LEASE_FILE)
    const holder = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...holder,
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )
  }

  function forceCompetingEpoch(): knowledgeLocal.WriterLeaseAuthority {
    expireLease()
    return acquireAuthority()
  }

  it('refuses stale authority before an index open can create database bytes', async () => {
    publishNamed('Pre-open Authority Product', 'Pre-open authority')
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'marker must survive a pre-open authority refusal',
    })
    const authority = acquireAuthority()
    forceCompetingEpoch()

    await expect(
      rebuildApi().rebuildIndex({ knowledgeRoot, writerAuthority: authority }),
    ).rejects.toBeInstanceOf(knowledgeLocal.WriterAuthorityLostError)

    expect(existsSync(join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE))).toBe(false)
    expect(readRebuildRequest(knowledgeRoot).present).toBe(true)
  })

  it('commits synchronous projection before a contender can reclaim authority', async () => {
    const published = publishNamed('Commit Fence Product', 'Commit fence')
    const authority = acquireAuthority()
    let hookCalls = 0
    let contenderDuringCommit: ReturnType<typeof knowledgeLocal.acquireWriterLease> | undefined

    const report = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      writerAuthority: authority,
      hooks: {
        beforeTransactionCommit: () => {
          hookCalls += 1
          expireLease()
          contenderDuringCommit = knowledgeLocal.acquireWriterLease(knowledgeRoot, {
            mutationLockTakeoverMs: 0,
          })
        },
      },
    })

    expect(hookCalls).toBe(1)
    expect(contenderDuringCommit).toMatchObject({
      kind: 'held',
      holder: { leaseId: authority.leaseId, epoch: authority.epoch },
    })
    expect(report.projected).toBe(1)
    const reader = openReader()
    try {
      expect(
        reader.db.prepare('SELECT 1 FROM records WHERE bundle_id = ?').get(published.id),
      ).toEqual({ '1': 1 })
    } finally {
      reader.db.close()
    }
    expect(forceCompetingEpoch()).toMatchObject({ epoch: authority.epoch + 1 })
  })

  it('refuses the next vector mutation after a competing epoch appears during embedding', async () => {
    const published = publishNamed('Embedding Authority Product', 'Embedding authority')
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'marker must survive authority loss before vector persistence',
    })
    const authority = acquireAuthority()
    const baseEmbedder = makeFakeEmbedder()
    const reclaimingEmbedder: knowledgeLocal.EmbedderPort = {
      async embedDocument(rendering) {
        forceCompetingEpoch()
        return baseEmbedder.embedDocument(rendering)
      },
      embedQuery: (rendering) => baseEmbedder.embedQuery(rendering),
    }

    await expect(
      rebuildApi().rebuildIndex({
        knowledgeRoot,
        embedder: reclaimingEmbedder,
        writerAuthority: authority,
      }),
    ).rejects.toBeInstanceOf(knowledgeLocal.WriterAuthorityLostError)

    const reader = openReader()
    try {
      expect(
        reader.db
          .prepare('SELECT embed_status, embedding FROM records WHERE bundle_id = ?')
          .get(published.id),
      ).toEqual({ embed_status: 'pending', embedding: null })
      expect(
        rows(
          reader.db,
          `SELECT record_rowid FROM ${knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)}`,
        ),
      ).toEqual([])
    } finally {
      reader.db.close()
    }
    expect(readRebuildRequest(knowledgeRoot).present).toBe(true)
  })

  it('inspects an absent or pending index without creating or changing files', async () => {
    const indexDir = join(knowledgeRoot, 'memory', 'index')
    expect(readIndexMaintenanceState(knowledgeRoot)).toEqual({
      indexAbsent: true,
      pendingEmbeddings: 0,
      renderingEpochStale: false,
      vectorReconciliationOutstanding: false,
    })
    expect(existsSync(indexDir)).toBe(false)

    publishNamed('Pending Inspection Product', 'Pending inspection')
    await rebuildApi().rebuildIndex({ knowledgeRoot })
    const before = snapshotDirectory(indexDir)

    expect(readIndexMaintenanceState(knowledgeRoot)).toEqual({
      indexAbsent: false,
      pendingEmbeddings: 1,
      renderingEpochStale: false,
      vectorReconciliationOutstanding: false,
    })
    expect(snapshotDirectory(indexDir)).toEqual(before)
  })

  it('reports rendering and vector maintenance independently of pending rows', async () => {
    publishNamed('Metadata Inspection Product', 'Metadata inspection')
    await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })

    const dbPath = join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE)
    const renderingWriter = new DatabaseSync(dbPath)
    let vectorEpoch: unknown
    try {
      vectorEpoch = renderingWriter
        .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
        .get()?.v
      expect(typeof vectorEpoch).toBe('string')

      renderingWriter
        .prepare("UPDATE meta SET v = ? WHERE k = 'rendering_schema_version'")
        .run('0')
      renderingWriter
        .prepare("UPDATE meta SET v = ? WHERE k = 'embedding_vec_cleanup_epoch'")
        .run(String(vectorEpoch))
      renderingWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      renderingWriter.close()
    }
    expect(readIndexMaintenanceState(knowledgeRoot)).toEqual({
      indexAbsent: false,
      pendingEmbeddings: 0,
      renderingEpochStale: true,
      vectorReconciliationOutstanding: false,
    })

    const vectorWriter = new DatabaseSync(dbPath)
    try {
      vectorWriter
        .prepare("UPDATE meta SET v = ? WHERE k = 'rendering_schema_version'")
        .run(String(INDEX_RENDERING_SCHEMA_VERSION))
      vectorWriter
        .prepare("UPDATE meta SET v = ? WHERE k = 'embedding_vec_cleanup_epoch'")
        .run('0')
      vectorWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      vectorWriter.close()
    }
    expect(readIndexMaintenanceState(knowledgeRoot)).toEqual({
      indexAbsent: false,
      pendingEmbeddings: 0,
      renderingEpochStale: false,
      vectorReconciliationOutstanding: true,
    })
  })

  it('fails inspection rather than treating a malformed index as healthy', () => {
    const indexDir = join(knowledgeRoot, 'memory', 'index')
    mkdirSync(indexDir, { recursive: true })
    writeFileSync(join(indexDir, INDEX_DB_FILE), 'not a sqlite database', 'utf8')

    expect(() => readIndexMaintenanceState(knowledgeRoot)).toThrow()
  })

  it('projects the latest surviving confirmation ordinal into records', async () => {
    const published = publish('Confirmation Ordinal Product', {
      createdAtOrdinal: 1,
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-confirmed-ordinal-three',
          curationJobId: 'index-confirmed-ordinal-three-job',
          buildOrdinal: 3,
          origin: 'agent-verified',
        }),
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-confirmed-ordinal-seven',
          curationJobId: 'index-confirmed-ordinal-seven-job',
          buildOrdinal: 7,
          origin: 'agent-verified',
        }),
      ],
    })

    expect(await rebuildApi().rebuildIndex({ knowledgeRoot })).toMatchObject({
      projected: 1,
      scanIssues: [],
    })

    const reader = openReader()
    try {
      expect(
        reader.db
          .prepare('SELECT last_confirmed_ordinal FROM records WHERE bundle_id = ?')
          .get(published.id),
      ).toEqual({ last_confirmed_ordinal: 7 })
    } finally {
      reader.db.close()
    }
  })

  it('marks an index stamped 1 for schema reset and fully re-projects confirmation ordinals', async () => {
    expect(INDEX_SCHEMA_VERSION).toBe(2)

    const published = publish('Schema Reset Confirmation Product', {
      createdAtOrdinal: 1,
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-schema-reset-confirmed-three',
          curationJobId: 'index-schema-reset-confirmed-three-job',
          buildOrdinal: 3,
          origin: 'agent-verified',
        }),
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-schema-reset-confirmed-seven',
          curationJobId: 'index-schema-reset-confirmed-seven-job',
          buildOrdinal: 7,
          origin: 'agent-verified',
        }),
      ],
    })
    await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })

    const dbPath = join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE)
    const previousSchema = new DatabaseSync(dbPath)
    try {
      const columns = previousSchema
        .prepare('PRAGMA table_info(records)')
        .all()
        .map((row) => String(row.name))
      if (columns.includes('last_confirmed_ordinal')) {
        previousSchema.exec('ALTER TABLE records DROP COLUMN last_confirmed_ordinal')
      }
      previousSchema
        .prepare("UPDATE meta SET v = '1' WHERE k = 'index_schema_version'")
        .run()
      previousSchema.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      previousSchema.close()
    }

    const degraded = knowledgeLocal.openKnowledgeReader(knowledgeRoot)
    try {
      expect(degraded.source).toBe('scan')
      expect(degraded.getById(published.id)?.bundleId).toBe(published.id)
    } finally {
      degraded.close()
    }
    expect(readRebuildRequest(knowledgeRoot)).toMatchObject({
      present: true,
      request: { reason: 'schema-version' },
    })

    expect(
      await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() }),
    ).toMatchObject({ projected: 1, scanIssues: [], maintenanceRemaining: false })

    const reader = openReader()
    try {
      expect(
        reader.db
          .prepare('SELECT last_confirmed_ordinal FROM records WHERE bundle_id = ?')
          .get(published.id),
      ).toEqual({ last_confirmed_ordinal: 7 })
      expect(
        reader.db
          .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
          .get(),
      ).toEqual({ v: String(INDEX_SCHEMA_VERSION) })
    } finally {
      reader.db.close()
    }
  })

  it('projects records, trust, FTS, anchors, graph edges, and pending vectors from bundles', async () => {
    const target = publish('Checkout Product', {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Checkout now' },
          { t: 'page', route: '/cart' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'checkout-product' },
        summary: 'Checkout control on the cart page',
        body: 'Selecting Checkout now opens the payment page.',
      }),
    })
    const relation: BundleRelation = {
      type: 'relates-to',
      targetId: target.id,
      addedAtOrdinal: 43,
      curationJobId: 'index-rebuild-relation-job',
    }
    const sourceAnchors: Anchor[] = [
      { t: 'el', role: 'Button', name: 'Sign in' },
      { t: 'page', route: '/login' },
      { t: 'selector', literal: '#sign-in' },
      { t: 'error', message: 'Authentication failed 401' },
      { t: 'platform', platform: 'web' },
    ]
    const source = publish('Storefront Product', {
      draft: makeBundleDraftFixture({
        anchors: sourceAnchors,
        scope: { tier: 'product', key: 'storefront-product' },
      }),
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-rebuild-confirmed',
          curationJobId: 'index-rebuild-confirmed-job',
          buildOrdinal: 43,
          origin: 'agent-verified',
        }),
      ],
      relations: [relation],
    })

    const sourceManifest = JSON.parse(
      readFileSync(join(source.dir, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    const incompleteDir = join(
      knowledgeRoot,
      'memory',
      'partial-product',
      'bundles',
      'half-written',
    )
    mkdirSync(incompleteDir, { recursive: true })
    writeFileSync(
      join(incompleteDir, 'manifest.json'),
      `${JSON.stringify({ ...sourceManifest, complete: false })}\n`,
      'utf8',
    )

    const report = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(report).toMatchObject({
      projected: 2,
      skippedIncomplete: 1,
      scanIssues: [],
      removed: 0,
      backfilled: 0,
    })

    const reader = openReader()
    try {
      const recordRows = rows(
        reader.db,
        `SELECT * FROM records ORDER BY product, bundle_id`,
      )
      expect(recordRows).toHaveLength(2)
      expect(recordRows.every((row) => row.embed_status === 'pending')).toBe(true)
      expect(recordRows.every((row) => row.embedding === null)).toBe(true)

      for (const published of [source, target]) {
        const loaded = loadBundle(published.dir)
        expect(loaded.kind).toBe('loaded')
        if (loaded.kind !== 'loaded') throw new Error(`expected loaded, got ${loaded.kind}`)
        const expectedTrust: DerivedTrustState = deriveBundleTrust(loaded.bundle)
        const projected = recordRows.find((row) => row.bundle_id === published.id)
        expect(projected).toMatchObject({
          mutable_state_hash: loaded.bundle.manifest.mutableStateHash,
          kind: loaded.bundle.frontmatter.kind,
          subtype: loaded.bundle.frontmatter.subtype ?? null,
          scope_tier: loaded.bundle.frontmatter.scope.tier,
          scope_key: loaded.bundle.frontmatter.scope.key,
          status: expectedTrust.status,
          confirmed: expectedTrust.counters.confirmed,
          contradicted: expectedTrust.counters.contradicted,
          helpful: expectedTrust.counters.helpful,
          harmful: expectedTrust.counters.harmful,
          opened_at_ordinal: expectedTrust.validity.openedAtOrdinal,
          closed_at_ordinal: expectedTrust.validity.closedAtOrdinal ?? null,
          created_at_ordinal: loaded.bundle.frontmatter.createdAtOrdinal,
          origin_class: loaded.bundle.frontmatter.originClass,
          summary: loaded.bundle.summary,
          embedding_input: loaded.bundle.manifest.embeddingInput,
        })
        expect(projected?.trust).toBeCloseTo(expectedTrust.trust)
      }

      const sourceRow = recordRows.find((row) => row.bundle_id === source.id)
      expect(sourceRow).toBeDefined()
      const sourceRowid = Number(sourceRow?.record_rowid)
      const fts = reader.db
        .prepare('SELECT rowid, identity, content FROM fts_records WHERE rowid = ?')
        .get(sourceRowid)
      expect(fts).toMatchObject({
        rowid: sourceRowid,
        content: expect.any(String),
      })
      expect(String(fts?.identity)).toContain(canonicalJson(sourceAnchors[0]))
      expect(String(fts?.identity)).toContain('#sign-in')
      expect(String(fts?.identity)).toContain('Authentication failed 401')
      expect(rows(reader.db, 'SELECT * FROM fts_records')).toHaveLength(2)
      expect(
        rows(reader.db, `SELECT * FROM anchors WHERE record_rowid = ${sourceRowid}`),
      ).toHaveLength(sourceAnchors.length)

      const recordNodeId = graphNodeId('fact', source.id)
      const elementNodeId = graphNodeId('web-element', {
        role: 'button',
        name: 'sign in',
      })
      const pageNodeId = graphNodeId('web-page', '/login')
      const targetNodeId = graphNodeId('fact', target.id)
      expect(
        reader.db.prepare('SELECT * FROM graph_nodes WHERE node_id = ?').get(recordNodeId),
      ).toMatchObject({
        node_type: 'fact',
        natural_key_json: canonicalJson(source.id),
      })
      expect(
        reader.db.prepare('SELECT * FROM graph_nodes WHERE node_id = ?').get(elementNodeId),
      ).toMatchObject({
        node_type: 'web-element',
        natural_key_json: canonicalJson({ role: 'button', name: 'sign in' }),
      })
      const graphEdges = rows(
        reader.db,
        'SELECT src_node_id, edge_type, dst_node_id FROM graph_edges',
      )
      expect(graphEdges).toEqual(
        expect.arrayContaining([
          { src_node_id: recordNodeId, edge_type: 'about', dst_node_id: elementNodeId },
          { src_node_id: elementNodeId, edge_type: 'part-of', dst_node_id: pageNodeId },
          { src_node_id: recordNodeId, edge_type: 'relates-to', dst_node_id: targetNodeId },
        ]),
      )
    } finally {
      reader.db.close()
    }
  })

  it('reconciles a relation edge when its target arrives after the source hash stabilizes', async () => {
    const product = 'Late Relation Product'
    const target = publishNamed(product, 'Late relation target')
    const stashedTargetDir = join(root, 'late-relation-target-stash')
    cpSync(target.dir, stashedTargetDir, { recursive: true })
    rmSync(target.dir, { recursive: true, force: true })

    const source = publish(product, {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Late relation source' },
          { t: 'page', route: '/late-relation-source' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'late-relation-source' },
      }),
      relations: [
        {
          type: 'relates-to',
          targetId: target.id,
          addedAtOrdinal: 52,
          curationJobId: 'index-late-relation-job',
        },
      ],
    })

    expect(await rebuildApi().rebuildIndex({ knowledgeRoot })).toMatchObject({ projected: 1 })

    const sourceNodeId = graphNodeId('fact', source.id)
    const targetNodeId = graphNodeId('fact', target.id)
    const firstReader = openReader()
    try {
      expect(
        firstReader.db
          .prepare(`
            SELECT src_node_id, edge_type, dst_node_id
            FROM graph_edges
            WHERE src_node_id = ? AND edge_type = ? AND dst_node_id = ?
          `)
          .get(sourceNodeId, 'relates-to', targetNodeId),
      ).toBeUndefined()
    } finally {
      firstReader.db.close()
    }

    cpSync(stashedTargetDir, target.dir, { recursive: true })
    const second = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(second.projected).toBe(1)

    const secondReader = openReader()
    try {
      expect(
        secondReader.db
          .prepare(`
            SELECT src_node_id, edge_type, dst_node_id
            FROM graph_edges
            WHERE src_node_id = ? AND edge_type = ? AND dst_node_id = ?
          `)
          .get(sourceNodeId, 'relates-to', targetNodeId),
      ).toEqual({
        src_node_id: sourceNodeId,
        edge_type: 'relates-to',
        dst_node_id: targetNodeId,
      })
    } finally {
      secondReader.db.close()
    }
  })

  it('stores canonical Float32 BLOBs and vec0 accelerator rows with the fake embedder', async () => {
    const published = publish('Embedded Product', {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Embed me' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'embedded-product' },
      }),
    })
    const embedder = makeFakeEmbedder()

    const report = await rebuildApi().rebuildIndex({ knowledgeRoot, embedder })
    expect(report.vec).toBe('vec0')
    expect(report.projected).toBe(1)

    const reader = openReader()
    try {
      const record = reader.db
        .prepare('SELECT record_rowid, embed_status, embedding FROM records WHERE bundle_id = ?')
        .get(published.id)
      expect(record?.embed_status).toBe('present')
      expect(record?.embedding).toBeInstanceOf(Uint8Array)
      expect((record?.embedding as Uint8Array).byteLength).toBe(
        DEFAULT_EMBEDDING_PROFILE.dim * Float32Array.BYTES_PER_ELEMENT,
      )

      const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
      const vecRow = reader.db
        .prepare(`SELECT record_rowid, product FROM ${tableName} WHERE record_rowid = ?`)
        .get(BigInt(Number(record?.record_rowid)))
      expect(vecRow).toMatchObject({
        record_rowid: Number(record?.record_rowid),
        product: slugBranch('Embedded Product'),
      })

      const expected = await embedder.embedDocument(
        String(
          reader.db
            .prepare('SELECT embedding_input FROM records WHERE bundle_id = ?')
            .get(published.id)?.embedding_input,
        ),
      )
      expect(Buffer.from(record?.embedding as Uint8Array)).toEqual(Buffer.from(expected.buffer))
    } finally {
      reader.db.close()
    }
  })

  it('refuses syntactically valid bundle content whose committed digest no longer matches', async () => {
    const published = publishNamed('Tamper Product', 'Digest guarded')
    const recordPath = join(published.dir, 'record.md')
    const recordText = readFileSync(recordPath, 'utf8')
    writeFileSync(
      recordPath,
      recordText.replace('Digest guarded control', 'Tampered but parseable control'),
      'utf8',
    )

    const report = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(report.projected).toBe(0)
    expect(report.scanIssues).toHaveLength(1)
    expect(report.scanIssues[0]).toContain('integrity')

    const reader = openReader()
    try {
      expect(rows(reader.db, 'SELECT bundle_id FROM records')).toEqual([])
    } finally {
      reader.db.close()
    }
  })

  it('projects only a mutable-hash change, preserves rowids, and consumes the rebuild marker', async () => {
    const changed = publishNamed('Incremental Product', 'Incremental changed')
    const unchanged = publishNamed('Stable Product', 'Incremental stable')
    expect(
      await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() }),
    ).toMatchObject({ projected: 2 })

    const beforeReader = openReader()
    const before = new Map(
      rows(
        beforeReader.db,
        'SELECT bundle_id, record_rowid, mutable_state_hash FROM records',
      ).map((row) => [String(row.bundle_id), row]),
    )
    beforeReader.db.close()

    expect(
      appendOutcomeEvent(
        config('Incremental Product'),
        changed.id,
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'index-incremental-confirmed',
          curationJobId: 'index-incremental-confirmed-job',
          buildOrdinal: 50,
          origin: 'agent-verified',
        }),
      ),
    ).toEqual({ kind: 'appended' })
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'fixture requests a successful rebuild',
    })
    expect(readRebuildRequest(knowledgeRoot).present).toBe(true)

    const report = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(report).toMatchObject({
      projected: 1,
      backfilled: 0,
      removed: 0,
      pendingEmbeddings: 0,
      maintenanceRemaining: false,
    })
    expect(readRebuildRequest(knowledgeRoot)).toEqual({ present: false })

    const afterReader = openReader()
    try {
      const after = new Map(
        rows(
          afterReader.db,
          `SELECT bundle_id, record_rowid, mutable_state_hash, confirmed
           FROM records`,
        ).map((row) => [String(row.bundle_id), row]),
      )
      expect(after.get(changed.id)?.record_rowid).toBe(before.get(changed.id)?.record_rowid)
      expect(after.get(unchanged.id)?.record_rowid).toBe(before.get(unchanged.id)?.record_rowid)
      expect(after.get(changed.id)?.mutable_state_hash).not.toBe(
        before.get(changed.id)?.mutable_state_hash,
      )
      expect(after.get(changed.id)?.confirmed).toBe(1)
      expect(after.get(unchanged.id)?.mutable_state_hash).toBe(
        before.get(unchanged.id)?.mutable_state_hash,
      )
    } finally {
      afterReader.db.close()
    }
  })

  it('retains a rebuild marker until pending embeddings converge', async () => {
    const published = publishNamed('Marker Retention Product', 'Marker retention')
    requestRebuild({
      knowledgeRoot,
      reason: 'corrupt',
      detail: 'fixture retains intent until dense maintenance converges',
    })

    const lexicalOnly = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(lexicalOnly).toMatchObject({
      projected: 1,
      backfilled: 0,
      pendingEmbeddings: 1,
      maintenanceRemaining: true,
    })
    expect(readRebuildRequest(knowledgeRoot).present).toBe(true)

    const ready = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
    })
    expect(ready).toMatchObject({
      projected: 0,
      backfilled: 1,
      pendingEmbeddings: 0,
      maintenanceRemaining: false,
    })
    expect(readRebuildRequest(knowledgeRoot)).toEqual({ present: false })

    const reader = openReader()
    try {
      expect(
        reader.db
          .prepare('SELECT bundle_id, embed_status FROM records WHERE bundle_id = ?')
          .get(published.id),
      ).toEqual({ bundle_id: published.id, embed_status: 'present' })
    } finally {
      reader.db.close()
    }
  })

  it('backfills every pending vector independently when no bundle hash changed', async () => {
    publishNamed('Backfill Product A', 'Backfill first')
    publishNamed('Backfill Product B', 'Backfill second')
    const first = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(first).toMatchObject({ projected: 2, backfilled: 0 })

    const pendingReader = openReader()
    const pendingRows = rows(
      pendingReader.db,
      'SELECT record_rowid, embed_status, embedding FROM records ORDER BY record_rowid',
    )
    pendingReader.db.close()
    expect(pendingRows.map((row) => row.embed_status)).toEqual(['pending', 'pending'])
    expect(pendingRows.every((row) => row.embedding === null)).toBe(true)

    const base = makeFakeEmbedder()
    let documentCalls = 0
    const countingEmbedder: knowledgeLocal.EmbedderPort = {
      async embedDocument(rendering) {
        documentCalls += 1
        return base.embedDocument(rendering)
      },
      embedQuery: (rendering) => base.embedQuery(rendering),
    }
    const second = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      embedder: countingEmbedder,
    })
    expect(second).toMatchObject({ projected: 0, backfilled: 2, removed: 0 })
    expect(documentCalls).toBe(2)

    const presentReader = openReader()
    try {
      const presentRows = rows(
        presentReader.db,
        'SELECT record_rowid, embed_status, embedding FROM records ORDER BY record_rowid',
      )
      expect(presentRows.map((row) => row.record_rowid)).toEqual(
        pendingRows.map((row) => row.record_rowid),
      )
      expect(presentRows.every((row) => row.embed_status === 'present')).toBe(true)
      expect(presentRows.every((row) => row.embedding instanceof Uint8Array)).toBe(true)
      const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
      expect(rows(presentReader.db, `SELECT record_rowid FROM ${tableName}`)).toHaveLength(2)
    } finally {
      presentReader.db.close()
    }
  })

  for (const deadStatus of ['superseded', 'deprecated'] as const) {
    it(`structurally scrubs ${deadStatus} recall rows on every projection`, async () => {
      const product = `Structural Forgetting ${deadStatus} Product`
      const target = publishNamed(product, `${deadStatus} live target`)
      const deadSummary = `${deadStatus} poisoned trigger`
      const dead = publish(product, {
        draft: makeBundleDraftFixture({
          kind: 'caution',
          anchors: [
            { t: 'error', message: `${deadStatus} poisoned trigger error` },
            { t: 'page', route: `/structural-forgetting/${deadStatus}` },
            { t: 'platform', platform: 'web' },
          ],
          scope: { tier: 'product', key: `structural-forgetting-${deadStatus}` },
          summary: deadSummary,
          body: 'This withdrawn trigger must never remain reachable through a recall row.',
        }),
        discriminant: makeDiscriminantFixture('caution'),
        relations: [
          {
            type: 'relates-to',
            targetId: target.id,
            addedAtOrdinal: 7,
            curationJobId: `${deadStatus}-dead-source-relation-job`,
          },
        ],
        distilledObservations: [
          {
            schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
            step: { naturalKey: `${deadStatus} poisoned step`, ordinal: 0 },
            platform: 'web',
            test: { id: `${deadStatus}-poisoned-test` },
            error: {
              naturalKey: `${deadStatus} poisoned error`,
              rootCauseClass: 'timeout',
            },
            observedAtOrdinal: 7,
          },
        ],
      })
      const liveSource = publish(product, {
        draft: makeBundleDraftFixture({
          anchors: [
            { t: 'el', role: 'Button', name: `${deadStatus} live source` },
            { t: 'page', route: `/structural-forgetting/${deadStatus}/source` },
            { t: 'platform', platform: 'web' },
          ],
          scope: { tier: 'product', key: `structural-forgetting-${deadStatus}-source` },
          summary: `${deadStatus} live source`,
          body: 'This live neighbor must survive when the poisoned caution is withdrawn.',
        }),
        relations: [
          {
            type: 'relates-to',
            targetId: dead.id,
            addedAtOrdinal: 8,
            curationJobId: `${deadStatus}-live-source-relation-job`,
          },
        ],
      })

      expect(
        await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() }),
      ).toMatchObject({ projected: 3, pendingEmbeddings: 0 })

      const deadNodeId = graphNodeId('caution', dead.id)
      const initialReader = openReader()
      const deadRow = initialReader.db
        .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
        .get(dead.id)
      expect(deadRow).toBeDefined()
      const deadRowid = Number(deadRow?.record_rowid)
      try {
        expect(
          initialReader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?').get(deadRowid),
        ).toBeDefined()
        expect(
          initialReader.db
            .prepare(`
              SELECT situating_line
              FROM records
              WHERE bundle_id = ?
            `)
            .get(liveSource.id)?.situating_line,
        ).toContain(deadSummary)
        expect(
          initialReader.db
            .prepare(`
              SELECT 1
              FROM graph_edges
              WHERE record_rowid = ? OR src_node_id = ? OR dst_node_id = ?
              LIMIT 1
            `)
            .get(deadRowid, deadNodeId, deadNodeId),
        ).toBeDefined()
      } finally {
        initialReader.db.close()
      }

      const event = BundleOutcomeEventSchema.parse(deadStatus === 'superseded'
        ? {
            type: 'superseded',
            evidenceToken: 'index-structural-forgetting-superseded',
            curationJobId: 'index-structural-forgetting-superseded-job',
            buildOrdinal: 50,
            byRecordId: target.id,
          }
        : {
            type: 'deprecated',
            evidenceToken: 'index-structural-forgetting-deprecated',
            curationJobId: 'index-structural-forgetting-deprecated-job',
            buildOrdinal: 50,
            reason: 'withdraw poisoned trigger',
          })
      expect(appendOutcomeEvent(config(product), dead.id, event)).toEqual({ kind: 'appended' })

      projectBundleIndexRow({ knowledgeRoot, bundleId: dead.id })

      function expectScrubbed(): void {
        const reader = openReader()
        try {
          const projected = reader.db
            .prepare(`
              SELECT status, embed_status, embedding
              FROM records
              WHERE bundle_id = ?
            `)
            .get(dead.id)
          expect(projected?.status).toBe(deadStatus)
          expect(projected?.embed_status).toBe(EMBED_STATUS_SCRUBBED)
          expect(projected?.embedding).toBeNull()
          expect(
            reader.db
              .prepare('SELECT COUNT(*) AS count FROM anchors WHERE record_rowid = ?')
              .get(deadRowid)?.count,
          ).toBe(3)
          expect(
            reader.db.prepare('SELECT 1 FROM fts_records WHERE rowid = ?').get(deadRowid),
          ).toBeUndefined()
          expect(
            reader.db
              .prepare(`
                SELECT 1
                FROM ${knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)}
                WHERE record_rowid = ?
              `)
              .get(BigInt(deadRowid)),
          ).toBeUndefined()
          expect(
            reader.db
              .prepare(`
                SELECT 1
                FROM graph_edges
                WHERE record_rowid = ? OR src_node_id = ? OR dst_node_id = ?
                LIMIT 1
              `)
              .get(deadRowid, deadNodeId, deadNodeId),
          ).toBeUndefined()
          expect(
            reader.db.prepare('SELECT 1 FROM graph_nodes WHERE node_id = ?').get(deadNodeId),
          ).toBeUndefined()
          expect(
            reader.db
              .prepare('SELECT situating_line FROM records WHERE bundle_id = ?')
              .get(liveSource.id)?.situating_line,
          ).not.toContain(deadSummary)
        } finally {
          reader.db.close()
        }
      }

      expectScrubbed()

      const staleRenderingWriter = new DatabaseSync(
        join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE),
      )
      try {
        staleRenderingWriter
          .prepare("UPDATE meta SET v = ? WHERE k = 'rendering_schema_version'")
          .run(String(INDEX_RENDERING_SCHEMA_VERSION - 1))
        staleRenderingWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } finally {
        staleRenderingWriter.close()
      }

      const embeddedRenderings: string[] = []
      const baseEmbedder = makeFakeEmbedder()
      const recordingEmbedder: knowledgeLocal.EmbedderPort = {
        async embedDocument(rendering) {
          embeddedRenderings.push(rendering)
          return baseEmbedder.embedDocument(rendering)
        },
        embedQuery: (rendering) => baseEmbedder.embedQuery(rendering),
      }
      expect(
        await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: recordingEmbedder }),
      ).toMatchObject({ projected: 0, pendingEmbeddings: 0 })
      expect(embeddedRenderings.every((rendering) => !rendering.includes(deadSummary))).toBe(true)
      expectScrubbed()
    })
  }

  it('keeps the suppressed terminal value when a suppressed row is structurally scrubbed', async () => {
    const product = 'Dual Suppression Terminal Product'
    const target = publishNamed(product, 'Dual suppression live replacement')
    const victim = publishNamed(product, 'Dual suppression redacted victim')

    projectBundleIndexRow({ knowledgeRoot, bundleId: victim.id })
    // nothing writes the terminal value now; an old row may hold it.
    const legacyWriter = new DatabaseSync(join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE))
    try {
      legacyWriter
        .prepare('UPDATE records SET embed_status = ?, embedding = NULL WHERE bundle_id = ?')
        .run(EMBED_STATUS_SUPPRESSED, victim.id)
      legacyWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      legacyWriter.close()
    }

    const reader = openReader()
    try {
      expect(
        reader.db
          .prepare('SELECT embed_status FROM records WHERE bundle_id = ?')
          .get(victim.id)?.embed_status,
      ).toBe(EMBED_STATUS_SUPPRESSED)
    } finally {
      reader.db.close()
    }

    expect(
      appendOutcomeEvent(
        config(product),
        victim.id,
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'dual-suppression-superseded',
          curationJobId: 'dual-suppression-superseded-job',
          buildOrdinal: 50,
          byRecordId: target.id,
        }),
      ),
    ).toEqual({ kind: 'appended' })

    projectBundleIndexRow({ knowledgeRoot, bundleId: victim.id })

    const scrubbedReader = openReader()
    try {
      expect(
        scrubbedReader.db
          .prepare('SELECT status, embed_status, embedding FROM records WHERE bundle_id = ?')
          .get(victim.id),
      ).toMatchObject({
        status: 'superseded',
        embed_status: EMBED_STATUS_SUPPRESSED,
        embedding: null,
      })
    } finally {
      scrubbedReader.db.close()
    }
  })

  it('removes deleted bundle projections, incoming edges, vec rows, and orphan nodes', async () => {
    const target = publishNamed('Removal Target Product', 'Removal target')
    const source = publish('Removal Source Product', {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Removal source' },
          { t: 'page', route: '/removal-source' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: 'removal-source' },
      }),
      relations: [
        {
          type: 'relates-to',
          targetId: target.id,
          addedAtOrdinal: 51,
          curationJobId: 'index-removal-relation-job',
        },
      ],
    })
    expect(
      await rebuildApi().rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() }),
    ).toMatchObject({ projected: 2, backfilled: 0, removed: 0 })

    const beforeReader = openReader()
    const targetRow = beforeReader.db
      .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
      .get(target.id)
    expect(targetRow).toBeDefined()
    beforeReader.db.close()

    rmSync(target.dir, { recursive: true, force: true })
    const report = await rebuildApi().rebuildIndex({ knowledgeRoot })
    expect(report).toMatchObject({ projected: 0, removed: 1, backfilled: 0 })

    const afterReader = openReader()
    try {
      const targetNodeId = graphNodeId('fact', target.id)
      expect(
        afterReader.db.prepare('SELECT 1 FROM records WHERE bundle_id = ?').get(target.id),
      ).toBeUndefined()
      expect(
        afterReader.db
          .prepare('SELECT 1 FROM fts_records WHERE rowid = ?')
          .get(Number(targetRow?.record_rowid)),
      ).toBeUndefined()
      expect(
        afterReader.db
          .prepare('SELECT 1 FROM anchors WHERE record_rowid = ?')
          .get(Number(targetRow?.record_rowid)),
      ).toBeUndefined()
      const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
      expect(
        afterReader.db
          .prepare(`SELECT 1 FROM ${tableName} WHERE record_rowid = ?`)
          .get(BigInt(Number(targetRow?.record_rowid))),
      ).toBeUndefined()
      expect(
        afterReader.db
          .prepare(
            `SELECT 1 FROM graph_edges
             WHERE record_rowid = ? OR src_node_id = ? OR dst_node_id = ?`,
          )
          .get(Number(targetRow?.record_rowid), targetNodeId, targetNodeId),
      ).toBeUndefined()
      expect(
        afterReader.db.prepare('SELECT 1 FROM graph_nodes WHERE node_id = ?').get(targetNodeId),
      ).toBeUndefined()
      expect(
        afterReader.db.prepare('SELECT 1 FROM records WHERE bundle_id = ?').get(source.id),
      ).toBeDefined()
    } finally {
      afterReader.db.close()
    }
  })

  it('reconciles canonical brute BLOBs into vec0 without calling the embedder again', async () => {
    const published = publishNamed('Reconcile Product', 'Reconcile vector')
    const brute = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      embedder: makeFakeEmbedder(),
      vecLoadablePath: '/nonexistent/forced-brute-vec0.dylib',
    })
    expect(brute).toMatchObject({ vec: 'brute', projected: 1, backfilled: 0 })

    const throwingEmbedder: knowledgeLocal.EmbedderPort = {
      async embedDocument() {
        throw new Error('reconciliation must not call embedDocument')
      },
      async embedQuery() {
        throw new Error('reconciliation must not call embedQuery')
      },
    }
    const reconciled = await rebuildApi().rebuildIndex({
      knowledgeRoot,
      embedder: throwingEmbedder,
    })
    expect(reconciled).toMatchObject({ vec: 'vec0', projected: 0, backfilled: 0 })

    const reader = openReader()
    try {
      const record = reader.db
        .prepare('SELECT record_rowid, embed_status, embedding FROM records WHERE bundle_id = ?')
        .get(published.id)
      expect(record).toMatchObject({ embed_status: 'present' })
      expect(record?.embedding).toBeInstanceOf(Uint8Array)
      const tableName = knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)
      expect(
        reader.db
          .prepare(`SELECT product FROM ${tableName} WHERE record_rowid = ?`)
          .get(BigInt(Number(record?.record_rowid))),
      ).toEqual({ product: slugBranch('Reconcile Product') })
    } finally {
      reader.db.close()
    }
  })
})

describe('suppressed lexical-only embedding status', () => {
  it('persists as terminal and is excluded from the pending-vector selector', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE records (
          record_rowid INTEGER PRIMARY KEY,
          bundle_id TEXT NOT NULL,
          contextual_rendering TEXT NOT NULL,
          embed_status TEXT NOT NULL
        )
      `)
      const insert = db.prepare(`
        INSERT INTO records (bundle_id, contextual_rendering, embed_status)
        VALUES (?, ?, ?)
      `)
      insert.run('pending-bundle', 'pending rendering', EMBED_STATUS_PENDING)
      insert.run('suppressed-bundle', 'redacted lexical rendering', EMBED_STATUS_SUPPRESSED)

      expect(
        db.prepare('SELECT embed_status FROM records WHERE bundle_id = ?')
          .get('suppressed-bundle'),
      ).toEqual({ embed_status: EMBED_STATUS_SUPPRESSED })
      expect(selectPendingEmbeddingRows(db)).toEqual([
        {
          record_rowid: 1,
          bundle_id: 'pending-bundle',
          contextual_rendering: 'pending rendering',
        },
      ])
    } finally {
      db.close()
    }
  })
})
