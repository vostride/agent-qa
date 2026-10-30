// The one write path: every change commits through the curator, and a retried identity lands once.

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  COMMIT_RECEIPT_SCHEMA_VERSION,
  FORGET_RECEIPT_SCHEMA_VERSION,
  GATE_RECEIPT_SCHEMA_VERSION,
  KnowledgeAcceptInputSchema,
  KnowledgeForgetInputSchema,
  KnowledgeMarkInputSchema,
  KnowledgeChangeIdSchema,
  KnowledgeRejectInputSchema,
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  deriveMarkStepId,
  stampReceiptDigest,
} from '@vostride/agent-qa-schema'

import type {
  Delta,
  CommitReceipt,
  ExecutionContext,
  Gate3Receipt,
  ForgetReceiptV1,
  KnowledgeMarkInput,
  KnowledgeProjection,
  KnowledgeReviewVerb,
  KnowledgeTargetRef,
  MarkChangeStamp,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle, readGateReceipts } from '../bundle-read.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import {
  createExplicitReviewStore,
  KnowledgePromotionError,
  syntheticEvidenceToken,
} from '../curator/knowledge-store.js'
import { diffSince } from '../diff-since.js'
import { materializePolicy, policyShelfPath, PolicyTextRefusedError } from '../policy/materialize.js'
import { acquireWriterLease, withCurrentWriterAuthority } from '../lease/writer-lease.js'
import { releaseLeaseAfterWork } from '../lease/under-writer-lease.js'
import type { WriterLease } from '../lease/writer-lease.js'
import { memoryStatusForBundle } from '../memory-status.js'
import { readRecordedForgetReceipt, recordForgetReceipt } from './forget-receipt-journal.js'
import { FORGET_SCRUBBED_PROJECTIONS, resolveReviewTarget, reviewDeltasFor } from './propose-review.js'
import type { ResolveBundleShortId, ReviewChangeRequest } from './propose-review.js'

export const APPLY_DELEGATE_TIMEOUT_MS = 30_000

/** The typed refusal a bounded wait produces. Never a generic timeout, never a takeover. */
export class ApplyDelegateTimeoutError extends Error {
  constructor(readonly changeId: string, readonly timeoutMs: number) {
    super(
      `The writer-lease holder did not answer the change ${changeId} within ${timeoutMs}ms. ` +
        'Retrying with the same operation identity is the same change; the lease was neither taken nor stolen.',
    )
    this.name = 'ApplyDelegateTimeoutError'
  }
}

/** The typed refusal when a live holder exists and this host was given no way to reach it. */
export class ApplyDelegateUnavailableError extends Error {
  constructor(readonly changeId: string, readonly holder: WriterLease) {
    super(
      `The writer lease for this knowledge root is held by pid ${holder.pid} (lease ` +
        `${holder.leaseId}, epoch ${holder.epoch}) and this host has no delegate transport, so ` +
        `${changeId} cannot be applied here. Lease-stealing is structurally refused.`,
    )
    this.name = 'ApplyDelegateUnavailableError'
  }
}

/** The record a change addresses left the store between resolution and commit. */
export class ReviewTargetVanishedError extends Error {
  constructor(readonly changeId: string) {
    super(`The record ${changeId} addresses is no longer in the store; nothing was committed.`)
    this.name = 'ReviewTargetVanishedError'
  }
}

// `id` is the receipt identity, derived from the caller's stable operation identity.
interface ReviewChange {
  readonly id: string
  readonly verb: KnowledgeReviewVerb
  readonly deltas: readonly Delta[]
  readonly mark?: MarkChangeStamp
}

/** The write context. The execution context is the actual one, never spoofed. */
interface ReviewWriter {
  readonly knowledgeRoot: string
  readonly executionContext: ExecutionContext
  /** Stamped as a Gate-3 receipt's `producedBy.opId`: the op that made this explicit change. */
  readonly opId: string
  readonly now?: () => number
}

interface WriterAuthority {
  readonly leaseId: string
  readonly epoch: number
}

/** What a review change did to the store, before any door-specific publication. */
type ReviewEffect =
  | {
      readonly kind: 'applied'
      readonly recordIds: readonly string[]
      readonly commitReceipt?: CommitReceipt
      readonly forgetReceipt?: ForgetReceiptV1
    }
  | { readonly kind: 'policy-materialize-refused' }

