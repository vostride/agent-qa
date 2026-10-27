import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deriveBundleTrust,
  drainQueue,
  appendOutcomeEvent,
  listQueuedCandidates,
  loadBundle,
  openKnowledgeReader,
  readCanonicalBundleAnchors,
  rebuildIndex,
  type BundleStoreConfig,
  type CuratorAuthor,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asEvidenceToken,
  asRecordId,
  asRef,
  asRunId,
  BundleOutcomeEventSchema,
  canonicalJson,
  computeBriefDigest,
  deriveEvidenceToken,
  sha256hex,
  type Anchor,
  type BundleDiscriminant,
  type BundleDraft,
  type CompletedRunHandoff,
  type DistilledObservation,
  type ElementInfo,
  type RecordId,
  type ScreenState,
  type ServedBrief,
  type StepEvidence,
  type SubActionEvidence,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  emitCanaryOutcomes,
  projectCanaryOutcomes,
} from '../index.js'

const PRODUCT = 'canary-seam-storefront'
const BUILD_ORDINAL = 43
const POLICY_TEXT = 'GLOBAL POLICY: preserve checkout canary evidence.'
const CANDIDATE_ANCHOR: Anchor = {
  t: 'el',
  role: 'button',
  name: 'Checkout',
  ordinal: 0,
}

function element(): ElementInfo {
  return {
    ref: asRef('checkout'),
    role: 'button',
    name: 'Checkout',
    nameNormalized: 'checkout',
    bounds: { x: 10, y: 20, width: 100, height: 40 },
    center: { x: 60, y: 40 },
    state: { enabled: true, focused: false, visible: true, clickable: true },
    labels: { ariaLabel: 'Checkout' },
    attributes: { 'data-testid': 'checkout' },
  }
}

function screen(): ScreenState {
  const checkout = element()
  return {
    platform: 'web',
    tree: 'button Checkout',
    elements: [checkout],
    refMap: {
      [checkout.ref]: {
        bounds: checkout.bounds!,
        center: checkout.center!,
      },
    },
    url: '/cart',
    timestamp: 1_750_000_000_000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      scroll: {
        offsetX: 0,
        offsetY: 0,
        contentWidth: 1_280,
        contentHeight: 1_440,
      },
    },
  }
}

function exercisedSubAction(): SubActionEvidence {
  const state = screen()
  return {
    plan: 'Click Checkout',
    plannedAction: { type: 'click', ref: asRef('checkout') },
    stateBefore: state,
    stateAfter: state,
    result: { success: true },
  }
}

function servedBrief(candidateId: RecordId, line: ServedBrief['channel1'][number]): ServedBrief {
  const brief: ServedBrief = {
    scope: { tier: 'product', key: PRODUCT },
    asOfBuild: BUILD_ORDINAL,
    budget: 1_000,
    truncation: 'none',
    channel1: [{ ...line, id: candidateId }],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...brief, briefDigest: computeBriefDigest(brief) }
}

function completedHandoff(
  candidateId: RecordId,
  line: ServedBrief['channel1'][number],
): CompletedRunHandoff {
  const step: StepEvidence = {
    stepIndex: 0,
    stepText: 'Click Checkout',
    cacheStatus: 'miss',
    servedBrief: servedBrief(candidateId, line),
    subActions: [exercisedSubAction()],
    verifierVerdict: { pass: true, reasoning: 'Checkout was exercised successfully.' },
  }
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId('run-canary-seam-live-shape'),
    scope: { tier: 'product', key: PRODUCT },
    buildOrdinal: BUILD_ORDINAL,
    executionContext: 'local-interactive',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [{
      testId: 'checkout::canary-seam',
      testName: 'Checkout canary seam',
      filePath: 'checkout.spec.yaml',
      testIndex: 0,
      outcome: 'passed',
      steps: [step],
    }],
  }
}

