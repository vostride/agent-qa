import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendGateReceipt, appendOutcomeEvent, appendPromotionReceipt } from '../bundle-append.js'
import { loadBundle, readGateReceipts } from '../bundle-read.js'
import { publishBundle as publishBundleForTest } from '../bundle-publish.test-helper.js'
import { assemblePromotionGateInput, candidateProvenanceOf } from '../promotion-gate-input.js'
import { gateReceiptsFor } from '../gates/gate-receipt-read.js'
import { completeGate1Receipt, createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'

describe('shared promotion input', () => {
  let root: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promotion-input-'))
    fixture = createPromotionFloorFixture({ knowledgeRoot: join(root, 'knowledge') })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  function load(bundleDir: string) {
    const loaded = loadBundle(bundleDir)
    if (loaded.kind !== 'loaded') throw new Error(`load failed: ${loaded.kind}`)
    return loaded.bundle
  }
  function assemble(bundleDir: string) {
    return assemblePromotionGateInput({ knowledgeRoot: fixture.outcomeAppendConfig().knowledgeRoot,
      bundleDir, bundle: load(bundleDir) })
  }
  it('assembles an empty receipt list', () => {
    const { published } = fixture.publishHeldCandidate('absent')
    expect(assemble(published.dir).gateReceipts).toEqual([])
  })
  it('keeps gate receipts, drops promotion receipts and reports sorted unique surviving provenance', () => {
    const { published } = fixture.publishHeldCandidate('provenance')
    const config = fixture.outcomeAppendConfig()
    const g1 = completeGate1Receipt(published.id)
    expect(appendGateReceipt(config, published.id, g1)).toEqual({ kind: 'appended' })
    expect(appendPromotionReceipt(config, published.id, { schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion',
      candidateId: published.id, promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [],
      producedAtOrdinal: 50, producedBy: { opId: 'test' } })).toEqual({ kind: 'appended' })
    for (const [token, ordinal] of [['later', 45], ['same', 42], ['earlier', 40], ['retracted', 99]] as const) {
      expect(appendOutcomeEvent(config, published.id, { type: 'confirmed', evidenceToken: asEvidenceToken(token),
        curationJobId: token, buildOrdinal: ordinal })).toEqual({ kind: 'appended' })
    }
    expect(appendOutcomeEvent(config, published.id, { type: 'retracted', evidenceToken: asEvidenceToken('rollback'),
      curationJobId: 'rollback', buildOrdinal: 100, retractsEvidenceToken: asEvidenceToken('retracted'),
      retractsCurationJobId: 'retracted', rollbackReceiptId: 'rollback' })).toEqual({ kind: 'appended' })
    expect(assemble(published.dir).gateReceipts).toEqual([g1])
    expect(candidateProvenanceOf(published.dir, load(published.dir))).toEqual({
      runIds: ['held-checkout-provenance-run'],
      receiptDigests: readGateReceipts(published.dir, published.id)!.map(line => line.receiptDigest),
      capturedAtOrdinals: [40, 42, 45],
    })
  })
  it('reports empty provenance for a standalone bundle', () => {
    const { draft } = fixture.publishHeldCandidate('template')
    const published = publishBundleForTest(fixture.outcomeAppendConfig(), {
      draft: { ...draft, summary: 'standalone', body: 'standalone evidence' },
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name: 'Standalone' } },
      originClass: 'agent-verified', createdAtOrdinal: 9, screenStates: [], initialEvents: [],
      relations: [], provenance: { mode: 'standalone', sourceDescription: 'fixture' }, artifacts: [],
    })
    if (published.kind !== 'published') throw new Error(`publish failed: ${published.kind}`)
    expect(candidateProvenanceOf(published.dir, load(published.dir)))
      .toEqual({ runIds: [], receiptDigests: [], capturedAtOrdinals: [] })
  })
  it('reports the floor verdict as the live verdict for a confirmed candidate', async () => {
    const { draft, published } = fixture.publishHeldCandidate('reader')
    await fixture.promotionStore(43).commit([{ kind: 'Confirm', origin: 'agent', scope: draft.scope,
      citedIds: [published.id], targetId: published.id, evidenceToken: asEvidenceToken('reader-confirm'),
      authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } }])
    expect(gateReceiptsFor({ knowledgeRoot: fixture.outcomeAppendConfig().knowledgeRoot, candidateId: published.id }))
      .toMatchObject({ kind: 'found', live: { verdict: 'promote', promotionPath: 'deterministic-verdict-floor' } })
  })
})
