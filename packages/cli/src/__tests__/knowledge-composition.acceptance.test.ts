// D-14/SC1 — 382's structural-functional proof; 383 keeps the human-gated live cold→warm E2E.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  enqueueCurationCandidateProjection,
  enumerateBundleDirs,
  listQueuedCandidates,
  loadBundle,
  rebuildIndex,
  type BundleStoreConfig,
  type CurationCandidateProjection,
  type PublishBundleInput,
} from '@vostride/agent-qa-knowledge-local'
import { publishBundleForTest as publishBundle } from '@vostride/agent-qa-knowledge-local'
import {
  runMemberTest,
  type LoopPorts,
  type MemberEventSink,
  type MemberTest,
  type PlatformAdapter,
  type StepResult,
} from '@vostride/agent-qa-runner'
import {
  HANDOFF_FILE,
  RUNS_SUBDIR,
  slugBranch,
} from '@vostride/agent-qa-runner-local'
import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  CURRENT_HANDOFF_SCHEMA_VERSION,
  asEvidenceToken,
  asRunId,
  BundleOutcomeEventSchema,
  canonicalJson,
  computeBriefDigest,
  type BundleDiscriminant,
  type BundleDraft,
  type CompletedRunHandoff,
  type DistilledObservation,
  type ServedBrief,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildMemberRunConfig, constructKnowledgeReader } from '@vostride/agent-qa-agent-local'
import { CURATION_TAIL_RECEIPT_FILE, runCurationTail } from '../curation/curation-tail.js'

const PRODUCT = 'composition-storefront'
const BUILD_ORDINAL = 52

function committedFixtureInput(): PublishBundleInput {
  const draft: BundleDraft = {
    kind: 'fact',
    subtype: 'selector',
    anchors: [
      { t: 'el', role: 'button', name: 'Place order', ordinal: 0 },
      { t: 'page', route: '/checkout' },
      { t: 'selector', literal: '[data-testid="place-order"]' },
    ],
    scope: { tier: 'product', key: PRODUCT },
    summary: 'Use the Place order button to submit checkout.',
    body: 'The Place order button was resolved and verified on checkout.',
    distilledEvidenceRef: {
      id: 'composition-reader-evidence',
      sha: 'a'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const discriminant: BundleDiscriminant = {
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'button', name: 'Place order' },
  }
  const observation: DistilledObservation = {
    schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
    step: { naturalKey: 'place-order-click', ordinal: 0 },
    platform: 'web',
    element: { naturalKey: 'button:place-order:0' },
    locator: { selector: '[data-testid="place-order"]' },
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
      evidenceToken: asEvidenceToken('composition-reader-confirmation'),
      curationJobId: 'composition-reader-confirmation',
      buildOrdinal: BUILD_ORDINAL - 1,
      origin: 'agent-verified',
    })],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: 'run-composition-reader-seed',
      testId: 'test-composition-reader-seed',
      stepIndex: 0,
      curationJobId: 'composition-reader-seed',
      sourceBuildOrdinal: BUILD_ORDINAL - 1,
    },
    artifacts: [],
    evidenceMarkdown: 'Deterministically observed during checkout.\n',
    distilledObservations: [observation],
  }
}

function emptyServedBrief(): ServedBrief {
  const brief: ServedBrief = {
    scope: { tier: 'product', key: PRODUCT },
    asOfBuild: BUILD_ORDINAL,
    budget: 128,
    truncation: 'none',
    channel1: [],
    channel2: [],
    channel3: [],
    briefDigest: '',
  }
  return { ...brief, briefDigest: computeBriefDigest(brief) }
}

function completedHandoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: asRunId(runId),
    scope: { tier: 'product', key: PRODUCT },
    buildOrdinal: BUILD_ORDINAL,
    executionContext: 'ci',
    aggregateVerdict: 'passed',
    configDigests: {
      suiteConfigDigest: 'composition-suite-digest',
      testConfigDigest: 'composition-test-digest',
    },
    startedAt: 1_750_000_000_000,
    endedAt: 1_750_000_001_000,
    tests: [{
      testId: 'checkout::composition',
      testName: 'knowledge composition acceptance',
      filePath: 'checkout.test.yaml',
      testIndex: 0,
      outcome: 'passed',
      steps: [{
        stepIndex: 0,
        stepText: 'Submit checkout',
        cacheStatus: 'miss',
        servedBrief: emptyServedBrief(),
        subActions: [],
        verifierVerdict: { pass: true, reasoning: 'Fixture completed.' },
      }],
    }],
  }
}

