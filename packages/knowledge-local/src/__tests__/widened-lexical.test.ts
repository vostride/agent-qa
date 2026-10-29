import { rebuildAuthorizedIndex as rebuildIndex } from './fixtures/authorized-rebuild.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { Anchor } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  indexDbPath,
  openKnowledgeReader,
  scanBundles,
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

const PRODUCT = 'widened-lexical-store'
const STORED_ANCHOR = {
  t: 'el',
  role: 'Button',
  name: 'Badge (7)',
  ordinal: 1,
} satisfies Anchor

describe('widened lexical-only matching', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-widened-lexical-'))
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
        anchors: [STORED_ANCHOR, { t: 'page', route: '/neutral-control' }],
        scope: { tier: 'product', key: PRODUCT },
        summary: 'Neutral account control',
        body: 'Invoking the control performs the recorded action.',
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: STORED_ANCHOR.role, name: STORED_ANCHOR.name },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 42,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: 'widened-lexical-run',
        testId: 'widened-lexical-test',
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

  it('widens role plus normalized-name matching only on the vec none rung', async () => {
    const published = publish()
    await rebuildIndex({ knowledgeRoot, embedder: makeFakeEmbedder() })

    const denseReader = openKnowledgeReader(knowledgeRoot, {
      vecLoadablePath: join(root, 'missing-sqlite-vec-extension'),
    })
    expect(denseReader).toMatchObject({ source: 'index', vec: 'brute' })

    // Exercise the existing health-degradation seam while keeping the already-open dense reader.
    const writer = new DatabaseSync(indexDbPath(knowledgeRoot))
    try {
      writer.exec('DROP TABLE graph_nodes')
    } finally {
      writer.close()
    }
    const lexicalReader = openKnowledgeReader(knowledgeRoot)

    try {
      expect(lexicalReader).toMatchObject({ source: 'scan', vec: 'none' })

      const sameIdentity: Anchor = {
        t: 'el',
        role: ' button ',
        name: ' BADGE ',
        ordinal: 1,
      }
      const ordinalDrift: Anchor = { ...sameIdentity, ordinal: 2 }

      expect(denseReader.lookupAnchor(sameIdentity).map((hit) => hit.bundleId))
        .toEqual([published.id])
      expect(denseReader.lookupAnchor(ordinalDrift)).toEqual([])
      expect(lexicalReader.lookupAnchor(ordinalDrift).map((hit) => hit.bundleId))
        .toEqual([published.id])

      // renderEmbeddingInput already places normalized anchor-name tokens in the FTS content.
      expect(denseReader.searchLexical('badge').map((hit) => hit.bundleId))
        .toEqual([published.id])
      expect(lexicalReader.searchLexical('badge').map((hit) => hit.bundleId))
        .toEqual([published.id])
    } finally {
      lexicalReader.close()
      denseReader.close()
    }
  })

  it('searches canonical normalized anchors without losing raw-anchor text', () => {
    const published = publish()

    // The normalized form drops the trailing badge; only its canonical JSON has this atom.
    expect(
      scanBundles({ knowledgeRoot, text: '"name":"badge"' }).map((hit) => hit.bundleId),
    ).toEqual([published.id])

    // The trailing badge survives only in the raw anchor and remains searchable.
    expect(scanBundles({ knowledgeRoot, text: '(7)' }).map((hit) => hit.bundleId))
      .toEqual([published.id])
  })
})
