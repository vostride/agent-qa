import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  BundleOutcomeEventSchema,
  slugBranch,
} from '@vostride/agent-qa-schema'
import type { Anchor } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { rebuildAuthorizedIndex } from './fixtures/authorized-rebuild.js'
import * as knowledgeLocal from '../index.js'
import { appendOutcomeEvent } from '../bundle-append.js'
import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeDiscriminantFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'
import { makeFakeEmbedder } from './fixtures/fake-embedder.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

interface ReaderOptions {
  product?: string
  k?: number
}

interface KnowledgeReader {
  source: 'index' | 'scan'
  vec: 'vec0' | 'brute' | 'none'
  getById(bundleId: string): knowledgeLocal.KnowledgeHit | undefined
  searchLexical(text: string, opts?: ReaderOptions): knowledgeLocal.KnowledgeHit[]
  lookupAnchor(anchor: Anchor, opts?: ReaderOptions): knowledgeLocal.KnowledgeHit[]
  searchDense(
    embedding: Float32Array,
    opts: ReaderOptions & { k: number },
  ): Array<knowledgeLocal.KnowledgeHit & { distance: number }>
  recheck(hits: readonly knowledgeLocal.KnowledgeHit[]): knowledgeLocal.KnowledgeHit[]
  close(): void
}

interface KnowledgeReaderApi {
  openKnowledgeReader(
    knowledgeRoot: string,
    opts?: { vecLoadablePath?: string },
  ): KnowledgeReader
}

function readerApi(): KnowledgeReaderApi {
  const candidate = knowledgeLocal as unknown as Partial<KnowledgeReaderApi>
  if (typeof candidate.openKnowledgeReader !== 'function') {
    throw new Error('openKnowledgeReader public API is not implemented')
  }
  return candidate as KnowledgeReaderApi
}

