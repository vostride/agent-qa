/**
 * D-06/D-07/D-08 degrading reader facade for IDX-02 and memory.md §8.2.
 *
 * Index health is resolved at open and every later index operation is guarded. Any unhealthy state
 * permanently swaps the facade to an authoritative bundle scan plus a durable rebuild request,
 * while healthy readers stay read-only and query-only through openIndexReaderConnection. This
 * module never acquires the writer role or rebuilds inline.
 *
 * ONE ladder, ONE core, two callers (407 D-17, 407-13 CR-02): `classifyIndexFaceWithConnection`
 * runs the degrade ladder exactly once per call and hands back the live connection on the healthy
 * arm. `classifyIndexFace` is the PROBE wrapper — it releases that connection and writes nothing,
 * so `doctor`, the retrieval-rung resolver and the local composition root can ask about the index
 * without mutating it or leaking a handle. `openKnowledgeReader` is the SERVING facade — it KEEPS
 * the connection the ladder blessed and owns the marker write. The facade never closes what it is
 * about to reopen, so there is no window in which contention can degrade a healthy index.
 */
import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  canonicalJson,
  normalizeAnchor,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleRelation,
  OriginClass,
  ScopeKey,
  VettedCandidateInput,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from './bundle-read.js'
import {
  isServable,
  scanBundleById,
  scanBundles,
  scanBundlesForRetrieval,
} from './bundle-scan.js'
import type { KnowledgeHit } from './bundle-scan.js'
import {
  indexDbPath,
  isEmbeddingVecCleanupCurrent,
  openIndexReaderConnection,
  probeIndexHealth,
  resolveActiveProfile,
  vecTableName,
} from './index-open.js'
import type { IndexReaderConnection, VecCapability } from './index-open.js'
import { requestRebuild } from './rebuild-marker.js'
import type { RebuildReason } from './rebuild-marker.js'
import { buildLexicalMatchExpression } from './retrieval/fts-match.js'
import { assemblePromotionGateInput } from './promotion-gate-input.js'
import {
  effectivePriorDigest,
  indexTrustEpochMatches,
  TrustPriorEpochMismatch,
} from './trust-prior-context.js'

export interface KnowledgeSearchOptions {
  product?: string
  k?: number
}

export interface DenseSearchOptions extends KnowledgeSearchOptions {
  k: number
}

export type DenseHit = KnowledgeHit & { distance: number }

export interface KnowledgeReader {
  /** Current serving face; permanently changes to scan after an index operation failure. */
  readonly source: 'index' | 'scan'
  /** Current vector capability; changes to none when the serving face degrades to scan. */
  readonly vec: VecCapability | 'none'
  getById(bundleId: string): KnowledgeHit | undefined
  searchLexical(text: string, opts?: KnowledgeSearchOptions): KnowledgeHit[]
  lookupAnchor(anchor: Anchor, opts?: KnowledgeSearchOptions): KnowledgeHit[]
  searchDense(embedding: Float32Array, opts: DenseSearchOptions): DenseHit[]
  recheck(hits: readonly KnowledgeHit[]): KnowledgeHit[]
  close(): void
}

/** Internal bundle-truth shape consumed by retrieve.ts; deliberately absent from the barrel. */
export type AuthoritativeKnowledgeHit<THit extends KnowledgeHit = KnowledgeHit> = Omit<
  THit,
  | keyof KnowledgeHit
  | 'anchors'
  | 'scope'
  | 'createdAtOrdinal'
  | 'originClass'
  | 'relations'
> & KnowledgeHit & {
  anchors: Anchor[]
  scope: ScopeKey
  createdAtOrdinal: number
  originClass: OriginClass
  relations: readonly BundleRelation[]
  lastConfirmedOrdinal: number
  vettedCandidateInput: VettedCandidateInput
}

/** Internal snapshot context that lets the public retrieve function compose on this facade. */
export interface KnowledgeRetrievalContext {
  readonly knowledgeRoot: string
  readonly source: 'index' | 'scan'
  readonly vec: VecCapability | 'none'
  readonly connection: IndexReaderConnection | undefined
  readonly reader: KnowledgeReader
  readonly scan:
    | ((text: string | undefined, anchor: Anchor | undefined) => KnowledgeHit[])
    | undefined
  recheck<THit extends KnowledgeHit>(
    hits: readonly THit[],
    audit: boolean,
  ): Array<AuthoritativeKnowledgeHit<THit>>
}

