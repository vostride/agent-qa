import { join } from 'node:path'

import type { KnowledgePort } from '@vostride/agent-qa-agent'
import {
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  deriveEvidenceToken,
  evaluatePromotionGate,
  eventDedupKey,
  foldBundleTrust,
  GATE_RECEIPT_SCHEMA_VERSION,
  GateReceiptSchema,
  receiptDigestOf,
  sha256hex,
  survivingOutcomeEvents,
  strongestPromotionPath,
  strongerPromotionPath,
} from '@vostride/agent-qa-schema'
import type {
  BundleDraft,
  CanaryOutcome,
  CurationAuthorship,
  Delta,
  ExecutionContext,
  GateReceipt,
  GateReceiptRecordOutcome,
  PromotionGateHoldReason,
  PromotionOutcome,
  PromotionPath,
  RecordId,
  ScreenState,
  TrustPriorTable,
} from '@vostride/agent-qa-schema'

import { appendGateReceipt, appendOutcomeEvent, appendPromotionReceipt, type AppendOutcome } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle, readGateReceipts } from '../bundle-read.js'
import type { LoadedBundle } from '../bundle-read.js'
import type { BundleStoreConfig } from '../bundle-publish.js'
import {
  BundleTargetResolutionError,
  resolveProductQualifiedBundleDir,
} from '../bundle-scan.js'
import { readCurrentEpoch, withCurrentWriterAuthority } from '../lease/writer-lease.js'
import { claimedCandidateDir } from '../queue/queue-layout.js'
import { snapshotTrustPriors } from '../promotion-gate-input.js'
import {
  CURATION_QUEUE_SCHEMA_VERSION,
  buildCurationCandidateAddressFields,
  candidateContentAddress,
} from '../queue/queue-payload.js'
import type {
  CurationCandidateAddressFields,
  CurationCandidatePayload,
} from '../queue/queue-payload.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION, resolveDispositionProfile } from './author-contract.js'
import type { AuthoredDeltaCheckpoint, DispositionProfile } from './author-contract.js'
import {
  applyIndexDeltaForBundleWithinCurrentAuthority,
  assemblePromotionGateInput,
  commitCurationDelta,
  derivePromotedEvidenceToken,
} from './commit.js'
import { canaryOutcomeObservationId } from './disposition.js'
import type {
  CommitCurationDependencies,
  CommitCurationJob,
  CommitCurationOutcome,
} from './commit.js'

/**
 * CR-02 takeover barriers. Test-only seams naming the three points at which a canary flow is
 * about to make canonical state durable; production callers omit them.
 *
 * The two entry barriers fire OUTSIDE the held section, which is what lets a schedule complete a
 * real takeover there and then observe the resumed writer's refusal. `beforeIndexProjection` fires
 * INSIDE it, so its schedule observes a contender blocked behind the tail instead.
 */
export interface CanaryAuthorityHooks {
  /** Immediately before the negative arm enters its held section. */
  beforeNegativeAppend?: () => void
  /** Immediately before the positive arm enters its held promotion section. */
  beforePromotionAppend?: () => void
  /** Inside the negative arm's held section, between its append and its projection. */
  beforeIndexProjection?: () => void
}

export interface CreateLocalKnowledgeStoreConfig {
  knowledgeRoot: string
  executionContext: ExecutionContext
  /** The holder's fresh lease epoch. Defaults to a fresh disk read for composition roots. */
  epoch?: number
  /**
   * The caller's real writer-lease id, paired with `epoch`.
   *
   * CR-02: every canonical append, promotion, and index projection this store performs carries
   * this identity into `withCurrentWriterAuthority`, so a store constructed by someone who is not
   * the published holder is refused at its first canonical mutation instead of laundering a
   * fabricated id. It is required precisely so no code path can omit it and fall back to one.
   */
  writerLeaseId: string
  /** Port calls lack a run ordinal; callers with run context should supply it. */
  sourceBuildOrdinal?: number
  sourceRunId?: string
  /** 2026-09-07, 418 D-07: queue entry identity stamped as producedBy.jobId. */
  sourceJobId?: string
  screenStates?: readonly ScreenState[]
  /** Resolved once at construction; only neutral immutable data reaches folds and projections. */
  resolveTrustPriors?: () => TrustPriorTable | undefined
  onPromotionOutcome?: (report: PromotionOutcomeReport) => void
  /** Fault-injection seam; production callers must omit it. */
  canaryAuthorityHooks?: CanaryAuthorityHooks
  /**
   * Joins the caller's own terminal work to the canary tail's held section. The drain's `done`
   * job-state write uses this so the append, the projection, and the lifecycle transition are one
   * indivisible section; implementations must use within-held write forms only.
   */
  onCanaryTailWithinCurrentAuthority?: () => void
  operations?: {
    /** Test/chaos seam; production always uses commitCurationDelta. */
    commitCurationDelta?: typeof commitCurationDelta
  }
}

