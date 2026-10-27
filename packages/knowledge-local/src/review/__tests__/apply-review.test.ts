// Apply routes through the ONE commit path, race-safely and idempotently (387-08, KREV-01).
//
// RE-SPELLED 2026-10-01 (432-17, D-05/D-22). The proposal door this corpus drove is deleted with the
// inbox. Every case now stages its change in memory (`stage`, below) and applies it through
// `applyExplicitReview` under a stable operation identity; the receipt id is `prop_<identity>`, the
// shape receipts already carried, so the receipt assertions are unchanged. What each door-specific
// claim became is stated at its case: "already-applied" is the same-identity retry, "the proposal
// stays applicable" is "the change stays retryable", and the four CR-03 claim-window cases left with
// the claim/rename machinery they measured (C432-PROPOSAL-FILES-UNREAD pins its absence).
//
// The zero-recall case is the one that had to be built carefully rather than merely written. A
// "the record is gone from search" assertion is worthless unless the record was FINDABLE first, on
// BOTH legs, so each leg is asserted present before the forget and absent after. The vec leg in
// particular is populated with a real embedder-shaped backfill; without that, "no vec row" would
// have been true before the verb ran and the whole half would have been measuring nothing.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import {
  GATE_RECEIPT_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  DEFAULT_EMBEDDING_PROFILE,
  KNOWLEDGE_REVIEW_VERBS,
  asRunId,
  asRecordId,
  asEvidenceToken,
  strongestPromotionPath,
  stampReceiptDigest,
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { Anchor, CommitReceipt, ForgetReceiptV1, KnowledgeReviewVerb, RecordId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as knowledgeStore from '../../curator/knowledge-store.js'
import { loadBundle, readGateReceipts } from '../../bundle-read.js'

import { appendOutcomeEvent } from '../../bundle-append.js'
import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { UserDeltaCitationIntegrityError } from '../../curator/disposition.js'
import { reconcileOnDrainStart } from '../../journal/reconcile.js'
import { listBundles } from '../../list-bundles.js'
import { openIndexReaderConnection, vecTableName } from '../../index-open.js'
import { rebuildIndex } from '../../index-rebuild.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { listQueuedCandidates } from '../../queue/curation-queue.js'
import { claimedRoot } from '../../queue/queue-layout.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from '../../__tests__/fixtures/fake-embedder.js'
import {
  APPLY_DELEGATE_TIMEOUT_MS,
  ApplyDelegateTimeoutError,
  ApplyDelegateUnavailableError,
  applyExplicitReview,
} from '../apply-review.js'
import type { ExplicitReviewDelegate, ExplicitReviewRequest } from '../apply-review.js'
import { FORGET_RECEIPTS_SUBDIR } from '../forget-receipt-journal.js'
import { FORGET_SCRUBBED_PROJECTIONS } from '../propose-review.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

/** Changes staged by the cases, keyed by the receipt id each will land under. */
const staged = new Map<string, ExplicitReviewRequest>()
let stagedCount = 0

/** Stage a change and answer the id it will be recorded under (`prop_<operation identity>`). */
function stage(request: ExplicitReviewRequest): string {
  stagedCount += 1
  const changeId = `prop_apply-review-${stagedCount}`
  staged.set(changeId, request)
  return changeId
}

/** The op a verb's change is made by, as it is stamped on Gate-3 receipts. */
function opIdFor(verb: KnowledgeReviewVerb): string {
  return verb === 'mark' ? 'runs.mark' : `knowledge.${verb}`
}

interface ApplyInput {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  readonly proposalId: string
  readonly executionContext?: 'local-interactive' | 'local-headless' | 'ci' | 'cloud'
  readonly now?: () => number
  readonly delegate?: ExplicitReviewDelegate
  readonly delegateTimeoutMs?: number
  readonly writerAuthority?: { readonly leaseId: string; readonly epoch: number }
}

interface Applied {
  readonly outcome: string
  readonly recordIds?: readonly string[]
  readonly commitReceipt?: CommitReceipt
  readonly forgetReceipt?: ForgetReceiptV1
}

/** Apply a staged change directly, under the identity its receipt id names. */
async function applyReview(input: ApplyInput): Promise<Applied> {
  const request = staged.get(input.proposalId)
  if (request === undefined) throw new Error(`nothing staged under ${input.proposalId}`)
  return await applyExplicitReview({
    agentQaRoot: input.agentQaRoot,
    knowledgeRoot: input.knowledgeRoot,
    operationId: input.proposalId.slice('prop_'.length),
    opId: opIdFor(request.verb),
    executionContext: input.executionContext ?? 'local-interactive',
    request,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.delegate === undefined ? {} : { delegate: input.delegate }),
    ...(input.delegateTimeoutMs === undefined ? {} : { delegateTimeoutMs: input.delegateTimeoutMs }),
    ...(input.writerAuthority === undefined ? {} : { writerAuthority: input.writerAuthority }),
  })
}

/**
 * A content hash of every regular file under a directory tree, path-relative and sorted.
 *
 * Paths are part of the digest, not just contents: an apply that created an empty marker file
 * or renamed a bundle directory would leave every byte of content identical, and a
 * contents-only digest would call that "unchanged".
 *
 * DELIBERATELY DUPLICATED from propose-apply.test.ts:48-74 rather than extracted to a shared
 * module. The sibling wave-11 plan 387-18 owns that file and runs in the same wave; a shared
 * helper would couple the two diffs for no gain, and a digest helper is exactly the kind of
 * thing each corpus should be able to read in full without leaving its own file.
 */
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
 * The digest's own input domain, spelled out — asserted BEFORE the digest so a change is NAMED.
 *
 * `hashTree` answers "did anything change" with one opaque hex string; a corpus whose only
 * statement is that string reports a leak as `expected 'a1b2…' to be 'c3d4…'`, which tells the
 * next reader nothing about WHERE. This listing carries exactly what the digest carries — every
 * directory by path, every file by path and content hash — so asserting it first makes the
 * failure output print the offending entry itself.
 *
 * DIRECTORIES ARE ENTRIES HERE, and that is not decoration: the first draft of this helper listed
 * files only, and it went green against a bridge that no longer wrote `payload.json` but whose
 * caller still materialized an EMPTY `memory/queue/claimed/` on the way past. A files-only
 * listing would have reported the residue as "nothing to see" while the digest disagreed with it.
 */
