import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  asEvidenceToken,
  canonicalJson,
  computeStepSequenceSignature,
  evaluatePromotionGate,
  GATE_RECEIPT_SCHEMA_VERSION,
  parseProcedureBody,
  procedureStepKeys,
  sha256hex,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleDiscriminant,
  BundleDraft,
  BundleRelation,
  Delta,
  EvidenceToken,
  PromotionGateHoldReason,
  PromotionPath,
  RecordId,
  ScreenState,
} from '@vostride/agent-qa-schema'

import { copyArtifacts } from '../artifact-copy.js'
import type { ArtifactCopyInput, ArtifactCopyResult } from '../artifact-copy.js'
import {
  appendMeasurementObservation,
  appendOutcomeEvent,
  appendOutcomeEventWithEnrichment,
  appendPromotionReceipt,
  appendRelation,
  writeMeasurementBaseline,
} from '../bundle-append.js'
import { loadBundle, readMeasurements } from '../bundle-read.js'
import type { LoadedBundle } from '../bundle-read.js'
import { renderBundleParts } from '../bundle-parts.js'
import type { RenderBundlePartsInput } from '../bundle-parts.js'
import {
  discardStagedBundle,
  finalizeStagedBundle,
  stageBundle,
} from '../bundle-publish.js'
import type {
  BundleStoreConfig,
  PublishBundleInput,
  PublishBundleOutcome,
  StageBundleOutcome,
} from '../bundle-publish.js'
import {
  BundleTargetResolutionError,
  resolveProductQualifiedBundleDir,
  type ProductQualifiedBundleDir,
} from '../bundle-scan.js'
import {
  projectBundleIndexRow,
  projectBundleIndexRowWithinCurrentAuthority,
} from '../index-rebuild.js'
import {
  COMMIT_INTENT_SCHEMA_VERSION,
  clearCommitIntent,
  writeCommitIntent,
} from '../journal/intent-journal.js'
import {
  isCurationEffectCommitted, receiptForEffect, writeCurationEffectReceiptWithinCurrentAuthority,
  type CurationEffect, type CurationObservation,
} from '../journal/curation-effect-receipt.js'
import {
  assertEpochCurrent,
  readCurrentEpoch,
  withCurrentWriterAuthority,
  WriterAuthorityLostError,
} from '../lease/writer-lease.js'
import { assemblePromotionGateInput } from '../promotion-gate-input.js'
import type { ClaimedCurationJob } from '../queue/curation-queue.js'
import {
  writeJobState,
  writeJobStateWithinCurrentAuthority,
} from '../queue/job-state.js'
import { widenAuthoredDeltaCheckpoint } from './author-contract.js'
import type { AuthoredDeltaCheckpoint, DispositionProfile } from './author-contract.js'
import { disposeDelta, originalDispositionDelta } from './disposition.js'
import type {
  DispositionDrainState,
  FirstSeenRegistration,
  RelationIntent,
  UnknownMintIntent,
  UnknownResolutionIntent,
} from './disposition.js'

export { assemblePromotionGateInput } from '../promotion-gate-input.js'

type CheckpointDraft = BundleDraft & { needsEnrichment?: true }

export interface CommitCurationJob extends ClaimedCurationJob {
  screenStates?: readonly ScreenState[]
  /** Product authority resolved with the checkpoint; absent ids must be globally unique. */
  targetProducts?: Readonly<Record<string, string>>
}

export interface CommitCurationDependencies {
  knowledgeRoot: string
  epoch: number
  profile: DispositionProfile
  drainState: DispositionDrainState
  /**
   * Multi-delta disposal (D-02): when set, terminal paths skip queue completion so the
   * claimed candidate directory stays available for the checkpoint's remaining deltas.
   * The drain leaves it unset on the final delta, which completes the job as before.
   */
  deferCompletion?: true
  hooks?: {
    /**
     * Test/chaos seam after every pre-staging write and immediately before the commit tail
     * enters its current-writer-authority section. Nothing durable and reader-relevant to this
     * candidate has been published yet when it fires.
     */
    beforeCommitAuthorityEntry?: () => void
    /** Test/chaos seam immediately after the durable intent rename. */
    afterIntentWritten?: () => void
    /** Test/chaos seam while the complete bundle is staged but still reader-invisible. */
    beforePublishRename?: () => void
    /** Test/chaos seam after lock-held authority comparison and before finalize. */
    afterFinalAuthorityCompare?: () => void
    /** Test-only bounded-takeover override; production uses the pinned lock deadline. */
    mutationLockTakeoverMs?: number
    /** Test/chaos seam after each durable mutable-file replacement. */
    afterMutableReplacement?: (targetRelPath: string) => void
    /** Test/chaos seam after a fresh bundle publish and before its index projection. */
    afterBundlePublished?: (bundleId: RecordId) => void
    /** Test/chaos seam after the index transaction and before intent removal. */
    afterIndexApplied?: (bundleId: RecordId) => void
    /** Test/chaos seams around the durable observation/cleanup boundary. */
    afterEffectReceiptsWritten?: () => void
    afterIntentCleared?: () => void
  }
  operations?: {
    /** Test/chaos seam; production always uses the canonical publisher. */
    publishBundle?: (
      config: BundleStoreConfig,
      input: PublishBundleInput,
    ) => PublishBundleOutcome
  }
}

interface CommittedBundleResult {
  bundleId: RecordId
  bundleDir: string
  deltaKind: Delta['kind']
  /** D-16 exception-bucket observability; absent when the gate promotes or never runs. */
  promotionHoldReason?: PromotionGateHoldReason
  promotionPath?: PromotionPath
}

/**
 * 381-47 (F-381-45-1): WHY a delta-noop disposition had nothing to apply. `authored-noop`
 * = a capable-model author deliberately emitted a Noop delta; the `fallback-*` members
 * name WHICH author fallback defeated extraction (the §7.9 one-element procedure Noop).
 * Benign noop reasons (evidence-token dedup, disposition rejects) never carry a cause.
 */
export type EmptyDeltaCause =
  | 'authored-noop'
  | 'fallback-malformed'
  | 'fallback-no-model'
  | 'fallback-token-budget'
  | 'fallback-model-error'

export type CommitCurationOutcome =
  | ({ kind: 'applied' } & CommittedBundleResult)
  | ({ kind: 'downgraded'; reason: string; original: Delta } & CommittedBundleResult)
  | ({ kind: 'converted-confirm' } & CommittedBundleResult)
  | { kind: 'abandoned-stale-epoch'; observedEpoch: number }
  | {
      kind: 'failed'
      reason: 'identity-collision' | 'append-failed'
      collisionReason?: Extract<
        PublishBundleOutcome,
        { kind: 'identity-collision' }
      >['reason']
    }
  | { kind: 'noop'; reason: string; emptyDeltaCause?: EmptyDeltaCause }
  | { kind: 'requeue-resynthesis'; reason: string }

export interface ApplyIndexDeltaForBundleInput {
  knowledgeRoot: string
  bundleId: string
  product?: string
}

