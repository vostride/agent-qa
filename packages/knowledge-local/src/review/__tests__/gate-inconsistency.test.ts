// 2026-09-30, 432-10 D-05/D-08/D-22: re-spelled in place. The 418 gate-inconsistency proposal
// (its identity, filing, claim/decision flag and inbox read) is deleted; each cell below carries
// the claim that survives it: contradictory standing receipts hold promotion as gate-inconsistent
// through the real store, nothing is filed, and the legacy inbox is never read.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, stampReceiptDigest, type GateReceipt } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendOutcomeEvent } from '../../bundle-append.js'
import { deriveBundleTrust, loadBundle } from '../../bundle-read.js'
import { createLocalKnowledgeStore } from '../../curator/knowledge-store.js'
import { completeGate1Receipt, createPromotionFloorFixture, resolvedPromotionPosture }
  from '../../curator/__tests__/fixtures/promotion-floor-fixture.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'

const DIGEST = 'c'.repeat(64)

function gate2(candidateId: string, verdict: 'pass' | 'fail', producedAtOrdinal: number): GateReceipt {
  return stampReceiptDigest({
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 2, candidateId, verdict, producedAtOrdinal,
    producedBy: { opId: 'test' }, attributedObservationId: `observation-${producedAtOrdinal}`,
    corpusVersion: { corpusDigest: DIGEST },
    benefit: verdict === 'fail' ? 'exercised-harmed' : 'exercised-benefited', stateValidity: 'valid',
  })
}

