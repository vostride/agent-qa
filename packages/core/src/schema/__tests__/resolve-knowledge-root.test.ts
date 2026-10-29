import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { KnowledgeConfigSchema } from '../knowledge-schema.js'
import { resolveKnowledgeRoot } from '../resolve-knowledge-root.js'

describe('resolveKnowledgeRoot', () => {
  it('resolves the materialized default directory against the config directory', () => {
    const knowledge = KnowledgeConfigSchema.parse({})

    expect(resolveKnowledgeRoot(knowledge, '/repo')).toBe('/repo/agent-qa-knowledge')
  })

  it('normalizes a nested repo-relative directory beneath the config directory', () => {
    const resolved = resolveKnowledgeRoot(
      { dir: 'knowledge/./products/../shared' },
      '/repo',
    )

    expect(resolved).toBe('/repo/knowledge/shared')
    expect(path.isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(path.normalize(resolved))
  })
})
