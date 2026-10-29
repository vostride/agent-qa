import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GATE_RECEIPT_SCHEMA_VERSION, CURRENT_HANDOFF_SCHEMA_VERSION, asRecordId, asRunId, foldBundleTrust, stampReceiptDigest, type CompletedRunHandoff, type KnowledgeMarkInput } from '@vostride/agent-qa-schema'
import { makeBundleDraftFixture, makeScreenStateFixture, scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import { loadBundle, readGateReceipts } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { createLocalKnowledgeStore } from '../../curator/knowledge-store.js'
import { applyFeedback } from '../../feedback/apply-feedback.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import * as stores from '../../curator/knowledge-store.js'
import { applyExplicitReview } from '../apply-review.js'
import type { ApplyExplicitReviewInput } from '../apply-review.js'

// RE-SPELLED 2026-10-01: the first cell applied its mark through a filed
// proposal and the proposal door. It now applies the same mark directly under a stable operation
// identity (the mark intent's identity), the interruption is injected after the sovereign promotion
// lands instead of at the deleted applied-record publication, and "already-applied" is the
// same-identity retry answering the same commit receipt.
async function applyMark(
  agentQaRoot: string, knowledgeRoot: string, operationId: string,
  input: KnowledgeMarkInput,
) {
  const request: ApplyExplicitReviewInput = { agentQaRoot, knowledgeRoot, operationId, opId: 'runs.mark',
    executionContext: 'local-interactive', request: { verb: 'mark', input } }
  const result = await applyExplicitReview(request)
  if (result.outcome !== 'applied') throw new Error(`mark did not apply: ${result.outcome}`)
  return result
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each([false, true])('commits a real same-kind same-anchor floor replacement before sovereign promotion (interrupted=%s)', async interrupted => {
  const root = mkdtempSync(join(tmpdir(), 'mark-supersession-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'knowledge')
  const agentQaRoot = join(root, '.agent-qa')
  scaffoldKnowledgeRoot(knowledgeRoot)
  const draft = makeBundleDraftFixture({ anchors: [{ t: 'page', route: '/products' }] })
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('fixture lease unavailable')
  try {
    const store = createLocalKnowledgeStore({ knowledgeRoot,
      executionContext: 'local-interactive', writerLeaseId: lease.leaseId, epoch: lease.epoch,
      sourceBuildOrdinal: 6 })
    await store.commit([{ kind: 'Add', origin: 'user', scope: draft.scope, citedIds: [], bundle: draft }])
    const loaded = loadBundle(enumerateBundleDirs(knowledgeRoot)[0]!.dir)
    if (loaded.kind !== 'loaded') throw new Error('fixture must load')
    await store.promote(asRecordId(loaded.bundle.manifest.id), [stampReceiptDigest({
      schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId: loaded.bundle.manifest.id, verdict: 'pass',
      producedAtOrdinal: 6, producedBy: { opId: 'knowledge.proposal.apply' },
      runId: 'prior-approved-run', mark: 'false-fail',
    })])
  } finally { releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
  const bundles = () => enumerateBundleDirs(knowledgeRoot).map(entry => {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') throw new Error('bundle must load through the real guard')
    return { dir: entry.dir, bundle: loaded.bundle }
  })
  const original = bundles()[0]!
  const recordId = original.bundle.manifest.id
  expect(foldBundleTrust(original.bundle.events, original.bundle.manifest)).toMatchObject({
    status: 'active', validity: { openedAtOrdinal: 6 },
  })
  expect(original.bundle.events.some(event => event.type === 'window-close')).toBe(false)
  const runId = asRunId('mark-supersession-run')
  const mark = { markId: 'mark_0123456789ab', runId, runSlug: 'mark-supersession-run',
    testIndex: 0, stepIndex: 0, kind: 'false-fail' as const }
  const handoff: CompletedRunHandoff = { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId, scope: draft.scope,
    buildOrdinal: 7, executionContext: 'local-interactive', aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: '', testConfigDigest: '' }, startedAt: 0, endedAt: 1,
    tests: [{ testId: 'products', testName: 'Products', filePath: 'products.yaml',
      testIndex: 0, outcome: 'failed', steps: [{ stepIndex: 0,
      stepText: 'Open products', cacheStatus: 'miss', servedBrief: { scope: draft.scope,
        asOfBuild: 6, budget: 200, truncation: '', briefDigest: 'brief', channel2: [], channel3: [],
        channel1: [{ id: asRecordId(recordId), kind: 'fact', summary: draft.summary,
          trust: 1, status: 'active', servedAsCanary: false, tier: '1' }] },
      subActions: [{ plan: 'Open products', plannedAction: { type: 'delay', ms: 1 },
        stateBefore: makeScreenStateFixture(), result: { success: true } }],
      verifierVerdict: { pass: false, reasoning: 'Products were shown despite the failed verdict' },
    }] }] }
  const plan = applyFeedback({ mark, handoff, resolvedStepIndex: 0,
    served: [{ recordId, ...draft }] })
  expect(plan.kind).toBe('knowledge')
  if (plan.kind !== 'knowledge') throw new Error('expected knowledge floor')
  expect(plan.deltas[0]).toMatchObject({ kind: 'Supersede', victimId: recordId,
    newBundle: { kind: draft.kind, subtype: draft.subtype, anchors: draft.anchors } })
  const markInput = {
    target: plan.target, plan, mark: { markId: mark.markId, runId, testIndex: 0,
      stepIndex: 0, kind: mark.kind, fix: plan.fix },
  }
  const operationId = 'mark-supersession-first'
  let beforeRetry: unknown
  if (interrupted) {
    const originalFactory = stores.createExplicitReviewStore
    const spy = vi.spyOn(stores, 'createExplicitReviewStore').mockImplementation(config => {
      const store = originalFactory(config)
      return { ...store, async promote(...args: Parameters<typeof store.promote>) {
        await store.promote(...args)
        throw new Error('injected interrupted mark publication')
      } }
    })
    await expect(applyMark(agentQaRoot, knowledgeRoot, operationId, markInput)).rejects.toThrow('injected')
    spy.mockRestore()
    beforeRetry = bundles().map(row => ({ id: row.bundle.manifest.id, events: row.bundle.events,
      gates: readGateReceipts(row.dir, row.bundle.manifest.id) }))
  }
  const result = await applyMark(agentQaRoot, knowledgeRoot, operationId, markInput)
  if (interrupted) expect(bundles().map(row => ({ id: row.bundle.manifest.id, events: row.bundle.events,
    gates: readGateReceipts(row.dir, row.bundle.manifest.id) }))).toEqual(beforeRetry)
  expect(result.commitReceipt?.held).toEqual([])
  expect(result.commitReceipt?.promoted).toEqual([{ candidateId: expect.any(String), promotionPath: 'user-sovereign' }])
  const replacementId = result.commitReceipt!.recordIds[0]!
  expect(replacementId).not.toBe(recordId)
  const replacement = bundles().find(row => row.bundle.manifest.id === replacementId)!
  const delta = plan.deltas[0]!
  if (delta.kind !== 'Supersede') throw new Error('expected supersession')
  expect(replacement.bundle.body).toBe(delta.newBundle.body)
  expect(replacement.bundle.frontmatter.originClass).toBe('user')
  expect(replacement.bundle.events.some(event => event.type === 'promoted')).toBe(true)
  expect(replacement.bundle.events.some(event => event.type === 'window-close')).toBe(false)
  expect(readGateReceipts(replacement.dir, replacementId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ gate: 3, verdict: 'pass', candidateId: replacementId }),
    expect.objectContaining({ kind: 'promotion', promotionPath: 'user-sovereign' }),
  ]))
  const victim = bundles().find(row => row.bundle.manifest.id === recordId)!.bundle
  expect(victim.body).toBe(original.bundle.body)
  expect(victim.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'superseded', byRecordId: replacementId }),
    expect.objectContaining({ type: 'window-close' }),
  ]))
  const repeat = await applyMark(agentQaRoot, knowledgeRoot, operationId, markInput)
  expect(repeat.commitReceipt).toEqual(result.commitReceipt)
  expect(bundles()).toHaveLength(2)
  // A later actual correction of the same semantic fact gets its own generation.
  const nextMark = { ...mark, markId: 'mark_1123456789ab', note: 'Use the product list heading' }
  const nextPlan = applyFeedback({ mark: nextMark, handoff, resolvedStepIndex: 0,
    served: [{ recordId: replacementId, ...delta.newBundle }] })
  if (nextPlan.kind !== 'knowledge') throw new Error('expected subsequent knowledge floor')
  const corrected = await applyMark(agentQaRoot, knowledgeRoot, 'mark-supersession-next', {
    target: nextPlan.target, plan: nextPlan, mark: { markId: nextMark.markId, runId,
      testIndex: 0, stepIndex: 0, kind: nextMark.kind, fix: nextPlan.fix },
  })
  expect(corrected.commitReceipt?.held).toEqual([])
  const nextId = corrected.commitReceipt!.recordIds[0]!
  expect(new Set([recordId, replacementId, nextId]).size).toBe(3)
  expect(corrected.commitReceipt?.promoted).toEqual([{ candidateId: nextId, promotionPath: 'user-sovereign' }])
  expect(bundles().find(row => row.bundle.manifest.id === replacementId)!.bundle.events)
    .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'superseded', byRecordId: nextId })]))
  expect(bundles()).toHaveLength(3)
})

