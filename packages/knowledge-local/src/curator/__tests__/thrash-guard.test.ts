import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asEvidenceToken,
  asRecordId,
  canonicalJson,
  supersessionKey,
  type Anchor,
  type BundleDraft,
  type BundleOutcomeEvent,
  type Delta,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  applyIndexDeltaForBundle,
  appendOutcomeEvent,
  candidateContentAddress,
  commitCurationDelta,
  deriveBundleTrust,
  enumerateBundleDirs,
  loadBundle,
  openIndexReaderConnection,
  type AuthoredDeltaCheckpoint,
  type CommitCurationDependencies,
  type CommitCurationJob,
  type LoadedBundle,
} from '../../index.js'
import {
  finalizeStagedBundle,
  publishBundle,
  stageBundle,
} from '../../bundle-publish.test-helper.js'
import {
  acquireWriterLease,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  withCurrentWriterAuthority,
} from '../../lease/writer-lease.js'
import { candidateAddressFixture } from '../../__tests__/fixtures/curation-candidate-fixture.js'
import {
  THRASH_MAX_SUPERSESSIONS,
  THRASH_WINDOW_BUILDS,
  SCOPE_BURST_THRESHOLD,
  SCOPE_BURST_WINDOW_BUILDS,
  foldFirstSeenAnchorsByScope,
  foldSupersessionLineage,
  scanCanonicalBundles,
} from '../lineage-fold.js'

const scope = { tier: 'product', key: 'storefront' } as const
const anchors: Anchor[] = [
  { t: 'el', role: 'button', name: 'Checkout' },
  { t: 'page', route: '/checkout' },
]

let root: string
let knowledgeRoot: string
let epoch: number
let leaseId: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-thrash-guard-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
  epoch = lease.epoch
  leaseId = lease.leaseId
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function draft(generation: number): BundleDraft {
  return {
    kind: 'fact',
    subtype: 'measurement',
    anchors: [...anchors],
    scope,
    summary: `Checkout lineage generation ${generation}`,
    body: `Canonical checkout lineage generation ${generation}.`,
    distilledEvidenceRef: {
      id: `thrash-generation-${generation}`,
      sha: generation.toString(16).padStart(64, '0'),
    },
    originStage: 'run-curation',
  }
}

function storeConfig(writerLeaseId?: string) {
  return {
    knowledgeRoot,
    productKey: scope.key,
    ...(writerLeaseId === undefined ? {} : { writerLeaseId }),
  }
}

function publishGeneration(generation: number, buildOrdinal: number) {
  const published = publishBundle(storeConfig(), {
    draft: draft(generation),
    discriminant: {
      kind: 'fact',
      subtype: 'measurement',
      metricKey: `thrash-generation-${generation}`,
    },
    originClass: 'agent-verified',
    createdAtOrdinal: buildOrdinal,
    screenStates: [],
    initialEvents: [
      {
        type: 'promoted',
        evidenceToken: asEvidenceToken(`promoted-${generation}`),
        curationJobId: `seed-generation-${generation}`,
        buildOrdinal,
      },
    ],
    relations: [],
    provenance: { mode: 'standalone', sourceDescription: 'thrash fixture' },
    artifacts: [],
  })
  if (published.kind !== 'published') {
    throw new Error(`expected generation publish, got ${published.kind}`)
  }
  return published
}

function appendLifecycleEvent(recordId: RecordId, event: BundleOutcomeEvent): void {
  const appended = appendOutcomeEvent(storeConfig(), recordId, event)
  expect(appended.kind).toBe('appended')
}

function seedTwoSupersessions() {
  const first = publishGeneration(1, 1)
  const second = publishGeneration(2, 2)
  const third = publishGeneration(3, 3)

  for (const [victim, replacement, ordinal] of [
    [first.id, second.id, 2],
    [second.id, third.id, 3],
  ] as const) {
    appendLifecycleEvent(victim, {
      type: 'superseded',
      evidenceToken: asEvidenceToken(`seed-superseded-${ordinal}`),
      curationJobId: `seed-supersession-${ordinal}`,
      buildOrdinal: ordinal,
      byRecordId: replacement,
    })
    appendLifecycleEvent(victim, {
      type: 'window-close',
      evidenceToken: asEvidenceToken(`seed-window-close-${ordinal}`),
      curationJobId: `seed-supersession-${ordinal}`,
      buildOrdinal: ordinal,
      closedAtOrdinal: ordinal,
    })
  }

  return { first, second, third }
}

