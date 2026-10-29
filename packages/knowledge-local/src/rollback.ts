/**
 * D-15 provenance-keyed rollback.
 *
 * Resolution is derived exclusively from canonical bundle files. Disposable records rows are
 * never consulted, so deleting or rebuilding the local index cannot change the affected set.
 * Task 2 attaches the append-only inverse emitter to this resolution authority.
 */
import { isAbsolute } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  eventDedupKey,
  sha256hex,
  supersessionKey,
  survivingOutcomeEvents,
  type BundleOutcomeEvent,
  type Delta,
  type OriginClass,
  type RecordId,
} from '@vostride/agent-qa-schema'

import { appendOutcomeEvent } from './bundle-append.js'
import { deriveBundleTrust, loadBundle } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import type { BundleStoreConfig } from './bundle-publish.js'
import { enumerateBundleDirs } from './bundle-scan.js'
import { applyIndexDeltaForBundle } from './curator/commit.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION } from './curator/author-contract.js'
import type { AuthoredDeltaCheckpoint } from './curator/author-contract.js'
import { disposeDelta } from './curator/disposition.js'
import { refreshWriterLeaseAuthority } from './lease/writer-lease.js'
import type { WriterLeaseAuthority } from './lease/writer-lease.js'

export type RollbackKind = 'job' | 'campaign'

export interface RollbackCounterEvent {
  recordId: RecordId
  evidenceToken: string
  curationJobId: string
  type: 'confirmed' | 'deprecated' | 'superseded' | 'promoted'
}

export type RollbackPlannedEffect =
  | {
      kind: 'deprecate-bundle'
      product: string
      recordId: RecordId
    }
  | {
      kind: 'retract-counter' | 'retract-window-close' | 'retract-promotion'
      product: string
      recordId: RecordId
      eventKey: string
      evidenceToken: string
      curationJobId: string
    }

export interface RollbackBundleTarget {
  product: string
  recordId: RecordId
}

export interface RollbackAffectedSet {
  operationId: string
  /** Compatibility summary; plannedEffects is the product-qualified mutation authority. */
  mintedBundleIds: RecordId[]
  counterEvents: RollbackCounterEvent[]
  plannedEffects: RollbackPlannedEffect[]
  /** Projection healing targets; these never require a new rollback ordinal on their own. */
  projectionTargets: RollbackBundleTarget[]
  products: string[]
}

export interface RollbackReport {
  receiptId: string
  inverseCount: number
  restoredVictims: RecordId[]
  deprecatedBundles: RecordId[]
  /** Bundles whose surviving promoted events were cascade-retracted after support loss. */
  retractedPromotions: RecordId[]
  /** Auditable exact resolution that drove inverse construction. */
  affected: RollbackAffectedSet
}

export type RollbackMutationKind = 'append' | 'projection'

export interface RollbackHooks {
  /** Test/chaos seam after canonical resolution and causal preflight, before the first write. */
  afterResolution?: () => void
  /** Test/chaos seam after one actual append or projection mutation completes. */
  afterMutation?: (kind: RollbackMutationKind, recordId: RecordId) => void
}

interface RollbackBaseInput {
  knowledgeRoot: string
  resolvedAtOrdinal: number
  /** Governed maintenance callers fence this exact lease at every mutation boundary. */
  writerAuthority?: WriterLeaseAuthority
  /** Preview fingerprint revalidated by the mutator immediately before its first write. */
  expectedAffectedSetFingerprint?: string
  hooks?: RollbackHooks
}

export interface RollbackCurationJobInput extends RollbackBaseInput {
  curationJobId: string
}

export interface RollbackCampaignInput extends RollbackBaseInput {
  fromOrdinal?: number
  toOrdinal?: number
  anchorClusterKey?: string
  originClass?: OriginClass
}

interface CanonicalRollbackBundle {
  recordId: RecordId
  product: string
  dir: string
  bundle: LoadedBundle
}

interface ResolvedCounterEvent extends RollbackCounterEvent {
  event: BundleOutcomeEvent
  product: string
}

interface ResolvedRetractionEvent {
  recordId: RecordId
  product: string
  event: BundleOutcomeEvent
  effectKind: Extract<
    RollbackPlannedEffect['kind'],
    'retract-window-close' | 'retract-promotion'
  >
}

