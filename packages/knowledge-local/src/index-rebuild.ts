/**
 * IDX-01's derived-index writer over canonical Phase 374 bundles.
 *
 * D-02 keeps an absent embedder as a successful all-pending posture; D-05 indexes the bundle's
 * committed embeddingInput; D-10 stores every vector canonically in records before optionally
 * accelerating it through vec0. Per 374 D-03, loadBundle + deriveBundleTrust are the only bundle
 * projection faces. Relation edges are emitted from the complete integrity-valid walk in a second
 * pass so bundle ordering cannot change dangling-target behavior and late targets heal without
 * re-projecting an unchanged source.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  anchorGraphNode,
  canonicalJson,
  guardDistilledObservation,
  recordGraphNode,
} from '@vostride/agent-qa-schema'
import type {
  BundleStatus,
  DistilledObservation,
  EmbeddingProfile,
  GraphNodeNaturalKey,
  GraphNodeType,
  Platform,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import {
  enumerateBundleDirs,
  resolveProductQualifiedBundleDir,
} from './bundle-scan.js'
import {
  buildSituatingLine,
  computeRenderingDrift,
  renderContextual,
} from './contextual-rendering.js'
import type { EmbedderPort } from './embedder-port.js'
import {
  deriveEquivalentToBridges,
  deriveLocatesViaEdges,
  deriveObservationEdges,
} from './graph-derive.js'
import type {
  DerivedGraphEdge,
  DerivedGraphNode,
  GraphDerivation,
  GraphDerivationContext,
} from './graph-derive.js'
import {
  CHECKPOINT_EVERY_N_BUNDLES,
  deleteRecordFromAllSchemaVecTables,
  indexDbPath,
  isEmbeddingVecCleanupCurrent,
  openIndexWriter,
  resolveActiveProfile,
  vecTableName,
} from './index-open.js'
import type { VecCapability } from './index-open.js'
import {
  withCurrentWriterAuthority,
  type WriterLeaseAuthority,
} from './lease/writer-lease.js'
import { clearRebuildRequest } from './rebuild-marker.js'
import { effectivePriorDigest } from './trust-prior-context.js'

export interface RebuildReport {
  projected: number
  skippedIncomplete: number
  scanIssues: string[]
  removed: number
  backfilled: number
  vec: VecCapability
  pendingEmbeddings: number
  maintenanceRemaining: boolean
}

export type RebuildMutationFamily =
  | 'project-bundle'
  | 'checkpoint-passive'
  | 'remove-missing-bundles'
  | 'complete-rendering-epoch'
  | 'complete-trust-epoch'
  | 'clear-rebuild-request'

export interface RebuildIndexHooks {
  /** Test/chaos seam after synchronous DML and immediately before the final commit fence. */
  beforeTransactionCommit?: () => void
  /** Test/chaos seam immediately before one named authority unit acquires its hold. */
  beforeMutationAuthority?: (family: RebuildMutationFamily) => void
  /** Test/chaos seam after authority is held and before the named mutation begins. */
  insideMutationAuthority?: (family: RebuildMutationFamily) => void
}

export interface RebuildIndexOptions {
  knowledgeRoot: string
  embedder?: EmbedderPort
  vecLoadablePath?: string
  writerAuthority?: WriterLeaseAuthority
  hooks?: RebuildIndexHooks
}

export interface ProjectBundleIndexRowOptions {
  knowledgeRoot: string
  bundleId: string
  /** Required whenever the same content-addressed id exists in more than one product. */
  product?: string
}

export const EMBED_STATUS_PENDING = 'pending'
export const EMBED_STATUS_PRESENT = 'present'
/**
 * SAFE-02 terminal state: lexical projection exists, but dense bytes must never be backfilled.
 * nothing writes it now; rows indexed before 441 may still hold it.
 */
export const EMBED_STATUS_SUPPRESSED = 'suppressed'
/**
 * Structurally-dead dense suppression (Deprecate/Supersede scrub), distinct from the SAFE-02
 * terminal above. The contract pair: structural death is reversible — projecting the record live
 * again (e.g. a rollback restore) resets this value to pending so ordinary backfill re-embeds it —
 * while a row already holding EMBED_STATUS_SUPPRESSED stays terminal, including through a
 * death-and-revival cycle.
 */
export const EMBED_STATUS_SCRUBBED = 'scrubbed'

export interface PendingEmbeddingRow {
  record_rowid: number
  bundle_id: string
  contextual_rendering: string
}

/** The single selector used by ordinary vector backfill; terminal suppression is not pending. */
export function selectPendingEmbeddingRows(db: DatabaseSync): PendingEmbeddingRow[] {
  return db
    .prepare(`
      SELECT record_rowid, bundle_id, contextual_rendering
      FROM records
      WHERE embed_status = ?
      ORDER BY record_rowid
    `)
    .all(EMBED_STATUS_PENDING)
    .map((row) => ({
      record_rowid: Number(row.record_rowid),
      bundle_id: String(row.bundle_id),
      contextual_rendering: String(row.contextual_rendering),
    }))
}

interface ProjectedBundle {
  bundle: LoadedBundle
  dir: string
  product: string
}

type AnchorNode = NonNullable<ReturnType<typeof anchorGraphNode>>

