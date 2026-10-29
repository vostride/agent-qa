// Records-shaped for the retrieval legs, in its own file so no write reaches `knowledge.db`.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
  type EntityDescriptor,
  type EntityKind,
} from '@vostride/agent-qa-schema'

import type { EmbedderPort } from '../embedder-port.js'
import { assertWithinKnowledgeRoot } from '../knowledge-containment.js'
import {
  embeddingProfileKey,
  resolveActiveProfile,
  type IndexReaderConnection,
} from '../index-open.js'
import type { RetrievalLegScope } from '../retrieval/legs.js'
import { renderEntity, type EntityRendering } from './renderings.js'

/**
 * The projection's own file name, beside the knowledge index rather than inside it.
 *
 * Beside, because an entity is not a learned fact. Its own file, because the knowledge
 * index's schema version, rebuild and per-profile vec bookkeeping belong to records, and
 * sharing them would have coupled two projections whose only similarity is their shape.
 */
export const ENTITY_INDEX_DB_FILE = 'entity-index.db'

/**
 * Stamped into `PRAGMA user_version` at creation and checked on every open.
 *
 * Stamp and hard-fail, never migrate — the 385 D-04 house style. Migration would be effort
 * spent on a file whose contents can be regenerated in full from the ledger; a refusal that
 * says which version it found is more useful than a migration nobody would maintain.
 */
export const ENTITY_INDEX_USER_VERSION = 2

/** Busy timeout in milliseconds; the projection is written at a human-paced grain. */
export const ENTITY_INDEX_BUSY_TIMEOUT_MS = 2000

/**
 * How often a standing daemon re-renders the projection from its sources.
 *
 * PROVISIONAL 600_000 (ten minutes); retune from operational evidence without adding config,
 * the `LEASE_HEARTBEAT_TTL_MS` house style. What it is bounding is STALENESS of a title or a
 * status in a fuzzy-match target — never correctness of an address, which the ledger owns and
 * no cadence can affect. Sightings already refresh an entity the moment anything touches it,
 * so this sweep exists for the entities nothing has touched since their source data moved.
 *
 * Deliberately its own interval rather than the daemon's `MAINTENANCE_CADENCE_MS`. That
 * cadence runs the lease-holding maintenance tail; this sweep must never require the writer
 * lease because it writes only this file, and sharing a timer with lease-gated
 * work would have made a lease-free projection stop being maintained the moment a lease was
 * lost — a coupling nothing in the projection's own contract asks for.
 */
export const ENTITY_INDEX_SWEEP_INTERVAL_MS = 600_000

/**
 * The single partition every entity row lives in.
 *
 * The retrieval legs enforce a product/scope tenancy wall on every scan. This projection has
 * exactly one tenant, so the wall is satisfied by one pinned partition rather than disabled —
 * a predicate that is always true is a predicate nobody notices has stopped applying.
 */
export const ENTITY_INDEX_PRODUCT = 'agentqa-entities'

/** The one scope key every entity row carries; entities are global by construction. */
export const ENTITY_INDEX_SCOPE_KEY = 'scope:entities'

/**
 * The projection's row state, which is NOT the entity's status.
 *
 * The scope predicate excludes `deprecated`/`superseded` rows from every scan. An entity that
 * a store reports as quarantined or tombstoned is still a nameable thing that must resolve
 * so its row stays admissible and the store's own word lives in `status_source`.
 */
const ENTITY_INDEX_ROW_STATUS = 'active'

/** Rows are derived, never authored: the closest origin the records vocabulary offers. */
const ENTITY_INDEX_ORIGIN_CLASS = 'import'

/** The scope every entity query binds. One tenant, one key, four bindings. */
export const ENTITY_INDEX_SCOPE = {
  product: ENTITY_INDEX_PRODUCT,
  testKey: ENTITY_INDEX_SCOPE_KEY,
  suiteKey: ENTITY_INDEX_SCOPE_KEY,
  productKey: ENTITY_INDEX_SCOPE_KEY,
  globalKey: ENTITY_INDEX_SCOPE_KEY,
} as const satisfies RetrievalLegScope

export class EntityIndexSchemaVersionError extends Error {
  readonly path: string
  readonly supportedVersion: number
  readonly foundVersion: number

