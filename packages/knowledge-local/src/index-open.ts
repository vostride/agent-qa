// The index lives in the gitignored `memory/index`, so its writes skip the committed egress gate.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import {
  canonicalJson,
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
} from '@vostride/agent-qa-schema'
import type { EmbeddingProfile } from '@vostride/agent-qa-schema'

import { assertWithinKnowledgeRoot } from './knowledge-containment.js'
import { getLoadablePath } from './sqlite-vec-loadable.js'

export const INDEX_DB_FILE = 'knowledge.db'

/** Any other stamp resets the index. */
export const INDEX_SCHEMA_VERSION = 2

// Bump only when contextual-rendering bytes change; a stale stamp forces one full render pass.
export const INDEX_RENDERING_SCHEMA_VERSION = 2

// An absent or stale epoch forces one full invalidation, in the same transaction as the marker.
const EMBEDDING_TRANSITION_EPOCH = 1

/**
 * Active vec-table cleanup completed by a connection that actually loaded sqlite-vec.
 *
 * This fact is intentionally separate from canonical invalidation. A brute writer can safely
 * disown records.embedding bytes, but it cannot prove or mutate the unloaded virtual table. Every
 * brute writer therefore removes this marker before exposing its mutable connection, and only a
 * vec0 writer may publish it after clearing the active table in the same transaction.
 */
const EMBEDDING_VEC_CLEANUP_EPOCH = 1

/**
 * Projection tables every readable index must expose.
 *
 * Per-profile vec tables are deliberately excluded: vec0 is a conditional
 * capability, while operation-time failover and the next rebuild heal a lost
 * capability-specific table.
 */
export const REQUIRED_INDEX_TABLES = [
  'records',
  'fts_records',
  'anchors',
  'graph_nodes',
  'graph_edges',
  'meta',
] as const

export const WRITER_BUSY_TIMEOUT_MS = 2000

export const READER_BUSY_TIMEOUT_MS = 500

export const CHECKPOINT_EVERY_N_BUNDLES = 32

export type VecCapability = 'vec0' | 'brute'

export interface IndexWriterHandle {
  db: DatabaseSync
  vec: VecCapability
  readonly renderingEpochStale: boolean
  completeRenderingEpoch(): void
  checkpointPassive(): void
  close(): void
}

export interface IndexReaderConnection {
  db: DatabaseSync
  vec: VecCapability
}

/** Durable writer work that can be inspected without opening a mutable index connection. */
export interface IndexMaintenanceState {
  indexAbsent: boolean
  pendingEmbeddings: number
  renderingEpochStale: boolean
  vectorReconciliationOutstanding: boolean
}

export type IndexHealth =
  | { ok: true }
  | {
      ok: false
      probe: 'quick-check' | 'projection-schema' | 'schema-version'
      reason: string
    }

interface IndexOpenOptions {
  // Test seam; production resolves sqlite-vec's pinned prebuild.
  vecLoadablePath?: string
}

export interface IndexReaderOpenOptions extends IndexOpenOptions {
  // Opens `immutable=1` when no `-wal` exists, so a probe makes no sidecars; serving never sets it.
  inspectCheckpointedImmutably?: boolean
}

export function indexDbPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, 'memory', 'index', INDEX_DB_FILE)
}

/**
 * Inspect bounded durable maintenance facts without bootstrapping, migrating, or restamping.
 *
 * Absence is a valid schedulable state. Once the database exists, malformed or incomplete
 * projection schemas throw so callers cannot mistake an unreadable index for convergence.
 */
