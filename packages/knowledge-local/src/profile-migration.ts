// The flip marks rows projected after the snapshot pending, so the backfill selector heals them.
import type { DatabaseSync } from 'node:sqlite'

import type { EmbeddingProfile } from '@vostride/agent-qa-schema'

import {
  dropEmbedCacheForModel,
  ensureEmbedCacheTable,
  wrapEmbedderWithCache,
} from './embed-cache.js'
import type { EmbedderPort } from './embedder-port.js'
import {
  SCHEMA_OWNED_EMBEDDING_PROFILES,
  embeddingProfileKey,
  resolveActiveProfile,
  vecTableName,
} from './index-open.js'
import type { VecCapability } from './index-open.js'

export type MigrationOutcome =
  | { flipped: true; profileKey: string }
  | { flipped: false; missing: string[] }

export interface SetActiveEmbeddingProfileOptions {
  db: DatabaseSync
  vec: VecCapability
  target: {
    profile: EmbeddingProfile
    embedder: EmbedderPort
  }
}

interface FrozenMember {
  recordRowid: number
  bundleId: string
  embeddingInput: string
}

interface CurrentMember extends FrozenMember {
  product: string
  scopeTier: string
  scopeKey: string
  status: string
}

interface MigrationSnapshot {
  outgoingProfile: EmbeddingProfile
  frozenMembers: FrozenMember[]
}

interface StagedEmbedding {
  recordRowid: number
  embedding: Uint8Array
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function transaction<T>(
  db: DatabaseSync,
  begin: 'BEGIN' | 'BEGIN IMMEDIATE',
  operation: () => T,
): T {
  db.exec(begin)
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the migration error that caused the rollback.
    }
    throw error
  }
}

function knownProfile(profile: EmbeddingProfile): {
  key: string
  profile: EmbeddingProfile
} {
  const key = embeddingProfileKey(profile)
  const known = SCHEMA_OWNED_EMBEDDING_PROFILES.find(
    (candidate) => embeddingProfileKey(candidate) === key,
  )

  if (known === undefined) {
    throw new TypeError(`embedding profile ${key} is not schema-owned`)
  }
  return { key, profile: known }
}

function snapshotMigration(db: DatabaseSync): MigrationSnapshot {
  return transaction(db, 'BEGIN', () => ({
    outgoingProfile: resolveActiveProfile(db),
    frozenMembers: db
      .prepare(`
        SELECT record_rowid, bundle_id, embedding_input
        FROM records
        ORDER BY record_rowid
      `)
      .all()
      .map((row) => ({
        recordRowid: Number(row.record_rowid),
        bundleId: String(row.bundle_id),
        embeddingInput: String(row.embedding_input),
      })),
  }))
}

