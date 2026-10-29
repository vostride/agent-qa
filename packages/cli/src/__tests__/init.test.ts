import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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

vi.mock('../commands/init-filesystem.js', async () => {
  const fs = await import('node:fs')
  const entries = [
    '.agent-qa/',
    '.agent-qa/auth-states/',
    'node_modules/',
    'agent-qa.local.yaml',
    '.env',
    '.env.secrets.local',
  ]
  const writePlan = (plan: {
    path: string
    content: string | Uint8Array
    force?: boolean
    preserveOnForce?: boolean
    mode?: number
  }) => {
    const exists = fs.existsSync(plan.path)
    if (exists && (!plan.force || plan.preserveOnForce)) {
      return { path: plan.path, outcome: 'preserved' as const }
    }
    fs.writeFileSync(plan.path, plan.content)
    return {
      path: plan.path,
      outcome: exists ? 'updated' as const : 'created' as const,
    }
  }

  return {
    KNOWLEDGE_GITIGNORE_PROBES: [],
    TARGET_GITIGNORE_PROBES: [],
    classifyInitPath: vi.fn((path: string) => fs.existsSync(path) ? 'regular' : 'missing'),
    preflightInitPlan: vi.fn((plans: Array<{ path: string }>) => plans.map(plan => ({
      path: plan.path,
      classification: fs.existsSync(plan.path) ? 'regular' : 'missing',
    }))),
    writeScaffoldFileAtomic: vi.fn(writePlan),
    writeConfigMarkerLast: vi.fn(writePlan),
    upsertManagedGitignoreBlock: vi.fn((path: string) => {
      const exists = fs.existsSync(path)
      const original = exists ? String(fs.readFileSync(path, 'utf8')) : ''
      const prefix = original.length === 0
        ? ''
        : original.endsWith('\n')
          ? '\n'
          : '\n\n'
      const content = `${original}${prefix}# agent-qa init:start\n${entries.join('\n')}\n# agent-qa init:end\n`
      fs.writeFileSync(path, content)
      return { path, outcome: exists ? 'updated' as const : 'created' as const }
    }),
    verifyEffectiveGitignore: vi.fn(() => ({ checked: true })),
  }
})

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
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally with `npm install -D appium` or globally with `npm install -g appium`.'),
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
  getAgentQaVersion: vi.fn(() => '0.1.1'),
}))

// Suppress console output in tests
vi.spyOn(console, 'log').mockImplementation(() => {})

import {
  createInitCommand,
  buildDefaultConfig,
  getProviderChoices,
  defaultModelForProvider,
} from '../commands/init.js'
import {
  preflightInitPlan,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  writeConfigMarkerLast,
  writeScaffoldFileAtomic,
} from '../commands/init-filesystem.js'
import { formatInstallBrowsersRetryCommand, runBrowserInstall } from '../commands/install-browsers.js'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import select from '@inquirer/select'
import input from '@inquirer/input'
import checkbox from '@inquirer/checkbox'
import confirm from '@inquirer/confirm'
import password from '@inquirer/password'
import { getAgentQaVersion, resolveAppiumExecutable, writeAuth } from '@vostride/agent-qa-core'
import { clearProviderRegistry, registerProvider, type ProviderDescriptor } from '@vostride/agent-qa-model'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mockWriteFileSync = vi.mocked(writeFileSync)
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
const mockGetAgentQaVersion = vi.mocked(getAgentQaVersion)
const mockResolveAppiumExecutable = vi.mocked(resolveAppiumExecutable)
const mockPreflightInitPlan = vi.mocked(preflightInitPlan)
const mockWriteScaffoldFileAtomic = vi.mocked(writeScaffoldFileAtomic)
const mockWriteConfigMarkerLast = vi.mocked(writeConfigMarkerLast)
const mockUpsertManagedGitignoreBlock = vi.mocked(upsertManagedGitignoreBlock)
const mockVerifyEffectiveGitignore = vi.mocked(verifyEffectiveGitignore)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