interface RollbackResolution {
  receiptId: string
  mintedBundles: CanonicalRollbackBundle[]
  counterEvents: ResolvedCounterEvent[]
  windowCloseEvents: ResolvedRetractionEvent[]
  promotionEvents: ResolvedRetractionEvent[]
  projectionTargets: RollbackBundleTarget[]
  affected: RollbackAffectedSet
}

export type ResolveRollbackAffectedSetInput =
  | RollbackCurationJobInput
  | RollbackCampaignInput

/**
 * a rollback must never attest success at a resolution ordinal that is powerless to
 * change lifecycle status. At equal buildOrdinal the trust fold's fixed STATUS_PRECEDENCE keeps
 * active above deprecated, and an older event can never replace a newer status, so a
 * non-strictly-later resolvedAtOrdinal cannot causally invert a minted bundle.
 */
export class RollbackCausalityError extends Error {
  readonly offendingRecordIds: RecordId[]
  readonly minimumRequiredOrdinal: number

  constructor(offendingRecordIds: RecordId[], minimumRequiredOrdinal: number) {
    super(
      `rollback resolvedAtOrdinal must be at least ${minimumRequiredOrdinal} `
      + `to invert ${offendingRecordIds.join(', ')}`,
    )
    this.name = 'RollbackCausalityError'
    this.offendingRecordIds = offendingRecordIds
    this.minimumRequiredOrdinal = minimumRequiredOrdinal
  }
}

export class RollbackPlanChangedError extends Error {
  override readonly name = 'RollbackPlanChangedError'
  readonly expectedFingerprint: string
  readonly actualFingerprint: string

  constructor(expectedFingerprint: string, actualFingerprint: string) {
    super('rollback affected set changed before mutation; rerun to see the new preview')
    this.expectedFingerprint = expectedFingerprint
    this.actualFingerprint = actualFingerprint
  }
}

const ORIGIN_CLASSES = new Set<OriginClass>([
  'user',
  'agent-verified',
  'agent-observed',
  'import',
])
const ANCHOR_CLUSTER_KEY = /^[0-9a-f]{64}$/

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function assertBaseInput(input: RollbackBaseInput): void {
  if (!isAbsolute(input.knowledgeRoot)) {
    throw new TypeError('rollback knowledgeRoot must be absolute')
  }
  if (
    input.writerAuthority !== undefined
    && input.writerAuthority.knowledgeRoot !== input.knowledgeRoot
  ) {
    throw new TypeError('rollback writerAuthority must belong to knowledgeRoot')
  }
  assertOrdinal(input.resolvedAtOrdinal, 'rollback resolvedAtOrdinal')
}

function fenceWriterAuthority(input: RollbackBaseInput): void {
  if (input.writerAuthority === undefined) return
  if (input.writerAuthority.knowledgeRoot !== input.knowledgeRoot) {
    throw new TypeError('rollback writerAuthority must belong to knowledgeRoot')
  }
  refreshWriterLeaseAuthority(input.writerAuthority)
}

function campaignKeys(input: RollbackCampaignInput): Readonly<Record<string, unknown>> {
  if (input.fromOrdinal !== undefined) {
    assertOrdinal(input.fromOrdinal, 'rollback fromOrdinal')
  }
  if (input.toOrdinal !== undefined) {
    assertOrdinal(input.toOrdinal, 'rollback toOrdinal')
  }
  if (
    input.fromOrdinal !== undefined
    && input.toOrdinal !== undefined
    && input.fromOrdinal > input.toOrdinal
  ) {
    throw new RangeError('rollback fromOrdinal must be less than or equal to toOrdinal')
  }
  if (
    input.anchorClusterKey !== undefined
    && !ANCHOR_CLUSTER_KEY.test(input.anchorClusterKey)
  ) {
    throw new TypeError('rollback anchorClusterKey must be a canonical 64-hex key')
  }
  if (
    input.originClass !== undefined
    && !ORIGIN_CLASSES.has(input.originClass)
  ) {
    throw new TypeError('rollback originClass is not recognized')
  }
  if (
    input.fromOrdinal === undefined
    && input.toOrdinal === undefined
    && input.anchorClusterKey === undefined
    && input.originClass === undefined
  ) {
    throw new TypeError('rollbackCampaign requires at least one campaign predicate')
  }

  return {
    ...(input.fromOrdinal === undefined ? {} : { fromOrdinal: input.fromOrdinal }),
    ...(input.toOrdinal === undefined ? {} : { toOrdinal: input.toOrdinal }),
    ...(input.anchorClusterKey === undefined
      ? {}
      : { anchorClusterKey: input.anchorClusterKey }),
    ...(input.originClass === undefined ? {} : { originClass: input.originClass }),
  }
}

