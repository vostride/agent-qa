/**
 * Public memory.md §5.5 retrieval composition.
 *
 * Usage telemetry (§5.5.9) is deferred by architecture: reader connections are query_only, so
 * counters land with Phases 378/380's writer-owned paths and are never an input to trust.
 */
import type { DatabaseSync } from 'node:sqlite'

import {
  asRecordId,
  canonicalJson,
  supersessionKey,
  type Anchor,
  type IndexEntry,
  type ScopeKey,
  type VettedCandidateInput,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle, verifyBundleIntegrity } from './bundle-read.js'
import { enumerateBundleDirs, type KnowledgeHit } from './bundle-scan.js'
import type { AcquireEmbedderOutcome } from './embedder-acquire.js'
import type { KnowledgeReader } from './index-reader.js'
import {
  withKnowledgeReadSnapshot,
  type AuthoritativeKnowledgeHit,
  type KnowledgeRetrievalContext,
} from './index-reader.js'
import { resolveActiveProfile, type IndexReaderConnection } from './index-open.js'
import { buildRetrievalQuery, type RetrievalQueryInput } from './query-helper.js'
import { expandOneHop, type ExpansionSeed } from './retrieval/expansion.js'
import {
  admitCandidate,
  capExpansion,
  fuseWeightedRrf,
  type FusedCandidate,
  type WeightedRrfLeg,
} from './retrieval/fusion.js'
import {
  anchorSeedLeg,
  denseLeg,
  lexicalLeg,
  type LegCandidate,
  type RetrievalLegScope,
} from './retrieval/legs.js'
import { preFilterPredicate } from './retrieval/pre-filter.js'
import {
  applyDiversityCaps,
  applyLifecycleTrustTreatments,
  collapseByOrdinal,
  rerankPrecedence,
  type MintUnknownConflict,
  type ValidityClass,
} from './retrieval/rerank.js'
import {
  applyValidity,
  resolveAsOfBuild,
  type AsOfRange,
  type ValidityAnnotation,
} from './retrieval/validity.js'
import { TAU_LEX } from './retrieval/constants.js'

export interface RetrieveOptions {
  n: number
  product: string
  testKey?: string
  suiteKey?: string
  asOfBuild?: number
  resolveLatestOrdinal?: (product: string) => number | undefined
  runtimeRoot?: string
  includeSuperseded?: boolean
  asOfRange?: AsOfRange
  /** Host-resolved posture; a deferred daemon capability forbids in-process fallback. */
  embeddingCapability?: AcquireEmbedderOutcome
}

export type RetrieveResult = IndexEntry[]

type RankedLeg = WeightedRrfLeg<LegCandidate>

interface PipelineCandidate extends KnowledgeHit {
  readonly recordRowid: number
  readonly source: 'direct' | 'expanded'
  readonly legRanks: Readonly<Record<string, number>>
  readonly rawScores: LegCandidate['rawScores']
  readonly fusedScore: number
  readonly anchors: Anchor[]
  readonly scope: ScopeKey
  readonly openedAtOrdinal: number
  readonly closedAtOrdinal: number | null
  readonly createdAtOrdinal: number
  readonly originClass: 'agent' | 'user'
  readonly recencyOrdinal: number
  readonly validityClass: ValidityClass
  readonly lastConfirmedOrdinal: number
  readonly vettedCandidateInput?: VettedCandidateInput
  readonly unconfirmedSinceOrdinal?: number
  readonly unverified?: boolean
  readonly memoryOffTriggerKey?: string
  readonly servedAs?: 'current' | 'prior-build-hypothesis'
  readonly audit?: { status: string; openedAtOrdinal: number; closedAtOrdinal: number | null }
  readonly conflict?: { peerRecordId: string; unknownRecordId: string }
}

interface ScanCandidateSource extends AuthoritativeKnowledgeHit {
  recordRowid: number
}

const GLOBAL_SCOPE_KEY = 'global'
const MAX_SQL_LIMIT = 2_147_483_647

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function candidateLimit(n: number): number {
  return Math.max(32, Math.min(MAX_SQL_LIMIT, n > MAX_SQL_LIMIT / 4 ? MAX_SQL_LIMIT : n * 4))
}

function auditMode(options: RetrieveOptions): boolean {
  return options.includeSuperseded === true || options.asOfRange !== undefined
}

