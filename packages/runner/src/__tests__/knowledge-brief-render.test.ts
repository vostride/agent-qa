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
  OBSERVATION_LINE_PREFIX,
  assembleBriefTiers,
  estimateRenderedServingCost,
  renderBriefLine,
  renderCautionLine,
  renderObservationLine,
  tierForEntry,
} from '../knowledge-brief-render.js'

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

describe('shared observation rendering (FLOOR-06 / D-06)', () => {
  it('uses the same observation prefix as the full renderer', () => {
    expect(OBSERVATION_LINE_PREFIX).toBe('Observation: ')
    expect(renderBriefLine(entry()).line.startsWith(OBSERVATION_LINE_PREFIX)).toBe(true)
  })

  it('renders a BriefLine summary without annotations or app-observed wrapping', () => {
    const { briefLine } = renderBriefLine(entry({
      origin: 'app-observed',
      unconfirmedSinceOrdinal: 17,
      unverified: true,
      servedAsCanary: true,
    }))

    expect(renderObservationLine(briefLine)).toBe(OBSERVATION_LINE_PREFIX + briefLine.summary)
    expect(renderObservationLine({ ...briefLine, summary: 'x'.repeat(141) }))
      .toBe(OBSERVATION_LINE_PREFIX + 'x'.repeat(141))
  })

  it('assigns sovereign records to L0 before caution and learned tiers', () => {
    expect(tierForEntry(entry({ origin: 'user', kind: 'caution' }))).toBe('L0')
    expect(tierForEntry(entry({ originClass: 'user' }))).toBe('L0')
    expect(tierForEntry(entry({ kind: 'caution' }))).toBe('L1')
    expect(tierForEntry(entry())).toBe('L2')
  })
})

describe('shared brief tier assembly (FLOOR-06 / D-08)', () => {
  it.each(['policy', 'policy\n'])('appends user facts with one separator after %j', (policy) => {
    expect(assembleBriefTiers(policy, ['first fact', 'second fact'], []))
      .toEqual({ L0: 'policy\nfirst fact\nsecond fact', L1: '', L2: '' })
  })

  it('preserves policy bytes when no user facts are appended', () => {
    const policy = '  policy\n\n'
    expect(assembleBriefTiers(policy, [], [])).toEqual({ L0: policy, L1: '', L2: '' })
  })

  it('keeps user facts verbatim without adding a prefix to an empty policy', () => {
    expect(assembleBriefTiers('', ['  first fact\n', '', 'second fact  '], []))
      .toEqual({ L0: '  first fact\n\n\nsecond fact  ', L1: '', L2: '' })
  })

  it('joins each learned tier in input order and excludes rendered L0 lines', () => {
    const renderedLines = [
      { tier: 'L2', line: 'learned first' },
      { tier: 'L1', line: 'caution first' },
      { tier: 'L0', line: 'sovereign rendered line' },
      { tier: 'L2', line: 'learned second\n' },
      { tier: 'L1', line: '  caution second' },
    ] as const

    expect(assembleBriefTiers('', [], renderedLines)).toEqual({
      L0: '',
      L1: 'caution first\n  caution second',
      L2: 'learned first\nlearned second\n',
    })
  })

  it('returns empty strings for empty inputs', () => {
    expect(assembleBriefTiers('', [], [])).toEqual({ L0: '', L1: '', L2: '' })
  })
})
