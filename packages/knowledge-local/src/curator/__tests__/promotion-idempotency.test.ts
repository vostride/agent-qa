import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, asRecordId, stampReceiptDigest } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveBundleTrust, readGateReceipts } from '../../bundle-read.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import { openIndexReaderConnection } from '../../index-open.js'
import { createLocalKnowledgeStore, type CreateLocalKnowledgeStoreConfig } from '../knowledge-store.js'
import { completeGate1Receipt, createPromotionFloorFixture } from './fixtures/promotion-floor-fixture.js'

describe('promotion receipt writer contract', () => {
  let root: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  let config: CreateLocalKnowledgeStoreConfig
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promotion-idempotency-'))
    const knowledgeRoot = join(root, 'knowledge')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected writer lease')
    config = { knowledgeRoot, executionContext: 'local-interactive',
      epoch: lease.epoch, writerLeaseId: lease.leaseId, sourceBuildOrdinal: 46 }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  async function confirmed() {
    const seeded = fixture.publishHeldCandidate('receipt-writer')
    const store = createLocalKnowledgeStore(config)
    await store.commit([{ kind: 'Confirm', origin: 'agent', scope: seeded.draft.scope,
      citedIds: [seeded.published.id], targetId: seeded.published.id,
      evidenceToken: asEvidenceToken('receipt-writer-confirm'),
      authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
    return { ...seeded, store }
  }
  function gate3(candidateId: string, ordinal = 45) {
    return stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId, verdict: 'pass',
      producedAtOrdinal: ordinal, producedBy: { opId: 'test' }, runId: 'receipt-writer-run', mark: 'false-fail' })
  }
  function assertStatus(candidateId: string, status: 'active' | 'candidate') {
    expect(deriveBundleTrust(fixture.onlyBundle().bundle).status).toBe(status)
    const reader = openIndexReaderConnection(config.knowledgeRoot)
    try {
      expect(reader.db.prepare('SELECT status FROM records WHERE bundle_id = ?').get(candidateId))
        .toMatchObject({ status })
    } finally { reader.db.close() }
  }

  it('records identical receipts as appended then duplicate', async () => {
    const { published, store } = await confirmed()
    const receipt = completeGate1Receipt(published.id)
    expect(await store.recordGateReceipt(receipt)).toEqual({ kind: 'appended' })
    expect(await store.recordGateReceipt(receipt)).toEqual({ kind: 'duplicate' })
    expect(readGateReceipts(published.dir, published.id)).toEqual([receipt])
    expect(fixture.onlyBundle().bundle.events.filter(event => event.type === 'promoted')).toHaveLength(0)
  })
  it('repeats floor promotion with exactly one event and promotion receipt', async () => {
    const { published, store } = await confirmed()
    expect(await store.promote(published.id)).toEqual({ kind: 'promoted',
      promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
    const trust = deriveBundleTrust(fixture.onlyBundle().bundle)
    expect(await store.promote(published.id)).toEqual({ kind: 'already-active',
      promotionPath: 'deterministic-verdict-floor' })
    expect(readGateReceipts(published.dir, published.id)).toHaveLength(1)
    expect(fixture.onlyBundle().bundle.events.filter(event => event.type === 'promoted')).toHaveLength(1)
    expect(deriveBundleTrust(fixture.onlyBundle().bundle)).toEqual(trust)
  })
  async function refusesInvalidBatch(defect: 'digest' | 'candidate') {
    const { published, store } = await confirmed()
    const valid = completeGate1Receipt(published.id)
    const invalid = defect === 'digest'
      ? { ...gate3(published.id), receiptDigest: 'f'.repeat(64) }
      : completeGate1Receipt('foreign-candidate')
    const manifest = readFileSync(join(published.dir, 'manifest.json'), 'utf8')
    const events = readFileSync(join(published.dir, 'evidence/outcomes.jsonl'), 'utf8')
    const refused = store.promote(published.id, [valid, invalid])
    await expect(refused).rejects.toThrow(TypeError)
    await expect(refused).rejects.toThrow(defect === 'digest' ? 'receiptDigest mismatch' : 'foreign candidateId')
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
    expect(readFileSync(join(published.dir, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(published.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe(events)
  }
  it('refuses a later invalid digest before any supplied receipt lands', async () => {
    await refusesInvalidBatch('digest')
  })
  it('refuses a later foreign candidate before any supplied receipt lands', async () => {
    await refusesInvalidBatch('candidate')
  })
  it('refuses an unknown record and a tampered standalone receipt', async () => {
    const { published, store } = await confirmed()
    await expect(store.recordGateReceipt(completeGate1Receipt(asRecordId('missing'))))
      .rejects.toMatchObject({ name: 'KnowledgePromotionError', reason: 'not-found' })
    await expect(store.recordGateReceipt({ ...completeGate1Receipt(published.id), receiptDigest: 'f'.repeat(64) }))
      .rejects.toThrow(TypeError)
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
  })
  it('refuses propose-only before reporting or appending', async () => {
    const { published } = await confirmed()
    const reports = vi.fn()
    const proposeOnly = createLocalKnowledgeStore({ ...config, executionContext: 'ci', onPromotionOutcome: reports })
    await expect(proposeOnly.promote(published.id, [completeGate1Receipt(published.id)]))
      .rejects.toMatchObject({ reason: 'propose-only' })
    expect(reports).not.toHaveBeenCalled()
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
  })
  it('requires the published writer authority for both receipt-writing methods', async () => {
    const { published } = await confirmed()
    const unauthorized = createLocalKnowledgeStore({ ...config, writerLeaseId: 'foreign-holder' })
    const receipt = completeGate1Receipt(published.id)
    await expect(unauthorized.recordGateReceipt(receipt)).rejects.toMatchObject({ name: 'WriterAuthorityLostError' })
    await expect(unauthorized.promote(published.id, [receipt])).rejects.toMatchObject({ name: 'WriterAuthorityLostError' })
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
  })
})
