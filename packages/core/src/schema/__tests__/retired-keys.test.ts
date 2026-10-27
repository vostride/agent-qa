import { describe, it, expect } from 'vitest'
import { AgentQaConfigSchema } from '../config-schema.js'
import { refuseRetiredLocalBindings } from '../retired-keys.js'

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

function issueAt(config: unknown, path: string) {
  const result = AgentQaConfigSchema.safeParse(config)
  if (result.success) return undefined
  return result.error.issues.find(i => i.path.join('.') === path)
}

function issueMessageAt(config: unknown, path: string): string | undefined {
  return issueAt(config, path)?.message
}

function paramsAt(config: unknown, path: string): unknown {
  const issue = issueAt(config, path)
  return issue && 'params' in issue ? issue.params : undefined
}

const HARD_CUT_PARAMS = { retired: true, hardCut: true }

// Every retired key fails with a targeted one-line error naming what to do, not a bare zod
// unrecognized-key error. Keys removed in v2 also ask the CLI for the hard-cut steps.
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
    expect(paramsAt(config, `services.memory.${key}`)).toEqual(HARD_CUT_PARAMS)
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
    expect(paramsAt(config, 'workspace.agentRules')).toEqual(HARD_CUT_PARAMS)
  })
})

describe('retired-key pre-scan — block-level services.memory issue', () => {
  it('fires when any services.memory object is present', () => {
    const config = { ...validBase, services: { memory: {} } }
    const message = issueMessageAt(config, 'services.memory')
    expect(message).toBeDefined()
    expect(message).toContain('knowledge')
    expect(paramsAt(config, 'services.memory')).toEqual(HARD_CUT_PARAMS)
  })
})

describe('retired-key pre-scan — removed eval blocks', () => {
  const cases: [key: string, value: unknown, message: string][] = [
    ['gate1', {}, 'eval.gate1 was removed: memory is no longer screened by replay before promotion. Delete this block.'],
    ['gate2', {}, 'eval.gate2 was removed: completed runs no longer replay served memory. Delete this block.'],
    ['adversarial', {}, 'eval.adversarial was removed: runs no longer stage adversarial probes. Delete this block.'],
    ['seeding', {}, 'eval.seeding was removed: runs no longer seed an eval corpus. Delete this block.'],
    ['judge', 'gpt-judge', 'eval.judge was removed: pass --judge <name> to agent-qa eval replay. Delete this key.'],
    ['judges', ['a', 'b'], 'eval.judges was removed: repeat --judge <name> on agent-qa eval replay. Delete this key.'],
    ['judgeAllowSameFamily', true,
      'eval.judgeAllowSameFamily was removed: pass --judge-allow-same-family to agent-qa eval replay. Delete this key.'],
    ['k', 3, 'eval.k was removed: pass --k <n> to agent-qa eval replay. Delete this key.'],
    ['seed', 7, 'eval.seed was removed: pass --seed <n> to agent-qa eval replay. Delete this key.'],
  ]

  it.each(cases)('eval.%s is refused with its removal message and asks for no hard cut', (key, value, message) => {
    const config = { ...validBase, eval: { [key]: value } }
    expect(issueMessageAt(config, `eval.${key}`)).toBe(message)
    const result = AgentQaConfigSchema.safeParse(config)
    const issue = result.error?.issues.find(i => i.path.join('.') === `eval.${key}` && i.message === message)
    expect(issue && 'params' in issue ? issue.params : undefined).toEqual({ retired: true })
    expect(issueAt(config, 'eval')).toBeUndefined()
  })

  it('a bare or unknown-keyed eval block is refused with the block message', () => {
    for (const block of [{}, { other: 1 }, 'x']) {
      const config = { ...validBase, eval: block }
      const result = AgentQaConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
      const atEval = result.error?.issues.filter(i => i.path[0] === 'eval') ?? []
      expect(atEval).toHaveLength(1)
      expect(atEval[0]?.path).toEqual(['eval'])
      expect(atEval[0]?.message).toBe(
        'eval was removed: agent-qa eval replay takes its settings as flags. Delete this block.',
      )
      expect(atEval[0] && 'params' in atEval[0] ? atEval[0].params : undefined).toEqual({ retired: true })
    }
  })

  it('a block holding known keys gets each key message and no block line', () => {
    const config = { ...validBase, eval: { judge: 'gpt-judge', k: 3, other: 1 } }
    const result = AgentQaConfigSchema.safeParse(config)
    const atEval = result.error?.issues.filter(i => i.path[0] === 'eval') ?? []
    expect(atEval.map(i => i.path.join('.'))).toEqual(['eval.judge', 'eval.k'])
    expect(issueAt(config, 'eval')).toBeUndefined()
  })
})

describe('retired-key pre-scan: removed production keys', () => {
  it('allowProduction is refused with its removal message whatever its value', () => {
    for (const allowProduction of [true, false, null]) {
      const config = { ...validBase, allowProduction }
      expect(issueMessageAt(config, 'allowProduction'), String(allowProduction)).toBe(
        'allowProduction was removed: production targets run like any other target. Delete this line.',
      )
      expect(paramsAt(config, 'allowProduction'), String(allowProduction)).toEqual({ retired: true })
      const result = AgentQaConfigSchema.safeParse(config)
      expect(result.error?.issues.filter(i => i.code === 'unrecognized_keys')).toEqual([])
    }
  })
})