describe('degrading knowledge reader', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-index-reader-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function config(productKey = 'storefront'): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function input(overrides: Partial<PublishBundleInput> = {}): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Sign in' },
          { t: 'page', route: '/login' },
          { t: 'selector', literal: '#sign-in' },
          { t: 'platform', platform: 'web' },
        ],
      }),
      discriminant: makeDiscriminantFixture(),
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'index-reader-run',
        testId: 'index-reader-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
  }

  function publishFor(
    productKey: string,
    overrides: Partial<PublishBundleInput> = {},
  ): PublishedBundle {
    const outcome = publishBundle(config(productKey), input(overrides))
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function publish(overrides: Partial<PublishBundleInput> = {}): PublishedBundle {
    return publishFor('storefront', overrides)
  }

  function publishNamed(
    productKey: string,
    label: string,
    selector = `#${slugBranch(label)}`,
  ): PublishedBundle {
    const key = slugBranch(label)
    return publishFor(productKey, {
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: label },
          { t: 'page', route: `/${key}` },
          { t: 'selector', literal: selector },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: slugBranch(productKey) },
        summary: `${label} control`,
        body: `Selecting ${label} performs the recorded action.`,
      }),
    })
  }

  function expectMarker(reason: knowledgeLocal.RebuildReason): void {
    expect(knowledgeLocal.readRebuildRequest(knowledgeRoot)).toMatchObject({
      present: true,
      request: { reason },
    })
  }

  function expectScanServes(reader: KnowledgeReader, published: PublishedBundle): void {
    expect(reader).toMatchObject({ source: 'scan', vec: 'none' })
    expect(reader.getById(published.id)).toMatchObject({
      bundleId: published.id,
      product: 'storefront',
      status: 'candidate',
    })
    expect(reader.searchLexical('sign in')).toMatchObject([
      { bundleId: published.id, product: 'storefront' },
    ])
  }

  it('opens a healthy rebuilt index with the connection-local vec0 capability', async () => {
    publish()
    await rebuildAuthorizedIndex({ knowledgeRoot })

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader).toMatchObject({ source: 'index', vec: 'vec0' })
      expect(knowledgeLocal.readRebuildRequest(knowledgeRoot)).toEqual({ present: false })
    } finally {
      reader.close()
    }
  })

  it('degrades a structurally incomplete index at open and serves from bundles', async () => {
    const published = publish()
    await rebuildAuthorizedIndex({ knowledgeRoot })
    const db = new DatabaseSync(knowledgeLocal.indexDbPath(knowledgeRoot))
    try {
      db.exec('DROP TABLE fts_records')
    } finally {
      db.close()
    }

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader).toMatchObject({ source: 'scan', vec: 'none' })
      expectMarker('corrupt')
      expect(reader.searchLexical('sign in')).toMatchObject([
        { bundleId: published.id, product: 'storefront' },
      ])
    } finally {
      reader.close()
    }
  })

  it('permanently degrades a live reader when an index query fails', async () => {
    const published = publish()
    await rebuildAuthorizedIndex({ knowledgeRoot })
    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    expect(reader).toMatchObject({ source: 'index' })

    const db = new DatabaseSync(knowledgeLocal.indexDbPath(knowledgeRoot))
    try {
      db.exec('DROP TABLE fts_records')
    } finally {
      db.close()
    }

    try {
      expect(() => reader.searchLexical('sign in')).not.toThrow()
      expect(reader.searchLexical('sign in')).toMatchObject([
        { bundleId: published.id, product: 'storefront' },
      ])
      expectMarker('corrupt')
      expect(reader).toMatchObject({ source: 'scan', vec: 'none' })
      expect(reader.getById(published.id)).toMatchObject({ bundleId: published.id })
    } finally {
      expect(() => reader.close()).not.toThrow()
    }
  })

  it('degrades an absent index, requests rebuild, and serves from bundles', () => {
    const published = publish()

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expectScanServes(reader, published)
      expectMarker('absent')
    } finally {
      reader.close()
    }
  })

  it('degrades garbage index bytes as corrupt without blocking bundle reads', () => {
    const published = publish()
    const indexPath = knowledgeLocal.indexDbPath(knowledgeRoot)
    mkdirSync(dirname(indexPath), { recursive: true })
    writeFileSync(indexPath, 'not a sqlite database', 'utf8')

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expectScanServes(reader, published)
      expectMarker('corrupt')
    } finally {
      reader.close()
    }
  })

  it.each([
    {
      name: 'below-minimum',
      mutate(db: DatabaseSync): void {
        db.prepare("UPDATE meta SET v = '0' WHERE k = 'index_schema_version'").run()
      },
    },
    {
      name: 'missing',
      mutate(db: DatabaseSync): void {
        db.prepare("DELETE FROM meta WHERE k = 'index_schema_version'").run()
      },
    },
  ])('degrades a $name schema version and serves the authoritative scan', async ({ mutate }) => {
    const published = publish()
    await rebuildAuthorizedIndex({ knowledgeRoot })
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      mutate(writer.db)
    } finally {
      writer.close()
    }

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expectScanServes(reader, published)
      expectMarker('schema-version')
    } finally {
      reader.close()
    }
  })

  it('degrades a real exclusive-lock timeout as locked and keeps serving', async () => {
    const published = publish()
    await rebuildAuthorizedIndex({ knowledgeRoot })
    const locker = new DatabaseSync(knowledgeLocal.indexDbPath(knowledgeRoot), { timeout: 100 })
    locker.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')

    try {
      const reader = readerApi().openKnowledgeReader(knowledgeRoot)
      try {
        expectScanServes(reader, published)
        expectMarker('locked')
      } finally {
        reader.close()
      }
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })

  it('preserves the first marker and tolerates repeated degraded opens', () => {
    publish()
    const first = readerApi().openKnowledgeReader(knowledgeRoot)
    first.close()
    expectMarker('absent')

    writeFileSync(knowledgeLocal.indexDbPath(knowledgeRoot), 'garbage', 'utf8')
    expect(() => readerApi().openKnowledgeReader(knowledgeRoot).close()).not.toThrow()
    expect(() => readerApi().openKnowledgeReader(knowledgeRoot).close()).not.toThrow()
    expectMarker('absent')
  })

  it('serves indexed get-by-id, BM25 lexical, and canonical anchor lookups', async () => {
    const signIn = publishNamed('Storefront Product', 'Sign in', '#sign-in')
    const checkout = publishNamed('Checkout Product', 'Checkout now', '#checkout-now')
    await rebuildAuthorizedIndex({ knowledgeRoot })

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.getById(signIn.id)).toMatchObject({
        bundleId: signIn.id,
        product: slugBranch('Storefront Product'),
        status: 'candidate',
      })
      expect(reader.getById('fact-unknown-0123456789abcdef')).toBeUndefined()
      expect(reader.searchLexical('checkout now', { k: 1 })).toMatchObject([
        { bundleId: checkout.id, product: slugBranch('Checkout Product') },
      ])
      expect(reader.searchLexical('control', {
        product: slugBranch('Storefront Product'),
        k: 5,
      })).toMatchObject([
        { bundleId: signIn.id, product: slugBranch('Storefront Product') },
      ])
      expect(
        reader.lookupAnchor(
          { t: 'el', role: '  button ', name: '  SIGN   IN  ' },
          { product: slugBranch('Storefront Product'), k: 1 },
        ),
      ).toMatchObject([{ bundleId: signIn.id }])
    } finally {
      reader.close()
    }
  })

  it('returns every ordinary-token match in deterministic BM25 and bundle-id order', async () => {
    const alpha = publishNamed('Recall Product', 'Recall alpha')
    const bravo = publishNamed('Recall Product', 'Recall bravo')
    await rebuildAuthorizedIndex({ knowledgeRoot })

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      const options = { product: slugBranch('Recall Product') }
      const expected = [alpha.id, bravo.id].sort()

      expect(reader.searchLexical('alpha bravo', options).map((hit) => hit.bundleId))
        .toEqual(expected)
      expect(reader.searchLexical('alpha bravo', options).map((hit) => hit.bundleId))
        .toEqual(expected)
    } finally {
      reader.close()
    }
  })

  it('quotes every FTS token so identity atoms stay exact and MATCH syntax is inert', async () => {
    const exact = publishNamed('FTS Product', 'Submit exact', '#submit')
    const longer = publishNamed('FTS Product', 'Submit cancel', '#submit-cancel')
    const literalOperator = publishNamed('FTS Product', 'Literal OR checkout', '#literal-or')
    const literalCheckout = publishNamed('FTS Product', 'Literal checkout', '#literal-checkout')
    const literalAnd = publishNamed('FTS Product', 'Conjunction AND sentinel')
    const literalNot = publishNamed('FTS Product', 'Negation NOT sentinel')
    const literalNear = publishNamed('FTS Product', 'Proximity NEAR sentinel')
    await rebuildAuthorizedIndex({ knowledgeRoot })

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      const options = { product: slugBranch('FTS Product') }
      const queryIds = (query: string): string[] =>
        reader.searchLexical(query, options).map((hit) => hit.bundleId)
      const expectDeterministicSet = (query: string, expected: readonly string[]): void => {
        const first = queryIds(query)
        expect(new Set(first)).toEqual(new Set(expected))
        expect(queryIds(query)).toEqual(first)
      }
      const checkoutMatches = [literalOperator.id, literalCheckout.id]

      expect(queryIds('#submit')).toEqual([exact.id])
      expect(queryIds('#submit-cancel')).toEqual([longer.id])
      expectDeterministicSet('literal OR checkout', [
        exact.id,
        longer.id,
        literalOperator.id,
        literalCheckout.id,
        literalAnd.id,
        literalNot.id,
        literalNear.id,
      ])
      expectDeterministicSet('OR AND NOT NEAR', [
        literalOperator.id,
        literalAnd.id,
        literalNot.id,
        literalNear.id,
      ])
      expectDeterministicSet('(checkout)', checkoutMatches)
      expectDeterministicSet('"checkout"', checkoutMatches)
      expectDeterministicSet('checkout*', checkoutMatches)
    } finally {
      reader.close()
    }
  })

  it('returns the same dense ordering through vec0 and canonical-BLOB brute search', async () => {
    const embedder = makeFakeEmbedder()
    const first = publishNamed('Dense Product', 'Dense first')
    const second = publishNamed('Dense Product', 'Dense second')
    const third = publishNamed('Dense Product', 'Dense third')
    await rebuildAuthorizedIndex({ knowledgeRoot, embedder })
    const target = knowledgeLocal.scanBundleById({ knowledgeRoot, bundleId: second.id })
    expect(target).toBeDefined()
    const query = await embedder.embedQuery(target!.embeddingInput)

    const vecReader = readerApi().openKnowledgeReader(knowledgeRoot)
    const bruteReader = readerApi().openKnowledgeReader(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    try {
      expect(vecReader).toMatchObject({ source: 'index', vec: 'vec0' })
      expect(bruteReader).toMatchObject({ source: 'index', vec: 'brute' })
      const vecHits = vecReader.searchDense(query, {
        product: slugBranch('Dense Product'),
        k: 3,
      })
      const bruteHits = bruteReader.searchDense(query, {
        product: slugBranch('Dense Product'),
        k: 3,
      })

      expect(vecHits.map((hit) => hit.bundleId)).toEqual(bruteHits.map((hit) => hit.bundleId))
      expect(vecHits.map((hit) => hit.bundleId)).toEqual(
        expect.arrayContaining([first.id, second.id, third.id]),
      )
      expect(vecHits[0]?.bundleId).toBe(second.id)
      for (let index = 0; index < vecHits.length; index += 1) {
        expect(vecHits[index]!.distance).toBeCloseTo(bruteHits[index]!.distance, 5)
      }
    } finally {
      vecReader.close()
      bruteReader.close()
    }

    const scanReader = readerApi().openKnowledgeReader(join(root, 'absent-knowledge-root'))
    try {
      expect(scanReader.searchDense(query, {
        product: slugBranch('Dense Product'),
        k: 3,
      })).toEqual([])
    } finally {
      scanReader.close()
    }
  })

  it('rechecks every indexed result path and drops a post-rebuild supersession', async () => {
    const embedder = makeFakeEmbedder()
    const published = publishNamed('Withdrawn Product', 'Withdraw stale fact', '#withdraw-stale')
    await rebuildAuthorizedIndex({ knowledgeRoot, embedder })
    const source = knowledgeLocal.scanBundleById({ knowledgeRoot, bundleId: published.id })
    expect(source).toBeDefined()
    const query = await embedder.embedQuery(source!.embeddingInput)
    const reader = readerApi().openKnowledgeReader(knowledgeRoot)

    try {
      const indexedHit = reader.getById(published.id)
      expect(indexedHit).toBeDefined()
      expect(
        appendOutcomeEvent(
          config('Withdrawn Product'),
          published.id,
          BundleOutcomeEventSchema.parse({
            type: 'superseded',
            evidenceToken: 'index-reader-superseded',
            curationJobId: 'index-reader-superseded-job',
            buildOrdinal: 43,
            byRecordId: 'fact-replacement-0123456789abcdef',
          }),
        ),
      ).toEqual({ kind: 'appended' })

      expect(reader.getById(published.id)).toBeUndefined()
      expect(reader.searchLexical('withdraw stale', {
        product: slugBranch('Withdrawn Product'),
      })).toEqual([])
      expect(
        reader.lookupAnchor(
          { t: 'selector', literal: '#withdraw-stale' },
          { product: slugBranch('Withdrawn Product') },
        ),
      ).toEqual([])
      expect(reader.searchDense(query, {
        product: slugBranch('Withdrawn Product'),
        k: 1,
      })).toEqual([])
      expect(reader.recheck([indexedHit!])).toEqual([])
    } finally {
      reader.close()
    }
  })

  it('refreshes bundle-derived fields and rejects an integrity-tampered bundle', async () => {
    const published = publishNamed('Authority Product', 'Authoritative state')
    await rebuildAuthorizedIndex({ knowledgeRoot })
    const writer = knowledgeLocal.openIndexWriter(knowledgeRoot)
    try {
      writer.db.prepare(`
        UPDATE records
        SET status = 'active', trust = 0.99, opened_at_ordinal = 999
        WHERE bundle_id = ?
      `).run(published.id)
    } finally {
      writer.close()
    }

    const reader = readerApi().openKnowledgeReader(knowledgeRoot)
    try {
      expect(reader.getById(published.id)).toMatchObject({
        bundleId: published.id,
        status: 'candidate',
        validity: { openedAtOrdinal: 42 },
      })
      expect(reader.getById(published.id)?.trust).not.toBe(0.99)

      const recordPath = join(published.dir, 'record.md')
      writeFileSync(recordPath, `${readFileSync(recordPath, 'utf8')}\nunauthorized mutation\n`, 'utf8')
      expect(reader.getById(published.id)).toBeUndefined()
    } finally {
      reader.close()
    }
  })
})
