import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { asEvidenceToken, asRecordId, asRunId, type ImprovementPlan, IMPROVEMENT_PLAN_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { loadBundle, readGateReceipts } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import * as stores from '../../curator/knowledge-store.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { readPolicyLadder } from '../../serving/policy-ladder.js'
import { applyExplicitReview, ReviewTargetVanishedError } from '../apply-review.js'
import type { ApplyExplicitReviewInput } from '../apply-review.js'

// Crashes are injected at the store boundaries the commit crosses; retries answer the same receipt.

afterEach(() => vi.restoreAllMocks())
/**
 * Fail the change at a store boundary: before or after its Gate-3 receipt is recorded (the policy
 * arm), or after the mark's sovereign promotion lands (the mark arm).
 */
function injectAtGateReceipt(when: 'before' | 'after' | 'after-promote', message: string): void {
  const originalFactory = stores.createExplicitReviewStore
  vi.spyOn(stores, 'createExplicitReviewStore').mockImplementation(config => {
    const store = originalFactory(config)
    if (when === 'after-promote') {
      return { ...store, async promote(...args: Parameters<typeof store.promote>) {
        await store.promote(...args)
        throw new Error(message)
      } }
    }
    return { ...store, async recordGateReceipt(receipt) {
      if (when === 'after') await store.recordGateReceipt(receipt)
      throw new Error(message)
    } }
  })
}

async function applied(input: ApplyExplicitReviewInput) {
  const result = await applyExplicitReview(input)
  if (result.outcome !== 'applied') throw new Error(`change did not apply: ${result.outcome}`)
  return result
}

async function fixture(kind: 'policy' | 'fact' = 'policy') {
  const root = mkdtempSync(join(tmpdir(), 'policy-recovery-'))
  const knowledgeRoot = join(root, 'knowledge'), agentQaRoot = join(root, '.agent-qa')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('lease unavailable')
  const scope = { tier: 'product' as const, key: 'review' }
  const store = stores.createLocalKnowledgeStore({ knowledgeRoot,
    executionContext: 'local-interactive', epoch: lease.epoch, writerLeaseId: lease.leaseId })
  const draft = {
    kind, ...(kind === 'fact' ? { subtype: 'navigational' as const } : {}),
    scope, anchors: [{ t: 'page' as const, route: '/review' }],
    summary: 'Dismiss banner', body: 'Dismiss banner',
    distilledEvidenceRef: { id: 'review-evidence', sha: 'a'.repeat(64) }, originStage: 'run-curation' as const,
  }
  await store.commit([{ kind: 'Add', origin: 'user', scope, citedIds: [], bundle: draft }])
  const bundles = () => enumerateBundleDirs(knowledgeRoot).map(entry => {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') throw new Error('bundle unreadable')
    return { ...loaded.bundle, dir: entry.dir }
  })
  const recordId = bundles()[0]!.manifest.id
  let changes = 0
  const propose = (): ApplyExplicitReviewInput => ({ agentQaRoot, knowledgeRoot,
    operationId: `policy-recovery-${(changes += 1)}`, opId: 'knowledge.accept',
    executionContext: 'local-interactive',
    request: { verb: 'accept', input: { target: { grain: 'record', recordId } } },
    writerAuthority: { leaseId: lease.leaseId, epoch: lease.epoch } })
  return { root, knowledgeRoot, agentQaRoot, recordId, bundles, propose, draft, scope, lease,
    cleanup() { releaseLease({ knowledgeRoot, leaseId: lease.leaseId }); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['after-supersede', 'after-gate3'])('resumes %s without another Confirm or Supersede', async boundary => {
  const f = await fixture()
  try {
    const input = f.propose()
    if (boundary === 'after-supersede') injectAtGateReceipt('before', 'injected after Supersede')
    else injectAtGateReceipt('after', 'injected after Gate3')
    await expect(applyExplicitReview(input)).rejects.toThrow('injected')
    vi.restoreAllMocks()
    const before = f.bundles()
    const victim = before.find(bundle => bundle.manifest.id === f.recordId)!
    const superseded = victim.events.find(event => event.type === 'superseded')!
    const priorGates = readGateReceipts(victim.dir, f.recordId) ?? []
    expect(priorGates).toHaveLength(boundary === 'after-gate3' ? 1 : 0)
    const shelf = readFileSync(join(f.knowledgeRoot, 'policies/review.md'))
    const result = await applied(input)
    expect(result).toMatchObject({ outcome: 'applied', commitReceipt: {
      committedAtOrdinal: superseded.buildOrdinal, promoted: [], held: [],
      policy: { recordId: f.recordId, relPath: 'policies/review.md' },
    } })
    expect(f.bundles().map(bundle => bundle.events)).toEqual(before.map(bundle => bundle.events))
    expect(f.bundles()).toHaveLength(2)
    expect(readFileSync(join(f.knowledgeRoot, 'policies/review.md'))).toEqual(shelf)
    const gates = readGateReceipts(victim.dir, f.recordId)!
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ producedAtOrdinal: superseded.buildOrdinal,
      policyApproval: { proposalId: result.changeId, recordId: f.recordId } })
    expect(result.commitReceipt?.gate3[0]?.receiptDigest).toBe(gates[0]!.receiptDigest)
    if (boundary === 'after-gate3') expect(gates).toEqual(priorGates)
    expect(readPolicyLadder(f.knowledgeRoot, 'review').text).toContain('Dismiss banner')
    // The retry lands nothing: same records, same Gate-3 receipt, and the shelf is reported
    // unchanged because this call wrote nothing to it.
    expect(await applyExplicitReview(input)).toMatchObject({ outcome: 'applied', commitReceipt: {
      ...result.commitReceipt, policy: { ...result.commitReceipt?.policy, outcome: 'unchanged' } } })
    expect(readGateReceipts(victim.dir, f.recordId)).toEqual(gates)
  } finally { f.cleanup() }
})

it('keeps the isolated interrupted mark-apply control resumable through actual publication', async () => {
  const f = await fixture('fact')
  try {
    const mark = { markId: 'mark_0123456789ab', runId: asRunId('review-retry-run'),
      testIndex: 0, stepIndex: 0, kind: 'false-fail' as const, fix: 'fact' as const }
    const target = { grain: 'record' as const, recordId: f.recordId }
    const plan: ImprovementPlan = { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: mark.markId,
      feedbackSource: { runId: mark.runId, testIndex: 0, stepIndex: 0, kind: mark.kind },
      runTraceRef: { runId: mark.runId, runSlug: mark.runId }, kind: 'knowledge', fix: 'fact', target,
      deltas: [{ kind: 'Supersede', origin: 'user', scope: f.scope, citedIds: [asRecordId(f.recordId)],
        victimId: asRecordId(f.recordId), evidenceToken: asEvidenceToken(`mark:${mark.markId}`),
        newBundle: { ...f.draft, body: 'Use the review heading' } }], wording: 'floor' }
    const input: ApplyExplicitReviewInput = { agentQaRoot: f.agentQaRoot, knowledgeRoot: f.knowledgeRoot,
      operationId: 'policy-recovery-mark', opId: 'runs.mark', executionContext: 'local-interactive',
      request: { verb: 'mark', input: { target, mark, plan } },
      writerAuthority: { leaseId: f.lease.leaseId, epoch: f.lease.epoch } }
    injectAtGateReceipt('after-promote', 'injected mark publication')
    await expect(applyExplicitReview(input)).rejects.toThrow('injected mark publication')
    vi.restoreAllMocks()
    const result = await applied(input)
    expect(await applyExplicitReview(input)).toMatchObject({ outcome: 'applied', commitReceipt: result.commitReceipt })
  } finally { f.cleanup() }
})

it('refuses a missing authored section during recovery without recreating it', async () => {
  const f = await fixture()
  try {
    const input = f.propose()
    injectAtGateReceipt('after', 'injected publication')
    await expect(applyExplicitReview(input)).rejects.toThrow('injected')
    vi.restoreAllMocks()
    const shelf = join(f.knowledgeRoot, 'policies/review.md')
    rmSync(shelf)
    const before = f.bundles().map(bundle => bundle.events)
    await expect(applyExplicitReview(input)).rejects.toThrow('Policy text')
    expect(() => readFileSync(shelf)).toThrow()
    expect(f.bundles().map(bundle => bundle.events)).toEqual(before)
  } finally { f.cleanup() }
})

it('refuses a different change after the original was superseded without adding a Confirm', async () => {
  const f = await fixture()
  try {
    const first = f.propose(), other = f.propose()
    await applied(first)
    const before = f.bundles().map(bundle => bundle.events)
    await expect(applyExplicitReview(other)).rejects.toBeInstanceOf(ReviewTargetVanishedError)
    expect(f.bundles().map(bundle => bundle.events)).toEqual(before)
  } finally { f.cleanup() }
})
