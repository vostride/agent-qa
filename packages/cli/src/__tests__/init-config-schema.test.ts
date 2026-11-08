import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { buildDefaultConfig } from '../commands/init.js'
import {
  parseInitPlatformList,
  renderScaffoldConfigYaml,
  type InitPlatformInput,
} from '../commands/scaffold-content.js'

const SCREENSHOT_SIZE_BYTES = 256 * 1024
const CANONICAL_WORKSPACE = {
  testMatch: ['tests/**/*.yaml'],
  suiteMatch: ['suites/**/*.suite.yaml'],
  hooksFile: 'hooks.yaml',
  envFile: '.env',
  secretsFile: '.env.secrets.local',
}
const EXPECTED_TIMEOUT_MS = {
  step: 1200000,
  test: 5400000,
  navigation: 120000,
}

function platformFlag(value: string): InitPlatformInput {
  const parsed = parseInitPlatformList(value)
  if ('refusal' in parsed) throw new Error(parsed.refusal)
  return parsed.platform
}

function parseGeneratedConfig(config: Record<string, unknown>) {
  const result = AgentQaConfigSchema.safeParse(config)
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2))
  }
  return result.data
}

function uncommentBlock(text: string, firstLine: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(firstLine)
  if (start === -1) throw new Error(`the scaffold has no line ${JSON.stringify(firstLine)}`)
  for (let i = start; i < lines.length && /^\s*# /.test(lines[i]!); i++) {
    lines[i] = lines[i]!.replace(/^(\s*)# /, '$1')
  }
  return lines.join('\n')
}

function expectCompressionDefaults(config: Record<string, unknown>): void {
  const parsed = parseGeneratedConfig(config)
  expect(parsed.registry?.llms.length).toBeGreaterThan(0)
  expect(parsed.services?.vision?.screenshotSize).toBe(SCREENSHOT_SIZE_BYTES)
  expect(parsed.services?.vision?.effectiveResolution).toBe(768)
  for (const llm of parsed.registry?.llms ?? []) {
    expect(llm).not.toHaveProperty('screenshotSize')
    expect(llm).not.toHaveProperty('effectiveResolution')
  }
}

describe('init generated config schema compatibility', () => {
  it.each(['web', 'android', 'ios', 'web,android'] as const)(
    'generates schema-valid %s config',
    (platform) => {
      const config = buildDefaultConfig(
        platformFlag(platform),
        'anthropic-subscription',
        'claude-sonnet-4-6',
      )

      const parsed = parseGeneratedConfig(config)
      expectCompressionDefaults(config)
      expect(parsed.services?.recording?.enabled).toBe(true)
      expect(parsed.services?.authState?.dir).toBe('.agent-qa/auth-states')
      // The template writes no retired key; knowledge defaults materialize via prefault.
      expect(config.workspace).not.toHaveProperty('agentRules')
      expect(config.services).not.toHaveProperty('memory')
      expect(parsed.knowledge.dir).toBe('agent-qa-knowledge')
      expect(parsed.use?.timeout).toEqual(EXPECTED_TIMEOUT_MS)
      expect(parsed.use?.logCapture?.console).toBe(true)
      expect(parsed.use?.logCapture?.network).toBe(true)
      expect(parsed.use?.parallel).toBe(false)
      if (platform === 'web' || platform === 'web,android') {
        expect(parsed.use?.browser?.viewport).toEqual({ width: 1280, height: 720 })
        expect(parsed.registry?.targets?.komazon).toEqual({
          platform: 'web',
          url: 'https://playground.vostride.dev/shop/',
        })
        expect(parsed.registry?.targets?.['komazon-cart-total-bug']).toEqual({
          platform: 'web',
          url: 'https://playground.vostride.dev/shop/?bug=cart-total',
        })
      }
    },
  )

  it.each(['web', 'android', 'ios', 'web,android'] as const)(
    'writes the %s config with the cache under .agent-qa, the canonical workspace and app state for mobile platforms, and no retired key or reconciliation',
    (platform) => {
      const config = buildDefaultConfig(platformFlag(platform), 'anthropic-subscription', 'claude-sonnet-4-6')
      const parsed = parseGeneratedConfig(config)
      const written = renderScaffoldConfigYaml(config)

      expect(parsed.services?.cache?.dir).toBe('.agent-qa/cache')
      expect(written).toContain('dir: .agent-qa/cache')
      expect(config.workspace).toEqual(CANONICAL_WORKSPACE)
      if (platform === 'web') {
        expect(parsed.use?.mobile).toBeUndefined()
      } else {
        expect(parsed.use?.mobile?.appState).toBe('preserve')
      }
      for (const retired of ['memory:', 'agentRules', 'actionProofs']) {
        expect(written).not.toContain(retired)
      }
      expect(written.toLowerCase()).not.toContain('reconcil')
    },
  )

  it.each(['web', 'android', 'ios', 'web,android'] as const)(
    'the %s scaffold with its device and mobile target examples uncommented passes the strict parse',
    (platform) => {
      const config = buildDefaultConfig(platformFlag(platform), 'anthropic-subscription', 'claude-sonnet-4-6')
      const written = renderScaffoldConfigYaml(config)
      const uncommented = uncommentBlock(
        uncommentBlock(written, '  # devices:'),
        '    # my-mobile:',
      )

      const parsed = parseGeneratedConfig(parseYaml(uncommented) as Record<string, unknown>)
      expect(parsed.registry?.devices?.pixel).toMatchObject({
        platform: 'android',
        model: 'Pixel 8',
      })
      expect(parsed.registry?.targets?.['my-mobile']).toMatchObject({
        platform: 'android',
        device: 'pixel',
      })
      expect(parsed.use).not.toHaveProperty('device')
    },
  )

  it('generates schema-valid dual subscription config', () => {
    const config = buildDefaultConfig('web', [
      { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.5' },
      { name: 'claude-subscription', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' },
    ])

    const parsed = parseGeneratedConfig(config)
    expect(parsed.use?.llm).toBe('codex')
    expect(parsed.services?.recording?.enabled).toBe(true)
    expect(parsed.services?.authState?.dir).toBe('.agent-qa/auth-states')
    expect(config.workspace).not.toHaveProperty('agentRules')
    expect(config.services).not.toHaveProperty('memory')
    expect(parsed.knowledge.dir).toBe('agent-qa-knowledge')
    expect(parsed.use?.timeout).toEqual(EXPECTED_TIMEOUT_MS)
    expect(parsed.use?.browser?.viewport).toEqual({ width: 1280, height: 720 })
    expect(parsed.use?.logCapture?.console).toBe(true)
    expect(parsed.use?.logCapture?.network).toBe(true)
    expect(parsed.use?.parallel).toBe(false)
    expect(parsed.plugins).toEqual([
      { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' },
    ])
    expectCompressionDefaults(config)
  })

  it('emits identical timeout defaults for subscription and compatible baseURL configs', () => {
    const subscriptionConfig = buildDefaultConfig(
      'web',
      'anthropic-subscription',
      'claude-sonnet-4-6',
    )
    const compatibleConfig = buildDefaultConfig(
      'web',
      'openai-compatible',
      'deepseek-chat',
      'https://remote.example/api/v1',
    )

    const subscriptionParsed = parseGeneratedConfig(subscriptionConfig)
    const compatibleParsed = parseGeneratedConfig(compatibleConfig)

    expect(subscriptionParsed.use?.timeout).toEqual(EXPECTED_TIMEOUT_MS)
    expect(compatibleParsed.use?.timeout).toEqual(subscriptionParsed.use?.timeout)
  })
})