export type KnowledgeRetrievalOperation<TResult> = (
  context: KnowledgeRetrievalContext,
) => TResult | Promise<TResult>

interface IndexedRecord {
  hit: KnowledgeHit
  recordRowid: number
  lastConfirmedOrdinal: number
}

type RefreshedHit<THit extends KnowledgeHit> = Omit<THit, keyof KnowledgeHit> & KnowledgeHit

const RUN_RETRIEVAL = Symbol('knowledge-reader.run-retrieval')

interface InternalKnowledgeReader extends KnowledgeReader {
  [RUN_RETRIEVAL]<TResult>(operation: KnowledgeRetrievalOperation<TResult>): Promise<TResult>
}

const RECORD_COLUMNS = `
  r.record_rowid,
  r.bundle_id,
  r.product,
  r.kind,
  r.subtype,
  r.status,
  r.trust,
  r.last_confirmed_ordinal,
  r.opened_at_ordinal,
  r.closed_at_ordinal,
  r.summary,
  r.embedding_input
`

const MAX_SQL_LIMIT = 2_147_483_647

export interface OpenKnowledgeReaderOptions {
  /** D-12 test seam. Production callers resolve sqlite-vec's pinned prebuild. */
  vecLoadablePath?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lockedReason(detail: string): boolean {
  return /locked|busy/i.test(detail)
}

function requestRebuildBestEffort(
  knowledgeRoot: string,
  reason: RebuildReason,
  detail: string,
): void {
  try {
    requestRebuild({ knowledgeRoot, reason, detail })
  } catch {
    // D-07 is an operations signal, not a serving gate. Bundle truth remains available.
  }
}

function closeBestEffort(connection: IndexReaderConnection): void {
  try {
    connection.db.close()
  } catch {
    // Preserve the health failure that selected authoritative scan mode.
  }
}

function queryLimit(k: number | undefined): number {
  if (k === undefined || k === Number.POSITIVE_INFINITY) return MAX_SQL_LIMIT
  if (!Number.isFinite(k)) return 0
  return Math.min(MAX_SQL_LIMIT, Math.max(0, Math.floor(k)))
}

function rowToIndexedRecord(row: Record<string, unknown>): IndexedRecord {
  const closedAt = row.closed_at_ordinal
  const lastConfirmed = row.last_confirmed_ordinal
  return {
    recordRowid: Number(row.record_rowid),
    lastConfirmedOrdinal: Number(
      lastConfirmed === null || lastConfirmed === undefined
        ? row.opened_at_ordinal
        : lastConfirmed,
    ),
    hit: {
      bundleId: String(row.bundle_id),
      product: String(row.product),
      kind: String(row.kind) as KnowledgeHit['kind'],
      subtype: row.subtype === null || row.subtype === undefined
        ? null
        : String(row.subtype),
      status: String(row.status) as KnowledgeHit['status'],
      trust: Number(row.trust),
      validity: {
        openedAtOrdinal: Number(row.opened_at_ordinal),
        ...(closedAt === null || closedAt === undefined
          ? {}
          : { closedAtOrdinal: Number(closedAt) }),
      },
      summary: String(row.summary),
      embeddingInput: String(row.embedding_input),
    },
  }
}

function safeBundleDir(knowledgeRoot: string, hit: KnowledgeHit): string | undefined {
  if (
    hit.product === ''
    || hit.product === '.'
    || hit.product === '..'
    || hit.product !== basename(hit.product)
    || hit.bundleId === ''
    || hit.bundleId === '.'
    || hit.bundleId === '..'
    || hit.bundleId !== basename(hit.bundleId)
  ) {
    return undefined
  }
  return join(knowledgeRoot, 'memory', hit.product, 'bundles', hit.bundleId)
}

/** D-09: refresh complete truth from a digest-verified bundle and preserve ranking metadata. */
function recheckAuthoritativeHits<THit extends KnowledgeHit>(
  knowledgeRoot: string,
  hits: readonly THit[],
  audit: boolean,
): Array<AuthoritativeKnowledgeHit<THit>> {
  const refreshed: Array<AuthoritativeKnowledgeHit<THit>> = []
  for (const hit of hits) {
    const bundleDir = safeBundleDir(knowledgeRoot, hit)
    if (bundleDir === undefined) continue

    try {
      if (!verifyBundleIntegrity(bundleDir).ok) continue
      const outcome = loadBundle(bundleDir)
      if (outcome.kind !== 'loaded' || outcome.bundle.manifest.id !== hit.bundleId) continue
      const trust = deriveBundleTrust(outcome.bundle)
      if (!audit && !isServable(trust)) continue

      refreshed.push({
        ...hit,
        kind: outcome.bundle.frontmatter.kind,
        subtype: outcome.bundle.frontmatter.subtype ?? null,
        status: trust.status,
        trust: trust.trust,
        validity: trust.validity,
        summary: outcome.bundle.summary,
        embeddingInput: outcome.bundle.manifest.embeddingInput,
        anchors: outcome.bundle.frontmatter.anchors.map(({ normalized }) => normalized),
        scope: outcome.bundle.frontmatter.scope,
        createdAtOrdinal: outcome.bundle.frontmatter.createdAtOrdinal,
        originClass: outcome.bundle.frontmatter.originClass,
        relations: outcome.bundle.relations.relations,
        lastConfirmedOrdinal: trust.lastConfirmedOrdinal,
        vettedCandidateInput: assemblePromotionGateInput({
          knowledgeRoot,
          bundleDir,
          bundle: outcome.bundle,
        }),
      } as AuthoritativeKnowledgeHit<THit>)
    } catch {
      // A changing, unreadable, or invalid bundle is never safe to serve from a stale index row.
    }
  }
  return refreshed
}

/** Serving recheck retains the historical KnowledgeHit runtime surface. */
function recheckHits<THit extends KnowledgeHit>(
  knowledgeRoot: string,
  hits: readonly THit[],
): Array<RefreshedHit<THit>> {
  return recheckAuthoritativeHits(knowledgeRoot, hits, false).map((hit) => {
    const {
      anchors: _anchors,
      scope: _scope,
      createdAtOrdinal: _createdAtOrdinal,
      originClass: _originClass,
      relations: _relations,
      lastConfirmedOrdinal: _lastConfirmedOrdinal,
      vettedCandidateInput: _vettedCandidateInput,
      ...refreshed
    } = hit
    return refreshed as unknown as RefreshedHit<THit>
  })
}

function recordByRowidWithActiveEmbedding(
  db: DatabaseSync,
  recordRowid: number,
  product: string,
  expectedBytes: number,
): IndexedRecord | undefined {
  const row = db.prepare(`
    SELECT ${RECORD_COLUMNS}
    FROM records r
    WHERE r.record_rowid = ?
      AND r.product = ?
      AND r.embed_status = 'present'
      AND r.embedding IS NOT NULL
      AND length(r.embedding) = ?
  `).get(recordRowid, product, expectedBytes)
  return row === undefined
    ? undefined
    : rowToIndexedRecord(row as Record<string, unknown>)
}

function withReadSnapshot<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the SQL or commit error that caused the rollback.
    }
    throw error
  }
}