/** Shared Plan 378-10 projection authority used by commit and journal reconciliation. */
export function applyIndexDeltaForBundle(input: ApplyIndexDeltaForBundleInput): void {
  projectBundleIndexRow(input)
}

/** @internal The caller must already hold withCurrentWriterAuthority for this root. */
export function applyIndexDeltaForBundleWithinCurrentAuthority(
  input: ApplyIndexDeltaForBundleInput,
): void {
  projectBundleIndexRowWithinCurrentAuthority(input)
}

/** Recovery alias deliberately delegates to the same projection unit as the live tail. */
export function deriveIndexRowFromBundle(input: ApplyIndexDeltaForBundleInput): void {
  projectBundleIndexRow(input)
}

/** Plan 379-06's replay-safe promoted-token composition, shared by both seams. */
export function derivePromotedEvidenceToken(sourceToken: string): EvidenceToken {
  return asEvidenceToken(
    sha256hex(canonicalJson({ token: sourceToken, event: 'promoted' })),
  )
}

function staleEpoch(
  deps: CommitCurationDependencies,
): Extract<CommitCurationOutcome, { kind: 'abandoned-stale-epoch' }> | undefined {
  const current = assertEpochCurrent({
    knowledgeRoot: deps.knowledgeRoot,
    epoch: deps.epoch,
  })
  return current.current
    ? undefined
    : { kind: 'abandoned-stale-epoch', observedEpoch: current.observedEpoch }
}

function originClass(delta: Delta): RenderBundlePartsInput['originClass'] {
  switch (delta.origin) {
    case 'user':
      return 'user'
    case 'import':
      return 'import'
    case 'agent':
    case 'system':
      return 'agent-verified'
  }
}

function elementRef(anchors: readonly Anchor[]): { role: string; name: string } {
  const element = anchors.find(
    (anchor): anchor is Extract<Anchor, { t: 'el' }> => anchor.t === 'el',
  )
  if (element !== undefined) return { role: element.role, name: element.name }
  const primary = anchors[0]!
  return { role: primary.t, name: canonicalJson(primary) }
}

function discriminant(
  draft: BundleDraft,
  delta: Delta,
  structuralProcedureStepKeys: readonly string[],
): BundleDiscriminant {
  switch (draft.kind) {
    case 'fact': {
      if (draft.subtype === undefined) throw new TypeError('fact commit requires a subtype')
      if (draft.subtype === 'measurement') {
        return {
          kind: 'fact',
          subtype: 'measurement',
          // A superseding validity window keeps the same anchor-level supersession key while its
          // code-derived evidence token gives the replacement a distinct, replay-stable identity.
          metricKey: canonicalJson({
            anchors: draft.anchors,
            ...(delta.kind === 'Supersede'
              ? { validityWindowEvidenceToken: delta.evidenceToken }
              : {}),
          }),
        }
      }
      return { kind: 'fact', subtype: draft.subtype, elementRef: elementRef(draft.anchors),
        // Same-anchor corrections replace immutable authored content. Give that actual
        // validity-window generation its evidence identity, as measurements already do;
        // Add and historical identities remain unchanged and prose never enters the key.
        ...(delta.kind === 'Supersede'
          ? { validityWindowEvidenceToken: delta.evidenceToken } : {}),
      }
    }
    case 'procedure': {
      const flow = draft.anchors.find(
        (anchor): anchor is Extract<Anchor, { t: 'flow' }> => anchor.t === 'flow',
      )
      return {
        kind: 'procedure',
        flowName: flow?.name ?? canonicalJson(draft.anchors[0]),
        // D-01: procedureStepKeys is the schema-owned identity authority. Observation
        // naturalKeys are evidence prose and must never enter the content address.
        stepSignature: computeStepSequenceSignature(structuralProcedureStepKeys),
      }
    }
    case 'caution': {
      const error = draft.anchors.find(
        (anchor): anchor is Extract<Anchor, { t: 'error' }> => anchor.t === 'error',
      )
      return { kind: 'caution', errorKey: error?.message ?? canonicalJson(draft.anchors[0]) }
    }
    case 'unknown':
      return {
        kind: 'unknown',
        conflictRecordIds: delta.kind === 'MintUnknown' ? delta.conflict.recordIds : delta.citedIds,
      }
    case 'policy':
      return { kind: 'policy', ruleKey: canonicalJson(draft.anchors[0]),
        ...(delta.kind === 'Supersede'
          ? { validityWindowEvidenceToken: delta.evidenceToken } : {}),
      }
  }
}

function syntheticDraft(job: CommitCurationJob): BundleDraft {
  return {
    kind: job.payload.kind,
    ...(job.payload.subtype === undefined ? {} : { subtype: job.payload.subtype }),
    anchors: [...job.payload.anchors],
    scope: job.payload.scope,
    summary: job.payload.summarySeed,
    body: job.payload.bodySeed,
    distilledEvidenceRef: {
      id: `curation-candidate-${job.candidateId}`,
      sha: job.candidateId,
    },
    originStage: 'run-curation',
  }
}

function draftForDelta(delta: Delta, job: CommitCurationJob): CheckpointDraft | undefined {
  if (delta.kind === 'Add') return delta.bundle
  if (delta.kind === 'Supersede') return delta.newBundle
  if (delta.kind === 'MintUnknown') return syntheticDraft(job)
  return undefined
}

function evidenceMarkdown(job: CommitCurationJob): string {
  const lines = job.payload.distilledObservations.map(
    (observation) => `- ${canonicalJson(observation)}`,
  )
  return `${lines.length === 0 ? job.payload.bodySeed : lines.join('\n')}\n`
}

function observationOrdinal(job: CommitCurationJob): number | undefined {
  return job.payload.distilledObservations[0]?.observedAtOrdinal
}

function measurementSeedValue(job: CommitCurationJob): string | undefined {
  if (job.payload.kind !== 'fact' || job.payload.subtype !== 'measurement') return undefined
  const metric = job.payload.anchors.find(
    (anchor): anchor is Extract<Anchor, { t: 'flow' }> =>
      anchor.t === 'flow' && anchor.name.startsWith('measurement:'),
  )
  if (metric === undefined) return undefined
  const prefix = `${metric.name.slice('measurement:'.length)} measured as `
  return job.payload.summarySeed.startsWith(prefix)
    ? job.payload.summarySeed.slice(prefix.length)
    : undefined
}

