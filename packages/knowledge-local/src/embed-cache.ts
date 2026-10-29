// The leg discriminator keeps document and query embeddings of identical text from aliasing.
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { EmbeddingProfile } from '@vostride/agent-qa-schema'

import type { EmbedderPort } from './embedder-port.js'

export type EmbedCacheLeg = 'doc' | 'query'
export type EmbedCacheMode = 'check-only' | 'check-and-store'

export interface EmbedCacheLookup {
  db: DatabaseSync
  profile: EmbeddingProfile
  leg: EmbedCacheLeg
  rendering: string
}

export interface EmbedCachePut extends EmbedCacheLookup {
  vector: Float32Array
}

export interface EmbedCacheWrapperOptions {
  embedder: EmbedderPort
  profile: EmbeddingProfile
  db: DatabaseSync
  mode: EmbedCacheMode
}

function renderingSha256(rendering: string): string {
  return createHash('sha256').update(rendering).digest('hex')
}

/** Create the derived cache table from a writer-role connection. */
export function ensureEmbedCacheTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_cache (
      model_id TEXT NOT NULL,
      dtype TEXT NOT NULL,
      revision TEXT NOT NULL,
      rendering_sha256 TEXT NOT NULL,
      dim INTEGER NOT NULL,
      leg TEXT NOT NULL CHECK (leg IN ('doc', 'query')),
      embedding BLOB NOT NULL,
      PRIMARY KEY (model_id, dtype, revision, leg, rendering_sha256)
    ) WITHOUT ROWID;
  `)
}

/** Return a copied vector so callers cannot mutate SQLite-owned row bytes. */
export function getCachedEmbedding({
  db,
  profile,
  leg,
  rendering,
}: EmbedCacheLookup): Float32Array | undefined {
  const row = db
    .prepare(`
      SELECT dim, embedding
      FROM embed_cache
      WHERE model_id = ?
        AND dtype = ?
        AND revision = ?
        AND leg = ?
        AND rendering_sha256 = ?
    `)
    .get(
      profile.model_id,
      profile.dtype,
      profile.revision,
      leg,
      renderingSha256(rendering),
    )

  if (row === undefined) return undefined
  if (row.dim !== profile.dim) {
    const actualDim = String(row.dim)
    throw new RangeError(
      `cached embedding dimension ${actualDim} does not match profile dimension ${profile.dim}`,
    )
  }
  if (!(row.embedding instanceof Uint8Array)) {
    throw new TypeError('cached embedding must be a SQLite BLOB')
  }

  const expectedBytes = profile.dim * Float32Array.BYTES_PER_ELEMENT
  if (row.embedding.byteLength !== expectedBytes) {
    throw new RangeError(
      `cached embedding byte length ${row.embedding.byteLength} does not match ${expectedBytes}`,
    )
  }

  const bytes = Uint8Array.from(row.embedding)
  return new Float32Array(bytes.buffer, bytes.byteOffset, profile.dim)
}

/** Store an exact Float32 byte copy under the raw-rendering content hash. */
export function putCachedEmbedding({
  db,
  profile,
  leg,
  rendering,
  vector,
}: EmbedCachePut): void {
  if (vector.length !== profile.dim) {
    throw new RangeError(
      `embedding dimension ${vector.length} does not match profile dimension ${profile.dim}`,
    )
  }

  const bytes = Uint8Array.from(
    new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
  )
  db.prepare(`
    INSERT OR REPLACE INTO embed_cache (
      model_id,
      dtype,
      revision,
      rendering_sha256,
      dim,
      leg,
      embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.model_id,
    profile.dtype,
    profile.revision,
    renderingSha256(rendering),
    profile.dim,
    leg,
    bytes,
  )
}

/** Evict every cached leg/revision/dtype row owned by one model id. */
export function dropEmbedCacheForModel(db: DatabaseSync, modelId: string): void {
  db.prepare('DELETE FROM embed_cache WHERE model_id = ?').run(modelId)
}

// Readers check only and never write on a miss; writer-role paths check and store.
export function wrapEmbedderWithCache({
  embedder,
  profile,
  db,
  mode,
}: EmbedCacheWrapperOptions): EmbedderPort {
  async function resolve(
    leg: EmbedCacheLeg,
    rendering: string,
    embed: () => Promise<Float32Array>,
  ): Promise<Float32Array> {
    const cached = getCachedEmbedding({ db, profile, leg, rendering })
    if (cached !== undefined) return cached

    const vector = await embed()
    if (mode === 'check-and-store') {
      putCachedEmbedding({ db, profile, leg, rendering, vector })
    }
    return vector
  }

  return {
    embedDocument(rendering: string): Promise<Float32Array> {
      return resolve('doc', rendering, () => embedder.embedDocument(rendering))
    },
    embedQuery(rendering: string): Promise<Float32Array> {
      return resolve('query', rendering, () => embedder.embedQuery(rendering))
    },
  }
}
