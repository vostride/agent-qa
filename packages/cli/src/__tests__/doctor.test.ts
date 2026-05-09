import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFile: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => ''),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject({ code: 'ENOENT' })),
}))

vi.mock('@vostride/agent-qa-core', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    AgentQaConfigSchema: {
      safeParse: vi.fn((config: any) => {
        if (config?.workspace && typeof config.workspace.secretsFile !== 'string') {
          return {
            success: false,
            error: { issues: [{ path: ['workspace', 'secretsFile'], message: 'Invalid input: expected string' }] },
          }
        }
        return { success: true }
      }),
    },
    createModel: vi.fn(() => ({})),
    getCredential: vi.fn(() => null),
    resolveLLMAuth: vi.fn(() => Promise.resolve({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })),
    loadLLMAuthPlugins: vi.fn(() => Promise.resolve()),
    readAuth: vi.fn(() => ({})),
    resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
    formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally with `npm install -D appium` or globally with `npm install -g appium`.'),
    checkDockerAvailable: vi.fn(() => Promise.resolve(true)),
    validateProject: vi.fn(() => Promise.resolve({ errorCount: 0, warningCount: 0, fileCount: 5, results: [] })),
    resolveWorkspacePaths: vi.fn(({ config, configPath }: any) => {
      const configDir = String(configPath).includes('/')
        ? String(configPath).split('/').slice(0, -1).join('/')
        : process.cwd()
      for (const key of ['testMatch', 'suiteMatch', 'hooksFile', 'agentRules', 'envFile', 'secretsFile']) {
        if (config.workspace?.[key] === undefined) {
          throw new Error(`Missing required workspace config key: workspace.${key}`)
        }
      }
      const resolveConfigured = (value: string) => value.startsWith('/') ? value : `${configDir}/${value}`
      return {
        configPath,
        configDir,
        testMatch: config.workspace.testMatch,
        suiteMatch: config.workspace.suiteMatch,
        testPathIgnore: config.workspace.testPathIgnore ?? [],
        hooksFile: {
          configuredPath: config.workspace.hooksFile,
          absolutePath: resolveConfigured(config.workspace.hooksFile),
          workspaceRelativePath: config.workspace.hooksFile,
        },
        agentRules: {
          configuredPath: config.workspace.agentRules,
          absolutePath: resolveConfigured(config.workspace.agentRules),
          workspaceRelativePath: config.workspace.agentRules,
        },
        envFile: {
          configuredPath: config.workspace.envFile,
          absolutePath: resolveConfigured(config.workspace.envFile),
          workspaceRelativePath: config.workspace.envFile,
        },
        secretsFile: {
          configuredPath: config.workspace.secretsFile,
          absolutePath: resolveConfigured(config.workspace.secretsFile),
          workspaceRelativePath: config.workspace.secretsFile,
        },
      }
    }),
    discoverWorkspaceFiles: vi.fn(({ kind }: any) => Promise.resolve(
      kind === 'suite'
        ? [{ kind, absolutePath: `${process.cwd()}/suites/smoke.suite.yaml`, workspaceRelativePath: 'suites/smoke.suite.yaml' }]
        : [{ kind, absolutePath: `${process.cwd()}/tests/login.yaml`, workspaceRelativePath: 'tests/login.yaml' }],
    )),
  }
})

vi.mock('ai', () => ({
  generateText: vi.fn(() => Promise.resolve({ text: 'ok' })),
}))

// Capture console output
const consoleLogs: string[] = []
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  consoleLogs.push(args.map(String).join(' '))
})

import { createDoctorCommand } from '../commands/doctor.js'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as core from '@vostride/agent-qa-core'
import { generateText } from 'ai'

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFile = vi.mocked(readFile)
const mockCreateModel = vi.mocked(core.createModel)
const mockGetCredential = vi.mocked(core.getCredential)
const mockLoadLLMAuthPlugins = vi.mocked(core.loadLLMAuthPlugins)
const mockResolveLLMAuth = vi.mocked((core as any).resolveLLMAuth) as any
const mockResolveAppiumExecutable = vi.mocked(core.resolveAppiumExecutable)
const mockGenerateText = vi.mocked(generateText)

async function runDoctor(parentConfig?: string): Promise<void> {
  consoleLogs.length = 0
  process.exitCode = 0

  const parent = new Command()
  if (parentConfig) parent.setOptionValue('config', parentConfig)
  parent.addCommand(createDoctorCommand())
  await parent.parseAsync(['node', 'test', 'doctor'])
}

function getOutput(): string {
  return consoleLogs.join('\n')
}

