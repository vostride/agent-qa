import { rebuildAuthorizedIndex as rebuildIndex } from './fixtures/authorized-rebuild.js'
/**
 * Reader-open health and per-hit authority have deliberately different lifetimes: a healthy
 * derived index may lag append-only bundle mutations, so every result face must re-check current
 * bundle truth and suppress a supersession even before the next rebuild catches up.
 */
import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BundleOutcomeEventSchema, asRecordId } from '@vostride/agent-qa-schema'
import type { Anchor, BundleRelation } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  appendOutcomeEvent,
  appendRelation,
  openKnowledgeReader,
  scanBundleById,
  type BundleStoreConfig,
  type KnowledgeReader,
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

const PRODUCT = 'reader-recheck-store'
const ALPHA_ANCHOR: Anchor = {
  t: 'el',
  role: 'Button',
  name: 'Alpha stale action',
}
const BETA_ANCHOR: Anchor = {
  t: 'el',
  role: 'Button',
  name: 'Beta fresh action',
}

describe('IDX-02 stale-index bundle recheck', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-reader-recheck-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: PRODUCT,
    }
  }

  function input(
    anchor: Anchor,
    uniqueToken: string,
    createdAtOrdinal: number,
  ): PublishBundleInput {
    if (anchor.t !== 'el') throw new TypeError('reader recheck fixture requires an element anchor')
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          anchor,
          { t: 'page', route: `/reader-recheck/${uniqueToken}` },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: PRODUCT },
        summary: `Reader recheck shared control ${uniqueToken}`,
        body: `${uniqueToken} describes distinct current bundle authority behavior.`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: anchor.role, name: anchor.name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal,
      screenStates: [makeScreenStateFixture(createdAtOrdinal % 3)],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'reader-recheck-run',
        testId: `reader-recheck-${uniqueToken}`,
        stepIndex: createdAtOrdinal,
      },
      artifacts: [],
    }
  }

  function publish(
    anchor: Anchor,
    uniqueToken: string,
    createdAtOrdinal: number,
  ): PublishedBundle {
    const outcome = publishBundle(config(), input(anchor, uniqueToken, createdAtOrdinal))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected ${uniqueToken} publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function expectAlphaSuppressed(
    reader: KnowledgeReader,
    alpha: PublishedBundle,
    beta: PublishedBundle,
    alphaQuery: Float32Array,
  ): void {
    expect(reader).toMatchObject({ source: 'index', vec: 'vec0' })
    expect(reader.getById(alpha.id)).toBeUndefined()
    expect(reader.getById(beta.id)).toMatchObject({ bundleId: beta.id })
    expect(reader.searchLexical('alpha-only')).toEqual([])
    expect(
      reader.searchLexical('reader recheck shared control').map((hit) => hit.bundleId),
    ).toEqual([beta.id])
    expect(reader.lookupAnchor(ALPHA_ANCHOR)).toEqual([])
    expect(reader.lookupAnchor(BETA_ANCHOR)).toMatchObject([{ bundleId: beta.id }])

    const denseHits = reader.searchDense(alphaQuery, { product: PRODUCT, k: 2 })
    expect(denseHits.map((hit) => hit.bundleId)).toEqual([beta.id])
    expect(denseHits.some((hit) => hit.bundleId === alpha.id)).toBe(false)
  }

  it('blocks a post-rebuild supersession before and after the index catches up', async () => {
    const alpha = publish(ALPHA_ANCHOR, 'alpha-only', 42)
    const beta = publish(BETA_ANCHOR, 'beta-only', 43)
    const embedder = makeFakeEmbedder()
    await expect(rebuildIndex({ knowledgeRoot, embedder })).resolves.toMatchObject({
      projected: 2,
      vec: 'vec0',
    })
    const alphaSource = scanBundleById({ knowledgeRoot, bundleId: alpha.id })
    expect(alphaSource).toBeDefined()
    const alphaQuery = await embedder.embedQuery(alphaSource!.embeddingInput)

    const replacementId = asRecordId('fact-replacement-0123456789abcdef')
    expect(
      appendOutcomeEvent(
        config(),
        alpha.id,
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'reader-recheck-superseded',
          curationJobId: 'reader-recheck-superseded-job',
          buildOrdinal: 44,
          byRecordId: replacementId,
        }),
      ),
    ).toEqual({ kind: 'appended' })
    const relation: BundleRelation = {
      type: 'superseded-by',
      targetId: replacementId,
      addedAtOrdinal: 44,
      curationJobId: 'reader-recheck-relation-job',
    }
    expect(appendRelation(config(), alpha.id, relation)).toEqual({ kind: 'appended' })

    const staleReader = openKnowledgeReader(knowledgeRoot)
    try {
      expectAlphaSuppressed(staleReader, alpha, beta, alphaQuery)
    } finally {
      staleReader.close()
    }

    await expect(rebuildIndex({ knowledgeRoot, embedder })).resolves.toMatchObject({
      projected: 1,
      vec: 'vec0',
    })
    const currentReader = openKnowledgeReader(knowledgeRoot)
    try {
      expectAlphaSuppressed(currentReader, alpha, beta, alphaQuery)
    } finally {
      currentReader.close()
    }
  })
})
