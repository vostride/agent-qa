import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

const {
  mockGlob,
  mockParseAllTests,
  mockParseHooksFile,
  mockRunHooks,
  mockRunTestWithRetry,
  mockResolveConfig,
  mockResolveTarget,
  mockCreateModel,
  mockLLMPlanner,
  mockLLMVerifier,
  mockMultiReporterInstance,
  mockCreateAnalyticsRunReporter,
  mockWebAdapterCleanup,
} = vi.hoisted(() => {
  const multiReporter = {
    onRunStart: vi.fn().mockResolvedValue(undefined),
    onRunEnd: vi.fn().mockResolvedValue(undefined),
    onTestStart: vi.fn().mockResolvedValue(undefined),
    onTestEnd: vi.fn().mockResolvedValue(undefined),
    onHookStart: vi.fn().mockResolvedValue(undefined),
    onHookEnd: vi.fn().mockResolvedValue(undefined),
    onStepStart: vi.fn().mockResolvedValue(undefined),
    onStepEnd: vi.fn().mockResolvedValue(undefined),
  }
  const analyticsRunReporter = {
    flush: vi.fn().mockResolvedValue(undefined),
  }

  return {
    mockGlob: vi.fn(),
    mockParseAllTests: vi.fn(),
    mockParseHooksFile: vi.fn(),
    mockRunHooks: vi.fn(),
    mockRunTestWithRetry: vi.fn(),
    mockResolveConfig: vi.fn(),
    mockResolveTarget: vi.fn(),
    mockCreateModel: vi.fn(() => ({})),
    mockLLMPlanner: vi.fn(function () { return {} }),
    mockLLMVerifier: vi.fn(function () { return {} }),
    mockMultiReporterInstance: multiReporter,
    mockCreateAnalyticsRunReporter: vi.fn(function () { return analyticsRunReporter }),
    mockWebAdapterCleanup: vi.fn(),
  }
})

vi.mock('glob', () => ({ glob: mockGlob }))

