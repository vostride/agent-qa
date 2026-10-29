import {
  canonicalJson,
  curatorTier,
  normalizeAnchor,
  parseProcedureBody,
  procedureParameterFillability,
  survivingOutcomeEvents,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleProvenance,
  type CuratorTier,
  type IndexEntry,
  type ProcedureBindingAvailability,
  type ProcedureMatch,
} from '@vostride/agent-qa-schema'

/**
 * D-05 replay-eligibility confirmation bars per curator tier (PROVISIONAL, retrieval/constants.ts
 * style — internal constitution values, never config keys; M3 owns calibration from attributed
 * outcomes). Degraded authorship needs a higher confirmation bar than full; floor tier has no bar
 * because it is hint-only forever and is deliberately absent from this record.
 */
export const PROCEDURE_REPLAY_CONFIRMATIONS: Record<'full' | 'degraded', number> = {
  full: 2,
  degraded: 4,
}

/**
 * D-05 minimum composed confidence for a replay recommendation (PROVISIONAL). Below it a match
 * still serves as a hint; the fold can only ever downrank, never promote past this floor.
 */
export const PROCEDURE_REPLAY_CONFIDENCE_FLOOR = 0.5

/**
 * D-06 tier factor of the confidence fold (PROVISIONAL). Floor tier is discounted hardest and is
 * additionally hard-walled out of replay below, so this factor only shapes hint ordering there.
 */
const PROCEDURE_TIER_FACTOR: Record<CuratorTier, number> = {
  full: 1,
  degraded: 0.8,
  floor: 0.5,
}

/**
 * Weight of the intent-text lexical signal inside relevance (PROVISIONAL). Anchor overlap is the
 * primary signal; lexical relevance is secondary and purely additive on the zero-embedder floor.
 */
const PROCEDURE_LEXICAL_WEIGHT = 0.5

/**
 * Weight of the optional dense-leg contribution (PROVISIONAL). The dense term joins only when an
 * embedder is up (caller-supplied per-record scores); absent scores contribute exactly zero so the
 * lexical floor stays deterministic.
 */
const PROCEDURE_DENSE_WEIGHT = 0.25

/**
 * D-08 fillability downrank factor (PROVISIONAL). An unfillable required parameter both halves
 * confidence and hard-walls the match out of replay — the factor exists so hint ordering still
 * prefers fillable procedures.
 */
const PROCEDURE_UNFILLABLE_FACTOR = 0.5

/**
 * The bundle facts the matcher folds. `LoadedBundle` satisfies this structurally, so the reader
 * passes hydrated entries straight through; tests construct the narrow shape directly.
 */
export interface ProcedureMatchCandidate {
  entry: IndexEntry
  bundle: {
    summary: string
    body: string
    events: readonly BundleOutcomeEvent[]
    provenance: BundleProvenance
  }
}

export interface MatchProcedureInput {
  /** Already-hydrated entries; the reader's SQL scope ladder has applied the scope walls. */
  entries: readonly ProcedureMatchCandidate[]
  intent: string
  /** ScreenState-derived anchors; normalized here via canonicalJson(normalizeAnchor(...)). */
  anchors: readonly Anchor[]
  /** Source-tagged binding NAMES only — no value ever reaches the matcher. */
  availability: ProcedureBindingAvailability
  /** Optional additive dense-leg scores keyed by record id, present only when an embedder is up. */
  denseScoreByRecordId?: ReadonlyMap<string, number>
}

function normalizedAnchorKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

function compareRecordId(left: IndexEntry, right: IndexEntry): number {
  const leftId = String(left.id)
  const rightId = String(right.id)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

/**
 * The ONE kind-aware procedure admission predicate, shared by BOTH serving faces:
 * the MATCH face (`matchProcedure` below) and the READ face (`findReadableBundle` in
 * serving/reader.ts). Procedures can never be `active` in M2 (379 D-16 excludes procedure-kind
 * from promotion) and the brief's vetted-candidate path is fact/caution-only, so candidate-status
 * procedures are admitted here through explicit status walls — candidate + validity-open +
 * not-withheld + no surviving user-deprecate.
 *
 * Sharing it is load-bearing, not tidiness: the two faces had diverged, so the matcher could
 * recommend a replay whose body the reader then refused to serve, silently starving every earned
 * replay into a hint. Keep this the sole admission authority for both faces so they cannot
 * diverge again. This is READ admission, never promotion — nothing here makes a procedure
 * `active`, brief-servable, or caution-servable. TRUST lives in the fold (hint/replay), never in
 * admission.
 */
export function admitsProcedure({ entry, bundle }: ProcedureMatchCandidate): boolean {
  if (entry.kind !== 'procedure') return false
  if (entry.status === 'active') return true
  if (entry.status !== 'candidate') return false
  if (entry.validity !== 'current') return false
  if (bundle.provenance.mode === 'run-linked' && bundle.provenance.withheld === true) return false
  return !survivingOutcomeEvents(bundle.events).some((event) => event.type === 'deprecated')
}

/** Matched share of the record's flow:/page: anchors under normalized-key equality. */
function anchorRelevance(entry: IndexEntry, requestedKeys: ReadonlySet<string>): number {
  const flowPageAnchors = entry.anchors.filter(
    (anchor) => anchor.t === 'flow' || anchor.t === 'page',
  )
  if (flowPageAnchors.length === 0) return 0
  const matched = flowPageAnchors.filter(
    (anchor) => requestedKeys.has(normalizedAnchorKey(anchor)),
  ).length
  return matched / flowPageAnchors.length
}

/** Matched share of intent tokens against summary + body on the lexical floor. */
function lexicalRelevance(bundle: ProcedureMatchCandidate['bundle'], intent: string): number {
  const tokens = intent.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) return 0
  const text = [bundle.summary, bundle.body].join('\n').toLowerCase()
  return tokens.filter((token) => text.includes(token)).length / tokens.length
}

