import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_CURATION_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import {
  acquireWriterLease, appendOutcomeEvent, createLocalKnowledgeStore, deriveBundleTrust,
  loadBundle, openKnowledgeReader, publishBundleForTest,
} from '@vostride/agent-qa-knowledge-local'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, GATE_RECEIPT_SCHEMA_VERSION, asEvidenceToken, stampReceiptDigest, survivingOutcomeEvents, type CanaryOutcome } from '@vostride/agent-qa-schema'
import { buildPromotionPostureResolver } from '../curation/promotion-posture.js'
import { promotionHostProof } from './promotion-host-proof.js'

const scope = { tier: 'product', key: 'example-web' } as const
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function setup() {
  const root = mkdtempSync(join(tmpdir(), '418-lower-trust-lifecycle-'))
  roots.push(root)
  const configPath = join(root, 'agent-qa.config.yaml')
  promotionHostProof(configPath)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.eval = { gate2: { maxLowerTrustPerScope: 1 } }
  writeFileSync(configPath, JSON.stringify(config))
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const agentQaRoot = join(root, '.agent-qa')
  const appendConfig = { knowledgeRoot, productKey: scope.key,
    commitArtifacts: 'none' as const, writerLeaseId: 'fixture' }
  function seed(name: string) {
    const anchor = { t: 'el' as const, role: 'button', name, ordinal: 0 }
    const published = publishBundleForTest(appendConfig, {
      draft: { kind: 'fact', subtype: 'selector', scope, anchors: [anchor], summary: `${name} selector`,
        body: `Use the verified ${name} button.`, originStage: 'run-curation',
        distilledEvidenceRef: { id: `evidence-${name}`, sha: 'a'.repeat(64) } },
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'button', name } },
      originClass: 'agent-verified', createdAtOrdinal: 1, screenStates: [], relations: [], artifacts: [],
      initialEvents: [{ type: 'confirmed', evidenceToken: asEvidenceToken(`confirm-${name}`),
        curationJobId: `confirm-${name}`, buildOrdinal: 1 }],
      provenance: { mode: 'run-linked', runId: `seed-${name}`, testId: `seed-${name}`, stepIndex: 0,
        curationJobId: `seed-${name}`, sourceBuildOrdinal: 1 },
      evidenceMarkdown: 'Verified selector evidence.\n',
      distilledObservations: [{ schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION, step: { naturalKey: name, ordinal: 0 }, platform: 'web',
        element: { naturalKey: `button:${name}:0` }, observedAtOrdinal: 1 }],
    })
    if (published.kind !== 'published') throw new Error(published.kind)
    return { ...published, anchor }
  }
  const seeded = seed('checkout')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error(lease.kind)
  const replay = vi.fn(() => { throw new Error('automatic replay forbidden') })
  let ordinal = 15
  const posture = await buildPromotionPostureResolver({ configPath, knowledgeRoot, agentQaRoot,
    replayGate: { runReplayGate: replay }, currentBuildOrdinal: () => ordinal,
    canaryFacts: LOCAL_CURATION_CAPABILITIES.readCanaryPostureFacts,
    lowerTrustShares: LOCAL_CURATION_CAPABILITIES.readLowerTrustShares })
  if (posture.kind !== 'ready') throw new Error(JSON.stringify(posture))
  const corpusDigest = posture.host.corpusDigest
  const reports = vi.fn()
  const storeConfig = { knowledgeRoot, executionContext: 'local-interactive' as const,
    epoch: lease.epoch, writerLeaseId: lease.leaseId, sourceBuildOrdinal: ordinal,
    resolvePromotionPosture: posture.resolve, onPromotionOutcome: reports }
  const store = () => createLocalKnowledgeStore({ ...storeConfig, sourceBuildOrdinal: ordinal })
  function gate1(id = seeded.id, producedAtOrdinal = 10) {
    const score = { baseline: 0, candidate: 1, delta: 1, floor: 0.1, n: 3 }
    return stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 1, candidateId: id, verdict: 'pass',
      producedAtOrdinal, producedBy: { opId: 'fixture' },
      perAxisScore: { headline: score, elementIdentity: score, value: score, opClass: score, sideEffect: score, loop: score },
      corpusVersion: { corpusDigest, partitionVersion: 1, gateSetSize: 40, excludedCount: 0, minimumGateSet: 13 },
      samples: { k: 3, seeds: [1, 2, 3], seedHonored: true, modelCalls: 0 }, crossCheck: 'held' })
  }
  const read = () => {
    const loaded = loadBundle(seeded.dir)
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind)
    return loaded.bundle
  }
  const outcome = (): CanaryOutcome => ({
    candidateId: seeded.id, runOutcome: 'positive', benefit: 'rode-along', stateValidity: 'valid',
    runId: `canary-${ordinal}`, testId: 'checkout', testIndex: 0, stepIndex: 0, buildOrdinal: ordinal,
    exercisedAnchor: seeded.anchor, briefDigest: 'fixture-brief', attribution: 'Checkout was exercised.',
  })
  const reader = () => openKnowledgeReader({ knowledgeRoot, product: scope.key, scopeDefaults: { asOfBuild: ordinal } })
  await store().promote(seeded.id, [gate1()])
  return { root, configPath, knowledgeRoot, agentQaRoot, appendConfig, seeded, seed, store, gate1, read, outcome,
    reader, replay, reports, posture, storeConfig, advance: () => { ordinal += 1 } }
}

