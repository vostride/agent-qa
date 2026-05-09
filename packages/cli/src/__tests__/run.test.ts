import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

const {
  mockGlob,
  mockParseAllTests,
  mockParseSuiteFile,
  mockParseTestFile,
  mockParseHooksFile,
  mockFormatParseError,
  mockRunHooks,
  mockRunSuite,
  mockRunTestWithRetry,
  mockCreateMemoryProvider,
  mockCreateModel,
  mockLLMPlanner,
  mockLLMVerifier,
  mockResolveConfig,
  mockResolveTarget,
  mockAndroidAdapterSetup,
  mockAndroidAdapterCleanup,
  mockWebAdapterSetup,
  mockWebAdapterCleanup,
  mockConsoleReporterInstance,
  mockJUnitReporterInstance,
  mockStdoutLiveReporterInstance,
  mockMultiReporterInstance,
  mockDashboardDatabase,
  mockDashboardReporter,
  mockResolveDashboardDbPath,
  mockGenerateRunId,
  mockFileActionCache,
  mockAnalyticsRunReporterInstance,
  mockCreateAnalyticsRunReporter,
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
    onRunEnd: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  }
  return {
    mockGlob: vi.fn(),
    mockParseAllTests: vi.fn(),
    mockParseSuiteFile: vi.fn(),
    mockParseTestFile: vi.fn(),
    mockParseHooksFile: vi.fn(),
    mockFormatParseError: vi.fn((err: any) => `${err.file}:${err.line}:${err.column}: ${err.message}`),
    mockRunHooks: vi.fn(),
    mockRunSuite: vi.fn(),
    mockRunTestWithRetry: vi.fn(),
    mockCreateMemoryProvider: vi.fn(),
    mockCreateModel: vi.fn(() => ({})),
    mockLLMPlanner: vi.fn(),
    mockLLMVerifier: vi.fn(),
    mockResolveConfig: vi.fn(),
    mockResolveTarget: vi.fn(),
    mockAndroidAdapterSetup: vi.fn(),
    mockAndroidAdapterCleanup: vi.fn(),
    mockWebAdapterSetup: vi.fn(),
    mockWebAdapterCleanup: vi.fn(),
    mockConsoleReporterInstance: { verbose: false },
    mockJUnitReporterInstance: { outputPath: '' },
    mockStdoutLiveReporterInstance: { active: false },
    mockMultiReporterInstance: multiReporter,
    mockDashboardDatabase: vi.fn(function () { return { close: vi.fn() } }),
    mockDashboardReporter: vi.fn(function () { return {} }),
    mockResolveDashboardDbPath: vi.fn(),
    mockGenerateRunId: vi.fn(() => 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'),
    mockFileActionCache: vi.fn(function () { return {} }),
    mockAnalyticsRunReporterInstance: analyticsRunReporter,
    mockCreateAnalyticsRunReporter: vi.fn(function () { return analyticsRunReporter }),
  }
})

vi.mock('glob', () => ({ glob: mockGlob }))