export interface PromotionOutcomeReport {
  candidateId: RecordId
  promotionPath?: PromotionPath
  promotionHoldReason?: PromotionGateHoldReason
}

/**
 * @deprecated `recordCanaryOutcome` is implemented. The exported class remains only so code
 * compiled against the pre-380 package surface does not lose its named import.
 */
export class KnowledgeStoreNotImplementedError extends Error {
  readonly operation: 'recordCanaryOutcome'

  constructor(operation: 'recordCanaryOutcome', _retiredOwnerPhase?: 380) {
    super(`${operation} compatibility error is retired because the operation is implemented`)
    this.name = 'KnowledgeStoreNotImplementedError'
    this.operation = operation
  }
}

export type KnowledgePromotionErrorReason =
  | PromotionGateHoldReason
  | 'propose-only'
  | 'not-found'

/** Typed refusal for the evidence-gated promote port; callers never receive a force path. */
export class KnowledgePromotionError extends Error {
  readonly candidateId: RecordId
  readonly reason: KnowledgePromotionErrorReason

  constructor(candidateId: RecordId, reason: KnowledgePromotionErrorReason) {
    super(`knowledge promotion refused for ${candidateId}: ${reason}`)
    this.name = 'KnowledgePromotionError'
    this.candidateId = candidateId
    this.reason = reason
  }
}

export class KnowledgeCommitError extends Error {
  readonly outcome: CommitCurationOutcome

  constructor(outcome: CommitCurationOutcome) {
    super(`local knowledge commit did not complete: ${outcome.kind}`)
    this.name = 'KnowledgeCommitError'
    this.outcome = outcome
  }
}

/** Typed WR-02 refusal for procedure drafts that require evidence this port cannot carry. */
export class KnowledgeUnsupportedDeltaError extends Error {
  readonly deltaKind: Delta['kind']
  readonly reason: 'procedure-evidence-unsupported'

  constructor(deltaKind: Delta['kind']) {
    super(
      `local KnowledgePort cannot author ${deltaKind} procedure drafts: the public port carries no durable trajectory/capture evidence; use the evidence-bearing curation queue/drainer`,
    )
    this.name = 'KnowledgeUnsupportedDeltaError'
    this.deltaKind = deltaKind
    this.reason = 'procedure-evidence-unsupported'
  }
}

interface ResolvedTruth {
  id: RecordId
  bundle: LoadedBundle
  bundleDir: string
  product: string
  observedStatus: string
  observedOrdinal: number
}

function resolveTruth(knowledgeRoot: string, id: RecordId, priors?: TrustPriorTable): ResolvedTruth | undefined {
  let target: ReturnType<typeof resolveProductQualifiedBundleDir>
  try {
    target = resolveProductQualifiedBundleDir({ knowledgeRoot, recordId: id })
  } catch (error) {
    if (
      error instanceof BundleTargetResolutionError
      && error.reason === 'not-found'
    ) return undefined
    throw error
  }
  const loaded = loadBundle(target.dir)
  if (loaded.kind !== 'loaded' || loaded.bundle.manifest.id !== id) return undefined
  const trust = deriveBundleTrust(loaded.bundle, priors)
  return {
    id,
    bundle: loaded.bundle,
    bundleDir: target.dir,
    product: target.product,
    observedStatus: trust.status,
    observedOrdinal: trust.validity.closedAtOrdinal ?? trust.validity.openedAtOrdinal,
  }
}

function targetId(delta: Delta): RecordId | undefined {
  switch (delta.kind) {
    case 'Confirm':
    case 'Deprecate':
      return delta.targetId
    case 'Supersede':
      return delta.victimId
    case 'MintUnknown':
      return delta.conflict.recordIds[0]
    case 'Add':
    case 'Noop':
      return undefined
  }
}

function draft(delta: Delta): BundleDraft | undefined {
  if (delta.kind === 'Add') return delta.bundle
  if (delta.kind === 'Supersede') return delta.newBundle
  return undefined
}

/**
 * @internal The evidence token the port bridge stamps on a delta's committed event. Exported
 * only so the review writer can recognise an explicit change that already landed (432-06).
 */
