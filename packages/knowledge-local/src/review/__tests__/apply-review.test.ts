// Each recall leg is asserted findable before the forget, so its absence afterwards is meaningful.

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

// Paths are in the digest: a created marker file or renamed directory leaves contents identical.
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

// Directories are entries too, so a leftover empty directory shows here, not only in the digest.
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

  it.each(['fact', 'caution'] as const)('confirmed %s fix commits user content and one sovereign Gate-3 receipt', async kind => {
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
      // Same-identity retry: nothing lands, same receipt; lease and index churn are excluded.
      const canonical = () => treeEntries(knowledgeRoot).filter(entry =>
        !/^F:(\.epoch|\.writer-authority\.sqlite|memory\/index\/)/u.test(entry))
      const before = canonical()
      const repeated = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
      expect(repeated.outcome).toBe('applied')
      expect(repeated.commitReceipt).toEqual(result.commitReceipt)
      expect(canonical()).toEqual(before)
    } finally { create.mockRestore() }
  })

  it('concurrent mark applies answer the same durable receipt and commit once', async () => {
    // The overlapping call meets the writer lease and is refused; a same-identity retry adds none.
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

  it('Confirm readback names only its target and advances beyond earlier gate-only ordinals', async () => {
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

  // An explicit mark is authority in every context, so the CI apply commits and promotes.
  it('mark application in ci commits under the actual context and promotes through the sovereign gate', async () => {
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
    // The same-identity retry answers the receipt; no applied record is written.
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

  it('policy accept materializes and supersedes to a reference with honest Gate-3 approval, never promotes', async () => {
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

  it('policy marker refusal commits nothing and files nothing', async () => {
    const recordId = publishPolicy('This rule contains --> and cannot be materialized')
    const proposalId = proposeAccept(recordId)
    const before = hashTree(join(knowledgeRoot, 'memory'))
    const result = await applyReview({ agentQaRoot, knowledgeRoot, proposalId })
    expect(result.outcome).toBe('policy-materialize-refused')
    expect(result).not.toHaveProperty('commitReceipt')
    expect(hashTree(join(knowledgeRoot, 'memory'))).toBe(before)
    expect(existsSync(join(knowledgeRoot, 'policies'))).toBe(false)
    // Nothing is filed to restore; a retry refuses the same way.
    expect(existsSync(join(agentQaRoot, 'proposals'))).toBe(false)
    expect((await applyReview({ agentQaRoot, knowledgeRoot, proposalId })).outcome).toBe('policy-materialize-refused')
  })

  it('a policy file with credential-shaped text is applied as written', async () => {
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

  // The scan is store-wide: the unauthored clone hashes to another id, which an id scan would miss.
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
    // A total lookup with no fallback, so a claimed projection this case cannot read fails.
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
    // A retried forget commits nothing twice and answers the same records.
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
    // Both calls start before either is awaited; the second meets the lease held and is refused.
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

  it('names the already-tombstoned state rather than destroying twice', async () => {
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
    // A second, independent forget scrubs nothing, so its receipt claims no scrubs.
    expect(second.forgetReceipt?.projectionsScrubbed).toEqual([])
    // …and the FIRST receipt did claim its three scrubs, because that apply really performed them.
    expect(firstReceipt?.projectionsScrubbed).toEqual([...FORGET_SCRUBBED_PROJECTIONS])
    // …and nothing was destroyed a second time: the record still exists with the same status.
    expect(listBundles(knowledgeRoot)).toEqual(afterFirst)
  })

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

  it('a tombstone this forget committed but never recorded still answers its scrubs, then stays stable', async () => {
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

  it('a second, independent forget keeps empty scrubs, and its own retry is identical', async () => {
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

  // Reject and forget both emit the same `Deprecate` delta, so both walk every tombstone state.

  it('a reject over an ALREADY-DEPRECATED target (prior reject) mints nothing', async () => {
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

  it('a reject over an ALREADY-DEPRECATED target (prior FORGET) mints nothing', async () => {
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

  it('a reject over an ALREADY-SUPERSEDED target mints nothing', async () => {
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

  it('a forget over an already-superseded target claims ZERO scrubs it did not perform', async () => {
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
    // The branch committed and scrubbed nothing, and the schema admits an empty scrub list.
    expect(receipt.projectionsScrubbed).toEqual([])
    // …while the rest of the receipt still reports the post-state honestly rather than going silent.
    expect(receipt.tombstonedRecords.map((row) => row.recordId)).toEqual([recordId])
    expect(receipt.tombstonedRecords[0]?.provenance.mode).toBe('run-linked')
    expect(receipt.resultingBundleStatus).toBe('tombstoned')
    expect(receipt.forgottenAt).toBe(4321)
    expectNoUnauthoredMint(recordId, 'superseded', before)
  })

  it('a THIRD addressed operation on a twice-applied record id still resolves', async () => {
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

    // Two directories claiming one id make resolution ambiguous; propose and apply are asserted.
    const thirdId = proposeReject(recordId, 'third')
    const third = await applyReview({ agentQaRoot, knowledgeRoot, proposalId: thirdId })

    expect(third.outcome).toBe('applied')
    expectNoUnauthoredMint(recordId, 'deprecated', before)
  })

  it('CONTROL: a first reject over a LIVE candidate target still commits', async () => {
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
    // A held lease refuses the change before any write; the same identity applies once it is free.
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

  // Walks the runtime verb registry via a `satisfies` table, so a verb without a row won't compile.

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
        // A real mark proposal exercises the shared citation fence.
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
          + `→ ${expectation}`,
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
            // The caller is never told `applied` for a confirmation that confirmed nothing.
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

  it('ADMIT: accept over a SUPERSEDED target still commits an ordinary Confirm', async () => {
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

    // A regression pin over the admit half: it fails if the refusal widens to tombstoned targets.
  })

  it('ADMIT: accept over a LIVE candidate commits normally', async () => {
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

  // The fixture holds the lease, so only the apply's own effects fall inside the whole-root digest.

  /** Entries under `memory/` — the curation state, as opposed to root-level lease bookkeeping. */
  function curationEntries(entries: string[]): string[] {
    return entries.filter((entry) => entry.slice(2).startsWith('memory/'))
  }

  it('a refused accept leaves the WHOLE knowledge root byte-identical', async () => {
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

  it('the next drain adopts NOTHING from a refused accept (requeue half)', async () => {
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

  it('refuses an input claiming BOTH writerAuthority and delegate', async () => {
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

    // Each field alone is covered elsewhere; this case adds only their conjunction.
  })
})