function memoryOffGroupKey(scope: ScopeKey, triggerKey: string): string {
  return canonicalJson([scope.tier, scope.key, triggerKey])
}

function factMemoryOffGroup(candidate: PipelineCandidate): string | undefined {
  return candidate.kind === 'fact'
    ? memoryOffGroupKey(candidate.scope, supersessionKey(candidate.anchors))
    : undefined
}

function thrashTriggerKey(anchor: Anchor | undefined): string | undefined {
  if (anchor?.t !== 'flow') return undefined
  const match = /^thrash:([0-9a-f]{64}):window:[0-9]+$/.exec(anchor.name)
  return match?.[1]
}

/**
 * D-07 targeted canonical lookup: a derived index may disappear, so the committed
 * unresolved unknown remains the serving switch. Only digest-verified unknowns
 * matching a retrieved fact group can suppress or enter this query.
 */
function attachMemoryOffUnknowns(
  knowledgeRoot: string,
  candidates: readonly PipelineCandidate[],
  options: RetrieveOptions,
): PipelineCandidate[] {
  if (auditMode(options)) return [...candidates]

  const relevantGroups = new Set(
    candidates.flatMap((candidate) => {
      const key = factMemoryOffGroup(candidate)
      return key === undefined ? [] : [key]
    }),
  )
  if (relevantGroups.size === 0) return [...candidates]

  const augmented = [...candidates]
  const candidateIndexById = new Map(
    augmented.map((candidate, index) => [candidate.bundleId, index] as const),
  )
  let syntheticRowid = -1

  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    if (!verifyBundleIntegrity(entry.dir).ok) continue
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded' || loaded.bundle.frontmatter.kind !== 'unknown') continue

    const trust = deriveBundleTrust(loaded.bundle)
    if (
      (trust.status !== 'active' && trust.status !== 'candidate')
      || trust.validity.closedAtOrdinal !== undefined
    ) {
      continue
    }

    const anchors = loaded.bundle.frontmatter.anchors.map(({ normalized }) => normalized)
    const triggerKey = thrashTriggerKey(anchors[0])
    if (triggerKey === undefined) continue
    const markerKey = memoryOffGroupKey(loaded.bundle.frontmatter.scope, triggerKey)
    if (!relevantGroups.has(markerKey)) continue

    const existingIndex = candidateIndexById.get(loaded.bundle.manifest.id)
    if (existingIndex !== undefined) {
      augmented[existingIndex] = {
        ...augmented[existingIndex]!,
        memoryOffTriggerKey: markerKey,
      }
      continue
    }

    augmented.push({
      bundleId: loaded.bundle.manifest.id,
      product: entry.product,
      kind: 'unknown',
      subtype: null,
      status: trust.status,
      trust: trust.trust,
      validity: trust.validity,
      summary: loaded.bundle.summary,
      embeddingInput: loaded.bundle.manifest.embeddingInput,
      recordRowid: syntheticRowid,
      source: 'expanded',
      legRanks: { memoryOffUnknown: Math.abs(syntheticRowid) },
      rawScores: {},
      fusedScore: 0,
      anchors,
      scope: loaded.bundle.frontmatter.scope,
      openedAtOrdinal: trust.validity.openedAtOrdinal,
      closedAtOrdinal: trust.validity.closedAtOrdinal ?? null,
      createdAtOrdinal: loaded.bundle.frontmatter.createdAtOrdinal,
      originClass: loaded.bundle.frontmatter.originClass === 'user' ? 'user' : 'agent',
      recencyOrdinal: loaded.bundle.frontmatter.createdAtOrdinal,
      validityClass: 'current',
      lastConfirmedOrdinal: trust.lastConfirmedOrdinal,
      memoryOffTriggerKey: markerKey,
    })
    candidateIndexById.set(loaded.bundle.manifest.id, augmented.length - 1)
    syntheticRowid -= 1
  }

  return augmented
}

function suppressMemoryOffFacts(
  candidates: readonly PipelineCandidate[],
  audit: boolean,
): PipelineCandidate[] {
  if (audit) return [...candidates]
  const suppressedGroups = new Set(
    candidates.flatMap((candidate) =>
      candidate.memoryOffTriggerKey === undefined
        ? []
        : [candidate.memoryOffTriggerKey]),
  )
  if (suppressedGroups.size === 0) return [...candidates]

  return candidates.filter((candidate) => {
    const key = factMemoryOffGroup(candidate)
    return key === undefined || !suppressedGroups.has(key)
  })
}

