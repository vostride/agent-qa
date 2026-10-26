/**
 * knowledge-local implementation of the agent-side AuthoringReadPort (D-13): the 4th channel's
 * composition boundary. Shares the serving reader's hydration internals and the one derived
 * index SQLite; keeps servingReader/KnowledgeHintReader untouched.
 */
import { existsSync } from 'node:fs'

import type { AuthoringReadPort } from '@vostride/agent-qa-agent'
import {
  identityTupleKey,
  normalizeAnchor,
  slugBranch,
  type Anchor,
  type AuthoringBrief,
  type ScopeKey,
} from '@vostride/agent-qa-schema'

import type { EmbedderPort } from '../embedder-port.js'
import { indexDbPath, openIndexReaderConnection } from '../index-open.js'
import { foldQuarantineLedgerState, readQuarantineLedger } from '../quarantine/ledger.js'
import { hasDenseCandidates } from '../retrieve.js'
import { denseLeg, type RetrievalLegScope } from '../retrieval/legs.js'
import { scopeLadderPredicate } from '../retrieval/pre-filter.js'
import {
  assembleAuthoringBrief,
  type AuthoringExemplarRow,
  type AuthoringTestRef,
} from './get-authoring-brief.js'
import {
  hydrateRows,
  readIndexRows,
  type OpenServingKnowledgeReaderConfig,
} from './reader.js'

/**
 * PROVISIONAL authoring-brief budget, computed as a plain number at this composition boundary
 * (377 D-07 lineage: budgets are numbers passed down, never config reads inside assemblies).
 */
export const AUTHORING_BRIEF_DEFAULT_BUDGET = 2_000

/** PROVISIONAL dense candidate cap pending authoring-channel retrieval telemetry. */
export const AUTHORING_DENSE_K = 32

export interface AuthoringReaderDependencies {
  /** Consumer-owned test inventory crossing this boundary as identity refs only. */
  discoverKnownTests?: () => readonly AuthoringTestRef[]
  /** Test/integration seam; production omission uses denseLeg's automatic acquisition ladder. */
  embedder?: EmbedderPort
  /**
   * ISO-8601 instant the quarantine fold compares expiry against (390 D-11). A seam rather than a
   * clock read inside the fold: `'expired'` is COMPUTED from this value, so pinning an expiry
   * boundary one second either side has to be possible without waiting for wall time. Production
   * omission reads the clock ONCE per brief, at this composition boundary.
   */
  now?: () => string
}

interface OutcomeRow {
  product: string
  file_path: string
  test_name: string
  passes: number
  failures: number
  heals: number
  flake_count: number
  last_outcomes_json: string
}

/**
 * The identities the committed ledger currently suppresses (390 D-02), keyed exactly the way the
 * projection is keyed — `(product, filePath, testName)`, with the ledger's `product` carrying the
 * same slugged partition the projection rows do.
 *
 * Only `'quarantined'` counts. `'expired'` and both released states are deliberately NOT excluded:
 * an entry whose deadline lapsed has stopped suppressing (D-11) while staying listed, and a
 * released entry is a decision someone made.
 *
 * NO try/catch. A ledger this build cannot read propagates its typed error, because the one
 * outcome that must be impossible here is degrading unreadable committed truth to "nothing is
 * quarantined" — that silently un-quarantines every entry in the file. Refused individual LINES
 * are already surfaced as data by the read itself and never became entries.
 */
function quarantinedIdentityKeys(knowledgeRoot: string, now: string): ReadonlySet<string> {
  const { events } = readQuarantineLedger(knowledgeRoot)
  return new Set(
    foldQuarantineLedgerState(events, now)
      .filter((entry) => entry.state === 'quarantined')
      .map((entry) => identityTupleKey([entry.product, entry.filePath, entry.testName])),
  )
}

function parseLastOutcomes(json: string): { buildOrdinal: number; passed: boolean }[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => (
      typeof entry === 'object'
        && entry !== null
        && typeof (entry as { buildOrdinal?: unknown }).buildOrdinal === 'number'
        && typeof (entry as { passed?: unknown }).passed === 'boolean'
        ? [{
            buildOrdinal: (entry as { buildOrdinal: number }).buildOrdinal,
            passed: (entry as { passed: boolean }).passed,
          }]
        : []
    ))
  } catch {
    // A malformed window heals through the projection rebuild; serve the row without it.
    return []
  }
}

/**
 * Read the run-outcome projection through the one index reader connection and the same
 * scope ladder as ordinary knowledge records. The tables are deliberately outside
 * REQUIRED_INDEX_TABLES, so an absent or pre-partition shape is an empty projection —
 * the ABRF-02 empty edge, never a throw or an unfiltered cross-product read.
 */