async function withAsyncReadSnapshot<T>(
  db: DatabaseSync,
  operation: () => T | Promise<T>,
): Promise<T> {
  db.exec('BEGIN')
  try {
    const result = await operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the SQL, async operation, or commit error that caused the rollback.
    }
    throw error
  }
}

function float32View(value: unknown): Float32Array | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return undefined
  }
  const alignedCopy = Uint8Array.from(value)
  return new Float32Array(alignedCopy.buffer)
}

function cosineDistance(query: Float32Array, candidate: Float32Array): number | undefined {
  if (candidate.length !== query.length) return undefined
  let dot = 0
  for (let index = 0; index < query.length; index += 1) {
    dot += query[index]! * candidate[index]!
  }
  return 1 - dot
}

function scanReader(knowledgeRoot: string): InternalKnowledgeReader {
  const reader: InternalKnowledgeReader = {
    source: 'scan',
    vec: 'none',
    getById(bundleId): KnowledgeHit | undefined {
      return scanBundleById({ knowledgeRoot, bundleId })
    },
    searchLexical(text, opts = {}): KnowledgeHit[] {
      return scanBundles({ knowledgeRoot, text, ...opts })
    },
    lookupAnchor(anchor, opts = {}): KnowledgeHit[] {
      // D-16: vec:none is the only reader rung allowed to widen beyond full identity.
      // Normalize through the schema authority before the scan compares role + name.
      return scanBundles({ knowledgeRoot, anchor: normalizeAnchor(anchor), ...opts })
    },
    searchDense(): DenseHit[] {
      return []
    },
    recheck(hits): KnowledgeHit[] {
      return recheckHits(knowledgeRoot, hits)
    },
    close(): void {},
    async [RUN_RETRIEVAL]<TResult>(
      operation: KnowledgeRetrievalOperation<TResult>,
    ): Promise<TResult> {
      return operation({
        knowledgeRoot,
        source: 'scan',
        vec: 'none',
        connection: undefined,
        reader,
        scan: (text, anchor) => scanBundlesForRetrieval({
          knowledgeRoot,
          ...(text === undefined ? {} : { text }),
          ...(anchor === undefined ? {} : { anchor }),
        }),
        recheck: (hits, audit) => recheckAuthoritativeHits(knowledgeRoot, hits, audit),
      })
    },
  }
  return reader
}

