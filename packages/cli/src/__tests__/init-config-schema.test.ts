import { describe, expect, it } from 'vitest'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { buildDefaultConfig } from '../commands/init.js'

const SCREENSHOT_SIZE_BYTES = 50 * 1024

function parseGeneratedConfig(config: Record<string, unknown>) {
  const result = AgentQaConfigSchema.safeParse(config)
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2))
  }
  return result.data
}

function expectCompressionDefaults(config: Record<string, unknown>): void {
  const parsed = parseGeneratedConfig(config)
  expect(parsed.registry?.llms.length).toBeGreaterThan(0)
  for (const llm of parsed.registry?.llms ?? []) {
    expect(llm.screenshotSize).toBe(SCREENSHOT_SIZE_BYTES)
    expect(llm.effectiveResolution).toBe(500)
  }
}

describe('init generated config schema compatibility', () => {
  it.each(['web', 'android', 'ios', 'web+android'] as const)(
    'generates schema-valid %s config',
    (platform) => {
      const config = buildDefaultConfig(
        platform,
        'anthropic-subscription',
        'claude-sonnet-4-6',
      )

      const parsed = parseGeneratedConfig(config)
      expectCompressionDefaults(config)
      expect(parsed.services?.recording?.enabled).toBe(true)
      expect(parsed.services?.memory?.enabled).toBe(true)
      expect(parsed.services?.memory?.provider).toBe('local')
      expect(parsed.services?.memory?.dir).toBe('agent-qa-memory')
      expect(parsed.use?.timeout?.step).toBe(300000)
      expect(parsed.use?.timeout?.test).toBe(1800000)
      expect(parsed.use?.timeout?.navigation).toBe(60000)
      expect(parsed.use?.logCapture?.console).toBe(true)
      expect(parsed.use?.logCapture?.network).toBe(true)
      expect(parsed.use?.parallel).toBe(false)
      if (platform === 'web' || platform === 'web+android') {
        expect(parsed.use?.browser?.viewport).toEqual({ width: 1280, height: 720 })
        expect(parsed.registry?.targets?.['automation-exercise']).toEqual({
          platform: 'web',
          url: 'https://automationexercise.com',
        })
      }
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
    expect(parsed.services?.memory?.enabled).toBe(true)
    expect(parsed.services?.memory?.provider).toBe('local')
    expect(parsed.services?.memory?.dir).toBe('agent-qa-memory')
    expect(parsed.use?.timeout?.step).toBe(300000)
    expect(parsed.use?.timeout?.test).toBe(1800000)
    expect(parsed.use?.timeout?.navigation).toBe(60000)
    expect(parsed.use?.browser?.viewport).toEqual({ width: 1280, height: 720 })
    expect(parsed.use?.logCapture?.console).toBe(true)
    expect(parsed.use?.logCapture?.network).toBe(true)
    expect(parsed.use?.parallel).toBe(false)
    expect(parsed.plugins?.auth).toEqual([
      { package: '@vostride/agent-qa-subscription-auth' },
    ])
    for (const llm of parsed.registry?.llms ?? []) {
      expect(llm.screenshotSize).toBe(SCREENSHOT_SIZE_BYTES)
      expect(llm.effectiveResolution).toBe(500)
    }
  })
})
