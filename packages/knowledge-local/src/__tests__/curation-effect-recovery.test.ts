import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, asEvidenceToken, asRecordId, type BundleDraft, type Delta } from '@vostride/agent-qa-schema'
import * as bundleAppend from '../bundle-append.js'
import { loadBundle } from '../bundle-read.js'
import { commitCurationDelta, type CommitCurationDependencies, type CommitCurationJob } from '../curator/commit.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION } from '../curator/author-contract.js'
import type { AuthoredDeltaCheckpoint } from '../curator/author-contract.js'
import { claimNextJob } from '../queue/curation-queue.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'

import {
  COMMIT_INTENT_SCHEMA_VERSION,
  commitIntentSchema,
  listCommitIntents,
  writeCommitIntent,
} from '../journal/intent-journal.js'
import { clearCommitIntent } from '../journal/intent-journal.js'
import { acquireWriterLease, releaseLease } from '../lease/writer-lease.js'
import { readJobState, writeJobState } from '../queue/job-state.js'
import { reconcileOnDrainStart } from '../journal/reconcile.js'
import { applyIndexDeltaForBundleWithinCurrentAuthority } from '../curator/commit.js'
import { enumerateBundleDirs } from '../bundle-scan.js'
import {
  COMPLETED_EFFECTS_SUBDIR,
  curationEffectReceiptSchema,
  effectIdentity,
  listCurationEffectReceipts,
  writeCurationEffectReceipt,
  receiptForEffect,
  type CurationObservation,
} from '../journal/curation-effect-receipt.js'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'curation-recovery-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function commitFixture() {
  const root = temporaryRoot()
  const lease = acquireWriterLease(root)
  if (lease.kind !== 'acquired') throw new Error('expected fresh lease')
  const authority = { leaseId: lease.leaseId, epoch: lease.epoch }
  const deps: CommitCurationDependencies = { knowledgeRoot: root, epoch: lease.epoch,
    profile: { mode: 'propose-only' }, drainState: { supersedesSeenByAnchorKey: new Map() } }
  function draft(name: string): BundleDraft {
    return { kind: 'fact', subtype: 'selector', anchors: [{ t: 'el', role: 'button', name }, { t: 'page', route: '/checkout' }, { t: 'selector', literal: '[data-testid="checkout"]' }],
      scope: { tier: 'product', key: 'storefront' }, summary: `${name} selector`, body: `${name} verified`,
      distilledEvidenceRef: { id: 'synthetic-evidence', sha: 'a'.repeat(64) }, originStage: 'run-curation' }
  }
  function job(name: string, ordinal: number): CommitCurationJob {
    const bundle = draft(name)
    const enqueued = enqueueArtifactFreeCandidateProjection({ knowledgeRoot: root, projectionInput: {
      sourceRunId: `synthetic-run-${ordinal}`, scope: bundle.scope, buildOrdinal: ordinal, executionContext: 'ci',
      kind: 'fact', subtype: 'selector', anchors: bundle.anchors, summarySeed: bundle.summary, bodySeed: bundle.body,
      distilledObservations: [{ schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION, step: { naturalKey: 'checkout', ordinal: 0 }, platform: 'web', element: { naturalKey: `button:${name}` }, observedAtOrdinal: ordinal }],
      evidenceToken: `synthetic-evidence-${ordinal}`, attributingObservationId: `synthetic-observation-${ordinal}`, emittedAt: '2026-09-14T00:00:00.000Z',
    } })
    if (enqueued.kind !== 'enqueued') throw new Error('expected enqueued candidate')
    const claimed = claimNextJob({ knowledgeRoot: root, authority, leaseId: authority.leaseId })
    if (claimed?.kind !== 'claimed') throw new Error('expected claimed candidate')
    return claimed
  }
  function checkpoint(delta: Delta): AuthoredDeltaCheckpoint {
    return { schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION, delta, neighborIds: [...delta.citedIds], preconditions: [...(delta.precondition ?? [])],
      authorship: { path: 'llm', model: { id: 'synthetic-curator' }, executionContext: 'ci' } }
  }
  const victimJob = job('Checkout', 42)
  const add: Delta = { kind: 'Add', origin: 'agent', scope: draft('Checkout').scope, citedIds: [], bundle: draft('Checkout') }
  const victim = commitCurationDelta(deps, victimJob, checkpoint(add))
  if (victim.kind !== 'applied') throw new Error(`expected victim Add: ${victim.kind}`)
  const claimed = job('Purchase', 43)
  const supersede: Delta = { kind: 'Supersede', origin: 'agent', scope: draft('Purchase').scope, citedIds: [victim.bundleId],
    precondition: [{ recordId: victim.bundleId, observedStatus: 'candidate', observedOrdinal: 42 }],
    victimId: victim.bundleId, newBundle: draft('Purchase'), evidenceToken: asEvidenceToken(claimed.payload.evidenceToken) }
  const rows = () => listCurationEffectReceipts(root).filter((row) => row.candidateId === claimed.candidateId)
  return { root, authority, deps, claimed, supersede, victim, victimJob, add, draft, job, checkpoint, rows }
}

