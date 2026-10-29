// A derived-index projection only; committed bundle bytes never depend on cross-bundle graph state.
import type { DatabaseSync } from 'node:sqlite'

import { recordGraphNode } from '@vostride/agent-qa-schema'

import { SITUATING_LINE_MAX_CHARS } from './retrieval/constants.js'

type RecordKind = 'fact' | 'procedure' | 'caution' | 'unknown' | 'policy'

interface CandidateRow {
  node_id: string
  node_type?: string
  natural_key_json?: string
  summary?: string
  support_trust: number
  recency_ordinal: number
}

interface SituatingCandidate {
  nodeId: string
  text: string
  trust: number
  recencyOrdinal: number
}

function recordKind(value: unknown): RecordKind {
  if (
    value === 'fact'
    || value === 'procedure'
    || value === 'caution'
    || value === 'unknown'
    || value === 'policy'
  ) {
    return value
  }
  throw new TypeError(`unsupported contextual-rendering record kind ${String(value)}`)
}

function compareCandidates(left: SituatingCandidate, right: SituatingCandidate): number {
  return right.trust - left.trust
    || right.recencyOrdinal - left.recencyOrdinal
    || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
}

function sentence(prefix: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return `${prefix}: ${trimmed}${/[.!?]$/.test(trimmed) ? '' : '.'}`
}

function naturalKeyText(serialized: string): string {
  const parsed = JSON.parse(serialized) as unknown
  if (typeof parsed === 'string') return parsed
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed)
  if (parsed !== null && typeof parsed === 'object') {
    const value = parsed as Record<string, unknown>
    for (const key of ['name', 'route', 'id', 'naturalKey']) {
      if (typeof value[key] === 'string') return value[key]
    }
  }
  return serialized
}

function candidate(row: CandidateRow, text: string): SituatingCandidate | undefined {
  if (text === '') return undefined
  return {
    nodeId: String(row.node_id),
    text,
    trust: Number(row.support_trust),
    recencyOrdinal: Number(row.recency_ordinal),
  }
}

function ownershipCandidates(
  db: DatabaseSync,
  recordRowid: number,
  recordNodeId: string,
): SituatingCandidate[] {
  const rows = db.prepare(`
    WITH record_seeds(node_id) AS (
      SELECT ?
      UNION
      SELECT dst_node_id
      FROM graph_edges
      WHERE src_node_id = ? AND edge_type = 'about'
      UNION
      SELECT src_node_id FROM graph_edges WHERE record_rowid = ?
      UNION
      SELECT dst_node_id FROM graph_edges WHERE record_rowid = ?
    ),
    owner_support AS (
      SELECT
        target.node_id,
        target.node_type,
        target.natural_key_json,
        support.trust AS support_trust,
        edge.recency_ordinal
      FROM graph_edges AS edge
      JOIN record_seeds AS seed ON seed.node_id = edge.src_node_id
      JOIN graph_nodes AS target ON target.node_id = edge.dst_node_id
      JOIN records AS support ON support.record_rowid = edge.record_rowid
      WHERE edge.edge_type IN ('part-of', 'on')
        AND target.node_type IN ('page', 'web-page', 'mobile-screen', 'flow', 'procedure')

      UNION ALL

      SELECT
        source.node_id,
        source.node_type,
        source.natural_key_json,
        support.trust AS support_trust,
        edge.recency_ordinal
      FROM graph_edges AS edge
      JOIN record_seeds AS seed ON seed.node_id = edge.dst_node_id
      JOIN graph_nodes AS source ON source.node_id = edge.src_node_id
      JOIN records AS support ON support.record_rowid = edge.record_rowid
      WHERE edge.edge_type = 'composed-of'
        AND source.node_type = 'procedure'

      UNION ALL

      SELECT
        target.node_id,
        target.node_type,
        target.natural_key_json,
        support.trust AS support_trust,
        edge.recency_ordinal
      FROM graph_edges AS edge
      JOIN graph_nodes AS target ON target.node_id = edge.dst_node_id
      JOIN records AS support ON support.record_rowid = edge.record_rowid
      WHERE edge.src_node_id = ?
        AND edge.edge_type = 'about'
        AND target.node_type IN ('page', 'web-page', 'mobile-screen', 'flow', 'procedure')
    )
    SELECT node_id, node_type, natural_key_json, support_trust, recency_ordinal
    FROM owner_support
    ORDER BY support_trust DESC, recency_ordinal DESC, node_id ASC
  `).all(recordNodeId, recordNodeId, recordRowid, recordRowid, recordNodeId) as unknown as CandidateRow[]

  const candidates = new Map<string, SituatingCandidate>()
  for (const row of rows) {
    const prefix = row.node_type === 'flow'
      ? 'Flow'
      : row.node_type === 'procedure'
        ? 'Procedure'
        : 'Page'
    const value = naturalKeyText(String(row.natural_key_json))
    const next = candidate(row, sentence(prefix, value))
    if (next !== undefined && !candidates.has(next.nodeId)) candidates.set(next.nodeId, next)
  }
  return [...candidates.values()]
}