export function syntheticEvidenceToken(delta: Delta): string {
  if (delta.kind === 'Confirm' || delta.kind === 'Supersede') return delta.evidenceToken
  return sha256hex(canonicalJson({ delta, source: 'knowledge-port' }))
}

function addressFields(
  config: CreateLocalKnowledgeStoreConfig,
  delta: Delta,
  target: ResolvedTruth | undefined,
  buildOrdinal: number,
): CurationCandidateAddressFields {
  const authored = draft(delta)
  const kind = authored?.kind ?? target?.bundle.frontmatter.kind ?? 'unknown'
  const subtype = authored?.subtype ?? target?.bundle.frontmatter.subtype
  const anchors = authored?.anchors
    ?? target?.bundle.frontmatter.anchors.map(({ raw }) => raw)
    ?? [{ t: 'error' as const, message: `unresolved knowledge-port ${delta.kind}` }]
  return buildCurationCandidateAddressFields({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: config.sourceRunId ?? 'knowledge-port',
    scope: delta.scope,
    buildOrdinal,
    executionContext: config.executionContext,
    kind,
    ...(kind === 'fact'
      ? { subtype: subtype ?? 'content' }
      : {}),
    anchors,
    summarySeed: authored?.summary ?? target?.bundle.summary ?? `KnowledgePort ${delta.kind}`,
    bodySeed: authored?.body ?? target?.bundle.body ?? canonicalJson(delta),
    distilledObservations: [],
    evidenceToken: syntheticEvidenceToken(delta),
    attributingObservationId: `knowledge-port:${sha256hex(canonicalJson(delta))}`,
    artifactInventory: [],
    emittedAt: '1970-01-01T00:00:00.000Z',
  })
}

function syntheticAuthorship(
  config: CreateLocalKnowledgeStoreConfig,
  delta: Delta,
): CurationAuthorship {
  return delta.authorship ?? {
    path: 'llm',
    model: { id: 'knowledge-port-bridge' },
    executionContext: config.executionContext,
  }
}

/** The one authority every canonical mutation in this file carries; never synthesized. */
function currentAuthority(
  config: CreateLocalKnowledgeStoreConfig,
): { leaseId: string; epoch: number } {
  return {
    leaseId: config.writerLeaseId,
    epoch: config.epoch ?? readCurrentEpoch(config.knowledgeRoot),
  }
}

/**
 * Bridge one port delta into the commit path's job shape — computing the claimed-candidate
 * ADDRESS and materializing NOTHING.
 *
 * WHY THE BRIDGE WRITES NOTHING (CR-02″). This function used to create the candidate's artifacts
 * directory and write its `payload.json` before returning (those two statements, and this file's
 * whole `node:fs` import with them, are gone — the corpus greps this file for a filesystem write
 * and expects to find none), and `commitWithProfile` calls it BEFORE `operation(...)` — which is
 * where `disposeDelta` runs the
 * §7.3.1 checks. So a delta the store REFUSES had already left a claimed curation candidate on
 * disk, seeded from `addressFields` with the cited record's own `summarySeed`, `anchors`,
 * `bodySeed` and `kind`. Nothing unwound it on the throw: `reconcileOnDrainStart` requeued that
 * directory under the next lease (`requeueClaimedWithinCurrentAuthority` takes every
 * `/^[0-9a-f]{64}$/` name with no provenance filter) and the curator re-authored the fact a
 * reviewer had just removed, one drain later, as `origin: 'agent'`.
 *
 * The repair is NOT an unwind. An unwind enumerates the artifacts today's bridge happens to
 * write, so the next check that throws from a new position leaks whatever the enumeration missed
 * — the same one-axis-out shape this phase has paid for repeatedly. Writing nothing is a
 * property of the path instead of a property of a cleanup: a thrown check at ANY position now
 * leaves no residue, because there was never anything to leave.
 *
 * WHAT MAKES IT SAFE — the port path has no on-disk consumer of the claimed form, each half
 * verified by reading:
 *   - disposition reads no `job.candidateDir` (441-53), and procedure drafts are refused by
 *     `commitWithProfile` BEFORE this function is called, pinned by knowledge-store.test.ts's
 *     "rejects before materializing any claimed candidate" case;
 *   - `addressFields` sets `artifactInventory: []`, so `commit.ts`'s `artifactInputs` maps over
 *     an empty list and `preCopyArtifacts` copies nothing;
 *   - every completed outcome ends in `markDone` → `writeJobState('done')` →
 *     `removeClaimedCandidate`, whose `rmSync(…, { force: true })` and `removeEmptyDir` are both
 *     no-ops on an absent directory.
 * The job keeps `candidateDir` / `payloadPath` / `artifactsDir` because `CommitCurationJob`'s
 * type requires them and the drain's own run-sourced candidates — which DO exist on disk — flow
 * through the same shape. Here they name an address, not a file.
 *
 * THE MECHANISM THAT REDS THIS. The claim above is not prose: reintroducing the two write
 * statements reds `apply-review.test.ts`'s "a refused accept leaves the WHOLE knowledge root
 * byte-identical (CR-02″)" with the leaked `memory/queue/claimed/…/payload.json` printed in the
 * diff, and reds its sibling adoption case with `jobsRequeued` back at 1. Probe m1 of 387-17 is
 * exactly that mutation, run and recorded.
 */
