// SQLite excludes by scope and status at each scan; every ordering ends in a stable identity.
import type { DatabaseSync } from 'node:sqlite'

import {
  canonicalJson,
  normalizeAnchor,
  type Anchor,
} from '@vostride/agent-qa-schema'

import {
  acquireEmbedder,
  resetEmbedderCapability,
  type AcquireEmbedderOutcome,
  type EmbedderProbes,
} from '../embedder-acquire.js'
import { wrapEmbedderWithCache } from '../embed-cache.js'
import type { EmbedderPort } from '../embedder-port.js'
import { EmbedderWorkerTimeoutError } from '../embedder-worker/worker-registration.js'
import {
  embeddingProfileKey,
  isEmbeddingVecCleanupCurrent,
  resolveActiveProfile,
  vecTableName,
  type IndexReaderConnection,
} from '../index-open.js'
import type { FallbackRendering } from '../query-helper.js'
import {
  FTS_WEIGHT_CONTENT,
  FTS_WEIGHT_CONTEXT,
  FTS_WEIGHT_IDENTITY,
} from './constants.js'
import { buildLexicalMatchExpression } from './fts-match.js'
import type { CandidateRawScores, FusionCandidate } from './fusion.js'
import { preFilterPredicate, type PreFilterOptions } from './pre-filter.js'

export interface RetrievalLegScope extends PreFilterOptions {}

export interface LegCandidate extends FusionCandidate {
  readonly recordRowid: number
  readonly product: string
  readonly kind: string
  readonly subtype: string | null
  readonly scopeTier: string
  readonly scopeKey: string
  readonly status: string
  readonly trust: number
  readonly openedAtOrdinal: number
  readonly closedAtOrdinal?: number
  readonly createdAtOrdinal: number
  readonly originClass: string
  readonly summary: string
  readonly embeddingInput: string
  readonly matchedAnchorKeys?: readonly string[]
  readonly matchedDenseRendering?: string
}

export interface DenseLegOptions {
  /** Test/integration seam; production omission runs the automatic acquisition ladder. */
  embedder?: EmbedderPort
  /** Host-resolved posture; a non-ready value deliberately suppresses the automatic ladder. */
  capability?: AcquireEmbedderOutcome
  allowDownload?: boolean
  probes?: EmbedderProbes
}

export type DenseLegRendering =
  | string
  | readonly string[]
  | readonly FallbackRendering[]

type CandidateLeg = 'anchor' | 'dense' | 'lexical'

interface DenseRowCandidate extends LegCandidate {
  distance: number
}

const CANDIDATE_COLUMNS = `
  r.record_rowid,
  r.bundle_id,
  r.product,
  r.kind,
  r.subtype,
  r.scope_tier,
  r.scope_key,
  r.status,
  r.trust,
  r.opened_at_ordinal,
  r.closed_at_ordinal,
  r.created_at_ordinal,
  r.origin_class,
  r.summary,
  r.embedding_input
`

const MAX_SQL_LIMIT = 2_147_483_647

function queryLimit(k: number): number {
  if (k === Number.POSITIVE_INFINITY) return MAX_SQL_LIMIT
  if (!Number.isFinite(k)) return 0
  return Math.min(MAX_SQL_LIMIT, Math.max(0, Math.floor(k)))
}

function compareBundleIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function rowToCandidate(
  row: Record<string, unknown>,
  leg: CandidateLeg,
  rank: number,
  rawScores: CandidateRawScores,
  context: Pick<LegCandidate, 'matchedAnchorKeys' | 'matchedDenseRendering'> = {},
): LegCandidate {
  const closedAt = row.closed_at_ordinal
  return {
    bundleId: String(row.bundle_id),
    recordRowid: Number(row.record_rowid),
    product: String(row.product),
    kind: String(row.kind),
    subtype: row.subtype === null || row.subtype === undefined ? null : String(row.subtype),
    scopeTier: String(row.scope_tier),
    scopeKey: String(row.scope_key),
    status: String(row.status),
    trust: Number(row.trust),
    openedAtOrdinal: Number(row.opened_at_ordinal),
    ...(closedAt === null || closedAt === undefined
      ? {}
      : { closedAtOrdinal: Number(closedAt) }),
    createdAtOrdinal: Number(row.created_at_ordinal),
    originClass: String(row.origin_class),
    summary: String(row.summary),
    embeddingInput: String(row.embedding_input),
    source: 'direct',
    legRanks: { [leg]: rank },
    rawScores,
    ...context,
  }
}

