import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, canonicalJson, computeMutableStateHash, receiptDigestOf } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendGateReceipt, appendPromotionReceipt } from '../bundle-append.js'
import { GATES_REL_PATH, loadBundle, readGateReceipts, verifyBundleIntegrity } from '../bundle-read.js'
import { MUTABLE_BUNDLE_TARGETS } from '../journal/bundle-mutation.js'
import { gateReceiptsFor } from '../gates/gate-receipt-read.js'
import { completeGate1Receipt, createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'

describe('416 lazy journaled gate part', () => {
  let root: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '416-gates-part-'))
    fixture = createPromotionFloorFixture({ knowledgeRoot: join(root, 'agent-qa-knowledge') })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  async function confirmed() {
    const seeded = fixture.publishHeldCandidate('gates-part')
    const store = fixture.promotionStore(43)
    await store.commit([{ kind: 'Confirm', origin: 'agent', scope: seeded.draft.scope,
      citedIds: [seeded.published.id], targetId: seeded.published.id,
      evidenceToken: asEvidenceToken('held-checkout-confirm'),
      authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
    return { ...seeded, store }
  }
  it('reads a missing id, an absent part, and persisted promotion history through the reader', async () => {
    const knowledgeRoot = fixture.outcomeAppendConfig().knowledgeRoot
    expect(gateReceiptsFor({ knowledgeRoot, candidateId: 'missing' })).toEqual({
      kind: 'not-found', recordId: 'missing',
    })
    const { published, store } = await confirmed()
    expect(gateReceiptsFor({ knowledgeRoot, candidateId: published.id })).toEqual({
      kind: 'found', recordId: published.id, product: 'storefront', recordKind: 'fact',
      status: 'candidate', lines: [], standing: [],
      live: { verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] },
    })
    await store.promote(published.id)
    expect(gateReceiptsFor({ knowledgeRoot, candidateId: published.id })).toEqual({
      kind: 'found', recordId: published.id, product: 'storefront', recordKind: 'fact',
      status: 'active', strongestPromotionPath: 'deterministic-verdict-floor',
      lines: readGateReceipts(published.dir, published.id), standing: [],
      live: { verdict: 'hold', reason: 'not-candidate' },
    })
  })
  it('promotes with one receipt and event, then answers already-active; receipts dedup by digest', async () => {
    const { published, store } = await confirmed()
    expect(await store.promote(published.id)).toEqual({
      kind: 'promoted', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [],
    })
    const lines = readGateReceipts(published.dir, published.id)!
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'promotion', promotionPath: 'deterministic-verdict-floor',
      citedReceiptDigests: [], producedBy: { opId: 'promote' } })
    expect(lines[0]!.receiptDigest).toBe(receiptDigestOf(lines[0]!))
    expect(appendPromotionReceipt(fixture.outcomeAppendConfig(), published.id, {
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: published.id,
      promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [],
      producedAtOrdinal: 45, producedBy: { opId: 'repeat' },
    })).toEqual({ kind: 'duplicate' })
    expect(readFileSync(join(published.dir, GATES_REL_PATH), 'utf8')).toBe(canonicalJson(lines[0]) + '\n')
    const { bundle } = fixture.onlyBundle()
    const hashes = bundle.manifest.contentHashes
    expect(hashes[GATES_REL_PATH]).toBeDefined()
    expect(bundle.manifest.mutableStateHash).toBe(computeMutableStateHash({
      outcomes: hashes['evidence/outcomes.jsonl']!, relations: hashes['relations.json']!,
      artifactsIndex: hashes['artifacts.index.json']!, gates: hashes[GATES_REL_PATH]!,
    }))
    expect(verifyBundleIntegrity(published.dir).ok).toBe(true)
    expect(await store.promote(published.id)).toEqual({
      kind: 'already-active', promotionPath: 'deterministic-verdict-floor',
    })
    expect(readGateReceipts(published.dir, published.id)).toHaveLength(1)
    expect(fixture.onlyBundle().bundle.events.filter(e => e.type === 'promoted')).toHaveLength(1)
    const receipt = completeGate1Receipt(published.id)
    expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, receipt)).toEqual({ kind: 'appended' })
    expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, receipt)).toEqual({ kind: 'duplicate' })
    expect(readGateReceipts(published.dir, published.id)).toHaveLength(2)
    expect(verifyBundleIntegrity(published.dir).ok).toBe(true)
  })
  it('keeps absent-part manifests byte-compatible and pins the seven mutable targets', () => {
    const { published } = fixture.publishHeldCandidate('no-gates')
    const { bundle } = fixture.onlyBundle()
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
    expect(bundle.manifest.contentHashes).not.toHaveProperty(GATES_REL_PATH)
    const hashes = bundle.manifest.contentHashes
    expect(bundle.manifest.mutableStateHash).toBe(computeMutableStateHash({
      outcomes: hashes['evidence/outcomes.jsonl']!, relations: hashes['relations.json']!,
      artifactsIndex: hashes['artifacts.index.json']!,
    }))
    expect(MUTABLE_BUNDLE_TARGETS).toEqual(['record.md', 'provenance.json', 'evidence/outcomes.jsonl',
      'evidence/measurements.json', 'evidence/gates.jsonl', 'relations.json', 'manifest.json'])
  })
  it('refuses foreign candidateId and receiptDigest mismatch at both trust boundaries', async () => {
    const { published, store } = await confirmed()
    await store.promote(published.id)
    const original = readGateReceipts(published.dir, published.id)![0]!
    const file = join(published.dir, GATES_REL_PATH)
    writeFileSync(file, canonicalJson({ ...original, candidateId: 'foreign' }) + '\n')
    expect(() => readGateReceipts(published.dir, published.id)).toThrow('line 1: foreign candidateId')
    expect(loadBundle(published.dir)).toMatchObject({ kind: 'invalid' })
    writeFileSync(file, canonicalJson({ ...original, receiptDigest: '0'.repeat(64) }) + '\n')
    expect(() => readGateReceipts(published.dir, published.id)).toThrow('line 1: receiptDigest mismatch')
    writeFileSync(file, canonicalJson(original) + '\n')
    const receipt = completeGate1Receipt('foreign')
    expect(() => appendGateReceipt(fixture.outcomeAppendConfig(), published.id, receipt)).toThrow('foreign candidateId')
    expect(() => appendGateReceipt(fixture.outcomeAppendConfig(), published.id,
      { ...receipt, candidateId: published.id })).toThrow('receiptDigest mismatch')
    expect(readFileSync(file, 'utf8')).toBe(canonicalJson(original) + '\n')
  })
  it('refuses present empty, unterminated, malformed and extra-key lines', () => {
    const { published } = fixture.publishHeldCandidate('malformed')
    const file = join(published.dir, GATES_REL_PATH)
    for (const text of ['', '{}', '{\n', '{}\n']) {
      writeFileSync(file, text)
      expect(() => readGateReceipts(published.dir, published.id)).toThrow()
    }
    const receipt = completeGate1Receipt(published.id)
    writeFileSync(file, canonicalJson({ ...receipt, extra: true }) + '\n')
    expect(() => readGateReceipts(published.dir, published.id)).toThrow()
    writeFileSync(file, JSON.stringify(receipt) + '\n')
    expect(() => readGateReceipts(published.dir, published.id)).toThrow('expected canonical JSON')
  })
})