vi.mock('@vostride/agent-qa-core', () => ({
  DEFAULT_AGENT_QA_ARTIFACTS_DIR: '.agent-qa/artifacts',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_SCREENSHOTS_DIR: '.agent-qa/artifacts/screenshots',
  DEFAULT_AGENT_QA_VIDEOS_DIR: '.agent-qa/artifacts/videos',
  parseAllTests: mockParseAllTests,
  formatParseError: vi.fn((err: any) => `${err.file}:${err.line}:${err.column}: ${err.message}`),
  parseHooksFile: mockParseHooksFile,
  runHooks: mockRunHooks,
  runTestWithRetry: mockRunTestWithRetry,
  createModel: mockCreateModel,
  resolveLLMAuth: vi.fn(async () => ({
    kind: 'api-key',
    credentialKey: 'default',
    provider: 'anthropic-subscription',
    apiKey: 'test-key',
  })),
  getProviderOptions: vi.fn(() => ({})),
  LLMPlanner: mockLLMPlanner,
  LLMVerifier: mockLLMVerifier,
  parseEnvFile: vi.fn(() => ({})),
  SecretStore: class MockSecretStore {
    private secrets: Record<string, string>

    constructor(secrets: Record<string, string> = {}) {
      this.secrets = secrets
    }

    static fromEnvContent(content: string) {
      const secrets: Record<string, string> = {}
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        secrets[key] = value
      }
      return new this(secrets)
    }

    get(name: string) {
      return this.secrets[name]
    }

    require(name: string) {
      const value = this.get(name)
      if (value === undefined) throw new Error(`Secret not found: ${name}`)
      return value
    }

    count() {
      return Object.keys(this.secrets).length
    }

    forEachSecret(callback: (name: string, value: string) => void) {
      for (const [name, value] of Object.entries(this.secrets)) callback(name, value)
    }
  },
  SecretRedactor: class MockSecretRedactor {
    redactString(value: string) { return value }
    redactValue(value: unknown) { return value }
  },
  FileActionCache: vi.fn(function () { return {} }),
  LogManager: vi.fn(function () {
    return {
      setRunId: vi.fn(),
      setCurrentStep: vi.fn(),
      clearCurrentStep: vi.fn(),
      createScopedLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    }
  }),
  ConsoleReporter: vi.fn(function () { return {} }),
  JUnitReporter: vi.fn(function () { return {} }),
  MultiReporter: vi.fn(function () { return mockMultiReporterInstance }),
  createAnalyticsRunReporter: mockCreateAnalyticsRunReporter,
  CircuitBreaker: vi.fn(function () {
    return {
      record: vi.fn(),
      isTripped: vi.fn(() => false),
      evaluate: vi.fn(() => ({ tripped: false, failureRate: 0, baselineRate: 0 })),
    }
  }),
  shouldAblate: vi.fn(() => false),
  collectAllInjectedIds: vi.fn(() => new Map()),
  createMemoryProvider: vi.fn(),
  resolveMemoryRoot: vi.fn((_config: unknown, configDir: string) => `${configDir}/agent-qa-memory`),
  generateRunId: vi.fn(() => 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'),
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
  discoverWorkspaceFiles: vi.fn(async ({ workspace, kind }: any) => {
    const patterns = kind === 'suite' ? workspace.suiteMatch : workspace.testMatch
    const files: string[] = []
    for (const pattern of patterns) {
      files.push(...await mockGlob(pattern, { ignore: workspace.testPathIgnore ?? [] }))
    }
    return files.map((file) => ({
      kind,
      absolutePath: file,
      workspaceRelativePath: file,
    }))
  }),
  resolveWorkspaceFileTarget: vi.fn(async ({ kind, filePath }: any) => ({
    kind,
    absolutePath: filePath,
    workspaceRelativePath: filePath,
  })),
  isWorkspacePathMatch: vi.fn(({ workspace, kind, workspaceRelativePath }: any) => {
    const patterns = kind === 'suite' ? workspace.suiteMatch : workspace.testMatch
    return patterns.some((pattern: string) => {
      let source = ''
      for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]
        if (char === '*' && pattern[i + 1] === '*') {
          if (pattern[i + 2] === '/') {
            source += '(?:.*/)?'
            i += 2
          } else {
            source += '.*'
            i += 1
          }
        } else if (char === '*') {
          source += '[^/]*'
        } else {
          source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        }
      }
      return new RegExp(`^${source}$`).test(workspaceRelativePath)
    })
  }),
  parseRunAttrFlags: vi.fn(() => ({ attributes: {}, duplicateKeys: [] })),
  buildInternalRunAttributes: vi.fn(({ trigger, runner }: { trigger: string; runner: string }) => ({
    'agent-qa.trigger': trigger,
    'agent-qa.runner': runner,
  })),
  mergeRunAttributes: vi.fn((internal: Record<string, string>, user: Record<string, string>) => ({
    ...internal,
    ...user,
  })),
  formatRunAttributesBlock: vi.fn((attributes: Record<string, string>) =>
    Object.entries(attributes).length > 0
      ? ['Run attributes:', ...Object.entries(attributes).map(([key, value]) => `  ${key}=${value}`)].join('\n')
      : '',
  ),
  isPathInsideDir: vi.fn((candidatePath: string) => !candidatePath.includes('..')),
}))

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn(function () {
    return {
      setup: vi.fn(),
      cleanup: mockWebAdapterCleanup,
      observe: vi.fn(),
      execute: vi.fn(),
    }
  }),
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
  mergeWithTestConfig: vi.fn((...args: any[]) => args[0]),
  mergeUseBlocks: vi.fn((...args: any[]) => args[0] ?? {}),
  formatConfigDebug: vi.fn(() => ''),
  loadEnvOverrides: vi.fn(() => ({})),
}))

vi.mock('../targets.js', () => ({
  resolveTarget: mockResolveTarget,
}))

import { createRunCommand } from '../commands/run.js'

const HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

function defaultConfig() {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      testPathIgnore: [] as string[],
      hooksFile: 'hooks.yaml',
      agentRules: 'agent-rules.md',
      envFile: '.env',
      secretsFile: '.secrets.local',
    },
    services: {
      cache: { dir: '.agent-qa/cache', ttl: '7d' },
      logging: { level: 'warn' },
    },
    registry: {
      llms: [{
        name: 'default',
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
      }],
      targets: { 'test-app': { platform: 'web', url: 'https://example.com', product: 'test-app' } },
    },
    use: {
      llm: 'default',
      timeout: { step: 30000, test: 300000, navigation: 10000 },
      healing: { maxAttempts: 0 },
      planner: { maxSubActions: 50, previousStepCount: 3 },
      logCapture: { console: true, network: true },
    },
  }
}

