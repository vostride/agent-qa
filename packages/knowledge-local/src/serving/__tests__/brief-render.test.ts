import {
  APP_OBSERVED_DATA_CLOSE,
  APP_OBSERVED_DATA_OPEN,
} from '@vostride/agent-qa-safety'
import {
  asRecordId,
  type IndexEntry,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  estimateRenderedServingCost,
  renderBriefLine,
  renderCautionLine,
} from '../brief-render.js'

type OriginStampedEntry = IndexEntry & {
  origin?: 'app-observed' | 'user'
  originClass?: 'agent-observed' | 'agent-verified' | 'import' | 'user'
}

const scope = { tier: 'test', key: 'checkout' } as const

function entry(overrides: Partial<OriginStampedEntry> = {}): OriginStampedEntry {
  return {
    id: asRecordId('fact-checkout'),
    kind: 'fact',
    title: 'Checkout fact',
    summary: 'The checkout page usually exposes a Place order button.',
    trust: 0.8,
    anchors: [{ t: 'el', role: 'button', name: 'Place order' }],
    status: 'active',
    servedAsCanary: false,
    scope,
    validity: 'current',
    ...overrides,
  }
}

describe('brief line rendering', () => {
  it('renders every typed serving annotation in one line', () => {
    const rendered = renderBriefLine(entry({
      unconfirmedSinceOrdinal: 17,
      unverified: true,
      servedAs: 'prior-build-hypothesis',
      conflict: {
        peerRecordId: asRecordId('fact-peer'),
        unknownRecordId: asRecordId('unknown-conflict'),
      },
      servedAsCanary: true,
    })).line

    expect(rendered).toContain('unconfirmed since build 17')
    expect(rendered).toContain('UNVERIFIED')
    expect(rendered).toContain('prior-build hypothesis')
    expect(rendered).toContain('CONFLICT')
    expect(rendered).toContain('fact-peer')
    expect(rendered).toContain('unknown-conflict')
    expect(rendered).toContain('CANARY')
  })

  it('keeps 140 UTF-16 code units whole and truncates 141 to the pinned boundary', () => {
    const atBoundary = renderBriefLine(entry({ summary: 'a'.repeat(140) }))
    const overBoundary = renderBriefLine(entry({ summary: 'b'.repeat(141) }))

    expect(atBoundary.briefLine.summary).toBe('a'.repeat(140))
    expect(atBoundary.briefLine.summary).toHaveLength(140)
    expect(overBoundary.briefLine.summary).toHaveLength(140)
    expect(overBoundary.briefLine.summary).not.toBe('b'.repeat(141))
    expect(overBoundary.line).not.toContain('b'.repeat(141))
  })

  it('DATA-wraps app-observed content but never wraps a user-origin record', () => {
    const observed = renderBriefLine(entry({ origin: 'app-observed' })).line
    const sovereign = renderBriefLine(entry({ origin: 'user' })).line

    expect(observed).toContain(APP_OBSERVED_DATA_OPEN)
    expect(observed).toContain(APP_OBSERVED_DATA_CLOSE)
    expect(sovereign).not.toContain(APP_OBSERVED_DATA_OPEN)
    expect(sovereign).not.toContain(APP_OBSERVED_DATA_CLOSE)
  })

  it('returns the cost of the exact rendered Channel-1 and Channel-3 text', () => {
    const observed = entry({ summary: 'x', origin: 'app-observed' })
    const brief = renderBriefLine(observed)
    const caution = renderCautionLine(observed)

    expect(brief.cost).toBe(estimateRenderedServingCost(brief.line))
    expect(caution.cost).toBe(estimateRenderedServingCost(caution.summary))
    expect(brief.cost).toBeGreaterThan(estimateRenderedServingCost(observed.summary))
    expect(caution.cost).toBeGreaterThan(estimateRenderedServingCost(observed.summary))
  })

  it('is byte-deterministic and contains no wall-clock material', () => {
    const fixture = entry({ unconfirmedSinceOrdinal: 42, servedAsCanary: true })
    const first = renderBriefLine(fixture)
    const second = renderBriefLine(fixture)

    expect(first).toEqual(second)
    expect(first.line).not.toMatch(/\b20\d{2}-\d{2}-\d{2}[T ]/)
  })

  it('frames learned summaries as observations rather than imperative commands', () => {
    const imperativeVerbs = [
      'click',
      'tap',
      'select',
      'enter',
      'open',
      'navigate',
      'press',
      'fill',
      'type',
      'scroll',
      'swipe',
    ]
    const fixtures = imperativeVerbs.map((verb) => renderBriefLine(entry({
      id: asRecordId(`fact-${verb}`),
      summary: `${verb} the primary control`,
    })).line)

    for (const line of fixtures) {
      expect(imperativeVerbs.some((verb) => (
        new RegExp(`^${verb}\\b`, 'i').test(line)
      ))).toBe(false)
    }
  })
})
