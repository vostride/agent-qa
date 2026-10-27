import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleDraft,
  Delta,
  DistilledObservation,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  candidateContentAddress,
  commitCurationDelta,
  createLocalKnowledgeStore,
  deriveBundleTrust,
  loadBundle,
  openIndexReaderConnection,
  rollbackCurationJob,
  type CommitCurationDependencies,
  type CommitCurationJob,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import { derivePromotedEvidenceToken } from '../curator/commit.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import { candidateAddressFixture } from './fixtures/curation-candidate-fixture.js'
import type { AuthoredDeltaCheckpoint } from '../curator/author-contract.js'

const PRODUCT = 'rollback-promotion-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const
const DISPLAY_NAME = 'Rollback promotion checkout'
const ANCHORS: Anchor[] = [
  { t: 'el', role: 'button', name: DISPLAY_NAME, ordinal: 0 },
  { t: 'page', route: '/rollback-promotion/checkout' },
  { t: 'selector', literal: '[data-testid="rollback-promotion-checkout"]' },
]
const OBSERVATION: DistilledObservation = {
  schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
  step: { naturalKey: 'rollback-promotion-checkout', ordinal: 0 },
  platform: 'web',
  element: { naturalKey: `button:${DISPLAY_NAME.toLowerCase()}:0` },
  locator: { selector: '[data-testid="rollback-promotion-checkout"]' },
  observedAtOrdinal: 42,
}
const DRAFT: BundleDraft = {
  kind: 'fact',
  subtype: 'selector',
  anchors: [...ANCHORS],
  scope: SCOPE,
  summary: `${DISPLAY_NAME} selector`,
  body: `The ${DISPLAY_NAME} button was resolved and verified.`,
  distilledEvidenceRef: { id: 'rollback-promotion-evidence', sha: 'a'.repeat(64) },
  originStage: 'run-curation',
}
const CONVERSION_EVIDENCE_TOKEN = 'rollback-promotion-conversion-evidence'

