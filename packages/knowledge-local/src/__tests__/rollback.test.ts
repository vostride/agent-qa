import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asEvidenceToken,
  canonicalJson,
  DEFAULT_EMBEDDING_PROFILE,
  sha256hex,
  supersessionKey,
  type Anchor,
  type BundleDiscriminant,
  type BundleDraft,
  type BundleOutcomeEvent,
  type BundleRelation,
  type OriginClass,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import type {
  BundleStoreConfig,
  PublishBundleOutcome,
  WriterLeaseAuthority,
} from '../index.js'
import {
  EMBED_STATUS_PENDING,
  EMBED_STATUS_PRESENT,
  EMBED_STATUS_SCRUBBED,
  EMBED_STATUS_SUPPRESSED,
  projectBundleIndexRow,
} from '../index-rebuild.js'
import { LEASE_FILE, LEASE_HEARTBEAT_TTL_MS } from '../lease/writer-lease.js'
import { makeBundleDraftFixture } from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

interface RollbackCounterEvent {
  recordId: string
  evidenceToken: string
  curationJobId: string
  type: string
}

interface RollbackReport {
  receiptId: string
  inverseCount: number
  restoredVictims: string[]
  deprecatedBundles: string[]
  retractedPromotions: string[]
  affected: {
    operationId?: string
    mintedBundleIds: string[]
    counterEvents: RollbackCounterEvent[]
    plannedEffects?: unknown[]
    projectionTargets?: unknown[]
    products?: string[]
  }
}

interface RollbackApi {
  resolveRollbackAffectedSet(input: Parameters<RollbackApi['rollbackCampaign']>[0]): RollbackReport['affected']
  rollbackCurationJob(input: {
    knowledgeRoot: string
    curationJobId: string
    resolvedAtOrdinal: number
    writerAuthority?: WriterLeaseAuthority
    hooks?: {
      afterResolution?: () => void
      afterMutation?: (kind: 'append' | 'projection', recordId: string) => void
    }
  }): RollbackReport
  rollbackCampaign(input: {
    knowledgeRoot: string
    resolvedAtOrdinal: number
    fromOrdinal?: number
    toOrdinal?: number
    anchorClusterKey?: string
    originClass?: OriginClass
    writerAuthority?: WriterLeaseAuthority
    hooks?: {
      afterResolution?: () => void
      afterMutation?: (kind: 'append' | 'projection', recordId: string) => void
    }
  }): RollbackReport
  rollbackReceiptId(
    kind: 'job' | 'campaign',
    keys: Readonly<Record<string, unknown>>,
    effectKeys?: readonly string[],
  ): string
}

function rollbackApi(): RollbackApi {
  const candidate = knowledgeLocal as unknown as Partial<RollbackApi>
  if (
    typeof candidate.rollbackCurationJob !== 'function'
    || typeof candidate.rollbackCampaign !== 'function'
    || typeof candidate.resolveRollbackAffectedSet !== 'function'
    || typeof candidate.rollbackReceiptId !== 'function'
  ) {
    throw new Error('rollback public API is not implemented')
  }
  return candidate as RollbackApi
}

const PRODUCT = 'rollback-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const

