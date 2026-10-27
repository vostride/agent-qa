import { afterEach, describe, expect, it, vi } from 'vitest'

import { deriveVision, getModelCatalog } from '../catalog/catalog.js'

const providerIds = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

function findEntry(provider: (typeof providerIds)[number], id: string) {
  return getModelCatalog()[provider].find(entry => entry.id === id)
}

describe('model catalog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns entries for all supported provider ids', () => {
    const catalog = getModelCatalog()

    expect(Object.keys(catalog).sort()).toEqual([...providerIds].sort())
    for (const provider of providerIds) {
      expect(Array.isArray(catalog[provider])).toBe(true)
    }
  })

  it('shares the Claude catalog between Anthropic-compatible providers', () => {
    const catalog = getModelCatalog()

    expect(catalog['anthropic-compatible']).toEqual(catalog['anthropic-subscription'])
    expect(catalog['anthropic-compatible'].map(entry => entry.id)).toContain('claude-sonnet-4-6')
  })

  it('derives vision from the family table and supports explicit overrides', () => {
    expect(findEntry('openai-compatible', 'deepseek-chat')).toMatchObject({
      id: 'deepseek-chat',
      vision: false,
      notes: 'Text-only model; use the accessibility tree.',
    })
    expect(findEntry('openai-compatible', 'qwen2.5-vl')).toMatchObject({
      id: 'qwen2.5-vl',
      vision: true,
    })
    expect(findEntry('openai-compatible', 'gpt-5.5')).toMatchObject({
      id: 'gpt-5.5',
      vision: true,
    })
    expect(findEntry('anthropic-compatible', 'claude-sonnet-4-6')).toMatchObject({
      id: 'claude-sonnet-4-6',
      vision: true,
    })
    expect(deriveVision('mystery-vl-1', true)).toBe(true)
  })

  it('keeps the static catalog network-free', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    getModelCatalog()

    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })
})
