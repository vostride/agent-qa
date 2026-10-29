import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, asEvidenceToken, asRecordId, CurationSnapshotSchema, type BundleDraft, type Delta, type RecordChange, RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { diffSince } from '../diff-since.js'
import * as bundleAppend from '../bundle-append.js'
import { loadBundle } from '../bundle-read.js'
import { commitCurationDelta, type CommitCurationDependencies, type CommitCurationJob } from '../curator/commit.js'
import type { AuthoredDeltaCheckpoint } from '../curator/author-contract.js'
import { claimNextJob } from '../queue/curation-queue.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'

import { commitIntentSchema, listCommitIntents, writeCommitIntent } from '../journal/intent-journal.js'
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
  const root = mkdtempSync(join(tmpdir(), '423-curation-snapshot-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function commitFixture(executionContext: 'ci' | 'local-interactive' = 'ci') {
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
      sourceRunId: `synthetic-run-${ordinal}`, scope: bundle.scope, buildOrdinal: ordinal, executionContext,
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

import * as curationSnapshotModule from '../curator/curation-snapshot.js'
import { foldCurationSnapshot, readCurationEffects } from '../curator/curation-snapshot.js'
import { drainQueue } from '../curator/drain.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION } from '../curator/author-contract.js'

function snapshot(f: ReturnType<typeof commitFixture>, run = 'synthetic-run-43') {
  return foldCurationSnapshot(readCurationEffects({ knowledgeRoot: f.root, sourceRunId: run }))
}

function fiveBucketFixture() {
  const f = commitFixture()
  const active = { ...f.deps, profile: { mode: 'drain-to-active' as const } }
  expect(commitCurationDelta(active, f.claimed, f.checkpoint(f.supersede)).kind).toBe('applied')
  // Reuse one run attribution across distinct candidates, with independent historical ordinals.
  const commit = (name: string, ordinal: number, make: (job: CommitCurationJob) => Delta, proposed = false) => {
    const j = f.job(name, ordinal)
    j.payload.sourceRunId = 'synthetic-run-43'
    const result = commitCurationDelta(proposed ? f.deps : active, j, f.checkpoint(make(j)))
    expect(['applied', 'converted-confirm', 'downgraded'], `${name}: ${JSON.stringify(result)}`).toContain(result.kind)
    return result
  }
  commit('New', 44, () => ({ ...f.add, bundle: f.draft('New') }))
  const oldConfirm = f.job('Existing', 45)
  const existing = commitCurationDelta(active, oldConfirm, f.checkpoint({ ...f.add, bundle: f.draft('Existing') }))
  if (existing.kind !== 'applied') throw new Error('fixture existing Add')
  for (const ordinal of [46, 47]) commit('Reinforce', ordinal, (j) => ({ kind: 'Confirm', origin: 'agent', scope: f.add.scope,
    citedIds: [existing.bundleId], targetId: existing.bundleId, evidenceToken: asEvidenceToken(j.payload.evidenceToken) }))
  const oldDeprecate = f.job('Retire', 48)
  const retiring = commitCurationDelta(active, oldDeprecate, f.checkpoint({ ...f.add, bundle: f.draft('Retire') }))
  if (retiring.kind !== 'applied') throw new Error('fixture retired Add')
  commit('Retired', 49, () => ({ kind: 'Deprecate', origin: 'agent', scope: f.add.scope, citedIds: [retiring.bundleId], targetId: retiring.bundleId, reason: 'synthetic retired' }))
  commit('Held', 50, () => ({ ...f.supersede, precondition: [], newBundle: f.draft('Held') } as Delta), true)
  return f
}

describe('curation snapshot', () => {
  it('REPLACEMENT-INDEPENDENT-CONFIRM keeps actual confirmation after suppressing only replacement Add', () => {
    const f = commitFixture()
    const active = { ...f.deps, profile: { mode: 'drain-to-active' as const } }
    const result = commitCurationDelta(active, f.claimed, f.checkpoint(f.supersede))
    if (result.kind !== 'applied') throw new Error('expected Supersede')
    const initial = readCurationEffects({ knowledgeRoot: f.root, sourceRunId: 'synthetic-run-43' })
    expect(foldCurationSnapshot([...initial, ...initial]).rows).toHaveLength(1)
    const confirmJob = f.job('Purchase', 44)
    confirmJob.payload.sourceRunId = 'synthetic-run-43'
    const confirm: Delta = { kind: 'Confirm', origin: 'agent', scope: f.add.scope,
      citedIds: [result.bundleId], targetId: result.bundleId, evidenceToken: asEvidenceToken(confirmJob.payload.evidenceToken) }
    expect(commitCurationDelta(active, confirmJob, f.checkpoint(confirm)).kind).toBe('applied')
    const folded = snapshot(f)
    expect(folded.breakdown).toEqual({ added: 0, confirmed: 1, superseded: 1, deprecated: 0, proposed: 0 })
    expect(folded.rows.flatMap(row => row.changes)).toHaveLength(3)
    expect(folded.rows.find(row => row.recordId === result.bundleId)?.changes).toEqual([
      expect.objectContaining({ bucket: 'confirmed', change: expect.objectContaining({ atOrdinal: 44 }) }),
    ])
  })
  it('CURATION-FIVE-BUCKETS counts five actual affected units and suppresses replacement Add', () => {
    const f = fiveBucketFixture()
    const result = snapshot(f)
    expect(result.breakdown).toEqual({ added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 })
    expect(result.rows).toHaveLength(5)
    expect(result.rows.find(r => r.bucket === 'superseded')?.changes.some(e => e.bucket === 'added')).toBe(true)
    expect(result.rows.find(r => r.bucket === 'confirmed')?.changes).toHaveLength(2)
  })

  it('SNAPSHOT-ROWS-IN-DIFF finds every snapshot change in the real diff; only run-created records carry the run link', async () => {
    const f = fiveBucketFixture()
    const run = 'synthetic-run-43'
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'fallback-required', reason: 'no-model' }), executionContext: 'ci',
      maintenance: 'skip', sourceRunId: run })
    expect({ failures: report.failures, requeued: report.requeued, remaining: report.remaining })
      .toEqual({ failures: 0, requeued: 0, remaining: 0 })
    const rows = report.snapshot?.rows ?? []
    expect(rows).toHaveLength(5)
    const diff = diffSince({ knowledgeRoot: f.root, sinceOrdinal: 0 })
    // The identity runs.knowledge can compare on: diffSince reports an Add without the receipt token.
    const same = (left: RecordChange, right: RecordChange) => left.recordId === right.recordId
      && left.change === right.change && left.atOrdinal === right.atOrdinal && left.byRecordId === right.byRecordId
    const observed = rows.flatMap(row => row.changes.map((entry) => {
      const found = diff.filter(change => same(change, entry.change))
      expect(found, `${row.bucket}/${entry.bucket}/${entry.change.change}`).toHaveLength(1)
      return `${row.bucket}/${entry.bucket}/${entry.change.change}:${found[0]?.sourceRunId === run ? 'run-linked' : 'unlinked'}`
    }))
    expect(observed.sort()).toEqual([
      'added/added/added:run-linked',
      'confirmed/confirmed/confirmed:unlinked',
      'confirmed/confirmed/confirmed:unlinked',
      'deprecated/deprecated/deprecated:unlinked',
      'proposed/proposed/added:run-linked',
      'superseded/added/added:run-linked',
      'superseded/superseded/superseded:unlinked',
    ])
    const unlinked = diff.filter(change => rows.some(row => row.changes.some(entry => same(change, entry.change)))
      && change.sourceRunId !== run)
    expect(unlinked.every(change => change.sourceRunId === undefined)).toBe(true)
  })

  it.each(['propose-only', 'validation', 'existing', 'deprecation'] as const)('DOWNGRADE-ORIGIN %s uses recorded disposition', (kind) => {
    const f = commitFixture()
    let delta: Delta = f.supersede
    if (kind === 'validation' && delta.kind === 'Supersede') delta = { ...delta, victimId: asRecordId('missing-victim'), citedIds: [asRecordId('missing-victim')] }
    if (kind === 'deprecation') delta = { kind: 'Deprecate', origin: 'agent', scope: f.add.scope, citedIds: [f.victim.bundleId], targetId: f.victim.bundleId, reason: 'synthetic retirement' }
    const result = commitCurationDelta(kind === 'validation' ? { ...f.deps, profile: { mode: 'drain-to-active' } } : f.deps, f.claimed, f.checkpoint(delta))
    expect(result.kind).toBe('downgraded')
    let run = 'synthetic-run-43'
    if (kind === 'existing') {
      const again = f.job('Purchase', 44)
      expect(commitCurationDelta(f.deps, again, f.checkpoint(delta)).kind).toBe('downgraded')
      run = 'synthetic-run-44'
    }
    const resultSnapshot = snapshot(f, run)
    expect(resultSnapshot.breakdown).toEqual({ added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 1 })
    expect(resultSnapshot.rows[0]?.changes[0]?.change).toMatchObject({ sourceRunId: run, observationId: kind === 'existing' ? 'synthetic-observation-44' : 'synthetic-observation-43', change: kind === 'existing' ? 'confirmed' : 'added' })
  })

  it('RESTART-REFOLD reads surviving receipts after cleanup and preserves exact index bytes', async () => {
    const f = commitFixture()
    commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    expect(existsSync(f.claimed.candidateDir)).toBe(false)
    const before = snapshot(f)
    expect(before.breakdown.proposed).toBe(1)
    const index = readFileSync(join(f.root, 'memory/index/knowledge.db'))
    releaseLease({ knowledgeRoot: f.root, leaseId: f.authority.leaseId })
    expect(snapshot(f)).toEqual(before)
    expect(readFileSync(join(f.root, 'memory/index/knowledge.db')).equals(index)).toBe(true)
  })

  it.each(['single', 'siblings'] as const)('PARTIAL-NO-FAKE-ZERO %s preserves actual effects and resumes the failed claim', async (mode) => {
    const f = commitFixture('local-interactive')
    const original = bundleAppend.appendOutcomeEvent
    vi.spyOn(bundleAppend, 'appendOutcomeEvent').mockImplementation((config, id, event) => event.type === 'superseded' ? { kind: 'not-found' } : original(config, id, event))
    let claimed = false
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'authored', deltas: [
        ...(mode === 'single' ? [] : [{ ...f.add, bundle: f.draft('Sibling') }]), f.supersede],
        authorship: f.checkpoint(f.supersede).authorship }),
      executionContext: 'local-interactive', maintenance: 'skip', sourceRunId: 'synthetic-run-43',
      operations: {
        claimNextJob: () => { if (claimed) return undefined; claimed = true; return f.claimed },
        commitCurationDelta: (deps, job, checkpoint) => commitCurationDelta(deps, job,
          { ...checkpoint, neighborIds: [f.victim.bundleId] }),
      } })
    expect(report.effects).toHaveLength(mode === 'single' ? 1 : 2)
    expect(report.effects?.map(effect => effect.bucket).sort()).toEqual(mode === 'single' ? ['added'] : ['added', 'proposed'])
    expect(report).not.toHaveProperty('snapshot')
    expect(report.remaining, JSON.stringify(report)).toBeGreaterThan(0)
    expect(report.failures).toBeGreaterThan(0)
    expect(report.requeued).toBeGreaterThan(0)
    vi.restoreAllMocks()
    const author = vi.fn(async () => { throw new Error('retry must reuse authored checkpoint') })
    const resumed = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author, executionContext: 'local-interactive', maintenance: 'skip', sourceRunId: 'synthetic-run-43',
      operations: { commitCurationDelta: (deps, job, checkpoint) => commitCurationDelta(deps, job,
        { ...checkpoint, neighborIds: [f.victim.bundleId] }) } })
    expect(author).not.toHaveBeenCalled()
    expect(resumed.failures, JSON.stringify(resumed)).toBe(0)
    expect(resumed.remaining, JSON.stringify(resumed)).toBe(0)
    expect(resumed.snapshot?.breakdown).toEqual({ added: 0, confirmed: 0, superseded: 1, deprecated: 0, proposed: mode === 'single' ? 0 : 1 })
    expect(resumed.snapshot?.rows).toHaveLength(mode === 'single' ? 1 : 2)
  })

  it('SNAPSHOT-FOLD-DEGRADES keeps a committed drain drained when only the snapshot projection throws', async () => {
    const f = commitFixture('local-interactive')
    // No committed effect set reaches the fold's own refusal through the shipped commit paths, so the
    // projection is made to refuse once; the effects underneath are real commits.
    vi.spyOn(curationSnapshotModule, 'foldCurationSnapshot').mockImplementationOnce(() => {
      throw new TypeError('conflicting curation classification')
    })
    let claimed = false
    const drained = drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'authored', deltas: [f.supersede], authorship: f.checkpoint(f.supersede).authorship }),
      executionContext: 'local-interactive', maintenance: 'skip', sourceRunId: 'synthetic-run-43',
      operations: {
        claimNextJob: () => { if (claimed) return undefined; claimed = true; return f.claimed },
        commitCurationDelta: (deps, job, checkpoint) => commitCurationDelta(deps, job,
          { ...checkpoint, neighborIds: [f.victim.bundleId] }),
      } })
    await expect(drained).resolves.toMatchObject({ kind: 'drained' })
    const report = await drained
    expect(report.committed).toBe(1)
    expect({ failures: report.failures, requeued: report.requeued, remaining: report.remaining })
      .toEqual({ failures: 0, requeued: 0, remaining: 0 })
    expect(report).not.toHaveProperty('snapshot')
    expect(report).toHaveProperty('snapshotFoldFailed', true)
    expect(report.effects?.length).toBeGreaterThan(0)
    const reread = readCurationEffects({ knowledgeRoot: f.root, sourceRunId: 'synthetic-run-43' })
    expect(reread).toEqual(report.effects)
    const victim = loadBundle(f.victim.bundleDir)
    expect(victim.kind === 'loaded' && victim.bundle.events.some(event => event.type === 'superseded')).toBe(true)
  })

  it('STRONGEST-ONCE retains older supersessions and collapses repeated identities', () => {
    const change = (recordId: string, kind: 'added' | 'confirmed' | 'superseded' | 'deprecated', atOrdinal: number, byRecordId?: string) => ({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION, recordId, change: kind, atOrdinal, sourceRunId: 'synthetic-run',
      ...(byRecordId === undefined ? {} : { byRecordId }),
    })
    const effects = [
      { bucket: 'confirmed', change: change('victim', 'confirmed', 1) },
      { bucket: 'added', change: change('victim', 'added', 2) },
      { bucket: 'proposed', change: change('victim', 'confirmed', 3) },
      { bucket: 'deprecated', change: change('victim', 'deprecated', 4) },
      { bucket: 'superseded', change: change('victim', 'superseded', 5, 'old-replacement') },
      { bucket: 'added', change: change('old-replacement', 'added', 5) },
      { bucket: 'superseded', change: change('victim', 'superseded', 6, 'new-replacement') },
      { bucket: 'added', change: change('new-replacement', 'added', 6) },
    ] as Parameters<typeof foldCurationSnapshot>[0]
    const result = foldCurationSnapshot([...effects, ...effects])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ bucket: 'superseded', byRecordId: 'new-replacement' })
    expect(result.rows[0]?.changes).toHaveLength(8)
    expect(foldCurationSnapshot([...effects].reverse())).toEqual(result)
  })

  it('CANARY-SURVIVAL collapses attributed confirmations and promotion while excluding foreign and overturned events', () => {
    const f = commitFixture()
    const confirm: Delta = { kind: 'Confirm', origin: 'agent', scope: f.add.scope, citedIds: [f.victim.bundleId], targetId: f.victim.bundleId,
      evidenceToken: asEvidenceToken(f.claimed.payload.evidenceToken) }
    expect(commitCurationDelta(f.deps, f.claimed, f.checkpoint(confirm)).kind).toBe('applied')
    const config = { knowledgeRoot: f.root, productKey: 'storefront',
      writerLeaseId: f.authority.leaseId, writerEpoch: f.authority.epoch }
    const append = (event: Parameters<typeof bundleAppend.appendOutcomeEvent>[2]) =>
      expect(bundleAppend.appendOutcomeEvent(config, f.victim.bundleId, event).kind).toBe('appended')
    append({ type: 'confirmed', buildOrdinal: 44, evidenceToken: asEvidenceToken('canary'), curationJobId: 'canary-job', observationId: 'attributed' })
    append({ type: 'promoted', buildOrdinal: 45, evidenceToken: asEvidenceToken('promotion'), curationJobId: 'promotion-job', observationId: 'attributed' })
    append({ type: 'confirmed', buildOrdinal: 46, evidenceToken: asEvidenceToken('foreign'), curationJobId: 'foreign-job', observationId: 'foreign' })
    const read = () => foldCurationSnapshot(readCurationEffects({ knowledgeRoot: f.root, sourceRunId: 'synthetic-run-43', observationIds: ['attributed'] }))
    expect(read().breakdown.confirmed).toBe(1)
    expect(read().rows[0]?.changes).toHaveLength(3)
    append({ type: 'retracted', buildOrdinal: 47, evidenceToken: asEvidenceToken('rollback'), curationJobId: 'rollback-job',
      retractsEvidenceToken: asEvidenceToken('synthetic-evidence-43'), retractsCurationJobId: f.claimed.candidateId, rollbackReceiptId: 'synthetic-rollback' })
    expect(read().rows[0]?.changes).toHaveLength(2)
    expect(read().rows[0]?.changes.every(e => e.change.observationId === 'attributed')).toBe(true)
    expect(read().rows[0]?.changes.every(e => e.change.sourceRunId === 'synthetic-run-43')).toBe(true)
  })

  it('LATER-PROMOTION-STORE keeps the fixed snapshot while a later attributed promotion has its own identity', () => {
    const f = commitFixture()
    const run = 'synthetic-run-42'
    const fixed = snapshot(f, run)
    expect(fixed.breakdown).toEqual({ added: 1, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 })
    const fixedBytes = JSON.stringify(fixed)
    const config = { knowledgeRoot: f.root, productKey: 'storefront',
      writerLeaseId: f.authority.leaseId, writerEpoch: f.authority.epoch }
    expect(bundleAppend.appendOutcomeEvent(config, f.victim.bundleId, { type: 'promoted', buildOrdinal: 60,
      evidenceToken: asEvidenceToken('later-promotion'), curationJobId: `promote:${f.victimJob.candidateId}` }).kind).toBe('appended')
    const attributed = diffSince({ knowledgeRoot: f.root, sinceOrdinal: 41 }).filter(row => row.sourceRunId === run)
    const recorded = fixed.rows.flatMap(row => row.changes.map(entry => entry.change))
    // The stable identity both readers retain: diffSince reports an Add without the receipt token.
    const same = (left: RecordChange, right: RecordChange) => left.recordId === right.recordId
      && left.change === right.change && left.atOrdinal === right.atOrdinal && left.byRecordId === right.byRecordId
      && (left.evidenceToken === undefined || right.evidenceToken === undefined || left.evidenceToken === right.evidenceToken)
    expect(recorded.every(entry => attributed.some(row => same(row, entry)))).toBe(true)
    const later = attributed.filter(row => !recorded.some(entry => same(row, entry)))
    expect(later).toEqual([expect.objectContaining({ recordId: f.victim.bundleId, change: 'promoted', atOrdinal: 60, sourceRunId: run })])
    expect(JSON.stringify(fixed)).toBe(fixedBytes)
    expect(snapshot(f, run).rows[0]?.changes.length).toBeGreaterThan(fixed.rows[0]!.changes.length)
  })

  it('HISTORICAL-MISSING never creates a snapshot from missing receipts or bundle shape', async () => {
    const f = commitFixture()
    commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    const receiptsDir = join(f.root, COMPLETED_EFFECTS_SUBDIR)
    for (const name of readdirSync(receiptsDir)) rmSync(join(receiptsDir, name))
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'fallback-required', reason: 'no-model' }), executionContext: 'ci',
      maintenance: 'skip', sourceRunId: 'synthetic-run-43' })
    expect(report.failures).toBe(0)
    expect(report.effects).toEqual([])
    expect(report).not.toHaveProperty('snapshot')
  })

  it('ZERO-EFFECT-SNAPSHOT records an all-zero snapshot for a clean drain that committed nothing for the run', async () => {
    const f = commitFixture()
    commitCurationDelta(f.deps, f.claimed, f.checkpoint(f.supersede))
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'fallback-required', reason: 'no-model' }), executionContext: 'ci',
      maintenance: 'skip', sourceRunId: 'synthetic-run-zero' })
    expect({ kind: report.kind, failures: report.failures, requeued: report.requeued, remaining: report.remaining })
      .toEqual({ kind: 'drained', failures: 0, requeued: 0, remaining: 0 })
    expect(report.effects).toEqual([])
    const zero = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 } }
    expect(report.snapshot).toEqual(zero)
    expect(CurationSnapshotSchema.parse(report.snapshot)).toEqual(zero)
  })

  it.each(['deprecation', 'confirmation'] as const)('RECEIPT-LOSS-CANARY-LINKED %s never reads lost receipts as nothing committed', async (kind) => {
    const f = commitFixture()
    const observationId = f.claimed.payload.attributingObservationId
    const confirm: Delta = { kind: 'Confirm', origin: 'agent', scope: f.add.scope, citedIds: [f.victim.bundleId], targetId: f.victim.bundleId,
      evidenceToken: asEvidenceToken(f.claimed.payload.evidenceToken) }
    if (kind === 'deprecation') {
      // No shipped commit stamps a canary id on a deprecation, so the confirmation belongs to another run
      // and this run's only change is appended directly: the observation-id arm alone must refuse the zero.
      f.claimed.payload.sourceRunId = 'synthetic-run-other'
      f.claimed.payload.attributingObservationId = 'synthetic-observation-other'
    }
    expect(commitCurationDelta(f.deps, f.claimed, f.checkpoint(confirm)).kind).toBe('applied')
    if (kind === 'deprecation') {
      const config = { knowledgeRoot: f.root, productKey: 'storefront',
        writerLeaseId: f.authority.leaseId, writerEpoch: f.authority.epoch }
      expect(bundleAppend.appendOutcomeEvent(config, f.victim.bundleId, { type: 'deprecated', buildOrdinal: 44,
        evidenceToken: asEvidenceToken('canary-deprecation'), curationJobId: 'canary-job', observationId, reason: 'synthetic canary retirement' }).kind).toBe('appended')
    }
    const linked = diffSince({ knowledgeRoot: f.root, sinceOrdinal: 0 })
    // The run's only surviving change sits on an older bundle: no change carries its run id.
    expect(linked.some(change => change.sourceRunId === 'synthetic-run-43')).toBe(false)
    expect(linked.filter(change => change.observationId === observationId)).toHaveLength(1)
    const receiptsDir = join(f.root, COMPLETED_EFFECTS_SUBDIR)
    for (const name of readdirSync(receiptsDir)) rmSync(join(receiptsDir, name))
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => ({ kind: 'fallback-required', reason: 'no-model' }), executionContext: 'ci',
      maintenance: 'skip', sourceRunId: 'synthetic-run-43', observationIds: [observationId] })
    expect(report.failures).toBe(0)
    if (kind === 'deprecation') {
      expect(report.effects).toEqual([])
      expect(report).not.toHaveProperty('snapshot')
    } else {
      // The canary-attributed confirmation is itself a surviving effect, so the record is never all-zero.
      expect(report.effects?.map(effect => effect.bucket)).toEqual(['confirmed'])
      expect(report.snapshot?.breakdown).toEqual({ added: 0, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 })
    }
  })

  it.each(['failure', 'requeue'] as const)('INCOMPLETE-DRAIN-NO-ZERO %s never records a zero-effect drain that did not finish cleanly', async (mode) => {
    const f = commitFixture('local-interactive')
    let claimed = false
    const report = await drainQueue({ knowledgeRoot: f.root, lease: f.authority,
      author: async () => { throw new Error('synthetic author failure') },
      executionContext: 'local-interactive', maintenance: 'skip', sourceRunId: 'synthetic-run-zero',
      operations: {
        claimNextJob: () => {
          if (mode === 'failure') throw new Error('synthetic claim failure')
          if (claimed) return undefined
          claimed = true
          return f.claimed
        },
      } })
    expect(report.effects).toEqual([])
    expect(report.failures + report.requeued + report.remaining, JSON.stringify(report)).toBeGreaterThan(0)
    if (mode === 'requeue') expect(report.requeued + report.remaining, JSON.stringify(report)).toBeGreaterThan(0)
    expect(report).not.toHaveProperty('snapshot')
    expect(report).not.toHaveProperty('snapshotFoldFailed')
  })
})
