import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  BundleOutcomeEventSchema,
  DEFAULT_EMBEDDING_PROFILE,
  asRecordId,
} from '@vostride/agent-qa-schema'
import type { Anchor, BundleRelation } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  REBUILD_MARKER_FILE,
  appendOutcomeEvent,
  appendRelation,
  indexDbPath,
  openKnowledgeReader,
  readRebuildRequest,
  rebuildIndex,
  type BundleStoreConfig,
  type KnowledgeReader,
  type PublishBundleInput,
  type PublishBundleOutcome,
  type RebuildReason,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const PRODUCT = 'degrade-store'
const TARGET_ANCHOR = {
  t: 'el',
  role: 'Button',
  name: 'Degradation sentinel',
} satisfies Anchor

describe('authoritative degradation ladder', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'knowledge-index-degrade-'))
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

  function input(): PublishBundleInput {
    return {
      draft: makeBundleDraftFixture({
        anchors: [
          TARGET_ANCHOR,
          { t: 'page', route: '/degradation-sentinel' },
          { t: 'platform', platform: 'web' },
        ],
        scope: { tier: 'product', key: PRODUCT },
        summary: 'Degradation sentinel control',
        body: 'The degradation sentinel keeps authoritative bundle scan serving observable.',
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: TARGET_ANCHOR.role, name: TARGET_ANCHOR.name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'index-degrade-run',
        testId: 'index-degrade-test',
        stepIndex: 0,
      },
      artifacts: [],
    }
  }

  function publish(): PublishedBundle {
    const outcome = publishBundle(config(), input())
    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') {
      throw new Error(`expected publication, got ${outcome.kind}`)
    }
    return outcome
  }

  function openWithoutThrow(): KnowledgeReader {
    let reader: KnowledgeReader | undefined
    expect(() => {
      reader = openKnowledgeReader(knowledgeRoot)
    }).not.toThrow()
    expect(reader).toBeDefined()
    return reader!
  }

  function expectMarker(reason: RebuildReason): void {
    expect(readRebuildRequest(knowledgeRoot)).toMatchObject({
      present: true,
      request: { reason },
    })
  }

  function expectAuthoritativeScanServes(
    reader: KnowledgeReader,
    published: PublishedBundle,
  ): void {
    expect(reader).toMatchObject({ source: 'scan', vec: 'none' })
    expect(reader.getById(published.id)).toMatchObject({
      bundleId: published.id,
      product: PRODUCT,
    })
    expect(reader.searchLexical('degradation sentinel')).toMatchObject([
      { bundleId: published.id, product: PRODUCT },
    ])
    expect(
      reader.lookupAnchor({ t: 'el', role: ' button ', name: ' DEGRADATION   SENTINEL ' }),
    ).toMatchObject([{ bundleId: published.id, product: PRODUCT }])
    expect(
      reader.searchDense(new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim), { k: 5 }),
    ).toEqual([])
  }

  it('degrades an absent index and serves every non-dense face from bundles', () => {
    const published = publish()
    const reader = openWithoutThrow()
    try {
      expectAuthoritativeScanServes(reader, published)
      expectMarker('absent')
    } finally {
      reader.close()
    }
  })

  it('degrades garbage index bytes as corrupt and keeps bundle truth available', () => {
    const published = publish()
    const path = indexDbPath(knowledgeRoot)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not a sqlite database', 'utf8')

    const reader = openWithoutThrow()
    try {
      expectAuthoritativeScanServes(reader, published)
      expectMarker('corrupt')
    } finally {
      reader.close()
    }
  })

  it.each([1, 3, 4, 5])('an index stamped %i is refused by the read probe', async (stamp) => {
    const published = publish()
    await rebuildIndex({ knowledgeRoot })
    const db = new DatabaseSync(indexDbPath(knowledgeRoot))
    try {
      db.prepare("UPDATE meta SET v = ? WHERE k = 'index_schema_version'").run(String(stamp))
    } finally {
      db.close()
    }

    const reader = openWithoutThrow()
    try {
      expectAuthoritativeScanServes(reader, published)
      expectMarker('schema-version')
    } finally {
      reader.close()
    }
  })

  it('preserves the first marker bytes across repeated degraded opens', () => {
    publish()
    openWithoutThrow().close()
    expectMarker('absent')
    const markerPath = join(knowledgeRoot, 'memory', 'index', REBUILD_MARKER_FILE)
    const firstMarker = readFileSync(markerPath, 'utf8')

    writeFileSync(indexDbPath(knowledgeRoot), 'now corrupt', 'utf8')
    openWithoutThrow().close()
    openWithoutThrow().close()

    expect(readFileSync(markerPath, 'utf8')).toBe(firstMarker)
    expectMarker('absent')
  })

  it('never serves a superseded bundle from any scan-mode result face', () => {
    const published = publish()
    const replacementId = asRecordId('fact-replacement-0123456789abcdef')
    expect(
      appendOutcomeEvent(
        config(),
        published.id,
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'index-degrade-superseded',
          curationJobId: 'index-degrade-superseded-job',
          buildOrdinal: 43,
          byRecordId: replacementId,
        }),
      ),
    ).toEqual({ kind: 'appended' })
    const relation: BundleRelation = {
      type: 'superseded-by',
      targetId: replacementId,
      addedAtOrdinal: 43,
      curationJobId: 'index-degrade-relation-job',
    }
    expect(appendRelation(config(), published.id, relation)).toEqual({ kind: 'appended' })

    const reader = openWithoutThrow()
    try {
      expect(reader).toMatchObject({ source: 'scan', vec: 'none' })
      expect(reader.getById(published.id)).toBeUndefined()
      expect(reader.searchLexical('')).toEqual([])
      expect(reader.searchLexical('degradation sentinel')).toEqual([])
      expect(reader.lookupAnchor(TARGET_ANCHOR)).toEqual([])
      expect(
        reader.searchDense(new Float32Array(DEFAULT_EMBEDDING_PROFILE.dim), { k: 5 }),
      ).toEqual([])
      expectMarker('absent')
    } finally {
      reader.close()
    }
  })
})
