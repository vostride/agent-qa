// Apply: the ONE path a knowledge change's bytes take.
//
// An explicit mark, accept, reject or forget applies in the call. The caller's stable
// operation identity is the change identity, so a retry is the same change: its evidence tokens,
// receipts and record ids repeat and nothing lands twice. Every change routes its deltas through the
// Curator's `commit()` — the same epoch-fenced path every curation write takes — and the receipt is
// assembled around the commit from the disposition outcome plus post-commit reads.
//
// LEASE ROUTING is decided by `acquireWriterLease` itself rather than by a classification
// this module performs first. That is deliberate: a read-then-decide would have a window between
// the read and the acquire, and the primitive already refuses a fresh holder. So "the lease is
// held by somebody alive" arrives here as an ordinary `held` outcome, and the caller delegates the
// same validated request and identity to the holder, bounded. There is no code path in this file
// that acquires when a live holder exists, because there is no second acquisition primitive.
//
// An explicit change is authority in every execution context, so it writes through the store's
// narrow explicit entry, which skips only the automatic propose-only downgrade and keeps the actual
// ExecutionContext on every durable record. Delta validation and every promotion gate still apply.
//
// the proposal door is deleted with the inbox — the claim by atomic
// rename, the applied/rejected publication, the in-flight wait and the restore-to-pending on failure.
// Old proposal files are never read again.

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

/**
 * How long a delegating process waits for the leaseholder to finish an apply.
 *
 * PINNED, not configured, on the `LEASE_HEARTBEAT_TTL_MS` idiom. 30s is chosen as "longer than any
 * commit this store performs, shorter than a person's patience": a commit is a handful of file
 * appends plus one bundle re-projection, all local. RETUNE from an observed apply that legitimately
 * exceeded it — never from a flaky test, which is a symptom of a wedged holder rather than a slow
 * one, and the wedged holder is exactly what this bound exists to refuse rather than wait out.
 */
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
        `${changeId} cannot be applied here. Lease-stealing is structurally refused (386 D-14).`,
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

/**
 * One review change: a validated direct request. `id` is the receipt identity, derived from
 * the caller's stable operation identity.
 */
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

/**
 * The delta kind a review verb emits when it means "this record stops standing".
 *
 * BOTH `reject` and `forget` emit it (propose-review.ts:183-195 — identical `Deprecate` deltas
 * differing only in the recorded reason), so the guard below is keyed on the kind rather than on
 * either verb's name.
 *
 * WHAT THE GUARD BELOW IS, and the previous version of this comment got it wrong, so it is
 * stated plainly: it is an IDEMPOTENCY short-circuit. A deprecating change over an already
 * tombstoned target has nothing left to destroy, and the honest answer is a receipt naming the
 * state that already holds rather than a second destructive change (FUNC-04's adjacency edge,
 * D-19's "nothing silently partial").
 *
 * WHAT IT IS NOT: the owner of the unauthored-mint hazard. This comment used to claim the guard's
 * kind-scoping was what stopped a clone being minted, and round 1's verifier measured that claim
 * false by reproducing the identical mint through `accept` — which emits a `Confirm` and walks
 * straight past everything in this file. The hazard lives one layer down, at the curator's
 * `checkCitedIdIntegrity`, whose id domain is `deltaTargetIds` = cited ids ∪ target/victim/
 * conflict ids — strictly wider than `targetRecordIds` below, which reads only `delta.targetId`.
 * Every review delta of every verb passes through that one check funnel regardless of its kind,
 * which is why the closure had to land there and not here: see
 * `UserDeltaCitationIntegrityError` and the origin-keyed fallback table beside it in
 * `curator/disposition.ts`, where a user-authored delta whose citation cannot be honoured is
 * refused by type instead of degraded into minted content.
 */
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

/**
 * Whether every record a deprecating change addresses is ALREADY tombstoned.
 *
 * `every`, not `some`: a bundle-grained verb over a partially-tombstoned set still has work to
 * do, and treating it as complete would be the silent partiality D-19 forbids.
 *
 * Judged through the SHARED mapping rather than a table local to this module. The local
 * table this replaced named `withdrawn` and `retired` — neither is a `BundleStatus` member, so
 * both were dead weight — and the shared one is `satisfies Record<BundleStatus, …>`, which makes
 * a fifth member a compile error here instead of a status that silently reads as untombstoned.
 */
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

/**
 * The effects of a Confirm or Add change that already landed (432-06 retry), or `undefined`.
 *
 * Each delta's committed event carries an evidence token derived from the delta itself, but the
 * curation job id that dedups the append is derived from the build ordinal, so a retried change
 * would land as a second, distinct event. A plain read: the caller already holds the writer
 * lease, so nothing can land in between, and entering the authority fence here would move lease
 * bookkeeping on a change that then refuses. Partial effects are refused by type, exactly as a
 * partial supersession is.
 */
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