function treeEntries(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        found.push(`D:${relative(root, path)}`)
        walk(path)
        continue
      }
      found.push(
        `F:${relative(root, path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
      )
    }
  }
  walk(root)
  return found.sort()
}

interface RecallRows {
  readonly fts: number
  readonly vec: number
  readonly graph: number
}

describe('apply — one commit path, receipts at the boundary, race-safe consumption', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-review-apply-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Apply Product',
    }
  }

  function publish(summary: string): string {
    const outcome = publishBundle(
      storeConfig(),
      {
        draft: makeBundleDraftFixture({
          kind: 'fact',
          anchors: [ANCHOR],
          scope: { tier: 'product', key: 'apply-storefront' },
          summary,
        }),
        discriminant: {
          kind: 'fact',
          subtype: 'selector',
          elementRef: { role: 'Button', name: summary },
        },
        originClass: 'agent-verified',
        createdAtOrdinal: 10,
        screenStates: [makeScreenStateFixture()],
        initialEvents: [],
        relations: [],
        provenance: { mode: 'run-linked', runId: `apply-${summary}`, testId: 't', stepIndex: 0 },
        artifacts: [],
      },
    )
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  async function projectIndex(): Promise<void> {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture could not take the lease')
    try {
      await rebuildIndex({
        knowledgeRoot,
        embedder: makeFakeEmbedder(),
        writerAuthority: { knowledgeRoot, leaseId: lease.leaseId, epoch: lease.epoch },
      })
    } finally {
      releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
  }

  /** Recall rows for ONE record, on all three legs the §7.7 scrub covers. */
  function recallRows(recordId: string): RecallRows {
    const connection = openIndexReaderConnection(knowledgeRoot)
    const db: DatabaseSync = connection.db
    try {
      const record = db
        .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
        .get(recordId) as { record_rowid?: number } | undefined
      if (record?.record_rowid === undefined) return { fts: 0, vec: 0, graph: 0 }
      const rowid = Number(record.record_rowid)
      const count = (sql: string): number => {
        const row = db.prepare(sql).get(BigInt(rowid)) as { n?: number } | undefined
        return Number(row?.n ?? 0)
      }
      return {
        fts: count('SELECT COUNT(*) AS n FROM fts_records WHERE rowid = ?'),
        vec: count(
          `SELECT COUNT(*) AS n FROM ${vecTableName(DEFAULT_EMBEDDING_PROFILE)} ` +
            'WHERE record_rowid = ?',
        ),
        graph: count('SELECT COUNT(*) AS n FROM graph_edges WHERE record_rowid = ?'),
      }
    } finally {
      db.close()
    }
  }

  function proposeForget(recordId: string): string {
    return stage({ verb: 'forget', input: { target: { grain: 'record', recordId } } })
  }

  function proposeReject(recordId: string, reason: string): string {
    return stage({ verb: 'reject', input: { target: { grain: 'record', recordId }, reason } })
  }

  function proposeAccept(recordId: string): string {
    return stage({ verb: 'accept', input: { target: { grain: 'record', recordId } } })
  }

  function proposeMark(recordId: string, kind: 'fact' | 'caution' = 'fact', add = false, confirm = false) {
    const target = { grain: 'record' as const, recordId }
    const runId = asRunId('mark-apply-run')
    const mark = { markId: 'mark_0123456789ab', runId, testIndex: 2, stepIndex: 3,
      kind: 'false-fail' as const, fix: kind }
    const scope = { tier: 'product' as const, key: 'apply-storefront' }
    const draft = makeBundleDraftFixture({ kind, scope, anchors: [ANCHOR],
      ...(kind === 'fact' ? { subtype: 'navigational' as const } : {}),
      summary: kind === 'fact' ? 'Navigational fact: open the checkout panel first' : 'Avoid stale checkout state' })
    const shared = { origin: 'user' as const, scope, citedIds: [asRecordId(recordId)],
      evidenceToken: asEvidenceToken(`mark:${mark.markId}`) }
    return stage({ verb: 'mark', input: {
      target, mark, plan: { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: mark.markId, kind: 'knowledge', fix: kind,
        target, wording: 'floor', feedbackSource: { runId, testIndex: 2, stepIndex: 3, kind: mark.kind },
        runTraceRef: { runId, runSlug: runId }, deltas: [confirm
          ? { ...shared, kind: 'Confirm', targetId: asRecordId(recordId) }
          : add
          ? { ...shared, kind: 'Add', bundle: draft }
          : { ...shared, kind: 'Supersede', victimId: asRecordId(recordId), newBundle: draft }],
      },
    } })
  }

  it.each(['fact', 'caution'] as const)('419 confirmed %s fix commits user content and one sovereign Gate-3 receipt', async kind => {
    const recordId = publish('checkout button')
    const proposalId = proposeMark(recordId, kind, kind === 'caution')
    const create = vi.spyOn(knowledgeStore, 'createExplicitReviewStore')
    try {
      const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
      expect(create.mock.calls[0]?.[0].executionContext).toBe('local-interactive')
      expect(result.outcome).toBe('applied')
      expect(result.commitReceipt?.gate3).toHaveLength(1)
      const id = result.commitReceipt!.recordIds[0]!
      expect(id).not.toBe(recordId)
      const entry = enumerateBundleDirs(knowledgeRoot).find(entry => loadBundle(entry.dir).kind === 'loaded'
        && readGateReceipts(entry.dir, id)?.length)!
      const loaded = loadBundle(entry.dir)
      expect(loaded.kind).toBe('loaded')
      if (loaded.kind !== 'loaded') throw new Error('missing committed record')
      expect(loaded.bundle.frontmatter.originClass).toBe('user')
      expect(loaded.bundle.provenance).toMatchObject({ mode: 'run-linked', runId: 'mark-apply-run' })
      if (kind === 'fact') expect(loaded.bundle.frontmatter.subtype).toBe('navigational')
      const lines = readGateReceipts(entry.dir, id)!
      expect(lines.filter(line => 'gate' in line && line.gate === 3)).toEqual([
        expect.objectContaining({ gate: 3, verdict: 'pass', candidateId: id,
          producedBy: { opId: 'runs.mark' }, stepId: '2:3', mark: 'false-fail' }),
      ])
      expect(strongestPromotionPath(lines)).toBe('user-sovereign')
      expect(rowsFor(id)[0]?.status).toBe('active')
      expect(result.commitReceipt?.promoted).toEqual([{ candidateId: id, promotionPath: 'user-sovereign' }])
      // The same-identity retry (formerly `already-applied`) lands nothing and answers the same
      // receipt. Measured over the canonical files: taking the writer lease bumps `.epoch` and the
      // authority row, and the derived index is re-projected; neither is an effect of the change.
      const canonical = () => treeEntries(knowledgeRoot).filter(entry =>
        !/^F:(\.epoch|\.writer-authority\.sqlite|memory\/index\/)/u.test(entry))
      const before = canonical()
      const repeated = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
      expect(repeated.outcome).toBe('applied')
      expect(repeated.commitReceipt).toEqual(result.commitReceipt)
      expect(canonical()).toEqual(before)
    } finally { create.mockRestore() }
  })

  it('419 concurrent mark applies answer the same durable receipt and commit once', async () => {
    // RE-SPELLED (432-17): without a claim, the overlapping call meets the first one's writer lease
    // and is refused by name with no host delegate; its retry under the same identity answers the
    // first call's receipt and commits nothing more. The composed port serializes its own calls.
    const proposalId = proposeMark(publish('concurrent checkout'))
    const settled = await Promise.allSettled([1, 2].map(() => applyReview({ agentQaRoot, knowledgeRoot, proposalId })))
    const applied = settled.filter(entry => entry.status === 'fulfilled')
      .map(entry => (entry as PromiseFulfilledResult<Applied>).value)
    expect(applied).toHaveLength(1)
    for (const entry of settled) {
      if (entry.status === 'rejected') expect(entry.reason).toBeInstanceOf(ApplyDelegateUnavailableError)
    }
    const retried = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(retried.commitReceipt).toEqual(applied[0]!.commitReceipt)
    expect(retried.commitReceipt?.gate3).toHaveLength(1)
  })

  it('419 Confirm readback names only its target and advances beyond earlier gate-only ordinals', async () => {
    const recordId = publish('previously gated checkout')
    const unrelated = publish('unrelated checkout')
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture lease unavailable')
    try {
      const store = knowledgeStore.createLocalKnowledgeStore({ knowledgeRoot,
        executionContext: 'local-interactive', writerLeaseId: lease.leaseId, epoch: lease.epoch })
      await store.recordGateReceipt(stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3,
        candidateId: recordId, verdict: 'fail', producedAtOrdinal: 100,
        producedBy: { opId: 'prior-confirmation' }, runId: 'prior-run', mark: 'false-pass' }))
    } finally { releaseLease({ knowledgeRoot, leaseId: lease.leaseId }) }
    const proposalId = proposeMark(recordId, 'fact', false, true)
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(result.commitReceipt?.recordIds).toEqual([recordId])
    expect(result.commitReceipt?.committedAtOrdinal).toBe(101)
    expect(result.commitReceipt?.promoted).toEqual([{ candidateId: recordId, promotionPath: 'user-sovereign' }])
    expect(rowsFor(unrelated)[0]?.status).toBe('candidate')
    const record = enumerateBundleDirs(knowledgeRoot).map(entry => loadBundle(entry.dir))
      .find(loaded => loaded.kind === 'loaded' && loaded.bundle.manifest.id === recordId)
    expect(record?.kind === 'loaded' && record.bundle.events.some(event =>
      event.type === 'confirmed' && event.origin === 'user' && event.buildOrdinal === 101)).toBe(true)
  })

  // 432 D-04 replaces the 419 propose-only refusal: an explicit mark is authority in every
  // context, so the CI apply commits and promotes while the record keeps its actual context.
  it('419 mark application in ci commits under the actual context and promotes through the sovereign gate', async () => {
    const recordId = publish('CI checkout')
    const proposalId = proposeMark(recordId)
    const result = applyReview({ agentQaRoot, knowledgeRoot, proposalId, executionContext: 'ci' })
    await expect(result).resolves.toMatchObject({ outcome: 'applied' })
    const receipt = (await result).commitReceipt!
    const id = receipt.recordIds[0]!
    expect(id).not.toBe(recordId)
    expect(receipt.promoted).toEqual([{ candidateId: id, promotionPath: 'user-sovereign' }])
    expect(rowsFor(recordId)[0]?.status).toBe('superseded')
    expect(rowsFor(id)[0]?.status).toBe('active')
    const entry = enumerateBundleDirs(knowledgeRoot).map(found => loadBundle(found.dir))
      .find(loaded => loaded.kind === 'loaded' && loaded.bundle.manifest.id === id)
    expect(entry?.kind === 'loaded' && entry.bundle.provenance).toMatchObject({ authorship: { executionContext: 'ci' } })
    // RE-SPELLED (432-17): no applied record is written; the same-identity retry answers the receipt.
    expect((await applyReview({ agentQaRoot, knowledgeRoot, proposalId, executionContext: 'ci' })).commitReceipt)
      .toEqual(receipt)
  })

  function publishPolicy(body = 'Dismiss the cookie banner before checkout') {
    const result = publishBundle(storeConfig(), {
      draft: makeBundleDraftFixture({ kind: 'policy', body, summary: 'Checkout rule',
        scope: { tier: 'product', key: 'apply-storefront' } }),
      discriminant: { kind: 'policy', ruleKey: 'checkout-rule' }, originClass: 'agent-verified',
      createdAtOrdinal: 10, screenStates: [makeScreenStateFixture()], initialEvents: [],
      relations: [], provenance: { mode: 'standalone', sourceDescription: 'policy fixture' }, artifacts: [],
    })
    if (result.kind !== 'published') throw new Error('policy fixture did not publish')
    return result.id
  }

  it('419 policy accept materializes and supersedes to a reference with honest Gate-3 approval, never promotes', async () => {
    const recordId = publishPolicy()
    const proposalId = proposeAccept(recordId)
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(result.outcome).toBe('applied')
    expect(result.commitReceipt?.policy).toEqual({ recordId, scope: 'apply-storefront',
      relPath: 'policies/apply-storefront.md', outcome: 'written' })
    expect(readFileSync(join(knowledgeRoot, 'policies/apply-storefront.md'), 'utf8'))
      .toContain(`<!-- agent-qa:policy ${recordId} -->`)
    expect(rowsFor(recordId)[0]?.status).toBe('superseded')
    const bundles = enumerateBundleDirs(knowledgeRoot).map(entry => ({ dir: entry.dir, loaded: loadBundle(entry.dir) }))
    const reference = bundles.find(entry => entry.loaded.kind === 'loaded'
      && entry.loaded.bundle.body === `policies/apply-storefront.md#agent-qa:policy ${recordId}`)
    expect(reference?.loaded.kind).toBe('loaded')
    const original = bundles.find(entry => entry.loaded.kind === 'loaded' && entry.loaded.bundle.manifest.id === recordId)!
    const receipts = readGateReceipts(original.dir, recordId)!
    expect(receipts).toEqual([expect.objectContaining({ gate: 3, verdict: 'pass',
      producedBy: { opId: 'knowledge.accept' }, policyApproval: { proposalId, recordId } })])
    expect(receipts[0]).not.toHaveProperty('runId')
    expect(receipts[0]).not.toHaveProperty('mark')
    for (const { loaded } of bundles) if (loaded.kind === 'loaded') {
      expect(loaded.bundle.events.some(event => event.type === 'promoted')).toBe(false)
    }
    expect(result.commitReceipt?.promoted).toEqual([])
    // The same-identity retry lands nothing; this call wrote nothing to the shelf.
    const repeated = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(repeated.outcome).toBe('applied')
    expect(repeated.commitReceipt).toEqual({ ...result.commitReceipt,
      policy: { ...result.commitReceipt?.policy, outcome: 'unchanged' } })
  })

  it('419 policy marker refusal commits nothing and files nothing', async () => {
    const recordId = publishPolicy('This rule contains --> and cannot be materialized')
    const proposalId = proposeAccept(recordId)
    const before = hashTree(join(knowledgeRoot, 'memory'))
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(result.outcome).toBe('policy-materialize-refused')
    expect(result).not.toHaveProperty('commitReceipt')
    expect(hashTree(join(knowledgeRoot, 'memory'))).toBe(before)
    expect(existsSync(join(knowledgeRoot, 'policies'))).toBe(false)
    // RE-SPELLED (432-17): nothing was filed to restore; a retry refuses the same way.
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect((await applyReview({ agentQaRoot, knowledgeRoot, proposalId })).outcome).toBe('policy-materialize-refused')
  })

  it('C441-COMMITTED a policy file with credential-shaped text is applied as written', async () => {
    const body = 'Pay with 4242 4242 4242 4242 and send Bearer abc123def456ghi789'
    const recordId = publishPolicy(body)
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId: proposeAccept(recordId) })
    expect(result.outcome).toBe('applied')
    expect(result.commitReceipt?.policy).toEqual({ recordId, scope: 'apply-storefront',
      relPath: 'policies/apply-storefront.md', outcome: 'written' })
    expect(readFileSync(join(knowledgeRoot, 'policies/apply-storefront.md'), 'utf8'))
      .toContain(`<!-- agent-qa:policy ${recordId} -->\n### Checkout rule\n${body}\n`)
  })

  /**
   * How many bundle DIRECTORIES exist, measured off the filesystem rather than off the fold.
   *
   * Deliberately not `listBundles().length`: that walk skips a bundle whose canonical files do
   * not strictly parse, so a mint that lands half-written would be invisible to it. The minted
   * clone this matrix refuses is a whole new directory, and the cheapest total statement about
   * it is a directory count taken from `enumerateBundleDirs` — the same enumeration
   * `listBundles` composes, read one layer lower.
   */
  function bundleDirCount(): number {
    return enumerateBundleDirs(knowledgeRoot).length
  }

  /**
   * Drive a bundle to `superseded` through ORDINARY CURATION, never through a review verb.
   *
   * The append is the same one the curator's `Supersede` arm performs (curator/commit.ts:1459
   * emits `type: 'superseded'` into the outcome log); it is reproduced here rather than driving a
   * full drift-supersede because the matrix's input is the STATUS, and a status reached through a
   * forget would make "reject over a superseded target" a case about the forget path instead. The
   * `buildOrdinal` must exceed the fixture's `createdAtOrdinal` (10) or the fold keeps `candidate`.
   */
  function supersede(recordId: string): void {
    const appended = appendOutcomeEvent(
      storeConfig(),
      recordId as RecordId,
      BundleOutcomeEventSchema.parse({
        type: 'superseded',
        evidenceToken: `apply-review-superseded-${recordId}`,
        curationJobId: `apply-review-superseded-job-${recordId}`,
        buildOrdinal: 43,
        byRecordId: 'fact-replacement-0123456789abcdef',
      }),
    )
    if (appended.kind !== 'appended') throw new Error(`fixture supersede failed: ${appended.kind}`)
  }

  /** Rows claiming ONE record id — a second entry means a second directory claims that id. */
  function rowsFor(recordId: string) {
    return listBundles(knowledgeRoot).filter((row) => row.bundleId === recordId)
  }

  /**
   * The CR-02 integrity assertion, applied identically to every cell of the matrix.
   *
   * THE CANDIDATE SCAN IS STORE-WIDE, AND THAT IS THE WHOLE POINT OF THIS HELPER. The first draft
   * of it filtered every assertion to rows whose `bundleId` equals the target id, on the
   * verifier's wording ("no second directory claims the record id") — and that draft PASSED
   * against the unmodified defect. Dumping the minted bundle showed why: the unauthored record is
   * a verbatim CLONE of the target's own content (same anchors, same scope, same summary)
   * re-addressed under `originClass: user` at the next ordinal, so its content address DIFFERS
   * from the target's and it lands under the scope-derived product directory rather than the
   * target's. An id-scoped scan cannot see it. The row that matters is the one
   * `isEligibleCandidate` (serving/brief-selection.ts:142-151) would re-admit into serving, and it
   * carries whatever id the clone hashed to — so the assertion is over the STORE, not over an id.
   *
   * Four facts, each load-bearing: the store is row-for-row unchanged; no `candidate` row exists
   * anywhere (the serving re-admission channel); exactly one directory claims the target id (the
   * duplicate-id wedge); and the POSITIVE post-state holds — a guard that refused the whole apply
   * would satisfy all three negatives and still be wrong.
   */
  function expectNoUnauthoredMint(
    recordId: string,
    expectedStatus: string,
    before: ReturnType<typeof listBundles>,
  ): void {
    const all = listBundles(knowledgeRoot)
    expect(all, 'the store must be row-for-row unchanged: any new row is a record nobody authored')
      .toEqual(before)
    expect(
      all.filter((row) => row.status === 'candidate'),
      'a resurrected candidate row anywhere is re-admittable into serving by isEligibleCandidate',
    ).toHaveLength(0)
    const mine = all.filter((row) => row.bundleId === recordId)
    expect(new Set(mine.map((row) => row.dir)).size, 'exactly one directory may claim the id')
      .toBe(1)
    expect(mine[0]?.status, 'the target must still hold its tombstoned state').toBe(expectedStatus)
  }

  it('tombstones without destroying, scrubs every projection it names, and receipts it', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    // POSITIVE CONTROL, and the case is worthless without it: every leg the receipt will claim
    // to have scrubbed must be POPULATED first, or "zero rows afterwards" is a fact about a leg
    // that was never there.
    const before = recallRows(recordId)
    expect(before.fts, 'the FTS leg must be populated for the absence to mean anything').toBe(1)
    expect(before.vec, 'the VEC leg must be populated for the absence to mean anything').toBe(1)

    const proposalId = proposeForget(recordId)
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 1234 })

    expect(result.outcome).toBe('applied')
    const receipt = result.forgetReceipt
    if (receipt === undefined) throw new Error('a forget must produce a receipt')
    expect(receipt.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])
    expect(receipt.tombstonedRecords[0]?.provenance.mode).toBe('run-linked')
    expect(receipt.resultingBundleStatus).toBe('tombstoned')
    expect(receipt.forgottenAt).toBe(1234)

    // NEVER DESTROY: the bundle is still enumerable and still says what happened to it.
    const rows = listBundles(knowledgeRoot)
    expect(rows.map((row) => row.bundleId)).toEqual([recordId])
    expect(rows[0]?.status).toBe('deprecated')

    // …and every projection the receipt NAMES is verified individually rather than trusted.
    //
    // A TOTAL lookup with no fallback, deliberately. The first draft of this loop ended in a
    // `: after.graph` else-branch, which silently mapped a claimed `exemplar` onto the graph
    // count — so a receipt claiming a projection nobody scrubs would have PASSED. That is the
    // exact failure mode this case exists to catch, and an unverifiable claim is now a failure
    // rather than a coincidence.
    const after = recallRows(recordId)
    const verifiable: Readonly<Record<string, number>> = {
      fts: after.fts,
      vec: after.vec,
      graph: after.graph,
    }
    for (const projection of receipt.projectionsScrubbed) {
      expect(
        Object.hasOwn(verifiable, projection),
        `the receipt claims ${projection} was scrubbed and this case cannot verify it — a ` +
          'receipt naming a projection nobody scrubbed is worse than no receipt',
      ).toBe(true)
      expect(verifiable[projection], `receipt claims ${projection} was scrubbed`).toBe(0)
    }
    // …and it does NOT claim `exemplar`, because nothing scrubs one: an exemplar in this system
    // is a test reference out of the run-outcome projection, not a knowledge record.
    expect(receipt.projectionsScrubbed).not.toContain('exemplar')
  })

  it('is idempotent: a same-identity retry commits nothing', async () => {
    // RE-SPELLED (432-17): the proposal door answered the FIRST receipt verbatim off its applied
    // record. The direct door keeps no such record: a retried forget lands nothing and answers the
    // same records, and re-mints its receipt (deferred-items 432-16 #3). What is asserted is the
    // half that survives — nothing is committed twice.
    const recordId = publish('checkout button')
    await projectIndex()
    const proposalId = proposeForget(recordId)

    const first = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 111 })
    const storeAfterFirst = listBundles(knowledgeRoot)

    const second = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 222 })

    expect(second.outcome).toBe('applied')
    expect(second.recordIds).toEqual(first.recordIds)
    expect(second.forgetReceipt?.tombstonedRecords).toEqual(first.forgetReceipt?.tombstonedRecords)
    expect(listBundles(knowledgeRoot)).toEqual(storeAfterFirst)
  })

  it('records exactly one application even when two applies overlap', async () => {
    // RE-SPELLED (432-17): both calls are started before either is awaited. With no claim to race
    // for, the first acquires the writer lease synchronously and the overlapping call meets it held
    // and, with no delegate on this host, is refused BY TYPE. Exactly one call commits, and the
    // store shows one application.
    const recordId = publish('checkout button')
    await projectIndex()
    const proposalId = proposeForget(recordId)

    const settled = await Promise.allSettled([
      applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 1 }),
      applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 2 }),
    ])

    const committed = settled.filter(
      (entry) => entry.status === 'fulfilled' && entry.value.outcome === 'applied',
    )
    expect(committed, 'exactly one call may commit').toHaveLength(1)
    for (const entry of settled) {
      if (entry.status === 'fulfilled') continue
      expect(entry.reason).toBeInstanceOf(ApplyDelegateUnavailableError)
    }

    // The store shows ONE application: a second Deprecate would append a second event.
    expect(listBundles(knowledgeRoot).filter((row) => row.status === 'deprecated')).toHaveLength(1)
  })

  it('names the already-tombstoned state rather than destroying twice (FUNC-04 adjacency)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    const firstReceipt = (await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeForget(recordId),
      now: () => 10,
    })).forgetReceipt
    expect(firstReceipt?.resultingBundleStatus).toBe('tombstoned')
    const afterFirst = listBundles(knowledgeRoot)

    // A SECOND, independently minted forget over the same, now-tombstoned target.
    const secondId = proposeForget(recordId)
    const second = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: secondId,
      now: () => 20,
    })

    expect(second.outcome).toBe('applied')
    // The receipt states what IS: already tombstoned. The status is read back after the commit,
    // never copied forward from the preview.
    expect(second.forgetReceipt?.resultingBundleStatus).toBe('tombstoned')
    // WR-02, added by 387-12: this case previously asserted nothing about the scrub list, so the
    // short-circuit's three unperformed scrub claims passed through it unread. Silence is not
    // pinning, but it is the reason the dishonesty survived — the assertion is now explicit.
    expect(second.forgetReceipt?.projectionsScrubbed).toEqual([])
    // …and the FIRST receipt did claim its three scrubs, because that apply really performed them.
    expect(firstReceipt?.projectionsScrubbed).toEqual([...FORGET_SCRUBBED_PROJECTIONS])
    // …and nothing was destroyed a second time: the record still exists with the same status.
    expect(listBundles(knowledgeRoot)).toEqual(afterFirst)
  })

  // 2026-10-02 (quick 261002-lse, 432-16 #3): a RETRY of the same forget (the same operation
  // identity) is the same change, so it answers the receipt its first application recorded, byte
  // for byte. It used to re-mint `forgottenAt` and claim no scrubs, where reject's retry already
  // answered identically. A SECOND, independently minted forget (the cell above) keeps WR-02's
  // empty scrub list.
  it('answers a retried forget with its first receipt, byte for byte, and lands nothing twice', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    const proposalId = proposeForget(recordId)

    const first = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 10 })
    const afterFirst = listBundles(knowledgeRoot)
    const retried = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 20 })

    expect(first.forgetReceipt).toMatchObject({
      forgottenAt: 10,
      projectionsScrubbed: [...FORGET_SCRUBBED_PROJECTIONS],
    })
    expect(retried.forgetReceipt).toEqual(first.forgetReceipt)
    expect(JSON.stringify(retried)).toBe(JSON.stringify(first))

    // The records and the tombstone landed once: one forget event for this change, nothing else.
    expect(listBundles(knowledgeRoot)).toEqual(afterFirst)
    const forgetEvents = enumerateBundleDirs(knowledgeRoot)
      .map(entry => loadBundle(entry.dir))
      .flatMap(loaded => loaded.kind === 'loaded' ? loaded.bundle.events : [])
      .filter(event => event.type === 'deprecated' && event.reason === `forget:${proposalId}`)
    expect(forgetEvents).toHaveLength(1)
  })

  it('a tombstone this forget committed but never recorded still answers its scrubs, then stays stable (261002-lse)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    const proposalId = proposeForget(recordId)
    await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 10 })
    // The commit landed and the process died before the receipt was recorded.
    rmSync(join(knowledgeRoot, FORGET_RECEIPTS_SUBDIR), { recursive: true, force: true })

    const recovered = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 20 })
    const again = await applyReview({ agentQaRoot, knowledgeRoot, proposalId, now: () => 30 })

    expect(recovered.forgetReceipt).toMatchObject({
      forgottenAt: 20,
      projectionsScrubbed: [...FORGET_SCRUBBED_PROJECTIONS],
    })
    expect(JSON.stringify(again)).toBe(JSON.stringify(recovered))
  })

  it('a second, independent forget keeps WR-02 empty scrubs, and its own retry is identical (261002-lse)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    const firstId = proposeForget(recordId)
    await applyReview({ agentQaRoot, knowledgeRoot, proposalId: firstId, now: () => 10 })
    const secondId = proposeForget(recordId)

    const second = await applyReview({
      agentQaRoot, knowledgeRoot, proposalId: secondId, now: () => 20,
    })
    const secondRetried = await applyReview({
      agentQaRoot, knowledgeRoot, proposalId: secondId, now: () => 30,
    })

    expect(second.forgetReceipt).toMatchObject({ forgottenAt: 20, projectionsScrubbed: [] })
    expect(JSON.stringify(secondRetried)).toBe(JSON.stringify(second))
  })

  // ── CR-03: deleted 2026-10-01 (432-17). The four claim-window cases (a parked claim refused by
  // type, a winner publishing or restoring during the wait, an id never minted) measured the
  // claim/rename machinery the inbox owned. A change is no longer claimed: the identity is the
  // caller's, and a live writer is met through the lease (see the overlap case above).

  // ── CR-02: the complete {reject, forget} × {deprecated, superseded} matrix ──────────────────
  //
  // The suite's input domain before this block contained exactly one cell — forget over a target
  // a forget had tombstoned — and the defect lived in every other cell. `propose-review.ts` emits
  // an IDENTICAL `Deprecate` delta for reject (:183-188) and forget (:190-195), so the hazard
  // belongs to the DELTA KIND; a guard scoped to one verb of the emitting set is the same
  // root-cause shape as a status table scoped to hand-picked members of a union (387-11 / CR-04).
  // The cases are therefore written over the whole set, not over the member that failed.
  //
  // RED BASELINE, observed against unmodified apply-review.ts (short-circuit still
  // `proposal.verb === 'forget' && …` at :297), transcribed from the failing run:
  //
  //   × a reject over an ALREADY-DEPRECATED target (prior reject) mints nothing
  //     → AssertionError: the store must be row-for-row unchanged … expected [ {…}, {…} ] to
  //       deeply equal [ {…} ]
  //   × a reject over an ALREADY-DEPRECATED target (prior FORGET) mints nothing
  //     → AssertionError: the store must be row-for-row unchanged … expected [ {…}, {…} ] to
  //       deeply equal [ {…} ]
  //   × a forget over an already-superseded target claims ZERO scrubs it did not perform
  //     → AssertionError: expected [ 'fts', 'vec', 'graph' ] to deeply equal []
  //   × (FUNC-04 adjacency, below) a forget over a forgotten target
  //     → AssertionError: expected [ 'fts', 'vec', 'graph' ] to deeply equal []
  //   × a THIRD addressed operation on a twice-applied record id still resolves
  //     → AssertionError: the store must be row-for-row unchanged … two rows in, two rows out,
  //       differing — the third reject reached commit() and mutated the clone
  //
  // ONE CELL WAS ALREADY GREEN PRE-FIX, and saying so is more useful than a matrix that reds
  // uniformly, because the green cell says where the hazard actually lives:
  //
  //   ✓ reject over an already-SUPERSEDED target — measured green before the fix. The Deprecate
  //     had real work to do (the target was not `deprecated`), so it committed an ordinary
  //     `deprecated` outcome event at the apply's build ordinal, which the fold ranks BELOW the
  //     supersede at ordinal 43 — status stays `superseded` and nothing is minted. The defect
  //     needs a target that is already `deprecated` specifically. The case is kept as a
  //     regression pin over the cell, not as a reproduction of it.
  //
  // The third-operation case reds, but NOT with the verifier's
  // `BundleTargetResolutionError: … is ambiguous`. That error needs the minted clone to collide
  // with the target's record id; in this fixture it does not, because the clone re-addresses
  // under `originClass: user` at the next ordinal and hashes differently (dumped:
  // `fact-el-button-checkout-ac9994…` beside the target's `…969cd289…`, under the scope-derived
  // product dir `apply-storefront/` rather than the fixture's `Apply-Product/`). The ambiguity
  // wedge is therefore reachable but fixture-dependent; what this suite observes instead is the
  // third reject reaching commit() and mutating the clone. Stated rather than implied.
  //
  // What DID reproduce in every red cell is the sharper fact: the unauthored record is a verbatim
  // CLONE of the fact the reviewer just rejected — same anchors, same scope, same summary —
  // published `status: candidate`, which `isEligibleCandidate` re-admits into serving.

  it('a reject over an ALREADY-DEPRECATED target (prior reject) mints nothing (CR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    const first = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'flaky selector'),
    })
    expect(first.outcome).toBe('applied')
    expect(rowsFor(recordId)[0]?.status).toBe('deprecated')
    const before = listBundles(knowledgeRoot)

    // The single most ordinary operator repetition in a review queue: reject the same record twice.
    const second = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'flaky selector, again'),
    })

    expect(second.outcome).toBe('applied')
    // reject carries no receipt on any path, short-circuit included.
    expect(second.forgetReceipt).toBeUndefined()
    expectNoUnauthoredMint(recordId, 'deprecated', before)
  })

  it('a reject over an ALREADY-DEPRECATED target (prior FORGET) mints nothing (CR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    // The second provenance path to the same status. Both verbs emit the same delta, so a guard
    // that keyed on how the target GOT tombstoned would pass one of these two and fail the other.
    await applyReview({ agentQaRoot, knowledgeRoot, proposalId: proposeForget(recordId) })
    expect(rowsFor(recordId)[0]?.status).toBe('deprecated')
    const before = listBundles(knowledgeRoot)

    const rejected = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'already forgotten'),
    })

    expect(rejected.outcome).toBe('applied')
    expectNoUnauthoredMint(recordId, 'deprecated', before)
  })

  it('a reject over an ALREADY-SUPERSEDED target mints nothing (CR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    // Superseded through ordinary curation, never through a review verb — the third tombstoned
    // provenance, and the one no review verb can produce.
    supersede(recordId)
    expect(rowsFor(recordId)[0]?.status).toBe('superseded')
    const before = listBundles(knowledgeRoot)

    const rejected = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'replaced upstream'),
    })

    expect(rejected.outcome).toBe('applied')
    // `superseded`, not `deprecated`: the short-circuit reports the state that IS, and does not
    // overwrite one tombstoned status with another it never committed.
    expectNoUnauthoredMint(recordId, 'superseded', before)
  })

  it('a forget over an already-superseded target claims ZERO scrubs it did not perform (WR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    supersede(recordId)
    const before = listBundles(knowledgeRoot)

    const forgotten = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeForget(recordId),
      now: () => 4321,
    })

    const receipt = forgotten.forgetReceipt
    if (receipt === undefined) throw new Error('a forget must produce a receipt')
    // WR-02: the branch committed nothing and scrubbed nothing. `scrubSetSchema`
    // (schema/src/knowledge/proposal.ts:140-146) admits any unique SUBSET including the empty one,
    // so an honest empty list is expressible — and a receipt asserting work nobody did is exactly
    // what propose-review.ts:44-45 forbids.
    expect(receipt.projectionsScrubbed).toEqual([])
    // …while the rest of the receipt still reports the post-state honestly rather than going silent.
    expect(receipt.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])
    expect(receipt.tombstonedRecords[0]?.provenance.mode).toBe('run-linked')
    expect(receipt.resultingBundleStatus).toBe('tombstoned')
    expect(receipt.forgottenAt).toBe(4321)
    expectNoUnauthoredMint(recordId, 'superseded', before)
  })

  it('a THIRD addressed operation on a twice-applied record id still resolves (CR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()

    await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'first'),
    })
    await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'second'),
    })
    // Snapshotted AFTER both applies on purpose: this case asks whether the state two applies
    // leave behind can still be addressed, so its baseline is that state, whatever it is.
    const before = listBundles(knowledgeRoot)

    // The wedge the verifier observed: with two directories claiming one id, resolving the target
    // throws `BundleTargetResolutionError: … is ambiguous` — a retryable-looking error that can
    // never succeed, because the failing apply restores its own proposal to pending each time.
    // BOTH halves are asserted, because the throw can land on either: the propose resolves AND
    // the apply settles.
    const thirdId = proposeReject(recordId, 'third')
    const third = await applyReview({ agentQaRoot, knowledgeRoot, proposalId: thirdId })

    expect(third.outcome).toBe('applied')
    expectNoUnauthoredMint(recordId, 'deprecated', before)
  })

  it('CONTROL: a first reject over a LIVE candidate target still commits (CR-02)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    // Drawn from OUTSIDE the rescoped guard's own assumption: the guard's precondition is
    // "already tombstoned", so a corpus made only of tombstoned targets would be satisfied by a
    // guard that swallowed EVERY Deprecate. This is the input it must admit.
    expect(rowsFor(recordId)[0]?.status).toBe('candidate')
    const before = listBundles(knowledgeRoot)

    const rejected = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'flaky selector'),
    })

    expect(rejected.outcome).toBe('applied')
    // The legitimate first destruction HAPPENED: the state changed, through commit(). This is the
    // positive half — `listBundles` unchanged in LENGTH but changed in CONTENT is precisely the
    // shape a swallow-everything guard could not produce.
    expect(rowsFor(recordId)[0]?.status).toBe('deprecated')
    expect(listBundles(knowledgeRoot).length).toBe(before.length)
    expect(listBundles(knowledgeRoot)).not.toEqual(before)
  })

  it('leaves the change RETRYABLE when the commit refuses', async () => {
    // RE-SPELLED (432-17): there is no pending proposal to keep applicable. A held lease refuses the
    // change before anything is written, and the same identity applies once the lease is free.
    const recordId = publish('checkout button')
    const proposalId = proposeForget(recordId)
    const before = listBundles(knowledgeRoot)

    const holder = acquireWriterLease(knowledgeRoot)
    if (holder.kind !== 'acquired') throw new Error('fixture could not take the lease')
    try {
      await expect(applyReview({ agentQaRoot, knowledgeRoot, proposalId }))
        .rejects.toBeInstanceOf(ApplyDelegateUnavailableError)
    } finally {
      releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
    }

    expect(listBundles(knowledgeRoot)).toEqual(before)
    const retried = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(retried.outcome).toBe('applied')
  })

  it('delegates instead of stealing when a live holder exists, and waits BOUNDED', async () => {
    const recordId = publish('checkout button')
    const proposalId = proposeForget(recordId)

    const holder = acquireWriterLease(knowledgeRoot)
    if (holder.kind !== 'acquired') throw new Error('fixture could not take the lease')
    try {
      // The delegate is handed the SAME request and identity and nothing else — no lease, no
      // epoch, no store handle. There is nothing here it could steal with.
      const seen: string[] = []
      const delegated = await applyReview({
        agentQaRoot,
        knowledgeRoot,
        proposalId,
        delegate: async ({ request, operationId }) => {
          seen.push(`prop_${operationId}`)
          return { outcome: 'applied', verb: request.verb, changeId: `prop_${operationId}`, recordIds: [recordId] }
        },
      })
      expect(seen).toEqual([proposalId])
      expect(delegated.outcome).toBe('applied')

      // The holder still holds it: nothing about delegating took, reclaimed or bumped the lease.
      const stillHeld = acquireWriterLease(knowledgeRoot)
      expect(stillHeld.kind).toBe('held')

      // A holder that never answers is REFUSED at the bound, not waited out and not taken over.
      await expect(applyReview({
        agentQaRoot,
        knowledgeRoot,
        proposalId,
        delegateTimeoutMs: 25,
        delegate: () => new Promise(() => {}),
      })).rejects.toBeInstanceOf(ApplyDelegateTimeoutError)

      // Still not stolen, and nothing was filed for the holder to find.
      expect(acquireWriterLease(knowledgeRoot).kind).toBe('held')
      expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    } finally {
      releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
    }

    expect(APPLY_DELEGATE_TIMEOUT_MS).toBeGreaterThan(1_000)
  })

  // ── CR-02′: the matrix is driven from the VERB REGISTRY, not from a list of verbs ──────────
  //
  // The block above walks {reject, forget}. That set was hand-picked — it is the set of verbs
  // whose hazard had been NOTICED — and `accept` was simply absent, so `expectNoUnauthoredMint`
  // was never applied to the third verb and the identical mint reproduced through it. Round 1's
  // verifier measured the omission exactly: zero occurrences of `accept` in this file.
  //
  // The correction is mechanical rather than another case. The walk iterates
  // `KNOWLEDGE_REVIEW_VERBS` — the RUNTIME registry in `schema/src/knowledge/proposal.ts`, which
  // is the authority independent of anything this file writes down — and looks each verb's
  // expected behaviour up in a table declared `satisfies Record<KnowledgeReviewVerb, …>`. A
  // fourth verb added to the registry with no row here is a COMPILE ERROR, and a row here naming
  // no registry member is the same. So the corpus cannot fall behind the vocabulary the way it
  // just did; `proposalFor`'s switch is exhaustive over the same union for the same reason.
  //
  // RED BASELINE, observed against unmodified disposition.ts + apply-review.ts (before the
  // origin-discriminated refusal of Task 2), transcribed from the failing run:
  //
  //   × accept over a target already deprecated by a prior applied reject → refuses (CR-02′)
  //     → AssertionError: an accept over a tombstoned target must REFUSE by type, never report
  //       a confirmation it did not perform: expected 'resolved' to be 'rejected'
  //   × accept over a target already deprecated by a prior applied forget → refuses (CR-02′)
  //     → (byte-identical failure)
  //
  // …and with that first assertion replaced by a dump, in the same run, the defect's own
  // artifacts — printed for BOTH provenances, character for character identical:
  //
  //   PROBE accept reject resolved applied dirs 1 -> 2 rows
  //     [["memory/Apply-Product/bundles/fact-el-button-checkout-969cd289e646aae2","deprecated"],
  //      ["memory/apply-storefront/bundles/fact-el-button-checkout-ac9994c92f7366a8","candidate"]]
  //   PROBE accept forget resolved applied dirs 1 -> 2 rows  … (the same two rows)
  //   → AssertionError: the store must be row-for-row unchanged: any new row is a record nobody
  //     authored: expected [ { …(13) }, { …(13) } ] to deeply equal [ { …(13) } ]
  //
  // The second row is the mint: a verbatim CLONE of the fact the reviewer removed, re-addressed
  // under the scope-derived product directory (`apply-storefront/`, not the fixture's
  // `Apply-Product/`) at a different content address, `status: 'candidate'` — which
  // `isEligibleCandidate` re-admits into serving. Same clone id the round-0 CR-02 block names at
  // the top of this file; the same defect, arriving through the verb the matrix did not walk.
  //
  // BOTH provenances of `deprecated` are walked (a prior reject and a prior forget), because a
  // fix keyed on HOW the target got tombstoned would pass one and fail the other — the
  // full-input-set law this phase has now paid for twice.

  type TombstonedTargetExpectation = 'refuses' | 'short-circuits-applied'

  /**
   * What each review verb must do when the record it addresses is ALREADY `deprecated`.
   *
   * `accept` REFUSES and the other two do not, and the asymmetry is not a preference: reject and
   * forget over a tombstone are idempotent no-ops with an honest receipt — the state they ask for
   * already holds. An accept over a tombstone asks for the OPPOSITE of the state that holds, and
   * the store has no way to grant it; reporting `applied` there tells a human their decision was
   * reversed when it was not, and the path that produced the `applied` minted a clone of the very
   * fact the earlier decision removed.
   */
  const TOMBSTONED_TARGET_EXPECTATION_BY_VERB = {
    accept: 'refuses',
    reject: 'short-circuits-applied',
    forget: 'short-circuits-applied',
    mark: 'refuses',
  } satisfies Record<KnowledgeReviewVerb, TombstonedTargetExpectation>

  /** The two ways a review verb can leave a record `deprecated`. Both are in the corpus. */
  const TOMBSTONING_PROVENANCES = ['reject', 'forget'] as const

  function proposalFor(verb: KnowledgeReviewVerb, recordId: string): string {
    switch (verb) {
      case 'accept':
        return proposeAccept(recordId)
      case 'reject':
        return proposeReject(recordId, `matrix reject of ${recordId}`)
      case 'forget':
        return proposeForget(recordId)
      case 'mark': {
        // A real mark proposal exercises the shared citation fence now; Gate-3 receipt
        // emission for live targets belongs to the confirmation arm in Plan 419-07.
        const target = { grain: 'record' as const, recordId }
        const runId = asRunId('tombstone-mark-run')
        const mark = { markId: 'mark_0123456789ab', runId, testIndex: 0,
          kind: 'false-fail' as const, fix: 'fact' as const }
        const scope = { tier: 'product' as const, key: 'apply-storefront' }
        return stage({ verb: 'mark', input: {
          target, mark, plan: { schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId: mark.markId, kind: 'knowledge', fix: 'fact',
            target, wording: 'floor', feedbackSource: { runId, testIndex: 0, kind: mark.kind },
            runTraceRef: { runId, runSlug: runId }, deltas: [{ kind: 'Supersede', origin: 'user', scope,
              citedIds: [asRecordId(recordId)], victimId: asRecordId(recordId),
              evidenceToken: asEvidenceToken(`mark:${mark.markId}`),
              newBundle: makeBundleDraftFixture({ scope, anchors: [ANCHOR] }),
            }] },
        } })
      }
    }
  }

  async function settle(proposalId: string) {
    return await applyReview({ agentQaRoot, knowledgeRoot, proposalId }).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
  }

  for (const verb of KNOWLEDGE_REVIEW_VERBS) {
    const expectation = TOMBSTONED_TARGET_EXPECTATION_BY_VERB[verb]
    for (const provenance of TOMBSTONING_PROVENANCES) {
      it(
        `${verb} over a target already deprecated by a prior applied ${provenance} `
          + `→ ${expectation} (CR-02′)`,
        async () => {
          const recordId = publish('checkout button')
          await projectIndex()

          const tombstoning = provenance === 'reject'
            ? proposeReject(recordId, 'the first decision')
            : proposeForget(recordId)
          const first = await applyReview({ agentQaRoot, knowledgeRoot, proposalId: tombstoning })
          expect(first.outcome, 'the tombstoning apply is fixture, not subject').toBe('applied')
          expect(rowsFor(recordId)[0]?.status).toBe('deprecated')

          const before = listBundles(knowledgeRoot)
          const dirsBefore = bundleDirCount()

          const proposalId = proposalFor(verb, recordId)
          const settled = await settle(proposalId)

          if (expectation === 'refuses') {
            expect(
              settled.kind,
              'an accept over a tombstoned target must REFUSE by type, never report a '
                + 'confirmation it did not perform',
            ).toBe('rejected')
            const error = settled.kind === 'rejected' ? settled.error as Error : undefined
            expect(error).toBeInstanceOf(UserDeltaCitationIntegrityError)
            expect(error?.name).toBe('UserDeltaCitationIntegrityError')
            expect((error as UserDeltaCitationIntegrityError | undefined)?.recordId).toBe(recordId)
            // NOTHING was filed or published: the caller is never told `applied` for a
            // confirmation that confirmed nothing (432-17: there is no proposal to restore).
            expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
          } else {
            expect(settled.kind).toBe('resolved')
            expect(settled.kind === 'resolved' ? settled.value.outcome : undefined).toBe('applied')
          }

          // Identical on BOTH arms, and that is the point: whichever answer the verb gives, no
          // record nobody authored may exist afterwards.
          expectNoUnauthoredMint(recordId, 'deprecated', before)
          expect(bundleDirCount(), 'a new bundle directory is a minted record').toBe(dirsBefore)
        },
      )
    }
  }

  it('ADMIT: accept over a SUPERSEDED target still commits an ordinary Confirm (CR-02′)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    // Superseded through ordinary curation, never through a review verb — a tombstoned-looking
    // status the refusal must NOT swallow. Without this the refusal is satisfiable by "refuse
    // every accept over anything that is not `candidate`".
    supersede(recordId)
    expect(rowsFor(recordId)[0]?.status).toBe('superseded')
    const confirmedBefore = rowsFor(recordId)[0]?.counters.confirmed
    const dirsBefore = bundleDirCount()

    const accepted = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeAccept(recordId),
    })

    expect(accepted.outcome).toBe('applied')
    expect(accepted.forgetReceipt).toBeUndefined()
    // The POSITIVE half: the Confirm really reached commit() and the fold saw it. A guard that
    // swallowed the apply would satisfy every negative below and still be wrong.
    expect(confirmedBefore).toBe(0)
    expect(rowsFor(recordId)[0]?.counters.confirmed).toBe(1)
    expect(rowsFor(recordId)[0]?.status, 'a Confirm does not un-supersede').toBe('superseded')
    expect(bundleDirCount(), 'an ordinary Confirm mints nothing').toBe(dirsBefore)
    expect(listBundles(knowledgeRoot).filter((row) => row.status === 'candidate')).toHaveLength(0)

    // STATED LIMIT, on the 387-12 finding-3 precedent: this cell was GREEN before the fix. It is
    // a REGRESSION PIN over the admit half, not a reproduction of anything — `superseded` never
    // reached `checkCitedIdIntegrity`'s deprecated arm, which is exactly why the defect needed a
    // target that is `deprecated` specifically. Its job is to red if the refusal is ever widened
    // from "the cited-id-integrity check failed" to "the target looks tombstoned".
  })

  it('ADMIT: accept over a LIVE candidate commits normally (CR-02′, SOUND-10 extended)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    expect(rowsFor(recordId)[0]?.status).toBe('candidate')
    const dirsBefore = bundleDirCount()

    const accepted = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeAccept(recordId),
    })

    expect(accepted.outcome).toBe('applied')
    expect(rowsFor(recordId)[0]?.counters.confirmed).toBe(1)
    expect(bundleDirCount()).toBe(dirsBefore)
    expect(new Set(rowsFor(recordId).map((row) => row.dir)).size).toBe(1)
  })

  // ── CR-02″: the refusal's neutrality is measured over the WHOLE knowledge root ──────────────
  //
  // The two cases below exist because round 2's gates could not see the leak they were written
  // to catch. `expectNoUnauthoredMint` reads `listBundles`, and `bundleDirCount` reads
  // `enumerateBundleDirs`; both observe the BUNDLE tree, and round 1's refusal moved the residue
  // one directory over — into `memory/queue/claimed/`, where the knowledge-port bridge had
  // already materialized a curation candidate seeded from the tombstoned record's own
  // `summarySeed` / `anchors` / `bodySeed` / `kind` before disposition ever ran. Nothing unwound
  // it on the throw, `reconcileOnDrainStart` requeued it under the next lease, and the curator
  // re-authored the removed fact one drain later with `origin: 'agent'`.
  //
  // So the invariant here is the WHOLE root, not a shape of harm somebody enumerated. The bundle
  // gates stay — they name the specific harm and print a legible diff — but the digest is what
  // makes the next narrowing a test failure rather than an argument.
  //
  // RED BASELINE, observed against unmodified knowledge-store.ts (bridgeDelta still writing),
  // transcribed from the failing run:
  //
  //   × a refused accept leaves the WHOLE knowledge root byte-identical (CR-02″)
  //     → AssertionError: a refused apply may not leave a file ANYWHERE under the knowledge root
  //       — the queue tree is inside the invariant, not outside it:
  //       expected [ '.epoch', '.gitignore', …(10) ] to deeply equal [ '.epoch', … …(9) ]
  //       - Expected  + Received
  //       + "memory/queue/claimed/867e619b-7876-444a-8d26-eb89789674e8/
  //          07491443aeead09c87ccc3fe31b96da13ec8728c516528e6f002055c1e4f030e/payload.json"
  //   × the next drain adopts NOTHING from a refused accept (CR-02″ requeue half)
  //     → AssertionError: a refusal must leave the next drain nothing to adopt: expected 1 to be 0
  //
  // (the leaked payload.json is the candidate the requeue then adopts — one leak, two cases. The
  // lease uuid and the candidate content address vary per run.)
  //
  // WHY THE FIRST CASE HOLDS THE LEASE ITSELF. With the leak fixed, the digest STILL moved, and
  // the second measurement named the reason: `.epoch` and `.writer-authority.sqlite`, and nothing
  // else. `acquireWriterLease` advances the fencing epoch on every acquisition, so an apply that
  // takes its own lease moves those two bytes whether it commits, refuses, or does nothing at
  // all. Leaving them inside the window would force the invariant to become "equal except for
  // this list", and a hand-written exclusion list is the exact shape this phase keeps paying for.
  // The lease is therefore acquired by the FIXTURE and handed in through `writerAuthority` (the
  // holder branch — same `commitAndPublish`, same store, same bridge), which takes the lease
  // lifecycle out of the measured window instead of carving it out of the assertion. The
  // acquire-and-release CONTROL below proves the exclusion is really the lease's own doing rather
  // than an assumption: a bare lease round-trip, committing nothing, must move the digest and
  // must move NOTHING under `memory/`. The ordinary acquiring path is covered end-to-end by the
  // adoption case that follows, which asserts over the queue tree directly.

  /** Entries under `memory/` — the curation state, as opposed to root-level lease bookkeeping. */
  function curationEntries(entries: string[]): string[] {
    return entries.filter((entry) => entry.slice(2).startsWith('memory/'))
  }

  it('a refused accept leaves the WHOLE knowledge root byte-identical (CR-02″)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    const tombstoning = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'the first decision'),
    })
    expect(tombstoning.outcome, 'the tombstoning apply is fixture, not subject').toBe('applied')

    // CONTROL — what the lease lifecycle alone costs, MEASURED rather than assumed. A bare
    // acquire-and-release commits nothing; if it moved no bytes there would be no reason to hold
    // the lease across the window below, and if it moved curation state the window would be
    // hiding something.
    const beforeBareLease = treeEntries(knowledgeRoot)
    const bare = acquireWriterLease(knowledgeRoot)
    if (bare.kind !== 'acquired') throw new Error('fixture could not take the lease')
    releaseLease({ knowledgeRoot, leaseId: bare.leaseId })
    const afterBareLease = treeEntries(knowledgeRoot)
    expect(
      afterBareLease,
      'taking and dropping the lease must move SOMETHING, or holding it across the window '
        + 'below would be pointless ceremony',
    ).not.toEqual(beforeBareLease)
    expect(
      curationEntries(afterBareLease),
      'and it must move nothing under memory/ — the exclusion is lease bookkeeping, not a '
        + 'carve-out that could be hiding curation state',
    ).toEqual(curationEntries(beforeBareLease))

    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture could not take the lease')
    try {
      const proposalId = proposeAccept(recordId)
      const entriesBefore = treeEntries(knowledgeRoot)
      const treeBefore = hashTree(knowledgeRoot)

      const refusal = await applyReview({
        agentQaRoot,
        knowledgeRoot,
        proposalId,
        writerAuthority: { leaseId: lease.leaseId, epoch: lease.epoch },
      }).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(UserDeltaCitationIntegrityError)

      expect(
        treeEntries(knowledgeRoot),
        'a refused apply may not leave a file OR a directory anywhere under the knowledge root '
          + '— the queue tree is inside the invariant, not outside it',
      ).toEqual(entriesBefore)
      expect(
        hashTree(knowledgeRoot),
        'the refusal must be byte-identical over the whole root: paths, sizes and contents',
      ).toBe(treeBefore)
      // The specific shape the leak took, named so a regression reads as itself rather than as a
      // digest mismatch. A consequence of the invariant above, never a substitute for it.
      expect(
        existsSync(claimedRoot(knowledgeRoot)),
        'the write-free bridge materializes no claimed candidate, so the tree never appears',
      ).toBe(false)

      // POTENCY, measured over THIS root and THIS digest rather than asserted about hashing in
      // general: without it a digest taken over the wrong directory would report success forever.
      // One byte, deliberately written, must move it.
      writeFileSync(join(knowledgeRoot, 'potency-probe.txt'), 'x', 'utf8')
      expect(
        hashTree(knowledgeRoot),
        'the invariant must be FALSIFIABLE over this exact root, or it measures nothing',
      ).not.toBe(treeBefore)
    } finally {
      releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }
  })

  it('the next drain adopts NOTHING from a refused accept (CR-02″ requeue half)', async () => {
    const recordId = publish('checkout button')
    await projectIndex()
    const tombstoning = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeReject(recordId, 'the first decision'),
    })
    expect(tombstoning.outcome).toBe('applied')

    const refusal = await applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId: proposeAccept(recordId),
    }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(UserDeltaCitationIntegrityError)

    // A DIFFERENT lease, which is the whole point: `reconcileOnDrainStart` skips its own
    // authority's claims and recovers everybody else's, so the next drain is exactly a caller
    // holding a lease the refusing apply did not hold.
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('fixture could not take the lease')
    const replayed: string[] = []
    try {
      const report = reconcileOnDrainStart({
        knowledgeRoot,
        writerAuthority: { leaseId: lease.leaseId, epoch: lease.epoch },
        hasIndexRow: () => true,
        applyIndexDelta: (intent) => { replayed.push(intent.bundleId) },
        deriveIndexRowFromBundle: (bundleId) => { replayed.push(bundleId) },
      })
      expect(
        report.jobsRequeued,
        'a refusal must leave the next drain nothing to adopt: a requeued candidate is the '
          + 'removed fact re-entering under `origin: agent` one drain later',
      ).toBe(0)
    } finally {
      releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    }

    expect(listQueuedCandidates(knowledgeRoot), 'nothing was seeded into the pending queue')
      .toEqual([])
    expect(replayed, 'and no index work was inherited from a commit that never happened')
      .toEqual([])
    // …and the record the reviewer removed is still removed, which is the positive half: a
    // reconcile that recovered nothing because the STORE was empty would satisfy every negative.
    expect(rowsFor(recordId)[0]?.status).toBe('deprecated')
  })

  it('refuses an input claiming BOTH writerAuthority and delegate (WR-04)', async () => {
    const recordId = publish('checkout button')
    const proposalId = proposeForget(recordId)

    let delegateCalls = 0
    await expect(applyReview({
      agentQaRoot,
      knowledgeRoot,
      proposalId,
      writerAuthority: { leaseId: 'lease-that-does-not-exist', epoch: 1 },
      delegate: async () => {
        delegateCalls += 1
        throw new Error('the delegate must never be reached')
      },
    })).rejects.toBeInstanceOf(TypeError)

    // The refusal is STRUCTURAL and happens before anything is touched: the delegate was never
    // called and nothing was written, so a caller that fixes its input applies the same change.
    expect(delegateCalls).toBe(0)
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect((await applyReview({ agentQaRoot, knowledgeRoot, proposalId })).outcome).toBe('applied')

    // EACH FIELD ALONE still works, and neither half is duplicated here: `delegate` alone is
    // covered by 'delegates instead of stealing when a live holder exists, and waits BOUNDED'
    // above, and `writerAuthority` alone by the daemon-authority suite in
    // knowledge-proposal-apply's tests (387-10). What this case adds is only the conjunction.
  })
})
