// 432-06: the direct explicit knowledge writer (D-04, D-05, D-08, D-09, D-11).
//
// An explicit mark, accept, reject or forget is authority in every execution context, so it
// lands in the call: no inbox envelope is written or read, the actual ExecutionContext is kept
// on the durable record, and the writer lease, delta validation and every promotion gate still
// apply. Automatic curation keeps its own context profile (ci/cloud stay
// proposed), which is why the two matrices are measured separately below.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  asRunId,
  type Anchor,
  type ExecutionContext,
  type KnowledgeMarkInput,
  type ScopeKey,
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import { loadBundle, readGateReceipts } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { UserDeltaCitationIntegrityError } from '../../curator/disposition.js'
import { createLocalKnowledgeStore } from '../../curator/knowledge-store.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { listBundles } from '../../list-bundles.js'
import * as promotionGateInput from '../../promotion-gate-input.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import * as review from '../apply-review.js'
import type {
  ApplyExplicitReviewInput,
  ExplicitReviewDelegation,
  ExplicitReviewResult,
} from '../apply-review.js'

const EXECUTION_CONTEXTS = ['local-interactive', 'local-headless', 'ci', 'cloud'] as const satisfies
  readonly ExecutionContext[]
const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'direct-storefront' }
const OPERATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const LATER_OPERATION = '7a2d3b4c-5e6f-4a71-9b8c-0d1e2f3a4b5c'

function hashTree(root: string): string {
  const digest = createHash('sha256')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        digest.update(`D:${relative(root, path)}\n`)
        walk(path)
        continue
      }
      digest.update(`F:${relative(root, path)}:${statSync(path).size}:`)
      digest.update(readFileSync(path))
      digest.update('\n')
    }
  }
  walk(root)
  return digest.digest('hex')
}

/**
 * Canonical bundle bytes only: every file under `memory/` except the derived index. Lease
 * acquisition bumps `.epoch` and re-projection rewrites `memory/index`; neither is an effect of
 * the change itself, so "lands once" is measured over what a retry could actually duplicate.
 */
