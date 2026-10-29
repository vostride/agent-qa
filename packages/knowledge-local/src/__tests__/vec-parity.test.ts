import { rebuildAuthorizedIndex as rebuildIndex } from './fixtures/authorized-rebuild.js'
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  openKnowledgeReader,
  scanBundleById,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const PRODUCT_A = 'parity-alpha'
const PRODUCT_B = 'parity-beta'
const BUNDLE_COUNT = 24

// Vec0 stores Float32 while brute search sums in float64, so the two distances differ slightly.
const PARITY_DISTANCE_TOLERANCE = 1e-5

describe('vec0 and brute dense-search parity', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-vec-parity-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function input(productKey: string, ordinal: number): PublishBundleInput {
    const label = `${productKey} vector fixture ${ordinal.toString().padStart(2, '0')} action`
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: label },
          { t: 'page', route: `/${productKey}/fixture-${ordinal}` },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: productKey },
        summary: `${label} summary with deterministic parity token ${ordinal}`,
        body: `${label} body describes distinct retrieval behavior for corpus row ${ordinal}.`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: label },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: ordinal,
      screenStates: [makeScreenStateFixture(ordinal % 3)],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `vec-parity-${productKey}-run`,
        testId: `vec-parity-${ordinal}`,
        stepIndex: ordinal,
      },
      artifacts: [],
    }
  }

  function publish(productKey: string, ordinal: number): PublishedBundle {
    const outcome = publishBundle(config(productKey), input(productKey, ordinal))
    if (outcome.kind !== 'published') {
      throw new Error(
        `expected ${productKey} fixture ${ordinal} publication, got ${outcome.kind}`,
      )
    }
    return outcome
  }

  it('returns identical ids, ordering, and bounded distances for deterministic queries', async () => {
    const published = Array.from({ length: BUNDLE_COUNT }, (_, index) => {
      const product = index < BUNDLE_COUNT / 2 ? PRODUCT_A : PRODUCT_B
      return { product, bundle: publish(product, index + 1) }
    })
    const embeddingInputs = published.map(({ bundle }) => {
      const hit = scanBundleById({ knowledgeRoot, bundleId: bundle.id })
      expect(hit).toBeDefined()
      return hit!.embeddingInput
    })
    expect(new Set(embeddingInputs)).toHaveProperty('size', BUNDLE_COUNT)

    const embedder = makeFakeEmbedder()
    await expect(rebuildIndex({ knowledgeRoot, embedder })).resolves.toMatchObject({
      projected: BUNDLE_COUNT,
      vec: 'vec0',
    })

    const vecReader = openKnowledgeReader(knowledgeRoot)
    const bruteReader = openKnowledgeReader(knowledgeRoot, {
      vecLoadablePath: join(root, 'nonexistent-sqlite-vec-extension'),
    })
    try {
      expect(vecReader).toMatchObject({ source: 'index', vec: 'vec0' })
      expect(bruteReader).toMatchObject({ source: 'index', vec: 'brute' })

      const queryTexts = [
        'find the alpha checkout control',
        'locate a beta settings action',
        'deterministic cross-product retrieval',
        'vector parity query number four',
        'final fixed fake-embedder query',
      ]
      const queryVectors = await Promise.all(
        queryTexts.map((queryText) => embedder.embedQuery(queryText)),
      )

      for (const query of queryVectors) {
        for (const k of [1, 5, 10]) {
          const vecHits = vecReader.searchDense(query, { k })
          const bruteHits = bruteReader.searchDense(query, { k })

          expect(vecHits.map((hit) => hit.bundleId)).toEqual(
            bruteHits.map((hit) => hit.bundleId),
          )
          expect(vecHits).toHaveLength(k)
          for (let index = 0; index < vecHits.length; index += 1) {
            expect(
              Math.abs(vecHits[index]!.distance - bruteHits[index]!.distance),
            ).toBeLessThanOrEqual(PARITY_DISTANCE_TOLERANCE)
          }
        }
      }

      const productBIds = new Set(
        published
          .filter(({ product }) => product === PRODUCT_B)
          .map(({ bundle }) => String(bundle.id)),
      )
      for (const reader of [vecReader, bruteReader]) {
        const scopedHits = reader.searchDense(queryVectors[0]!, {
          product: PRODUCT_A,
          k: 10,
        })
        expect(scopedHits).toHaveLength(10)
        expect(scopedHits.every((hit) => hit.product === PRODUCT_A)).toBe(true)
        expect(scopedHits.some((hit) => productBIds.has(hit.bundleId))).toBe(false)
      }
    } finally {
      vecReader.close()
      bruteReader.close()
    }
  // Full-workspace contention has exceeded 15s; this is a correctness oracle,
  // with the distance tolerance above, rather than a wall-clock performance check.
  }, 30_000)
})