// Both reject and forget emit `Deprecate`, so the idempotency guard below keys on the kind.
const DEPRECATE_DELTA_KIND = 'Deprecate'

/** Whether a change's deltas deprecate anything. */
function deprecatesRecords(change: ReviewChange): boolean {
  return change.deltas.some((delta) => delta.kind === DEPRECATE_DELTA_KIND)
}

function locateRecord(knowledgeRoot: string, recordId: string) {
  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const outcome = loadBundle(entry.dir)
    if (outcome.kind !== 'loaded') continue
    if (outcome.bundle.manifest.id !== recordId) continue
    return {
      dir: entry.dir,
      product: entry.product,
      // Record lookup reads lifecycle only; numerical trust is neither returned nor consulted.
      status: deriveBundleTrust(outcome.bundle).status,
      provenance: outcome.bundle.provenance,
      bundle: outcome.bundle,
    }
  }
  return undefined
}

// `every`, not `some`: a partially tombstoned set still has work to do.
function alreadyTombstoned(knowledgeRoot: string, change: ReviewChange): boolean {
  const ids = targetRecordIds(change)
  if (ids.length === 0) return false
  return ids.every((recordId) => {
    const located = locateRecord(knowledgeRoot, recordId)
    return located !== undefined && memoryStatusForBundle(located.status) === 'tombstoned'
  })
}

/** Whether every record a forget names carries the tombstone this very change committed. */
function tombstonedByThisForget(knowledgeRoot: string, change: ReviewChange): boolean {
  const reason = `forget:${change.id}`
  const ids = targetRecordIds(change)
  return ids.length > 0 && ids.every((recordId) =>
    (locateRecord(knowledgeRoot, recordId)?.bundle.events ?? [])
      .some((event) => event.type === 'deprecated' && event.reason === reason))
}

/** Every record id a change's deltas name — the enumeration a forget receipt is built over. */
function targetRecordIds(change: ReviewChange): string[] {
  const ids = new Set<string>()
  for (const delta of change.deltas as readonly (Delta & { targetId?: string })[]) {
    if (typeof delta.targetId === 'string') ids.add(delta.targetId)
  }
  return [...ids].sort()
}

// A retried change would land a second event, because the dedup job id uses the build ordinal.
function landedEffects(
  knowledgeRoot: string,
  change: ReviewChange,
): { recordIds: string[]; ordinal: number } | undefined {
  if (change.deltas.length === 0
    || !change.deltas.every(delta => delta.kind === 'Confirm' || delta.kind === 'Add')) return undefined
  const found: { id: string; ordinal: number }[] = []
  for (const delta of change.deltas) {
    const token = syntheticEvidenceToken(delta)
    const hits = delta.kind === 'Confirm'
      ? (locateRecord(knowledgeRoot, delta.targetId)?.bundle.events ?? [])
        .filter(event => event.type === 'confirmed' && event.evidenceToken === token)
        .map(event => ({ id: delta.targetId as string, ordinal: event.buildOrdinal }))
      : enumerateBundleDirs(knowledgeRoot).flatMap(entry => {
        const loaded = loadBundle(entry.dir)
        if (loaded.kind !== 'loaded') return []
        return loaded.bundle.events
          .filter(event => event.type === 'confirmed' && event.evidenceToken === token)
          .map(event => ({ id: loaded.bundle.manifest.id as string, ordinal: event.buildOrdinal }))
      })
    if (hits.length > 1) throw new ReviewTargetVanishedError(change.id)
    if (hits.length === 1) found.push(hits[0]!)
  }
  if (found.length === 0) return undefined
  if (found.length !== change.deltas.length || new Set(found.map(row => row.ordinal)).size !== 1) {
    throw new ReviewTargetVanishedError(change.id)
  }
  return { recordIds: [...new Set(found.map(row => row.id))].sort(), ordinal: found[0]!.ordinal }
}