vi.mock('@vostride/agent-qa-core', () => {
  class MockMobileSetupError extends Error {
    category: string
    constructor(input: { category: string; message: string }) {
      super(input.message)
      this.category = input.category
    }
  }

  return {
  parseAllTests: mockParseAllTests,
  parseSuiteFile: mockParseSuiteFile,
  parseTestFile: mockParseTestFile,
  parseHooksFile: mockParseHooksFile,
  formatParseError: mockFormatParseError,
  runHooks: mockRunHooks,
  runSuite: mockRunSuite,
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
  FileActionCache: mockFileActionCache,
  ATTR_TRIGGER: 'agent-qa.trigger',
  ATTR_RUNNER: 'agent-qa.runner',
  DEFAULT_AGENT_QA_ARTIFACTS_DIR: '.agent-qa/artifacts',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_SCREENSHOTS_DIR: '.agent-qa/artifacts/screenshots',
  DEFAULT_AGENT_QA_VIDEOS_DIR: '.agent-qa/artifacts/videos',
  parseEnvFile: vi.fn(() => ({})),
  registerAllProviders: vi.fn(),
  getProvider: vi.fn(() => ({
    resolveMobileCapabilities: vi.fn(async () => ({
      provider: 'browserstack',
      endpoint: 'wss://browserstack.example.test/playwright',
      capabilities: {},
    })),
  })),
  validateUserRunAttributes: vi.fn((input: unknown, sourceLabel = 'run attributes') => {
    if (input === undefined || input === null) return {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`${sourceLabel}: attributes must be a plain object`)
    }
    const attributes: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      if (!key) throw new Error(`${sourceLabel}: Attribute key must be non-empty`)
      if (key.startsWith('agent-qa.')) throw new Error(`${sourceLabel}: Attribute key "${key}" uses the reserved prefix "agent-qa."`)
      if (typeof value !== 'string') throw new Error(`${sourceLabel}: Attribute value for "${key}" must be a string`)
      attributes[key] = value
    }
    return attributes
  }),
  validateTrustedRunAttributes: vi.fn((input: unknown, sourceLabel = 'run attributes') => {
    if (input === undefined || input === null) return {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error(`${sourceLabel}: attributes must be a plain object`)
    }
    const attributes: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      if (!key) throw new Error(`${sourceLabel}: Attribute key must be non-empty`)
      if (typeof value !== 'string') throw new Error(`${sourceLabel}: Attribute value for "${key}" must be a string`)
      if (key === 'agent-qa.trigger' && !['cli', 'dashboard', 'api', 'mcp'].includes(value)) {
        throw new Error(`${sourceLabel}: Attribute value for "${key}" must be one of: cli, dashboard, api, mcp`)
      }
      if (key === 'agent-qa.runner' && !['local', 'browserstack'].includes(value)) {
        throw new Error(`${sourceLabel}: Attribute value for "${key}" must be one of: local, browserstack`)
      }
      if (key.startsWith('agent-qa.') && key !== 'agent-qa.trigger' && key !== 'agent-qa.runner') {
        throw new Error(`${sourceLabel}: Attribute key "${key}" uses the reserved prefix "agent-qa."`)
      }
      attributes[key] = value
    }
    return attributes
  }),
  parseRunAttrFlags: vi.fn((flags: string[] | undefined) => {
    const rawAttributes: Record<string, string> = {}
    const seen = new Set<string>()
    const duplicateKeys = new Set<string>()
    for (const flag of flags ?? []) {
      const separator = flag.indexOf('=')
      if (separator <= 0) throw new Error(`--run-attr must use KEY=VALUE format: "${flag}"`)
      const key = flag.slice(0, separator)
      const value = flag.slice(separator + 1)
      if (seen.has(key)) duplicateKeys.add(key)
      seen.add(key)
      rawAttributes[key] = value
    }
    for (const key of Object.keys(rawAttributes)) {
      if (key.startsWith('agent-qa.')) throw new Error(`--run-attr: Attribute key "${key}" uses the reserved prefix "agent-qa."`)
    }
    return { attributes: rawAttributes, duplicateKeys: [...duplicateKeys].sort() }
  }),
  buildInternalRunAttributes: vi.fn(({ trigger, runner }: { trigger: string; runner: string }) => ({
    'agent-qa.trigger': trigger,
    'agent-qa.runner': runner,
  })),
  mergeRunAttributes: vi.fn((internal: Record<string, string>, user: Record<string, string>) => ({
    ...user,
    ...internal,
  })),
  formatRunAttributesBlock: vi.fn((attributes: Record<string, string>) => {
    const order = ([key]: [string, string]) => key === 'agent-qa.trigger'
      ? [0, 0, key]
      : key === 'agent-qa.runner'
        ? [0, 1, key]
        : [1, 0, key]
    const entries = Object.entries(attributes).sort((left, right) => {
      const leftOrder = order(left)
      const rightOrder = order(right)
      return Number(leftOrder[0]) - Number(rightOrder[0])
        || Number(leftOrder[1]) - Number(rightOrder[1])
        || String(leftOrder[2]).localeCompare(String(rightOrder[2]))
    })
    return ['Run attributes:', ...entries.map(([key, value]) => `  ${key}=${value}`)].join('\n')
  }),
  MobileSetupError: MockMobileSetupError,
  resolveMobileRunConfig: vi.fn((input: any) => ({
    deviceName: (() => {
      const deviceName = input.explicitDeviceName ?? input.useDeviceName
      if (!deviceName) {
        throw new MockMobileSetupError({
          category: 'device-resolution',
          message: `No device specified for mobile target "${input.targetName}"`,
        })
      }
      if (input.appState !== 'preserve' && input.appState !== 'reset') {
        throw new MockMobileSetupError({
          category: 'device-resolution',
          message: 'use.mobile.appState is required',
        })
      }
      return deviceName
    })(),
    platform: input.platform,
    targetName: input.targetName,
    transport: 'local',
    device: {
      name: input.explicitDeviceName ?? input.useDeviceName,
      platform: input.platform,
      transport: 'local',
      match: {},
    },
    app: {},
    appState: input.appState,
    appium: { url: input.appiumUrl },
    sourceTrace: [],
  })),
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
  hashStepInstruction: vi.fn(() => 'mock-hash'),
  LogManager: vi.fn(function () {
    return {
      log: vi.fn(),
      flush: vi.fn(),
      setRunId: vi.fn(),
      setCurrentStep: vi.fn(),
      clearCurrentStep: vi.fn(),
      getBuffer: vi.fn(() => []),
      createScopedLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    }
  }),
  ConsoleReporter: vi.fn(function (opts: any) {
    mockConsoleReporterInstance.verbose = opts?.verbose ?? false
    return mockConsoleReporterInstance
  }),
  JUnitReporter: vi.fn(function (opts: any) {
    mockJUnitReporterInstance.outputPath = opts?.outputPath ?? ''
    return mockJUnitReporterInstance
  }),
  StdoutLiveReporter: vi.fn(function (opts: any) {
    mockStdoutLiveReporterInstance.active = opts?.active ?? false
    return mockStdoutLiveReporterInstance
  }),
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
  createMemoryProvider: mockCreateMemoryProvider,
  resolveMemoryRoot: vi.fn((config: any, configDir: string) => {
    const memoryDir = config?.services?.memory?.dir ?? 'agent-qa-memory'
    return memoryDir.startsWith('/') ? memoryDir : resolve(configDir, memoryDir)
  }),
  generateRunId: mockGenerateRunId,
  isPathInsideDir: vi.fn((candidatePath: string) => !candidatePath.includes('..')),
  resolveWorkspacePaths: vi.fn(({ config, configPath }: any) => {
    const configDir = String(configPath).includes('/')
      ? String(configPath).split('/').slice(0, -1).join('/')
      : process.cwd()
    for (const key of ['testMatch', 'suiteMatch', 'hooksFile', 'agentRules', 'envFile', 'secretsFile']) {
      if (config.workspace[key] === undefined) {
        throw new Error(`workspace.${key} is required`)
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
  resolveWorkspaceFileTarget: vi.fn(async ({ workspace, kind, filePath }: any) => {
    if (filePath.includes('legacy') || filePath.includes('..')) {
      throw new Error(`Workspace ${kind} file is not matched by configured workspace patterns: ${filePath}`)
    }
    return {
      kind,
      absolutePath: filePath,
      workspaceRelativePath: filePath,
    }
  }),
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
}})

vi.mock('@vostride/agent-qa-android', () => ({
  AndroidPlatformAdapter: vi.fn(function () {
    return {
      setup: mockAndroidAdapterSetup,
      cleanup: mockAndroidAdapterCleanup,
      observe: vi.fn(),
      execute: vi.fn(),
    }
  }),
}))

vi.mock('@vostride/agent-qa-web', () => ({
  WebPlatformAdapter: vi.fn(function () {
    return {
      setup: mockWebAdapterSetup,
      cleanup: mockWebAdapterCleanup,
      observe: vi.fn(),
      execute: vi.fn(),
    }
  }),
}))

vi.mock('@vostride/agent-qa-dashboard', () => ({
  DashboardDatabase: mockDashboardDatabase,
  DashboardReporter: mockDashboardReporter,
  resolveDashboardDbPath: mockResolveDashboardDbPath,
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
  mergeWithTestConfig: vi.fn((...args: any[]) => args[0]),
  mergeConfigs: vi.fn((...args: any[]) => args[0]),
  mergeUseBlocks: vi.fn((globalUse: any, suiteUse: any, testUse: any, cliFlags: any) => {
    const merge = (base: any, override: any): any => {
      if (!base || typeof base !== 'object' || Array.isArray(base)) return override ?? base
      if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base
      const result: Record<string, unknown> = { ...base }
      for (const [key, value] of Object.entries(override)) {
        result[key] = merge(result[key], value)
      }
      return result
    }
    return merge(merge(merge(globalUse ?? {}, suiteUse ?? {}), testUse ?? {}), cliFlags ?? {})
  }),
  formatConfigDebug: vi.fn(() => ''),
  loadEnvOverrides: vi.fn(() => ({})),
  loadConfigFile: vi.fn(() => ({})),
}))

vi.mock('../targets.js', () => ({
  resolveTarget: mockResolveTarget,
}))

import { createRunCommand } from '../commands/run.js'

let defaultSecretsFilePath: string | undefined
let defaultEnvFilePath: string | undefined
let defaultHooksFilePath: string | undefined
let defaultAgentRulesFilePath: string | undefined

function defaultConfig() {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      testPathIgnore: [] as string[],
      hooksFile: defaultHooksFilePath ?? 'hooks.yaml',
      agentRules: defaultAgentRulesFilePath ?? './agent-rules.md',
      envFile: defaultEnvFilePath ?? '.env',
      secretsFile: defaultSecretsFilePath ?? '.env.secrets.local',
    },
    // Flat aliases removed — run command now reads from workspace.* (4-bucket config)
    services: {
      cache: { dir: '.agent-qa/cache', ttl: '7d' },
      logging: { level: 'warn' },
      dashboard: undefined as any,
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
      healing: { maxAttempts: 3 },
      planner: { maxSubActions: 50, previousStepCount: 3 },
      logCapture: { console: true, network: true },
    },
  }
}

function makeTest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test One',
    target: 'test-app',
    steps: ['Click login'],
    meta: { tags: ['smoke', 'auth'], suite: 'authentication' },
    ...overrides,
  }
}

function makeTest2(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Two',
    target: 'test-app',
    steps: ['Click register'],
    meta: { tags: ['regression'], suite: 'checkout' },
    ...overrides,
  }
}

let exitSpy: any
let logSpy: any
let errorSpy: any
const tempDirs: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  const secretsDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-secrets-'))
  tempDirs.push(secretsDir)
  defaultSecretsFilePath = join(secretsDir, '.env.secrets.local')
  defaultEnvFilePath = join(secretsDir, '.env')
  defaultHooksFilePath = join(secretsDir, 'hooks.yaml')
  defaultAgentRulesFilePath = join(secretsDir, 'agent-rules.md')
  writeFileSync(defaultSecretsFilePath, '')
  writeFileSync(defaultEnvFilePath, '')
  writeFileSync(defaultHooksFilePath, 'hooks: []\n')
  writeFileSync(defaultAgentRulesFilePath, '# rules\n')
  mockResolveConfig.mockResolvedValue(defaultConfig())
  mockDashboardDatabase.mockImplementation(function () { return { close: vi.fn() } })
  mockDashboardReporter.mockImplementation(function () { return {} })
  mockResolveDashboardDbPath.mockImplementation(({ configDir, configuredDbPath }: { configDir: string; configuredDbPath?: string }) => {
    if (configuredDbPath?.trim()) return resolve(configDir, configuredDbPath)
    const defaultPath = resolve(configDir, '.agent-qa/runs.db')
    const legacyPath = resolve(configDir, '.agent-qa/dashboard.db')
    if (!existsSync(defaultPath) && existsSync(legacyPath)) {
      mkdirSync(dirname(defaultPath), { recursive: true })
      renameSync(legacyPath, defaultPath)
    }
    return defaultPath
  })
  mockParseSuiteFile.mockReset()
  mockParseTestFile.mockReset()
  mockParseHooksFile.mockReset()
  mockParseHooksFile.mockResolvedValue({ hooks: [], errors: [] })
  mockRunHooks.mockReset()
  mockRunHooks.mockResolvedValue({
    allPassed: true,
    variables: {},
    results: new Map(),
  })
  mockRunSuite.mockReset()
  mockRunSuite.mockResolvedValue({ status: 'passed', duration: 100 })
  mockFileActionCache.mockClear()
  mockResolveTarget.mockReturnValue({
    name: 'test-app',
    product: 'test-app',
    platform: 'web',
    url: 'https://example.com',
  })
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit')
  }) as any)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  exitSpy.mockRestore()
  logSpy.mockRestore()
  errorSpy.mockRestore()
  delete process.env.AGENT_QA_RUN_ID
  delete process.env.AGENT_QA_SUITE_QUEUE_ID
  delete process.env.AGENT_QA_PARENT_RUN_ID
  delete process.env.AGENT_QA_RUN_ATTRIBUTES_JSON
  delete process.env.BROWSERSTACK_USERNAME
  delete process.env.BROWSERSTACK_ACCESS_KEY
  defaultSecretsFilePath = undefined
  defaultEnvFilePath = undefined
  defaultHooksFilePath = undefined
  defaultAgentRulesFilePath = undefined
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function runCommand(...args: string[]) {
  return runCommandWithGlobalArgs([], ...args)
}

