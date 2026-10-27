import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BIMODAL_MIN_MODE_N,
  CUSUM_DECISION_H,
  CUSUM_SLACK_K,
  DRIFT_RELATIVE_THRESHOLD,
  DRIFT_SIGMA_K,
  MEASUREMENT_MIN_N,
  asEvidenceToken,
  canonicalJson,
  decideMeasurementDrift,
  foldMeasurements,
  shrunkSigma,
  type Anchor,
  type BundleDraft,
  type ExecutionContext,
  type MeasurementBaseline,
  type MeasurementObservation,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyIndexDeltaForBundle,
  deriveBundleTrust,
  drainQueue,
  enumerateBundleDirs,
  loadBundle,
  readMeasurements,
  writeMeasurementBaseline,
  type CuratorAuthor,
  type LoadedBundle,
} from '../../index.js'
import { publishBundle } from '../../bundle-publish.test-helper.js'
import {
  enqueueArtifactFreeCandidateProjection,
  type ArtifactFreeCandidateProjectionInput,
} from '../../__tests__/fixtures/curation-candidate-fixture.js'

const scope = { tier: 'product', key: 'storefront' } as const
const NO_INDEX_MAINTENANCE = {
  indexAbsent: false,
  pendingEmbeddings: 0,
  renderingEpochStale: false,
  vectorReconciliationOutstanding: false,
} as const
const ACCEPTANCE_TIMEOUT_MS = 30_000

interface MeasurementFixture {
  id: RecordId
  dir: string
  metric: string
  anchors: Anchor[]
  baseline: MeasurementBaseline
}