describe('doctor command', () => {
  const originalVersion = process.version
  const originalPlatform = process.platform
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    consoleLogs.length = 0
    process.exitCode = 0
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockRejectedValue({ code: 'ENOENT' })
    mockLoadLLMAuthPlugins.mockResolvedValue([])
    mockResolveAppiumExecutable.mockReturnValue({ command: 'appium', source: 'path' })
    // Clean env for consistent tests
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.GOOGLE_GENERATIVE_AI_KEY
    delete process.env.ANDROID_HOME
    delete process.env.ANDROID_SDK_ROOT
  })

  afterEach(() => {
    Object.defineProperty(process, 'version', { value: originalVersion, writable: true })
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env = { ...originalEnv }
  })

  it('Node.js version check passes for v24+', async () => {
    Object.defineProperty(process, 'version', { value: 'v24.10.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('v24.10.0')
    expect(output).toContain('PASS')
  })

  it('Node.js version check fails for v18', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.20.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('requires 24+')
    expect(output).toContain('FAIL')
  })

  it('Config file check passes when file exists', async () => {
    mockExistsSync.mockImplementation((p) => {
      return (p as string).endsWith('agent-qa.config.yaml')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('agent-qa.config.yaml found')
    expect(output).toContain('PASS')
  })

  it('Config file check warns when missing', async () => {
    mockExistsSync.mockReturnValue(false)

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('not found')
    expect(output).toContain('WARN')
  })

  it('uses the current Claude fallback model when config is missing', async () => {
    await runDoctor()

    expect(mockResolveLLMAuth).toHaveBeenCalledWith('default', expect.objectContaining({
      provider: 'anthropic-subscription',
      model: 'claude-sonnet-4-6',
    }))
  })

  it('uses the parent global config path when loading config', async () => {
    mockExistsSync.mockImplementation((p) => p === 'custom-agent-qa.yaml')
    mockReadFile.mockResolvedValue(`
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)

    await runDoctor('custom-agent-qa.yaml')

    expect(mockExistsSync).toHaveBeenCalledWith('custom-agent-qa.yaml')
    expect(mockReadFile).toHaveBeenCalledWith('custom-agent-qa.yaml', 'utf-8')
  })

  it('passes the secrets file check when workspace.secretsFile exists', async () => {
    mockReadFile.mockResolvedValue(`
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  agentRules: agent-rules.md
  envFile: .env
  secretsFile: .secrets.local
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)
    mockExistsSync.mockImplementation((p) => String(p).endsWith('.secrets.local'))

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Secrets file')
    expect(output).toContain('.secrets.local found')
  })

  it('fails the secrets file check when workspace.secretsFile is missing', async () => {
    mockReadFile.mockResolvedValue(`
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  agentRules: agent-rules.md
  envFile: .env
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
` as never)

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Missing required workspace config key: workspace.secretsFile')
    expect(output).toContain('Set workspace.secretsFile')
  })

  it('LLM credential checks resolve by config name without env-var fallback output', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: anthropic-compatible
      model: claude-remote
      baseURL: https://remote.example/messages
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })

    await runDoctor()
    const output = getOutput()

    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', expect.objectContaining({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://remote.example/messages',
    }))
    expect(output).not.toContain('ANTHROPIC_API_KEY')
    expect(output).not.toContain('OPENAI_API_KEY')
    expect(output).not.toContain('GOOGLE_GENERATIVE_AI_KEY')
  })

  it('Gemini missing credentials use resolver message without Google env-var guidance', async () => {
    const geminiConfig = `
registry:
  llms:
    - name: gemini-fast
      provider: gemini
      model: gemini-3-flash-preview
use:
  llm: gemini-fast
`
    mockReadFile.mockResolvedValue(geminiConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'missing',
      credentialKey: 'gemini-fast',
      provider: 'gemini',
      required: true,
      message: 'Save a Gemini API key for this config before testing.',
    })

    await runDoctor()
    const output = getOutput()

    expect(output).toContain('Save a Gemini API key for this config before testing.')
    expect(output).not.toContain('GOOGLE_GENERATIVE_AI_KEY')
    expect(output).not.toContain('OPENAI_API_KEY')
    expect(output).not.toContain('ANTHROPIC_API_KEY')
  })

  it('openai-compatible checks use exact baseURL and allow resolver unauthenticated state', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
      baseURL: https://remote.example/api/v1
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'planner',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    mockCreateModel.mockReturnValue({} as any)
    mockGenerateText.mockResolvedValue({ text: 'ok' } as any)

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Testing without a saved credential.')
    expect(output).toContain('credential optional')
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-compatible',
      model: 'deepseek-chat',
      baseURL: 'https://remote.example/api/v1',
    }))
    expect(mockGetCredential).not.toHaveBeenCalled()
  })

  it('LLM connection passes resolver auth material and providerHeaders to createModel', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: anthropic-compatible
      model: claude-remote
      baseURL: https://remote.example/messages
      providerHeaders:
        x-workspace: agent-qa
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'bearer-token',
      credentialKey: 'planner',
      provider: 'anthropic-compatible',
      token: 'bearer-planner',
    })

    await runDoctor()

    expect(mockResolveLLMAuth).toHaveBeenCalledWith('planner', expect.objectContaining({
      provider: 'anthropic-compatible',
      providerHeaders: { 'x-workspace': 'agent-qa' },
    }))
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic-compatible',
      model: 'claude-remote',
      baseURL: 'https://remote.example/messages',
      providerHeaders: { 'x-workspace': 'agent-qa' },
      authToken: 'bearer-planner',
    }))
  })

  it('loads declared auth plugins and forwards auth-fetch modelAdapter to createModel', async () => {
    const subscriptionConfig = `
plugins:
  auth:
    - package: "@vostride/agent-qa-subscription-auth"
registry:
  llms:
    - name: codex
      provider: openai-subscription
      model: gpt-5.5
use:
  llm: codex
`
    const authFetch = vi.fn() as unknown as typeof globalThis.fetch
    mockReadFile.mockResolvedValue(subscriptionConfig as never)
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'auth-fetch',
      credentialKey: 'codex',
      provider: 'openai-subscription',
      modelAdapter: 'openai-responses',
      fetch: authFetch,
    })

    await runDoctor('agent-qa.config.yaml')

    expect(mockLoadLLMAuthPlugins).toHaveBeenCalledWith(
      [{ package: '@vostride/agent-qa-subscription-auth' }],
      expect.objectContaining({ baseDir: expect.any(String) }),
    )
    expect(mockCreateModel).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai-subscription',
      model: 'gpt-5.5',
      fetch: authFetch,
      modelAdapter: 'openai-responses',
    }))
  })

  it('openai-compatible connection check fails when baseURL is missing', async () => {
    const compatibleConfig = `
registry:
  llms:
    - name: planner
      provider: openai-compatible
      model: deepseek-chat
use:
  llm: planner
`
    mockReadFile.mockResolvedValue(compatibleConfig as never)
    mockGetCredential.mockResolvedValue(null)

    await runDoctor()

    expect(getOutput()).toContain('baseURL required for openai-compatible')
    expect(mockCreateModel).not.toHaveBeenCalled()
  })

  it('Playwright check passes when installed', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string).includes('playwright --version')) return Buffer.from('1.50.0')
      return Buffer.from('')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('installed')
  })

  it('Playwright check fails when not installed', async () => {
    mockExecSync.mockImplementation((cmd) => {
      if ((cmd as string).includes('playwright')) throw new Error('not found')
      return Buffer.from('')
    })

    await runDoctor()
    const output = getOutput()
    // Should show Playwright not installed
    expect(output).toContain('Playwright')
    expect(output).toContain('agent-qa install-browsers --chromium')
    expect(output).not.toContain('agent-qa init')
    expect(output).not.toContain('npx playwright install')
  })

  it('Appium checks skipped when platform is web-only', async () => {
    // No mobile config → appium should be skipped
    await runDoctor()
    const output = getOutput()
    // Appium line should show SKIP
    expect(output).toContain('not configured')
    expect(output).toContain('SKIP')
  })

  it('Appium checks run when platform includes mobile', async () => {
    // Load config with mobile app
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: android
    environments:
      dev:
        url: http://localhost
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = cmd as string
      if (cmdStr.includes('playwright')) throw new Error('not found')
      return Buffer.from('')
    })
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'appium' && Array.isArray(args) && args.join(' ') === '--version') return Buffer.from('2.0.0')
      if (cmd === 'appium' && Array.isArray(args) && args.join(' ') === 'driver list --installed') return Buffer.from('uiautomator2')
      return Buffer.from('')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('Appium')
    // Should not show SKIP for appium
    expect(output).toContain('v2.0.0')
  })

  it('Appium checks use the resolved local executable when available', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: ios
    environments:
      dev:
        url: http://localhost
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    mockResolveAppiumExecutable.mockReturnValue({ command: '/tmp/project/node_modules/.bin/appium', source: 'local' })
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === '/tmp/project/node_modules/.bin/appium' && Array.isArray(args) && args.join(' ') === '--version') return Buffer.from('2.1.0')
      if (cmd === '/tmp/project/node_modules/.bin/appium' && Array.isArray(args) && args.join(' ') === 'driver list --installed') return Buffer.from('xcuitest')
      return Buffer.from('')
    })

    await runDoctor()

    expect(mockResolveAppiumExecutable).toHaveBeenCalledWith({ cwd: process.cwd() })
    expect(mockExecFileSync).toHaveBeenCalledWith('/tmp/project/node_modules/.bin/appium', ['--version'], { stdio: 'pipe' })
    expect(mockExecFileSync).toHaveBeenCalledWith('/tmp/project/node_modules/.bin/appium', ['driver', 'list', '--installed'], { stdio: 'pipe' })
  })

  it('Appium driver failure points to the AgentQA mobile driver install command', async () => {
    const mobileConfig = `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  agentRules: agent-rules.md
  envFile: .env
  secretsFile: .env.secrets.local
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
  targets:
    my-app:
      platform: android
use:
  llm: default
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    mockExistsSync.mockReturnValue(true)
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = cmd as string
      if (cmdStr.includes('playwright')) return Buffer.from('1.50.0')
      return Buffer.from('')
    })
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'appium' && Array.isArray(args) && args.join(' ') === '--version') return Buffer.from('2.0.0')
      if (cmd === 'appium' && Array.isArray(args) && args.join(' ') === 'driver list --installed') return Buffer.from('')
      return Buffer.from('')
    })

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('no drivers installed')
    expect(output).toContain('agent-qa install-mobile-drivers --android')
    expect(output).not.toContain('appium driver install uiautomator2')
  })

  it('missing Appium guidance keeps local install first and names the mobile driver command', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: ios
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    mockExecFileSync.mockImplementation((cmd, args) => {
      if (cmd === 'appium' && Array.isArray(args) && args.join(' ') === '--version') throw new Error('appium not found')
      return Buffer.from('')
    })

    await runDoctor()

    const output = getOutput()
    expect(output).toContain('Install Appium locally with `npm install -D appium`')
    expect(output).toContain('agent-qa install-mobile-drivers --ios')
  })

  it('Android SDK check validates ANDROID_HOME', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: android
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    process.env.ANDROID_HOME = '/opt/android-sdk'
    mockExistsSync.mockImplementation((p) => {
      return (p as string).includes('platform-tools/adb')
    })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('SDK found')
  })

  it('Xcode check skipped on non-macOS', async () => {
    const mobileConfig = `
registry:
  llms:
    - name: default
      provider: openai-compatible
      model: model-name
      baseURL: https://remote.example/api/v1
use:
  llm: default
targets:
  my-app:
    platform: ios
`
    mockReadFile.mockResolvedValue(mobileConfig as never)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('requires macOS')
  })

  it('Overall result: all pass → exit 0', async () => {
    Object.defineProperty(process, 'version', { value: 'v24.10.0', writable: true })
    mockExistsSync.mockReturnValue(true)
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    mockResolveLLMAuth.mockResolvedValue({
      kind: 'unauthenticated',
      credentialKey: 'default',
      provider: 'openai-compatible',
      optional: true,
      message: 'Testing without a saved credential.',
    })
    // Provide a valid config so config validation passes
    const { stringify } = await import('yaml')
    const validConfig = stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        agentRules: 'agent-rules.md',
        envFile: '.env',
        secretsFile: '.secrets.local',
      },
      registry: { llms: [{ name: 'default', provider: 'openai-compatible', model: 'model-name', baseURL: 'https://remote.example/api/v1', screenshotSize: '1m' }] },
      services: { cache: { dir: '.agent-qa/cache', ttl: '7d' }, logging: { level: 'warn' } },
      use: {
        browser: { name: 'chromium', headless: true },
        timeout: { step: '30s', test: '10m', navigation: '10s' },
        healing: { maxAttempts: 3 },
        planner: { maxSubActions: 50, previousStepCount: 5 },
        llm: 'default',
      },
    })
    mockReadFile.mockResolvedValue(validConfig as never)

    await runDoctor()
    expect(process.exitCode).toBe(0)
    const output = getOutput()
    expect(output).toContain('All checks passed')
  })

  it('Overall result: any fail → exit 1', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.0.0', writable: true })

    await runDoctor()
    expect(process.exitCode).toBe(1)
    const output = getOutput()
    expect(output).toContain('Some checks failed')
  })

  it('Fix instructions printed for each failure', async () => {
    Object.defineProperty(process, 'version', { value: 'v18.0.0', writable: true })

    await runDoctor()
    const output = getOutput()
    expect(output).toContain('Install Node.js 24+')
  })
})