function indexReader(
  knowledgeRoot: string,
  connection: IndexReaderConnection,
): InternalKnowledgeReader {
  let closed = false
  const { db } = connection
  const activeProfile = resolveActiveProfile(db)
  const priorDigest = effectivePriorDigest()
  let snapshotDepth = 0

  function assertTrustEpoch(): void {
    if (!indexTrustEpochMatches(db, priorDigest)) throw new TrustPriorEpochMismatch()
  }

  function readSnapshot<TResult>(operation: () => TResult): TResult {
    // Calls made through a retrieval context share its already-pinned WAL snapshot.
    if (snapshotDepth > 0) return operation()
    return withReadSnapshot(db, () => {
      assertTrustEpoch()
      snapshotDepth += 1
      try {
        return operation()
      } finally {
        snapshotDepth -= 1
      }
    })
  }

  function recheckCurrent<THit extends KnowledgeHit>(
    hits: readonly THit[],
  ): Array<RefreshedHit<THit>> {
    return recheckHits(knowledgeRoot, hits)
  }

  function denseVec0(embedding: Float32Array, opts: DenseSearchOptions): DenseHit[] {
    const k = queryLimit(opts.k)
    if (k === 0) return []

    const queryBlob = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    )
    const tableName = vecTableName(activeProfile)
    const expectedBytes = activeProfile.dim * Float32Array.BYTES_PER_ELEMENT

    return readSnapshot(() => {
      // The trust epoch and vector cleanup stamp must share the MATCH snapshot.
      if (!isEmbeddingVecCleanupCurrent(db)) return []

      const products = opts.product === undefined
        ? db.prepare(`
            SELECT DISTINCT r.product
            FROM records r
            WHERE r.embed_status = 'present'
              AND r.embedding IS NOT NULL
              AND length(r.embedding) = ?
            ORDER BY r.product
          `).all(expectedBytes).map((row) => String(row.product))
        : [opts.product]
      const knn = db.prepare(`
        SELECT record_rowid, distance
        FROM ${tableName}
        WHERE embedding MATCH ? AND product = ? AND k = ?
        ORDER BY distance
      `)
      const candidates: Array<{
        distance: number
        product: string
        recordRowid: number
      }> = []
      for (const product of products) {
        for (const row of knn.all(queryBlob, product, k)) {
          candidates.push({
            recordRowid: Number(row.record_rowid),
            product,
            distance: Number(row.distance),
          })
        }
      }
      candidates.sort(
        (left, right) => left.distance - right.distance || left.recordRowid - right.recordRowid,
      )

      return candidates.slice(0, k).flatMap(({ distance, product, recordRowid }) => {
        const record = recordByRowidWithActiveEmbedding(
          db,
          recordRowid,
          product,
          expectedBytes,
        )
        return record === undefined ? [] : [{ ...record.hit, distance }]
      })
    })
  }

  function denseBrute(embedding: Float32Array, opts: DenseSearchOptions): DenseHit[] {
    const k = queryLimit(opts.k)
    if (k === 0) return []

    const rows = opts.product === undefined
      ? db.prepare(`
          SELECT ${RECORD_COLUMNS}, r.embedding
          FROM records r
          WHERE r.embedding IS NOT NULL
          ORDER BY r.record_rowid
        `).all()
      : db.prepare(`
          SELECT ${RECORD_COLUMNS}, r.embedding
          FROM records r
          WHERE r.embedding IS NOT NULL AND r.product = ?
          ORDER BY r.record_rowid
        `).all(opts.product)
    const candidates: Array<{ distance: number; record: IndexedRecord }> = []
    for (const row of rows) {
      const vector = float32View(row.embedding)
      if (vector === undefined) continue
      const distance = cosineDistance(embedding, vector)
      if (distance === undefined) continue
      candidates.push({
        record: rowToIndexedRecord(row as Record<string, unknown>),
        distance,
      })
    }
    candidates.sort(
      (left, right) => left.distance - right.distance
        || left.record.recordRowid - right.record.recordRowid,
    )
    const hits = candidates
      .slice(0, k)
      .map(({ distance, record }) => ({ ...record.hit, distance }))
    return hits
  }

  const reader: InternalKnowledgeReader = {
    source: 'index',
    vec: connection.vec,
    getById(bundleId): KnowledgeHit | undefined {
      const row = db.prepare(`
        SELECT ${RECORD_COLUMNS}
        FROM records r
        WHERE r.bundle_id = ?
      `).get(bundleId)
      if (row === undefined) return undefined
      return recheckCurrent([rowToIndexedRecord(row as Record<string, unknown>).hit])[0]
    },
    searchLexical(text, opts = {}): KnowledgeHit[] {
      const k = queryLimit(opts.k)
      if (k === 0) return []
      const match = buildLexicalMatchExpression(text)
      const rows = match === ''
        ? opts.product === undefined
          ? db.prepare(`
              SELECT ${RECORD_COLUMNS}
              FROM records r
              ORDER BY r.record_rowid
              LIMIT ?
            `).all(k)
          : db.prepare(`
              SELECT ${RECORD_COLUMNS}
              FROM records r
              WHERE r.product = ?
              ORDER BY r.record_rowid
              LIMIT ?
            `).all(opts.product, k)
        : opts.product === undefined
          ? db.prepare(`
              SELECT ${RECORD_COLUMNS}
              FROM fts_records
              JOIN records r ON r.record_rowid = fts_records.rowid
              WHERE fts_records MATCH ?
              ORDER BY bm25(fts_records), r.bundle_id
              LIMIT ?
            `).all(match, k)
          : db.prepare(`
              SELECT ${RECORD_COLUMNS}
              FROM fts_records
              JOIN records r ON r.record_rowid = fts_records.rowid
              WHERE fts_records MATCH ? AND r.product = ?
              ORDER BY bm25(fts_records), r.bundle_id
              LIMIT ?
            `).all(match, opts.product, k)
      return recheckCurrent(
        rows.map((row) => rowToIndexedRecord(row as Record<string, unknown>).hit),
      )
    },
    lookupAnchor(anchor, opts = {}): KnowledgeHit[] {
      const k = queryLimit(opts.k)
      if (k === 0) return []
      const normalized = canonicalJson(normalizeAnchor(anchor))
      const rows = opts.product === undefined
        ? db.prepare(`
            SELECT DISTINCT ${RECORD_COLUMNS}
            FROM anchors a
            JOIN records r ON r.record_rowid = a.record_rowid
            WHERE a.normalized_json = ?
            ORDER BY r.record_rowid
            LIMIT ?
          `).all(normalized, k)
        : db.prepare(`
            SELECT DISTINCT ${RECORD_COLUMNS}
            FROM anchors a
            JOIN records r ON r.record_rowid = a.record_rowid
            WHERE a.normalized_json = ? AND r.product = ?
            ORDER BY r.record_rowid
            LIMIT ?
          `).all(normalized, opts.product, k)
      return recheckCurrent(
        rows.map((row) => rowToIndexedRecord(row as Record<string, unknown>).hit),
      )
    },
    searchDense(embedding, opts): DenseHit[] {
      const hits = connection.vec === 'vec0'
        ? denseVec0(embedding, opts)
        : denseBrute(embedding, opts)
      return recheckCurrent(hits)
    },
    recheck(hits): KnowledgeHit[] {
      return recheckCurrent(hits)
    },
    close(): void {
      if (closed) return
      closed = true
      connection.db.close()
    },
    async [RUN_RETRIEVAL]<TResult>(
      operation: KnowledgeRetrievalOperation<TResult>,
    ): Promise<TResult> {
      return withAsyncReadSnapshot(db, async () => {
        assertTrustEpoch()
        snapshotDepth += 1
        try {
          return await operation({
            knowledgeRoot,
            source: 'index',
            vec: connection.vec,
            connection,
            reader: snapshotReader,
            scan: undefined,
            recheck: (hits, audit) => recheckAuthoritativeHits(knowledgeRoot, hits, audit),
          })
        } finally {
          snapshotDepth -= 1
        }
      })
    },
  }
  const snapshotReader: InternalKnowledgeReader = {
    ...reader,
    getById: (id) => readSnapshot(() => reader.getById(id)),
    searchLexical: (text, opts) => readSnapshot(() => reader.searchLexical(text, opts)),
    lookupAnchor: (anchor, opts) => readSnapshot(() => reader.lookupAnchor(anchor, opts)),
    searchDense: (embedding, opts) => readSnapshot(() => reader.searchDense(embedding, opts)),
  }
  return snapshotReader
}