function candidateInput(): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [
      CANDIDATE_ANCHOR,
      { t: 'page', route: '/checkout' },
      { t: 'selector', literal: '[data-testid="checkout"]' },
    ],
    scope: { tier: 'product', key: PRODUCT },
    summary: 'Use the Checkout button to continue from the cart.',
    body: 'The Checkout button was resolved and verified on the cart screen.',
    distilledEvidenceRef: {
      id: 'canary-seam-seed-evidence',
      sha: 'a'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name: 'Checkout' },
  }
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'checkout-click', ordinal: 0 },
    platform: 'web',
    element: { naturalKey: 'button:checkout:0' },
    locator: { selector: '[data-testid="checkout"]' },
    observedAtOrdinal: BUILD_ORDINAL - 1,
  }
  return {
    draft,
    discriminant,
    originClass: 'agent-verified',
    createdAtOrdinal: BUILD_ORDINAL - 1,
    screenStates: [],
    initialEvents: [BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: asEvidenceToken('canary-seam-seed-confirmation'),
      curationJobId: 'canary-seam-seed-confirmation',
      buildOrdinal: BUILD_ORDINAL - 1,
      origin: 'agent-verified',
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: 'run-canary-seam-seed',
      testId: 'test-canary-seam-seed',
      stepIndex: 0,
      curationJobId: 'seed-canary-seam-candidate',
      sourceBuildOrdinal: BUILD_ORDINAL - 1,
    },
    artifacts: [],
    evidenceMarkdown: 'Deterministically observed during checkout.\n',
    distilledObservations: [observation],
  }
}

function expectedCanaryEvidenceToken(
  outcome: ReturnType<typeof projectCanaryOutcomes>[number],
): string {
  const attributingObservationId = `canary-outcome:${sha256hex(canonicalJson({
    candidateId: outcome.candidateId,
    runId: outcome.runId,
    testId: outcome.testId,
    testIndex: outcome.testIndex,
    stepIndex: outcome.stepIndex,
  }))}`
  return deriveEvidenceToken({
    attributingObservationId,
    anchor: outcome.exercisedAnchor,
    buildOrdinal: outcome.buildOrdinal,
  })
}