interface InsertableGraphNode {
  nodeId: string
  type: GraphNodeType
  naturalKey: GraphNodeNaturalKey
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type MutationAuthorityContext =
  | { hold: WriterLeaseAuthority }
  | { withinHeldAuthority: true }

/**
 * The hold form owns one authority-store transaction for the operation. The within-held form is
 * deliberately raw: its caller already owns that outer transaction and must not re-enter the
 * non-reentrant authority primitive.
 */
function withMutationAuthority<T>(
  authority: MutationAuthorityContext | undefined,
  operation: () => T,
): T {
  if (authority !== undefined && 'hold' in authority) {
    return withCurrentWriterAuthority(
      authority.hold.knowledgeRoot,
      authority.hold,
      operation,
    )
  }
  return operation()
}

function withNamedMutationAuthority<T>(
  authority: MutationAuthorityContext | undefined,
  family: RebuildMutationFamily,
  hooks: RebuildIndexHooks | undefined,
  operation: () => T,
): T {
  hooks?.beforeMutationAuthority?.(family)
  return withMutationAuthority(authority, () => {
    hooks?.insideMutationAuthority?.(family)
    return operation()
  })
}

function transaction(
  db: DatabaseSync,
  operation: () => void,
  authority?: MutationAuthorityContext,
  beforeCommit?: () => void,
  namedMutation?: {
    family: RebuildMutationFamily
    hooks: RebuildIndexHooks | undefined
  },
): void {
  const transact = (): void => {
    db.exec('BEGIN IMMEDIATE')
    try {
      operation()
      beforeCommit?.()
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the projection error that caused the rollback.
      }
      throw error
    }
  }
  if (namedMutation === undefined) {
    withMutationAuthority(authority, transact)
    return
  }
  withNamedMutationAuthority(
    authority,
    namedMutation.family,
    namedMutation.hooks,
    transact,
  )
}

