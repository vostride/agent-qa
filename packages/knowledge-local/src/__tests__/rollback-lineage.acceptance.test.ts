import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  sha256hex,
  supersessionKey,
  type Anchor,
  type BundleDraft,
  type BundleOutcomeEvent,
  type Delta,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  appendOutcomeEvent,
  candidateContentAddress,
  commitCurationDelta,
  deriveBundleTrust,
  disposeDelta,
  enumerateBundleDirs,
  loadBundle,
  rollbackCurationJob,
  runKnowledgeGc,
  type AuthoredDeltaCheckpoint,
  type CommitCurationDependencies,
  type CommitCurationJob,
  type LoadedBundle,
  type PublishBundleOutcome,
  type WriterLeaseAuthority,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import { candidateAddressFixture } from './fixtures/curation-candidate-fixture.js'
import {
  STABLE_WINDOW_BUILDS,
  THRASH_MAX_SUPERSESSIONS,
  THRASH_WINDOW_BUILDS,
  foldSupersessionLineage,
  scanCanonicalBundles,
} from '../curator/lineage-fold.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const PRODUCT = 'rollback-lineage-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const
const ANCHORS: Anchor[] = [
  { t: 'el', role: 'button', name: 'Rollback lineage checkout' },
  { t: 'page', route: '/rollback-lineage/checkout' },
  { t: 'platform', platform: 'web' },
]

let root: string
let knowledgeRoot: string
let epoch: number
let leaseId: string
let writerAuthority: WriterLeaseAuthority
let jobSerial: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-rollback-lineage-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
  epoch = lease.epoch
  writerAuthority = {
    knowledgeRoot,
    leaseId: lease.leaseId,
    epoch: lease.epoch,
  }
  leaseId = lease.leaseId
  jobSerial = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function storeConfig() {
  return {
    knowledgeRoot,
    productKey: PRODUCT,
  }
}

function generationDraft(generation: number): BundleDraft {
  return {
    kind: 'fact',
    subtype: 'measurement',
    anchors: [...ANCHORS],
    scope: SCOPE,
    summary: `Rollback lineage generation ${generation}`,
    body: `Canonical rollback lineage generation ${generation}.`,
    distilledEvidenceRef: {
      id: `rollback-lineage-generation-${generation}`,
      sha: generation.toString(16).padStart(64, '0'),
    },
    originStage: 'run-curation',
  }
}

function publishGeneration(generation: number, buildOrdinal: number): PublishedBundle {
  const published = publishBundle(storeConfig(), {
    draft: generationDraft(generation),
    discriminant: {
      kind: 'fact',
      subtype: 'measurement',
      metricKey: `rollback-lineage-generation-${generation}`,
    },
    originClass: 'agent-verified',
    createdAtOrdinal: buildOrdinal,
    screenStates: [],
    initialEvents: [{
      type: 'promoted',
      evidenceToken: asEvidenceToken(`rollback-lineage-promoted-${generation}`),
      curationJobId: `rollback-lineage-seed-${generation}`,
      buildOrdinal,
    }],
    relations: [],
    provenance: { mode: 'standalone', sourceDescription: 'rollback lineage fixture' },
    artifacts: [],
  })
  if (published.kind !== 'published') {
    throw new Error(`expected generation ${generation} publication, got ${published.kind}`)
  }
  return published
}

function appendLifecycleEvent(recordId: RecordId, event: BundleOutcomeEvent): void {
  expect(appendOutcomeEvent(storeConfig(), recordId, event).kind).toBe('appended')
}

function appendSupersession(
  victimId: RecordId,
  replacementId: RecordId,
  buildOrdinal: number,
  curationJobId: string,
): { supersedeToken: string; closeToken: string } {
  const supersedeToken = asEvidenceToken(`${curationJobId}-superseded`)
  const closeToken = asEvidenceToken(sha256hex(canonicalJson({
    token: supersedeToken,
    event: 'window-close',
  })))
  appendLifecycleEvent(victimId, {
    type: 'superseded',
    evidenceToken: supersedeToken,
    curationJobId,
    buildOrdinal,
    byRecordId: replacementId,
  })
  appendLifecycleEvent(victimId, {
    type: 'window-close',
    evidenceToken: closeToken,
    curationJobId,
    buildOrdinal,
    closedAtOrdinal: buildOrdinal,
  })
  return { supersedeToken, closeToken }
}

