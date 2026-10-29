// The MEM sighting source's status derivation.
//
// CR-04's shape, stated so the cases below are readable as a fix for it rather than as
// arbitrary assertions: the resolver's private status table named three strings, two of which
// (`withdrawn`, `retired`) are not members of `BundleStatus` at all, and it omitted
// `deprecated` — the status every forget and every reject actually produces. Its reachable
// domain was therefore `['superseded']`, so after a forget the card said `active` while the
// receipt handed to the same caller said `tombstoned`.
//
// The regression cases here walk the COMPLETE `BundleStatus` union rather than the one member
// that failed, because a table scoped to hand-picked members of a set whose hazard belongs to
// the whole set is the defect, and a test scoped the same way would reproduce it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BundleOutcomeEventSchema, ENTITY_STATUSES } from '@vostride/agent-qa-schema'
import type { Anchor, BundleStatus, RecordId } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendOutcomeEvent } from '../../bundle-append.js'
import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import { listBundles } from '../../list-bundles.js'
import {
  MEMORY_STATUS_BY_BUNDLE_STATUS,
  UnknownBundleStatusError,
  memoryStatusForBundle,
} from '../../memory-status.js'
import {
  makeBundleDraftFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { createMemorySightingSource } from '../memory-source.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }

/**
 * The complete `BundleStatus` union, WRITTEN OUT, and the expected card status beside it.
 *
 * Deliberately a literal list rather than `Object.keys(MEMORY_STATUS_BY_BUNDLE_STATUS)`. Walking
 * the table's own keys would be vacuous against exactly the defect this closes — a table that
 * dropped `deprecated` would still "walk its complete union" and still pass. The list has to be
 * an independent statement of what the union contains, so the table is measured against
 * something outside itself.
 */
const COMPLETE_BUNDLE_STATUS_WALK = [
  ['active', 'active'],
  ['candidate', 'active'],
  ['superseded', 'tombstoned'],
  ['deprecated', 'tombstoned'],
] as const satisfies readonly (readonly [BundleStatus, string])[]

describe('the bundle-status → MEM card-status mapping is total over the complete union', () => {
  it('names exactly the four BundleStatus members and nothing else', () => {
    expect(Object.keys(MEMORY_STATUS_BY_BUNDLE_STATUS).sort()).toEqual([
      'active',
      'candidate',
      'deprecated',
      'superseded',
    ])
  })

  it.each(COMPLETE_BUNDLE_STATUS_WALK)('maps %s to %s', (bundleStatus, cardStatus) => {
    expect(memoryStatusForBundle(bundleStatus)).toBe(cardStatus)
  })

  it('only ever produces a status the MEM card vocabulary declares', () => {
    for (const value of Object.values(MEMORY_STATUS_BY_BUNDLE_STATUS)) {
      expect(ENTITY_STATUSES.MEM as readonly string[]).toContain(value)
    }
  })

  it('THROWS, naming the status, for an input outside the union', () => {
    // The cast is required and is the point of the design note in `memory-status.ts`: the
    // parameter stays `BundleStatus` so both production call sites keep compile-time totality,
    // which makes this arm unreachable from TypeScript and reachable only the way it is
    // actually reachable in production — a string that arrived through a cast at a
    // deserialization boundary. `withdrawn` is one of the two dead members the old table named.
    expect(() => memoryStatusForBundle('withdrawn' as BundleStatus))
      .toThrow(UnknownBundleStatusError)
    expect(() => memoryStatusForBundle('withdrawn' as BundleStatus))
      .toThrow(/"withdrawn"/)
    // Never the silent default that hid the defect.
    expect(() => memoryStatusForBundle('retired' as BundleStatus)).toThrow(/"retired"/)
  })
})

describe('the MEM sighting source reports the status the store actually derived', () => {
  let root: string
  let knowledgeRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-source-status-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return {
      knowledgeRoot,
      productKey: 'Memory Source Product',
    }
  }

  function publish(summary: string): RecordId {
    const outcome = publishBundle(storeConfig(), {
      draft: makeBundleDraftFixture({
        kind: 'fact',
        anchors: [ANCHOR],
        scope: { tier: 'product', key: 'memory-source-status' },
        summary,
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'Button', name: summary },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: `mem-source-${summary}`, testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  /** The status `listBundles` derives, read the same way the sighting source reads it. */
  function derivedStatus(bundleId: string): string | undefined {
    return listBundles(knowledgeRoot).find((row) => row.bundleId === bundleId)?.status
  }

  function sight(bundleId: string): string | undefined {
    return createMemorySightingSource(() => knowledgeRoot).sight(bundleId)?.statusSource
  }

  it('reports tombstoned for a bundle a forget or reject drove to deprecated', () => {
    const recordId = publish('deprecated checkout button')
    expect(
      appendOutcomeEvent(
        storeConfig(),
        recordId,
        BundleOutcomeEventSchema.parse({
          type: 'deprecated',
          evidenceToken: 'memory-source-deprecated',
          curationJobId: 'memory-source-deprecated-job',
          // Strictly ABOVE createdAtOrdinal: the fold only lets a lifecycle event win the
          // status when its build ordinal beats the one the record was born at, so an equal
          // ordinal would leave the bundle `candidate` and this case would be measuring the
          // wrong state rather than the one a forget produces.
          buildOrdinal: 11,
          reason: 'forget applied',
        }),
      ).kind,
    ).toBe('appended')

    // The precondition, asserted rather than assumed: if the store did not actually derive
    // `deprecated`, the sighting assertion below would be a test of the fixture, not the table.
    expect(derivedStatus(recordId)).toBe('deprecated')

    // OBSERVED RED (2026-08-02, before the fix, against the unmodified
    // TOMBSTONED_BUNDLE_STATUSES = ['withdrawn', 'superseded', 'retired'] at
    // memory-source.ts:24):
    //   AssertionError: expected 'active' to be 'tombstoned' // Object.is equality
    //   - Expected: "tombstoned"   + Received: "active"
    // That is CR-04 verbatim at the sighting seam.
    expect(sight(recordId)).toBe('tombstoned')
  })

  it('reports tombstoned for a bundle ordinary curation superseded', () => {
    const recordId = publish('superseded checkout button')
    expect(
      appendOutcomeEvent(
        storeConfig(),
        recordId,
        BundleOutcomeEventSchema.parse({
          type: 'superseded',
          evidenceToken: 'memory-source-superseded',
          curationJobId: 'memory-source-superseded-job',
          buildOrdinal: 11,
          byRecordId: 'rec-successor-of-the-superseded-checkout-button',
        }),
      ).kind,
    ).toBe('appended')

    expect(derivedStatus(recordId)).toBe('superseded')

    // OBSERVED GREEN BEFORE THE FIX, and kept deliberately. `superseded` was the ONE member of
    // the old table's three that `BundleStatus` actually contains, so this case passing against
    // the broken table is what proves the harness itself works — the sibling case above reds
    // because of the table, not because the fixture never reached the sighting source.
    expect(sight(recordId)).toBe('tombstoned')
  })

  it('reports active for a bundle still standing', () => {
    const recordId = publish('live checkout button')
    expect(derivedStatus(recordId)).toBe('candidate')
    expect(sight(recordId)).toBe('active')
  })
})
