/**
 * Phase 377 D-08 bounded graph expansion (memory.md §5.5.4).
 *
 * The hot path is strictly one hop. Hubs are skipped entirely in both directions; the spec's
 * matched-anchor-type-only alternative is a deliberate non-choice.
 */
import type { DatabaseSync } from 'node:sqlite'

import {
  FAN_IN_THRESHOLD_K,
  FAN_OUT_CAP,
  HUB_DEGREE_THRESHOLD,
} from './constants.js'
import { preFilterPredicate } from './pre-filter.js'
import type { PreFilterOptions } from './pre-filter.js'

export interface ExpansionSeed {
  readonly bundleId: string
  readonly nodeIds: readonly string[]
}

export type ExpansionQueryScope = PreFilterOptions

export interface ExpansionCandidate {
  readonly recordRowid: number
  readonly bundleId: string
  readonly nodeId: string
  readonly trust: number
  readonly recencyOrdinal: number
  readonly source: 'expanded'
  readonly seedBundleIds: readonly string[]
}

interface DegreeRow {
  node_id: string
  degree: number
}

interface NeighborRow {
  record_rowid: number
  bundle_id: string
  neighbor_node_id: string
  trust: number
  recency_ordinal: number
}

interface NormalizedSeed {
  bundleId: string
  nodeIds: string[]
}

interface CandidateAccumulator {
  best: ExpansionCandidate
  seedBundleIds: Set<string>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compute undirected incident degree once for the complete expansion query. */
function computeNodeDegrees(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`
    WITH edge_endpoints(node_id) AS (
      SELECT src_node_id FROM graph_edges
      UNION ALL
      SELECT dst_node_id FROM graph_edges
    )
    SELECT node_id, COUNT(*) AS degree
    FROM edge_endpoints
    GROUP BY node_id
    ORDER BY node_id ASC
  `).all() as unknown as DegreeRow[]

  return new Map(rows.map((row) => [String(row.node_id), Number(row.degree)]))
}

function readNeighbors(
  db: DatabaseSync,
  seedNodeId: string,
  hubNodeIds: readonly string[],
  queryScope: ExpansionQueryScope,
): NeighborRow[] {
  const predicate = preFilterPredicate(queryScope)
  const hubClause = hubNodeIds.length === 0
    ? ''
    : `AND incident.neighbor_node_id NOT IN (${hubNodeIds.map(() => '?').join(', ')})`
  const hasRecordNodes = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'graph_nodes'")
    .get() !== undefined
  // D-22 completes undirected record-relation traversal. The ordinary incident rows retain
  // edge-owner provenance; this extra arm materializes an outgoing record-node target so a live
  // rename replacement can reach its scrubbed predecessor when audit posture re-admits it.
  const outgoingRecordTargets = hasRecordNodes
    ? `
      UNION ALL

      SELECT
        edge.dst_node_id AS neighbor_node_id,
        edge.edge_type,
        target_record.record_rowid,
        edge.recency_ordinal
      FROM graph_edges AS edge
      JOIN graph_nodes AS target ON target.node_id = edge.dst_node_id
      JOIN records AS target_record
        ON target_record.bundle_id = json_extract(target.natural_key_json, '$')
      WHERE edge.src_node_id = ?
        AND target.node_type IN ('fact', 'procedure', 'caution', 'unknown', 'policy')
    `
    : ''

  return db.prepare(`
    WITH incident AS (
      SELECT
        edge.dst_node_id AS neighbor_node_id,
        edge.edge_type,
        edge.record_rowid,
        edge.recency_ordinal
      FROM graph_edges AS edge
      WHERE edge.src_node_id = ?

      UNION ALL

      SELECT
        edge.src_node_id AS neighbor_node_id,
        edge.edge_type,
        edge.record_rowid,
        edge.recency_ordinal
      FROM graph_edges AS edge
      WHERE edge.dst_node_id = ?

      ${outgoingRecordTargets}
    )
    SELECT
      r.record_rowid,
      r.bundle_id,
      incident.neighbor_node_id,
      r.trust,
      MAX(incident.recency_ordinal) AS recency_ordinal
    FROM incident
    JOIN records AS r ON r.record_rowid = incident.record_rowid
    WHERE ${predicate.sql}
      AND r.scope_tier <> 'global'
      ${hubClause}
    GROUP BY
      r.record_rowid,
      r.bundle_id,
      incident.neighbor_node_id,
      r.trust
    ORDER BY
      r.trust DESC,
      recency_ordinal DESC,
      incident.neighbor_node_id ASC,
      r.bundle_id ASC
    LIMIT ?
  `).all(
    seedNodeId,
    seedNodeId,
    ...(hasRecordNodes ? [seedNodeId] : []),
    ...predicate.binds,
    ...hubNodeIds,
    FAN_OUT_CAP,
  ) as unknown as NeighborRow[]
}