/**
 * Keep index failures behind a live facade so callers retain one reader while
 * its source and vector capability permanently degrade to authoritative scans.
 */
function operationDegradingReader(
  knowledgeRoot: string,
  connection: IndexReaderConnection,
): InternalKnowledgeReader {
  let delegate = indexReader(knowledgeRoot, connection)
  let closed = false

  function invoke<TResult>(operation: (reader: KnowledgeReader) => TResult): TResult {
    if (delegate.source === 'scan') return operation(delegate)

    try {
      return operation(delegate)
    } catch (error) {
      closeBestEffort(connection)
      if (!(error instanceof TrustPriorEpochMismatch)) {
        requestRebuildBestEffort(
          knowledgeRoot,
          'corrupt',
          `derived index operation failed: ${errorMessage(error)}`,
        )
      }
      delegate = scanReader(knowledgeRoot)
      return operation(delegate)
    }
  }

  async function invokeAsync<TResult>(
    operation: (reader: InternalKnowledgeReader) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    if (delegate.source === 'scan') return operation(delegate)

    try {
      return await operation(delegate)
    } catch (error) {
      closeBestEffort(connection)
      if (!(error instanceof TrustPriorEpochMismatch)) {
        requestRebuildBestEffort(
          knowledgeRoot,
          'corrupt',
          `derived index operation failed: ${errorMessage(error)}`,
        )
      }
      delegate = scanReader(knowledgeRoot)
      return operation(delegate)
    }
  }

  const reader: InternalKnowledgeReader = {
    get source(): 'index' | 'scan' {
      return delegate.source
    },
    get vec(): VecCapability | 'none' {
      return delegate.vec
    },
    getById(bundleId): KnowledgeHit | undefined {
      return invoke((reader) => reader.getById(bundleId))
    },
    searchLexical(text, opts = {}): KnowledgeHit[] {
      return invoke((reader) => reader.searchLexical(text, opts))
    },
    lookupAnchor(anchor, opts = {}): KnowledgeHit[] {
      return invoke((reader) => reader.lookupAnchor(anchor, opts))
    },
    searchDense(embedding, opts): DenseHit[] {
      return invoke((reader) => reader.searchDense(embedding, opts))
    },
    recheck(hits): KnowledgeHit[] {
      return invoke((reader) => reader.recheck(hits))
    },
    close(): void {
      if (closed) return
      closed = true
      try {
        delegate.close()
      } catch {
        closeBestEffort(connection)
      }
    },
    async [RUN_RETRIEVAL]<TResult>(
      operation: KnowledgeRetrievalOperation<TResult>,
    ): Promise<TResult> {
      return invokeAsync((current) => current[RUN_RETRIEVAL](operation))
    },
  }
  return reader
}