function embeddingBuffer(vector: Float32Array, activeProfile: EmbeddingProfile): Buffer {
  if (vector.length !== activeProfile.dim) {
    throw new RangeError(
      `embedder returned ${vector.length} dimensions; expected ${activeProfile.dim}`,
    )
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

interface VecRowMetadata {
  product: string
  scopeTier: string
  scopeKey: string
  status: string
}

function recordVecMetadata(db: DatabaseSync, recordRowid: number): VecRowMetadata {
  const row = db
    .prepare(`
      SELECT product, scope_tier, scope_key, status
      FROM records
      WHERE record_rowid = ?
    `)
    .get(recordRowid)
  if (row === undefined) {
    throw new Error(`vec metadata source record ${recordRowid} is missing`)
  }
  return {
    product: String(row.product),
    scopeTier: String(row.scope_tier),
    scopeKey: String(row.scope_key),
    status: String(row.status),
  }
}

function identityText(bundle: LoadedBundle): string {
  return bundle.frontmatter.anchors
    .flatMap(({ raw }) => {
      const serialized = canonicalJson(raw)
      if (raw.t === 'selector') return [serialized, raw.literal]
      if (raw.t === 'error') return [serialized, raw.message]
      return [serialized]
    })
    .join('\n')
}

function bundlePlatform(bundle: LoadedBundle): Platform | undefined {
  for (const { normalized } of bundle.frontmatter.anchors) {
    if (normalized.t === 'platform') return normalized.platform
  }
  return undefined
}

function insertGraphNode(
  db: DatabaseSync,
  node: InsertableGraphNode,
  product: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO graph_nodes (
      node_id, node_type, natural_key_json, product
    ) VALUES (?, ?, ?, ?)
  `).run(node.nodeId, node.type, canonicalJson(node.naturalKey), product)
}

function insertGraphEdge(
  db: DatabaseSync,
  edge: {
    srcNodeId: string
    edgeType: string
    dstNodeId: string
    recordRowid: number
    product: string
    recencyOrdinal: number
  },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO graph_edges (
      src_node_id, edge_type, dst_node_id, record_rowid, product, recency_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    edge.srcNodeId,
    edge.edgeType,
    edge.dstNodeId,
    edge.recordRowid,
    edge.product,
    edge.recencyOrdinal,
  )
}

function insertGraphDerivation(db: DatabaseSync, projection: GraphDerivation): void {
  for (const node of projection.nodes) insertGraphNode(db, node, node.product)
  for (const edge of projection.edges) insertGraphEdge(db, edge)
}

function upsertRecord(
  db: DatabaseSync,
  bundle: LoadedBundle,
  product: string,
): { recordRowid: number; status: BundleStatus } {
  const trust = deriveBundleTrust(bundle)
  const digest = effectivePriorDigest()
  // A delta may change one row to another epoch, but cannot certify the full index.
  db.prepare("DELETE FROM meta WHERE k = 'trust_prior_digest' AND v != ?").run(digest)
  db.prepare(`
    INSERT INTO records (
      bundle_id, product, mutable_state_hash, kind, subtype, scope_tier, scope_key,
      status, trust, confirmed, contradicted, helpful, harmful, last_confirmed_ordinal,
      opened_at_ordinal, closed_at_ordinal, created_at_ordinal, origin_class, summary,
      embedding_input, situating_line, contextual_rendering, trust_prior_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bundle_id) DO UPDATE SET
      product = excluded.product,
      mutable_state_hash = excluded.mutable_state_hash,
      kind = excluded.kind,
      subtype = excluded.subtype,
      scope_tier = excluded.scope_tier,
      scope_key = excluded.scope_key,
      status = excluded.status,
      trust = excluded.trust,
      trust_prior_digest = excluded.trust_prior_digest,
      confirmed = excluded.confirmed,
      contradicted = excluded.contradicted,
      helpful = excluded.helpful,
      harmful = excluded.harmful,
      last_confirmed_ordinal = excluded.last_confirmed_ordinal,
      opened_at_ordinal = excluded.opened_at_ordinal,
      closed_at_ordinal = excluded.closed_at_ordinal,
      created_at_ordinal = excluded.created_at_ordinal,
      origin_class = excluded.origin_class,
      summary = excluded.summary,
      embedding_input = excluded.embedding_input
  `).run(
    bundle.manifest.id,
    product,
    bundle.manifest.mutableStateHash,
    bundle.frontmatter.kind,
    bundle.frontmatter.subtype ?? null,
    bundle.frontmatter.scope.tier,
    bundle.frontmatter.scope.key,
    trust.status,
    trust.trust,
    trust.counters.confirmed,
    trust.counters.contradicted,
    trust.counters.helpful,
    trust.counters.harmful,
    trust.lastConfirmedOrdinal,
    trust.validity.openedAtOrdinal,
    trust.validity.closedAtOrdinal ?? null,
    bundle.frontmatter.createdAtOrdinal,
    bundle.frontmatter.originClass,
    bundle.summary,
    bundle.manifest.embeddingInput,
    '',
    bundle.manifest.embeddingInput,
    digest,
  )

  const row = db
    .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
    .get(bundle.manifest.id)
  if (row === undefined) throw new Error(`record upsert lost bundle ${bundle.manifest.id}`)
  return { recordRowid: Number(row.record_rowid), status: trust.status }
}

function replaceFtsAndAnchors(
  db: DatabaseSync,
  bundle: LoadedBundle,
  product: string,
  recordRowid: number,
): void {
  const rendering = db
    .prepare('SELECT situating_line FROM records WHERE record_rowid = ?')
    .get(recordRowid)
  if (rendering === undefined) {
    throw new Error(`FTS projection source record ${recordRowid} is missing`)
  }
  db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
  db.prepare(`
    INSERT INTO fts_records (rowid, identity, content, context)
    VALUES (?, ?, ?, ?)
  `).run(
    recordRowid,
    identityText(bundle),
    bundle.manifest.embeddingInput,
    String(rendering.situating_line),
  )

  db.prepare('DELETE FROM anchors WHERE record_rowid = ?').run(recordRowid)
  const insertAnchor = db.prepare(`
    INSERT INTO anchors (
      record_rowid, product, t, raw_json, normalized_json
    ) VALUES (?, ?, ?, ?, ?)
  `)
  for (const anchor of bundle.frontmatter.anchors) {
    insertAnchor.run(
      recordRowid,
      product,
      anchor.normalized.t,
      canonicalJson(anchor.raw),
      canonicalJson(anchor.normalized),
    )
  }
}

function replaceAnchorGraph(
  db: DatabaseSync,
  bundle: LoadedBundle,
  product: string,
  recordRowid: number,
): void {
  db.prepare('DELETE FROM graph_edges WHERE record_rowid = ?').run(recordRowid)

  const recordNode = recordGraphNode(bundle.frontmatter.kind, bundle.manifest.id)
  insertGraphNode(db, recordNode, product)

  const platform = bundlePlatform(bundle)
  const nodes = new Map<string, AnchorNode>()
  for (const { normalized } of bundle.frontmatter.anchors) {
    const node = anchorGraphNode(normalized, platform)
    if (node !== null) nodes.set(node.nodeId, node)
  }

  const elementNodes: AnchorNode[] = []
  const pageNodes: AnchorNode[] = []
  for (const node of nodes.values()) {
    insertGraphNode(db, node, product)
    insertGraphEdge(db, {
      srcNodeId: recordNode.nodeId,
      edgeType: 'about',
      dstNodeId: node.nodeId,
      recordRowid,
      product,
      recencyOrdinal: bundle.frontmatter.createdAtOrdinal,
    })
    if (node.type === 'element' || node.type === 'web-element' || node.type === 'mobile-element') {
      elementNodes.push(node)
    }
    if (node.type === 'page' || node.type === 'web-page' || node.type === 'mobile-screen') {
      pageNodes.push(node)
    }
  }

  for (const element of elementNodes) {
    for (const page of pageNodes) {
      insertGraphEdge(db, {
        srcNodeId: element.nodeId,
        edgeType: 'part-of',
        dstNodeId: page.nodeId,
        recordRowid,
        product,
        recencyOrdinal: bundle.frontmatter.createdAtOrdinal,
      })
    }
  }

  insertGraphDerivation(
    db,
    deriveLocatesViaEdges(
      bundle.frontmatter.anchors.map(({ normalized }) => normalized),
      platform,
      {
        bundleId: bundle.manifest.id,
        recordRowid,
        product,
        createdAtOrdinal: bundle.frontmatter.createdAtOrdinal,
      },
    ),
  )
}

function storeEmbedding(
  db: DatabaseSync,
  vec: VecCapability,
  recordRowid: number,
  vector: Float32Array,
  activeProfile: EmbeddingProfile,
): void {
  const bytes = embeddingBuffer(vector, activeProfile)
  db.prepare(`
    UPDATE records
    SET embedding = ?, embed_status = ?
    WHERE record_rowid = ?
  `).run(bytes, EMBED_STATUS_PRESENT, recordRowid)

  if (vec === 'vec0') {
    const metadata = recordVecMetadata(db, recordRowid)
    const tableName = vecTableName(activeProfile)
    db.prepare(`DELETE FROM ${tableName} WHERE record_rowid = ?`).run(BigInt(recordRowid))
    db.prepare(`
      INSERT INTO ${tableName} (
        record_rowid, product, scope_tier, scope_key, status, embedding
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      BigInt(recordRowid),
      metadata.product,
      metadata.scopeTier,
      metadata.scopeKey,
      metadata.status,
      bytes,
    )
  }
}

function refreshVecMetadata(
  db: DatabaseSync,
  vec: VecCapability,
  recordRowid: number,
  activeProfile: EmbeddingProfile,
): void {
  if (vec !== 'vec0') return
  const metadata = recordVecMetadata(db, recordRowid)
  db.prepare(`
    UPDATE ${vecTableName(activeProfile)}
    SET scope_tier = ?, scope_key = ?, status = ?
    WHERE record_rowid = ?
  `).run(
    metadata.scopeTier,
    metadata.scopeKey,
    metadata.status,
    BigInt(recordRowid),
  )
}

function isDeadStatus(status: unknown): status is 'superseded' | 'deprecated' {
  return status === 'superseded' || status === 'deprecated'
}

function deleteOrphanGraphNodes(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM graph_nodes
    WHERE node_id NOT IN (
      SELECT src_node_id FROM graph_edges
      UNION
      SELECT dst_node_id FROM graph_edges
    )
  `)
}

/**
 * 379 D-10/D-11 structural forgetting lives inside the canonical projection unit. Every full or
 * single-bundle projection therefore re-derives the scrub: lexical/vector/graph recall rows die,
 * while records and anchors deliberately survive for includeSuperseded/as-of audit reads. The
 * status pre-filter remains the second wall during the commit-to-projection gap.
 */
function scrubDeadRecallRows(
  db: DatabaseSync,
  bundle: LoadedBundle,
  recordRowid: number,
): void {
  db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
  deleteRecordFromAllSchemaVecTables(db, recordRowid)
  /**
   * RATIFICATION (revised, round 4): the round-1 ratification reused SAFE-02's terminal suppressed
   * state here. Round-4 verification proved that conflation makes a rollback-restored supersession
   * victim permanently lose dense recall — the restore re-projection cannot distinguish structural
   * death from governed redaction, and D-15 requires the scrub effect to be invertible. Structural
   * death therefore takes its own reversible scrubbed value, while a row already redacted under
   * SAFE-02 before dying keeps the terminal value through death (terminal wins) so revival can
   * never resurrect redacted content. While dead, both values stay outside the pending backfill
   * selector, rendering refresh, and present-only reconciliation exactly as before the split.
   */
  db.prepare(`
    UPDATE records
    SET embedding = NULL,
        embed_status = CASE WHEN embed_status = ? THEN ? ELSE ? END
    WHERE record_rowid = ?
  `).run(EMBED_STATUS_SUPPRESSED, EMBED_STATUS_SUPPRESSED, EMBED_STATUS_SCRUBBED, recordRowid)

  const recordNode = recordGraphNode(bundle.frontmatter.kind, bundle.manifest.id)
  db.prepare(`
    DELETE FROM graph_edges
    WHERE record_rowid = ?
      OR src_node_id = ?
      OR (dst_node_id = ? AND edge_type <> 'renamed-from')
  `).run(recordRowid, recordNode.nodeId, recordNode.nodeId)
  deleteOrphanGraphNodes(db)
}

function projectBundle(
  db: DatabaseSync,
  vec: VecCapability,
  projected: ProjectedBundle,
  activeProfile: EmbeddingProfile,
  authority?: MutationAuthorityContext,
  beforeCommit?: () => void,
  hooks?: RebuildIndexHooks,
): void {
  transaction(db, () => {
    const { recordRowid, status } = upsertRecord(
      db,
      projected.bundle,
      projected.product,
    )
    replaceFtsAndAnchors(db, projected.bundle, projected.product, recordRowid)
    if (isDeadStatus(status)) {
      scrubDeadRecallRows(db, projected.bundle, recordRowid)
      return
    }
    /**
     * D-15 revival seam: a rollback restore re-projects through applyIndexDeltaForBundle, so the
     * reset lives on this default projection path. The WHERE clause makes it a no-op for
     * pending/present rows and deliberately unable to match the SAFE-02 terminal value — only a
     * structurally scrubbed row projecting live again re-enters the ordinary backfill pipeline.
     */
    db.prepare(`
      UPDATE records
      SET embed_status = ?
      WHERE record_rowid = ? AND embed_status = ?
    `).run(EMBED_STATUS_PENDING, recordRowid, EMBED_STATUS_SCRUBBED)
    refreshVecMetadata(db, vec, recordRowid, activeProfile)
    replaceAnchorGraph(db, projected.bundle, projected.product, recordRowid)
  }, authority, beforeCommit, { family: 'project-bundle', hooks })
}

/**
 * Project exactly one canonical bundle through the same record/FTS/anchor/graph units used by a
 * full rebuild. Commit and journal recovery both call this authority; no projection SQL exists in
 * either orchestration layer.
 */
export function projectBundleIndexRow(opts: ProjectBundleIndexRowOptions): void {
  projectBundleIndexRowWithAuthority(opts)
}

/** @internal Caller already owns the current writer-authority section. */
export function projectBundleIndexRowWithinCurrentAuthority(
  opts: ProjectBundleIndexRowOptions,
): void {
  projectBundleIndexRowWithAuthority(opts, { withinHeldAuthority: true })
}

function projectBundleIndexRowWithAuthority(
  opts: ProjectBundleIndexRowOptions,
  authority?: MutationAuthorityContext,
): void {
  const target = resolveProductQualifiedBundleDir({
    knowledgeRoot: opts.knowledgeRoot,
    recordId: opts.bundleId,
    ...(opts.product === undefined ? {} : { product: opts.product }),
  })
  const outcome = loadBundle(target.dir)
  if (outcome.kind !== 'loaded' || outcome.bundle.manifest.id !== opts.bundleId) {
    throw new Error(`bundle ${target.product}/${opts.bundleId} was not loadable`)
  }
  const integrity = verifyBundleIntegrity(target.dir)
  if (!integrity.ok) {
    throw new Error(
      `cannot project invalid bundle ${target.product}/${opts.bundleId}: `
      + integrity.violations.join('; '),
    )
  }
  const projected: ProjectedBundle = {
    bundle: outcome.bundle,
    dir: target.dir,
    product: target.product,
  }

  const writer = openIndexWriter(opts.knowledgeRoot)
  const activeProfile = resolveActiveProfile(writer.db)
  try {
    projectBundle(writer.db, writer.vec, projected, activeProfile, authority)
    emitRelationEdges(writer.db, [projected], authority)
    const scanIssues: string[] = []
    emitObservationEdges(
      writer.db,
      opts.knowledgeRoot,
      [projected],
      scanIssues,
      authority,
    )
    if (scanIssues.length > 0) {
      throw new Error(`bundle ${opts.bundleId} observation projection failed: ${scanIssues.join('; ')}`)
    }
    emitEquivalentToBridges(writer.db, authority)
    removeOrphanGraphNodes(writer.db, authority)
    refreshContextualRenderings(writer.db, writer.renderingEpochStale, authority)
    withMutationAuthority(authority, () => writer.completeRenderingEpoch())
  } finally {
    writer.close()
  }
}

/**
 * Reconcile relations from every integrity-valid bundle in the current walk, including sources
 * skipped by mutable-state hashing. INSERT OR IGNORE keeps unchanged re-emission idempotent, while
 * relations already participate in mutableStateHash, so only target membership can require healing
 * without a source re-projection.
 */
function emitRelationEdges(
  db: DatabaseSync,
  relationSources: readonly ProjectedBundle[],
  authority?: MutationAuthorityContext,
): void {
  transaction(db, () => {
    for (const { bundle, product } of relationSources) {
      const sourceRow = db
        .prepare('SELECT record_rowid, status FROM records WHERE bundle_id = ?')
        .get(bundle.manifest.id)
      if (sourceRow === undefined || isDeadStatus(sourceRow.status)) continue
      const recordRowid = Number(sourceRow.record_rowid)
      const sourceNode = recordGraphNode(bundle.frontmatter.kind, bundle.manifest.id)

      for (const relation of bundle.relations.relations) {
        const targetRow = db
          .prepare('SELECT kind, status FROM records WHERE bundle_id = ?')
          .get(relation.targetId)
        if (
          targetRow === undefined
          || (isDeadStatus(targetRow.status) && relation.type !== 'renamed-from')
        ) {
          continue
        }
        /**
         * `renamed-from` is the one intentional dead-target relation. The live replacement
         * owns the edge, so audit expansion can still traverse new → old after the victim's own
         * recall rows and edges are structurally scrubbed. Every other dead target stays omitted.
         */
        const targetKind = targetRow.kind as LoadedBundle['frontmatter']['kind']
        const targetNode = recordGraphNode(targetKind, relation.targetId)
        insertGraphNode(db, targetNode, product)
        insertGraphEdge(db, {
          srcNodeId: sourceNode.nodeId,
          edgeType: relation.type,
          dstNodeId: targetNode.nodeId,
          recordRowid,
          product,
          recencyOrdinal: relation.addedAtOrdinal,
        })
      }
    }
  }, authority)
}

function safeObservationPath(
  knowledgeRoot: string,
  source: ProjectedBundle,
): string | undefined {
  const bundleDir = basename(source.dir)
  if (
    source.product === ''
    || source.product === '.'
    || source.product === '..'
    || source.product !== basename(source.product)
    || bundleDir === ''
    || bundleDir === '.'
    || bundleDir === '..'
    || source.dir !== join(knowledgeRoot, 'memory', source.product, 'bundles', bundleDir)
  ) {
    return undefined
  }
  return join(source.dir, 'observations.jsonl')
}

function loadObservations(
  knowledgeRoot: string,
  source: ProjectedBundle,
  scanIssues: string[],
): DistilledObservation[] {
  const observationPath = safeObservationPath(knowledgeRoot, source)
  if (observationPath === undefined) {
    scanIssues.push(`${source.dir}: observations.jsonl: unsafe bundle path`)
    return []
  }
  if (!existsSync(observationPath)) return []

  let text: string
  try {
    text = readFileSync(observationPath, 'utf8')
  } catch (error) {
    scanIssues.push(`${observationPath}: ${errorMessage(error)}`)
    return []
  }

  const observations: DistilledObservation[] = []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const [index, line] of lines.entries()) {
    try {
      observations.push(guardDistilledObservation(JSON.parse(line)))
    } catch (error) {
      scanIssues.push(`${observationPath}:${index + 1}: ${errorMessage(error)}`)
    }
  }
  return observations
}

function deleteObservationEdges(db: DatabaseSync, recordRowid: number): void {
  db.prepare(`
    DELETE FROM graph_edges
    WHERE record_rowid = ?
      AND EXISTS (
        SELECT 1
        FROM graph_nodes AS source
        WHERE source.node_id = graph_edges.src_node_id
          AND (
            (graph_edges.edge_type = 'contains' AND source.node_type = 'test')
            OR (
              graph_edges.edge_type = 'composed-of'
              AND source.node_type = 'procedure'
            )
            OR (
              graph_edges.edge_type IN ('uses', 'on', 'part-of')
              AND source.node_type = 'step'
            )
            OR (graph_edges.edge_type = 'precedes' AND source.node_type = 'flow')
            OR (graph_edges.edge_type = 'caused-by' AND source.node_type = 'error')
          )
      )
  `).run(recordRowid)
}

/** Re-read every valid bundle so fixture/live observation changes do not depend on bundle hashes. */
function emitObservationEdges(
  db: DatabaseSync,
  knowledgeRoot: string,
  sources: readonly ProjectedBundle[],
  scanIssues: string[],
  authority?: MutationAuthorityContext,
): void {
  const prepared: GraphDerivation[] = []
  const recordRowids: number[] = []
  for (const source of sources) {
    const row = db
      .prepare('SELECT record_rowid, status FROM records WHERE bundle_id = ?')
      .get(source.bundle.manifest.id)
    if (row === undefined) continue
    const recordRowid = Number(row.record_rowid)
    if (isDeadStatus(row.status)) {
      // Rule 2: the unconditional observation pass is another graph resurrection vector.
      recordRowids.push(recordRowid)
      continue
    }
    const context: GraphDerivationContext = {
      bundleId: source.bundle.manifest.id,
      recordRowid,
      product: source.product,
      createdAtOrdinal: source.bundle.frontmatter.createdAtOrdinal,
    }
    recordRowids.push(recordRowid)
    prepared.push(
      deriveObservationEdges(
        loadObservations(knowledgeRoot, source, scanIssues),
        context,
      ),
    )
  }

  transaction(db, () => {
    for (const recordRowid of recordRowids) deleteObservationEdges(db, recordRowid)
    for (const projection of prepared) insertGraphDerivation(db, projection)
  }, authority)
}

interface UsesEdgeRow {
  src_node_id: string
  dst_node_id: string
  record_rowid: number
  product: string
  recency_ordinal: number
  bundle_id: string
  node_type: GraphNodeType
  natural_key_json: string
}

function accumulatedUsesEdges(db: DatabaseSync): {
  nodes: DerivedGraphNode[]
  edges: DerivedGraphEdge[]
} {
  const rows = db.prepare(`
    SELECT
      edge.src_node_id,
      edge.dst_node_id,
      edge.record_rowid,
      edge.product,
      edge.recency_ordinal,
      records.bundle_id,
      target.node_type,
      target.natural_key_json
    FROM graph_edges AS edge
    JOIN records ON records.record_rowid = edge.record_rowid
    JOIN graph_nodes AS target ON target.node_id = edge.dst_node_id
    WHERE edge.edge_type = 'uses'
    ORDER BY
      edge.src_node_id,
      edge.edge_type,
      edge.dst_node_id,
      edge.record_rowid
  `).all() as unknown as UsesEdgeRow[]

  const nodes = new Map<string, DerivedGraphNode>()
  const edges: DerivedGraphEdge[] = []
  for (const row of rows) {
    if (!nodes.has(row.dst_node_id)) {
      nodes.set(row.dst_node_id, {
        nodeId: row.dst_node_id,
        type: row.node_type,
        naturalKey: JSON.parse(row.natural_key_json) as GraphNodeNaturalKey,
        product: row.product,
      })
    }
    edges.push({
      srcNodeId: row.src_node_id,
      edgeType: 'uses',
      dstNodeId: row.dst_node_id,
      recordRowid: Number(row.record_rowid),
      bundleId: row.bundle_id,
      product: row.product,
      recencyOrdinal: Number(row.recency_ordinal),
    })
  }
  return { nodes: [...nodes.values()], edges }
}

function emitEquivalentToBridges(
  db: DatabaseSync,
  authority?: MutationAuthorityContext,
): void {
  const accumulated = accumulatedUsesEdges(db)
  const bridges = deriveEquivalentToBridges(accumulated.nodes, accumulated.edges)

  transaction(db, () => {
    db.exec(`
      DELETE FROM graph_edges
      WHERE edge_type = 'equivalent-to'
        AND EXISTS (
          SELECT 1
          FROM graph_nodes AS source
          JOIN graph_nodes AS target
            ON target.node_id = graph_edges.dst_node_id
          WHERE source.node_id = graph_edges.src_node_id
            AND source.node_type = 'web-element'
            AND target.node_type = 'mobile-element'
        )
    `)
    for (const edge of bridges) insertGraphEdge(db, edge)
  }, authority)
}

function removeOrphanGraphNodes(
  db: DatabaseSync,
  authority?: MutationAuthorityContext,
): void {
  transaction(db, () => {
    deleteOrphanGraphNodes(db)
  }, authority)
}

/** Recompute graph-derived prose only after every graph-producing pass has converged. */
function refreshContextualRenderings(
  db: DatabaseSync,
  force = false,
  authority?: MutationAuthorityContext,
): number {
  const rows = db.prepare(`
    SELECT record_rowid, embedding_input, contextual_rendering, status
    FROM records
    ORDER BY record_rowid
  `).all()
  let refreshed = 0

  for (const row of rows) {
    if (isDeadStatus(row.status)) continue
    const recordRowid = Number(row.record_rowid)
    const situatingLine = buildSituatingLine(db, recordRowid)
    const contextualRendering = renderContextual(
      String(row.embedding_input),
      situatingLine,
    )
    if (
      !force
      && !computeRenderingDrift(
        contextualRendering,
        String(row.contextual_rendering),
      )
    ) {
      continue
    }

    transaction(db, () => {
      const fts = db
        .prepare('SELECT identity FROM fts_records WHERE rowid = ?')
        .get(recordRowid)
      if (fts === undefined) {
        throw new Error(`contextual FTS row ${recordRowid} is missing`)
      }
      db.prepare(`
        UPDATE records
        SET
          situating_line = ?,
          contextual_rendering = ?,
          embed_status = CASE
            WHEN embed_status = ? THEN ?
            ELSE ?
          END,
          embedding = NULL
        WHERE record_rowid = ?
      `).run(
        situatingLine,
        contextualRendering,
        EMBED_STATUS_SUPPRESSED,
        EMBED_STATUS_SUPPRESSED,
        EMBED_STATUS_PENDING,
        recordRowid,
      )
      db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
      db.prepare(`
        INSERT INTO fts_records (rowid, identity, content, context)
        VALUES (?, ?, ?, ?)
      `).run(
        recordRowid,
        String(fts.identity),
        String(row.embedding_input),
        situatingLine,
      )
    }, authority)
    refreshed += 1
  }
  return refreshed
}

/** The total per-record projection deletion set shared by the missing-bundle and drain-tail passes. */
function deleteRecordProjectionRows(
  db: DatabaseSync,
  recordRowid: number,
  bundleId: string,
  kind: LoadedBundle['frontmatter']['kind'],
): void {
  const recordNode = recordGraphNode(kind, bundleId)
  deleteRecordFromAllSchemaVecTables(db, recordRowid)
  db.prepare('DELETE FROM fts_records WHERE rowid = ?').run(recordRowid)
  db.prepare('DELETE FROM anchors WHERE record_rowid = ?').run(recordRowid)
  db.prepare(`
    DELETE FROM graph_edges
    WHERE record_rowid = ? OR src_node_id = ? OR dst_node_id = ?
  `).run(recordRowid, recordNode.nodeId, recordNode.nodeId)
  db.prepare('DELETE FROM records WHERE record_rowid = ?').run(recordRowid)
}

function removeMissingBundles(
  db: DatabaseSync,
  seenBundleIds: ReadonlySet<string>,
  authority?: MutationAuthorityContext,
  hooks?: RebuildIndexHooks,
): number {
  const missing = db
    .prepare('SELECT record_rowid, bundle_id, kind FROM records ORDER BY record_rowid')
    .all()
    .filter((row) => !seenBundleIds.has(String(row.bundle_id)))
  if (missing.length === 0) return 0

  transaction(db, () => {
    for (const row of missing) {
      deleteRecordProjectionRows(
        db,
        Number(row.record_rowid),
        String(row.bundle_id),
        row.kind as LoadedBundle['frontmatter']['kind'],
      )
    }
  }, authority, undefined, { family: 'remove-missing-bundles', hooks })

  return missing.length
}

/**
 * WR-01 record-scoped healing: delete the total projection set for exactly the supplied bundle
 * ids inside one transaction and return the number of records removed. An absent index db,
 * empty ids, and ids without records rows are no-ops; embed_cache is untouched (purge-only A4).
 */
export function removeBundleProjectionRows(
  knowledgeRoot: string,
  bundleIds: readonly string[],
  writerAuthority: WriterLeaseAuthority,
): number {
  if (writerAuthority.knowledgeRoot !== knowledgeRoot) {
    throw new TypeError('projection cleanup writerAuthority must belong to knowledgeRoot')
  }
  if (bundleIds.length === 0 || !existsSync(indexDbPath(knowledgeRoot))) return 0

  const writer = openIndexWriter(knowledgeRoot)
  try {
    const selectRecord = writer.db.prepare(
      'SELECT record_rowid, kind FROM records WHERE bundle_id = ?',
    )
    const found = bundleIds.flatMap((bundleId) => {
      const row = selectRecord.get(bundleId)
      return row === undefined
        ? []
        : [{
            recordRowid: Number(row.record_rowid),
            bundleId,
            kind: row.kind as LoadedBundle['frontmatter']['kind'],
          }]
    })
    if (found.length === 0) return 0

    withCurrentWriterAuthority(knowledgeRoot, writerAuthority, () => {
      transaction(writer.db, () => {
        for (const row of found) {
          deleteRecordProjectionRows(writer.db, row.recordRowid, row.bundleId, row.kind)
        }
      }, { withinHeldAuthority: true })
    })
    return found.length
  } finally {
    writer.close()
  }
}

async function backfillPendingEmbeddings(
  db: DatabaseSync,
  vec: VecCapability,
  embedder: EmbedderPort | undefined,
  activeProfile: EmbeddingProfile,
  newlyProjectedBundleIds: ReadonlySet<string>,
  authority?: MutationAuthorityContext,
): Promise<number> {
  if (embedder === undefined) return 0

  const pending = selectPendingEmbeddingRows(db)
  let backfilled = 0
  for (const row of pending) {
    let vector: Float32Array
    try {
      vector = await embedder.embedDocument(String(row.contextual_rendering))
    } catch (error) {
      throw new Error(
        `embedding ${String(row.bundle_id)} failed: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    transaction(db, () => {
      storeEmbedding(
        db,
        vec,
        Number(row.record_rowid),
        vector,
        activeProfile,
      )
    }, authority)
    // Keep RebuildReport.backfilled's established meaning: rows carried pending into this rebuild.
    if (!newlyProjectedBundleIds.has(String(row.bundle_id))) backfilled += 1
  }
  return backfilled
}