/** Stable identity for one selector and its product-qualified source-effect universe. */
export function rollbackReceiptId(
  kind: RollbackKind,
  keys: Readonly<Record<string, unknown>>,
  effectKeys: readonly string[] = [],
): string {
  return `rollback:${sha256hex(canonicalJson({
    kind,
    keys,
    effectKeys: [...effectKeys].sort(compareText),
  }))}`
}

function canonicalBundles(knowledgeRoot: string): CanonicalRollbackBundle[] {
  const bundles: CanonicalRollbackBundle[] = []
  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') continue
    bundles.push({
      recordId: asRecordId(loaded.bundle.manifest.id),
      product: entry.product,
      dir: entry.dir,
      bundle: loaded.bundle,
    })
  }
  return bundles
}

function isCounterEvent(
  event: BundleOutcomeEvent,
): event is BundleOutcomeEvent & { type: RollbackCounterEvent['type'] } {
  return event.type === 'confirmed'
    || event.type === 'deprecated'
    || event.type === 'superseded'
    || event.type === 'promoted'
}

function publicAffectedSet(resolution: RollbackResolution): RollbackAffectedSet {
  return resolution.affected
}

export function rollbackAffectedSetFingerprint(affected: RollbackAffectedSet): string {
  return canonicalJson(affected)
}

/** Resolve the canonical rollback preview without appending inverse events or touching indexes. */
export function resolveRollbackAffectedSet(
  input: ResolveRollbackAffectedSetInput,
): RollbackAffectedSet {
  return publicAffectedSet(
    'curationJobId' in input
      ? resolveCurationJob(input)
      : resolveCampaign(input),
  )
}

function counterEventsFor(
  bundles: readonly CanonicalRollbackBundle[],
  mintedTargets: ReadonlySet<string>,
  predicate: (bundle: CanonicalRollbackBundle, event: BundleOutcomeEvent) => boolean,
): ResolvedCounterEvent[] {
  const events: ResolvedCounterEvent[] = []
  for (const bundle of bundles) {
    // A minted bundle is inverted as a whole. Its initial confirmation is part of that Add,
    // Supersede, or MintUnknown effect and must not be independently retracted.
    if (mintedTargets.has(bundleTargetKey(bundle.product, bundle.recordId))) continue
    for (const event of bundle.bundle.events) {
      if (!isCounterEvent(event) || event.curationJobId.startsWith('rollback:')) continue
      if (!predicate(bundle, event)) continue
      events.push({
        recordId: bundle.recordId,
        evidenceToken: event.evidenceToken,
        curationJobId: event.curationJobId,
        type: event.type,
        event,
        product: bundle.product,
      })
    }
  }
  return events.sort((left, right) =>
    compareText(left.product, right.product)
    || compareText(left.recordId, right.recordId)
    || compareText(left.evidenceToken, right.evidenceToken)
    || compareText(left.curationJobId, right.curationJobId)
    || compareText(left.type, right.type),
  )
}

function bundleTargetKey(product: string, recordId: RecordId): string {
  return `${product}\0${recordId}`
}

function eventEffectKey(
  kind: RollbackPlannedEffect['kind'],
  product: string,
  recordId: RecordId,
  event?: BundleOutcomeEvent,
): string {
  return canonicalJson({
    kind,
    product,
    recordId,
    ...(event === undefined ? {} : { eventKey: eventDedupKey(event) }),
  })
}

function eventSurvivalKeys(bundle: LoadedBundle): Set<string> {
  return new Set(survivingOutcomeEvents(bundle.events).map(eventDedupKey))
}

function hasExactRetraction(
  bundle: LoadedBundle,
  receiptId: string,
  targetRecordId: RecordId,
  target: BundleOutcomeEvent,
): boolean {
  const targetKey = eventDedupKey(target)
  const token = inverseEvidenceToken(receiptId, targetRecordId, targetKey)
  return bundle.events.some((event) =>
    event.type === 'retracted'
    && event.evidenceToken === token
    && event.curationJobId === receiptId
    && event.retractsEvidenceToken === target.evidenceToken
    && event.retractsCurationJobId === target.curationJobId,
  )
}

