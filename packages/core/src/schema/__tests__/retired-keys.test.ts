import { describe, it, expect } from 'vitest'
import { AgentQaConfigSchema } from '../config-schema.js'

const validWorkspace = {
  testMatch: ['tests/**/*.yaml'],
  suiteMatch: ['suites/**/*.suite.yaml'],
  hooksFile: 'hooks.yaml',
  envFile: '.env',
  secretsFile: '.env.secrets.local',
}

const validBase = {
  workspace: validWorkspace,
  use: { mobile: { appState: 'preserve' } },
}

function issueMessageAt(config: unknown, path: string): string | undefined {
  const result = AgentQaConfigSchema.safeParse(config)
  if (result.success) return undefined
  return result.error.issues.find(i => i.path.join('.') === path)?.message
}

// D-07/D-11: every retired key must fail with a targeted one-line migration error
// naming its v2 disposition — not a bare zod unrecognized-key error.
describe('retired-key pre-scan — services.memory per-key dispositions (D-11)', () => {
  const cases: [key: string, value: unknown, substring: string][] = [
    ['dir', 'agent-qa-memory', 'knowledge.dir'],
    ['enabled', true, 'no disable switch'],
    ['provider', 'local', 'internalized — delete this key'],
    ['minTrust', 0.3, 'internalized — delete this key'],
    ['maxInjections', 3, 'internalized — delete this key'],
    ['curatorEnabled', true, 'internalized — delete this key'],
    ['curatorLockTimeout', 120_000, 'internalized — delete this key'],
    ['trustConfirmDelta', 0.05, 'internalized — delete this key'],
    ['trustContradictDelta', 0.10, 'internalized — delete this key'],
    ['ablationEnabled', true, 'no ablation exists'],
    ['circuitBreakerEnabled', true, 'no circuit breaker exists'],
    ['circuitBreakerWindowSize', 10, 'no circuit breaker exists'],
    ['circuitBreakerBaselineSize', 5, 'no circuit breaker exists'],
    ['circuitBreakerThreshold', 0.5, 'no circuit breaker exists'],
  ]

  it.each(cases)('services.memory.%s fails with its disposition', (key, value, substring) => {
    const config = { ...validBase, services: { memory: { [key]: value } } }
    const message = issueMessageAt(config, `services.memory.${key}`)
    expect(message).toBeDefined()
    expect(message).toContain(substring)
  })
})

describe('retired-key pre-scan — workspace.agentRules (D-07)', () => {
  it('workspace.agentRules fails with its policies-file destination', () => {
    const config = {
      ...validBase,
      workspace: { ...validWorkspace, agentRules: './agent-rules.md' },
    }
    const message = issueMessageAt(config, 'workspace.agentRules')
    expect(message).toBeDefined()
    expect(message).toContain('agent-qa-knowledge/policies/')
  })
})

describe('retired-key pre-scan — block-level services.memory issue', () => {
  it('fires when any services.memory object is present', () => {
    const config = { ...validBase, services: { memory: {} } }
    const message = issueMessageAt(config, 'services.memory')
    expect(message).toBeDefined()
    expect(message).toContain('knowledge')
  })
})

describe('retired-key pre-scan — removed eval blocks', () => {
  const cases: [key: string, message: string][] = [
    ['gate1', 'eval.gate1 was removed: memory is no longer screened by replay before promotion. Delete this block.'],
    ['gate2', 'eval.gate2 was removed: completed runs no longer replay served memory. Delete this block.'],
    ['adversarial', 'eval.adversarial was removed: runs no longer stage adversarial probes. Delete this block.'],
    ['seeding', 'eval.seeding was removed: eval seed no longer reads its cap from the config. Delete this block.'],
  ]

  it.each(cases)('eval.%s is refused with its removal message', (key, message) => {
    const config = { ...validBase, eval: { [key]: {} } }
    expect(issueMessageAt(config, `eval.${key}`)).toBe(message)
    const result = AgentQaConfigSchema.safeParse(config)
    const issue = result.error?.issues.find(i => i.path.join('.') === `eval.${key}` && i.message === message)
    expect(issue && 'params' in issue ? issue.params : undefined).toEqual({ retired: true })
  })
})

describe('strict backstop — arbitrary unknown keys (D-07)', () => {
  it('still rejects an arbitrary unknown top-level key via strict parsing', () => {
    const result = AgentQaConfigSchema.safeParse({ ...validBase, totallyUnknownKey: 1 })
    expect(result.success).toBe(false)
  })
})

describe('valid configs still parse through the pipe', () => {
  it('parses a valid config with a knowledge block', () => {
    const result = AgentQaConfigSchema.safeParse({
      ...validBase,
      knowledge: { dir: 'docs/knowledge', commitArtifacts: 'thumbnails' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.knowledge.dir).toBe('docs/knowledge')
      expect(result.data.knowledge.commitArtifacts).toBe('thumbnails')
    }
  })

  it('parses a valid config WITHOUT workspace.agentRules (previously required)', () => {
    const result = AgentQaConfigSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })
})