function readProjectionRows(
  config: OpenServingKnowledgeReaderConfig,
  scope: ScopeKey,
  now: string,
): AuthoringExemplarRow[] {
  if (!existsSync(indexDbPath(config.knowledgeRoot))) return []

  const reader = openIndexReaderConnection(config.knowledgeRoot)
  try {
    const present = reader.db.prepare(`
      SELECT count(*) AS tables
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('run_test_outcomes', 'run_test_anchors')
    `).get() as { tables: number } | undefined
    if (Number(present?.tables ?? 0) < 2) return []

    const partitionColumnsPresent = [
      "PRAGMA table_info('run_test_outcomes')",
      "PRAGMA table_info('run_test_anchors')",
    ].every((pragma) => {
      const columns = new Set(reader.db.prepare(pragma).all().map((row) => String(row.name)))
      return ['product', 'scope_tier', 'scope_key'].every((column) => columns.has(column))
    })
    if (!partitionColumnsPresent) return []

    const predicate = scopeLadderPredicate({
      ...(config.product === undefined
        ? {}
        : { productRow: slugBranch(config.product), productScope: config.product }),
      requestedScope: scope,
      ...(config.scopeDefaults?.parentScopes === undefined
        ? {}
        : { parentScopes: config.scopeDefaults.parentScopes }),
    })

    const anchorsByTest = new Map<string, string[]>()
    const anchorRows = reader.db.prepare(`
      SELECT r.product, r.file_path, r.test_name, r.anchor_normalized_json
      FROM run_test_anchors r
      WHERE ${predicate.sql}
      ORDER BY r.product, r.file_path, r.test_name, r.anchor_normalized_json
    `).all(...predicate.binds)
    for (const row of anchorRows) {
      const key = identityTupleKey([
        String(row.product), String(row.file_path), String(row.test_name),
      ])
      const keys = anchorsByTest.get(key)
      if (keys === undefined) anchorsByTest.set(key, [String(row.anchor_normalized_json)])
      else keys.push(String(row.anchor_normalized_json))
    }

    const quarantinedKeys = quarantinedIdentityKeys(config.knowledgeRoot, now)

    return (reader.db.prepare(`
      SELECT r.product, r.file_path, r.test_name, r.passes, r.failures, r.heals,
        r.flake_count,
        last_outcomes_json
      FROM run_test_outcomes r
      WHERE ${predicate.sql}
      ORDER BY r.product, r.file_path, r.test_name
    `).all(...predicate.binds) as unknown as OutcomeRow[]).map((row) => ({
      filePath: String(row.file_path),
      testName: String(row.test_name),
      passes: Number(row.passes),
      failures: Number(row.failures),
      heals: Number(row.heals),
      flakeCount: Number(row.flake_count),
      quarantined: quarantinedKeys.has(identityTupleKey([
        String(row.product), String(row.file_path), String(row.test_name),
      ])),
      lastOutcomes: parseLastOutcomes(String(row.last_outcomes_json)),
      anchorKeys: anchorsByTest.get(identityTupleKey([
        String(row.product), String(row.file_path), String(row.test_name),
      ])) ?? [],
    }))
  } finally {
    reader.db.close()
  }
}

/**
 * PROVISIONAL screenless target-anchor derivation (D-13: intent on the dense leg, page:/flow:
 * anchors on the lexical leg). Every derived anchor goes through the one normalizeAnchor
 * authority: '/'-prefixed and 'page:'-prefixed intent tokens become page anchors;
 * 'flow:'-prefixed tokens and the whole intent become flow-name candidates. The scope key
 * contributes through the SQL scope ladder, not through anchors.
 */