function numericMeasurementSeed(job: CommitCurationJob): number | undefined {
  const value = measurementSeedValue(job)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function confirmedEvent(
  job: CommitCurationJob,
  delta: Delta,
  evidenceToken = job.payload.evidenceToken,
): Extract<LoadedBundle['events'][number], { type: 'confirmed' }> {
  return {
    type: 'confirmed',
    evidenceToken: asEvidenceToken(evidenceToken),
    curationJobId: job.candidateId,
    buildOrdinal: job.payload.buildOrdinal,
    observationId: job.payload.attributingObservationId,
    ...(observationOrdinal(job) === undefined
      ? {}
      : { observationOrdinal: observationOrdinal(job) }),
    origin: originClass(delta),
  }
}

function relations(
  intents: readonly RelationIntent[],
  delta: Delta,
  job: CommitCurationJob,
): BundleRelation[] {
  const values: BundleRelation[] = intents.map((intent) => ({
    type: intent.type,
    targetId: intent.targetId,
    addedAtOrdinal: job.payload.buildOrdinal,
    curationJobId: job.candidateId,
  }))
  if (delta.kind === 'Supersede') {
    values.unshift({
      type: 'supersedes',
      targetId: delta.victimId,
      addedAtOrdinal: job.payload.buildOrdinal,
      curationJobId: job.candidateId,
    })
  }
  return values
}

function artifactInputs(job: CommitCurationJob): ArtifactCopyInput[] {
  return job.payload.artifactInventory.map((artifact) => ({
    ref: {
      id: `${job.candidateId}:${artifact.stepIndex}:${artifact.sha256}`,
      sha: artifact.sha256,
    },
    sourcePath: join(job.candidateDir, artifact.relativePath),
    stepIndex: artifact.stepIndex,
    role: artifact.role,
    originalName: artifact.originalName,
  }))
}

/**
 * Pre-copy the job's artifacts into the preflight dir — and touch the filesystem only if it has
 * artifacts to copy.
 *
 * THE EMPTY SHORT-CIRCUIT IS NOT A MICRO-OPTIMISATION, it is what makes 387-17's write-free
 * `bridgeDelta` true on the SUCCESS path. `copyArtifacts` opens with an unconditional
 * `mkdirSync(destArtifactsDir, { recursive: true })`, and `preflightDir` lives INSIDE
 * `job.candidateDir` — so for a knowledge-port job, whose `candidateDir` deliberately no longer
 * exists, that one recursive mkdir re-created the entire `memory/queue/claimed/<lease>/<id>/…`
 * chain. `markDone` then removed the candidate and its lease dir again, but `memory/queue/claimed`
 * itself survived: MEASURED as `existsSync(claimedRoot) === true` after a successful port-bridged
 * fact `Add`. The corpus's whole-root digest counts directories, so that is residue, and the
 * regression case in knowledge-store.test.ts now reds if it comes back.
 *
 * PROVABLY INERT FOR THE DRAIN, which is the sibling-input half. A drain job's `candidateDir` is
 * a real directory that the queue wrote long before commit, its artifacts dir is created by this
 * call only to be removed by `commitCurationDelta`'s `finally`, and the result returned here for
 * an empty input list is the same object `copyArtifacts` builds for one: nothing copied, nothing
 * skipped, and evidence complete. A job WITH artifacts is untouched by this branch.
 */
function preCopyArtifacts(
  job: CommitCurationJob,
  preflightDir: string,
): ArtifactCopyResult {
  const inputs = artifactInputs(job)
  if (inputs.length === 0) {
    return { copied: [], skipped: [], evidenceIncomplete: false }
  }
  return copyArtifacts(inputs, join(preflightDir, 'artifacts'))
}

function publisherArtifacts(
  preCopy: ArtifactCopyResult,
  preflightDir: string,
): ArtifactCopyInput[] {
  return preCopy.copied.map((artifact) => ({
    ref: artifact.ref,
    sourcePath: join(preflightDir, artifact.relPath),
    stepIndex: artifact.stepIndex,
    ...(artifact.role === undefined ? {} : { role: artifact.role }),
    ...(artifact.originalName === undefined ? {} : { originalName: artifact.originalName }),
  }))
}

function storeConfig(
  deps: CommitCurationDependencies,
  productKey: string,
  writerLeaseId: string,
): BundleStoreConfig {
  const hooks: NonNullable<BundleStoreConfig['hooks']> = {
    ...(deps.hooks?.beforePublishRename === undefined
      ? {}
      : { beforePublishRename: deps.hooks.beforePublishRename }),
    ...(deps.hooks?.afterMutableReplacement === undefined
      ? {}
      : { afterMutableReplacement: deps.hooks.afterMutableReplacement }),
  }
  return {
    knowledgeRoot: deps.knowledgeRoot,
    productKey,
    writerLeaseId,
    writerEpoch: deps.epoch,
    ...(Object.keys(hooks).length === 0 ? {} : { hooks }),
  }
}

type PreparedBundlePublication =
  | {
      kind: 'override'
      publish: NonNullable<
        NonNullable<CommitCurationDependencies['operations']>['publishBundle']
      >
      config: BundleStoreConfig
      input: PublishBundleInput
    }
  | { kind: 'canonical'; outcome: StageBundleOutcome }

function prepareBundlePublication(
  deps: CommitCurationDependencies,
  config: BundleStoreConfig,
  input: PublishBundleInput,
): PreparedBundlePublication {
  const publishOverride = deps.operations?.publishBundle
  if (publishOverride !== undefined) {
    return { kind: 'override', publish: publishOverride, config, input }
  }
  return { kind: 'canonical', outcome: stageBundle(config, input) }
}

function finalizePreparedPublicationWithinCurrentAuthority(
  deps: CommitCurationDependencies,
  writerLeaseId: string,
  prepared: PreparedBundlePublication,
): PublishBundleOutcome {
  if (prepared.kind === 'override') {
    return prepared.publish(prepared.config, prepared.input)
  }
  if (prepared.outcome.kind !== 'staged') return prepared.outcome
  try {
    return finalizeStagedBundle(prepared.outcome)
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT'
      && !existsSync(prepared.outcome.stagingDir)
    ) {
      throw new WriterAuthorityLostError(
        { knowledgeRoot: deps.knowledgeRoot, leaseId: writerLeaseId, epoch: deps.epoch },
        'mutation-lock-generation-lost',
        readCurrentEpoch(deps.knowledgeRoot),
      )
    }
    throw error
  }
}

function discardPreparedPublication(prepared: PreparedBundlePublication): void {
  if (prepared.kind !== 'canonical' || prepared.outcome.kind !== 'staged') return
  discardStagedBundle(prepared.outcome, true)
}

function unknownEvidenceRecordIds(
  intent: UnknownMintIntent,
  committedBundleId: RecordId,
): RecordId[] {
  const ids = [
    ...intent.evidenceRecordIds,
    ...(intent.includeCommittedBundle ? [committedBundleId] : []),
  ]
  return ids.filter((id, index) => ids.indexOf(id) === index).sort()
}

function recordFirstSeenBundle(
  state: DispositionDrainState,
  registration: FirstSeenRegistration,
  recordId: RecordId,
): void {
  state.firstSeenAnchorsByScope ??= new Map()
  const entries = state.firstSeenAnchorsByScope.get(registration.scopeKey) ?? new Map()
  entries.set(registration.supersessionKey, {
    buildOrdinal: registration.buildOrdinal,
    recordId,
  })
  state.firstSeenAnchorsByScope.set(registration.scopeKey, entries)
}