describe('queue-to-commit measurement drift acceptance (DCAY-02)', () => {
  let root: string
  let knowledgeRoot: string
  let fallbackAuthor: ReturnType<typeof vi.fn<CuratorAuthor>>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-drift-supersede-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    fallbackAuthor = vi.fn<CuratorAuthor>(async () => ({
      kind: 'fallback-required',
      reason: 'no-model',
    }))
  }, ACCEPTANCE_TIMEOUT_MS)

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  }, ACCEPTANCE_TIMEOUT_MS)

  function measurementAnchors(metric: string): Anchor[] {
    return [
      { t: 'el', role: 'status', name: `${metric} reading`, ordinal: 0 },
      { t: 'flow', name: `measurement:${metric}` },
      { t: 'platform', platform: 'web' },
    ]
  }

  function seedBaseline(
    seed: string,
    baseline: MeasurementBaseline,
  ): MeasurementFixture {
    const metric = `reported-value-${seed}`
    const anchors = measurementAnchors(metric)
    const draft: BundleDraft = {
      kind: 'fact',
      subtype: 'measurement',
      anchors,
      scope,
      summary: `${metric} measured as ${baseline.mu0}`,
      body: `Verified ${metric} value: ${baseline.mu0}.`,
      distilledEvidenceRef: {
        id: `baseline-${seed}`,
        sha: seed.padEnd(64, 'a').slice(0, 64),
      },
      originStage: 'run-curation',
    }
    const published = publishBundle({
      knowledgeRoot,
      productKey: scope.key,
      writerLeaseId: 'drift-acceptance-fixture',
    }, {
      draft,
      discriminant: {
        kind: 'fact',
        subtype: 'measurement',
        metricKey: canonicalJson({ anchors }),
      },
      originClass: 'agent-verified',
      createdAtOrdinal: baseline.openedAtOrdinal,
      screenStates: [],
      initialEvents: [
        {
          type: 'confirmed',
          evidenceToken: asEvidenceToken(`baseline-confirmed-${seed}`),
          curationJobId: `baseline-job-${seed}`,
          buildOrdinal: baseline.openedAtOrdinal,
          origin: 'agent-verified',
        },
        {
          type: 'promoted',
          evidenceToken: asEvidenceToken(`baseline-promoted-${seed}`),
          curationJobId: `baseline-job-${seed}`,
          buildOrdinal: baseline.openedAtOrdinal,
        },
      ],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'stable measurement baseline acceptance fixture',
      },
      artifacts: [],
      evidenceMarkdown: `Stable ${metric} baseline.\n`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: `${metric}-baseline`, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `status:${metric} reading:0` },
          observedAtOrdinal: baseline.openedAtOrdinal,
        },
      ],
    })
    if (published.kind !== 'published') {
      throw new Error(`expected baseline publish, got ${published.kind}`)
    }
    expect(baseline.n0).toBeGreaterThanOrEqual(MEASUREMENT_MIN_N)
    expect(writeMeasurementBaseline({
      knowledgeRoot,
      productKey: scope.key,
      writerLeaseId: 'drift-acceptance-fixture',
    }, published.id, baseline)).toEqual({ kind: 'appended' })
    applyIndexDeltaForBundle({ knowledgeRoot, bundleId: published.id })
    return { id: published.id, dir: published.dir, metric, anchors, baseline }
  }

  function projection(
    fixture: MeasurementFixture,
    value: number,
    buildOrdinal: number,
    executionContext: ExecutionContext,
  ): ArtifactFreeCandidateProjectionInput {
    return {
      sourceRunId: `run-${fixture.metric}-${buildOrdinal}`,
      scope,
      buildOrdinal,
      executionContext,      kind: 'fact',
      subtype: 'measurement',
      anchors: fixture.anchors,
      summarySeed: `${fixture.metric} measured as ${value}`,
      bodySeed: `Verified ${fixture.metric} value: ${value}.`,
      distilledObservations: [
        {
          schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
          step: { naturalKey: `${fixture.metric}-${buildOrdinal}`, ordinal: 0 },
          platform: 'web',
          element: { naturalKey: `status:${fixture.metric} reading:0` },
          observedAtOrdinal: buildOrdinal,
        },
      ],
      evidenceToken: `${fixture.metric}-evidence-${buildOrdinal}-${value}`,
      attributingObservationId: `${fixture.metric}-observation-${buildOrdinal}`,
      emittedAt: '2026-07-16T00:00:00.000Z',
    }
  }

  async function drainValue(
    fixture: MeasurementFixture,
    value: number,
    buildOrdinal: number,
    executionContext: ExecutionContext = 'local-interactive',
  ) {
    const queued = enqueueArtifactFreeCandidateProjection({
      knowledgeRoot,
      projectionInput: projection(fixture, value, buildOrdinal, executionContext),
    })
    expect(queued.kind).toBe('enqueued')
    if (queued.kind !== 'enqueued') throw new Error(`expected enqueue, got ${queued.kind}`)

    const report = await drainQueue({
      knowledgeRoot,
      author: fallbackAuthor,
      executionContext,
      operations: {
        readRebuildRequest: () => ({ present: false }),
        readIndexMaintenanceState: () => NO_INDEX_MAINTENANCE,
        // GC is a separately accepted drain-tail concern. Keeping it inert here isolates the
        // queue → fallback → commit contract and avoids multiplying unrelated filesystem scans.
        runKnowledgeGc: () => ({
          trimmedRecordIds: [],
          skipped: { unknownRef: 0, withinK: 0, userOrigin: 0, horizon: 0 },
        }),
      },
    })
    expect(report).toMatchObject({
      kind: 'drained',
      jobsProcessed: 1,
      committed: 1,
      failures: 0,
    })
    return report
  }

  async function drainValues(
    fixture: MeasurementFixture,
    values: readonly number[],
    firstBuildOrdinal = fixture.baseline.openedAtOrdinal + 1,
    executionContext: ExecutionContext = 'local-interactive',
  ) {
    const reports = []
    for (const [index, value] of values.entries()) {
      reports.push(
        await drainValue(fixture, value, firstBuildOrdinal + index, executionContext),
      )
    }
    return reports
  }

  function loadedBundles(): Array<{ dir: string; bundle: LoadedBundle }> {
    return enumerateBundleDirs(knowledgeRoot).map(({ dir }) => {
      const loaded = loadBundle(dir)
      if (loaded.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${loaded.kind}`)
      return { dir, bundle: loaded.bundle }
    })
  }

  function loadedById(id: RecordId): { dir: string; bundle: LoadedBundle } {
    const loaded = loadedBundles().find(({ bundle }) => bundle.manifest.id === id)
    if (loaded === undefined) throw new Error(`missing bundle ${id}`)
    return loaded
  }

  function measurementLines(
    baseline: MeasurementBaseline,
    values: readonly number[],
    firstBuildOrdinal = baseline.openedAtOrdinal + 1,
  ): MeasurementObservation[] {
    return values.map((value, index) => ({
      value,
      buildOrdinal: firstBuildOrdinal + index,
      evidenceToken: `decision-evidence-${index}`,
      curationJobId: `decision-job-${index}`,
    }))
  }

  function decisionFor(
    baseline: MeasurementBaseline,
    values: readonly number[],
  ) {
    const observations = measurementLines(baseline, values)
    return decideMeasurementDrift({
      baseline,
      state: foldMeasurements(baseline, observations),
      windowBuilds: { observations },
    })
  }

  function sigmaThresholdValues(baseline: MeasurementBaseline): number[] {
    const sigma = shrunkSigma(baseline.sigma0, baseline.n0, baseline.mu0)
    const delta = (DRIFT_SIGMA_K + 1) * sigma
    expect(delta).toBeLessThan(
      DRIFT_RELATIVE_THRESHOLD * Math.abs(baseline.mu0),
    )
    return Array.from({ length: MEASUREMENT_MIN_N }, () => baseline.mu0 + delta)
  }

  function assertFallbackAuthorship(bundle: LoadedBundle): void {
    expect(bundle.provenance).toMatchObject({
      mode: 'run-linked',
      authorship: { path: 'deterministic-fallback' },
    })
    if (bundle.provenance.mode !== 'run-linked') {
      throw new Error('expected run-linked drift provenance')
    }
    expect(bundle.provenance.authorship).not.toHaveProperty('model')
  }

  function assertBornActive(
    fixture: MeasurementFixture,
    finalValue: number,
    finalBuildOrdinal: number,
  ): { victim: LoadedBundle; replacement: LoadedBundle } {
    const victim = loadedById(fixture.id).bundle
    expect(deriveBundleTrust(victim)).toMatchObject({
      status: 'superseded',
      validity: {
        openedAtOrdinal: fixture.baseline.openedAtOrdinal,
        closedAtOrdinal: finalBuildOrdinal,
      },
    })
    expect(victim.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'superseded', buildOrdinal: finalBuildOrdinal }),
      expect.objectContaining({ type: 'window-close', closedAtOrdinal: finalBuildOrdinal }),
    ]))

    const replacements = loadedBundles().filter(
      ({ bundle }) => bundle.manifest.id !== fixture.id && bundle.frontmatter.kind === 'fact',
    )
    expect(replacements).toHaveLength(1)
    const replacementEntry = replacements[0]!
    const replacement = replacementEntry.bundle
    assertFallbackAuthorship(replacement)
    expect(deriveBundleTrust(replacement).status).toBe('active')
    expect(replacement.events.filter(({ type }) => type === 'promoted')).toHaveLength(1)
    expect(replacement.relations.relations).toContainEqual(expect.objectContaining({
      type: 'supersedes',
      targetId: fixture.id,
    }))
    expect(readMeasurements(replacementEntry.dir)).toEqual({
      baseline: {
        mu0: finalValue,
        sigma0: 0,
        n0: 1,
        openedAtOrdinal: finalBuildOrdinal,
      },
      observations: [],
    })
    return { victim, replacement }
  }

  it('supersedes a stable 3·sigma drift and births the replacement active in one drain', async () => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 1,
      n0: MEASUREMENT_MIN_N * 20,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline('sigma-threshold', baseline)
    const values = sigmaThresholdValues(baseline)
    expect(decisionFor(baseline, values)).toEqual({
      decision: 'supersede',
      reason: 'threshold',
    })

    await drainValues(fixture, values)

    assertBornActive(fixture, values.at(-1)!, baseline.openedAtOrdinal + values.length)
    expect(readMeasurements(fixture.dir)?.observations).toHaveLength(
      MEASUREMENT_MIN_N - 1,
    )
  }, ACCEPTANCE_TIMEOUT_MS)

  it.each([
    { direction: 'rise', sign: 1 },
    { direction: 'drop', sign: -1 },
  ] as const)('supersedes a small-sigma relative $direction past ±50%', async ({ sign }) => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 0,
      n0: MEASUREMENT_MIN_N,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline(`relative-${sign}`, baseline)
    const relativeWall = DRIFT_RELATIVE_THRESHOLD * Math.abs(baseline.mu0)
    const delta = relativeWall + relativeWall / MEASUREMENT_MIN_N
    expect(delta).toBeGreaterThan(relativeWall)
    expect(delta).toBeLessThan(
      DRIFT_SIGMA_K * shrunkSigma(baseline.sigma0, baseline.n0, baseline.mu0),
    )
    const values = Array.from(
      { length: MEASUREMENT_MIN_N },
      () => baseline.mu0 + sign * delta,
    )
    expect(decisionFor(baseline, values)).toEqual({
      decision: 'supersede',
      reason: 'relative',
    })

    await drainValues(fixture, values)

    assertBornActive(fixture, values.at(-1)!, baseline.openedAtOrdinal + values.length)
  }, ACCEPTANCE_TIMEOUT_MS)

  it('widens below min-n with one measurement line and Confirm but no supersession', async () => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 1,
      n0: MEASUREMENT_MIN_N,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline('young-widen', baseline)
    const value = baseline.mu0 * (1 + DRIFT_RELATIVE_THRESHOLD)
    const before = readMeasurements(fixture.dir)
    expect(decisionFor(baseline, [value])).toEqual({
      decision: 'widen',
      reason: 'below-min-n',
    })

    await drainValue(fixture, value, baseline.openedAtOrdinal + 1)

    expect(loadedBundles()).toHaveLength(1)
    const victim = loadedById(fixture.id)
    const measurements = readMeasurements(victim.dir)
    expect(measurements?.observations).toHaveLength((before?.observations.length ?? 0) + 1)
    expect(victim.bundle.events.filter(({ type }) => type === 'confirmed')).toHaveLength(2)
    expect(victim.bundle.events.some(({ type }) => type === 'superseded')).toBe(false)
    expect(deriveBundleTrust(victim.bundle).status).toBe('active')
  }, ACCEPTANCE_TIMEOUT_MS)

  it('widens stable bimodal oscillation across repeated drains without thrash unknowns', async () => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: DRIFT_RELATIVE_THRESHOLD * 100,
      n0: MEASUREMENT_MIN_N * 20,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline('bimodal-widen', baseline)
    const low = baseline.mu0
    const high = baseline.mu0 + (
      DRIFT_RELATIVE_THRESHOLD
      * Math.abs(baseline.mu0)
      * (DRIFT_SIGMA_K - CUSUM_SLACK_K)
    )
    const firstWave = [
      ...Array.from({ length: BIMODAL_MIN_MODE_N }, () => low),
      ...Array.from({ length: BIMODAL_MIN_MODE_N }, () => high),
    ]
    const secondWave = [low, high, low, high]
    expect(decisionFor(baseline, firstWave)).toEqual({
      decision: 'widen',
      reason: 'stable-multimodal',
    })
    expect(decisionFor(baseline, [...firstWave, ...secondWave])).toEqual({
      decision: 'widen',
      reason: 'stable-multimodal',
    })

    await drainValues(fixture, firstWave)
    await drainValues(
      fixture,
      secondWave,
      baseline.openedAtOrdinal + firstWave.length + 1,
    )

    expect(loadedBundles()).toHaveLength(1)
    const victim = loadedById(fixture.id)
    expect(readMeasurements(victim.dir)?.observations).toHaveLength(
      firstWave.length + secondWave.length,
    )
    expect(victim.bundle.events.some(({ type }) => type === 'superseded')).toBe(false)
    expect(deriveBundleTrust(victim.bundle).status).toBe('active')
    expect(
      loadedBundles().filter(({ bundle }) => bundle.frontmatter.kind === 'unknown'),
    ).toHaveLength(0)
  }, ACCEPTANCE_TIMEOUT_MS)

  it('accumulates a monotone sub-threshold slow walk to a CUSUM supersede', async () => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 10,
      n0: MEASUREMENT_MIN_N * 20,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline('cusum-walk', baseline)
    const sigma = shrunkSigma(baseline.sigma0, baseline.n0, baseline.mu0)
    const values = Array.from(
      { length: MEASUREMENT_MIN_N + 1 },
      (_, index) => baseline.mu0 + sigma * (
        CUSUM_SLACK_K * 2 + index / CUSUM_DECISION_H
      ),
    )
    for (const [index, value] of values.entries()) {
      if (index > 0) expect(value).toBeGreaterThan(values[index - 1]!)
    }
    expect(decisionFor(baseline, values.slice(0, -1)).decision).toBe('widen')
    expect(decisionFor(baseline, values)).toEqual({
      decision: 'supersede',
      reason: 'cusum',
    })

    await drainValues(fixture, values)

    assertBornActive(fixture, values.at(-1)!, baseline.openedAtOrdinal + values.length)
  }, ACCEPTANCE_TIMEOUT_MS)

  it('commits identical confirmed drift as candidate + proposed relation in propose-only', async () => {
    const baseline: MeasurementBaseline = {
      mu0: 100,
      sigma0: 1,
      n0: MEASUREMENT_MIN_N * 20,
      openedAtOrdinal: 1,
    }
    const fixture = seedBaseline('propose-only', baseline)
    const values = sigmaThresholdValues(baseline)
    expect(decisionFor(baseline, values)).toEqual({
      decision: 'supersede',
      reason: 'threshold',
    })

    await drainValues(fixture, values, baseline.openedAtOrdinal + 1, 'ci')

    const victim = loadedById(fixture.id).bundle
    expect(deriveBundleTrust(victim)).toMatchObject({
      status: 'active',
      validity: { openedAtOrdinal: baseline.openedAtOrdinal },
    })
    expect(victim.events.some(({ type }) => type === 'superseded')).toBe(false)
    expect(victim.events.some(({ type }) => type === 'window-close')).toBe(false)

    const candidates = loadedBundles().filter(
      ({ bundle }) => bundle.manifest.id !== fixture.id && bundle.frontmatter.kind === 'fact',
    )
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!.bundle
    assertFallbackAuthorship(candidate)
    expect(deriveBundleTrust(candidate).status).toBe('candidate')
    expect(candidate.events.some(({ type }) => type === 'promoted')).toBe(false)
    expect(candidate.relations.relations).toContainEqual(expect.objectContaining({
      type: 'proposed-supersession-of',
      targetId: fixture.id,
    }))
    expect(readMeasurements(candidates[0]!.dir)?.baseline.mu0).toBe(values.at(-1))
    expect(fallbackAuthor).toHaveBeenCalledTimes(values.length)
  }, ACCEPTANCE_TIMEOUT_MS)
})