/**
 * Surviving Confirm evidence minus the creation/authoring observation. A run-linked bundle's
 * creation event shares the bundle-creating candidate id with provenance.curationJobId; counting
 * it would cross every D-05 bar one organic canary early. Re-extraction and canary
 * confirmations arrive from distinct curation jobs and continue to count.
 */
function confirmationCount(
  events: readonly BundleOutcomeEvent[],
  provenance: BundleProvenance,
): number {
  const creationJobId = provenance.mode === 'run-linked'
    ? provenance.curationJobId
    : undefined
  return survivingOutcomeEvents(events)
    .flatMap((event) => (
      event.type === 'confirmed' && event.curationJobId !== creationJobId
        ? [event.evidenceToken]
        : []
    ))
    .filter((token) => token.length > 0)
    .length
}

interface ScoredMatch {
  entry: IndexEntry
  match: ProcedureMatch
}

/**
 * D-07 pure procedure matcher: pre-filter (kind-aware admission) -> anchor match (normalized-key
 * equality, lexical intent as a secondary additive signal) -> rerank fold (tier x confirmations x
 * fillability). Deterministic on the zero-embedder lexical floor: snapshot-pure inputs only, no
 * wall-clock, float-order-stable single-pass scoring, ties broken by record id. Misses return
 * undefined, never a throw.
 */
export function matchProcedure(input: MatchProcedureInput): ProcedureMatch | undefined {
  const requestedKeys = new Set(input.anchors.map(normalizedAnchorKey))

  const scored = input.entries.flatMap((candidate): ScoredMatch[] => {
    if (!admitsProcedure(candidate)) return []

    const anchorScore = anchorRelevance(candidate.entry, requestedKeys)
    if (anchorScore === 0) return []

    // Unparseable bodies are skipped fail-closed, matching parseProcedureBody's law.
    const payload = parseProcedureBody(candidate.bundle.body)
    if (payload === undefined) return []

    const flowAnchor = candidate.entry.anchors.find((anchor) => anchor.t === 'flow')
      ?? candidate.entry.anchors[0]
    if (flowAnchor === undefined) return []

    const denseScore = input.denseScoreByRecordId?.get(String(candidate.entry.id)) ?? 0
    const relevance = Math.min(
      1,
      anchorScore
        + PROCEDURE_LEXICAL_WEIGHT * lexicalRelevance(candidate.bundle, input.intent)
        + PROCEDURE_DENSE_WEIGHT * denseScore,
    )

    const tier = curatorTier(
      candidate.bundle.provenance.mode === 'run-linked'
        ? candidate.bundle.provenance.authorship
        : undefined,
    )
    const confirmations = confirmationCount(
      candidate.bundle.events,
      candidate.bundle.provenance,
    )
    // The shared schema contract is also enforced by the loop binder. Matcher admission and
    // loop-side source/type binding therefore cannot drift.
    const { fillable } = procedureParameterFillability(payload, input.availability)

    // Laplace-shaped confirmation factor: 0 confirmations => 0.5, saturating toward 1. Hint
    // matches keep a meaningful confidence while unconfirmed procedures stay below replay bars.
    const confidence = relevance
      * PROCEDURE_TIER_FACTOR[tier]
      * ((confirmations + 1) / (confirmations + 2))
      * (fillable ? 1 : PROCEDURE_UNFILLABLE_FACTOR)

    const replay = tier !== 'floor'
      && confirmations >= PROCEDURE_REPLAY_CONFIRMATIONS[tier]
      && fillable
      && confidence >= PROCEDURE_REPLAY_CONFIDENCE_FLOOR

    return [{
      entry: candidate.entry,
      match: {
        id: candidate.entry.id,
        flowAnchor: normalizeAnchor(flowAnchor),
        confidence,
        authoringModelTier: tier,
        parameterSchema: payload.parameters.map(({ name, type, required }) => ({
          name,
          type,
          required,
        })),
        replayRecommendation: replay ? 'replay' : 'hint',
      },
    }]
  })

  scored.sort((left, right) => (
    right.match.confidence - left.match.confidence
    || compareRecordId(left.entry, right.entry)
  ))
  return scored[0]?.match
}