function unknownDraft(
  intent: UnknownMintIntent,
  evidenceRecordIds: readonly RecordId[],
  job: CommitCurationJob,
): BundleDraft {
  const payload = intent.kind === 'thrash'
    ? {
        kind: intent.kind,
        triggerKey: intent.triggerKey,
        windowOpenOrdinal: intent.windowOpenOrdinal,
        windowCloseOrdinal: intent.windowCloseOrdinal,
        evidenceRecordIds,
      }
    : {
        kind: intent.kind,
        scopeKey: intent.triggerKey,
        windowOpenOrdinal: intent.windowOpenOrdinal,
        windowCloseOrdinal: intent.windowCloseOrdinal,
        firstSeenCount: intent.firstSeenCount,
        evidenceRecordIds,
      }
  return {
    kind: 'unknown',
    anchors: [{ t: 'flow', name: intent.marker }],
    scope: intent.scope,
    summary: intent.kind === 'thrash'
      ? `Memory disabled for churning anchor ${intent.triggerKey}`
      : `High-cardinality restructuring detected for ${intent.triggerKey}`,
    body: canonicalJson(payload),
    distilledEvidenceRef: {
      id: `${intent.kind}:${job.candidateId}`,
      sha: job.candidateId,
    },
    originStage: 'run-curation',
  }
}

interface PreparedUnknownMintIntent {
  intent: UnknownMintIntent
  publication: PreparedBundlePublication
}

function prepareUnknownMintIntent(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
  checkpoint: AuthoredDeltaCheckpoint,
  intent: UnknownMintIntent,
  committedBundleId: RecordId,
): PreparedUnknownMintIntent {
  const evidenceRecordIds = unknownEvidenceRecordIds(intent, committedBundleId)
  const deterministicAuthorship = {
    path: 'deterministic-fallback' as const,
    executionContext: checkpoint.authorship.executionContext,
  }
  const delta: Extract<Delta, { kind: 'MintUnknown' }> = {
    kind: 'MintUnknown',
    origin: 'system',
    scope: intent.scope,
    citedIds: [...evidenceRecordIds],
    conflict: { recordIds: [...evidenceRecordIds], kind: 'drift' },
    authorship: deterministicAuthorship,
  }
  const draft = unknownDraft(intent, evidenceRecordIds, job)
  const config = storeConfig(deps, intent.scope.key, job.leaseId)
  const publication = prepareBundlePublication(deps, config, {
    draft,
    discriminant: discriminant(draft, delta, []),
    originClass: originClass(delta),
    createdAtOrdinal: job.payload.buildOrdinal,
    screenStates: [],
    initialEvents: [confirmedEvent(job, delta)],
    relations: evidenceRecordIds.map((targetId) => ({
      type: 'conflicts-with' as const,
      targetId,
      addedAtOrdinal: job.payload.buildOrdinal,
      curationJobId: job.candidateId,
    })),
    provenance: {
      mode: 'run-linked',
      runId: job.payload.sourceRunId,
      testId: job.payload.attributingObservationId,
      stepIndex: job.payload.distilledObservations[0]?.step.ordinal ?? 0,
      curationJobId: job.candidateId,
      sourceBuildOrdinal: job.payload.buildOrdinal,
      authorship: deterministicAuthorship,
    },
    evidenceMarkdown: `${draft.body}\n`,
    distilledObservations: [],
    artifacts: [],
  })
  return { intent, publication }
}

function commitUnknownMintIntentWithinCurrentAuthority(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
  prepared: PreparedUnknownMintIntent,
): CommitCurationOutcome | undefined {
  const published = finalizePreparedPublicationWithinCurrentAuthority(
    deps,
    job.leaseId,
    prepared.publication,
  )
  if (published.kind === 'identity-collision') {
    return {
      kind: 'failed',
      reason: 'identity-collision',
      collisionReason: published.reason,
    }
  }
  applyIndexDeltaForBundleWithinCurrentAuthority({
    knowledgeRoot: deps.knowledgeRoot,
    bundleId: published.id,
    product: prepared.intent.scope.key,
  })
  return undefined
}

function commitUnknownResolutionIntent(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
  intent: UnknownResolutionIntent,
  target: ProductQualifiedBundleDir,
): CommitCurationOutcome | undefined {
  const config = storeConfig(deps, target.product, job.leaseId)
  const evidenceToken = asEvidenceToken(
    sha256hex(canonicalJson({
      token: job.payload.evidenceToken,
      event: intent.reason,
      targetId: intent.targetId,
    })),
  )
  // The intent is armed disposition-side as maintenance origin `system`; the
  // autonomous-deprecate guard blocks only agent-origin removals.
  const appended = appendOutcomeEvent(config, intent.targetId, {
    type: 'deprecated',
    evidenceToken,
    curationJobId: job.candidateId,
    buildOrdinal: job.payload.buildOrdinal,
    reason: intent.reason,
  })
  const failure = appendFailure(appended)
  if (failure !== undefined) return failure
  applyIndexDeltaForBundleWithinCurrentAuthority({
    knowledgeRoot: deps.knowledgeRoot,
    bundleId: intent.targetId,
    product: target.product,
  })
  return undefined
}

function resolveExistingTarget(
  knowledgeRoot: string,
  bundleId: RecordId,
  product: string | undefined,
): ProductQualifiedBundleDir {
  return resolveProductQualifiedBundleDir({
    knowledgeRoot,
    recordId: bundleId,
    ...(product === undefined ? {} : { product }),
  })
}

/**
 * 381-47: derive the delta-noop cause from the checkpoint authorship commit already holds
 * (disposition stays authorship-blind). Absent fallbackReason on a fallback-path checkpoint
 * predates the stamp and maps to 'fallback-malformed' — the historical dominant cause
 * (F-381-45-1: three rejected proposals).
 */
function deriveEmptyDeltaCause(
  authorship: AuthoredDeltaCheckpoint['authorship'],
): EmptyDeltaCause {
  if (authorship.path === 'deterministic-fallback') {
    return `fallback-${authorship.fallbackReason ?? 'malformed'}`
  }
  return 'authored-noop'
}

function markDone(deps: CommitCurationDependencies, job: CommitCurationJob): void {
  if (deps.deferCompletion === true) return
  writeJobState({
    knowledgeRoot: deps.knowledgeRoot,
    candidateId: job.candidateId,
    authority: { leaseId: job.leaseId, epoch: deps.epoch },
    lifecycle: 'done',
  })
}

function markDoneWithinCurrentAuthority(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
): void {
  if (deps.deferCompletion === true) return
  writeJobStateWithinCurrentAuthority({
    knowledgeRoot: deps.knowledgeRoot,
    candidateId: job.candidateId,
    authority: { leaseId: job.leaseId, epoch: deps.epoch },
    lifecycle: 'done',
  })
}

