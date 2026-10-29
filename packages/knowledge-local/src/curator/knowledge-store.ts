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

// Entry barriers fire outside the held section, `beforeIndexProjection` inside it.
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
  // Required, so a store built by a non-holder is refused at its first canonical mutation.
  writerLeaseId: string
  /** Port calls lack a run ordinal; callers with run context should supply it. */
  sourceBuildOrdinal?: number
  sourceRunId?: string
  // Queue entry identity stamped as `producedBy.jobId`.
  sourceJobId?: string
  screenStates?: readonly ScreenState[]
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

/** @deprecated `recordCanaryOutcome` is implemented; kept so older named imports resolve. */
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

// Typed refusal for procedure drafts that need evidence this port cannot carry.
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

function resolveTruth(knowledgeRoot: string, id: RecordId): ResolvedTruth | undefined {
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
  const trust = deriveBundleTrust(loaded.bundle)
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
 * The token the port bridge stamps; exported so the review writer can spot a landed change.
 * @internal
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

// Computes the claimed-candidate address and writes nothing, so a refused delta leaves no residue.
function bridgeDelta(
  config: CreateLocalKnowledgeStoreConfig,
  delta: Delta,
): { job: CommitCurationJob; checkpoint: AuthoredDeltaCheckpoint } {
  const neighbors = delta.citedIds
    .map((id) => resolveTruth(config.knowledgeRoot, id))
    .filter((truth): truth is ResolvedTruth => truth !== undefined)
  const target = targetId(delta)
  const targetTruth = target === undefined
    ? undefined
    : neighbors.find(({ id }) => id === target) ?? resolveTruth(config.knowledgeRoot, target)
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

// `automatic` follows the run context (CI and cloud propose); `explicit` is a person's review.
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

// Propose-only is a disposition profile inside `commitCurationDelta`, never a second mutation path.
export function createLocalKnowledgeStore(
  config: CreateLocalKnowledgeStoreConfig,
): KnowledgePort {
  return buildLocalKnowledgeStore(config, 'automatic')
}

/**
 * Explicit-authority entry for the review writer only; canary and proposal-only doors are absent.
 * @internal
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
  const operation = config.operations?.commitCurationDelta ?? commitCurationDelta

  function bundleStoreConfig(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot: config.knowledgeRoot,
      productKey,
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
    // The posture resolves at call time; canary evidence is always automatic.
    if (profile.mode === 'propose-only') {
      throw new KnowledgePromotionError(candidateId, 'propose-only')
    }

    const resolved = resolveTruth(config.knowledgeRoot, candidateId)
    if (resolved === undefined) {
      throw new KnowledgePromotionError(candidateId, 'not-found')
    }
    const appendConfig = bundleStoreConfig(resolved.product)
    if (resolved.observedStatus === 'active') {
      // Re-validates the gate, not trusting `active`: a crashed rollback can leave zero support.
      const gateInput = assemblePromotionGateInput({
        knowledgeRoot: config.knowledgeRoot,
        bundleDir: resolved.bundleDir,
        bundle: resolved.bundle,
      })
      const setAside = foldBundleTrust(
        survivingOutcomeEvents(resolved.bundle.events)
          .filter(({ type }) => type !== 'promoted'),
        {
          originClass: resolved.bundle.frontmatter.originClass,
          evidenceIncomplete: resolved.bundle.manifest.evidenceIncomplete,
          createdAtOrdinal: resolved.bundle.frontmatter.createdAtOrdinal,
        },
      )
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
        knowledgeRoot: config.knowledgeRoot,
        bundleId: candidateId,
        product: resolved.product,
      })
      throw new KnowledgePromotionError(candidateId, revalidated.reason)
    }

    const gate = evaluatePromotionGate(assemblePromotionGateInput({
      knowledgeRoot: config.knowledgeRoot,
      bundleDir: resolved.bundleDir,
      bundle: resolved.bundle,
    }))
    if (gate.verdict === 'hold') {
      throw new KnowledgePromotionError(candidateId, gate.reason)
    }
    // Reuse the first-promotion identity, but not authority the append-only fold has retracted.
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
      knowledgeRoot: config.knowledgeRoot,
      bundleId: candidateId,
      product: resolved.product,
    })
    config.onPromotionOutcome?.({ candidateId, promotionPath: gate.promotionPath })
    return { kind: 'promoted', promotionPath: gate.promotionPath, citedReceiptDigests: gate.citedReceiptDigests }
  }

  async function commitWithProfile(
    deltas: Delta[],
    profile: DispositionProfile,
  ): Promise<void> {
    const drainState: CommitCurationDependencies['drainState'] = {
      supersedesSeenByAnchorKey: new Map(),
    }
    for (const delta of deltas) {
      // This bridge carries no procedure evidence, so a procedure is refused up front.
      if (draft(delta)?.kind === 'procedure') {
        throw new KnowledgeUnsupportedDeltaError(delta.kind)
      }
      const { job, checkpoint } = bridgeDelta(config, delta)
      const outcome = operation(
        {
          knowledgeRoot: config.knowledgeRoot,
          epoch: currentAuthority(config).epoch,
          profile,
          drainState,
        },
        job,
        checkpoint,
      )
      if (!completed(outcome)) throw new KnowledgeCommitError(outcome)
    }
  }

  const store: KnowledgePort = {
    proposeDeltas(deltas: Delta[]): Promise<void> {
      return commitWithProfile(deltas, { mode: 'propose-only' })
    },
    commit(deltas: Delta[]): Promise<void> {
      return commitWithProfile(deltas, dispositionProfileFor(config, authority))
    },
    async recordCanaryOutcome(outcome: CanaryOutcome): Promise<void> {
      const resolved = resolveTruth(config.knowledgeRoot, outcome.candidateId)
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
        const resolved = resolveTruth(config.knowledgeRoot, candidateId)
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
        const resolved = resolveTruth(config.knowledgeRoot, candidateId)
        if (resolved === undefined) throw new KnowledgePromotionError(candidateId, 'not-found')
        return checkedAppend(candidateId, appendGateReceipt(bundleStoreConfig(resolved.product), candidateId, receipt))
      })
    },
  }
  return store
}
