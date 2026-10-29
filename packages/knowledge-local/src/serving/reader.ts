import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import type { KnowledgeHintReader } from '@vostride/agent-qa-runner'
import { wrapAppObservedData } from '@vostride/agent-qa-safety'
import {
  asRecordId,
  canonicalJson,
  EMPTY_PROCEDURE_BINDING_AVAILABILITY,
  isVettedCandidate,
  normalizeAnchor,
  slugBranch,
  type Anchor,
  type CanaryOutcome,
  type CautionBlock,
  type IndexEntry,
  type ReadOptions,
  type RecordBody,
  type RecordId,
  type ScopeKey,
  type ScreenState,
  type SearchOptions,
} from '@vostride/agent-qa-schema'

import {
  deriveBundleTrust,
  loadBundle,
  readMeasurements,
  verifyBundleIntegrity,
  type LoadedBundle,
} from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import { enqueueCanaryOutcome } from '../canary-emit.js'
import {
  indexDbPath,
  openIndexReaderConnection,
} from '../index-open.js'
import {
  openKnowledgeReader as openIndexKnowledgeReader,
  type KnowledgeReader,
  type OpenKnowledgeReaderOptions,
} from '../index-reader.js'
import { assemblePromotionGateInput } from '../promotion-gate-input.js'
import { scopeLadderPredicate } from '../retrieval/pre-filter.js'
import { effectivePriorDigest, indexTrustEpochMatches } from '../trust-prior-context.js'
import { selectCautions } from './get-cautions.js'
import { admitsProcedure, matchProcedure } from './get-procedure.js'
import { assembleRunBrief } from './get-run-brief.js'
import { readPolicyLadder } from './policy-ladder.js'

const DEFAULT_RECORD_CAP = 20
const CHARS_PER_TOKEN_ESTIMATE = 4

export interface OpenServingKnowledgeReaderConfig {
  knowledgeRoot: string
  product?: string
  scopeDefaults?: {
    asOfBuild?: number
    /** Known containing scopes for member requests (for example, the owning suite). */
    parentScopes?: readonly ScopeKey[]
  }
  budgets?: { recordCap?: number }
}

export interface IndexRow {
  bundle_id: string
  product: string
  scope_tier: string
  scope_key: string
}

export interface HydratedEntry {
  dir: string
  bundle: LoadedBundle
  entry: IndexEntry
}

type OriginStampedEntry = IndexEntry & {
  originClass: LoadedBundle['frontmatter']['originClass']
}

/** @deprecated The safe serving reader reports misses as `undefined` and never throws this. */
export class KnowledgeRecordNotFoundError extends Error {
  readonly recordId: RecordId