function windowCloseFor(
  bundle: CanonicalRollbackBundle,
  superseded: ResolvedCounterEvent,
): ResolvedRetractionEvent | undefined {
  const closeToken = asEvidenceToken(sha256hex(canonicalJson({
    token: superseded.evidenceToken,
    event: 'window-close',
  })))
  const event = bundle.bundle.events.find((candidate) =>
    candidate.type === 'window-close'
    && candidate.evidenceToken === closeToken
    && candidate.curationJobId === superseded.curationJobId,
  )
  return event === undefined
    ? undefined
    : {
        recordId: bundle.recordId,
        product: bundle.product,
        event,
        effectKind: 'retract-window-close',
      }
}

function promotionCascadeUniverse(
  bundles: readonly CanonicalRollbackBundle[],
  counters: readonly ResolvedCounterEvent[],
): ResolvedRetractionEvent[] {
  const selectedConfirmations = new Map<string, Set<string>>()
  const directlySelectedEvents = new Set(counters.map(({ product, recordId, event }) =>
    `${bundleTargetKey(product, recordId)}\0${eventDedupKey(event)}`,
  ))
  for (const counter of counters) {
    if (counter.type !== 'confirmed') continue
    const key = bundleTargetKey(counter.product, counter.recordId)
    const selected = selectedConfirmations.get(key) ?? new Set<string>()
    selected.add(eventDedupKey(counter.event))
    selectedConfirmations.set(key, selected)
  }

  const cascades: ResolvedRetractionEvent[] = []
  for (const bundle of bundles) {
    const selected = selectedConfirmations.get(
      bundleTargetKey(bundle.product, bundle.recordId),
    )
    if (selected === undefined) continue
    const surviving = survivingOutcomeEvents(bundle.bundle.events)
    if (surviving.some((event) =>
      event.type === 'confirmed' && !selected.has(eventDedupKey(event)),
    )) continue
    for (const event of bundle.bundle.events) {
      const selectedEventKey = [
        bundleTargetKey(bundle.product, bundle.recordId),
        eventDedupKey(event),
      ].join('\0')
      if (event.type !== 'promoted' || directlySelectedEvents.has(selectedEventKey)) continue
      cascades.push({
        recordId: bundle.recordId,
        product: bundle.product,
        event,
        effectKind: 'retract-promotion',
      })
    }
  }
  return cascades.sort((left, right) =>
    compareText(left.product, right.product)
    || compareText(left.recordId, right.recordId)
    || compareText(eventDedupKey(left.event), eventDedupKey(right.event)),
  )
}

