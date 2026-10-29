import { describe, expect, it } from 'vitest'

import type { CurationAuthorship } from '../../delta/envelope'
import { curatorTier } from '../curator-tier'

function authorship(input: Partial<CurationAuthorship> & Pick<CurationAuthorship, 'path'>): CurationAuthorship {
  return { executionContext: 'local-headless', ...input }
}

describe('curatorTier (capability tier)', () => {
  it('is total over every authorship path and the absent case', () => {
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'claude-sonnet-4' } }))).toBe('full')
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'llama-3-8b' } }))).toBe('degraded')
    expect(curatorTier(authorship({ path: 'llm', model: undefined }))).toBe('degraded')
    expect(curatorTier(authorship({ path: 'llm-repaired', model: { id: 'claude-sonnet-4' } }))).toBe('degraded')
    expect(curatorTier(authorship({ path: 'deterministic-fallback' }))).toBe('floor')
    expect(curatorTier(undefined)).toBe('degraded')
  })

  it('matches model.family when present instead of model.id', () => {
    // family says capable even though the id alone would not match
    expect(
      curatorTier(authorship({ path: 'llm', model: { id: 'proxy-alias-7', family: 'claude-sonnet' } })),
    ).toBe('full')
    // family says weak even though the id alone would match
    expect(
      curatorTier(authorship({ path: 'llm', model: { id: 'claude-sonnet-4', family: 'llama-3' } })),
    ).toBe('degraded')
  })

  it('falls back to matching model.id against the capable-family prefixes when family is absent', () => {
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'gpt-4o-mini' } }))).toBe('full')
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'gemini-2.5-pro' } }))).toBe('full')
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'o3-mini' } }))).toBe('full')
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'mistral-large' } }))).toBe('degraded')
  })

  it('ignores the diagnostic fallbackReason member (never a tier input)', () => {
    const bare = authorship({ path: 'deterministic-fallback' })
    const stamped = { ...bare, fallbackReason: 'malformed' as const }
    expect(curatorTier(stamped)).toBe(curatorTier(bare))
    expect(curatorTier(stamped)).toBe('floor')
  })

  it('matches case-insensitively at token boundaries only', () => {
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'Claude-Opus-4' } }))).toBe('full')
    // 'o1' must not match inside a longer token
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'o100-experimental' } }))).toBe('degraded')
    expect(curatorTier(authorship({ path: 'llm', model: { id: 'neo1-8b' } }))).toBe('degraded')
  })
})