function reconcileVecRows(
  db: DatabaseSync,
  vec: VecCapability,
  activeProfile: EmbeddingProfile,
  authority?: MutationAuthorityContext,
): void {
  if (vec !== 'vec0') return
  const tableName = vecTableName(activeProfile)
  const vecRows = new Map(
    db.prepare(`
      SELECT record_rowid, scope_tier, scope_key, status
      FROM ${tableName}
    `).all().map((row) => [
      Number(row.record_rowid),
      {
        scopeTier: String(row.scope_tier),
        scopeKey: String(row.scope_key),
        status: String(row.status),
      },
    ]),
  )
  /**
   * Writer open verifies the meta stamp before any present canonical bytes are trusted, so the
   * stamp is their profile provenance without adding a per-row profile column. Status and exact
   * byte length remain defense-in-depth gates: the active vec table must never receive bytes that
   * the active profile could not have produced.
   */
  const canonical = db
    .prepare(`
      SELECT record_rowid, product, scope_tier, scope_key, status, embedding
      FROM records
      WHERE embedding IS NOT NULL
        AND embed_status = ?
        AND length(embedding) = ?
      ORDER BY record_rowid
    `)
    .all(EMBED_STATUS_PRESENT, activeProfile.dim * Float32Array.BYTES_PER_ELEMENT)
  const canonicalRowids = new Set(canonical.map((row) => Number(row.record_rowid)))

  transaction(db, () => {
    const deleteVec = db.prepare(`DELETE FROM ${tableName} WHERE record_rowid = ?`)
    for (const recordRowid of vecRows.keys()) {
      if (!canonicalRowids.has(recordRowid)) deleteVec.run(BigInt(recordRowid))
    }

    const insertVec = db.prepare(`
      INSERT INTO ${tableName} (
        record_rowid, product, scope_tier, scope_key, status, embedding
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    const updateMetadata = db.prepare(`
      UPDATE ${tableName}
      SET scope_tier = ?, scope_key = ?, status = ?
      WHERE record_rowid = ?
    `)
    for (const row of canonical) {
      const recordRowid = Number(row.record_rowid)
      const scopeTier = String(row.scope_tier)
      const scopeKey = String(row.scope_key)
      const status = String(row.status)
      const vecRow = vecRows.get(recordRowid)
      if (vecRow === undefined) {
        insertVec.run(
          BigInt(recordRowid),
          String(row.product),
          scopeTier,
          scopeKey,
          status,
          row.embedding as Uint8Array,
        )
        continue
      }
      if (
        vecRow.scopeTier !== scopeTier
        || vecRow.scopeKey !== scopeKey
        || vecRow.status !== status
      ) {
        updateMetadata.run(scopeTier, scopeKey, status, BigInt(recordRowid))
      }
    }
  }, authority)
}

/** Hash-selected projection plus the independent D-02 backfill and D-10 reconciliation passes. */
export async function rebuildIndex(opts: RebuildIndexOptions): Promise<RebuildReport> {
  const digest = effectivePriorDigest()
  const writerAuthority = opts.writerAuthority
  if (
    writerAuthority !== undefined
    && writerAuthority.knowledgeRoot !== opts.knowledgeRoot
  ) {
    throw new TypeError('rebuild writerAuthority must belong to knowledgeRoot')
  }
  const authority: MutationAuthorityContext | undefined = writerAuthority === undefined
    ? undefined
    : { hold: writerAuthority }
  const writer = withMutationAuthority(
    authority,
    () => openIndexWriter(
      opts.knowledgeRoot,
      opts.vecLoadablePath === undefined
        ? {}
        : { vecLoadablePath: opts.vecLoadablePath },
    ),
  )
  const activeProfile = resolveActiveProfile(writer.db)
  const report: RebuildReport = {
    projected: 0,
    skippedIncomplete: 0,
    scanIssues: [],
    removed: 0,
    backfilled: 0,
    vec: writer.vec,
    pendingEmbeddings: 0,
    maintenanceRemaining: true,
  }
  const projected: ProjectedBundle[] = []
  const relationSources: ProjectedBundle[] = []
  const seenBundleIds = new Set<string>()
  let processedBundles = 0

  try {
    // Invalidate before any row can commit. An interruption cannot look complete, even
    // when retrying the same epoch after a partially completed prior pass.
    transaction(writer.db, () => {
      writer.db.prepare("DELETE FROM meta WHERE k = 'trust_prior_digest'").run()
    }, authority)
    for (const entry of enumerateBundleDirs(opts.knowledgeRoot)) {
      const outcome = loadBundle(entry.dir)
      if (outcome.kind === 'incomplete') {
        seenBundleIds.add(basename(entry.dir))
        report.skippedIncomplete += 1
        continue
      }
      if (outcome.kind !== 'loaded') {
        seenBundleIds.add(basename(entry.dir))
        const reason = 'reason' in outcome ? `: ${outcome.reason}` : ''
        report.scanIssues.push(`${entry.dir}: ${outcome.kind}${reason}`)
        continue
      }

      seenBundleIds.add(outcome.bundle.manifest.id)
      const integrity = verifyBundleIntegrity(entry.dir)
      if (!integrity.ok) {
        report.scanIssues.push(`${entry.dir}: integrity: ${integrity.violations.join('; ')}`)
        continue
      }
      const item = { bundle: outcome.bundle, dir: entry.dir, product: entry.product }
      relationSources.push(item)
      const current = writer.db
        .prepare(`
          SELECT mutable_state_hash, trust_prior_digest
          FROM records
          WHERE bundle_id = ?
        `)
        .get(outcome.bundle.manifest.id)
      processedBundles += 1
      if (current?.mutable_state_hash === outcome.bundle.manifest.mutableStateHash) {
        if (current.trust_prior_digest !== digest) {
          // Trust-only reprojection must not undo SAFE-02 lexical redaction or disturb
          // rendering, graph, embedding provenance, counters or lifecycle fields.
          transaction(writer.db, () => {
            writer.db.prepare('UPDATE records SET trust = ?, trust_prior_digest = ? WHERE bundle_id = ?')
              .run(deriveBundleTrust(outcome.bundle).trust, digest, outcome.bundle.manifest.id)
          }, authority, opts.hooks?.beforeTransactionCommit, { family: 'project-bundle', hooks: opts.hooks })
          report.projected += 1
        }
        if (processedBundles % CHECKPOINT_EVERY_N_BUNDLES === 0) {
          withNamedMutationAuthority(
            authority,
            'checkpoint-passive',
            opts.hooks,
            () => writer.checkpointPassive(),
          )
        }
        continue
      }

      projectBundle(
        writer.db,
        writer.vec,
        item,
        activeProfile,
        authority,
        opts.hooks?.beforeTransactionCommit,
        opts.hooks,
      )
      projected.push(item)
      report.projected += 1
      if (processedBundles % CHECKPOINT_EVERY_N_BUNDLES === 0) {
        withNamedMutationAuthority(
          authority,
          'checkpoint-passive',
          opts.hooks,
          () => writer.checkpointPassive(),
        )
      }
    }

    report.removed = removeMissingBundles(
      writer.db,
      seenBundleIds,
      authority,
      opts.hooks,
    )
    emitRelationEdges(writer.db, relationSources, authority)
    emitObservationEdges(
      writer.db,
      opts.knowledgeRoot,
      relationSources,
      report.scanIssues,
      authority,
    )
    emitEquivalentToBridges(writer.db, authority)
    removeOrphanGraphNodes(writer.db, authority)
    refreshContextualRenderings(writer.db, writer.renderingEpochStale, authority)
    report.backfilled = await backfillPendingEmbeddings(
      writer.db,
      writer.vec,
      opts.embedder,
      activeProfile,
      new Set(projected.map(({ bundle }) => bundle.manifest.id)),
      authority,
    )
    reconcileVecRows(writer.db, writer.vec, activeProfile, authority)
    withNamedMutationAuthority(
      authority,
      'complete-rendering-epoch',
      opts.hooks,
      () => writer.completeRenderingEpoch(),
    )
    if (writerAuthority !== undefined && report.skippedIncomplete === 0 && report.scanIssues.length === 0) {
      transaction(writer.db, () => {
        const mixed = writer.db.prepare('SELECT 1 FROM records WHERE trust_prior_digest != ? LIMIT 1').get(digest)
        if (mixed !== undefined) return
        writer.db.prepare("INSERT INTO meta (k, v) VALUES ('trust_prior_digest', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(digest)
      }, authority, undefined, { family: 'complete-trust-epoch', hooks: opts.hooks })
    }
    report.pendingEmbeddings = selectPendingEmbeddingRows(writer.db).length
    report.maintenanceRemaining =
      report.pendingEmbeddings > 0
      || writer.renderingEpochStale
      || !isEmbeddingVecCleanupCurrent(writer.db)
    if (!report.maintenanceRemaining) {
      withNamedMutationAuthority(
        authority,
        'clear-rebuild-request',
        opts.hooks,
        () => clearRebuildRequest(opts.knowledgeRoot),
      )
    }
    return report
  } finally {
    writer.close()
  }
}