  constructor(recordId: RecordId) {
    super(`knowledge record not found: ${recordId}`)
    this.name = 'KnowledgeRecordNotFoundError'
    this.recordId = recordId
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedRecordCap(config: OpenServingKnowledgeReaderConfig): number {
  const configured = config.budgets?.recordCap ?? DEFAULT_RECORD_CAP
  return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 0
}

function productSlug(config: OpenServingKnowledgeReaderConfig): string | undefined {
  return config.product === undefined ? undefined : slugBranch(config.product)
}

/** Shared serving internal: scope-laddered index rows (also feeds the authoring reader). */
export function readIndexRows(
  config: OpenServingKnowledgeReaderConfig,
  scope?: ScopeKey,
): IndexRow[] {
  if (!existsSync(indexDbPath(config.knowledgeRoot))) return []

  const reader = openIndexReaderConnection(config.knowledgeRoot)
  try {
    reader.db.exec('BEGIN')
    const boundProduct = productSlug(config)
    const predicate = scopeLadderPredicate({
      ...(boundProduct === undefined ? {} : { productRow: boundProduct }),
      ...(config.product === undefined ? {} : { productScope: config.product }),
      ...(scope === undefined ? {} : { requestedScope: scope }),
      ...(config.scopeDefaults?.parentScopes === undefined
        ? {}
        : { parentScopes: config.scopeDefaults.parentScopes }),
    })
    // Pin eligibility before selection: rehydrating mismatched selected rows cannot recover
    // canonical bundles that another epoch's index omitted. Keep the shared SQL scope wall.
    if (!indexTrustEpochMatches(reader.db, effectivePriorDigest())) {
      const admits = reader.db.prepare(`
        SELECT 1 FROM (SELECT ? AS product, ? AS scope_tier, ? AS scope_key) r
        WHERE ${predicate.sql}
      `)
      return enumerateBundleDirs(config.knowledgeRoot).flatMap(({ dir, product }) => {
        const loaded = loadBundle(dir)
        if (loaded.kind !== 'loaded' || !verifyBundleIntegrity(dir).ok) return []
        const { scope: bundleScope } = loaded.bundle.frontmatter
        if (admits.get(product, bundleScope.tier, bundleScope.key, ...predicate.binds) === undefined) {
          return []
        }
        return [{
          bundle_id: loaded.bundle.manifest.id,
          product,
          scope_tier: bundleScope.tier,
          scope_key: bundleScope.key,
        }]
      }).sort((left, right) => (
        compareText(left.product, right.product) || compareText(left.bundle_id, right.bundle_id)
      ))
    }
    return reader.db.prepare(`
      SELECT r.bundle_id, r.product, r.scope_tier, r.scope_key
      FROM records r
      WHERE ${predicate.sql}
      ORDER BY r.product, r.bundle_id
    `).all(...predicate.binds).map((row) => ({
      bundle_id: String(row.bundle_id),
      product: String(row.product),
      scope_tier: String(row.scope_tier),
      scope_key: String(row.scope_key),
    }))
  } finally {
    // Closing also releases the read transaction, including on hydration/selection failure.
    reader.db.close()
  }
}

function bundleDirs(config: OpenServingKnowledgeReaderConfig): Map<string, {
  dir: string
  product: string
}> {
  return new Map(
    enumerateBundleDirs(config.knowledgeRoot).map(({ dir, product }) => [
      basename(dir),
      { dir, product },
    ]),
  )
}

/** Shared serving internal: integrity-checked bundle hydration (also feeds the authoring reader). */
export function hydrateRows(
  config: OpenServingKnowledgeReaderConfig,
  rows: readonly IndexRow[],
  audit: boolean,
): HydratedEntry[] {
  const dirs = bundleDirs(config)
  return rows.flatMap((row): HydratedEntry[] => {
    const found = dirs.get(row.bundle_id)
    if (found === undefined || found.product !== row.product) return []
    const loaded = loadBundle(found.dir)
    if (loaded.kind !== 'loaded' || !verifyBundleIntegrity(found.dir).ok) return []

    const { bundle } = loaded
    const trust = deriveBundleTrust(bundle)
    const vetted = trust.status === 'candidate' && isVettedCandidate(
      assemblePromotionGateInput({
        knowledgeRoot: config.knowledgeRoot,
        bundleDir: found.dir,
        bundle,
      }),
    )
    const entry: OriginStampedEntry = {
      id: asRecordId(bundle.manifest.id),
      kind: bundle.frontmatter.kind,
      ...(bundle.frontmatter.subtype === undefined
        ? {}
        : { subtype: bundle.frontmatter.subtype }),
      title: bundle.summary,
      summary: bundle.summary,
      trust: trust.trust,
      anchors: bundle.frontmatter.anchors.map(({ normalized }) => normalized),
      status: trust.status,
      servedAsCanary: vetted,
      ...(vetted ? { unverified: true } : {}),
      ...(audit
        ? {
            audit: {
              status: trust.status,
              openedAtOrdinal: trust.validity.openedAtOrdinal,
              closedAtOrdinal: trust.validity.closedAtOrdinal ?? null,
            },
          }
        : {}),
      scope: bundle.frontmatter.scope,
      validity: trust.validity.closedAtOrdinal === undefined
        ? 'current'
        : `${trust.validity.openedAtOrdinal}:${trust.validity.closedAtOrdinal}`,
      originClass: bundle.frontmatter.originClass,
    }
    return [{ dir: found.dir, bundle, entry }]
  })
}

function currentServingEntries(entries: readonly HydratedEntry[]): IndexEntry[] {
  return entries.flatMap(({ entry }) => {
    if (entry.kind === 'policy') return []
    if (entry.status === 'active') return [entry]
    return entry.status === 'candidate' && entry.unverified === true ? [entry] : []
  })
}

function normalizedAnchorKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

/**
 * Derive the current page anchors from a live ScreenState for procedure matching. Both authored
 * page-anchor shapes are covered: the full-URL form (the failure-caution derivation idiom) and
 * the route-path form (committed procedure guard descriptors carry routes like '/login'). Every
 * derived anchor goes through the one normalizeAnchor authority.
 */
function screenStatePageAnchors(screenState: ScreenState): Anchor[] {
  if (screenState.url === undefined || screenState.url.trim() === '') return []
  const anchors: Anchor[] = [normalizeAnchor({ t: 'page', route: screenState.url })]
  try {
    const parsed = new URL(screenState.url)
    anchors.push(normalizeAnchor({ t: 'page', route: `${parsed.pathname}${parsed.search}` }))
  } catch {
    // Non-URL routes stay as the single raw-form anchor.
  }
  return anchors
}

function anchorMatches(entry: IndexEntry, anchors: readonly Anchor[]): boolean {
  if (anchors.length === 0) return false
  const requested = new Set(anchors.map(normalizedAnchorKey))
  return entry.anchors.some((anchor) => requested.has(normalizedAnchorKey(anchor)))
}

function lexicalMatches(bundle: LoadedBundle, query: string): boolean {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return false
  const text = [
    bundle.summary,
    bundle.body,
    bundle.manifest.embeddingInput,
    ...bundle.frontmatter.anchors.map(({ normalized }) => canonicalJson(normalized)),
  ].join('\n').toLowerCase()
  return tokens.every((token) => text.includes(token))
}

function overlapsRange(
  openedAtOrdinal: number,
  closedAtOrdinal: number | undefined,
  range: NonNullable<SearchOptions['asOfRange']>,
): boolean {
  const from = range.from ?? Number.NEGATIVE_INFINITY
  const to = range.to ?? Number.POSITIVE_INFINITY
  return openedAtOrdinal <= to && (closedAtOrdinal === undefined || closedAtOrdinal > from)
}

function validAtBuild(
  openedAtOrdinal: number,
  closedAtOrdinal: number | undefined,
  buildOrdinal: number,
): boolean {
  return openedAtOrdinal <= buildOrdinal
    && (closedAtOrdinal === undefined || buildOrdinal < closedAtOrdinal)
}

function searchEntries(
  config: OpenServingKnowledgeReaderConfig,
  query: string,
  options: SearchOptions,
): IndexEntry[] {
  const anchors = options.anchors ?? []
  if (query.trim() === '' && anchors.length === 0) return []

  const auditMode = options.includeSuperseded === true || options.asOfRange !== undefined
  const hydrated = hydrateRows(config, readIndexRows(config, options.scope), auditMode)
  return hydrated
    .filter(({ bundle, entry }) => (
      lexicalMatches(bundle, query) || anchorMatches(entry, anchors)
    ))
    .filter(({ bundle, entry }) => {
      if (entry.kind === 'policy') return false
      if (options.kind !== undefined && entry.kind !== options.kind) return false
      if (entry.status === 'candidate') {
        return options.includeCandidates === true && entry.unverified === true
      }
      if (
        !auditMode
        && (entry.status === 'deprecated' || entry.status === 'superseded')
      ) {
        return false
      }
      const trust = deriveBundleTrust(bundle)
      if (
        options.asOfBuild !== undefined
        && !validAtBuild(
          trust.validity.openedAtOrdinal,
          trust.validity.closedAtOrdinal,
          options.asOfBuild,
        )
      ) {
        return false
      }
      return options.asOfRange === undefined || overlapsRange(
        trust.validity.openedAtOrdinal,
        trust.validity.closedAtOrdinal,
        options.asOfRange,
      )
    })
    .map(({ bundle, entry }): IndexEntry => {
      const appObserved = bundle.frontmatter.originClass === 'agent-observed'
      return {
        ...entry,
        summary: appObserved ? wrapAppObservedData(entry.summary) : entry.summary,
        ...(options.asOfBuild !== undefined && entry.status !== 'active'
          ? { servedAs: 'prior-build-hypothesis' as const }
          : {}),
      }
    })
    .sort((left, right) => (
      Number(anchorMatches(right, anchors)) - Number(anchorMatches(left, anchors))
      || right.trust - left.trust
      || compareText(String(left.id), String(right.id))
    ))
}

function findReadableBundle(
  config: OpenServingKnowledgeReaderConfig,
  id: RecordId,
  options?: ReadOptions,
): { dir: string; bundle: LoadedBundle } | undefined {
  const row = readIndexRows(config, options?.scope)
    .find(({ bundle_id }) => bundle_id === id)
  if (row === undefined) return undefined

  const hydrated = hydrateRows(config, [row], false)[0]
  if (hydrated === undefined) return undefined
  /**
   * `currentServingEntries` is the BRIEF/CAUTION serving wall — it admits candidates
   * only through the vetted-canary flag, which is fact/caution-only, so a committed procedure
   * (agent-verified candidate, promotion-excluded in M2 by 379 D-16) was permanently unreadable
   * even when `getProcedure` had just recommended replaying it. The read face therefore falls
   * back to the matcher's OWN admission predicate: what getProcedure can recommend, read() can
   * serve. This is read admission only — `currentServingEntries` is untouched, so nothing new
   * reaches getRunBrief, getCautions, or search.
   */
  if (
    currentServingEntries([hydrated]).length === 0
    && !admitsProcedure({ entry: hydrated.entry, bundle: hydrated.bundle })
  ) {
    return undefined
  }

  const trust = deriveBundleTrust(hydrated.bundle)
  const asOfBuild = options?.asOfBuild ?? config.scopeDefaults?.asOfBuild
  if (
    asOfBuild !== undefined
    && !validAtBuild(
      trust.validity.openedAtOrdinal,
      trust.validity.closedAtOrdinal,
      asOfBuild,
    )
  ) {
    return undefined
  }
  return { dir: hydrated.dir, bundle: hydrated.bundle }
}

function estimatedBodyCost(body: string): number {
  return Math.ceil(body.length / CHARS_PER_TOKEN_ESTIMATE)
}

function renderedBody(body: string, appObserved: boolean): string {
  return appObserved ? wrapAppObservedData(body) : body
}

function truncateBody(
  body: string,
  appObserved: boolean,
  budget: number | undefined,
): string {
  if (budget === undefined) return renderedBody(body, appObserved)
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0
  const whole = renderedBody(body, appObserved)
  if (estimatedBodyCost(whole) <= limit) return whole

  const admitted: string[] = []
  for (const line of body.split('\n')) {
    const candidate = renderedBody([...admitted, line].join('\n'), appObserved)
    if (estimatedBodyCost(candidate) > limit) break
    admitted.push(line)
  }
  if (admitted.length === 0) return ''
  return renderedBody(admitted.join('\n'), appObserved)
}

function readRecord(
  config: OpenServingKnowledgeReaderConfig,
  id: RecordId,
  options?: ReadOptions,
): RecordBody | undefined {
  const found = findReadableBundle(config, id, options)
  if (found === undefined) return undefined

  const { bundle } = found
  const measurements = readMeasurements(found.dir)
  return {
    id: asRecordId(bundle.manifest.id),
    title: bundle.summary,
    body: truncateBody(
      bundle.body,
      bundle.frontmatter.originClass === 'agent-observed',
      options?.budget,
    ),
    anchors: bundle.frontmatter.anchors.map(({ normalized }) => normalized),
    evidenceDigest: bundle.manifest.contentHashes['evidence/evidence.md']
      ?? bundle.manifest.contentHashes['record.md']
      ?? bundle.manifest.identityHash,
    ...(measurements === undefined
      ? {}
      : { measurement: canonicalJson(measurements) }),
    relations: bundle.relations.relations.map((relation) => ({
      kind: relation.type,
      targetId: asRecordId(relation.targetId),
    })),
  }
}

function servingReader(
  config: OpenServingKnowledgeReaderConfig,
): KnowledgeHintReader {
  return {
    getRunBrief(scope, budget) {
      const entries = currentServingEntries(
        hydrateRows(config, readIndexRows(config, scope), true),
      )
      // the composite is returned verbatim. The reader does not unwrap and re-wrap it,
      // so there is no point in this path at which a brief exists without its trace.
      return assembleRunBrief({
        candidates: entries,
        policy: readPolicyLadder(config.knowledgeRoot, config.product),
        scope,
        budget,
        recordCap: normalizedRecordCap(config),
        ...(config.scopeDefaults?.asOfBuild === undefined
          ? {}
          : { asOfBuild: config.scopeDefaults.asOfBuild }),
      })
    },

    search(query, options) {
      return searchEntries(config, query, options)
    },

    read(id, options) {
      return readRecord(config, id, options)
    },

    getCautions(anchors, budget) {
      const selected = selectCautions({
        candidates: currentServingEntries(
          hydrateRows(config, readIndexRows(config), false),
        ),
        anchors,
        budget,
        recordCap: normalizedRecordCap(config),
      })
      if (selected.overflow === undefined) {
        return { block: selected.block, trace: selected.trace }
      }

      /**
       * Reserved terminal id: consumers must display this cap signal but skip it for ledger
       * admission because it is not a committed knowledge record. It gets no trace line for the
       * same reason: it names no record, so there is nothing to attribute. The cut cautions it
       * summarizes are already enumerated individually in the trace's truncation ledger.
       */
      const overflowLine: CautionBlock['cautions'][number] = {
        id: asRecordId('caution:truncated'),
        anchors: [],
        summary: `truncated ${selected.overflow.served} of ${selected.overflow.eligible}`,
      }
      return {
        block: {
          ...selected.block,
          cautions: [...selected.block.cautions, overflowLine],
        },
        trace: selected.trace,
      }
    },

    getProcedure(intent, screenState, availability) {
      return matchProcedure({
        entries: hydrateRows(config, readIndexRows(config), false),
        intent,
        anchors: screenStatePageAnchors(screenState),
        availability: availability ?? EMPTY_PROCEDURE_BINDING_AVAILABILITY,
      })
    },

    emitCanaryOutcome(payload: CanaryOutcome) {
      // one synchronous, atomic, content-addressed emit pattern.
      enqueueCanaryOutcome(config.knowledgeRoot, payload)
    },
  }
}

export function openKnowledgeReader(
  config: OpenServingKnowledgeReaderConfig,
): KnowledgeHintReader
export function openKnowledgeReader(
  knowledgeRoot: string,
  opts?: OpenKnowledgeReaderOptions,
): KnowledgeReader
export function openKnowledgeReader(
  configOrKnowledgeRoot: OpenServingKnowledgeReaderConfig | string,
  opts?: OpenKnowledgeReaderOptions,
): KnowledgeHintReader | KnowledgeReader {
  // Preserve the established low-level index-reader overload while the new object form is the
  // KnowledgeHintReader composition seam used by the runner.
  return typeof configOrKnowledgeRoot === 'string'
    ? openIndexKnowledgeReader(configOrKnowledgeRoot, opts)
    : servingReader(configOrKnowledgeRoot)
}