describe('canary seam public integration (PROM-02/SC5 substrate)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves, attributes, enqueues, drains, promotes, and replay-drains without double-counting', async () => {
    const root = mkdtempSync(join(tmpdir(), `agent-qa-canary-seam-${randomUUID()}-`))
    roots.push(root)
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const agentQaRoot = join(root, '.agent-qa')
    const runDir = join(agentQaRoot, 'runs', 'run-canary-seam-live-shape')
    mkdirSync(join(knowledgeRoot, 'policies'), { recursive: true })
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(knowledgeRoot, 'policies', 'global.md'), `${POLICY_TEXT}\n`, 'utf8')

    const storeConfig: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'canary-seam-seed',
    }
    const published = publishBundle(storeConfig, candidateInput())
    if (published.kind !== 'published') {
      throw new Error(`expected candidate publication, got ${published.kind}`)
    }
    await rebuildIndex({ knowledgeRoot })

    const reader = openKnowledgeReader({
      knowledgeRoot,
      product: PRODUCT,
      scopeDefaults: { asOfBuild: BUILD_ORDINAL },
    })
    const { brief } = reader.getRunBrief({ tier: 'product', key: PRODUCT }, 1_000)
    const servedCandidate = brief.lines.find(({ id }) => id === published.id)

    expect(brief.tiers.L0).toContain(POLICY_TEXT)
    expect(servedCandidate).toMatchObject({
      id: published.id,
      status: 'candidate',
      servedAsCanary: true,
      tier: 'L2',
    })
    expect(brief.tiers.L2).toContain('CANARY')
    if (servedCandidate === undefined) throw new Error('candidate was not served')

    const handoff = completedHandoff(published.id, servedCandidate)
    const projectionInput = {
      handoff,
      resolveCandidateAnchors: (id: RecordId) => readCanonicalBundleAnchors({
        knowledgeRoot,
        bundleId: id,
      }),
    }
    const firstProjection = projectCanaryOutcomes(projectionInput)
    const secondProjection = projectCanaryOutcomes(projectionInput)
    expect(canonicalJson(secondProjection)).toBe(canonicalJson(firstProjection))
    expect(firstProjection).toHaveLength(1)
    expect(firstProjection[0]).toMatchObject({ benefit: 'rode-along' })

    const firstEmit = await emitCanaryOutcomes({
      handoff,
      knowledgeRoot,
      runDir,
      emit: reader.emitCanaryOutcome.bind(reader),
    })
    const queuedAfterFirstEmit = listQueuedCandidates(knowledgeRoot)
    const secondEmit = await emitCanaryOutcomes({
      handoff,
      knowledgeRoot,
      runDir,
      emit: reader.emitCanaryOutcome.bind(reader),
    })

    expect(firstEmit).toMatchObject({ emitted: 1, refused: 0 })
    expect(secondEmit).toMatchObject({ emitted: 1, refused: 0 })
    expect(queuedAfterFirstEmit).toHaveLength(1)
    expect(listQueuedCandidates(knowledgeRoot)).toEqual(queuedAfterFirstEmit)

    const author = vi.fn<CuratorAuthor>(async () => {
      throw new Error('canary jobs must never invoke the Curator author')
    })
    const firstDrain = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
    })

    expect(firstDrain).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    expect(author).not.toHaveBeenCalled()
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])

    const loadedAfterFirstDrain = loadBundle(published.dir)
    if (loadedAfterFirstDrain.kind !== 'loaded') {
      throw new Error(`expected loaded candidate, got ${loadedAfterFirstDrain.kind}`)
    }
    const expectedToken = expectedCanaryEvidenceToken(firstProjection[0]!)
    const confirmedIndex = loadedAfterFirstDrain.bundle.events.findIndex(
      (event) => event.type === 'confirmed' && event.evidenceToken === expectedToken,
    )
    const promotedIndex = loadedAfterFirstDrain.bundle.events.findIndex(
      (event) => event.type === 'promoted',
    )
    const firstTrust = deriveBundleTrust(loadedAfterFirstDrain.bundle)

    expect(confirmedIndex).toBeGreaterThanOrEqual(0)
    expect(promotedIndex).toBeGreaterThan(confirmedIndex)
    expect(firstTrust.status).toBe('active')
    expect(firstTrust.counters.confirmed).toBe(2)

    const evidenceAfterFirstDrain = canonicalJson({
      events: loadedAfterFirstDrain.bundle.events,
      trust: firstTrust,
    })
    reader.emitCanaryOutcome(firstProjection[0]!)
    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(1)

    const replayDrain = await drainQueue({
      knowledgeRoot,
      author,
      executionContext: 'local-interactive',
    })
    const loadedAfterReplay = loadBundle(published.dir)
    if (loadedAfterReplay.kind !== 'loaded') {
      throw new Error(`expected replayed candidate, got ${loadedAfterReplay.kind}`)
    }

    expect(replayDrain).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    expect(author).not.toHaveBeenCalled()
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    expect(canonicalJson({
      events: loadedAfterReplay.bundle.events,
      trust: deriveBundleTrust(loadedAfterReplay.bundle),
    })).toBe(evidenceAfterFirstDrain)
  }, 30_000)

  it('retries a failed queue drop from canonical bytes after the served candidate is superseded', async () => {
    const root = mkdtempSync(join(tmpdir(), `agent-qa-canary-restart-${randomUUID()}-`))
    roots.push(root)
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const agentQaRoot = join(root, '.agent-qa')
    const runDir = join(agentQaRoot, 'runs', 'run-canary-seam-live-shape')
    mkdirSync(join(knowledgeRoot, 'policies'), { recursive: true })
    mkdirSync(runDir, { recursive: true })

    const storeConfig: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'canary-restart-seed',
    }
    const published = publishBundle(storeConfig, candidateInput())
    if (published.kind !== 'published') {
      throw new Error(`expected candidate publication, got ${published.kind}`)
    }
    await rebuildIndex({ knowledgeRoot })

    const reader = openKnowledgeReader({
      knowledgeRoot,
      product: PRODUCT,
      scopeDefaults: { asOfBuild: BUILD_ORDINAL },
    })
    const served = reader
      .getRunBrief({ tier: 'product', key: PRODUCT }, 1_000)
      .brief.lines.find(({ id }) => id === published.id)
    if (served === undefined) throw new Error('candidate was not served')
    const handoff = completedHandoff(published.id, served)

    const first = await emitCanaryOutcomes({
      handoff,
      knowledgeRoot,
      runDir,
      emit() {
        throw new Error('simulated first queue drop failure')
      },
    })
    expect(first).toMatchObject({ emitted: 0, refused: 1, unresolved: 0 })
    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])

    expect(appendOutcomeEvent(storeConfig, published.id, BundleOutcomeEventSchema.parse({
      type: 'superseded',
      evidenceToken: asEvidenceToken('canary-restart-superseded'),
      curationJobId: 'canary-restart-superseded',
      buildOrdinal: BUILD_ORDINAL,
      byRecordId: asRecordId('fact-canary-replacement-0123456789abcdef'),
    }))).toEqual({ kind: 'appended' })
    await rebuildIndex({ knowledgeRoot })
    expect(reader.read(published.id)).toBeUndefined()

    const replay = await emitCanaryOutcomes({
      handoff,
      knowledgeRoot,
      runDir,
      emit: reader.emitCanaryOutcome.bind(reader),
    })
    expect(replay).toMatchObject({ emitted: 1, refused: 0, unresolved: 0 })
    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(1)
  }, 30_000)
})