/**
 * Build the forget receipt from POST-COMMIT reads, never from the preview.
 *
 * The preview says what would happen; the receipt must say what did. Copying the preview forward
 * would have produced a receipt that is always right by construction and therefore evidence of
 * nothing — including in the one case that matters, where the commit tombstoned less than the
 * preview predicted.
 *
 * `projectionsScrubbed` is a PARAMETER for the same reason. It used to be the constant
 * scrub set spliced in unconditionally, which made the receipt right by construction on the one
 * path where it was wrong: the short-circuit runs no commit, so no projection is rebuilt and no
 * recall row is removed, and a receipt naming three scrubs there asserts work nobody performed.
 * `scrubSetSchema` (schema/src/knowledge/change.ts) declares this field a SUBSET of the
 * scrub set with no minimum length, so the empty list is the honest, already-legal answer.
 */
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
  // FUNC-04's adjacency edge, decided BEFORE the commit rather than hoped for after it.
  //
  // Deprecating an already-tombstoned record must be "a receipt naming the already-tombstoned
  // state, never a second destructive change", and that is ALL this branch does. Idempotency
  // lives here, over the target's STATE rather than only over the change id, because rejecting
  // the same record twice is the most ordinary repetition a review invites.
  //
  // CORRECTED, because the earlier version of this comment claimed more than it delivers: this
  // branch is NOT what stops an unauthored clone being minted. It cannot be — it is reachable
  // only for a change that deprecates, and round 1's verifier reproduced the identical mint
  // through `accept`, whose `Confirm` never enters here. The mint is the curator's response to
  // a cited-id-integrity failure, and it is refused at that check now, for every review delta
  // of every kind, by `UserDeltaCitationIntegrityError`. What is true and worth keeping: the
  // clone really is a verbatim copy of the target's anchors, scope and summary republished as
  // a fresh `candidate`, which `isEligibleCandidate` (serving/brief-selection.ts:142-151)
  // re-admits into serving — that is why the refusal, not merely a no-op, is the right answer.
  if (deprecatesRecords(change) && alreadyTombstoned(writer.knowledgeRoot, change)) {
    const recordIds = targetRecordIds(change)
    // reject carries no receipt on any path; the record ids are the whole answer.
    if (change.verb !== 'forget') return { kind: 'applied', recordIds }
    // 2026-10-02 (quick 261002-lse, 432-16 #3): a retry of the SAME change answers the receipt its
    // first application recorded, byte for byte, as reject's retry already answers its record ids.
    const recorded = readRecordedForgetReceipt(writer.knowledgeRoot, change.id)
    const recordedIds = recorded?.tombstonedRecords.map(row => row.recordId)
    if (recorded !== undefined && canonicalJson(recordedIds) === canonicalJson(recordIds)) {
      return { kind: 'applied', recordIds, forgetReceipt: recorded }
    }
    // when something ELSE tombstoned these records, no commit ran for this change, so no
    // projection was rebuilt and no recall row was removed. The scrub list is EMPTY because that
    // is what happened. A tombstone this change itself committed (its receipt was never recorded)
    // did scrub them, and says so.
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

/**
 * A leaseholder never delegates, and the input may not claim to be both.
 *
 * The two fields are mutually exclusive by MEANING: `writerAuthority` says "I hold the lease and
 * will commit in this process", `delegate` says "somebody else holds it and here is how to reach
 * them". Supplying both was previously refused only by reading the code — the authority branch
 * is taken first and returns, so a caller that passed both silently got the in-process commit and
 * never learned its delegate was ignored. A source-scan-only rule is one refactor away from being
 * untrue; this makes it structural, and it fires before any lease is asked for.
 */
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

// ---- 432-06: the direct door ------------------------------------------------------------------

/** A validated mark, accept, reject or forget, in the shape the review verbs already take. */
export type ExplicitReviewRequest = ReviewChangeRequest

/** What the writer-lease holder is handed: the same request and the same stable identity. */
export interface ExplicitReviewDelegation {
  readonly request: ExplicitReviewRequest
  readonly operationId: string
}

/**
 * Hand the direct request to the leaseholder and wait bounded for its answer. Injected as
 * an optional operation rather than built here: `knowledge-local` neither knows nor may know that a
 * unix socket exists. A host supplies its transport; the leaseholder's own composition supplies
 * nothing, which makes delegation recursion impossible by construction.
 */
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

/**
 * Apply an explicit knowledge change in the call.
 *
 * No envelope is written, claimed or reloaded. A holder commits with its own authority, a free lease is acquired and released, and a live holder is
 * handed the same validated request and identity, bounded, and is never stolen from. Retrying
 * the same `operationId` lands nothing twice and answers the same record ids.
 */
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