function relatedRecordCandidate(
  db: DatabaseSync,
  recordNodeId: string,
  kind: 'lineage' | 'caution',
): SituatingCandidate | undefined {
  const edgePredicate = kind === 'lineage'
    ? "edge.edge_type IN ('supersedes', 'superseded-by')"
    : "edge.edge_type IN ('derived-from', 'conflicts-with', 'relates-to', 'renamed-from', 'equivalent-to')"
  const kindPredicate = kind === 'caution' ? "AND neighbor_record.kind = 'caution'" : ''
  const row = db.prepare(`
    SELECT
      neighbor.node_id,
      neighbor_record.summary,
      neighbor_record.trust AS support_trust,
      edge.recency_ordinal
    FROM graph_edges AS edge
    JOIN graph_nodes AS neighbor
      ON neighbor.node_id = CASE
        WHEN edge.src_node_id = ? THEN edge.dst_node_id
        ELSE edge.src_node_id
      END
    JOIN records AS neighbor_record
      ON neighbor.natural_key_json = json_quote(neighbor_record.bundle_id)
    WHERE ${edgePredicate}
      AND (edge.src_node_id = ? OR edge.dst_node_id = ?)
      ${kindPredicate}
    ORDER BY support_trust DESC, recency_ordinal DESC, node_id ASC
    LIMIT 1
  `).get(recordNodeId, recordNodeId, recordNodeId) as unknown as CandidateRow | undefined
  if (row === undefined) return undefined
  return candidate(
    row,
    sentence(kind === 'lineage' ? 'Supersession' : 'Caution', String(row.summary)),
  )
}

export function buildSituatingLine(db: DatabaseSync, recordRowid: number): string {
  if (!Number.isSafeInteger(recordRowid) || recordRowid <= 0) {
    throw new RangeError('recordRowid must be a positive safe integer')
  }
  const record = db
    .prepare('SELECT bundle_id, kind FROM records WHERE record_rowid = ?')
    .get(recordRowid)
  if (record === undefined) return ''

  const recordNodeId = recordGraphNode(
    recordKind(record.kind),
    String(record.bundle_id),
  ).nodeId
  const candidates = ownershipCandidates(db, recordRowid, recordNodeId)
  const lineage = relatedRecordCandidate(db, recordNodeId, 'lineage')
  const caution = relatedRecordCandidate(db, recordNodeId, 'caution')
  if (lineage !== undefined) candidates.push(lineage)
  if (caution !== undefined) candidates.push(caution)
  candidates.sort(compareCandidates)

  const clauses: string[] = []
  let length = 0
  for (const item of candidates) {
    const nextLength = length + (clauses.length === 0 ? 0 : 1) + item.text.length
    if (nextLength > SITUATING_LINE_MAX_CHARS) break
    clauses.push(item.text)
    length = nextLength
  }
  return clauses.join(' ')
}

export function renderContextual(selfFields: string, situatingLine: string): string {
  return situatingLine === '' ? selfFields : `${selfFields}\n${situatingLine}`
}

export function computeRenderingDrift(expected: string, stored: string): boolean {
  return expected !== stored
}
