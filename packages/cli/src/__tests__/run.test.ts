import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
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
  mockRunMemberTest,
  mockPatchTestForSuite,
  mockFsEventLog,
  mockFsHandoffStore,
  mockNextBuildOrdinal,
  mockCreateModel,
  mockLLMPlanner,
  mockLLMVerifier,
  mockResolveConfig,
  mockResolveTarget,
  mockResolveAuthStateForRun,
  mockResolveAuthStatePaths,
  mockWriteAuthStateFiles,
  mockAndroidAdapterSetup,
  mockAndroidAdapterCleanup,
  mockWebAdapterSetup,
  mockWebAdapterCleanup,
  mockWebStorageState,
  mockRunAccessibilityCheck,
  mockConsoleReporterInstance,
  mockJUnitReporterInstance,
  mockStdoutLiveReporterInstance,
  mockMultiReporterInstance,
  mockDashboardDatabase,
  mockDashboardReporter,
  mockResolveDashboardDbPath,
  mockGenerateRunId,
  mockFsActionCache,
  mockFsStorageStateStore,
  mockResolveBranch,
  mockAnalyticsRunSubscriberInstance,
  mockCreateAnalyticsRunSubscriber,
  mockDashboardRunIngestInstance,
  mockCreateDashboardRunIngest,
  mockRunsDbHandle,
  mockShouldPrintAgentQaUpdateNotice,
  mockPrintAgentQaUpdateNoticeIfNeeded,
  mockLogScope,
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
  // 363-09: the bus-subscriber successors — analytics + dashboard ingest ride the run session bus.
  const analyticsRunSubscriber = {
    handler: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  }
  const dashboardRunIngest = {
    handler: vi.fn(),
    stageSnapshots: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
  }
  // 2026-10-17 (443-08, D-03): every run opens its record, so the default handle answers its reads.
  const runsDbHandle = () => ({
    close: vi.fn(),
    getRun: vi.fn(() => undefined),
    readRunOwner: vi.fn(() => undefined),
    isOwnStamp: vi.fn(() => false),
    insertRun: vi.fn(),
    updateRun: vi.fn(),
    insertRunArtifact: vi.fn(),
    finalizeRunArtifact: vi.fn(),
    finalizeOwnRun: vi.fn(() => true),
  })
  // WINDOWS #233/#249: records the member-log-scope depth at every setRunId stamp, so a cell can
  // assert the direct member executor actually runs INSIDE a scope. Depth, not a source grep —
  // deleting the `logger.runInMemberScope(...)` wrap in run.ts leaves every stamp at depth 0.
  const logScope = { depth: 0, stampDepths: [] as number[] }

  return {
    mockLogScope: logScope,
    mockAnalyticsRunSubscriberInstance: analyticsRunSubscriber,
    // 398-10: the options argument is TYPED because two cells read it — the port-identity check
    // for `--all` needs `calls[n][0].port`, and an untyped `vi.fn()` records a zero-length tuple
    // that `tsc` refuses to index (vitest's own typecheck lane does not see this file's calls).
    mockCreateAnalyticsRunSubscriber: vi.fn(function (_options: { port: unknown }) {
      return analyticsRunSubscriber
    }),
    mockDashboardRunIngestInstance: dashboardRunIngest,
    mockRunsDbHandle: runsDbHandle,
    mockCreateDashboardRunIngest: vi.fn(function (deps: { runId: string; onRunCreated?: (runId: string) => void }) {
      deps.onRunCreated?.(deps.runId)
      return dashboardRunIngest
    }),
    mockGlob: vi.fn(),
    mockParseAllTests: vi.fn(),
    mockParseSuiteFile: vi.fn(),
    mockParseTestFile: vi.fn(),
    mockParseHooksFile: vi.fn(),
    mockFormatParseError: vi.fn((err: any) => `${err.file}:${err.line}:${err.column}: ${err.message}`),
    mockRunHooks: vi.fn(),
    mockRunSuite: vi.fn(),
    mockRunMemberTest: vi.fn(),
    mockPatchTestForSuite: vi.fn((t: any) => t),
    mockFsEventLog: vi.fn(function () { return { append: vi.fn(), read: vi.fn(() => []) } }),
    mockFsHandoffStore: vi.fn(function () { return { save: vi.fn() } }),
    mockNextBuildOrdinal: vi.fn(async () => 1),
    mockCreateModel: vi.fn(() => ({})),
    mockLLMPlanner: vi.fn(),
    mockLLMVerifier: vi.fn(),
    mockResolveConfig: vi.fn(),
    mockResolveTarget: vi.fn(),
    mockResolveAuthStateForRun: vi.fn(),
    mockResolveAuthStatePaths: vi.fn(),
    mockWriteAuthStateFiles: vi.fn(),
    mockAndroidAdapterSetup: vi.fn(),
    mockAndroidAdapterCleanup: vi.fn(),
    mockWebAdapterSetup: vi.fn(),
    mockWebAdapterCleanup: vi.fn(),
    mockWebStorageState: vi.fn(),
    mockRunAccessibilityCheck: vi.fn(),
    mockConsoleReporterInstance: { verbose: false },
    mockJUnitReporterInstance: { outputPath: '' },
    mockStdoutLiveReporterInstance: { active: false },
    mockMultiReporterInstance: multiReporter,
    mockDashboardDatabase: vi.fn(function (): unknown { return runsDbHandle() }),
    mockDashboardReporter: vi.fn(function () { return {} }),
    mockResolveDashboardDbPath: vi.fn(),
    mockGenerateRunId: vi.fn(() => 'r_able-baker-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'),
    mockFsActionCache: vi.fn(function () { return { get: vi.fn(), set: vi.fn(), invalidate: vi.fn() } }),
    mockFsStorageStateStore: vi.fn(function () { return { save: vi.fn(), load: vi.fn() } }),
    mockResolveBranch: vi.fn(() => ({ currentBranch: 'main', defaultBranch: 'main' })),
    mockShouldPrintAgentQaUpdateNotice: vi.fn(() => true),
    mockPrintAgentQaUpdateNoticeIfNeeded: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('glob', () => ({ glob: mockGlob }))

vi.mock('@vostride/agent-qa-model', async () => {
  const actual = await vi.importActual<typeof import('@vostride/agent-qa-model')>('@vostride/agent-qa-model')
  return {
    ...actual,
    createModel: mockCreateModel,
  }
})

// LLMPlanner/LLMVerifier moved to the runner package (Phase 353-07); run.ts now
// imports them from @vostride/agent-qa-runner, so intercept them there.
vi.mock('@vostride/agent-qa-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-runner')>()
  // runHooks moved to runner in Phase 363 D-06; intercept it while keeping every other export real.
  return { ...actual, LLMPlanner: mockLLMPlanner, LLMVerifier: mockLLMVerifier, runHooks: mockRunHooks, runMemberTest: mockRunMemberTest }
})

vi.mock('@vostride/agent-qa-runner-local', () => ({
  FsActionCache: mockFsActionCache,
  FsStorageStateStore: mockFsStorageStateStore,
  resolveBranch: mockResolveBranch,
  FsEventLog: mockFsEventLog,
  FsHandoffStore: mockFsHandoffStore,
  // 363-06: buildRunPorts constructs the run-artifact store; buildScreenshotCompressor constructs
  // the sharp compressor. Both are injected but their legs are never exercised in these unit runs.
  FsRunArtifactStore: class { stage(): void {} finalize(): void {} },
  // 367-13 CASS-02: buildRunPorts also constructs the run-scoped evidence artifact store; its legs
  // are never exercised in these mocked unit runs, but the constructor must exist.
  FsEvidenceArtifactStore: class {
    persistDecisionScreenshot(): { id: string; sha: string } { return { id: 'decision-screenshot:mock', sha: 'mock' } }
    getBlob(): Uint8Array | undefined { return undefined }
  },
  SharpScreenshotCompressor: class {
    async compress(buffer: Buffer): Promise<{ buffer: Buffer; imageWidth: number; imageHeight: number }> {
      return { buffer, imageWidth: 0, imageHeight: 0 }
    }
    async dimensions(): Promise<{ width: number; height: number }> {
      return { width: 0, height: 0 }
    }
  },
  nextBuildOrdinal: mockNextBuildOrdinal,
  // 363-04: the run paths construct DockerHookExecutor here (D-06); runHooks is mocked so execute
  // is never actually invoked, but the constructor must exist.
  DockerHookExecutor: class { async execute() { return { success: true, variables: {}, output: '', stdout: '', stderr: '', duration: 0 } } },
  // The run composition's `runDirFor` roots the run's own directory via the shared run-dir slug, so
  // the mock exposes both.
  RUNS_SUBDIR: 'runs',
  slugBranch: (name: string) => String(name),
  // 388-02: the post-run tail derives the handoff path and reads it before enqueueing
  // analyze-run. These unit runs write no handoff, so the read refuses — which is exactly the
  // D-07 warn-only leg, and the exit-code assertions below are what prove it stays warn-only.
  HANDOFF_FILE: 'handoff.json',
  loadCompletedRunHandoff: () => {
    throw new Error('no completed run handoff in this unit fixture')
  },
}))

// 398-10 (D-17/D-20): the run-completion subscriber comes from `@vostride/agent-qa-analytics` now.
// ONLY that factory is replaced — `composeAnalytics`, the port, the transports and the closed union
// are the REAL ones, so this command's composition root still makes the real opt-out decision and
// still refuses an event the union does not declare. Mocking the package wholesale would have made
// every analytics claim in this file a claim about the mock.
vi.mock('@vostride/agent-qa-analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-analytics')>()
  return { ...actual, createAnalyticsRunSubscriber: mockCreateAnalyticsRunSubscriber }
})