describe('provenance-keyed rollback resolution', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-rollback-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    mkdirSync(knowledgeRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey = PRODUCT): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function acquireWriterAuthority(): WriterLeaseAuthority {
    const acquired = knowledgeLocal.acquireWriterLease(knowledgeRoot)
    expect(acquired.kind).toBe('acquired')
    if (acquired.kind !== 'acquired') throw new Error('expected acquired writer authority')
    return { knowledgeRoot, leaseId: acquired.leaseId, epoch: acquired.epoch }
  }

  function reclaimWriterAuthority(authority: WriterLeaseAuthority): WriterLeaseAuthority {
    const leasePath = join(knowledgeRoot, LEASE_FILE)
    const holder = JSON.parse(readFileSync(leasePath, 'utf8')) as Record<string, unknown>
    writeFileSync(
      leasePath,
      `${JSON.stringify({
        ...holder,
        heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS,
      })}\n`,
      'utf8',
    )
    const reclaimed = knowledgeLocal.acquireWriterLease(knowledgeRoot)
    expect(reclaimed.kind).toBe('acquired')
    if (reclaimed.kind !== 'acquired') throw new Error('expected reclaimed writer authority')
    expect(reclaimed.epoch).toBe(authority.epoch + 1)
    return { knowledgeRoot, leaseId: reclaimed.leaseId, epoch: reclaimed.epoch }
  }

  function publishForJob(input: {
    identity: string
    curationJobId: string
    sourceBuildOrdinal: number
    anchors?: readonly Anchor[]
    originClass?: OriginClass
    kind?: BundleDraft['kind']
    initialEvents?: readonly BundleOutcomeEvent[]
    relations?: readonly BundleRelation[]
    discriminant?: BundleDiscriminant
    product?: string
  }): PublishedBundle {
    const kind = input.kind ?? 'fact'
    const anchors = input.anchors ?? [
      { t: 'el', role: 'button', name: `${input.identity} control` },
      { t: 'page', route: `/rollback/${input.identity}` },
    ]
    const outcome = publishBundle(config(input.product), {
      draft: makeBundleDraftFixture({
        kind,
        anchors: [...anchors],
        scope: SCOPE,
        summary: `${input.identity} rollback fixture`,
        body: `Canonical provenance for ${input.identity}.`,
      }),
      discriminant: input.discriminant ?? (
        kind === 'unknown'
          ? { kind, conflictRecordIds: [] }
          : {
              kind: 'fact',
              subtype: 'selector',
              elementRef: { role: 'button', name: input.identity },
            }
      ),
      originClass: input.originClass ?? 'agent-verified',
      createdAtOrdinal: input.sourceBuildOrdinal,
      screenStates: [],
      initialEvents: input.initialEvents ?? [{
        type: 'confirmed',
        evidenceToken: asEvidenceToken(`${input.curationJobId}-mint-confirmed`),
        curationJobId: input.curationJobId,
        buildOrdinal: input.sourceBuildOrdinal,
        origin: input.originClass ?? 'agent-verified',
      }],
      relations: input.relations ?? [],
      provenance: {
        mode: 'run-linked',
        runId: `run-${input.curationJobId}`,
        testId: `test-${input.curationJobId}`,
        stepIndex: 0,
        curationJobId: input.curationJobId,
        sourceBuildOrdinal: input.sourceBuildOrdinal,
      },
      artifacts: [],
    })
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${input.identity} publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function activeEvents(jobId: string, ordinal: number): BundleOutcomeEvent[] {
    return [
      {
        type: 'confirmed',
        evidenceToken: asEvidenceToken(`${jobId}-confirmed`),
        curationJobId: jobId,
        buildOrdinal: ordinal,
        origin: 'agent-verified',
      },
      {
        type: 'promoted',
        evidenceToken: asEvidenceToken(`${jobId}-promoted`),
        curationJobId: jobId,
        buildOrdinal: ordinal,
      },
    ]
  }

  function loaded(published: PublishedBundle) {
    const outcome = knowledgeLocal.loadBundle(published.dir)
    if (outcome.kind !== 'loaded') {
      throw new Error(`expected loaded bundle ${published.id}, got ${outcome.kind}`)
    }
    return outcome.bundle
  }

  function hasFtsRow(bundleId: string): boolean {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      return reader.db.prepare(`
        SELECT 1
        FROM fts_records AS fts
        JOIN records AS record ON record.record_rowid = fts.rowid
        WHERE record.bundle_id = ?
      `).get(bundleId) !== undefined
    } finally {
      reader.db.close()
    }
  }

  function writeLegacySuppressedRow(bundleId: string): void {
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      const record = writer.db
        .prepare('SELECT record_rowid FROM records WHERE bundle_id = ?')
        .get(bundleId)
      if (record === undefined) throw new Error(`records row for ${bundleId} is missing`)
      writer.db
        .prepare('UPDATE records SET embed_status = ?, embedding = NULL WHERE record_rowid = ?')
        .run(EMBED_STATUS_SUPPRESSED, record.record_rowid)
      if (writer.vec === 'vec0') {
        writer.db
          .prepare(`
            DELETE FROM ${knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)}
            WHERE record_rowid = ?
          `)
          .run(BigInt(Number(record.record_rowid)))
      }
    } finally {
      writer.close()
    }
  }

  function embedState(bundleId: string): {
    embedStatus: string
    embeddingPresent: boolean
    vecRows: number
  } {
    const reader = knowledgeLocal.openIndexReaderConnection(knowledgeRoot)
    try {
      const record = reader.db
        .prepare('SELECT record_rowid, embed_status, embedding FROM records WHERE bundle_id = ?')
        .get(bundleId)
      if (record === undefined) throw new Error(`records row for ${bundleId} is missing`)
      const vecRow = reader.db
        .prepare(`
          SELECT 1
          FROM ${knowledgeLocal.vecTableName(DEFAULT_EMBEDDING_PROFILE)}
          WHERE record_rowid = ?
        `)
        .get(BigInt(Number(record.record_rowid)))
      return {
        embedStatus: String(record.embed_status),
        embeddingPresent: record.embedding !== null && record.embedding !== undefined,
        vecRows: vecRow === undefined ? 0 : 1,
      }
    } finally {
      reader.db.close()
    }
  }

  async function retrieveIds(anchors: readonly Anchor[]): Promise<string[]> {
    const reader = knowledgeLocal.openKnowledgeReader(knowledgeRoot)
    try {
      const result = await knowledgeLocal.retrieve(
        reader,
        { intent: '', anchors },
        { n: 12, product: PRODUCT, asOfBuild: 30 },
      )
      return result.map(({ id }) => id)
    } finally {
      reader.close()
    }
  }

  it('resolves exactly one job\'s minted bundles and counter events on other bundles', () => {
    const jobA = publishForJob({
      identity: 'job-a-bundle',
      curationJobId: 'job-a',
      sourceBuildOrdinal: 3,
    })
    const jobB = publishForJob({
      identity: 'job-b-bundle',
      curationJobId: 'job-b',
      sourceBuildOrdinal: 4,
    })
    publishForJob({
      identity: 'job-c-bundle',
      curationJobId: 'job-c',
      sourceBuildOrdinal: 5,
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), jobA.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('job-b-confirmed-existing'),
      curationJobId: 'job-b',
      buildOrdinal: 4,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-b',
      resolvedAtOrdinal: 20,
    })

    expect(report.affected.mintedBundleIds).toEqual([jobB.id])
    expect(report.affected.counterEvents).toEqual([{
      recordId: jobA.id,
      evidenceToken: 'job-b-confirmed-existing',
      curationJobId: 'job-b',
      type: 'confirmed',
    }])
  })

  it('resolves campaign axes independently and composes predicates with AND semantics', () => {
    const alphaAnchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'alpha control' },
      { t: 'page', route: '/rollback/alpha' },
    ]
    const betaAnchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'beta control' },
      { t: 'page', route: '/rollback/beta' },
    ]
    const lowAlpha = publishForJob({
      identity: 'low-alpha',
      curationJobId: 'campaign-low-alpha',
      sourceBuildOrdinal: 2,
      anchors: alphaAnchors,
    })
    const highAlphaVerified = publishForJob({
      identity: 'high-alpha-verified',
      curationJobId: 'campaign-high-alpha-verified',
      sourceBuildOrdinal: 8,
      anchors: alphaAnchors,
    })
    const highBetaObserved = publishForJob({
      identity: 'high-beta-observed',
      curationJobId: 'campaign-high-beta-observed',
      sourceBuildOrdinal: 9,
      anchors: betaAnchors,
      originClass: 'agent-observed',
    })
    const highAlphaObserved = publishForJob({
      identity: 'high-alpha-observed',
      curationJobId: 'campaign-high-alpha-observed',
      sourceBuildOrdinal: 10,
      anchors: alphaAnchors,
      originClass: 'agent-observed',
    })

    const base = { knowledgeRoot, resolvedAtOrdinal: 20 }
    expect(rollbackApi().resolveRollbackAffectedSet({ ...base, fromOrdinal: 8 })
      .mintedBundleIds).toEqual([
      highAlphaVerified.id,
      highBetaObserved.id,
      highAlphaObserved.id,
    ].sort())
    expect(rollbackApi().resolveRollbackAffectedSet({
      ...base,
      anchorClusterKey: supersessionKey(alphaAnchors),
    }).mintedBundleIds).toEqual([
      lowAlpha.id,
      highAlphaVerified.id,
      highAlphaObserved.id,
    ].sort())
    expect(rollbackApi().resolveRollbackAffectedSet({ ...base, originClass: 'agent-observed' })
      .mintedBundleIds).toEqual([
      highBetaObserved.id,
      highAlphaObserved.id,
    ].sort())
    expect(rollbackApi().resolveRollbackAffectedSet({
      ...base,
      fromOrdinal: 8,
      toOrdinal: 10,
      anchorClusterKey: supersessionKey(alphaAnchors),
      originClass: 'agent-observed',
    }).mintedBundleIds).toEqual([highAlphaObserved.id])
  })

  it('derives the receipt from canonical selector and product-qualified effect bytes', () => {
    const keys = {
      originClass: 'agent-observed',
      anchorClusterKey: 'cluster-a',
      fromOrdinal: 8,
    }
    const effectKeys = ['product-b/record-2/event-z', 'product-a/record-1/event-a']
    const expected = `rollback:${sha256hex(canonicalJson({
      kind: 'campaign',
      keys,
      effectKeys: [...effectKeys].sort(),
    }))}`

    const first = rollbackApi().rollbackReceiptId('campaign', keys, effectKeys)
    const second = rollbackApi().rollbackReceiptId(
      'campaign',
      { fromOrdinal: 8, anchorClusterKey: 'cluster-a', originClass: 'agent-observed' },
      [...effectKeys].reverse(),
    )
    expect(first).toBe(expected)
    expect(second).toBe(expected)
    expect(first).toMatch(/^rollback:[0-9a-f]{64}$/)
  })

  it('inverts a minted Add through a system-origin deprecation and scrubs recall rows', async () => {
    const added = publishForJob({
      identity: 'poisoned-add',
      curationJobId: 'job-poisoned-add',
      sourceBuildOrdinal: 7,
      initialEvents: activeEvents('job-poisoned-add', 7),
    })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    expect(hasFtsRow(added.id)).toBe(true)

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-poisoned-add',
      resolvedAtOrdinal: 20,
    })
    const bundle = loaded(added)
    const trust = knowledgeLocal.deriveBundleTrust(bundle)
    const inverse = bundle.events.find(
      (event) => event.type === 'deprecated' && event.curationJobId === report.receiptId,
    )

    expect(report.inverseCount).toBe(1)
    expect(report.deprecatedBundles).toEqual([added.id])
    expect(report.restoredVictims).toEqual([])
    expect(trust.status).toBe('deprecated')
    expect(inverse).toMatchObject({
      type: 'deprecated',
      reason: `rollback:${report.receiptId}`,
      buildOrdinal: 20,
    })
    // An active record would be downgraded by the disposition floor under agent origin.
    // Reaching a deprecated fold without minting another bundle proves maintenance origin system.
    expect(knowledgeLocal.enumerateBundleDirs(knowledgeRoot)).toHaveLength(1)
    expect(hasFtsRow(added.id)).toBe(false)
  })

  it('mutates only the product-qualified copy when record ids collide across products', () => {
    const targeted = publishForJob({
      identity: 'cross-product-shared-id',
      curationJobId: 'job-cross-product-target',
      sourceBuildOrdinal: 7,
      initialEvents: activeEvents('job-cross-product-target', 7),
    })
    const untouched = publishForJob({
      identity: 'cross-product-shared-id',
      curationJobId: 'job-cross-product-other',
      sourceBuildOrdinal: 8,
      initialEvents: activeEvents('job-cross-product-other', 8),
      product: 'rollback-shadow-product',
    })
    expect(untouched.id).toBe(targeted.id)

    rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-cross-product-target',
      resolvedAtOrdinal: 20,
    })

    expect(knowledgeLocal.deriveBundleTrust(loaded(targeted)).status).toBe('deprecated')
    expect(knowledgeLocal.deriveBundleTrust(loaded(untouched)).status).toBe('active')
    expect(loaded(untouched).events.some((event) =>
      event.curationJobId.startsWith('rollback:'),
    )).toBe(false)
  })

  it('retracts a Confirm on a pre-existing bundle so its counter drops on re-fold', () => {
    const target = publishForJob({
      identity: 'confirmed-target',
      curationJobId: 'job-base-confirmed',
      sourceBuildOrdinal: 4,
      initialEvents: activeEvents('job-base-confirmed', 4),
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('job-confirm-poison-token'),
      curationJobId: 'job-confirm-poison',
      buildOrdinal: 8,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).counters.confirmed).toBe(2)

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-confirm-poison',
      resolvedAtOrdinal: 20,
    })
    const bundle = loaded(target)

    expect(report.inverseCount).toBe(1)
    expect(knowledgeLocal.deriveBundleTrust(bundle).counters.confirmed).toBe(1)
    expect(bundle.events).toContainEqual(expect.objectContaining({
      type: 'retracted',
      curationJobId: report.receiptId,
      retractsEvidenceToken: 'job-confirm-poison-token',
      retractsCurationJobId: 'job-confirm-poison',
      rollbackReceiptId: report.receiptId,
    }))
  })

  it('retracts both supersession effects, reopens the victim, restores recall, and replays byte-identically', async () => {
    const anchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'restore checkout' },
      { t: 'page', route: '/rollback/restore-checkout' },
      { t: 'platform', platform: 'web' },
    ]
    const victim = publishForJob({
      identity: 'supersession-victim',
      curationJobId: 'job-supersession-victim',
      sourceBuildOrdinal: 3,
      anchors,
      initialEvents: activeEvents('job-supersession-victim', 3),
    })
    const replacement = publishForJob({
      identity: 'poisoned-replacement',
      curationJobId: 'job-poisoned-supersede',
      sourceBuildOrdinal: 9,
      anchors,
      initialEvents: activeEvents('job-poisoned-supersede', 9),
      relations: [{
        type: 'supersedes',
        targetId: victim.id,
        addedAtOrdinal: 9,
        curationJobId: 'job-poisoned-supersede',
      }],
    })
    // The victim starts densely served: present canonical bytes and an active vec row.
    await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_PRESENT,
      embeddingPresent: true,
      vecRows: 1,
    })

    const supersedeToken = asEvidenceToken('poisoned-supersede-token')
    const closeToken = asEvidenceToken(sha256hex(canonicalJson({
      token: supersedeToken,
      event: 'window-close',
    })))
    expect(knowledgeLocal.appendOutcomeEvent(config(), victim.id, {
      type: 'superseded',
      evidenceToken: supersedeToken,
      curationJobId: 'job-poisoned-supersede',
      buildOrdinal: 9,
      byRecordId: replacement.id,
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.appendOutcomeEvent(config(), victim.id, {
      type: 'window-close',
      evidenceToken: closeToken,
      curationJobId: 'job-poisoned-supersede',
      buildOrdinal: 9,
      closedAtOrdinal: 9,
    })).toEqual({ kind: 'appended' })
    projectBundleIndexRow({ knowledgeRoot, bundleId: victim.id })
    expect(hasFtsRow(victim.id)).toBe(false)
    expect(hasFtsRow(replacement.id)).toBe(true)
    // Structural death takes the reversible scrubbed value and empties dense recall.
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_SCRUBBED,
      embeddingPresent: false,
      vecRows: 0,
    })

    const rollbackInput = {
      knowledgeRoot,
      curationJobId: 'job-poisoned-supersede',
      resolvedAtOrdinal: 20,
    }
    const first = rollbackApi().rollbackCurationJob(rollbackInput)
    const restored = loaded(victim)
    const replacementAfter = loaded(replacement)
    const retractedTargets = restored.events.flatMap((event) =>
      event.type === 'retracted'
        ? [`${event.retractsEvidenceToken}:${event.retractsCurationJobId}`]
        : [],
    )

    expect(first.inverseCount).toBe(3)
    expect(first.restoredVictims).toEqual([victim.id])
    expect(first.deprecatedBundles).toEqual([replacement.id])
    expect(knowledgeLocal.deriveBundleTrust(restored)).toMatchObject({
      status: 'active',
      validity: { openedAtOrdinal: 3 },
    })
    expect(knowledgeLocal.deriveBundleTrust(restored).validity.closedAtOrdinal).toBeUndefined()
    expect(knowledgeLocal.deriveBundleTrust(replacementAfter).status).toBe('deprecated')
    expect(retractedTargets).toEqual(expect.arrayContaining([
      `${supersedeToken}:job-poisoned-supersede`,
      `${closeToken}:job-poisoned-supersede`,
    ]))
    expect(hasFtsRow(victim.id)).toBe(true)
    expect(hasFtsRow(replacement.id)).toBe(false)
    // The restore re-projection reaches the revival reset on the default projection path:
    // the structurally-scrubbed victim re-enters the ordinary backfill pipeline as pending.
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_PENDING,
      embeddingPresent: false,
      vecRows: 0,
    })

    const beforeReplay = {
      victim: readFileSync(join(victim.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
      replacement: readFileSync(
        join(replacement.dir, 'evidence', 'outcomes.jsonl'),
        'utf8',
      ),
    }
    const second = rollbackApi().rollbackCurationJob(rollbackInput)
    expect(second.inverseCount).toBe(0)
    expect({
      victim: readFileSync(join(victim.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
      replacement: readFileSync(
        join(replacement.dir, 'evidence', 'outcomes.jsonl'),
        'utf8',
      ),
    }).toEqual(beforeReplay)
    // Duplicate replay re-projects the touched bundles, but the reset is a no-op outside
    // the structural state: pending stays pending.
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_PENDING,
      embeddingPresent: false,
      vecRows: 0,
    })

    // Ordinary backfill — no bespoke invalidation — restores dense retrieval for the victim.
    await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_PRESENT,
      embeddingPresent: true,
      vecRows: 1,
    })
  })

  it('never revives a suppressed record through supersede, restore, and backfill', async () => {
    const anchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'redacted checkout' },
      { t: 'page', route: '/rollback/redacted-checkout' },
      { t: 'platform', platform: 'web' },
    ]
    const victim = publishForJob({
      identity: 'redacted-victim',
      curationJobId: 'job-redacted-victim',
      sourceBuildOrdinal: 3,
      anchors,
      initialEvents: activeEvents('job-redacted-victim', 3),
    })
    const replacement = publishForJob({
      identity: 'redacted-replacement',
      curationJobId: 'job-redacted-supersede',
      sourceBuildOrdinal: 9,
      anchors,
      initialEvents: activeEvents('job-redacted-supersede', 9),
      relations: [{
        type: 'supersedes',
        targetId: victim.id,
        addedAtOrdinal: 9,
        curationJobId: 'job-redacted-supersede',
      }],
    })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })

    // No writer emits the terminal value; only a legacy row can hold it.
    writeLegacySuppressedRow(victim.id)
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_SUPPRESSED,
      embeddingPresent: false,
      vecRows: 0,
    })

    expect(knowledgeLocal.appendOutcomeEvent(config(), victim.id, {
      type: 'superseded',
      evidenceToken: asEvidenceToken('redacted-supersede-token'),
      curationJobId: 'job-redacted-supersede',
      buildOrdinal: 9,
      byRecordId: replacement.id,
    })).toEqual({ kind: 'appended' })
    projectBundleIndexRow({ knowledgeRoot, bundleId: victim.id })
    // Both suppressions touched one row and terminal wins through structural death.
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_SUPPRESSED,
      embeddingPresent: false,
      vecRows: 0,
    })

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-redacted-supersede',
      resolvedAtOrdinal: 20,
    })
    expect(report.restoredVictims).toEqual([victim.id])
    expect(knowledgeLocal.deriveBundleTrust(loaded(victim)).status).toBe('active')
    // The revival reset must not match the terminal value on restore.
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_SUPPRESSED,
      embeddingPresent: false,
      vecRows: 0,
    })

    // No backfill sequence converts the terminal state: no vec row ever appears.
    await knowledgeLocal.rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })
    expect(embedState(victim.id)).toEqual({
      embedStatus: EMBED_STATUS_SUPPRESSED,
      embeddingPresent: false,
      vecRows: 0,
    })
  })

  it('deprecates a rolled-back thrash unknown so memory-off suppression lifts', async () => {
    const factAnchors: Anchor[] = [
      { t: 'el', role: 'button', name: 'resume checkout' },
      { t: 'page', route: '/rollback/resume-checkout' },
      { t: 'platform', platform: 'web' },
    ]
    const fact = publishForJob({
      identity: 'suppressed-live-fact',
      curationJobId: 'job-live-fact',
      sourceBuildOrdinal: 10,
      anchors: factAnchors,
      initialEvents: activeEvents('job-live-fact', 10),
    })
    const marker = `thrash:${supersessionKey(factAnchors)}:window:10`
    const unknown = publishForJob({
      identity: 'poisoned-thrash-unknown',
      curationJobId: 'job-thrash-unknown',
      sourceBuildOrdinal: 15,
      kind: 'unknown',
      anchors: [{ t: 'flow', name: marker }],
      discriminant: { kind: 'unknown', conflictRecordIds: [fact.id] },
      relations: [{
        type: 'conflicts-with',
        targetId: fact.id,
        addedAtOrdinal: 15,
        curationJobId: 'job-thrash-unknown',
      }],
    })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    expect(await retrieveIds([factAnchors[0]!])).toEqual([unknown.id])

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-thrash-unknown',
      resolvedAtOrdinal: 20,
    })

    expect(report.deprecatedBundles).toEqual([unknown.id])
    expect(knowledgeLocal.deriveBundleTrust(loaded(unknown)).status).toBe('deprecated')
    expect(await retrieveIds([factAnchors[0]!])).toEqual([fact.id])
  })

  it('retracts a conversion job\'s confirmed and promoted events so the fold returns candidate after rollback', () => {
    const equalOrdinal = publishForJob({
      identity: 'conversion-equal',
      curationJobId: 'job-equal-mint',
      sourceBuildOrdinal: 4,
      initialEvents: [],
    })
    const distinctOrdinal = publishForJob({
      identity: 'conversion-distinct',
      curationJobId: 'job-distinct-mint',
      sourceBuildOrdinal: 4,
      initialEvents: [],
    })
    const conversions = [
      { published: equalOrdinal, prefix: 'equal', confirmedOrdinal: 9, promotedOrdinal: 9 },
      { published: distinctOrdinal, prefix: 'distinct', confirmedOrdinal: 9, promotedOrdinal: 12 },
    ] as const
    for (const conversion of conversions) {
      expect(knowledgeLocal.appendOutcomeEvent(config(), conversion.published.id, {
        type: 'confirmed',
        evidenceToken: asEvidenceToken(`${conversion.prefix}-conversion-confirmed`),
        curationJobId: 'job-conversion',
        buildOrdinal: conversion.confirmedOrdinal,
        origin: 'agent-verified',
      })).toEqual({ kind: 'appended' })
      expect(knowledgeLocal.appendOutcomeEvent(config(), conversion.published.id, {
        type: 'promoted',
        evidenceToken: asEvidenceToken(`${conversion.prefix}-conversion-promoted`),
        curationJobId: 'job-conversion',
        buildOrdinal: conversion.promotedOrdinal,
      })).toEqual({ kind: 'appended' })
      expect(knowledgeLocal.deriveBundleTrust(loaded(conversion.published)).status).toBe('active')
    }

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-conversion',
      resolvedAtOrdinal: 20,
    })

    expect(report.inverseCount).toBe(4)
    expect(report.affected.mintedBundleIds).toEqual([])
    expect(report.affected.counterEvents).toHaveLength(4)
    expect(report.affected.counterEvents.map(({ type }) => type).sort()).toEqual([
      'confirmed',
      'confirmed',
      'promoted',
      'promoted',
    ])
    // Direct retraction of the job's own promotion is not a support-loss cascade.
    expect(report.retractedPromotions).toEqual([])
    for (const conversion of conversions) {
      const trust = knowledgeLocal.deriveBundleTrust(loaded(conversion.published))
      expect(trust.status).toBe('candidate')
      expect(trust.counters.confirmed).toBe(0)
    }
  })

  it('cascades promoted retraction when a rollback removes the last surviving confirmation', () => {
    const target = publishForJob({
      identity: 'cascade-target',
      curationJobId: 'job-cascade-mint',
      sourceBuildOrdinal: 4,
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('cascade-keeper-confirmed'),
      curationJobId: 'job-cascade-keeper',
      buildOrdinal: 8,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('cascade-promoted-token'),
      curationJobId: 'promote:cascade',
      buildOrdinal: 9,
    })).toEqual({ kind: 'appended' })
    // Crash-window state from a partially-applied prior rollback: the mint confirmation is
    // already retracted, leaving job-cascade-keeper holding the only surviving confirmation.
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'retracted',
      evidenceToken: asEvidenceToken('prior-rollback-retraction'),
      curationJobId: 'rollback:manual-prior',
      buildOrdinal: 10,
      retractsEvidenceToken: asEvidenceToken('job-cascade-mint-mint-confirmed'),
      retractsCurationJobId: 'job-cascade-mint',
      rollbackReceiptId: 'rollback:manual-prior',
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.deriveBundleTrust(loaded(target))).toMatchObject({
      status: 'active',
      counters: { confirmed: 1 },
    })

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-cascade-keeper',
      resolvedAtOrdinal: 20,
    })
    const bundle = loaded(target)
    const trust = knowledgeLocal.deriveBundleTrust(bundle)

    expect(report.inverseCount).toBe(2)
    expect(report.retractedPromotions).toEqual([target.id])
    expect(bundle.events).toContainEqual(expect.objectContaining({
      type: 'retracted',
      curationJobId: report.receiptId,
      retractsEvidenceToken: 'cascade-promoted-token',
      retractsCurationJobId: 'promote:cascade',
      rollbackReceiptId: report.receiptId,
    }))
    expect(trust.status).toBe('candidate')
    expect(trust.counters.confirmed).toBe(0)
  })

  it('refuses a promotion that appears after preview before writing any inverse', () => {
    const target = publishForJob({
      identity: 'promotion-preview-race',
      curationJobId: 'job-promotion-preview-base',
      sourceBuildOrdinal: 4,
      initialEvents: [],
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('promotion-preview-selected-confirmation'),
      curationJobId: 'job-promotion-preview-race',
      buildOrdinal: 8,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    const baseInput = {
      knowledgeRoot,
      curationJobId: 'job-promotion-preview-race',
      resolvedAtOrdinal: 20,
    }
    const preview = knowledgeLocal.resolveRollbackAffectedSet(baseInput)
    const previewFingerprint = knowledgeLocal.rollbackAffectedSetFingerprint(preview)
    expect(preview.plannedEffects.map(({ kind }) => kind)).toEqual(['retract-counter'])

    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('promotion-preview-late-promotion'),
      curationJobId: 'job-unrelated-late-promotion',
      buildOrdinal: 9,
    })).toEqual({ kind: 'appended' })
    const before = readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')

    expect(() => knowledgeLocal.rollbackCurationJob({
      ...baseInput,
      expectedAffectedSetFingerprint: previewFingerprint,
    })).toThrow(knowledgeLocal.RollbackPlanChangedError)
    expect(readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
    expect(loaded(target).events.some(({ type }) => type === 'retracted')).toBe(false)
  })

  it('does not cascade promoted retraction while another job\'s confirmation survives', () => {
    const target = publishForJob({
      identity: 'cascade-survivor',
      curationJobId: 'job-survivor-mint',
      sourceBuildOrdinal: 4,
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('survivor-keeper-confirmed'),
      curationJobId: 'job-survivor-keeper',
      buildOrdinal: 8,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('survivor-promoted-token'),
      curationJobId: 'promote:survivor',
      buildOrdinal: 9,
    })).toEqual({ kind: 'appended' })

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-survivor-keeper',
      resolvedAtOrdinal: 20,
    })
    const bundle = loaded(target)
    const trust = knowledgeLocal.deriveBundleTrust(bundle)

    expect(report.inverseCount).toBe(1)
    expect(report.retractedPromotions).toEqual([])
    // The mint confirmation still supports the promotion, so authority survives.
    expect(trust.status).toBe('active')
    expect(trust.counters.confirmed).toBe(1)
    expect(bundle.events).not.toContainEqual(expect.objectContaining({
      type: 'retracted',
      retractsEvidenceToken: 'survivor-promoted-token',
    }))
  })

  it('retracts promoted events by exact byte identity so a near-miss token survives', () => {
    const target = publishForJob({
      identity: 'byte-identity',
      curationJobId: 'job-byte-mint',
      sourceBuildOrdinal: 4,
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('byte-target-token'),
      curationJobId: 'job-byte-victim',
      buildOrdinal: 9,
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('byte-target-tokeN'),
      curationJobId: 'promote:near-miss',
      buildOrdinal: 10,
    })).toEqual({ kind: 'appended' })

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-byte-victim',
      resolvedAtOrdinal: 20,
    })
    const bundle = loaded(target)
    const retractions = bundle.events.flatMap((event) =>
      event.type === 'retracted'
        ? [`${event.retractsEvidenceToken}:${event.retractsCurationJobId}`]
        : [],
    )

    expect(report.inverseCount).toBe(1)
    expect(report.affected.counterEvents).toEqual([{
      recordId: target.id,
      evidenceToken: 'byte-target-token',
      curationJobId: 'job-byte-victim',
      type: 'promoted',
    }])
    expect(retractions).toEqual(['byte-target-token:job-byte-victim'])
    // The promotion whose token differs in one byte survives and keeps the record active.
    expect(knowledgeLocal.deriveBundleTrust(bundle).status).toBe('active')
  })

  it('rejects an equal-ordinal resolution with RollbackCausalityError before any append', async () => {
    const target = publishForJob({
      identity: 'causality-equal',
      curationJobId: 'job-causality-equal',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-causality-equal', 5),
    })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    expect(hasFtsRow(target.id)).toBe(true)
    const before = readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')

    let caught: unknown
    try {
      rollbackApi().rollbackCurationJob({
        knowledgeRoot,
        curationJobId: 'job-causality-equal',
        resolvedAtOrdinal: 5,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({
      name: 'RollbackCausalityError',
      offendingRecordIds: [target.id],
      minimumRequiredOrdinal: 6,
    })
    expect(readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('active')
    expect(hasFtsRow(target.id)).toBe(true)

    // The strictly-later boundary N+1 succeeds with the existing behavior unchanged.
    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-causality-equal',
      resolvedAtOrdinal: 6,
    })
    expect(report.deprecatedBundles).toEqual([target.id])
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('deprecated')
  })

  it('rejects a lower-ordinal resolution with RollbackCausalityError before any append', () => {
    const target = publishForJob({
      identity: 'causality-lower',
      curationJobId: 'job-causality-lower',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-causality-lower', 5),
    })
    const before = readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')

    let caught: unknown
    try {
      rollbackApi().rollbackCurationJob({
        knowledgeRoot,
        curationJobId: 'job-causality-lower',
        resolvedAtOrdinal: 4,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'RollbackCausalityError',
      offendingRecordIds: [target.id],
      minimumRequiredOrdinal: 6,
    })
    expect(readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('active')
  })

  it('rejects a campaign rollback atomically when any affected bundle is not strictly later', () => {
    const early = publishForJob({
      identity: 'campaign-early',
      curationJobId: 'job-campaign-early',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-campaign-early', 5),
    })
    const late = publishForJob({
      identity: 'campaign-late',
      curationJobId: 'job-campaign-late',
      sourceBuildOrdinal: 10,
      initialEvents: activeEvents('job-campaign-late', 10),
    })
    const before = {
      early: readFileSync(join(early.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
      late: readFileSync(join(late.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
    }

    let caught: unknown
    try {
      rollbackApi().rollbackCampaign({
        knowledgeRoot,
        fromOrdinal: 1,
        resolvedAtOrdinal: 10,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'RollbackCausalityError',
      offendingRecordIds: [late.id],
      minimumRequiredOrdinal: 11,
    })
    // The whole resolved set is rejected atomically: neither bundle gained an event.
    expect({
      early: readFileSync(join(early.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
      late: readFileSync(join(late.dir, 'evidence', 'outcomes.jsonl'), 'utf8'),
    }).toEqual(before)
    expect(knowledgeLocal.deriveBundleTrust(loaded(early)).status).toBe('active')
    expect(knowledgeLocal.deriveBundleTrust(loaded(late)).status).toBe('active')
  })

  it('admits byte replay at the original ordinal as a duplicate no-op', () => {
    const target = publishForJob({
      identity: 'replay-admission',
      curationJobId: 'job-replay-admission',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-replay-admission', 5),
    })
    const rollbackInput = {
      knowledgeRoot,
      curationJobId: 'job-replay-admission',
      resolvedAtOrdinal: 20,
    }
    const first = rollbackApi().rollbackCurationJob(rollbackInput)
    expect(first.inverseCount).toBe(1)
    // Later truth re-promotes the bundle, so the replay preflight cannot rely on an
    // already-deprecated fold: only the exact inverse identity admits it.
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'promoted',
      evidenceToken: asEvidenceToken('replay-revive-promoted'),
      curationJobId: 'promote:revive',
      buildOrdinal: 21,
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('active')
    const before = readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')

    const second = rollbackApi().rollbackCurationJob(rollbackInput)

    expect(second.inverseCount).toBe(0)
    expect(readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('active')
  })

  it('admits a minted bundle already deprecated by earlier truth without a throw', () => {
    const target = publishForJob({
      identity: 'already-deprecated',
      curationJobId: 'job-already-deprecated',
      sourceBuildOrdinal: 5,
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), target.id, {
      type: 'deprecated',
      evidenceToken: asEvidenceToken('manual-deprecation-token'),
      curationJobId: 'job-manual-deprecate',
      buildOrdinal: 9,
      reason: 'manual maintenance',
    })).toEqual({ kind: 'appended' })
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('deprecated')

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-already-deprecated',
      resolvedAtOrdinal: 9,
    })

    expect(report.deprecatedBundles).toEqual([])
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('deprecated')
  })

  it('returns an empty no-op report when the rollback matches nothing', () => {
    const bystander = publishForJob({
      identity: 'empty-set-bystander',
      curationJobId: 'job-bystander',
      sourceBuildOrdinal: 5,
    })
    const before = readFileSync(join(bystander.dir, 'evidence', 'outcomes.jsonl'), 'utf8')

    const report = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-never-existed',
      resolvedAtOrdinal: 20,
    })

    expect(report.inverseCount).toBe(0)
    expect(report.restoredVictims).toEqual([])
    expect(report.deprecatedBundles).toEqual([])
    expect(report.retractedPromotions).toEqual([])
    expect(report.affected).toMatchObject({
      mintedBundleIds: [],
      counterEvents: [],
      plannedEffects: [],
      projectionTargets: [],
      products: [],
    })
    expect(readFileSync(join(bystander.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
  })

  it('refuses the first append when authority is reclaimed after resolution', async () => {
    const target = publishForJob({
      identity: 'authority-after-resolution',
      curationJobId: 'job-authority-after-resolution',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-authority-after-resolution', 5),
    })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    const before = readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')
    const authority = acquireWriterAuthority()

    expect(() =>
      rollbackApi().rollbackCurationJob({
        knowledgeRoot,
        curationJobId: 'job-authority-after-resolution',
        resolvedAtOrdinal: 20,
        writerAuthority: authority,
        hooks: {
          afterResolution: () => {
            reclaimWriterAuthority(authority)
          },
        },
      }),
    ).toThrow(knowledgeLocal.WriterAuthorityLostError)

    expect(readFileSync(join(target.dir, 'evidence', 'outcomes.jsonl'), 'utf8')).toBe(before)
    expect(knowledgeLocal.deriveBundleTrust(loaded(target)).status).toBe('active')
    expect(hasFtsRow(target.id)).toBe(true)
  })

  it('performs no later append or projection after authority loss and resumes idempotently', async () => {
    const minted = publishForJob({
      identity: 'authority-partial-minted',
      curationJobId: 'job-authority-partial',
      sourceBuildOrdinal: 5,
      initialEvents: activeEvents('job-authority-partial', 5),
    })
    const counterTarget = publishForJob({
      identity: 'authority-partial-counter',
      curationJobId: 'job-authority-bystander',
      sourceBuildOrdinal: 6,
      initialEvents: activeEvents('job-authority-bystander', 6),
    })
    expect(knowledgeLocal.appendOutcomeEvent(config(), counterTarget.id, {
      type: 'confirmed',
      evidenceToken: asEvidenceToken('authority-partial-counter-token'),
      curationJobId: 'job-authority-partial',
      buildOrdinal: 7,
      origin: 'agent-verified',
    })).toEqual({ kind: 'appended' })
    await knowledgeLocal.rebuildIndex({ knowledgeRoot })
    const counterBefore = readFileSync(
      join(counterTarget.dir, 'evidence', 'outcomes.jsonl'),
      'utf8',
    )
    const authority = acquireWriterAuthority()
    let successor: WriterLeaseAuthority | undefined
    let completedMutations = 0

    expect(() =>
      rollbackApi().rollbackCurationJob({
        knowledgeRoot,
        curationJobId: 'job-authority-partial',
        resolvedAtOrdinal: 20,
        writerAuthority: authority,
        hooks: {
          afterMutation: () => {
            completedMutations += 1
            if (completedMutations === 1) successor = reclaimWriterAuthority(authority)
          },
        },
      }),
    ).toThrow(knowledgeLocal.WriterAuthorityLostError)

    expect(completedMutations).toBe(1)
    expect(knowledgeLocal.deriveBundleTrust(loaded(minted)).status).toBe('deprecated')
    expect(readFileSync(join(counterTarget.dir, 'evidence', 'outcomes.jsonl'), 'utf8'))
      .toBe(counterBefore)
    expect(hasFtsRow(minted.id)).toBe(true)
    expect(hasFtsRow(counterTarget.id)).toBe(true)

    if (successor === undefined) throw new Error('expected successor writer authority')
    const resumed = rollbackApi().rollbackCurationJob({
      knowledgeRoot,
      curationJobId: 'job-authority-partial',
      resolvedAtOrdinal: 20,
      writerAuthority: successor,
    })
    expect(resumed.inverseCount).toBe(1)
    expect(knowledgeLocal.deriveBundleTrust(loaded(counterTarget)).counters.confirmed).toBe(1)
    expect(hasFtsRow(minted.id)).toBe(false)
  })
})