// Built from post-commit reads: the receipt says what happened, not what the preview predicted.
function assembleForgetReceipt(
  knowledgeRoot: string,
  change: ReviewChange,
  forgottenAt: number,
  projectionsScrubbed: readonly KnowledgeProjection[],
): ForgetReceiptV1 {
  const tombstonedRecords: ForgetReceiptV1['tombstonedRecords'] = []
  let resultingBundleStatus: ForgetReceiptV1['resultingBundleStatus'] = 'forgotten'
  for (const recordId of targetRecordIds(change)) {
    const located = locateRecord(knowledgeRoot, recordId)
    if (located === undefined) {
      // Tombstone-never-destroy (§7.7): the bundle file survives a forget, so a record that
      // cannot be read back after the commit is a fact about the STORE, not about this verb, and
      // reporting a tombstone for it would be the receipt asserting work nobody can verify.
      throw new ReviewTargetVanishedError(change.id)
    }
    tombstonedRecords.push({ recordId, provenance: located.provenance })
    resultingBundleStatus = memoryStatusForBundle(located.status)
  }
  return {
    schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
    proposalId: change.id,
    tombstonedRecords,
    projectionsScrubbed: [...projectionsScrubbed],
    resultingBundleStatus,
    forgottenAt,
  }
}

function reviewStore(
  writer: ReviewWriter,
  change: ReviewChange,
  lease: WriterAuthority,
  sourceBuildOrdinal?: number,
) {
  return createExplicitReviewStore({
    knowledgeRoot: writer.knowledgeRoot,
    executionContext: writer.executionContext,
    epoch: lease.epoch,
    writerLeaseId: lease.leaseId,
    ...(change.mark === undefined ? {} : { sourceRunId: change.mark.runId }),
    ...(sourceBuildOrdinal === undefined ? {} : { sourceBuildOrdinal }),
  })
}

async function commitInProcess(
  writer: ReviewWriter,
  change: ReviewChange,
  lease: WriterAuthority,
  sourceBuildOrdinal?: number,
) {
  const store = reviewStore(writer, change, lease, sourceBuildOrdinal)
  // THE one write path. Not `proposeDeltas` (which is the propose-only disposition profile and
  // would commit nothing), not a direct append, not a projection call — `commit`, exactly as any
  // curation write reaches it, through the store's explicit entry: a person's change is not
  // downgraded by the automatic propose-only profile, and every other check still applies.
  await store.commit([...change.deltas])
  return store
}

/** The local bridge has no global counter. Fence this commit above every persisted ordinal. */
function currentOrdinal(knowledgeRoot: string): number {
  let ordinal = 0
  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') continue
    ordinal = Math.max(ordinal, loaded.bundle.manifest.createdAtOrdinal,
      ...loaded.bundle.events.map(event => event.buildOrdinal),
      ...(readGateReceipts(entry.dir, loaded.bundle.manifest.id) ?? []).map(line => line.producedAtOrdinal))
  }
  return ordinal
}

/** commit() returns void: read the committed additions/confirmations, excluding retired victims. */
function readBackCommittedIds(knowledgeRoot: string, preOrdinal: number, change: ReviewChange): string[] {
  const ids = new Set(change.deltas.flatMap(delta => delta.kind === 'Confirm' ? [delta.targetId] : []))
  // diffSince projects surviving events and receipts into change/identity; it does not fold trust.
  for (const row of diffSince({ knowledgeRoot, sinceOrdinal: preOrdinal })) {
    if (row.change === 'added' || row.change === 'confirmed' || row.change === 'superseded') {
      ids.add(asRecordId(row.recordId))
    }
  }
  return [...ids].filter(id => {
    const record = locateRecord(knowledgeRoot, id)
    return record !== undefined && memoryStatusForBundle(record.status) !== 'tombstoned'
  }).sort()
}

function mintGate3Receipt(
  candidateId: string, writer: ReviewWriter, change: ReviewChange, producedAtOrdinal: number,
): Gate3Receipt {
  if (change.mark === undefined) throw new TypeError('mark change has no mark stamp')
  return stampReceiptDigest({
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId, verdict: 'pass', producedAtOrdinal,
    producedBy: { opId: writer.opId }, runId: change.mark.runId,
    ...(change.mark.stepIndex === undefined ? {} : {
      stepId: deriveMarkStepId(change.mark.testIndex, change.mark.stepIndex),
    }),
    mark: change.mark.kind,
  })
}

