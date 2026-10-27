import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

const {
  mockGlob,
  mockParseAllTests,
  mockParseHooksFile,
  mockHookExecute,
  mockRunMemberTest,
  mockResolveConfig,
  mockResolveTarget,
  mockCreateModel,
  mockLLMPlanner,
  mockLLMVerifier,
  mockMultiReporterInstance,
  mockCreateAnalyticsRunSubscriber,
  mockWebAdapterCleanup,
  mockFsHandoffStore,
  mockNextBuildOrdinal,
  mockFsActionCache,
  mockFsStorageStateStore,
  mockResolveBranch,
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
  const analyticsRunSubscriber = {
    handler: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  }

  return {
    mockCreateAnalyticsRunSubscriber: vi.fn(function () { return analyticsRunSubscriber }),
    mockGlob: vi.fn(),
    mockParseAllTests: vi.fn(),
    mockParseHooksFile: vi.fn(),
    mockHookExecute: vi.fn(),
    mockRunMemberTest: vi.fn(),
    mockResolveConfig: vi.fn(),
    mockResolveTarget: vi.fn(),
    mockCreateModel: vi.fn(() => ({})),
    mockLLMPlanner: vi.fn(function () { return {} }),
    mockLLMVerifier: vi.fn(function () { return {} }),
    mockMultiReporterInstance: multiReporter,
    mockWebAdapterCleanup: vi.fn(),
    mockFsHandoffStore: vi.fn(function () { return { save: vi.fn() } }),
    mockNextBuildOrdinal: vi.fn(async () => 1),
    mockFsActionCache: vi.fn(function () { return { get: vi.fn(), set: vi.fn(), invalidate: vi.fn() } }),
    mockFsStorageStateStore: vi.fn(function () { return { save: vi.fn(), load: vi.fn() } }),
    mockResolveBranch: vi.fn(() => ({ currentBranch: 'main', defaultBranch: 'main' })),
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
  // runHooks stays the REAL runner export: the cells measure what it publishes on the run's bus.
  return { ...actual, LLMPlanner: mockLLMPlanner, LLMVerifier: mockLLMVerifier, runMemberTest: mockRunMemberTest }
})

// The run's event log is the real FsEventLog, so the cells read the run's own events.jsonl. Only
// the sealed container is faked, at the DockerHookExecutor seam.
vi.mock('@vostride/agent-qa-runner-local', async (importOriginal) => ({
  FsEventLog: (await importOriginal<typeof import('@vostride/agent-qa-runner-local')>()).FsEventLog,
  FsActionCache: mockFsActionCache,
  FsStorageStateStore: mockFsStorageStateStore,
  resolveBranch: mockResolveBranch,
  FsHandoffStore: mockFsHandoffStore,
  // 363-06: buildRunPorts + buildScreenshotCompressor construct these; legs never exercised here.
  FsRunArtifactStore: class { stage(): void {} finalize(): void {} },
  // 367-13 CASS-02: buildRunPorts also constructs the run-scoped evidence artifact store.
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
  DockerHookExecutor: class { async execute(hook: unknown, ctx: unknown) { return mockHookExecute(hook, ctx) } },
  // The run composition's `runDirFor` roots the run's own directory via the shared run-dir slug —
  // expose both so the mock stays complete.
  RUNS_SUBDIR: 'runs',
  slugBranch: (name: string) => String(name),
}))