function buildResolution(input: {
  kind: RollbackKind
  keys: Readonly<Record<string, unknown>>
  bundles: readonly CanonicalRollbackBundle[]
  mintedUniverse: readonly CanonicalRollbackBundle[]
  counterUniverse: readonly ResolvedCounterEvent[]
}): RollbackResolution {
  const byTarget = new Map(input.bundles.map((bundle) => [
    bundleTargetKey(bundle.product, bundle.recordId),
    bundle,
  ]))
  const windowCloseUniverse = input.counterUniverse.flatMap((counter) => {
    if (counter.type !== 'superseded') return []
    const bundle = byTarget.get(bundleTargetKey(counter.product, counter.recordId))
    if (bundle === undefined) return []
    const close = windowCloseFor(bundle, counter)
    return close === undefined ? [] : [close]
  })
  const promotionUniverse = promotionCascadeUniverse(input.bundles, input.counterUniverse)
  const operationEffectKeys = [
    ...input.mintedUniverse.map((bundle) =>
      eventEffectKey('deprecate-bundle', bundle.product, bundle.recordId),
    ),
    ...input.counterUniverse.map((counter) =>
      eventEffectKey('retract-counter', counter.product, counter.recordId, counter.event),
    ),
    ...windowCloseUniverse.map((effect) =>
      eventEffectKey(effect.effectKind, effect.product, effect.recordId, effect.event),
    ),
    ...promotionUniverse.map((effect) =>
      eventEffectKey(effect.effectKind, effect.product, effect.recordId, effect.event),
    ),
  ].sort(compareText)
  const receiptId = rollbackReceiptId(input.kind, input.keys, operationEffectKeys)
  const survivingByTarget = new Map(input.bundles.map((bundle) => [
    bundleTargetKey(bundle.product, bundle.recordId),
    eventSurvivalKeys(bundle.bundle),
  ]))
  const mintedHasExactInverse = (bundle: CanonicalRollbackBundle) => {
    const token = inverseEvidenceToken(receiptId, bundle.recordId, 'minted-bundle')
    return bundle.bundle.events.some((event) =>
      event.evidenceToken === token && event.curationJobId === receiptId,
    )
  }
  const mintedBundles = input.mintedUniverse.filter((bundle) =>
    deriveBundleTrust(bundle.bundle).status !== 'deprecated'
    && !mintedHasExactInverse(bundle),
  )
  const hasAppliedRetraction = (
    effect: ResolvedCounterEvent | ResolvedRetractionEvent,
  ): boolean => {
    const bundle = byTarget.get(bundleTargetKey(effect.product, effect.recordId))
    return bundle !== undefined
      && hasExactRetraction(bundle.bundle, receiptId, effect.recordId, effect.event)
  }
  const pending = <T extends ResolvedCounterEvent | ResolvedRetractionEvent>(effect: T) => {
    const bundle = byTarget.get(bundleTargetKey(effect.product, effect.recordId))
    const surviving = survivingByTarget.get(bundleTargetKey(effect.product, effect.recordId))
    return bundle !== undefined
      && surviving?.has(eventDedupKey(effect.event)) === true
      && !hasExactRetraction(bundle.bundle, receiptId, effect.recordId, effect.event)
  }
  const counterEvents = input.counterUniverse.filter(pending)
  const windowCloseEvents = windowCloseUniverse.filter(pending)
  const promotionEvents = promotionUniverse.filter(pending)
  const plannedEffects: RollbackPlannedEffect[] = [
    ...mintedBundles.map(({ product, recordId }) => ({
      kind: 'deprecate-bundle' as const,
      product,
      recordId,
    })),
    ...counterEvents.map((effect) => ({
      kind: 'retract-counter' as const,
      product: effect.product,
      recordId: effect.recordId,
      eventKey: eventDedupKey(effect.event),
      evidenceToken: effect.evidenceToken,
      curationJobId: effect.curationJobId,
    })),
    ...windowCloseEvents.map((effect) => ({
      kind: effect.effectKind,
      product: effect.product,
      recordId: effect.recordId,
      eventKey: eventDedupKey(effect.event),
      evidenceToken: effect.event.evidenceToken,
      curationJobId: effect.event.curationJobId,
    })),
    ...promotionEvents.map((effect) => ({
      kind: effect.effectKind,
      product: effect.product,
      recordId: effect.recordId,
      eventKey: eventDedupKey(effect.event),
      evidenceToken: effect.event.evidenceToken,
      curationJobId: effect.event.curationJobId,
    })),
  ].sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
  const projectionTargetMap = new Map<string, RollbackBundleTarget>()
  const includeProjection = (product: string, recordId: RecordId) => {
    projectionTargetMap.set(bundleTargetKey(product, recordId), { product, recordId })
  }
  for (const bundle of input.mintedUniverse) {
    if (mintedBundles.includes(bundle) || mintedHasExactInverse(bundle)) {
      includeProjection(bundle.product, bundle.recordId)
    }
  }
  for (const effect of [
    ...input.counterUniverse,
    ...windowCloseUniverse,
    ...promotionUniverse,
  ]) {
    if (pending(effect) || hasAppliedRetraction(effect)) {
      includeProjection(effect.product, effect.recordId)
    }
  }
  const projectionTargets = [...projectionTargetMap.values()].sort((left, right) =>
    compareText(left.product, right.product) || compareText(left.recordId, right.recordId),
  )
  const products = [...new Set([
    ...plannedEffects.map(({ product }) => product),
    ...projectionTargets.map(({ product }) => product),
  ])].sort(compareText)
  const affected: RollbackAffectedSet = {
    operationId: receiptId,
    mintedBundleIds: mintedBundles.map(({ recordId }) => recordId).sort(compareText),
    counterEvents: counterEvents.map((event) => ({
      recordId: event.recordId,
      evidenceToken: event.evidenceToken,
      curationJobId: event.curationJobId,
      type: event.type,
    })),
    plannedEffects,
    projectionTargets,
    products,
  }
  return {
    receiptId,
    mintedBundles,
    counterEvents,
    windowCloseEvents,
    promotionEvents,
    projectionTargets,
    affected,
  }
}