it('applies the same real floor replacement through the direct writer in ci, once per operation, and a later mark supersedes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mark-supersession-direct-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'knowledge')
  const agentQaRoot = join(root, '.agent-qa')
  scaffoldKnowledgeRoot(knowledgeRoot)
  const draft = makeBundleDraftFixture({ anchors: [{ t: 'page', route: '/products' }] })
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('fixture lease unavailable')
  try {
    const store = createLocalKnowledgeStore({ knowledgeRoot,
      executionContext: 'local-interactive', writerLeaseId: lease.leaseId, epoch: lease.epoch,
      sourceBuildOrdinal: 6 })
    await store.commit([{ kind: 'Add', origin: 'user', scope: draft.scope, citedIds: [], bundle: draft }])
  } finally { releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
  const bundles = () => enumerateBundleDirs(knowledgeRoot).map(entry => {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') throw new Error('bundle must load through the real guard')
    return { dir: entry.dir, bundle: loaded.bundle }
  })
  const recordId = bundles()[0]!.bundle.manifest.id
  const runId = asRunId('mark-supersession-direct-run')
  const mark = { markId: 'mark_2123456789ab', runId, runSlug: 'mark-supersession-direct-run',
    testIndex: 0, stepIndex: 0, kind: 'false-fail' as const }
  const handoff: CompletedRunHandoff = { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId, scope: draft.scope,
    buildOrdinal: 7, executionContext: 'ci', aggregateVerdict: 'failed',
    configDigests: { suiteConfigDigest: '', testConfigDigest: '' }, startedAt: 0, endedAt: 1,
    tests: [{ testId: 'products', testName: 'Products', filePath: 'products.yaml',
      testIndex: 0, outcome: 'failed', steps: [{ stepIndex: 0,
      stepText: 'Open products', cacheStatus: 'miss', servedBrief: { scope: draft.scope,
        asOfBuild: 6, budget: 200, truncation: '', briefDigest: 'brief', channel2: [], channel3: [],
        channel1: [{ id: asRecordId(recordId), kind: 'fact', summary: draft.summary,
          trust: 1, status: 'candidate', servedAsCanary: false, tier: '1' }] },
      subActions: [{ plan: 'Open products', plannedAction: { type: 'delay', ms: 1 },
        stateBefore: makeScreenStateFixture(), result: { success: true } }],
      verifierVerdict: { pass: false, reasoning: 'Products were shown despite the failed verdict' },
    }] }] }
  const plan = applyFeedback({ mark, handoff, resolvedStepIndex: 0, served: [{ recordId, ...draft }] })
  if (plan.kind !== 'knowledge') throw new Error('expected knowledge floor')
  const direct = (operationId: string, markId: string, fixPlan: typeof plan) => applyExplicitReview({
    agentQaRoot, knowledgeRoot, executionContext: 'ci', opId: 'runs.mark', operationId,
    request: { verb: 'mark', input: { target: fixPlan.target, plan: fixPlan,
      mark: { markId, runId, testIndex: 0, stepIndex: 0, kind: mark.kind, fix: fixPlan.fix } } } })
  const result = await direct('0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607', mark.markId, plan)
  if (result.outcome !== 'applied') throw new Error('expected the direct fix to apply')
  const replacementId = result.recordIds[0]!
  expect(replacementId).not.toBe(recordId)
  expect(result.commitReceipt).toMatchObject({ held: [], promoted: [{ candidateId: replacementId,
    promotionPath: 'user-sovereign' }] })
  const replacement = bundles().find(row => row.bundle.manifest.id === replacementId)!
  expect(replacement.bundle.provenance).toMatchObject({ authorship: { executionContext: 'ci' } })
  expect(readGateReceipts(replacement.dir, replacementId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ gate: 3, producedBy: { opId: 'runs.mark' }, runId }),
  ]))
  expect(existsSync(join(agentQaRoot, 'proposals')), 'no inbox envelope on the direct door').toBe(false)
  expect(await direct('0b1c2d3e-4f50-4a61-8b72-9c83d4e5f607', mark.markId, plan)).toEqual(result)
  expect(bundles()).toHaveLength(2)
  const delta = plan.deltas[0]!
  if (delta.kind !== 'Supersede') throw new Error('expected supersession')
  const nextMark = { ...mark, markId: 'mark_3123456789ab', note: 'Use the product list heading' }
  const nextPlan = applyFeedback({ mark: nextMark, handoff, resolvedStepIndex: 0,
    served: [{ recordId: replacementId, ...delta.newBundle }] })
  if (nextPlan.kind !== 'knowledge') throw new Error('expected subsequent knowledge floor')
  const corrected = await direct('1c2d3e4f-5061-4b72-8c83-9d94e5f60718', nextMark.markId, nextPlan)
  if (corrected.outcome !== 'applied') throw new Error('expected the later fix to apply')
  const nextId = corrected.recordIds[0]!
  expect(new Set([recordId, replacementId, nextId]).size).toBe(3)
  expect(bundles().find(row => row.bundle.manifest.id === replacementId)!.bundle.events)
    .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'promoted' }),
      expect.objectContaining({ type: 'superseded', byRecordId: nextId })]))
  expect(bundles()).toHaveLength(3)
})