export function readIndexMaintenanceState(
  knowledgeRoot: string,
): IndexMaintenanceState {
  const path = indexDbPath(knowledgeRoot)
  if (!existsSync(path)) {
    return {
      indexAbsent: true,
      pendingEmbeddings: 0,
      renderingEpochStale: false,
      vectorReconciliationOutstanding: false,
    }
  }

  // The lease-gated writer closes with a truncate checkpoint. Immutable read mode then avoids
  // SQLite creating WAL/SHM sidecars merely to inspect that closed, fully checkpointed database.
  const immutableUri = pathToFileURL(path)
  immutableUri.searchParams.set('mode', 'ro')
  immutableUri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(immutableUri.href, {
    readOnly: true,
    timeout: READER_BUSY_TIMEOUT_MS,
  })
  try {
    db.exec('PRAGMA query_only=1')
    const tableNames = new Set(
      db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'records',
            'fts_records',
            'anchors',
            'graph_nodes',
            'graph_edges',
            'meta'
          )
      `).all().map((row) => String(row.name)),
    )
    const missingTables = REQUIRED_INDEX_TABLES.filter((name) => !tableNames.has(name))
    if (missingTables.length > 0) {
      throw new Error(
        `index maintenance inspection found incomplete schema: ${missingTables.join(', ')}`,
      )
    }

    const pendingRow = db
      .prepare("SELECT COUNT(*) AS count FROM records WHERE embed_status = 'pending'")
      .get()
    const pendingEmbeddings = Number(pendingRow?.count)
    if (!Number.isSafeInteger(pendingEmbeddings) || pendingEmbeddings < 0) {
      throw new Error('index maintenance inspection returned an invalid pending count')
    }

    const metadata = new Map(
      db.prepare(`
        SELECT k, v
        FROM meta
        WHERE k IN ('rendering_schema_version', 'embedding_vec_cleanup_epoch')
      `).all().map((row) => [String(row.k), String(row.v)]),
    )
    return {
      indexAbsent: false,
      pendingEmbeddings,
      renderingEpochStale:
        metadata.get('rendering_schema_version') !== String(INDEX_RENDERING_SCHEMA_VERSION),
      vectorReconciliationOutstanding:
        metadata.get('embedding_vec_cleanup_epoch') !== String(EMBEDDING_VEC_CLEANUP_EPOCH),
    }
  } finally {
    db.close()
  }
}

export function resolveVecCapability(
  db: DatabaseSync,
  loadablePath?: string,
): VecCapability {
  try {
    db.loadExtension(loadablePath ?? getLoadablePath())
    return 'vec0'
  } catch {
    return 'brute'
  }
}

export function vecTableName(profile: EmbeddingProfile): string {
  const identity = `${profile.model_id}_${profile.revision}_${profile.dtype}_${profile.dim}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (identity === '') throw new Error('embedding profile produced an empty vec table identity')
  return `vec_${identity}`
}

/**
 * The closed set of embedding profiles whose per-profile vec tables belong to this schema.
 *
 * Active-profile resolution, profile migration, and destructive projection maintenance must
 * share this exact authority. Adding a profile therefore cannot silently make an old vec table
 * invisible to forgetting or purge.
 */
export const SCHEMA_OWNED_EMBEDDING_PROFILES = [
  DEFAULT_EMBEDDING_PROFILE,
  STATIC_FLOOR_EMBEDDING_PROFILE,
] as const satisfies readonly EmbeddingProfile[]

/**
 * Enumerate only materialized vec tables derived from the closed schema profile list.
 *
 * sqlite_master is safe to inspect even when this connection could not load sqlite-vec. Names
 * are bound as data, then returned in profile-list order; no caller-controlled identifier reaches
 * the dynamic DELETE statements used by maintenance.
 */
export function materializedSchemaVecTableNames(db: DatabaseSync): string[] {
  const schemaNames = SCHEMA_OWNED_EMBEDDING_PROFILES.map(vecTableName)
  const present = new Set(
    db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (?, ?)
    `).all(...schemaNames).map((row) => String(row.name)),
  )
  return schemaNames.filter((name) => present.has(name))
}

/**
 * Delete one record from every materialized schema-owned vec table, independent of capability.
 *
 * An existing vec0 table on a brute connection is not a valid no-op: preparing its DML fails
 * when sqlite-vec is unavailable. Preserve that failure with table context so the caller's
 * transaction rolls back and no maintenance report or purge receipt can claim partial success.
 */
export function deleteRecordFromAllSchemaVecTables(
  db: DatabaseSync,
  recordRowid: number,
): void {
  for (const tableName of materializedSchemaVecTableNames(db)) {
    try {
      db.prepare(`DELETE FROM ${tableName} WHERE record_rowid = ?`)
        .run(BigInt(recordRowid))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `deleting record ${recordRowid} from schema-owned vec table ${tableName} failed: ${message}`,
        { cause: error },
      )
    }
  }
}

/** Stable identity persisted in meta and used to select a closed-list profile. */
export function embeddingProfileKey(profile: EmbeddingProfile): string {
  return canonicalJson({
    model_id: profile.model_id,
    revision: profile.revision,
    dtype: profile.dtype,
    dim: profile.dim,
  })
}

function readEmbeddingProfileStamp(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'embedding_profile'")
      .get()
    return typeof row?.v === 'string' ? row.v : undefined
  } catch {
    return undefined
  }
}

function readIndexSchemaVersionStamp(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
      .get()
    return typeof row?.v === 'string' ? row.v : undefined
  } catch {
    return undefined
  }
}

function readRenderingSchemaVersionStamp(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'rendering_schema_version'")
      .get()
    return typeof row?.v === 'string' ? row.v : undefined
  } catch {
    return undefined
  }
}

function hasProjectionTables(db: DatabaseSync): boolean {
  const row = db
    .prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('records', 'fts_records', 'anchors', 'graph_nodes', 'graph_edges', 'meta')
      LIMIT 1
    `)
    .get()
  return row !== undefined
}

function readTransitionEpoch(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'embedding_transition_epoch'")
      .get()
    return typeof row?.v === 'string' ? row.v : undefined
  } catch {
    return undefined
  }
}