/**
 * Run one retrieval operation on the facade's current capability. Index work receives one async
 * read snapshot; any operation failure follows the existing permanent index-to-scan retry path.
 */
export function withKnowledgeReadSnapshot<TResult>(
  reader: KnowledgeReader,
  operation: KnowledgeRetrievalOperation<TResult>,
): Promise<TResult> {
  const internal = reader as Partial<InternalKnowledgeReader>
  const run = internal[RUN_RETRIEVAL]
  if (run === undefined) {
    throw new TypeError('retrieve requires a reader created by openKnowledgeReader')
  }
  return (reader as InternalKnowledgeReader)[RUN_RETRIEVAL](operation)
}

function degrade(
  knowledgeRoot: string,
  reason: RebuildReason,
  detail: string,
): KnowledgeReader {
  requestRebuildBestEffort(knowledgeRoot, reason, detail)
  return scanReader(knowledgeRoot)
}

/**
 * Which face the derived index presents to a reader RIGHT NOW (407 D-17).
 *
 * `scan` carries the reason the ladder degraded, the detail the rebuild request would have
 * quoted, and whether the file was there at all — `absent` and `corrupt` are the same word to a
 * serving caller but different operator situations, and `doctor` says which.
 */
export type IndexFace =
  | { source: 'index' }
  | {
      source: 'scan'
      reason: RebuildReason
      detail: string
      filePresent: boolean
    }