describe('curation effect recovery', () => {
  function reopen(f: ReturnType<typeof commitFixture>) {
    expect(releaseLease({ knowledgeRoot: f.root, leaseId: f.authority.leaseId }).kind).toBe('released')
    const lease = acquireWriterLease(f.root)
    if (lease.kind !== 'acquired') throw new Error('expected successor lease')
    expect(lease.epoch).toBeGreaterThan(f.authority.epoch)
    return { leaseId: lease.leaseId, epoch: lease.epoch }
  }
  function reconcile(f: ReturnType<typeof commitFixture>, authority = f.authority) {
    return reconcileOnDrainStart({ knowledgeRoot: f.root, writerAuthority: authority,
      hasIndexRow: () => true,
      applyIndexDelta: (intent) => applyIndexDeltaForBundleWithinCurrentAuthority({ knowledgeRoot: f.root, bundleId: intent.bundleId }),
      deriveIndexRowFromBundle: (bundleId) => applyIndexDeltaForBundleWithinCurrentAuthority({ knowledgeRoot: f.root, bundleId }),
    })
  }
  function bundleBytes(root: string) {
    return enumerateBundleDirs(root).map(({ dir }) => [dir, readFileSync(join(dir, 'manifest.json'), 'utf8'), readFileSync(join(dir, 'evidence/outcomes.jsonl'), 'utf8')])
  }
  it.each([
    ['CRASH-AFTER-COMMIT', 'afterBundlePublished'],
    ['CRASH-AFTER-RECEIPT', 'afterEffectReceiptsWritten'],
    ['CRASH-BEFORE-OUTER-CHECKPOINT', 'afterIntentCleared'],
  ] as const)('%s recovers identical classification under a newer epoch', (_name, hook) => {
    const f = commitFixture()
    let observation: CurationObservation | undefined
    const crash = () => { throw new Error('synthetic-interruption') }
    expect(() => commitCurationDelta({ ...f.deps, hooks: {
      afterIntentWritten: () => {
        const entry = listCommitIntents(f.root)[0]
        if (entry !== undefined && 'parsed' in entry) observation = entry.parsed.observation
      }, [hook]: crash,
    } }, f.claimed, f.checkpoint(f.supersede))).toThrow('synthetic-interruption')
    expect(observation).toBeDefined()
    const expected = observation!.effects.map((effect) => receiptForEffect(f.claimed.candidateId, observation!, effect))
    const before = bundleBytes(f.root)
    const successor = reopen(f)
    reconcile(f, successor)
    expect(f.rows()).toEqual(expected)
    expect(bundleBytes(f.root)).toEqual(before)
    const retry = claimNextJob({ knowledgeRoot: f.root, leaseId: successor.leaseId, authority: successor })
    if (retry?.kind === 'claimed') {
      const outcome = commitCurationDelta({ ...f.deps, epoch: successor.epoch }, retry, f.checkpoint(f.supersede))
      expect(outcome.kind).toBe('noop')
      expect(readJobState(f.root, retry.candidateId).kind).toBe('absent')
      expect(bundleBytes(f.root)).toEqual(before)
      expect(f.rows()).toEqual(expected)
    }
    const receipts = readdirSync(join(f.root, COMPLETED_EFFECTS_SUBDIR)).map((name) => readFileSync(join(f.root, COMPLETED_EFFECTS_SUBDIR, name), 'utf8'))
    reconcile(f, successor)
    expect(f.rows()).toEqual(expected)
    expect(readdirSync(join(f.root, COMPLETED_EFFECTS_SUBDIR)).map((name) => readFileSync(join(f.root, COMPLETED_EFFECTS_SUBDIR, name), 'utf8'))).toEqual(receipts)
  })
  it('CRASH-BEFORE-PUBLICATION contributes no successfully committed row', () => {
    const f = commitFixture()
    expect(() => commitCurationDelta({ ...f.deps, hooks: { beforePublishRename: () => { throw new Error('synthetic-before-publish') } } }, f.claimed, f.checkpoint(f.supersede))).toThrow('synthetic-before-publish')
    reconcile(f, reopen(f))
    expect(f.rows()).toEqual([])
  })
  it('RESTART-REFOLD reads completed effects after candidate state was deleted', () => {
    const f = commitFixture()
    const outcome = commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    expect(outcome.kind).toBe('downgraded')
    expect(readJobState(f.root, f.claimed.candidateId).kind).toBe('absent')
    expect(existsSync(f.claimed.candidateDir)).toBe(false)
    const before = f.rows()
    expect(before).toHaveLength(1)
    reconcile(f, reopen(f))
    expect(f.rows()).toEqual(before)
  })
  it('STALE-EPOCH-EFFECT refuses old writers creating or overwriting receipts', () => {
    const f = commitFixture()
    commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    const row = f.rows()[0]!
    reopen(f)
    const options = { knowledgeRoot: f.root, authority: f.authority, receipt: row }
    expect(() => writeCurationEffectReceipt(options)).toThrow()
    expect(() => writeCurationEffectReceipt({ ...options, receipt: { ...row, sourceRunId: 'foreign' } })).toThrow()
    const newEffect = { recordId: 'fact-new', product: 'storefront', change: 'added' as const, atOrdinal: 44, evidenceToken: 'synthetic-new' }
    expect(() => writeCurationEffectReceipt({ ...options, receipt: { ...row, ...newEffect, effectId: effectIdentity(row.candidateId, newEffect) } })).toThrow()
    expect(f.rows()).toEqual([row])
  })
  it('DOWNGRADE-PROPOSE-ONLY retains original Supersede while ordinary Add stays added', () => {
    const f = commitFixture()
    const before = readFileSync(join(f.victim.bundleDir, 'manifest.json'))
    const outcome = commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    expect(outcome).toMatchObject({ kind: 'downgraded', deltaKind: 'Add', original: f.supersede, reason: 'propose-only' })
    expect(f.rows()).toMatchObject([{ originalDeltaKind: 'Supersede', appliedDeltaKind: 'Add', disposition: 'downgraded', change: 'added' }])
    expect(listCurationEffectReceipts(f.root).filter((r) => r.candidateId === f.victimJob.candidateId)).toMatchObject([{ originalDeltaKind: 'Add', disposition: 'apply', change: 'added' }])
    expect(readFileSync(join(f.victim.bundleDir, 'manifest.json'))).toEqual(before)
  })
  it('DOWNGRADE-VALIDATION retains validation origin without a proposal relation heuristic', () => {
    const f = commitFixture()
    if (f.supersede.kind !== 'Supersede') throw new Error('fixture Supersede')
    const invalid = { ...f.supersede, victimId: asRecordId('missing-victim'), citedIds: [asRecordId('missing-victim')] }
    const outcome = commitCurationDelta({ ...f.deps, profile: { mode: 'drain-to-active' } }, f.claimed, f.checkpoint(invalid))
    expect(outcome).toMatchObject({ kind: 'downgraded', original: invalid })
    expect(f.rows()).toMatchObject([{ originalDeltaKind: 'Supersede', disposition: 'downgraded', downgradeReason: 'cited-id-integrity' }])
  })
  it('DOWNGRADE-EXISTING preserves original disposition when publication becomes confirmation', () => {
    const f = commitFixture()
    commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    const again = f.job('Purchase', 44)
    const outcome = commitCurationDelta(f.deps, again, f.checkpoint(f.supersede))
    expect(outcome).toMatchObject({ kind: 'downgraded', original: f.supersede, reason: 'propose-only' })
    expect(listCurationEffectReceipts(f.root).filter((row) => row.candidateId === again.candidateId)).toMatchObject([
      { originalDeltaKind: 'Supersede', disposition: 'downgraded', change: 'confirmed' },
    ])
  })
  it('DEPRECATE-PROPOSED distinguishes clarification from ordinary MintUnknown', () => {
    const f = commitFixture()
    const delta: Delta = { kind: 'Deprecate', origin: 'agent', scope: f.supersede.scope, citedIds: [f.victim.bundleId], targetId: f.victim.bundleId, reason: 'synthetic-reason' }
    const outcome = commitCurationDelta(f.deps, f.claimed, f.checkpoint(delta))
    expect(outcome).toMatchObject({ kind: 'downgraded', original: delta, deltaKind: 'MintUnknown' })
    expect(f.rows()).toMatchObject([{ originalDeltaKind: 'Deprecate', appliedDeltaKind: 'MintUnknown', disposition: 'downgraded' }])
    const loaded = loadBundle(f.victim.bundleDir)
    expect(loaded.kind === 'loaded' && loaded.bundle.events.some((e) => e.type === 'deprecated')).toBe(false)
    const ordinaryJob = f.job('Question', 44)
    const ordinary: Delta = { kind: 'MintUnknown', origin: 'agent', scope: delta.scope, citedIds: [], conflict: { recordIds: [], kind: 'clarification' } }
    expect(commitCurationDelta(f.deps, ordinaryJob, f.checkpoint(ordinary)).kind).toBe('applied')
    expect(listCurationEffectReceipts(f.root).filter((row) => row.candidateId === ordinaryJob.candidateId)).toMatchObject([
      { originalDeltaKind: 'MintUnknown', appliedDeltaKind: 'MintUnknown', disposition: 'apply', change: 'added' },
    ])
  })
  it('COMMIT-PARTIAL-EFFECTS records replacement publication but no refused victim effect', () => {
    const f = commitFixture()
    const original = bundleAppend.appendOutcomeEvent
    vi.spyOn(bundleAppend, 'appendOutcomeEvent').mockImplementation((config, id, event) => event.type === 'superseded' ? { kind: 'not-found' } : original(config, id, event))
    const outcome = commitCurationDelta({ ...f.deps, profile: { mode: 'drain-to-active' } }, f.claimed, f.checkpoint(f.supersede))
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'append-failed' })
    expect(f.rows()).toMatchObject([{ change: 'added', originalDeltaKind: 'Supersede' }])
    expect(f.rows().some((row) => row.recordId === f.victim.bundleId)).toBe(false)
  })
  function receipt() {
    const effect = { recordId: 'fact-fixture', change: 'added' as const, atOrdinal: 42, evidenceToken: 'synthetic-token', product: 'storefront' }
    const candidateId = 'a'.repeat(64)
    return { schemaVersion: 2 as const, candidateId, effectId: effectIdentity(candidateId, effect), ...effect,
      sourceRunId: 'synthetic-run', observationId: 'synthetic-observation', originalDeltaKind: 'Supersede' as const,
      appliedDeltaKind: 'Add' as const, disposition: 'downgraded' as const, downgradeReason: 'propose-only' }
  }
  function writer(root: string) {
    const lease = acquireWriterLease(root)
    if (lease.kind !== 'acquired') throw new Error('fixture requires fresh lease')
    return { leaseId: lease.leaseId, epoch: lease.epoch }
  }
  it('EFFECT-READ-NOTHING reads absence without creating any directory', () => {
    const root = join(temporaryRoot(), 'absent')
    expect(listCurationEffectReceipts(root)).toEqual([])
    expect(existsSync(root)).toBe(false)
  })
  it('EFFECT-RECEIPT-ROUNDTRIP survives intent and done-state cleanup', () => {
    const root = temporaryRoot()
    const authority = writer(root)
    const row = receipt()
    writeCurationEffectReceipt({ knowledgeRoot: root, authority, receipt: row })
    writeCommitIntent(root, { schemaVersion: COMMIT_INTENT_SCHEMA_VERSION, candidateId: row.candidateId, bundleId: row.recordId, deltaKind: 'Add', epoch: authority.epoch })
    clearCommitIntent(root, row.candidateId)
    writeJobState({ knowledgeRoot: root, authority, candidateId: row.candidateId, lifecycle: 'done' })
    expect(listCurationEffectReceipts(root)).toEqual([row])
    for (const invalid of [{ ...row, schemaVersion: 9 }, { ...row, unexpected: true }, { ...row, candidateId: '../escape' }, { ...row, effectId: 'f'.repeat(64) }]) {
      expect(curationEffectReceiptSchema.safeParse(invalid).success).toBe(false)
    }
  })
  it('EFFECT-IDEMPOTENT keeps exact bytes and refuses conflicting or malformed receipts', () => {
    const root = temporaryRoot()
    const authority = writer(root)
    const row = receipt()
    const options = { knowledgeRoot: root, authority, receipt: row }
    writeCurationEffectReceipt(options)
    const dir = join(root, COMPLETED_EFFECTS_SUBDIR)
    const file = join(dir, readdirSync(dir)[0]!)
    const before = readFileSync(file)
    writeCurationEffectReceipt(options)
    expect(readFileSync(file)).toEqual(before)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(() => writeCurationEffectReceipt({ ...options, receipt: { ...row, sourceRunId: 'foreign' } })).toThrow('conflicting')
    writeFileSync(file, '{"schemaVersion":99}')
    expect(() => listCurationEffectReceipts(root)).toThrow('invalid curation effect receipt')
  })
  it('EFFECT-LISTING-IGNORES-FOREIGN skips non-receipt entries while a malformed canonical receipt still refuses', () => {
    const root = temporaryRoot()
    const authority = writer(root)
    const row = receipt()
    writeCurationEffectReceipt({ knowledgeRoot: root, authority, receipt: row })
    const dir = join(root, COMPLETED_EFFECTS_SUBDIR)
    const canonical = join(dir, readdirSync(dir)[0]!)
    writeFileSync(join(dir, '.DS_Store'), 'Bud1')
    writeFileSync(join(dir, 'notes.txt'), 'operator notes')
    mkdirSync(join(dir, `${'b'.repeat(64)}-${'c'.repeat(64)}.json`))
    expect(() => listCurationEffectReceipts(root)).not.toThrow()
    expect(listCurationEffectReceipts(root)).toEqual([row])
    writeFileSync(canonical, '{"torn":')
    expect(() => listCurationEffectReceipts(root)).toThrow('invalid curation effect receipt')
  })
  it('INTENT-OBSERVATION-OPTIONAL reads an intent without an observation and one carrying the original disposition', () => {
    const root = temporaryRoot()
    const bare = { schemaVersion: COMMIT_INTENT_SCHEMA_VERSION as typeof COMMIT_INTENT_SCHEMA_VERSION, candidateId: 'a'.repeat(64), bundleId: 'fixture', deltaKind: 'Add' as const, epoch: 1 }
    writeCommitIntent(root, bare)
    expect(listCommitIntents(root)).toEqual([{ parsed: bare }])
    expect(commitIntentSchema.safeParse({ ...bare, schemaVersion: 99 }).success).toBe(false)
    expect(commitIntentSchema.safeParse({ ...bare, observation: { schemaVersion: 99 } }).success).toBe(false)
    const observation = { schemaVersion: 2, effects: [], originalDeltaKind: 'Supersede', appliedDeltaKind: 'Add', disposition: 'downgraded', downgradeReason: 'propose-only', sourceRunId: 'synthetic-run', observationId: 'synthetic-observation' }
    const parsed = commitIntentSchema.safeParse({ ...bare, observation })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual({ ...bare, observation })
  })
})