function job(generation: number, buildOrdinal: number): CommitCurationJob {
  const fields = candidateAddressFixture({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: `run-thrash-${generation}`,
    scope,
    buildOrdinal,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'measurement',
    anchors,
    summarySeed: `Checkout lineage generation ${generation}`,
    bodySeed: `Canonical checkout lineage generation ${generation}.`,
    distilledObservations: [],
    evidenceToken: `thrash-evidence-${generation}-${buildOrdinal}`,
    attributingObservationId: `thrash-observation-${generation}-${buildOrdinal}`,
    artifactInventory: [],
    emittedAt: '2026-07-16T00:00:00.000Z',
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
      model: { id: 'curator-fixture' },
      executionContext: 'local-interactive',
    },
  }
}

function drainState(): CommitCurationDependencies['drainState'] {
  return { supersedesSeenByAnchorKey: new Map() }
}

function deps(
  state = drainState(),
  overrides: Partial<CommitCurationDependencies> = {},
): CommitCurationDependencies {
  return {
    knowledgeRoot,
    epoch,
    profile: { mode: 'drain-to-active' },
    drainState: state,
    ...overrides,
  }
}

function expireCurrentLease(): void {
  const file = join(knowledgeRoot, LEASE_FILE)
  const holder = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(
    file,
    `${JSON.stringify({
      ...holder,
      heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
    })}\n`,
    'utf8',
  )
}

function publishSuccessorUnknown(
  authority: { leaseId: string; epoch: number },
): RecordId {
  const successorDraft: BundleDraft = {
    kind: 'unknown',
    anchors: [{ t: 'flow', name: 'successor-owned-unknown' }],
    scope,
    summary: 'Successor-owned unknown',
    body: canonicalJson({ kind: 'successor-control', epoch: authority.epoch }),
    distilledEvidenceRef: {
      id: 'successor-owned-unknown',
      sha: 'f'.repeat(64),
    },
    originStage: 'run-curation',
  }
  const staged = stageBundle(
    {
      ...storeConfig(authority.leaseId),
      writerEpoch: authority.epoch,
    },
    {
      draft: successorDraft,
      discriminant: { kind: 'unknown', conflictRecordIds: [] },
      originClass: 'agent-verified',
      createdAtOrdinal: 5,
      screenStates: [],
      initialEvents: [
        {
          type: 'confirmed',
          evidenceToken: asEvidenceToken('successor-owned-unknown'),
          curationJobId: 'successor-owned-unknown',
          buildOrdinal: 5,
          origin: 'agent-verified',
        },
      ],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'successor authority control',
      },
      artifacts: [],
    },
  )
  expect(staged.kind).toBe('staged')
  if (staged.kind !== 'staged') throw new Error('expected successor unknown staging')
  const published = withCurrentWriterAuthority(
    knowledgeRoot,
    authority,
    () => finalizeStagedBundle(staged),
    { mutationLockTakeoverMs: 0 },
  )
  expect(published.kind).toBe('published')
  if (published.kind !== 'published') throw new Error('expected successor unknown publication')
  applyIndexDeltaForBundle({
    knowledgeRoot,
    bundleId: published.id,
    product: scope.key,
  })
  return published.id
}

function supersede(
  victimId: RecordId,
  generation: number,
  buildOrdinal: number,
) {
  const claimed = job(generation, buildOrdinal)
  const delta: Extract<Delta, { kind: 'Supersede' }> = {
    kind: 'Supersede',
    origin: 'agent',
    scope,
    citedIds: [victimId],
    victimId,
    newBundle: draft(generation),
    evidenceToken: asEvidenceToken(claimed.payload.evidenceToken),
    authorship: {
      path: 'llm',
      model: { id: 'curator-fixture' },
      executionContext: 'local-interactive',
    },
  }
  const authored = checkpoint(delta)
  return {
    claimed,
    delta,
    authored,
    outcome: commitCurationDelta(deps(), claimed, authored),
  }
}

function confirm(targetId: RecordId, buildOrdinal: number) {
  const claimed = job(100 + buildOrdinal, buildOrdinal)
  const delta: Extract<Delta, { kind: 'Confirm' }> = {
    kind: 'Confirm',
    origin: 'agent',
    scope,
    citedIds: [targetId],
    targetId,
    evidenceToken: asEvidenceToken(claimed.payload.evidenceToken),
    authorship: {
      path: 'llm',
      model: { id: 'curator-fixture' },
      executionContext: 'local-interactive',
    },
  }
  return commitCurationDelta(deps(), claimed, checkpoint(delta))
}