async function applyMarkArm(
  writer: ReviewWriter, change: ReviewChange, authority: WriterAuthority,
): Promise<ReviewEffect> {
  const recovered = completedMarkSupersession(writer, change, authority)
    ?? landedEffects(writer.knowledgeRoot, change)
  const preOrdinal = currentOrdinal(writer.knowledgeRoot)
  const store = recovered === undefined
    ? await commitInProcess(writer, change, authority, preOrdinal + 1)
    : reviewStore(writer, change, authority)
  const recordIds = recovered?.recordIds ?? readBackCommittedIds(writer.knowledgeRoot, preOrdinal, change)
  const committedAtOrdinal = recovered?.ordinal ?? currentOrdinal(writer.knowledgeRoot)
  const commitReceipt: CommitReceipt = {
    schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: change.id, markId: change.mark!.markId,
    committedAtOrdinal, recordIds, gate3: [], promoted: [], held: [],
  }
  for (const candidateId of recordIds) {
    const receipt = mintGate3Receipt(candidateId, writer, change, committedAtOrdinal)
    try {
      const outcome = await store.promote(asRecordId(candidateId), [receipt])
      if (outcome.promotionPath !== undefined) {
        commitReceipt.promoted.push({ candidateId, promotionPath: outcome.promotionPath })
      }
    } catch (error) {
      if (!(error instanceof KnowledgePromotionError)
        || error.reason === 'propose-only' || error.reason === 'not-found') throw error
      commitReceipt.held.push({ candidateId, reason: error.reason })
    }
    commitReceipt.gate3.push({ candidateId, receiptDigest: receipt.receiptDigest })
  }
  return { kind: 'applied', recordIds, commitReceipt }
}

/** A retry is not another lineage transition. Recover exact mark Supersede effects before commit. */
function completedMarkSupersession(
  writer: ReviewWriter, change: ReviewChange, authority: WriterAuthority,
): { recordIds: string[]; ordinal: number } | undefined {
  if (change.deltas.length === 0 || !change.deltas.every(delta => delta.kind === 'Supersede')) return undefined
  return withCurrentWriterAuthority(writer.knowledgeRoot, authority, () => {
    const found: { id: string; ordinal: number }[] = []
    for (const delta of change.deltas) {
      if (delta.kind !== 'Supersede') throw new Error('Expected mark Supersede')
      const victim = locateRecord(writer.knowledgeRoot, delta.victimId)
      const matches = victim?.bundle.events.filter(row => row.type === 'superseded'
        && row.evidenceToken === delta.evidenceToken) ?? []
      if (matches.length === 0) {
        // No own effects: the normal commit path retains its exact citation-integrity refusal.
        continue
      }
      const event = matches.length === 1 ? matches[0] : undefined
      if (event?.type !== 'superseded' || delta.evidenceToken !== `mark:${change.mark!.markId}`) {
        throw new ReviewTargetVanishedError(change.id)
      }
      const replacement = locateRecord(writer.knowledgeRoot, event.byRecordId)
      if (replacement === undefined || memoryStatusForBundle(replacement.status) === 'tombstoned'
        || replacement.bundle.frontmatter.kind !== delta.newBundle.kind
        || replacement.bundle.frontmatter.subtype !== delta.newBundle.subtype
        || replacement.bundle.body !== delta.newBundle.body
        || canonicalJson(replacement.bundle.frontmatter.scope) !== canonicalJson(delta.newBundle.scope)
        || canonicalJson(replacement.bundle.frontmatter.anchors.map(anchor => anchor.raw)) !== canonicalJson(delta.newBundle.anchors)
        || !replacement.bundle.events.some(row => row.type === 'confirmed' && row.evidenceToken === delta.evidenceToken
          && row.buildOrdinal === event.buildOrdinal && row.curationJobId === event.curationJobId)
        || !replacement.bundle.relations.relations.some(row => row.type === 'supersedes' && row.targetId === delta.victimId
          && row.addedAtOrdinal === event.buildOrdinal && row.curationJobId === event.curationJobId)
        || !victim!.bundle.events.some(row => row.type === 'window-close' && row.closedAtOrdinal === event.buildOrdinal
          && row.curationJobId === event.curationJobId)) throw new ReviewTargetVanishedError(change.id)
      found.push({ id: event.byRecordId, ordinal: event.buildOrdinal })
    }
    if (found.length === 0) return undefined
    if (found.length !== change.deltas.length || new Set(found.map(row => row.ordinal)).size !== 1) {
      throw new ReviewTargetVanishedError(change.id)
    }
    return { recordIds: [...new Set(found.map(row => row.id))].sort(), ordinal: found[0]!.ordinal }
  })
}