function retrievalScope(options: RetrieveOptions): RetrievalLegScope {
  return {
    product: options.product,
    testKey: options.testKey ?? `__missing_test_scope__:${options.product}`,
    suiteKey: options.suiteKey ?? `__missing_suite_scope__:${options.product}`,
    productKey: options.product,
    globalKey: GLOBAL_SCOPE_KEY,
    ...(options.includeSuperseded === undefined
      ? {}
      : { includeSuperseded: options.includeSuperseded }),
  }
}

function inScope(
  hit: Pick<AuthoritativeKnowledgeHit, 'product' | 'scope'>,
  scope: RetrievalLegScope,
): boolean {
  const allowedKeys = new Set([
    scope.testKey,
    scope.suiteKey,
    scope.productKey,
    scope.globalKey,
  ])
  if (!allowedKeys.has(hit.scope.key)) return false
  return hit.scope.tier === 'global' || hit.product === scope.product
}

export function hasDenseCandidates(db: DatabaseSync, scope: RetrievalLegScope): boolean {
  const predicate = preFilterPredicate(scope)
  return db.prepare(`
    SELECT 1 AS present
    FROM records r
    WHERE r.embed_status = 'present'
      AND r.embedding IS NOT NULL
      AND ${predicate.sql}
    LIMIT 1
  `).get(...predicate.binds) !== undefined
}

function admitLeg(
  candidates: readonly LegCandidate[],
  tauDense: number,
): LegCandidate[] {
  return candidates.filter((candidate) => admitCandidate(candidate, { tauDense }))
}

function readAnchors(db: DatabaseSync, recordRowid: number): Anchor[] {
  return db.prepare(`
    SELECT normalized_json
    FROM anchors
    WHERE record_rowid = ?
    ORDER BY rowid
  `).all(recordRowid).flatMap((row) => {
    try {
      return [JSON.parse(String(row.normalized_json)) as Anchor]
    } catch {
      return []
    }
  })
}

function asKnowledgeHit(candidate: LegCandidate): KnowledgeHit {
  return {
    bundleId: candidate.bundleId,
    product: candidate.product,
    kind: candidate.kind as KnowledgeHit['kind'],
    subtype: candidate.subtype,
    status: candidate.status as KnowledgeHit['status'],
    trust: candidate.trust,
    validity: {
      openedAtOrdinal: candidate.openedAtOrdinal,
      ...(candidate.closedAtOrdinal === undefined
        ? {}
        : { closedAtOrdinal: candidate.closedAtOrdinal }),
    },
    summary: candidate.summary,
    embeddingInput: candidate.embeddingInput,
  }
}

function hydrateFusedCandidate(
  db: DatabaseSync,
  candidate: FusedCandidate<LegCandidate>,
): PipelineCandidate {
  const hit = asKnowledgeHit(candidate)
  const confirmation = db.prepare(`
    SELECT last_confirmed_ordinal
    FROM records
    WHERE record_rowid = ?
  `).get(candidate.recordRowid)
  const lastConfirmed = confirmation?.last_confirmed_ordinal
  return {
    ...hit,
    recordRowid: candidate.recordRowid,
    source: candidate.source,
    legRanks: candidate.legRanks,
    rawScores: candidate.rawScores,
    fusedScore: candidate.fusedScore,
    anchors: readAnchors(db, candidate.recordRowid),
    scope: {
      tier: candidate.scopeTier as ScopeKey['tier'],
      key: candidate.scopeKey,
    },
    openedAtOrdinal: candidate.openedAtOrdinal,
    closedAtOrdinal: candidate.closedAtOrdinal ?? null,
    createdAtOrdinal: candidate.createdAtOrdinal,
    originClass: candidate.originClass === 'user' ? 'user' : 'agent',
    recencyOrdinal: candidate.createdAtOrdinal,
    validityClass: 'current',
    lastConfirmedOrdinal: Number(
      lastConfirmed === null || lastConfirmed === undefined
        ? candidate.openedAtOrdinal
        : lastConfirmed,
    ),
  }
}