describe('432 evidence-based gate inconsistency hold (D-05, D-22)', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string
  let fixture: ReturnType<typeof createPromotionFloorFixture>
  const onPromotionOutcome = vi.fn()
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), '432-gate-inconsistency-'))
    knowledgeRoot = join(root, 'knowledge')
    agentQaRoot = join(root, '.agent-qa')
    fixture = createPromotionFloorFixture({ knowledgeRoot })
    onPromotionOutcome.mockReset()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function store(executionContext: 'local-interactive' | 'ci' = 'local-interactive') {
    const lease = acquireWriterLease(knowledgeRoot)
    const authority = lease.kind === 'acquired' ? { writerLeaseId: lease.leaseId, epoch: lease.epoch }
      : lease.kind === 'held' ? { writerLeaseId: lease.holder.leaseId, epoch: lease.holder.epoch }
        : undefined
    if (authority === undefined) throw new Error(lease.kind)
    return createLocalKnowledgeStore({ knowledgeRoot,
      executionContext, sourceBuildOrdinal: 43, ...authority,
      resolvePromotionPosture: () => resolvedPromotionPosture(), onPromotionOutcome })
  }

  /** A confirmed candidate with a standing Gate-1 pass: only the Gate-2 evidence decides. */
  async function confirmedCandidate(name: string) {
    const { published, draft } = fixture.publishHeldCandidate(name)
    expect(appendOutcomeEvent(fixture.outcomeAppendConfig(), published.id, { type: 'confirmed',
      evidenceToken: asEvidenceToken(`confirm-${name}`), curationJobId: `confirm-${name}`, buildOrdinal: 42 }))
      .toEqual({ kind: 'appended' })
    const port = store()
    await port.recordGateReceipt(completeGate1Receipt(published.id, { producedAtOrdinal: 10 }))
    return { ...published, anchor: draft.anchors[0]!, port }
  }

  function status(dir: string) {
    const loaded = loadBundle(dir)
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind)
    return deriveBundleTrust(loaded.bundle).status
  }

  // Replaces: "derives stable schema-valid identity from candidate and both receipts". The hold
  // needs no identity: it is recomputed from the standing receipts on every promotion call.
  it('C432-INCONSISTENCY-HOLD: contradictory standing receipts hold promotion gate-inconsistent through the store', async () => {
    const candidate = await confirmedCandidate('contradicted')
    await candidate.port.recordGateReceipt(gate2(candidate.id, 'fail', 11))
    await expect(candidate.port.promote(candidate.id)).rejects.toMatchObject({ reason: 'gate-inconsistent' })
    expect(onPromotionOutcome).toHaveBeenLastCalledWith({ candidateId: candidate.id,
      promotionHoldReason: 'gate-inconsistent' })
    expect(status(candidate.dir)).toBe('candidate')
  })

  // Replaces: "retains applied/rejected after claim resolution, clears only the flag". No human
  // decision clears the hold any more; newer clean evidence is the only thing that does.
  it('newer clean evidence alone clears the hold, and the record is never deprecated automatically', async () => {
    const candidate = await confirmedCandidate('cleared')
    await candidate.port.recordGateReceipt(gate2(candidate.id, 'fail', 11))
    await expect(candidate.port.promote(candidate.id)).rejects.toMatchObject({ reason: 'gate-inconsistent' })
    expect(status(candidate.dir)).toBe('candidate')
    await candidate.port.recordGateReceipt(gate2(candidate.id, 'pass', 12))
    await expect(candidate.port.promote(candidate.id)).resolves.toMatchObject({ kind: 'promoted',
      promotionPath: 'gate1+gate2' })
    expect(status(candidate.dir)).toBe('active')
  })

  // Replaces: "measures the existing readProposal blind spot", "refuses a decided path carrying
  // another proposal" and "re-reads when a claim becomes applied/rejected/restored". The legacy
  // inbox is left on disk and never read, whatever state or shape its files are in.
  it('never reads the legacy inbox: pending, claimed, decided or corrupt files neither hold clean receipts nor clear a contradiction', async () => {
    const clean = await confirmedCandidate('clean')
    const held = await confirmedCandidate('held')
    const dir = join(agentQaRoot, 'proposals')
    mkdirSync(dir, { recursive: true })
    const legacy = (candidateId: string) => JSON.stringify({ schemaVersion: 1,
      proposalId: 'prop_0123456789abcdef', verb: 'accept', targetRef: { grain: 'record', recordId: candidateId },
      deltas: [{ kind: 'Deprecate', origin: 'system', scope: { tier: 'product', key: 'storefront' },
        citedIds: [candidateId], targetId: candidateId,
        reason: `gate-inconsistent:gate1-pass-gate2-fail:${'a'.repeat(64)}:${'b'.repeat(64)}` }],
      proposedAt: 10, status: 'pending' })
    writeFileSync(join(dir, 'prop_0123456789abcdef.json'), legacy(clean.id))
    writeFileSync(join(dir, `prop_1123456789abcdef.json.claimed.${process.pid}`), legacy(clean.id))
    writeFileSync(join(dir, 'prop_2123456789abcdef.rejected.json'), JSON.stringify({ proposal: { status: 'rejected' } }))
    writeFileSync(join(dir, 'prop_3123456789abcdef.applied.json'), legacy(held.id))
    writeFileSync(join(dir, 'prop_4123456789abcdef.json'), '{bad')
    const before = readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])
    await clean.port.recordGateReceipt(gate2(clean.id, 'pass', 11))
    await expect(clean.port.promote(clean.id)).resolves.toMatchObject({ promotionPath: 'gate1+gate2' })
    await held.port.recordGateReceipt(gate2(held.id, 'fail', 11))
    await expect(held.port.promote(held.id)).rejects.toMatchObject({ reason: 'gate-inconsistent' })
    expect(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')])).toEqual(before)
  })

  // Replaces: "rejects path-shaped proposal ids before filing". No id is minted, so there is no
  // path to shape; the held-out contradiction is held from the receipts instead.
  it('holds the held-out shape: a Gate-2 pass beside a Gate-1 failure that harmed a held-out row', async () => {
    const candidate = await confirmedCandidate('held-out')
    const base = completeGate1Receipt(candidate.id, { producedAtOrdinal: 12, verdict: 'fail' })
    const { receiptDigest: _digest, ...body } = base
    await candidate.port.recordGateReceipt(stampReceiptDigest({ ...body, harmed: [{ cassetteId: 'heldout-neighbour',
      decisionOrdinal: 0, origin: 'gate-set' as const, axes: ['headline' as const],
      split: 'held-out', verdictPresent: true }] }))
    await candidate.port.recordGateReceipt(gate2(candidate.id, 'pass', 13))
    await expect(candidate.port.promote(candidate.id)).rejects.toMatchObject({ reason: 'gate-inconsistent' })
  })

  it('keeps a sovereign Gate-3 pass above the contradiction', async () => {
    const candidate = await confirmedCandidate('sovereign')
    await candidate.port.recordGateReceipt(gate2(candidate.id, 'fail', 11))
    const g3 = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId: candidate.id, verdict: 'pass',
      producedAtOrdinal: 12, producedBy: { opId: 'test' }, runId: 'run-mark', mark: 'confirmed-bug' })
    await candidate.port.recordGateReceipt(g3)
    await expect(candidate.port.promote(candidate.id)).resolves.toMatchObject({ kind: 'promoted',
      promotionPath: 'user-sovereign', citedReceiptDigests: [g3.receiptDigest] })
  })

  // Retained control (D-08): automatic canary promotion in CI stays proposed. The harm is kept as
  // evidence, nothing is promoted, filed or deprecated, and no hold is reported for propose-only.
  it('keeps automatic CI canary promotion proposed: contradictory evidence is recorded, nothing is filed', async () => {
    const { published, draft } = fixture.publishHeldCandidate('ci')
    const port = store('ci')
    await port.recordGateReceipt(completeGate1Receipt(published.id, { producedAtOrdinal: 10 }))
    await port.recordCanaryOutcome({ candidateId: published.id, runOutcome: 'negative',
      benefit: 'exercised-harmed', stateValidity: 'valid', runId: 'run-ci-harm', testId: 'checkout::harm',
      testIndex: 0, buildOrdinal: 43, stepIndex: 1, briefDigest: 'brief-ci-harm',
      attribution: 'The served checkout hypothesis was exercised and harmed.',
      exercisedAnchor: draft.anchors[0]! })
    expect(onPromotionOutcome).not.toHaveBeenCalled()
    await expect(port.promote(published.id)).rejects.toMatchObject({ reason: 'propose-only' })
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect(status(published.dir)).toBe('candidate')
    const loaded = loadBundle(published.dir)
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind)
    expect(loaded.bundle.events.filter(event => event.type === 'contradicted')).toHaveLength(1)
  })
})