function readVecCleanupEpoch(db: DatabaseSync): string | undefined {
  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'embedding_vec_cleanup_epoch'")
      .get()
    return typeof row?.v === 'string' ? row.v : undefined
  } catch {
    return undefined
  }
}

/** Internal dense-reader gate; deliberately absent from the package barrel. */
export function isEmbeddingVecCleanupCurrent(db: DatabaseSync): boolean {
  return readVecCleanupEpoch(db) === String(EMBEDDING_VEC_CLEANUP_EPOCH)
}

// Absent, unknown or pre-bootstrap metadata falls back to the default profile.
export function resolveActiveProfile(db: DatabaseSync): EmbeddingProfile {
  const stamp = readEmbeddingProfileStamp(db)

  return SCHEMA_OWNED_EMBEDDING_PROFILES.find(
    (profile) => embeddingProfileKey(profile) === stamp,
  )
    ?? DEFAULT_EMBEDDING_PROFILE
}

function bootstrapVecSchema(db: DatabaseSync, activeProfile: EmbeddingProfile): void {
  const tableName = vecTableName(activeProfile)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      record_rowid integer primary key,
      product text partition key,
      scope_tier text,
      scope_key text,
      status text,
      embedding float[${activeProfile.dim}] distance_metric=cosine
    );
  `)
}

// Disposable and rebuilt from run handoffs, so not in `REQUIRED_INDEX_TABLES`; holds no test file.
export function ensureRunOutcomeTables(db: DatabaseSync): void {
  const outcomeColumns = db.prepare("PRAGMA table_info('run_test_outcomes')").all()
    .map((row) => String(row.name))
  if (outcomeColumns.length > 0 && !outcomeColumns.includes('product')) {
    // L12 disposable-store migration: a shape change drops every projection table so
    // no writer can retain or silently read globally keyed pre-partition rows.
    db.exec(`
      DROP TABLE IF EXISTS run_test_outcomes;
      DROP TABLE IF EXISTS run_test_anchors;
      DROP TABLE IF EXISTS run_outcome_applied_runs;
      DROP TABLE IF EXISTS run_fingerprint_windows;
      DROP TABLE IF EXISTS suite_fingerprints;
      DROP TABLE IF EXISTS run_outcome_projection_version;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_test_outcomes (
      product TEXT NOT NULL,
      scope_tier TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      passes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      heals INTEGER NOT NULL DEFAULT 0,
      flake_count INTEGER NOT NULL DEFAULT 0,
      last_outcomes_json TEXT NOT NULL DEFAULT '[]',
      last_build_ordinal INTEGER,
      PRIMARY KEY (product, file_path, test_name)
    );

    CREATE TABLE IF NOT EXISTS run_test_anchors (
      product TEXT NOT NULL,
      scope_tier TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      anchor_normalized_json TEXT NOT NULL,
      UNIQUE (product, file_path, test_name, anchor_normalized_json)
    );

    CREATE TABLE IF NOT EXISTS run_outcome_applied_runs (
      product TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (product, run_id)
    );

    CREATE TABLE IF NOT EXISTS run_fingerprint_windows (
      product TEXT NOT NULL,
      file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      verdict_class TEXT NOT NULL,
      build_ordinal INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      UNIQUE (product, file_path, test_name, fingerprint, build_ordinal, run_id)
    );

    -- 393 D-15: gate 3's comparison substrate, folded by the same pass and cleared by the same
    -- rebuild as the tables above. One row per fingerprint element, ordered by seq, keyed by the
    -- stable test identity; run_id and build_ordinal are the provenance the fold's
    -- newest-evidence-wins replacement rule compares on (see projection/suite-fingerprints.ts).
    CREATE TABLE IF NOT EXISTS suite_fingerprints (
      product TEXT NOT NULL,
      file_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      seq INTEGER NOT NULL,
      element TEXT NOT NULL,
      run_id TEXT NOT NULL,
      build_ordinal INTEGER NOT NULL,
      PRIMARY KEY (product, file_path, test_name, seq)
    );

    -- 393 CR-02: the stored fold-semantics stamp for the five tables above. Singleton by
    -- construction (the CHECK admits exactly one row) because "which semantics produced this
    -- family" is one fact about one derived index, and a second row could only ever be a second
    -- answer to it. Absent is a legal state and means MISMATCH: a pre-stamp index and an index
    -- whose file was deleted both read as absent, and both want the same rebuild.
    CREATE TABLE IF NOT EXISTS run_outcome_projection_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `)
}

function bootstrapSchema(
  db: DatabaseSync,
  vec: VecCapability,
  activeProfile: EmbeddingProfile,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      record_rowid INTEGER PRIMARY KEY,
      bundle_id TEXT NOT NULL UNIQUE,
      product TEXT NOT NULL,
      mutable_state_hash TEXT NOT NULL,
      trust_prior_digest TEXT NOT NULL DEFAULT '',
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
      last_confirmed_ordinal INTEGER,
      opened_at_ordinal REAL NOT NULL,
      closed_at_ordinal REAL,
      created_at_ordinal REAL NOT NULL,
      origin_class TEXT NOT NULL,
      summary TEXT NOT NULL,
      embedding_input TEXT NOT NULL,
      situating_line TEXT NOT NULL DEFAULT '',
      contextual_rendering TEXT NOT NULL DEFAULT '',
      embed_status TEXT NOT NULL DEFAULT 'pending',
      embedding BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_records USING fts5(
      identity,
      content,
      context,
      tokenize = "unicode61 tokenchars '#-_./:[]=>@'"
    );

    CREATE TABLE IF NOT EXISTS anchors (
      record_rowid INTEGER NOT NULL,
      product TEXT NOT NULL,
      t TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      normalized_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      node_id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      natural_key_json TEXT NOT NULL,
      product TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      src_node_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      dst_node_id TEXT NOT NULL,
      record_rowid INTEGER NOT NULL,
      product TEXT NOT NULL,
      recency_ordinal INTEGER NOT NULL DEFAULT 0,
      UNIQUE(src_node_id, edge_type, dst_node_id, record_rowid)
    );

    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `)

  ensureRunOutcomeTables(db)

  if (vec === 'vec0') {
    bootstrapVecSchema(db, activeProfile)
  }
}