/**
 * The degrade ladder, ONE core, with the live connection on the healthy arm (407-13, CR-02).
 *
 * The healthy arm returns the connection it just probed WITHOUT closing it, because the caller
 * that is about to serve from the index must keep the very connection the ladder blessed. Closing
 * here and reopening in the facade opened a TOCTOU window: a writer, a drain or a sibling reader
 * holding the database across it made the reopen throw SQLITE_BUSY, which the facade could only
 * read as a `locked` degrade — a durable rebuild request plus a process-lifetime swap to bundle
 * scan, for an index that was healthy the whole time. The trust surface must never report a
 * degradation the trust surface itself caused.
 *
 * Unhealthy arms still close: nothing downstream wants a connection to an index that just failed.
 */
type ClassifiedIndex =
  | { face: { source: 'index' }; connection: IndexReaderConnection }
  | { face: Extract<IndexFace, { source: 'scan' }>; connection?: undefined }

export interface ClassifyIndexFaceOptions extends OpenKnowledgeReaderOptions {
  /** `IndexReaderOpenOptions.inspectCheckpointedImmutably`: the probe only, never the facade. */
  inspectCheckpointedImmutably?: boolean
}

function classifyIndexFaceWithConnection(
  knowledgeRoot: string,
  opts: ClassifyIndexFaceOptions,
): ClassifiedIndex {
  if (!existsSync(indexDbPath(knowledgeRoot))) {
    return {
      face: {
        source: 'scan',
        reason: 'absent',
        detail: 'derived index file is absent',
        filePresent: false,
      },
    }
  }

  let connection: IndexReaderConnection
  try {
    connection = openIndexReaderConnection(knowledgeRoot, opts)
  } catch (error) {
    const detail = errorMessage(error)
    return {
      face: {
        source: 'scan',
        reason: lockedReason(detail) ? 'locked' : 'corrupt',
        detail,
        filePresent: true,
      },
    }
  }

  const health = probeIndexHealth(connection.db)
  if (!health.ok) {
    closeBestEffort(connection)
    let reason: RebuildReason
    if (health.probe === 'schema-version') {
      reason = 'schema-version'
    } else if (health.probe === 'projection-schema') {
      reason = 'corrupt'
    } else {
      reason = lockedReason(health.reason) ? 'locked' : 'corrupt'
    }
    return { face: { source: 'scan', reason, detail: health.reason, filePresent: true } }
  }

  return { face: { source: 'index' }, connection }
}