function bridgeDelta(
  config: CreateLocalKnowledgeStoreConfig,
  delta: Delta,
  priors?: TrustPriorTable,
): { job: CommitCurationJob; checkpoint: AuthoredDeltaCheckpoint } {
  const neighbors = delta.citedIds
    .map((id) => resolveTruth(config.knowledgeRoot, id, priors))
    .filter((truth): truth is ResolvedTruth => truth !== undefined)
  const target = targetId(delta)
  const targetTruth = target === undefined
    ? undefined
    : neighbors.find(({ id }) => id === target) ?? resolveTruth(config.knowledgeRoot, target, priors)
  const observedOrdinals = [...neighbors, ...(targetTruth === undefined ? [] : [targetTruth])]
    .map(({ observedOrdinal }) => observedOrdinal)
  const buildOrdinal = config.sourceBuildOrdinal
    ?? (observedOrdinals.length === 0 ? 0 : Math.max(...observedOrdinals) + 1)
  const fields = addressFields(config, delta, targetTruth, buildOrdinal)
  const candidateId = candidateContentAddress(fields)
  const leaseId = config.writerLeaseId
  const candidateDir = claimedCandidateDir(config.knowledgeRoot, leaseId, candidateId)
  const artifactsDir = join(candidateDir, 'artifacts')
  const payload: CurationCandidatePayload = { candidateId, ...fields }

  const authorship = syntheticAuthorship(config, delta)
  return {
    job: {
      kind: 'claimed',
      candidateId,
      leaseId,
      payload,
      candidateDir,
      payloadPath: join(candidateDir, 'payload.json'),
      artifactsDir,
      targetProducts: Object.fromEntries(
        [...neighbors, ...(targetTruth === undefined ? [] : [targetTruth])]
          .map((truth) => [truth.id, truth.product]),
      ),
      ...(config.screenStates === undefined ? {} : { screenStates: config.screenStates }),
    },
    checkpoint: {
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      delta,
      neighborIds: neighbors.map(({ id }) => id),
      preconditions: neighbors.map(({ id, observedStatus, observedOrdinal }) => ({
        recordId: id,
        observedStatus,
        observedOrdinal,
      })),
      authorship,
    },
  }
}

function completed(outcome: CommitCurationOutcome): boolean {
  return outcome.kind === 'applied'
    || outcome.kind === 'downgraded'
    || outcome.kind === 'converted-confirm'
    || outcome.kind === 'noop'
}

function promotionBuildOrdinal(
  config: CreateLocalKnowledgeStoreConfig,
  bundle: LoadedBundle,
): number {
  return config.sourceBuildOrdinal ?? Math.max(
    bundle.frontmatter.createdAtOrdinal,
    ...bundle.events.map(({ buildOrdinal }) => buildOrdinal),
  )
}

function expectedPromotionHold(error: unknown): error is KnowledgePromotionError & {
  reason: PromotionGateHoldReason | 'propose-only'
} {
  return error instanceof KnowledgePromotionError && error.reason !== 'not-found'
}

function unreachableCanaryOutcome(outcome: never): never {
  throw new TypeError(`unsupported canary outcome: ${canonicalJson(outcome)}`)
}

/**
 * Who is asking for this write. `automatic` is the curator and the agent port, whose authority
 * follows the run's execution context (432 D-08: ci/cloud stay proposed). `explicit` is a
 * person's mark, accept, reject or forget, which is authority in every context (D-04/D-05).
 */
type WriteAuthority = 'automatic' | 'explicit'

const EXPLICIT_PROFILE: DispositionProfile = Object.freeze({ mode: 'drain-to-active' })