// 390-08: `workspaceRelativeIdentityPath` is pulled from the REAL module rather than stubbed — it
// decides the bytes the committed quarantine ledger keys on, and a stub would leave these pins
// measuring the test's idea of identity instead of the shipped one.
// 398-10: the run command composes its analytics at the root now, and the binding stamps
// `agent_qa_version` on every event from the SHIPPED reader. Passed through from the real module for
// the same reason `workspaceRelativeIdentityPath` is — a stub would be a second answer to a question
// the product already answers, and here it would be a version the closed union's semver refuses.
// 398-10 (D-17/D-20): the run-completion subscriber comes from the analytics package now; only that
// factory is replaced, so this command's composition root still makes the real opt-out decision.
vi.mock('@vostride/agent-qa-analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vostride/agent-qa-analytics')>()
  return { ...actual, createAnalyticsRunSubscriber: mockCreateAnalyticsRunSubscriber }
})

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  workspaceRelativeIdentityPath:
    (await importOriginal<typeof import('@vostride/agent-qa-core')>()).workspaceRelativeIdentityPath,
  getAgentQaVersion:
    (await importOriginal<typeof import('@vostride/agent-qa-core')>()).getAgentQaVersion,
  // The two run-attribute KEYS, from the real module: `run.ts` reads the resolved attributes to
  // tell the subscriber this run's trigger and runner, and a stubbed key would silently look up
  // nothing — the subscriber would then normalise a missing value to `unknown` and this file would
  // be measuring that rather than the wiring.
  ATTR_TRIGGER: (await importOriginal<typeof import('@vostride/agent-qa-core')>()).ATTR_TRIGGER,
  ATTR_RUNNER: (await importOriginal<typeof import('@vostride/agent-qa-core')>()).ATTR_RUNNER,
  DEFAULT_AGENT_QA_ARTIFACTS_DIR: '.agent-qa/artifacts',
  // 395-08: `commands/scaffold-content.ts` — D-04's one scaffold producer — reads this, and it is
  // now in this command's module graph through the composition root.
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNS_DB_PATH: '.agent-qa/runs.db',
  DEFAULT_AGENT_QA_SCREENSHOTS_DIR: '.agent-qa/artifacts/screenshots',
  DEFAULT_AGENT_QA_VIDEOS_DIR: '.agent-qa/artifacts/videos',
  AUTH_STATE_SCHEMA_VERSION: 2,
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
  formatParseError: vi.fn((err: any) => `${err.file}:${err.line}:${err.column}: ${err.message}`),
  parseHooksFile: mockParseHooksFile,
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
  resolveAuthStateForRun: vi.fn(),
  resolveAuthStatePaths: vi.fn(),
  writeAuthStateFiles: vi.fn(),
  resolveLLMAuth: vi.fn(async () => ({
    kind: 'api-key',
    credentialKey: 'default',
    provider: 'anthropic-subscription',
    apiKey: 'test-key',
  })),
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
  LogManager: vi.fn(function () {
    return {
      // WINDOWS #233: faithful pass-through — the real one binds a per-member run id here.
      runInMemberScope: vi.fn(async (fn: () => unknown) => await fn()),
      setRunId: vi.fn(),
      setCurrentStep: vi.fn(),
      clearCurrentStep: vi.fn(),
      createScopedLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    }
  }),
  ConsoleReporter: vi.fn(function () { return {} }),
  JUnitReporter: vi.fn(function () { return {} }),
  MultiReporter: vi.fn(function () { return mockMultiReporterInstance }),
  resolveKnowledgeRoot: vi.fn((knowledge: { dir?: string } | undefined, configDir: string) =>
    path.resolve(configDir, knowledge?.dir ?? 'agent-qa-knowledge')),
  // 401-20 (CR-04): a fresh id per CALL — a colliding caller-named run id is now refused, and this
  // fixture writes a real run directory that survives the process, so a constant would collide on
  // the second execution of this file. No cell here compares two mints, so per-call is enough.
  generateRunId: vi.fn(((): (() => string) => {
    let ordinal = 0
    return () => {
      ordinal += 1
      return `r_able-baker-charlie-delta-echo-${process.pid.toString(36)}-${ordinal.toString(36)}`
    }
  })()),
  isCanonicalRunId: (value: string): boolean => /^r_/.test(value),
  resolveWorkspacePaths: vi.fn(({ config, configPath }: any) => {
    const configDir = String(configPath).includes('/')
      ? String(configPath).split('/').slice(0, -1).join('/')
      : process.cwd()
    for (const key of ['testMatch', 'suiteMatch', 'hooksFile', 'envFile', 'secretsFile']) {
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

// 2026-10-17 (443-08, D-03): every run opens its record; these cells read hooks, not runs.db rows.
vi.mock('@vostride/agent-qa-dashboard', () => ({
  resolveDashboardDbPath: ({ configDir }: { configDir: string }) => `${configDir}/.agent-qa/runs.db`,
  DashboardDatabase: vi.fn(function () {
    return { close: vi.fn(), getRun: vi.fn(), readRunOwner: vi.fn(), isOwnStamp: vi.fn(), finalizeOwnRun: vi.fn() }
  }),
  createDashboardRunIngest: vi.fn(function (deps: { runId: string; onRunCreated?: (runId: string) => void }) {
    deps.onRunCreated?.(deps.runId)
    return { handler: vi.fn(), stageSnapshots: vi.fn(), finalize: vi.fn(async () => {}) }
  }),
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
  loadConfigPlugins: vi.fn(async () => {}),
  mergeWithTestConfig: vi.fn((...args: any[]) => args[0]),
  mergeUseBlocks: vi.fn((...args: any[]) => args[0] ?? {}),
  formatConfigDebug: vi.fn(() => ''),
  loadEnvOverrides: vi.fn(() => ({})),
}))

vi.mock('../targets.js', () => ({
  resolveTarget: mockResolveTarget,
}))

import { createRunCommand } from '../commands/run.js'

const SETUP_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const TEARDOWN_HOOK_ID = 'h_kettle-lemon-maple-nectar-orchid-pepper-quartz-river-saddle-timber'
const TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const SECRET = 'SECRET-433'

function defaultConfig() {
  return {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      testPathIgnore: [] as string[],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.secrets.local',
    },
    services: {
      cache: { dir: '.agent-qa/cache' },
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
      planner: { maxActions: 50, maxPlanningTurns: 50, previousStepCount: 3 },
      logCapture: { console: true, network: true },
    },
  }
}

function hookedTest() {
  return {
    'test-id': TEST_ID,
    name: 'Hooked run test',
    target: 'test-app',
    steps: ['Verify {{env:HN_FIRST_STORY_TITLE}} is shown'],
    setup: [SETUP_HOOK_ID],
    teardown: [TEARDOWN_HOOK_ID],
  }
}

function hookOk(stdout: string, variables: Record<string, string> = {}) {
  return { success: true, variables, output: stdout, stdout, stderr: '', duration: 5 }
}

type Envelope = { seq: number; type: string; payload: Record<string, unknown> }

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
    environment: 'local',
  })
  mockGlob.mockResolvedValue(['tests/hooked.yaml'])
  mockParseAllTests.mockResolvedValue({ tests: [hookedTest()], errors: [] })
  mockParseHooksFile.mockResolvedValue({
    hooks: [
      {
        id: SETUP_HOOK_ID,
        name: 'Fetch first Hacker News story',
        runtime: 'ts',
        file: '/project/hooks/fetch.ts',
        deps: [],
        timeout: 30000,
        network: true,
      },
      {
        id: TEARDOWN_HOOK_ID,
        name: 'Clean up',
        runtime: 'ts',
        file: '/project/hooks/cleanup.ts',
        deps: [],
        timeout: 30000,
        network: false,
      },
    ],
    errors: [],
  })
  mockHookExecute.mockImplementation(async (hook: { id: string }) =>
    hook.id === SETUP_HOOK_ID
      ? hookOk(`setup ran ${SECRET}`, { HN_FIRST_STORY_TITLE: 'x' })
      : hookOk('teardown ran'))
  mockRunMemberTest.mockResolvedValue({
    name: 'Hooked run test',
    filePath: 'tests/hooked.yaml',
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
  tempDir = await mkdtemp(path.join(tmpdir(), 'agent-qa-433-hooked-run-'))
  await writeFile(path.join(tempDir, 'hooks.yaml'), 'hooks: []\n', 'utf-8')
  await writeFile(path.join(tempDir, 'agent-rules.md'), '', 'utf-8')
  await writeFile(path.join(tempDir, '.env'), '', 'utf-8')
  await writeFile(path.join(tempDir, '.secrets.local'), `HN_API_TOKEN=${SECRET}\n`, 'utf-8')
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

async function runEvents(): Promise<Envelope[]> {
  const runsDir = path.join(tempDir, '.agent-qa', 'runs')
  const runDirs = await readdir(runsDir)
  expect(runDirs).toHaveLength(1)
  const raw = await readFile(path.join(runsDir, runDirs[0]!, 'events.jsonl'), 'utf-8')
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Envelope)
}

function hookEvents(events: Envelope[], phase: string) {
  return events.filter((e) => (e.type === 'hookStarted' || e.type === 'hookFinished') && e.payload.phase === phase)
}

describe('C433-HOOKED-RUN-EVENTS: a test\'s own hooks are part of its run\'s record (G-433-8, F-433-35)', () => {
  it('C433-HOOKED-RUN-EVENTS: a test\'s setup hook is on the run\'s bus', async () => {
    await runCommand('tests/**/*.yaml')

    const events = await runEvents()
    const setup = hookEvents(events, 'setup')
    expect(setup.map((e) => e.type)).toEqual(['hookStarted', 'hookFinished'])
    for (const e of setup) {
      expect(e.payload).toMatchObject({
        hookId: SETUP_HOOK_ID,
        hookName: 'Fetch first Hacker News story',
        phase: 'setup',
        scope: 'test',
        testIndex: 0,
      })
    }
    expect(setup[1]!.payload.status).toBe('passed')
    expect(setup[1]!.payload.variables).toEqual({ HN_FIRST_STORY_TITLE: 'x' })
    const testStarted = events.find((e) => e.type === 'testStarted')
    expect(testStarted).toBeDefined()
    expect(mockRunMemberTest).toHaveBeenCalledTimes(1)
  })

  it('C433-HOOKED-RUN-EVENTS: a test\'s teardown hook is on the run\'s bus', async () => {
    await runCommand('tests/**/*.yaml')

    const events = await runEvents()
    const teardown = hookEvents(events, 'teardown')
    expect(teardown.map((e) => e.type)).toEqual(['hookStarted', 'hookFinished'])
    for (const e of teardown) {
      expect(e.payload).toMatchObject({
        hookId: TEARDOWN_HOOK_ID,
        hookName: 'Clean up',
        phase: 'teardown',
        scope: 'test',
        testIndex: 0,
      })
    }
    expect(teardown[1]!.payload.status).toBe('passed')
    const testFinished = events.find((e) => e.type === 'testFinished')
    expect(testFinished).toBeDefined()
    expect(teardown[1]!.seq).toBeLessThan(testFinished!.seq)
  })

  it('C433-HOOKED-RUN-EVENTS: a failing setup hook is a failed hook event', async () => {
    mockHookExecute.mockImplementation(async (hook: { id: string }) =>
      hook.id === SETUP_HOOK_ID
        ? { success: false, variables: {}, output: '', stdout: 'about to fail', stderr: 'boom', duration: 3, error: 'Hook exited with code 1: boom' }
        : hookOk('teardown ran'))

    await runCommand('tests/**/*.yaml')

    const events = await runEvents()
    const finished = hookEvents(events, 'setup').filter((e) => e.type === 'hookFinished')
    expect(finished).toHaveLength(1)
    expect(finished[0]!.payload).toMatchObject({
      hookId: SETUP_HOOK_ID,
      phase: 'setup',
      scope: 'test',
      testIndex: 0,
      status: 'failed',
      error: 'Hook exited with code 1: boom',
    })
    expect(mockRunMemberTest).not.toHaveBeenCalled()
    const testFinished = events.find((e) => e.type === 'testFinished')
    expect(testFinished?.payload.outcome).toBe('failed')
    expect(String(testFinished?.payload.failureSummary)).toContain('Setup hook "Fetch first Hacker News story" failed')
    expect(events.some((e) => e.type === 'stepFinalized')).toBe(false)
  })

  it('C433-HOOKED-RUN-EVENTS: hook output is masked', async () => {
    await runCommand('tests/**/*.yaml')

    const events = await runEvents()
    const finished = hookEvents(events, 'setup').find((e) => e.type === 'hookFinished')
    expect(finished).toBeDefined()
    expect(String(finished!.payload.stdout)).toContain('setup ran')
    expect(String(finished!.payload.stdout)).not.toContain(SECRET)
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })
})