function refreshPipelineCandidates(
  context: KnowledgeRetrievalContext,
  candidates: readonly PipelineCandidate[],
): PipelineCandidate[] {
  return context.recheck(candidates, true).map((candidate) => ({
    ...candidate,
    openedAtOrdinal: candidate.validity.openedAtOrdinal,
    closedAtOrdinal: candidate.validity.closedAtOrdinal ?? null,
    originClass: candidate.originClass === 'user' ? 'user' : 'agent',
    recencyOrdinal: candidate.createdAtOrdinal,
    validityClass: 'current',
    lastConfirmedOrdinal: candidate.lastConfirmedOrdinal,
    vettedCandidateInput: candidate.vettedCandidateInput,
  }))
}

function rowToExpandedLeg(
  db: DatabaseSync,
  recordRowid: number,
  rank: number,
): LegCandidate | undefined {
  const row = db.prepare(`
    SELECT
      record_rowid,
      bundle_id,
      product,
      kind,
      subtype,
      scope_tier,
      scope_key,
      status,
      trust,
      opened_at_ordinal,
      closed_at_ordinal,
      created_at_ordinal,
      origin_class,
      summary,
      embedding_input
    FROM records
    WHERE record_rowid = ?
  `).get(recordRowid)
  if (row === undefined) return undefined

  const closedAt = row.closed_at_ordinal
  return {
    recordRowid: Number(row.record_rowid),
    bundleId: String(row.bundle_id),
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
    source: 'expanded',
    legRanks: { expansion: rank },
    rawScores: {},
  }
}

function expansionSeeds(
  db: DatabaseSync,
  candidates: readonly FusedCandidate<LegCandidate>[],
): ExpansionSeed[] {
  return candidates.map((candidate) => {
    const rows = db.prepare(`
      SELECT src_node_id, dst_node_id
      FROM graph_edges
      WHERE record_rowid = ?
      ORDER BY src_node_id, edge_type, dst_node_id
    `).all(candidate.recordRowid)
    const nodeIds = new Set<string>()
    for (const row of rows) {
      nodeIds.add(String(row.src_node_id))
      nodeIds.add(String(row.dst_node_id))
    }
    return {
      bundleId: candidate.bundleId,
      nodeIds: [...nodeIds].sort(compareText),
    }
  })
}

function mintUnknownConflicts(db: DatabaseSync): MintUnknownConflict[] {
  const rows = db.prepare(`
    SELECT r.bundle_id AS member_id, target.natural_key_json AS unknown_json
    FROM graph_edges edge
    JOIN records r ON r.record_rowid = edge.record_rowid
    JOIN graph_nodes target ON target.node_id = edge.dst_node_id
    WHERE edge.edge_type = 'conflicts-with'
      AND target.node_type = 'unknown'
    ORDER BY target.natural_key_json, r.bundle_id
  `).all()
  const membersByUnknown = new Map<string, Set<string>>()
  for (const row of rows) {
    let unknownRecordId: unknown
    try {
      unknownRecordId = JSON.parse(String(row.unknown_json))
    } catch {
      continue
    }
    if (typeof unknownRecordId !== 'string') continue
    const members = membersByUnknown.get(unknownRecordId) ?? new Set<string>()
    members.add(String(row.member_id))
    membersByUnknown.set(unknownRecordId, members)
  }

  const conflicts: MintUnknownConflict[] = []
  for (const [unknownRecordId, memberSet] of [...membersByUnknown].sort(([left], [right]) =>
    compareText(left, right))) {
    const members = [...memberSet].sort(compareText)
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        conflicts.push({
          leftRecordId: members[left]!,
          rightRecordId: members[right]!,
          unknownRecordId,
        })
      }
    }
  }
  return conflicts
}

function validityClass(
  annotation: ValidityAnnotation,
  audit: boolean,
): ValidityClass {
  if (audit) return 'auditReadmitted'
  return annotation.servedAs === 'prior-build-hypothesis'
    ? 'priorBuildHypothesis'
    : 'current'
}

