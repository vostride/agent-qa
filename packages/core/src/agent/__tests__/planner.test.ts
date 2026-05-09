import { describe, it, expect } from 'vitest'
import type { ScreenState } from '../../types/platform.js'
import { truncateScreenState, hashScreenState } from '../observation.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: 'button "Sign In" [ref=btn-1]\ninput "Email" [ref=input-1]',
    elements: [
      { ref: 'btn-1', role: 'button', name: 'Sign In', attributes: {} },
      { ref: 'input-1', role: 'textbox', name: 'Email', attributes: {} },
    ],
    url: 'https://example.com/login',
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

describe('truncateScreenState', () => {
  it('returns full tree text', () => {
    const state = makeScreenState({
      tree: 'button "Sign In"',
    })

    const result = truncateScreenState(state)

    expect(result).toContain('button "Sign In"')
  })

  it('includes URL when available', () => {
    const state = makeScreenState({ url: 'https://example.com/dashboard' })

    const result = truncateScreenState(state)

    expect(result).toContain('Current page: https://example.com/dashboard')
  })

  it('handles empty elements list', () => {
    const state = makeScreenState({
      tree: '',
      elements: [],
    })

    const result = truncateScreenState(state)

    expect(result).toContain('Current page:')
  })
})

describe('hashScreenState', () => {
  it('produces deterministic hash for same elements', () => {
    const state1 = makeScreenState()
    const state2 = makeScreenState()

    expect(hashScreenState(state1)).toBe(hashScreenState(state2))
  })

  it('ignores dynamic values — same structure, different values', () => {
    const state1 = makeScreenState({
      elements: [
        { ref: 'btn-1', role: 'button', name: 'Sign In', value: 'old', attributes: { id: 'x' } },
        { ref: 'input-1', role: 'textbox', name: 'Email', value: 'user@a.com', attributes: {} },
      ],
    })

    const state2 = makeScreenState({
      elements: [
        { ref: 'btn-99', role: 'button', name: 'Sign In', value: 'new', attributes: { id: 'y' } },
        { ref: 'input-99', role: 'textbox', name: 'Email', value: 'user@b.com', attributes: {} },
      ],
    })

    expect(hashScreenState(state1)).toBe(hashScreenState(state2))
  })

  it('detects structural change — different elements', () => {
    const state1 = makeScreenState({
      elements: [
        { ref: 'btn-1', role: 'button', name: 'Sign In', attributes: {} },
      ],
    })

    const state2 = makeScreenState({
      elements: [
        { ref: 'btn-1', role: 'button', name: 'Register', attributes: {} },
      ],
    })

    expect(hashScreenState(state1)).not.toBe(hashScreenState(state2))
  })

  it('returns 16-character hex hash', () => {
    const state = makeScreenState()
    const hash = hashScreenState(state)

    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('handles empty elements list', () => {
    const state = makeScreenState({ elements: [] })
    const hash = hashScreenState(state)

    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })
})
