import {
  canonicalJson,
  decideMeasurementDrift,
  isReplayableActionShape,
  parseProcedureBody,
  foldMeasurements,
  normalizeAnchor,
  supersessionKey as schemaSupersessionKey,
  type Anchor,
  type BundleDraft,
  type BundleStatus,
  type Delta,
  type DeltaOrigin,
  type DistilledObservation,
  type MeasurementObservation,
  type ProcedureBodyPayload,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'

import {
  deriveBundleTrust,
  loadBundle,
  readMeasurements,
  type LoadedBundle,
} from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import type { AuthoredDeltaCheckpoint, DispositionProfile } from './author-contract.js'
import {
  SCOPE_BURST_THRESHOLD,
  SCOPE_BURST_WINDOW_BUILDS,
  STABLE_WINDOW_BUILDS,
  THRASH_MAX_SUPERSESSIONS,
  THRASH_WINDOW_BUILDS,
  anchorScopeKey,
  foldFirstSeenAnchorsByScope,
  foldSupersessionLineage,
  scanCanonicalBundles,
  type CanonicalBundleSnapshot,
} from './lineage-fold.js'

/** Provisional §7.3.1 cap. Phase 379 may retune it only through an explicit constant edit. */
export const BLAST_RADIUS_MAX_SUPERSEDES_PER_ANCHOR_PER_DRAIN = 1

// 407-04 (D-08/D-10): `canaryOutcomeObservationId` MOVED to `../serving/canary-observation-id.js`
// and is re-exported here so every writer-side caller keeps its import path. The reader entry must
// recompute the identity the writer stamped, and this file cannot be on that entry — it names the
// bundle store and the curation queue payloads. One implementation, two
// import paths: a second spelling would be a silent attribution failure, not a compile error.
export { canaryOutcomeObservationId } from '../serving/canary-observation-id.js'

/**
 * 381-03 (PROC-01 D-02/D-03): the verified queue evidence the procedure-extraction wall
 * validates against. It is code-derived queue truth — distilled observations — never LLM text.
 */
export interface ProcedureDispositionEvidence {
  distilledObservations: readonly DistilledObservation[]
}

export interface DispositionCandidateContext {
  anchors: readonly Anchor[]
  scope: ScopeKey
  buildOrdinal: number
  /** Durable queue address used as the observation's idempotency identity. */
  curationJobId?: string
  /** Original measurement seed value; prose authored by a model is never parsed for authority. */
  measurementValue?: string
  /** Present only for procedure-extraction jobs; procedure deltas fail closed without it. */
  procedureEvidence?: ProcedureDispositionEvidence
}

export interface RelationIntent {
  type: 'proposed-supersession-of' | 'renamed-from'
  targetId: RecordId
}

export interface DispositionDrainState {
  supersedesSeenByAnchorKey: Map<string, number>
  /** 379 Open Question 3: one canonical O(store) scan, lazily cached per drain. */
  canonicalBundles?: CanonicalBundleSnapshot[]
  /** Test-only observability seam for proving the canonical scan runs once. */
  onCanonicalBundleScan?: () => void
  /** Prevent two jobs in one drain from arming the same not-yet-published unknown. */
  unknownMarkersSeen?: Set<string>
  /** New anchor groups observed by earlier jobs after the once-per-drain snapshot. */
  firstSeenAnchorsByScope?: Map<string, Map<string, {
    buildOrdinal: number
    recordId?: RecordId
  }>>
}

export interface FirstSeenRegistration {
  scopeKey: string
  supersessionKey: string
  buildOrdinal: number
}

export interface UnknownMintIntent {
  kind: 'thrash' | 'scope-burst'
  marker: string
  triggerKey: string
  scope: ScopeKey
  windowOpenOrdinal: number
  windowCloseOrdinal: number
  evidenceRecordIds: RecordId[]
  includeCommittedBundle: boolean
  firstSeenCount?: number
}

export interface UnknownResolutionIntent {
  targetId: RecordId
  reason: 'thrash-stable-window'
}

export interface DisposeDeltaInput {
  delta: Delta
  checkpoint: AuthoredDeltaCheckpoint
  profile: DispositionProfile
  knowledgeRoot: string
  /**
   * Verified queue evidence needed for anchor and new-ordinal checks. Optional only for the
   * non-mutating delta shapes; Add and Supersede fail closed when it is absent.
   */
  candidate?: DispositionCandidateContext
  drainState: DispositionDrainState
}

export type DispositionOutcome =
  | {
      kind: 'apply'
      delta: Delta
      relationIntents?: RelationIntent[]
      bornActive?: true
      measurementAppend?: { victimId: RecordId; observation: MeasurementObservation }
      unknownMintIntents?: UnknownMintIntent[]
      unknownResolutionIntents?: UnknownResolutionIntent[]
      firstSeenRegistration?: FirstSeenRegistration
    }
  | {
      kind: 'downgraded'
      delta: Delta
      reason: string
      original: Delta
      relationIntents?: RelationIntent[]
      measurementAppend?: { victimId: RecordId; observation: MeasurementObservation }
      unknownMintIntents?: UnknownMintIntent[]
      unknownResolutionIntents?: UnknownResolutionIntent[]
      firstSeenRegistration?: FirstSeenRegistration
    }
  | { kind: 'requeue-resynthesis'; reason: string }
  | { kind: 'noop'; reason: string }

/** Classification observation only: disposal remains the sole policy decision. */
export function originalDispositionDelta(disposed: Extract<DispositionOutcome, { delta: Delta }>): Delta {
  return disposed.kind === 'downgraded' ? disposed.original : disposed.delta
}

interface BundleTruth {
  dir: string
  bundle: LoadedBundle
  status: BundleStatus
  openedAtOrdinal: number
  currentOrdinal: number
}

type TruthLookup = (id: RecordId) => BundleTruth | undefined

type CheckFailure =
  | { kind: 'downgrade'; reason: string; fallback?: 'drift-unknown' }
  | { kind: 'requeue'; reason: string }
  /**
   * REFUSE the delta outright rather than degrade it into something else.
   *
   * The arm carries the failing `recordId` because the other two do not need one and this one
   * does: the refusal is reported to a person who addressed a specific record, and "the citation
   * check failed" without saying which id it failed on is an answer they cannot act on. It
   * carries the `condition` for the same reason one level down — which of the four ways the
   * store cannot stand behind that id fired.
   */
  | {
      kind: 'refuse'
      reason: string
      recordId: RecordId
      condition: CitedIdIntegrityCondition
    }

type CheckVerdict = { kind: 'pass' } | CheckFailure

interface EvaluationState {
  renameBridge?: RelationIntent
  blastRadiusAnchorKey?: string
  unknownMintIntents?: UnknownMintIntent[]
  unknownResolutionIntents?: UnknownResolutionIntent[]
  firstSeenRegistration?: FirstSeenRegistration
}

const PASS: CheckVerdict = { kind: 'pass' }

function sameScope(left: ScopeKey, right: ScopeKey): boolean {
  return left.tier === right.tier && left.key === right.key
}

function sameAnchor(left: Anchor, right: Anchor): boolean {
  return canonicalJson(normalizeAnchor(left)) === canonicalJson(normalizeAnchor(right))
}

function primaryAnchor(anchors: readonly Anchor[]): Anchor | undefined {
  return anchors[0]
}

function deltaTargetIds(delta: Delta): RecordId[] {
  const ids = new Set<RecordId>(delta.citedIds)
  switch (delta.kind) {
    case 'Confirm':
    case 'Deprecate':
      ids.add(delta.targetId)
      break
    case 'Supersede':
      ids.add(delta.victimId)
      break
    case 'MintUnknown':
      for (const id of delta.conflict.recordIds) ids.add(id)
      break
    case 'Add':
    case 'Noop':
      break
  }
  return [...ids]
}

function truthLookup(knowledgeRoot: string): TruthLookup {
  const cache = new Map<RecordId, BundleTruth | undefined>()
  return (id) => {
    if (cache.has(id)) return cache.get(id)

    for (const entry of enumerateBundleDirs(knowledgeRoot)) {
      const loaded = loadBundle(entry.dir)
      if (loaded.kind !== 'loaded' || loaded.bundle.manifest.id !== id) continue
      // BundleTruth consumes lifecycle and validity ordinals only, never numerical trust.
      const trust = deriveBundleTrust(loaded.bundle)
      const truth: BundleTruth = {
        dir: entry.dir,
        bundle: loaded.bundle,
        status: trust.status,
        openedAtOrdinal: trust.validity.openedAtOrdinal,
        currentOrdinal:
          trust.validity.closedAtOrdinal ?? trust.validity.openedAtOrdinal,
      }
      cache.set(id, truth)
      return truth
    }

    cache.set(id, undefined)
    return undefined
  }
}

function canonicalBundles(input: DisposeDeltaInput): readonly CanonicalBundleSnapshot[] {
  if (input.drainState.canonicalBundles === undefined) {
    input.drainState.onCanonicalBundleScan?.()
    // The lineage scan projects status/events/identity only; no numerical trust enters checks.
    input.drainState.canonicalBundles = scanCanonicalBundles(input.knowledgeRoot)
  }
  return input.drainState.canonicalBundles
}

function flowMarker(bundle: CanonicalBundleSnapshot): string | undefined {
  const primary = bundle.anchors[0]
  return primary?.t === 'flow' ? primary.name : undefined
}

function unresolvedUnknownsWithPrefix(
  input: DisposeDeltaInput,
  prefix: string,
): CanonicalBundleSnapshot[] {
  return canonicalBundles(input).filter((bundle) =>
    bundle.kind === 'unknown'
    && bundle.status !== 'deprecated'
    && bundle.status !== 'superseded'
    && flowMarker(bundle)?.startsWith(prefix) === true,
  )
}

function unknownMarkerAlreadyArmed(input: DisposeDeltaInput, marker: string): boolean {
  if (input.drainState.unknownMarkersSeen?.has(marker) === true) return true
  return canonicalBundles(input).some((bundle) =>
    bundle.kind === 'unknown'
    && flowMarker(bundle) === marker,
  )
}

function armUnknownMarker(input: DisposeDeltaInput, marker: string): void {
  input.drainState.unknownMarkersSeen ??= new Set<string>()
  input.drainState.unknownMarkersSeen.add(marker)
}

function pushUnknownMint(state: EvaluationState, intent: UnknownMintIntent): void {
  state.unknownMintIntents = [...(state.unknownMintIntents ?? []), intent]
}

function pushUnknownResolution(
  state: EvaluationState,
  intent: UnknownResolutionIntent,
): void {
  state.unknownResolutionIntents = [...(state.unknownResolutionIntents ?? []), intent]
}

/**
 * D-07/D-08: the tripping Supersede remains the applied write. The unresolved
 * unknown is a second deterministic commit intent; it suppresses serving later,
 * never this writer path.
 */
function armThrashTripAndClosure(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
  state: EvaluationState,
): void {
  const buildOrdinal = input.candidate?.buildOrdinal
  if (buildOrdinal === undefined) return
  const bundles = canonicalBundles(input)

  if (input.delta.kind === 'Supersede' && input.profile.mode === 'drain-to-active') {
    const victim = lookup(input.delta.victimId)
    if (victim === undefined) return
    const victimAnchors = victim.bundle.frontmatter.anchors.map(
      ({ normalized }) => normalized,
    )
    const triggerKey = schemaSupersessionKey(victimAnchors)
    const folded = foldSupersessionLineage(bundles, {
      windowBuilds: THRASH_WINDOW_BUILDS,
      asOfBuildOrdinal: buildOrdinal,
    }).get(triggerKey)
    const depthAfterCommit = (folded?.supersededDepthInWindow ?? 0) + 1
    if (depthAfterCommit < THRASH_MAX_SUPERSESSIONS) return

    const prefix = `thrash:${triggerKey}:window:`
    if (unresolvedUnknownsWithPrefix(input, prefix).length > 0) return
    const windowOpenOrdinal = folded?.windowOpenOrdinal
      ?? Math.max(1, buildOrdinal - THRASH_WINDOW_BUILDS + 1)
    const marker = `${prefix}${windowOpenOrdinal}`
    if (unknownMarkerAlreadyArmed(input, marker)) return

    pushUnknownMint(state, {
      kind: 'thrash',
      marker,
      triggerKey,
      scope: input.delta.scope,
      windowOpenOrdinal,
      windowCloseOrdinal: buildOrdinal,
      evidenceRecordIds: [
        ...(folded?.chainRecordIds ?? []),
        input.delta.victimId,
      ].filter((id, index, values) => values.indexOf(id) === index).sort(),
      includeCommittedBundle: true,
    })
    armUnknownMarker(input, marker)
    return
  }

  if (input.delta.kind !== 'Confirm') return
  const target = lookup(input.delta.targetId)
  if (target === undefined) return
  const targetAnchors = target.bundle.frontmatter.anchors.map(
    ({ normalized }) => normalized,
  )
  const triggerKey = schemaSupersessionKey(targetAnchors)
  const folded = foldSupersessionLineage(bundles, {
    windowBuilds: Number.MAX_SAFE_INTEGER,
    asOfBuildOrdinal: buildOrdinal,
  }).get(triggerKey)
  const latest = folded?.latestSupersessionOrdinal
  if (latest === undefined || buildOrdinal - latest < STABLE_WINDOW_BUILDS) return

  for (const unknown of unresolvedUnknownsWithPrefix(input, `thrash:${triggerKey}:window:`)) {
    pushUnknownResolution(state, {
      targetId: unknown.recordId,
      reason: 'thrash-stable-window',
    })
  }
}

function createdAnchors(delta: Delta): readonly Anchor[] | undefined {
  if (delta.kind === 'Add') return delta.bundle.anchors
  if (delta.kind === 'Supersede') return delta.newBundle.anchors
  return undefined
}

/**
 * D-09/Open Question 3: evaluate the O(store) first-seen fold once per drain,
 * then increment it with committed jobs carried in drain state. Crossing the
 * provisional threshold arms one scope/window unknown without rewriting the
 * triggering Add or Supersede.
 */
function armScopeBurst(
  input: DisposeDeltaInput,
  state: EvaluationState,
): void {
  const anchors = createdAnchors(input.delta)
  const buildOrdinal = input.candidate?.buildOrdinal
  if (anchors === undefined || buildOrdinal === undefined) return

  const scopeKey = anchorScopeKey(anchors)
  if (scopeKey === undefined) return
  const candidateKey = schemaSupersessionKey(anchors)
  const bundles = canonicalBundles(input)
  const matchingCanonical = bundles.filter((bundle) =>
    bundle.kind !== 'unknown'
    && schemaSupersessionKey(bundle.anchors) === candidateKey,
  )
  const replayedCandidate = matchingCanonical.find((bundle) =>
    input.candidate?.curationJobId !== undefined
    && bundle.curationJobId === input.candidate.curationJobId,
  )
  if (matchingCanonical.some((bundle) => bundle !== replayedCandidate)) return
  const baselineBundles = replayedCandidate === undefined
    ? bundles
    : bundles.filter((bundle) => bundle.recordId !== replayedCandidate.recordId)

  input.drainState.firstSeenAnchorsByScope ??= new Map()
  const entries = input.drainState.firstSeenAnchorsByScope.get(scopeKey) ?? new Map()
  input.drainState.firstSeenAnchorsByScope.set(scopeKey, entries)
  if (entries.has(candidateKey)) return

  const baseline = foldFirstSeenAnchorsByScope(baselineBundles, {
    windowBuilds: SCOPE_BURST_WINDOW_BUILDS,
    asOfBuildOrdinal: buildOrdinal,
  }).get(scopeKey)
  const windowOpenOrdinal = baseline?.windowOpenOrdinal
    ?? Math.max(1, buildOrdinal - SCOPE_BURST_WINDOW_BUILDS + 1)
  const inWindowEntries = [...entries.entries()].filter(
    ([, entry]) => entry.buildOrdinal >= windowOpenOrdinal,
  )
  const countBefore = (baseline?.firstSeenCount ?? 0) + inWindowEntries.length
  entries.set(candidateKey, {
    buildOrdinal,
    ...(replayedCandidate === undefined ? {} : { recordId: replayedCandidate.recordId }),
  })
  state.firstSeenRegistration = {
    scopeKey,
    supersessionKey: candidateKey,
    buildOrdinal,
  }
  const countAfter = countBefore + 1
  if (countBefore > SCOPE_BURST_THRESHOLD || countAfter <= SCOPE_BURST_THRESHOLD) return

  const marker = `scope-burst:${scopeKey}:window:${windowOpenOrdinal}`
  if (unknownMarkerAlreadyArmed(input, marker)) return
  pushUnknownMint(state, {
    kind: 'scope-burst',
    marker,
    triggerKey: scopeKey,
    scope: input.delta.scope,
    windowOpenOrdinal,
    windowCloseOrdinal: buildOrdinal,
    firstSeenCount: countAfter,
    evidenceRecordIds: [
      ...(baseline?.recordIds ?? []),
      ...inWindowEntries.flatMap(([, entry]) =>
        entry.recordId === undefined ? [] : [entry.recordId],
      ),
    ].filter((id, index, values) => values.indexOf(id) === index).sort(),
    includeCommittedBundle: true,
  })
  armUnknownMarker(input, marker)
}

interface MeasurementDisposition {
  input: DisposeDeltaInput
  measurementAppend?: { victimId: RecordId; observation: MeasurementObservation }
  confirmedDriftSupersede: boolean
}

/**
 * RATIFICATION A6: non-numeric measurement values retain the existing inequality-supersede
 * semantics outside the drift tree. Otherwise string-valued measurements could never widen.
 */
function finiteMeasurementValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Mechanism #9: discipline measurement Confirm/Supersede deltas against canonical bundle truth
 * before the six existing checks compose their final verdict.
 */
function disposeMeasurementDrift(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
): MeasurementDisposition {
  const delta = input.delta
  if (delta.kind !== 'Confirm' && delta.kind !== 'Supersede') {
    return { input, confirmedDriftSupersede: false }
  }
  const victimId = delta.kind === 'Confirm' ? delta.targetId : delta.victimId

  const victim = lookup(victimId)
  if (
    victim === undefined
    || victim.bundle.frontmatter.kind !== 'fact'
    || victim.bundle.frontmatter.subtype !== 'measurement'
  ) {
    return { input, confirmedDriftSupersede: false }
  }

  const value = finiteMeasurementValue(input.candidate?.measurementValue)
  if (value === undefined) {
    return { input, confirmedDriftSupersede: false }
  }
  if (input.candidate?.curationJobId === undefined) {
    throw new TypeError('numeric measurement disposition requires a durable curation job id')
  }

  const measurements = readMeasurements(victim.dir)
  if (measurements === undefined) {
    throw new TypeError('numeric measurement disposition requires a stored baseline')
  }
  const observation: MeasurementObservation = {
    value,
    buildOrdinal: input.candidate.buildOrdinal,
    evidenceToken: delta.evidenceToken,
    curationJobId: input.candidate.curationJobId,
  }
  const consumed = measurements.observations.find(
    (candidate) =>
      candidate.evidenceToken === observation.evidenceToken
      && candidate.curationJobId === observation.curationJobId,
  )
  if (consumed !== undefined && canonicalJson(consumed) !== canonicalJson(observation)) {
    throw new TypeError('measurement observation identity resolved to different canonical bytes')
  }
  const observations = consumed === undefined
    ? [...measurements.observations, observation]
    : measurements.observations
  const decision = decideMeasurementDrift({
    baseline: measurements.baseline,
    state: foldMeasurements(measurements.baseline, observations),
    windowBuilds: { observations },
  })

  if (delta.kind === 'Confirm') {
    // Confirm carries observation authority but no replacement draft. Keep accumulating canonical
    // evidence so a later measurement Supersede can realize a confirmed regime change.
    return {
      input,
      measurementAppend: { victimId, observation },
      confirmedDriftSupersede: false,
    }
  }

  if (decision.decision === 'supersede') {
    return { input, confirmedDriftSupersede: true }
  }

  // Pitfall 5: a widen emits no superseded event and therefore never feeds the thrash counter.
  const confirm: Delta = {
    kind: 'Confirm',
    ...envelope(delta),
    targetId: victimId,
    evidenceToken: delta.evidenceToken,
  }
  return {
    input: { ...input, delta: confirm },
    measurementAppend: { victimId, observation },
    confirmedDriftSupersede: false,
  }
}

/**
 * Every way `checkCitedIdIntegrity` can decide this store cannot stand behind a cited id.
 *
 * The registry exists so the count stops being something a comment or a corpus has to keep in
 * step. Round 2 measured what happens when it is not one: the check's second return is a
 * three-way disjunction, the corpus and the doc comment both said "three conditions", and
 * carving `scope-mismatch` out of the refusal for every origin left 3 files / 70 tests green.
 * A fifth member added here is a compile error at `citedIdIntegrityFailure`'s derivation and at
 * the corpus's `satisfies Record<CitedIdIntegrityCondition, …>` fixture table.
 */
export const CITED_ID_INTEGRITY_CONDITIONS = [
  'not-a-persisted-neighbor',
  'missing-from-disk',
  'deprecated',
  'scope-mismatch',
] as const

export type CitedIdIntegrityCondition = (typeof CITED_ID_INTEGRITY_CONDITIONS)[number]

/**
 * The typed refusal a USER-authored delta receives when its cited-id integrity check fails.
 *
 * Thrown rather than returned, and out of the check funnel rather than out of the commit, so it
 * fires before any canonical byte moves for this delta: `disposeDelta` runs `checkCitedIdIntegrity`
 * first of the six §7.3.1 checks, ahead of every append, projection and promotion.
 * `applyReview`'s `commitAndPublish` catches it, restores the proposal to pending and rethrows,
 * which is how the caller gets a typed answer instead of a receipt for work nobody did.
 *
 * WHAT MAKES "NOTHING MOVED" TRUE, and it is not this sentence. The previous version of this
 * comment asserted whole-store neutrality as free-standing prose, naming no mechanism, and the
 * round-2 verifier measured that claim FALSE: the delta had already reached disposition through
 * `knowledge-store.ts`'s bridge, which materialized a claimed curation candidate on disk before
 * `commitWithProfile` ever called into the commit, and the throw left it there for the next
 * drain's reconcile to requeue (CR-02″). Two mechanisms now establish the claim, and each of them
 * reds if it is removed:
 *
 *   1. `bridgeDelta` is WRITE-FREE (`curator/knowledge-store.ts`). It computes the candidate's
 *      address and materializes nothing, so a check that throws at any position has nothing to
 *      leave behind. Reintroducing its two write statements reds the case in (2).
 *   2. `review/__tests__/apply-review.test.ts` asserts `hashTree(knowledgeRoot)` and the tree's
 *      full entry listing — QUEUE TREE INCLUDED — are identical across a refused `accept`, with
 *      a potency control proving the digest is falsifiable over that exact root.
 *
 * The scope of the guarantee is the knowledge root. The writer lease's own fencing state
 * (`.epoch`, `.writer-authority.sqlite`) advances on acquisition regardless of what the caller
 * then does, which is why the case above holds the lease across its measurement rather than
 * excusing those two names.
 */
export class UserDeltaCitationIntegrityError extends Error {
  constructor(
    readonly recordId: RecordId,
    readonly deltaKind: Delta['kind'],
    readonly condition: CitedIdIntegrityCondition,
  ) {
    super(
      `The record ${recordId} this ${deltaKind} cites is one this store cannot stand behind ` +
        `(${condition}), so the instruction is REFUSED rather than converted into minted ` +
        'content. Nothing was committed and the record is unchanged.',
    )
    this.name = 'UserDeltaCitationIntegrityError'
  }
}

/**
 * What a cited-id-integrity failure falls back to, decided by WHO authored the delta.
 *
 * Total over the origin vocabulary by construction: the `satisfies` below makes a fifth origin
 * member a compile error AT THIS TABLE, so no future member can silently inherit a fallback
 * nobody chose for it. That is the whole mechanism — the class of defect this closes is "a guard
 * scoped to the members somebody happened to think of", and the only fix that class cannot
 * reopen is handing the enumeration to something that cannot forget a member.
 *
 * WHY each member is what it is:
 *
 *   agent   — the curation pipeline proposed this change from its own observations. A broken
 *             citation means the pipeline reasoned over a record that no longer stands, and
 *             degrading its proposal into a clarification candidate a person can adjudicate is
 *             exactly the right answer. This is the drain path's long-standing behaviour and it
 *             is PRESERVED unchanged.
 *   import  — bulk-ingested content, pipeline-authored in every sense that matters here: nobody
 *             is waiting on a typed answer for one record, and a clarification candidate is the
 *             reviewable artifact the importer wants.
 *   system  — maintenance deltas (rollback's Deprecate, the canary Confirm). Same reasoning:
 *             machine-authored content, and a refusal would turn a maintenance sweep into a hard
 *             failure over one stale citation.
 *   user    — a human INSTRUCTION about records that already exist. There is no content here to
 *             degrade: minting from it publishes a verbatim clone of the cited record under a
 *             fresh content address as a `candidate`, which serving re-admits — so an `accept`
 *             over a record the same person had already rejected RESURRECTED the fact they
 *             removed and reported success (CR-02′). The store cannot grant the instruction, so
 *             it says so.
 */
const CITED_ID_INTEGRITY_FALLBACK_BY_ORIGIN = {
  agent: 'mint-unknown',
  import: 'mint-unknown',
  system: 'mint-unknown',
  user: 'refuse',
} as const satisfies Record<DeltaOrigin, 'mint-unknown' | 'refuse'>

/**
 * The ONE site the fallback mapping is consulted, shared by every failure condition the check
 * has. Deliberately not inlined at either return site: the check fails for the four reasons
 * `CITED_ID_INTEGRITY_CONDITIONS` enumerates, and they are ONE failure domain ("this delta cites
 * something this store cannot stand behind"). Discriminating at one of them and not the others is
 * the same one-axis-out mistake as scoping a guard to one verb of a set.
 *
 * The `condition` is carried THROUGH this site rather than derived here, and that is what keeps
 * the funnel a funnel: the caller knows which disjunct fired, this function knows what to do
 * about it, and neither has to learn the other's job.
 */
function citedIdIntegrityFailure(
  delta: Delta,
  recordId: RecordId,
  condition: CitedIdIntegrityCondition,
): CheckFailure {
  return CITED_ID_INTEGRITY_FALLBACK_BY_ORIGIN[delta.origin] === 'refuse'
    ? { kind: 'refuse', reason: 'cited-id-integrity', recordId, condition }
    : { kind: 'downgrade', reason: 'cited-id-integrity' }
}

function checkCitedIdIntegrity(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
): CheckVerdict {
  const persistedNeighbors = new Set<RecordId>(input.checkpoint.neighborIds)
  for (const id of deltaTargetIds(input.delta)) {
    if (!persistedNeighbors.has(id)) {
      return citedIdIntegrityFailure(input.delta, id, 'not-a-persisted-neighbor')
    }
    const truth = lookup(id)
    // The second return's three disjuncts, named in the order they are tested. Splitting them
    // only this far is deliberate: the ANSWER stays one answer (the funnel above), and all that
    // is recovered here is which fact produced it — which the refusal then has to say out loud,
    // because "tombstoned or unresolvable" was false for the third disjunct and sent operators
    // looking for a tombstone a scope-mismatched record does not have.
    if (truth === undefined) {
      return citedIdIntegrityFailure(input.delta, id, 'missing-from-disk')
    }
    if (truth.status === 'deprecated') {
      return citedIdIntegrityFailure(input.delta, id, 'deprecated')
    }
    if (!sameScope(truth.bundle.frontmatter.scope, input.delta.scope)) {
      return citedIdIntegrityFailure(input.delta, id, 'scope-mismatch')
    }
  }
  return PASS
}

function hasSharedAnchor(
  left: readonly Anchor[],
  right: readonly Anchor[],
  type: Anchor['t'],
): boolean {
  return left
    .filter((anchor) => anchor.t === type)
    .some((anchor) =>
      right.some((candidate) => candidate.t === type && sameAnchor(anchor, candidate)),
    )
}

/**
 * 379 D-22 / RATIFICATION A3: `renamed-from` is the concrete realization of
 * memory.md §9.6's alias edge. It already round-trips from relations.json into
 * graph_edges and is traversed by retrieval expansion, so no synonym edge type
 * is added.
 */
function renameBridge(
  newAnchors: readonly Anchor[],
  victimAnchors: readonly Anchor[],
  victimId: RecordId,
): RelationIntent | undefined {
  const next = primaryAnchor(newAnchors)
  const previous = primaryAnchor(victimAnchors)
  if (next?.t !== 'el' || previous?.t !== 'el') return undefined
  const normalizedNext = normalizeAnchor(next)
  const normalizedPrevious = normalizeAnchor(previous)
  if (normalizedNext.t !== 'el' || normalizedPrevious.t !== 'el') return undefined
  if (
    normalizedNext.role !== normalizedPrevious.role
    || normalizedNext.name === normalizedPrevious.name
  ) {
    return undefined
  }
  if (
    !hasSharedAnchor(newAnchors, victimAnchors, 'page')
    || !hasSharedAnchor(newAnchors, victimAnchors, 'selector')
  ) {
    return undefined
  }
  return { type: 'renamed-from', targetId: victimId }
}

function candidateMatchesBundle(
  input: DisposeDeltaInput,
  anchors: readonly Anchor[],
  scope: ScopeKey,
): boolean {
  if (!sameScope(scope, input.delta.scope)) return false
  if (input.candidate === undefined) return false
  const claimedPrimary = primaryAnchor(anchors)
  const verifiedPrimary = primaryAnchor(input.candidate.anchors)
  return (
    claimedPrimary !== undefined
    && verifiedPrimary !== undefined
    && sameAnchor(claimedPrimary, verifiedPrimary)
  )
}

function checkAnchorConsistency(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
  state: EvaluationState,
): CheckVerdict {
  if (input.delta.kind === 'Add') {
    return candidateMatchesBundle(input, input.delta.bundle.anchors, input.delta.bundle.scope)
      ? PASS
      : { kind: 'downgrade', reason: 'anchor-consistency' }
  }
  if (input.delta.kind !== 'Supersede') return PASS
  if (
    !candidateMatchesBundle(
      input,
      input.delta.newBundle.anchors,
      input.delta.newBundle.scope,
    )
  ) {
    return { kind: 'downgrade', reason: 'anchor-consistency' }
  }

  const victim = lookup(input.delta.victimId)
  if (victim === undefined) {
    return { kind: 'downgrade', reason: 'anchor-consistency' }
  }
  const victimAnchors = victim.bundle.frontmatter.anchors.map(({ normalized }) => normalized)
  const nextPrimary = primaryAnchor(input.delta.newBundle.anchors)
  const previousPrimary = primaryAnchor(victimAnchors)
  if (nextPrimary === undefined || previousPrimary === undefined) {
    return { kind: 'downgrade', reason: 'anchor-consistency' }
  }
  if (sameAnchor(nextPrimary, previousPrimary)) return PASS

  const bridge = renameBridge(
    input.delta.newBundle.anchors,
    victimAnchors,
    input.delta.victimId,
  )
  if (bridge === undefined) {
    return { kind: 'downgrade', reason: 'anchor-consistency' }
  }
  state.renameBridge = bridge
  return PASS
}

function checkSupersessionKey(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
  state: EvaluationState,
): CheckVerdict {
  if (input.delta.kind !== 'Supersede') return PASS
  const victim = lookup(input.delta.victimId)
  if (victim === undefined || input.candidate === undefined) {
    return { kind: 'downgrade', reason: 'supersession-key' }
  }

  const victimAnchors = victim.bundle.frontmatter.anchors.map(({ normalized }) => normalized)
  if (
    state.renameBridge === undefined
    && schemaSupersessionKey(input.delta.newBundle.anchors)
      !== schemaSupersessionKey(victimAnchors)
  ) {
    return { kind: 'downgrade', reason: 'supersession-key' }
  }
  if (input.candidate.buildOrdinal <= victim.openedAtOrdinal) {
    return { kind: 'downgrade', reason: 'supersession-key' }
  }
  return PASS
}

/**
 * Who may tombstone a record this store is currently standing behind, decided per origin.
 *
 * MECHANISM, stated so the claim can be reded rather than believed: totality is the `satisfies`
 * clause below — a fifth member of `DeltaOrigin` is a compile error AT THIS TABLE — and the
 * BEHAVIOUR of each member is pinned by the DELTA_ORIGINS walk in disposition.test.ts, whose
 * expectations are declared independently of this literal. Neither half is prose: dropping a
 * member fails `tsc`, flipping a member's value reds a named row.
 *
 * This replaces a hand-picked single-member origin comparison — one literal origin named inline,
 * every other member admitted by omission — that sat eleven lines from
 * `CITED_ID_INTEGRITY_FALLBACK_BY_ORIGIN`, whose own rationale calls `import` machine-authored.
 * The file's two origin discriminations therefore disagreed about the same word. They now share
 * one idiom and one vocabulary, which is what stops them drifting apart again.
 *
 * The retired comparison is DESCRIBED rather than quoted on purpose: a `grep -c` for its literal
 * text is a live guard against it coming back, and a quotation kept here for colour would disarm
 * that guard permanently (387-17 D-4).
 *
 * WHY each member is what it is:
 *
 *   agent   — the autonomy floor itself: a model may PROPOSE removing standing knowledge but may
 *             not perform it, so the Deprecate degrades into a reviewable candidate. Long-standing
 *             behaviour, PRESERVED unchanged.
 *   import  — machine-authored by the same reasoning the fallback table above applies to it
 *             ("bulk-ingested content, pipeline-authored in every sense that matters here"). An
 *             importer that emits a Deprecate is a pipeline nominating a removal, which is
 *             precisely what the floor exists to hold. This is the one BEHAVIOUR change here, and
 *             it is latent: no production site mints `origin: 'import'` today, which is the
 *             condition under which the old member-pick would have been wrong silently.
 *   system  — mechanical maintenance deltas, and they must pass. `appendInverseDeprecate` in
 *             rollback.ts is the written case: its comment records that `agent` "would be
 *             downgraded for an active target, while `user` would incorrectly make this lifecycle
 *             choice sovereign and permanent", and it throws if disposition does not return
 *             `apply`. Downgrading `system` here would turn every rollback into a hard failure.
 *   user    — the human decision the review verbs exist to carry. `reject` and `forget` emit
 *             user-origin Deprecates over active records and depend on reaching `apply`;
 *             downgrading them would silently convert a person's removal into a candidate the
 *             store keeps serving.
 *
 * NOT the same question as `AUTHORED_CHECKPOINT_ORIGIN_ADMISSION` in author-contract.ts, which
 * asks which origins may arrive as DRAIN-AUTHORED curator output. `system` is allowed here and
 * rejected there without contradiction: rollback and the canary reach `disposeDelta` through
 * in-process checkpoints (`maintenanceCheckpoint`, `bridgeDelta`), never through the drain's
 * authored-checkpoint recovery boundary.
 */
const AUTONOMOUS_DEPRECATE_BY_ORIGIN = {
  agent: 'downgrade',
  import: 'downgrade',
  system: 'allow',
  user: 'allow',
} as const satisfies Record<DeltaOrigin, 'downgrade' | 'allow'>

function checkAutonomousDeprecate(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
): CheckVerdict {
  if (input.delta.kind !== 'Deprecate') return PASS
  if (AUTONOMOUS_DEPRECATE_BY_ORIGIN[input.delta.origin] === 'allow') return PASS
  return lookup(input.delta.targetId)?.status === 'active'
    ? { kind: 'downgrade', reason: 'autonomous-deprecate' }
    : PASS
}

function checkCompareAndSet(
  input: DisposeDeltaInput,
  lookup: TruthLookup,
): CheckVerdict {
  for (const precondition of input.checkpoint.preconditions) {
    const current = lookup(precondition.recordId)
    if (
      current === undefined
      || current.status !== precondition.observedStatus
      || current.currentOrdinal !== precondition.observedOrdinal
    ) {
      return { kind: 'requeue', reason: 'compare-and-set' }
    }
  }
  return PASS
}

function checkBlastRadius(
  input: DisposeDeltaInput,
  state: EvaluationState,
): CheckVerdict {
  if (input.delta.kind !== 'Supersede') return PASS
  const candidateScope = input.candidate?.scope ?? input.delta.newBundle.scope
  if (!sameScope(candidateScope, input.delta.scope)) {
    return { kind: 'downgrade', reason: 'blast-radius-scope' }
  }
  if (input.profile.mode === 'propose-only') return PASS

  const anchorKey = schemaSupersessionKey(
    input.candidate?.anchors ?? input.delta.newBundle.anchors,
  )
  const seen = input.drainState.supersedesSeenByAnchorKey.get(anchorKey) ?? 0
  if (seen >= BLAST_RADIUS_MAX_SUPERSEDES_PER_ANCHOR_PER_DRAIN) {
    return {
      kind: 'downgrade',
      reason: 'blast-radius-cap',
      fallback: 'drift-unknown',
    }
  }
  state.blastRadiusAnchorKey = anchorKey
  return PASS
}

function envelope(delta: Delta): Pick<Delta, 'origin' | 'scope' | 'citedIds'> & {
  precondition?: Delta['precondition']
  authorship?: Delta['authorship']
} {
  return {
    origin: delta.origin,
    scope: delta.scope,
    citedIds: [...delta.citedIds],
    ...(delta.precondition === undefined ? {} : { precondition: [...delta.precondition] }),
    ...(delta.authorship === undefined ? {} : { authorship: delta.authorship }),
  }
}

function addCandidate(delta: Extract<Delta, { kind: 'Supersede' }>): Delta {
  return {
    kind: 'Add',
    ...envelope(delta),
    bundle: delta.newBundle,
  }
}

function mintUnknown(
  delta: Delta,
  reason: string,
  conflictKind: 'contradiction' | 'drift' | 'clarification',
): Delta {
  return {
    kind: 'MintUnknown',
    ...envelope(delta),
    citedIds: reason === 'cited-id-integrity' ? [] : [...delta.citedIds],
    conflict: {
      recordIds: reason === 'cited-id-integrity' ? [] : deltaTargetIds(delta),
      kind: conflictKind,
    },
  }
}

function downgraded(
  delta: Delta,
  failure: Extract<CheckFailure, { kind: 'downgrade' }>,
): DispositionOutcome {
  const fallback =
    failure.fallback === 'drift-unknown'
      ? mintUnknown(delta, failure.reason, 'drift')
      : delta.kind === 'Supersede'
        ? addCandidate(delta)
        : mintUnknown(delta, failure.reason, 'clarification')
  return {
    kind: 'downgraded',
    delta: fallback,
    reason: failure.reason,
    original: delta,
  }
}

function procedureDraft(delta: Delta): BundleDraft | undefined {
  if (delta.kind === 'Add' && delta.bundle.kind === 'procedure') return delta.bundle
  if (delta.kind === 'Supersede' && delta.newBundle.kind === 'procedure') {
    return delta.newBundle
  }
  return undefined
}

interface CoveredProcedureStep {
  step: ProcedureBodyPayload['steps'][number]
  observation: DistilledObservation
}

/**
 * §7.1 candidacy mapping: the emit fold's step natural key is instruction text, which may
 * legitimately repeat within a flow. Resolve coverage by a contiguous ordinal window with
 * per-position instruction equality instead of grouping by text, which falsely rejected valid
 * repeated instructions (G6/WR-05). Candidate starts are sorted so the lowest matching window
 * wins deterministically; no complete window means missing PASS evidence and fails closed.
 */
function coveredProcedureSteps(
  payload: ProcedureBodyPayload,
  observations: readonly DistilledObservation[],
): CoveredProcedureStep[] | undefined {
  const byOrdinal = new Map<number, DistilledObservation>()
  for (const observation of observations) {
    if (byOrdinal.has(observation.step.ordinal)) return undefined
    byOrdinal.set(observation.step.ordinal, observation)
  }

  const candidateStarts = [...byOrdinal.keys()].sort((left, right) => left - right)
  for (const startOrdinal of candidateStarts) {
    const covered: CoveredProcedureStep[] = []
    for (const [index, step] of payload.steps.entries()) {
      const observation = byOrdinal.get(startOrdinal + index)
      if (observation === undefined || observation.step.naturalKey !== step.instruction) {
        break
      }
      covered.push({ step, observation })
    }
    if (covered.length === payload.steps.length) return covered
  }
  return undefined
}

/**
 * Preserve the established non-contiguous rejection when the full instruction sequence exists
 * in ordinal order but only with gaps. Coverage itself is still granted exclusively by the
 * contiguous-window matcher above.
 */
function hasOrderedNonContiguousProcedureSpan(
  payload: ProcedureBodyPayload,
  observations: readonly DistilledObservation[],
): boolean {
  const [firstStep] = payload.steps
  if (firstStep === undefined) return false

  const ordered = [...observations].sort(
    (left, right) => left.step.ordinal - right.step.ordinal,
  )
  for (let startIndex = 0; startIndex < ordered.length; startIndex += 1) {
    const start = ordered[startIndex]!
    if (start.step.naturalKey !== firstStep.instruction) continue

    let observationIndex = startIndex + 1
    let previousOrdinal = start.step.ordinal
    let matched = true
    let hasGap = false
    for (const step of payload.steps.slice(1)) {
      let observation: DistilledObservation | undefined
      while (observationIndex < ordered.length) {
        const candidate = ordered[observationIndex++]!
        if (
          candidate.step.ordinal > previousOrdinal &&
          candidate.step.naturalKey === step.instruction
        ) {
          observation = candidate
          break
        }
      }
      if (observation === undefined) {
        matched = false
        break
      }
      if (observation.step.ordinal !== previousOrdinal + 1) hasGap = true
      previousOrdinal = observation.step.ordinal
    }
    if (matched && hasGap) return true
  }
  return false
}

/**
 * 381-03 (PROC-01): the deterministic procedure-extraction wall — D-02 candidacy (contiguous
 * verified-PASS span with resolved elements + coherent anchors) and Pitfall 6 replayability
 * (the ONE shared schema exclusion list, never a fork). Any failed check disposes the delta
 * as a structured Noop with a machine-readable reason; nothing here reads LLM prose for
 * authority — the body decode is fail-closed and evidence comes from the durable queue payload.
 */
function disposeProcedureExtraction(input: DisposeDeltaInput): string | undefined {
  const draft = procedureDraft(input.delta)
  if (draft === undefined) return undefined
  const evidence = input.candidate?.procedureEvidence
  if (evidence === undefined) return 'procedure-evidence-missing'

  const payload = parseProcedureBody(draft.body)
  if (payload === undefined) return 'procedure-body-unparseable'

  const covered = coveredProcedureSteps(payload, evidence.distilledObservations)
  if (covered === undefined) {
    return hasOrderedNonContiguousProcedureSpan(payload, evidence.distilledObservations)
      ? 'procedure-span-non-contiguous'
      : 'procedure-step-coverage'
  }
  for (let index = 1; index < covered.length; index += 1) {
    const previous = covered[index - 1]!.observation.step.ordinal
    if (covered[index]!.observation.step.ordinal !== previous + 1) {
      return 'procedure-span-non-contiguous'
    }
  }
  if (covered.some(({ observation }) => observation.element === undefined)) {
    return 'procedure-step-unresolved-element'
  }

  if (draft.anchors.filter((anchor) => anchor.t === 'flow').length !== 1) {
    return 'procedure-flow-anchor'
  }
  const coveredSurfaces = new Set(
    covered.flatMap(({ observation }) =>
      observation.surface === undefined ? [] : [observation.surface.naturalKey],
    ),
  )
  const pageRoutes = [
    ...draft.anchors.flatMap((anchor) => (anchor.t === 'page' ? [anchor.route] : [])),
    ...payload.steps.map((step) => step.guard.pageAnchor.route),
  ]
  if (pageRoutes.some((route) => !coveredSurfaces.has(route))) {
    return 'procedure-page-anchor-disjoint'
  }

  for (const { step } of covered) {
    const shapeKeys = [
      ...Object.keys(step.action.targets),
      ...Object.keys(step.action.values),
    ]
    if (!isReplayableActionShape(step.action.type, shapeKeys)) {
      return 'procedure-non-replayable-action'
    }
  }

  const secretReject = procedureSecretLiteralReject(covered)
  if (secretReject !== undefined) return secretReject

  const bindingReject = procedureBindingIntegrityReject(payload)
  if (bindingReject !== undefined) return bindingReject

  return undefined
}

/**
 * 2026-10-15 (441-64, WR-C01): a declared secret is the `[secret:NAME]` marker or an unexpanded
 * `{{secret:...}}` template; a test variable is a `{{env:...}}` template. The emit fold labels
 * value sources on this same contract; any such observed value surviving as a committed literal
 * is a D-03 structural reject — the secret param type only protects values that stay `{ param }`
 * referenced (T-381-02/07).
 */
const MASKED_SECRET_VALUE_PATTERN = /\[secret:\w+\]|\{\{\s*secret:/
const TEST_VARIABLE_VALUE_PATTERN = /\{\{\s*env:/

/**
 * D-03 rule 2: a literal whose own content matches the masking contract fails closed.
 * 2026-10-15 (441-25, D-28): the field a value was typed into never makes it secret.
 */
function procedureSecretLiteralReject(
  covered: readonly CoveredProcedureStep[],
): string | undefined {
  for (const { step } of covered) {
    for (const slot of Object.values(step.action.values)) {
      if (typeof slot !== 'string') continue
      if (MASKED_SECRET_VALUE_PATTERN.test(slot)) return 'procedure-masked-secret-literal'
      if (TEST_VARIABLE_VALUE_PATTERN.test(slot)) return 'procedure-test-variable-literal'
    }
  }
  return undefined
}

/**
 * D-03 rule 1: every `{ param }` ref must resolve to a declared parameter, and every
 * declared parameter must be referenced by at least one step value slot. (Param types
 * outside the closed string/number/boolean/secret union are unreachable here by
 * construction — `parseProcedureBody` already refused them at the decode wall.)
 */
function procedureBindingIntegrityReject(
  payload: ProcedureBodyPayload,
): string | undefined {
  const declared = new Set(payload.parameters.map(({ name }) => name))
  const referenced = new Set<string>()
  for (const step of payload.steps) {
    for (const slot of Object.values(step.action.values)) {
      if (typeof slot !== 'object' || !('param' in slot)) continue
      if (!declared.has(slot.param)) return 'procedure-param-undeclared'
      referenced.add(slot.param)
    }
  }
  if (payload.parameters.some(({ name }) => !referenced.has(name))) {
    return 'procedure-param-unreferenced'
  }
  return undefined
}

/**
 * Run memory.md §7.3.1's six checks in order. The function is deliberately synchronous: every
 * decision is made from the persisted checkpoint and canonical bundle tree, never an index row.
 */
export function disposeDelta(input: DisposeDeltaInput): DispositionOutcome {
  const procedureReject = disposeProcedureExtraction(input)
  if (procedureReject !== undefined) {
    return { kind: 'noop', reason: procedureReject }
  }
  const lookup = truthLookup(input.knowledgeRoot)
  const measurement = disposeMeasurementDrift(input, lookup)
  const dispositionInput = measurement.input
  const state: EvaluationState = {}
  const checks = [
    () => checkCitedIdIntegrity(dispositionInput, lookup),
    () => checkAnchorConsistency(dispositionInput, lookup, state),
    () => checkSupersessionKey(dispositionInput, lookup, state),
    () => checkAutonomousDeprecate(dispositionInput, lookup),
    () => checkCompareAndSet(dispositionInput, lookup),
    () => checkBlastRadius(dispositionInput, state),
  ]

  for (const check of checks) {
    const verdict = check()
    if (verdict.kind === 'requeue') {
      return { kind: 'requeue-resynthesis', reason: verdict.reason }
    }
    if (verdict.kind === 'refuse') {
      // No outcome arm carries a refusal on purpose: `DispositionOutcome` is the vocabulary of
      // things that CHANGE the store, and a refusal changes nothing. Throwing keeps the caller
      // from having to remember to check for a fifth arm — the mistake that produced the defect
      // this refusal exists for.
      throw new UserDeltaCitationIntegrityError(
        verdict.recordId,
        dispositionInput.delta.kind,
        verdict.condition,
      )
    }
    if (verdict.kind === 'downgrade') {
      return {
        ...downgraded(dispositionInput.delta, verdict),
        ...(measurement.measurementAppend === undefined
          ? {}
          : { measurementAppend: measurement.measurementAppend }),
      }
    }
  }

  if (dispositionInput.delta.kind === 'Noop') return { kind: 'noop', reason: 'delta-noop' }
  if (
    dispositionInput.profile.mode === 'propose-only'
    && (
      dispositionInput.delta.kind === 'Supersede'
      || dispositionInput.delta.kind === 'Deprecate'
    )
  ) {
    // D-02 flat invariant: propose-only has zero exceptions. Even deterministically confirmed
    // drift remains a candidate plus proposed-supersession relation in CI and cloud contexts.
    const fallback = dispositionInput.delta.kind === 'Supersede'
      ? addCandidate(dispositionInput.delta)
      : mintUnknown(dispositionInput.delta, 'propose-only', 'clarification')
    if (fallback.kind === 'Add') {
      armScopeBurst({ ...dispositionInput, delta: fallback }, state)
    }
    return {
      kind: 'downgraded',
      delta: fallback,
      reason: 'propose-only',
      original: dispositionInput.delta,
      ...(dispositionInput.delta.kind === 'Supersede'
        ? {
            relationIntents: [
              {
                type: 'proposed-supersession-of' as const,
                targetId: dispositionInput.delta.victimId,
              },
              ...(state.renameBridge === undefined ? [] : [state.renameBridge]),
            ],
          }
        : {}),
      ...(state.unknownMintIntents === undefined
        ? {}
        : { unknownMintIntents: state.unknownMintIntents }),
      ...(state.firstSeenRegistration === undefined
        ? {}
        : { firstSeenRegistration: state.firstSeenRegistration }),
    }
  }

  armThrashTripAndClosure(dispositionInput, lookup, state)
  armScopeBurst(dispositionInput, state)
  if (state.blastRadiusAnchorKey !== undefined) {
    const seen = input.drainState.supersedesSeenByAnchorKey.get(state.blastRadiusAnchorKey) ?? 0
    input.drainState.supersedesSeenByAnchorKey.set(state.blastRadiusAnchorKey, seen + 1)
  }
  return {
    kind: 'apply',
    delta: dispositionInput.delta,
    ...(state.renameBridge === undefined ? {} : { relationIntents: [state.renameBridge] }),
    ...(measurement.measurementAppend === undefined
      ? {}
      : { measurementAppend: measurement.measurementAppend }),
    ...(state.unknownMintIntents === undefined
      ? {}
      : { unknownMintIntents: state.unknownMintIntents }),
    ...(state.unknownResolutionIntents === undefined
      ? {}
      : { unknownResolutionIntents: state.unknownResolutionIntents }),
    ...(state.firstSeenRegistration === undefined
      ? {}
      : { firstSeenRegistration: state.firstSeenRegistration }),
    ...(measurement.confirmedDriftSupersede
      && dispositionInput.profile.mode === 'drain-to-active'
      ? { bornActive: true as const }
      : {}),
  }
}