function ensureMigrationTables(
  db: DatabaseSync,
  vec: VecCapability,
  targetProfile: EmbeddingProfile,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_embed_status (
      record_rowid INTEGER NOT NULL,
      profile_key TEXT NOT NULL,
      status TEXT NOT NULL,
      embedding BLOB,
      PRIMARY KEY (record_rowid, profile_key)
    ) WITHOUT ROWID;
  `)
  ensureEmbedCacheTable(db)

  if (vec === 'vec0') {
    const tableName = vecTableName(targetProfile)
    db.exec(`
      DROP TABLE IF EXISTS ${tableName};
      CREATE VIRTUAL TABLE ${tableName} USING vec0(
        record_rowid integer primary key,
        product text partition key,
        scope_tier text,
        scope_key text,
        status text,
        embedding float[${targetProfile.dim}] distance_metric=cosine
      );
    `)
  }
}

function isTargetEmbedding(
  value: unknown,
  targetProfile: EmbeddingProfile,
): value is Uint8Array {
  return value instanceof Uint8Array
    && value.byteLength
      === targetProfile.dim * Float32Array.BYTES_PER_ELEMENT
}

function embeddingBytes(
  vector: Float32Array,
  targetProfile: EmbeddingProfile,
): Buffer {
  if (vector.length !== targetProfile.dim) {
    throw new RangeError(
      `embedder returned ${vector.length} dimensions; expected ${targetProfile.dim}`,
    )
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function stagedEmbedding(
  db: DatabaseSync,
  recordRowid: number,
  profileKey: string,
  targetProfile: EmbeddingProfile,
): Uint8Array | undefined {
  const row = db
    .prepare(`
      SELECT status, embedding
      FROM profile_embed_status
      WHERE record_rowid = ? AND profile_key = ?
    `)
    .get(recordRowid, profileKey)

  if (row?.status !== 'present') return undefined
  return isTargetEmbedding(row.embedding, targetProfile)
    ? Uint8Array.from(row.embedding)
    : undefined
}

function writeStagedStatus(
  db: DatabaseSync,
  member: FrozenMember,
  profileKey: string,
  status: 'present' | 'missing',
  embedding: Uint8Array | null,
): void {
  transaction(db, 'BEGIN IMMEDIATE', () => {
    db.prepare(`
      INSERT INTO profile_embed_status (
        record_rowid, profile_key, status, embedding
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(record_rowid, profile_key) DO UPDATE SET
        status = excluded.status,
        embedding = excluded.embedding
    `).run(member.recordRowid, profileKey, status, embedding)
  })
}

async function stageFrozenMembers(options: {
  db: DatabaseSync
  targetProfile: EmbeddingProfile
  targetEmbedder: EmbedderPort
  profileKey: string
  frozenMembers: readonly FrozenMember[]
}): Promise<void> {
  const cachedEmbedder = wrapEmbedderWithCache({
    embedder: options.targetEmbedder,
    profile: options.targetProfile,
    db: options.db,
    mode: 'check-and-store',
  })

  for (const member of options.frozenMembers) {
    if (
      stagedEmbedding(
        options.db,
        member.recordRowid,
        options.profileKey,
        options.targetProfile,
      ) !== undefined
    ) {
      continue
    }

    let vector: Float32Array
    try {
      vector = await cachedEmbedder.embedDocument(member.embeddingInput)
    } catch {
      try {
        writeStagedStatus(
          options.db,
          member,
          options.profileKey,
          'missing',
          null,
        )
      } catch (error) {
        throw new Error(
          `recording failed embedding for ${member.bundleId} failed: ${errorMessage(error)}`,
          { cause: error },
        )
      }
      continue
    }

    try {
      writeStagedStatus(
        options.db,
        member,
        options.profileKey,
        'present',
        embeddingBytes(vector, options.targetProfile),
      )
    } catch (error) {
      throw new Error(
        `staging embedding for ${member.bundleId} failed: ${errorMessage(error)}`,
        { cause: error },
      )
    }
  }
}

function currentMembers(db: DatabaseSync): CurrentMember[] {
  return db
    .prepare(`
      SELECT record_rowid, bundle_id, product, scope_tier, scope_key, status,
             embedding_input
      FROM records
      ORDER BY record_rowid
    `)
    .all()
    .map((row) => ({
      recordRowid: Number(row.record_rowid),
      bundleId: String(row.bundle_id),
      product: String(row.product),
      scopeTier: String(row.scope_tier),
      scopeKey: String(row.scope_key),
      status: String(row.status),
      embeddingInput: String(row.embedding_input),
    }))
}

function stagedPresentByRowid(
  db: DatabaseSync,
  profileKey: string,
  targetProfile: EmbeddingProfile,
): Map<number, StagedEmbedding> {
  const staged = new Map<number, StagedEmbedding>()
  for (const row of db
    .prepare(`
      SELECT record_rowid, status, embedding
      FROM profile_embed_status
      WHERE profile_key = ?
      ORDER BY record_rowid
    `)
    .all(profileKey)) {
    if (row.status !== 'present' || !isTargetEmbedding(row.embedding, targetProfile)) {
      continue
    }
    const recordRowid = Number(row.record_rowid)
    staged.set(recordRowid, {
      recordRowid,
      embedding: Uint8Array.from(row.embedding),
    })
  }
  return staged
}

// Compares member ids, never row counts, so a post-snapshot row cannot stand in for a missing one.
function missingFrozenMembers(
  frozenMembers: readonly FrozenMember[],
  currentByRowid: ReadonlyMap<number, CurrentMember>,
  stagedByRowid: ReadonlyMap<number, StagedEmbedding>,
): FrozenMember[] {
  const stagedPresentMemberIds = new Set(stagedByRowid.keys())
  return frozenMembers.filter((member) => {
    const current = currentByRowid.get(member.recordRowid)
    return current === undefined
      || current.bundleId !== member.bundleId
      || current.embeddingInput !== member.embeddingInput
      || !stagedPresentMemberIds.has(member.recordRowid)
  })
}

function flipProfile(options: {
  db: DatabaseSync
  vec: VecCapability
  outgoingProfile: EmbeddingProfile
  targetProfile: EmbeddingProfile
  targetKey: string
  frozenMembers: readonly FrozenMember[]
}): MigrationOutcome {
  return transaction(options.db, 'BEGIN IMMEDIATE', () => {
    const currentProfile = resolveActiveProfile(options.db)
    const currentKey = embeddingProfileKey(currentProfile)
    if (currentKey === options.targetKey) {
      return { flipped: true, profileKey: options.targetKey }
    }

    const outgoingKey = embeddingProfileKey(options.outgoingProfile)
    if (currentKey !== outgoingKey) {
      throw new Error(
        `active embedding profile changed during migration: ${outgoingKey} -> ${currentKey}`,
      )
    }

    const current = currentMembers(options.db)
    const currentByRowid = new Map(
      current.map((member) => [member.recordRowid, member] as const),
    )
    const stagedByRowid = stagedPresentByRowid(
      options.db,
      options.targetKey,
      options.targetProfile,
    )
    const missing = missingFrozenMembers(
      options.frozenMembers,
      currentByRowid,
      stagedByRowid,
    )
    if (missing.length > 0) {
      return {
        flipped: false,
        missing: missing.map((member) => member.bundleId),
      }
    }

    const frozenRowids = new Set(
      options.frozenMembers.map((member) => member.recordRowid),
    )
    const updatePresent = options.db.prepare(`
      UPDATE records
      SET embedding = ?, embed_status = 'present'
      WHERE record_rowid = ? AND bundle_id = ?
    `)
    const updatePending = options.db.prepare(`
      UPDATE records
      SET embedding = NULL, embed_status = 'pending'
      WHERE record_rowid = ?
    `)

    for (const member of options.frozenMembers) {
      const staged = stagedByRowid.get(member.recordRowid)
      if (staged === undefined) {
        throw new Error(`complete migration lost staged member ${member.bundleId}`)
      }
      updatePresent.run(staged.embedding, member.recordRowid, member.bundleId)
    }
    for (const member of current) {
      if (!frozenRowids.has(member.recordRowid)) {
        updatePending.run(member.recordRowid)
      }
    }

    if (options.vec === 'vec0') {
      const tableName = vecTableName(options.targetProfile)
      options.db.exec(`DELETE FROM ${tableName}`)
      const insertTargetVec = options.db.prepare(`
        INSERT INTO ${tableName} (
          record_rowid, product, scope_tier, scope_key, status, embedding
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const member of options.frozenMembers) {
        const currentMember = currentByRowid.get(member.recordRowid)
        const staged = stagedByRowid.get(member.recordRowid)
        if (currentMember === undefined || staged === undefined) {
          throw new Error(`complete migration lost frozen member ${member.bundleId}`)
        }
        insertTargetVec.run(
          BigInt(member.recordRowid),
          currentMember.product,
          currentMember.scopeTier,
          currentMember.scopeKey,
          currentMember.status,
          staged.embedding,
        )
      }
    }

    options.db
      .prepare(`
        INSERT INTO meta (k, v) VALUES ('embedding_profile', ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v
      `)
      .run(options.targetKey)
    dropEmbedCacheForModel(options.db, options.outgoingProfile.model_id)

    return { flipped: true, profileKey: options.targetKey }
  })
}

/**
 * Stage every frozen record for a schema-owned target profile, then atomically
 * flip only when the exact frozen member set is complete.
 */
export async function setActiveEmbeddingProfile(
  options: SetActiveEmbeddingProfileOptions,
): Promise<MigrationOutcome> {
  const target = knownProfile(options.target.profile)
  const snapshot = snapshotMigration(options.db)
  if (embeddingProfileKey(snapshot.outgoingProfile) === target.key) {
    return { flipped: true, profileKey: target.key }
  }

  ensureMigrationTables(options.db, options.vec, target.profile)
  await stageFrozenMembers({
    db: options.db,
    targetProfile: target.profile,
    targetEmbedder: options.target.embedder,
    profileKey: target.key,
    frozenMembers: snapshot.frozenMembers,
  })

  return flipProfile({
    db: options.db,
    vec: options.vec,
    outgoingProfile: snapshot.outgoingProfile,
    targetProfile: target.profile,
    targetKey: target.key,
    frozenMembers: snapshot.frozenMembers,
  })
}