  constructor(path: string, supportedVersion: number, foundVersion: number) {
    super(
      `entity index ${path} is stamped at version ${foundVersion}; this build reads ${supportedVersion}. `
      + 'The entity index is a disposable projection: delete the file and it rebuilds.',
    )
    this.name = 'EntityIndexSchemaVersionError'
    this.path = path
    this.supportedVersion = supportedVersion
    this.foundVersion = foundVersion
  }
}

/**
 * The projection shape the retrieval legs read.
 *
 * Column-for-column what `lexicalLeg`/`denseLeg` select, plus the descriptor columns that let
 * a row be read back as the entity it came from. The FTS tokenizer is copied verbatim from
 * the records index so `MEM-001` and `agentqa://memory/MEM-001` stay single tokens here too —
 * an address that tokenised differently in the two indexes would match differently, and the
 * two would disagree about what an exact handle is.
 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS records (
     record_rowid        INTEGER PRIMARY KEY,
     bundle_id           TEXT    NOT NULL UNIQUE,
     product             TEXT    NOT NULL,
     kind                TEXT    NOT NULL,
     subtype             TEXT,
     scope_tier          TEXT    NOT NULL,
     scope_key           TEXT    NOT NULL,
     status              TEXT    NOT NULL,
     trust               REAL    NOT NULL,
     opened_at_ordinal   REAL    NOT NULL,
     closed_at_ordinal   REAL,
     created_at_ordinal  REAL    NOT NULL,
     origin_class        TEXT    NOT NULL,
     summary             TEXT    NOT NULL,
     embedding_input     TEXT    NOT NULL,
     embed_status        TEXT    NOT NULL DEFAULT 'pending',
     embedding           BLOB,
     entity_kind         TEXT    NOT NULL,
     machine_id          TEXT    NOT NULL,
     uri                 TEXT    NOT NULL,
     title               TEXT    NOT NULL,
     status_source       TEXT    NOT NULL,
     successor_machine_id TEXT
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts_records USING fts5(
     identity,
     content,
     context,
     tokenize = "unicode61 tokenchars '#-_./:[]=>@'"
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
] as const

export interface EntityIndexHandle {
  /** `vec` is `brute`: `denseVec0` needs the records index's private vec-cleanup epoch marker. */
  readonly connection: IndexReaderConnection
  readonly path: string
  close(): void
}

export interface OpenEntityIndexOptions {
  /** Absolute path to the projection file, typically `entityIndexDbPath(knowledgeRoot)`. */
  readonly path: string
  /**
   * The knowledge root the path lives under. When given, the path's directory chain must stay
   * inside it: a linked `memory/` or `memory/index/` is refused before the open.
   */
  readonly knowledgeRoot?: string
  readonly timeoutMs?: number
}

/** The projection's path: beside the knowledge index, never inside it. */
export function entityIndexDbPath(knowledgeRoot: string): string {
  return join(knowledgeRoot, 'memory', 'index', ENTITY_INDEX_DB_FILE)
}

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

export function openEntityIndex(options: OpenEntityIndexOptions): EntityIndexHandle {
  if (options.knowledgeRoot !== undefined) {
    assertWithinKnowledgeRoot(options.knowledgeRoot, dirname(options.path))
  }
  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path, {
    timeout: options.timeoutMs ?? ENTITY_INDEX_BUSY_TIMEOUT_MS,
  })
  db.exec('PRAGMA journal_mode=WAL')

  const stamped = toNumber(db.prepare('PRAGMA user_version').get()?.user_version)
  if (stamped !== 0 && stamped !== ENTITY_INDEX_USER_VERSION) {
    db.close()
    throw new EntityIndexSchemaVersionError(
      options.path,
      ENTITY_INDEX_USER_VERSION,
      stamped,
    )
  }
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  if (stamped === 0) db.exec(`PRAGMA user_version = ${ENTITY_INDEX_USER_VERSION}`)

  return {
    connection: { db, vec: 'brute' },
    path: options.path,
    close(): void {
      db.close()
    },
  }
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
      // Preserve the write error that caused the rollback.
    }
    throw error
  }
}

function writeFtsRow(
  db: DatabaseSync,
  recordRowid: number,
  rendering: EntityRendering,
): void {
  db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
  db.prepare(`
    INSERT INTO fts_records (rowid, identity, content, context)
    VALUES (?, ?, ?, ?)
  `).run(recordRowid, rendering.identity, rendering.content, rendering.context)
}