describe('rollback-to-promotion public acceptance (PROM-01/DCAY-05)', () => {
  let root: string
  let knowledgeRoot: string
  let epoch: number
  let leaseId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-rollback-promotion-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
    const lease = acquireWriterLease(knowledgeRoot)
    if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
    epoch = lease.epoch
    leaseId = lease.leaseId
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publishHeldCandidate() {
    // A pre-existing candidate: held by the gate because it has zero confirmed
    // evidence, so the only confirmations it ever earns come from the conversion job.
    const published = publishBundle({
      knowledgeRoot,
      productKey: PRODUCT,
      writerLeaseId: 'rollback-promotion-fixture',
    }, {
      draft: DRAFT,
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: DISPLAY_NAME },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'rollback-promotion-held-run',
        testId: 'rollback-promotion-held-test',
        stepIndex: 0,
        curationJobId: 'rollback-promotion-held-seed',
        sourceBuildOrdinal: 42,
        authorship: {
          path: 'deterministic-fallback',
          executionContext: 'local-interactive',
        },
      },
      artifacts: [],
      evidenceMarkdown: 'Held pending canonical confirmation.\n',
      distilledObservations: [OBSERVATION],
    })
    if (published.kind !== 'published') {
      throw new Error(`expected held candidate publish, got ${published.kind}`)
    }
    return published
  }

  function conversionJob(): CommitCurationJob {
    const fields = candidateAddressFixture({
      schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
      sourceRunId: 'run-rollback-promotion-conversion',
      scope: SCOPE,
      buildOrdinal: 43,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: ANCHORS,
      summarySeed: DRAFT.summary,
      bodySeed: DRAFT.body,
      distilledObservations: [OBSERVATION],
      evidenceToken: CONVERSION_EVIDENCE_TOKEN,
      attributingObservationId: 'rollback-promotion-conversion-observation',
      artifactInventory: [],
      emittedAt: '2026-07-17T00:00:00.000Z',
    })
    const payload = { candidateId: candidateContentAddress(fields), ...fields }
    const candidateDir = join(root, 'claimed', payload.candidateId)
    const artifactsDir = join(candidateDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(candidateDir, 'payload.json'), JSON.stringify(payload), 'utf8')
    return {
      kind: 'claimed',
      candidateId: payload.candidateId,
      leaseId,
      payload,
      candidateDir,
      payloadPath: join(candidateDir, 'payload.json'),
      artifactsDir,
      screenStates: [],
    }
  }

  function conversionCheckpoint(delta: Delta): AuthoredDeltaCheckpoint {
    return {
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      delta,
      neighborIds: [],
      preconditions: [],
      authorship: {
        path: 'deterministic-fallback',
        executionContext: 'local-interactive',
      },
    }
  }

  function dependencies(): CommitCurationDependencies {
    return {
      knowledgeRoot,
      epoch,
      profile: { mode: 'drain-to-active' },
      drainState: { supersedesSeenByAnchorKey: new Map() },
    }
  }

  function activeWallBundleIds(): string[] {
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      return (reader.db
        .prepare("SELECT bundle_id FROM records WHERE status = 'active'")
        .all() as { bundle_id: string }[])
        .map(({ bundle_id }) => bundle_id)
    } finally {
      reader.db.close()
    }
  }

  function loadedBundle(dir: string) {
    const loaded = loadBundle(dir)
    if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${loaded.kind}`)
    return loaded.bundle
  }

  it('reverses a same-drain conversion promotion end to end: candidate, non-serving, un-promotable', async () => {
    const held = publishHeldCandidate()
    expect(deriveBundleTrust(loadedBundle(held.dir)).status).toBe('candidate')

    // Same-drain conversion: the already-exists path appends confirmed and the
    // drain-to-active tail appends promoted, both under this job's candidateId.
    const job = conversionJob()
    const delta: Extract<Delta, { kind: 'Add' }> = {
      kind: 'Add',
      origin: 'agent',
      scope: SCOPE,
      citedIds: [],
      bundle: DRAFT,
      authorship: {
        path: 'deterministic-fallback',
        executionContext: 'local-interactive',
      },
    }
    const outcome = commitCurationDelta(dependencies(), job, conversionCheckpoint(delta))
    expect(outcome).toMatchObject({ kind: 'converted-confirm', bundleId: held.id })

    // Non-vacuous control: canonical truth derives active AND the projected records
    // row passes the active status wall — the promotion had observable serving effect.
    const converted = loadedBundle(held.dir)
    expect(deriveBundleTrust(converted).status).toBe('active')
    expect(converted.events).toEqual([
      expect.objectContaining({
        type: 'confirmed',
        evidenceToken: CONVERSION_EVIDENCE_TOKEN,
        curationJobId: job.candidateId,
        buildOrdinal: 43,
      }),
      expect.objectContaining({
        type: 'promoted',
        evidenceToken: derivePromotedEvidenceToken(CONVERSION_EVIDENCE_TOKEN),
        curationJobId: job.candidateId,
        buildOrdinal: 43,
      }),
    ])
    expect(activeWallBundleIds()).toContain(held.id)

    // (1) The rollback report retracts both effects of the conversion job.
    const report = rollbackCurationJob({
      knowledgeRoot,
      curationJobId: job.candidateId,
      resolvedAtOrdinal: 44,
    })
    expect(report.inverseCount).toBe(2)
    expect(report.deprecatedBundles).toEqual([])
    expect(report.affected.mintedBundleIds).toEqual([])
    // Counter events sort by recordId, then evidenceToken: the derived hex
    // promoted token precedes the plain conversion confirmation token.
    expect(report.affected.counterEvents).toEqual([
      {
        recordId: held.id,
        evidenceToken: derivePromotedEvidenceToken(CONVERSION_EVIDENCE_TOKEN),
        curationJobId: job.candidateId,
        type: 'promoted',
      },
      {
        recordId: held.id,
        evidenceToken: CONVERSION_EVIDENCE_TOKEN,
        curationJobId: job.candidateId,
        type: 'confirmed',
      },
    ])

    // (2) Canonical truth returns candidate with zero surviving confirmations.
    const rolledBack = loadedBundle(held.dir)
    const trust = deriveBundleTrust(rolledBack)
    expect(trust.status).toBe('candidate')
    expect(trust.counters.confirmed).toBe(0)

    // (3) The re-projected records row leaves the active status wall (non-serving).
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db.prepare('SELECT status FROM records WHERE bundle_id = ?').get(held.id),
      ).toMatchObject({ status: 'candidate' })
    } finally {
      reader.db.close()
    }
    expect(activeWallBundleIds()).not.toContain(held.id)

    // (4) A subsequent promote() refuses over the same canonical truth with the
    // exact deterministic reason: the only confirmations ever earned were the
    // conversion job's, and that job was rolled back.
    const store = createLocalKnowledgeStore({
      knowledgeRoot,
      executionContext: 'local-interactive',
      epoch,
      writerLeaseId: leaseId,
      sourceBuildOrdinal: 45,
    })
    await expect(store.promote(held.id)).rejects.toMatchObject({
      name: 'KnowledgePromotionError',
      candidateId: held.id,
      reason: 'no-confirmed-evidence',
    })
    expect(deriveBundleTrust(loadedBundle(held.dir)).status).toBe('candidate')
  })
})