/**
 * The one place write authority becomes a disposition profile. Explicit authority skips only the
 * automatic propose-only downgrade: the store still records the actual execution context, and
 * delta validation and every promotion gate apply unchanged.
 */
function dispositionProfileFor(
  config: CreateLocalKnowledgeStoreConfig,
  authority: WriteAuthority,
): DispositionProfile {
  return authority === 'explicit' ? EXPLICIT_PROFILE : resolveDispositionProfile(config.executionContext)
}

/** The write face an explicit review needs: commit, gated promotion and gate receipts only. */
export type ExplicitReviewStore = Pick<KnowledgePort, 'commit' | 'promote' | 'recordGateReceipt'>

/**
 * Realizes the agent write port over the canonical mutation path. D-08 propose-only is a
 * disposition profile inside commitCurationDelta, never a second mutation path. Because the port
 * carries bare deltas, this bridge materializes the smallest queue/checkpoint envelope and resolves
 * cited neighbor truth from canonical bundles before entering disposition.
 */
export function createLocalKnowledgeStore(
  config: CreateLocalKnowledgeStoreConfig,
): KnowledgePort {
  return buildLocalKnowledgeStore(config, 'automatic')
}

/**
 * @internal The narrow explicit-authority entry for the review writer (432-06). Not on the
 * package barrel: only `applyReview` / `applyExplicitReview` construct it, under the caller's
 * writer lease. Canary and proposal-only doors are deliberately absent from its face.
 */
export function createExplicitReviewStore(
  config: CreateLocalKnowledgeStoreConfig,
): ExplicitReviewStore {
  const { commit, promote, recordGateReceipt } = buildLocalKnowledgeStore(config, 'explicit')
  return { commit, promote, recordGateReceipt }
}

