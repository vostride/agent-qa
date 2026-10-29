import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CurationAuthorship, Delta } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  commitCurationDelta,
  drainQueue,
  enumerateBundleDirs,
  loadBundle,
  verifyBundleIntegrity,
  type CommitCurationOutcome,
  type CuratorAuthor,
} from '../../index.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'

const flowAnchor = { t: 'flow', name: 'Checkout flow' } as const

describe('fallback to capable-model enrichment in place', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-enrichment-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function projectionInput(
    seed: string,
    buildOrdinal: number,
  ): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-enrichment-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'behavioral',
      anchors: [flowAnchor],
      summarySeed: 'Checkout flow needs richer authoring',
      bodySeed: 'Complete checkout using the observed sequence.',
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: 'checkout-submit', ordinal: 0 },
          flow: { name: flowAnchor.name },
          observedAtOrdinal: buildOrdinal,
        },
      ],
      evidenceToken: `evidence-enrichment-${seed}`,
      attributingObservationId: `run-enrichment-${seed}:test-0:step-0`,
      emittedAt: `2026-07-15T10:0${buildOrdinal - 42}:00.000Z`,
    }
  }

  function enqueue(
    candidateProjection: ArtifactFreeCandidateProjectionInput,
  ): { candidateId: string } {
    const outcome = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: candidateProjection,
    })
    expect(outcome.kind).toBe('enqueued')
    if (outcome.kind !== 'enqueued') {
      throw new Error(`expected enqueued projection, received ${outcome.kind}`)
    }
    return { candidateId: outcome.candidateId }
  }

  function options(author: CuratorAuthor) {
    return {
      knowledgeRoot,
      author,
      executionContext: 'local-interactive' as const,
    }
  }

  it('converts an enriched duplicate Add to Confirm on the one existing bundle', async () => {
    const fallbackCandidate = enqueue(projectionInput('fallback', 42))
    const fallbackAuthor = vi.fn<CuratorAuthor>(async () => ({
      kind: 'fallback-required',
      reason: 'no-model',
    }))

    const fallbackReport = await drainQueue(options(fallbackAuthor))

    expect(fallbackReport).toMatchObject({ committed: 1, failures: 0 })
    expect(fallbackAuthor).toHaveBeenCalledOnce()
    const fallbackDirs = enumerateBundleDirs(knowledgeRoot)
    expect(fallbackDirs).toHaveLength(1)
    const fallbackLoaded = loadBundle(fallbackDirs[0]!.dir)
    expect(fallbackLoaded.kind).toBe('loaded')
    if (fallbackLoaded.kind !== 'loaded') throw new Error('expected fallback bundle')
    expect(fallbackLoaded.bundle.provenance).toMatchObject({
      needsEnrichment: true,
      authorship: { path: 'deterministic-fallback' },
    })
    const originalId = fallbackLoaded.bundle.manifest.id

    const capableCandidate = enqueue(projectionInput('capable', 43))
    const enrichedSummary = 'Checkout submission sequence with verified terminal action'
    const enrichedBody =
      'Submit the resolved checkout form, wait for confirmation, and verify payment navigation.'
    const capableAuthor = vi.fn<CuratorAuthor>(async (job) => {
      const authorship: CurationAuthorship = {
        path: 'llm',
        model: { id: 'capable-curator' },
        executionContext: job.executionContext,
      }
      const delta: Delta = {
        kind: 'Add',
        origin: 'agent',
        scope: job.scope,
        citedIds: [],
        authorship,
        bundle: {
          kind: job.kind,
          ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
          anchors: job.anchors,
          scope: job.scope,
          summary: enrichedSummary,
          body: enrichedBody,
          distilledEvidenceRef: {
            id: `curation-candidate-${job.candidateId}`,
            sha: job.candidateId,
          },
          originStage: 'run-curation',
        },
      }
      return { kind: 'authored', deltas: [delta], authorship }
    })
    let commitOutcome: CommitCurationOutcome | undefined

    const capableReport = await drainQueue({
      ...options(capableAuthor),
      operations: {
        commitCurationDelta(deps, job, checkpoint) {
          commitOutcome = commitCurationDelta(deps, job, checkpoint)
          return commitOutcome
        },
      },
    })

    expect(capableReport).toMatchObject({ committed: 1, failures: 0 })
    expect(capableAuthor).toHaveBeenCalledOnce()
    expect(commitOutcome).toMatchObject({
      kind: 'converted-confirm',
      bundleId: originalId,
    })
    const finalDirs = enumerateBundleDirs(knowledgeRoot)
    expect(finalDirs).toHaveLength(1)
    expect(finalDirs[0]!.dir).toBe(fallbackDirs[0]!.dir)
    const enrichedLoaded = loadBundle(finalDirs[0]!.dir)
    expect(enrichedLoaded.kind).toBe('loaded')
    if (enrichedLoaded.kind !== 'loaded') throw new Error('expected enriched bundle')
    expect(enrichedLoaded.bundle.manifest.id).toBe(originalId)
    expect(enrichedLoaded.bundle.summary).toBe(enrichedSummary)
    expect(enrichedLoaded.bundle.body).toBe(enrichedBody)
    expect(enrichedLoaded.bundle.provenance).toMatchObject({
      needsEnrichment: false,
      authorship: { path: 'llm', model: { id: 'capable-curator' } },
    })
    expect(enrichedLoaded.bundle.events).toHaveLength(2)
    expect(enrichedLoaded.bundle.events).toContainEqual(
      expect.objectContaining({
        type: 'confirmed',
        curationJobId: capableCandidate.candidateId,
        origin: 'agent-verified',
      }),
    )
    expect(verifyBundleIntegrity(finalDirs[0]!.dir)).toEqual({
      ok: true,
      violations: [],
    })
  })
})