async function runCommandWithGlobalArgs(globalArgs: string[], ...runArgs: string[]) {
  const program = new Command()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.option('--log-level <level>', 'log verbosity: silent|error|warn|info|debug')
  program.option('--verbose', 'shorthand for --log-level debug')
  program.option('--quiet', 'shorthand for --log-level silent')
  program.configureOutput({ writeErr: (message) => errorSpy(message.trimEnd()) })
  const run = createRunCommand()
  run.configureOutput({ writeErr: (message) => errorSpy(message.trimEnd()) })
  program.addCommand(run)

  try {
    await program.parseAsync(['node', 'agent-qa', ...globalArgs, 'run', ...runArgs])
  } catch (err) {
    if ((err as Error).message !== 'process.exit') throw err
  }
}

async function parseRemovedRunFlag(...runArgs: string[]) {
  const program = new Command()
  const run = createRunCommand()
  program.configureOutput({ writeErr: () => {} })
  run.configureOutput({ writeErr: () => {} })
  program.exitOverride()
  run.exitOverride()
  program.addCommand(run)

  return program.parseAsync(['node', 'agent-qa', 'run', ...runArgs])
}

async function waitForCondition(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function deferredRunResult(name: string) {
  let resolveResult!: () => void
  const promise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveResult = () => resolvePromise({
      name,
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })
  })
  return { promise, resolve: resolveResult }
}

async function createTempSuiteWorkspace() {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-suite-'))
  tempDirs.push(rootDir)
  const testsDir = join(rootDir, 'tests')
  await mkdir(testsDir, { recursive: true })
  const suitePath = join(rootDir, 'smoke.suite.yaml')
  const testPath = join(testsDir, 'login.yaml')
  const configPath = join(rootDir, 'agent-qa.config.yaml')
  await writeFile(suitePath, 'name: Smoke Suite\n')
  await writeFile(testPath, 'name: Login Test\n')
  return { rootDir, suitePath, testPath, configPath }
}

async function createMultiSuiteWorkspace() {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-multi-suite-'))
  tempDirs.push(rootDir)
  const suitesDir = join(rootDir, 'suites')
  const testsDir = join(rootDir, 'tests')
  await mkdir(suitesDir, { recursive: true })
  await mkdir(testsDir, { recursive: true })
  const configPath = join(rootDir, 'agent-qa.config.yaml')
  const suiteA = join(suitesDir, 'a.suite.yaml')
  const suiteB = join(suitesDir, 'b.suite.yaml')
  const suiteC = join(suitesDir, 'c.suite.yaml')
  await writeFile(configPath, 'workspace:\n  testMatch: ["tests/**/*.yaml"]\n  suiteMatch: ["suites/**/*.suite.yaml"]\n')
  await writeFile(join(testsDir, 'a.yaml'), 'name: A\n')
  await writeFile(join(testsDir, 'b.yaml'), 'name: B\n')
  await writeFile(join(testsDir, 'c.yaml'), 'name: C\n')
  await writeFile(suiteA, 'name: Suite A\n')
  await writeFile(suiteB, 'name: Suite B\n')
  await writeFile(suiteC, 'name: Suite C\n')
  return { rootDir, configPath, suiteA, suiteB, suiteC }
}

function suiteDefinition(name: string, testFile: string, use?: Record<string, unknown>) {
  return {
    name,
    target: 'test-app',
    ...(use ? { use } : {}),
    tests: [{ test: `tests/${testFile}`, id: `${name.toLowerCase().replace(/\s+/g, '-')}-test` }],
  }
}

function deferredSuiteResult(name: string) {
  let resolveResult!: () => void
  const promise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveResult = () => resolvePromise({
      name,
      status: 'passed',
      tests: [],
      duration: 100,
    })
  })
  return { promise, resolve: resolveResult }
}

describe('run command — secrets file preflight', () => {
  it('exits 2 when workspace.secretsFile is missing from config', async () => {
    const cfg = defaultConfig()
    delete (cfg.workspace as any).secretsFile
    mockResolveConfig.mockResolvedValue(cfg)

    await runCommand('--dry-run', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockGlob).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('workspace.secretsFile is required')
  })

  it('exits 1 when the configured secrets file is missing', async () => {
    const cfg = defaultConfig()
    cfg.workspace.secretsFile = join(tmpdir(), 'agent-qa-missing-secrets.local')
    mockResolveConfig.mockResolvedValue(cfg)

    await runCommand('--dry-run', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockGlob).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Secrets file not found')
  })

  it('loads secrets into runtime config without adding secret values to artifact metadata', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-run-secret-load-'))
    tempDirs.push(rootDir)
    const secretsPath = join(rootDir, '.secrets.local')
    await writeFile(secretsPath, 'LOGIN_PASSWORD=super-secret\n')
    const cfg = defaultConfig()
    cfg.workspace.secretsFile = secretsPath
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunTestWithRetry.mock.calls[0][1]
    expect(runConfig.secretStore.require('LOGIN_PASSWORD')).toBe('super-secret')
    expect(runConfig.secretRedactor).toBeDefined()
    expect(runConfig.secretsFileMetadata).toEqual({
      path: secretsPath,
      status: 'loaded',
      count: 1,
    })
    const reporterContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(JSON.stringify(reporterContext.artifact.config.secretsFile)).not.toContain('super-secret')
  })
})

describe('run command — glob expansion', () => {
  it('calls parseAllTests with expanded file paths', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml', 'tests/b.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommand('--dry-run', 'tests/**/*.yaml')

    expect(mockGlob).toHaveBeenCalledWith('tests/**/*.yaml', expect.objectContaining({ ignore: [] }))
    expect(mockParseAllTests).toHaveBeenCalledWith(['tests/a.yaml', 'tests/b.yaml'])
  })

  it('exits 2 when no files match glob', async () => {
    mockGlob.mockResolvedValue([])

    await runCommand('nonexistent/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No test files found'))
  })
})