function makeTest(overrides: Record<string, unknown> = {}) {
  return {
    'test-id': TEST_ID,
    name: 'Hook identity test',
    target: 'test-app',
    steps: ['Open the page'],
    ...overrides,
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let tempDir: string
let originalCwd: string

beforeEach(async () => {
  vi.clearAllMocks()
  mockResolveConfig.mockResolvedValue(defaultConfig())
  mockResolveTarget.mockReturnValue({
    name: 'test-app',
    product: 'test-app',
    platform: 'web',
    url: 'https://example.com',
  })
  mockGlob.mockResolvedValue(['tests/hook-id.yaml'])
  mockParseHooksFile.mockResolvedValue({
    hooks: [{
      id: HOOK_ID,
      name: 'Auth Hook',
      runtime: 'ts',
      file: '/project/hooks/auth.ts',
      deps: [],
      timeout: 30000,
      network: true,
    }],
    errors: [],
  })
  mockRunHooks.mockResolvedValue({
    results: new Map([
      ['Auth Hook', { success: true, duration: 5, stdout: '', stderr: '', variables: {}, error: undefined }],
    ]),
  })
  mockRunTestWithRetry.mockResolvedValue({
    name: 'Hook identity test',
    filePath: 'tests/hook-id.yaml',
    status: 'passed',
    steps: [],
    duration: 1,
  })

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as any)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  originalCwd = process.cwd()
  tempDir = await mkdtemp(path.join(tmpdir(), 'agent-qa-run-hook-ids-'))
  await writeFile(path.join(tempDir, 'hooks.yaml'), 'hooks: []\n', 'utf-8')
  await writeFile(path.join(tempDir, 'agent-rules.md'), '', 'utf-8')
  await writeFile(path.join(tempDir, '.env'), '', 'utf-8')
  await writeFile(path.join(tempDir, '.secrets.local'), '', 'utf-8')
  process.chdir(tempDir)
})

afterEach(async () => {
  process.chdir(originalCwd)
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errorSpy.mockRestore()
  await rm(tempDir, { recursive: true, force: true })
})

async function runCommand(...args: string[]) {
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.option('--log-level <level>', 'log verbosity: silent|error|warn|info|debug')
  program.option('--verbose', 'shorthand for --log-level debug')
  program.option('--quiet', 'shorthand for --log-level silent')
  program.addCommand(createRunCommand())

  try {
    await program.parseAsync(['node', 'agent-qa', 'run', ...args])
  } catch (err) {
    if ((err as Error).message !== 'process.exit') throw err
  }
}

describe('run command hook identity resolution', () => {
  it('resolves setup and teardown hooks from canonical hook ids', async () => {
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ setup: [HOOK_ID], teardown: [HOOK_ID] })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunHooks).toHaveBeenCalledTimes(2)
    expect(mockRunHooks).toHaveBeenNthCalledWith(1, [expect.objectContaining({ id: HOOK_ID, name: 'Auth Hook' })], expect.any(Object))
    expect(mockRunHooks).toHaveBeenNthCalledWith(2, [expect.objectContaining({ id: HOOK_ID, name: 'Auth Hook' })], expect.any(Object))
  })

  it('passes inline hook definitions keyed by canonical hook id into the test runner', async () => {
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ steps: [`Open the page {{runHook:"${HOOK_ID}"}}`] })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunTestWithRetry).toHaveBeenCalledTimes(1)
    const inlineHookDefs = mockRunTestWithRetry.mock.calls[0][1].inlineHookDefs as Map<string, unknown>
    expect(inlineHookDefs.has(HOOK_ID)).toBe(true)
    expect(inlineHookDefs.get(HOOK_ID)).toEqual(expect.objectContaining({ id: HOOK_ID, name: 'Auth Hook' }))
    expect(inlineHookDefs.has('Auth Hook')).toBe(false)
  })
})