function applyAssembly(
  candidates: readonly PipelineCandidate[],
  conflicts: readonly MintUnknownConflict[],
  options: RetrieveOptions,
): PipelineCandidate[] {
  const audit = auditMode(options)
  const resolvedAsOf = resolveAsOfBuild({
    product: options.product,
    candidates,
    ...(options.asOfBuild === undefined ? {} : { asOfBuild: options.asOfBuild }),
    ...(options.resolveLatestOrdinal === undefined
      ? {}
      : { resolveLatestOrdinal: options.resolveLatestOrdinal }),
    ...(options.runtimeRoot === undefined ? {} : { runtimeRoot: options.runtimeRoot }),
    ...(options.asOfRange === undefined ? {} : { asOfRange: options.asOfRange }),
  })
  const valid = applyValidity(candidates, resolvedAsOf, {
    ...(options.asOfRange === undefined ? {} : { asOfRange: options.asOfRange }),
  }).map((candidate) => ({
    ...candidate,
    validityClass: validityClass(candidate, audit),
    ...(candidate.audit !== undefined
      ? {}
      : audit
        ? {
            audit: {
              status: candidate.status,
              openedAtOrdinal: candidate.openedAtOrdinal,
              closedAtOrdinal: candidate.closedAtOrdinal,
            },
          }
        : {}),
  }))
  // D-05/D-20 are ordinary serving treatments. Audit reads preserve raw authority.
  const treated = audit || resolvedAsOf === undefined
    ? valid
    : applyLifecycleTrustTreatments(valid, resolvedAsOf)
  const reranked = rerankPrecedence(treated)
  const collapsed = collapseByOrdinal(reranked, { audit, conflicts })
  const memorySafe = suppressMemoryOffFacts(collapsed, audit)
  return applyDiversityCaps(memorySafe, audit)
}

function finalRecheck(
  context: KnowledgeRetrievalContext,
  candidates: readonly PipelineCandidate[],
  scope: RetrievalLegScope,
  options: RetrieveOptions,
): RetrieveResult {
  const audit = auditMode(options)
  const servedTrust = new Map(
    candidates.map((candidate) => [candidate.bundleId, candidate.trust] as const),
  )
  const refreshed = audit
    ? context.recheck(candidates, true)
    : candidates.flatMap((candidate) => {
        const priorHypothesis = candidate.servedAs === 'prior-build-hypothesis'
        return context.recheck([candidate], priorHypothesis).filter((hit) =>
          !priorHypothesis
          || (
            (hit.status === 'active' || hit.status === 'candidate')
            && hit.validity.closedAtOrdinal !== undefined
          ))
      })
  return refreshed
    .filter((candidate) => inScope(candidate, scope))
    .map((candidate): IndexEntry => {
      const closedAtOrdinal = candidate.validity.closedAtOrdinal ?? null
      return {
        id: asRecordId(candidate.bundleId),
        kind: candidate.kind,
        ...(candidate.subtype === null ? {} : { subtype: candidate.subtype }),
        title: candidate.summary,
        summary: candidate.summary,
        trust: audit
          ? candidate.trust
          : (servedTrust.get(candidate.bundleId) ?? candidate.trust),
        anchors: candidate.anchors,
        status: candidate.status,
        servedAsCanary: false,
        ...(candidate.servedAs === undefined ? {} : { servedAs: candidate.servedAs }),
        ...(candidate.unconfirmedSinceOrdinal === undefined
          ? {}
          : { unconfirmedSinceOrdinal: candidate.unconfirmedSinceOrdinal }),
        ...(candidate.unverified === true ? { unverified: true } : {}),
        ...(candidate.conflict === undefined
          ? {}
          : {
              conflict: {
                peerRecordId: asRecordId(candidate.conflict.peerRecordId),
                unknownRecordId: asRecordId(candidate.conflict.unknownRecordId),
              },
            }),
        ...(audit
          ? {
              audit: {
                status: candidate.status,
                openedAtOrdinal: candidate.validity.openedAtOrdinal,
                closedAtOrdinal,
              },
            }
          : {}),
        scope: candidate.scope,
        validity: candidate.servedAs ?? (audit ? 'audit' : 'current'),
      }
    })
}