function stampMeta(
  db: DatabaseSync,
  activeProfile: EmbeddingProfile,
  vecCleanup: 'current' | 'pending',
  renderingEpoch: 'current' | 'preserve',
): void {
  const upsert = db.prepare(`
    INSERT INTO meta (k, v) VALUES (?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v
  `)

  if (vecCleanup === 'pending') {
    db.prepare("DELETE FROM meta WHERE k = 'embedding_vec_cleanup_epoch'").run()
  }
  upsert.run('index_schema_version', String(INDEX_SCHEMA_VERSION))
  upsert.run('embedding_profile', embeddingProfileKey(activeProfile))
  if (renderingEpoch === 'current') {
    upsert.run('rendering_schema_version', String(INDEX_RENDERING_SCHEMA_VERSION))
  }
  upsert.run('embedding_transition_epoch', String(EMBEDDING_TRANSITION_EPOCH))
  if (vecCleanup === 'current') {
    upsert.run('embedding_vec_cleanup_epoch', String(EMBEDDING_VEC_CLEANUP_EPOCH))
  }
}

function stampRenderingSchemaVersion(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO meta (k, v) VALUES ('rendering_schema_version', ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v
  `).run(String(INDEX_RENDERING_SCHEMA_VERSION))
}

// Invalidates before the stamp in one transaction; a brute connection leaves vec cleanup pending.
function invalidateDerivedEmbeddings(db: DatabaseSync): void {
  db.prepare(`
    UPDATE records
    SET embedding = NULL, embed_status = 'pending'
    WHERE embedding IS NOT NULL OR embed_status = 'present'
  `).run()
}

function recreateActiveVecTable(db: DatabaseSync, activeProfile: EmbeddingProfile): void {
  db.exec(`DROP TABLE IF EXISTS ${vecTableName(activeProfile)}`)
  bootstrapVecSchema(db, activeProfile)
}

function resetProjectionSchema(
  db: DatabaseSync,
  vec: VecCapability,
  activeProfile: EmbeddingProfile,
): void {
  if (vec === 'vec0') {
    db.exec(`DROP TABLE IF EXISTS ${vecTableName(activeProfile)}`)
  }
  db.exec(`
    DROP TABLE IF EXISTS fts_records;
    DROP TABLE IF EXISTS graph_edges;
    DROP TABLE IF EXISTS graph_nodes;
    DROP TABLE IF EXISTS anchors;
    DROP TABLE IF EXISTS records;
    DROP TABLE IF EXISTS meta;
  `)
  bootstrapSchema(db, vec, activeProfile)
}

function immediateTransaction(db: DatabaseSync, operation: () => void): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    operation()
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the transition or cleanup error that caused the rollback.
    }
    throw error
  }
}

function closeAfterOpenFailure(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // Preserve the original open/bootstrap failure.
  }
}

export function openIndexWriter(
  knowledgeRoot: string,
  opts: IndexOpenOptions = {},
): IndexWriterHandle {
  const path = indexDbPath(knowledgeRoot)
  assertWithinKnowledgeRoot(knowledgeRoot, dirname(path))
  mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path, {
    allowExtension: true,
    timeout: WRITER_BUSY_TIMEOUT_MS,
  })

  try {
    const vec = resolveVecCapability(db, opts.vecLoadablePath)
    const activeProfile = resolveActiveProfile(db)
    const projectionTablesPresent = hasProjectionTables(db)
    const previousSchemaVersionStamp = readIndexSchemaVersionStamp(db)
    const previousSchemaVersion = Number(previousSchemaVersionStamp)
    const schemaResetRequired =
      projectionTablesPresent
      && (previousSchemaVersionStamp === undefined
        || !Number.isFinite(previousSchemaVersion)
        || previousSchemaVersion !== INDEX_SCHEMA_VERSION)
    const previousRenderingVersionStamp = readRenderingSchemaVersionStamp(db)
    const previousRenderingVersion = Number(previousRenderingVersionStamp)
    let renderingEpochStale =
      projectionTablesPresent
      && !schemaResetRequired
      && (previousRenderingVersionStamp === undefined
        || !Number.isFinite(previousRenderingVersion)
        || previousRenderingVersion !== INDEX_RENDERING_SCHEMA_VERSION)
    db.exec('PRAGMA journal_mode=WAL')
    bootstrapSchema(db, vec, activeProfile)

    immediateTransaction(db, () => {
      if (schemaResetRequired) {
        resetProjectionSchema(db, vec, activeProfile)
        stampMeta(
          db,
          activeProfile,
          vec === 'vec0' ? 'current' : 'pending',
          'current',
        )
        renderingEpochStale = false
        return
      }

      const transitionRequired =
        readEmbeddingProfileStamp(db) !== embeddingProfileKey(activeProfile)
        || readTransitionEpoch(db) !== String(EMBEDDING_TRANSITION_EPOCH)
      const embeddingInvalidationRequired =
        transitionRequired || renderingEpochStale

      if (vec === 'brute') {
        if (embeddingInvalidationRequired) invalidateDerivedEmbeddings(db)
        stampMeta(
          db,
          activeProfile,
          'pending',
          renderingEpochStale ? 'preserve' : 'current',
        )
        return
      }

      if (embeddingInvalidationRequired || !isEmbeddingVecCleanupCurrent(db)) {
        if (embeddingInvalidationRequired) invalidateDerivedEmbeddings(db)
        recreateActiveVecTable(db, activeProfile)
      }
      stampMeta(
        db,
        activeProfile,
        'current',
        renderingEpochStale ? 'preserve' : 'current',
      )
    })

    let closed = false
    return {
      db,
      vec,
      get renderingEpochStale(): boolean {
        return renderingEpochStale
      },
      completeRenderingEpoch(): void {
        if (!renderingEpochStale) return
        immediateTransaction(db, () => {
          stampRenderingSchemaVersion(db)
        })
        renderingEpochStale = false
      },
      checkpointPassive(): void {
        db.exec('PRAGMA wal_checkpoint(PASSIVE)')
      },
      close(): void {
        if (closed) return
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          closed = true
          db.close()
        }
      },
    }
  } catch (error) {
    closeAfterOpenFailure(db)
    throw error
  }
}

export function openIndexReaderConnection(
  knowledgeRoot: string,
  opts: IndexReaderOpenOptions = {},
): IndexReaderConnection {
  const path = indexDbPath(knowledgeRoot)
  let location = path
  if (opts.inspectCheckpointedImmutably === true && !existsSync(`${path}-wal`)) {
    const immutableUri = pathToFileURL(path)
    immutableUri.searchParams.set('mode', 'ro')
    immutableUri.searchParams.set('immutable', '1')
    location = immutableUri.href
  }
  const db = new DatabaseSync(location, {
    readOnly: true,
    allowExtension: true,
    timeout: READER_BUSY_TIMEOUT_MS,
  })

  try {
    const vec = resolveVecCapability(db, opts.vecLoadablePath)
    db.exec('PRAGMA query_only=1')
    return { db, vec }
  } catch (error) {
    closeAfterOpenFailure(db)
    throw error
  }
}

export function probeIndexHealth(db: DatabaseSync): IndexHealth {
  try {
    const row = db.prepare('PRAGMA quick_check').get()
    const result = row?.quick_check
    if (result !== 'ok') {
      return {
        ok: false,
        probe: 'quick-check',
        reason: `PRAGMA quick_check returned ${String(result)}`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      probe: 'quick-check',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
    const present = new Set(rows.map((row) => String(row.name)))
    const missing = REQUIRED_INDEX_TABLES.filter((table) => !present.has(table))
    if (missing.length > 0) {
      return {
        ok: false,
        probe: 'projection-schema',
        reason: `required projection tables missing: ${missing.join(', ')}`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      probe: 'projection-schema',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const row = db
      .prepare("SELECT v FROM meta WHERE k = 'index_schema_version'")
      .get()
    const version = Number(row?.v)
    if (
      row === undefined
      || !Number.isFinite(version)
      || version !== INDEX_SCHEMA_VERSION
    ) {
      return {
        ok: false,
        probe: 'schema-version',
        reason: `index schema version ${String(row?.v)} is not readable`,
      }
    }
  } catch (error) {
    return {
      ok: false,
      probe: 'schema-version',
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  return { ok: true }
}