describe('retired-key pre-scan: removed BrowserStack keys', () => {
  it('registry.providers is refused with its removal message, an empty block included', () => {
    for (const providers of [null, {}, { browserstack: { username: 'u', accessKey: 'k' } }]) {
      const config = { ...validBase, registry: { providers } }
      const label = JSON.stringify(providers)
      expect(issueMessageAt(config, 'registry.providers'), label).toBe(
        'registry.providers was removed: BrowserStack is no longer supported; runs use local Playwright and Appium. Delete this block.',
      )
      expect(paramsAt(config, 'registry.providers'), label).toEqual({ retired: true })
      const result = AgentQaConfigSchema.safeParse(config)
      expect(result.error?.issues.filter(i => i.code === 'unrecognized_keys'), label).toEqual([])
    }
  })

  it("a device's transport is refused with its removal message, local included", () => {
    const message =
      'registry.devices.<name>.transport was removed: devices run on local Appium. Delete this line.'
    const configs = [
      { devices: { 'android-emu': { platform: 'android', transport: 'local' } }, names: ['android-emu'] },
      { devices: { iphone: { platform: 'ios', transport: 'browserstack' } }, names: ['iphone'] },
      {
        devices: {
          pixel: { platform: 'android', transport: 'local', match: { avd: 'Pixel_7' } },
          sim: { platform: 'ios', transport: 'local' },
        },
        names: ['pixel', 'sim'],
      },
    ]
    for (const { devices, names } of configs) {
      const config = { ...validBase, registry: { devices } }
      for (const name of names) {
        const path = `registry.devices.${name}.transport`
        expect(issueMessageAt(config, path), path).toBe(message)
        expect(paramsAt(config, path), path).toEqual({ retired: true })
      }
    }
  })

  it("a target's app.browserstack is refused with its removal message", () => {
    const config = {
      ...validBase,
      registry: {
        targets: {
          'release-android': {
            platform: 'android',
            appPackage: 'org.wikipedia.alpha',
            app: { path: 'apps/wikipedia.apk', browserstack: 'bs://uploaded-app' },
          },
        },
      },
    }
    const path = 'registry.targets.release-android.app.browserstack'
    expect(issueMessageAt(config, path)).toBe(
      'registry.targets.<name>.app.browserstack was removed: BrowserStack is no longer supported; app.path is the app file. Delete this line.',
    )
    expect(paramsAt(config, path)).toEqual({ retired: true })
  })
})

describe('retired-key pre-scan: removed cache keys', () => {
  it('services.cache.ttl is refused with its removal message', () => {
    const config = { ...validBase, services: { cache: { dir: '.agent-qa/cache', ttl: '7d' } } }
    expect(issueMessageAt(config, 'services.cache.ttl')).toBe(
      'services.cache.ttl was removed: cached plans do not expire by age. Delete this line.',
    )
    expect(paramsAt(config, 'services.cache.ttl')).toEqual({ retired: true })
    const result = AgentQaConfigSchema.safeParse(config)
    expect(result.error?.issues.filter(i => i.code === 'unrecognized_keys')).toEqual([])
  })
})

describe('agent-qa.local.yaml refusals', () => {
  const filePath = '/work/project/agent-qa.local.yaml'

  function thrownMessage(raw: unknown): string {
    try {
      refuseRetiredLocalBindings(raw, filePath)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected refuseRetiredLocalBindings to throw')
  }

  it("the local file's providers block is refused with its removal message, an empty block included", () => {
    for (const raw of [
      { providers: null },
      { providers: {} },
      { devices: {}, providers: { browserstack: { username: 'u', accessKey: 'k' } } },
    ]) {
      expect(thrownMessage(raw), JSON.stringify(raw)).toBe(
        `${filePath}:\n  providers: providers was removed: BrowserStack is no longer supported. Delete this block.`,
      )
    }
  })

  it("a local app's browserstack is refused with its removal message", () => {
    const message = thrownMessage({
      apps: {
        'release-android': { path: 'a.apk', browserstack: 'bs://x' },
        'release-ios': { path: 'b.app' },
      },
    })
    expect(message).toBe(
      `${filePath}:\n  apps.release-android.browserstack: apps.<name>.browserstack was removed: BrowserStack is no longer supported; apps.<name>.path is the app file. Delete this line.`,
    )
  })

  it('a local file with devices and app paths only is accepted', () => {
    for (const raw of [
      null,
      'text',
      { devices: { 'android-emu': { avd: 'Pixel_8_API_35' } }, apps: { 'release-android': { path: 'a.apk' } } },
      { devices: null, apps: null },
    ]) {
      expect(() => refuseRetiredLocalBindings(raw, filePath), JSON.stringify(raw)).not.toThrow()
    }
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