function loadedBundles(): LoadedBundle[] {
  return enumerateBundleDirs(knowledgeRoot).flatMap((entry) => {
    const loaded = loadBundle(entry.dir)
    return loaded.kind === 'loaded' ? [loaded.bundle] : []
  })
}

function unknowns(): LoadedBundle[] {
  return loadedBundles().filter((bundle) => bundle.frontmatter.kind === 'unknown')
}

function loadById(id: RecordId): LoadedBundle {
  const bundle = loadedBundles().find((candidate) => candidate.manifest.id === id)
  if (bundle === undefined) throw new Error(`missing bundle ${id}`)
  return bundle
}

function burstAnchors(index: number, route = '/catalog'): Anchor[] {
  return [
    { t: 'el', role: 'button', name: `Catalog item ${index} action` },
    { t: 'page', route },
  ]
}

function burstDraft(index: number, route = '/catalog'): BundleDraft {
  return {
    kind: 'fact',
    subtype: 'selector',
    anchors: burstAnchors(index, route),
    scope,
    summary: `Catalog item ${index} selector`,
    body: `Catalog item ${index} was first observed on ${route}.`,
    distilledEvidenceRef: {
      id: `burst-item-${index}`,
      sha: (10_000 + index).toString(16).padStart(64, '0'),
    },
    originStage: 'run-curation',
  }
}

function publishFirstSeen(index: number, buildOrdinal: number, route = '/catalog') {
  const itemAnchors = burstAnchors(index, route)
  const published = publishBundle(storeConfig(), {
    draft: burstDraft(index, route),
    discriminant: {
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'button', name: `Catalog item ${index} action` },
    },
    originClass: 'agent-verified',
    createdAtOrdinal: buildOrdinal,
    screenStates: [],
    initialEvents: [
      {
        type: 'confirmed',
        evidenceToken: asEvidenceToken(`first-seen-${route}-${index}`),
        curationJobId: `first-seen-job-${route}-${index}`,
        buildOrdinal,
        origin: 'agent-verified',
      },
    ],
    relations: [],
    provenance: { mode: 'standalone', sourceDescription: 'scope burst fixture' },
    artifacts: [],
  })
  if (published.kind !== 'published') {
    throw new Error(`expected first-seen publish, got ${published.kind}`)
  }
  expect(itemAnchors).toEqual(burstDraft(index, route).anchors)
  return published
}

function seedFirstSeen(count: number, route = '/catalog', indexOffset = 0): RecordId[] {
  return Array.from({ length: count }, (_, offset) =>
    publishFirstSeen(indexOffset + offset + 1, 1 + Math.floor(offset / 2), route).id,
  )
}