describe('run command — reduced flag surface and target resolution', () => {
  it('rejects removed --app as an unknown option', async () => {
    await runCommand('--app', 'staging', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--app'"))
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })

  it('rejects removed --env as an unknown option', async () => {
    await runCommand('--env', 'staging', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--env'"))
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })

  it('rejects removed --env-file as an unknown option', async () => {
    await runCommand('--env-file', '.env.local', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--env-file'"))
    expect(mockResolveConfig).not.toHaveBeenCalled()
  })

  it('does not show removed run flags in help', () => {
    const help = createRunCommand().helpInformation()

    expect(help).not.toContain('--app')
    expect(help).not.toContain('--env ')
    expect(help).not.toContain('--env-file')
  })

  it('classifies removed run flags as Commander unknown options', async () => {
    await expect(parseRemovedRunFlag('--app', 'staging')).rejects.toMatchObject({ code: 'commander.unknownOption' })
    await expect(parseRemovedRunFlag('--env', 'staging')).rejects.toMatchObject({ code: 'commander.unknownOption' })
    await expect(parseRemovedRunFlag('--env-file', '.env.local')).rejects.toMatchObject({ code: 'commander.unknownOption' })
  })

  it('resolves target: from test YAML via resolveTarget', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    const testWithTarget = makeTest({ target: 'myapp' })
    mockParseAllTests.mockResolvedValue({
      tests: [testWithTarget],
      errors: [],
    })
    mockResolveTarget.mockReturnValue({
      name: 'myapp',
      product: 'myapp',
      platform: 'web',
      url: 'https://myapp.example.com',
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockResolveTarget).toHaveBeenCalledWith(
      expect.anything(),
      'myapp',
    )
    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://myapp.example.com' }),
      expect.anything(),
      expect.anything(),
    )
  })
})

describe('run command — mobile app state and device resolution', () => {
  function mobileConfig() {
    const cfg = defaultConfig()
    cfg.registry.targets = {
      'mobile-app': {
        platform: 'android',
        appPackage: 'com.example.app',
        product: 'mobile-app',
      },
    } as any
    ;(cfg.registry as any).devices = {
      'android-emu': {
        platform: 'android',
        transport: 'local',
        match: { automationName: 'UiAutomator2' },
      },
    }
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    return cfg
  }

  function mockMobileTarget() {
    mockResolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform: 'android',
      appPackage: 'com.example.app',
    })
  }

  it('passes direct mobile test device and global app state into the resolver', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app', use: { device: 'android-emu' } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/mobile.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(resolveMobileRunConfig).toHaveBeenCalledWith(expect.objectContaining({
      targetName: 'mobile-app',
      platform: 'android',
      explicitDeviceName: undefined,
      useDeviceName: 'android-emu',
      appState: 'preserve',
    }))
    const resolverInput = vi.mocked(resolveMobileRunConfig).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(resolverInput).not.toHaveProperty('targetDefaultDeviceName')
    expect(resolverInput).not.toHaveProperty('configDefaultDeviceName')
  })

  it('passes direct mobile test app-state override into the resolver', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({
        target: 'mobile-app',
        use: { device: 'android-emu', mobile: { appState: 'reset' } },
      })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/mobile.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(resolveMobileRunConfig).toHaveBeenCalledWith(expect.objectContaining({
      useDeviceName: 'android-emu',
      appState: 'reset',
    }))
  })

  it('fails direct mobile tests without use.device or --device', async () => {
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app' })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('No device specified for mobile target "mobile-app"')
  })

  it('does not call the mobile resolver for web direct tests without use.device', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const cfg = defaultConfig()
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(resolveMobileRunConfig).not.toHaveBeenCalled()
    expect(mockRunTestWithRetry).toHaveBeenCalled()
  })

  it('uses suite-level use.device for mobile suites', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Mobile Suite',
      target: 'mobile-app',
      use: { device: 'android-emu' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ target: 'mobile-app' })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(resolveMobileRunConfig).toHaveBeenCalledWith(expect.objectContaining({
      useDeviceName: 'android-emu',
      appState: 'preserve',
    }))
  })

  it('accepts one shared child use.device for mobile suites without suite use.device', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Mobile Suite',
      target: 'mobile-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ target: 'mobile-app', use: { device: 'android-emu' } })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(resolveMobileRunConfig).toHaveBeenCalledWith(expect.objectContaining({
      useDeviceName: 'android-emu',
    }))
  })

  it('fails mobile suites with no suite or child device', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Mobile Suite',
      target: 'mobile-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ target: 'mobile-app' })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Select a device for this mobile suite')
  })

  it('fails mobile suites whose child tests use multiple devices', async () => {
    const { rootDir, suitePath, configPath } = await createTempSuiteWorkspace()
    await writeFile(join(rootDir, 'tests', 'a.yaml'), 'name: A\n')
    await writeFile(join(rootDir, 'tests', 'b.yaml'), 'name: B\n')
    mockResolveConfig.mockResolvedValue(mobileConfig())
    mockMobileTarget()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Mobile Suite',
      target: 'mobile-app',
      tests: [
        { test: 'tests/a.yaml', id: 'suite-test-1' },
        { test: 'tests/b.yaml', id: 'suite-test-2' },
      ],
    })
    mockParseTestFile.mockImplementation((_content: string, file: string) => ({
      tests: [
        makeTest({
          name: file.includes('b.yaml') ? 'Test Two' : 'Test One',
          target: 'mobile-app',
          use: { device: file.includes('b.yaml') ? 'ios-sim' : 'android-emu' },
        }),
      ],
      errors: [],
    }))

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Mobile suite child tests use multiple devices')
    expect(allErrors).toContain('set suite use.device or split the suite')
  })

  it('runs web suites without device settings', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    const cfg = defaultConfig()
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'test-app',
      product: 'test-app',
      platform: 'web',
      url: 'https://example.com',
    })
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(resolveMobileRunConfig).not.toHaveBeenCalled()
    expect(mockRunSuite).toHaveBeenCalled()
  })
})

describe('run command — dry run', () => {
  it('lists tests without executing when --dry-run is set', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest(), makeTest2()],
      errors: [],
    })

    await runCommand('--dry-run', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Test One')
    expect(allOutput).toContain('Test Two')
  })
})

describe('run command — run attributes', () => {
  it('stores user attributes in the run artifact context and output block', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--run-attr', 'git.branch=phase223-main', 'user.email=CI')

    const startContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(startContext.artifact.metadata.attributes).toMatchObject({
      'agent-qa.trigger': 'cli',
      'agent-qa.runner': 'local',
      'git.branch': 'phase223-main',
      'user.email': 'CI',
    })
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Run attributes:')
    expect(allOutput).toContain('git.branch=phase223-main')
    expect(allOutput).toContain('user.email=CI')
  })

  it('warns on duplicate --run-attr keys and uses the last value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--run-attr', 'git.branch=dev', '--run-attr', 'git.branch=phase223-main')

    expect(warnSpy).toHaveBeenCalledWith('Warning: duplicate --run-attr key "git.branch"; using last value')
    const startContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(startContext.artifact.metadata.attributes['git.branch']).toBe('phase223-main')
    warnSpy.mockRestore()
  })

  it('rejects protected agent-qa.* attribute keys before execution', async () => {
    await runCommand('tests/**/*.yaml', '--run-attr', 'agent-qa.trigger=evil')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('reserved prefix "agent-qa."')
  })

  it('rejects invalid inherited protected run attributes before execution', async () => {
    process.env.AGENT_QA_RUN_ID = 'r_dashboard-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'agent-qa.custom': 'evil',
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('inherited run attributes')
    expect(allErrors).toContain('agent-qa.custom')
    expect(allErrors).toContain('reserved prefix "agent-qa."')
  })

  it('inherits retry-child attributes from AGENT_QA_PARENT_RUN_ID without a child run id', async () => {
    process.env.AGENT_QA_PARENT_RUN_ID = 'r_parent-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'git.branch': 'phase247-review',
    })
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const startContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(startContext.artifact.metadata.attributes).toMatchObject({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'git.branch': 'phase247-review',
    })
  })

  it('recomputes inherited runner attributes after direct BrowserStack device resolution', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const cfg = defaultConfig()
    cfg.registry.targets = {
      'mobile-browser': {
        platform: 'android',
        product: 'mobile-browser',
        url: 'https://example.com',
      },
    } as any
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'mobile-browser',
      product: 'mobile-browser',
      platform: 'android',
      url: 'https://example.com',
    })
    vi.mocked(resolveMobileRunConfig).mockImplementationOnce((input: any) => ({
      deviceName: 'cloud-phone',
      platform: 'android',
      targetName: input.targetName,
      transport: 'browserstack',
      device: {
        name: 'cloud-phone',
        platform: 'android',
        transport: 'browserstack',
        match: { browserName: 'chrome' },
      },
      app: { sourceTrace: {} },
      appState: input.appState,
      appium: { url: input.appiumUrl },
      sourceTrace: [],
    }))
    process.env.BROWSERSTACK_USERNAME = 'user'
    process.env.BROWSERSTACK_ACCESS_KEY = 'key'
    process.env.AGENT_QA_RUN_ID = 'r_dashboard-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'git.branch': 'phase247-review',
    })
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-browser', use: { device: 'cloud-phone' } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/mobile.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const startContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(startContext.artifact.metadata.attributes).toMatchObject({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'browserstack',
      'git.branch': 'phase247-review',
    })
  })

  it('recomputes inherited runner attributes after suite BrowserStack device resolution', async () => {
    const { resolveMobileRunConfig } = await import('@vostride/agent-qa-core')
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    const cfg = defaultConfig()
    cfg.registry.targets = {
      'mobile-browser': {
        platform: 'android',
        product: 'mobile-browser',
        url: 'https://example.com',
      },
    } as any
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'mobile-browser',
      product: 'mobile-browser',
      platform: 'android',
      url: 'https://example.com',
    })
    vi.mocked(resolveMobileRunConfig).mockImplementationOnce((input: any) => ({
      deviceName: 'cloud-phone',
      platform: 'android',
      targetName: input.targetName,
      transport: 'browserstack',
      device: {
        name: 'cloud-phone',
        platform: 'android',
        transport: 'browserstack',
        match: { browserName: 'chrome' },
      },
      app: { sourceTrace: {} },
      appState: input.appState,
      appium: { url: input.appiumUrl },
      sourceTrace: [],
    }))
    process.env.BROWSERSTACK_USERNAME = 'user'
    process.env.BROWSERSTACK_ACCESS_KEY = 'key'
    process.env.AGENT_QA_SUITE_QUEUE_ID = 'r_suite-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'api',
      'agent-qa.runner': 'local',
      'git.branch': 'phase247-review',
    })
    mockParseSuiteFile.mockResolvedValue({
      name: 'Mobile Cloud Suite',
      target: 'mobile-browser',
      use: { device: 'cloud-phone' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ target: 'mobile-browser' })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    const suiteConfig = mockRunSuite.mock.calls[0][2] as Record<string, any>
    expect(suiteConfig.artifactContext.metadata.attributes).toMatchObject({
      'agent-qa.trigger': 'api',
      'agent-qa.runner': 'browserstack',
      'git.branch': 'phase247-review',
    })
  })

  it('rejects malformed --run-attr values before execution', async () => {
    await runCommand('tests/**/*.yaml', '--run-attr', 'noEquals')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('KEY=VALUE')
  })
})

