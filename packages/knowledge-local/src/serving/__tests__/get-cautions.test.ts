import {
  APP_OBSERVED_DATA_CLOSE,
  APP_OBSERVED_DATA_OPEN,
} from '@vostride/agent-qa-safety'
import {
  asRecordId,
  type IndexEntry,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { selectCautions } from '../get-cautions.js'
import { renderCautionLine } from '../brief-render.js'

type OriginStampedEntry = IndexEntry & {
  origin?: 'app-observed' | 'user'
  originClass?: 'agent-observed' | 'agent-verified' | 'import' | 'user'
}

const scope = { tier: 'test', key: 'checkout' } as const

function caution(
  id: string,
  overrides: Partial<OriginStampedEntry> = {},
): OriginStampedEntry {
  return {
    id: asRecordId(id),
    kind: 'caution',
    title: id,
    summary: 'note',
    trust: 1,
    anchors: [{ t: 'page', route: '/checkout' }],
    status: 'active',
    servedAsCanary: false,
    scope,
    validity: 'current',
    ...overrides,
  }
}

describe('Channel-3 caution selection', () => {
  it('fills the caution budget in el then page then flow precision order', () => {
    const result = selectCautions({
      candidates: [
        caution('c_flow', { anchors: [{ t: 'flow', name: 'Checkout' }] }),
        caution('c_page', { anchors: [{ t: 'page', route: '/checkout' }] }),
        caution('c_element', {
          anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
        }),
      ],
      anchors: [
        { t: 'el', role: 'button', name: 'Place order' },
        { t: 'page', route: '/checkout' },
        { t: 'flow', name: 'Checkout' },
      ],
      budget: 2,
    })

    expect(result.block.cautions.map(({ id }) => id)).toEqual([
      'c_element',
      'c_page',
    ])
    expect(result.block.budgetUsed).toBe(2)
    expect(result.block.admissions.map(({ id }) => id)).toEqual([
      'c_element',
      'c_page',
    ])
    expect(result.block.admissions.every(({ renderedCost }) => renderedCost > 0)).toBe(true)
    expect(result.overflow).toEqual({ served: 2, eligible: 3 })
  })

  it('matches anchors only after shared normalizeAnchor equality', () => {
    const result = selectCautions({
      candidates: [
        caution('c_normalized', {
          anchors: [{ t: 'el', role: ' BUTTON ', name: ' Checkout   27 ' }],
        }),
      ],
      anchors: [{ t: 'el', role: 'button', name: 'checkout 99' }],
      budget: 2,
    })

    expect(result.block.cautions.map(({ id }) => id)).toEqual(['c_normalized'])
  })

  it('returns a typed empty block with zero budget for no anchor matches', () => {
    const result = selectCautions({
      candidates: [caution('c_other')],
      anchors: [{ t: 'page', route: '/account' }],
      budget: 8,
    })

    expect(result.block.cautions).toEqual([])
    expect(result.block.budgetUsed).toBe(0)
    expect(result.overflow).toBeUndefined()
  })

  it('excludes policy records and caps one normalized anchor cluster at half the budget', () => {
    const shared = (ordinal: number) => ({
      t: 'el' as const,
      role: 'button',
      name: 'Place order',
      ordinal,
    })
    const result = selectCautions({
      candidates: [
        caution('c_policy', {
          kind: 'policy',
          trust: Number.MAX_SAFE_INTEGER,
          anchors: [shared(1)],
        }),
        caution('c_shared_a', { anchors: [shared(1)] }),
        caution('c_shared_b', { anchors: [shared(2)] }),
        caution('c_shared_c', { anchors: [shared(3)] }),
        caution('c_other_cluster', {
          anchors: [{ t: 'el', role: 'link', name: 'Order help' }],
        }),
      ],
      anchors: [
        { t: 'el', role: 'button', name: 'Place order', ordinal: 1 },
        { t: 'el', role: 'button', name: 'Place order', ordinal: 2 },
        { t: 'el', role: 'button', name: 'Place order', ordinal: 3 },
        { t: 'el', role: 'link', name: 'Order help' },
      ],
      budget: 4,
    })

    const ids = result.block.cautions.map(({ id }) => id)
    expect(ids).not.toContain('c_policy')
    expect(ids.filter((id) => String(id).startsWith('c_shared_'))).toHaveLength(2)
    expect(ids).toContain('c_other_cluster')
  })

  it('reports every eligible match omitted by budget or dominance pressure', () => {
    const result = selectCautions({
      candidates: [
        caution('c_a', { anchors: [{ t: 'page', route: '/checkout' }] }),
        caution('c_b', { anchors: [{ t: 'page', route: '/cart' }] }),
        caution('c_c', { anchors: [{ t: 'page', route: '/orders' }] }),
      ],
      anchors: [
        { t: 'page', route: '/checkout' },
        { t: 'page', route: '/cart' },
        { t: 'page', route: '/orders' },
      ],
      budget: 2,
    })

    expect(result.block.cautions).toHaveLength(2)
    expect(result.overflow).toEqual({ served: 2, eligible: 3 })
  })

  it('DATA-wraps app-observed caution summaries with the shared delimiters', () => {
    const result = selectCautions({
      candidates: [caution('c_observed', { origin: 'app-observed' })],
      anchors: [{ t: 'page', route: '/checkout' }],
      budget: 64,
    })

    const summary = result.block.cautions[0]?.summary ?? ''
    expect(summary).toContain(APP_OBSERVED_DATA_OPEN)
    expect(summary).toContain(APP_OBSERVED_DATA_CLOSE)
  })

  it('admits an app-observed caution at exact rendered cost and rejects one token short', () => {
    const observed = caution('c_observed_exact', {
      summary: 'x',
      origin: 'app-observed',
    })
    const rendered = renderCautionLine(observed)
    const exactBudget = rendered.cost * 2
    const input = {
      candidates: [observed],
      anchors: [{ t: 'page' as const, route: '/checkout' }],
      recordCap: 1,
    }

    const exact = selectCautions({ ...input, budget: exactBudget })
    const oneTokenShort = selectCautions({ ...input, budget: exactBudget - 1 })

    expect(exact.block.cautions[0]?.summary).toBe(rendered.summary)
    expect(exact.block.budgetUsed).toBe(rendered.cost)
    expect(oneTokenShort.block.cautions).toEqual([])
  })

  it('serves the single best caution when the floor budget fits one line', () => {
    const result = selectCautions({
      candidates: [
        caution('c_only', {
          trust: 0.1,
          anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
        }),
      ],
      anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
      budget: 2,
    })

    expect(result.block.cautions.map(({ id }) => id)).toEqual(['c_only'])
    expect(result.block.budgetUsed).toBe(1)
    expect(result.overflow).toBeUndefined()
  })

  it('ranks a mixed el-and-page match in the el group and counts it once', () => {
    const result = selectCautions({
      candidates: [
        caution('c_page', {
          trust: 100,
          anchors: [{ t: 'page', route: '/checkout' }],
        }),
        caution('c_mixed', {
          trust: 0.1,
          anchors: [
            { t: 'page', route: '/checkout' },
            { t: 'el', role: 'button', name: 'Place order' },
          ],
        }),
      ],
      anchors: [
        { t: 'el', role: 'button', name: 'Place order' },
        { t: 'page', route: '/checkout' },
      ],
      budget: 2,
    })

    expect(result.block.cautions.map(({ id }) => id)).toEqual(['c_mixed', 'c_page'])
    expect(result.block.cautions.filter(({ id }) => id === 'c_mixed')).toHaveLength(1)
  })
})