function burstJob(index: number, buildOrdinal: number): CommitCurationJob {
  const itemDraft = burstDraft(index)
  const fields = candidateAddressFixture({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: `run-burst-${index}`,
    scope,
    buildOrdinal,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'selector',
    anchors: itemDraft.anchors,
    summarySeed: itemDraft.summary,
    bodySeed: itemDraft.body,
    distilledObservations: [],
    evidenceToken: `burst-evidence-${index}-${buildOrdinal}`,
    attributingObservationId: `burst-observation-${index}-${buildOrdinal}`,
    artifactInventory: [],
    emittedAt: '2026-07-16T00:00:00.000Z',
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

function addFirstSeen(
  index: number,
  buildOrdinal: number,
  state = drainState(),
) {
  const claimed = burstJob(index, buildOrdinal)
  const delta: Extract<Delta, { kind: 'Add' }> = {
    kind: 'Add',
    origin: 'agent',
    scope,
    citedIds: [],
    bundle: burstDraft(index),
    authorship: {
      path: 'llm',
      model: { id: 'curator-fixture' },
      executionContext: 'local-interactive',
    },
  }
  const authored = checkpoint(delta)
  return {
    claimed,
    authored,
    outcome: commitCurationDelta(deps(state), claimed, authored),
  }
}

function tripThrashGuard() {
  const lineage = seedTwoSupersessions()
  const tripping = supersede(lineage.third.id, 4, 4)
  expect(tripping.outcome.kind).toBe('applied')
  if (tripping.outcome.kind !== 'applied') throw new Error('expected applied tripping write')
  return { lineage, tripping, replacementId: tripping.outcome.bundleId }
}

describe('thrash guard lineage and lifecycle', () => {
  it('folds only superseded events across the locked trailing window', () => {
    tripThrashGuard()
    const folded = foldSupersessionLineage(scanCanonicalBundles(knowledgeRoot), {
      windowBuilds: THRASH_WINDOW_BUILDS,
      asOfBuildOrdinal: 4,
    }).get(supersessionKey(anchors))

    expect(THRASH_MAX_SUPERSESSIONS).toBe(3)
    expect(folded).toMatchObject({
      supersededDepthInWindow: 3,
      latestSupersessionOrdinal: 4,
      windowOpenOrdinal: 1,
    })
    expect(folded?.chainRecordIds).toHaveLength(4)
  })

  it('folds a Confirm-only widened lineage to superseded depth zero', () => {
    const widened = publishGeneration(1, 1)
    appendLifecycleEvent(widened.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('widen-confirm-2'),
      curationJobId: 'widen-job-2',
      buildOrdinal: 2,
      origin: 'agent-verified',
    })
    appendLifecycleEvent(widened.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('widen-confirm-3'),
      curationJobId: 'widen-job-3',
      buildOrdinal: 3,
      origin: 'agent-verified',
    })

    expect(
      foldSupersessionLineage(scanCanonicalBundles(knowledgeRoot), {
        windowBuilds: THRASH_WINDOW_BUILDS,
        asOfBuildOrdinal: 3,
      }).get(supersessionKey(anchors)),
    ).toMatchObject({ supersededDepthInWindow: 0, chainRecordIds: [] })
  })

  it('gives a rollback-retracted supersession zero lineage effect', () => {
    const first = publishGeneration(1, 1)
    const second = publishGeneration(2, 2)
    const superseded: BundleOutcomeEvent = {
      type: 'superseded',
      evidenceToken: asEvidenceToken('retracted-supersession'),
      curationJobId: 'retracted-supersession-job',
      buildOrdinal: 2,
      byRecordId: second.id,
    }
    appendLifecycleEvent(first.id, superseded)
    appendLifecycleEvent(first.id, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('rollback-retraction'),
      curationJobId: 'rollback-job',
      buildOrdinal: 3,
      retractsEvidenceToken: superseded.evidenceToken,
      retractsCurationJobId: superseded.curationJobId,
      rollbackReceiptId: 'rollback-receipt-a',
    })

    const folded = foldSupersessionLineage(scanCanonicalBundles(knowledgeRoot), {
      windowBuilds: THRASH_WINDOW_BUILDS,
      asOfBuildOrdinal: 3,
    }).get(supersessionKey(anchors))

    expect(folded).toEqual({
      supersededDepthInWindow: 0,
      chainRecordIds: [],
      windowOpenOrdinal: 1,
    })
  })

  it('keeps an adjacent same-token different-job supersession as the latest lineage', () => {
    const first = publishGeneration(1, 1)
    const second = publishGeneration(2, 2)
    const third = publishGeneration(3, 3)
    const retractedNewest: BundleOutcomeEvent = {
      type: 'superseded',
      evidenceToken: asEvidenceToken('shared-supersession-token'),
      curationJobId: 'retracted-newest-job',
      buildOrdinal: 6,
      byRecordId: second.id,
    }
    appendLifecycleEvent(first.id, retractedNewest)
    appendLifecycleEvent(second.id, {
      type: 'superseded',
      evidenceToken: retractedNewest.evidenceToken,
      curationJobId: 'surviving-adjacent-job',
      buildOrdinal: 4,
      byRecordId: third.id,
    })
    appendLifecycleEvent(first.id, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('rollback-newest-retraction'),
      curationJobId: 'rollback-job',
      buildOrdinal: 7,
      retractsEvidenceToken: retractedNewest.evidenceToken,
      retractsCurationJobId: retractedNewest.curationJobId,
      rollbackReceiptId: 'rollback-receipt-a',
    })

    expect(foldSupersessionLineage(scanCanonicalBundles(knowledgeRoot), {
      windowBuilds: 8,
      asOfBuildOrdinal: 8,
    }).get(supersessionKey(anchors))).toEqual({
      supersededDepthInWindow: 1,
      latestSupersessionOrdinal: 4,
      chainRecordIds: [second.id, third.id].sort(),
      windowOpenOrdinal: 1,
    })
  })

  it('commits the third supersession and one self-contained anchor unknown', () => {
    const { lineage, tripping, replacementId } = tripThrashGuard()
    const committedUnknowns = unknowns()
    expect(committedUnknowns).toHaveLength(1)

    const unknown = committedUnknowns[0]!
    const triggerKey = supersessionKey(anchors)
    const evidenceRecordIds = [
      lineage.first.id,
      lineage.second.id,
      lineage.third.id,
      replacementId,
    ].sort()
    expect(unknown.frontmatter.anchors[0]?.normalized).toEqual({
      t: 'flow',
      name: `thrash:${triggerKey}:window:1`,
    })
    expect(JSON.parse(unknown.body)).toEqual({
      kind: 'thrash',
      triggerKey,
      windowOpenOrdinal: 1,
      windowCloseOrdinal: 4,
      evidenceRecordIds,
    })
    expect(
      unknown.relations.relations
        .filter((relation) => relation.type === 'conflicts-with')
        .map((relation) => relation.targetId)
        .sort(),
    ).toEqual(evidenceRecordIds)
    expect(unknown.provenance).toMatchObject({
      mode: 'run-linked',
      authorship: { path: 'deterministic-fallback' },
    })
    expect(deriveBundleTrust(unknown).status).toBe('candidate')

    const replay = commitCurationDelta(deps(), tripping.claimed, tripping.authored)
    expect(['noop', 'converted-confirm']).toContain(replay.kind)
    expect(unknowns()).toHaveLength(1)
  })

  it('refuses the old writer before its governed rename and keeps only the successor unknown', () => {
    const lineage = seedTwoSupersessions()
    let intentBoundaryCount = 0
    let successorUnknownId: RecordId | undefined
    const hooks = {
      mutationLockTakeoverMs: 0,
      beforeCommitAuthorityEntry: () => {
        intentBoundaryCount += 1
        expireCurrentLease()
        const successor = acquireWriterLease(knowledgeRoot, {
          mutationLockTakeoverMs: 0,
        })
        expect(successor.kind).toBe('acquired')
        if (successor.kind !== 'acquired') throw new Error('expected successor takeover')
        successorUnknownId = publishSuccessorUnknown({
          leaseId: successor.leaseId,
          epoch: successor.epoch,
        })
      },
    } as NonNullable<CommitCurationDependencies['hooks']> & {
      mutationLockTakeoverMs: number
    }
    const claimed = job(4, 4)
    const delta: Extract<Delta, { kind: 'Supersede' }> = {
      kind: 'Supersede',
      origin: 'agent',
      scope,
      citedIds: [lineage.third.id],
      victimId: lineage.third.id,
      newBundle: draft(4),
      evidenceToken: asEvidenceToken(claimed.payload.evidenceToken),
      authorship: {
        path: 'llm',
        model: { id: 'curator-fixture' },
        executionContext: 'local-interactive',
      },
    }

    const outcome = commitCurationDelta(
      deps(drainState(), { hooks }),
      claimed,
      checkpoint(delta),
    )

    expect(intentBoundaryCount).toBe(1)
    expect(outcome).toEqual({ kind: 'abandoned-stale-epoch', observedEpoch: 2 })
    expect(successorUnknownId).toBeDefined()
    expect(unknowns().map((bundle) => bundle.manifest.id)).toEqual([successorUnknownId])
    const reader = openIndexReaderConnection(knowledgeRoot)
    try {
      expect(
        reader.db
          .prepare("SELECT bundle_id FROM records WHERE kind = 'unknown' ORDER BY bundle_id")
          .all(),
      ).toEqual([{ bundle_id: successorUnknownId }])
    } finally {
      reader.db.close()
    }
  })

  it('continues Confirm and Supersede writes while the anchor is memory-off', () => {
    const { replacementId } = tripThrashGuard()

    expect(confirm(replacementId, 5).kind).toBe('applied')
    const next = supersede(replacementId, 5, 6)
    expect(next.outcome.kind).toBe('applied')
    expect(unknowns()).toHaveLength(1)
    expect(deriveBundleTrust(unknowns()[0]!).status).toBe('candidate')
  })

  it('resolves the unknown only after a five-build stable Confirm window', () => {
    const { replacementId } = tripThrashGuard()
    const unknownId = asRecordId(unknowns()[0]!.manifest.id)

    expect(confirm(replacementId, 6).kind).toBe('applied')
    expect(deriveBundleTrust(loadById(unknownId)).status).toBe('candidate')

    expect(confirm(replacementId, 9).kind).toBe('applied')
    const resolved = loadById(unknownId)
    expect(deriveBundleTrust(resolved).status).toBe('deprecated')
    expect(resolved.events).toContainEqual(expect.objectContaining({
      type: 'deprecated',
      buildOrdinal: 9,
      reason: 'thrash-stable-window',
    }))
  })

  it('does not let a retracted newest supersession delay stable-window closure', () => {
    const { replacementId } = tripThrashGuard()
    const unknownId = asRecordId(unknowns()[0]!.manifest.id)
    const retractedNewest: BundleOutcomeEvent = {
      type: 'superseded',
      evidenceToken: asEvidenceToken('rolled-back-newest-supersession'),
      curationJobId: 'rolled-back-newest-job',
      buildOrdinal: 7,
      byRecordId: asRecordId('rolled-back-replacement'),
    }
    appendLifecycleEvent(replacementId, retractedNewest)
    appendLifecycleEvent(replacementId, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('rolled-back-newest-retraction'),
      curationJobId: 'rollback-job',
      buildOrdinal: 8,
      retractsEvidenceToken: retractedNewest.evidenceToken,
      retractsCurationJobId: retractedNewest.curationJobId,
      rollbackReceiptId: 'rollback-receipt-a',
    })

    expect(confirm(replacementId, 9).kind).toBe('applied')
    expect(deriveBundleTrust(loadById(unknownId)).status).toBe('deprecated')
  })

  it('keeps the expected trigger payload canonical and value-free', () => {
    const triggerKey = supersessionKey(anchors)
    expect(canonicalJson({ kind: 'thrash', triggerKey })).not.toContain('Checkout lineage')
  })
})

