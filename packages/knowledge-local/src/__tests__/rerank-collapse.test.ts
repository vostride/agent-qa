import type { Anchor } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  applyDiversityCaps,
  collapseByOrdinal,
  rerankPrecedence,
} from '../retrieval/rerank.js'
import type { RerankEntry } from '../retrieval/rerank.js'

const submitAnchor: Anchor = { t: 'el', role: 'button', name: 'Submit order' }

function entry(
  bundleId: string,
  overrides: Partial<RerankEntry> = {},
): RerankEntry {
  return {
    bundleId,
    validityClass: 'current',
    trust: 0.5,
    scope: { tier: 'test', key: 'test:checkout' },
    recencyOrdinal: 10,
    createdAtOrdinal: 10,
    originClass: 'agent',
    anchors: [submitAnchor],
    subtype: 'selector',
    lastConfirmedOrdinal: 10,
    ...overrides,
  }
}

describe('precedence rerank (spec §5.5.6)', () => {
  it('keeps a current-window fact above a prior-build hypothesis regardless of trust or recency', () => {
    const ranked = rerankPrecedence([
      entry('r_prior', {
        validityClass: 'priorBuildHypothesis',
        trust: 1,
        recencyOrdinal: 1_000,
      }),
      entry('r_current', { trust: 0, recencyOrdinal: 1 }),
    ])

    expect(ranked.map(({ bundleId }) => bundleId)).toEqual(['r_current', 'r_prior'])
  })

  it('orders by trust, scope specificity, recency, then bundle id', () => {
    const ranked = rerankPrecedence([
      entry('r_global_high', {
        trust: 0.9,
        scope: { tier: 'global', key: 'global' },
        recencyOrdinal: 1,
      }),
      entry('r_test_z', { trust: 0.8, recencyOrdinal: 20 }),
      entry('r_test_a', { trust: 0.8, recencyOrdinal: 20 }),
      entry('r_test_old', { trust: 0.8, recencyOrdinal: 10 }),
      entry('r_suite_new', {
        trust: 0.8,
        scope: { tier: 'suite', key: 'suite:checkout' },
        recencyOrdinal: 1_000,
      }),
      entry('r_product', {
        trust: 0.8,
        scope: { tier: 'product', key: 'product:checkout' },
      }),
      entry('r_global', {
        trust: 0.8,
        scope: { tier: 'global', key: 'global' },
      }),
    ])

    expect(ranked.map(({ bundleId }) => bundleId)).toEqual([
      'r_global_high',
      'r_test_a',
      'r_test_z',
      'r_test_old',
      'r_suite_new',
      'r_product',
      'r_global',
    ])
  })
})

describe('assembly-time ordinal collapse', () => {
  it('collapses cosmetically different agent anchors onto the maximum creation ordinal', () => {
    const oldEntry = entry('r_old', {
      createdAtOrdinal: 4,
      anchors: [{ t: 'el', role: ' BUTTON ', name: '  Submit   Order ' }],
    })
    const newEntry = entry('r_new', {
      createdAtOrdinal: 9,
      anchors: [{ t: 'el', role: 'button', name: 'submit order' }],
    })

    expect(collapseByOrdinal([oldEntry, newEntry]).map(({ bundleId }) => bundleId)).toEqual([
      'r_new',
    ])
  })

  it('always preserves a sovereign user entry beside the newest agent entry', () => {
    const user = entry('r_user', { originClass: 'user', createdAtOrdinal: 1 })
    const newestAgent = entry('r_agent_new', { createdAtOrdinal: 9 })
    const oldAgent = entry('r_agent_old', { createdAtOrdinal: 3 })

    expect(
      collapseByOrdinal([user, newestAgent, oldAgent]).map(({ bundleId }) => bundleId),
    ).toEqual(['r_user', 'r_agent_new'])
  })

  it('preserves and annotates both members of a MintUnknown conflict in natural rank order', () => {
    const left = entry('r_left', { createdAtOrdinal: 4 })
    const right = entry('r_right', { createdAtOrdinal: 9 })

    const collapsed = collapseByOrdinal([left, right], {
      conflicts: [
        {
          leftRecordId: 'r_left',
          rightRecordId: 'r_right',
          unknownRecordId: 'r_unknown',
        },
      ],
    })

    expect(collapsed).toEqual([
      expect.objectContaining({
        bundleId: 'r_left',
        conflict: { peerRecordId: 'r_right', unknownRecordId: 'r_unknown' },
      }),
      expect.objectContaining({
        bundleId: 'r_right',
        conflict: { peerRecordId: 'r_left', unknownRecordId: 'r_unknown' },
      }),
    ])
  })

  it('skips collapse in audit mode', () => {
    const oldEntry = entry('r_old', { createdAtOrdinal: 4 })
    const newEntry = entry('r_new', { createdAtOrdinal: 9 })

    expect(
      collapseByOrdinal([oldEntry, newEntry], { audit: true }).map(
        ({ bundleId }) => bundleId,
      ),
    ).toEqual(['r_old', 'r_new'])
  })
})

describe('primary-anchor diversity', () => {
  it('caps normalized element and flow anchors while leaving other anchors untouched', () => {
    const entries = [
      entry('r_el_1'),
      entry('r_el_2', {
        anchors: [{ t: 'el', role: ' BUTTON ', name: ' submit   order ' }],
      }),
      entry('r_el_3'),
      entry('r_flow_1', { anchors: [{ t: 'flow', name: 'Checkout' }] }),
      entry('r_flow_2', { anchors: [{ t: 'flow', name: ' checkout ' }] }),
      entry('r_flow_3', { anchors: [{ t: 'flow', name: 'CHECKOUT' }] }),
      entry('r_page_1', { anchors: [{ t: 'page', route: '/checkout' }] }),
      entry('r_page_2', { anchors: [{ t: 'page', route: '/checkout' }] }),
    ]

    expect(applyDiversityCaps(entries).map(({ bundleId }) => bundleId)).toEqual([
      'r_el_1',
      'r_el_2',
      'r_flow_1',
      'r_flow_2',
      'r_page_1',
      'r_page_2',
    ])
    expect(applyDiversityCaps(entries, true)).toEqual(entries)
  })
})