function resolveCurationJob(input: RollbackCurationJobInput): RollbackResolution {
  assertBaseInput(input)
  if (input.curationJobId.trim() === '') {
    throw new TypeError('rollback curationJobId must be non-empty')
  }
  const bundles = canonicalBundles(input.knowledgeRoot)
  const mintedUniverse = bundles.filter(({ bundle }) =>
    bundle.provenance.mode === 'run-linked'
    && bundle.provenance.curationJobId === input.curationJobId,
  )
  const mintedTargets = new Set(mintedUniverse.map(({ product, recordId }) =>
    bundleTargetKey(product, recordId),
  ))
  return buildResolution({
    kind: 'job',
    keys: { curationJobId: input.curationJobId },
    bundles,
    mintedUniverse,
    counterUniverse: counterEventsFor(
      bundles,
      mintedTargets,
      (_bundle, event) => event.curationJobId === input.curationJobId,
    ),
  })
}

function ordinalMatches(
  ordinal: number,
  input: RollbackCampaignInput,
): boolean {
  return (input.fromOrdinal === undefined || ordinal >= input.fromOrdinal)
    && (input.toOrdinal === undefined || ordinal <= input.toOrdinal)
}

function bundleAxesMatch(
  bundle: CanonicalRollbackBundle,
  input: RollbackCampaignInput,
): boolean {
  return (
    input.anchorClusterKey === undefined
    || supersessionKey(bundle.bundle.frontmatter.anchors.map(({ normalized }) => normalized))
      === input.anchorClusterKey
  ) && (
    input.originClass === undefined
    || bundle.bundle.frontmatter.originClass === input.originClass
  )
}

function resolveCampaign(input: RollbackCampaignInput): RollbackResolution {
  assertBaseInput(input)
  const keys = campaignKeys(input)
  const bundles = canonicalBundles(input.knowledgeRoot)
  const mintedUniverse = bundles.filter((bundle) =>
    bundle.bundle.provenance.mode === 'run-linked'
    && bundle.bundle.provenance.sourceBuildOrdinal !== undefined
    && ordinalMatches(bundle.bundle.provenance.sourceBuildOrdinal, input)
    && bundleAxesMatch(bundle, input),
  )
  const mintedTargets = new Set(mintedUniverse.map(({ product, recordId }) =>
    bundleTargetKey(product, recordId),
  ))
  return buildResolution({
    kind: 'campaign',
    keys,
    bundles,
    mintedUniverse,
    counterUniverse: counterEventsFor(
      bundles,
      mintedTargets,
      (bundle, event) => ordinalMatches(event.buildOrdinal, input)
        && bundleAxesMatch(bundle, input),
    ),
  })
}

function bundleConfig(
  input: RollbackBaseInput,
  productKey: string,
): BundleStoreConfig {
  return {
    knowledgeRoot: input.knowledgeRoot,
    productKey,
    ...(input.writerAuthority === undefined
      ? {}
      : { writerLeaseId: input.writerAuthority.leaseId }),
  }
}

/**
 * Every inverse token binds the receipt, target, and exact effect key. The existing
 * (recordId, evidenceToken, curationJobId) append dedup therefore makes a repeated rollback a
 * byte-level noop while a different selector/effect universe receives a different audit identity.
 */
function inverseEvidenceToken(
  receiptId: string,
  targetRecordId: RecordId,
  retractedKey: string,
) {
  return asEvidenceToken(sha256hex(canonicalJson({
    rollbackReceiptId: receiptId,
    targetRecordId,
    retractedKey,
  })))
}

function appendedOrThrow(
  outcome: ReturnType<typeof appendOutcomeEvent>,
  targetRecordId: RecordId,
): boolean {
  switch (outcome.kind) {
    case 'appended':
      return true
    case 'duplicate':
      return false
    case 'not-found':
      throw new Error(`rollback target ${targetRecordId} disappeared during commit`)
  }
}

function appendRollbackEvent(
  input: RollbackBaseInput,
  product: string,
  targetRecordId: RecordId,
  event: BundleOutcomeEvent,
): boolean {
  fenceWriterAuthority(input)
  const appended = appendedOrThrow(
    appendOutcomeEvent(bundleConfig(input, product), targetRecordId, event),
    targetRecordId,
  )
  if (appended) input.hooks?.afterMutation?.('append', targetRecordId)
  return appended
}

function maintenanceCheckpoint(delta: Delta, targetRecordId: RecordId): AuthoredDeltaCheckpoint {
  const authorship = {
    path: 'deterministic-fallback' as const,
    executionContext: 'local-interactive' as const,
  }
  return {
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    delta,
    neighborIds: [targetRecordId],
    preconditions: [],
    authorship,
  }
}

