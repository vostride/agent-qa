import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  deriveEvidenceToken,
  evaluatePromotionGate,
  isVettedCandidate,
  type BundleDiscriminant,
  type BundleDraft,
  type CanaryOutcome,
  type DistilledObservation,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  enqueueArtifactFreeCandidateProjection,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'
import { scaffoldKnowledgeRoot } from '../../__tests__/fixtures/bundle-fixture.js'
import { deriveBundleTrust, loadBundle, readGateReceipts } from '../../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../../bundle-publish.test-helper.js'
import { buildRetrievalQuery } from '../../query-helper.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { enqueueCanaryOutcome } from '../../queue/canary-queue.js'
import { listQueuedCandidates } from '../../queue/curation-queue.js'
import { readJobState, writeJobState } from '../../queue/job-state.js'
import type { CuratorAuthor } from '../author-contract.js'
import {
  drainQueue,
  type DrainOperations,
} from '../drain.js'
import { canaryOutcomeObservationId } from '../disposition.js'
import { createLocalKnowledgeStore } from '../knowledge-store.js'
import { openKnowledgeReader } from '../../index-reader.js'

const FACT_ANCHORS = [
  { t: 'el', role: 'button', name: 'Checkout', ordinal: 0 },
  { t: 'page', route: '/checkout' },
  { t: 'selector', literal: '[data-testid="checkout"]' },
] as const
const ELEMENT_OBSERVATION: DistilledObservation = {
  schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
  step: { naturalKey: 'checkout-click', ordinal: 0 },
  platform: 'web',
  element: { naturalKey: 'button:checkout:0' },
  locator: { selector: '[data-testid="checkout"]' },
  observedAtOrdinal: 42,
}