describe('run command — exit codes', () => {
  it('exits 0 when all tests pass', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('exits 1 when any test fails', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('exits 2 on parse errors', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [],
      errors: [{
        file: 'tests/a.yaml',
        line: 3,
        column: 5,
        message: 'Invalid syntax',
        severity: 'error',
        source: '  invalid:',
      }],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Run ID: r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet')
  })

  it('exits 2 when no files match glob', async () => {
    mockGlob.mockResolvedValue([])

    await runCommand('nothing/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})


describe('run command — bail mode', () => {
  it('stops execution after first failure with --bail', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    const test1 = makeTest({ name: 'Failing Test' })
    const test2 = makeTest2({ name: 'Skipped Test' })
    mockParseAllTests.mockResolvedValue({
      tests: [test1, test2],
      errors: [],
    })

    let callCount = 0
    mockRunTestWithRetry.mockImplementation(async () => {
      callCount++
      return {
        name: callCount === 1 ? 'Failing Test' : 'Skipped Test',
        filePath: 'tests/a.yaml',
        status: 'failed',
        steps: [],
        duration: 100,
      }
    })

    await runCommand('--bail', 'tests/**/*.yaml')

    expect(mockRunTestWithRetry).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Bailing out')
  })
})

describe('run command — framework error handling', () => {
  it('exits 2 on config resolution failure', async () => {
    mockResolveConfig.mockRejectedValue(new Error('Invalid config: missing fields'))

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Framework error')
  })

  it('prints agent-qa browser install guidance instead of raw Playwright missing-browser output', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockWebAdapterSetup.mockRejectedValueOnce(new Error([
      "browserType.launch: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/webkit-2272/pw_run.sh",
      'Looks like Playwright was just installed or updated.',
      'Please run the following command to download new browsers:',
      'npx playwright install',
    ].join('\n')))

    await runCommand('--browser', 'webkit', 'tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('agent-qa browser support is not installed for WebKit')
    expect(allErrors).toContain('agent-qa install-browsers --webkit')
    expect(allErrors).not.toContain('npx playwright install')
    expect(allErrors).not.toContain('Looks like Playwright was just installed')
  })

  it('prints run IDs for running rows finalized during framework crash cleanup', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    const runningRun = {
      id: 'r_crash-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india',
      name: 'Crash Run',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
    const crashDb = {
      getRuns: vi.fn(() => [runningRun]),
      updateRun: vi.fn(),
      getRunArtifact: vi.fn(() => ({ finalizedAt: null })),
      finalizeRunArtifact: vi.fn(),
      close: vi.fn(),
    }
    mockDashboardDatabase.mockImplementationOnce(function () { return crashDb })
    mockWebAdapterSetup.mockRejectedValueOnce(new Error('browser crashed'))

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(crashDb.updateRun).toHaveBeenCalledWith(
      runningRun.id,
      expect.objectContaining({ status: 'failed' }),
    )
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain(`Run ID: ${runningRun.id}`)
  })
})

describe('run command — reporter integration', () => {
  it('adds the analytics reporter to actual direct test execution and flushes after completion', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockCreateAnalyticsRunReporter).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ workspace: expect.any(Object) }),
      surface: 'cli',
    }))
    const { MultiReporter } = await import('@vostride/agent-qa-core')
    expect(vi.mocked(MultiReporter).mock.calls[0][0]).toEqual(
      expect.arrayContaining([mockAnalyticsRunReporterInstance]),
    )
    expect(mockAnalyticsRunReporterInstance.flush).toHaveBeenCalled()
  })

  it('adds the analytics reporter to actual suite execution and flushes after completion', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Smoke Suite',
      target: 'test-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockCreateAnalyticsRunReporter).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ workspace: expect.any(Object) }),
      surface: 'cli',
    }))
    expect(mockRunSuite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        reporters: expect.arrayContaining([mockAnalyticsRunReporterInstance]),
      }),
    )
    expect(mockAnalyticsRunReporterInstance.flush).toHaveBeenCalled()
  })

  it('does not create analytics reporter for dry run, list, or validation-only paths', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommand('--dry-run', 'tests/**/*.yaml')
    await runCommand('--list-tests')

    mockParseAllTests.mockResolvedValue({
      tests: [],
      errors: [{
        file: 'tests/a.yaml',
        line: 1,
        column: 1,
        message: 'Invalid',
        severity: 'error',
      }],
    })
    await runCommand('tests/**/*.yaml')

    expect(mockCreateAnalyticsRunReporter).not.toHaveBeenCalled()
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
  })

  it('does not fail direct test execution when analytics flush rejects', async () => {
    mockAnalyticsRunReporterInstance.flush.mockRejectedValueOnce(new Error('posthog unavailable'))
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockAnalyticsRunReporterInstance.flush).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it.each(['android', 'ios'] as const)('emits best-effort analytics for dashboard-triggered %s setup failures', async (platform) => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db' } as any
    cfg.registry.targets = {
      'mobile-app': {
        platform,
        product: 'mobile-app',
        ...(platform === 'android'
          ? { appPackage: 'com.example.app' }
          : { bundleId: 'com.example.app' }),
      },
    } as any
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform,
      ...(platform === 'android'
        ? { appPackage: 'com.example.app' }
        : { bundleId: 'com.example.app' }),
    })
    process.env.AGENT_QA_RUN_ID = 'r_dashboard-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel'
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
    })
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app', use: { device: 'mobile-device' } })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockAnalyticsRunReporterInstance.onRunEnd).toHaveBeenCalledWith(expect.objectContaining({
      failed: 1,
      results: [
        expect.objectContaining({
          runId: process.env.AGENT_QA_RUN_ID,
          status: 'failed',
          metadata: expect.objectContaining({
            phase: 'setup',
            platform,
            attributes: expect.objectContaining({
              'agent-qa.trigger': 'dashboard',
              'agent-qa.runner': 'local',
            }),
            runtime: expect.objectContaining({
              platform,
              mobileTransport: 'local',
              appState: 'preserve',
            }),
          }),
        }),
      ],
    }))
    expect(mockAnalyticsRunReporterInstance.flush).toHaveBeenCalled()
  })

  it.each(['android', 'ios'] as const)('emits cli/local analytics attributes for standalone %s setup failures', async (platform) => {
    const cfg = defaultConfig()
    cfg.registry.targets = {
      'mobile-app': {
        platform,
        product: 'mobile-app',
        ...(platform === 'android'
          ? { appPackage: 'com.example.app' }
          : { bundleId: 'com.example.app' }),
      },
    } as any
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform,
      ...(platform === 'android'
        ? { appPackage: 'com.example.app' }
        : { bundleId: 'com.example.app' }),
    })
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app' })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockAnalyticsRunReporterInstance.onRunEnd).toHaveBeenCalledWith(expect.objectContaining({
      failed: 1,
      results: [
        expect.objectContaining({
          runId: 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet',
          status: 'failed',
          metadata: expect.objectContaining({
            phase: 'setup',
            platform,
            attributes: expect.objectContaining({
              'agent-qa.trigger': 'cli',
              'agent-qa.runner': 'local',
            }),
          }),
        }),
      ],
    }))
    expect(mockAnalyticsRunReporterInstance.flush).toHaveBeenCalled()
  })

  it('creates ConsoleReporter with verbose=false by default', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const { ConsoleReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).toHaveBeenCalledWith(expect.objectContaining({ verbose: false }))
  })

  it('ConsoleReporter always gets verbose=false (LogManager handles verbose display)', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    const program = new Command()
    program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
    program.option('--log-level <level>', 'log verbosity: silent|error|warn|info|debug')
    program.option('--verbose', 'shorthand for --log-level debug')
    program.option('--quiet', 'shorthand for --log-level silent')
    program.addCommand(createRunCommand())

    try {
      await program.parseAsync(['node', 'agent-qa', '--verbose', 'run', 'tests/**/*.yaml'])
    } catch (err) {
      if ((err as Error).message !== 'process.exit') throw err
    }

    const { ConsoleReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).toHaveBeenCalledWith(expect.objectContaining({ verbose: false }))
  })

  it('creates JUnitReporter when --junit-output is specified', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('--junit-output', 'test-results.xml', 'tests/**/*.yaml')

    const { JUnitReporter } = await import('@vostride/agent-qa-core')
    expect(JUnitReporter).toHaveBeenCalledWith({ outputPath: 'test-results.xml' })
  })

  it('supports explicit console-only reporter selection', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--reporter', 'console')

    const { ConsoleReporter, JUnitReporter, StdoutLiveReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).toHaveBeenCalled()
    expect(JUnitReporter).not.toHaveBeenCalled()
    expect(StdoutLiveReporter).not.toHaveBeenCalled()
    expect(mockDashboardReporter).not.toHaveBeenCalled()
  })

  it('supports explicit console and junit reporter selection', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--reporter', 'console,junit', '--junit-output', 'test-results.xml')

    const { ConsoleReporter, JUnitReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).toHaveBeenCalled()
    expect(JUnitReporter).toHaveBeenCalledWith({ outputPath: 'test-results.xml' })
  })

  it('supports explicit stdout-live reporter selection without env opt-in', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--reporter', 'stdout-live')

    const { ConsoleReporter, StdoutLiveReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).not.toHaveBeenCalled()
    expect(StdoutLiveReporter).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      redactor: expect.anything(),
    }))
  })

  it('supports explicit dashboard reporter selection', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--reporter', 'dashboard')

    const { ConsoleReporter } = await import('@vostride/agent-qa-core')
    expect(ConsoleReporter).not.toHaveBeenCalled()
    expect(mockDashboardDatabase).toHaveBeenCalled()
    expect(mockDashboardReporter).toHaveBeenCalled()
  })

  it('fails unknown reporter selection before execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])

    await runCommand('tests/**/*.yaml', '--reporter', 'unknown')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Unknown reporter "unknown"')
  })

  it('fails junit reporter selection without output path before execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])

    await runCommand('tests/**/*.yaml', '--reporter', 'junit')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('--reporter junit requires --junit-output <path>')
  })

  it('treats screenshotDir as capture intent for runTestWithRetry config', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('--screenshot-dir', './shots', 'tests/**/*.yaml')

    const runConfig = mockRunTestWithRetry.mock.calls[0][1]
    expect(runConfig).toEqual(expect.objectContaining({ captureScreenshots: true }))
    expect(runConfig).not.toHaveProperty('screenshotDir')
  })

  it('calls onRunStart before test execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockMultiReporterInstance.onRunStart).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'Test One' })]),
    )
  })

  it('calls onRunEnd after all tests complete', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: expect.any(Array),
        duration: expect.any(Number),
        passed: 1,
        failed: 0,
        skipped: 0,
      }),
    )
  })

  it('uses one generated run ID from reporter start through passing result summary', async () => {
    const runId = 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
    mockGenerateRunId.mockReturnValueOnce(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockMultiReporterInstance.onTestStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test One' }),
      'tests/a.yaml',
      expect.objectContaining({ runId }),
    )
    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId }),
      'tests/a.yaml',
    )
    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ status: 'passed', runId })],
      }),
    )
  })

  it('preserves one generated run ID from reporter start through failed result summary', async () => {
    const runId = 'r_harbor-iris-jade-kilo-lima-maple-nova-orbit-pearl-quartz'
    mockGenerateRunId.mockReturnValueOnce(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockMultiReporterInstance.onTestStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test One' }),
      'tests/a.yaml',
      expect.objectContaining({ runId }),
    )
    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId }),
      'tests/a.yaml',
    )
    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ status: 'failed', runId })],
      }),
    )
  })

  it('reuses queued AGENT_QA_RUN_ID for single-test reporter context and result summary', async () => {
    const runId = 'r_queue-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    process.env.AGENT_QA_RUN_ID = runId
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockGenerateRunId).not.toHaveBeenCalled()
    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId }),
      'tests/a.yaml',
    )
    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ runId })],
      }),
    )
  })

  it('adds run ID to cancelled results before final summary', async () => {
    const runId = 'r_cancel-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    mockGenerateRunId.mockReturnValueOnce(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'cancelled',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ status: 'cancelled', runId })],
      }),
    )
  })

  it('passes run ID through setup hook failure result before execution', async () => {
    const runId = 'r_setup-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india'
    mockGenerateRunId.mockReturnValueOnce(runId)
    const { rootDir, testPath, configPath } = await createTempSuiteWorkspace()
    await writeFile(join(rootDir, 'hooks.yaml'), 'hooks:\n  - id: hook-seed\n')
    mockGlob.mockResolvedValue([testPath])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ setup: ['hook-seed'] })],
      errors: [],
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{ id: 'hook-seed', name: 'seed data', command: 'false' }],
      errors: [],
    })
    mockRunHooks.mockResolvedValue({
      allPassed: false,
      variables: {},
      results: new Map([['seed data', {
        success: false,
        duration: 10,
        stdout: '',
        stderr: 'setup failed',
        variables: {},
        error: 'setup failed',
      }]]),
    })

    await runCommandWithGlobalArgs(['--config', configPath], testPath)

    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    expect(mockMultiReporterInstance.onTestEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        runId,
        failureSummary: expect.stringContaining('Setup hook'),
      }),
    )
    expect(mockMultiReporterInstance.onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        results: [expect.objectContaining({ runId })],
      }),
    )
  })

  it('does not pass a default screenshotDir when not specified', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunTestWithRetry.mock.calls[0][1]
    expect(runConfig).toEqual(expect.objectContaining({ captureScreenshots: false }))
    expect(runConfig).not.toHaveProperty('screenshotDir')
  })

  it('lets test-level browser.headless false override global true', async () => {
    const cfg = defaultConfig()
    ;(cfg.use as any).browser = { name: 'chromium', headless: true }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { browser: { headless: false } } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup).toHaveBeenCalledWith(expect.objectContaining({
      browser: expect.objectContaining({
        headless: false,
      }),
    }))
  })

  it('lets --headless override test-level browser.headless false', async () => {
    const cfg = defaultConfig()
    ;(cfg.use as any).browser = { name: 'chromium', headless: true }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { browser: { headless: false } } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('--headless', 'tests/**/*.yaml')

    expect(mockWebAdapterSetup).toHaveBeenCalledWith(expect.objectContaining({
      browser: expect.objectContaining({
        headless: true,
      }),
    }))
  })

  it('starts two web tests concurrently when global use.parallel is true', async () => {
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = true
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml', 'tests/b.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest(), makeTest2()],
      errors: [],
    })
    const first = deferredRunResult('Test One')
    const second = deferredRunResult('Test Two')
    const started: string[] = []
    mockRunTestWithRetry.mockImplementation((test: any) => {
      started.push(test.name)
      return test.name === 'Test One' ? first.promise : second.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await waitForCondition(() => started.length >= 2)
    expect(started).toHaveLength(2)
    expect(started).toEqual(expect.arrayContaining(['Test One', 'Test Two']))

    first.resolve()
    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('runs web tests sequentially when global use.parallel is false', async () => {
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = false
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml', 'tests/b.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest(), makeTest2()],
      errors: [],
    })
    const first = deferredRunResult('Test One')
    const second = deferredRunResult('Test Two')
    const started: string[] = []
    mockRunTestWithRetry.mockImplementation((test: any) => {
      started.push(test.name)
      return test.name === 'Test One' ? first.promise : second.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await waitForCondition(() => started.length >= 1)

    expect(started).toEqual(['Test One'])

    first.resolve()
    await waitForCondition(() => started.length >= 2)
    expect(started).toEqual(['Test One', 'Test Two'])

    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('treats test-level use.parallel false as a sequential barrier', async () => {
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = true
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml', 'tests/b.yaml', 'tests/c.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [
        makeTest(),
        makeTest2({ use: { parallel: false } }),
        makeTest({ name: 'Test Three' }),
      ],
      errors: [],
    })
    const runs = new Map([
      ['Test One', deferredRunResult('Test One')],
      ['Test Two', deferredRunResult('Test Two')],
      ['Test Three', deferredRunResult('Test Three')],
    ])
    const started: string[] = []
    mockRunTestWithRetry.mockImplementation((test: any) => {
      started.push(test.name)
      return runs.get(test.name)!.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await waitForCondition(() => started.length >= 1)
    expect(started).toEqual(['Test One'])

    runs.get('Test One')!.resolve()
    await waitForCondition(() => started.length >= 2)
    expect(started).toEqual(['Test One', 'Test Two'])

    runs.get('Test Two')!.resolve()
    await waitForCondition(() => started.length >= 3)
    expect(started).toEqual(['Test One', 'Test Two', 'Test Three'])

    runs.get('Test Three')!.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('starts two web suite parents concurrently when global use.parallel is true', async () => {
    const { configPath, suiteA, suiteB } = await createMultiSuiteWorkspace()
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = true
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue([suiteA, suiteB])
    mockParseSuiteFile.mockImplementation(async (file: string) =>
      file === suiteA
        ? suiteDefinition('Suite A', 'a.yaml')
        : suiteDefinition('Suite B', 'b.yaml'),
    )
    mockParseTestFile.mockReturnValue({ tests: [makeTest()], errors: [] })
    const first = deferredSuiteResult('Suite A')
    const second = deferredSuiteResult('Suite B')
    const started: string[] = []
    mockRunSuite.mockImplementation((suite: any) => {
      started.push(suite.name)
      return suite.name === 'Suite A' ? first.promise : second.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    await waitForCondition(() => started.length >= 2)
    expect(started).toHaveLength(2)
    expect(started).toEqual(expect.arrayContaining(['Suite A', 'Suite B']))

    first.resolve()
    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('runs web suite parents sequentially when global use.parallel is false', async () => {
    const { configPath, suiteA, suiteB } = await createMultiSuiteWorkspace()
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = false
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue([suiteA, suiteB])
    mockParseSuiteFile.mockImplementation(async (file: string) =>
      file === suiteA
        ? suiteDefinition('Suite A', 'a.yaml')
        : suiteDefinition('Suite B', 'b.yaml'),
    )
    mockParseTestFile.mockReturnValue({ tests: [makeTest()], errors: [] })
    const first = deferredSuiteResult('Suite A')
    const second = deferredSuiteResult('Suite B')
    const started: string[] = []
    mockRunSuite.mockImplementation((suite: any) => {
      started.push(suite.name)
      return suite.name === 'Suite A' ? first.promise : second.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    await waitForCondition(() => started.length >= 1)
    expect(started).toEqual(['Suite A'])

    first.resolve()
    await waitForCondition(() => started.length >= 2)
    expect(started).toEqual(['Suite A', 'Suite B'])

    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('treats suite-level use.parallel false as a suite parent barrier', async () => {
    const { configPath, suiteA, suiteB, suiteC } = await createMultiSuiteWorkspace()
    const cfg = defaultConfig()
    ;(cfg.use as any).parallel = true
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue([suiteA, suiteB, suiteC])
    mockParseSuiteFile.mockImplementation(async (file: string) => {
      if (file === suiteA) return suiteDefinition('Suite A', 'a.yaml')
      if (file === suiteB) return suiteDefinition('Suite B', 'b.yaml', { parallel: false })
      return suiteDefinition('Suite C', 'c.yaml')
    })
    mockParseTestFile.mockReturnValue({ tests: [makeTest()], errors: [] })
    const runs = new Map([
      ['Suite A', deferredSuiteResult('Suite A')],
      ['Suite B', deferredSuiteResult('Suite B')],
      ['Suite C', deferredSuiteResult('Suite C')],
    ])
    const started: string[] = []
    mockRunSuite.mockImplementation((suite: any) => {
      started.push(suite.name)
      return runs.get(suite.name)!.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    await waitForCondition(() => started.length >= 1)
    expect(started).toEqual(['Suite A'])

    runs.get('Suite A')!.resolve()
    await waitForCondition(() => started.length >= 2)
    expect(started).toEqual(['Suite A', 'Suite B'])

    runs.get('Suite B')!.resolve()
    await waitForCondition(() => started.length >= 3)
    expect(started).toEqual(['Suite A', 'Suite B', 'Suite C'])

    runs.get('Suite C')!.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe('run command — DashboardReporter wiring', () => {
  it('creates DashboardReporter when services.dashboard is present', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = {} as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockDashboardDatabase).toHaveBeenCalled()
    expect(mockResolveDashboardDbPath).toHaveBeenCalledWith({
      configDir: process.cwd(),
      configuredDbPath: undefined,
    })
    expect(mockDashboardDatabase).toHaveBeenCalledWith({
      dbPath: resolve(process.cwd(), '.agent-qa/runs.db'),
    })
    expect(mockDashboardReporter).toHaveBeenCalled()
    expect(mockRunTestWithRetry.mock.calls[0][1]).toEqual(expect.objectContaining({
      captureScreenshots: true,
    }))
  })

  it('honors an explicit dashboard dbPath override', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/dashboard.db' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockResolveDashboardDbPath).toHaveBeenCalledWith({
      configDir: process.cwd(),
      configuredDbPath: '.agent-qa/dashboard.db',
    })
    expect(mockDashboardDatabase).toHaveBeenCalledWith({
      dbPath: resolve(process.cwd(), '.agent-qa/dashboard.db'),
    })
  })

  it('migrates legacy default dashboard.db to runs.db through the resolver', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-db-migration-'))
    tempDirs.push(projectDir)
    const configPath = join(projectDir, 'agent-qa.config.yaml')
    writeFileSync(configPath, 'services:\n  dashboard: {}\n')
    mkdirSync(join(projectDir, '.agent-qa'), { recursive: true })
    writeFileSync(join(projectDir, '.agent-qa', 'dashboard.db'), 'legacy-runs')

    const cfg = defaultConfig()
    cfg.services.dashboard = {} as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', configPath], 'tests/**/*.yaml')

    expect(existsSync(join(projectDir, '.agent-qa', 'dashboard.db'))).toBe(false)
    expect(existsSync(join(projectDir, '.agent-qa', 'runs.db'))).toBe(true)
    expect(mockDashboardDatabase).toHaveBeenCalledWith({
      dbPath: join(projectDir, '.agent-qa', 'runs.db'),
    })
  })

  it('does not create DashboardReporter when services.dashboard is absent', async () => {
    const cfg = defaultConfig()
    delete (cfg.services as any).dashboard
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockDashboardDatabase).not.toHaveBeenCalled()
    expect(mockDashboardReporter).not.toHaveBeenCalled()
  })

  it('warns but continues when dashboard-server import fails', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { ...cfg.services.dashboard } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockDashboardDatabase.mockImplementation(() => {
      throw new Error('native bindings not found')
    })
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runCommand('tests/**/*.yaml')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Could not load dashboard reporter'))
    warnSpy.mockRestore()
  })
})

describe('run command — dashboard video recording root', () => {
  it('uses .agent-qa/artifacts/videos for standalone recording by default', async () => {
    const cfg = defaultConfig()
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        recording: expect.objectContaining({
          videoDir: resolve(process.cwd(), '.agent-qa/artifacts/videos'),
        }),
      }),
    )
  })

  it('uses artifactsDir/videos for suite recording in dashboard mode', async () => {
    const { rootDir, suitePath, configPath } = await createTempSuiteWorkspace()
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db', artifactsDir: 'dashboard-artifacts' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockParseSuiteFile.mockResolvedValue({
      name: 'Smoke Suite',
      target: 'test-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], '--record', suitePath)

    expect(mockRunSuite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        platformConfig: expect.objectContaining({
          recording: expect.objectContaining({
            videoDir: resolve(rootDir, 'dashboard-artifacts', 'videos'),
          }),
        }),
      }),
    )
  })

  it('uses artifactsDir/videos for adapter setup when standalone recording is enabled', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db', artifactsDir: 'dashboard-artifacts' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        recording: expect.objectContaining({
          videoDir: resolve(process.cwd(), 'dashboard-artifacts', 'videos'),
        }),
      }),
    )
  })

  it('uses artifactsDir/videos for per-test recording overrides in dashboard mode', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db', artifactsDir: 'dashboard-artifacts' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recording: expect.objectContaining({
          videoDir: resolve(process.cwd(), 'dashboard-artifacts', 'videos'),
        }),
      }),
      expect.anything(),
    )
  })
})

