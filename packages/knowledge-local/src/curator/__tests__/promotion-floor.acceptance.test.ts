import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  GATE_RECEIPT_SCHEMA_VERSION,
  asEvidenceToken,
  canonicalJson,
  stampReceiptDigest,
  type CanaryOutcome,
  type Anchor,
  type BundleDraft,
  type Delta,
  type DistilledObservation,
  type ExecutionContext,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  appendOutcomeEvent,
  createLocalKnowledgeStore,
  deriveBundleTrust,
  drainQueue,
  enumerateBundleDirs,
  loadBundle,
  type BundleStoreConfig,
  type CuratorAuthor,
  type LoadedBundle,
} from '../../index.js'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import { readGateReceipts } from '../../bundle-read.js'
import { enqueueCanaryOutcome } from '../../queue/canary-queue.js'
import { createPromotionFloorFixture } from './fixtures/promotion-floor-fixture.js'

const NO_INDEX_MAINTENANCE = {
  indexAbsent: false,
  pendingEmbeddings: 0,
  renderingEpochStale: false,
  vectorReconciliationOutstanding: false,
} as const

describe('zero-model promotion floor acceptance', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-promotion-floor-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function selectorProjection(
    seed: string,
    overrides: Partial<ArtifactFreeCandidateProjectionInput> = {},
  ): ArtifactFreeCandidateProjectionInput {
    const normalizedName = `checkout ${seed}`
    return {
      sourceRunId: `run-promotion-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [
        { t: 'el', role: 'button', name: `Checkout ${seed}`, ordinal: 0 },
        { t: 'page', route: '/checkout' },
        { t: 'selector', literal: `[data-testid="checkout-${seed}"]` },
      ],
      summarySeed: `Checkout ${seed} selector`,
      bodySeed: `The Checkout ${seed} button was resolved and verified.`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: `checkout-${seed}`, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `button:${normalizedName}:0` },
          locator: { selector: `[data-testid="checkout-${seed}"]` },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `promotion-evidence-${seed}`,
      attributingObservationId: `promotion-observation-${seed}`,
      emittedAt: '2026-07-16T00:00:00.000Z',
      ...overrides,
    }
  }

  function cautionProjection(seed: string): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-promotion-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'caution',
      rootCauseClass: 'timeout',
      anchors: [{ t: 'error', message: 'checkout confirmation timed out' }],
      summarySeed: 'Checkout confirmation can time out',
      bodySeed: 'Retry after the deterministic timeout attribution.',
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: 'checkout-confirmation', ordinal: 0 },
          error: {
            naturalKey: 'checkout confirmation timed out',
            rootCauseClass: 'timeout',
          },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `promotion-evidence-${seed}`,
      attributingObservationId: `promotion-observation-${seed}`,
      emittedAt: '2026-07-16T00:00:00.000Z',
    }
  }

  function enqueue(projection: ArtifactFreeCandidateProjectionInput): string {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projection,
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') {
      throw new Error(`expected enqueued projection, received ${outcome.kind}`)
    }
    return outcome.candidateId
  }

  async function drainWithoutModel(
    projection: ArtifactFreeCandidateProjectionInput,
    executionContext: ExecutionContext = projection.executionContext,
  ) {
    const candidateId = enqueue(projection)
    // The API requires an author capability, but this fixture binds no model/provider port.
    // Returning `no-model` forces §7.9's deterministic fallback author on every job.
    const author = vi.fn<CuratorAuthor>(async () => ({
      kind: 'fallback-required',
      reason: 'no-model',
    }))
    const report = await drainQueue({
      knowledgeRoot,
      author,
      executionContext,
      operations: {
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => NO_INDEX_MAINTENANCE,
        runKnowledgeGc: () => ({
          trimmedRecordIds: [],
          skipped: { unknownRef: 0, withinK: 0, userOrigin: 0, horizon: 0 },
        }),
      },
    })
    expect(report).toMatchObject({ jobsProcessed: 1, failures: 0 })
    expect(author).toHaveBeenCalledOnce()
    return { candidateId, report }
  }

  function loadedBundles(): Array<{ dir: string; bundle: LoadedBundle }> {
    return enumerateBundleDirs(knowledgeRoot).map(({ dir }) => {
      const loaded = loadBundle(dir)
      if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${loaded.kind}`)
      return { dir, bundle: loaded.bundle }
    })
  }

  function onlyBundle(): { dir: string; bundle: LoadedBundle } {
    const bundles = loadedBundles()
    expect(bundles).toHaveLength(1)
    return bundles[0]!
  }

  function expectFallbackAuthorship(bundle: LoadedBundle): void {
    expect(bundle.provenance).toMatchObject({
      mode: 'run-linked',
      authorship: { path: 'deterministic-fallback' },
    })
    if (bundle.provenance.mode !== 'run-linked') {
      throw new Error('expected run-linked fallback provenance')
    }
    expect(bundle.provenance.authorship).not.toHaveProperty('model')
  }

  function publishHeldCandidate(seed: string) {
    const displayName = `Held checkout ${seed}`
    const normalizedName = displayName.toLowerCase()
    const anchors: Anchor[] = [
      { t: 'el', role: 'button', name: displayName, ordinal: 0 },
      { t: 'page', route: '/checkout' },
      { t: 'selector', literal: `[data-testid="held-checkout-${seed}"]` },
    ]
    const observation: DistilledObservation = {
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: `held-checkout-${seed}`, ordinal: 0 },
      platform: 'web',
      element: { naturalKey: `button:${normalizedName}:0` },
      locator: { selector: `[data-testid="held-checkout-${seed}"]` },
      observedAtOrdinal: 42,
    }
    const draft: BundleDraft = {
      kind: 'fact',
      subtype: 'selector',
      anchors,
      scope: { tier: 'product', key: 'storefront' },
      summary: `${displayName} selector`,
      body: `The ${displayName} button was resolved and verified.`,
      distilledEvidenceRef: { id: `held-checkout-${seed}`, sha: 'a'.repeat(64) },
      originStage: 'run-curation',
    }
    const published = publishBundle({
      knowledgeRoot,
      productKey: 'storefront',
      writerLeaseId: 'promotion-floor-fixture',
    }, {
      draft,
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: displayName },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `held-checkout-${seed}-run`,
        testId: `held-checkout-${seed}-test`,
        stepIndex: 0,
        curationJobId: `held-checkout-${seed}-seed`,
        sourceBuildOrdinal: 42,
        authorship: {
          path: 'deterministic-fallback',
          executionContext: 'local-interactive',
        },
      },
      artifacts: [],
      evidenceMarkdown: 'Held pending canonical confirmation.\n',
      distilledObservations: [observation],
    })
    if (published.kind !== 'published') {
      throw new Error(`expected held candidate publish, got ${published.kind}`)
    }
    return { draft, published }
  }

  function outcomeAppendConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'storefront',
      writerLeaseId: 'promotion-floor-fixture',
    }
  }

  function promotionStore(sourceBuildOrdinal: number) {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected promotion fixture writer lease')
    return createLocalKnowledgeStore({
      knowledgeRoot,
      executionContext: 'local-interactive',
      epoch: lease.epoch,
      writerLeaseId: lease.leaseId,
      sourceBuildOrdinal,
    })
  }

  it.each(['rode-along', 'exercised-benefited'] as const)
    ('a %s canary drained without a model writes the confirm and promote events and exactly one floor promotion line', async benefit => {
      const fixture = createPromotionFloorFixture({ knowledgeRoot })
      const { draft, published } = fixture.publishHeldCandidate('fact-door2-canary')
      const outcome: CanaryOutcome = { candidateId: published.id, runOutcome: 'positive', benefit,
        runId: 'run-canary-disposition', testId: 'checkout::happy-path',
        testIndex: 0, buildOrdinal: 43, stepIndex: 2, briefDigest: 'brief-digest-canary-disposition',
        attribution: 'The served checkout hypothesis was exercised by the attributed step.',
        exercisedAnchor: draft.anchors[0]! }
      enqueueCanaryOutcome(knowledgeRoot, outcome)
      const author = vi.fn<CuratorAuthor>(async () => { throw new Error('no model in BYOM acceptance') })
      expect(await drainQueue({ knowledgeRoot, author, executionContext: 'local-interactive',
        maintenance: 'skip' })).toMatchObject({ jobsProcessed: 1, committed: 1, failures: 0 })
      expect(readFileSync(join(published.dir, 'evidence/outcomes.jsonl'), 'utf8')).toBe([
        '{"buildOrdinal":43,"curationJobId":"032f723f082dd59bffede79e7681c720306e756d388fbc34eaa72425c9288909","evidenceToken":"5f611fe17bf4a92f0e1442f4a851712c84fb4c326ac0751007130aba1e94ee19","observationId":"knowledge-port:8b3b5fe534f25e4add2ca039a0477462122d9ae8fc4aad05acf99d94e00cc69d","origin":"agent-verified","type":"confirmed"}',
        '{"buildOrdinal":43,"curationJobId":"promote:fact-el-button-held-checkout-fact-door2-canary-c6f8eb46cf81885c","evidenceToken":"4fbb71627919c7cd5ab04d8b9b4266ec4fd4ae7bd3adf8cc29afb229135bf816","type":"promoted"}',
      ].join('\n') + '\n')
      const promotion = stampReceiptDigest({ schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, kind: 'promotion', candidateId: published.id,
        promotionPath: 'deterministic-verdict-floor', citedReceiptDigests: [], producedAtOrdinal: 43,
        producedBy: { opId: 'promote' } })
      expect(readGateReceipts(published.dir, published.id)).toEqual([promotion])
      expect(readFileSync(join(published.dir, 'evidence/gates.jsonl'), 'utf8')).toBe(canonicalJson(promotion) + '\n')
      expect(author).not.toHaveBeenCalled()
    })

  it('fallback-authored evidence-complete fact drains queue → gate → active', async () => {
    const { report } = await drainWithoutModel(selectorProjection('primary'))

    expect(report).toMatchObject({ committed: 1, downgraded: 0, withheld: 0 })
    const { bundle } = onlyBundle()
    expectFallbackAuthorship(bundle)
    expect(bundle.events.map(({ type }) => type)).toEqual(['confirmed', 'promoted'])
    expect(deriveBundleTrust(bundle).status).toBe('active')
  })

  it('drains a typed root-cause caution to active through the same zero-model floor', async () => {
    const { report } = await drainWithoutModel(cautionProjection('typed-caution'))

    expect(report).toMatchObject({ committed: 1, downgraded: 0, withheld: 0 })
    const { bundle } = onlyBundle()
    expectFallbackAuthorship(bundle)
    expect(bundle.frontmatter.kind).toBe('caution')
    expect(bundle.events.map(({ type }) => type)).toEqual(['confirmed', 'promoted'])
    expect(deriveBundleTrust(bundle).status).toBe('active')
  })

  it('fallback-authored bare behavioral evidence stays needs-enrichment', async () => {
    await drainWithoutModel({
      ...selectorProjection('bare-behavioral'),
      kind: 'fact',
      subtype: 'behavioral',
      anchors: [{ t: 'flow', name: 'Checkout completion' }],
      summarySeed: 'Checkout completes after confirmation',
      bodySeed: 'The observed behavior needs capable-model enrichment.',
      distilledObservations: [],
    })

    const { bundle } = onlyBundle()
    expectFallbackAuthorship(bundle)
    expect(bundle.provenance).toMatchObject({ needsEnrichment: true })
    expect(bundle.events.some(({ type }) => type === 'promoted')).toBe(false)
    expect(deriveBundleTrust(bundle).status).toBe('candidate')
  })

  it('refuses procedure kind and commits a once-flagged row under zero-model fallback', async () => {
    // D-06 (381-02): the restricted fallback NEVER authors procedures. A procedure-extraction
    // job under zero-model fallback disposes as a Noop — no bundle is written at all.
    const { report: procedureReport } = await drainWithoutModel({
      ...selectorProjection('procedure'),
      kind: 'procedure',
      subtype: undefined,
      anchors: [{ t: 'flow', name: 'Checkout procedure' }],
      summarySeed: 'Complete checkout',
      bodySeed: 'Open checkout and verify confirmation.',
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: 'checkout-procedure', ordinal: 0 },
          flow: { name: 'Checkout procedure' },
          observedAtOrdinal: 42,
        },
      ],
    })
    expect(procedureReport).toMatchObject({ jobsProcessed: 1, committed: 0, failures: 0 })
    expect(loadedBundles()).toHaveLength(0)

    rmSync(knowledgeRoot, { recursive: true, force: true })
    // 2026-10-15 (441-50, D-26): the once-flagged row now carries no flag and takes the normal path.
    const { report } = await drainWithoutModel(selectorProjection('flagged'))
    expect(report).toMatchObject({ committed: 1, withheld: 0 })
    const flagged = onlyBundle().bundle
    expect(flagged.provenance).not.toHaveProperty('withheld')
    expectFallbackAuthorship(flagged)
  })

  it('keeps evidence-complete fallback output candidate in a propose-only context', async () => {
    const projection = selectorProjection('propose-only', {
      executionContext: 'ci',
    })
    const { report } = await drainWithoutModel(projection, 'ci')

    expect(report).toMatchObject({ committed: 1, downgraded: 0, withheld: 0 })
    const { bundle } = onlyBundle()
    expectFallbackAuthorship(bundle)
    expect(bundle.provenance).toMatchObject({
      authorship: { executionContext: 'ci' },
    })
    expect(bundle.events.some(({ type }) => type === 'promoted')).toBe(false)
    expect(deriveBundleTrust(bundle).status).toBe('candidate')
  })

  it('promote() re-evaluates later Confirm evidence and remains idempotent', async () => {
    const { draft, published } = publishHeldCandidate('later-confirm')
    const store = promotionStore(43)
    await expect(store.promote(published.id)).rejects.toMatchObject({
      reason: 'no-confirmed-evidence',
    })

    const confirm: Extract<Delta, { kind: 'Confirm' }> = {
      kind: 'Confirm',
      origin: 'agent',
      scope: draft.scope,
      citedIds: [published.id],
      targetId: published.id,
      evidenceToken: asEvidenceToken('held-checkout-confirm'),
      authorship: {
        path: 'deterministic-fallback',
        executionContext: 'local-interactive',
      },
    }
    await store.commit([confirm])
    const confirmed = loadBundle(published.dir)
    if (confirmed.kind !== 'loaded') throw new Error('expected Confirm-appended candidate')
    expect(deriveBundleTrust(confirmed.bundle).status).toBe('candidate')
    expect(confirmed.bundle.events.filter(({ type }) => type === 'confirmed')).toHaveLength(1)

    await store.promote(published.id)
    await store.promote(published.id)

    const promoted = loadBundle(published.dir)
    if (promoted.kind !== 'loaded') throw new Error('expected promoted bundle')
    expect(deriveBundleTrust(promoted.bundle).status).toBe('active')
    expect(promoted.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
  })

  it('keeps an exact retracted confirmation inert until an adjacent job survives', async () => {
    const { published } = publishHeldCandidate('retracted-confirmation')
    const config = outcomeAppendConfig()
    const sharedEvidenceToken = asEvidenceToken('held-shared-confirmation')
    const originalConfirmation = {
      type: 'confirmed' as const,
      evidenceToken: sharedEvidenceToken,
      curationJobId: 'held-confirmation-original-job',
      buildOrdinal: 43,
      origin: 'agent-verified' as const,
    }
    expect(appendOutcomeEvent(config, published.id, originalConfirmation).kind).toBe('appended')
    const beforeRetraction = loadBundle(published.dir)
    if (beforeRetraction.kind !== 'loaded') throw new Error('expected confirmed candidate')
    expect(beforeRetraction.bundle.events).toContainEqual(originalConfirmation)
    expect(deriveBundleTrust(beforeRetraction.bundle).status).toBe('candidate')

    const retraction = {
      type: 'retracted' as const,
      evidenceToken: asEvidenceToken('held-confirmation-retraction'),
      curationJobId: 'rollback-held-confirmation',
      buildOrdinal: 44,
      retractsEvidenceToken: sharedEvidenceToken,
      retractsCurationJobId: originalConfirmation.curationJobId,
      rollbackReceiptId: 'rollback:held-confirmation',
    }
    expect(appendOutcomeEvent(config, published.id, retraction).kind).toBe('appended')

    const store = promotionStore(45)
    await expect(store.promote(published.id)).rejects.toMatchObject({
      reason: 'no-confirmed-evidence',
    })
    const afterRetraction = loadBundle(published.dir)
    if (afterRetraction.kind !== 'loaded') throw new Error('expected retracted candidate')
    expect(afterRetraction.bundle.events).toEqual([originalConfirmation, retraction])
    expect(deriveBundleTrust(afterRetraction.bundle).status).toBe('candidate')

    const adjacentConfirmation = {
      ...originalConfirmation,
      curationJobId: 'held-confirmation-adjacent-job',
      buildOrdinal: 45,
    }
    expect(appendOutcomeEvent(config, published.id, adjacentConfirmation).kind).toBe('appended')
    await store.promote(published.id)
    await store.promote(published.id)

    const promoted = loadBundle(published.dir)
    if (promoted.kind !== 'loaded') throw new Error('expected adjacent confirmation promotion')
    expect(deriveBundleTrust(promoted.bundle).status).toBe('active')
    expect(promoted.bundle.events).toEqual(expect.arrayContaining([
      originalConfirmation,
      retraction,
      adjacentConfirmation,
    ]))
    expect(promoted.bundle.events.filter(({ type }) => type === 'confirmed')).toHaveLength(2)
    expect(promoted.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(1)
    expect(promoted.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
  })

  it('removes only the exact deprecation hold before explicit promotion', async () => {
    const { published } = publishHeldCandidate('retracted-deprecation')
    const config = outcomeAppendConfig()
    expect(appendOutcomeEvent(config, published.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('held-deprecation-confirmation'),
      curationJobId: 'held-deprecation-confirmation-job',
      buildOrdinal: 43,
      origin: 'agent-verified',
    }).kind).toBe('appended')

    const sharedDeprecationToken = asEvidenceToken('held-shared-deprecation')
    const firstDeprecation = {
      type: 'deprecated' as const,
      evidenceToken: sharedDeprecationToken,
      curationJobId: 'held-deprecation-first-job',
      buildOrdinal: 44,
      reason: 'first exact deprecation',
    }
    const adjacentDeprecation = {
      ...firstDeprecation,
      curationJobId: 'held-deprecation-adjacent-job',
      buildOrdinal: 45,
      reason: 'adjacent surviving deprecation',
    }
    expect(appendOutcomeEvent(config, published.id, firstDeprecation).kind).toBe('appended')
    expect(appendOutcomeEvent(config, published.id, adjacentDeprecation).kind).toBe('appended')

    const store = promotionStore(48)
    await expect(store.promote(published.id)).rejects.toMatchObject({
      reason: 'not-candidate',
    })
    expect(appendOutcomeEvent(config, published.id, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('held-first-deprecation-retraction'),
      curationJobId: 'rollback-held-first-deprecation',
      buildOrdinal: 46,
      retractsEvidenceToken: sharedDeprecationToken,
      retractsCurationJobId: firstDeprecation.curationJobId,
      rollbackReceiptId: 'rollback:held-first-deprecation',
    }).kind).toBe('appended')
    await expect(store.promote(published.id)).rejects.toMatchObject({
      reason: 'not-candidate',
    })

    expect(appendOutcomeEvent(config, published.id, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('held-adjacent-deprecation-retraction'),
      curationJobId: 'rollback-held-adjacent-deprecation',
      buildOrdinal: 47,
      retractsEvidenceToken: sharedDeprecationToken,
      retractsCurationJobId: adjacentDeprecation.curationJobId,
      rollbackReceiptId: 'rollback:held-adjacent-deprecation',
    }).kind).toBe('appended')
    await store.promote(published.id)

    const promoted = loadBundle(published.dir)
    if (promoted.kind !== 'loaded') throw new Error('expected promotion after deprecation rollback')
    expect(deriveBundleTrust(promoted.bundle).status).toBe('active')
    expect(promoted.bundle.events.filter(({ type }) => type === 'deprecated')).toHaveLength(2)
    expect(promoted.bundle.events.filter(({ type }) => type === 'retracted')).toHaveLength(2)
    expect(promoted.bundle.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
  })
})
