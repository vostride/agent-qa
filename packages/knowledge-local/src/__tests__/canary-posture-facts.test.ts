import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, stampReceiptDigest } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendGateReceipt, appendOutcomeEvent, appendPromotionReceipt } from '../bundle-append.js'
import { canaryPostureFactsFor, lowerTrustSharesFor, standingReceiptDigestsFor } from '../gates/canary-posture-facts.js'
import { completeGate1Receipt, createPromotionFloorFixture } from '../curator/__tests__/fixtures/promotion-floor-fixture.js'

describe('418 bundle-local canary posture facts', () => {
  let root: string
  let knowledgeRoot: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  const scope = { tier: 'product', key: 'storefront' } as const
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '418-canary-facts-'))
    knowledgeRoot = join(root, 'knowledge')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  function seed(name = 'quiet') {
    const { published } = fixture.publishHeldCandidate(name)
    const pass = completeGate1Receipt(published.id, { producedAtOrdinal: 10 })
    expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, pass)).toEqual({ kind: 'appended' })
    return { ...published, pass }
  }
  const read = (candidateId: string) => canaryPostureFactsFor({ knowledgeRoot, candidateId, scope })
  // 2026-09-30, 432-10 D-05/D-22: re-spelled. The legacy inbox is never read, so no file state
  // (pending, claimed, applied, rejected) adds a flag, and the facts never write under it.
  it.each([
    ['pending', (id: string) => `${id}.json`],
    ['claimed', (id: string) => `${id}.json.claimed.${process.pid}`],
    ['applied', (id: string) => `${id}.applied.json`],
    ['rejected', (id: string) => `${id}.rejected.json`],
  ] as const)('432 a legacy %s inconsistency file adds no flag and is never written', (_state, name) => {
    const planted = seed()
    const agentQaRoot = join(root, '.agent-qa')
    const dir = plantLegacyInbox(agentQaRoot, planted.id, planted.pass.receiptDigest)
    const pending = join(dir, 'prop_0123456789abcdef.json')
    const legacy = join(dir, name('prop_0123456789abcdef'))
    if (legacy !== pending) renameSync(pending, legacy)
    const bytes = readFileSync(legacy, 'utf8')
    const legacyInput = { knowledgeRoot, candidateId: planted.id, scope, agentQaRoot }
    expect(canaryPostureFactsFor(legacyInput)).toEqual(read(planted.id))
    expect(read(planted.id)).not.toHaveProperty('pendingInconsistency')
    expect(readdirSync(dir)).toEqual([name('prop_0123456789abcdef')])
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
  })
  // 2026-09-30, 432-10 D-22: re-spelled. A corrupt legacy file used to fail the read closed; it is
  // no longer read at all, so it neither throws nor reports a flag.
  it('432 a corrupt legacy proposal file is never read, so it neither throws nor flags', () => {
    const planted = seed()
    const agentQaRoot = join(root, '.agent-qa')
    const dir = plantLegacyInbox(agentQaRoot, planted.id, planted.pass.receiptDigest)
    writeFileSync(join(dir, 'prop_0123456789abcdef.json'), '{bad')
    const legacyInput = { knowledgeRoot, candidateId: planted.id, scope, agentQaRoot }
    expect(() => canaryPostureFactsFor(legacyInput)).not.toThrow()
    expect(canaryPostureFactsFor(legacyInput)).toEqual(read(planted.id))
  })
  it('reads the standing pass and corpus digest without inventing attribution', () => {
    const planted = seed()
    expect(read(planted.id)).toEqual({ kind: 'found', gate1PassOrdinal: 10,
      gate1PassDigest: planted.pass.receiptDigest, activeInScope: 0, lowerTrustActiveInScope: 0 })
    expect(standingReceiptDigestsFor({ knowledgeRoot })).toEqual([{ candidateId: planted.id,
      gate: 1, verdict: 'pass', corpusDigest: 'c'.repeat(64), producedAtOrdinal: 10 }])
    expect(read('missing')).toEqual({ kind: 'not-found' })
  })
  it.each(['confirmed', 'contradicted', 'helpful', 'harmful'] as const)('counts surviving %s attribution', type => {
    const planted = seed()
    expect(appendOutcomeEvent(fixture.outcomeAppendConfig(), planted.id, {
      type, evidenceToken: asEvidenceToken('attribution'), curationJobId: 'attribution', buildOrdinal: 12,
    })).toEqual({ kind: 'appended' })
    expect(read(planted.id)).toMatchObject({ latestAttributionOrdinal: 12 })
    appendOutcomeEvent(fixture.outcomeAppendConfig(), planted.id, {
      type: 'retracted', evidenceToken: asEvidenceToken('retraction'), curationJobId: 'retraction',
      buildOrdinal: 13, retractsEvidenceToken: asEvidenceToken('attribution'),
      retractsCurationJobId: 'attribution', rollbackReceiptId: 'rollback',
    })
    expect(read(planted.id)).not.toHaveProperty('latestAttributionOrdinal')
  })
  it('reads all Gate-2 ordinals, including abstains, and never revives a superseded pass', () => {
    const planted = seed()
    appendGateReceipt(fixture.outcomeAppendConfig(), planted.id, stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 2, candidateId: planted.id, verdict: 'abstain', producedAtOrdinal: 11,
      producedBy: { opId: 'fixture' }, attributedObservationId: 'observation',
      corpusVersion: { corpusDigest: 'c'.repeat(64) }, benefit: 'rode-along', stateValidity: 'unknown',
    }))
    expect(read(planted.id)).toMatchObject({ latestGate2Ordinal: 11 })
    appendGateReceipt(fixture.outcomeAppendConfig(), planted.id,
      completeGate1Receipt(planted.id, { producedAtOrdinal: 14, verdict: 'fail' }))
    expect(read(planted.id)).not.toHaveProperty('gate1PassOrdinal')
    expect(standingReceiptDigestsFor({ knowledgeRoot }).find(row => row.gate === 1)?.verdict).toBe('fail')
  })
  it('counts active lower-trust records by strongest path and updates after upgrades', () => {
    const first = seed('lower')
    const second = seed('ordinary')
    for (const planted of [first, second]) {
      appendOutcomeEvent(fixture.outcomeAppendConfig(), planted.id, { type: 'promoted',
        evidenceToken: asEvidenceToken(`promoted-${planted.id}`), curationJobId: 'promote', buildOrdinal: 45 })
    }
    appendPromotionReceipt(fixture.outcomeAppendConfig(), first.id, { schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
      kind: 'promotion', candidateId: first.id, promotionPath: 'gate1-lower-trust',
      citedReceiptDigests: [first.pass.receiptDigest], producedAtOrdinal: 15, producedBy: { opId: 'fixture' } })
    expect(read(second.id)).toMatchObject({ activeInScope: 2, lowerTrustActiveInScope: 1 })
    expect(read(first.id)).toMatchObject({ lowerTrustActiveGate1Digest: first.pass.receiptDigest })
    expect(read(second.id)).not.toHaveProperty('lowerTrustActiveGate1Digest')
    expect(lowerTrustSharesFor({ knowledgeRoot })).toEqual([{ product: 'storefront', active: 2, lowerTrust: 1 }])
    appendPromotionReceipt(fixture.outcomeAppendConfig(), first.id, { schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
      kind: 'promotion', candidateId: first.id, promotionPath: 'gate1+gate2',
      citedReceiptDigests: [first.pass.receiptDigest], producedAtOrdinal: 16, producedBy: { opId: 'fixture' } })
    expect(read(second.id)).toMatchObject({ activeInScope: 2, lowerTrustActiveInScope: 0 })
    expect(read(first.id)).not.toHaveProperty('lowerTrustActiveGate1Digest')
  })
  it('never derives continued authority from a historical promotion after retraction or a changed Gate-1', () => {
    const planted = seed()
    const config = fixture.outcomeAppendConfig()
    appendPromotionReceipt(config, planted.id, { schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion',
      candidateId: planted.id, promotionPath: 'gate1-lower-trust',
      citedReceiptDigests: [planted.pass.receiptDigest], producedAtOrdinal: 45, producedBy: { opId: 'fixture' } })
    expect(read(planted.id)).not.toHaveProperty('lowerTrustActiveGate1Digest')
    appendOutcomeEvent(config, planted.id, { type: 'promoted', evidenceToken: asEvidenceToken('authority'),
      curationJobId: 'authority', buildOrdinal: 45 })
    expect(read(planted.id)).toMatchObject({ lowerTrustActiveGate1Digest: planted.pass.receiptDigest })
    appendOutcomeEvent(config, planted.id, { type: 'retracted', evidenceToken: asEvidenceToken('retract-authority'),
      curationJobId: 'retract-authority', buildOrdinal: 46, retractsEvidenceToken: asEvidenceToken('authority'),
      retractsCurationJobId: 'authority', rollbackReceiptId: 'rollback-authority' })
    expect(read(planted.id)).not.toHaveProperty('lowerTrustActiveGate1Digest')
    appendOutcomeEvent(config, planted.id, { type: 'promoted', evidenceToken: asEvidenceToken('authority-two'),
      curationJobId: 'authority-two', buildOrdinal: 47 })
    appendGateReceipt(config, planted.id, completeGate1Receipt(planted.id, { producedAtOrdinal: 48 }))
    expect(read(planted.id)).not.toHaveProperty('lowerTrustActiveGate1Digest')
  })
  it('refuses mismatched scopes and corrupt evidence instead of undercounting the cap', () => {
    const planted = seed()
    expect(canaryPostureFactsFor({ knowledgeRoot, candidateId: planted.id,
      scope: { tier: 'product', key: 'foreign' } })).toEqual({ kind: 'not-found' })
    writeFileSync(join(planted.dir, 'evidence/outcomes.jsonl'), '{bad}\n')
    expect(() => read(planted.id)).toThrow()
    expect(() => lowerTrustSharesFor({ knowledgeRoot })).toThrow()
    expect(() => standingReceiptDigestsFor({ knowledgeRoot })).toThrow()
  })
})