describe('run command — runtime memory override', () => {
  it('does not initialize runtime memory when --no-memory is passed', async () => {
    const cfg = defaultConfig()
    ;(cfg.services as any).memory = { enabled: true, provider: 'local' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('--no-memory', 'tests/**/*.yaml')

    expect(mockRunTestWithRetry).toHaveBeenCalled()
    expect(mockCreateMemoryProvider).not.toHaveBeenCalled()
  })

  it('resolves services.memory.dir from the config directory for runtime memory', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'agent-qa-memory-config-'))
    tempDirs.push(configDir)
    const cfg = defaultConfig()
    ;(cfg.services as any).memory = {
      enabled: true,
      provider: 'local',
      dir: '.agent-qa/custom-memory',
      curatorEnabled: false,
      ablationEnabled: false,
    }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockCreateMemoryProvider.mockResolvedValue({
      getInjectedObservations: vi.fn(() => []),
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', join(configDir, 'agent-qa.config.yaml')], 'tests/**/*.yaml')

    const expectedRoot = join(configDir, '.agent-qa/custom-memory')
    expect(mockCreateMemoryProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'local',
      memoryRoot: expectedRoot,
    }))
    expect(mockRunTestWithRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memoryInitParams: expect.objectContaining({ memoryRoot: expectedRoot }),
      }),
      expect.anything(),
    )
  })
})

