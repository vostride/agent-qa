import { describe, expect, it } from 'vitest'
import { asRef } from '../primitives/ref'
import type { ScreenState } from '../screen/screen-state'
import { screenIdentityHash, screenStateHash } from '../determinism/screen-hash'

const buttonRef = asRef('ref-button')
const linkRef = asRef('ref-link')

function makeState(options: {
  scrollOffsetY?: number
  attributes?: Record<string, string>
  refMapOrder?: 'button-first' | 'link-first'
} = {}): ScreenState {
  const scrollOffsetY = options.scrollOffsetY ?? 0
  const attributes = options.attributes ?? { id: 'checkout', class: 'primary' }
  const buttonBounds = { x: 10, y: 10, width: 80, height: 20 }
  const linkBounds = { x: 10, y: 140, width: 80, height: 20 }
  const buttonElementBounds = { bounds: buttonBounds, center: { x: 50, y: 20 } }
  const linkElementBounds = { bounds: linkBounds, center: { x: 50, y: 150 } }
  const refMap = options.refMapOrder === 'link-first'
    ? { [linkRef]: linkElementBounds, [buttonRef]: buttonElementBounds }
    : { [buttonRef]: buttonElementBounds, [linkRef]: linkElementBounds }

  return {
    platform: 'web',
    tree: 'button Checkout\nlink Terms',
    elements: [
      {
        ref: buttonRef,
        role: 'button',
        name: 'Checkout',
        nameNormalized: 'checkout',
        bounds: buttonBounds,
        center: { x: 50, y: 20 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Checkout' },
        attributes,
      },
      {
        ref: linkRef,
        role: 'link',
        name: 'Terms',
        nameNormalized: 'terms',
        bounds: linkBounds,
        center: { x: 50, y: 150 },
        state: { enabled: true, focused: false, visible: true },
        labels: { title: 'Terms' },
        attributes: { href: '/terms' },
      },
    ],
    refMap,
    url: 'https://example.test/checkout',
    timestamp: 1700000000000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 390,
      viewportHeight: 100,
      scroll: { offsetX: 0, offsetY: scrollOffsetY, contentWidth: 390, contentHeight: 320 },
    },
  }
}

describe('screen fingerprints', () => {
  it('changes screenIdentityHash when scroll changes visibility', () => {
    const before = makeState({ scrollOffsetY: 0 })
    const after = makeState({ scrollOffsetY: 90 })

    expect(screenIdentityHash(before)).not.toBe(screenIdentityHash(after))
  })

  it('returns distinct purpose-split hashes for the same state', () => {
    const state = makeState()

    expect(screenIdentityHash(state)).toMatch(/^[0-9a-f]{64}$/)
    expect(screenStateHash(state)).toMatch(/^[0-9a-f]{64}$/)
    expect(screenIdentityHash(state)).not.toBe(screenStateHash(state))
  })

  it('is independent of refMap and attribute insertion order', () => {
    const first = makeState({
      attributes: { id: 'checkout', class: 'primary' },
      refMapOrder: 'button-first',
    })
    const second = makeState({
      attributes: { class: 'primary', id: 'checkout' },
      refMapOrder: 'link-first',
    })

    expect(screenStateHash(first)).toBe(screenStateHash(second))
    expect(screenIdentityHash(first)).toBe(screenIdentityHash(second))
  })

  it('is idempotent for both fingerprint functions', () => {
    const state = makeState()

    expect(screenIdentityHash(state)).toBe(screenIdentityHash(state))
    expect(screenStateHash(state)).toBe(screenStateHash(state))
  })
})