function deriveTargetAnchors(intent: string): Anchor[] {
  const anchors: Anchor[] = []
  for (const token of intent.split(/\s+/)) {
    if (token.startsWith('/')) anchors.push({ t: 'page', route: token })
    else if (token.startsWith('page:')) anchors.push({ t: 'page', route: token.slice(5) })
    else if (token.startsWith('flow:')) anchors.push({ t: 'flow', name: token.slice(5) })
  }
  if (intent.trim() !== '') anchors.push({ t: 'flow', name: intent })

  const seen = new Set<string>()
  return anchors.map(normalizeAnchor).filter((anchor) => {
    const key = JSON.stringify(anchor)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function authoringRetrievalScope(
  config: OpenServingKnowledgeReaderConfig,
  scope: ScopeKey,
): RetrievalLegScope {
  const containingScopes = [scope, ...(config.scopeDefaults?.parentScopes ?? [])]
  const productKey = config.product
    ?? containingScopes.find((candidate) => candidate.tier === 'product')?.key
    ?? scope.key
  return {
    product: slugBranch(productKey),
    testKey: containingScopes.find((candidate) => candidate.tier === 'test')?.key
      ?? `__missing_test_scope__:${productKey}`,
    suiteKey: containingScopes.find((candidate) => candidate.tier === 'suite')?.key
      ?? `__missing_suite_scope__:${productKey}`,
    productKey,
    globalKey: 'global',
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function knownTestUniverse(
  projectionRows: readonly AuthoringExemplarRow[],
  discovered: readonly AuthoringTestRef[],
): AuthoringTestRef[] {
  const byIdentity = new Map<string, AuthoringTestRef>()
  for (const { filePath, testName } of discovered) {
    byIdentity.set(identityTupleKey([filePath, testName]), { filePath, testName })
  }
  // Projection-known identities are the floor, never the ceiling. Re-setting them last makes
  // the trusted projection identity win without allowing consumer-owned content across D-16.
  for (const { filePath, testName } of projectionRows) {
    byIdentity.set(identityTupleKey([filePath, testName]), { filePath, testName })
  }
  return [...byIdentity.values()].sort((left, right) => (
    (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0)
      || (left.testName < right.testName ? -1 : left.testName > right.testName ? 1 : 0)
  ))
}

/**
 * Read optional dense scores without widening the authoring-reader contract. Embedder
 * acquisition and query failures deliberately degrade to the deterministic lexical/anchor
 * floor required by ABRF-01; they never abort the authoring channel.
 */
async function readDenseScores(
  config: OpenServingKnowledgeReaderConfig,
  deps: AuthoringReaderDependencies,
  intent: string,
  scope: ScopeKey,
): Promise<ReadonlyMap<string, number> | undefined> {
  if (!existsSync(indexDbPath(config.knowledgeRoot))) return undefined

  const connection = openIndexReaderConnection(config.knowledgeRoot)
  try {
    const legScope = authoringRetrievalScope(config, scope)
    if (!hasDenseCandidates(connection.db, legScope)) return undefined

    const candidates = await denseLeg(
      connection,
      [intent],
      legScope,
      AUTHORING_DENSE_K,
      deps.embedder === undefined ? {} : { embedder: deps.embedder },
    )
    if (candidates.length === 0) return undefined
    return new Map(candidates.map((candidate) => [
      String(candidate.bundleId),
      clamp01(candidate.rawScores.cosine ?? 0),
    ]))
  } catch {
    // The dense leg is optional by contract: acquisition or query failure deliberately
    // degrades silently to the deterministic lexical/anchor floor instead of aborting ABRF-01.
    return undefined
  } finally {
    connection.db.close()
  }
}

/** Open the screenless authoring channel over the same store config as the serving reader. */
export function createAuthoringReader(
  config: OpenServingKnowledgeReaderConfig,
  deps: AuthoringReaderDependencies = {},
): AuthoringReadPort {
  return {
    async getAuthoringBrief(intent: string, scope: ScopeKey): Promise<AuthoringBrief> {
      const entries = hydrateRows(config, readIndexRows(config, scope), false)
      // ONE clock read per brief, here at the composition boundary — the quarantine fold below is
      // pure in `now` (D-11), and a second read could put two rows on two sides of one deadline.
      const projectionRows = readProjectionRows(
        config,
        scope,
        (deps.now ?? (() => new Date().toISOString()))(),
      )
      const denseScoreByRecordId = await readDenseScores(config, deps, intent, scope)
      const knownTests = knownTestUniverse(
        projectionRows,
        deps.discoverKnownTests?.() ?? [],
      )
      // D-16: the assembly seam ALWAYS produces the trace, so capture is already running for the
      // 4th channel. The AuthoringReadPort contract still carries only the brief because there is
      // no authoring evidence artifact to persist it onto yet; 393/394 mint the draft receipt and
      // then only have to stop discarding this value. Deliberately not a fabricated persistence
      // path today: a trace written nowhere would be a trace nobody could answer from.
      const { brief } = assembleAuthoringBrief({
        entries,
        projectionRows,
        // D-16: the consumer owns the filesystem and supplies identity refs only. Projection
        // identities remain a deterministic floor, while never-run tests widen the universe.
        knownTests,
        intent,
        scope,
        targetAnchors: deriveTargetAnchors(intent),
        budget: AUTHORING_BRIEF_DEFAULT_BUDGET,
        ...(denseScoreByRecordId === undefined ? {} : { denseScoreByRecordId }),
      })
      return brief
    },
  }
}