// 2026-09-30, 432-10 D-05/D-22: the pre-432 inbox is left on disk and never read. A leftover
// pending gate-inconsistency file sits beside a corrupt one, and the directory is unreadable.
function plantLegacyInbox(agentQaRoot: string, candidateId: string, gate1Digest: string): string {
  const dir = join(agentQaRoot, 'proposals')
  mkdirSync(dir, { recursive: true })
  const proposalId = 'prop_0123456789abcdef'
  writeFileSync(join(dir, `${proposalId}.json`), `${JSON.stringify({
    schemaVersion: 1, proposalId, verb: 'accept',
    targetRef: { grain: 'record', recordId: candidateId },
    deltas: [{ kind: 'Deprecate', origin: 'system', scope: { tier: 'product', key: 'storefront' },
      citedIds: [candidateId], targetId: candidateId,
      reason: `gate-inconsistent:gate1-pass-gate2-fail:${gate1Digest}:${'d'.repeat(64)}` }],
    proposedAt: 10, status: 'pending',
  }, undefined, 2)}\n`)
  return dir
}

function breakLegacyInbox(dir: string): void {
  writeFileSync(join(dir, 'prop_fedcba9876543210.json'), '{bad')
  chmodSync(dir, 0o000)
}

describe('432 canary posture facts and holds never read the legacy inbox (D-05, D-22)', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string
  let legacyDir: string | undefined
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  const scope = { tier: 'product', key: 'storefront' } as const
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '432-canary-inbox-'))
    knowledgeRoot = join(root, 'knowledge')
    agentQaRoot = join(root, '.agent-qa')
    legacyDir = undefined
    fixture = createPromotionFloorFixture({ knowledgeRoot })
  })
  afterEach(() => {
    if (legacyDir !== undefined && existsSync(legacyDir)) chmodSync(legacyDir, 0o755)
    rmSync(root, { recursive: true, force: true })
  })
  function seed(name: string) {
    const { published, draft } = fixture.publishHeldCandidate(name)
    const pass = completeGate1Receipt(published.id, { producedAtOrdinal: 10 })
    expect(appendGateReceipt(fixture.outcomeAppendConfig(), published.id, pass)).toEqual({ kind: 'appended' })
    return { ...published, pass, anchor: draft.anchors[0]! }
  }

  it('C432-CANARY-INBOX-UNREAD: clean facts are identical with a pending, corrupt or unreadable legacy inbox', () => {
    const planted = seed('clean')
    const clean = { kind: 'found', gate1PassOrdinal: 10, gate1PassDigest: planted.pass.receiptDigest,
      activeInScope: 0, lowerTrustActiveInScope: 0 }
    expect(canaryPostureFactsFor({ knowledgeRoot, candidateId: planted.id, scope })).toEqual(clean)
    legacyDir = plantLegacyInbox(agentQaRoot, planted.id, planted.pass.receiptDigest)
    // A pre-432 caller still handing its runtime root gets the same evidence-only answer.
    const legacyInput = { knowledgeRoot, candidateId: planted.id, scope, agentQaRoot }
    expect(canaryPostureFactsFor(legacyInput)).toEqual(clean)
    breakLegacyInbox(legacyDir)
    expect(() => canaryPostureFactsFor(legacyInput)).not.toThrow()
    expect(canaryPostureFactsFor(legacyInput)).toEqual(clean)
    expect(lowerTrustSharesFor({ knowledgeRoot })).toEqual([{ product: 'storefront', active: 0, lowerTrust: 0 }])
  })
})
