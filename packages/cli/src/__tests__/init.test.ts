import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { dirname, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

// Mock fs and child_process before importing
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../commands/install-browsers.js', () => ({
  formatInstallBrowsersRetryCommand: vi.fn(() => 'agent-qa install-browsers --chromium'),
  runBrowserInstall: vi.fn(() => ({ ok: true, status: 0, stage: 'installer' })),
}))

vi.mock('@inquirer/select', () => ({
  default: vi.fn(),
}))

vi.mock('@inquirer/input', () => ({
  default: vi.fn(),
}))

vi.mock('@inquirer/checkbox', () => ({
  default: vi.fn(),
}))

vi.mock('@inquirer/confirm', () => ({
  default: vi.fn(),
}))

vi.mock('@inquirer/password', () => ({
  default: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', () => ({
  writeAuth: vi.fn(() => Promise.resolve()),
  createModel: vi.fn(),
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally with `npm install -D appium` or globally with `npm install -g appium`.'),
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
}))

// Suppress console output in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

import { createInitCommand, buildDefaultConfig, PROVIDER_CHOICES, COMPATIBLE_PROVIDER_CHOICES, LLM_SETUP_CHOICES } from '../commands/init.js'
import { formatInstallBrowsersRetryCommand, runBrowserInstall } from '../commands/install-browsers.js'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import select from '@inquirer/select'
import input from '@inquirer/input'
import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import password from '@inquirer/password'
import { resolveAppiumExecutable, writeAuth } from '@vostride/agent-qa-core'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mockWriteFileSync = vi.mocked(writeFileSync)
const mockMkdirSync = vi.mocked(mkdirSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)
const mockRunBrowserInstall = vi.mocked(runBrowserInstall)
const mockFormatInstallBrowsersRetryCommand = vi.mocked(formatInstallBrowsersRetryCommand)
const mockSelect = vi.mocked(select)
const mockInput = vi.mocked(input)
const mockCheckbox = vi.mocked(checkbox)
const mockConfirm = vi.mocked(confirm)
const mockPassword = vi.mocked(password)
const mockWriteAuth = vi.mocked(writeAuth)
const mockResolveAppiumExecutable = vi.mocked(resolveAppiumExecutable)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

async function runInit(args: string[] = []): Promise<void> {
  const parent = new Command()
  parent.addCommand(createInitCommand())
  await parent.parseAsync(['node', 'test', 'init', ...args])
}

function findWriteCallEndingWith(pathSuffix: string) {
  return mockWriteFileSync.mock.calls.find(
    (call) => (call[0] as string).endsWith(pathSuffix),
  )
}

function consoleOutput(): string {
  return stripVTControlCharacters(vi.mocked(console.log).mock.calls.flat().map(String).join('\n'))
}

async function loadCoreYamlValidators() {
  const moduleUrl = (path: string) => pathToFileURL(resolve(repoRoot, path)).href
  const [yamlParser, suiteSchema, hooksSchema] = await Promise.all([
    import(/* @vite-ignore */ moduleUrl('packages/core/src/parser/yaml-parser.ts')),
    import(/* @vite-ignore */ moduleUrl('packages/core/src/schema/suite-schema.ts')),
    import(/* @vite-ignore */ moduleUrl('packages/core/src/hooks/schema.ts')),
  ])
  return {
    parseTestFile: yamlParser.parseTestFile as (content: string, filePath: string) => { tests: any[]; errors: any[] },
    SuiteDefinitionSchema: suiteSchema.SuiteDefinitionSchema,
    HooksFileSchema: hooksSchema.HooksFileSchema,
  }
}

