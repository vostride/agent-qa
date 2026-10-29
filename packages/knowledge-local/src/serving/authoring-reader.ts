// Shares the serving reader's hydration and index connection, and leaves the hint reader untouched.
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

// A plain number passed down; assemblies never read config.
export const AUTHORING_BRIEF_DEFAULT_BUDGET = 2_000

/** PROVISIONAL dense candidate cap pending authoring-channel retrieval telemetry. */
export const AUTHORING_DENSE_K = 32

export interface AuthoringReaderDependencies {
  /** Consumer-owned test inventory crossing this boundary as identity refs only. */
  discoverKnownTests?: () => readonly AuthoringTestRef[]
  /** Test/integration seam; production omission uses denseLeg's automatic acquisition ladder. */
  embedder?: EmbedderPort
  // A seam so expiry is testable either side of a deadline; production reads the clock per brief.
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

// No try/catch: an unreadable ledger must not read as nothing quarantined, un-quarantining all.
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

// The tables are outside `REQUIRED_INDEX_TABLES`, so an absent shape reads as empty, never a throw.
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

// Intent tokens prefixed `/` or `page:` become page anchors; `flow:` tokens and the intent, flows.
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
  // Projection identities are set last, so the trusted identity wins over consumer-owned content.
  for (const { filePath, testName } of projectionRows) {
    byIdentity.set(identityTupleKey([filePath, testName]), { filePath, testName })
  }
  return [...byIdentity.values()].sort((left, right) => (
    (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0)
      || (left.testName < right.testName ? -1 : left.testName > right.testName ? 1 : 0)
  ))
}

// Embedder or query failures fall back to the lexical and anchor floor; they never abort it.
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
      // One clock read per brief: a second read could put two rows on two sides of one deadline.
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
      // Only the brief is returned: no authoring evidence artifact exists to persist the trace on.
      const { brief } = assembleAuthoringBrief({
        entries,
        projectionRows,
        // The consumer owns the filesystem and supplies refs; never-run tests widen the projection.
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