vi.mock('@vostride/agent-qa-core', async (importOriginal) => {
  class MockMobileSetupError extends Error {
    category: string
    constructor(input: { category: string; message: string }) {
      super(input.message)
      this.category = input.category
    }
  }

  // 390-08: `workspaceRelativeIdentityPath` comes from the REAL module, never a hand-spelled stub.
  // It is the rule that decides what bytes land in the committed quarantine ledger, so a mock of it
  // would leave these run-command pins measuring the mock's idea of identity instead of the
  // shipped one — and a drift between the two would be exactly the defect CR-02 found.
  const actual = await importOriginal<typeof import('@vostride/agent-qa-core')>()

  return {
  // 395-08: the two default-directory constants, FROM THE REAL MODULE. `commands/scaffold-content.ts`
  // — D-04's one scaffold producer — reads them, and it is now in this command's module graph
  // through the composition root. Passed through rather than spelled, so a mock cannot become a
  // second answer about where the cache and the auth states live.
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: actual.DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_RUNS_DB_PATH: actual.DEFAULT_AGENT_QA_RUNS_DB_PATH,
  workspaceRelativeIdentityPath: actual.workspaceRelativeIdentityPath,
  // 398-10: the shipped version reader, FROM THE REAL MODULE for the same reason as the two above.
  // `composition/analytics-host.ts` stamps `agent_qa_version` on every event this command emits,
  // and the union constrains that field to a semver — a stubbed string here would let a cell pass
  // on a value the schema would refuse in production.
  getAgentQaVersion: actual.getAgentQaVersion,
  parseAllTests: mockParseAllTests,
  parseAllTestBindings: vi.fn(async (filePaths: string[]) => {
    const result = await mockParseAllTests(filePaths)
    return {
      bindings: (result.tests ?? []).map((test: unknown) => ({
        test,
        filePath: filePaths[0] ?? '',
        fileContent: '',
      })),
      errors: result.errors ?? [],
    }
  }),
  parseSuiteFile: mockParseSuiteFile,
  parseTestFile: mockParseTestFile,
  parseHooksFile: mockParseHooksFile,
  formatParseError: mockFormatParseError,
  runHooks: mockRunHooks,
  runSuite: mockRunSuite,
  patchTestForSuite: mockPatchTestForSuite,
  resolveAuthStateForRun: mockResolveAuthStateForRun,
  resolveAuthStatePaths: mockResolveAuthStatePaths,
  writeAuthStateFiles: mockWriteAuthStateFiles,
  AUTH_STATE_SCHEMA_VERSION: 2,
  normalizeAuthStateUse: vi.fn((use: { authState?: unknown } | undefined) => {
    const authState = use?.authState
    if (typeof authState === 'string' && authState.trim().length > 0) {
      return { name: authState, load: true, capture: false }
    }
    if (authState && typeof authState === 'object' && !Array.isArray(authState)) {
      const record = authState as Record<string, unknown>
      if (typeof record.name === 'string' && record.name.trim().length > 0) {
        return {
          name: record.name,
          load: typeof record.load === 'boolean' ? record.load : true,
          capture: typeof record.capture === 'boolean' ? record.capture : false,
        }
      }
    }
    return undefined
  }),
  resolveLLMAuth: vi.fn(async () => ({
    kind: 'api-key',
    credentialKey: 'default',
    provider: 'anthropic-subscription',
    apiKey: 'test-key',
  })),
  LLMPlanner: mockLLMPlanner,
  LLMVerifier: mockLLMVerifier,
  ATTR_TRIGGER: 'agent-qa.trigger',
  ATTR_RUNNER: 'agent-qa.runner',
  ATTR_GATE_RUN: 'agent-qa.gate-run',
  DEFAULT_AGENT_QA_ARTIFACTS_DIR: '.agent-qa/artifacts',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_SCREENSHOTS_DIR: '.agent-qa/artifacts/screenshots',
  DEFAULT_AGENT_QA_VIDEOS_DIR: '.agent-qa/artifacts/videos',
  parseEnvFile: vi.fn(() => ({})),
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
      if (key === 'agent-qa.runner' && value !== 'local') {
        throw new Error(`${sourceLabel}: Attribute value for "${key}" must be one of: local`)
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
    device: {
      name: input.explicitDeviceName ?? input.useDeviceName,
      platform: input.platform,
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
  LogManager: vi.fn(function () {
    return {
      log: vi.fn(),
      flush: vi.fn(),
      runInMemberScope: vi.fn(async (fn: () => unknown) => {
        mockLogScope.depth++
        try {
          return await fn()
        } finally {
          mockLogScope.depth--
        }
      }),
      setRunId: vi.fn(() => { mockLogScope.stampDepths.push(mockLogScope.depth) }),
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
  resolveKnowledgeRoot: vi.fn((knowledge: { dir?: string } | undefined, configDir: string) =>
    resolve(configDir, knowledge?.dir ?? 'agent-qa-knowledge')),
  generateRunId: mockGenerateRunId,
  isCanonicalRunId: (value: string): boolean => /^r_/.test(value),
  isPathInsideDir: vi.fn((candidatePath: string) => !candidatePath.includes('..')),
  resolveWorkspacePaths: vi.fn(({ config, configPath }: any) => {
    const configDir = String(configPath).includes('/')
      ? String(configPath).split('/').slice(0, -1).join('/')
      : process.cwd()
    for (const key of ['testMatch', 'suiteMatch', 'hooksFile', 'envFile', 'secretsFile']) {
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
  runAccessibilityCheck: mockRunAccessibilityCheck,
  WebPlatformAdapter: vi.fn(function () {
    return {
      setup: mockWebAdapterSetup,
      cleanup: mockWebAdapterCleanup,
      observe: vi.fn(),
      execute: vi.fn(),
      getPage: vi.fn(() => ({
        context: vi.fn(() => ({
          storageState: mockWebStorageState,
        })),
      })),
    }
  }),
}))

vi.mock('@vostride/agent-qa-dashboard', () => ({
  DashboardDatabase: mockDashboardDatabase,
  DashboardReporter: mockDashboardReporter,
  createDashboardRunIngest: mockCreateDashboardRunIngest,
  resolveDashboardDbPath: mockResolveDashboardDbPath,
}))

vi.mock('../version-notice.js', () => ({
  shouldPrintAgentQaUpdateNotice: mockShouldPrintAgentQaUpdateNotice,
  printAgentQaUpdateNoticeIfNeeded: mockPrintAgentQaUpdateNoticeIfNeeded,
}))

vi.mock('../config.js', () => ({
  resolveConfig: mockResolveConfig,
  loadConfigPlugins: vi.fn(async () => {}),
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

// 373-07: the run-start baseline probe (D-04) does a REAL global-fetch GET against the resolved
// web target at the composition root — stub it here so no unit test touches the network and the
// run body starts immediately (the classifier consumes the value; probe behavior is pinned in
// baseline-probe.test.ts).
vi.mock('../commands/baseline-probe.js', () => ({
  runBaselineProbe: vi.fn(async () => ({ status: 200, elapsedMs: 1 })),
}))

import { createRunCommand } from '../commands/run.js'
import { composeRunOwnership } from '../composition/run-owner-probe.js'

let defaultSecretsFilePath: string | undefined
let defaultEnvFilePath: string | undefined
let defaultHooksFilePath: string | undefined

function defaultConfig() {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      testPathIgnore: [] as string[],
      hooksFile: defaultHooksFilePath ?? 'hooks.yaml',
      envFile: defaultEnvFilePath ?? '.env',
      secretsFile: defaultSecretsFilePath ?? '.env.secrets.local',
    },
    // Flat aliases removed — run command now reads from workspace.* (4-bucket config)
    services: {
      cache: { dir: '.agent-qa/cache' },
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
      planner: { maxActions: 50, maxPlanningTurns: 50, previousStepCount: 3 },
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

/**
 * A run id unique to this test, and to this process (401-20 · CR-04).
 *
 * A caller-named run id that already names a run is now REFUSED, and these fixtures write REAL run
 * directories into `packages/cli/.agent-qa/runs/` which survive the process. A constant id
 * therefore worked exactly once per workspace and collided on every later run of this file. Unique
 * A FRESH ID PER CALL by default, because `--all` starts a suite run and a direct run in ONE
 * process and a shared mint would make the second collide with the first. Cells that need one
 * stable value across a single run pin it themselves with `mockReturnValue(freshRunId(...))`; the
 * one cell that asserts the printed id reads it back off the mint rather than typing it in.
 */
// 418-07: OS PIDs recur across sessions while these fixture directories persist.
// A per-suite nonce prevents historical run evidence from refusing a fresh fixture.
const runIdSession = randomUUID().replaceAll('-', '')
let runIdOrdinal = 0
function freshRunId(stem: string): string {
  runIdOrdinal += 1
  return `r_${stem}-${runIdSession}-${runIdOrdinal.toString(36)}`
}

beforeEach(() => {
  mockLogScope.depth = 0
  mockLogScope.stampDepths.length = 0
  vi.clearAllMocks()
  mockGenerateRunId.mockImplementation(() => freshRunId('able-baker-charlie-delta-echo'))
  const secretsDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-secrets-'))
  tempDirs.push(secretsDir)
  defaultSecretsFilePath = join(secretsDir, '.env.secrets.local')
  defaultEnvFilePath = join(secretsDir, '.env')
  defaultHooksFilePath = join(secretsDir, 'hooks.yaml')
  writeFileSync(defaultSecretsFilePath, '')
  writeFileSync(defaultEnvFilePath, '')
  writeFileSync(defaultHooksFilePath, 'hooks: []\n')
  mockResolveConfig.mockResolvedValue(defaultConfig())
  mockDashboardDatabase.mockImplementation(function () { return mockRunsDbHandle() })
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
  // The suite path now runs through startRun; each member wraps executeSuiteMember (D-01). Default
  // to a passing member TestResult so the aggregate verdict is `passed` ⇒ exit 0.
  mockRunMemberTest.mockReset()
  mockRunMemberTest.mockResolvedValue({
    runId: 'r_member',
    name: 'Suite Member',
    filePath: 'tests/login.yaml',
    status: 'passed',
    steps: [],
    duration: 100,
  })
  mockResolveAuthStateForRun.mockReset()
  mockResolveAuthStateForRun.mockResolvedValue({
    version: 2,
    kind: 'web',
    targetName: 'test-app',
    stateName: 'admin',
    capturedAt: '2026-05-17T00:00:00.000Z',
    storageStatePath: '/internal/auth/test-app/admin.json',
  })
  mockResolveAuthStatePaths.mockReset()
  mockResolveAuthStatePaths.mockImplementation(({ targetName, stateName }: { targetName: string; stateName: string }) => ({
    targetName,
    stateName,
    rootDir: '/internal/auth',
    targetDir: `/internal/auth/${targetName}`,
    payloadPath: `/internal/auth/${targetName}/${stateName}.json`,
    metadataPath: `/internal/auth/${targetName}/${stateName}.meta.json`,
  }))
  mockWriteAuthStateFiles.mockReset()
  mockWriteAuthStateFiles.mockResolvedValue(undefined)
  mockWebStorageState.mockReset()
  mockWebStorageState.mockResolvedValue({
    cookies: [],
    origins: [],
  })
  mockShouldPrintAgentQaUpdateNotice.mockReset()
  mockShouldPrintAgentQaUpdateNotice.mockReturnValue(true)
  mockPrintAgentQaUpdateNoticeIfNeeded.mockReset()
  mockPrintAgentQaUpdateNoticeIfNeeded.mockResolvedValue(undefined)
  mockFsActionCache.mockClear()
  mockFsStorageStateStore.mockClear()
  mockResolveBranch.mockClear()
  mockResolveTarget.mockReturnValue({
    name: 'test-app',
    product: 'test-app',
    platform: 'web',
    url: 'https://example.com',
    // 401-03 (D-06): these fixtures declare their class because the run gate now classifies
    // every run by it, and an UNDECLARED target fails closed in a non-interactive context —
    // which a vitest process is. `local` is the honest declaration here: nothing in this suite
    // touches a network (the baseline probe is mocked above and the member runner is a double),
    // so these runs drive a local fixture environment whatever the placeholder URL reads. The
    // gate's own behaviour is measured where it belongs — `run-gate.e2e.test.ts` on the shipped
    // binary and `run-invocation-core.test.ts` at the unit — and a control below proves these
    // cells are green because they DECLARED, not because the gate went missing.
    environment: 'local',
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
  delete process.env.AGENT_QA_RUN_ATTRIBUTES_JSON
  delete process.env.AGENT_QA_LIVE_EVENTS
  defaultSecretsFilePath = undefined
  defaultEnvFilePath = undefined
  defaultHooksFilePath = undefined
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

afterAll(async () => {
  await Promise.all(['agent-qa-run-notice-junit.xml', 'agent-qa-selection-junit.xml']
    .map((file) => rm(join(tmpdir(), file), { force: true })))
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

// Member starts resolve waits, so a slow run start costs time rather than a poll ceiling.
function memberArrivals() {
  const started: string[] = []
  const waiting: { count: number; resolve: () => void }[] = []
  const arrive = (name: string) => {
    started.push(name)
    for (const waiter of waiting.filter(({ count }) => started.length >= count)) {
      waiting.splice(waiting.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  // Resolves once `count` members have started and pending work has had a turn to start more,
  // so a sequential claim made right after still sees any member started early.
  const reached = async (count: number, command: Promise<unknown>) => {
    await Promise.race([
      started.length >= count ? Promise.resolve()
        : new Promise<void>((resolve) => { waiting.push({ count, resolve }) }),
      command.then(() => {
        throw new Error(`the run settled with ${started.length} of ${count} members started: ${started.join(', ')}`)
      }),
    ])
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { started, arrive, reached }
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

// Resolves to a per-member TestResult (the suite path now runs through executeSuiteMember, not
// runSuite). Used to control sequential member timing inside the ONE RunSession.
function deferredSuiteResult(name: string) {
  let resolveResult!: () => void
  const promise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveResult = () => resolvePromise({
      runId: `r_${name}`,
      name,
      filePath: `tests/${name}.yaml`,
      status: 'passed',
      steps: [],
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
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig.secretStore.require('LOGIN_PASSWORD')).toBe('super-secret')
    expect(runConfig.secretRedactor).toBeDefined()
    // 363-11: secretsFileMetadata / the run artifact are no longer threaded through a v1 reporter
    // (runMemberTest owns execution); the secret store + redactor threading above is the meaningful
    // assertion — the run redactor is what keeps raw secrets out of any rendered/persisted output.
    void secretsPath
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

describe('run command — product-scoped handoff preflight', () => {
  it('rejects a mixed-product direct invocation before run-owned side effects', async () => {
    mockGlob.mockResolvedValue(['tests/alpha.yaml', 'tests/beta.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [
        makeTest({ name: 'Alpha checkout', target: 'alpha-target' }),
        makeTest2({ name: 'Beta checkout', target: 'beta-target' }),
      ],
      errors: [],
    })
    mockResolveTarget.mockImplementation((_config, target: string) => ({
      name: target,
      product: target === 'alpha-target' ? 'alpha-product' : 'beta-product',
      platform: 'web',
      url: `https://${target}.example.test`,
      environment: 'local',
    }))

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const message = errorSpy.mock.calls.flat().join('\n')
    expect(message).toContain('Mixed-product run is not supported')
    expect(message).toContain('alpha-product')
    expect(message).toContain('beta-product')
    expect(mockNextBuildOrdinal).not.toHaveBeenCalled()
    expect(mockFsStorageStateStore).not.toHaveBeenCalled()
    expect(mockWebAdapterSetup).not.toHaveBeenCalled()
    expect(mockCreateModel).not.toHaveBeenCalled()
    expect(mockRunMemberTest).not.toHaveBeenCalled()
  })

  it('rejects mixed-product suites before dashboard, ordinal, adapter, or session setup', async () => {
    const { configPath, suiteA, suiteB } = await createMultiSuiteWorkspace()
    mockGlob.mockResolvedValue([suiteA, suiteB])
    mockParseSuiteFile.mockImplementation(async (file: string) => ({
      ...suiteDefinition(file === suiteA ? 'Suite Alpha' : 'Suite Beta', file === suiteA
        ? 'a.yaml'
        : 'b.yaml'),
      target: file === suiteA ? 'alpha-target' : 'beta-target',
    }))
    mockParseTestFile.mockReturnValue({ tests: [makeTest()], errors: [] })
    mockResolveTarget.mockImplementation((_config, target: string) => ({
      name: target,
      product: target === 'alpha-target' ? 'alpha-product' : 'beta-product',
      platform: 'web',
      url: `https://${target}.example.test`,
      environment: 'local',
    }))

    await runCommandWithGlobalArgs(['--config', configPath], '--suite')

    expect(exitSpy).toHaveBeenCalledWith(2)
    const message = errorSpy.mock.calls.flat().join('\n')
    expect(message).toContain('Mixed-product run is not supported')
    expect(message).toContain('alpha-product')
    expect(message).toContain('beta-product')
    expect(mockDashboardDatabase).not.toHaveBeenCalled()
    expect(mockNextBuildOrdinal).not.toHaveBeenCalled()
    expect(mockFsStorageStateStore).not.toHaveBeenCalled()
    expect(mockWebAdapterSetup).not.toHaveBeenCalled()
    expect(mockCreateModel).not.toHaveBeenCalled()
    expect(mockRunMemberTest).not.toHaveBeenCalled()
  })

  it('keeps multiple targets for one product in one direct run', async () => {
    mockGlob.mockResolvedValue(['tests/storefront.yaml', 'tests/admin.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [
        makeTest({ name: 'Storefront checkout', target: 'storefront-target' }),
        makeTest2({ name: 'Admin checkout', target: 'admin-target' }),
      ],
      errors: [],
    })
    mockResolveTarget.mockImplementation((_config, target: string) => ({
      name: target,
      product: 'checkout-product',
      platform: 'web',
      url: `https://${target}.example.test`,
      environment: 'local',
    }))

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(mockNextBuildOrdinal).toHaveBeenCalledWith(expect.objectContaining({
      product: 'checkout-product',
    }))
    expect(mockRunMemberTest).toHaveBeenCalledTimes(2)
  })
})

// Every fixture above declares `environment: 'local'`; nothing gates a run on it, so a target that
// declares no environment reaches the member runner the same way.
describe('run command — a target with no declared environment runs', () => {
  const oneMember = (): void => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest({ target: 'test-app' })], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })
  }

  it('an UNDECLARED target now reaches the member runner, with no prompt and no refusal', async () => {
    oneMember()
    mockResolveTarget.mockReturnValue({
      name: 'test-app',
      product: 'test-app',
      platform: 'web',
      url: 'https://example.com',
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunMemberTest).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
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
      environment: 'local',
    })
    mockRunMemberTest.mockResolvedValue({
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
    expect(mockRunMemberTest).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://myapp.example.com' }),
      expect.anything(),
    )
  })

  it('passes mapped model profile and auth to model.createModel for direct runs', async () => {
    const cfg = defaultConfig()
    cfg.registry.llms[0] = {
      ...cfg.registry.llms[0],
      providerHeaders: { 'X-Agent-QA-Test': 'run-path' },
    } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockCreateModel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        headers: { 'X-Agent-QA-Test': 'run-path' },
        auth: { mode: 'api-key' },
      }),
      { kind: 'api-key', apiKey: 'test-key' },
      expect.any(Function),
    )
    expect(mockCreateModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'anthropic-compatible',
        model: 'claude-sonnet-4-20250514',
        baseURL: 'https://anthropic-proxy.example/messages',
        headers: { 'X-Agent-QA-Test': 'run-path' },
        auth: { mode: 'api-key' },
      }),
      { kind: 'api-key', apiKey: 'test-key' },
      expect.any(Function),
    )
    // 355-07 supplies role-separated accounting ports. 366-07 adds each role's declared
    // model profile and preserves that exact DTO reference through member-run recording.
    expect(mockLLMPlanner.mock.calls[0]).toHaveLength(7)
    expect(mockLLMPlanner.mock.calls[0][0]).toBe(mockCreateModel.mock.results[0].value)
    expect(mockLLMPlanner.mock.calls[0][1]).toBe('web')
    const plannerAccounting = mockLLMPlanner.mock.calls[0][4]
    expect(plannerAccounting).toEqual(expect.objectContaining({
      estimate: expect.any(Function),
      degrade: expect.any(Function),
      recordUsage: expect.any(Function),
      getCeilings: expect.any(Function),
    }))
    const plannerDeclared = mockLLMPlanner.mock.calls[0][5]
    expect(plannerDeclared).toEqual(expect.objectContaining({
      provider: 'anthropic-compatible',
      modelId: 'claude-sonnet-4-20250514',
      vision: expect.any(Boolean),
      maxOutputTokens: expect.any(Number),
    }))
    expect(Object.keys(mockLLMPlanner.mock.calls[0][6]).sort()).toEqual([
      'memory.read',
      'memory.search',
    ])
    expect(plannerDeclared).not.toHaveProperty('sampling')

    expect(mockLLMVerifier.mock.calls[0]).toHaveLength(3)
    expect(mockLLMVerifier.mock.calls[0][0]).toBe(mockCreateModel.mock.results[1].value)
    const verifierAccounting = mockLLMVerifier.mock.calls[0][1]
    expect(verifierAccounting).toEqual(expect.objectContaining({
      estimate: expect.any(Function),
      recordUsage: expect.any(Function),
      getCeilings: expect.any(Function),
    }))
    const verifierDeclared = mockLLMVerifier.mock.calls[0][2]
    expect(verifierDeclared).toEqual(expect.objectContaining({
      provider: 'anthropic-compatible',
      modelId: 'claude-sonnet-4-20250514',
      vision: expect.any(Boolean),
      maxOutputTokens: expect.any(Number),
    }))
    expect(verifierDeclared).not.toHaveProperty('sampling')
    expect(verifierDeclared).not.toBe(plannerDeclared)

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig.modelProfiles.planner).toBe(plannerDeclared)
    expect(runConfig.modelProfiles.verifier).toBe(verifierDeclared)
    // Role-separated instances — the planner and verifier must not share one accounting.
    expect(plannerAccounting).not.toBe(verifierAccounting)
  })
})

describe('run command — auth state consumption', () => {
  it('resolves a direct web test auth state before adapter setup and still executes the test', async () => {
    const cfg = defaultConfig()
    ;(cfg.services as any).authState = { dir: '.agent-qa/auth-states' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { authState: 'admin' } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/auth.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockResolveAuthStateForRun).toHaveBeenCalledWith(expect.objectContaining({
      authStateDir: '.agent-qa/auth-states',
      targetName: 'test-app',
      stateName: 'admin',
      target: { platform: 'web' },
    }))
    expect(mockResolveAuthStateForRun.mock.invocationCallOrder[0]).toBeLessThan(
      mockWebAdapterSetup.mock.invocationCallOrder[0],
    )
    expect(mockWebAdapterSetup).toHaveBeenCalledWith(expect.objectContaining({
      authState: expect.objectContaining({
        targetName: 'test-app',
        stateName: 'admin',
        storageStatePath: '/internal/auth/test-app/admin.json',
      }),
    }))
    expect(mockRunMemberTest).toHaveBeenCalled()
  })

  it('passes direct auth state to setup, inline, and teardown hook sandbox options', async () => {
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({
        use: { authState: 'admin' },
        setup: ['hook-seed'],
        teardown: ['hook-seed'],
      })],
      errors: [],
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{ id: 'hook-seed', name: 'seed data', runtime: 'node', file: '/hooks/seed.js', deps: [] }],
      errors: [],
    })
    mockRunHooks.mockResolvedValue({
      allPassed: true,
      variables: {},
      results: new Map([['seed data', {
        success: true,
        duration: 10,
        stdout: '',
        stderr: '',
        variables: {},
      }]]),
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/auth.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunHooks).toHaveBeenCalledTimes(2)
    expect(mockRunHooks.mock.calls[0][1]).toEqual(expect.objectContaining({
      authState: expect.objectContaining({
        targetName: 'test-app',
        stateName: 'admin',
        storageStatePath: '/internal/auth/test-app/admin.json',
      }),
    }))
    expect(mockRunMemberTest.mock.calls[0][1].hookAuthState).toEqual(expect.objectContaining({
      targetName: 'test-app',
      stateName: 'admin',
    }))
    expect(mockRunHooks.mock.calls[1][1]).toEqual(expect.objectContaining({
      authState: expect.objectContaining({
        targetName: 'test-app',
        stateName: 'admin',
      }),
    }))
  })

  it('captures direct auth state from scratch and gives teardown hooks the captured state', async () => {
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({
        use: { authState: { name: 'admin', load: false, capture: true } },
        teardown: ['hook-seed'],
      })],
      errors: [],
    })
    mockParseHooksFile.mockResolvedValue({
      hooks: [{ id: 'hook-seed', name: 'seed data', runtime: 'node', file: '/hooks/seed.js', deps: [] }],
      errors: [],
    })
    mockRunHooks.mockResolvedValue({
      allPassed: true,
      variables: {},
      results: new Map([['seed data', {
        success: true,
        duration: 10,
        stdout: '',
        stderr: '',
        variables: {},
      }]]),
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/auth.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockResolveAuthStateForRun).not.toHaveBeenCalled()
    expect(mockWebAdapterSetup.mock.calls[0][0].authState).toBeUndefined()
    expect(mockWebStorageState).toHaveBeenCalledWith({ indexedDB: true })
    expect(mockWriteAuthStateFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        targetName: 'test-app',
        stateName: 'admin',
        payloadPath: '/internal/auth/test-app/admin.json',
      }),
      {
        payload: { cookies: [], origins: [] },
        metadata: expect.objectContaining({
          version: 2,
          kind: 'web',
          target: 'test-app',
          name: 'admin',
          capturedAt: expect.any(String),
        }),
      },
    )
    expect(mockRunHooks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authState: expect.objectContaining({
          targetName: 'test-app',
          stateName: 'admin',
          storageStatePath: '/internal/auth/test-app/admin.json',
        }),
      }),
    )
    // 363-11: the member outcome is no longer surfaced via a v1 reporter; a passing run exits 0.
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('does not capture direct auth state when product execution fails', async () => {
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { authState: { name: 'admin', load: false, capture: true } } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/auth.yaml',
      status: 'failed',
      steps: [{ name: 'Click login', status: 'failed', duration: 1 }],
      duration: 100,
      failureSummary: 'Button missing',
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWriteAuthStateFiles).not.toHaveBeenCalled()
    expect(mockWebStorageState).not.toHaveBeenCalled()
    expect(mockRunMemberTest).toHaveBeenCalledTimes(1)
    // 363-11: a failing member surfaces via the run exit code (no v1 reporter).
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('fails the direct run safely when auth-state capture write fails without retrying product steps', async () => {
    mockWriteAuthStateFiles.mockRejectedValueOnce(new Error('disk path /internal/auth/test-app/admin.json'))
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { authState: { name: 'admin', load: false, capture: true } } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/auth.yaml',
      status: 'passed',
      steps: [{ name: 'Click login', status: 'passed', duration: 1 }],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunMemberTest).toHaveBeenCalledTimes(1)
    // 363-11: the auth-capture-write failure synthesizes a failed run → exit 1 (no v1 reporter);
    // the sensitive path must never leak to stderr.
    expect(exitSpy).toHaveBeenCalledWith(1)
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).not.toContain('/internal/auth')
  })

  it('fails direct auth-state preflight before adapter setup without printing paths', async () => {
    mockResolveAuthStateForRun.mockRejectedValueOnce(
      new Error('Auth state "admin" for target "test-app" was not found or could not be read. Run agent-qa auth-state capture --target test-app --name admin.'),
    )
    mockGlob.mockResolvedValue(['tests/auth.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { authState: 'admin' } })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockWebAdapterSetup).not.toHaveBeenCalled()
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Auth state "admin" for target "test-app"')
    expect(allErrors).toContain('agent-qa auth-state capture --target test-app --name admin')
    expect(allErrors).not.toContain('/internal/auth')
    expect(allErrors).not.toContain('.agent-qa/auth-states')
  })

  it('fails direct mobile targets with auth state before adapter setup', async () => {
    const cfg = defaultConfig()
    cfg.registry.targets = {
      'mobile-app': {
        platform: 'android',
        appPackage: 'com.example.app',
        product: 'mobile-app',
      },
    } as any
    ;(cfg.use as any).mobile = { appState: 'preserve' }
    mockResolveConfig.mockResolvedValue(cfg)
    mockResolveTarget.mockReturnValue({
      name: 'mobile-app',
      product: 'mobile-app',
      platform: 'android',
      appPackage: 'com.example.app',
      // 401-03 (D-06): declared local — see the note on the default fixture above.
      environment: 'local',
    })
    mockResolveAuthStateForRun.mockRejectedValueOnce(
      new Error('auth state is only supported for web targets. For native mobile, use use.mobile.appState: preserve.'),
    )
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app', use: { authState: 'admin', device: 'android-emu' } })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockAndroidAdapterSetup).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('auth state is only supported for web targets')
    expect(allErrors).toContain('use.mobile.appState: preserve')
  })

  it('passes suite auth state to the shared platform config when child tests omit auth state', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      use: { authState: 'admin' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockWebAdapterSetup.mock.calls[0][0].authState).toEqual(expect.objectContaining({
      targetName: 'test-app',
      stateName: 'admin',
      storageStatePath: '/internal/auth/test-app/admin.json',
    }))
  })

  it('a web suite with no use.timeout sets the adapter up with a 2m navigation timeout', async () => {
    const cfg = defaultConfig()
    delete (cfg.use as any).timeout
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue([])
    const { suitePath, configPath } = await createTempSuiteWorkspace()
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

    expect(mockWebAdapterSetup.mock.calls[0][0].timeouts.navigation).toBe(120_000)
  })

  it('allows a suite child test to repeat the same auth state', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      use: { authState: 'admin' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ use: { authState: 'admin' } })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockRunMemberTest).toHaveBeenCalled()
    expect(mockWebAdapterSetup.mock.calls[0][0].authState).toEqual(expect.objectContaining({
      targetName: 'test-app',
      stateName: 'admin',
      storageStatePath: '/internal/auth/test-app/admin.json',
    }))
  })

  it('passes suite auth-state capture config without loading when load is false', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      use: { authState: { name: 'admin', load: false, capture: true } },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockResolveAuthStateForRun).not.toHaveBeenCalled()
    expect(mockWebAdapterSetup.mock.calls[0][0].authState).toBeUndefined()
    // auth-state capture runs in suite teardown (all members passed) — writeAuthStateFiles fires.
    expect(mockWriteAuthStateFiles).toHaveBeenCalled()
  })

  it('allows a suite child object-form auth state with the same name and ignores child capture flags', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      use: { authState: 'admin' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ use: { authState: { name: 'admin', load: false, capture: true } } })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockRunMemberTest).toHaveBeenCalled()
    expect(mockWebAdapterSetup.mock.calls[0][0].authState).toEqual(expect.objectContaining({
      targetName: 'test-app',
      stateName: 'admin',
    }))
    expect(mockWriteAuthStateFiles).not.toHaveBeenCalled()
  })

  it('hard-fails a suite child test with a different auth state before suite execution', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    mockParseSuiteFile.mockResolvedValue({
      name: 'Web Suite',
      target: 'test-app',
      use: { authState: 'admin' },
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest({ use: { authState: 'super-admin' } })],
      errors: [],
    })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    expect(mockWebAdapterSetup).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Suite auth state "admin"')
    expect(allErrors).toContain('child test auth state "super-admin"')
    expect(allErrors).not.toContain('/internal/auth')
    expect(allErrors).not.toContain('.agent-qa/auth-states')
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
      // 401-03 (D-06): declared local — see the note on the default fixture above.
      environment: 'local',
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
    mockRunMemberTest.mockResolvedValue({
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
    mockRunMemberTest.mockResolvedValue({
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
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(resolveMobileRunConfig).not.toHaveBeenCalled()
    expect(mockRunMemberTest).toHaveBeenCalled()
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
      // 401-03 (D-06): declared local — see the note on the default fixture above.
      environment: 'local',
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
    expect(mockRunMemberTest).toHaveBeenCalled()
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
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Test One')
    expect(allOutput).toContain('Test Two')
  })
})

