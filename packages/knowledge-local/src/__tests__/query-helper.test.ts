import { asRef, type Anchor, type ScreenState } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { buildRetrievalQuery } from '../query-helper.js'
import { QUERY_CLASS_WEIGHTS } from '../retrieval/constants.js'
import { makeScreenStateFixture } from './fixtures/bundle-fixture.js'

const rawSelector = '[data-testid="checkout-submit"]'

function query(anchors: readonly Anchor[], screenState?: ScreenState) {
  return buildRetrievalQuery({
    intent: 'Complete checkout',
    anchors,
    ...(screenState === undefined ? {} : { screenState }),
  })
}

describe('retrieval query construction', () => {
  it('preserves raw selectors only in lexical text and renders deterministic semantic text', () => {
    const input = {
      intent: 'Complete checkout',
      anchors: [
        { t: 'selector', literal: rawSelector },
        { t: 'el', role: ' BUTTON ', name: ' Checkout now (3) ' },
      ],
    } as const

    const first = buildRetrievalQuery(input)
    const second = buildRetrievalQuery(input)

    expect(first).toEqual(second)
    expect(first.lexicalQuery).toContain(rawSelector)
    expect(first.lexicalQuery).toContain('Checkout now (3)')
    expect(first.lexicalQuery).toContain('checkout now')
    expect(first.semanticText).toContain('checkout now')
    expect(first.semanticText).not.toContain(rawSelector)
  })

  it('normalizes every anchor before producing canonical lookup keys', () => {
    const first = query([
      { t: 'el', role: ' BUTTON ', name: ' Cart (3) ', ordinal: 2 },
      { t: 'flow', name: ' Add   item (42) ' },
    ])
    const second = query([
      { t: 'el', role: 'button', name: 'Cart (7)', ordinal: 2 },
      { t: 'flow', name: 'add item (9)' },
    ])

    expect(first.normalizedAnchors).toEqual(second.normalizedAnchors)
    expect(first.anchorLookupKeys).toEqual(second.anchorLookupKeys)
    expect(first.anchorLookupKeys).toEqual([
      '{"name":"cart","ordinal":2,"role":"button","t":"el"}',
      '{"name":"add item","t":"flow"}',
    ])
  })

  it('carries the deterministic query class and its exact weight vector', () => {
    const result = query([{ t: 'selector', literal: '#checkout-submit' }])

    expect(result.queryClass).toBe('mixed')
    expect(result.weights).toEqual(QUERY_CLASS_WEIGHTS.mixed)
  })

  it('renders a live screen region as a non-exact fallback awaiting lexical re-confirmation', () => {
    const headingRef = asRef('e-cart-heading')
    const buttonRef = asRef('e-checkout')
    const statusRef = asRef('e-cart-status')
    const screenState = makeScreenStateFixture(0, {
      tree: 'heading Cart\nbutton Checkout now\nstatus 3 items',
      elements: [
        {
          ref: headingRef,
          role: 'heading',
          name: 'Cart',
          nameNormalized: 'cart',
          state: { enabled: true, focused: false, visible: true },
          labels: { ariaLabel: 'Cart' },
          attributes: {},
          hierarchy: { childRefs: [buttonRef, statusRef] },
        },
        {
          ref: buttonRef,
          role: 'button',
          name: 'Checkout now (9)',
          nameNormalized: 'checkout now',
          state: { enabled: true, focused: true, visible: true, clickable: true },
          labels: { ariaLabel: 'Checkout now' },
          attributes: { 'data-testid': 'checkout-submit' },
          hierarchy: { parentRef: headingRef },
        },
        {
          ref: statusRef,
          role: 'status',
          name: '3 items',
          nameNormalized: '3 items',
          state: { enabled: true, focused: false, visible: true },
          labels: { ariaLabel: '3 items' },
          attributes: {},
          hierarchy: { parentRef: headingRef },
        },
      ],
    })

    const result = query(
      [{ t: 'el', role: 'BUTTON', name: 'Checkout now (9)' }],
      screenState,
    )

    expect(result.fallbackRenderings).toHaveLength(1)
    expect(result.fallbackRenderings[0]).toMatchObject({
      anchorIndex: 0,
      fallback: true,
      anchorExact: false,
      reconfirmToken: 'checkout now',
    })
    expect(result.fallbackRenderings[0]?.text).toContain('checkout now')
    expect(result.fallbackRenderings[0]?.text).toContain('cart')
    expect(result.fallbackRenderings[0]?.text).toContain('3 items')
    expect(result.lexicalQuery).toContain(result.fallbackRenderings[0]?.reconfirmToken)
  })
})