function buildLocalKnowledgeStore(
  config: CreateLocalKnowledgeStoreConfig,
  authority: WriteAuthority,
): KnowledgePort {
  const priors = snapshotTrustPriors(config.resolveTrustPriors?.())
  const operation = config.operations?.commitCurationDelta ?? commitCurationDelta

  function bundleStoreConfig(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot: config.knowledgeRoot,
      productKey,
      commitArtifacts: 'none',
      writerLeaseId: config.writerLeaseId,
    }
  }

  function checkedAppend(candidateId: RecordId, appended: AppendOutcome): GateReceiptRecordOutcome {
    if (appended.kind === 'not-found') throw new KnowledgePromotionError(candidateId, appended.kind)
    return appended
  }

  function reportHold(error: unknown): void {
    if (expectedPromotionHold(error) && error.reason !== 'propose-only') {
      config.onPromotionOutcome?.({ candidateId: error.candidateId, promotionHoldReason: error.reason })
    }
  }

  /**
   * @internal The caller must already hold withCurrentWriterAuthority for this root. Every
   * append and projection below is irreversible canonical work, so the whole gate-and-write
   * body lives in one section rather than re-entering the fence per unit.
   */
  function promoteWithinCurrentAuthority(
    candidateId: RecordId,
    profile: DispositionProfile = dispositionProfileFor(config, 'automatic'),
  ): PromotionOutcome {
    /**
     * D-17: later callers add evidence first, then ask this same gate to judge it. The
     * execution posture is resolved at call time; canary evidence is always automatic, and
     * only `promote` passes the store's own authority.
     */
    if (profile.mode === 'propose-only') {
      throw new KnowledgePromotionError(candidateId, 'propose-only')
    }

    const resolved = resolveTruth(config.knowledgeRoot, candidateId, priors)
    if (resolved === undefined) {
      throw new KnowledgePromotionError(candidateId, 'not-found')
    }
    const appendConfig = bundleStoreConfig(resolved.product)
    if (resolved.observedStatus === 'active') {
      /**
       * CR-01: the active fast path is a gate re-validation, never a bypass. A crash
       * between a rollback's confirmation retraction and its Plan-23 promotion cascade
       * leaves canonical active-with-zero-support until replay; attesting success over
       * that stale authority would launder a rolled-back promotion. The same pure gate
       * (D-17) is re-evaluated over the promoted-set-aside status: the status the record
       * would hold if its promoted authority were set aside.
       */
      const gateInput = assemblePromotionGateInput({
        knowledgeRoot: config.knowledgeRoot,
        bundleDir: resolved.bundleDir,
        bundle: resolved.bundle,
        ...(priors === undefined ? {} : { priors }),
      })
      const setAside = foldBundleTrust(
        survivingOutcomeEvents(resolved.bundle.events)
          .filter(({ type }) => type !== 'promoted'),
        {
          originClass: resolved.bundle.frontmatter.originClass,
          evidenceIncomplete: resolved.bundle.manifest.evidenceIncomplete,
          createdAtOrdinal: resolved.bundle.frontmatter.createdAtOrdinal,
        },
        priors,
      )
      // 416-DOOR: door-1-2 revalidation
      const revalidated = evaluatePromotionGate({ ...gateInput, status: setAside.status })
      if (revalidated.verdict === 'promote') {
        // Receipt strength can grow without granting a second lifecycle authority event.
        const onDisk = strongestPromotionPath(readGateReceipts(resolved.bundleDir, candidateId) ?? [])
        if (onDisk === undefined || (revalidated.promotionPath !== onDisk
          && strongerPromotionPath(revalidated.promotionPath, onDisk) === revalidated.promotionPath)) {
          checkedAppend(candidateId, appendPromotionReceipt(appendConfig, candidateId, {
            schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId,
            promotionPath: revalidated.promotionPath,
            citedReceiptDigests: revalidated.citedReceiptDigests,
            producedAtOrdinal: promotionBuildOrdinal(config, resolved.bundle),
            producedBy: { opId: 'promote' },
          }))
        }
        // Still authorized: heal append-before-projection retries.
        applyIndexDeltaForBundleWithinCurrentAuthority({
          ...(priors === undefined ? {} : { priors }),
          knowledgeRoot: config.knowledgeRoot,
          bundleId: candidateId,
          product: resolved.product,
        })
        const promotionPath = strongestPromotionPath(readGateReceipts(resolved.bundleDir, candidateId) ?? [])
        config.onPromotionOutcome?.({ candidateId, ...(promotionPath === undefined ? {} : { promotionPath }) })
        return { kind: 'already-active', ...(promotionPath === undefined ? {} : { promotionPath }) }
      }
      // Stale authority: append-only retraction of every surviving promoted event under a
      // deterministic replay-safe identity, then re-project and refuse with the gate's
      // hold reason. History is never rewritten; replayed heals dedup to no-ops.
      const survivingPromoted = survivingOutcomeEvents(resolved.bundle.events)
        .filter(({ type }) => type === 'promoted')
      const healReceiptId = `promote-heal:${candidateId}`
      for (const promoted of survivingPromoted) {
        const appended = appendOutcomeEvent(appendConfig, candidateId, {
          type: 'retracted',
          evidenceToken: asEvidenceToken(sha256hex(canonicalJson({
            healedPromotedEventKey: eventDedupKey(promoted),
            candidateId,
          }))),
          curationJobId: healReceiptId,
          buildOrdinal: promotionBuildOrdinal(config, resolved.bundle),
          retractsEvidenceToken: promoted.evidenceToken,
          retractsCurationJobId: promoted.curationJobId,
          rollbackReceiptId: healReceiptId,
        })
        if (appended.kind === 'not-found') {
          throw new KnowledgePromotionError(candidateId, appended.kind)
        }
      }
      applyIndexDeltaForBundleWithinCurrentAuthority({
        ...(priors === undefined ? {} : { priors }),
        knowledgeRoot: config.knowledgeRoot,
        bundleId: candidateId,
        product: resolved.product,
      })
      throw new KnowledgePromotionError(candidateId, revalidated.reason)
    }

    // 416-DOOR: door-1-2 gate
    const gate = evaluatePromotionGate(assemblePromotionGateInput({
      knowledgeRoot: config.knowledgeRoot,
      bundleDir: resolved.bundleDir,
      bundle: resolved.bundle,
      ...(priors === undefined ? {} : { priors }),
    }))
    if (gate.verdict === 'hold') {
      throw new KnowledgePromotionError(candidateId, gate.reason)
    }
    // Keep v51's first-promotion identity, but do not reuse authority that the
    // append-only fold has retracted. A recovery episode is keyed by the durable
    // retractions of earlier promotions, so retries share an identity and a later
    // hold/recovery gets a new one. Ordinary path upgrades still append no event.
    const promotedKeys = new Set(resolved.bundle.events
      .filter(event => event.type === 'promoted').map(eventDedupKey))
    const recoveryBoundary = [...new Set(resolved.bundle.events.flatMap(event =>
      event.type === 'retracted'
        && promotedKeys.has(eventDedupKey({ ...event,
          evidenceToken: event.retractsEvidenceToken, curationJobId: event.retractsCurationJobId }))
        ? [eventDedupKey(event)] : [],
    ))].sort()
    const promotionSource = recoveryBoundary.length === 0 ? candidateId
      : canonicalJson({ candidateId, retractedPromotionEvents: recoveryBoundary })
    const appended = appendOutcomeEvent(appendConfig, candidateId, {
      // 416-DOOR: door-1-2 promoted
      type: 'promoted',
      evidenceToken: derivePromotedEvidenceToken(promotionSource),
      curationJobId: `promote:${candidateId}`,
      buildOrdinal: promotionBuildOrdinal(config, resolved.bundle),
    })
    if (appended.kind === 'not-found') {
      throw new KnowledgePromotionError(candidateId, appended.kind)
    }
    const receipt = appendPromotionReceipt(appendConfig, candidateId, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
      kind: 'promotion',
      candidateId,
      promotionPath: gate.promotionPath,
      citedReceiptDigests: gate.citedReceiptDigests,
      producedAtOrdinal: promotionBuildOrdinal(config, resolved.bundle),
      producedBy: { opId: 'promote' },
    })
    if (receipt.kind === 'not-found') throw new KnowledgePromotionError(candidateId, receipt.kind)
    applyIndexDeltaForBundleWithinCurrentAuthority({
      ...(priors === undefined ? {} : { priors }),
      knowledgeRoot: config.knowledgeRoot,
      bundleId: candidateId,
      product: resolved.product,
    })
    config.onPromotionOutcome?.({ candidateId, promotionPath: gate.promotionPath })
    return { kind: 'promoted', promotionPath: gate.promotionPath, citedReceiptDigests: gate.citedReceiptDigests }
  }

  // 419-COMMIT-DOOR: curator profile pipeline
  async function commitWithProfile(
    deltas: Delta[],
    profile: DispositionProfile,
  ): Promise<void> {
    const drainState: CommitCurationDependencies['drainState'] = {
      supersedesSeenByAnchorKey: new Map(),
    }
    for (const delta of deltas) {
      /**
       * WR-02 / D-02: this bridge intentionally has no durable procedure observations or
       * capture artifacts. Disposition would therefore return a guaranteed procedure Noop,
       * which completed() would otherwise launder into a resolved void. Reject before
       * bridgeDelta materializes a claimed queue envelope; evidence carriage remains M4 scope.
       */
      if (draft(delta)?.kind === 'procedure') {
        throw new KnowledgeUnsupportedDeltaError(delta.kind)
      }
      const { job, checkpoint } = bridgeDelta(config, delta, priors)
      const outcome = operation(
        {
          knowledgeRoot: config.knowledgeRoot,
          epoch: currentAuthority(config).epoch,
          profile,
          drainState,
          ...(priors === undefined ? {} : { priors }),
        },
        job,
        checkpoint,
      )
      if (!completed(outcome)) throw new KnowledgeCommitError(outcome)
    }
  }

  const store: KnowledgePort = {
    proposeDeltas(deltas: Delta[]): Promise<void> {
      // 419-COMMIT-DOOR: curator propose-only
      return commitWithProfile(deltas, { mode: 'propose-only' })
    },
    commit(deltas: Delta[]): Promise<void> {
      // 419-COMMIT-DOOR: curator disposition
      return commitWithProfile(deltas, dispositionProfileFor(config, authority))
    },
    async recordCanaryOutcome(outcome: CanaryOutcome): Promise<void> {
      const resolved = resolveTruth(config.knowledgeRoot, outcome.candidateId, priors)
      if (resolved === undefined) {
        throw new KnowledgePromotionError(outcome.candidateId, 'not-found')
      }

      const observationId = canaryOutcomeObservationId(outcome)
      const evidenceToken = deriveEvidenceToken({
        attributingObservationId: observationId,
        anchor: outcome.exercisedAnchor,
        buildOrdinal: outcome.buildOrdinal,
      })

      switch (outcome.runOutcome) {
        case 'positive': {
          // The Confirm is a deterministic system delta; the existing promotion gate then
          // re-evaluates the candidate.
          const confirm: Extract<Delta, { kind: 'Confirm' }> = {
            kind: 'Confirm',
            origin: 'system',
            scope: resolved.bundle.frontmatter.scope,
            citedIds: [outcome.candidateId],
            targetId: outcome.candidateId,
            evidenceToken,
            authorship: {
              path: 'deterministic-fallback',
              executionContext: config.executionContext,
            },
          }
          // 419-COMMIT-DOOR: curator canary confirm
          await store.commit([confirm])
          /**
           * The Confirm has its own fenced commit pipeline; the promotion tail that follows it
           * is a second, separate held section which the caller's terminal job-state write
           * joins. A takeover between the two leaves the durable Confirm as valid replay
           * evidence, which is exactly what lets the successor's drain finish the candidate.
           */
          config.canaryAuthorityHooks?.beforePromotionAppend?.()
          withCurrentWriterAuthority(config.knowledgeRoot, currentAuthority(config), () => {
            try {
              promoteWithinCurrentAuthority(outcome.candidateId)
            } catch (error) {
              // A gate hold or propose-only posture means "not yet". The durable Confirm remains
              // valid evidence and must not turn a crash replay into a permanently failing job.
              if (!expectedPromotionHold(error)) throw error
              reportHold(error)
            }
            config.onCanaryTailWithinCurrentAuthority?.()
          })
          return
        }
        case 'negative': {
          // A single negative sample is a contradiction in the canonical outcome log, folded by
          // the same deterministic trust and status rules as every other outcome event.
          const appendConfig = bundleStoreConfig(resolved.product)
          /**
           * Contradicted evidence is trust/status currency, so the append, the projection it
           * implies, and the caller's terminal job-state write are ONE held section. A takeover
           * completed at the barrier below therefore finds nothing of this writer landed, and a
           * contender arriving after entry is told who holds the tail instead.
           */
          config.canaryAuthorityHooks?.beforeNegativeAppend?.()
          withCurrentWriterAuthority(config.knowledgeRoot, currentAuthority(config), () => {
            const appended = appendOutcomeEvent(appendConfig, outcome.candidateId, {
              type: 'contradicted',
              evidenceToken,
              curationJobId: observationId,
              buildOrdinal: outcome.buildOrdinal,
              observationOrdinal: outcome.stepIndex,
              observationId,
              origin: 'agent-verified',
            })
            if (appended.kind === 'not-found') {
              throw new KnowledgePromotionError(outcome.candidateId, appended.kind)
            }
            config.canaryAuthorityHooks?.beforeIndexProjection?.()
            applyIndexDeltaForBundleWithinCurrentAuthority({
              ...(priors === undefined ? {} : { priors }),
              knowledgeRoot: config.knowledgeRoot,
              bundleId: outcome.candidateId,
              product: resolved.product,
            })
            config.onCanaryTailWithinCurrentAuthority?.()
          })
          return
        }
        default:
          return unreachableCanaryOutcome(outcome.runOutcome)
      }
    },
    async promote(candidateId: RecordId, receipts?: readonly GateReceipt[]): Promise<PromotionOutcome> {
      return withCurrentWriterAuthority(config.knowledgeRoot, currentAuthority(config), () => {
        const profile = dispositionProfileFor(config, authority)
        if (profile.mode === 'propose-only') {
          throw new KnowledgePromotionError(candidateId, 'propose-only')
        }
        const resolved = resolveTruth(config.knowledgeRoot, candidateId, priors)
        if (resolved === undefined) throw new KnowledgePromotionError(candidateId, 'not-found')
        // Validate the entire batch before its first append; a later malformed item must not
        // leave earlier caller evidence durable. Appenders independently repeat these checks.
        const validated = (receipts ?? []).map(receipt => {
          const parsed = GateReceiptSchema.parse(receipt)
          if (parsed.candidateId !== candidateId) throw new TypeError('foreign candidateId')
          if (receiptDigestOf(parsed) !== parsed.receiptDigest) throw new TypeError('receiptDigest mismatch')
          return parsed
        })
        const appendConfig = bundleStoreConfig(resolved.product)
        for (const receipt of validated) checkedAppend(candidateId, appendGateReceipt(appendConfig, candidateId, receipt))
        try {
          return promoteWithinCurrentAuthority(candidateId, profile)
        } catch (error) {
          reportHold(error)
          throw error
        }
      })
    },
    async recordGateReceipt(receipt: GateReceipt): Promise<GateReceiptRecordOutcome> {
      return withCurrentWriterAuthority(config.knowledgeRoot, currentAuthority(config), () => {
        const candidateId = asRecordId(receipt.candidateId)
        const resolved = resolveTruth(config.knowledgeRoot, candidateId, priors)
        if (resolved === undefined) throw new KnowledgePromotionError(candidateId, 'not-found')
        return checkedAppend(candidateId, appendGateReceipt(bundleStoreConfig(resolved.product), candidateId, receipt))
      })
    },
  }
  return store
}
