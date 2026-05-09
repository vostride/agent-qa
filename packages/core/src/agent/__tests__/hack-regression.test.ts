import { describe, it, expect } from 'vitest'
import { buildVerificationPrompt, buildAssertionPrompt, buildExtractionPrompt } from '../prompts.js'
import { truncateScreenState } from '../observation.js'
import type { ScreenState } from '../../types/platform.js'

function makeScreenState(overrides?: Partial<ScreenState>): ScreenState {
  return {
    tree: '- button "Submit" [ref=e1]',
    elements: [{ ref: 'e1', role: 'button', name: 'Submit', attributes: {} }],
    timestamp: Date.now(),
    metadata: { coordSpace: 'viewport' as const, viewportWidth: 0, viewportHeight: 0 },
    ...overrides,
  }
}

const LARGE_TREE = Array.from({ length: 200 }, (_, i) =>
  `- button "Button ${i}" [ref=e${i}] @(${i * 10},${i * 20} 100x40)`
).join('\n')

describe('hack-regression', () => {
  describe('HK-01..03: token budget removal from prompt builders', () => {
    const largeState = makeScreenState({ tree: LARGE_TREE })

    it('buildVerificationPrompt includes full ARIA tree without truncation', () => {
      const action = { type: 'click' as const, ref: 'e1' }
      const result = buildVerificationPrompt('click button', largeState, largeState, action)
      expect(result).toContain(LARGE_TREE)
      expect(result).not.toContain('... and')
      expect(result).not.toContain('more elements')
    })

    it('buildAssertionPrompt includes full ARIA tree without truncation', () => {
      const result = buildAssertionPrompt(
        { type: 'text-presence', value: 'Submit button visible' },
        largeState,
      )
      expect(result).toContain(LARGE_TREE)
      expect(result).not.toContain('... and')
      expect(result).not.toContain('more elements')
    })

    it('buildExtractionPrompt includes full ARIA tree without truncation', () => {
      const result = buildExtractionPrompt(
        { method: 'ai', variableName: 'count', description: 'number of buttons' },
        largeState,
      )
      expect(result).toContain(LARGE_TREE)
      expect(result).not.toContain('... and')
      expect(result).not.toContain('more elements')
    })
  })

  describe('HK-04: truncateScreenState no budget parameter', () => {
    it('returns full tree content regardless of tree length', () => {
      const state = makeScreenState({ tree: LARGE_TREE })
      const result = truncateScreenState(state)
      expect(result).toContain(LARGE_TREE)
    })

    it('prefixes with Current page URL when state.url is set', () => {
      const state = makeScreenState({ url: 'https://example.com/dashboard' })
      const result = truncateScreenState(state)
      expect(result).toMatch(/^Current page: https:\/\/example\.com\/dashboard/)
    })

    it('includes viewport summary when refMap and viewportHeight present', () => {
      const state = makeScreenState({
        metadata: {
          coordSpace: 'viewport' as const,
          viewportWidth: 1280,
          viewportHeight: 800,
          refMap: {
            e1: { bounds: { x: 0, y: 100, width: 100, height: 40 } },
            e2: { bounds: { x: 0, y: -50, width: 100, height: 40 } },
            e3: { bounds: { x: 0, y: 900, width: 100, height: 40 } },
          },
        },
      })
      const result = truncateScreenState(state)
      expect(result).toContain('[viewport:')
      expect(result).toContain('elements visible')
    })

    it('accepts exactly 1 argument (no budget parameter)', () => {
      expect(truncateScreenState.length).toBe(1)
    })
  })

  describe('HK-06: @ai-sdk/google resolves', () => {
    it('module resolves and exports createGoogleGenerativeAI', async () => {
      const mod = await import('@ai-sdk/google')
      expect(mod).toBeDefined()
      expect(mod.createGoogleGenerativeAI).toBeTypeOf('function')
    })
  })

  describe('HK-07: effectiveResolution fail-fast', () => {
    it('loop.ts does not contain the 1568 magic number fallback', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const loopPath = path.resolve(import.meta.dirname, '..', 'loop.ts')
      const source = fs.readFileSync(loopPath, 'utf-8')
      expect(source).not.toContain('?? 1568')
      expect(source).toContain('effectiveResolution is required')
    })
  })
})