function canonicalFiles(knowledgeRoot: string): string[] {
  const found: string[] = []
  const memory = join(knowledgeRoot, 'memory')
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (path !== join(memory, 'index')) walk(path)
        continue
      }
      found.push(`${relative(knowledgeRoot, path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    }
  }
  walk(memory)
  return found.sort()
}

/** The direct writer, asserted present before it is called so its absence is an assertion. */
async function explicit(input: ApplyExplicitReviewInput): Promise<ExplicitReviewResult> {
  const writer = (review as Record<string, unknown>).applyExplicitReview
  expect(writer, 'the direct explicit review writer is exported').toBeTypeOf('function')
  return await (writer as (input: ApplyExplicitReviewInput) => Promise<ExplicitReviewResult>)(input)
}

/** A refusal becomes a value, so the witness fails on its own assertion and prints the reason. */
async function settled(input: ApplyExplicitReviewInput): Promise<ExplicitReviewResult | { outcome: 'refused'; reason: string }> {
  return await explicit(input).catch((error: unknown) => ({
    outcome: 'refused' as const,
    reason: error instanceof Error ? `${error.name}: ${(error as { reason?: string }).reason ?? error.message}` : String(error),
  }))
}

describe('direct explicit knowledge writer', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-direct-review-'))
    useRoot('default')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function useRoot(name: string): void {
    knowledgeRoot = join(root, name, 'agent-qa-knowledge')
    agentQaRoot = join(root, name, '.agent-qa')
    scaffoldKnowledgeRoot(knowledgeRoot)
  }

  function storeConfig(): BundleStoreConfig {
    return { knowledgeRoot, productKey: 'Direct Product' }
  }

  function publish(summary: string, kind: 'fact' | 'policy' = 'fact'): string {
    const outcome = publishBundle(storeConfig(), {
      draft: makeBundleDraftFixture(kind === 'policy'
        ? { kind: 'policy', body: `Rule: ${summary}`, summary, scope: SCOPE }
        : { kind: 'fact', anchors: [ANCHOR], scope: SCOPE, summary }),
      discriminant: kind === 'policy'
        ? { kind: 'policy', ruleKey: summary.replace(/[^a-z0-9]+/gi, '-').toLowerCase() }
        : { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: summary } },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: kind === 'policy'
        ? { mode: 'standalone', sourceDescription: 'direct policy fixture' }
        : { mode: 'run-linked', runId: `direct-${summary}`, testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  function markInput(recordId: string, options: { markId?: string; body?: string } = {}): KnowledgeMarkInput {
    const target = { grain: 'record' as const, recordId }
    const runId = asRunId('direct-mark-run')
    const markId = options.markId ?? 'mark_0123456789ab'
    const mark = { markId, runId, testIndex: 1, stepIndex: 2, kind: 'false-fail' as const, fix: 'fact' as const }
    const newBundle = makeBundleDraftFixture({ kind: 'fact', subtype: 'navigational', scope: SCOPE,
      anchors: [ANCHOR], summary: 'Navigational fact: open the checkout panel first',
      ...(options.body === undefined ? {} : { body: options.body }) })
    return { target, mark, plan: { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId, kind: 'knowledge', fix: 'fact', target,
      wording: 'floor', feedbackSource: { runId, testIndex: 1, stepIndex: 2, kind: mark.kind },
      runTraceRef: { runId, runSlug: runId }, deltas: [{ kind: 'Supersede', origin: 'user', scope: SCOPE,
        citedIds: [asRecordId(recordId)], victimId: asRecordId(recordId),
        evidenceToken: asEvidenceToken(`mark:${markId}`), newBundle }] } }
  }

  function base(executionContext: ExecutionContext) {
    return { agentQaRoot, knowledgeRoot, executionContext, operationId: OPERATION,
      opId: 'knowledge.change.apply' }
  }

  function bundle(recordId: string) {
    for (const entry of enumerateBundleDirs(knowledgeRoot)) {
      const loaded = loadBundle(entry.dir)
      if (loaded.kind === 'loaded' && loaded.bundle.manifest.id === recordId) return { dir: entry.dir, bundle: loaded.bundle }
    }
    throw new Error(`no bundle ${recordId}`)
  }

  function status(recordId: string): string | undefined {
    return listBundles(knowledgeRoot).find(row => row.bundleId === recordId)?.status
  }

  // 2026-10-01 (432-14): an explicit per-test timeout, on 432-09's label-calibration precedent. The
  // cell drives four contexts through a real writer lease and promotion gates (about 4 s alone); in
  // the forced workspace gate beside the rest of this package it took 17-20 s and reached vitest's
  // 15 s default in three consecutive runs. The claim is unchanged.
  it('explicit mark, accept, reject and forget apply in every execution context, including explicit CI promotion', async () => {
    for (const context of EXECUTION_CONTEXTS) {
      useRoot(context)

      const victim = publish(`checkout ${context}`)
      const marked = await settled({ ...base(context), request: { verb: 'mark', input: markInput(victim) } })
      expect(marked, `${context} mark lands in the call`).toMatchObject({ outcome: 'applied', verb: 'mark',
        changeId: `prop_${OPERATION}` })
      if (marked.outcome !== 'applied') throw new Error('mark did not apply')
      const replacement = marked.recordIds[0]!
      expect(marked.recordIds).toEqual([replacement])
      expect(replacement).not.toBe(victim)
      expect(marked.commitReceipt, `${context} explicit mark promotes through the sovereign gate`).toMatchObject({
        proposalId: `prop_${OPERATION}`, markId: 'mark_0123456789ab', recordIds: [replacement], held: [],
        promoted: [{ candidateId: replacement, promotionPath: 'user-sovereign' }],
      })
      expect(status(victim)).toBe('superseded')
      expect(status(replacement)).toBe('active')
      const committed = bundle(replacement)
      expect(committed.bundle.frontmatter.originClass).toBe('user')
      expect(committed.bundle.relations.relations).toContainEqual(expect.objectContaining({ type: 'supersedes', targetId: victim }))
      expect(committed.bundle.relations.relations).not.toContainEqual(expect.objectContaining({ type: 'proposed-supersession-of' }))
      expect(committed.bundle.provenance, 'the durable record keeps the actual context').toMatchObject({
        mode: 'run-linked', runId: 'direct-mark-run', authorship: { executionContext: context } })
      expect(readGateReceipts(committed.dir, replacement)).toEqual(expect.arrayContaining([
        expect.objectContaining({ gate: 3, verdict: 'pass', candidateId: replacement,
          producedBy: { opId: 'knowledge.change.apply' }, runId: 'direct-mark-run', stepId: '1:2', mark: 'false-fail' }),
        expect.objectContaining({ kind: 'promotion', promotionPath: 'user-sovereign' }),
      ]))

      const accepted = publish(`accept ${context}`)
      const accept = await settled({ ...base(context), request: { verb: 'accept',
        input: { target: { grain: 'record', recordId: accepted } } } })
      expect(accept, `${context} accept lands in the call`).toMatchObject({ outcome: 'applied', verb: 'accept',
        recordIds: [accepted] })
      expect(bundle(accepted).bundle.events).toContainEqual(expect.objectContaining({ type: 'confirmed',
        origin: 'user', evidenceToken: `review-accept:prop_${OPERATION}` }))

      const rejected = publish(`reject ${context}`)
      const reject = await settled({ ...base(context), request: { verb: 'reject',
        input: { target: { grain: 'record', recordId: rejected }, reason: 'wrong button' } } })
      expect(reject, `${context} reject lands in the call`).toMatchObject({ outcome: 'applied', verb: 'reject',
        recordIds: [rejected] })
      expect(status(rejected)).toBe('deprecated')

      const forgotten = publish(`forget ${context}`)
      const forget = await settled({ ...base(context), now: () => 1_700_000_000_000, request: { verb: 'forget',
        input: { target: { grain: 'record', recordId: forgotten } } } })
      expect(forget, `${context} forget lands in the call`).toMatchObject({ outcome: 'applied', verb: 'forget',
        recordIds: [forgotten], forgetReceipt: { proposalId: `prop_${OPERATION}`,
          tombstonedRecords: [{ recordId: forgotten }], projectionsScrubbed: ['fts', 'vec', 'graph'],
          resultingBundleStatus: 'tombstoned', forgottenAt: 1_700_000_000_000 } })
      expect(status(forgotten)).toBe('deprecated')

      expect(existsSync(join(agentQaRoot, 'proposals')), `${context} writes no inbox envelope`).toBe(false)
    }
  }, 120_000)

  it('explicit policy accept materializes in ci under the actual context', async () => {
    const recordId = publish('Dismiss the cookie banner', 'policy')
    const result = await explicit({ ...base('ci'), request: { verb: 'accept',
      input: { target: { grain: 'record', recordId } } } })
    expect(result).toMatchObject({ outcome: 'applied', recordIds: [recordId], commitReceipt: {
      policy: { recordId, scope: 'direct-storefront', relPath: 'policies/direct-storefront.md', outcome: 'written' },
      promoted: [] } })
    expect(readFileSync(join(knowledgeRoot, 'policies/direct-storefront.md'), 'utf8'))
      .toContain(`<!-- agent-qa:policy ${recordId} -->`)
    expect(status(recordId)).toBe('superseded')
    expect(readGateReceipts(bundle(recordId).dir, recordId)).toEqual([expect.objectContaining({ gate: 3,
      producedBy: { opId: 'knowledge.change.apply' }, policyApproval: { proposalId: `prop_${OPERATION}`, recordId } })])
    const files = canonicalFiles(knowledgeRoot)
    const again = await explicit({ ...base('ci'), request: { verb: 'accept', input: { target: { grain: 'record', recordId } } } })
    if (result.outcome !== 'applied' || result.commitReceipt?.policy === undefined) throw new Error('policy did not apply')
    expect(again, 'a retry recovers the same approval and says the shelf was left unchanged').toEqual({ ...result,
      commitReceipt: { ...result.commitReceipt, policy: { ...result.commitReceipt.policy, outcome: 'unchanged' } } })
    expect(canonicalFiles(knowledgeRoot)).toEqual(files)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  it('a held lease is delegated the direct request, bounded and never stolen', async () => {
    const recordId = publish('delegated checkout')
    const request = { verb: 'forget' as const, input: { target: { grain: 'record' as const, recordId } } }
    const holder = acquireWriterLease(knowledgeRoot)
    if (holder.kind !== 'acquired') throw new Error('fixture could not take the lease')
    try {
      const before = hashTree(knowledgeRoot)
      await expect(explicit({ ...base('ci'), request })).rejects.toBeInstanceOf(review.ApplyDelegateUnavailableError)

      const seen: ExplicitReviewDelegation[] = []
      const answer: ExplicitReviewResult = { outcome: 'applied', verb: 'forget', changeId: `prop_${OPERATION}`,
        recordIds: [recordId] }
      const delegated = await explicit({ ...base('ci'), request, delegate: async delegation => {
        seen.push(delegation)
        return answer
      } })
      expect(seen, 'the holder receives the validated request and the stable identity, nothing else')
        .toEqual([{ request, operationId: OPERATION }])
      expect(delegated).toEqual(answer)

      await expect(explicit({ ...base('ci'), request, delegateTimeoutMs: 25,
        delegate: () => new Promise(() => {}) })).rejects.toBeInstanceOf(review.ApplyDelegateTimeoutError)
      expect(acquireWriterLease(knowledgeRoot).kind, 'delegating never takes the lease').toBe('held')
      expect(hashTree(knowledgeRoot)).toBe(before)

      await expect(explicit({ ...base('ci'), request, writerAuthority: holder, delegate: async () => answer }))
        .rejects.toBeInstanceOf(TypeError)

      const held = await explicit({ ...base('ci'), request, writerAuthority: { leaseId: holder.leaseId, epoch: holder.epoch } })
      expect(held, 'the holder commits in process with its own authority').toMatchObject({ outcome: 'applied',
        recordIds: [recordId] })
      expect(status(recordId)).toBe('deprecated')
    } finally {
      releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
    }
  })

  it('a repeated operation identity lands its effects once and returns the same record ids, and a later mark leaves the earlier fix intact', async () => {
    const victim = publish('retried checkout')
    const request = { verb: 'mark' as const, input: markInput(victim) }
    const first = await explicit({ ...base('ci'), request })
    if (first.outcome !== 'applied') throw new Error('mark did not apply')
    const afterFirst = canonicalFiles(knowledgeRoot)
    const second = await explicit({ ...base('ci'), request })
    expect(second, 'a retry answers the same applied record ids and receipt').toEqual(first)
    expect(canonicalFiles(knowledgeRoot), 'a retry adds no second effect').toEqual(afterFirst)
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(2)

    const accepted = publish('retried accept')
    const acceptRequest = { verb: 'accept' as const, input: { target: { grain: 'record' as const, recordId: accepted } } }
    const acceptFirst = await explicit({ ...base('ci'), request: acceptRequest })
    const acceptTree = canonicalFiles(knowledgeRoot)
    expect(await explicit({ ...base('ci'), request: acceptRequest })).toEqual(acceptFirst)
    expect(canonicalFiles(knowledgeRoot)).toEqual(acceptTree)
    expect(bundle(accepted).bundle.events.filter(event => event.type === 'confirmed'
      && event.evidenceToken === `review-accept:prop_${OPERATION}`)).toHaveLength(1)

    const forgotten = publish('retried forget')
    const forgetRequest = { verb: 'forget' as const, input: { target: { grain: 'record' as const, recordId: forgotten } } }
    const forgetFirst = await explicit({ ...base('ci'), request: forgetRequest })
    const forgetTree = canonicalFiles(knowledgeRoot)
    const forgetAgain = await explicit({ ...base('ci'), request: forgetRequest })
    // RE-SPELLED 2026-10-02 (quick 261002-lse, 432-16 #3): the retry answers the FIRST receipt byte
    // for byte, as the mark and the accept above do. It used to re-mint `forgottenAt` and claim an
    // empty scrub list, which this leg pinned.
    expect(forgetAgain).toMatchObject({ outcome: 'applied', recordIds: [forgotten],
      forgetReceipt: { tombstonedRecords: [{ recordId: forgotten }],
        projectionsScrubbed: ['fts', 'vec', 'graph'] } })
    expect(JSON.stringify(forgetAgain)).toBe(JSON.stringify(forgetFirst))
    expect(forgetFirst.outcome === 'applied' && forgetFirst.recordIds).toEqual([forgotten])
    expect(canonicalFiles(knowledgeRoot), 'an already-forgotten target is not destroyed twice').toEqual(forgetTree)
    expect(bundle(forgotten).bundle.events.filter(event => event.type === 'deprecated')).toHaveLength(1)

    const replacement = first.recordIds[0]!
    const later = await explicit({ ...base('ci'), operationId: LATER_OPERATION, request: { verb: 'mark',
      input: markInput(replacement, { markId: 'mark_1123456789ab', body: 'Open the checkout drawer first' }) } })
    if (later.outcome !== 'applied') throw new Error('later mark did not apply')
    const next = later.recordIds[0]!
    expect(new Set([victim, replacement, next]).size).toBe(3)
    expect(later.commitReceipt?.promoted).toEqual([{ candidateId: next, promotionPath: 'user-sovereign' }])
    expect(status(next)).toBe('active')
    expect(status(replacement), 'the latest mark wins').toBe('superseded')
    const earlier = bundle(replacement).bundle
    expect(earlier.events, 'the earlier applied fix is superseded, never retracted').toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'promoted' }),
      expect.objectContaining({ type: 'superseded', byRecordId: next }),
    ]))
    expect(earlier.events.some(event => event.type === 'retracted')).toBe(false)
    expect(status(victim)).toBe('superseded')
  })

  it.each(['Add', 'Confirm'] as const)('a retried %s-shaped mark lands its fix once and answers the same receipt', async kind => {
    const target = publish(`retried ${kind} checkout`)
    const input = markInput(target)
    const delta = input.plan.deltas[0]!
    const shared = { origin: delta.origin, scope: delta.scope, citedIds: delta.citedIds,
      evidenceToken: asEvidenceToken(`mark:${input.mark.markId}`) }
    const request = { verb: 'mark' as const, input: { ...input, plan: { ...input.plan, deltas: [kind === 'Add'
      ? { ...shared, kind: 'Add' as const, bundle: makeBundleDraftFixture({ kind: 'caution', scope: SCOPE,
        anchors: [ANCHOR], summary: 'Avoid stale checkout state' }) }
      : { ...shared, kind: 'Confirm' as const, targetId: asRecordId(target) }] } } }
    const first = await explicit({ ...base('ci'), request })
    if (first.outcome !== 'applied') throw new Error('mark did not apply')
    const fixed = first.recordIds[0]!
    expect(first.commitReceipt?.promoted).toEqual([{ candidateId: fixed, promotionPath: 'user-sovereign' }])
    const files = canonicalFiles(knowledgeRoot)
    expect(await explicit({ ...base('ci'), request }), 'the same ids, ordinal and Gate-3 digest').toEqual(first)
    expect(canonicalFiles(knowledgeRoot), 'no second confirmation, gate receipt or promotion').toEqual(files)
    expect(bundle(fixed).bundle.events.filter(event => event.type === 'confirmed')).toHaveLength(1)
    expect(readGateReceipts(bundle(fixed).dir, fixed)?.filter(line => 'gate' in line && line.gate === 3)).toHaveLength(1)
  })

  it('an explicit accept over a tombstoned target refuses by type and moves no committed byte', async () => {
    const recordId = publish('tombstoned accept')
    const rejected = await explicit({ ...base('ci'), request: { verb: 'reject',
      input: { target: { grain: 'record', recordId }, reason: 'first decision' } } })
    expect(rejected).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    const files = canonicalFiles(knowledgeRoot)
    const bundles = listBundles(knowledgeRoot)
    await expect(explicit({ ...base('ci'), operationId: LATER_OPERATION, request: { verb: 'accept',
      input: { target: { grain: 'record', recordId } } } })).rejects.toBeInstanceOf(UserDeltaCitationIntegrityError)
    expect(canonicalFiles(knowledgeRoot)).toEqual(files)
    expect(listBundles(knowledgeRoot), 'no unauthored clone is minted').toEqual(bundles)
  })

  it('a retried reject deprecates once and answers the same record ids', async () => {
    const recordId = publish('retried reject')
    const request = { verb: 'reject' as const, input: { target: { grain: 'record' as const, recordId }, reason: 'stale' } }
    const first = await explicit({ ...base('cloud'), request })
    const files = canonicalFiles(knowledgeRoot)
    expect(await explicit({ ...base('cloud'), request })).toEqual(first)
    expect(canonicalFiles(knowledgeRoot)).toEqual(files)
    expect(bundle(recordId).bundle.events.filter(event => event.type === 'deprecated')).toHaveLength(1)
    expect(first).toEqual({ outcome: 'applied', verb: 'reject', changeId: `prop_${OPERATION}`, recordIds: [recordId] })
  })

  it('recovers an interrupted mark on retry without a second lineage transition', async () => {
    const victim = publish('interrupted checkout')
    const request = { verb: 'mark' as const, input: markInput(victim) }
    // Promotion assembles its gate input after the fix is durable, so failing that assembly once the
    // victim is superseded stops the write between the committed supersession and its promotion.
    const assemble = promotionGateInput.assemblePromotionGateInput
    const interrupted = vi.spyOn(promotionGateInput, 'assemblePromotionGateInput').mockImplementation((input) => {
      if (status(victim) === 'superseded') throw new Error('injected interruption after the fix committed')
      return assemble(input)
    })
    await expect(explicit({ ...base('cloud'), request })).rejects.toThrow('injected interruption')
    interrupted.mockRestore()
    expect(status(victim)).toBe('superseded')
    const fix = listBundles(knowledgeRoot).find(row => row.bundleId !== victim)!
    expect(bundle(fix.bundleId).bundle.events.some(event => event.type === 'promoted')).toBe(false)
    const retried = await explicit({ ...base('cloud'), request })
    if (retried.outcome !== 'applied') throw new Error('retry did not apply')
    expect(retried.commitReceipt?.promoted).toEqual([{ candidateId: retried.recordIds[0], promotionPath: 'user-sovereign' }])
    expect(bundle(victim).bundle.events.filter(event => event.type === 'superseded')).toHaveLength(1)
    expect(enumerateBundleDirs(knowledgeRoot)).toHaveLength(2)
  })

  it('answers a typed target-not-found for every verb, and refuses a malformed request before any write', async () => {
    publish('present checkout')
    const before = canonicalFiles(knowledgeRoot)
    const missing = { grain: 'record' as const, recordId: 'fact-missing-0123456789abcdef' }
    const bundleRef = { grain: 'bundle' as const, shortId: 'MEM-999' }
    for (const target of [missing, bundleRef]) {
      for (const request of [
        { verb: 'accept' as const, input: { target } },
        { verb: 'reject' as const, input: { target, reason: 'not real' } },
        { verb: 'forget' as const, input: { target } },
        { verb: 'mark' as const, input: { ...markInput(missing.recordId), target } },
      ]) {
        expect(await explicit({ ...base('ci'), request, resolveBundleShortId: () => undefined }))
          .toEqual({ outcome: 'target-not-found', verb: request.verb, changeId: `prop_${OPERATION}`, target })
      }
    }
    expect(canonicalFiles(knowledgeRoot)).toEqual(before)
    // Malformed input is refused before a lease is even asked for: not one byte moves, .epoch included.
    const whole = hashTree(knowledgeRoot)
    await expect(explicit({ ...base('ci'), request: { verb: 'reject',
      input: { target: missing, reason: '' } } })).rejects.toThrow()
    await expect(explicit({ ...base('ci'), operationId: '../escape', request: { verb: 'forget',
      input: { target: missing } } })).rejects.toBeInstanceOf(TypeError)
    expect(hashTree(knowledgeRoot)).toBe(whole)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
  })

  it('forgets a MEM-addressed bundle through the injected resolver', async () => {
    const recordId = publish('addressed checkout')
    const result = await explicit({ ...base('local-headless'), resolveBundleShortId: shortId =>
      shortId === 'MEM-001' ? recordId : undefined,
    request: { verb: 'forget', input: { target: { grain: 'bundle', shortId: 'MEM-001' } } } })
    expect(result).toMatchObject({ outcome: 'applied', recordIds: [recordId],
      forgetReceipt: { tombstonedRecords: [{ recordId }] } })
  })

  it('explicit ci promotion leaves automatic ci curation proposed and its promotion refused', async () => {
    const victim = publish('explicit ci checkout')
    const marked = await explicit({ ...base('ci'), request: { verb: 'mark', input: markInput(victim) } })
    expect(marked).toMatchObject({ outcome: 'applied', commitReceipt: { promoted: [{ promotionPath: 'user-sovereign' }] } })

    const automaticVictim = publish('automatic ci checkout')
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture lease unavailable')
    try {
      const automatic = createLocalKnowledgeStore({ knowledgeRoot,
        executionContext: 'ci', writerLeaseId: lease.leaseId, epoch: lease.epoch })
      await automatic.commit([{ kind: 'Supersede', origin: 'user', scope: SCOPE,
        citedIds: [asRecordId(automaticVictim)], victimId: asRecordId(automaticVictim),
        evidenceToken: asEvidenceToken('automatic-ci-supersede'),
        newBundle: makeBundleDraftFixture({ kind: 'fact', subtype: 'navigational', scope: SCOPE,
          anchors: [ANCHOR], summary: 'Automatic replacement' }) }])
      await expect(automatic.promote(asRecordId(automaticVictim)))
        .rejects.toMatchObject({ reason: 'propose-only' })
    } finally {
      releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
    expect(status(automaticVictim), 'automatic ci curation never supersedes directly').toBe('candidate')
    const proposed = listBundles(knowledgeRoot).map(row => bundle(row.bundleId).bundle)
      .flatMap(found => found.relations.relations)
    expect(proposed).toContainEqual(expect.objectContaining({ type: 'proposed-supersession-of', targetId: automaticVictim }))
    expect(status(marked.outcome === 'applied' ? marked.recordIds[0]! : '')).toBe('active')
  })
})