async function applyPolicyArm(
  writer: ReviewWriter, change: ReviewChange, authority: WriterAuthority,
  recordId: string, record: NonNullable<ReturnType<typeof locateRecord>>,
): Promise<ReviewEffect> {
  if (memoryStatusForBundle(record.status) === 'tombstoned') {
    return recoverPolicyArm(writer, change, authority, recordId)
  }
  const { bundle } = record
  const scope = bundle.frontmatter.scope
  let materialized
  try {
    materialized = materializePolicy({ knowledgeRoot: writer.knowledgeRoot, recordId,
      scope: scope.tier === 'global' ? 'global' : scope.key, ruleText: bundle.body,
      title: bundle.summary, writerAuthority: authority })
  } catch (error) {
    if (!(error instanceof PolicyTextRefusedError)) throw error
  }
  if (materialized === undefined) return { kind: 'policy-materialize-refused' }
  const reference: Delta = {
    kind: 'Supersede', origin: 'user', scope, citedIds: [asRecordId(recordId)],
    victimId: asRecordId(recordId), evidenceToken: asEvidenceToken(`policy-materialize:${change.id}`),
    newBundle: { kind: 'policy', summary: bundle.body.split('\n')[0] ?? bundle.summary,
      body: `${materialized.relPath}#agent-qa:policy ${recordId}`,
      anchors: bundle.frontmatter.anchors.map(({ raw }) => raw), scope,
      distilledEvidenceRef: { id: recordId, sha: bundle.manifest.contentHashes['record.md']! },
      originStage: 'run-curation' },
  }
  const preOrdinal = currentOrdinal(writer.knowledgeRoot)
  const store = await commitInProcess(writer, { ...change, deltas: [...change.deltas, reference] },
    authority, preOrdinal + 1)
  // Select the replacement by lifecycle/identity; the DTO's computed trust is never consumed.
  const superseded = diffSince({ knowledgeRoot: writer.knowledgeRoot, sinceOrdinal: preOrdinal })
    .find(row => row.recordId === recordId && row.change === 'superseded')
  const replacement = superseded?.byRecordId === undefined ? undefined
    : locateRecord(writer.knowledgeRoot, superseded.byRecordId)
  if (replacement?.bundle.frontmatter.kind !== 'policy' || replacement.bundle.body !== reference.newBundle.body) {
    throw new ReviewTargetVanishedError(change.id)
  }
  const committedAtOrdinal = currentOrdinal(writer.knowledgeRoot)
  const receipt = stampReceiptDigest({
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId: recordId,
    verdict: 'pass', producedAtOrdinal: committedAtOrdinal,
    producedBy: { opId: writer.opId },
    policyApproval: { proposalId: change.id, recordId },
  } as const)
  await store.recordGateReceipt(receipt)
  const commitReceipt: CommitReceipt = { schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: change.id,
    committedAtOrdinal, recordIds: [recordId], gate3: [{ candidateId: recordId, receiptDigest: receipt.receiptDigest }],
    promoted: [], held: [], policy: { recordId, scope: scope.tier === 'global' ? 'global' : scope.key,
      relPath: materialized.relPath, outcome: materialized.kind } }
  return { kind: 'applied', recordIds: [recordId], commitReceipt }
}

