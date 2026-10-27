import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import {
  asRecordId,
  BundleOutcomeEventSchema,
  canonicalJson,
  normalizeAnchor,
} from '@vostride/agent-qa-schema'
import type { Anchor, BundleRelation } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendOutcomeEvent, appendRelation } from '../bundle-append.js'
import { loadBundle, verifyBundleIntegrity } from '../bundle-read.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../bundle-publish.test-helper.js'
import { openKnowledgeReader } from '../index-reader.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

async function scanApi() {
  return import('../bundle-scan.js')
}

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

describe('IDX-02 authoritative degraded bundle scan', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-scan-'))
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

  function input(overrides: Partial<PublishBundleInput> = {}): PublishBundleInput {
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
        runId: 'bundle-scan-run',
        testId: 'bundle-scan-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
  }

  function publish(product: string, overrides: Partial<PublishBundleInput> = {}): PublishedBundle {
    const outcome = publishBundle(config(product), input(overrides))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error(`expected publication, got ${outcome.kind}`)
    return outcome
  }

  it(
    'matches every text token case-insensitively across renderings, summaries, and raw anchors',
    async () => {
      const { scanBundles } = await scanApi()
      const selector: Anchor = { t: 'selector', literal: '#exact-login-control' }
      const published = publish('storefront', {
        draft: makeBundleDraftFixture({
          anchors: [
            { t: 'el', role: 'Button', name: 'Sign In' },
            { t: 'page', route: '/login' },
            selector,
          ],
        }),
      })
      publish('checkout', {
        draft: makeBundleDraftFixture({
          anchors: [{ t: 'el', role: 'Button', name: 'Checkout now' }],
          summary: 'Checkout control on the cart page',
          body: 'Selecting Checkout now opens the payment page.',
        }),
      })

      const signInHits = scanBundles({ knowledgeRoot, text: 'sIgN IN' })
      expect(signInHits).toHaveLength(1)
      expect(signInHits[0]).toMatchObject({
        bundleId: published.id,
        product: 'storefront',
        kind: 'fact',
        subtype: 'selector',
        status: 'candidate',
        validity: { openedAtOrdinal: 42 },
        summary: makeBundleDraftFixture().summary,
      })
      expect(signInHits[0]?.trust).toBeCloseTo(2 / 3)
      expect(signInHits[0]?.embeddingInput).toEqual(expect.any(String))
      expect(scanBundles({ knowledgeRoot, text: '#EXACT-LOGIN-CONTROL' })).toHaveLength(1)
      expect(scanBundles({ knowledgeRoot, text: 'sign checkout' })).toEqual([])
      expect(scanBundles({ knowledgeRoot, product: 'storefront', k: 1 })).toHaveLength(1)
    },
  )

  it('matches canonical normalized anchors and composes anchor and text filters', async () => {
    const { scanBundles } = await scanApi()
    const published = publish('anchor-store')
    const query: Anchor = { t: 'el', role: ' button ', name: ' SIGN   IN ' }

    expect(canonicalJson(normalizeAnchor(query))).toBe(
      canonicalJson(normalizeAnchor({ t: 'el', role: 'Button', name: 'Sign in' })),
    )
    expect(scanBundles({ knowledgeRoot, anchor: query })).toMatchObject([
      { bundleId: published.id, product: 'anchor-store' },
    ])
    expect(scanBundles({ knowledgeRoot, anchor: query, text: 'account page' })).toHaveLength(1)
    expect(scanBundles({ knowledgeRoot, anchor: query, text: 'checkout' })).toEqual([])
  })

  it('excludes superseded and closed bundles from both scan faces', async () => {
    const {
      isServable,
      readCanonicalBundleAnchors,
      scanBundleById,
      scanBundles,
    } = await scanApi()
    const storeConfig = config('withdrawn-store')
    const published = publish('withdrawn-store')
    const superseded = BundleOutcomeEventSchema.parse({
      type: 'superseded',
      evidenceToken: 'bundle-scan-superseded',
      curationJobId: 'bundle-scan-superseded-job',
      buildOrdinal: 43,
      byRecordId: 'fact-replacement-0123456789abcdef',
    })
    const close = BundleOutcomeEventSchema.parse({
      type: 'window-close',
      evidenceToken: 'bundle-scan-window-close',
      curationJobId: 'bundle-scan-window-close-job',
      buildOrdinal: 44,
      closedAtOrdinal: 44,
    })
    const relation: BundleRelation = {
      type: 'superseded-by',
      targetId: 'fact-replacement-0123456789abcdef',
      addedAtOrdinal: 43,
      curationJobId: 'bundle-scan-relation-job',
    }
    expect(appendOutcomeEvent(storeConfig, published.id, superseded)).toEqual({ kind: 'appended' })
    expect(appendRelation(storeConfig, published.id, relation)).toEqual({ kind: 'appended' })
    expect(appendOutcomeEvent(storeConfig, published.id, close)).toEqual({ kind: 'appended' })

    const baseTrust = {
      trust: 0.5,
      counters: { confirmed: 0, contradicted: 0, helpful: 0, harmful: 0 },
      validity: { openedAtOrdinal: 1 },
      lastConfirmedOrdinal: 1,
    }
    expect(isServable({ ...baseTrust, status: 'candidate' })).toBe(true)
    expect(isServable({ ...baseTrust, status: 'active' })).toBe(true)
    expect(isServable({ ...baseTrust, status: 'superseded' })).toBe(false)
    expect(
      isServable({
        ...baseTrust,
        status: 'candidate',
        validity: { openedAtOrdinal: 1, closedAtOrdinal: 2 },
      }),
    ).toBe(false)
    expect(scanBundles({ knowledgeRoot })).toEqual([])
    expect(scanBundleById({ knowledgeRoot, bundleId: published.id })).toBeUndefined()
    expect(readCanonicalBundleAnchors({
      knowledgeRoot,
      bundleId: published.id,
    })).toMatchObject({
      kind: 'resolved',
      bundleId: published.id,
      product: 'withdrawn-store',
      anchors: makeBundleDraftFixture().anchors.map(normalizeAnchor),
    })
  })

  it('skips incomplete bundles and excludes derived partitions and dot entries', async () => {
    const { enumerateBundleDirs, scanBundles } = await scanApi()
    const source = publish('manifest-source')
    const manifest = JSON.parse(readFileSync(join(source.dir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const incompleteDir = join(knowledgeRoot, 'memory', 'partial', 'bundles', 'half-written')
    mkdirSync(incompleteDir, { recursive: true })
    writeFileSync(
      join(incompleteDir, 'manifest.json'),
      `${JSON.stringify({ ...manifest, complete: false })}\n`,
      'utf8',
    )
    mkdirSync(join(knowledgeRoot, 'memory', 'partial', 'bundles', '.staging', 'ignored'), {
      recursive: true,
    })
    mkdirSync(join(knowledgeRoot, 'memory', '.hidden', 'bundles', 'ignored'), { recursive: true })
    mkdirSync(join(knowledgeRoot, 'memory', 'index', 'bundles', 'ignored'), { recursive: true })
    mkdirSync(join(knowledgeRoot, 'memory', 'queue', 'bundles', 'ignored'), { recursive: true })

    expect(() => scanBundles({ knowledgeRoot, product: 'partial' })).not.toThrow()
    expect(scanBundles({ knowledgeRoot, product: 'partial' })).toEqual([])
    expect(enumerateBundleDirs(knowledgeRoot)).toEqual([
      { product: 'manifest-source', dir: source.dir },
      { product: 'partial', dir: incompleteDir },
    ])
  })

  it('resolves native Windows names and refuses record-only cross-product ambiguity', async () => {
    const {
      bundleDirRecordId,
      resolveProductQualifiedBundleDir,
    } = await scanApi()
    const first = publish('alpha-product')
    const second = publish('beta-product')
    expect(second.id).toBe(first.id)

    expect(bundleDirRecordId(win32.join('C:\\knowledge', 'bundles', first.id))).toBe(first.id)
    expect(() => resolveProductQualifiedBundleDir({
      knowledgeRoot,
      recordId: first.id,
    })).toThrow(/ambiguous/i)
    expect(resolveProductQualifiedBundleDir({
      knowledgeRoot,
      product: 'beta-product',
      recordId: first.id,
    })).toEqual({
      product: 'beta-product',
      recordId: first.id,
      dir: second.dir,
    })
  })

  it('refuses a parseable digest tamper across every degraded scan face', async () => {
    const { readCanonicalBundleAnchors, scanBundleById, scanBundles } = await scanApi()
    const tampered = publish('integrity-product', {
      draft: makeBundleDraftFixture({
        anchors: [{ t: 'selector', literal: '#integrity-alpha' }],
        summary: 'Shared integrity alpha control',
        body: 'Shared integrity alpha remains parseable after mutation.',
      }),
    })
    const healthy = publish('integrity-product', {
      draft: makeBundleDraftFixture({
        anchors: [{ t: 'selector', literal: '#integrity-beta' }],
        summary: 'Shared integrity beta control',
        body: 'Shared integrity beta remains authoritative.',
      }),
    })
    const recordPath = join(tampered.dir, 'record.md')
    writeFileSync(
      recordPath,
      readFileSync(recordPath, 'utf8').replace(
        'Shared integrity alpha control',
        'Shared integrity altered control',
      ),
      'utf8',
    )

    expect(loadBundle(tampered.dir).kind).toBe('loaded')
    expect(verifyBundleIntegrity(tampered.dir).ok).toBe(false)
    expect(scanBundles({ knowledgeRoot, text: 'shared integrity' }).map((hit) => hit.bundleId))
      .toEqual([healthy.id])
    expect(scanBundleById({ knowledgeRoot, bundleId: tampered.id })).toBeUndefined()
    expect(scanBundleById({ knowledgeRoot, bundleId: healthy.id })).toMatchObject({
      bundleId: healthy.id,
    })
    expect(readCanonicalBundleAnchors({
      knowledgeRoot,
      bundleId: tampered.id,
    })).toMatchObject({ kind: 'unresolved', reason: 'invalid' })
    expect(readCanonicalBundleAnchors({
      knowledgeRoot,
      bundleId: healthy.id,
    })).toMatchObject({ kind: 'resolved', bundleId: healthy.id })

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.source).toBe('scan')
      expect(reader.getById(tampered.id)).toBeUndefined()
      expect(reader.getById(healthy.id)).toMatchObject({ bundleId: healthy.id })
    } finally {
      reader.close()
    }
  })

  it('sorts bundle directories and resolves ids across products', async () => {
    const { enumerateBundleDirs, readCanonicalBundleAnchors, scanBundleById } = await scanApi()
    const published = publish('z-product')
    const manual = [
      ['beta', 'bundle-b'],
      ['alpha', 'bundle-c'],
      ['beta', 'bundle-a'],
    ] as const
    for (const [product, bundle] of manual) {
      mkdirSync(join(knowledgeRoot, 'memory', product, 'bundles', bundle), { recursive: true })
    }

    expect(enumerateBundleDirs(knowledgeRoot).map(({ product, dir }) => [product, dir])).toEqual([
      ['alpha', join(knowledgeRoot, 'memory', 'alpha', 'bundles', 'bundle-c')],
      ['beta', join(knowledgeRoot, 'memory', 'beta', 'bundles', 'bundle-a')],
      ['beta', join(knowledgeRoot, 'memory', 'beta', 'bundles', 'bundle-b')],
      ['z-product', published.dir],
    ])
    expect(scanBundleById({ knowledgeRoot, bundleId: published.id })).toMatchObject({
      bundleId: published.id,
      product: 'z-product',
      status: 'candidate',
    })
    expect(scanBundleById({ knowledgeRoot, bundleId: 'missing-bundle' })).toBeUndefined()
    expect(readCanonicalBundleAnchors({
      knowledgeRoot,
      bundleId: asRecordId('missing-bundle'),
    })).toEqual({ kind: 'unresolved', reason: 'not-found' })
  })
})