/** Weighted, sign-corrected FTS5 recall over the shared scope/status join. */
export function lexicalLeg(
  db: DatabaseSync,
  lexicalQuery: string,
  scope: RetrievalLegScope,
  requestedK: number,
): LegCandidate[] {
  const k = queryLimit(requestedK)
  const match = buildLexicalMatchExpression(lexicalQuery)
  if (k === 0 || match === '') return []

  const predicate = preFilterPredicate(scope)
  const rows = db.prepare(`
    SELECT ${CANDIDATE_COLUMNS},
      -bm25(fts_records, ?, ?, ?) AS bm25_positive
    FROM fts_records
    JOIN records r ON r.record_rowid = fts_records.rowid
    WHERE fts_records MATCH ?
      AND ${predicate.sql}
    ORDER BY bm25(fts_records, ?, ?, ?), r.bundle_id
    LIMIT ?
  `).all(
    FTS_WEIGHT_IDENTITY,
    FTS_WEIGHT_CONTENT,
    FTS_WEIGHT_CONTEXT,
    match,
    ...predicate.binds,
    FTS_WEIGHT_IDENTITY,
    FTS_WEIGHT_CONTENT,
    FTS_WEIGHT_CONTEXT,
    k,
  )

  return rows.map((row, index) =>
    rowToCandidate(
      row as Record<string, unknown>,
      'lexical',
      index + 1,
      { bm25Positive: Number(row.bm25_positive) },
    ),
  )
}

function denseRenderingTexts(rendering: DenseLegRendering): string[] {
  const values = typeof rendering === 'string'
    ? [rendering]
    : rendering.map((value) => typeof value === 'string' ? value : value.text)
  return [...new Set(values.filter((value) => value !== ''))]
}

