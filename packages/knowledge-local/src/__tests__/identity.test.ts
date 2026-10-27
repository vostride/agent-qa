import { basename, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  BundleOutcomeEventSchema,
  guardBundleManifest,
} from '@vostride/agent-qa-schema'
import type { BundleManifest, BundleRelation } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendOutcomeEvent, appendRelation } from '../bundle-append.js'
import { deriveBundleTrust, loadBundle } from '../bundle-read.js'
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

describe('BNDL-02 stable bundle identity over the live store', () => {
  let root: string
  let config: BundleStoreConfig

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-bundle-identity-'))
    config = {
      knowledgeRoot: join(root, 'agent-qa-knowledge'),
      productKey: 'identity-store',
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

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
        runId: 'identity-run',
        testId: 'identity-test',
        stepIndex: 0,
      },
      artifacts: [],
      ...overrides,
    }
  }

  function manifest(bundleDir: string): BundleManifest {
    return guardBundleManifest(
      JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8')),
    )
  }

  it('keeps id and identity hash stable while four mutations advance mutable state', () => {
    const published = publishBundle(config, input())
    expect(published.kind).toBe('published')
    if (published.kind !== 'published') throw new Error('expected identity fixture publication')
    const initial = manifest(published.dir)
    let previousMutableStateHash = initial.mutableStateHash

    const assertAdvanced = (): BundleManifest => {
      const next = manifest(published.dir)
      expect(basename(published.dir)).toBe(published.id)
      expect(next.id).toBe(initial.id)
      expect(next.identityHash).toBe(initial.identityHash)
      expect(next.mutableStateHash).not.toBe(previousMutableStateHash)
      previousMutableStateHash = next.mutableStateHash
      return next
    }

    const confirmed = BundleOutcomeEventSchema.parse({
      type: 'confirmed',
      evidenceToken: 'identity-confirmed',
      curationJobId: 'identity-confirmed-job',
      buildOrdinal: 43,
      origin: 'agent-verified',
    })
    expect(appendOutcomeEvent(config, published.id, confirmed)).toEqual({ kind: 'appended' })
    assertAdvanced()

    const relation: BundleRelation = {
      type: 'relates-to',
      targetId: 'fact-related-0123456789abcdef',
      addedAtOrdinal: 44,
      curationJobId: 'identity-relation-job',
    }
    expect(appendRelation(config, published.id, relation)).toEqual({ kind: 'appended' })
    assertAdvanced()

    const superseded = BundleOutcomeEventSchema.parse({
      type: 'superseded',
      evidenceToken: 'identity-superseded',
      curationJobId: 'identity-superseded-job',
      buildOrdinal: 45,
      byRecordId: 'fact-replacement-0123456789abcdef',
    })
    expect(appendOutcomeEvent(config, published.id, superseded)).toEqual({ kind: 'appended' })
    assertAdvanced()

    const windowClose = BundleOutcomeEventSchema.parse({
      type: 'window-close',
      evidenceToken: 'identity-window-close',
      curationJobId: 'identity-window-close-job',
      buildOrdinal: 46,
      closedAtOrdinal: 50,
    })
    expect(appendOutcomeEvent(config, published.id, windowClose)).toEqual({ kind: 'appended' })
    assertAdvanced()

    const loaded = loadBundle(published.dir)
    expect(loaded.kind).toBe('loaded')
    if (loaded.kind !== 'loaded') throw new Error('expected mutated bundle to load')
    expect(deriveBundleTrust(loaded.bundle)).toMatchObject({
      counters: { confirmed: 1 },
      status: 'superseded',
      validity: { openedAtOrdinal: 42, closedAtOrdinal: 50 },
    })
  })

  it('deduplicates badge-count drift and excludes LLM prose from store identity', () => {
    const badgeInput = input({
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Cart (3)' },
          { t: 'page', route: '/cart' },
        ],
      }),
      discriminant: makeDiscriminantFixture('fact', 'selector'),
    })
    const firstBadge = publishBundle(config, badgeInput)
    expect(firstBadge.kind).toBe('published')
    if (firstBadge.kind !== 'published') throw new Error('expected badge fixture publication')

    const driftedBadge = publishBundle(config, {
      ...badgeInput,
      draft: makeBundleDraftFixture({
        anchors: [
          { t: 'el', role: 'Button', name: 'Cart (7)' },
          { t: 'page', route: '/cart' },
        ],
      }),
    })
    expect(driftedBadge).toEqual({ kind: 'already-exists', id: firstBadge.id })

    const proseFirst = publishBundle(config, input())
    expect(proseFirst.kind).toBe('published')
    if (proseFirst.kind !== 'published') throw new Error('expected prose fixture publication')
    const proseSecond = publishBundle(
      config,
      input({
        draft: makeBundleDraftFixture({
          summary: 'Completely different model-authored summary',
          body: 'Completely different model-authored detail text.',
        }),
      }),
    )
    expect(proseSecond).toEqual({ kind: 'already-exists', id: proseFirst.id })
  })
})
