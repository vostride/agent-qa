import { describe, it, expect } from 'vitest'
import { KnowledgeConfigSchema } from '../knowledge-schema.js'
import { AgentQaConfigSchema } from '../config-schema.js'

const minimalConfig = {
  workspace: {
    testMatch: ['tests/**/*.yaml'],
    suiteMatch: ['suites/**/*.suite.yaml'],
    hooksFile: 'hooks.yaml',
    envFile: '.env',
    secretsFile: '.env.secrets.local',
  },
  use: {
    mobile: { appState: 'preserve' },
  },
}

describe('KnowledgeConfigSchema — defaults', () => {
  it('materializes knowledge defaults on a minimal config parse', () => {
    const result = AgentQaConfigSchema.safeParse(minimalConfig)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.knowledge.dir).toBe('agent-qa-knowledge')
    }
  })

  it('parses an empty knowledge object to full defaults', () => {
    const result = KnowledgeConfigSchema.parse({})
    expect(result.dir).toBe('agent-qa-knowledge')
  })
})

describe('KnowledgeConfigSchema — dir repo-relative predicate', () => {
  it.each(['/abs/path', 'C:\\x', '../escape'])('rejects %s with the repo-relative message', (dir) => {
    const result = KnowledgeConfigSchema.safeParse({ dir })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('knowledge.dir must be repo-relative'))).toBe(true)
    }
  })

  it('accepts a repo-relative dir', () => {
    const result = KnowledgeConfigSchema.safeParse({ dir: 'docs/knowledge' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty dir', () => {
    const result = KnowledgeConfigSchema.safeParse({ dir: '' })
    expect(result.success).toBe(false)
  })
})

describe('KnowledgeConfigSchema — strict backstop', () => {
  it('rejects unknown keys inside knowledge', () => {
    const result = KnowledgeConfigSchema.safeParse({ unknownKey: true })
    expect(result.success).toBe(false)
  })
})