function upsertEntityRow(db: DatabaseSync, descriptor: EntityDescriptor): void {
  const rendering = renderEntity(descriptor)
  const existing = db.prepare(`
    SELECT record_rowid, embedding_input FROM records WHERE bundle_id = ?
  `).get(descriptor.shortId)

  if (existing === undefined) {
    const inserted = db.prepare(`
      INSERT INTO records (
        bundle_id, product, kind, subtype,
        scope_tier, scope_key, status, trust,
        opened_at_ordinal, closed_at_ordinal, created_at_ordinal,
        origin_class, summary, embedding_input,
        embed_status, embedding,
        entity_kind, machine_id, uri, title, status_source, successor_machine_id
      ) VALUES (
        ?, ?, ?, NULL,
        'global', ?, ?, 1,
        0, NULL, 0,
        ?, ?, ?,
        'pending', NULL,
        ?, ?, ?, ?, ?, ?
      )
    `).run(
      descriptor.shortId,
      ENTITY_INDEX_PRODUCT,
      descriptor.kind,
      ENTITY_INDEX_SCOPE_KEY,
      ENTITY_INDEX_ROW_STATUS,
      ENTITY_INDEX_ORIGIN_CLASS,
      rendering.content,
      rendering.embedding,
      descriptor.kind,
      descriptor.machineId,
      descriptor.uri,
      descriptor.title,
      descriptor.statusSource,
      descriptor.successorMachineId ?? null,
    )
    writeFtsRow(db, Number(inserted.lastInsertRowid), rendering)
    return
  }

  const recordRowid = toNumber(existing.record_rowid)
  // The embedding is dropped exactly when the text it was computed FROM changed. Keeping it
  // across an unrelated edit is the difference between a maintenance sweep that costs a read
  // and one that re-embeds the whole corpus every time a status moves.
  const embeddingStale = String(existing.embedding_input) !== rendering.embedding
  db.prepare(`
    UPDATE records SET
      kind = ?, summary = ?, embedding_input = ?,
      entity_kind = ?, machine_id = ?, uri = ?, title = ?, status_source = ?,
      successor_machine_id = ?
      ${embeddingStale ? ", embedding = NULL, embed_status = 'pending'" : ''}
    WHERE record_rowid = ?
  `).run(
    descriptor.kind,
    rendering.content,
    rendering.embedding,
    descriptor.kind,
    descriptor.machineId,
    descriptor.uri,
    descriptor.title,
    descriptor.statusSource,
    descriptor.successorMachineId ?? null,
    recordRowid,
  )
  writeFtsRow(db, recordRowid, rendering)
}

/**
 * Project one entity into the index (D-06's incremental half).
 *
 * Called from the resolver's sighting/mint path, so every process posture — daemon, one-shot
 * CLI, a test harness — maintains the projection by using it. Idempotent: re-projecting an
 * unchanged entity leaves the same row.
 */
export function refreshEntity(handle: EntityIndexHandle, descriptor: EntityDescriptor): void {
  immediateTransaction(handle.connection.db, () => {
    upsertEntityRow(handle.connection.db, descriptor)
  })
}

/**
 * Drop everything and re-project from the supplied descriptor set (D-06's healing half).
 *
 * The set comes from the ledger plus the owning stores, which is what makes this a rebuild
 * rather than a repair: nothing in this file is consulted to produce the new contents, so a
 * file damaged in any way at all converges to the same result as a file that never existed.
 * Embeddings are re-derived rather than carried, because a rebuild that preserved derived
 * bytes would preserve exactly the state a rebuild is run to be rid of.
 */
export function rebuildEntityIndex(
  handle: EntityIndexHandle,
  descriptors: Iterable<EntityDescriptor>,
): number {
  const { db } = handle.connection
  let projected = 0
  immediateTransaction(db, () => {
    db.exec('DELETE FROM fts_records')
    db.exec('DELETE FROM records')
    for (const descriptor of descriptors) {
      upsertEntityRow(db, descriptor)
      projected += 1
    }
  })
  return projected
}

export interface EntityIndexSweepReport {
  readonly examined: number
  readonly refreshed: number
}

/**
 * Re-project the entities whose source data moved (D-06's maintenance-cadence half).
 *
 * A sweep is maintenance of a disposable projection, so it writes only where a row disagrees
 * with its source. It never touches the addressing ledger — the ledger is not a projection
 * and it takes no writer lease, because everything it writes lives in this file.
 */