describe('scope-windowed first-seen burst guard', () => {
  it('folds nine first-seen page anchors above the provisional threshold and four below it', () => {
    seedFirstSeen(9)
    seedFirstSeen(4, '/small-catalog', 100)

    const folded = foldFirstSeenAnchorsByScope(scanCanonicalBundles(knowledgeRoot), {
      windowBuilds: SCOPE_BURST_WINDOW_BUILDS,
      asOfBuildOrdinal: 5,
    })
    expect(SCOPE_BURST_THRESHOLD).toBe(8)
    expect(folded.get('page:/catalog')).toMatchObject({
      firstSeenCount: 9,
      windowOpenOrdinal: 1,
    })
    expect(folded.get('page:/small-catalog')).toMatchObject({
      firstSeenCount: 4,
      windowOpenOrdinal: 1,
    })
  })

  it('mints one scope/window unknown while the ninth Add stays a candidate', () => {
    const seededRecordIds = seedFirstSeen(8)
    const crossing = addFirstSeen(9, 5)
    expect(crossing.outcome.kind).toBe('applied')
    if (crossing.outcome.kind !== 'applied') throw new Error('expected applied burst Add')

    const committedUnknowns = unknowns()
    expect(committedUnknowns).toHaveLength(1)
    const unknown = committedUnknowns[0]!
    const evidenceRecordIds = [...seededRecordIds, crossing.outcome.bundleId].sort()
    expect(unknown.frontmatter.anchors[0]?.normalized).toEqual({
      t: 'flow',
      name: 'scope-burst:page:/catalog:window:1',
    })
    expect(JSON.parse(unknown.body)).toEqual({
      kind: 'scope-burst',
      scopeKey: 'page:/catalog',
      windowOpenOrdinal: 1,
      windowCloseOrdinal: 5,
      firstSeenCount: 9,
      evidenceRecordIds,
    })
    expect(deriveBundleTrust(loadById(crossing.outcome.bundleId)).status).toBe('candidate')
  })

  it('runs the O(store) fold once per drain and mints no duplicate in the window or replay', () => {
    seedFirstSeen(8)
    const onCanonicalBundleScan = vi.fn()
    const sharedDrain = {
      supersedesSeenByAnchorKey: new Map<string, number>(),
      onCanonicalBundleScan,
    }
    const crossing = addFirstSeen(9, 5, sharedDrain)
    expect(crossing.outcome.kind).toBe('applied')
    expect(addFirstSeen(10, 5, sharedDrain).outcome.kind).toBe('applied')
    expect(onCanonicalBundleScan).toHaveBeenCalledTimes(1)
    expect(unknowns()).toHaveLength(1)

    expect(commitCurationDelta(deps(), crossing.claimed, crossing.authored).kind).toBe('noop')
    expect(unknowns()).toHaveLength(1)
  })
})