function finishCommitWithinCurrentAuthority(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
  observation: CurationObservation,
  projectSuccessfulPrefix = true,
  completeClaim = true,
): void {
  for (const effect of observation.effects) {
    if (!isCurationEffectCommitted(deps.knowledgeRoot, job.candidateId, effect)) continue
    // Failure can leave a successful prefix whose normal index tail was never reached.
    if (projectSuccessfulPrefix) applyIndexDeltaForBundleWithinCurrentAuthority({ knowledgeRoot: deps.knowledgeRoot,
      bundleId: effect.recordId, product: effect.product,
    })
    writeCurationEffectReceiptWithinCurrentAuthority({ knowledgeRoot: deps.knowledgeRoot,
      authority: { leaseId: job.leaseId, epoch: deps.epoch },
      receipt: receiptForEffect(job.candidateId, observation, effect),
    })
  }
  deps.hooks?.afterEffectReceiptsWritten?.()
  clearCommitIntent(deps.knowledgeRoot, job.candidateId)
  deps.hooks?.afterIntentCleared?.()
  // Retriable failures preserve the claim for drain to requeue its authored checkpoint.
  if (completeClaim) markDoneWithinCurrentAuthority(deps, job)
}

function appendFailure(
  outcome:
    | ReturnType<typeof appendMeasurementObservation>
    | ReturnType<typeof appendOutcomeEvent>
    | ReturnType<typeof appendOutcomeEventWithEnrichment>
    | ReturnType<typeof appendPromotionReceipt>
    | ReturnType<typeof appendRelation>,
): CommitCurationOutcome | undefined {
  if (outcome.kind === 'not-found') return { kind: 'failed', reason: 'append-failed' }
  return undefined
}

function appendMeasurementObservationOnce(
  config: BundleStoreConfig,
  victim: ProductQualifiedBundleDir,
  observation: Parameters<typeof appendMeasurementObservation>[2],
): ReturnType<typeof appendMeasurementObservation> {
  const existing = readMeasurements(victim.dir)
  const consumed = existing?.observations.find(
    (candidate) =>
      candidate.evidenceToken === observation.evidenceToken
      && candidate.curationJobId === observation.curationJobId,
  )
  if (consumed !== undefined) {
    if (canonicalJson(consumed) !== canonicalJson(observation)) {
      throw new TypeError('measurement observation identity resolved to different canonical bytes')
    }
    return { kind: 'duplicate' }
  }
  return appendMeasurementObservation(config, victim.recordId as RecordId, observation)
}

function mutationTarget(delta: Delta): RecordId | undefined {
  if (delta.kind === 'Confirm' || delta.kind === 'Deprecate') return delta.targetId
  if (delta.kind === 'Supersede') return delta.victimId
  return undefined
}

/**
 * The one serialized mutation boundary: fresh epoch, disposition, intent, fresh epoch, publish,
 * append-only lifecycle, canonical index projection, intent clear, and queue completion.
 */