/** Recover only this change's fully committed effects; a closed target alone proves nothing. */
async function recoverPolicyArm(
  writer: ReviewWriter, change: ReviewChange, authority: WriterAuthority, recordId: string,
): Promise<ReviewEffect> {
  const committed = withCurrentWriterAuthority(writer.knowledgeRoot, authority, () => {
    const victim = locateRecord(writer.knowledgeRoot, recordId)
    const token = `policy-materialize:${change.id}`
    const events = victim?.bundle.events.filter(event => event.type === 'superseded' && event.evidenceToken === token)
    const event = events?.length === 1 ? events[0] : undefined
    if (victim === undefined || event?.type !== 'superseded') throw new ReviewTargetVanishedError(change.id)
    const replacement = locateRecord(writer.knowledgeRoot, event.byRecordId)
    const scope = victim.bundle.frontmatter.scope
    const shelfScope = scope.tier === 'global' ? 'global' : scope.key
    const relPath = relative(writer.knowledgeRoot, policyShelfPath(writer.knowledgeRoot, shelfScope))
    if (replacement?.bundle.frontmatter.kind !== 'policy'
      || memoryStatusForBundle(replacement.status) === 'tombstoned'
      || replacement.bundle.body !== `${relPath}#agent-qa:policy ${recordId}`
      || canonicalJson(replacement.bundle.frontmatter.scope) !== canonicalJson(scope)
      || replacement.bundle.manifest.createdAtOrdinal !== event.buildOrdinal
      || !replacement.bundle.events.some(row => row.type === 'confirmed' && row.evidenceToken === token
        && row.buildOrdinal === event.buildOrdinal && row.curationJobId === event.curationJobId)
      || !replacement.bundle.relations.relations.some(row => row.type === 'supersedes' && row.targetId === recordId
        && row.addedAtOrdinal === event.buildOrdinal && row.curationJobId === event.curationJobId)
      || !victim.bundle.events.some(row => row.type === 'window-close' && row.closedAtOrdinal === event.buildOrdinal
        && row.curationJobId === event.curationJobId)
      || !change.deltas.every(delta => delta.kind === 'Confirm' && delta.targetId === recordId
        && victim.bundle.events.some(row => row.type === 'confirmed' && row.evidenceToken === delta.evidenceToken
          && row.buildOrdinal === event.buildOrdinal))) throw new ReviewTargetVanishedError(change.id)
    const receipt = stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId: recordId,
      verdict: 'pass', producedAtOrdinal: event.buildOrdinal,
      producedBy: { opId: writer.opId },
      policyApproval: { proposalId: change.id, recordId },
    } as const)
    const gates = readGateReceipts(victim.dir, recordId)
    if (gates === undefined && existsSync(join(victim.dir, 'evidence/gates.jsonl'))) {
      throw new Error('Policy approval evidence is unreadable')
    }
    const prior = (gates ?? []).filter(row => 'gate' in row && row.gate === 3
      && row.policyApproval?.proposalId === change.id)
    if (prior.length > 1 || (prior.length === 1 && canonicalJson(prior[0]) !== canonicalJson(receipt))) {
      throw new Error('Policy approval evidence does not match the committed supersession')
    }
    return { victim, shelfScope, relPath, receipt, hasReceipt: prior.length === 1 }
  })
  const materialized = materializePolicy({ knowledgeRoot: writer.knowledgeRoot, recordId,
    scope: committed.shelfScope, ruleText: committed.victim.bundle.body,
    title: committed.victim.bundle.summary, writerAuthority: authority, existingOnly: true })
  if (materialized.kind !== 'unchanged') throw new Error('Committed policy section is unavailable')
  if (!committed.hasReceipt) await reviewStore(writer, change, authority).recordGateReceipt(committed.receipt)
  const commitReceipt: CommitReceipt = { schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: change.id,
    committedAtOrdinal: committed.receipt.producedAtOrdinal, recordIds: [recordId],
    gate3: [{ candidateId: recordId, receiptDigest: committed.receipt.receiptDigest }], promoted: [], held: [],
    policy: { recordId, scope: committed.shelfScope, relPath: committed.relPath, outcome: materialized.kind } }
  return { kind: 'applied', recordIds: [recordId], commitReceipt }
}

/** Apply one change under authority the caller already holds. Publishes nothing beyond the commit. */
async function writeReviewChange(
  writer: ReviewWriter, change: ReviewChange, authority: WriterAuthority,
): Promise<ReviewEffect> {
  if (change.verb === 'mark') return await applyMarkArm(writer, change, authority)
  if (change.verb === 'accept') {
    for (const recordId of targetRecordIds(change)) {
      const record = locateRecord(writer.knowledgeRoot, recordId)
      if (record?.bundle.frontmatter.kind === 'policy') {
        return await applyPolicyArm(writer, change, authority, recordId, record)
      }
    }
  }
  // Idempotent over the target's state: deprecating a tombstoned record answers a receipt only.
  if (deprecatesRecords(change) && alreadyTombstoned(writer.knowledgeRoot, change)) {
    const recordIds = targetRecordIds(change)
    // reject carries no receipt on any path; the record ids are the whole answer.
    if (change.verb !== 'forget') return { kind: 'applied', recordIds }
    // A retry of the same change answers its first receipt byte for byte.
    const recorded = readRecordedForgetReceipt(writer.knowledgeRoot, change.id)
    const recordedIds = recorded?.tombstonedRecords.map(row => row.recordId)
    if (recorded !== undefined && canonicalJson(recordedIds) === canonicalJson(recordIds)) {
      return { kind: 'applied', recordIds, forgetReceipt: recorded }
    }
    // If something else tombstoned these records, no commit ran here, so the scrub list is empty.
    const scrubbed = tombstonedByThisForget(writer.knowledgeRoot, change)
      ? FORGET_SCRUBBED_PROJECTIONS
      : []
    const forgetReceipt = assembleForgetReceipt(
      writer.knowledgeRoot, change, (writer.now ?? Date.now)(), scrubbed)
    recordForgetReceipt(writer.knowledgeRoot, authority, forgetReceipt)
    return { kind: 'applied', recordIds, forgetReceipt }
  }

  if (landedEffects(writer.knowledgeRoot, change) === undefined) {
    await commitInProcess(writer, change, authority)
  }
  const recordIds = targetRecordIds(change)
  if (change.verb !== 'forget') return { kind: 'applied', recordIds }
  const forgetReceipt = assembleForgetReceipt(
    writer.knowledgeRoot,
    change,
    (writer.now ?? Date.now)(),
    FORGET_SCRUBBED_PROJECTIONS,
  )
  recordForgetReceipt(writer.knowledgeRoot, authority, forgetReceipt)
  return { kind: 'applied', recordIds, forgetReceipt }
}