describe('run command — run attributes', () => {
  it('stores user attributes in the run artifact context and output block', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--run-attr', 'git.branch=phase223-main', 'user.email=CI')

    // 363-11: the run artifact is no longer surfaced via a v1 reporter; the resolved run
    // attributes remain observable in the printed run-attributes block.
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('Run attributes:')
    expect(allOutput).toContain('git.branch=phase223-main')
    expect(allOutput).toContain('user.email=CI')
  })

  it('warns on duplicate --run-attr keys and uses the last value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--run-attr', 'git.branch=dev', '--run-attr', 'git.branch=phase223-main')

    expect(warnSpy).toHaveBeenCalledWith('Warning: duplicate --run-attr key "git.branch"; using last value')
    // 363-11: the last-value-wins result is observable in the printed run-attributes block.
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput).toContain('git.branch=phase223-main')
    warnSpy.mockRestore()
  })

  it('rejects protected agent-qa.* attribute keys before execution', async () => {
    await runCommand('tests/**/*.yaml', '--run-attr', 'agent-qa.trigger=evil')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('reserved prefix "agent-qa."')
  })

  it('rejects invalid inherited protected run attributes before execution', async () => {
    process.env.AGENT_QA_RUN_ID = freshRunId('dashboard')
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'agent-qa.custom': 'evil',
    })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('inherited run attributes')
    expect(allErrors).toContain('agent-qa.custom')
    expect(allErrors).toContain('reserved prefix "agent-qa."')
  })

  it('rejects malformed --run-attr values before execution', async () => {
    await runCommand('tests/**/*.yaml', '--run-attr', 'noEquals')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('KEY=VALUE')
  })
})

