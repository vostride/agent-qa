import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BundleOutcomeEventSchema,
  ORIGIN_PRIORS,
  SERVING_ATTRIBUTION_WEIGHT,
  foldBundleTrust,
  parseRecordMarkdown,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  BundleOutcomeEvent,
  OriginClass,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ARTIFACT_STEP_CAP_BYTES } from '../artifact-copy.js'
import { appendOutcomeEvent } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle, type LoadedBundle } from '../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
} from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

function expectLoaded(bundleDir: string): LoadedBundle {
  const outcome = loadBundle(bundleDir)
  expect(outcome.kind).toBe('loaded')
  if (outcome.kind !== 'loaded') throw new Error(`expected loaded bundle, got ${outcome.kind}`)
  return outcome.bundle
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('event-sourced trust derivation acceptance', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-trust-derivation-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey,
    }
  }

  function input(
    originClass: OriginClass,
    initialEvents: readonly BundleOutcomeEvent[] = [],
    artifacts: PublishBundleInput['artifacts'] = [],
  ): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture(),
      discriminant: makeDiscriminantFixture(),
      originClass,
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents,
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `trust-${originClass}-run`,
        testId: 'trust-test',
        stepIndex: 0,
      },
      artifacts,
    }
  }

  function event(
    type: 'confirmed' | 'contradicted' | 'helpful' | 'harmful',
    suffix: string,
  ): BundleOutcomeEvent {
    return BundleOutcomeEventSchema.parse({
      type,
      evidenceToken: `trust-${suffix}`,
      curationJobId: `trust-${suffix}-job`,
      buildOrdinal: 43,
      origin: 'agent-verified',
    })
  }

  it('deduplicates replay at both append and fold layers', () => {
    const storeConfig = config('trust-idempotency')
    const published = publishBundle(storeConfig, input('agent-verified'))
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected trust fixture publication')
    const confirmed = event('confirmed', 'replayed-confirmed')

    expect(appendOutcomeEvent(storeConfig, published.id, confirmed)).toEqual({ kind: 'appended' })
    expect(appendOutcomeEvent(storeConfig, published.id, confirmed)).toEqual({ kind: 'duplicate' })

    const lines = readFileSync(join(published.dir, 'evidence', 'outcomes.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
    expect(lines).toHaveLength(1)
    expect(deriveBundleTrust(expectLoaded(published.dir)).counters.confirmed).toBe(1)
    expect(
      foldBundleTrust([confirmed, confirmed], {
        originClass: 'agent-verified',
        evidenceIncomplete: false,
        createdAtOrdinal: 42,
      }).counters.confirmed,
    ).toBe(1)
  })

  it.each(['user', 'agent-verified', 'agent-observed', 'import'] as const)(
    'derives the exact %s origin-prior Beta value through the store',
    (originClass) => {
      const confirmed = event('confirmed', `${originClass}-confirmed`)
      const published = publishBundle(
        config(`trust-prior-${originClass}`),
        input(originClass, [confirmed]),
      )
      expect(published.kind).toBe('published')
      if (published.kind !== 'published') throw new Error('expected origin-prior publication')
      const prior = ORIGIN_PRIORS[originClass]
      const expected = (1 + prior.alpha) / (1 + prior.alpha + prior.beta)

      expect(deriveBundleTrust(expectLoaded(published.dir)).trust).toBe(expected)
    },
  )

  it('folds serving attribution at its fractional weight and discounts incomplete evidence', () => {
    const confirmed = event('confirmed', 'weighted-confirmed')
    const helpful = event('helpful', 'weighted-helpful')
    const harmful = event('harmful', 'weighted-harmful')
    const weightedConfig = config('trust-serving-attribution')
    const weightedPublished = publishBundle(weightedConfig, input('agent-verified', [confirmed]))
    expect(weightedPublished.kind).toBe('published')
    if (weightedPublished.kind !== 'published') throw new Error('expected weighted publication')
    expect(appendOutcomeEvent(weightedConfig, weightedPublished.id, helpful)).toEqual({
      kind: 'appended',
    })
    expect(appendOutcomeEvent(weightedConfig, weightedPublished.id, harmful)).toEqual({
      kind: 'appended',
    })
    const prior = ORIGIN_PRIORS['agent-verified']
    const expectedWeightedTrust = (
      1 + SERVING_ATTRIBUTION_WEIGHT + prior.alpha
    ) / (
      1
      + SERVING_ATTRIBUTION_WEIGHT
      + SERVING_ATTRIBUTION_WEIGHT
      + prior.alpha
      + prior.beta
    )
    expect(deriveBundleTrust(expectLoaded(weightedPublished.dir))).toMatchObject({
      trust: expectedWeightedTrust,
      counters: { confirmed: 1, helpful: 1, harmful: 1 },
    })

    const oversizedBytes = Buffer.alloc(ARTIFACT_STEP_CAP_BYTES + 1, 98)
    const oversizedSource = join(root, 'trust-oversized.bin')
    writeFileSync(oversizedSource, oversizedBytes)
    const oversizedRef: ArtifactRef = {
      id: 'trust-oversized-artifact',
      sha: sha(oversizedBytes),
    }
    const cleanPublished = publishBundle(
      config('trust-evidence-clean'),
      input('agent-verified', [confirmed]),
    )
    const incompletePublished = publishBundle(
      config('trust-evidence-incomplete'),
      input('agent-verified', [confirmed], [
        { ref: oversizedRef, sourcePath: oversizedSource, stepIndex: 0 },
      ]),
    )
    expect(cleanPublished.kind).toBe('published')
    expect(incompletePublished.kind).toBe('published')
    if (cleanPublished.kind !== 'published' || incompletePublished.kind !== 'published') {
      throw new Error('expected evidence-discount publications')
    }
    expect(incompletePublished.evidenceIncomplete).toBe(true)
    expect(deriveBundleTrust(expectLoaded(incompletePublished.dir)).trust).toBeLessThan(
      deriveBundleTrust(expectLoaded(cleanPublished.dir)).trust,
    )
  })

  it('keeps trust, counters, status, and validity out of record frontmatter', () => {
    const published = publishBundle(
      config('trust-frontmatter'),
      input('agent-verified', [event('confirmed', 'frontmatter-confirmed')]),
    )
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected frontmatter publication')
    const parsed = parseRecordMarkdown(readFileSync(join(published.dir, 'record.md'), 'utf8'))

    expect(Object.keys(parsed.frontmatter)).not.toEqual(
      expect.arrayContaining(['trust', 'counters', 'status', 'validity']),
    )
  })
})