/**
 * The degrade ladder as a PURE READ (407 D-17, T-407-10).
 *
 * ONE ladder, ONE core, two callers. {@link openKnowledgeReader} below is the SERVING facade: it
 * keeps the connection the core blessed and keeps the side effect — a degraded open still writes
 * the durable D-07 rebuild request. This function is the PROBE half: the identical checks in the
 * identical order over the identical core, but it releases the connection and writes no marker,
 * because its other callers are the retrieval-rung resolver that `doctor` and the runner's
 * evidence recorder invoke, and the local composition root's knowledge probes. A probe that
 * requested a rebuild would make merely ASKING about the index a mutation of the knowledge root;
 * a probe that returned a live handle would make every `doctor` call a connection leak. The probe
 * hands back a face, never a handle — only the serving facade holds a connection.
 */
export function classifyIndexFace(
  knowledgeRoot: string,
  opts: ClassifyIndexFaceOptions = {},
): IndexFace {
  const inspectedImmutably = opts.inspectCheckpointedImmutably === true
    ? indexFileFingerprint(knowledgeRoot)
    : undefined
  const result = classifyIndexFaceWithConnection(knowledgeRoot, opts)
  if (result.connection !== undefined) closeBestEffort(result.connection)
  if (
    inspectedImmutably !== undefined
    && !inspectedImmutably.walPresent
    && result.face.source === 'scan'
    && result.face.filePresent
    && indexFileChangedSince(knowledgeRoot, inspectedImmutably)
  ) {
    return {
      source: 'scan',
      reason: 'locked',
      detail: 'a writer opened the index while it was being inspected, so the inspection could '
        + `not be trusted (it read: ${result.face.detail}); the index is busy, not known to be `
        + 'corrupt. Check again when the writer finishes.',
      filePresent: true,
    }
  }
  return result.face
}

interface IndexFileFingerprint {
  readonly walPresent: boolean
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly size: number
  readonly ino: number
}

function indexFileFingerprint(knowledgeRoot: string): IndexFileFingerprint | undefined {
  const path = indexDbPath(knowledgeRoot)
  try {
    const stat = statSync(path)
    return { walPresent: existsSync(`${path}-wal`), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      size: stat.size, ino: stat.ino }
  } catch {
    return undefined
  }
}

/**
 * 2026-10-03 (quick 261003-lgd, Phase 432 review IN-26): the immutable probe's check and its open
 * are not one step. A writer that opened the index in between (its `-wal` is now there), or that
 * checkpointed while the probe read (the main file changed), changed bytes under a connection
 * SQLite was told cannot change, so a failure read that way is a busy index, not a corrupt one.
 * Only `stat` and `existsSync` are used here: the probe still creates no `-wal`/`-shm`.
 */
function indexFileChangedSince(knowledgeRoot: string, before: IndexFileFingerprint): boolean {
  const after = indexFileFingerprint(knowledgeRoot)
  return after === undefined || after.walPresent || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs || after.size !== before.size || after.ino !== before.ino
}

/**
 * The SERVING facade: classify once, then serve from the connection the classifier blessed.
 *
 * 407-13 (CR-02): this used to call the pure probe and then open a SECOND connection of its own,
 * so a lock acquired in the gap between the probe's close and this open degraded a healthy index
 * — writing the durable rebuild marker and dropping every later retrieval in the process to
 * bundle scan on nothing but contention. It also let `resolveRetrievalRung` report `memidex` while
 * the reader it was describing served `bundle-scan`, the exact banner/reality disagreement D-17's
 * one-fold rule exists to prevent. The facade must never close what it is about to reopen: there
 * is one open on the healthy path and no window for a lock to arrive in.
 */
export function openKnowledgeReader(
  knowledgeRoot: string,
  opts: OpenKnowledgeReaderOptions = {},
): KnowledgeReader {
  const result = classifyIndexFaceWithConnection(knowledgeRoot, {
    ...opts,
    inspectCheckpointedImmutably: false,
  })
  if (result.connection === undefined) {
    // The marker write lives HERE, in the serving facade, and not in the classifier: requesting a
    // rebuild is what a reader that just failed to serve from the index owes the drainer.
    return degrade(knowledgeRoot, result.face.reason, result.face.detail)
  }

  return operationDegradingReader(knowledgeRoot, result.connection)
}