/**
 * RATIFICATION / Pitfall 8: inverse Deprecates are mechanical maintenance deltas with origin
 * `system`. They pass the ordinary deterministic disposition floor; `agent` would be downgraded
 * for an active target, while `user` would incorrectly make this lifecycle choice sovereign and
 * permanent. The disposed delta is then emitted through the canonical append + projection tail.
 */
function appendInverseDeprecate(
  input: RollbackBaseInput,
  resolution: RollbackResolution,
  target: CanonicalRollbackBundle,
): boolean {
  const delta: Extract<Delta, { kind: 'Deprecate' }> = {
    kind: 'Deprecate',
    origin: 'system',
    scope: target.bundle.frontmatter.scope,
    citedIds: [],
    targetId: target.recordId,
    reason: `rollback:${resolution.receiptId}`,
    authorship: {
      path: 'deterministic-fallback',
      executionContext: 'local-interactive',
    },
  }
  const targetAlreadyDeprecated = deriveBundleTrust(target.bundle).status === 'deprecated'
  const disposed = targetAlreadyDeprecated
    ? { kind: 'apply' as const, delta }
    : disposeDelta({
        delta,
        checkpoint: maintenanceCheckpoint(delta, target.recordId),
        profile: { mode: 'drain-to-active' },
        knowledgeRoot: input.knowledgeRoot,
        drainState: { supersedesSeenByAnchorKey: new Map() },
      })
  if (disposed.kind !== 'apply' || disposed.delta.kind !== 'Deprecate') {
    throw new Error(
      `rollback maintenance Deprecate for ${target.recordId} did not pass disposition`,
    )
  }

  return appendRollbackEvent(
    input,
    target.product,
    target.recordId,
    {
      type: 'deprecated',
      evidenceToken: inverseEvidenceToken(
        resolution.receiptId,
        target.recordId,
        'minted-bundle',
      ),
      curationJobId: resolution.receiptId,
      buildOrdinal: input.resolvedAtOrdinal,
      reason: disposed.delta.reason,
    },
  )
}

function appendRetraction(
  input: RollbackBaseInput,
  resolution: RollbackResolution,
  target: ResolvedCounterEvent | ResolvedRetractionEvent,
): boolean {
  const retractedKey = eventDedupKey(target.event)
  return appendRollbackEvent(
    input,
    target.product,
    target.recordId,
    {
      type: 'retracted',
      evidenceToken: inverseEvidenceToken(
        resolution.receiptId,
        target.recordId,
        retractedKey,
      ),
      curationJobId: resolution.receiptId,
      buildOrdinal: input.resolvedAtOrdinal,
      retractsEvidenceToken: target.event.evidenceToken,
      retractsCurationJobId: target.event.curationJobId,
      rollbackReceiptId: resolution.receiptId,
    },
  )
}

function latestSurvivingLifecycleOrdinal(bundle: LoadedBundle): number {
  let latest = bundle.manifest.createdAtOrdinal
  for (const event of survivingOutcomeEvents(bundle.events)) {
    // Window-close and observation events never derive status, so they cannot gate causality.
    if (
      (event.type === 'promoted' || event.type === 'superseded' || event.type === 'deprecated')
      && event.buildOrdinal > latest
    ) {
      latest = event.buildOrdinal
    }
  }
  return latest
}

/**
 * Atomic strictly-later causal preflight. Runs before ANY append or projection write:
 * every minted bundle in the resolved set must be invertible at input.resolvedAtOrdinal. A
 * bundle is admitted when its surviving fold status is already deprecated (the inverse
 * end-state already holds) or when its log already carries this receipt's exact
 * inverse-deprecate identity (byte replay). Otherwise the resolution must be strictly later
 * than the bundle's latest surviving lifecycle ordinal — at an equal ordinal the fold's fixed
 * status precedence makes the inverse deprecation lose, so success would be a lie. All
 * violators are collected first and reported in one throw; no partial mutation ever precedes it.
 */