export function sweepEntityIndex(
  handle: EntityIndexHandle,
  descriptors: Iterable<EntityDescriptor>,
): EntityIndexSweepReport {
  const { db } = handle.connection
  let examined = 0
  let refreshed = 0
  immediateTransaction(db, () => {
    for (const descriptor of descriptors) {
      examined += 1
      const stored = readEntityDescriptor(handle, descriptor.shortId)
      if (stored !== undefined && descriptorsAgree(stored, descriptor)) continue
      upsertEntityRow(db, descriptor)
      refreshed += 1
    }
  })
  return { examined, refreshed }
}

function descriptorsAgree(left: EntityDescriptor, right: EntityDescriptor): boolean {
  return left.kind === right.kind
    && left.machineId === right.machineId
    && left.uri === right.uri
    && left.title === right.title
    && left.statusSource === right.statusSource
    && left.successorMachineId === right.successorMachineId
}

/** Read one projected row back as the entity it came from. */
export function readEntityDescriptor(
  handle: EntityIndexHandle,
  shortId: string,
): EntityDescriptor | undefined {
  const row = handle.connection.db.prepare(`
    SELECT bundle_id, entity_kind, machine_id, uri, title, status_source, successor_machine_id
    FROM records WHERE bundle_id = ?
  `).get(shortId)
  if (row === undefined) return undefined

  const successor = row.successor_machine_id
  return {
    kind: String(row.entity_kind) as EntityKind,
    shortId: String(row.bundle_id),
    uri: String(row.uri),
    machineId: String(row.machine_id),
    title: String(row.title),
    statusSource: String(row.status_source),
    ...(successor === null || successor === undefined
      ? {}
      : { successorMachineId: String(successor) }),
  }
}

/** The rendering one projected row currently carries. */
export function readEntityRendering(
  handle: EntityIndexHandle,
  shortId: string,
): EntityRendering | undefined {
  const descriptor = readEntityDescriptor(handle, shortId)
  return descriptor === undefined ? undefined : renderEntity(descriptor)
}

export function countEntities(handle: EntityIndexHandle): number {
  return toNumber(handle.connection.db.prepare('SELECT COUNT(*) AS count FROM records').get()?.count)
}

/**
 * Embed every row whose rendering has no vector yet, returning how many were embedded.
 *
 * Separate from `refreshEntity` on purpose. Projecting an entity is synchronous and always
 * possible; embedding one needs a model that a floor host may not have. Splitting them is what
 * lets the degradation ladder work by omission — an index with no vectors simply serves its
 * lexical leg, and the resolver rides that without a posture flag anywhere.
 *
 * A profile change invalidates every stored vector rather than mixing two geometries in one
 * table, which is the same disposability law the records index applies to its own.
 */
export async function embedPendingEntities(
  handle: EntityIndexHandle,
  embedder: EmbedderPort,
  profile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE,
): Promise<number> {
  const { db } = handle.connection
  const key = embeddingProfileKey(profile)
  const stamped = db.prepare("SELECT v FROM meta WHERE k = 'embedding_profile'").get()?.v
  if (stamped !== key) {
    immediateTransaction(db, () => {
      db.exec("UPDATE records SET embedding = NULL, embed_status = 'pending'")
      db.prepare(`
        INSERT INTO meta (k, v) VALUES ('embedding_profile', ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v
      `).run(key)
    })
  }

  const pending = db.prepare(`
    SELECT record_rowid, embedding_input FROM records
    WHERE embed_status = 'pending' ORDER BY record_rowid
  `).all()

  let embedded = 0
  for (const row of pending) {
    const vector = await embedder.embedDocument(String(row.embedding_input))
    if (vector.length !== profile.dim) {
      throw new RangeError(
        `entity embedding has ${vector.length} dimensions; profile ${profile.model_id} declares ${profile.dim}`,
      )
    }
    db.prepare(`
      UPDATE records SET embedding = ?, embed_status = 'present' WHERE record_rowid = ?
    `).run(
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      toNumber(row.record_rowid),
    )
    embedded += 1
  }
  return embedded
}

/** The admission floor the dense leg's candidates are held to, from the stored profile. */
export function entityIndexTauDense(handle: EntityIndexHandle): number {
  return resolveActiveProfile(handle.connection.db).tau_dense
}