export function commitCurationDelta(
  deps: CommitCurationDependencies,
  job: CommitCurationJob,
  checkpoint: AuthoredDeltaCheckpoint,
): CommitCurationOutcome {
  const beforeWork = staleEpoch(deps)
  if (beforeWork !== undefined) return beforeWork

  const disposed = disposeDelta({
    delta: checkpoint.delta,
    checkpoint,
    profile: deps.profile,
    knowledgeRoot: deps.knowledgeRoot,
    candidate: {
      anchors: job.payload.anchors,
      scope: job.payload.scope,
      buildOrdinal: job.payload.buildOrdinal,
      curationJobId: job.candidateId,
      ...(measurementSeedValue(job) === undefined
        ? {}
        : { measurementValue: measurementSeedValue(job) }),
      // 381-03: procedure deltas are validated against durable queue evidence, so the
      // extraction wall receives the payload's code-derived facts (never LLM text).
      ...(job.payload.kind === 'procedure'
        ? {
            procedureEvidence: {
              distilledObservations: job.payload.distilledObservations,
            },
          }
        : {}),
    },
    drainState: deps.drainState,
  })
  if (disposed.kind === 'requeue-resynthesis') return disposed
  if (disposed.kind === 'noop') {
    markDone(deps, job)
    // Only the delta-noop mint is authorship-derived; every other noop reason
    // (evidence-token dedup, the extraction-wall rejects) stays causeless.
    if (disposed.reason === 'delta-noop') {
      return { ...disposed, emptyDeltaCause: deriveEmptyDeltaCause(checkpoint.authorship) }
    }
    return disposed
  }

  const delta = disposed.delta
  const relationRows = relations(disposed.relationIntents ?? [], delta, job)
  const draft = draftForDelta(delta, job)
  const structuralProcedureStepKeys = (() => {
    if (draft?.kind !== 'procedure') return []
    const payload = parseProcedureBody(draft.body)
    return payload === undefined ? undefined : procedureStepKeys(payload)
  })()
  if (structuralProcedureStepKeys === undefined) {
    // Defense in depth over disposition's matching refusal: an authored procedure
    // can never fall back to evidence prose for identity, including in sibling deltas.
    markDone(deps, job)
    return { kind: 'noop', reason: 'procedure-body-unparseable' }
  }
  const productKey = delta.scope.key
  const existingTargetIds = new Set<RecordId>()
  const directTarget = mutationTarget(delta)
  if (directTarget !== undefined) existingTargetIds.add(directTarget)
  if (disposed.measurementAppend !== undefined) {
    existingTargetIds.add(disposed.measurementAppend.victimId)
  }
  for (const intent of disposed.unknownResolutionIntents ?? []) {
    existingTargetIds.add(intent.targetId)
  }
  // Resolve every existing mutation target before publishing an intent or appending any bytes.
  // Scope keys are not storage products: use upstream product authority or require uniqueness.
  const existingTargets = new Map<RecordId, ProductQualifiedBundleDir>()
  for (const targetId of [...existingTargetIds].sort()) {
    existingTargets.set(
      targetId,
      resolveExistingTarget(
        deps.knowledgeRoot,
        targetId,
        job.targetProducts?.[targetId],
      ),
    )
  }
  let bundleId: RecordId
  let bundleDir: string | undefined
  let bundleProduct = productKey
  let publishInput: PublishBundleInput | undefined
  let preparedPublication: PreparedBundlePublication | undefined
  let preparedUnknownMintIntents: PreparedUnknownMintIntent[] = []
  const preflightDir = join(job.candidateDir, `.commit-artifacts-${randomUUID()}`)

  writeJobState({
    knowledgeRoot: deps.knowledgeRoot,
    candidateId: job.candidateId,
    authority: { leaseId: job.leaseId, epoch: deps.epoch },
    lifecycle: 'bundling',
    // Persist the parseable widened singleton so crash recovery replays through the
    // one authoredCheckpointSchema recovery boundary.
    authored: widenAuthoredDeltaCheckpoint(checkpoint),
  })

  try {
    if (draft !== undefined) {
      const preCopy = preCopyArtifacts(job, preflightDir)
      const identityDelta =
        disposed.kind === 'downgraded'
        && disposed.original.kind === 'Supersede'
        && (
          disposed.reason === 'propose-only'
          || (draft.kind === 'fact' && draft.subtype === 'measurement')
        )
          // D-02 propose-only keeps the replacement candidate distinct from its victim. The
          // downgraded Add is still the Supersede's new validity window, so it keeps the
          // original evidence token in its discriminant (D-58): a same-anchor correction never
          // lands on the victim's id, and a later acceptance converges on the id a local
          // Supersede of the same delta mints.
          ? disposed.original
          : delta
      const renderInput: RenderBundlePartsInput = {
        draft,
        discriminant: discriminant(
          draft,
          identityDelta,
          structuralProcedureStepKeys,
        ),
        originClass: originClass(delta),
        createdAtOrdinal: job.payload.buildOrdinal,
        screenStates: job.screenStates ?? [],
        initialEvents: [confirmedEvent(job, delta)],
        relations: relationRows,
        provenance: {
          mode: 'run-linked',
          runId: job.payload.sourceRunId,
          testId: job.payload.attributingObservationId,
          stepIndex: job.payload.distilledObservations[0]?.step.ordinal ?? 0,
          curationJobId: job.candidateId,
          sourceBuildOrdinal: job.payload.buildOrdinal,
          authorship: checkpoint.authorship,
          ...((draft as CheckpointDraft).needsEnrichment === true
            ? { needsEnrichment: true }
            : {}),
        },
        copiedArtifacts: preCopy,
        evidenceIncomplete: preCopy.evidenceIncomplete,
        evidenceMarkdown: evidenceMarkdown(job),
        distilledObservations: job.payload.distilledObservations,
      }
      const rendered = renderBundleParts(renderInput)
      bundleId = rendered.id
      publishInput = {
        ...renderInput,
        artifacts: publisherArtifacts(preCopy, preflightDir),
        preSkippedArtifacts: preCopy.skipped,
      }
    } else {
      const target = mutationTarget(delta)
      if (target === undefined) {
        markDone(deps, job)
        return { kind: 'failed', reason: 'append-failed' }
      }
      bundleId = target
      const resolved = existingTargets.get(target)
      if (resolved === undefined) {
        throw new Error(`bundle target ${target} was not resolved during preflight`)
      }
      bundleDir = resolved.dir
      bundleProduct = resolved.product
    }

    if (publishInput !== undefined) {
      preparedPublication = prepareBundlePublication(
        deps,
        storeConfig(deps, productKey, job.leaseId),
        publishInput,
      )
    }
    preparedUnknownMintIntents = (disposed.unknownMintIntents ?? []).map((intent) =>
      prepareUnknownMintIntent(deps, job, checkpoint, intent, bundleId),
    )

    // Cheap early abandon only. The load-bearing check is the tail's authority entry, which
    // reads lease identity and epoch inside the transaction it then holds.
    const beforeAuthorityEntry = staleEpoch(deps)
    if (beforeAuthorityEntry !== undefined) return beforeAuthorityEntry
    deps.hooks?.beforeCommitAuthorityEntry?.()
    const authority = { leaseId: job.leaseId, epoch: deps.epoch }
    const authorityHooks = {
      ...(deps.hooks?.afterFinalAuthorityCompare === undefined
        ? {}
        : { afterFinalAuthorityCompare: deps.hooks.afterFinalAuthorityCompare }),
      ...(deps.hooks?.mutationLockTakeoverMs === undefined
        ? {}
        : { mutationLockTakeoverMs: deps.hooks.mutationLockTakeoverMs }),
    }
    try {
      return withCurrentWriterAuthority(
        deps.knowledgeRoot,
        authority,
        () => {
          /**
           * CR-09: the committing transition and the durable intent are the first writes of
           * the held section, not the last writes before it. A superseded writer is refused
           * by the entry ladder above and therefore cannot publish either, so no intent can
           * exist that was not authored under live, exact authority. Both use the
           * within-held forms: re-entering withCurrentWriterAuthority here would open a
           * second connection against the BEGIN IMMEDIATE this callback already runs under.
           */
          writeJobStateWithinCurrentAuthority({
            knowledgeRoot: deps.knowledgeRoot,
            candidateId: job.candidateId,
            authority,
            lifecycle: 'committing',
            authored: widenAuthoredDeltaCheckpoint(checkpoint),
          })
          const effect = (
            recordId: string,
            product: string,
            change: CurationEffect['change'],
            evidenceToken = job.payload.evidenceToken,
          ): CurationEffect => ({
            recordId, product, change, evidenceToken, atOrdinal: job.payload.buildOrdinal,
          })
          const publicationChange = (id: string, product: string): 'added' | 'confirmed' => {
            // A resumed publication by this same candidate is still its original Add.
            let existing: LoadedBundle | undefined
            try {
              const target = resolveProductQualifiedBundleDir({
                knowledgeRoot: deps.knowledgeRoot, product, recordId: id,
              })
              const loaded = loadBundle(target.dir)
              if (loaded.kind === 'loaded') existing = loaded.bundle
            } catch (error) {
              if (!(error instanceof BundleTargetResolutionError) || error.reason !== 'not-found') {
                throw error
              }
            }
            return existing === undefined || (
              existing.provenance.mode === 'run-linked'
              && existing.provenance.curationJobId === job.candidateId
            )
              ? 'added' : 'confirmed'
          }
          const effects: CurationEffect[] = [effect(bundleId, bundleProduct,
            draft !== undefined
              ? publicationChange(bundleId, bundleProduct)
              : delta.kind === 'Deprecate' ? 'deprecated' : 'confirmed',
            delta.kind === 'Confirm' ? delta.evidenceToken : job.payload.evidenceToken,
          )]
          if (delta.kind === 'Supersede') {
            effects.push({
              ...effect(delta.victimId, existingTargets.get(delta.victimId)!.product,
                'superseded', delta.evidenceToken),
              byRecordId: bundleId,
            })
          }
          for (const prepared of preparedUnknownMintIntents) {
            const publication = prepared.publication
            const id = publication.kind === 'canonical' && 'id' in publication.outcome
              ? publication.outcome.id : undefined
            if (id !== undefined) {
              effects.push(effect(id, prepared.intent.scope.key,
                publicationChange(id, prepared.intent.scope.key)))
            }
          }
          for (const resolution of disposed.unknownResolutionIntents ?? []) {
            effects.push(effect(resolution.targetId, existingTargets.get(resolution.targetId)!.product,
              'deprecated', asEvidenceToken(sha256hex(canonicalJson({
                token: job.payload.evidenceToken,
                event: resolution.reason,
                targetId: resolution.targetId,
              }))),
            ))
          }
          const curationObservation: CurationObservation = {
            schemaVersion: 2, sourceRunId: job.payload.sourceRunId,
            observationId: job.payload.attributingObservationId,
            originalDeltaKind: originalDispositionDelta(disposed).kind,
            appliedDeltaKind: delta.kind, disposition: disposed.kind,
            ...(disposed.kind === 'downgraded' ? { downgradeReason: disposed.reason } : {}), effects,
          }
          writeCommitIntent(deps.knowledgeRoot, {
            schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
            candidateId: job.candidateId,
            bundleId,
            deltaKind: delta.kind,
            ...(mutationTarget(delta) === undefined
              ? {}
              : { targetRecordId: mutationTarget(delta) }),
            epoch: deps.epoch,
            observation: curationObservation,
          })
          deps.hooks?.afterIntentWritten?.()
          let convertedConfirm = false
          let confirmedEventDuplicate = false
          let measurementAppendDuplicate = false
          let tailMutationAppended = false
          let freshlyPublished = false
          let promotionHoldReason: PromotionGateHoldReason | undefined
          let promotionPath: PromotionPath | undefined
          const config = storeConfig(deps, productKey, job.leaseId)
          if (preparedPublication !== undefined) {
            const published = finalizePreparedPublicationWithinCurrentAuthority(
              deps,
              job.leaseId,
              preparedPublication,
            )
            if (published.kind === 'identity-collision') {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation)
              return {
                kind: 'failed',
                reason: 'identity-collision',
                collisionReason: published.reason,
              }
            }
            if (published.kind === 'already-exists') {
              const existingTarget = resolveProductQualifiedBundleDir({
                knowledgeRoot: deps.knowledgeRoot,
                product: productKey,
                recordId: published.id,
              })
              bundleDir = existingTarget.dir
              bundleProduct = existingTarget.product
              const existingConfig = storeConfig(
                deps,
                existingTarget.product,
                job.leaseId,
              )
              const capableEnrichment =
                delta.kind === 'Add'
                && checkpoint.authorship.path !== 'deterministic-fallback'
                && draft !== undefined
                  ? {
                      summary: draft.summary,
                      body: draft.body,
                      authorship: checkpoint.authorship,
                    }
                  : undefined
              const appended = capableEnrichment === undefined
                ? appendOutcomeEvent(
                    existingConfig,
                    published.id,
                    confirmedEvent(job, delta),
                  )
                : appendOutcomeEventWithEnrichment(
                    existingConfig,
                    published.id,
                    confirmedEvent(job, delta),
                    capableEnrichment,
                  )
              const failure = appendFailure(appended)
              if (failure !== undefined) {
                finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, failure.kind !== 'failed')
                return failure
              }
              if (
                appended.kind === 'duplicate'
                && (!('enriched' in appended) || appended.enriched === false)
              ) {
                const hasDeterministicTail =
                  disposed.measurementAppend !== undefined
                  || (disposed.kind === 'apply' && disposed.bornActive === true)
                  || (
                    deps.profile.mode === 'drain-to-active'
                    && !(disposed.kind === 'apply' && disposed.bornActive === true)
                  )
                  || (disposed.unknownMintIntents?.length ?? 0) > 0
                  || (disposed.unknownResolutionIntents?.length ?? 0) > 0
                if (!hasDeterministicTail) {
                  finishCommitWithinCurrentAuthority(deps, job, curationObservation, false)
                  return { kind: 'noop', reason: 'evidence-token-consumed' }
                }
                confirmedEventDuplicate = true
              }
              convertedConfirm = true
            } else {
              bundleDir = published.dir
              bundleProduct = productKey
              freshlyPublished = true
            }

            if (
              deps.profile.mode === 'drain-to-active'
              && !(disposed.kind === 'apply' && disposed.bornActive === true)
            ) {
              /**
               * Candidate is the exception bucket, not a waiting room. Admission
               * always writes candidate first; this immediate stricter re-check makes
               * clean facts active in the same drain. Propose-only never reaches this
               * branch, and promote() re-evaluates the gate at call time.
               */
              const promotionBundleDir = bundleDir
              const loaded = promotionBundleDir === undefined
                ? { kind: 'not-found' as const }
                : loadBundle(promotionBundleDir)
              if (loaded.kind !== 'loaded' || promotionBundleDir === undefined) {
                finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, false)
                return { kind: 'failed', reason: 'append-failed' }
              }
              const gate = evaluatePromotionGate(assemblePromotionGateInput({
                knowledgeRoot: deps.knowledgeRoot,
                bundleDir: promotionBundleDir,
                bundle: loaded.bundle,
              }))
              if (gate.verdict === 'promote') {
                const promoted = appendOutcomeEvent(config, published.id, {
                  type: 'promoted',
                  evidenceToken: derivePromotedEvidenceToken(job.payload.evidenceToken),
                  curationJobId: job.candidateId,
                  buildOrdinal: job.payload.buildOrdinal,
                })
                const promotedFailure = appendFailure(promoted)
                if (promotedFailure !== undefined) {
                  finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, promotedFailure.kind !== 'failed')
                  return promotedFailure
                }
                tailMutationAppended ||= promoted.kind === 'appended'
                const receipt = appendPromotionReceipt(config, published.id, {
                  schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
                  kind: 'promotion',
                  candidateId: published.id,
                  promotionPath: gate.promotionPath,
                  citedReceiptDigests: gate.citedReceiptDigests,
                  producedAtOrdinal: job.payload.buildOrdinal,
                  producedBy: { jobId: job.candidateId },
                })
                const receiptFailure = appendFailure(receipt)
                if (receiptFailure !== undefined) {
                  finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, receiptFailure.kind !== 'failed')
                  return receiptFailure
                }
                tailMutationAppended ||= receipt.kind === 'appended'
                promotionPath = gate.promotionPath
              } else {
                promotionHoldReason = gate.reason
              }
            }

            const measurementValue = numericMeasurementSeed(job)
            if (
              draft?.kind === 'fact'
              && draft.subtype === 'measurement'
              && measurementValue !== undefined
            ) {
              const baseline = writeMeasurementBaseline(config, published.id, {
                mu0: measurementValue,
                sigma0: 0,
                n0: 1,
                openedAtOrdinal: job.payload.buildOrdinal,
              })
              const baselineFailure = appendFailure(baseline)
              if (baselineFailure !== undefined) {
                finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, baselineFailure.kind !== 'failed')
                return baselineFailure
              }
              tailMutationAppended ||= baseline.kind === 'appended'
            }

            if (disposed.kind === 'apply' && disposed.bornActive === true) {
              if (delta.kind !== 'Supersede') {
                throw new TypeError('born-active disposition requires a Supersede delta')
              }
              // §5.5.5 carve-out: a deterministic drift Supersede is exempt from candidate-gating
              // and born active. Only drain-to-active disposition can set this D-02 marker.
              const promoted = appendOutcomeEvent(config, published.id, {
                  type: 'promoted',
                  evidenceToken: derivePromotedEvidenceToken(delta.evidenceToken),
                  curationJobId: job.candidateId,
                  buildOrdinal: job.payload.buildOrdinal,
                })
              const promotedFailure = appendFailure(promoted)
              if (promotedFailure !== undefined) {
                finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, promotedFailure.kind !== 'failed')
                return promotedFailure
              }
              tailMutationAppended ||= promoted.kind === 'appended'
            }
            if (freshlyPublished) deps.hooks?.afterBundlePublished?.(published.id)
            if (disposed.kind === 'apply' && disposed.bornActive === true) {
              applyIndexDeltaForBundleWithinCurrentAuthority({
                knowledgeRoot: deps.knowledgeRoot,
                bundleId: published.id,
                product: bundleProduct,
              })
            }
          } else if (delta.kind === 'Confirm') {
            const target = existingTargets.get(delta.targetId)
            if (target === undefined) {
              throw new Error(`bundle target ${delta.targetId} was not resolved during preflight`)
            }
            const targetConfig = storeConfig(
              deps,
              target.product,
              job.leaseId,
            )
            const appended = appendOutcomeEvent(
              targetConfig,
              delta.targetId,
              confirmedEvent(job, delta, delta.evidenceToken),
            )
            const failure = appendFailure(appended)
            if (failure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, failure.kind !== 'failed')
              return failure
            }
            if (appended.kind === 'duplicate') {
              if (disposed.measurementAppend === undefined) {
                finishCommitWithinCurrentAuthority(deps, job, curationObservation, false)
                return { kind: 'noop', reason: 'evidence-token-consumed' }
              }
              confirmedEventDuplicate = true
            }
          } else if (delta.kind === 'Deprecate') {
            const target = existingTargets.get(delta.targetId)
            if (target === undefined) {
              throw new Error(`bundle target ${delta.targetId} was not resolved during preflight`)
            }
            const targetConfig = storeConfig(
              deps,
              target.product,
              job.leaseId,
            )
            const appended = appendOutcomeEvent(targetConfig, delta.targetId, {
              type: 'deprecated',
              evidenceToken: asEvidenceToken(job.payload.evidenceToken),
              curationJobId: job.candidateId,
              buildOrdinal: job.payload.buildOrdinal,
              reason: delta.reason,
            })
            const failure = appendFailure(appended)
            if (failure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, failure.kind !== 'failed')
              return failure
            }
          }

          if (disposed.measurementAppend !== undefined) {
            const { victimId, observation } = disposed.measurementAppend
            const victim = existingTargets.get(victimId)
            if (victim === undefined) {
              throw new Error(`bundle target ${victimId} was not resolved during preflight`)
            }
            const measurementConfig = storeConfig(
              deps,
              victim.product,
              job.leaseId,
            )
            const appended = appendMeasurementObservationOnce(
              measurementConfig,
              victim,
              observation,
            )
            const failure = appendFailure(appended)
            if (failure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, failure.kind !== 'failed')
              return failure
            }
            measurementAppendDuplicate = appended.kind === 'duplicate'
            tailMutationAppended ||= appended.kind === 'appended'
          }

          const canonicalConfig = storeConfig(
            deps,
            bundleProduct,
            job.leaseId,
          )
          for (const relation of relationRows) {
            const appended = appendRelation(canonicalConfig, bundleId, relation)
            const failure = appendFailure(appended)
            if (failure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, failure.kind !== 'failed')
              return failure
            }
            tailMutationAppended ||= appended.kind === 'appended'
          }

          if (delta.kind === 'Supersede') {
            const victim = existingTargets.get(delta.victimId)
            if (victim === undefined) {
              throw new Error(`bundle target ${delta.victimId} was not resolved during preflight`)
            }
            const victimConfig = storeConfig(
              deps,
              victim.product,
              job.leaseId,
            )
            const superseded = appendOutcomeEvent(victimConfig, delta.victimId, {
              type: 'superseded',
              evidenceToken: delta.evidenceToken,
              curationJobId: job.candidateId,
              buildOrdinal: job.payload.buildOrdinal,
              byRecordId: bundleId,
            })
            const supersededFailure = appendFailure(superseded)
            if (supersededFailure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, supersededFailure.kind !== 'failed')
              return supersededFailure
            }
            tailMutationAppended ||= superseded.kind === 'appended'
            const closeToken = asEvidenceToken(
              sha256hex(canonicalJson({ token: delta.evidenceToken, event: 'window-close' })),
            )
            const closed = appendOutcomeEvent(victimConfig, delta.victimId, {
              type: 'window-close',
              evidenceToken: closeToken,
              curationJobId: job.candidateId,
              buildOrdinal: job.payload.buildOrdinal,
              closedAtOrdinal: job.payload.buildOrdinal,
            })
            const closeFailure = appendFailure(closed)
            if (closeFailure !== undefined) {
              finishCommitWithinCurrentAuthority(deps, job, curationObservation, true, closeFailure.kind !== 'failed')
              return closeFailure
            }
            tailMutationAppended ||= closed.kind === 'appended'
            applyIndexDeltaForBundleWithinCurrentAuthority({
              knowledgeRoot: deps.knowledgeRoot,
              bundleId: delta.victimId,
              product: victim.product,
            })
          }

          const evidenceTokenConsumed =
            confirmedEventDuplicate
            && !tailMutationAppended
            && (
              disposed.measurementAppend === undefined
              || measurementAppendDuplicate
            )
            && (disposed.unknownMintIntents?.length ?? 0) === 0
            && (disposed.unknownResolutionIntents?.length ?? 0) === 0
          if (evidenceTokenConsumed) {
            // A completed replay must not rewrite an unchanged FTS projection.
            finishCommitWithinCurrentAuthority(deps, job, curationObservation, false)
            return { kind: 'noop', reason: 'evidence-token-consumed' }
          }

          applyIndexDeltaForBundleWithinCurrentAuthority({
            knowledgeRoot: deps.knowledgeRoot,
            bundleId,
            product: bundleProduct,
          })

          if (disposed.firstSeenRegistration !== undefined) {
            recordFirstSeenBundle(deps.drainState, disposed.firstSeenRegistration, bundleId)
          }

          for (const prepared of preparedUnknownMintIntents) {
            const failure = commitUnknownMintIntentWithinCurrentAuthority(deps, job, prepared)
            if (failure !== undefined) return failure
          }
          for (const intent of disposed.unknownResolutionIntents ?? []) {
            const target = existingTargets.get(intent.targetId)
            if (target === undefined) {
              throw new Error(`bundle target ${intent.targetId} was not resolved during preflight`)
            }
            const failure = commitUnknownResolutionIntent(deps, job, intent, target)
            if (failure !== undefined) return failure
          }
          deps.hooks?.afterIndexApplied?.(bundleId)
          finishCommitWithinCurrentAuthority(deps, job, curationObservation, false)

          const result: CommittedBundleResult = {
            bundleId,
            bundleDir: bundleDir ?? '',
            deltaKind: delta.kind,
            ...(promotionHoldReason === undefined ? {} : { promotionHoldReason }),
            ...(promotionPath === undefined ? {} : { promotionPath }),
          }
          if (convertedConfirm && disposed.kind !== 'downgraded') {
            return { kind: 'converted-confirm', ...result }
          }
          return disposed.kind === 'downgraded'
            ? { kind: 'downgraded', reason: disposed.reason, original: disposed.original, ...result }
            : { kind: 'applied', ...result }
        },
        authorityHooks,
      )
    } catch (error) {
      if (error instanceof WriterAuthorityLostError) {
        return { kind: 'abandoned-stale-epoch', observedEpoch: error.observedEpoch }
      }
      throw error
    }
  } finally {
    if (preparedPublication !== undefined) {
      discardPreparedPublication(preparedPublication)
    }
    for (const prepared of preparedUnknownMintIntents) {
      discardPreparedPublication(prepared.publication)
    }
    rmSync(preflightDir, { recursive: true, force: true })
  }
}
