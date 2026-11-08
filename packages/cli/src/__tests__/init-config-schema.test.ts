import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { buildDefaultConfig } from '../commands/init.js'
import {
  parseInitPlatformList,
  renderScaffoldConfigYaml,
  SCAFFOLD_CONFIG_FILE,
  type InitLLMConfig,
  type InitPlatformInput,
} from '../commands/scaffold-content.js'
import { createScaffoldContentPort } from '../composition/local-agent-host.js'

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
const CLAUDE_SUBSCRIPTION: InitLLMConfig = {
  name: 'claude-code',
  provider: 'anthropic-subscription',
  model: 'claude-sonnet-4-6',
}
const GEMINI: InitLLMConfig = { name: 'gemini', provider: 'gemini', model: 'gemini-2.5-pro' }
const SUBSCRIPTION_PLUGIN = { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' }
const PLATFORMS = ['web', 'android', 'ios', 'web,android', 'web,ios'] as const

function platformFlag(value: string): InitPlatformInput {
  const parsed = parseInitPlatformList(value)
  if ('refusal' in parsed) throw new Error(parsed.refusal)
  return parsed.platform
}

function strictParse(doc: unknown) {
  const result = AgentQaConfigSchema.safeParse(doc)
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2))
  }
  return result.data
}

// What init writes to agent-qa.config.yaml, read back the way agent-qa reads it.
function writtenConfig(platform: string, llms: InitLLMConfig[] = [CLAUDE_SUBSCRIPTION]) {
  const text = renderScaffoldConfigYaml(buildDefaultConfig(platformFlag(platform), llms))
  const doc = parseYaml(text) as Record<string, any>
  return { text, doc, parsed: strictParse(doc) }
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

describe('the config init writes', () => {
  it('for web with the Claude subscription, passes the strict parse with the dashboard on 3470, no mobile settings and the subscription plugin', () => {
    const { doc, parsed } = writtenConfig('web')

    expect(doc.services.dashboard).toEqual({ port: 3470, artifactsDir: '.agent-qa/artifacts' })
    expect(doc.use).not.toHaveProperty('mobile')
    expect(doc.plugins).toEqual([SUBSCRIPTION_PLUGIN])
    expect(doc.workspace).toEqual(CANONICAL_WORKSPACE)
    expect(doc.use.browser).toEqual({
      name: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 720 },
    })
    expect(doc.registry.targets).toEqual({
      komazon: { platform: 'web', url: 'https://playground.vostride.dev/shop/' },
      'komazon-cart-total-bug': {
        platform: 'web',
        url: 'https://playground.vostride.dev/shop/?bug=cart-total',
      },
    })
    expect(parsed.use?.llm).toBe('claude-code')
    expect(parsed.services?.dashboard?.port).toBe(3470)
  })

  it.each(['android', 'ios', 'web,android', 'web,ios'] as const)(
    'for %s, preserves the app state between tests',
    (platform) => {
      const { doc } = writtenConfig(platform)
      expect(doc.use.mobile).toEqual({ appState: 'preserve' })
    },
  )

  it('for a Gemini key, lists no plugins', () => {
    const { doc, parsed } = writtenConfig('web', [GEMINI])
    expect(doc).not.toHaveProperty('plugins')
    expect(parsed.use?.llm).toBe('gemini')
  })

  it('for two subscriptions, lists the subscription plugin once and uses the first model', () => {
    const codex: InitLLMConfig = { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.5' }
    const { doc, parsed } = writtenConfig('web', [codex, CLAUDE_SUBSCRIPTION])
    expect(doc.plugins).toEqual([SUBSCRIPTION_PLUGIN])
    expect(parsed.use?.llm).toBe('codex')
  })

  it('with no model, writes neither the model list nor use.llm and still passes the strict parse', () => {
    const { doc } = writtenConfig('web', [])
    expect(doc.registry).not.toHaveProperty('llms')
    expect(doc.use).not.toHaveProperty('llm')
    expect(doc).not.toHaveProperty('plugins')
  })

  it.each(PLATFORMS)(
    'for %s, carries the defaults agent-qa runs with',
    (platform) => {
      const { parsed } = writtenConfig(platform)

      expect(parsed.services?.cache?.dir).toBe('.agent-qa/cache')
      expect(parsed.services?.authState?.dir).toBe('.agent-qa/auth-states')
      expect(parsed.services?.recording?.enabled).toBe(true)
      expect(parsed.services?.vision?.screenshotSize).toBe(SCREENSHOT_SIZE_BYTES)
      expect(parsed.services?.vision?.effectiveResolution).toBe(768)
      expect(parsed.knowledge.dir).toBe('agent-qa-knowledge')
      expect(parsed.use?.timeout).toEqual(EXPECTED_TIMEOUT_MS)
      expect(parsed.use?.logCapture).toEqual({ console: true, network: true })
      expect(parsed.use?.parallel).toBe(false)
      for (const llm of parsed.registry?.llms ?? []) {
        expect(llm).not.toHaveProperty('screenshotSize')
        expect(llm).not.toHaveProperty('effectiveResolution')
      }
    },
  )

  it.each(PLATFORMS)(
    'for %s, says nothing about BrowserStack, the retired local file or the old dashboard port',
    (platform) => {
      const { text } = writtenConfig(platform)
      for (const stale of ['browserstack', 'agent-qa.local.yaml', '3100', 'reconcil']) {
        expect(text.toLowerCase()).not.toContain(stale)
      }
    },
  )

  it('opens with a comment that says what the file is and where the docs are', () => {
    const lines = writtenConfig('web').text.split('\n')
    expect(lines[0]).toMatch(/^# .*agent-qa reads/)
    expect(lines[1]).toBe('# Docs: https://vostride.com/docs/agent-qa/')
  })

  it.each(PLATFORMS)(
    'for %s, its commented examples sit at their block indentation and pass the strict parse uncommented',
    (platform) => {
      const { text } = writtenConfig(platform)
      const lines = text.split('\n')
      const optional = lines.indexOf('  # Optional: ignore archived or generated tests.')
      expect(optional, 'the workspace example comment is indented inside workspace').toBeGreaterThan(0)
      expect(lines[optional + 1]).toBe('  # testPathIgnore:')

      const uncommented = [
        '  # testPathIgnore:',
        '  # devices:',
        '    # my-mobile:',
      ].reduce(uncommentBlock, text)
      const parsed = strictParse(parseYaml(uncommented))

      expect(parsed.workspace?.testPathIgnore).toEqual(['tests/archive/**/*.yaml'])
      expect(parsed.registry?.devices?.pixel).toEqual({ platform: 'android', model: 'Pixel 8' })
      expect(parsed.registry?.targets?.['my-mobile']).toEqual({
        platform: 'android',
        appPackage: 'com.example.app',
        appActivity: '.MainActivity',
        app: { path: 'apps/example.apk' },
        device: 'pixel',
      })
      expect(parsed.use).not.toHaveProperty('device')
    },
  )

  it('is the config config.project.scaffold writes, byte for byte, when both are given the same target and no model', async () => {
    const target = { 'booking-com': { platform: 'web', url: 'https://booking.com' } }
    const init = buildDefaultConfig('web', [])
    const initText = renderScaffoldConfigYaml({
      ...init,
      registry: { ...(init.registry as Record<string, unknown>), targets: target },
    })

    const files = await createScaffoldContentPort().render({
      targetName: 'booking-com',
      baseUrl: 'https://booking.com',
    })
    const scaffold = files.find((file) => file.path === SCAFFOLD_CONFIG_FILE)
    expect(scaffold, 'the scaffold writes a config').toBeDefined()
    expect(Buffer.from(scaffold!.bytes).toString('utf8')).toBe(initText)
  })
})
