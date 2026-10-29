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

// Degraded authorship needs more confirmations than full; floor tier is hint-only, with no bar.
export const PROCEDURE_REPLAY_CONFIRMATIONS: Record<'full' | 'degraded', number> = {
  full: 2,
  degraded: 4,
}

// Below it a match still serves as a hint; the fold can downrank but never promote past it.
export const PROCEDURE_REPLAY_CONFIDENCE_FLOOR = 0.5

// Floor tier is also walled out of replay, so this factor only shapes its hint order.
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

// An unfillable required parameter also walls replay; this factor ranks fillable hints first.
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
  // Source-tagged binding names only; no value ever reaches the matcher.
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

// The sole admission predicate for both faces, so the matcher never recommends what reads refuse.
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

// The creation event shares the job id, so counting it would cross every bar one canary early.
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

// Snapshot-pure and single-pass, ties broken by record id; a miss returns `undefined`, not a throw.
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
    // The loop binder enforces the same schema contract, so admission and binding cannot drift.
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