function assertCausalResolution(
  input: RollbackBaseInput,
  resolution: RollbackResolution,
): void {
  const offenders: { recordId: RecordId; latestOrdinal: number }[] = []
  for (const minted of resolution.mintedBundles) {
    if (deriveBundleTrust(minted.bundle).status === 'deprecated') continue
    const inverseToken = inverseEvidenceToken(
      resolution.receiptId,
      minted.recordId,
      'minted-bundle',
    )
    const alreadyInverted = minted.bundle.events.some((event) =>
      event.evidenceToken === inverseToken
      && event.curationJobId === resolution.receiptId,
    )
    if (alreadyInverted) continue
    const latestOrdinal = latestSurvivingLifecycleOrdinal(minted.bundle)
    if (input.resolvedAtOrdinal > latestOrdinal) continue
    offenders.push({ recordId: minted.recordId, latestOrdinal })
  }
  if (offenders.length === 0) return
  throw new RollbackCausalityError(
    offenders.map(({ recordId }) => recordId).sort(compareText),
    1 + Math.max(...offenders.map(({ latestOrdinal }) => latestOrdinal)),
  )
}

function emitRollback(
  input: RollbackBaseInput,
  resolution: RollbackResolution,
  resolveAgain: () => RollbackResolution,
): RollbackReport {
  const initialFingerprint = rollbackAffectedSetFingerprint(resolution.affected)
  if (
    input.expectedAffectedSetFingerprint !== undefined
    && input.expectedAffectedSetFingerprint !== initialFingerprint
  ) {
    throw new RollbackPlanChangedError(
      input.expectedAffectedSetFingerprint,
      initialFingerprint,
    )
  }
  assertCausalResolution(input, resolution)
  input.hooks?.afterResolution?.()
  const revalidated = resolveAgain()
  const revalidatedFingerprint = rollbackAffectedSetFingerprint(revalidated.affected)
  if (revalidatedFingerprint !== initialFingerprint) {
    throw new RollbackPlanChangedError(initialFingerprint, revalidatedFingerprint)
  }
  assertCausalResolution(input, revalidated)
  resolution = revalidated

  let inverseCount = 0
  const touched = new Map<string, { recordId: RecordId; product: string }>(
    resolution.projectionTargets.map((target) => [
      bundleTargetKey(target.product, target.recordId),
      target,
    ]),
  )
  const restoredVictims = new Set<RecordId>()
  const retractedPromotions = new Set<RecordId>()

  for (const minted of resolution.mintedBundles) {
    if (appendInverseDeprecate(input, resolution, minted)) inverseCount += 1
    touched.set(`${minted.product}\0${minted.recordId}`, minted)
  }

  for (const counter of resolution.counterEvents) {
    if (appendRetraction(
      input,
      resolution,
      counter,
    )) {
      inverseCount += 1
    }
    touched.set(`${counter.product}\0${counter.recordId}`, counter)
    if (counter.type === 'superseded') restoredVictims.add(counter.recordId)
  }

  for (const close of resolution.windowCloseEvents) {
    if (appendRetraction(input, resolution, close)) inverseCount += 1
    touched.set(bundleTargetKey(close.product, close.recordId), close)
    restoredVictims.add(close.recordId)
  }

  for (const promoted of resolution.promotionEvents) {
    if (appendRetraction(input, resolution, promoted)) inverseCount += 1
    touched.set(bundleTargetKey(promoted.product, promoted.recordId), promoted)
    retractedPromotions.add(promoted.recordId)
  }

  // Re-project every touched bundle even on duplicate replay. This is the same healing property
  // as commitCurationDelta's append-before-index recovery: canonical truth always wins.
  for (const target of [...touched.values()].sort((left, right) =>
    compareText(left.product, right.product) || compareText(left.recordId, right.recordId),
  )) {
    fenceWriterAuthority(input)
    applyIndexDeltaForBundle({
      knowledgeRoot: input.knowledgeRoot,
      bundleId: target.recordId,
      product: target.product,
    })
    input.hooks?.afterMutation?.('projection', target.recordId)
  }

  return {
    receiptId: resolution.receiptId,
    inverseCount,
    restoredVictims: [...restoredVictims].sort(compareText),
    deprecatedBundles: resolution.mintedBundles
      .map(({ recordId }) => recordId)
      .sort(compareText),
    retractedPromotions: [...retractedPromotions].sort(compareText),
    affected: publicAffectedSet(resolution),
  }
}

/** Resolve and append the ratified inverse map for one curation job. */
export function rollbackCurationJob(input: RollbackCurationJobInput): RollbackReport {
  return emitRollback(input, resolveCurationJob(input), () => resolveCurationJob(input))
}

/** Resolve and append the inverse map for an AND-composed provenance campaign. */
export function rollbackCampaign(input: RollbackCampaignInput): RollbackReport {
  return emitRollback(input, resolveCampaign(input), () => resolveCampaign(input))
}