function hasEmbedCache(db: DatabaseSync): boolean {
  return db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'embed_cache'
  `).get() !== undefined
}

async function queryEmbedder(
  connection: IndexReaderConnection,
  options: DenseLegOptions,
): Promise<EmbedderPort | undefined> {
  const profile = resolveActiveProfile(connection.db)
  let embedder = options.embedder

  if (embedder === undefined && options.capability !== undefined) {
    const outcome = options.capability
    if (
      outcome.kind !== 'ready'
      || embeddingProfileKey(outcome.profile) !== embeddingProfileKey(profile)
    ) {
      return undefined
    }
    embedder = outcome.embedder
  }

  if (embedder === undefined && options.capability === undefined) {
    const outcome = await acquireEmbedder({
      preferredProfile: profile,
      allowDownload: options.allowDownload ?? false,
      ...(options.probes === undefined ? {} : { probes: options.probes }),
    })
    if (
      outcome.kind !== 'ready'
      || embeddingProfileKey(outcome.profile) !== embeddingProfileKey(profile)
    ) {
      return undefined
    }
    embedder = outcome.embedder
  }
  if (embedder === undefined) return undefined

  // Reader connections cannot create the derived table. An absent cache is a read miss, while a
  // present cache always wraps in check-only mode and can never materialize query rows.
  return hasEmbedCache(connection.db)
    ? wrapEmbedderWithCache({
        embedder,
        profile,
        db: connection.db,
        mode: 'check-only',
      })
    : embedder
}

function queryBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

function float32View(value: unknown): Float32Array | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return undefined
  }
  const copied = Uint8Array.from(value)
  return new Float32Array(copied.buffer, copied.byteOffset, copied.byteLength / 4)
}

function cosineDistance(query: Float32Array, candidate: Float32Array): number | undefined {
  if (candidate.length !== query.length) return undefined
  let dot = 0
  let querySquared = 0
  let candidateSquared = 0
  for (let index = 0; index < query.length; index += 1) {
    const queryValue = query[index]!
    const candidateValue = candidate[index]!
    dot += queryValue * candidateValue
    querySquared += queryValue * queryValue
    candidateSquared += candidateValue * candidateValue
  }
  if (querySquared === 0 || candidateSquared === 0) return undefined
  return 1 - dot / Math.sqrt(querySquared * candidateSquared)
}

function hydrateDenseCandidate(
  db: DatabaseSync,
  recordRowid: number,
  distance: number,
  rendering: string,
  scope: RetrievalLegScope,
  expectedBytes: number,
): DenseRowCandidate | undefined {
  const predicate = preFilterPredicate(scope)
  const row = db.prepare(`
    SELECT ${CANDIDATE_COLUMNS}
    FROM records r
    WHERE r.record_rowid = ?
      AND r.embed_status = 'present'
      AND r.embedding IS NOT NULL
      AND length(r.embedding) = ?
      AND ${predicate.sql}
  `).get(recordRowid, expectedBytes, ...predicate.binds)
  if (row === undefined) return undefined

  return {
    ...rowToCandidate(
      row as Record<string, unknown>,
      'dense',
      0,
      { cosine: 1 - distance },
      { matchedDenseRendering: rendering },
    ),
    distance,
  }
}

function vecStatusClauses(includeSuperseded: boolean | undefined): string {
  return includeSuperseded === true
    ? ''
    : "AND status != 'deprecated' AND status != 'superseded'"
}

function denseVec0(
  connection: IndexReaderConnection,
  embedding: Float32Array,
  rendering: string,
  scope: RetrievalLegScope,
  k: number,
): DenseRowCandidate[] {
  const { db } = connection
  if (!isEmbeddingVecCleanupCurrent(db)) return []

  const profile = resolveActiveProfile(db)
  const expectedBytes = profile.dim * Float32Array.BYTES_PER_ELEMENT
  if (embedding.byteLength !== expectedBytes) {
    throw new RangeError(
      `query embedding byte length ${embedding.byteLength} does not match ${expectedBytes}`,
    )
  }
  const tableName = vecTableName(profile)
  const bytes = queryBlob(embedding)
  const statuses = vecStatusClauses(scope.includeSuperseded)

  // Query A: product partition, constrained to its test/suite/product scope keys.
  const productRows = db.prepare(`
    SELECT record_rowid, distance
    FROM ${tableName}
    WHERE embedding MATCH ?
      AND product = ?
      AND scope_key IN (?, ?, ?)
      ${statuses}
      AND k = ?
    ORDER BY distance
  `).all(
    bytes,
    scope.product,
    scope.testKey,
    scope.suiteKey,
    scope.productKey,
    k,
  )

  // Query B: partition-unconstrained global reach. Global records retain the enumeration product,
  // so imposing product here would silently lose valid rows stored under another partition.
  const globalRows = db.prepare(`
    SELECT record_rowid, distance
    FROM ${tableName}
    WHERE embedding MATCH ?
      AND scope_tier = 'global'
      AND scope_key = ?
      ${statuses}
      AND k = ?
    ORDER BY distance
  `).all(bytes, scope.globalKey, k)

  return [...productRows, ...globalRows]
    .map((row) => ({
      recordRowid: Number(row.record_rowid),
      distance: Number(row.distance),
    }))
    .sort(
      (left, right) => left.distance - right.distance || left.recordRowid - right.recordRowid,
    )
    .slice(0, k)
    .flatMap(({ recordRowid, distance }) => {
      const candidate = hydrateDenseCandidate(
        db,
        recordRowid,
        distance,
        rendering,
        scope,
        expectedBytes,
      )
      return candidate === undefined ? [] : [candidate]
    })
}

function denseBrute(
  connection: IndexReaderConnection,
  embedding: Float32Array,
  rendering: string,
  scope: RetrievalLegScope,
  k: number,
): DenseRowCandidate[] {
  const { db } = connection
  const profile = resolveActiveProfile(db)
  const expectedBytes = profile.dim * Float32Array.BYTES_PER_ELEMENT
  if (embedding.byteLength !== expectedBytes) {
    throw new RangeError(
      `query embedding byte length ${embedding.byteLength} does not match ${expectedBytes}`,
    )
  }
  const predicate = preFilterPredicate(scope)
  const rows = db.prepare(`
    SELECT ${CANDIDATE_COLUMNS}, r.embedding
    FROM records r
    WHERE r.embed_status = 'present'
      AND r.embedding IS NOT NULL
      AND length(r.embedding) = ?
      AND ${predicate.sql}
    ORDER BY r.record_rowid
  `).all(expectedBytes, ...predicate.binds)

  return rows.flatMap((row) => {
    const vector = float32View(row.embedding)
    if (vector === undefined) return []
    const distance = cosineDistance(embedding, vector)
    if (distance === undefined) return []
    return [{
      ...rowToCandidate(
        row as Record<string, unknown>,
        'dense',
        0,
        { cosine: 1 - distance },
        { matchedDenseRendering: rendering },
      ),
      distance,
    }]
  })
    .sort(
      (left, right) => left.distance - right.distance || left.recordRowid - right.recordRowid,
    )
    .slice(0, k)
}

/** Embed query/fallback renderings through a check-only cache and run the selected dense rung. */
export async function denseLeg(
  connection: IndexReaderConnection,
  rendering: DenseLegRendering,
  scope: RetrievalLegScope,
  requestedK: number,
  options: DenseLegOptions = {},
): Promise<LegCandidate[]> {
  const k = queryLimit(requestedK)
  const renderings = denseRenderingTexts(rendering)
  if (k === 0 || renderings.length === 0) return []

  const embedder = await queryEmbedder(connection, options)
  if (embedder === undefined) return []

  const byRecordRowid = new Map<number, DenseRowCandidate>()
  for (const text of renderings) {
    let embedding: Float32Array
    try {
      embedding = await embedder.embedQuery(text)
    } catch (error) {
      if (!(error instanceof EmbedderWorkerTimeoutError)) throw error
      resetEmbedderCapability()
      return []
    }
    const candidates = connection.vec === 'vec0'
      ? denseVec0(connection, embedding, text, scope, k)
      : denseBrute(connection, embedding, text, scope, k)
    for (const candidate of candidates) {
      const current = byRecordRowid.get(candidate.recordRowid)
      if (
        current === undefined
        || candidate.distance < current.distance
        || (candidate.distance === current.distance
          && (candidate.matchedDenseRendering ?? '') < (current.matchedDenseRendering ?? ''))
      ) {
        byRecordRowid.set(candidate.recordRowid, candidate)
      }
    }
  }

  return [...byRecordRowid.values()]
    .sort(
      (left, right) => left.distance - right.distance || left.recordRowid - right.recordRowid,
    )
    .slice(0, k)
    .map(({ distance: _distance, ...candidate }, index) => ({
      ...candidate,
      legRanks: { dense: index + 1 },
    }))
}

/** Exact canonical normalized-json seeds; widened role+name keys remain scan-rung-only. */
export function anchorSeedLeg(
  db: DatabaseSync,
  normalizedAnchors: readonly Anchor[],
  scope: RetrievalLegScope,
): LegCandidate[] {
  const lookupKeys = [...new Set(
    normalizedAnchors.map((anchor) => canonicalJson(normalizeAnchor(anchor))),
  )]
  if (lookupKeys.length === 0) return []

  const predicate = preFilterPredicate(scope)
  const placeholders = lookupKeys.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT ${CANDIDATE_COLUMNS}, a.normalized_json
    FROM anchors a
    JOIN records r ON r.record_rowid = a.record_rowid
    WHERE a.normalized_json IN (${placeholders})
      AND ${predicate.sql}
    ORDER BY r.bundle_id, a.normalized_json
  `).all(...lookupKeys, ...predicate.binds)

  const grouped = new Map<number, {
    row: Record<string, unknown>
    matchedAnchorKeys: string[]
  }>()
  for (const row of rows) {
    const recordRowid = Number(row.record_rowid)
    const key = String(row.normalized_json)
    const current = grouped.get(recordRowid)
    if (current === undefined) {
      grouped.set(recordRowid, {
        row: row as Record<string, unknown>,
        matchedAnchorKeys: [key],
      })
    } else if (!current.matchedAnchorKeys.includes(key)) {
      current.matchedAnchorKeys.push(key)
    }
  }

  return [...grouped.values()]
    .sort((left, right) =>
      compareBundleIds(String(left.row.bundle_id), String(right.row.bundle_id)))
    .map(({ row, matchedAnchorKeys }, index) =>
      rowToCandidate(
        row,
        'anchor',
        index + 1,
        { anchorExact: true },
        { matchedAnchorKeys },
      ),
    )
}