function claimedJob(generation: number, buildOrdinal: number, label: string): CommitCurationJob {
  jobSerial += 1
  const draft = generationDraft(generation)
  const fields = candidateAddressFixture({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: `run-${label}-${jobSerial}`,
    scope: SCOPE,
    buildOrdinal,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'measurement',
    anchors: ANCHORS,
    summarySeed: draft.summary,
    bodySeed: draft.body,
    distilledObservations: [],
    evidenceToken: `rollback-lineage-evidence-${label}-${jobSerial}`,
    attributingObservationId: `rollback-lineage-observation-${label}-${jobSerial}`,
    artifactInventory: [],
    emittedAt: '2026-07-17T00:00:00.000Z',
  })
  const payload = { candidateId: candidateContentAddress(fields), ...fields }
  const candidateDir = join(root, 'claimed', payload.candidateId)
  const artifactsDir = join(candidateDir, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
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

function checkpoint(delta: Delta): AuthoredDeltaCheckpoint {
  return {
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    delta,
    neighborIds: [...delta.citedIds],
    preconditions: [],
    authorship: {
      path: 'llm',
      model: { id: 'rollback-lineage-fixture' },
      executionContext: 'local-interactive',
    },
  }
}

function drainState(): CommitCurationDependencies['drainState'] {
  return { supersedesSeenByAnchorKey: new Map() }
}

function dependencies(): CommitCurationDependencies {
  return {
    knowledgeRoot,
    epoch,
    profile: { mode: 'drain-to-active' },
    drainState: drainState(),
  }
}

function prepareSupersede(
  victimId: RecordId,
  generation: number,
  buildOrdinal: number,
  label: string,
) {
  const claimed = claimedJob(generation, buildOrdinal, label)
  const delta: Extract<Delta, { kind: 'Supersede' }> = {
    kind: 'Supersede',
    origin: 'agent',
    scope: SCOPE,
    citedIds: [victimId],
    victimId,
    newBundle: generationDraft(generation),
    evidenceToken: asEvidenceToken(claimed.payload.evidenceToken),
    authorship: {
      path: 'llm',
      model: { id: 'rollback-lineage-fixture' },
      executionContext: 'local-interactive',
    },
  }
  return { claimed, delta, authored: checkpoint(delta) }
}

function commitSupersede(
  victimId: RecordId,
  generation: number,
  buildOrdinal: number,
  label: string,
) {
  const prepared = prepareSupersede(victimId, generation, buildOrdinal, label)
  const outcome = commitCurationDelta(
    dependencies(),
    prepared.claimed,
    prepared.authored,
  )
  expect(outcome.kind).toBe('applied')
  if (outcome.kind !== 'applied') throw new Error('expected an applied Supersede')
  return { ...prepared, outcome, replacementId: outcome.bundleId }
}

function prepareConfirm(targetId: RecordId, buildOrdinal: number, label: string) {
  const claimed = claimedJob(10_000 + buildOrdinal + jobSerial, buildOrdinal, label)
  const delta: Extract<Delta, { kind: 'Confirm' }> = {
    kind: 'Confirm',
    origin: 'agent',
    scope: SCOPE,
    citedIds: [targetId],
    targetId,
    evidenceToken: asEvidenceToken(claimed.payload.evidenceToken),
    authorship: {
      path: 'llm',
      model: { id: 'rollback-lineage-fixture' },
      executionContext: 'local-interactive',
    },
  }
  return { claimed, delta, authored: checkpoint(delta) }
}

function commitConfirm(targetId: RecordId, buildOrdinal: number, label: string) {
  const prepared = prepareConfirm(targetId, buildOrdinal, label)
  const outcome = commitCurationDelta(
    dependencies(),
    prepared.claimed,
    prepared.authored,
  )
  expect(outcome.kind).toBe('applied')
  if (outcome.kind !== 'applied') throw new Error('expected an applied Confirm')
  return { ...prepared, outcome }
}

function dispositionCandidate(job: CommitCurationJob) {
  return {
    anchors: job.payload.anchors,
    scope: job.payload.scope,
    buildOrdinal: job.payload.buildOrdinal,
    curationJobId: job.candidateId,
  }
}

function loadedBundles(): LoadedBundle[] {
  return enumerateBundleDirs(knowledgeRoot).flatMap((entry) => {
    const loaded = loadBundle(entry.dir)
    return loaded.kind === 'loaded' ? [loaded.bundle] : []
  })
}

function loadById(recordId: RecordId): LoadedBundle {
  const loaded = loadedBundles().find((bundle) => bundle.manifest.id === recordId)
  if (loaded === undefined) throw new Error(`missing bundle ${recordId}`)
  return loaded
}

function unresolvedUnknowns(): LoadedBundle[] {
  return loadedBundles().filter((bundle) =>
    bundle.frontmatter.kind === 'unknown'
    && deriveBundleTrust(bundle).status !== 'deprecated',
  )
}

function lineage(asOfBuildOrdinal: number, windowBuilds = THRASH_WINDOW_BUILDS) {
  return foldSupersessionLineage(scanCanonicalBundles(knowledgeRoot), {
    windowBuilds,
    asOfBuildOrdinal,
  }).get(supersessionKey(ANCHORS))
}

function rollbackJob(curationJobId: string, resolvedAtOrdinal: number) {
  return rollbackCurationJob({
    knowledgeRoot,
    curationJobId,
    resolvedAtOrdinal,
  })
}

function retractedTargets(bundle: LoadedBundle, receiptId: string): string[] {
  return bundle.events.flatMap((event) =>
    event.type === 'retracted' && event.rollbackReceiptId === receiptId
      ? [`${event.retractsEvidenceToken}:${event.retractsCurationJobId}`]
      : [],
  )
}

function publishThrashUnknown(
  marker: string,
  conflictRecordIds: readonly RecordId[],
  buildOrdinal: number,
): PublishedBundle {
  const published = publishBundle(storeConfig(), {
    draft: {
      kind: 'unknown',
      anchors: [{ t: 'flow', name: marker }],
      scope: SCOPE,
      summary: 'Rollback lineage stability is unresolved',
      body: canonicalJson({ kind: 'thrash', triggerKey: supersessionKey(ANCHORS) }),
      distilledEvidenceRef: {
        id: `rollback-lineage-unknown-${buildOrdinal}`,
        sha: (50_000 + buildOrdinal).toString(16).padStart(64, '0'),
      },
      originStage: 'run-curation',
    },
    discriminant: { kind: 'unknown', conflictRecordIds },
    originClass: 'agent-verified',
    createdAtOrdinal: buildOrdinal,
    screenStates: [],
    initialEvents: [{
      type: 'confirmed',
      evidenceToken: asEvidenceToken(`rollback-lineage-unknown-${buildOrdinal}`),
      curationJobId: `rollback-lineage-unknown-job-${buildOrdinal}`,
      buildOrdinal,
      origin: 'agent-verified',
    }],
    relations: conflictRecordIds.map((targetId) => ({
      type: 'conflicts-with' as const,
      targetId,
      addedAtOrdinal: buildOrdinal,
      curationJobId: `rollback-lineage-unknown-job-${buildOrdinal}`,
    })),
    provenance: { mode: 'standalone', sourceDescription: 'rollback lineage unknown fixture' },
    artifacts: [],
  })
  if (published.kind !== 'published') {
    throw new Error(`expected unknown publication, got ${published.kind}`)
  }
  return published
}

describe('rollback-aware lineage acceptance', () => {
  it('rollback removes lineage influence so the next Supersede trips only at three surviving events', () => {
    const first = publishGeneration(1, 1)
    const second = publishGeneration(2, 2)
    appendSupersession(first.id, second.id, 2, 'surviving-supersession-2')

    const rolledBack = commitSupersede(second.id, 3, 3, 'rolled-back-supersession')
    expect(lineage(3)).toEqual({
      supersededDepthInWindow: 2,
      latestSupersessionOrdinal: 3,
      chainRecordIds: [first.id, second.id, rolledBack.replacementId].sort(),
      windowOpenOrdinal: 1,
    })

    const liveControl = prepareSupersede(
      rolledBack.replacementId,
      4,
      4,
      'live-control-next-supersede',
    )
    const liveDecision = disposeDelta({
      delta: liveControl.delta,
      checkpoint: liveControl.authored,
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: dispositionCandidate(liveControl.claimed),
      drainState: drainState(),
    })
    expect(liveDecision).toMatchObject({
      kind: 'apply',
      unknownMintIntents: [{ kind: 'thrash', windowCloseOrdinal: 4 }],
    })

    const report = rollbackJob(rolledBack.claimed.candidateId, 4)
    const restoredVictim = loadById(second.id)
    const rolledBackReplacement = loadById(rolledBack.replacementId)
    const closeToken = asEvidenceToken(sha256hex(canonicalJson({
      token: rolledBack.delta.evidenceToken,
      event: 'window-close',
    })))

    expect(report).toMatchObject({
      inverseCount: 3,
      restoredVictims: [second.id],
      deprecatedBundles: [rolledBack.replacementId],
    })
    expect(retractedTargets(restoredVictim, report.receiptId)).toEqual(expect.arrayContaining([
      `${rolledBack.delta.evidenceToken}:${rolledBack.claimed.candidateId}`,
      `${closeToken}:${rolledBack.claimed.candidateId}`,
    ]))
    expect(deriveBundleTrust(restoredVictim).status).toBe('active')
    expect(deriveBundleTrust(rolledBackReplacement).status).toBe('deprecated')
    expect(lineage(3)).toEqual({
      supersededDepthInWindow: 1,
      latestSupersessionOrdinal: 2,
      chainRecordIds: [first.id, second.id].sort(),
      windowOpenOrdinal: 1,
    })

    const secondSurvivor = commitSupersede(
      second.id,
      5,
      4,
      'post-rollback-second-survivor',
    )
    expect(unresolvedUnknowns()).toEqual([])
    expect(lineage(4)).toMatchObject({
      supersededDepthInWindow: 2,
      latestSupersessionOrdinal: 4,
    })

    const thirdSurvivor = commitSupersede(
      secondSurvivor.replacementId,
      6,
      5,
      'post-rollback-third-survivor',
    )
    const unknowns = unresolvedUnknowns()
    expect(THRASH_MAX_SUPERSESSIONS).toBe(3)
    expect(unknowns).toHaveLength(1)
    expect(lineage(5)).toEqual({
      supersededDepthInWindow: 3,
      latestSupersessionOrdinal: 5,
      chainRecordIds: [
        first.id,
        second.id,
        secondSurvivor.replacementId,
        thirdSurvivor.replacementId,
      ].sort(),
      windowOpenOrdinal: 1,
    })
    expect(JSON.parse(unknowns[0]!.body)).toMatchObject({
      kind: 'thrash',
      triggerKey: supersessionKey(ANCHORS),
      windowCloseOrdinal: 5,
    })
  }, 15_000)

  it('rollback lets the next Confirm close from the latest surviving supersession', () => {
    const first = publishGeneration(11, 1)
    const survivor = publishGeneration(12, 4)
    appendSupersession(first.id, survivor.id, 4, 'surviving-supersession-4')
    const marker = `thrash:${supersessionKey(ANCHORS)}:window:1`
    const unknown = publishThrashUnknown(marker, [first.id, survivor.id], 4)

    const rolledBack = commitSupersede(survivor.id, 13, 8, 'rolled-back-supersession-8')
    expect(lineage(9, Number.MAX_SAFE_INTEGER)).toMatchObject({
      supersededDepthInWindow: 2,
      latestSupersessionOrdinal: 8,
    })

    const liveControl = prepareConfirm(
      rolledBack.replacementId,
      9,
      'live-control-next-confirm',
    )
    const liveDecision = disposeDelta({
      delta: liveControl.delta,
      checkpoint: liveControl.authored,
      profile: { mode: 'drain-to-active' },
      knowledgeRoot,
      candidate: dispositionCandidate(liveControl.claimed),
      drainState: drainState(),
    })
    expect(liveDecision.kind).toBe('apply')
    if (liveDecision.kind !== 'apply') throw new Error('expected an applied Confirm decision')
    expect(liveDecision.unknownResolutionIntents).toBeUndefined()
    expect(deriveBundleTrust(loadById(unknown.id)).status).toBe('candidate')

    const report = rollbackJob(rolledBack.claimed.candidateId, 9)
    expect(lineage(9, Number.MAX_SAFE_INTEGER)).toEqual({
      supersededDepthInWindow: 1,
      latestSupersessionOrdinal: 4,
      chainRecordIds: [first.id, survivor.id].sort(),
      windowOpenOrdinal: 1,
    })
    expect(retractedTargets(loadById(survivor.id), report.receiptId)).toHaveLength(2)

    commitConfirm(survivor.id, 9, 'post-rollback-next-confirm')
    const resolved = loadById(asRecordId(unknown.id))
    expect(STABLE_WINDOW_BUILDS).toBe(5)
    expect(deriveBundleTrust(resolved).status).toBe('deprecated')
    expect(resolved.events).toContainEqual(expect.objectContaining({
      type: 'deprecated',
      buildOrdinal: 9,
      reason: 'thrash-stable-window',
    }))
  })
})

describe('rollback-aware GC recent-K acceptance', () => {
  it('GC recent-K ignores a retracted newer supersession when choosing the retained generation', () => {
    const generationA = publishGeneration(21, 1)
    const generationB = publishGeneration(22, 3)
    const survivingHead = publishGeneration(23, 9)
    appendSupersession(
      generationA.id,
      generationB.id,
      2,
      'generation-a-older-surviving-supersession',
    )
    appendSupersession(
      generationB.id,
      survivingHead.id,
      8,
      'generation-b-newest-surviving-supersession',
    )
    const rolledBack = commitSupersede(
      generationA.id,
      24,
      10,
      'generation-a-rolled-back-newer-supersession',
    )

    expect(lineage(10, Number.MAX_SAFE_INTEGER)).toEqual({
      supersededDepthInWindow: 3,
      latestSupersessionOrdinal: 10,
      chainRecordIds: [
        generationA.id,
        generationB.id,
        survivingHead.id,
        rolledBack.replacementId,
      ].sort(),
      windowOpenOrdinal: 1,
    })

    const controlKnowledgeRoot = join(root, 'control-agent-qa-knowledge')
    cpSync(knowledgeRoot, controlKnowledgeRoot, { recursive: true })
    const controlSummary = runKnowledgeGc({
      knowledgeRoot: controlKnowledgeRoot,
      horizon: { kind: 'none' },
      retainK: 1,
    }, { ...writerAuthority, knowledgeRoot: controlKnowledgeRoot })
    const controlDir = (published: PublishedBundle) =>
      join(controlKnowledgeRoot, relative(knowledgeRoot, published.dir))

    expect(controlSummary).toEqual({
      trimmedRecordIds: [generationB.id],
      skipped: { unknownRef: 0, withinK: 1, userOrigin: 0, horizon: 0 },
    })
    expect(existsSync(controlDir(generationA))).toBe(true)
    expect(existsSync(controlDir(generationB))).toBe(false)

    const report = rollbackJob(rolledBack.claimed.candidateId, 11)
    expect(report).toMatchObject({
      inverseCount: 3,
      restoredVictims: [generationA.id],
      deprecatedBundles: [rolledBack.replacementId],
    })
    expect(retractedTargets(loadById(generationA.id), report.receiptId)).toHaveLength(2)
    expect(lineage(11, Number.MAX_SAFE_INTEGER)).toEqual({
      supersededDepthInWindow: 2,
      latestSupersessionOrdinal: 8,
      chainRecordIds: [generationA.id, generationB.id, survivingHead.id].sort(),
      windowOpenOrdinal: 1,
    })

    const restoredSummary = runKnowledgeGc({
      knowledgeRoot,
      horizon: { kind: 'none' },
      retainK: 1,
    }, writerAuthority)

    expect(restoredSummary).toEqual({
      trimmedRecordIds: [generationA.id],
      skipped: { unknownRef: 0, withinK: 1, userOrigin: 0, horizon: 0 },
    })
    expect(existsSync(generationA.dir)).toBe(false)
    expect(existsSync(generationB.dir)).toBe(true)
    expect(existsSync(survivingHead.dir)).toBe(true)
    expect(existsSync(rolledBack.outcome.bundleDir)).toBe(true)
  })
})
