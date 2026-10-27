import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  canonicalJson,
  guardBundleManifest,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claimNextJob,
  CURATION_QUEUE_SCHEMA_VERSION,
  persistAuthoredCheckpoint,
  queuedCandidateDir,
  readCurationCandidatePayload,
  readJobState,
  verifyBundleIntegrity,
  writeJobState,
  type CurationCandidatePayload,
} from '../index.js'
import { appendOutcomeEventWithEnrichment } from '../bundle-append.js'
import {
  acquireWriterLease,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  readCurrentEpoch,
  readWriterLease,
  type CurrentWriterAuthority,
} from '../lease/writer-lease.js'
import {
  COMMIT_INTENT_SCHEMA_VERSION,
  JOURNAL_SUBDIR,
  listCommitIntents,
  quarantineStaleCommitIntent,
  readReconciledEpoch,
  writeCommitIntent,
  type CommitIntent,
} from '../journal/intent-journal.js'
import {
  reconcileOnDrainStart,
  type ReconcileOnDrainStartDependencies,
  type ReconcileOnDrainStartHooks,
} from '../journal/reconcile.js'
import {
  publishBundle,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from './fixtures/curation-candidate-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

describe('drain-start crash reconciliation (CUR-04)', () => {
  let root: string
  let knowledgeRoot: string
  let indexRows: Set<string>
  let applyIndexDelta: ReturnType<typeof vi.fn<(intent: CommitIntent) => void>>
  let deriveIndexRowFromBundle: ReturnType<typeof vi.fn<(bundleId: string) => void>>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-reconcile-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    indexRows = new Set()
    applyIndexDelta = vi.fn((intent: CommitIntent) => {
      indexRows.add(intent.bundleId)
    })
    deriveIndexRowFromBundle = vi.fn((bundleId: string) => {
      indexRows.add(bundleId)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function currentWriterAuthority(): CurrentWriterAuthority {
    const current = readWriterLease(knowledgeRoot)
    if (current.kind === 'parsed') {
      return { leaseId: current.lease.leaseId, epoch: current.lease.epoch }
    }
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind === 'acquired') {
      return { leaseId: acquired.leaseId, epoch: acquired.epoch }
    }
    if (acquired.kind === 'held') {
      return { leaseId: acquired.holder.leaseId, epoch: acquired.holder.epoch }
    }
    throw acquired.error
  }

  function deps(hooks?: ReconcileOnDrainStartHooks): ReconcileOnDrainStartDependencies {
    return {
      knowledgeRoot,
      writerAuthority: currentWriterAuthority(),
      hasIndexRow: (bundleId) => indexRows.has(bundleId),
      applyIndexDelta,
      deriveIndexRowFromBundle,
      ...(hooks === undefined ? {} : { hooks }),
    }
  }

  function bundleInput(): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'reconcile-run',
        testId: 'reconcile-test',
        stepIndex: 0,
      },
      artifacts: [],
    }
  }

  function enrichmentBundleInput(): PublishBundleInput {
    return {
      ...bundleInput(),
      provenance: {
        mode: 'run-linked',
        runId: 'reconcile-run',
        testId: 'reconcile-test',
        stepIndex: 0,
        authorship: {
          path: 'deterministic-fallback',
          executionContext: 'local-headless',
        },
        needsEnrichment: true,
      },
    }
  }

  function publishBundleTruth(): PublishedBundle {
    const outcome = publishBundle(
      {
        knowledgeRoot,
        productKey: 'fixture-storefront',
      },
      bundleInput(),
    )
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error(`expected publish, got ${outcome.kind}`)
    return outcome
  }

  function projectionInput(seed: string): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-${seed}`,
      scope: { tier: 'product', key: 'fixture-storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: seed }],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was verified`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: seed, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `button:${seed}` },
          observedAtOrdinal: 42,
        },
      ],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      emittedAt: '2026-07-15T10:00:00.000Z',
    }
  }

  function claimWithAuthoredCheckpoint(
    seed: string,
    authority: CurrentWriterAuthority = currentWriterAuthority(),
  ): CurationCandidatePayload {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projectionInput(seed),
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
    const { candidateId } = outcome
    const queued = readCurationCandidatePayload(
      queuedCandidateDir(knowledgeRoot, candidateId),
    )
    expect(queued.kind).toBe('parsed')
    if (queued.kind !== 'parsed') throw new Error('expected parsed projection payload')
    expect(queued.payload.candidateId).toBe(candidateId)

    const claim = claimNextJob({
      knowledgeRoot,
      leaseId: authority.leaseId,
      authority,
    })
    expect(claim?.kind).toBe('claimed')
    if (claim?.kind !== 'claimed') throw new Error('expected claimed candidate')
    expect(claim.candidateId).toBe(candidateId)
    expect(claim.payload).toEqual(queued.payload)

    const authored = { delta: { kind: 'Add', body: seed }, neighborIds: ['record-1'] }
    const persisted = persistAuthoredCheckpoint({
      knowledgeRoot,
      candidateId,
      authority,
      authored,
    })
    expect(persisted.kind).toBe('persisted')
    writeJobState({
      knowledgeRoot,
      candidateId,
      lifecycle: 'bundling',
      authority,
      authored,
    })
    return queued.payload
  }

  function intent(candidateId: string, bundleId: string): CommitIntent {
    return {
      schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
      candidateId,
      bundleId,
      deltaKind: 'Add',
      epoch: 2,
    }
  }

  it('state 1 reprojects an existing row from canonical bundle truth before clearing intent', () => {
    const published = publishBundleTruth()
    const entry = intent('a'.repeat(64), published.id)
    writeCommitIntent(knowledgeRoot, entry)
    indexRows.add(published.id)

    expect(reconcileOnDrainStart(deps())).toEqual({
      intentsCleared: 1,
      intentsReplayed: 1,
      intentsDiscarded: 0,
      intentsQuarantinedStale: 0,
      jobsRequeued: 0,
      orphansRemoved: 0,
      mutationsRecovered: 0,
      malformed: 0,
    })
    expect(listCommitIntents(knowledgeRoot)).toEqual([])
    expect(applyIndexDelta).toHaveBeenCalledOnce()
    expect(applyIndexDelta).toHaveBeenCalledWith(entry)
    expect(deriveIndexRowFromBundle).not.toHaveBeenCalled()
  })

  it('state 2 replays a persisted intent before clearing it when the row is missing', () => {
    const published = publishBundleTruth()
    const entry = intent('b'.repeat(64), published.id)
    writeCommitIntent(knowledgeRoot, entry)

    const report = reconcileOnDrainStart(deps())

    expect(applyIndexDelta).toHaveBeenCalledOnce()
    expect(applyIndexDelta).toHaveBeenCalledWith(entry)
    expect(indexRows.has(published.id)).toBe(true)
    expect(listCommitIntents(knowledgeRoot)).toEqual([])
    expect(report).toMatchObject({ intentsCleared: 1, intentsReplayed: 1 })
  })

  it('state 3 discards an intent without bundle truth and returns the job to queued', () => {
    const payload = claimWithAuthoredCheckpoint('missing-bundle')
    writeCommitIntent(
      knowledgeRoot,
      intent(payload.candidateId, 'fact-never-published-0123456789abcdef'),
    )

    const report = reconcileOnDrainStart(deps())

    expect(report).toMatchObject({ intentsDiscarded: 1, jobsRequeued: 1 })
    expect(listCommitIntents(knowledgeRoot)).toEqual([])
    expect(existsSync(queuedCandidateDir(knowledgeRoot, payload.candidateId))).toBe(true)
    const state = readJobState(knowledgeRoot, payload.candidateId)
    expect(state.kind).toBe('parsed')
    if (state.kind !== 'parsed') throw new Error('expected requeued state')
    expect(state.state.lifecycle).toBe('queued')
    expect(state.state.authored).toEqual({
      delta: { kind: 'Add', body: 'missing-bundle' },
      neighborIds: ['record-1'],
    })
    expect(applyIndexDelta).not.toHaveBeenCalled()
  })

  it('state 4 re-derives an orphan bundle row and a second pass is a no-op', () => {
    const published = publishBundleTruth()

    const first = reconcileOnDrainStart(deps())

    expect(deriveIndexRowFromBundle).toHaveBeenCalledOnce()
    expect(deriveIndexRowFromBundle).toHaveBeenCalledWith(published.id)
    expect(indexRows.has(published.id)).toBe(true)
    expect(first).toEqual({
      intentsCleared: 0,
      intentsReplayed: 0,
      intentsDiscarded: 0,
      intentsQuarantinedStale: 0,
      jobsRequeued: 0,
      orphansRemoved: 0,
      mutationsRecovered: 0,
      malformed: 0,
    })

    applyIndexDelta.mockClear()
    deriveIndexRowFromBundle.mockClear()
    expect(reconcileOnDrainStart(deps())).toEqual(first)
    expect(applyIndexDelta).not.toHaveBeenCalled()
    expect(deriveIndexRowFromBundle).not.toHaveBeenCalled()
  })

  it('state 5 leaves an indexed bundle with pending vector healing to the writer pass', () => {
    const published = publishBundleTruth()
    indexRows.add(published.id)

    reconcileOnDrainStart(deps())

    expect(applyIndexDelta).not.toHaveBeenCalled()
    expect(deriveIndexRowFromBundle).not.toHaveBeenCalled()
  })

  it('discards malformed intent bytes and fails toward re-processing the candidate', () => {
    const payload = claimWithAuthoredCheckpoint('malformed-intent')
    const file = join(
      knowledgeRoot,
      JOURNAL_SUBDIR,
      `${payload.candidateId}.intent.json`,
    )
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{torn-intent', 'utf8')

    const report = reconcileOnDrainStart(deps())

    expect(report).toMatchObject({
      intentsDiscarded: 1,
      jobsRequeued: 1,
      malformed: 1,
    })
    expect(existsSync(file)).toBe(false)
    expect(existsSync(queuedCandidateDir(knowledgeRoot, payload.candidateId))).toBe(true)
  })

  it('reclaims a stale lease, preserves authored work, and GCs only its staging dirs', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const stale = acquireWriterLease(knowledgeRoot)
    expect(stale.kind).toBe('acquired')
    if (stale.kind !== 'acquired') throw new Error('expected stale holder setup')
    const payload = claimWithAuthoredCheckpoint(
      'stale-reclaim',
      stale,
    )

    now.mockReturnValue(1_000_000 + LEASE_HEARTBEAT_TTL_MS)
    const current = acquireWriterLease(knowledgeRoot)
    expect(current.kind).toBe('acquired')
    if (current.kind !== 'acquired') throw new Error('expected reclaimed current holder')
    expect(readCurrentEpoch(knowledgeRoot)).toBe(2)

    const stagingRoot = join(
      knowledgeRoot,
      'memory',
      'fixture-storefront',
      'bundles',
      '.staging',
    )
    const staleStaging = join(stagingRoot, `${stale.leaseId}-orphan-bundle`)
    const freshStaging = join(stagingRoot, `${current.leaseId}-active-bundle`)
    mkdirSync(staleStaging, { recursive: true })
    mkdirSync(freshStaging, { recursive: true })
    writeFileSync(join(staleStaging, 'partial'), 'stale', 'utf8')
    writeFileSync(join(freshStaging, 'partial'), 'fresh', 'utf8')

    const report = reconcileOnDrainStart(deps())

    expect(report).toMatchObject({ jobsRequeued: 1, orphansRemoved: 1 })
    expect(existsSync(staleStaging)).toBe(false)
    expect(existsSync(freshStaging)).toBe(true)
    expect(existsSync(join(knowledgeRoot, LEASE_FILE))).toBe(true)
    expect(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')).toContain(current.leaseId)
    expect(existsSync(queuedCandidateDir(knowledgeRoot, payload.candidateId))).toBe(true)
    const state = readJobState(knowledgeRoot, payload.candidateId)
    expect(state.kind).toBe('parsed')
    if (state.kind !== 'parsed') throw new Error('expected stale job to be requeued')
    expect(state.state.authored).toEqual({
      delta: { kind: 'Add', body: 'stale-reclaim' },
      neighborIds: ['record-1'],
    })
  })

  it('recovers a partial expired-lease enrichment before stale GC and refreshes its existing row', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const stale = acquireWriterLease(knowledgeRoot)
    expect(stale.kind).toBe('acquired')
    if (stale.kind !== 'acquired') throw new Error('expected stale holder setup')
    const payload = claimWithAuthoredCheckpoint(
      'partial-enrichment',
      stale,
    )
    const published = publishBundle(
      {
        knowledgeRoot,
        productKey: 'fixture-storefront',
        writerLeaseId: stale.leaseId,
      },
      enrichmentBundleInput(),
    )
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected enrichment fixture bundle')
    writeCommitIntent(knowledgeRoot, intent(payload.candidateId, published.id))
    indexRows.add(published.id)

    expect(() =>
      appendOutcomeEventWithEnrichment(
        {
          knowledgeRoot,
          productKey: 'fixture-storefront',
          writerLeaseId: stale.leaseId,
          hooks: {
            afterMutableReplacement(relPath) {
              if (relPath === 'record.md') throw new Error('injected partial enrichment')
            },
          },
        },
        published.id,
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'recovered-enrichment',
          curationJobId: payload.candidateId,
          buildOrdinal: 43,
          origin: 'agent-verified',
        }),
        {
          summary: 'Recovered capable-model selector',
          body: 'The recovered mutation contains verified capable-model prose.',
          authorship: {
            path: 'llm',
            model: { id: 'recovery-curator' },
            executionContext: 'local-interactive',
          },
        },
      ),
    ).toThrow('injected partial enrichment')
    expect(verifyBundleIntegrity(published.dir).ok).toBe(false)

    const stagingRoot = join(published.dir, '..', '.staging')
    const mutationDir = join(
      stagingRoot,
      readdirSync(stagingRoot).find((name) => name.includes('-mutation-'))!,
    )
    const ordinaryStaging = join(stagingRoot, `${stale.leaseId}-unpublished-bundle`)
    mkdirSync(ordinaryStaging)
    writeFileSync(join(ordinaryStaging, 'partial'), 'ordinary stale staging', 'utf8')

    let projectedMutableStateHash: string | undefined
    applyIndexDelta.mockImplementation((entry) => {
      indexRows.add(entry.bundleId)
      projectedMutableStateHash = guardBundleManifest(
        JSON.parse(readFileSync(join(published.dir, 'manifest.json'), 'utf8')),
      ).mutableStateHash
    })
    now.mockReturnValue(2_000_000 + LEASE_HEARTBEAT_TTL_MS)
    expect(acquireWriterLease(knowledgeRoot).kind).toBe('acquired')

    const report = reconcileOnDrainStart(deps())

    expect(report).toMatchObject({
      mutationsRecovered: 1,
      orphansRemoved: 1,
      intentsCleared: 1,
      intentsReplayed: 1,
      jobsRequeued: 1,
    })
    expect(existsSync(mutationDir)).toBe(false)
    expect(existsSync(ordinaryStaging)).toBe(false)
    expect(verifyBundleIntegrity(published.dir)).toEqual({ ok: true, violations: [] })
    const repairedManifest = guardBundleManifest(
      JSON.parse(readFileSync(join(published.dir, 'manifest.json'), 'utf8')),
    )
    expect(projectedMutableStateHash).toBe(repairedManifest.mutableStateHash)
    expect(applyIndexDelta).toHaveBeenCalledWith(intent(payload.candidateId, published.id))
    expect(listCommitIntents(knowledgeRoot)).toEqual([])

    applyIndexDelta.mockClear()
    expect(reconcileOnDrainStart(deps())).toMatchObject({ mutationsRecovered: 0 })
    expect(applyIndexDelta).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'malformed journal',
      tamper(transactionDir: string) {
        writeFileSync(join(transactionDir, 'mutation.json'), '{torn-journal', 'utf8')
      },
    },
    {
      label: 'digest-mismatched recovery copy',
      tamper(transactionDir: string) {
        writeFileSync(join(transactionDir, 'recovery', '0001'), 'tampered', 'utf8')
      },
    },
    {
      label: 'path-escaping target',
      tamper(transactionDir: string) {
        const journalPath = join(transactionDir, 'mutation.json')
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
          replacements: { targetRelPath: string }[]
        }
        journal.replacements[0]!.targetRelPath = '../record.md'
        writeFileSync(journalPath, `${canonicalJson(journal)}\n`, 'utf8')
      },
    },
  ])('preserves expired mutation evidence for a $label', ({ tamper }) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000)
    const stale = acquireWriterLease(knowledgeRoot)
    expect(stale.kind).toBe('acquired')
    if (stale.kind !== 'acquired') throw new Error('expected stale holder setup')
    claimWithAuthoredCheckpoint(
      'malformed-mutation',
      stale,
    )
    const published = publishBundle(
      {
        knowledgeRoot,
        productKey: 'fixture-storefront',
        writerLeaseId: stale.leaseId,
      },
      enrichmentBundleInput(),
    )
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected mutation fixture bundle')

    expect(() =>
      appendOutcomeEventWithEnrichment(
        {
          knowledgeRoot,
          productKey: 'fixture-storefront',
          writerLeaseId: stale.leaseId,
          hooks: {
            afterMutableReplacement() {
              throw new Error('leave mutation journal')
            },
          },
        },
        published.id,
        BundleOutcomeEventSchema.parse({
          type: 'confirmed',
          evidenceToken: 'malformed-recovery',
          curationJobId: 'malformed-recovery-job',
          buildOrdinal: 43,
          origin: 'agent-verified',
        }),
        {
          summary: 'Recovery evidence',
          body: 'Recovery evidence must remain durable.',
          authorship: {
            path: 'llm',
            model: { id: 'recovery-curator' },
            executionContext: 'local-interactive',
          },
        },
      ),
    ).toThrow('leave mutation journal')
    const stagingRoot = join(published.dir, '..', '.staging')
    const transactionDir = join(stagingRoot, readdirSync(stagingRoot)[0]!)
    tamper(transactionDir)

    now.mockReturnValue(3_000_000 + LEASE_HEARTBEAT_TTL_MS)
    expect(acquireWriterLease(knowledgeRoot).kind).toBe('acquired')

    expect(() => reconcileOnDrainStart(deps())).toThrow()
    expect(existsSync(transactionDir)).toBe(true)
  })

  describe('stale-intent quarantine is collision-proof and crash-calm (W-08)', () => {
    function journalDir(): string {
      return join(knowledgeRoot, JOURNAL_SUBDIR)
    }

    function quarantinedNames(): string[] {
      return readdirSync(journalDir())
        .filter((name) => name.startsWith('.stale-'))
        .sort()
    }

    function quarantinedBytes(): string[] {
      return quarantinedNames()
        .map((name) => readFileSync(join(journalDir(), name), 'utf8'))
        .sort()
    }

    /** Take the lease from an expired holder, exactly as a successor daemon does. */
    function takeOver(
      now: { mockReturnValue(value: number): unknown },
      at: number,
    ): number {
      now.mockReturnValue(at)
      const acquired = acquireWriterLease(knowledgeRoot)
      expect(acquired.kind).toBe('acquired')
      if (acquired.kind !== 'acquired') throw new Error('expected acquired lease')
      return acquired.epoch
    }

    /**
     * A fenced-out writer of `epoch` reaching the journal — authored through the production
     * entry point so the quarantine sees exactly the bytes production produces.
     */
    function authorAsFencedOutWriter(entry: CommitIntent): string {
      writeCommitIntent(knowledgeRoot, entry)
      return readFileSync(join(journalDir(), `${entry.candidateId}.intent.json`), 'utf8')
    }

    it('preserves both evidence sets when two stale intents share (epoch, candidateId)', () => {
      const published = publishBundleTruth()
      const staleCandidate = 'e'.repeat(64)
      const now = vi.spyOn(Date, 'now').mockReturnValue(4_000_000)
      expect(takeOver(now, 4_000_000)).toBe(1)
      expect(takeOver(now, 4_000_000 + LEASE_HEARTBEAT_TTL_MS)).toBe(2)

      // A completed pass at epoch 2 sets the watermark; epoch-1 intents are stale from here on.
      expect(reconcileOnDrainStart(deps())).toMatchObject({ intentsQuarantinedStale: 0 })
      expect(readReconciledEpoch(knowledgeRoot)).toBe(2)

      const firstBytes = authorAsFencedOutWriter({
        schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
        candidateId: staleCandidate,
        bundleId: published.id,
        deltaKind: 'Add',
        epoch: 1,
      })
      expect(reconcileOnDrainStart(deps())).toMatchObject({
        intentsQuarantinedStale: 1,
        intentsReplayed: 0,
      })

      // The same fenced-out generation reaches the journal again for the same candidate: the
      // key is identical, so a name derived only from (epoch, candidateId) would overwrite.
      const secondBytes = authorAsFencedOutWriter({
        schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
        candidateId: staleCandidate,
        bundleId: published.id,
        deltaKind: 'Confirm',
        targetRecordId: published.id,
        epoch: 1,
      })
      expect(secondBytes).not.toBe(firstBytes)
      expect(reconcileOnDrainStart(deps())).toMatchObject({
        intentsQuarantinedStale: 1,
        intentsReplayed: 0,
      })

      const names = quarantinedNames()
      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
      for (const name of names) {
        expect(name).toMatch(
          new RegExp(String.raw`^\.stale-1-${staleCandidate}-.+\.intent\.json$`),
        )
      }
      expect(quarantinedBytes()).toEqual([firstBytes, secondBytes].sort())
      expect(listCommitIntents(knowledgeRoot)).toEqual([])
      expect(applyIndexDelta).not.toHaveBeenCalled()
    })

    it('completes the pass when a stale intent vanishes before its quarantine rename', () => {
      const published = publishBundleTruth()
      const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
      expect(takeOver(now, 5_000_000)).toBe(1)
      expect(takeOver(now, 5_000_000 + LEASE_HEARTBEAT_TTL_MS)).toBe(2)

      expect(reconcileOnDrainStart(deps())).toMatchObject({ intentsQuarantinedStale: 0 })
      expect(readReconciledEpoch(knowledgeRoot)).toBe(2)

      const staleCandidate = 'f'.repeat(64)
      authorAsFencedOutWriter({
        schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
        candidateId: staleCandidate,
        bundleId: published.id,
        deltaKind: 'Add',
        epoch: 1,
      })
      // A crash journal of the generation this pass legitimately inherits, replayed after the
      // quarantine loop — it only reaches applyIndexDelta if the pass survives the vanished one.
      const inherited = intent('a'.repeat(64), published.id)
      writeCommitIntent(knowledgeRoot, inherited)

      expect(takeOver(now, 5_000_000 + 2 * LEASE_HEARTBEAT_TTL_MS)).toBe(3)
      applyIndexDelta.mockClear()

      const vanished: string[] = []
      const report = reconcileOnDrainStart(
        deps({
          beforeStaleQuarantine(candidateId) {
            vanished.push(candidateId)
            rmSync(join(journalDir(), `${candidateId}.intent.json`), { force: true })
          },
        }),
      )

      expect(vanished).toEqual([staleCandidate])
      expect(report).toMatchObject({
        intentsQuarantinedStale: 0,
        intentsReplayed: 1,
        intentsCleared: 1,
        intentsDiscarded: 0,
        malformed: 0,
      })
      expect(applyIndexDelta).toHaveBeenCalledOnce()
      expect(applyIndexDelta).toHaveBeenCalledWith(inherited)
      expect(quarantinedNames()).toEqual([])
      expect(listCommitIntents(knowledgeRoot)).toEqual([])
      // The pass ran to its last step: an aborted pass leaves the watermark behind.
      expect(readReconciledEpoch(knowledgeRoot)).toBe(3)
    })

    it('classifies only a vanished source as already-gone and surfaces every other errno', () => {
      const missing = quarantineStaleCommitIntent(knowledgeRoot, 'd'.repeat(64), 1)
      expect(missing).toEqual({ kind: 'already-gone' })

      // A journal path whose prefix is a regular file: rename fails ENOTDIR, not ENOENT.
      const brokenRoot = join(root, 'broken-knowledge')
      mkdirSync(join(brokenRoot, 'memory', 'queue'), { recursive: true })
      writeFileSync(join(brokenRoot, JOURNAL_SUBDIR), 'not a directory', 'utf8')

      let surfaced: NodeJS.ErrnoException | undefined
      try {
        quarantineStaleCommitIntent(brokenRoot, 'd'.repeat(64), 1)
      } catch (error) {
        surfaced = error as NodeJS.ErrnoException
      }
      expect(surfaced?.code).toBe('ENOTDIR')
    })
  })

  it('has no author or model invocation slot in its dependency surface', () => {
    type HasNoAuthor = 'author' extends keyof ReconcileOnDrainStartDependencies ? false : true
    const hasNoAuthor: HasNoAuthor = true

    expect(hasNoAuthor).toBe(true)
    expect(Object.keys(deps()).sort()).toEqual([
      'applyIndexDelta',
      'deriveIndexRowFromBundle',
      'hasIndexRow',
      'knowledgeRoot',
      'writerAuthority',
    ])
  })
})