async function runInit(
  args: string[] = [],
  hooks: Parameters<typeof createInitCommand>[0] = {},
): Promise<void> {
  const parent = new Command()
  const init = createInitCommand(hooks)
  parent.exitOverride()
  init.exitOverride()
  parent.addCommand(init)
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

function warnOutput(): string {
  return stripVTControlCharacters(vi.mocked(console.warn).mock.calls.flat().map(String).join('\n'))
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
    clearProviderRegistry()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockImplementation((path) => String(path).endsWith('package.json') ? '{"version":"0.1.1"}' : '')
    mockGetAgentQaVersion.mockReturnValue('0.1.1')
    mockRunBrowserInstall.mockReturnValue({ ok: true, status: 0, stage: 'installer' })
    mockFormatInstallBrowsersRetryCommand.mockReturnValue('agent-qa install-browsers --chromium')
    mockResolveAppiumExecutable.mockReturnValue({ command: 'appium', source: 'path' })
  })

  afterEach(() => {
    clearProviderRegistry()
    vi.restoreAllMocks()
  })

  it('creates config file with correct YAML structure', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeDefined()

    const content = configCall![1] as string
    expect(content).toContain('workspace:')
    expect(content).toContain('hooksFile: hooks.yaml')
    expect(content).not.toContain('agentRules')
    expect(content).toContain('envFile: .env')
    expect(content).toContain('secretsFile: .env.secrets.local')
    expect(content).toContain('services:')
    expect(content).not.toContain('mcp:')
    expect(content).toContain('enabled: true')
    expect(content).not.toContain('port: 3471')
    expect(content).toContain('recording:')
    expect(content).not.toContain('agent-qa-memory')
    expect(content).toContain('# knowledge:')
    expect(content).toContain('#   dir: agent-qa-knowledge')
    expect(content).toContain('authState:')
    expect(content).toContain('dir: .agent-qa/auth-states')
    expect(content).toContain('registry:')
    expect(content).toContain('targets:')
    expect(content).toContain('komazon:')
    expect(content).toContain('url: https://playground.vostride.dev/shop/')
    expect(content).toContain('komazon-cart-total-bug:')
    expect(content).toContain('url: https://playground.vostride.dev/shop/?bug=cart-total')
    expect(content).toContain('use:')
    expect(content).not.toMatch(/^\s*mobile:/m)
    expect(content).not.toContain('appState: preserve')
    expect(content).toContain('dir: .agent-qa/cache')
    expect(content).toContain('plugins:')
    expect(content).toContain('package: "@vostride/agent-qa-subscription-auth"')
    expect(content).toContain('provider: anthropic-subscription')
    expect(content).toContain('model: claude-sonnet-5-5')
    expect(content).toContain('vision:')
    expect(content).toContain('screenshotSize: 256k')
    expect(content).toContain('effectiveResolution: 768')
    expect(content).not.toContain('screenshotSize: 1m')
    expect(content).toContain('timeout:')
    expect(content).toContain('step: 20m')
    expect(content).toContain('test: 90m')
    expect(content).toContain('navigation: 2m')
    expect(content).not.toContain('step: 30s')
    expect(content).not.toContain('test: 10m')
    expect(content).not.toContain('navigation: 10s')
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
    expect(content).toContain(
      "  # Accessibility checks run once at the end of each test; results show in the dashboard's run detail.\n  accessibility:\n",
    )
    expect(content).toContain('accessibility:')
    expect(content).toContain('standard: wcag2aa')
    expect(content).toContain('runAfter: test-end')
    expect(content).toContain('failOnViolation: false')
    expect(content).not.toContain('  # recording:')
    expect(content).not.toContain('  # memory:')
    expect(content).toContain('# Named resource definitions')
    expect(content).toContain('  # devices:')
    expect(content).toContain('  #     platform: android')
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

    const parsed = parseYaml(content) as any
    expect(parsed.services.authState).toEqual({ dir: '.agent-qa/auth-states' })

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
    const values = getProviderChoices().map(choice => choice.value)

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

  it('includes newly registered provider descriptors in init choices at call time', () => {
    const descriptor: ProviderDescriptor = {
      id: 'sixth-provider',
      label: 'Sixth',
      adapter: (_transport, _modelId) => ({}) as ReturnType<ProviderDescriptor['adapter']>,
      needsBaseURL: true,
      authModes: ['api-key'],
      defaultModel: 'sixth-default',
    }

    registerProvider(descriptor)

    expect(getProviderChoices()).toContainEqual({ value: 'sixth-provider', name: 'Sixth' })
    expect(defaultModelForProvider('sixth-provider')).toBe('sixth-default')
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
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('screenshotSize')
    expect(config.registry.llms[0]).not.toHaveProperty('effectiveResolution')
    expect(config.services.vision).toEqual({ screenshotSize: '256k', effectiveResolution: 768 })
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.registry.llms[0]).not.toHaveProperty('authMethod')
    expect(config.use.mobile).toBeUndefined()
    expect(config.use.browser.viewport).toEqual({ width: 1280, height: 720 })
    expect(config.use.logCapture).toEqual({ console: true, network: true })
    expect(config.use.parallel).toBe(false)
    expect(config.services.authState).toEqual({ dir: '.agent-qa/auth-states' })
    expect(config.services.recording).toEqual({ enabled: true })
    expect(config.services).not.toHaveProperty('memory')
    expect(config.workspace).not.toHaveProperty('agentRules')
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
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('screenshotSize')
    expect(config.registry.llms[0]).not.toHaveProperty('effectiveResolution')
    expect(config.services.vision).toEqual({ screenshotSize: '256k', effectiveResolution: 768 })
    expect(config.registry.llms[0]).not.toHaveProperty('authMethod')
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.use.mobile).toBeUndefined()
    expect(config.use.browser.viewport).toEqual({ width: 1280, height: 720 })
    expect(config.use.logCapture).toEqual({ console: true, network: true })
    expect(config.use.parallel).toBe(false)
    expect(config.services.authState).toEqual({ dir: '.agent-qa/auth-states' })
    expect(config.services.recording).toEqual({ enabled: true })
    expect(config.services).not.toHaveProperty('memory')
    expect(config.workspace).not.toHaveProperty('agentRules')
  })

  it('builds Gemini config without subscription auth plugin or base URL', () => {
    const config = buildDefaultConfig('web', 'gemini', 'gemini-3-flash-preview') as any

    expect(config.registry.llms).toEqual([
      expect.objectContaining({
        name: 'default',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
      }),
    ])
    expect(config.registry.llms[0]).not.toHaveProperty('screenshotSize')
    expect(config.registry.llms[0]).not.toHaveProperty('effectiveResolution')
    expect(config.services.vision).toEqual({ screenshotSize: '256k', effectiveResolution: 768 })
    expect(config.registry.llms[0]).not.toHaveProperty('baseURL')
    expect(config.registry.llms[0]).not.toHaveProperty('apiKey')
    expect(config.services.authState).toEqual({ dir: '.agent-qa/auth-states' })
    expect(config).not.toHaveProperty('plugins')
  })

  it.each(['web', 'android', 'ios', 'web+android', 'web+ios'] as const)(
    'builds %s config with a mobile app state only for mobile platforms',
    (platform) => {
      const config = buildDefaultConfig(
        platform,
        'anthropic-subscription',
        'claude-sonnet-4-6',
      ) as any

      if (platform === 'web') {
        expect(config.use.mobile).toBeUndefined()
      } else {
        expect(config.use.mobile.appState).toBe('preserve')
      }
      expect(config.use.logCapture).toEqual({ console: true, network: true })
      expect(config.use.parallel).toBe(false)
      expect(config.services.authState).toEqual({ dir: '.agent-qa/auth-states' })
      expect(config.services.recording).toEqual({ enabled: true })
      expect(config.services).not.toHaveProperty('memory')
      expect(config.workspace).not.toHaveProperty('agentRules')
      expect(config.services).not.toHaveProperty('mcp')
      expect(config.plugins).toEqual({
        auth: [{ package: '@vostride/agent-qa-subscription-auth' }],
      })
      if (platform === 'web' || platform === 'web+android' || platform === 'web+ios') {
        expect(config.services.accessibility).toEqual({
          enabled: true,
          standard: 'wcag2aa',
          runAfter: 'test-end',
          failOnViolation: false,
        })
        expect(config.registry.targets).toHaveProperty('komazon-cart-total-bug')
      } else {
        expect(config.services).not.toHaveProperty('accessibility')
        expect(config.registry.targets).not.toHaveProperty('komazon-cart-total-bug')
      }
      if (platform === 'web+android') {
        expect(config.registry.targets).toHaveProperty('komazon')
        expect(config.registry.targets).toHaveProperty('example-android')
      }
      if (platform === 'web+ios') {
        expect(config.registry.targets).toHaveProperty('komazon')
        expect(config.registry.targets).toHaveProperty('example-ios')
      }
      expect(config).not.toHaveProperty('analytics')
    },
  )

  it('rejects an invalid Commander platform before preflight or filesystem writes', async () => {
    await expect(runInit([
      '--dir',
      '/tmp/test-project',
      '--platform',
      'bogus',
    ])).rejects.toMatchObject({ code: 'commander.invalidArgument' })

    expect(mockPreflightInitPlan).not.toHaveBeenCalled()
    expect(mockWriteScaffoldFileAtomic).not.toHaveBeenCalled()
    expect(mockWriteConfigMarkerLast).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('rejects an invalid programmatic platform with a closed diagnostic', () => {
    expect(() => buildDefaultConfig(
      'bogus' as never,
      'anthropic-subscription',
      'claude-sonnet-4-6',
    )).toThrow('Unsupported init platform "bogus"')
  })

  it.each(['', '0.0.0', '  '])(
    'refuses invalid installed version %j before preflight or filesystem writes',
    async (version) => {
      mockGetAgentQaVersion.mockReturnValueOnce(version)

      await expect(runInit([
        '--dir',
        '/tmp/test-project',
        '--platform',
        'web',
      ])).rejects.toThrow('installed agent-qa version')

      expect(mockPreflightInitPlan).not.toHaveBeenCalled()
      expect(mockWriteScaffoldFileAtomic).not.toHaveBeenCalled()
      expect(mockWriteConfigMarkerLast).not.toHaveBeenCalled()
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    },
  )

  it('prompts model as free text and does not collect first-party API keys during interactive init', async () => {
    mockCheckbox.mockResolvedValueOnce(['web'])
    mockSelect.mockResolvedValueOnce('anthropic-compatible')
    mockInput
      .mockResolvedValueOnce('claude-remote')
      .mockResolvedValueOnce('https://anthropic-proxy.example/messages')

    await runInit(['--dir', '/tmp/test-project'], { isTTY: true })

    expect(mockCheckbox).toHaveBeenCalledTimes(1)
    expect(mockCheckbox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'What platform will you test?',
      choices: [
        { value: 'web', name: 'Web', description: 'Test web apps with Playwright', checked: true },
        { value: 'mobile', name: 'Mobile', description: 'Test Android or iOS apps with Appium', checked: false },
      ],
      required: true,
    }))
    expect(mockSelect).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'Which model connection?',
      default: 'claude-code',
    }))
    expect(mockInput).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: 'Model:',
      default: defaultModelForProvider('anthropic-compatible'),
    }))
    expect(mockInput).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: 'Base URL:',
      default: 'https://api.anthropic.com/v1',
    }))
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockPassword).not.toHaveBeenCalled()
    expect(mockWriteAuth).not.toHaveBeenCalled()

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('provider: anthropic-compatible')
    expect(configCall?.[1]).toContain('model: claude-remote')
    expect(configCall?.[1]).toContain('baseURL: https://anthropic-proxy.example/messages')
    expect(configCall?.[1]).not.toContain('apiKey')
  })

  it('scaffolds both mobile runtimes when Mobile is selected', async () => {
    mockCheckbox.mockResolvedValueOnce(['web', 'mobile'])

    await runInit(['--dir', '/tmp/test-project', '--llm', 'codex'], { isTTY: true })

    expect(mockCheckbox).toHaveBeenCalledTimes(1)
    const platformValidate = mockCheckbox.mock.calls[0]?.[0].validate
    expect(platformValidate?.([])).toBe('Select at least one platform.')
    expect(mockCheckbox).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'Which mobile platforms will you test?',
    }))

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('komazon:')
    expect(configCall?.[1]).toContain('example-android:')
    expect(configCall?.[1]).toContain('example-ios:')
  })

  it('writes OpenAI subscription config during interactive init', async () => {
    mockCheckbox.mockResolvedValueOnce(['web'])

    await runInit(['--dir', '/tmp/test-project', '--llm', 'codex'], { isTTY: true })

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall?.[1]).toContain('name: codex')
    expect(configCall?.[1]).toContain('provider: openai-subscription')
    expect(configCall?.[1]).toContain('model: gpt-6.1-sol')
    expect(configCall?.[1]).toContain('llm: codex')
    expect(configCall?.[1]).toContain('package: "@vostride/agent-qa-subscription-auth"')
    expect(configCall?.[1]).not.toContain('provider: anthropic-subscription')
    expect(mockInput).not.toHaveBeenCalled()
    expect(mockWriteAuth).not.toHaveBeenCalled()
  })

  it('keeps compatible Gemini init free of subscription auth plugin', async () => {
    mockCheckbox.mockResolvedValueOnce(['web'])
    mockSelect.mockResolvedValueOnce('gemini')
    mockInput.mockResolvedValueOnce('gemini-3-flash-preview')

    await runInit(['--dir', '/tmp/test-project'], { isTTY: true })

    expect(mockInput).toHaveBeenCalledTimes(1)
    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Model:',
      default: defaultModelForProvider('gemini'),
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

  it('generates schema-valid demo artifact YAML for web init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])
    const { parseTestFile, SuiteDefinitionSchema, HooksFileSchema } = await loadCoreYamlValidators()

    for (const [suffix, target] of [
      ['tests/examples/komazon-checkout.yaml', 'komazon'],
      ['tests/examples/komazon-cart-total-bug.yaml', 'komazon-cart-total-bug'],
      ['tests/examples/komazon-shipping-hook.yaml', 'komazon'],
    ]) {
      const call = findWriteCallEndingWith(suffix)
      expect(call).toBeDefined()
      const parsed = parseTestFile(String(call?.[1]), suffix)
      expect(parsed.errors).toEqual([])
      expect(parsed.tests).toHaveLength(1)
      expect(parsed.tests[0].target).toBe(target)
    }

    const suiteCall = findWriteCallEndingWith('suites/examples.suite.yaml')
    expect(suiteCall).toBeDefined()
    const parsedSuite = SuiteDefinitionSchema.safeParse(parseYaml(String(suiteCall?.[1])))
    if (!parsedSuite.success) {
      throw new Error(JSON.stringify(parsedSuite.error.issues, null, 2))
    }
    expect(parsedSuite.data.tests.map((test: { test: string }) => test.test)).toEqual([
      'tests/examples/komazon-checkout.yaml',
      'tests/examples/komazon-cart-total-bug.yaml',
    ])

    const hooksCall = findWriteCallEndingWith('hooks.yaml')
    expect(hooksCall).toBeDefined()
    const parsedHooks = HooksFileSchema.safeParse(parseYaml(String(hooksCall?.[1])))
    if (!parsedHooks.success) {
      throw new Error(JSON.stringify(parsedHooks.error.issues, null, 2))
    }
    expect(parsedHooks.data.hooks).toHaveLength(1)
    expect(parsedHooks.data.hooks[0].file).toBe('scripts/examples/make-shipping-address.mjs')
    expect(parsedHooks.data.hooks[0].network).toBe(false)
  })

  it('does not create web demo tests for mobile-only init', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android'])

    expect(findWriteCallEndingWith('tests/examples/komazon-checkout.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('tests/examples/komazon-cart-total-bug.yaml')).toBeUndefined()
    expect(findWriteCallEndingWith('suites/examples.suite.yaml')).toBeUndefined()

    const configCall = findWriteCallEndingWith('agent-qa.config.yaml')
    expect(configCall?.[1]).not.toContain('komazon')
    expect(configCall?.[1]).not.toContain('playground.vostride.dev')
    expect(configCall?.[1]).not.toContain('\n  accessibility:\n')

    const hooksCall = findWriteCallEndingWith('hooks.yaml')
    expect(hooksCall?.[1]).toBe('hooks: []\n')
    expect(consoleOutput()).not.toContain('tests/examples/')
    expect(consoleOutput()).not.toContain('suites/examples.suite.yaml')
  })

  it('an Android scaffold keeps the optional accessibility example after the cache block', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android'])

    const content = String(findWriteCallEndingWith('agent-qa.config.yaml')?.[1])
    const cache = content.indexOf('\n  cache:\n')
    const example = content.indexOf('# Optional accessibility service example:')
    const authState = content.indexOf('\n  authState:\n')
    expect(cache).toBeGreaterThan(-1)
    expect(example).toBeGreaterThan(cache)
    expect(authState).toBeGreaterThan(example)
  })

  it('creates an empty local secrets file', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const secretsCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.env.secrets.local'),
    )
    expect(secretsCall).toBeDefined()
    expect(String(secretsCall![1]).split('\n')).toContain('KOMAZON_PASSWORD=komazon123')

    mockWriteFileSync.mockClear()
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android'])
    const mobileSecretsCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.env.secrets.local'),
    )
    expect(mobileSecretsCall).toBeDefined()
    expect(mobileSecretsCall![1]).toBe('')
  })

  it('creates explicit workspace support files', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('hooks.yaml'))).toBe(true)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('agent-rules.md'))).toBe(false)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('.env'))).toBe(true)
    expect(mockWriteFileSync.mock.calls.some((call) => (call[0] as string).endsWith('.env.secrets.local'))).toBe(true)
  })

  it('creates an ignored local override template', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const localCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.local.yaml'),
    )
    expect(localCall).toBeDefined()

    const content = localCall![1] as string
    expect(content.startsWith('# This file is for machine-specific device and app bindings.')).toBe(true)
    expect(content).toContain('# Keep it out of git.')
    expect(content).toContain('# Add agent-qa.local.yaml to .gitignore.')
    expect(content).toContain('devices:\n')
    expect(content).toContain('apps:\n')
    expect(content).toContain('  # android-emu:')
    expect(content).toContain('  #   avd: Pixel_8_API_35')
    expect(content).toContain('  # example-android:')
    expect(content).toContain('  #   path: apps/example.apk')
    expect(content).not.toContain('devices: {}')
    expect(content).not.toContain('# devices:')
    expect(content).not.toContain('# apps:')

    const output = consoleOutput()
    expect(output).toContain('agent-qa.local.yaml')
  })

  it('places a complete managed .gitignore block after existing entries', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('.gitignore')) return true
      return false
    })
    mockReadFileSync.mockReturnValue('node_modules/\n')

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const gitignoreCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.gitignore'),
    )
    expect(gitignoreCall).toBeDefined()

    const content = gitignoreCall![1] as string
    // Existing rules remain byte-preserved; the complete terminal block is authoritative.
    expect(content).toContain('.agent-qa/')
    expect(content).toContain('.agent-qa/auth-states/')
    expect(content).toContain('agent-qa.local.yaml')
    expect(content).toContain('.env')
    expect(content).toContain('.env.secrets.local')
    // The original node_modules rule remains and is repeated in the managed block.
    const nodeModulesCount = (content.match(/node_modules\//g) || []).length
    const runtimeCount = (content.match(/^\.agent-qa\/$/gm) || []).length
    const authStatesCount = (content.match(/^\.agent-qa\/auth-states\/$/gm) || []).length
    expect(nodeModulesCount).toBe(2)
    expect(runtimeCount).toBe(1)
    expect(authStatesCount).toBe(1)
  })

  it('does not skip .agent-qa/ when only the auth-state directory is already ignored', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('.gitignore')) return true
      return false
    })
    mockReadFileSync.mockReturnValue('node_modules/\n.agent-qa/auth-states/\n')

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const gitignoreCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('.gitignore'),
    )
    expect(gitignoreCall).toBeDefined()

    const content = gitignoreCall![1] as string
    expect(content).toContain('.agent-qa/')
    expect(content).toContain('.agent-qa/auth-states/')
    expect((content.match(/^\.agent-qa\/$/gm) || []).length).toBe(1)
    expect((content.match(/^\.agent-qa\/auth-states\/$/gm) || []).length).toBe(2)
  })

  it('skips if config exists and no --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.config.yaml')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    // Should not write config file
    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeUndefined()
    expect(consoleOutput()).toContain('Preserved:\n    • agent-qa.config.yaml')
  })

  it('overwrites with --force', async () => {
    mockExistsSync.mockImplementation((p) => {
      if ((p as string).endsWith('agent-qa.config.yaml')) return true
      if ((p as string).endsWith('tests')) return true
      return false
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--force'])

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

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

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

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--force'])

    const localCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.local.yaml'),
    )
    expect(localCall).toBeDefined()
  })

  describe('credential-file scaffold policy', () => {
    const projectDir = '/tmp/test-project'
    const envPath = join(projectDir, '.env')
    const secretsPath = join(projectDir, '.env.secrets.local')

    function scaffoldPlanFor(path: string) {
      return mockWriteScaffoldFileAtomic.mock.calls.find(
        ([plan]) => plan.path === path,
      )?.[0]
    }

    async function runInitCollectingOutcomes(args: string[]) {
      const outcomes: { path: string; outcome: string }[] = []
      const written: string[] = []
      await runInit(args, {
        afterWrite: (result) => { written.push(result.path) },
        onComplete: (results) => {
          outcomes.push(...results.map(result => ({
            path: result.path,
            outcome: result.outcome as string,
          })))
        },
      })
      return { outcomes, written }
    }

    it('declares preservation for both env files and mode 0600 only for the secrets file', async () => {
      await runInit(['--dir', projectDir, '--platform', 'web'])

      const envPlan = scaffoldPlanFor(envPath)
      const secretsPlan = scaffoldPlanFor(secretsPath)
      expect(envPlan?.preserveOnForce).toBe(true)
      expect(envPlan?.mode).toBeUndefined()
      expect(secretsPlan?.preserveOnForce).toBe(true)
      expect(secretsPlan?.mode).toBe(0o600)
    })

    it('keeps the same credential policy under --force', async () => {
      mockExistsSync.mockImplementation((p) => (p as string).endsWith('agent-qa.config.yaml'))

      await runInit(['--dir', projectDir, '--platform', 'web', '--force'])

      const envPlan = scaffoldPlanFor(envPath)
      const secretsPlan = scaffoldPlanFor(secretsPath)
      expect(envPlan?.force).toBe(true)
      expect(envPlan?.preserveOnForce).toBe(true)
      expect(envPlan?.mode).toBeUndefined()
      expect(secretsPlan?.force).toBe(true)
      expect(secretsPlan?.preserveOnForce).toBe(true)
      expect(secretsPlan?.mode).toBe(0o600)
    })

    for (const [label, bytes] of [['empty', ''], ['populated', 'API_KEY=abc\n']] as const) {
      it(`never rewrites ${label} existing credential files under --force`, async () => {
        mockExistsSync.mockImplementation((p) => {
          const path = p as string
          return path === envPath || path === secretsPath
            || path.endsWith('agent-qa.config.yaml')
        })
        mockReadFileSync.mockImplementation((p) => {
          const path = String(p)
          if (path.endsWith('package.json')) return '{"version":"0.1.1"}'
          if (path === envPath || path === secretsPath) return bytes
          return ''
        })

        const { outcomes, written } = await runInitCollectingOutcomes(
          ['--dir', projectDir, '--platform', 'web', '--force'],
        )

        expect(mockWriteFileSync.mock.calls.some(call => call[0] === envPath)).toBe(false)
        expect(mockWriteFileSync.mock.calls.some(call => call[0] === secretsPath)).toBe(false)
        expect(written).not.toContain(envPath)
        expect(written).not.toContain(secretsPath)

        // Looked up by name, not by index. The managed .gitignore is now written before the
        // scaffold loop so no credential temporary can exist under a name no rule covers,
        // which moves every scaffold entry one position; the property being pinned here is
        // the credential files' outcome and their relative scaffold order, never their
        // absolute position in the list.
        const paths = outcomes.map(outcome => outcome.path)
        expect(paths.indexOf(envPath)).toBeGreaterThanOrEqual(0)
        expect(paths.indexOf(envPath)).toBeLessThan(paths.indexOf(secretsPath))
        expect(outcomes.find(outcome => outcome.path === envPath)?.outcome).toBe('preserved')
        expect(outcomes.find(outcome => outcome.path === secretsPath)?.outcome).toBe('preserved')

        const output = consoleOutput()
        expect(output).toContain('Preserved:\n    • .env\n    • .env.secrets.local')
      })
    }

    it('still creates both absent credential files empty and in scaffold order', async () => {
      const { outcomes } = await runInitCollectingOutcomes(
        ['--dir', projectDir, '--platform', 'web'],
      )

      // Scaffold order is a RELATIVE property between the two credential files. Their
      // absolute index moved when the managed .gitignore was hoisted ahead of the scaffold
      // loop to close the uncovered-temporary window.
      const paths = outcomes.map(outcome => outcome.path)
      expect(paths.indexOf(envPath)).toBeGreaterThanOrEqual(0)
      expect(paths.indexOf(envPath)).toBeLessThan(paths.indexOf(secretsPath))
      expect(outcomes.find(outcome => outcome.path === envPath)?.outcome).toBe('created')
      expect(outcomes.find(outcome => outcome.path === secretsPath)?.outcome).toBe('created')

      const envWrite = mockWriteFileSync.mock.calls.find(call => call[0] === envPath)
      const secretsWrite = mockWriteFileSync.mock.calls.find(call => call[0] === secretsPath)
      expect(envWrite?.[1]).toBe('')
      expect(String(secretsWrite?.[1]).split('\n')).toContain('KOMAZON_PASSWORD=komazon123')
    })

    it('leaves non-credential scaffold files force-updatable', async () => {
      mockExistsSync.mockImplementation((p) => {
        const path = p as string
        return path === envPath || path === secretsPath
          || path.endsWith('agent-qa.config.yaml')
          || path.endsWith('agent-qa.local.yaml')
          || path.endsWith('hooks.yaml')
      })

      await runInit(['--dir', projectDir, '--platform', 'web', '--force'])

      expect(findWriteCallEndingWith('agent-qa.local.yaml')).toBeDefined()
      expect(findWriteCallEndingWith('hooks.yaml')).toBeDefined()
      expect(findWriteCallEndingWith('agent-qa.config.yaml')).toBeDefined()
    })
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
    expect(output).toContain('agent-qa install-mobile-drivers --all')
    expect(output).not.toContain('Installing Appium')
  })

  it('prints all-driver mobile setup guidance for iOS projects', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'ios'])

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-mobile-drivers --all')
    expect(output).not.toContain('agent-qa install-mobile-drivers --ios')
    expect(output).not.toContain('agent-qa install-mobile-drivers --android')
  })

  it('prints both web and mobile setup guidance for mixed projects', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web+android'])

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-browsers --chromium')
    expect(output).toContain('agent-qa install-mobile-drivers --all')
    expect(output).toContain('npx agent-qa validate')
  })

  it('prints all-drivers setup guidance when both mobile platforms are selected interactively', async () => {
    mockCheckbox.mockResolvedValueOnce(['mobile'])

    await runInit(['--dir', '/tmp/test-project', '--llm', 'codex'], { isTTY: true })

    const output = consoleOutput()
    expect(output).toContain('agent-qa install-mobile-drivers --all')
    expect(mockCheckbox).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'Which mobile platforms will you test?',
    }))
  })

  it('routes nested test files through the safe filesystem writer', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    expect(mockWriteScaffoldFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        root: '/tmp/test-project',
        path: '/tmp/test-project/tests/examples/komazon-checkout.yaml',
      }),
      expect.anything(),
    )
  })

  it('config includes mobile note for mobile platform', async () => {
    await runInit(['--dir', '/tmp/test-project', '--platform', 'android'])

    const configCall = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).endsWith('agent-qa.config.yaml'),
    )
    expect(configCall).toBeDefined()

    const content = configCall![1] as string
    // Android platform should NOT have browsers section
    expect(content).not.toContain('browsers:')
  })

  describe('knowledge root scaffold', () => {
    const KNOWLEDGE_ROOT = '/tmp/test-project/agent-qa-knowledge'
    // The committed/derived split, verbatim from spec/v2/knowledge-store.md §4.
    const FUNCTIONAL_LINES = [
      'memory/index/',
      'memory/queue/',
      'memory/*/bundles/.staging/',
      '.lease',
      '.epoch',
      '.writer-authority.sqlite*',
      '**/artifacts/',
      'skills/.staging/',
    ]

    // NOT part of that split, and deliberately kept separate here so the divergence is
    // visible in the test rather than folded into the spec list. agent-qa init publishes
    // every file through a temporary sibling carrying the destination's own content; a
    // knowledge tree that is its own repository does not inherit the project .gitignore,
    // so the rule has to be present in this file to keep that temporary out of a commit.
    const INIT_TOOL_OPERATIONAL_LINES = ['.*.agent-qa-init-*.tmp']

    function knowledgeWritePaths(): string[] {
      return mockWriteFileSync.mock.calls
        .map((call) => call[0] as string)
        .filter((path) => path.includes('agent-qa-knowledge'))
        .sort()
    }

    it('fresh init creates exactly AGENTS.md, README.md, .gitignore, and policies/global.md under the root', async () => {
      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

      expect(knowledgeWritePaths()).toEqual([
        `${KNOWLEDGE_ROOT}/.gitignore`,
        `${KNOWLEDGE_ROOT}/AGENTS.md`,
        `${KNOWLEDGE_ROOT}/README.md`,
        `${KNOWLEDGE_ROOT}/policies/global.md`,
      ])
      expect(knowledgeWritePaths().some((path) => path.includes('.gitkeep'))).toBe(false)

      const readmeCall = findWriteCallEndingWith('agent-qa-knowledge/README.md')
      expect(readmeCall?.[1]).not.toContain('thumbnail')

      const output = consoleOutput()
      expect(output).toContain('agent-qa-knowledge/README.md')
      expect(output).toContain('agent-qa-knowledge/.gitignore')
      expect(output).toContain('agent-qa-knowledge/policies/global.md')
      expect(output).toContain('agent-qa-knowledge/AGENTS.md')
    })

    it('scaffolded knowledge .gitignore carries the spec lines plus the init-tool rule', async () => {
      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

      const gitignoreCall = findWriteCallEndingWith('agent-qa-knowledge/.gitignore')
      expect(gitignoreCall).toBeDefined()

      const content = gitignoreCall![1] as string
      expect(content.startsWith('# agent-qa-knowledge/.gitignore\n')).toBe(true)
      expect(content).not.toContain('thumbnail')
      const activeLines = content
        .split(/\r?\n/)
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(line => line.replace(/[ \t]+$/u, ''))
      expect(activeLines).toEqual([...FUNCTIONAL_LINES, ...INIT_TOOL_OPERATIONAL_LINES])
      // The operational rule is labelled for what it is, so a later reader does not mistake
      // it for part of the spec's committed/derived split.
      expect(content).toContain('# INIT-TOOL OPERATIONAL')
    })

    it('scaffolded knowledge .gitignore enforces committed and derived partitions in real Git', async () => {
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
      const actualChildProcess =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')

      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])
      const gitignoreCall = findWriteCallEndingWith('agent-qa-knowledge/.gitignore')
      expect(gitignoreCall).toBeDefined()

      const repository = actualFs.mkdtempSync(join(tmpdir(), 'agent-qa-kdir-git-'))
      try {
        actualChildProcess.execFileSync('git', ['init', '--quiet'], {
          cwd: repository,
          stdio: 'pipe',
        })
        actualFs.writeFileSync(join(repository, '.gitignore'), gitignoreCall![1] as string)

        const ignoredPaths = [
          'memory/index/knowledge.sqlite',
          'memory/queue/candidate.json',
          '.lease',
          '.epoch',
          'memory/local-form/bundles/fact-example/artifacts/screenshot.png',
          'skills/.staging/draft.md',
        ]
        const committedPaths = [
          'memory/local-form/bundles/fact-example/record.md',
          'memory/local-form/bundles/fact-example/manifest.json',
          'memory/local-form/bundles/fact-example/evidence/outcomes.jsonl',
          'memory/local-form/bundles/fact-example/artifacts.index.json',
          'policies/global.md',
        ]

        for (const fixturePath of [...ignoredPaths, ...committedPaths]) {
          const absolutePath = join(repository, fixturePath)
          actualFs.mkdirSync(dirname(absolutePath), { recursive: true })
          actualFs.writeFileSync(absolutePath, 'fixture\n')
        }

        for (const fixturePath of ignoredPaths) {
          const result = actualChildProcess.spawnSync(
            'git',
            ['check-ignore', '--quiet', '--', fixturePath],
            { cwd: repository, stdio: 'pipe' },
          )
          if (result.error) throw result.error
          expect(result.status, `${fixturePath} should be ignored`).toBe(0)
        }

        for (const fixturePath of committedPaths) {
          const result = actualChildProcess.spawnSync(
            'git',
            ['check-ignore', '--quiet', '--', fixturePath],
            { cwd: repository, stdio: 'pipe' },
          )
          if (result.error) throw result.error
          expect(result.status, `${fixturePath} should remain commit-visible`).toBe(1)
        }
      } finally {
        actualFs.rmSync(repository, { recursive: true, force: true })
      }
    })

    it('scaffolded policies/global.md is comment-only — zero active rules', async () => {
      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

      const policyCall = findWriteCallEndingWith('policies/global.md')
      expect(policyCall).toBeDefined()

      const content = policyCall![1] as string
      expect(content.trimStart().startsWith('<!--')).toBe(true)
      // Exactly one comment block; nothing non-blank may sit outside it.
      const segments = content.split('-->')
      expect(segments).toHaveLength(2)
      const activeLines = segments[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      expect(activeLines).toEqual([])
      // The example rule is taught INSIDE the comment.
      expect(segments[0]).toContain('Always dismiss the cookie banner before asserting page content')
    })

    it('re-init never overwrites hand-edited README.md or policies/global.md, even with --force', async () => {
      mockExistsSync.mockImplementation((p) => String(p).includes('agent-qa-knowledge'))

      await runInit(['--dir', '/tmp/test-project', '--platform', 'web', '--force'])

      expect(findWriteCallEndingWith('agent-qa-knowledge/README.md')).toBeUndefined()
      expect(findWriteCallEndingWith('policies/global.md')).toBeUndefined()
      expect(findWriteCallEndingWith('agent-qa-knowledge/.gitignore')).toBeUndefined()
      // 431 D-17: the guide is agent-qa's generated file, so --force regenerates it.
      expect(findWriteCallEndingWith('agent-qa-knowledge/AGENTS.md')).toBeDefined()
    })

    it('warns naming the exact missing functional line of an existing knowledge .gitignore without rewriting it', async () => {
      const degraded = `# agent-qa-knowledge/.gitignore
memory/index/
memory/queue/
memory/*/bundles/.staging/
.lease
.writer-authority.sqlite*
**/artifacts/        # binary blobs
skills/.staging/
.*.agent-qa-init-*.tmp
`
      mockExistsSync.mockImplementation((p) => String(p).endsWith('agent-qa-knowledge/.gitignore'))
      mockReadFileSync.mockImplementation((p) => {
        if (String(p).endsWith('package.json')) return '{"version":"0.1.1"}'
        if (String(p).endsWith('agent-qa-knowledge/.gitignore')) return degraded
        return ''
      })

      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

      expect(findWriteCallEndingWith('agent-qa-knowledge/.gitignore')).toBeUndefined()
      expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(2)
      const warning = warnOutput()
      expect(warning).toContain('".epoch"')
      expect(warning).toContain('"**/artifacts/"')
      expect(warning).toContain('add it manually')
      // The fixture carries the init-tool rule, so it must NOT be named. This is what keeps
      // the count of 2 meaningful: it pins that the two warnings are the two lines the
      // fixture actually degraded, not an arbitrary pair.
      expect(warning).not.toContain('.agent-qa-init-')
    })

    it('target-project .gitignore entries include .agent-qa/ and never the v1 memory directory', async () => {
      await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

      const gitignoreCall = mockWriteFileSync.mock.calls.find(
        (call) => (call[0] as string) === '/tmp/test-project/.gitignore',
      )
      expect(gitignoreCall).toBeDefined()

      const content = gitignoreCall![1] as string
      expect(content).toContain('.agent-qa/')
      expect(content).not.toContain('agent-qa-memory')
    })
  })

  it('preflights the complete web inventory before writing and writes the config marker last', async () => {
    const onComplete = vi.fn()
    await runInit(
      ['--dir', '/tmp/test-project', '--platform', 'web'],
      { onComplete },
    )

    expect(mockPreflightInitPlan).toHaveBeenCalledTimes(1)
    const plannedPaths = new Set(
      mockPreflightInitPlan.mock.calls[0]![0].map(plan => plan.path),
    )
    expect(plannedPaths).toEqual(new Set([
      '/tmp/test-project/.env',
      '/tmp/test-project/.env.secrets.local',
      '/tmp/test-project/.gitignore',
      '/tmp/test-project/agent-qa-knowledge/.gitignore',
      '/tmp/test-project/agent-qa-knowledge/AGENTS.md',
      '/tmp/test-project/agent-qa-knowledge/README.md',
      '/tmp/test-project/agent-qa-knowledge/policies/global.md',
      '/tmp/test-project/agent-qa.config.yaml',
      '/tmp/test-project/agent-qa.local.yaml',
      '/tmp/test-project/hooks.yaml',
      '/tmp/test-project/package.json',
      '/tmp/test-project/scripts/examples/make-shipping-address.mjs',
      '/tmp/test-project/suites/examples.suite.yaml',
      '/tmp/test-project/tests/examples/komazon-cart-total-bug.yaml',
      '/tmp/test-project/tests/examples/komazon-checkout.yaml',
      '/tmp/test-project/tests/examples/komazon-shipping-hook.yaml',
    ]))

    const preflightOrder = mockPreflightInitPlan.mock.invocationCallOrder[0]!
    const firstWriteOrder = Math.min(
      mockWriteScaffoldFileAtomic.mock.invocationCallOrder[0]!,
      mockUpsertManagedGitignoreBlock.mock.invocationCallOrder[0]!,
    )
    const configOrder = mockWriteConfigMarkerLast.mock.invocationCallOrder[0]!
    const priorWriteOrders = [
      ...mockWriteScaffoldFileAtomic.mock.invocationCallOrder,
      ...mockUpsertManagedGitignoreBlock.mock.invocationCallOrder,
    ]

    expect(preflightOrder).toBeLessThan(firstWriteOrder)
    expect(configOrder).toBeGreaterThan(Math.max(...priorWriteOrders))
    expect(mockWriteConfigMarkerLast).toHaveBeenCalledWith(expect.objectContaining({
      path: '/tmp/test-project/agent-qa.config.yaml',
    }), expect.anything())
    expect(mockVerifyEffectiveGitignore).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/test-project',
      label: 'target .gitignore',
    }))
    expect(onComplete).toHaveBeenCalledTimes(1)
    const completedOutcomes = onComplete.mock.calls[0]![0]
    expect(completedOutcomes).toHaveLength(plannedPaths.size)
    expect(completedOutcomes.at(-1)).toEqual({
      path: '/tmp/test-project/agent-qa.config.yaml',
      outcome: 'created',
    })
  })

  it('preserves every completed generated file on partial recovery and reports actual outcomes', async () => {
    const packageJson = `${JSON.stringify({
      private: true,
      scripts: { test: 'vitest' },
      devDependencies: {
        '@vostride/agent-qa-subscription-auth': '0.1.1',
      },
    }, null, 2)}\n`
    mockExistsSync.mockImplementation(path => !String(path).endsWith('agent-qa.config.yaml'))
    mockReadFileSync.mockImplementation(path => {
      const value = String(path)
      if (value.endsWith('package.json')) return packageJson
      if (value.endsWith('agent-qa-knowledge/.gitignore')) {
        return 'memory/index/\nmemory/queue/\n.lease\n.epoch\n**/artifacts/\nskills/.staging/\n'
      }
      if (value.endsWith('.gitignore')) return '# existing project rules\n'
      return 'user-owned sentinel\n'
    })

    await runInit(['--dir', '/tmp/test-project', '--platform', 'web'])

    const generatedResults = mockWriteScaffoldFileAtomic.mock.results
      .map(result => result.value)
      .filter((value): value is { path: string; outcome: string } => Boolean(value))
    expect(generatedResults.filter(result => result.path.endsWith('agent-qa.config.yaml')))
      .toEqual([])
    expect(
      generatedResults
        .every(result => result.outcome === 'preserved'),
    ).toBe(true)
    const packageJsonCall = findWriteCallEndingWith('package.json')
    expect(packageJsonCall).toBeUndefined()
    expect(JSON.parse(packageJson)).toMatchObject({
      private: true,
      scripts: { test: 'vitest' },
      devDependencies: {
        '@vostride/agent-qa-subscription-auth': '0.1.1',
      },
    })

    const output = consoleOutput()
    expect(output).toContain('Preserved:')
    expect(output).toContain('tests/examples/komazon-checkout.yaml')
    const createdSection = output.match(
      /  Created:\n([\s\S]*?)(?:\n  (?:Updated|Preserved|Next steps):|$)/,
    )?.[1] ?? ''
    expect(createdSection).not.toContain('tests/examples/komazon-checkout.yaml')
  })

  it('performs zero writes when any full-plan preflight destination fails', async () => {
    mockPreflightInitPlan.mockImplementationOnce(() => {
      throw new Error('late generated path is a symbolic link')
    })

    await expect(runInit([
      '--dir',
      '/tmp/test-project',
      '--platform',
      'web',
    ])).rejects.toThrow('late generated path is a symbolic link')

    expect(mockWriteScaffoldFileAtomic).not.toHaveBeenCalled()
    expect(mockWriteConfigMarkerLast).not.toHaveBeenCalled()
    expect(mockUpsertManagedGitignoreBlock).not.toHaveBeenCalled()
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  // This exhaustive real-Git matrix creates and recovers one repository per
  // mutation boundary. It finishes in about six seconds alone, but full Turbo
  // runs co-schedule other filesystem-heavy suites, so keep a local 120s budget.
  it('recovers after every real write boundary while preserving completed bytes', async () => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('node:child_process')
    vi.doUnmock('../commands/init-filesystem.js')

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualChildProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const actualInit =
      await vi.importActual<typeof import('../commands/init.js')>('../commands/init.js')
    type Outcome = { path: string; outcome: 'created' | 'updated' | 'preserved' }
    type Hooks = { afterWrite?: (result: Outcome, boundary: number) => void }

    const runRealInit = async (dir: string, hooks: Hooks = {}): Promise<void> => {
      const parent = new Command()
      parent.addCommand(actualInit.createInitCommand(hooks))
      await parent.parseAsync([
        'node',
        'test',
        'init',
        '--dir',
        dir,
        '--platform',
        'web',
      ])
    }
    const createRepository = (): string => {
      const dir = actualFs.mkdtempSync(join(tmpdir(), 'agent-qa-init-recovery-'))
      actualChildProcess.execFileSync('git', ['init', '--quiet'], {
        cwd: dir,
        stdio: 'pipe',
      })
      return dir
    }
    const snapshotFiles = (root: string): Map<string, Buffer> => {
      const snapshot = new Map<string, Buffer>()
      const visit = (dir: string, prefix = ''): void => {
        for (const entry of actualFs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.git') continue
          const relativePath = prefix ? join(prefix, entry.name) : entry.name
          const absolutePath = join(dir, entry.name)
          if (entry.isDirectory()) visit(absolutePath, relativePath)
          else if (entry.isFile()) snapshot.set(relativePath, actualFs.readFileSync(absolutePath))
        }
      }
      visit(root)
      return snapshot
    }

    const repositories: string[] = []
    try {
      const baseline = createRepository()
      repositories.push(baseline)
      const successfulWrites: Outcome[] = []
      await runRealInit(baseline, {
        afterWrite: result => {
          successfulWrites.push(result)
        },
      })

      expect(successfulWrites.length).toBeGreaterThan(10)
      expect(successfulWrites.at(-1)?.path).toBe(join(baseline, 'agent-qa.config.yaml'))

      for (let boundary = 1; boundary < successfulWrites.length; boundary += 1) {
        const repository = createRepository()
        repositories.push(repository)
        let writes = 0
        await expect(runRealInit(repository, {
          afterWrite: () => {
            writes += 1
            if (writes === boundary) throw new Error(`injected boundary ${boundary}`)
          },
        })).rejects.toThrow(`injected boundary ${boundary}`)

        expect(actualFs.existsSync(join(repository, 'agent-qa.config.yaml'))).toBe(false)
        const completedBytes = snapshotFiles(repository)
        await runRealInit(repository)
        expect(actualFs.existsSync(join(repository, 'agent-qa.config.yaml'))).toBe(true)
        for (const [relativePath, bytes] of completedBytes) {
          expect(actualFs.readFileSync(join(repository, relativePath))).toEqual(bytes)
        }
      }
    } finally {
      for (const repository of repositories) {
        actualFs.rmSync(repository, { recursive: true, force: true })
      }
    }
  }, 120_000)

  it('uses the exact installed version from a fresh built CLI layout', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualChildProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const cliRoot = resolve(repoRoot, 'packages/cli')
    const bundleDir = actualFs.mkdtempSync(join(cliRoot, '.init-dist-test-'))
    const projectDir = actualFs.mkdtempSync(join(tmpdir(), 'agent-qa-init-dist-project-'))

    try {
      actualChildProcess.execFileSync('pnpm', [
        'exec',
        'tsup',
        'src/cli.ts',
        'src/cli-main.ts',
        '--out-dir',
        bundleDir,
        '--format',
        'esm',
        '--target',
        'node24',
        '--no-splitting',
        '--no-config',
        '--silent',
      ], {
        cwd: cliRoot,
        stdio: 'pipe',
      })
      actualChildProcess.execFileSync('git', ['init', '--quiet'], {
        cwd: projectDir,
        stdio: 'pipe',
      })
      actualChildProcess.execFileSync(process.execPath, [
        join(bundleDir, 'cli.js'),
        'init',
        '--dir',
        projectDir,
        '--platform',
        'web',
      ], {
        cwd: repoRoot,
        stdio: 'pipe',
      })

      const cliManifest = JSON.parse(
        actualFs.readFileSync(join(cliRoot, 'package.json'), 'utf8'),
      ) as { version: string }
      const projectManifest = JSON.parse(
        actualFs.readFileSync(join(projectDir, 'package.json'), 'utf8'),
      ) as { devDependencies: Record<string, string> }
      const installedRange =
        projectManifest.devDependencies['@vostride/agent-qa-subscription-auth']
      expect(installedRange).toBe(cliManifest.version)
      expect(installedRange).not.toBe('*')
    } finally {
      actualFs.rmSync(bundleDir, { recursive: true, force: true })
      actualFs.rmSync(projectDir, { recursive: true, force: true })
    }
  }, 60_000)

  // ---- 398-10 (D-16 / D-18): the init/scaffold member -----------------------------------------
  //
  // REAL FILESYSTEM, REAL COMMAND, REAL COMPOSED PORT — only the transport is substituted. The
  // three arms below are the three answers this member can give, and each is produced by actually
  // running `init` rather than by constructing an outcome list: a fresh directory (`created`), the
  // same directory again (`unchanged`, because the scaffold preserves what it finds), and the
  // `--agent` manifest read, which writes nothing and must therefore report nothing.
  it('emits one init member per scaffold, and none for the --agent read', async () => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('node:child_process')
    vi.doUnmock('../commands/init-filesystem.js')

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualInit =
      await vi.importActual<typeof import('../commands/init.js')>('../commands/init.js')
    const { composeAnalyticsHost } =
      await vi.importActual<typeof import('../composition/analytics-host.js')>(
        '../composition/analytics-host.js',
      )

    const sent: { name: string; properties: Record<string, unknown> }[] = []
    const composeAnalytics = async (): ReturnType<typeof composeAnalyticsHost> =>
      composeAnalyticsHost({
        surface: 'cli',
        env: {},
        transportOverride: {
          capture: (payload) => { sent.push(payload.event as typeof sent[number]) },
          flush: () => {},
          shutdown: () => {},
        },
        resolveIdentity: async () => ({ distinctId: 'u_init-cell', runtimeContext: 'user' }),
      })

    const dir = actualFs.mkdtempSync(join(tmpdir(), 'agent-qa-init-analytics-'))
    const runRealInit = async (args: string[]): Promise<void> => {
      const parent = new Command()
      parent.addCommand(actualInit.createInitCommand({ composeAnalytics }))
      await parent.parseAsync(['node', 'test', 'init', ...args])
    }

    try {
      await runRealInit(['--dir', dir, '--platform', 'web'])
      const first = sent.filter((event) => event.name === 'agent-qa.init.completed')
      expect(first).toHaveLength(1)
      expect(first[0]?.properties).toMatchObject({
        init_mode: 'scaffold',
        outcome: 'created',
        surface: 'cli',
      })
      expect(first[0]?.properties.created_file_count).toBeGreaterThan(0)

      // The same directory again. `init` answers "already initialized, use --force" and returns —
      // and that IS an init outcome, so it reports one: `unchanged`, nothing created. A member that
      // only fired on the write path would count first-time scaffolds and silently drop every
      // re-run, which is the shape of a usage number that flatters itself.
      sent.length = 0
      await runRealInit(['--dir', dir, '--platform', 'web'])
      const second = sent.filter((event) => event.name === 'agent-qa.init.completed')
      expect(second).toHaveLength(1)
      expect(second[0]?.properties).toMatchObject({
        outcome: 'unchanged',
        created_file_count: 0,
      })

      // `--agent` is a read. It returns before the scaffold exists, so there is no init to report —
      // and counting one would make every manifest read a coding agent performs look like a project
      // being initialised.
      sent.length = 0
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await runRealInit(['--dir', dir, '--agent'])
      } finally {
        log.mockRestore()
      }
      expect(sent).toEqual([])
    } finally {
      actualFs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  // ---- 432-40 (D-24 / D-21): the scaffolded knowledge README and guide say the direct rule ------
  //
  // A REAL init into a fresh temporary directory, read back from disk: the README and the generated
  // guide a person and a coding agent open first both say knowledge changes only through agent-qa,
  // applies at once, and is corrected by new feedback or forget. The README no longer tells anyone
  // to edit a fact or its evidence and no longer cites a design-doc path a user does not have. The
  // init samples and the policy file are unchanged (M7 owns them, D-21).
  it('the scaffolded README and guide state the direct change rule, and the samples are unchanged', async () => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('node:child_process')
    vi.doUnmock('../commands/init-filesystem.js')

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const actualInit =
      await vi.importActual<typeof import('../commands/init.js')>('../commands/init.js')
    const actualGuide =
      await vi.importActual<typeof import('../commands/knowledge-guide.js')>('../commands/knowledge-guide.js')

    const dir = actualFs.mkdtempSync(join(tmpdir(), 'agent-qa-432-40-init-'))
    try {
      const parent = new Command()
      parent.addCommand(actualInit.createInitCommand())
      await parent.parseAsync(['node', 'test', 'init', '--dir', dir, '--platform', 'web'])

      const readme = actualFs.readFileSync(join(dir, 'agent-qa-knowledge', 'README.md'), 'utf8')
      const guide = actualFs.readFileSync(join(dir, 'agent-qa-knowledge', 'AGENTS.md'), 'utf8')
      expect(readme, 'the README on disk is the builder\'s').toBe(actualInit.buildKnowledgeReadme())
      expect(guide, 'the guide on disk is the builder\'s').toBe(actualGuide.buildKnowledgeAgentGuide())

      for (const [name, body] of [['README.md', readme], ['AGENTS.md', guide]] as const) {
        expect(body, `${name}: knowledge changes only through agent-qa`).toMatch(/changes only\s+through agent-qa/u)
        expect(body, `${name}: a change applies at once`).toMatch(/appl(?:y|ies) at once/u)
        expect(body, `${name}: wrong knowledge is corrected by new feedback`).toMatch(/corrected by\s+new feedback/u)
        expect(body, `${name}: or by forgetting the record`).toMatch(/forgetting the\s+record/u)
        expect(body, `${name}: the change tool`).toContain('agent_qa_change_knowledge')
        // `marks and approvals` names the gates read's receipt kinds, not the approval model.
        expect(body, `${name}: approval-model wording`).not.toMatch(
          /\bapprov(?!als?\b)|\bapprovals?\b(?<!\bmarks? and approvals?)|\bpropos|\bpending\b|\bawaiting\b|\bgrant/iu,
        )
        expect(body, `${name}: a design-doc path a user does not have`).not.toMatch(/\bspec\/v\d/u)
      }
      expect(readme, 'the README still tells a reader to edit a fact or its evidence')
        .not.toMatch(/\bedit the fact\b|\bedit the evidence\b/iu)
      expect(readme, 'the README points at the generated guide').toContain('`AGENTS.md` in this directory')
      // People still write policies by hand, and the README still says where.
      expect(readme).toContain('policies/global.md')

      // D-21: the samples and the policy template are still scaffolded (445-02 moved the samples).
      for (const sample of [
        'tests/examples/komazon-checkout.yaml',
        'tests/examples/komazon-cart-total-bug.yaml',
        'suites/examples.suite.yaml',
        'agent-qa-knowledge/policies/global.md',
      ]) {
        expect(actualFs.existsSync(join(dir, sample)), `${sample} is no longer scaffolded`).toBe(true)
      }
    } finally {
      actualFs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