describe('run command — runtime cache paths', () => {
  it('resolves services.cache.dir and ttl from the config directory', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'agent-qa-cache-config-'))
    tempDirs.push(configDir)
    const cfg = defaultConfig()
    cfg.services.cache = { dir: '.agent-qa/custom-cache', ttl: '7d' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', join(configDir, 'agent-qa.config.yaml')], 'tests/**/*.yaml')

    expect(mockFileActionCache).toHaveBeenCalledWith(expect.objectContaining({
      dir: join(configDir, '.agent-qa/custom-cache'),
      ttl: '7d',
    }))
  })

  it('disables direct test cache when use.cache is false', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { cache: false } })],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunTestWithRetry.mock.calls[0][1]
    expect(runConfig.cache).toBeUndefined()
    const reporterContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(reporterContext.artifact.config.cache.enabled).toBe(false)
  })

  it('keeps direct test cache enabled when use.cache is absent', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunTestWithRetry.mock.calls[0][1]
    expect(runConfig.cache).toBeDefined()
    const reporterContext = mockMultiReporterInstance.onTestStart.mock.calls[0][2]
    expect(reporterContext.artifact.config.cache.enabled).toBe(true)
  })

  it('disables suite cache when use.cache is false', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Smoke Suite',
      target: 'test-app',
      use: { cache: false },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    const suiteConfig = mockRunSuite.mock.calls[0][2]
    expect(suiteConfig.cache).toBeUndefined()
    expect(suiteConfig.artifactContext.config.cache.enabled).toBe(false)
  })

  it('keeps suite cache enabled when use.cache is absent', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Smoke Suite',
      target: 'test-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    const suiteConfig = mockRunSuite.mock.calls[0][2]
    expect(suiteConfig.cache).toBeDefined()
    expect(suiteConfig.artifactContext.config.cache.enabled).toBe(true)
  })

  it('invalidates failed-run cache entries under the configured cache directory', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'agent-qa-cache-invalidate-'))
    tempDirs.push(configDir)
    const cacheEntry = join(configDir, '.agent-qa/custom-cache/mock-hash')
    mkdirSync(cacheEntry, { recursive: true })
    writeFileSync(join(cacheEntry, 'entry.json'), '{}')

    const cfg = defaultConfig()
    cfg.services.cache = { dir: '.agent-qa/custom-cache', ttl: '7d' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunTestWithRetry.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [{ name: 'Click login', status: 'failed' }],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', join(configDir, 'agent-qa.config.yaml')], 'tests/**/*.yaml')

    expect(existsSync(cacheEntry)).toBe(false)
  })
})