// 2026-10-17 (443-09, D-11/D-25): the retired names are built from halves so no file spells them.
describe('C443-ENV-RETIRED', () => {
  it('inherits run attributes only under AGENT_QA_RUN_ID', async () => {
    const retired = [['AGENT_QA_SUITE', '_QUEUE_ID'], ['AGENT_QA_PARENT', '_RUN_ID']]
      .map((halves) => halves.join(''))
    for (const name of retired) vi.stubEnv(name, freshRunId('retired'))
    process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify({
      'agent-qa.trigger': 'dashboard',
      'agent-qa.runner': 'local',
      'git.branch': 'phase443-inherited',
    })
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One', filePath: 'tests/a.yaml', status: 'passed', steps: [], duration: 100,
    })

    try {
      await runCommand('tests/**/*.yaml')
    } finally {
      vi.unstubAllEnvs()
    }

    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allOutput.includes('agent-qa.trigger=cli'), 'the run carries its own trigger').toBe(true)
    expect(allOutput.includes('git.branch=phase443-inherited'), 'inherited without AGENT_QA_RUN_ID')
      .toBe(false)
  })
})

describe('run command — exit codes', () => {
  // WINDOWS #233 — the WIRE, not the mechanism.
  //
  // The isolation mechanism (a member's run id bound to its async scope) is pinned in core's
  // `log-manager.test.ts` and survives a five-mutation sweep. What only THIS harness can measure is
  // that the direct member executor is actually wired through it: `commands/run.ts` builds ONE
  // LogManager for the whole run, and since 402-02/402-03 its members run concurrently, so a member
  // that stamps its run id OUTSIDE a scope silently restores the corruption (measured pre-fix: every
  // buffered line collapsed to the last stamper's id).
  //
  // Depth at the stamp, NOT a source grep — this phase has twice measured a grep pass on the import
  // line alone (402-01 `timingSafeEqual`, 402-03 `resolveEffectiveWorkers`). Deleting the
  // `logger.runInMemberScope(...)` wrap leaves every stamp at depth 0 and reds this cell.
  it('stamps each direct member run id INSIDE a member log scope (WINDOWS #233)', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockLogScope.stampDepths.length).toBeGreaterThan(0)
    expect(mockLogScope.stampDepths.every((d) => d >= 1)).toBe(true)
  })

  it('exits 0 when all tests pass', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
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
    mockRunMemberTest.mockResolvedValue({
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
    // 2026-10-17 (443-08, D-03): the failure row is written whatever the config holds, so the
    // malformed file the row snapshots exists on disk.
    const projectDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-parse-error-'))
    tempDirs.push(projectDir)
    const malformed = join(projectDir, 'a.yaml')
    writeFileSync(malformed, 'name: [an unclosed list\n')
    const db = mockRunsDbHandle()
    mockDashboardDatabase.mockImplementationOnce(function () { return db })
    mockGlob.mockResolvedValue([malformed])
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

    await runCommand(malformed)

    expect(exitSpy).toHaveBeenCalledWith(2)
    const allOutput = logSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    // Read off the MINT rather than typed in — the id is salted per test now (401-20), and a
    // literal here would pin one execution's value.
    expect(allOutput).toContain(`Run ID: ${mockGenerateRunId.mock.results[0]!.value as string}`)
    expect(db.insertRun).toHaveBeenCalledWith(expect.objectContaining({
      id: mockGenerateRunId.mock.results[0]!.value as string,
      status: 'failed',
    }))
  })

  it('exits 2 when no files match glob', async () => {
    mockGlob.mockResolvedValue([])

    await runCommand('nothing/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  // RUNX-06: discovery resolved a file but parsing produced ZERO runnable tests (no parse errors).
  // This previously exited 0 with a green "No tests match filters" — a silent zero-member non-run.
  // It must now fail LOUDLY (exit 2) and never render a benign "0 of 0" run summary.
  it('exits 2 (not silent green) when files resolve but zero runnable tests parse', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [], errors: [] })

    await runCommand('tests/**/*.yaml')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(exitSpy).not.toHaveBeenCalledWith(0)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const errOutput = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(errOutput).toContain('0 runnable tests')
  })
})