describe('init command', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockImplementation((path) => String(path).endsWith('package.json') ? '{"version":"0.1.1"}' : '')
    mockRunBrowserInstall.mockReturnValue({ ok: true, status: 0, stage: 'installer' })
    mockFormatInstallBrowsersRetryCommand.mockReturnValue('agent-qa install-browsers --chromium')
    mockResolveAppiumExecutable.mockReturnValue({ command: 'appium', source: 'path' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates config file with correct YAML structure', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeDefined()

    const content = configCall![1] as string
    expect(content).toContain('workspace:')
    expect(content).toContain('hooksFile: hooks.yaml')
    expect(content).toContain('agentRules: ./agent-rules.md')
    expect(content).toContain('envFile: .env')
    expect(content).toContain('secretsFile: .env.secrets.local')
    expect(content).toContain('services:')
    expect(content).toContain('mcp:')
    expect(content).toContain('enabled: true')
    expect(content).toContain('transport: http')
    expect(content).toContain('host: 127.0.0.1')
    expect(content).toContain('port: 3471')
    expect(content).toContain('path: /mcp')
    expect(content).toContain('recording:')
    expect(content).toContain('memory:')
    expect(content).toContain('provider: local')
    expect(content).toContain('dir: agent-qa-memory')
    expect(content).toContain('registry:')
    expect(content).toContain('targets:')
    expect(content).toContain('example-web:')
    expect(content).toContain('url: https://example.com')
    expect(content).toContain('automation-exercise:')
    expect(content).toContain('url: https://automationexercise.com')
    expect(content).toContain('wai-bad:')
    expect(content).toContain('url: https://www.w3.org/WAI/demos/bad/before/home.html')
    expect(content).toContain('use:')
    expect(content).toContain('mobile:')
    expect(content).toContain('appState: preserve')
    expect(content).toContain('dir: .agent-qa/cache')
    expect(content).toContain('plugins:')
    expect(content).toContain('package: "@vostride/agent-qa-subscription-auth"')
    expect(content).toContain('provider: anthropic-subscription')
    expect(content).toContain('model: claude-sonnet-4-6')
    expect(content).toContain('screenshotSize: 50kb')
    expect(content).toContain('effectiveResolution: 500')
    expect(content).not.toContain('screenshotSize: 1m')
    expect(content).toContain('timeout:')
    expect(content).toContain('step: 5m')
    expect(content).toContain('test: 30m')
    expect(content).toContain('navigation: 1m')
    expect(content).not.toContain('step: 30s')
    expect(content).not.toContain('test: 10m')
    expect(content).not.toContain('navigation: 10s')
    expect(content).toContain('healing:')
    expect(content).toContain('chromium')
    expect(content).toContain('viewport:')
    expect(content).toContain('width: 1280')
    expect(content).toContain('height: 720')
    expect(content).toContain('logCapture:')
    expect(content).toContain('console: true')
    expect(content).toContain('network: true')
    expect(content).toContain('parallel: false')
    expect(content).not.toContain('\nanalytics:\n')
    expect(content).not.toContain('\nprivacy:')
    expect(content).not.toContain('# Optional analytics example:')
    expect(content).not.toContain('# analytics:')
    expect(content).not.toContain('#   privacy: true')
    expect(content).toContain('# Optional: ignore archived or generated tests.')
    expect(content).toContain('  # testPathIgnore:')
    expect(content).toContain('# Accessibility checks power the W3C BAD demo test.')
    expect(content).toContain('accessibility:')
    expect(content).toContain('standard: wcag2aa')
    expect(content).toContain('runAfter: every-step')
    expect(content).toContain('failOnViolation: false')
    expect(content).not.toContain('  # recording:')
    expect(content).not.toContain('  # memory:')
    expect(content).toContain('# Named resource definitions')
    expect(content).toContain('  # devices:')
    expect(content).toContain('  # providers:')
    expect(content).toContain('    # my-mobile:')
    expect(content).toContain('    #   appPackage: com.example.app')
    expect(content).toContain('    #   appActivity: .MainActivity')
    expect(content).toContain('    #     path: apps/example.apk')
    expect(content).not.toContain('  # logCapture:')
    expect(content).not.toContain('  #   console: true')
    expect(content).not.toContain('  #   network: true')
    expect(content).not.toContain('  # parallel: false')
    expect(content).toContain('  # device: android-emu')
    expect(content).not.toContain('# Optional configuration examples (uncomment only what you need)')
    expect(content).not.toContain('# workspace:')
    expect(content).not.toContain('# services:')
    expect(content).not.toContain('# registry:')
    expect(content).not.toContain('# use:')
    expect(content).not.toContain('authMethod')
    expect(content).not.toContain('apiKey')

    const packageJsonCall = findWriteCallEndingWith('package.json')
    expect(packageJsonCall).toBeDefined()
    expect(JSON.parse(packageJsonCall![1] as string)).toEqual({
      private: true,
      devDependencies: {
        '@vostride/agent-qa-subscription-auth': '0.1.1',
      },
    })
  })

  it('provider choices include only current LLM providers', () => {
    const values = PROVIDER_CHOICES.map(choice => choice.value)

    expect(values).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'openai-subscription',
      'anthropic-subscription',
      'gemini',
    ])
    expect(values).not.toContain('anthropic')
    expect(values).not.toContain('openai')
    expect(values).not.toContain('google')
    expect(values).not.toContain('authMethod')
    expect(values).not.toContain('ollama')
    expect(values).not.toContain('lmstudio')
    expect(values).not.toContain('custom')
  })

  it('compatible provider choices exclude subscription providers', () => {
    expect(COMPATIBLE_PROVIDER_CHOICES.map(choice => choice.value)).toEqual([
      'openai-compatible',
      'anthropic-compatible',
      'gemini',
    ])
  })

  it('LLM setup choices offer no subscription auth, Codex, and Claude Code', () => {
    expect(LLM_SETUP_CHOICES.map(choice => choice.value)).toEqual([
      'none',
      'codex',
      'claude-code',
    ])
  })

  it('builds openai-compatible config with user-supplied baseURL and no inline apiKey', () => {
    const config = buildDefaultConfig(
      'web',
      'openai-compatible',
      'deepseek-chat',
      'https://remote.example/api/v1',
    ) as any

    expect(config.registry.llms).toEqual([
      expect.objectContaining({
        name: 'default',
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        baseURL: 'https://remote.example/api/v1',
        screenshotSize: '50kb',
        effectiveResolution: 500,
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.registry.llms[0]).not.toHaveProperty('authMethod')
    expect(config.use.mobile.appState).toBe('preserve')
    expect(config.use.browser.viewport).toEqual({ width: 1280, height: 720 })
    expect(config.use.logCapture).toEqual({ console: true, network: true })
    expect(config.use.parallel).toBe(false)
    expect(config.services.recording).toEqual({ enabled: true })
    expect(config.services.memory).toEqual({ enabled: true, provider: 'local', dir: 'agent-qa-memory' })
  })

  it('builds anthropic-compatible config with exact baseURL and no authMethod or inline apiKey', () => {
    const config = buildDefaultConfig(
      'web',
      'anthropic-compatible',
      'claude-remote',
      'https://anthropic-proxy.example/messages',
    ) as any

    expect(config.registry.llms).toEqual([
      expect.objectContaining({
        name: 'default',
        provider: 'anthropic-compatible',
        model: 'claude-remote',
        baseURL: 'https://anthropic-proxy.example/messages',
        screenshotSize: '50kb',
        effectiveResolution: 500,
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('authMethod')
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.use.mobile.appState).toBe('preserve')
    expect(config.use.browser.viewport).toEqual({ width: 1280, height: 720 })
    expect(config.use.logCapture).toEqual({ console: true, network: true })
    expect(config.use.parallel).toBe(false)
    expect(config.services.recording).toEqual({ enabled: true })
    expect(config.services.memory).toEqual({ enabled: true, provider: 'local', dir: 'agent-qa-memory' })
  })

  it('builds Gemini config without subscription auth plugin or base URL', () => {
    const config = buildDefaultConfig('web', 'gemini', 'gemini-3-flash-preview') as any

    expect(config.registry.llms).toEqual([
      expect.objectContaining({
        name: 'default',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        screenshotSize: '50kb',
        effectiveResolution: 500,
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('baseURL')
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config).not.toHaveProperty('plugins')
  })

  it('builds dual subscription config and points use.llm at the first subscription', () => {
    const config = buildDefaultConfig('web', [
      { name: 'codex', provider: 'openai-subscription', model: 'gpt-5.5' },
      { name: 'claude-subscription', provider: 'anthropic-subscription', model: 'claude-sonnet-4-6' },
    ]) as any

    expect(config.registry.llms).toEqual([
      expect.objectContaining({
        name: 'codex',
        provider: 'openai-subscription',
        model: 'gpt-5.5',
        screenshotSize: '50kb',
        effectiveResolution: 500,
      }),
      expect.objectContaining({
        name: 'claude-subscription',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-4-6',
        screenshotSize: '50kb',
        effectiveResolution: 500,
      }),
    ])
    expect(config.plugins).toEqual({
      auth: [{ package: '@vostride/agent-qa-subscription-auth' }],
    })
    expect(config.use.llm).toBe('codex')
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.registry.llms[1]).not.toHaveProperty('authMethod')
  })

  it.each(['web', 'android', 'ios', 'web+android', 'web+ios'] as const)(
    'builds %s config with required mobile app state',
    (platform) => {
      const config = buildDefaultConfig(
        platform,
        'anthropic-subscription',
        'claude-sonnet-4-6',
      ) as any

      expect(config.use.mobile.appState).toBe('preserve')
      expect(config.use.logCapture).toEqual({ console: true, network: true })
      expect(config.use.parallel).toBe(false)
      expect(config.services.recording).toEqual({ enabled: true })
      expect(config.services.memory).toEqual({ enabled: true, provider: 'local', dir: 'agent-qa-memory' })
      expect(config.services.mcp).toEqual({
        enabled: true,
        transport: 'http',
        host: '127.0.0.1',
        port: 3471,
        path: '/mcp',
      })
      expect(config.plugins).toEqual({
        auth: [{ package: '@vostride/agent-qa-subscription-auth' }],
      })
      if (platform === 'web' || platform === 'web+android' || platform === 'web+ios') {
        expect(config.services.accessibility).toEqual({
          enabled: true,
          standard: 'wcag2aa',
          runAfter: 'every-step',
          failOnViolation: false,
        })
        expect(config.registry.targets).toHaveProperty('wai-bad')
      } else {
        expect(config.services).not.toHaveProperty('accessibility')
        expect(config.registry.targets).not.toHaveProperty('wai-bad')
      }
      if (platform === 'web+android') {
        expect(config.registry.targets).toHaveProperty('example-web')
        expect(config.registry.targets).toHaveProperty('automation-exercise')
        expect(config.registry.targets).toHaveProperty('example-android')
      }
      if (platform === 'web+ios') {
        expect(config.registry.targets).toHaveProperty('example-web')
        expect(config.registry.targets).toHaveProperty('automation-exercise')
        expect(config.registry.targets).toHaveProperty('example-ios')
      }
      expect(config).not.toHaveProperty('analytics')
    },
  )

  it('prompts model as free text and does not collect first-party API keys during interactive init', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['web'])
      .mockResolvedValueOnce(['none'])
    mockSelect.mockResolvedValueOnce('anthropic-compatible')
    mockInput
      .mockResolvedValueOnce('claude-remote')
      .mockResolvedValueOnce('https://anthropic-proxy.example/messages')
    mockConfirm.mockResolvedValueOnce(false)

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    expect(mockCheckbox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'What platform will you test?',
      choices: [
        { value: 'web', name: 'Web', description: 'Test web apps with Playwright', checked: true },
        { value: 'mobile', name: 'Mobile', description: 'Test Android or iOS apps with Appium', checked: false },
      ],
      required: true,
    }))
    expect(mockCheckbox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining('Subscription auth'),
      choices: LLM_SETUP_CHOICES,
      required: true,
    }))
    expect(mockSelect).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'Which LLM provider?',
      choices: COMPATIBLE_PROVIDER_CHOICES,
      default: 'anthropic-compatible',
    }))
    expect(mockInput).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'Model name:',
      default: 'claude-sonnet-4-6',
    }))
    expect(mockInput).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: 'Base URL:',
    }))
    expect(mockPassword).not.toHaveBeenCalled()
    expect(mockWriteAuth).not.toHaveBeenCalled()

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('provider: anthropic-compatible')
    expect(configCall?.[1]).toContain('baseURL: https://anthropic-proxy.example/messages')
    expect(configCall?.[1]).not.toContain('apiKey')
  })

  it('prompts for required mobile runtimes when Mobile is selected', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['web', 'mobile'])
      .mockResolvedValueOnce(['android'])
      .mockResolvedValueOnce(['codex'])

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    expect(mockCheckbox).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: 'Which mobile platforms will you test?',
      choices: [
        { value: 'android', name: 'Android', description: 'Install or reuse the UiAutomator2 Appium driver' },
        { value: 'ios', name: 'iOS', description: 'Install or reuse the XCUITest Appium driver' },
      ],
      required: true,
    }))

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('example-web:')
    expect(configCall?.[1]).toContain('example-android:')
  })

  it('validates required platform, mobile runtime, and subscription selections', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['mobile'])
      .mockResolvedValueOnce(['ios'])
      .mockResolvedValueOnce(['codex'])

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    const platformValidate = mockCheckbox.mock.calls[0]?.[0].validate
    const mobileValidate = mockCheckbox.mock.calls[1]?.[0].validate
    const subscriptionValidate = mockCheckbox.mock.calls[2]?.[0].validate

    expect(platformValidate?.([])).toBe('Select at least one platform.')
    expect(mobileValidate?.([])).toBe('Select at least one mobile platform.')
    expect(subscriptionValidate?.([])).toBe('Select No subscription auth or at least one subscription provider.')
    expect(subscriptionValidate?.([
      { value: 'none', name: 'No subscription auth', checkedName: 'No subscription auth', short: 'No subscription auth', checked: true, disabled: false },
      { value: 'codex', name: 'Codex', checkedName: 'Codex', short: 'Codex', checked: true, disabled: false },
    ])).toBe('No subscription auth cannot be combined with Codex or Claude Code.')
    expect(subscriptionValidate?.([
      { value: 'codex', name: 'Codex', checkedName: 'Codex', short: 'Codex', checked: true, disabled: false },
      { value: 'claude-code', name: 'Claude Code', checkedName: 'Claude Code', short: 'Claude Code', checked: true, disabled: false },
    ])).toBe(true)
  })

  it('writes both subscription configs during interactive init without collecting API keys', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['web'])
      .mockResolvedValueOnce(['codex', 'claude-code'])

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    expect(mockInput).not.toHaveBeenCalled()
    expect(mockPassword).not.toHaveBeenCalled()
    expect(mockWriteAuth).not.toHaveBeenCalled()

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('name: codex')
    expect(configCall?.[1]).toContain('provider: openai-subscription')
    expect(configCall?.[1]).toContain('name: claude-subscription')
    expect(configCall?.[1]).toContain('provider: anthropic-subscription')
    expect(configCall?.[1]).toContain('package: "@vostride/agent-qa-subscription-auth"')
    expect(configCall?.[1]).toContain('llm: codex')
    expect(configCall?.[1]).not.toContain('apiKey')
    expect(configCall?.[1]).not.toContain('authMethod')

    const output = consoleOutput()
    expect(output).toContain('Fetch @vostride/agent-qa-subscription-auth with your package manager install command')
    expect(output).toContain('Authenticate codex from agent-qa dashboard')
    expect(output).toContain('Authenticate claude-subscription from agent-qa dashboard')

    const packageJsonCall = findWriteCallEndingWith('package.json')
    expect(packageJsonCall).toBeDefined()
    expect(JSON.parse(packageJsonCall![1] as string).devDependencies['@vostride/agent-qa-subscription-auth']).toBe('0.1.1')
  })

  it('writes OpenAI subscription config during interactive init', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['web'])
      .mockResolvedValueOnce(['codex'])

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('name: codex')
    expect(configCall?.[1]).toContain('provider: openai-subscription')
    expect(configCall?.[1]).toContain('model: gpt-5.5')
    expect(configCall?.[1]).toContain('llm: codex')
    expect(configCall?.[1]).toContain('package: "@vostride/agent-qa-subscription-auth"')
    expect(configCall?.[1]).not.toContain('provider: anthropic-subscription')
    expect(mockInput).not.toHaveBeenCalled()
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('keeps compatible Gemini init free of subscription auth plugin', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['web'])
      .mockResolvedValueOnce(['none'])
    mockSelect.mockResolvedValueOnce('gemini')
    mockInput.mockResolvedValueOnce('gemini-3-flash-preview')

    await runInit(['--dir', '/tmp/test-project', '--skip-install'])

    expect(mockInput).toHaveBeenCalledTimes(1)
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Model name:',
      default: 'gemini-3-flash-preview',
    }))

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('provider: gemini')
    expect(configCall?.[1]).toContain('model: gemini-3-flash-preview')
    expect(configCall?.[1]).not.toContain('plugins:')
    expect(configCall?.[1]).not.toContain('baseURL:')
    expect(configCall?.[1]).not.toContain('apiKey')
    expect(findWriteCallEndingWith('package.json')).toBeUndefined()
  })

  it('creates passing and failing example test files', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const passCall = findWriteCallEndingWith('example-pass.yaml')
    const failCall = findWriteCallEndingWith('example-fail.yaml')
    expect(passCall).toBeDefined()
    expect(failCall).toBeDefined()

    const passContent = passCall![1] as string
    expect(passContent).toContain('name: Example passing test')
    expect(passContent).toContain('target: example-web')
    expect(passContent).not.toContain('url: https://example.com')
    expect(passContent).toContain('steps:')
    expect(passContent).toContain('Verify the page says "Example Domain"')
    expect(passContent).toContain('Click on "Learn More"')
    expect(passContent).toContain('Verify the page url is "https://www.iana.org/help/example-domains"')

    const failContent = failCall![1] as string
    expect(failContent).toContain('name: Example failing test')
    expect(failContent).toContain('target: example-web')
    expect(failContent).toContain('Verify the page says "Example Domain"')
    expect(failContent).toContain('Click on "Learn More"')
    expect(failContent).toContain('Verify the page url is "https://www.iana.org/example-domains"')
  })

  it('creates Automation Exercise demo tests and suite for web init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const homeCall = findWriteCallEndingWith('tests/automation-exercise/home-smoke.yaml')
    const productsCall = findWriteCallEndingWith('tests/automation-exercise/products-smoke.yaml')
    const cartCall = findWriteCallEndingWith('tests/automation-exercise/cart-smoke.yaml')
    const suiteCall = findWriteCallEndingWith('suites/automation-exercise.suite.yaml')
    expect(homeCall).toBeDefined()
    expect(productsCall).toBeDefined()
    expect(cartCall).toBeDefined()
    expect(suiteCall).toBeDefined()

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-project/suites', { recursive: true })
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-project/tests/automation-exercise', { recursive: true })

    expect(homeCall?.[1]).toContain('target: automation-exercise')
    expect(homeCall?.[1]).toContain('Verify the page says "Automation Exercise"')
    expect(homeCall?.[1]).toContain('Verify the page has "Signup / Login"')
    expect(productsCall?.[1]).toContain('Click on "Products"')
    expect(productsCall?.[1]).toContain('Verify the page says "All Products"')
    expect(cartCall?.[1]).toContain('Click on "Cart"')
    expect(cartCall?.[1]).toContain('Verify the page says "Shopping Cart"')

    const suiteContent = suiteCall?.[1] as string
    expect(suiteContent).toContain('suite-id: s_hill-gant-verb-nast-hunter-rita-home-store-amy-crest')
    expect(suiteContent).toContain('name: Automation Exercise demo suite')
    expect(suiteContent).toContain('target: automation-exercise')
    expect(suiteContent).toContain('test: tests/automation-exercise/home-smoke.yaml')
    expect(suiteContent).toContain('test: tests/automation-exercise/products-smoke.yaml')
    expect(suiteContent).toContain('test: tests/automation-exercise/cart-smoke.yaml')

    const output = consoleOutput()
    expect(output).toContain('tests/automation-exercise/*.yaml')
    expect(output).toContain('suites/automation-exercise.suite.yaml')
  })

  it('creates a Hacker News hook demo for web init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const hooksCall = findWriteCallEndingWith('hooks.yaml')
    const scriptCall = findWriteCallEndingWith('scripts/fetch-hn-top-story.mjs')
    const testCall = findWriteCallEndingWith('tests/hacker-news-top-story.yaml')
    expect(hooksCall).toBeDefined()
    expect(scriptCall).toBeDefined()
    expect(testCall).toBeDefined()

    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-project/scripts', { recursive: true })

    const hooksContent = hooksCall?.[1] as string
    expect(hooksContent).toContain('Fetch first Hacker News story')
    expect(hooksContent).toContain('runtime: node')
    expect(hooksContent).toContain('file: scripts/fetch-hn-top-story.mjs')
    expect(hooksContent).toContain('timeout: 30s')
    expect(hooksContent).toContain('network: true')

    const scriptContent = scriptCall?.[1] as string
    expect(scriptContent).toContain('https://hacker-news.firebaseio.com/v0/topstories.json')
    expect(scriptContent).toContain('https://hacker-news.firebaseio.com/v0/item/${firstStoryId}.json')
    expect(scriptContent).toContain("writeFile('/tmp/agent-qa.env'")
    expect(scriptContent).toContain('HN_FIRST_STORY_TITLE')
    expect(scriptContent).toContain('HN_FIRST_STORY_ID')

    const testContent = testCall?.[1] as string
    expect(testContent).toContain('name: Hacker News top story hook demo')
    expect(testContent).toContain('target: example-web')
    expect(testContent).toContain('setup:')
    expect(testContent).toContain('h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper')
    expect(testContent).toContain('use:\n  cache: false')
    expect(testContent).toContain('Navigate to "https://news.ycombinator.com/"')
    expect(testContent).toContain('{{env:HN_FIRST_STORY_TITLE}}')

    const output = consoleOutput()
    expect(output).toContain('tests/hacker-news-top-story.yaml')
    expect(output).toContain('scripts/fetch-hn-top-story.mjs')
  })

  it('creates a W3C BAD accessibility reporting demo for web init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const testCall = findWriteCallEndingWith('tests/bad-a11y.yaml')
    expect(testCall).toBeDefined()

    const testContent = testCall?.[1] as string
    expect(testContent).toContain('test-id: t_ponent-toa-base-fred-click-sigma-lad-agen-report-sticky')
    expect(testContent).toContain('name: W3C BAD accessibility smoke')
    expect(testContent).toContain('target: wai-bad')
    expect(testContent).toContain('Verify the page says "Welcome to CityLights"')
    expect(testContent).toContain('Verify the page says "Inaccessible Home Page"')

    const output = consoleOutput()
    expect(output).toContain('tests/bad-a11y.yaml')
  })

  it('generates schema-valid demo artifact YAML for web init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])
    const { parseTestFile, SuiteDefinitionSchema, HooksFileSchema } = await loadCoreYamlValidators()

    for (const suffix of [
      'tests/automation-exercise/home-smoke.yaml',
      'tests/automation-exercise/products-smoke.yaml',
      'tests/automation-exercise/cart-smoke.yaml',
    ]) {
      const call = findWriteCallEndingWith(suffix)
      expect(call).toBeDefined()
      const parsed = parseTestFile(String(call?.[1]), suffix)
      expect(parsed.errors).toEqual([])
      expect(parsed.tests).toHaveLength(1)
      expect(parsed.tests[0].target).toBe('automation-exercise')
    }

    const hnCall = findWriteCallEndingWith('tests/hacker-news-top-story.yaml')
    expect(hnCall).toBeDefined()
    const parsedHn = parseTestFile(String(hnCall?.[1]), 'tests/hacker-news-top-story.yaml')
    expect(parsedHn.errors).toEqual([])
    expect(parsedHn.tests).toHaveLength(1)
    expect(parsedHn.tests[0].setup).toEqual([
      'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
    ])
    expect(parsedHn.tests[0].use?.cache).toBe(false)

    const badA11yCall = findWriteCallEndingWith('tests/bad-a11y.yaml')
    expect(badA11yCall).toBeDefined()
    const parsedBadA11y = parseTestFile(String(badA11yCall?.[1]), 'tests/bad-a11y.yaml')
    expect(parsedBadA11y.errors).toEqual([])
    expect(parsedBadA11y.tests).toHaveLength(1)
    expect(parsedBadA11y.tests[0].target).toBe('wai-bad')

    const suiteCall = findWriteCallEndingWith('suites/automation-exercise.suite.yaml')
    expect(suiteCall).toBeDefined()
    const parsedSuite = SuiteDefinitionSchema.safeParse(parseYaml(String(suiteCall?.[1])))
    if (!parsedSuite.success) {
      throw new Error(JSON.stringify(parsedSuite.error.issues, null, 2))
    }
    expect(parsedSuite.data.tests).toHaveLength(3)
    expect(parsedSuite.data.tests.map((test: { test: string }) => test.test)).toEqual([
      'tests/automation-exercise/home-smoke.yaml',
      'tests/automation-exercise/products-smoke.yaml',
      'tests/automation-exercise/cart-smoke.yaml',
    ])

    const hooksCall = findWriteCallEndingWith('hooks.yaml')
    expect(hooksCall).toBeDefined()
    const parsedHooks = HooksFileSchema.safeParse(parseYaml(String(hooksCall?.[1])))
    if (!parsedHooks.success) {
      throw new Error(JSON.stringify(parsedHooks.error.issues, null, 2))
    }
    expect(parsedHooks.data.hooks).toHaveLength(1)
    expect(parsedHooks.data.hooks[0]).toMatchObject({
      id: 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
      name: 'Fetch first Hacker News story',
      runtime: 'node',
      file: 'scripts/fetch-hn-top-story.mjs',
      network: true,
    })
  })

  it('does not create web demo tests for mobile-only init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android', '--skip-install'])

    expect(findWriteCallEndingWith('tests/automation-exercise/home-smoke.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('tests/automation-exercise/products-smoke.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('tests/automation-exercise/cart-smoke.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('suites/automation-exercise.suite.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('scripts/fetch-hn-top-story.mjs')).toBeUndefined()
    expect(findWriteCallEndingWith('tests/hacker-news-top-story.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('tests/bad-a11y.yaml')).toBeUndefined()

    const configCall = findWriteCallEndingWith('agent-qa.config.yaml')
    expect(configCall?.[1]).not.toContain('automation-exercise:')
    expect(configCall?.[1]).not.toContain('automationexercise.com')
    expect(configCall?.[1]).not.toContain('wai-bad:')
    expect(configCall?.[1]).not.toContain('\n  accessibility:\n')

    const hooksCall = findWriteCallEndingWith('hooks.yaml')
    expect(hooksCall?.[1]).toBe('hooks: []\n')
  })

  it('creates an empty local secrets file', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const secretsCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.env.secrets.local'),
    )
    expect(secretsCall).toBeDefined()
    expect(secretsCall![1]).toBe('')
  })

  it('creates explicit workspace support files', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('hooks.yaml'))).toBe(true)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('agent-rules.md'))).toBe(true)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('.env'))).toBe(true)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('.env.secrets.local'))).toBe(true)
  })

  it('creates an ignored local override template', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const localCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.local.yaml'),
    )
    expect(localCall).toBeDefined()

    const content = localCall![1] as string
    expect(content.startsWith('# This file is for machine-specific device, app, and provider bindings.')).toBe(true)
    expect(content).toContain('# Keep it out of git.')
    expect(content).toContain('# Add agent-qa.local.yaml to .gitignore.')
    expect(content).toContain('devices:\n')
    expect(content).toContain('apps:\n')
    expect(content).toContain('providers:\n')
    expect(content).toContain('  # android-emu:')
    expect(content).toContain('  #   avd: Pixel_8_API_35')
    expect(content).toContain('  # example-android:')
    expect(content).toContain('  #   path: apps/example.apk')
    expect(content).toContain('  # browserstack:')
    expect(content).toContain('  #   username: ${BROWSERSTACK_USERNAME}')
    expect(content).toContain('  #   accessKey: ${BROWSERSTACK_ACCESS_KEY}')
    expect(content).not.toContain('devices: {}')
    expect(content).not.toContain('# devices:')
    expect(content).not.toContain('# apps:')
    expect(content).not.toContain('# providers:')

    const output = consoleOutput()
    expect(output).toContain('agent-qa.local.yaml')
  })

  it('appends to .gitignore without duplicating entries', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('.gitignore')) return true
      return false
    })
    mockReadFileSync.mockReturnValue('node_modules/\n')

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const gitignoreCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.gitignore'),
    )
    expect(gitignoreCall).toBeDefined()

    const content = gitignoreCall![1] as string
    // Should contain .agent-qa/ but not duplicate node_modules/
    expect(content).toContain('.agent-qa/')
    expect(content).toContain('agent-qa.local.yaml')
    expect(content).toContain('.env')
    expect(content).toContain('.env.secrets.local')
    // Original content + only the missing entry
    const nodeModulesCount = (content.match(/node_modules\//g) || []).length
    expect(nodeModulesCount).toBe(1)
  })

  it('skips if config exists and no --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.config.yaml')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    // Should not write config file
    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeUndefined()
  })

  it('overwrites with --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.config.yaml')) return true
      if ((p as string).endsWith('tests')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--force', '--skip-install'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeDefined()
  })

  it('preserves existing local override file without --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.local.yaml')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    const localCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.local.yaml'),
    )
    expect(localCall).toBeUndefined()
  })

  it('overwrites existing local override file with --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.config.yaml')) return true
      if ((p as string).endsWith('agent-qa.local.yaml')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--force', '--skip-install'])

    const localCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.local.yaml'),
    )
    expect(localCall).toBeDefined()
  })

  it('does not auto-install browser support for web projects', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    expect(mockRunBrowserInstall).not.toHaveBeenCalled()
    expect(mockExecSync).not.toHaveBeenCalledWith('npx playwright install chromium', { stdio: 'inherit' })
    const output = consoleOutput()
    expect(output).toContain('agent-qa install-browsers --chromium')
    expect(output).not.toContain('Installing agent-qa browser support')
  })

  it('does not auto-install Appium or drivers for Android projects', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android'])

    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockResolveAppiumExecutable).not.toHaveBeenCalled()
    const output = consoleOutput()
    expect(output).toContain('agent-qa install-mobile-drivers --android')
    expect(output).not.toContain('Installing Appium')
  })

  it('prints iOS-specific mobile setup guidance', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'ios'])

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-mobile-drivers --ios')
    expect(output).not.toContain('agent-qa install-mobile-drivers --android')
  })

  it('prints both web and mobile setup guidance for mixed projects', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web+android'])

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-browsers --chromium')
    expect(output).toContain('agent-qa install-mobile-drivers --android')
    expect(output).toContain('agent-qa doctor')
  })

  it('prints all-drivers setup guidance when both mobile platforms are selected interactively', async () => {
    mockCheckbox
      .mockResolvedValueOnce(['mobile'])
      .mockResolvedValueOnce(['android', 'ios'])
      .mockResolvedValueOnce(['none'])
    mockSelect.mockResolvedValue('openai-compatible')
    mockInput.mockResolvedValue('https://api.example.test/v1')

    await runInit(['--dir', '/tmp/test-project'])

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-mobile-drivers --all')
  })

  it('--skip-install remains accepted and init remains scaffold-only', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRunBrowserInstall).not.toHaveBeenCalled()

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-browsers --chromium')
  })

  it('creates tests directory when it does not exist', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--skip-install'])

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('tests'),
      { recursive: true },
    )
  })

  it('config includes mobile note for mobile platform', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android', '--skip-install'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeDefined()

    const content = configCall![1] as string
    // Android platform should NOT have browsers section
    expect(content).not.toContain('browsers:')
  })
})