function compareRoutes(left: ExpansionCandidate, right: ExpansionCandidate): number {
  return right.trust - left.trust
    || right.recencyOrdinal - left.recencyOrdinal
    || compareText(left.nodeId, right.nodeId)
    || compareText(left.bundleId, right.bundleId)
    || left.recordRowid - right.recordRowid
}

function compareCandidates(left: ExpansionCandidate, right: ExpansionCandidate): number {
  return right.trust - left.trust
    || right.recencyOrdinal - left.recencyOrdinal
    || compareText(left.bundleId, right.bundleId)
    || compareText(left.nodeId, right.nodeId)
    || left.recordRowid - right.recordRowid
}

function normalizeSeeds(seeds: readonly ExpansionSeed[]): NormalizedSeed[] {
  const byBundle = new Map<string, Set<string>>()
  for (const seed of seeds) {
    const nodeIds = byBundle.get(seed.bundleId) ?? new Set<string>()
    for (const nodeId of seed.nodeIds) nodeIds.add(nodeId)
    byBundle.set(seed.bundleId, nodeIds)
  }
  return [...byBundle]
    .map(([bundleId, nodeIds]) => ({ bundleId, nodeIds: [...nodeIds].sort(compareText) }))
    .sort((left, right) => compareText(left.bundleId, right.bundleId))
}

function seedMayExpand(db: DatabaseSync, bundleId: string): boolean {
  const row = db.prepare(`
    SELECT scope_tier
    FROM records
    WHERE bundle_id = ?
    ORDER BY record_rowid ASC
    LIMIT 1
  `).get(bundleId)
  return row?.scope_tier === 'product'
    || row?.scope_tier === 'suite'
    || row?.scope_tier === 'test'
}

export function expandOneHop(
  db: DatabaseSync,
  seeds: readonly ExpansionSeed[],
  queryScope: ExpansionQueryScope,
  n: number,
): ExpansionCandidate[] {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError('n must be a non-negative safe integer')
  }

  const degrees = computeNodeDegrees(db)
  const hubNodeIds = [...degrees]
    .filter(([, degree]) => degree > HUB_DEGREE_THRESHOLD)
    .map(([nodeId]) => nodeId)
    .sort(compareText)
  const hubs = new Set(hubNodeIds)
  const byBundle = new Map<string, CandidateAccumulator>()

  for (const seed of normalizeSeeds(seeds)) {
    // global records remain direct-match-only and never descend into product records.
    if (!seedMayExpand(db, seed.bundleId)) continue
    for (const seedNodeId of seed.nodeIds) {
      if (hubs.has(seedNodeId)) continue
      for (const row of readNeighbors(db, seedNodeId, hubNodeIds, queryScope)) {
        const candidate: ExpansionCandidate = {
          recordRowid: Number(row.record_rowid),
          bundleId: String(row.bundle_id),
          nodeId: String(row.neighbor_node_id),
          trust: Number(row.trust),
          recencyOrdinal: Number(row.recency_ordinal),
          source: 'expanded',
          seedBundleIds: [seed.bundleId],
        }
        const current = byBundle.get(candidate.bundleId)
        if (current === undefined) {
          byBundle.set(candidate.bundleId, {
            best: candidate,
            seedBundleIds: new Set([seed.bundleId]),
          })
          continue
        }
        current.seedBundleIds.add(seed.bundleId)
        if (compareRoutes(candidate, current.best) < 0) current.best = candidate
      }
    }
  }

  const expanded: ExpansionCandidate[] = []
  for (const { best, seedBundleIds } of byBundle.values()) {
    /**
     * D-11/§13.1 deliberately treats graph ubiquity as a poison/hub signal rather than a
     * relevance boost. This exclusion is expansion-local; direct recall remains the only door.
     */
    if (seedBundleIds.size > FAN_IN_THRESHOLD_K) continue
    expanded.push({ ...best, seedBundleIds: [...seedBundleIds].sort(compareText) })
  }

  // D-07's count cap is deliberately single-owned by fusion.capExpansion; N is contract input only.
  return expanded.sort(compareCandidates)
}
