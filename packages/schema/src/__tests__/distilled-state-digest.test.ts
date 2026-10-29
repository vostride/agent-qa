import { describe, expect, it } from 'vitest'
import { asRef } from '../primitives/ref'
import { distilledScreenStateDigest } from '../screen/distilled-state-digest'
import type { ScreenState } from '../screen/screen-state'

function fixture(): ScreenState {
  return {
    platform: 'web', url: 'https://example.test/account/?view=one#top',
    timestamp: 1, tree: 'capture one', refMap: {},
    metadata: {
      captureMode: 'textOnly', coordSpace: 'viewport', viewportWidth: 800, viewportHeight: 600,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 800, contentHeight: 600 },
    },
    elements: ['first', 'second'].map((ref) => ({
      ref: asRef(ref), role: 'button', name: ' Continue ', nameNormalized: 'continue',
      state: { enabled: true, visible: true, focused: false }, labels: {}, attributes: {},
    })),
  }
}

describe('route-and-elements state identity', () => {
  it('pins the persisted definition to an independently computed literal digest', () => {
    expect(distilledScreenStateDigest(fixture())).toBe(
      '6bf48f864d267dcccfde281e64ecc7ad43cd356e4eea77afa98a63c2cfc8dc81',
    )
  })
  it.each(['timestamp', 'refMap', 'metadata', 'tree', 'query/hash', 'trailing slash', 'refs', 'badge'])(
    'ignores volatile %s', (field) => {
      const state = fixture()
      const original = distilledScreenStateDigest(state)
      if (field === 'timestamp') state.timestamp = 99
      if (field === 'refMap') state.refMap = { ...state.refMap, unused: {} } as ScreenState['refMap']
      if (field === 'metadata') state.metadata.viewportWidth = 1000
      if (field === 'tree') state.tree = 'a different rendering'
      if (field === 'query/hash') state.url = 'https://example.test/account/?view=two#bottom'
      if (field === 'trailing slash') state.url = 'https://example.test/account'
      if (field === 'refs') state.elements.forEach((e, i) => { e.ref = asRef(`fresh-${i}`) })
      if (field === 'badge') state.elements[0]!.name = 'CONTINUE (23)'
      expect(distilledScreenStateDigest(state)).toBe(original)
    },
  )
  it.each(['role', 'name', 'ordinal', 'route', 'platform', 'order'])(
    'changes when %s changes', (field) => {
      const state = fixture()
      const original = distilledScreenStateDigest(state)
      if (field === 'role') state.elements[0]!.role = 'checkbox'
      if (field === 'name') state.elements[0]!.name = 'Confirm'
      // The shared helper derives ordinal from same-role/nameNormalized siblings.
      if (field === 'ordinal') state.elements[1]!.nameNormalized = 'other sibling group'
      if (field === 'route') state.url = 'https://example.test/settings'
      if (field === 'platform') state.platform = 'android'
      if (field === 'order') {
        state.elements[0]!.role = 'checkbox'
        const before = distilledScreenStateDigest(state)
        state.elements.reverse()
        expect(distilledScreenStateDigest(state)).not.toBe(before)
      }
      expect(distilledScreenStateDigest(state)).not.toBe(original)
    },
  )
  it('uses a deterministic null route when the URL is absent or invalid', () => {
    const state = fixture()
    delete state.url
    expect(distilledScreenStateDigest(state)).toBe(distilledScreenStateDigest(structuredClone(state)))
    expect(distilledScreenStateDigest({ ...state, url: 'invalid URL' })).toBe(distilledScreenStateDigest(state))
  })
})