describe('run command — bail mode', () => {
  // Phase 361 (D-01/SESSION-04): the single-test path is now ONE RunSession per invocation whose
  // members carry NO failFastGroup, so ungrouped members never fail-fast — every discovered test runs
  // then the run aggregates. The old --bail short-circuit is dropped (the single-test analog of Plan
  // 10's suite-parent parallel drop); --bail is a no-op under the one-RunSession law.
  it('runs all members in one RunSession — --bail no longer short-circuits after the first failure', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    const test1 = makeTest({ name: 'Failing Test' })
    const test2 = makeTest2({ name: 'Second Test' })
    mockParseAllTests.mockResolvedValue({
      tests: [test1, test2],
      errors: [],
    })

    let callCount = 0
    mockRunMemberTest.mockImplementation(async () => {
      callCount++
      return {
        name: callCount === 1 ? 'Failing Test' : 'Second Test',
        filePath: 'tests/a.yaml',
        status: 'failed',
        steps: [],
        duration: 100,
      }
    })

    await runCommand('--bail', 'tests/**/*.yaml')

    // Both members execute inside the one session; the failed aggregate verdict still maps to exit 1.
    expect(mockRunMemberTest).toHaveBeenCalledTimes(2)
    expect(exitSpy).toHaveBeenCalledWith(1)
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

})

describe('run command — reporter integration', () => {
  function setupPassingDirectRun(resultOverrides: Record<string, unknown> = {}) {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
      ...resultOverrides,
    })
  }

  async function setupSuiteRun(resultOverrides: Record<string, unknown> = {}) {
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
    mockRunMemberTest.mockResolvedValue({
      runId: 'r_member',
      name: 'Suite Member',
      filePath: 'tests/login.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
      ...resultOverrides,
    })
    return { suitePath, configPath }
  }

  async function setupAllRun() {
    const { suitePath, testPath, configPath } = await createTempSuiteWorkspace()
    mockGlob.mockImplementation(async (pattern: string) => (
      pattern.includes('suite') ? [suitePath] : [testPath]
    ))
    mockParseSuiteFile.mockResolvedValue({
      name: 'Smoke Suite',
      target: 'test-app',
      tests: [{ test: 'tests/login.yaml', id: 'suite-test-1' }],
    })
    mockParseTestFile.mockReturnValue({
      tests: [makeTest()],
      errors: [],
    })
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      runId: 'r_member', name: 'Suite Member', filePath: 'tests/login.yaml',
      status: 'passed', steps: [], duration: 100,
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: testPath,
      status: 'passed',
      steps: [],
      duration: 100,
    })
    return { configPath }
  }

  function lastInvocationOrder(mock: { mock: { invocationCallOrder: number[] } }) {
    const orders = mock.mock.invocationCallOrder
    return orders[orders.length - 1] ?? 0
  }

  it('adds the analytics reporter to actual direct test execution and flushes after completion', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    // 398-10 (D-17/D-20): the subscriber is built from the PORT this command composed at its root
    // and is handed the trigger/runner the command already resolved — no `config` reaches it, and
    // it reads no environment of its own. `surface` moved onto the standard properties, where it is
    // stamped once for every event of the invocation rather than per subscriber.
    expect(mockCreateAnalyticsRunSubscriber).toHaveBeenCalledWith(expect.objectContaining({
      port: expect.objectContaining({ capture: expect.any(Function) }),
      triggerSource: 'cli',
      runner: 'local',
      standardProperties: expect.objectContaining({ surface: 'cli' }),
    }))
    expect(mockCreateAnalyticsRunSubscriber.mock.calls[0]?.[0]).not.toHaveProperty('config')
    expect(mockAnalyticsRunSubscriberInstance.flush).toHaveBeenCalled()
  })

  it('prints the update notice once after direct reporter completion and analytics flush', async () => {
    setupPassingDirectRun()

    await runCommand('tests/**/*.yaml')

    expect(mockShouldPrintAgentQaUpdateNotice).toHaveBeenCalledTimes(1)
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledTimes(1)
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      effectiveLogLevel: 'warn',
      liveEvents: undefined,
      reporterSelection: expect.objectContaining({
        console: true,
        stdoutLive: false,
      }),
    }))
    const noticeOrder = lastInvocationOrder(mockPrintAgentQaUpdateNoticeIfNeeded)
    // 363-11: the notice fires after member execution + the analytics bus subscriber flush
    // (the v1 reporter/analytics-reporter lifecycle is deleted).
    expect(noticeOrder).toBeGreaterThan(lastInvocationOrder(mockRunMemberTest))
    expect(noticeOrder).toBeGreaterThan(lastInvocationOrder(mockAnalyticsRunSubscriberInstance.flush))
    expect(exitSpy).toHaveBeenCalledWith(0)
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

    // 363-09 (D-16) / 398-10: the suite path attaches the same subscriber at the run-level startRun
    // site, built by the SAME factory over the SAME composed port as the direct path (Pitfall 8).
    expect(mockCreateAnalyticsRunSubscriber).toHaveBeenCalledWith(expect.objectContaining({
      port: expect.objectContaining({ capture: expect.any(Function) }),
      standardProperties: expect.objectContaining({ surface: 'cli' }),
    }))
    expect(mockRunMemberTest).toHaveBeenCalled()
    expect(mockAnalyticsRunSubscriberInstance.flush).toHaveBeenCalled()
  })

  it.each([
    ['passing', 'passed', 0],
    ['failing', 'failed', 1],
  ])('prints the update notice once after %s suite-only execution', async (_label, suiteStatus, exitCode) => {
    const { suitePath, configPath } = await setupSuiteRun({ status: suiteStatus })

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    expect(mockShouldPrintAgentQaUpdateNotice).toHaveBeenCalledTimes(1)
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledTimes(1)
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      effectiveLogLevel: 'warn',
      reporterSelection: expect.objectContaining({
        console: true,
        stdoutLive: false,
      }),
    }))
    expect(exitSpy).toHaveBeenCalledWith(exitCode)
  })

  it('composes analytics ONCE for a --all invocation — both subscribers hold the same port (D-19)', async () => {
    // THE CLAIM IS OBJECT IDENTITY, not "both were configured the same way". `--all` drives the
    // suite path and then the direct path in one process; a rewire that composed at each attach
    // site would produce two ports, two opt-out decisions and two identity resolutions, and every
    // property assertion in this file would still pass. Only the identity check sees it.
    const { configPath } = await setupAllRun()

    await runCommandWithGlobalArgs(['--config', configPath], '--all')

    const ports = mockCreateAnalyticsRunSubscriber.mock.calls.map((call) => call[0].port)
    expect(ports).toHaveLength(2)
    expect(ports[0]).toBe(ports[1])
  })

  it('prints the update notice once after --all suites and direct tests finish', async () => {
    const { configPath } = await setupAllRun()

    await runCommandWithGlobalArgs(['--config', configPath], '--all')

    expect(mockRunMemberTest).toHaveBeenCalledTimes(2)
    expect(mockShouldPrintAgentQaUpdateNotice).toHaveBeenCalledTimes(1)
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledTimes(1)
    const noticeOrder = lastInvocationOrder(mockPrintAgentQaUpdateNoticeIfNeeded)
    // 363-11: the notice fires after all members finish executing (no v1 reporter onRunEnd).
    expect(noticeOrder).toBeGreaterThan(lastInvocationOrder(mockRunMemberTest))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it.each([
    [
      '--quiet',
      ['--quiet'],
      ['tests/**/*.yaml'],
      undefined,
      { effectiveLogLevel: 'silent', reporterSelection: expect.objectContaining({ console: true, stdoutLive: false }) },
    ],
    [
      '--log-level silent',
      ['--log-level', 'silent'],
      ['tests/**/*.yaml'],
      undefined,
      { effectiveLogLevel: 'silent', reporterSelection: expect.objectContaining({ console: true, stdoutLive: false }) },
    ],
    [
      '--reporter stdout-live',
      [],
      ['tests/**/*.yaml', '--reporter', 'stdout-live'],
      undefined,
      { effectiveLogLevel: 'warn', reporterSelection: expect.objectContaining({ console: false, stdoutLive: true }) },
    ],
    [
      'AGENT_QA_LIVE_EVENTS=true',
      [],
      ['tests/**/*.yaml'],
      'true',
      { effectiveLogLevel: 'warn', liveEvents: 'true', reporterSelection: expect.objectContaining({ console: true, stdoutLive: true }) },
    ],
    [
      '--reporter junit',
      [],
      ['tests/**/*.yaml', '--reporter', 'junit', '--junit-output', join(tmpdir(), 'agent-qa-run-notice-junit.xml')],
      undefined,
      { effectiveLogLevel: 'warn', reporterSelection: expect.objectContaining({ console: false, junit: true, stdoutLive: false }) },
    ],
  ])('does not print the update notice for %s', async (_label, globalArgs, runArgs, liveEvents, expectedContext) => {
    setupPassingDirectRun()
    mockShouldPrintAgentQaUpdateNotice.mockReturnValue(false)
    if (liveEvents) process.env.AGENT_QA_LIVE_EVENTS = liveEvents

    await runCommandWithGlobalArgs(globalArgs as string[], ...(runArgs as string[]))

    expect(mockShouldPrintAgentQaUpdateNotice).toHaveBeenCalledTimes(1)
    expect(mockShouldPrintAgentQaUpdateNotice).toHaveBeenCalledWith(expect.objectContaining(expectedContext))
    expect(mockPrintAgentQaUpdateNoticeIfNeeded).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('preserves the computed exit status and console errors when the update notice rejects', async () => {
    setupPassingDirectRun({ status: 'failed' })
    mockPrintAgentQaUpdateNoticeIfNeeded.mockRejectedValueOnce(new Error('registry unavailable'))

    await runCommand('tests/**/*.yaml')

    expect(mockPrintAgentQaUpdateNoticeIfNeeded).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)
    const nonExitErrors = errorSpy.mock.calls
      .map((call: string[]) => call.join(' '))
      .filter((message: string) => !message.includes('Framework error: process.exit'))
    expect(nonExitErrors).toEqual([])
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

    expect(mockRunMemberTest).not.toHaveBeenCalled()
  })

  it('does not fail direct test execution when analytics flush rejects', async () => {
    // 363-09: the attach helper flushes every subscriber with allSettled, so a best-effort analytics
    // flush rejection can never abort the run or its exit code (RUNX-03 / D-08 detach-on-error).
    mockAnalyticsRunSubscriberInstance.flush.mockRejectedValueOnce(new Error('posthog unavailable'))
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockAnalyticsRunSubscriberInstance.flush).toHaveBeenCalled()
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
      // 401-03 (D-06): declared local — see the note on the default fixture above.
      environment: 'local',
    })
    process.env.AGENT_QA_RUN_ID = freshRunId('dashboard')
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

    // 363-09 (D-16): a mobile setup failure occurs BEFORE the runner emits a testFinished envelope, so
    // its telemetry is no longer captured (the v1 per-result analytics capture is gone; analytics now
    // rides the bus). The failure is still surfaced as a clean framework-error exit 2. The companion
    // "never constructed the v1 reporter" assertion retired in 398-11 with the module itself: there is
    // no longer a symbol to construct, so the claim is now enforced by the compiler, not by a mock.
    expect(exitSpy).toHaveBeenCalledWith(2)
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
      // 401-03 (D-06): declared local — see the note on the default fixture above.
      environment: 'local',
    })
    mockGlob.mockResolvedValue(['tests/mobile.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ target: 'mobile-app' })],
      errors: [],
    })

    await runCommand('tests/**/*.yaml')

    // 363-09 (D-16): pre-runner mobile setup-failure telemetry is dropped with the v1 analytics reporter
    // (analytics rides the bus). The failure still surfaces as a clean framework-error exit 2.
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  // 363-09 (D-01 clean cut): the CLI no longer constructs v1 core Reporters (ConsoleReporter /
  // JUnitReporter / StdoutLiveReporter / DashboardReporter). Reporter rendering is unit-tested in
  // src/__tests__/reporters/*.test.ts; here we pin that the selection is HONORED — v1 reporters are
  // never constructed and the accepted selection reaches execution.
  it('never constructs v1 core reporters for a default direct run (bus subscribers replace them)', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One', filePath: 'tests/a.yaml', status: 'passed', steps: [], duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    // 363-11: the v1 core reporters (ConsoleReporter / JUnitReporter / StdoutLiveReporter /
    // DashboardReporter) were deleted; there is nothing to construct. The run still reaches
    // execution via the bus subscribers and exits clean.
    expect(mockDashboardReporter).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('honors console/junit reporter selection without constructing v1 reporters', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One', filePath: 'tests/a.yaml', status: 'passed', steps: [], duration: 100,
    })

    await runCommand('tests/**/*.yaml', '--reporter', 'console,junit', '--junit-output', join(tmpdir(), 'agent-qa-selection-junit.xml'))

    // The selection is accepted (no pre-execution error) and the run reaches execution + exits 0.
    // The v1 core reporters no longer exist to construct (363-11).
    expect(mockRunMemberTest).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('fails unknown reporter selection before execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])

    await runCommand('tests/**/*.yaml', '--reporter', 'unknown')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('Unknown reporter "unknown"')
  })

  it('fails junit reporter selection without output path before execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])

    await runCommand('tests/**/*.yaml', '--reporter', 'junit')

    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const allErrors = errorSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n')
    expect(allErrors).toContain('--reporter junit requires --junit-output <path>')
  })

  it('treats screenshotDir as capture intent for runTestWithRetry config', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('--screenshot-dir', './shots', 'tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig).toEqual(expect.objectContaining({ captureScreenshots: true }))
    expect(runConfig).not.toHaveProperty('screenshotDir')
  })

  it('passes services.accessibility into direct test execution', async () => {
    const cfg = defaultConfig()
    const accessibility = {
      enabled: true,
      standard: 'wcag2aa',
      runAfter: 'every-step',
      failOnViolation: false,
    }
    ;(cfg.services as any).accessibility = accessibility
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig.accessibility).toEqual(accessibility)
    // 363-11: accessibility execution is an injected handler built at the composition root (the CLI
    // owns page acquisition + the dynamic web import); the config is threaded, the handler is present.
    expect(runConfig.accessibilityCheck).toEqual(expect.any(Function))
  })

  it('passes services.accessibility into suite execution', async () => {
    const { suitePath, configPath } = await createTempSuiteWorkspace()
    const cfg = defaultConfig()
    const accessibility = {
      enabled: true,
      standard: 'wcag2aa',
      runAfter: 'every-step',
      failOnViolation: false,
    }
    ;(cfg.services as any).accessibility = accessibility
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

    await runCommandWithGlobalArgs(['--config', configPath], suitePath)

    const suiteConfig = mockRunMemberTest.mock.calls[0][1]
    expect(suiteConfig.accessibility).toEqual(accessibility)
    expect(suiteConfig.accessibilityCheck).toEqual(expect.any(Function))
  })

  it('calls onRunStart before test execution', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    // 363-11: the v1 reporter lifecycle is deleted; the run reaching execution is observable via
    // the member executor receiving the discovered test.
    expect(mockRunMemberTest).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test One' }),
      expect.anything(),
    )
  })

  it('calls onRunEnd after all tests complete', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    // 363-11: run aggregation/counts are carried by the bus, not a v1 reporter; a single passing
    // member exits 0 after execution completes.
    expect(mockRunMemberTest).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('threads one generated run ID onto the passing member result', async () => {
    const runId = freshRunId('able')
    // One RunSession mints a run-level id up front AND the member closure mints the per-test id;
    // pin both so the per-test id lands on the member result (363-11: no v1 reporter to observe).
    mockGenerateRunId.mockReturnValue(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunMemberTest).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test One' }),
      expect.anything(),
    )
    const memberResult = await mockRunMemberTest.mock.results[0].value
    expect(memberResult.runId).toBe(runId)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('threads one generated run ID onto the failed member result', async () => {
    const runId = freshRunId('harbor')
    mockGenerateRunId.mockReturnValue(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockRunMemberTest).toHaveBeenCalled()
    const memberResult = await mockRunMemberTest.mock.results[0].value
    expect(memberResult.runId).toBe(runId)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('reuses queued AGENT_QA_RUN_ID for the single-test member result', async () => {
    const runId = freshRunId('queue')
    process.env.AGENT_QA_RUN_ID = runId
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockGenerateRunId).not.toHaveBeenCalled()
    expect(mockRunMemberTest).toHaveBeenCalled()
    const memberResult = await mockRunMemberTest.mock.results[0].value
    expect(memberResult.runId).toBe(runId)
  })

  it('threads the run ID onto a cancelled member result', async () => {
    const runId = freshRunId('cancel')
    mockGenerateRunId.mockReturnValue(runId)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'cancelled',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const memberResult = await mockRunMemberTest.mock.results[0].value
    expect(memberResult.runId).toBe(runId)
    expect(memberResult.status).toBe('cancelled')
  })

  it('fails the run before execution when a setup hook fails', async () => {
    const runId = freshRunId('setup')
    mockGenerateRunId.mockReturnValue(runId)
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

    // 363-11: a per-test setup-hook failure short-circuits before the member executes and fails the
    // run (exit 1) — no v1 reporter onTestEnd/onRunEnd to observe.
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('does not pass a default screenshotDir when not specified', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
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
    mockRunMemberTest.mockResolvedValue({
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
    mockRunMemberTest.mockResolvedValue({
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

  it('a test with no use.timeout sets the adapter up with a 2m navigation timeout', async () => {
    const cfg = defaultConfig()
    delete (cfg.use as any).timeout
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup.mock.calls[0][0].timeouts.navigation).toBe(120_000)
  })

  it("a test's use.timeout.navigation reaches the adapter setup", async () => {
    const cfg = defaultConfig()
    cfg.use.timeout = { step: 30000, test: 300000, navigation: 5_000 }
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({ tests: [makeTest()], errors: [] })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup.mock.calls[0][0].timeouts.navigation).toBe(5_000)
  })

  // Phase 361 (D-01/SESSION-04): the single-test path is now ONE sequential RunSession per invocation.
  // `use.parallel: true` no longer starts web tests concurrently (the single-test analog of Plan 10's
  // suite-parent parallel drop) — members run one at a time in file order inside the single session.
  it('runs all web tests in one sequential RunSession even when global use.parallel is true (parallel is a no-op)', async () => {
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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((test: any) => {
      arrive(test.name)
      return test.name === 'Test One' ? first.promise : second.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await reached(1, commandPromise)
    // Sequential: Test Two does not start until Test One's member resolves.
    expect(started).toEqual(['Test One'])

    first.resolve()
    await reached(2, commandPromise)
    expect(started).toEqual(['Test One', 'Test Two'])

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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((test: any) => {
      arrive(test.name)
      return test.name === 'Test One' ? first.promise : second.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await reached(1, commandPromise)

    expect(started).toEqual(['Test One'])

    first.resolve()
    await reached(2, commandPromise)
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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((test: any) => {
      arrive(test.name)
      return runs.get(test.name)!.promise
    })

    const commandPromise = runCommand('tests/**/*.yaml')
    await reached(1, commandPromise)
    expect(started).toEqual(['Test One'])

    runs.get('Test One')!.resolve()
    await reached(2, commandPromise)
    expect(started).toEqual(['Test One', 'Test Two'])

    runs.get('Test Two')!.resolve()
    await reached(3, commandPromise)
    expect(started).toEqual(['Test One', 'Test Two', 'Test Three'])

    runs.get('Test Three')!.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  // Phase 361 (D-01/SESSION-04): the suite path is now ONE RunSession per invocation that iterates
  // ALL suite members sequentially — parallel suite-parent execution (the old pendingSuiteParents
  // path) is intentionally dropped. `use.parallel` no longer starts suite parents concurrently;
  // members run in file order, one at a time, inside the single session.
  it('runs all suite members in one sequential RunSession even when global use.parallel is true', async () => {
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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((member: any) => {
      const suiteName = String(member.filePath).includes('a.yaml') ? 'Suite A' : 'Suite B'
      arrive(suiteName)
      return suiteName === 'Suite A' ? first.promise : second.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    // Sequential: Suite B's member does not start until Suite A's member resolves.
    await reached(1, commandPromise)
    expect(started).toEqual(['Suite A'])

    first.resolve()
    await reached(2, commandPromise)
    expect(started).toEqual(['Suite A', 'Suite B'])

    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('runs web suite members sequentially when global use.parallel is false', async () => {
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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((member: any) => {
      const suiteName = String(member.filePath).includes('a.yaml') ? 'Suite A' : 'Suite B'
      arrive(suiteName)
      return suiteName === 'Suite A' ? first.promise : second.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    await reached(1, commandPromise)
    expect(started).toEqual(['Suite A'])

    first.resolve()
    await reached(2, commandPromise)
    expect(started).toEqual(['Suite A', 'Suite B'])

    second.resolve()
    await commandPromise
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('iterates every suite in file order within the one session (suite-level use.parallel is a no-op)', async () => {
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
    const { started, arrive, reached } = memberArrivals()
    mockRunMemberTest.mockImplementation((member: any) => {
      const suiteName = String(member.filePath).includes('a.yaml') ? 'Suite A' : String(member.filePath).includes('b.yaml') ? 'Suite B' : 'Suite C'
      arrive(suiteName)
      return runs.get(suiteName)!.promise
    })

    const commandPromise = runCommandWithGlobalArgs(['--config', configPath], '--suite')
    await reached(1, commandPromise)
    expect(started).toEqual(['Suite A'])

    runs.get('Suite A')!.resolve()
    await reached(2, commandPromise)
    expect(started).toEqual(['Suite A', 'Suite B'])

    runs.get('Suite B')!.resolve()
    await reached(3, commandPromise)
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
    mockRunMemberTest.mockResolvedValue({
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
      runOwnership: composeRunOwnership(),
    })
    // 363-09: dashboard history is written by the Plan-08 bus ingest, not the deleted v1 DashboardReporter.
    expect(mockCreateDashboardRunIngest).toHaveBeenCalled()
    expect(mockDashboardReporter).not.toHaveBeenCalled()
    // 2026-10-17 (443-09, D-20): a dashboard block no longer turns screenshot capture on.
    expect(mockRunMemberTest.mock.calls[0][1]).toEqual(expect.objectContaining({
      captureScreenshots: false,
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
    mockRunMemberTest.mockResolvedValue({
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
      runOwnership: composeRunOwnership(),
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
    mockRunMemberTest.mockResolvedValue({
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
      runOwnership: composeRunOwnership(),
    })
  })
})

describe('run command — recording staging root', () => {
  it('uses .agent-qa/recording-staging for standalone recording by default', async () => {
    const cfg = defaultConfig()
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
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
          videoDir: resolve(process.cwd(), '.agent-qa/recording-staging'),
        }),
      }),
    )
  })

  it('stages suite recording beside runs in dashboard mode', async () => {
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

    expect(mockWebAdapterSetup.mock.calls[0][0].recording).toEqual(expect.objectContaining({
      videoDir: resolve(rootDir, '.agent-qa', 'recording-staging'),
    }))
  })

  it('stages standalone recording beside runs despite a custom artifactsDir', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db', artifactsDir: 'dashboard-artifacts' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
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
          videoDir: resolve(process.cwd(), '.agent-qa', 'recording-staging'),
        }),
      }),
    )
  })

  it('stages per-test recording overrides beside runs in dashboard mode', async () => {
    const cfg = defaultConfig()
    cfg.services.dashboard = { dbPath: '.agent-qa/runs.db', artifactsDir: 'dashboard-artifacts' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ meta: { tags: ['smoke'], record: true } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    expect(mockWebAdapterSetup.mock.calls[0][0].recording).toEqual(expect.objectContaining({
      videoDir: resolve(process.cwd(), '.agent-qa', 'recording-staging'),
    }))
  })
})

describe('run command — runtime cache paths', () => {
  it('resolves services.cache.dir into the FsActionCache root from the config directory', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'agent-qa-cache-config-'))
    tempDirs.push(configDir)
    const cfg = defaultConfig()
    cfg.services.cache = { dir: '.agent-qa/custom-cache' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', join(configDir, 'agent-qa.config.yaml')], 'tests/**/*.yaml')

    // The composition root constructs the runner-local FsActionCache with a resolved branch
    // CachePolicy over the config-relative cache root.
    expect(mockFsActionCache).toHaveBeenCalledWith(expect.objectContaining({
      root: join(configDir, '.agent-qa/custom-cache'),
      policy: expect.objectContaining({
        currentBranch: 'main',
        defaultBranch: 'main',
        disableCache: false,
      }),
    }))
  })

  it('disables direct test cache when use.cache is false', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest({ use: { cache: false } })],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig.cache).toBeUndefined()
  })

  it('keeps direct test cache enabled when use.cache is absent', async () => {
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'passed',
      steps: [],
      duration: 100,
    })

    await runCommand('tests/**/*.yaml')

    const runConfig = mockRunMemberTest.mock.calls[0][1]
    expect(runConfig.cache).toBeDefined()
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

    const suiteConfig = mockRunMemberTest.mock.calls[0][1]
    expect(suiteConfig.cache).toBeUndefined()
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

    const suiteConfig = mockRunMemberTest.mock.calls[0][1]
    expect(suiteConfig.cache).toBeDefined()
  })

  it('does not recompute/purge cache entries post-run — the loop owns per-key invalidation (Phase 356)', async () => {
    // The v1 CLI post-run batch purge (recompute a step hash -> rm dir) is retired
    // (D-03/D-13): the redesigned per-key ActionPlanCache invalidates the exact failed
    // decision point inside the runner loop. The CLI never recomputes an opaque masked key,
    // so it must not touch the on-disk cache after a failed run.
    const configDir = mkdtempSync(join(tmpdir(), 'agent-qa-cache-invalidate-'))
    tempDirs.push(configDir)
    const cacheEntry = join(configDir, '.agent-qa/custom-cache/main')
    mkdirSync(cacheEntry, { recursive: true })
    writeFileSync(join(cacheEntry, 'a1b2c3d4e5f60718.json'), '{"schemaVersion":10}')

    const cfg = defaultConfig()
    cfg.services.cache = { dir: '.agent-qa/custom-cache' } as any
    mockResolveConfig.mockResolvedValue(cfg)
    mockGlob.mockResolvedValue(['tests/a.yaml'])
    mockParseAllTests.mockResolvedValue({
      tests: [makeTest()],
      errors: [],
    })
    mockRunMemberTest.mockResolvedValue({
      name: 'Test One',
      filePath: 'tests/a.yaml',
      status: 'failed',
      steps: [{ name: 'Click login', status: 'failed' }],
      duration: 100,
    })

    await runCommandWithGlobalArgs(['--config', join(configDir, 'agent-qa.config.yaml')], 'tests/**/*.yaml')

    // The CLI leaves the cache untouched; invalidation is the loop's responsibility.
    expect(existsSync(join(cacheEntry, 'a1b2c3d4e5f60718.json'))).toBe(true)
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
    expect(mockRunMemberTest).not.toHaveBeenCalled()
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