async function buildIndexLegs(
  connection: IndexReaderConnection,
  input: RetrievalQueryInput,
  scope: RetrievalLegScope,
  n: number,
  options: Pick<RetrieveOptions, 'embeddingCapability'>,
): Promise<{ legs: RankedLeg[]; query: ReturnType<typeof buildRetrievalQuery> }> {
  const { db } = connection
  const query = buildRetrievalQuery(input)
  const k = candidateLimit(n)
  const lexical = lexicalLeg(db, query.lexicalQuery, scope, k)
  const anchors = anchorSeedLeg(db, query.normalizedAnchors, scope)
  const matchedKeys = new Set(anchors.flatMap((candidate) => candidate.matchedAnchorKeys ?? []))
  const fallback = query.fallbackRenderings.filter(
    (rendering) => !matchedKeys.has(rendering.lookupKey),
  )

  let dense: LegCandidate[] = []
  if (hasDenseCandidates(db, scope)) {
    dense = await denseLeg(
      connection,
      [query.semanticText, ...fallback.map((rendering) => rendering.text)],
      scope,
      k,
      options.embeddingCapability === undefined
        ? {}
        : { capability: options.embeddingCapability },
    )
    if (fallback.length > 0) {
      const confirmations = new Map(
        fallback.map((rendering) => [
          rendering.text,
          new Set(
            lexicalLeg(db, rendering.reconfirmToken, scope, k).map(({ bundleId }) => bundleId),
          ),
        ]),
      )
      dense = dense.map((candidate) => {
        const rendering = candidate.matchedDenseRendering
        return rendering !== undefined && confirmations.get(rendering)?.has(candidate.bundleId)
          ? {
              ...candidate,
              rawScores: { ...candidate.rawScores, anchorExact: true },
            }
          : candidate
      })
    }
  }

  const tauDense = resolveActiveProfile(db).tau_dense
  return {
    query,
    legs: [
      { weight: query.weights.wLex, ranked: admitLeg(lexical, tauDense) },
      { weight: query.weights.wDense, ranked: admitLeg(dense, tauDense) },
      { weight: query.weights.wAnchor, ranked: admitLeg(anchors, tauDense) },
    ],
  }
}

async function retrieveFromIndex(
  context: KnowledgeRetrievalContext,
  input: RetrievalQueryInput,
  scope: RetrievalLegScope,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const connection = context.connection
  if (connection === undefined) throw new Error('index retrieval requires an index connection')

  const { legs } = await buildIndexLegs(connection, input, scope, options.n, options)
  const direct = fuseWeightedRrf(legs)
  const expanded = expandOneHop(
    connection.db,
    expansionSeeds(connection.db, direct),
    scope,
    options.n,
  )
    .flatMap((candidate, index) => {
      const hydrated = rowToExpandedLeg(connection.db, candidate.recordRowid, index + 1)
      return hydrated === undefined ? [] : [hydrated]
    })
  const finalLegs: RankedLeg[] = [
    ...legs,
    { weight: 1, ranked: expanded },
  ]
  const capped = capExpansion(fuseWeightedRrf(finalLegs), options.n)
  const candidates = capped.map((candidate) => hydrateFusedCandidate(connection.db, candidate))
  const authoritative = refreshPipelineCandidates(context, candidates)
  const withMemoryOffUnknowns = attachMemoryOffUnknowns(
    context.knowledgeRoot,
    authoritative,
    options,
  )
  const assembled = applyAssembly(
    withMemoryOffUnknowns,
    mintUnknownConflicts(connection.db),
    options,
  )
  return finalRecheck(context, assembled, scope, options).slice(0, options.n)
}

function scanLegCandidate(
  source: ScanCandidateSource,
  leg: 'anchor' | 'lexical',
  rank: number,
  matchedAnchorKeys: readonly string[] = [],
): LegCandidate {
  return {
    recordRowid: source.recordRowid,
    bundleId: source.bundleId,
    product: source.product,
    kind: source.kind,
    subtype: source.subtype,
    scopeTier: source.scope.tier,
    scopeKey: source.scope.key,
    status: source.status,
    trust: source.trust,
    openedAtOrdinal: source.validity.openedAtOrdinal,
    ...(source.validity.closedAtOrdinal === undefined
      ? {}
      : { closedAtOrdinal: source.validity.closedAtOrdinal }),
    createdAtOrdinal: source.createdAtOrdinal,
    originClass: source.originClass,
    summary: source.summary,
    embeddingInput: source.embeddingInput,
    source: 'direct',
    legRanks: { [leg]: rank },
    rawScores: leg === 'anchor' ? { anchorExact: true } : { bm25Positive: TAU_LEX },
    ...(matchedAnchorKeys.length === 0 ? {} : { matchedAnchorKeys }),
  }
}

function scanSources(
  context: KnowledgeRetrievalContext,
  hits: readonly KnowledgeHit[],
  scope: RetrievalLegScope,
  includeSuperseded: boolean,
): ScanCandidateSource[] {
  const filtered = context.recheck(hits, true)
    .filter((hit) => inScope(hit, scope))
    .filter((hit) =>
      includeSuperseded || (hit.status !== 'deprecated' && hit.status !== 'superseded'))
  const byBundle = new Map(filtered.map((hit) => [hit.bundleId, hit]))
  return [...byBundle.values()]
    .sort((left, right) => compareText(left.bundleId, right.bundleId))
    .map((hit, index) => ({ ...hit, recordRowid: index + 1 }))
}