function queueProjection(runId: string): CurationCandidateProjection {
  return {
    sourceRunId: runId,
    scope: { tier: 'product', key: PRODUCT },
    buildOrdinal: BUILD_ORDINAL,
    executionContext: 'ci',    kind: 'fact',
    subtype: 'selector',
    anchors: [
      { t: 'el', role: 'button', name: 'Review order', ordinal: 0 },
      { t: 'page', route: '/checkout/review' },
      { t: 'selector', literal: '[data-testid="review-order"]' },
    ],
    summarySeed: 'Review order selector',
    bodySeed: 'The Review order button was resolved and verified.',
    distilledObservations: [{
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: 'review-order', ordinal: 0 },
      platform: 'web',
      element: { naturalKey: 'button:review-order:0' },
      locator: { selector: '[data-testid="review-order"]' },
      observedAtOrdinal: BUILD_ORDINAL,
    }],
    evidenceToken: 'composition-writer-evidence',
    attributingObservationId: 'composition-writer-observation',
    artifactDescriptors: [],
    emittedAt: '2026-07-22T00:00:00.000Z',
  }
}

function eventSink(): MemberEventSink {
  return {
    stepStarted() {},
    loopEmitFor() {
      return {
        stepFinalized() {},
        subActionRecorded() {},
      }
    },
    hookStarted() {},
    hookFinished() {},
    testRetryScheduled() {},
  }
}

describe('knowledge composition acceptance (D-14/SC1)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds the carved-out reader into LoopPorts and serves a committed fixture brief', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-reader-composition-'))
    roots.push(root)
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const storeConfig: BundleStoreConfig = {
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'composition-reader-seed',
    }
    const published = publishBundle(storeConfig, committedFixtureInput())
    if (published.kind !== 'published') {
      throw new Error(`expected fixture publication, got ${published.kind}`)
    }
    await rebuildIndex({ knowledgeRoot })

    const knowledgeReader = constructKnowledgeReader({
      knowledgeRoot,
      product: PRODUCT,
      asOfBuild: BUILD_ORDINAL,
      recordCap: 24,
    })
    const captured: LoopPorts[] = []
    const config = Object.assign(buildMemberRunConfig({
      adapter: { platform: 'web' } as unknown as PlatformAdapter,
      planner: {} as never,
      verifier: {} as never,
      knowledgeReader,
      plannerModel: {} as never,
      verifierModel: {} as never,
      sink: eventSink(),
      testIndex: 0,
      abortSignal: new AbortController().signal,
      filePath: 'checkout.test.yaml',
    }), {
      executeStep: async (_instruction: string, ports: LoopPorts): Promise<StepResult> => {
        captured.push(ports)
        return {
          name: 'Submit checkout',
          status: 'passed',
          duration: 1,
          trace: {
            observation: 'Fixture executed.',
            reasoning: 'No browser or model was needed.',
            plannedAction: { type: 'click', ref: 'place-order' } as never,
            result: 'success',
            screenStateBefore: '',
          },
        }
      },
    })
    const member: MemberTest = {
      testId: 'checkout::composition',
      name: 'knowledge composition acceptance',
      filePath: 'checkout.test.yaml',
      steps: ['Submit checkout'],
    }

    await expect(runMemberTest(member, config)).resolves.toMatchObject({ status: 'passed' })
    expect(captured).toHaveLength(1)
    expect(captured[0]!.knowledgeReader).toBe(knowledgeReader)

    const { brief } = captured[0]!.knowledgeReader!.getRunBrief(
      { tier: 'product', key: PRODUCT },
      1_000,
    )
    expect(brief.lines).toContainEqual(expect.objectContaining({ id: published.id }))
  }, 30_000)

  it('drains a public-surface queue job through the post-verdict tail into a committed bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-writer-composition-'))
    roots.push(root)
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    const agentQaRoot = join(root, '.agent-qa')
    const runId = 'run-knowledge-writer-composition'
    const runDir = join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId))
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, HANDOFF_FILE),
      `${canonicalJson(completedHandoff(runId))}\n`,
      'utf8',
    )

    const enqueued = enqueueCurationCandidateProjection({
      knowledgeRoot,
      projection: queueProjection(runId),
      artifactSources: [],
    })
    expect(enqueued.kind).toBe('enqueued')
    if (enqueued.kind !== 'enqueued') {
      throw new Error(`expected queued fixture, got ${enqueued.kind}`)
    }
    expect(listQueuedCandidates(knowledgeRoot)).toHaveLength(1)

    const warn = vi.fn()
    await runCurationTail({
      runId,
      agentQaRoot,
      knowledgeConfig: { dir: 'agent-qa-knowledge' },
      configDir: root,
      log: { warn },
    })

    expect(listQueuedCandidates(knowledgeRoot)).toEqual([])
    const bundles = enumerateBundleDirs(knowledgeRoot)
    expect(bundles).toHaveLength(1)
    const loaded = loadBundle(bundles[0]!.dir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected one committed fixture bundle')
    expect(loaded.bundle.events).toContainEqual(
      expect.objectContaining({ curationJobId: enqueued.candidateId }),
    )
    expect(warn).not.toHaveBeenCalled()
    expect(existsSync(join(runDir, CURATION_TAIL_RECEIPT_FILE))).toBe(true)
  }, 30_000)
})
