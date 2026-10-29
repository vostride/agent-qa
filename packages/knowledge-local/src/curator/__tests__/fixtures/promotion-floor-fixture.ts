// Shared builders for the promotion-floor acceptance tests.
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, GATE_RECEIPT_SCHEMA_VERSION, stampReceiptDigest, type Gate3Receipt, type GateVerdict, type Anchor, type BundleDraft, type DistilledObservation, type ExecutionContext } from '@vostride/agent-qa-schema'
import { expect, vi } from 'vitest'
import { createLocalKnowledgeStore, drainQueue, enumerateBundleDirs, loadBundle, type BundleStoreConfig, type CuratorAuthor, type DrainOptions, type LoadedBundle } from '../../../index.js'
import { publishBundle } from '../../../bundle-publish.test-helper.js'
import { enqueueArtifactFreeCandidateProjection, type ArtifactFreeCandidateProjectionInput } from '../../../__tests__/fixtures/curation-candidate-fixture.js'
import { acquireWriterLease } from '../../../lease/writer-lease.js'
const NO_INDEX_MAINTENANCE = { indexAbsent: false, pendingEmbeddings: 0, renderingEpochStale: false, vectorReconciliationOutstanding: false } as const
export function markReceipt(
  candidateId: string,
  overrides?: { producedAtOrdinal?: number; verdict?: GateVerdict },
): Gate3Receipt {
  return stampReceiptDigest({
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION, gate: 3, candidateId, verdict: overrides?.verdict ?? 'pass',
    producedAtOrdinal: overrides?.producedAtOrdinal ?? 44, producedBy: { opId: 'test' },
    runId: 'marked-run', mark: 'confirmed-bug',
  })
}
export function createPromotionFloorFixture({ knowledgeRoot }: { knowledgeRoot: string }) {
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
    drainOptions: Partial<DrainOptions> = {},
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
      ...drainOptions,
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

  function publishHeldCaution(seed: string) {
    const projection = cautionProjection(seed)
    const draft: BundleDraft = {
      kind: 'caution', anchors: projection.anchors,
      scope: projection.scope, summary: projection.summarySeed, body: projection.bodySeed,
      distilledEvidenceRef: { id: `held-caution-${seed}`, sha: 'b'.repeat(64) },
      originStage: 'run-curation',
    }
    const published = publishBundle(outcomeAppendConfig(), {
      draft, discriminant: { kind: 'caution', errorKey: 'checkout confirmation timed out' },
      originClass: 'agent-verified', createdAtOrdinal: 42,
      screenStates: [], initialEvents: [], relations: [],
      provenance: { mode: 'run-linked', runId: `held-caution-${seed}-run`,
        testId: `held-caution-${seed}-test`, stepIndex: 0,
        curationJobId: `held-caution-${seed}-seed`, sourceBuildOrdinal: 42,
        authorship: { path: 'deterministic-fallback', executionContext: 'local-interactive' } },
      artifacts: [], evidenceMarkdown: 'Held pending canonical confirmation.\n',
      distilledObservations: projection.distilledObservations,
    })
    if (published.kind !== 'published') throw new Error(`expected held caution publish, got ${published.kind}`)
    return { draft, published }
  }
  function canaryStore(sourceBuildOrdinal: number, sourceRunId: string) {
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected canary fixture writer lease')
    return createLocalKnowledgeStore({ knowledgeRoot,
      executionContext: 'local-interactive', epoch: lease.epoch, writerLeaseId: lease.leaseId,
      sourceBuildOrdinal, sourceRunId })
  }
  return { selectorProjection, cautionProjection, enqueue, drainWithoutModel, onlyBundle,
    publishHeldCandidate, publishHeldCaution, outcomeAppendConfig, promotionStore, canaryStore }
}