async function retrieveFromScan(
  context: KnowledgeRetrievalContext,
  input: RetrievalQueryInput,
  scope: RetrievalLegScope,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const query = buildRetrievalQuery(input)
  const k = candidateLimit(options.n)
  const scan = context.scan
  if (scan === undefined) throw new Error('scan retrieval requires the scan delegate')
  const includeSuperseded = options.includeSuperseded === true
  const lexicalSources = scanSources(
    context,
    query.lexicalQuery === '' ? [] : scan(query.lexicalQuery, undefined),
    scope,
    includeSuperseded,
  ).slice(0, k)
  const anchorMatches = query.normalizedAnchors.map((anchor, index) => ({
    key: query.anchorLookupKeys[index]!,
    hits: scan(undefined, anchor),
  }))
  const anchorSources = scanSources(
    context,
    anchorMatches.flatMap(({ hits }) => hits),
    scope,
    includeSuperseded,
  ).slice(0, k)
  const sourceByBundle = new Map(
    [...lexicalSources, ...anchorSources].map((source) => [source.bundleId, source]),
  )
  const anchorKeysByBundle = new Map<string, Set<string>>()
  for (const { key, hits } of anchorMatches) {
    for (const hit of hits) {
      const keys = anchorKeysByBundle.get(hit.bundleId) ?? new Set<string>()
      keys.add(key)
      anchorKeysByBundle.set(hit.bundleId, keys)
    }
  }
  const lexical = lexicalSources.map((source, index) =>
    scanLegCandidate(source, 'lexical', index + 1))
  const anchor = anchorSources.map((source, index) =>
    scanLegCandidate(
      source,
      'anchor',
      index + 1,
      [...(anchorKeysByBundle.get(source.bundleId) ?? [])].sort(compareText),
    ))
  const fused = capExpansion(
    fuseWeightedRrf([
      { weight: query.weights.wLex, ranked: lexical },
      { weight: query.weights.wAnchor, ranked: anchor },
    ]),
    options.n,
  )
  const candidates = fused.flatMap((candidate) => {
    const source = sourceByBundle.get(candidate.bundleId)
    if (source === undefined) return []
    const leg = scanLegCandidate(source, 'lexical', source.recordRowid)
    return [{
      ...asKnowledgeHit(leg),
      recordRowid: source.recordRowid,
      source: candidate.source,
      legRanks: candidate.legRanks,
      rawScores: candidate.rawScores,
      fusedScore: candidate.fusedScore,
      anchors: source.anchors,
      scope: source.scope,
      openedAtOrdinal: source.validity.openedAtOrdinal,
      closedAtOrdinal: source.validity.closedAtOrdinal ?? null,
      createdAtOrdinal: source.createdAtOrdinal,
      originClass: source.originClass === 'user' ? 'user' as const : 'agent' as const,
      recencyOrdinal: source.createdAtOrdinal,
      validityClass: 'current' as const,
      lastConfirmedOrdinal: source.lastConfirmedOrdinal,
      vettedCandidateInput: source.vettedCandidateInput,
    }]
  })
  const withMemoryOffUnknowns = attachMemoryOffUnknowns(
    context.knowledgeRoot,
    candidates,
    options,
  )
  const assembled = applyAssembly(withMemoryOffUnknowns, [], options)
  return finalRecheck(context, assembled, scope, options).slice(0, options.n)
}

function validateOptions(options: RetrieveOptions): void {
  if (!Number.isSafeInteger(options.n) || options.n < 0) {
    throw new RangeError('n must be a non-negative safe integer')
  }
  if (options.product === '') throw new TypeError('product must not be empty')
}

/** Retrieve a deterministic ranked headline list through the reader's current capability. */
export function retrieve(
  reader: KnowledgeReader,
  query: RetrievalQueryInput,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  validateOptions(options)
  if (options.n === 0) return Promise.resolve([])

  const scope = retrievalScope(options)
  return withKnowledgeReadSnapshot(reader, (context) =>
    context.source === 'index'
      ? retrieveFromIndex(context, query, scope, options)
      : retrieveFromScan(context, query, scope, options))
}
