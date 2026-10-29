// Imported from `../reader.js`, so a missing reader re-export fails to resolve.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeBundleSummarySchema } from '@vostride/agent-qa-schema'
import type { Anchor, BundleOutcomeEvent } from '@vostride/agent-qa-schema'
import { BundleOutcomeEventSchema } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle } from '../bundle-publish.test-helper.js'
import type { BundleStoreConfig } from '../bundle-publish.test-helper.js'
import { listBundles } from '../reader.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'

function outcomeEvent(
  value: Parameters<typeof BundleOutcomeEventSchema.parse>[0],
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse(value)
}

/** Every file under a directory tree, relative and sorted — the read-only witness. */
function fileTree(root: string): string[] {
  const files: string[] = []
  const visit = (relDir: string): void => {
    const dir = relDir === '' ? root : join(root, relDir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) visit(relPath)
      else files.push(relPath)
    }
  }
  visit('')
  return files.sort()
}

describe('listBundles read-only bundle listing', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-list-bundles-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(productKey: string): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey,
    }
  }

  function publish(input: {
    product: string
    scope: string
    anchor: Anchor
    elementName: string
    createdAtOrdinal: number
    initialEvents?: readonly BundleOutcomeEvent[]
  }): string {
    const outcome = publishBundle(storeConfig(input.product), {
      draft: makeBundleDraftFixture({
        kind: 'fact',
        anchors: [input.anchor],
        scope: { tier: 'product', key: input.scope },
        summary: `fact record for ${input.scope}`,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: input.elementName },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: input.createdAtOrdinal,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [...(input.initialEvents ?? [])],
      relations: [],
      provenance: {
        mode: 'run-linked',
        runId: `list-bundles-${input.scope}`,
        testId: 'list-bundles',
        stepIndex: 0,
      },
      artifacts: [],
    })

    expect(outcome.kind).toBe('published')
    if (outcome.kind !== 'published') throw new Error('fixture bundle did not publish')
    return outcome.id
  }

  function seedTwoProducts(): { alphaId: string; betaId: string } {
    const alphaId = publish({
      product: 'alpha',
      scope: 'checkout',
      anchor: { t: 'el', role: 'Button', name: 'Checkout Now' },
      elementName: 'Checkout Now',
      createdAtOrdinal: 5,
      initialEvents: [
        outcomeEvent({
          type: 'promoted',
          evidenceToken: 'alpha-promoted',
          curationJobId: 'alpha-promotion-job',
          buildOrdinal: 6,
        }),
        outcomeEvent({
          type: 'confirmed',
          evidenceToken: 'alpha-confirmed',
          curationJobId: 'alpha-confirmation-job',
          buildOrdinal: 7,
          origin: 'agent-verified',
        }),
      ],
    })

    const betaId = publish({
      product: 'beta',
      scope: 'search',
      anchor: { t: 'el', role: 'Button', name: 'Search' },
      elementName: 'Search',
      createdAtOrdinal: 4,
    })

    return { alphaId, betaId }
  }

  it('returns one KnowledgeBundleSummary row per committed bundle', () => {
    const { alphaId, betaId } = seedTwoProducts()

    const rows = listBundles(knowledgeRoot)

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(() => KnowledgeBundleSummarySchema.parse(row)).not.toThrow()
    }
    expect(rows.map((row) => row.product)).toEqual(['alpha', 'beta'])
    expect(rows.map((row) => row.bundleId)).toEqual([alphaId, betaId])
  })

  it('projects the derived trust state and the record identity onto each row', () => {
    seedTwoProducts()

    const [alpha, beta] = listBundles(knowledgeRoot)

    expect(alpha).toMatchObject({
      product: 'alpha',
      kind: 'fact',
      subtype: 'selector',
      scope: { tier: 'product', key: 'checkout' },
      status: 'active',
      openedAtOrdinal: 5,
      lastConfirmedOrdinal: 7,
      summary: 'fact record for checkout',
      evidenceIncomplete: false,
    })
    expect(alpha!.counters).toEqual({
      confirmed: 1,
      contradicted: 0,
      helpful: 0,
      harmful: 0,
    })
    expect(alpha!.trust).toBeGreaterThan(0)
    expect(alpha!.trust).toBeLessThanOrEqual(1)
    expect(alpha!.closedAtOrdinal).toBeUndefined()

    // `dir` is relative to the knowledge root, so a row is portable across machines.
    expect(alpha!.dir).toBe(`memory/alpha/bundles/${alpha!.bundleId}`)
    expect(beta).toMatchObject({ product: 'beta', status: 'candidate', openedAtOrdinal: 4 })
  })

  it('orders rows deterministically by product then bundle id', () => {
    seedTwoProducts()

    const first = listBundles(knowledgeRoot)
    const second = listBundles(knowledgeRoot)

    expect(first).toEqual(second)
    expect(first).toEqual(
      [...first].sort((left, right) => (
        left.product < right.product ? -1
          : left.product > right.product ? 1
            : left.bundleId < right.bundleId ? -1
              : left.bundleId > right.bundleId ? 1 : 0
      )),
    )
  })

  it('returns an empty list for a knowledge root that does not exist', () => {
    expect(listBundles(join(root, 'no-such-knowledge-root'))).toEqual([])
  })

  it('returns an empty list for a knowledge root with no committed bundles', () => {
    seedTwoProducts()
    rmSync(join(knowledgeRoot, 'memory'), { recursive: true, force: true })

    expect(listBundles(knowledgeRoot)).toEqual([])
  })

  it('mutates nothing on the knowledge root — it is a pure read', () => {
    seedTwoProducts()
    const before = fileTree(knowledgeRoot)

    listBundles(knowledgeRoot)
    listBundles(knowledgeRoot)

    expect(fileTree(knowledgeRoot)).toEqual(before)
  })
})