describe('run command — test discovery from config', () => {
  it('uses config.testMatch patterns when no CLI patterns provided', async () => {
    const cfg = defaultConfig()
    cfg.workspace.testMatch = ['src/**/*.test.yaml']
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['src/login.test.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommand('--dry-run')

    expect(mockGlob).toHaveBeenCalledWith('src/**/*.test.yaml', expect.objectContaining({ ignore: [] }))
  })

  it('errors when workspace.testMatch is missing from config', async () => {
    const cfg = defaultConfig()
    cfg.workspace.testMatch = undefined as any
    mockResolveConfig.mockResolvedValue(cfg)

    try {
      await runCommand('--dry-run')
    } catch { /* process.exit may throw */ }
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('workspace.testMatch is required'))
  })

  it('CLI patterns filter configured workspace discovery without bypassing testMatch', async () => {
    const cfg = defaultConfig()
    cfg.workspace.testMatch = ['src/**/*.test.yaml']
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['src/login.test.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommand('--dry-run', 'custom/**/*.yaml')

    expect(mockGlob).toHaveBeenCalledWith('src/**/*.test.yaml', expect.objectContaining({ ignore: [] }))
    expect(mockGlob).toHaveBeenCalledWith('suites/**/*.suite.yaml', expect.objectContaining({ ignore: [] }))
    expect(mockGlob).not.toHaveBeenCalledWith('custom/**/*.yaml', expect.anything())
    expect(mockParseAllTests).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('No test files found matching patterns')
  })

  it('passes testPathIgnore as glob ignore option', async () => {
    const cfg = defaultConfig()
    cfg.workspace.testPathIgnore = ['**/fixtures/**', '**/snapshots/**']
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommand('--dry-run')

    expect(mockGlob).toHaveBeenCalledWith('tests/**/*.yaml', expect.objectContaining({ ignore: ['**/fixtures/**', '**/snapshots/**'] }))
  })
})

describe('run command — --list-tests', () => {
  it('prints discovered file paths and exits 0 without parsing', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml', 'tests/b.yaml'])

    await runCommand('--list-tests')

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(mockParseAllTests).not.toHaveBeenCalled()
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('tests/a.yaml')
    expect(allOutput).toContain('tests/b.yaml')
  })

  it('exits 2 when no files found with --list-tests', async () => {
    mockGlob.mockResolvedValue([])

    await runCommand('--list-tests')

    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})

describe('run command — Zod validation before execution', () => {
  it('exits 2 with parse errors before any LLM calls', async () => {
    mockGlob.mockResolvedValue(['tests/bad.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [],
      errors: [{
        file: 'tests/bad.yaml',
        line: 2,
        column: 1,
        message: 'Required',
        severity: 'error',
        source: 'steps:',
      }],
    })

    await runCommand()

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunTestWithRetry).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('parse error')
  })

  it('shows field-level Zod error details via formatParseError', async () => {
    mockGlob.mockResolvedValue(['tests/bad.yaml'])
    const parseError = {
      file: 'tests/bad.yaml',
      line: 5,
      column: 3,
      message: 'Invalid type at steps',
      severity: 'error',
      source: 'steps: invalid',
    }
    mockParseAllTests.mockResolvedValue({
      tests: [],
      errors: [parseError],
    })

    await runCommand()

    expect(mockFormatParseError).toHaveBeenCalledWith(parseError)
    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})