describe('418 lower-trust active lifecycle through real store, resolver and serving', () => {
  it('keeps new candidates capped and requires a new quiet horizon after a changed Gate-1', async () => {
    const f = await setup()
    const next = f.seed('payment')
    await expect(f.store().promote(next.id, [f.gate1(next.id)]))
      .rejects.toMatchObject({ reason: 'gate2-receipt-required' })
    await expect(f.store().promote(f.seeded.id, [f.gate1(f.seeded.id, 15)]))
      .rejects.toMatchObject({ reason: 'gate2-receipt-required' })
    expect(deriveBundleTrust(f.read()).status).toBe('candidate')
    expect(LOCAL_CURATION_CAPABILITIES.readCanaryPostureFacts({ knowledgeRoot: f.knowledgeRoot,
      candidateId: f.seeded.id, scope })).not.toHaveProperty('lowerTrustActiveGate1Digest')
  })

  it.each(['rollback', 'stale receipt'] as const)
  ('revalidates lower-trust authority against %s', async defect => {
    const f = await setup()
    f.advance()
    let expected: string
    if (defect === 'rollback') {
      appendOutcomeEvent(f.appendConfig, f.seeded.id, { type: 'retracted',
        evidenceToken: asEvidenceToken('rollback-confirm'), curationJobId: 'rollback-confirm',
        buildOrdinal: 16, retractsEvidenceToken: asEvidenceToken('confirm-checkout'),
        retractsCurationJobId: 'confirm-checkout', rollbackReceiptId: 'rollback-confirm' })
      expected = 'no-confirmed-evidence'
    } else {
      const current = f.posture.resolve
      f.posture.resolve = candidate => {
        const value = current(candidate)
        return value?.kind === 'resolved' ? { ...value, corpusDigest: 'f'.repeat(64) } : value
      }
      expected = 'receipt-stale'
    }
    // Real revalidation path; the stale-corpus row alters external posture DATA.
    const store = createLocalKnowledgeStore({ ...f.storeConfig, sourceBuildOrdinal: 16,
      resolvePromotionPosture: f.posture.resolve })
    await expect(store.promote(f.seeded.id)).rejects.toMatchObject({ reason: expected })
    expect(survivingOutcomeEvents(f.read().events).filter(row => row.type === 'promoted')).toHaveLength(0)
    expect(f.replay).not.toHaveBeenCalled()
  })
  // 2026-09-30, 432-10 D-05/D-22: re-spelled from the former 'pending inconsistency' row. A
  // leftover pending file no longer revalidates lower-trust authority away: it is never read.
  it('keeps lower-trust authority beside a legacy pending inconsistency file, which is never read', async () => {
    const f = await setup()
    f.advance()
    const inbox = join(f.agentQaRoot, 'proposals')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'prop_0123456789abcdef.json'), JSON.stringify({ schemaVersion: 1,
      proposalId: 'prop_0123456789abcdef', verb: 'accept', targetRef: { grain: 'record', recordId: f.seeded.id },
      deltas: [{ kind: 'Deprecate', origin: 'system', scope, citedIds: [f.seeded.id], targetId: f.seeded.id,
        reason: `gate-inconsistent:gate1-pass-gate2-fail:${f.gate1().receiptDigest}:${'d'.repeat(64)}` }],
      proposedAt: 10, status: 'pending' }))
    const store = createLocalKnowledgeStore({ ...f.storeConfig, sourceBuildOrdinal: 16,
      resolvePromotionPosture: f.posture.resolve })
    await expect(store.promote(f.seeded.id)).resolves.toMatchObject({ kind: 'already-active' })
    expect(deriveBundleTrust(f.read()).status).toBe('active')
    expect(readdirSync(inbox)).toEqual(['prop_0123456789abcdef.json'])
    expect(f.replay).not.toHaveBeenCalled()
  })
  it.each(['repeat promote', 'rode-along'] as const)('retains at-cap authority after %s', async action => {
    const f = await setup()
    expect(deriveBundleTrust(f.read()).status).toBe('active')
    expect(LOCAL_CURATION_CAPABILITIES.readLowerTrustShares({ knowledgeRoot: f.knowledgeRoot }))
      .toEqual([{ product: scope.key, active: 1, lowerTrust: 1 }])
    f.advance()
    if (action === 'repeat promote') {
      await expect(f.store().promote(f.seeded.id)).resolves.toMatchObject({ kind: 'already-active' })
    } else await f.store().recordCanaryOutcome(f.outcome())
    expect(deriveBundleTrust(f.read()).status).toBe('active')
    expect(f.reader().search('checkout', { scope })[0]).toMatchObject({ lowerTrust: true, servedAsCanary: true })
    expect(f.reader().getRunBrief(scope, 10_000).brief.tiers.L2).toContain('[LEARNED, UNCONFIRMED] [CANARY]')
    expect(f.read().events.filter(row => row.type === 'promoted')).toHaveLength(1)
    expect(f.replay).not.toHaveBeenCalled()
  })
})