describe('canary outcome deterministic disposition', () => {
  let root: string
  let knowledgeRoot: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-canary-disposition-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    const released = releaseLease({ knowledgeRoot, leaseId: lease.leaseId })
    if (released.kind !== 'released') throw new Error('expected writer lease release')
  })

  /**
   * CR-01: the port bridge can no longer synthesize an identity, so a store handed to a test
   * must hold the genuine published lease. drainQueue acquires its own, which is why beforeEach
   * still leaves the root unheld.
   */
  function portAuthority(): { writerLeaseId: string; epoch: number } {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind === 'acquired') return { writerLeaseId: lease.leaseId, epoch: lease.epoch }
    if (lease.kind === 'held') {
      return { writerLeaseId: lease.holder.leaseId, epoch: lease.holder.epoch }
    }
    throw new Error('expected writer authority for the knowledge port')
  }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function bundleConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'storefront',
      commitArtifacts: 'none',
      writerLeaseId: 'canary-disposition-test',
    }
  }

  function seedCandidate(kind: 'fact' | 'policy' = 'fact') {
    const draft: BundleDraft = {
      kind,
      ...(kind === 'fact' ? { subtype: 'selector' as const } : {}),
      anchors: [...FACT_ANCHORS],
      scope: { tier: 'product', key: 'storefront' },
      summary: kind === 'fact'
        ? 'Checkout button selector'
        : 'Checkout approval policy proposal',
      body: kind === 'fact'
        ? 'The checkout button was resolved and verified.'
        : 'Only approved users may activate checkout.',
      distilledEvidenceRef: {
        id: `${kind}-checkout-evidence`,
        sha: kind === 'fact' ? 'a'.repeat(64) : 'b'.repeat(64),
      },
      originStage: 'run-curation',
    }
    const discriminant: BundleDiscriminant = kind === 'fact'
      ? {
          kind,
          subtype: 'selector',
          elementRef: { role: 'button', name: 'Checkout' },
        }
      : { kind, ruleKey: 'only approved users may activate checkout' }
    const input: PublishBundleInput = {
      draft,
      discriminant,
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'run-canary-seed',
        testId: 'test-canary-seed',
        stepIndex: 0,
        curationJobId: `seed-${kind}-candidate`,
        sourceBuildOrdinal: 42,
      },
      artifacts: [],
      evidenceMarkdown: 'Deterministically observed during checkout.\n',
      distilledObservations: [ELEMENT_OBSERVATION],
    }
    const published = publishBundle(bundleConfig(), input)
    if (published.kind !== 'published') {
      throw new Error(`expected candidate publish, got ${published.kind}`)
    }
    return published
  }

  function outcome(
    candidateId: ReturnType<typeof asRecordId>,
    runOutcome: CanaryOutcome['runOutcome'] = 'positive',
  ): CanaryOutcome {
    return {
      candidateId,
      runOutcome,
      benefit: 'rode-along',
      stateValidity: 'unknown',
      runId: 'run-canary-disposition',
      testId: 'checkout::happy-path',
      testIndex: 0,
      buildOrdinal: 43,
      stepIndex: 2,
      briefDigest: 'brief-digest-canary-disposition',
      attribution: 'The served checkout hypothesis was exercised by the attributed step.',
      exercisedAnchor: FACT_ANCHORS[0],
    }
  }

  function store() {
    return createLocalKnowledgeStore({
      knowledgeRoot,
      executionContext: 'local-interactive',
      sourceBuildOrdinal: 43,
      sourceRunId: 'run-canary-disposition',
      ...portAuthority(),
    })
  }

  function loaded(bundleDir: string) {
    const result = loadBundle(bundleDir)
    if (result.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${result.kind}`)
    return { bundle: result.bundle, trust: deriveBundleTrust(result.bundle) }
  }

  it('commits a positive attributed outcome before promoting with the schema evidence recipe', async () => {
    const published = seedCandidate()
    const attributed = outcome(published.id)

    await store().recordCanaryOutcome(attributed)

    const result = loaded(published.dir)
    const expectedToken = deriveEvidenceToken({
      attributingObservationId: canaryOutcomeObservationId(attributed),
      anchor: attributed.exercisedAnchor,
      buildOrdinal: attributed.buildOrdinal,
    })
    const confirmedIndex = result.bundle.events.findIndex(
      (event) => event.type === 'confirmed' && event.evidenceToken === expectedToken,
    )
    const promotedIndex = result.bundle.events.findIndex((event) => event.type === 'promoted')

    expect(confirmedIndex).toBeGreaterThanOrEqual(0)
    expect(promotedIndex).toBeGreaterThan(confirmedIndex)
    expect(result.trust.status).toBe('active')
    expect(result.trust.counters.confirmed).toBe(1)
  })

  it.each(['rode-along', 'exercised-benefited'] as const)('a positive %s outcome commits one Confirm, promotes on the verdict floor and replays byte-identically', async benefit => {
    const published = seedCandidate()
    const attributed = { ...outcome(published.id), benefit }
    await store().recordCanaryOutcome(attributed)
    const { bundle } = loaded(published.dir)
    expect(bundle.events.filter(event => event.type === 'confirmed')).toEqual([
      expect.objectContaining({ evidenceToken: deriveEvidenceToken({ attributingObservationId: canaryOutcomeObservationId(attributed),
        anchor: attributed.exercisedAnchor, buildOrdinal: attributed.buildOrdinal }), buildOrdinal: 43 }),
    ])
    const receipts = readGateReceipts(published.dir, published.id)!
    expect(receipts).toEqual([expect.objectContaining({ promotionPath: 'deterministic-verdict-floor' })])
    const bytes = canonicalJson(bundle.events)
    await store().recordCanaryOutcome({ ...attributed, benefit: 'rode-along' })
    expect(canonicalJson(loaded(published.dir).bundle.events)).toBe(bytes)
  })

  it('replays the same positive outcome as a trust-preserving no-op', async () => {
    const published = seedCandidate()
    const attributed = outcome(published.id)
    const knowledgeStore = store()

    await knowledgeStore.recordCanaryOutcome(attributed)
    const first = loaded(published.dir)
    const firstEvidence = canonicalJson({
      events: first.bundle.events,
      counters: first.trust.counters,
      trust: first.trust.trust,
      status: first.trust.status,
    })

    await knowledgeStore.recordCanaryOutcome(attributed)
    const replayed = loaded(published.dir)

    expect(canonicalJson({
      events: replayed.bundle.events,
      counters: replayed.trust.counters,
      trust: replayed.trust.trust,
      status: replayed.trust.status,
    })).toBe(firstEvidence)
    expect(replayed.trust.counters.confirmed).toBe(1)
  })

  it('appends replay-safe negative evidence through the existing trust disposition', async () => {
    const published = seedCandidate()
    const attributed = outcome(published.id, 'negative')
    const knowledgeStore = store()
    const before = loaded(published.dir)

    await knowledgeStore.recordCanaryOutcome(attributed)
    const first = loaded(published.dir)
    await knowledgeStore.recordCanaryOutcome(attributed)
    const replayed = loaded(published.dir)

    expect(first.trust.counters.contradicted).toBe(1)
    expect(first.trust.trust).toBeLessThan(before.trust.trust)
    expect(first.trust.status).toBe('candidate')
    expect(replayed.trust).toEqual(first.trust)
    expect(replayed.bundle.events).toEqual(first.bundle.events)
  })

  it.each(['valid', 'unknown', 'stale'] as const)('a %s negative outcome contradicts immediately and writes no receipt', async stateValidity => {
    const published = seedCandidate()
    await store().recordCanaryOutcome({ ...outcome(published.id, 'negative'),
      stateValidity, benefit: 'exercised-harmed' })
    expect(loaded(published.dir).trust.counters.contradicted).toBe(1)
    expect(readGateReceipts(published.dir, published.id)).toBeUndefined()
  })

  it('persists mixed same-step outcomes from separate tests under distinct identities', async () => {
    const published = seedCandidate()
    const positive = outcome(published.id)
    const negative: CanaryOutcome = {
      ...outcome(published.id, 'negative'),
      testId: 'checkout::declined-card',
      testIndex: 1,
    }
    const positiveObservationId = canaryOutcomeObservationId(positive)
    const negativeObservationId = canaryOutcomeObservationId(negative)

    expect(negative.stepIndex).toBe(positive.stepIndex)
    expect(negativeObservationId).not.toBe(positiveObservationId)

    const positiveEntry = enqueueCanaryOutcome(knowledgeRoot, positive)
    const negativeEntry = enqueueCanaryOutcome(knowledgeRoot, negative)
    expect(negativeEntry.entryId).not.toBe(positiveEntry.entryId)
    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(2)

    const author = vi.fn<CuratorAuthor>(async () => {
      throw new Error('canary jobs must not invoke the Curator author')
    })
    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
    })
    const result = loaded(published.dir)
    const positiveToken = deriveEvidenceToken({
      attributingObservationId: positiveObservationId,
      anchor: positive.exercisedAnchor,
      buildOrdinal: positive.buildOrdinal,
    })
    const negativeToken = deriveEvidenceToken({
      attributingObservationId: negativeObservationId,
      anchor: negative.exercisedAnchor,
      buildOrdinal: negative.buildOrdinal,
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 2,
      committed: 2,
      failures: 0,
    })
    expect(author).not.toHaveBeenCalled()
    expect(result.bundle.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'confirmed', evidenceToken: positiveToken }),
      expect.objectContaining({ type: 'contradicted', evidenceToken: negativeToken }),
    ]))
    expect(result.trust.counters).toMatchObject({ confirmed: 1, contradicted: 1 })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
  })

  it('drains mixed canary and curation jobs without spending author or query work on canaries', async () => {
    const published = seedCandidate()
    const canary = enqueueCanaryOutcome(knowledgeRoot, outcome(published.id))
    const curation = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: {
        sourceRunId: 'run-mixed-curation',
        scope: { tier: 'product', key: 'storefront' },
        buildOrdinal: 44,
        executionContext: 'local-interactive',        kind: 'fact',
        subtype: 'selector',
        anchors: [{ t: 'el', role: 'button', name: 'Pay now', ordinal: 0 }],
        summarySeed: 'Pay now button selector',
        bodySeed: 'The Pay now button was observed during checkout.',
        distilledObservations: [
          {
            schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
            step: { naturalKey: 'pay-now-click', ordinal: 0 },
            platform: 'web',
            element: { naturalKey: 'button:Pay now:0' },
            observedAtOrdinal: 44,
          },
        ],
        evidenceToken: 'mixed-curation-evidence',
        attributingObservationId: 'run-mixed-curation:test-0:step-0',
        emittedAt: '2026-07-18T00:00:00.000Z',
      },
    })
    if (curation.kind !== 'enqueued') throw new Error(`expected curation enqueue, got ${curation.kind}`)

    const author = vi.fn<CuratorAuthor>(async (job) => {
      if (job.candidateId !== curation.candidateId) {
        throw new Error(`canary job ${job.candidateId} reached the author`)
      }
      return { kind: 'fallback-required', reason: 'no-model' }
    })
    const build = vi.fn(buildRetrievalQuery)
    const commit = vi.fn<DrainOperations['commitCurationDelta']>((dependencies, job) => {
      writeJobState({
        knowledgeRoot,
        candidateId: job.candidateId,
        lifecycle: 'done',
        authority: { leaseId: job.leaseId, epoch: dependencies.epoch },
      })
      return {
        kind: 'applied',
        bundleId: asRecordId(`bundle-${job.candidateId}`),
        bundleDir: join(knowledgeRoot, 'memory', 'storefront', 'bundles', job.candidateId),
        deltaKind: 'Add',
      }
    })

    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
      operations: {
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => ({
          indexAbsent: false,
          pendingEmbeddings: 0,
          renderingEpochStale: false,
          vectorReconciliationOutstanding: false,
        }),
        openKnowledgeReader: () => fakeReader(),
        buildRetrievalQuery: build,
        retrieve: async () => [],
        commitCurationDelta: commit,
      },
    })

    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 2,
      committed: 2,
      failures: 0,
    })
    expect(author).toHaveBeenCalledOnce()
    expect(author.mock.calls[0]?.[0].candidateId).toBe(curation.candidateId)
    expect(build).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledOnce()
    expect(loaded(published.dir).trust.status).toBe('active')
    expect(readJobState(knowledgeRoot, canary.entryId).kind).toBe('absent')
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
  })

  // D-08 wall 1: serving a proposed-but-unapproved rule as a hypothesis is the
  // confused-deputy shape — a rule is either sovereign or it is not yet a rule.
  it('holds a promotion-ready policy candidate at the kind allowlist', () => {
    const otherwisePromotionReady = {
      status: 'candidate' as const,
      validityOpen: true,
      anchors: [
        { t: 'el' as const, role: 'button', name: 'checkout', ordinal: 0 },
        { t: 'page' as const, route: '/checkout' },
      ],
      originClass: 'agent-verified' as const,
      withheld: false,
      needsEnrichment: false,
      evidenceIncomplete: false,
      distilledObservations: [
        { element: { naturalKey: 'button:checkout:0' } },
      ],
      confirmedOutcomeEvidenceTokens: [asEvidenceToken('policy-confirmed-evidence')],
      hasUserDeprecateInLineage: false,
      memoryOffForAnchorGroup: false,
    }

    expect(evaluatePromotionGate({
      ...otherwisePromotionReady,
      kind: 'fact',
      subtype: 'selector',
    })).toEqual({ verdict: 'promote', promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [] })
    expect(evaluatePromotionGate({
      ...otherwisePromotionReady,
      kind: 'policy',
    })).toEqual({ verdict: 'hold', reason: 'kind-excluded' })
  })

  it('records positive policy evidence without moving the candidate to active', async () => {
    const published = seedCandidate('policy')

    await store().recordCanaryOutcome(outcome(published.id))

    const result = loaded(published.dir)
    expect(result.trust.counters.confirmed).toBe(1)
    expect(result.trust.status).toBe('candidate')
    expect(result.bundle.events.some((event) => event.type === 'promoted')).toBe(false)
  })

  it('excludes policy candidates from the cold-start vetted sub-cap', () => {
    expect(isVettedCandidate({
      kind: 'policy',
      status: 'candidate',
      validityOpen: true,
      anchors: [{ t: 'page', route: '/checkout' }],
      originClass: 'agent-verified',
      withheld: false,
      needsEnrichment: false,
      evidenceIncomplete: false,
      confirmedOutcomeEvidenceTokens: [asEvidenceToken('policy-vetted-evidence')],
      hasUserDeprecateInLineage: false,
      memoryOffForAnchorGroup: false,
    })).toBe(false)
  })
})

function fakeReader() {
  return {
    source: 'scan' as const,
    vec: 'none' as const,
    getById: vi.fn(),
    searchLexical: vi.fn(() => []),
    lookupAnchor: vi.fn(() => []),
    searchDense: vi.fn(() => []),
    recheck: vi.fn((hits) => [...hits]),
    close: vi.fn(),
  }
}