// A leaseholder never delegates, and this refuses both fields before any lease is asked for.
function assertSingleWritePath(
  input: { readonly writerAuthority?: unknown; readonly delegate?: unknown },
  entry: 'applyExplicitReview',
): void {
  if (input.writerAuthority !== undefined && input.delegate !== undefined) {
    throw new TypeError(
      `${entry} received both \`writerAuthority\` and \`delegate\`. A leaseholder never ` +
        'delegates: holding the writer lease is exactly what makes an in-process commit the ' +
        'only available path, so supply one or the other and never both.',
    )
  }
}

/**
 * Wait bounded for the delegate, and REFUSE rather than hang.
 *
 * `Promise.race` against a timer rather than an abort signal, because the transport is injected and
 * this module cannot assume it is cancellable. The consequence is stated rather than hidden: a
 * wedged holder's answer may still arrive after the refusal, and it is discarded — nothing was
 * applied here either way, so the worst case is a retry that finds the work already done. A hang
 * has no such worst case.
 */
async function withBoundedWait<T>(
  changeId: string,
  delegateTimeoutMs: number | undefined,
  call: () => Promise<T>,
): Promise<T> {
  const timeoutMs = delegateTimeoutMs ?? APPLY_DELEGATE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ApplyDelegateTimeoutError(changeId, timeoutMs)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A validated mark, accept, reject or forget, in the shape the review verbs already take. */
export type ExplicitReviewRequest = ReviewChangeRequest

/** What the writer-lease holder is handed: the same request and the same stable identity. */
export interface ExplicitReviewDelegation {
  readonly request: ExplicitReviewRequest
  readonly operationId: string
}

// Injected because this package must not know a socket exists; the leaseholder supplies none.
export type ExplicitReviewDelegate = (delegation: ExplicitReviewDelegation) => Promise<ExplicitReviewResult>

export interface ApplyExplicitReviewInput {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly request: ExplicitReviewRequest
  /**
   * The caller's stable identity for this change, such as a mark intent's UUID. A retry with the
   * same identity is the same change: its evidence tokens, receipts and record ids repeat.
   */
  readonly operationId: string
  /** The op making the change, stamped on Gate-3 receipts as `producedBy.opId`. */
  readonly opId: string
  /** The caller's actual context. Recorded as-is; explicit authority never rewrites it. */
  readonly executionContext: ExecutionContext
  readonly resolveBundleShortId?: ResolveBundleShortId
  readonly delegate?: ExplicitReviewDelegate
  readonly writerAuthority?: WriterAuthority
  readonly now?: () => number
  readonly delegateTimeoutMs?: number
}

export type ExplicitReviewResult =
  | {
      readonly outcome: 'applied'
      readonly verb: KnowledgeReviewVerb
      readonly changeId: string
      /** The records the change added, confirmed or tombstoned, read back after the write. */
      readonly recordIds: readonly string[]
      readonly commitReceipt?: CommitReceipt
      readonly forgetReceipt?: ForgetReceiptV1
    }
  | {
      readonly outcome: 'target-not-found'
      readonly verb: KnowledgeReviewVerb
      readonly changeId: string
      readonly target: KnowledgeTargetRef
    }
  | {
      readonly outcome: 'policy-materialize-refused'
      readonly verb: KnowledgeReviewVerb
      readonly changeId: string
    }

/** Validate at the boundary, before any lease is asked for or any request is delegated. */
function validatedRequest(request: ExplicitReviewRequest): ExplicitReviewRequest {
  switch (request.verb) {
    case 'accept':
      return { verb: 'accept', input: KnowledgeAcceptInputSchema.parse(request.input) }
    case 'reject':
      return { verb: 'reject', input: KnowledgeRejectInputSchema.parse(request.input) }
    case 'forget':
      return { verb: 'forget', input: KnowledgeForgetInputSchema.parse(request.input) }
    case 'mark':
      return { verb: 'mark', input: KnowledgeMarkInputSchema.parse(request.input) }
    default:
      throw new TypeError('an explicit knowledge change names accept, reject, forget or mark')
  }
}

/**
 * The change identity receipts carry, derived from the caller's operation identity. It keeps the
 * receipt id shape, so the same UUID a mark intent already holds names the same change here.
 */
function explicitChangeId(operationId: string): string {
  const parsed = typeof operationId === 'string'
    ? KnowledgeChangeIdSchema.safeParse(`prop_${operationId.toLowerCase()}`)
    : undefined
  if (parsed?.success !== true) {
    throw new TypeError(
      'operationId must be a stable identity of letters, digits and single hyphens, such as a UUID',
    )
  }
  return parsed.data
}

async function applyExplicitAsHolder(
  writer: ReviewWriter,
  request: ExplicitReviewRequest,
  changeId: string,
  authority: WriterAuthority,
  resolveBundleShortId: ResolveBundleShortId | undefined,
): Promise<ExplicitReviewResult> {
  const target = request.input.target
  const resolved = resolveReviewTarget(writer.knowledgeRoot, target, resolveBundleShortId)
  if (resolved === undefined) return { outcome: 'target-not-found', verb: request.verb, changeId, target }
  const change: ReviewChange = {
    id: changeId,
    verb: request.verb,
    deltas: reviewDeltasFor(request, resolved, changeId),
    ...(request.verb === 'mark' ? { mark: (request.input as KnowledgeMarkInput).mark } : {}),
  }
  const effect = await writeReviewChange(writer, change, authority)
  if (effect.kind === 'policy-materialize-refused') {
    return { outcome: 'policy-materialize-refused', verb: request.verb, changeId }
  }
  return {
    outcome: 'applied',
    verb: request.verb,
    changeId,
    recordIds: [...effect.recordIds],
    ...(effect.commitReceipt === undefined ? {} : { commitReceipt: effect.commitReceipt }),
    ...(effect.forgetReceipt === undefined ? {} : { forgetReceipt: effect.forgetReceipt }),
  }
}

// A live holder gets the same request and identity, bounded, and is never stolen from.
export async function applyExplicitReview(input: ApplyExplicitReviewInput): Promise<ExplicitReviewResult> {
  assertSingleWritePath(input, 'applyExplicitReview')
  const request = validatedRequest(input.request)
  const changeId = explicitChangeId(input.operationId)
  if (typeof input.opId !== 'string' || input.opId.length === 0) {
    throw new TypeError('applyExplicitReview needs the op id that makes the change')
  }
  const writer: ReviewWriter = {
    knowledgeRoot: input.knowledgeRoot,
    executionContext: input.executionContext,
    opId: input.opId,
    ...(input.now === undefined ? {} : { now: input.now }),
  }
  if (input.writerAuthority !== undefined) {
    return await applyExplicitAsHolder(writer, request, changeId, input.writerAuthority,
      input.resolveBundleShortId)
  }
  const acquired = acquireWriterLease(input.knowledgeRoot)
  if (acquired.kind === 'held') {
    const delegate = input.delegate
    if (delegate === undefined) throw new ApplyDelegateUnavailableError(changeId, acquired.holder)
    return await withBoundedWait(changeId, input.delegateTimeoutMs,
      () => delegate({ request, operationId: input.operationId }))
  }
  if (acquired.kind !== 'acquired') throw acquired.error
  try {
    return await applyExplicitAsHolder(writer, request, changeId, acquired, input.resolveBundleShortId)
  } finally {
    // An applied change is never reported as failed because the release after it threw.
    releaseLeaseAfterWork({ knowledgeRoot: input.knowledgeRoot, leaseId: acquired.leaseId })
  }
}
