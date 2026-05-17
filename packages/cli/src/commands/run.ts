import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { resolveConfig, mergeWithTestConfig, mergeUseBlocks, formatConfigDebug, loadEnvOverrides } from '../config.js'
import { ATTR_RUNNER, ATTR_TRIGGER, buildInternalRunAttributes, DEFAULT_AGENT_QA_ARTIFACTS_DIR, DEFAULT_AGENT_QA_CACHE_DIR, DEFAULT_AGENT_QA_VIDEOS_DIR, formatRunAttributesBlock, generateRunId, mergeRunAttributes, MobileSetupError, parseRunAttrFlags, redactAuthStateValue, resolveAuthStateForRun, resolveMemoryRoot, resolveMobileRunConfig, validateTrustedRunAttributes } from '@vostride/agent-qa-core'
import { discoverWorkspaceFiles, isWorkspacePathMatch, resolveWorkspaceFileTarget, resolveWorkspacePaths } from '@vostride/agent-qa-core'
import type { AgentQaConfig, ResolvedAuthStateForRun, ResolvedMobileRunConfig, ResolvedWorkspacePaths, RunAttributes, RunAttributeRunner, RunAttributeTrigger, WorkspaceFileKind, WorkspaceFileRecord } from '@vostride/agent-qa-core'
import { resolveTarget, type ResolvedTarget } from '../targets.js'
import { resolveDevice, loadLocalBindings, resolveProviderCredentials, type ResolvedDevice } from '../devices.js'
import { applyResolvedAuthToModelConfig, resolveLLMModels, resolveModelAuth } from '../llm-utils.js'
import { formatInstallBrowsersRetryCommand, type BrowserInstallSelection } from './install-browsers.js'
import type { TestDefinition, TestResult, ParseError, PlatformAdapter, PlatformConfig, SuiteDefinition, SuiteResult, RunSuiteConfig, HookDefinition, SandboxRunnerOptions, SecretStore, SecretRedactor } from '@vostride/agent-qa-core'
import { isPathInsideDir } from '@vostride/agent-qa-core'

const RUNTIME_ARTIFACTS_DIR = DEFAULT_AGENT_QA_ARTIFACTS_DIR || '.agent-qa/artifacts'
const RUNTIME_CACHE_DIR = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'
const RUNTIME_VIDEOS_DIR = DEFAULT_AGENT_QA_VIDEOS_DIR || '.agent-qa/artifacts/videos'

let _appiumManager: InstanceType<typeof import('@vostride/agent-qa-dashboard').AppiumManager> | null = null

async function acquireAppium(logLevel: string): Promise<string | undefined> {
  if (process.env.AGENT_QA_APPIUM_URL) return process.env.AGENT_QA_APPIUM_URL
  const { AppiumManager } = await import('@vostride/agent-qa-dashboard')
  if (!_appiumManager) {
    _appiumManager = new AppiumManager({
      logLevel: logLevel === 'debug' ? 'debug' : 'normal',
    })
  }
  await _appiumManager.acquire()
  return _appiumManager.getUrl()
}

function releaseAppium(): void {
  _appiumManager?.release()
}

export async function createPlatformAdapter(
  platform: 'web' | 'android' | 'ios',
): Promise<PlatformAdapter> {
  if (platform === 'android') {
    try {
      const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
      return new AndroidPlatformAdapter()
    } catch {
      throw new Error(
        'Android adapter not available. Install @vostride/agent-qa-android: pnpm add @vostride/agent-qa-android',
      )
    }
  }
  if (platform === 'ios') {
    try {
      const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')
      return new IOSPlatformAdapter()
    } catch {
      throw new Error(
        'iOS adapter not available. Install @vostride/agent-qa-ios: pnpm add @vostride/agent-qa-ios',
      )
    }
  }
  const { WebPlatformAdapter } = await import('@vostride/agent-qa-web')
  return new WebPlatformAdapter()
}

const runWebAccessibilityCheck: NonNullable<RunSuiteConfig['accessibilityCheck']> = async (page, options) => {
  const { runAccessibilityCheck } = await import('@vostride/agent-qa-web')
  return runAccessibilityCheck(page as any, options)
}

export function buildPlatformConfig(
  platform: 'web' | 'android' | 'ios',
  resolvedDevice: ResolvedDevice | undefined,
  timeouts: PlatformConfig['timeouts'],
  globalBrowser?: { name?: string; headless?: boolean; viewport?: { width: number; height: number } },
  logCapture?: { console?: boolean; network?: boolean },
  farmSession?: PlatformConfig['farmSession'],
  mobileResolved?: ResolvedMobileRunConfig,
): PlatformConfig {
  if (platform === 'web') {
    return {
      platform: 'web',
      browser: {
        name: (globalBrowser?.name as 'chromium' | 'firefox' | 'webkit') ?? 'chromium',
        headless: globalBrowser?.headless ?? true,
        viewport: globalBrowser?.viewport,
      },
      timeouts,
      logCapture,
    }
  }
  return {
    platform,
    device: resolvedDevice ? {
      name: resolvedDevice.name,
      platform: resolvedDevice.platform,
      transport: resolvedDevice.transport,
      match: resolvedDevice.match,
    } : undefined,
    bundleId: mobileResolved?.app.bundleId,
    appPackage: mobileResolved?.app.appPackage,
    appActivity: mobileResolved?.app.appActivity,
    deepLinkAppId: mobileResolved?.app.deepLinkAppId,
    appState: mobileResolved?.appState,
    appPath: mobileResolved?.app.install?.path,
    browserstackApp: mobileResolved?.app.install?.browserstack,
    appiumUrl: mobileResolved?.appium.url,
    timeouts,
    logCapture,
    farmSession,
  }
}

type WebBrowserName = 'chromium' | 'firefox' | 'webkit'

interface FormattedFrameworkError {
  displayMessage: string
  failureSummary: string
}

function inferMissingBrowser(message: string): WebBrowserName | null {
  const lower = message.toLowerCase()
  if (/(^|[/\\])webkit-\d/.test(lower) || lower.includes('webkit')) return 'webkit'
  if (/(^|[/\\])firefox-\d/.test(lower) || lower.includes('firefox')) return 'firefox'
  if (/(^|[/\\])chromium-\d/.test(lower) || lower.includes('chromium')) return 'chromium'
  return null
}

function isRawPlaywrightMissingBrowserError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes("executable doesn't exist")
    && lower.includes('playwright')
    && lower.includes('install')
}

function formatBrowserInstallSelection(browserName: WebBrowserName | null): BrowserInstallSelection {
  if (browserName === 'chromium') return { chromium: true }
  if (browserName === 'firefox') return { firefox: true }
  if (browserName === 'webkit') return { webkit: true }
  return { all: true }
}

function browserDisplayName(browserName: WebBrowserName | null): string {
  if (browserName === 'chromium') return 'Chromium'
  if (browserName === 'firefox') return 'Firefox'
  if (browserName === 'webkit') return 'WebKit'
  return 'the selected browser'
}

function formatMissingBrowserFrameworkError(message: string): FormattedFrameworkError | null {
  const browserName = inferMissingBrowser(message)
  const retryCommand = formatInstallBrowsersRetryCommand(formatBrowserInstallSelection(browserName))
  const alreadyFriendly = message.startsWith('agent-qa browser support is not installed')

  if (!alreadyFriendly && !isRawPlaywrightMissingBrowserError(message)) return null

  const displayMessage = alreadyFriendly
    ? message
    : [
      `agent-qa browser support is not installed for ${browserDisplayName(browserName)}.`,
      '',
      'Install the browser managed by agent-qa, then rerun the test:',
      `  ${retryCommand}`,
      '',
      'This can happen after upgrading agent-qa or Playwright because browser binaries live outside the package install.',
    ].join('\n')

  return {
    displayMessage,
    failureSummary: `Browser support missing: run ${retryCommand}`,
  }
}

function formatFrameworkError(message: string): FormattedFrameworkError {
  return formatMissingBrowserFrameworkError(message) ?? {
    displayMessage: `Framework error: ${message}`,
    failureSummary: `Framework error: ${message.slice(0, 200)}`,
  }
}

function resolveDashboardVideoDir(
  config: AgentQaConfig,
  configDir: string,
  dashboardEnabled: boolean,
): string {
  const recordingCfg = config.services?.recording as Record<string, unknown> | undefined
  const configuredVideoDir = recordingCfg?.videoDir as string | undefined
  if (configuredVideoDir) {
    return resolvePath(configDir, configuredVideoDir)
  }
  if (dashboardEnabled) {
    const dashArtifactsDir = (config.services?.dashboard as Record<string, unknown> | undefined)?.artifactsDir as string | undefined
    return resolvePath(configDir, dashArtifactsDir ?? RUNTIME_ARTIFACTS_DIR, 'videos')
  }
  return resolvePath(configDir, RUNTIME_VIDEOS_DIR)
}

interface RunOptions {
  browser?: string
  platform?: string
  headless?: boolean
  cache?: boolean
  memory?: boolean
  bail?: boolean
  dryRun?: boolean
  listTests?: boolean
  junitOutput?: string
  screenshotDir?: string
  screenshotMode?: string
  reporter?: string[]
  record?: boolean
  configDebug?: boolean
  test?: boolean
  suite?: boolean
  all?: boolean
  device?: string
  var?: string[]
  runAttr?: string[]
}

const SUPPORTED_REPORTERS = ['console', 'junit', 'stdout-live', 'dashboard'] as const
type ReporterName = typeof SUPPORTED_REPORTERS[number]

interface ReporterSelection {
  console: boolean
  junit: boolean
  stdoutLive: boolean
  dashboard: boolean
}

interface SecretsFileArtifactMetadata {
  path: string | null
  status: 'loaded' | 'missing' | 'unreadable' | 'invalid'
  count?: number
}

interface RuntimeSecretsContext {
  secretStore: SecretStore
  secretRedactor: SecretRedactor
  secretsFileMetadata: SecretsFileArtifactMetadata
}

function parseVarFlags(flags: string[] | undefined): Record<string, string> {
  if (!flags) return {}
  const vars: Record<string, string> = {}
  for (const kv of flags) {
    const eqIdx = kv.indexOf('=')
    if (eqIdx === -1) {
      console.warn(`Warning: --var "${kv}" missing =, ignored`)
      continue
    }
    vars[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1)
  }
  return vars
}

function resolveRunnerAttribute(transport: string | undefined): RunAttributeRunner {
  return transport === 'browserstack' ? 'browserstack' : 'local'
}

function buildCliRunAttributes(userAttributes: RunAttributes, runner: RunAttributeRunner): RunAttributes {
  return mergeRunAttributes(
    buildInternalRunAttributes({ trigger: 'cli', runner }),
    userAttributes,
  )
}

function readRunAttributesFromEnv(): RunAttributes | undefined {
  const raw = process.env.AGENT_QA_RUN_ATTRIBUTES_JSON
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('inherited run attributes: AGENT_QA_RUN_ATTRIBUTES_JSON must contain valid run attributes JSON')
  }
  const attributes = validateTrustedRunAttributes(parsed, 'inherited run attributes')
  return Object.keys(attributes).length > 0 ? attributes : undefined
}

function resolveCliRunAttributes(
  userAttributes: RunAttributes,
  runner: RunAttributeRunner,
  inheritedAttributes?: RunAttributes,
): RunAttributes {
  if (!inheritedAttributes) return buildCliRunAttributes(userAttributes, runner)
  const trigger = inheritedAttributes[ATTR_TRIGGER] as RunAttributeTrigger | undefined
  const inheritedUserAttributes = Object.fromEntries(
    Object.entries(inheritedAttributes)
      .filter(([key]) => key !== ATTR_TRIGGER && key !== ATTR_RUNNER),
  )
  return mergeRunAttributes(
    buildInternalRunAttributes({ trigger: trigger ?? 'cli', runner }),
    inheritedUserAttributes,
  )
}

function writeRunAttributesToEnv(attributes: RunAttributes): void {
  process.env.AGENT_QA_RUN_ATTRIBUTES_JSON = JSON.stringify(attributes)
}

function printRunAttributes(attributes: RunAttributes | undefined): void {
  if (!attributes || Object.keys(attributes).length === 0) return
  const block = formatRunAttributesBlock(attributes)
  if (block) console.log(block)
}

function resolveReporterSelection(opts: RunOptions, dashboardConfigured: boolean): { selection?: ReporterSelection; error?: string } {
  const requiredDashboard = Boolean(process.env.AGENT_QA_RUN_ID || process.env.AGENT_QA_SUITE_QUEUE_ID)
  const requested = opts.reporter
    ?.flatMap((name) => name.split(','))
    .map((name) => name.trim())
    .filter(Boolean)

  if (!requested?.length) {
    return {
      selection: {
        console: true,
        junit: Boolean(opts.junitOutput),
        stdoutLive: process.env.AGENT_QA_LIVE_EVENTS === 'true',
        dashboard: dashboardConfigured || requiredDashboard,
      },
    }
  }

  for (const name of requested) {
    if (!SUPPORTED_REPORTERS.includes(name as ReporterName)) {
      return { error: `Unknown reporter "${name}". Supported reporters: ${SUPPORTED_REPORTERS.join(', ')}` }
    }
  }

  const selected = new Set(requested as ReporterName[])
  if (selected.has('junit') && !opts.junitOutput) {
    return { error: '--reporter junit requires --junit-output <path>' }
  }

  return {
    selection: {
      console: selected.has('console'),
      junit: selected.has('junit'),
      stdoutLive: selected.has('stdout-live'),
      dashboard: selected.has('dashboard') || requiredDashboard,
    },
  }
}

type AnalyticsRunEndReporter = {
  onRunEnd?: (summary: {
    results: TestResult[]
    duration: number
    passed: number
    failed: number
    skipped: number
  }) => Promise<void> | void
  flush: () => Promise<void>
}

async function flushAnalyticsRunReporter(reporter: { flush: () => Promise<void> } | undefined): Promise<void> {
  if (!reporter) return
  try {
    await reporter.flush()
  } catch {
    // Analytics is best-effort and must not affect run outcomes.
  }
}

async function captureSingleAnalyticsResult(
  reporter: AnalyticsRunEndReporter | undefined,
  result: TestResult,
): Promise<void> {
  if (!reporter?.onRunEnd) {
    await flushAnalyticsRunReporter(reporter)
    return
  }
  try {
    await reporter.onRunEnd({
      results: [result],
      duration: result.duration,
      passed: result.status === 'passed' ? 1 : 0,
      failed: result.status === 'failed' ? 1 : 0,
      skipped: result.status === 'skipped' ? 1 : 0,
    })
  } catch {
    // Analytics is best-effort and must not affect run outcomes.
  }
  await flushAnalyticsRunReporter(reporter)
}

function formatParseErrors(errors: ParseError[]): void {
  for (const err of errors) {
    const location = `${err.file}:${err.line}:${err.column}`
    const severity = err.severity === 'error' ? pc.red('error') : pc.yellow('warning')
    console.error(`${severity}: ${err.message}`)
    console.error(`  ${pc.blue('-->')} ${location}`)
    if (err.source) {
      console.error(`  ${pc.blue('|')} ${err.source}`)
    }
    if (err.suggestion) {
      console.error(`  ${pc.blue('=')} ${pc.bold('help')}: ${err.suggestion}`)
    }
    console.error()
  }
}

function createTestRunId(): string {
  return process.env.AGENT_QA_RUN_ID ?? generateRunId()
}

function createSuiteRunId(): string {
  return process.env.AGENT_QA_SUITE_QUEUE_ID ?? process.env.AGENT_QA_RUN_ID ?? generateRunId()
}

function printRunId(runId: string | null | undefined): void {
  if (runId) console.log(`Run ID: ${runId}`)
}

function printMemoryStatus(log: { added: number; confirmed: number; deprecated: number; errors: string[]; curatorDuration: number }): void {
  const parts: string[] = []
  if (log.added > 0) parts.push(pc.green(`${log.added} added`))
  if (log.confirmed > 0) parts.push(`${log.confirmed} confirmed`)
  if (log.deprecated > 0) parts.push(pc.yellow(`${log.deprecated} deprecated`))
  if (parts.length === 0) parts.push('no changes')
  const secs = log.curatorDuration >= 1000 ? `${Math.round(log.curatorDuration / 1000)}s` : `${log.curatorDuration}ms`
  console.log(`  ${pc.dim('Memory:')} ${parts.join(', ')} ${pc.dim(`(${secs})`)}`)
  for (const err of log.errors) {
    console.log(`  ${pc.dim('Memory:')} ${pc.yellow(`warning -- ${err}`)}`)
  }
}

function isGlobLikePattern(value: string): boolean {
  return /[*?[{]/.test(value)
}

function classifyRunPattern(pattern: string): WorkspaceFileKind {
  return pattern.includes('.suite.') ? 'suite' : 'test'
}

function matchesCliWorkspacePattern(
  workspace: ResolvedWorkspacePaths,
  kind: WorkspaceFileKind,
  pattern: string,
  record: WorkspaceFileRecord,
): boolean {
  const patternWorkspace = {
    ...workspace,
    testMatch: kind === 'test' ? [pattern] : workspace.testMatch,
    suiteMatch: kind === 'suite' ? [pattern] : workspace.suiteMatch,
  }
  return isWorkspacePathMatch({
    workspace: patternWorkspace,
    kind,
    workspaceRelativePath: record.workspaceRelativePath,
  })
}

async function discoverFilesForCliPatterns(
  workspace: ResolvedWorkspacePaths,
  patterns: string[],
): Promise<{ tests: string[]; suites: string[] }> {
  const testRecords = await discoverWorkspaceFiles({ workspace, kind: 'test' })
  const suiteRecords = await discoverWorkspaceFiles({ workspace, kind: 'suite' })
  const discoveredByKind: Record<WorkspaceFileKind, WorkspaceFileRecord[]> = {
    test: testRecords,
    suite: suiteRecords,
  }
  const selectedByKind: Record<WorkspaceFileKind, Map<string, WorkspaceFileRecord>> = {
    test: new Map(),
    suite: new Map(),
  }
  const seenKinds = new Set<WorkspaceFileKind>()

  for (const pattern of patterns) {
    const kind = classifyRunPattern(pattern)
    seenKinds.add(kind)

    if (isGlobLikePattern(pattern)) {
      for (const record of discoveredByKind[kind]) {
        if (matchesCliWorkspacePattern(workspace, kind, pattern, record)) {
          selectedByKind[kind].set(record.workspaceRelativePath, record)
        }
      }
      continue
    }

    const record = await resolveWorkspaceFileTarget({
      workspace,
      kind,
      filePath: pattern,
      requireExisting: true,
    })
    selectedByKind[kind].set(record.workspaceRelativePath, record)
  }

  if (seenKinds.size > 1) {
    throw new Error('Cannot mix suite files and test patterns in the same run')
  }

  return {
    tests: [...selectedByKind.test.values()].map(record => record.absolutePath),
    suites: [...selectedByKind.suite.values()].map(record => record.absolutePath),
  }
}

function buildHooksArtifact(hooks?: Map<string, HookDefinition>): Array<{ id: string; name: string; runtime?: string; sourcePath?: string }> {
  if (!hooks) return []
  return [...hooks.values()].map((hook) => ({
    id: hook.id,
    name: hook.name,
    runtime: (hook as any).runtime,
    sourcePath: (hook as any).path ?? (hook as any).sourcePath,
  }))
}

async function loadRuntimeSecrets(input: {
  config: AgentQaConfig
  configDir: string
  secretsFilePath?: string
  readFileSync: typeof import('node:fs').readFileSync
  existsSync: typeof import('node:fs').existsSync
}): Promise<RuntimeSecretsContext> {
  const configuredSecretsFile = (input.config as any).workspace?.secretsFile
  if (typeof configuredSecretsFile !== 'string' || configuredSecretsFile.trim().length === 0) {
    console.error(pc.red('Error: workspace.secretsFile is required. Run `agent-qa init` or set it in agent-qa.config.yaml.'))
    process.exit(1)
  }

  const secretsPath = input.secretsFilePath ?? resolvePath(input.configDir, configuredSecretsFile)
  if (!input.existsSync(secretsPath)) {
    console.error(pc.red(`Error: Secrets file not found: ${secretsPath}`))
    console.error(pc.dim('Create the file before running tests. It may be empty, but it must exist.'))
    process.exit(1)
  }

  let secretsContent: string
  try {
    secretsContent = input.readFileSync(secretsPath, 'utf-8')
  } catch {
    console.error(pc.red(`Error: Secrets file could not be read: ${secretsPath}`))
    console.error(pc.dim('Check the path and file permissions before running tests.'))
    process.exit(1)
  }

  try {
    const { SecretStore, SecretRedactor } = await import('@vostride/agent-qa-core')
    const secretStore = SecretStore.fromEnvContent(secretsContent)
    return {
      secretStore,
      secretRedactor: new SecretRedactor(secretStore),
      secretsFileMetadata: {
        path: secretsPath,
        status: 'loaded',
        count: secretStore.count(),
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`Error: Secrets file is invalid: ${message}`))
    process.exit(1)
  }
}

function buildRunArtifactContext(input: {
  kind: 'test' | 'suite-parent' | 'suite-child'
  configContent: string
  parsedConfig: unknown
  effectiveConfig: unknown
  envFilePath: string | null
  rawEnvFileContent: string | null
  envFileVars: Record<string, string>
  secretsFileMetadata?: SecretsFileArtifactMetadata | null
  cliVars: Record<string, string>
  inlineVars: Record<string, string>
  hooks?: Map<string, HookDefinition>
  planner: { provider?: string; model?: string }
  verifier: { provider?: string; model?: string }
  platform: 'web' | 'android' | 'ios'
  target: ResolvedTarget
  deviceName?: string
  attributes: RunAttributes
  timeouts: Record<string, unknown>
  cache: Record<string, unknown>
  memory: Record<string, unknown>
  source: Record<string, unknown>
}): { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } } {
  return redactAuthStateValue({
    artifact: {
      kind: input.kind,
      config: {
        rawConfigContent: input.configContent,
        parsedConfig: input.parsedConfig,
        effectiveConfig: input.effectiveConfig,
        envFile: {
          path: input.envFilePath,
          content: input.rawEnvFileContent,
          variables: input.envFileVars,
        },
        secretsFile: input.secretsFileMetadata ?? null,
        cliVars: input.cliVars,
        inlineVars: input.inlineVars,
        hooks: buildHooksArtifact(input.hooks),
        model: {
          planner: input.planner,
          verifier: input.verifier,
        },
        runtime: {
          platform: input.platform,
          targetName: input.target.name,
          deviceName: input.deviceName,
        },
        timeouts: input.timeouts,
        cache: input.cache,
        memory: input.memory,
      },
      source: input.source,
      metadata: {
        attributes: input.attributes,
      },
    },
  }) as { artifact: Record<string, unknown> & { kind: 'test' | 'suite-parent' | 'suite-child' } }
}

export async function resolveDeviceAndFarmSession(
  config: AgentQaConfig,
  deviceName: string | undefined,
  testPlatform: 'web' | 'android' | 'ios',
  testName: string,
  testTimeout?: number,
  preResolvedDevice?: ResolvedDevice,
  localBindingsOverride?: ReturnType<typeof loadLocalBindings>,
  mobileResolved?: ResolvedMobileRunConfig,
): Promise<{ resolvedDevice?: ResolvedDevice; farmSession?: PlatformConfig['farmSession'] }> {
  if (!deviceName || testPlatform === 'web') return {}

  const localBindings = localBindingsOverride ?? loadLocalBindings()
  const resolved = preResolvedDevice ?? resolveDevice(config, deviceName, localBindings)

  if (resolved.transport === 'local') {
    return { resolvedDevice: resolved }
  }

  const credentials = resolveProviderCredentials(resolved.transport, localBindings)
  const { getProvider, registerAllProviders } = await import('@vostride/agent-qa-core')
  registerAllProviders()
  const provider = getProvider(resolved.transport)
  if (!provider) {
    throw new Error(`Farm provider "${resolved.transport}" not found. Available: browserstack`)
  }
  const browserstackApp = mobileResolved?.app.install?.browserstack
  if (!browserstackApp && hasNativeAppIdentity(mobileResolved) && !isBrowserMode(resolved.match)) {
    throw new MobileSetupError({
      category: 'app-install',
      message: `BrowserStack native app target "${mobileResolved?.targetName ?? 'unknown'}" requires app.browserstack; app.path is local-only and is not used as a BrowserStack fallback.`,
      platform: resolved.platform,
      targetName: mobileResolved?.targetName,
      deviceName: resolved.name,
      appId: mobileResolved?.app.deepLinkAppId,
      sourceTrace: mobileResolved?.sourceTrace,
    })
  }
  let farmSession: PlatformConfig['farmSession']
  try {
    farmSession = await provider.resolveMobileCapabilities({
      match: resolved.match,
      platform: resolved.platform,
      credentials,
      testName,
      testTimeout,
      app: browserstackApp,
      appState: mobileResolved?.appState,
      appBaseDir: mobileResolved?.app.install?.browserstackBaseDir,
      appSourceTrace: mobileResolved?.sourceTrace,
    })
  } catch (err) {
    if (err instanceof MobileSetupError) throw err
    if (browserstackApp) {
      throw new MobileSetupError({
        category: 'app-install',
        message: `Failed to resolve BrowserStack app reference: ${err instanceof Error ? err.message : String(err)}`,
        platform: resolved.platform,
        targetName: mobileResolved?.targetName,
        deviceName: resolved.name,
        appId: browserstackApp,
        cause: err,
      })
    }
    throw err
  }
  return { resolvedDevice: resolved, farmSession }
}

function isBrowserMode(match: Record<string, unknown>): boolean {
  return typeof match.browserName === 'string' && match.browserName.trim().length > 0
}

function hasNativeAppIdentity(mobileResolved?: ResolvedMobileRunConfig): boolean {
  const app = mobileResolved?.app
  return Boolean(app?.bundleId || app?.appPackage || app?.appActivity || app?.deepLinkAppId)
}

function wrapMobileSetupError(err: unknown): never {
  if (err instanceof MobileSetupError) {
    throw new Error(`${err.category}: ${err.message}`)
  }
  throw err
}

function resolveMobileRunOrThrow(input: Parameters<typeof resolveMobileRunConfig>[0]): ResolvedMobileRunConfig {
  try {
    return resolveMobileRunConfig(input)
  } catch (err) {
    wrapMobileSetupError(err)
  }
}

function getSelectedAuthStateName(use: Record<string, unknown> | undefined): string | undefined {
  const authState = use?.authState
  return typeof authState === 'string' && authState.trim().length > 0 ? authState : undefined
}

async function resolveSelectedAuthStateForRun(input: {
  config: AgentQaConfig
  configDir: string
  resolvedTarget: ResolvedTarget
  stateName: string | undefined
}): Promise<ResolvedAuthStateForRun | undefined> {
  if (!input.stateName) return undefined
  try {
    return await resolveAuthStateForRun({
      configDir: input.configDir,
      authStateDir: input.config.services?.authState?.dir,
      targetName: input.resolvedTarget.name,
      stateName: input.stateName,
      target: { platform: input.resolvedTarget.platform },
    })
  } catch (err) {
    console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(2)
  }
}

async function executeSuites(
  suiteFiles: string[],
  opts: RunOptions,
  config: AgentQaConfig,
  globalOpts: { config?: string; verbose?: boolean; quiet?: boolean; logLevel?: string },
  configContent: string,
  effectiveLogLevel: string,
  variableContext?: {
    envFileVars: Record<string, string>
    inlineVars: Record<string, string>
    cliVars: Record<string, string>
    rawEnvFileContent?: string | null
    resolvedEnvFilePath?: string | null
    secretStore?: SecretStore
    secretRedactor?: SecretRedactor
    secretsFileMetadata?: SecretsFileArtifactMetadata | null
    userRunAttributes: RunAttributes
    inheritedRunAttributes?: RunAttributes
  },
  hooksContext?: { resolvedHooks: Map<string, HookDefinition>; sandboxOptions: SandboxRunnerOptions },
): Promise<boolean> {
  const { parseSuiteFile, parseTestFile, runSuite,
    createModel, getProviderOptions, LLMPlanner, LLMVerifier,
    ConsoleReporter, JUnitReporter, MultiReporter, createAnalyticsRunReporter,
  } = await import('@vostride/agent-qa-core')
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')

  const configFilePath = globalOpts.config ?? 'agent-qa.config.yaml'
  const configDir = path.dirname(path.resolve(configFilePath))

  const suiteResults: SuiteResult[] = []

  const activeSuiteDbs = new Set<any>()
  let shutdownRequested = false

  const handleShutdown = () => {
    shutdownRequested = true
    process.exitCode = 130
    for (const activeSuiteDb of activeSuiteDbs) {
      try {
        const now = new Date().toISOString()
        const runningRuns = activeSuiteDb.getRuns({ status: 'running' })
          .filter((run: any) => run.suiteId && !run.parentRunId)
        for (const run of runningRuns) {
          activeSuiteDb.updateRun(run.id, { status: 'cancelled', endedAt: now })
          const children = activeSuiteDb.getRunsByParent(run.id)
          for (const child of children) {
            if (child.status === 'running') {
              activeSuiteDb.updateRun(child.id, { status: 'cancelled', endedAt: now })
            }
          }
        }
      } catch { /* best-effort cleanup */ }
    }
  }

  process.once('SIGINT', handleShutdown)
  process.once('SIGTERM', handleShutdown)

  const dashboardCfg = config.services?.dashboard as Record<string, unknown> | undefined
  const reporterSelectionResult = resolveReporterSelection(opts, Boolean(dashboardCfg))
  if (reporterSelectionResult.error) {
    console.error(pc.red(`Error: ${reporterSelectionResult.error}`))
    process.exit(2)
  }
  const reporterSelection = reporterSelectionResult.selection!
  const dashboardEnabled = reporterSelection.dashboard

  const createSuiteDashboardResources = async (): Promise<{ dashboardDb?: any; logStorage?: any }> => {
    if (!dashboardEnabled) return {}
    try {
      const { DashboardDatabase, resolveDashboardDbPath } = await import('@vostride/agent-qa-dashboard')
      const configuredDbPath = dashboardCfg?.dbPath as string | undefined
      const dashboardDb = new DashboardDatabase({
        dbPath: resolveDashboardDbPath({ configDir, configuredDbPath }),
      })
      activeSuiteDbs.add(dashboardDb)
      return { dashboardDb, logStorage: dashboardDb }
    } catch (err) {
      console.warn(pc.yellow(`Warning: Could not load dashboard reporter: ${err instanceof Error ? err.message : String(err)}`))
      return {}
    }
  }

  const closeSuiteDashboardDb = (dashboardDb?: any) => {
    if (!dashboardDb) return
    activeSuiteDbs.delete(dashboardDb)
    dashboardDb.close()
  }

  type SuiteParentOutcome = { failed: boolean; cancelled: boolean }

  const resolveSuiteParentPlatform = async (suite: SuiteDefinition): Promise<'web' | 'android' | 'ios'> => {
    if (suite.target) {
      return resolveTarget(config, suite.target).platform
    }
    const firstEntry = suite.tests[0]
    if (firstEntry) {
      const absolutePath = path.resolve(configDir, firstEntry.test)
      const fileContent = await readFile(absolutePath, 'utf-8')
      const parseResult = parseTestFile(fileContent, absolutePath)
      const firstTest = parseResult.tests[0]
      if (firstTest?.target) {
        return resolveTarget(config, firstTest.target).platform
      }
    }
    return 'web'
  }

  const runOneSuiteFile = async (suiteFile: string, suite: SuiteDefinition): Promise<SuiteParentOutcome> => {
    const suiteFailureAttributes = resolveCliRunAttributes(
      variableContext?.userRunAttributes ?? {},
      'local',
      variableContext?.inheritedRunAttributes,
    )
    const { dashboardDb, logStorage } = await createSuiteDashboardResources()
    let lastSuiteRunId: string | undefined
    let suiteFileContent = ''
    try { suiteFileContent = await readFile(suiteFile, 'utf-8') } catch { /* best-effort */ }

    const mergedUse = mergeUseBlocks(
      config.use as Record<string, unknown>,
      suite.use as Record<string, unknown> | undefined,
      undefined,
      {},
    )
    const suiteAuthStateName = getSelectedAuthStateName(mergedUse as Record<string, unknown>)

    const testEntries: [TestDefinition, string][] = []
    const suiteMembers: Array<Record<string, unknown>> = []
    for (const { test: relativePath, id: suiteEntryId } of suite.tests) {
      if (!isPathInsideDir(relativePath, configDir)) {
        console.error(pc.red(`Path traversal rejected: ${relativePath}`))
        const runId = createSuiteRunId()
        if (dashboardDb) {
          const now = new Date().toISOString()
          const existingRunId = process.env.AGENT_QA_RUN_ID ?? process.env.AGENT_QA_SUITE_QUEUE_ID
          if (existingRunId) {
            dashboardDb.updateRun(existingRunId, {
              name: `Path traversal rejected in suite`,
              status: 'failed',
              duration: 0,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `Path traversal rejected: ${relativePath}`,
              errorLog: `Path traversal rejected: ${relativePath}`,
            })
          } else {
            dashboardDb.insertRun({
              id: runId,
              name: `Path traversal rejected in suite`,
              status: 'failed',
              duration: 0,
              startedAt: now,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `Path traversal rejected: ${relativePath}`,
            })
            dashboardDb.updateRun(runId, { errorLog: `Path traversal rejected: ${relativePath}` })
          }
          closeSuiteDashboardDb(dashboardDb)
        }
        printRunId(runId)
        printRunAttributes(suiteFailureAttributes)
        process.exit(2)
      }

      const absolutePath = path.resolve(configDir, relativePath)
      const fileContent = await readFile(absolutePath, 'utf-8')
      const parseResult = parseTestFile(fileContent, absolutePath)
      if (parseResult.errors.length > 0) {
        console.error(pc.red(`Parse errors in ${relativePath}:`))
        formatParseErrors(parseResult.errors)
        const runId = createSuiteRunId()
        if (dashboardDb) {
          const now = new Date().toISOString()
          const errorLines: string[] = []
          for (const e of parseResult.errors) {
            const location = `${e.file}:${e.line}:${e.column}`
            errorLines.push(`${e.severity}: ${e.message}\n  --> ${location}`)
          }
          const existingRunId = process.env.AGENT_QA_RUN_ID ?? process.env.AGENT_QA_SUITE_QUEUE_ID
          if (existingRunId) {
            dashboardDb.updateRun(existingRunId, {
              name: `Parse errors in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `${parseResult.errors.length} parse error(s) in ${relativePath}`,
              errorLog: errorLines.join('\n'),
            })
          } else {
            dashboardDb.insertRun({
              id: runId,
              name: `Parse errors in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              startedAt: now,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `${parseResult.errors.length} parse error(s) in ${relativePath}`,
            })
            dashboardDb.updateRun(runId, { errorLog: errorLines.join('\n') })
          }
          closeSuiteDashboardDb(dashboardDb)
        }
        printRunId(runId)
        printRunAttributes(suiteFailureAttributes)
        process.exit(2)
      }
      if (parseResult.tests.length === 0) {
        console.error(pc.red(`No test definition found in ${relativePath}`))
        const runId = createSuiteRunId()
        if (dashboardDb) {
          const now = new Date().toISOString()
          const existingRunId = process.env.AGENT_QA_RUN_ID ?? process.env.AGENT_QA_SUITE_QUEUE_ID
          if (existingRunId) {
            dashboardDb.updateRun(existingRunId, {
              name: `No test definition in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `No test definition found in ${relativePath}`,
              errorLog: `No test definition found in ${relativePath}`,
            })
          } else {
            dashboardDb.insertRun({
              id: runId,
              name: `No test definition in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              startedAt: now,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: `No test definition found in ${relativePath}`,
            })
            dashboardDb.updateRun(runId, { errorLog: `No test definition found in ${relativePath}` })
          }
          closeSuiteDashboardDb(dashboardDb)
        }
        printRunId(runId)
        printRunAttributes(suiteFailureAttributes)
        process.exit(2)
      }

      const testDef = parseResult.tests[0]
      const childAuthStateName = getSelectedAuthStateName(testDef.use as Record<string, unknown> | undefined)
      // Normal suite runs are auth-state consumers only; producer/update workflows are explicit and separate. Compare child authState only to reject drift.
      if (suiteAuthStateName && childAuthStateName && childAuthStateName !== suiteAuthStateName) {
        console.error(pc.red(`Suite auth state "${suiteAuthStateName}" conflicts with child test auth state "${childAuthStateName}". Use one primary auth state per suite.`))
        process.exit(2)
      }
      if (testDef['test-id'] && testDef['test-id'] !== suiteEntryId) {
        const mismatchMsg = `ID mismatch in suite "${suite.name}": test file ${relativePath} has test-id "${testDef['test-id']}" but suite entry specifies id "${suiteEntryId}"`
        console.error(pc.red(mismatchMsg))
        const runId = createSuiteRunId()
        if (dashboardDb) {
          const now = new Date().toISOString()
          const existingRunId = process.env.AGENT_QA_RUN_ID ?? process.env.AGENT_QA_SUITE_QUEUE_ID
          if (existingRunId) {
            dashboardDb.updateRun(existingRunId, {
              name: `ID mismatch in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: mismatchMsg,
              errorLog: mismatchMsg,
            })
          } else {
            dashboardDb.insertRun({
              id: runId,
              name: `ID mismatch in suite "${suite.name}"`,
              status: 'failed',
              duration: 0,
              startedAt: now,
              endedAt: now,
              attributes: suiteFailureAttributes,
              failureSummary: mismatchMsg,
            })
            dashboardDb.updateRun(runId, { errorLog: mismatchMsg })
          }
          closeSuiteDashboardDb(dashboardDb)
        }
        printRunId(runId)
        printRunAttributes(suiteFailureAttributes)
        process.exit(2)
      }

      suiteMembers.push({
        index: suiteMembers.length,
        ref: { test: relativePath, id: suiteEntryId },
        filePath: absolutePath,
        testId: testDef['test-id'] ?? null,
        name: testDef.name,
        target: testDef.target ?? null,
        rawYaml: fileContent,
        resolvedDefinition: testDef,
        loadStatus: 'loaded',
      })
      testEntries.push([testDef, absolutePath])
    }

    const suiteResolvedTarget = suite.target
      ? resolveTarget(config, suite.target!)
      : resolveTarget(config, testEntries[0][0].target!)
    const suitePlatform: 'web' | 'android' | 'ios' = suiteResolvedTarget.platform

    const suiteAuthState = await resolveSelectedAuthStateForRun({
      config,
      configDir,
      resolvedTarget: suiteResolvedTarget,
      stateName: suiteAuthStateName,
    })
    const suiteEffectiveCacheEnabled = opts.cache !== false && (mergedUse as Record<string, unknown>).cache !== false
    let suiteDeviceName = opts.device ?? (mergedUse.device as string | undefined)

    if ((suitePlatform === 'android' || suitePlatform === 'ios') && !suiteDeviceName) {
      const childDeviceNames = testEntries.map(([testDef]) => {
        const device = (testDef.use as Record<string, unknown> | undefined)?.device
        return typeof device === 'string' && device.trim().length > 0 ? device.trim() : undefined
      })
      const missingChildDevice = childDeviceNames.some((device) => !device)
      const uniqueChildDevices = [...new Set(childDeviceNames.filter((device): device is string => Boolean(device)))]

      if (missingChildDevice || uniqueChildDevices.length === 0) {
        throw new Error(`Select a device for this mobile suite "${suite.name}" with suite use.device or every child test use.device.`)
      }
      if (uniqueChildDevices.length > 1) {
        throw new Error(`Mobile suite child tests use multiple devices (${uniqueChildDevices.join(', ')}); set suite use.device or split the suite.`)
      }
      suiteDeviceName = uniqueChildDevices[0]
    }
    const deviceName = suiteDeviceName

    const suiteTimeoutConfig = mergedUse.timeout as Record<string, unknown> | undefined
    const testTimeouts = {
      step: typeof suiteTimeoutConfig?.step === 'number' ? suiteTimeoutConfig.step : 30000,
      test: typeof suiteTimeoutConfig?.test === 'number' ? suiteTimeoutConfig.test : 120000,
      navigation: typeof suiteTimeoutConfig?.navigation === 'number' ? suiteTimeoutConfig.navigation : 30000,
    }

    const suiteLocalBindings = suitePlatform === 'android' || suitePlatform === 'ios'
      ? loadLocalBindings()
      : null
    let mobileResolved: ResolvedMobileRunConfig | undefined
    let resolvedDevice: ResolvedDevice | undefined
    let farmSession: PlatformConfig['farmSession'] | undefined
    if (suitePlatform === 'android' || suitePlatform === 'ios') {
      mobileResolved = resolveMobileRunOrThrow({
        config: config as unknown as Record<string, any>,
        targetName: suiteResolvedTarget.name,
        platform: suitePlatform,
        explicitDeviceName: opts.device,
        useDeviceName: suiteDeviceName,
        appState: (mergedUse.mobile as Record<string, unknown> | undefined)?.appState as 'preserve' | 'reset' | undefined,
        localBindings: suiteLocalBindings,
        configFilePath: path.resolve(configFilePath),
        localConfigFilePath: suiteLocalBindings?.filePath,
        appiumUrl: process.env.AGENT_QA_APPIUM_URL,
      })
      const resolved = await resolveDeviceAndFarmSession(
        config, mobileResolved.deviceName, suitePlatform,
        `Suite: ${suite.name} — ${new Date().toISOString().slice(0, 19)}`,
        testTimeouts.test,
        mobileResolved.device,
        suiteLocalBindings,
        mobileResolved,
      )
      resolvedDevice = resolved.resolvedDevice
      farmSession = resolved.farmSession
    }

    const useFarm = resolvedDevice?.transport !== undefined && resolvedDevice.transport !== 'local'
    const suiteAttributes = resolveCliRunAttributes(
      variableContext?.userRunAttributes ?? {},
      resolveRunnerAttribute(resolvedDevice?.transport),
      variableContext?.inheritedRunAttributes,
    )
    writeRunAttributesToEnv(suiteAttributes)

    // Auto-start Appium for mobile platforms
    if ((suitePlatform === 'ios' || suitePlatform === 'android') && !useFarm) {
      try {
        const appiumUrl = await acquireAppium(effectiveLogLevel)
        if (mobileResolved) {
          mobileResolved = { ...mobileResolved, appium: { url: appiumUrl, managed: !process.env.AGENT_QA_APPIUM_URL } }
        }
      } catch (err) {
        throw new MobileSetupError({
          category: 'appium-startup',
          message: `Could not auto-start Appium: ${err instanceof Error ? err.message : String(err)}`,
          platform: suitePlatform,
          targetName: suiteResolvedTarget.name,
          deviceName,
          cause: err,
        })
      }
    }

    const adapter = await createPlatformAdapter(suitePlatform)

    const resolvedTarget = suite.target
      ? resolveTarget(config, suite.target)
      : testEntries[0][0].target
        ? resolveTarget(config, testEntries[0][0].target)
        : undefined

    const suiteBrowser = (mergedUse.browser as Record<string, unknown> | undefined) ?? config.use?.browser
    const suiteLogCapture = (mergedUse.logCapture as Record<string, unknown> | undefined) ?? (config as any).use?.logCapture
    const platformConfig = buildPlatformConfig(suitePlatform, resolvedDevice, testTimeouts, suiteBrowser as any, suiteLogCapture, farmSession, mobileResolved)
    platformConfig.authState = suiteAuthState
    platformConfig.verbose = effectiveLogLevel === 'debug'
    if (opts.headless !== undefined && platformConfig.browser) {
      platformConfig.browser.headless = opts.headless
    }

    const recordingEnabled = opts.record ?? config.services?.recording?.enabled ?? false
    if (recordingEnabled) {
      const recordingCfg = config.services?.recording as Record<string, unknown> | undefined
      platformConfig.recording = {
        enabled: true,
        videoDir: resolveDashboardVideoDir(config, configDir, dashboardEnabled),
        videoSize: recordingCfg?.videoSize as { width: number; height: number } | undefined,
      }
    }

    // Resolve LLM models
    const { planner: plannerCfg, verifier: verifierCfg, configName } = resolveLLMModels(config)
    const resolvedAuth = await resolveModelAuth(configName, plannerCfg)
    const plannerModelConfig = applyResolvedAuthToModelConfig(plannerCfg, resolvedAuth)
    const verifierModelConfig = applyResolvedAuthToModelConfig(verifierCfg, resolvedAuth)
    process.env.AGENT_QA_LLM_MODEL = plannerCfg.model
    process.env.AGENT_QA_LLM_PROVIDER = plannerCfg.provider

    const plannerModel = await createModel(plannerModelConfig)
    const verifierModel = await createModel(verifierModelConfig)

    const providerOpts = getProviderOptions(plannerModelConfig)

    const { LogManager } = await import('@vostride/agent-qa-core')

    const logger = new LogManager({
      runId: process.env.AGENT_QA_RUN_ID || undefined,
      displayLevel: effectiveLogLevel as any,
      storage: logStorage,
      ndjson: process.env.AGENT_QA_LIVE_EVENTS === 'true',
      redactor: variableContext?.secretRedactor,
    })

    let agentRulesContent: string | undefined
    const agentRulesPath = (config as any).workspace?.agentRules
    if (agentRulesPath) {
      const { readFile: readFileAsync } = await import('node:fs/promises')
      const resolvedRulesPath = path.resolve(configDir, agentRulesPath)
      try {
        agentRulesContent = await readFileAsync(resolvedRulesPath, 'utf-8')
      } catch { /* agent rules file not found — ignore */ }
    }
    let suiteEffectiveRules = agentRulesContent ?? ''
    if (suiteLogCapture?.console === false) {
      suiteEffectiveRules += '\nConsole log capture is DISABLED for this test run. The readConsoleLogs action will return no data. If a test step explicitly requires reading console logs, use stepFailed to fail the step — do not silently pass with empty data.'
    }
    if (suiteLogCapture?.network === false) {
      suiteEffectiveRules += '\nNetwork log capture is DISABLED for this test run. The readNetworkLogs action will return no data. If a test step explicitly requires reading network logs, use stepFailed to fail the step — do not silently pass with empty data.'
    }
    const planner = new LLMPlanner(plannerModel, suitePlatform, providerOpts, logger.createScopedLogger('planner'), suiteEffectiveRules || undefined)
    const verifier = new LLMVerifier(verifierModel, providerOpts)

    const reporters: import('@vostride/agent-qa-core').Reporter[] = []
    if (reporterSelection.console) {
      reporters.push(new ConsoleReporter({ verbose: false, logLevel: effectiveLogLevel }))
    }
    if (reporterSelection.junit && opts.junitOutput) {
      reporters.push(new JUnitReporter({ outputPath: opts.junitOutput }))
    }
    if (reporterSelection.stdoutLive) {
      const { StdoutLiveReporter } = await import('@vostride/agent-qa-core')
      reporters.push(new StdoutLiveReporter({ active: true, redactor: variableContext?.secretRedactor }))
    }
    if (reporterSelection.dashboard && dashboardDb) {
      try {
        const { DashboardReporter } = await import('@vostride/agent-qa-dashboard')
        const { resolve } = await import('node:path')
        const dashArtifactsDir = config.services?.dashboard?.artifactsDir ?? RUNTIME_ARTIFACTS_DIR
        reporters.push(new DashboardReporter({
          db: dashboardDb,
          artifactsDir: resolve(configDir, dashArtifactsDir),
          redactor: variableContext?.secretRedactor,
          onRunCreated: (runId: string) => { lastSuiteRunId = runId; logger.setRunId(runId) },
        }))
      } catch { /* dashboard reporter not available */ }
    }
    const analyticsReporter = createAnalyticsRunReporter({ config, surface: 'cli' })
    reporters.push(analyticsReporter)

    // Wire action cache
    let actionCache: import('@vostride/agent-qa-core').ActionCache | undefined
    if (opts.cache !== false) {
      const { FileActionCache } = await import('@vostride/agent-qa-core')
      const { resolve } = await import('node:path')
      actionCache = new FileActionCache({
        dir: resolve(configDir, config.services?.cache?.dir ?? RUNTIME_CACHE_DIR),
        ttl: config.services?.cache?.ttl ?? '7d',
        logger: logger.createScopedLogger('cache'),
      })
    }

    const healingConfig = {
      maxAttempts: config.use?.healing?.maxAttempts ?? 3,
    }

    const captureScreenshots = reporterSelection.dashboard || opts.screenshotMode === 'every-step' || Boolean(opts.screenshotDir)

    let suiteMemoryProvider: import('@vostride/agent-qa-core').MemoryProvider | undefined
    let suiteCircuitBreaker: import('@vostride/agent-qa-core').CircuitBreaker | undefined
    const suiteMemoryConfig = config.services?.memory
    const suiteMemoryRoot = resolveMemoryRoot(config, configDir)

    if (opts.memory !== false && suiteMemoryConfig?.enabled !== false) {
      try {
        const { createMemoryProvider } = await import('@vostride/agent-qa-core')
        suiteMemoryProvider = await createMemoryProvider({
          provider: suiteMemoryConfig?.provider ?? 'local',
          memoryRoot: suiteMemoryRoot,
          curatorLockTimeout: suiteMemoryConfig?.curatorLockTimeout,
        })
      } catch (err) {
        console.warn(`  ${pc.dim('Memory:')} init error -- ${(err as Error).message}`)
      }

      if (suiteMemoryConfig?.circuitBreakerEnabled !== false) {
        const { CircuitBreaker } = await import('@vostride/agent-qa-core')
        suiteCircuitBreaker = new CircuitBreaker({
          windowSize: suiteMemoryConfig?.circuitBreakerWindowSize,
          baselineSize: suiteMemoryConfig?.circuitBreakerBaselineSize,
          threshold: suiteMemoryConfig?.circuitBreakerThreshold,
        })
      }
    }

    const suiteArtifactContext = buildRunArtifactContext({
      kind: 'suite-parent',
      configContent,
      parsedConfig: config,
      effectiveConfig: { ...config, use: mergedUse },
      envFilePath: variableContext?.resolvedEnvFilePath ?? null,
      rawEnvFileContent: variableContext?.rawEnvFileContent ?? null,
      envFileVars: variableContext?.envFileVars ?? {},
      secretsFileMetadata: variableContext?.secretsFileMetadata ?? null,
      cliVars: variableContext?.cliVars ?? {},
      inlineVars: variableContext?.inlineVars ?? {},
      hooks: hooksContext?.resolvedHooks,
      planner: { provider: plannerCfg.provider, model: plannerCfg.model },
      verifier: { provider: verifierCfg.provider, model: verifierCfg.model },
      platform: suitePlatform,
      target: suiteResolvedTarget,
      deviceName,
      attributes: suiteAttributes,
      timeouts: testTimeouts,
      cache: {
        enabled: suiteEffectiveCacheEnabled,
        dir: config.services?.cache?.dir,
        ttl: config.services?.cache?.ttl,
      },
      memory: {
        enabled: opts.memory !== false && suiteMemoryConfig?.enabled !== false,
        curatorEnabled: suiteMemoryConfig?.curatorEnabled,
        provider: suiteMemoryConfig?.provider ?? 'local',
        dir: suiteMemoryConfig?.dir,
      },
      source: {
        kind: 'suite',
        suiteId: (suite as any)['suite-id'] ?? null,
        name: suite.name,
        filePath: suiteFile,
        rawYaml: suiteFileContent || null,
        resolvedDefinition: suite,
        loadStatus: 'loaded',
        members: suiteMembers,
      },
    })

    const suiteConfig: RunSuiteConfig = {
      adapter,
      platformConfig,
      planner,
      verifier,
      cache: suiteEffectiveCacheEnabled ? actionCache : undefined,
      healingConfig,
      plannerModel,
      verifierModel,
      providerOptions: providerOpts,
      reporters,
      captureScreenshots,
      screenshotMode: (opts.screenshotMode as 'failure' | 'every-step') ?? 'failure',
      timeouts: testTimeouts,
      logger,
      configContent,
      suiteFileContent,
      envFileVars: variableContext?.envFileVars,
      inlineVars: variableContext?.inlineVars,
      cliVars: variableContext?.cliVars,
      resolvedHooks: hooksContext?.resolvedHooks,
      sandboxOptions: hooksContext?.sandboxOptions,
      logCapture: suiteLogCapture,
      accessibility: config.services?.accessibility,
      accessibilityCheck: runWebAccessibilityCheck,
      screenshotSize: plannerCfg.screenshotSize,
      effectiveResolution: plannerCfg.effectiveResolution,
      memoryProvider: suiteMemoryProvider,
      memoryConfig: suiteMemoryConfig,
      memoryRoot: suiteMemoryRoot,
      circuitBreaker: suiteCircuitBreaker,
      product: resolvedTarget?.product,
      createAdapter: () => createPlatformAdapter(suitePlatform),
      resolveUrl: (targetName: string) => {
        try { return resolveTarget(config, targetName).url } catch { return undefined }
      },
      onCuratorComplete: dashboardDb ? (_testName: string, memoryLog: any) => {
        if (lastSuiteRunId) {
          try {
            dashboardDb.updateRun(lastSuiteRunId, { memoryLog: JSON.stringify(memoryLog) })
          } catch { /* DB write failure must not fail the test */ }
        }
      } : undefined,
    }
    ;(suiteConfig as any).artifactContext = suiteArtifactContext.artifact
    ;(suiteConfig as any).secretStore = variableContext?.secretStore
    ;(suiteConfig as any).secretRedactor = variableContext?.secretRedactor
    ;(suiteConfig as any).secretsFileMetadata = variableContext?.secretsFileMetadata

    const suiteResult = await runSuite(suite, testEntries, suiteConfig)
      .finally(async () => {
        closeSuiteDashboardDb(dashboardDb)
        await flushAnalyticsRunReporter(analyticsReporter)
      })
    suiteResults.push(suiteResult)
    printRunAttributes(suiteAttributes)

    return {
      failed: suiteResult.status === 'failed',
      cancelled: suiteResult.status === 'cancelled' || shutdownRequested,
    }
  }

  const pendingSuiteParents: Promise<SuiteParentOutcome>[] = []
  const flushSuiteParents = async (): Promise<SuiteParentOutcome> => {
    if (pendingSuiteParents.length === 0) return { failed: false, cancelled: false }
    const batch = pendingSuiteParents.splice(0, pendingSuiteParents.length)
    const settled = await Promise.allSettled(batch)
    const rejected = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (rejected) throw rejected.reason
    const outcomes = settled
      .filter((outcome): outcome is PromiseFulfilledResult<SuiteParentOutcome> => outcome.status === 'fulfilled')
      .map((outcome) => outcome.value)
    return {
      failed: outcomes.some((outcome) => outcome.failed),
      cancelled: outcomes.some((outcome) => outcome.cancelled),
    }
  }

  for (const suiteFile of suiteFiles) {
    const suite = await parseSuiteFile(suiteFile)
    const suitePlatform = await resolveSuiteParentPlatform(suite)
    const effectiveSuiteParallel = suite.use?.parallel ?? config.use?.parallel ?? false
    const canRunSuiteInParallel = suitePlatform === 'web' && effectiveSuiteParallel === true

    if (canRunSuiteInParallel) {
      pendingSuiteParents.push(runOneSuiteFile(suiteFile, suite))
      continue
    }

    const batchOutcome = await flushSuiteParents()
    if (batchOutcome.cancelled || shutdownRequested) break
    if (opts.bail && batchOutcome.failed) {
      console.log(pc.yellow('\nBailing out — stopping after first failed suite'))
      break
    }

    const outcome = await runOneSuiteFile(suiteFile, suite)
    if (outcome.cancelled || shutdownRequested) break
    if (opts.bail && outcome.failed) {
      console.log(pc.yellow('\nBailing out — stopping after first failed suite'))
      break
    }
  }

  const finalBatchOutcome = await flushSuiteParents()
  if (opts.bail && finalBatchOutcome.failed) {
    console.log(pc.yellow('\nBailing out — stopping after first failed suite'))
  }

  process.removeListener('SIGINT', handleShutdown)
  process.removeListener('SIGTERM', handleShutdown)

  releaseAppium()
  return suiteResults.some(r => r.status === 'failed' || r.status === 'cancelled') || shutdownRequested
}

export function createRunCommand(): Command {
  const cmd = new Command('run')
    .description('Run test files')
    .argument('[patterns...]', 'glob patterns for test files')
    .option('--browser <name>', 'override browser (chromium, firefox, webkit)')
    .option('--platform <name>', 'filter by platform (web, android, ios)')
    .option('--headless', 'run in headless mode')
    .option('--no-headless', 'run in headed mode')
    .option('--no-cache', 'bypass action cache for this run')
    .option('--no-memory', 'disable runtime memory injection for this run')
    .option('--bail', 'stop on first test failure')
    .option('--dry-run', 'parse and list tests without executing')
    .option('--list-tests', 'list discovered test files without executing')
    .option('--junit-output <path>', 'path for JUnit XML output')
    .option('--screenshot-dir <dir>', 'directory for failure screenshots')
    .option('--screenshot-mode <mode>', 'when to capture: failure (default) or every-step')
    .option('--reporter <names...>', 'select reporters (default: console)')
    .option('--record', 'enable session video recording')
    .option('--config-debug', 'print resolved config with source attribution for each test')
    .option('--test', 'discover and run tests via testMatch patterns (default when no flags)')
    .option('--suite', 'discover and run suites via suiteMatch patterns')
    .option('--all', 'discover and run both tests (testMatch) and suites (suiteMatch)')
    .option('--device <name>', 'Override the mobile test/suite device for this run')
    .option('--var <kv...>', 'set variable KEY=VALUE (repeatable)')
    .option('--run-attr <kv...>', 'attach run attribute KEY=VALUE; repeatable')
    .action(async (patterns: string[], opts: RunOptions, command: Command) => {
      let _crashDb: any
      try {
        const modeFlags = [opts.test, opts.suite, opts.all].filter(Boolean).length
        if (modeFlags > 1) {
          console.error(pc.red('Error: --test, --suite, and --all are mutually exclusive.'))
          process.exit(1)
        }

        const program = command.parent!
        const globalOpts = program.opts<{ config?: string; verbose?: boolean; quiet?: boolean; logLevel?: string }>()

        const flagOverrides: Record<string, unknown> = {}
        if (opts.browser) {
          flagOverrides.browsers = [{ name: opts.browser }]
        }
        if (opts.headless !== undefined) {
          // headless is handled per-platform in platformConfig setup below
        }

        const config = await resolveConfig({
          configPath: globalOpts.config,
          flags: flagOverrides,
          loadAuthPlugins: !(opts.dryRun || opts.listTests),
        })

        // Read raw config file content for cache key scoping
        const configFilePath = resolvePath(globalOpts.config ?? 'agent-qa.config.yaml')
        const workspacePaths = resolveWorkspacePaths({
          config,
          configPath: configFilePath,
        })
        let configContent = ''
        try {
          const { readFile: readConfigFile } = await import('node:fs/promises')
          configContent = await readConfigFile(configFilePath, 'utf-8')
        } catch { /* best-effort: resolveConfig already required the file */ }

        // Load variables from env file, config inline, and CLI flags
        const { parseEnvFile } = await import('@vostride/agent-qa-core')
        const { readFileSync, existsSync } = await import('node:fs')
        const configDir = workspacePaths.configDir

        const cliVars = parseVarFlags(opts.var)
        const inheritedContextRunId = process.env.AGENT_QA_RUN_ID
          ?? process.env.AGENT_QA_SUITE_QUEUE_ID
          ?? process.env.AGENT_QA_PARENT_RUN_ID
        const inheritedRunAttributes = inheritedContextRunId
          ? readRunAttributesFromEnv()
          : undefined
        let userRunAttributes: RunAttributes
        try {
          const parsedRunAttrs = parseRunAttrFlags(opts.runAttr)
          userRunAttributes = parsedRunAttrs.attributes
          for (const duplicateKey of parsedRunAttrs.duplicateKeys) {
            console.warn(`Warning: duplicate --run-attr key "${duplicateKey}"; using last value`)
          }
        } catch (err) {
          console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
          process.exit(2)
        }
        const inlineVars: Record<string, string> = {}

        const runtimeSecrets = await loadRuntimeSecrets({
          config,
          configDir,
          secretsFilePath: workspacePaths.secretsFile.absolutePath,
          readFileSync,
          existsSync,
        })

        let envFileVars: Record<string, string> = {}
        let rawEnvFileContent: string | null = null
        let resolvedEnvFilePath: string | null = null
        resolvedEnvFilePath = workspacePaths.envFile.absolutePath
        if (!existsSync(workspacePaths.envFile.absolutePath)) {
          console.error(pc.red(`Error: Env file not found: ${workspacePaths.envFile.absolutePath}`))
          process.exit(1)
        }
        try {
          rawEnvFileContent = readFileSync(workspacePaths.envFile.absolutePath, 'utf-8')
          envFileVars = parseEnvFile(rawEnvFileContent)
        } catch {
          console.error(pc.red(`Error: Env file could not be read: ${workspacePaths.envFile.absolutePath}`))
          process.exit(1)
        }

        let resolvedHooks: Map<string, HookDefinition> | undefined
        let sandboxOptions: SandboxRunnerOptions | undefined

        const hooksFilePath = workspacePaths.hooksFile.absolutePath
        if (!existsSync(hooksFilePath)) {
          console.error(pc.red(`Error: Hooks file not found: ${hooksFilePath}`))
          process.exit(1)
        }
        try {
          const { parseHooksFile } = await import('@vostride/agent-qa-core')
          const { hooks, errors } = await parseHooksFile(hooksFilePath)
          if (errors.length > 0) {
            console.error(pc.red('Hooks configuration errors:'))
            for (const err of errors) console.error(pc.red(`  - ${err}`))
            process.exit(1)
          }
          resolvedHooks = new Map(hooks.map((h: HookDefinition) => [h.id, h]))
          sandboxOptions = {
            secretStore: runtimeSecrets.secretStore,
            secretRedactor: runtimeSecrets.secretRedactor,
          } as any
        } catch (err: any) {
          console.error(pc.red(`Error: Hooks file could not be read: ${hooksFilePath}`))
          if (err instanceof Error && err.message) console.error(pc.dim(err.message))
          process.exit(1)
        }

        let agentRulesContent: string | undefined
        const { readFile: readFileAsync } = await import('node:fs/promises')
        try {
          agentRulesContent = await readFileAsync(workspacePaths.agentRules.absolutePath, 'utf-8')
        } catch {
          console.error(pc.red(`Error: Agent rules file not found: ${workspacePaths.agentRules.absolutePath}`))
          process.exit(1)
        }

        // Resolve effective log level: CLI flag > --verbose/--quiet > config > fallback
        const effectiveLogLevel = globalOpts.logLevel
          ?? (globalOpts.verbose ? 'debug' : undefined)
          ?? (globalOpts.quiet ? 'silent' : undefined)
          ?? (config as any).services?.logging?.level
          ?? 'warn'

        let discoveredTestFiles: string[] = []
        let discoveredSuiteFiles: string[] = []

        if (patterns && patterns.length > 0) {
          try {
            const selected = await discoverFilesForCliPatterns(workspacePaths, patterns)
            discoveredTestFiles = selected.tests
            discoveredSuiteFiles = selected.suites
          } catch (err) {
            console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`))
            process.exit(1)
          }

          if (discoveredTestFiles.length === 0 && discoveredSuiteFiles.length === 0) {
            const patternKind = patterns.every((pattern) => classifyRunPattern(pattern) === 'suite') ? 'suite' : 'test'
            console.error(pc.red(`Error: No ${patternKind} files found matching patterns:`))
            for (const p of patterns) console.error(pc.red(`  ${p}`))
            process.exit(2)
          }
        } else if (opts.suite) {
          discoveredSuiteFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'suite' }))
            .map(record => record.absolutePath)
          if (discoveredSuiteFiles.length === 0) {
            console.error(pc.red('Error: No suite files found matching workspace.suiteMatch'))
            for (const p of workspacePaths.suiteMatch) {
              console.error(pc.red(`  ${p}`))
            }
            process.exit(2)
          }
        } else if (opts.all) {
          discoveredTestFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' }))
            .map(record => record.absolutePath)
          discoveredSuiteFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'suite' }))
            .map(record => record.absolutePath)

          if (discoveredTestFiles.length === 0 && discoveredSuiteFiles.length === 0) {
            console.error(pc.red('Error: No test or suite files found. Check workspace.testMatch and workspace.suiteMatch in agent-qa.config.yaml'))
            process.exit(2)
          }
        } else {
          if (!workspacePaths.testMatch || workspacePaths.testMatch.length === 0) {
            console.error(pc.red('Error: No testMatch patterns in config. Add workspace.testMatch to agent-qa.config.yaml.'))
            process.exit(2)
          }
          discoveredTestFiles = (await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' }))
            .map(record => record.absolutePath)
          if (discoveredTestFiles.length === 0) {
            console.error(pc.red('Error: No test files found matching workspace.testMatch'))
            for (const p of workspacePaths.testMatch) {
              console.error(pc.red(`  ${p}`))
            }
            process.exit(2)
          }
        }

        // Handle suite execution (early return)
        if (discoveredSuiteFiles.length > 0 && discoveredTestFiles.length === 0) {
          const hasFailed = await executeSuites(discoveredSuiteFiles, opts, config, globalOpts, configContent, effectiveLogLevel, { envFileVars, inlineVars, cliVars, rawEnvFileContent, resolvedEnvFilePath, userRunAttributes, inheritedRunAttributes, ...runtimeSecrets }, resolvedHooks && sandboxOptions ? { resolvedHooks, sandboxOptions } : undefined)
          process.exit(hasFailed ? 1 : 0)
        }

        // Handle --all: run suites first, then fall through to test execution
        let suitesFailed = false
        if (discoveredSuiteFiles.length > 0 && discoveredTestFiles.length > 0) {
          suitesFailed = await executeSuites(discoveredSuiteFiles, opts, config, globalOpts, configContent, effectiveLogLevel, { envFileVars, inlineVars, cliVars, rawEnvFileContent, resolvedEnvFilePath, userRunAttributes, inheritedRunAttributes, ...runtimeSecrets }, resolvedHooks && sandboxOptions ? { resolvedHooks, sandboxOptions } : undefined)
        }

        const files = discoveredTestFiles

        if (opts.listTests) {
          console.log(pc.bold(`\nDiscovered ${files.length} test file(s):\n`))
          for (const file of files) {
            console.log(`  ${file}`)
          }
          process.exit(0)
        }

        // Hoist dashboard DB init before parsing so parse errors can write to DB
        let logStorage: any
        const dashboardCfg2 = config.services?.dashboard as Record<string, unknown> | undefined
        const reporterSelectionResult = resolveReporterSelection(opts, Boolean(dashboardCfg2))
        if (reporterSelectionResult.error) {
          console.error(pc.red(`Error: ${reporterSelectionResult.error}`))
          process.exit(2)
        }
        const reporterSelection = reporterSelectionResult.selection!
        const dashboardEnabled = reporterSelection.dashboard
        let dashboardDb: any
        let currentRunId: string | undefined
        if (dashboardEnabled) {
          try {
            const { DashboardDatabase, resolveDashboardDbPath } = await import('@vostride/agent-qa-dashboard')
            const configuredDbPath = dashboardCfg2?.dbPath as string | undefined
            dashboardDb = new DashboardDatabase({
              dbPath: resolveDashboardDbPath({ configDir, configuredDbPath }),
            })
            logStorage = dashboardDb
            _crashDb = dashboardDb
          } catch (err) {
            console.warn(pc.yellow(`Warning: Could not load dashboard reporter: ${err instanceof Error ? err.message : String(err)}`))
          }
        }

        const { parseAllTests, formatParseError } = await import('@vostride/agent-qa-core')
        const parseResult = await parseAllTests(files)

        if (parseResult.errors.length > 0) {
          console.error(pc.red(`Found ${parseResult.errors.length} parse error(s):\n`))
          for (const err of parseResult.errors) {
            console.error(formatParseError(err))
          }
          const validationRunId = createTestRunId()
          const validationAttributes = resolveCliRunAttributes(userRunAttributes, 'local', inheritedRunAttributes)
          if (dashboardDb) {
            const now = new Date().toISOString()
            const { basename } = await import('node:path')
            const errorText = parseResult.errors.map(e => formatParseError(e)).join('\n').replace(/\x1b\[[0-9;]*m/g, '')
            const { readFileSync } = await import('node:fs')
            const rawContent = readFileSync(files[0], 'utf-8')
            const nameMatch = rawContent.match(/^\s*name:\s*(.+)$/m)
            const targetMatch = rawContent.match(/^\s*target:\s*(.+)$/m)
            let detectedPlatform = 'web'
            if (targetMatch) {
              const targetName = targetMatch[1].trim()
              const resolvedTarget = (config as any).registry?.targets?.[targetName]
              if (resolvedTarget?.platform) detectedPlatform = resolvedTarget.platform
            }
            const testName = nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : basename(files[0], '.yaml')
            const existingRunId = process.env.AGENT_QA_RUN_ID
            let artifactRunId: string
            if (existingRunId) {
              dashboardDb.updateRun(existingRunId, {
                name: testName,
                status: 'failed',
                duration: 0,
                endedAt: now,
                attributes: validationAttributes,
                platform: detectedPlatform,
                failureSummary: `${parseResult.errors.length} parse error(s)`,
                errorLog: errorText,
              })
              artifactRunId = existingRunId
            } else {
              dashboardDb.insertRun({
                id: validationRunId,
                name: testName,
                status: 'failed',
                duration: 0,
                startedAt: now,
                endedAt: now,
                attributes: validationAttributes,
                platform: detectedPlatform,
                failureSummary: `${parseResult.errors.length} parse error(s)`,
              })
              dashboardDb.updateRun(validationRunId, { errorLog: errorText })
              artifactRunId = validationRunId
            }
            dashboardDb.insertRunArtifact({
              runId: artifactRunId,
              kind: 'test',
              payload: redactAuthStateValue({
                config: {
                  rawConfigContent: configContent,
                  parsedConfig: config,
                  effectiveConfig: config,
                  envFile: { path: resolvedEnvFilePath, content: rawEnvFileContent, variables: envFileVars },
                  secretsFile: runtimeSecrets.secretsFileMetadata,
                  cliVars,
                  inlineVars,
                  hooks: buildHooksArtifact(resolvedHooks),
                },
                source: {
                  kind: 'test',
                  testId: null,
                  name: testName,
                  filePath: files[0],
                  rawYaml: rawContent,
                  resolvedDefinition: null,
                  loadStatus: 'parse-error',
                },
                runtime: {
                  platform: detectedPlatform,
                  targetName: targetMatch ? targetMatch[1].trim() : null,
                },
                metadata: { attributes: validationAttributes },
                errors: parseResult.errors.map((error) => ({
                  code: 'parse-error',
                  phase: 'parse',
                  message: error.message,
                  details: error,
                })),
              }),
            })
            dashboardDb.finalizeRunArtifact(artifactRunId)
            dashboardDb.close()
          }
          printRunId(validationRunId)
          printRunAttributes(validationAttributes)
          process.exit(2)
        }

        const filtered = parseResult.tests

        if (filtered.length === 0) {
          console.log(pc.yellow('No tests match filters'))
          process.exit(0)
        }

        if (opts.dryRun) {
          console.log(pc.bold(`\nFound ${filtered.length} test(s):\n`))
          for (const test of filtered) {
            console.log(`  ${pc.green('●')} ${test.name}`)
            if (opts.configDebug) {
              console.log(pc.bold(`\n  Config for: ${test.name}`))
              console.log(formatConfigDebug(config, test.use, flagOverrides))
              console.log()
            }
          }
          process.exit(0)
        }

        // Actual execution
        const startTime = Date.now()
        const {
          createModel, getProviderOptions, LLMPlanner, LLMVerifier, runTestWithRetry,
          ConsoleReporter, JUnitReporter, MultiReporter, createAnalyticsRunReporter,
        } = await import('@vostride/agent-qa-core')

        const recordingEnabled = opts.record ?? config.services?.recording?.enabled ?? false

        // Wire action cache from config (logger wired after LogManager creation below)
        let actionCache: import('@vostride/agent-qa-core').ActionCache | undefined

        const reporters: import('@vostride/agent-qa-core').Reporter[] = []
        if (reporterSelection.console) {
          reporters.push(new ConsoleReporter({ verbose: false, logLevel: effectiveLogLevel }))
        }
        if (reporterSelection.junit && opts.junitOutput) {
          reporters.push(new JUnitReporter({ outputPath: opts.junitOutput }))
        }

        if (reporterSelection.stdoutLive) {
          const { StdoutLiveReporter } = await import('@vostride/agent-qa-core')
          reporters.push(new StdoutLiveReporter({ active: true, redactor: runtimeSecrets.secretRedactor }))
        }

        const captureScreenshots = reporterSelection.dashboard || opts.screenshotMode === 'every-step' || Boolean(opts.screenshotDir)

        // Wire DashboardReporter (DB already created above before parse step)
        const { LogManager } = await import('@vostride/agent-qa-core')
        if (reporterSelection.dashboard && dashboardDb) {
          try {
            const { DashboardReporter } = await import('@vostride/agent-qa-dashboard')
            const { resolve } = await import('node:path')
            const dashArtifactsDir = config.services?.dashboard?.artifactsDir ?? RUNTIME_ARTIFACTS_DIR
            reporters.push(new DashboardReporter({
              db: dashboardDb,
              artifactsDir: resolve(configDir, dashArtifactsDir),
              redactor: runtimeSecrets.secretRedactor,
              onRunCreated: (runId: string) => { currentRunId = runId; logger.setRunId(runId) },
            }))
          } catch (err) {
            console.warn(pc.yellow(`Warning: Could not load dashboard reporter: ${err instanceof Error ? err.message : String(err)}`))
          }
        }
        const analyticsReporter = createAnalyticsRunReporter({ config, surface: 'cli' })
        reporters.push(analyticsReporter)

        const logger = new LogManager({
          runId: process.env.AGENT_QA_RUN_ID || undefined,
          displayLevel: effectiveLogLevel as any,
          storage: logStorage,
          ndjson: process.env.AGENT_QA_LIVE_EVENTS === 'true',
          redactor: runtimeSecrets.secretRedactor,
        })

        // Wire action cache with logger (skip when --no-cache)
        if (opts.cache !== false) {
          const { FileActionCache } = await import('@vostride/agent-qa-core')
          const { resolve } = await import('node:path')
          actionCache = new FileActionCache({
            dir: resolve(configDir, config.services?.cache?.dir ?? RUNTIME_CACHE_DIR),
            ttl: config.services?.cache?.ttl ?? '7d',
            logger: logger.createScopedLogger('cache'),
          })
        } else {
          const cacheLog = logger.createScopedLogger('cache')
          cacheLog.info('Cache disabled via --no-cache', { operation: 'bypass' })
        }

        const multiReporter = new MultiReporter(reporters)

        const results: TestResult[] = []

        let circuitBreaker: import('@vostride/agent-qa-core').CircuitBreaker | undefined
        let circuitBreakerTripped = false
        const memoryGlobalConfig = config.services?.memory
        const runtimeMemoryRoot = resolveMemoryRoot(config, configDir)
        if (opts.memory !== false && memoryGlobalConfig?.circuitBreakerEnabled !== false && memoryGlobalConfig?.enabled !== false) {
          const { CircuitBreaker } = await import('@vostride/agent-qa-core')
          circuitBreaker = new CircuitBreaker({
            windowSize: memoryGlobalConfig?.circuitBreakerWindowSize,
            baselineSize: memoryGlobalConfig?.circuitBreakerBaselineSize,
            threshold: memoryGlobalConfig?.circuitBreakerThreshold,
          })
        }

        await multiReporter.onRunStart(filtered)

        type DirectTestOutcome = { failed: boolean }
        const runOneDirectTest = async (test: TestDefinition): Promise<DirectTestOutcome> => {
          let currentPlatform: 'web' | 'android' | 'ios' | null = null
          let currentAdapterKey: string | null = null
          let adapter: import('@vostride/agent-qa-core').PlatformAdapter | null = null
          let analyticsRunId: string | undefined
          let analyticsFilePath = 'unknown'
          let analyticsPlatform: 'web' | 'android' | 'ios' | undefined
          let analyticsTestId: string | undefined
          let analyticsAttributes: RunAttributes | undefined = resolveCliRunAttributes(
            userRunAttributes,
            'local',
            inheritedRunAttributes,
          )
          let analyticsMobileTransport: string | undefined
          let analyticsAppState: string | undefined
          let analyticsStartedAt = Date.now()
          let completedResult: TestResult | undefined
          try {
          try {
          let testResolvedTarget = resolveTarget(config, test.target!)
          let testTargetUrl = testResolvedTarget.url

          const testDef = {
            ...test,
            url: testTargetUrl,
          }
          analyticsTestId = testDef['test-id']

          const filePath = files.find(f =>
            parseResult.tests.some(t => t.name === test.name),
          ) ?? 'unknown'
          analyticsFilePath = filePath

          const runId = process.env.AGENT_QA_RUN_ID ?? generateRunId()
          analyticsRunId = runId
          analyticsStartedAt = Date.now()
          currentRunId = runId
          logger.setRunId(runId)

          // Read raw test file content for cache key scoping
          let testFileContent = ''
          if (filePath !== 'unknown') {
            try {
              const { readFile: readTestFile } = await import('node:fs/promises')
              testFileContent = await readTestFile(filePath, 'utf-8')
            } catch { /* best-effort */ }
          }

          // Per-test config merge (global config < test YAML use: < CLI flags)
          const testFlagOverrides: Record<string, unknown> = {}
          if (opts.headless !== undefined) testFlagOverrides['browser'] = { headless: opts.headless }
          if (opts.browser) testFlagOverrides['browser'] = { ...(testFlagOverrides['browser'] as Record<string, unknown> ?? {}), name: opts.browser }

          const mergedUse = mergeUseBlocks(
            config.use as Record<string, unknown>,
            undefined,
            test.use as Record<string, unknown> | undefined,
            testFlagOverrides,
          )
          const testMergedConfig = { ...config, use: mergedUse } as AgentQaConfig
          const effectiveCacheEnabled = opts.cache !== false && (mergedUse as Record<string, unknown>).cache !== false

          if (opts.configDebug) {
            console.log(pc.bold(`\nConfig for: ${test.name}`))
            console.log(formatConfigDebug(config, test.use, testFlagOverrides))
            console.log()
          }

          const testPlatform: 'web' | 'android' | 'ios' = testResolvedTarget.platform
          analyticsPlatform = testPlatform
          const testAuthState = await resolveSelectedAuthStateForRun({
            config,
            configDir,
            resolvedTarget: testResolvedTarget,
            stateName: getSelectedAuthStateName(mergedUse as Record<string, unknown>),
          })

          const testMergedUse = (testMergedConfig as any).use ?? (config as any).use ?? {}
          const testDeviceName = opts.device ?? testMergedUse.device as string | undefined

          const testTimeoutsForSetup = {
            step: (testMergedConfig as any).use?.timeout?.step ?? config.use?.timeout?.step,
            test: (testMergedConfig as any).use?.timeout?.test ?? config.use?.timeout?.test,
            navigation: (testMergedConfig as any).use?.timeout?.navigation ?? config.use?.timeout?.navigation,
          }

          const testLocalBindings = testPlatform === 'android' || testPlatform === 'ios'
            ? loadLocalBindings()
            : null
          let testMobileResolved: ResolvedMobileRunConfig | undefined
          let testResolvedDevice: ResolvedDevice | undefined
          let testFarmSession: PlatformConfig['farmSession'] | undefined
          if (testPlatform === 'android' || testPlatform === 'ios') {
            testMobileResolved = resolveMobileRunOrThrow({
              config: config as unknown as Record<string, any>,
              targetName: testResolvedTarget.name,
              platform: testPlatform,
              explicitDeviceName: opts.device,
              useDeviceName: testMergedUse.device as string | undefined,
              appState: testMergedUse.mobile?.appState as 'preserve' | 'reset' | undefined,
              localBindings: testLocalBindings,
              configFilePath: resolvePath(configFilePath),
              localConfigFilePath: testLocalBindings?.filePath,
              appiumUrl: process.env.AGENT_QA_APPIUM_URL,
            })
            analyticsAppState = testMobileResolved.appState
            const resolved = await resolveDeviceAndFarmSession(
              config, testMobileResolved.deviceName, testPlatform,
              `${test.name} — ${new Date().toISOString().slice(0, 19)}`,
              testTimeoutsForSetup.test,
              testMobileResolved.device,
              testLocalBindings,
              testMobileResolved,
            )
            testResolvedDevice = resolved.resolvedDevice
            testFarmSession = resolved.farmSession
            analyticsMobileTransport = testResolvedDevice?.transport
          }

          const useFarm = testResolvedDevice?.transport !== undefined && testResolvedDevice.transport !== 'local'
          const testAttributes = resolveCliRunAttributes(
            userRunAttributes,
            resolveRunnerAttribute(testResolvedDevice?.transport),
            inheritedRunAttributes,
          )
          analyticsAttributes = testAttributes
          writeRunAttributesToEnv(testAttributes)
          const adapterKey = JSON.stringify({
            platform: testPlatform,
            device: testResolvedDevice?.name,
            appPackage: testMobileResolved?.app.appPackage,
            appActivity: testMobileResolved?.app.appActivity,
            bundleId: testMobileResolved?.app.bundleId,
            appPath: testMobileResolved?.app.install?.path,
            browserstackApp: testMobileResolved?.app.install?.browserstack,
          })

            // Each direct test owns its adapter so parallel batches cannot share mutable browser/mobile state.
            if (testPlatform !== currentPlatform || adapterKey !== currentAdapterKey) {
              currentPlatform = testPlatform
              currentAdapterKey = adapterKey

              // Auto-start Appium for mobile platforms (if not already running and not in farm mode)
              if ((testPlatform === 'ios' || testPlatform === 'android') && !useFarm) {
                try {
                  const appiumUrl = await acquireAppium(effectiveLogLevel)
                  if (testMobileResolved) {
                    testMobileResolved = { ...testMobileResolved, appium: { url: appiumUrl, managed: !process.env.AGENT_QA_APPIUM_URL } }
                  }
                } catch (err) {
                  throw new MobileSetupError({
                    category: 'appium-startup',
                    message: `Could not auto-start Appium: ${err instanceof Error ? err.message : String(err)}`,
                    platform: testPlatform,
                    targetName: testResolvedTarget.name,
                    deviceName: testDeviceName,
                    cause: err,
                  })
                }
              }

              adapter = await createPlatformAdapter(testPlatform)

              const mergedBrowser = (mergedUse as Record<string, unknown>).browser as Record<string, unknown> | undefined
              const platformConfig = buildPlatformConfig(testPlatform, testResolvedDevice, testTimeoutsForSetup, mergedBrowser ?? config.use?.browser, (testMergedConfig as any).use?.logCapture ?? config.use?.logCapture, testFarmSession, testMobileResolved)
              platformConfig.authState = testAuthState
              platformConfig.verbose = effectiveLogLevel === 'debug'
              if (opts.headless !== undefined) {
                if (platformConfig.browser) {
                  platformConfig.browser.headless = opts.headless
                }
              }

              // Wire recording config for this platform adapter
              const anyTestNeedsRecording = filtered.some(t => (t.meta as any)?.record === true)
              if (recordingEnabled || anyTestNeedsRecording) {
                const recCfg = config.services?.recording as Record<string, unknown> | undefined
                platformConfig.recording = {
                  enabled: true,
                  videoDir: resolveDashboardVideoDir(config, configDir, dashboardEnabled),
                  videoSize: recCfg?.videoSize as { width: number; height: number } | undefined,
                }
              }

              await adapter.setup(platformConfig)

              // Exit cleanup for farm sessions on mobile
              if (useFarm && (testPlatform === 'android' || testPlatform === 'ios')) {
                const farmAdapter = adapter
                process.on('exit', () => { void Promise.resolve(farmAdapter.cleanup()).catch(() => {}) })
              }

              if (effectiveLogLevel === 'debug') {
                console.log(pc.dim(`  Platform: ${testPlatform}${useFarm ? ` (farm: ${testResolvedDevice?.transport})` : ''}${testPlatform !== 'web' ? ' (adapter re-created)' : ''}`))
              }
            }

            // Per-test model creation using merged LLM config
            const mergedForLLM = { registry: (config as any).registry, use: (testMergedConfig as any).use ?? (config as any).use }
            const { planner: plannerCfg, verifier: verifierCfg, configName } = resolveLLMModels(mergedForLLM)
            const resolvedAuth = await resolveModelAuth(configName, plannerCfg)
            const plannerModelConfig = applyResolvedAuthToModelConfig(plannerCfg, resolvedAuth)
            const verifierModelConfig = applyResolvedAuthToModelConfig(verifierCfg, resolvedAuth)
            process.env.AGENT_QA_LLM_MODEL = plannerCfg.model
            process.env.AGENT_QA_LLM_PROVIDER = plannerCfg.provider
            if (effectiveLogLevel === 'debug') {
              console.log(pc.dim(`  Model: ${plannerCfg.model} (${plannerCfg.provider})`))
            }
            const plannerModel = await createModel(plannerModelConfig)
            const verifierModel = await createModel(verifierModelConfig)
            const plannerConfig = {
              maxSubActions: testMergedConfig.use?.planner?.maxSubActions ?? 10,
              previousStepCount: testMergedConfig.use?.planner?.previousStepCount ?? 3,
            }

            const providerOpts = getProviderOptions(plannerModelConfig)
            const testLogCapture = (testMergedConfig as any).use?.logCapture ?? config.use?.logCapture
            let testEffectiveRules = agentRulesContent ?? ''
            if (testLogCapture?.console === false) {
              testEffectiveRules += '\nConsole log capture is DISABLED for this test run. The readConsoleLogs action will return no data. If a test step explicitly requires reading console logs, use stepFailed to fail the step — do not silently pass with empty data.'
            }
            if (testLogCapture?.network === false) {
              testEffectiveRules += '\nNetwork log capture is DISABLED for this test run. The readNetworkLogs action will return no data. If a test step explicitly requires reading network logs, use stepFailed to fail the step — do not silently pass with empty data.'
            }
            const planner = new LLMPlanner(plannerModel, testPlatform, providerOpts, logger.createScopedLogger('planner'), testEffectiveRules || undefined)
            const verifier = new LLMVerifier(verifierModel, providerOpts)

            // Per-test timeouts from merged config
            const testTimeouts = {
              step: testMergedConfig.use?.timeout?.step,
              test: testMergedConfig.use?.timeout?.test,
              navigation: testMergedConfig.use?.timeout?.navigation,
            }

            // Per-test healing config from merged config
            const testHealingConfig = {
              maxAttempts: testMergedConfig.use?.healing?.maxAttempts ?? 3,
            }

            // Per-test recording override: meta.record takes priority over global
            let testRecording: import('@vostride/agent-qa-core').PlatformConfig['recording'] | undefined
            const testRecordMeta = (testDef.meta as any)?.record
            if (testRecordMeta === true || recordingEnabled) {
              const recCfg2 = config.services?.recording as Record<string, unknown> | undefined
              testRecording = {
                enabled: true,
                videoDir: resolveDashboardVideoDir(config, configDir, dashboardEnabled),
                videoSize: recCfg2?.videoSize as { width: number; height: number } | undefined,
              }
            }
            if (testRecordMeta === false) {
              testRecording = undefined
            }

            const artifactContext = buildRunArtifactContext({
              kind: 'test',
              configContent,
              parsedConfig: config,
              effectiveConfig: testMergedConfig,
              envFilePath: resolvedEnvFilePath,
              rawEnvFileContent,
              envFileVars,
              secretsFileMetadata: runtimeSecrets.secretsFileMetadata,
              cliVars,
              inlineVars,
              hooks: resolvedHooks,
              planner: { provider: plannerCfg.provider, model: plannerCfg.model },
              verifier: { provider: verifierCfg.provider, model: verifierCfg.model },
              platform: testPlatform,
              target: testResolvedTarget,
              deviceName: testDeviceName,
              attributes: testAttributes,
              timeouts: testTimeouts,
              cache: {
                enabled: effectiveCacheEnabled,
                dir: config.services?.cache?.dir,
                ttl: config.services?.cache?.ttl,
              },
              memory: {
                enabled: opts.memory !== false && config.services?.memory?.enabled !== false,
                curatorEnabled: config.services?.memory?.curatorEnabled,
                provider: config.services?.memory?.provider ?? 'local',
              },
              source: {
                kind: 'test',
                testId: testDef['test-id'] ?? null,
                name: testDef.name,
                filePath,
                rawYaml: testFileContent || null,
                resolvedDefinition: testDef,
                loadStatus: 'loaded',
              },
            })

            // Fire onTestStart BEFORE setup hooks so DashboardReporter creates
            // the DB row and runId is available for hook recording (Phase 107 fix)
            await (multiReporter.onTestStart as any)(testDef, filePath, {
              runId,
              artifact: artifactContext.artifact,
            })

            const authAwareSandboxOptions = sandboxOptions && testAuthState
              ? { ...sandboxOptions, authState: testAuthState }
              : sandboxOptions

            // Per-test setup hooks: run BEFORE test execution (D-01, D-03)
            let perTestSetupVars: Record<string, string> = {}
            let testStartTime = Date.now()
            let setupHookFailed = false
            if (resolvedHooks && authAwareSandboxOptions && (testDef as any).setup?.length) {
              const { runHooks } = await import('@vostride/agent-qa-core')
              const hookDefs: HookDefinition[] = []
              let hookSetupError: string | undefined
              for (const hookId of (testDef as any).setup) {
                const hook = resolvedHooks.get(hookId)
                if (!hook) { hookSetupError = `Hook ID "${hookId}" not found in hooks registry`; break }
                hookDefs.push(hook)
              }

              if (!hookSetupError && hookDefs.length > 0) {
                const allVars: Record<string, string> = { ...envFileVars }
                if (inlineVars) Object.assign(allVars, inlineVars)
                if ((testDef as any).variables) Object.assign(allVars, (testDef as any).variables)
                if (cliVars) Object.assign(allVars, cliVars)

                for (const hookDef of hookDefs) {
                  const hookExecId = randomUUID()
                  await multiReporter.onHookStart({ hookId: hookDef.id, hookName: hookDef.name, phase: 'setup', hookExecutionId: hookExecId, runId })
                  const hookResult = await runHooks([hookDef], { ...authAwareSandboxOptions, envVars: { ...authAwareSandboxOptions.envVars, ...allVars, ...perTestSetupVars } })
                  const hr = hookResult.results.get(hookDef.name)
                  await multiReporter.onHookEnd({
                    hookId: hookDef.id,
                    hookName: hookDef.name,
                    phase: 'setup',
                    hookExecutionId: hookExecId,
                    runId,
                    status: hr?.success ? 'passed' : 'failed',
                    duration: hr?.duration ?? 0,
                    stdout: hr?.stdout ?? '',
                    stderr: hr?.stderr ?? '',
                    variables: hr?.variables ?? {},
                    error: hr?.error,
                  })
                  if (!hr?.success) {
                    hookSetupError = `Setup hook "${hookDef.name}" failed: ${hr?.error ?? 'unknown'}`
                    break
                  }
                  Object.assign(perTestSetupVars, hr.variables)
                  Object.assign(allVars, hr.variables)
                }
              }

              if (hookSetupError) {
                setupHookFailed = true
                const setupResult: TestResult = {
                  runId,
                  name: test.name,
                  filePath,
                  status: 'failed',
                  steps: [],
                  duration: Date.now() - testStartTime,
                  failureSummary: hookSetupError,
                }
                results.push(setupResult)
                await multiReporter.onTestEnd(setupResult)
                printRunAttributes(testAttributes)
              }
            }

            if (setupHookFailed) {
              return { failed: true }
            }

            // Memory provider setup (best-effort)
            let memoryProvider: import('@vostride/agent-qa-core').MemoryProvider | undefined
            let memoryInitParams: import('@vostride/agent-qa-core').MemoryIndexParams | undefined
            const memoryConfig = config.services?.memory
            let memoryRoot: string | undefined
            if (opts.memory !== false && memoryConfig?.enabled !== false) {
              try {
                const { createMemoryProvider } = await import('@vostride/agent-qa-core')
                memoryRoot = runtimeMemoryRoot
                memoryProvider = await createMemoryProvider({
                  provider: memoryConfig?.provider ?? 'local',
                  memoryRoot,
                  curatorLockTimeout: memoryConfig?.curatorLockTimeout,
                })
                const product = testResolvedTarget.product
                const testId = testDef['test-id'] ?? testDef.name
                memoryInitParams = { product, testId, memoryRoot }
              } catch (err) {
                console.warn(`  ${pc.dim('Memory:')} init error -- ${(err as Error).message}`)
              }
            }

            const result = await runTestWithRetry(testDef, {
              adapter: adapter!,
              planner,
              verifier,
              healingConfig: testHealingConfig,
              plannerModel,
              verifierModel,
              reporters,
              captureScreenshots,
              screenshotMode: (opts.screenshotMode as 'failure' | 'every-step') ?? 'failure',
              cache: effectiveCacheEnabled ? actionCache : undefined,
              recording: testRecording,
              plannerConfig,
              timeouts: testTimeouts,
              logger,
              configContent,
              testFileContent,
              envFileVars,
              secretStore: runtimeSecrets.secretStore,
              secretRedactor: runtimeSecrets.secretRedactor,
              secretsFileMetadata: runtimeSecrets.secretsFileMetadata,
              inlineVars,
              cliVars,
              hookSetupVars: perTestSetupVars,
              inlineHookDefs: resolvedHooks,
              inlineHookSandboxOptions: authAwareSandboxOptions,
              logCapture: testLogCapture,
              accessibility: config.services?.accessibility,
              accessibilityCheck: runWebAccessibilityCheck,
              screenshotSize: plannerCfg.screenshotSize,
              effectiveResolution: plannerCfg.effectiveResolution,
              contextWindow: plannerCfg.contextWindow,
              memoryProvider,
              memoryInitParams,
              circuitBreaker,
              runId,
              skipReporterOnTestStart: true,
            } as any, filePath)

            if (!result.runId) result.runId = runId
            completedResult = result

            // Per-test teardown hooks: run AFTER test execution (D-01, D-03)
            if (resolvedHooks && authAwareSandboxOptions && (testDef as any).teardown?.length) {
              const { runHooks } = await import('@vostride/agent-qa-core')
              for (const hookId of (testDef as any).teardown) {
                const hook = resolvedHooks.get(hookId)
                if (!hook) continue
                const hookExecId = randomUUID()
                try {
                  await multiReporter.onHookStart({ hookId: hook.id, hookName: hook.name, phase: 'teardown', hookExecutionId: hookExecId, runId })
                  const allVars: Record<string, string> = { ...envFileVars, ...perTestSetupVars }
                  if (cliVars) Object.assign(allVars, cliVars)
                  const hookResult = await runHooks([hook], { ...authAwareSandboxOptions, envVars: { ...authAwareSandboxOptions.envVars, ...allVars } })
                  const hr = hookResult.results.get(hook.name)
                  await multiReporter.onHookEnd({
                    hookId: hook.id,
                    hookName: hook.name,
                    phase: 'teardown',
                    hookExecutionId: hookExecId,
                    runId,
                    status: hr?.success ? 'passed' : 'failed',
                    duration: hr?.duration ?? 0,
                    stdout: hr?.stdout ?? '',
                    stderr: hr?.stderr ?? '',
                    variables: hr?.variables ?? {},
                    error: hr?.error,
                  })
                } catch {}
              }
            }

            // Capture farm session URL and device context for metadata
            if (useFarm && adapter) {
              try {
                const farmSessionUrl = (adapter as any).getSessionUrl?.()
                result.metadata = {
                  ...result.metadata,
                  ...(farmSessionUrl ? { farmSessionUrl } : {}),
                  runDevice: testPlatform === 'web'
                    ? `${config.use?.browser?.name ?? 'chromium'} (remote)`
                    : `${testResolvedDevice?.name ?? testPlatform} (remote)`,
                }
                if (result.status === 'failed') {
                  (adapter as any).markFailed?.()
                }
              } catch { /* best-effort session URL capture */ }
            } else {
              result.metadata = {
                ...result.metadata,
                runDevice: testPlatform === 'web'
                  ? `${config.use?.browser?.name ?? 'chromium'} (local)`
                  : `${testResolvedDevice?.name ?? testPlatform} (local)`,
              }
            }

            // Selective ablation: re-run failed test without memory to confirm memory caused failure (REL-01)
            let ablationHandledDeprecation = false
            if (memoryProvider && memoryConfig?.ablationEnabled !== false && result.status === 'failed') {
              try {
                const { shouldAblate, collectAllInjectedIds, deprecateOnFailure } = await import('@vostride/agent-qa-core')
                if (shouldAblate(result, memoryProvider)) {
                  console.log(`  ${pc.dim('Memory:')} ablation retry -- re-running without memory...`)
                  const ablationAdapter = await createPlatformAdapter(testPlatform)
                  const mergedBrowser = (mergedUse as Record<string, unknown>).browser as Record<string, unknown> | undefined
                  const ablationPlatformConfig = buildPlatformConfig(testPlatform, testResolvedDevice, testTimeoutsForSetup, mergedBrowser ?? config.use?.browser, (testMergedConfig as any).use?.logCapture ?? config.use?.logCapture, testFarmSession, testMobileResolved)
                  ablationPlatformConfig.authState = testAuthState
                  ablationPlatformConfig.verbose = effectiveLogLevel === 'debug'
                  if (opts.headless !== undefined && ablationPlatformConfig.browser) {
                    ablationPlatformConfig.browser.headless = opts.headless
                  }
                  await ablationAdapter.setup(ablationPlatformConfig)
                  try {
                    const ablationResult = await runTestWithRetry(testDef, {
                      adapter: ablationAdapter,
                      planner,
                      verifier,
                      healingConfig: testHealingConfig,
                      plannerModel,
                      verifierModel,
                      reporters: undefined,
                      captureScreenshots,
                      screenshotMode: (opts.screenshotMode as 'failure' | 'every-step') ?? 'failure',
                      cache: effectiveCacheEnabled ? actionCache : undefined,
                      recording: testRecording,
                      plannerConfig,
                      timeouts: testTimeouts,
                      logger,
                      configContent,
                      testFileContent,
                      envFileVars,
                      secretStore: runtimeSecrets.secretStore,
                      secretRedactor: runtimeSecrets.secretRedactor,
                      secretsFileMetadata: runtimeSecrets.secretsFileMetadata,
                      inlineVars,
                      cliVars,
                      hookSetupVars: perTestSetupVars,
                      inlineHookDefs: resolvedHooks,
                      inlineHookSandboxOptions: authAwareSandboxOptions,
                      logCapture: testLogCapture,
                      accessibility: config.services?.accessibility,
                      accessibilityCheck: runWebAccessibilityCheck,
                      screenshotSize: plannerCfg.screenshotSize,
                      effectiveResolution: plannerCfg.effectiveResolution,
                      contextWindow: plannerCfg.contextWindow,
                    }, filePath)

                    if (circuitBreaker) {
                      circuitBreaker.record({ withMemory: false, passed: ablationResult.status === 'passed' })
                    }

                    if (ablationResult.status === 'passed') {
                      console.log(`  ${pc.dim('Memory:')} ablation confirmed memory caused failure -- penalizing observations`)
                      const injectedMap = collectAllInjectedIds(result, memoryProvider)
                      await deprecateOnFailure({
                        testResult: result,
                        provider: memoryProvider,
                        memoryRoot: memoryRoot ?? runtimeMemoryRoot,
                        injectedObservationIds: injectedMap,
                        trustContradictDelta: memoryConfig?.trustContradictDelta,
                      })
                      ablationHandledDeprecation = true
                    } else {
                      console.log(`  ${pc.dim('Memory:')} ablation retry also failed -- memory not the cause`)
                    }
                  } finally {
                    await ablationAdapter.cleanup()
                  }
                }
              } catch (err) {
                console.warn(`  ${pc.dim('Memory:')} ablation error -- ${(err as Error).message}`)
              }
            }

            // Memory curator: inline blocking after teardown hooks (D-02)
            if (memoryProvider && memoryConfig?.curatorEnabled !== false && !ablationHandledDeprecation) {
              try {
                const { runCurator } = await import('@vostride/agent-qa-core')
                const injectedObservationIds = new Map<number, string[]>()
                for (let i = 0; i < result.steps.length; i++) {
                  const ids = memoryProvider.getInjectedObservations(i)
                  if (ids.length > 0) injectedObservationIds.set(i, ids)
                }
                const curatorProduct = testResolvedTarget.product
                const testId = testDef['test-id'] ?? testDef.name
                const memoryLog = await runCurator({
                  testResult: result,
                  provider: memoryProvider,
                  model: plannerModel,
                  providerOptions: providerOpts,
                  memoryRoot: memoryRoot ?? runtimeMemoryRoot,
                  product: curatorProduct,
                  testId,
                  injectedObservationIds,
                  trustConfirmDelta: memoryConfig?.trustConfirmDelta,
                  trustContradictDelta: memoryConfig?.trustContradictDelta,
                });
                (result as any).memoryLog = memoryLog
                printMemoryStatus(memoryLog)
                if (dashboardDb && currentRunId) {
                  try {
                    dashboardDb.updateRun(currentRunId, { memoryLog: JSON.stringify(memoryLog) })
                  } catch { /* DB write failure must not fail the test */ }
                }
              } catch (err) {
                console.warn(`  ${pc.dim('Memory:')} curator error -- ${(err as Error).message}`)
              }
            }

            results.push(result)
            printRunAttributes(testAttributes)

            if (circuitBreaker && memoryProvider) {
              const hadMemory = result.steps.some((_, i) => memoryProvider!.getInjectedObservations(i).length > 0)
              circuitBreaker.record({ withMemory: hadMemory, passed: result.status === 'passed' })
            }
            if (circuitBreaker?.isTripped() && !circuitBreakerTripped) {
              circuitBreakerTripped = true
              console.log(`  ${pc.yellow('Memory: circuit breaker tripped -- disabling memory injection for remaining tests')}`)
            }

            // Post-run cache invalidation: delete all step cache entries for failed runs
            if (result.status === 'failed' && actionCache && effectiveCacheEnabled && result.steps.length > 0) {
              const { hashStepInstruction } = await import('@vostride/agent-qa-core')
              const { rm } = await import('node:fs/promises')
              const { resolve, join } = await import('node:path')
              const cacheDir = resolve(configDir, config.services?.cache?.dir ?? RUNTIME_CACHE_DIR)
              const cacheLog = logger.createScopedLogger('cache')

              let purged = 0
              for (let i = 0; i < result.steps.length; i++) {
                const step = result.steps[i]
                const stepHash = hashStepInstruction(step.name, testPlatform, configContent, testFileContent, i)
                try {
                  await rm(join(cacheDir, stepHash), { recursive: true, force: true })
                  purged++
                } catch { /* ignore — directory may not exist */ }
              }

              if (purged > 0) {
                cacheLog.info('Failed run cache invalidation', {
                  operation: 'batch-purge',
                  stepHash: 'batch',
                  entriesDeleted: purged,
                })
              }
            }

            return { failed: result.status === 'failed' }
          } finally {
            if (adapter) await adapter.cleanup()
          }
          } catch (err) {
            if ((analyticsPlatform === 'android' || analyticsPlatform === 'ios') && analyticsRunId) {
              const errorMessage = err instanceof Error ? err.message : String(err)
              const analyticsResult = completedResult ?? {
                runId: analyticsRunId,
                name: test.name,
                filePath: analyticsFilePath,
                status: 'failed',
                steps: [],
                duration: Date.now() - analyticsStartedAt,
                failureSummary: errorMessage,
                metadata: {
                  phase: 'setup',
                  error: errorMessage,
                  platform: analyticsPlatform,
                  testId: analyticsTestId,
                  attributes: analyticsAttributes,
                  runtime: {
                    platform: analyticsPlatform,
                    mobileTransport: analyticsMobileTransport,
                    appState: analyticsAppState,
                  },
                },
              } satisfies TestResult
              await captureSingleAnalyticsResult(analyticsReporter, analyticsResult)
            }
            throw err
          }
        }

        const pendingParallelRuns: Promise<DirectTestOutcome>[] = []
        const flushParallelRuns = async (): Promise<boolean> => {
          if (pendingParallelRuns.length === 0) return false
          const batch = pendingParallelRuns.splice(0, pendingParallelRuns.length)
          const outcomes = await Promise.all(batch)
          return outcomes.some((outcome) => outcome.failed)
        }

        let bailTriggered = false
        for (const test of filtered) {
          const testFlagOverrides: Record<string, unknown> = {}
          if (opts.headless !== undefined) testFlagOverrides.browser = { headless: opts.headless }
          if (opts.browser) testFlagOverrides.browser = { ...(testFlagOverrides.browser as Record<string, unknown> ?? {}), name: opts.browser }
          const schedulingUse = mergeUseBlocks(
            config.use as Record<string, unknown>,
            undefined,
            test.use as Record<string, unknown> | undefined,
            testFlagOverrides,
          )
          const schedulingTarget = resolveTarget(config, test.target!)
          const canRunInParallel = schedulingTarget.platform === 'web' && (schedulingUse as Record<string, unknown>).parallel === true

          if (canRunInParallel) {
            pendingParallelRuns.push(runOneDirectTest(test))
            continue
          }

          const parallelBatchFailed = await flushParallelRuns()
          if (opts.bail && parallelBatchFailed) {
            console.log(pc.yellow('\nBailing out — stopping after first failure'))
            bailTriggered = true
            break
          }

          const outcome = await runOneDirectTest(test)
          if (opts.bail && outcome.failed) {
            console.log(pc.yellow('\nBailing out — stopping after first failure'))
            bailTriggered = true
            break
          }
        }

        if (!bailTriggered) {
          const parallelBatchFailed = await flushParallelRuns()
          if (opts.bail && parallelBatchFailed) {
            console.log(pc.yellow('\nBailing out — stopping after first failure'))
          }
        }

        releaseAppium()

        const duration = results.reduce((sum, r) => sum + r.duration, 0)
        const passed = results.filter(r => r.status === 'passed').length
        const failed = results.filter(r => r.status === 'failed').length
        const skipped = results.filter(r => r.status === 'skipped').length

        await multiReporter.onRunEnd({ results, duration, passed, failed, skipped })
        await flushAnalyticsRunReporter(analyticsReporter)

        if (dashboardDb) {
          dashboardDb.close()
        }

        const hasFailed = results.some(r => r.status === 'failed') || suitesFailed
        process.exit(hasFailed ? 1 : 0)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errStack = err instanceof Error ? err.stack ?? '' : ''
        const formattedError = formatFrameworkError(errMsg)
        console.error(pc.red(formattedError.displayMessage))

        if (_crashDb) {
          const fullError = `${errMsg}\n${errStack}`
          const isBrowserClose = fullError.includes('Target page, context or browser has been closed')
            || fullError.includes('browser has been closed')
            || fullError.includes('Browser closed')
          try {
            const runs = _crashDb.getRuns({ status: 'running' })
            for (const run of runs) {
              const finalStatus = isBrowserClose ? 'cancelled' : 'failed'
              printRunId(run.id)
              printRunAttributes(run.attributes)
              _crashDb.updateRun(run.id, {
                status: finalStatus,
                duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : 0,
                endedAt: new Date().toISOString(),
                failureSummary: isBrowserClose ? 'Browser closed by user' : redactAuthStateValue(formattedError.failureSummary),
              })
              try {
                const artifact = _crashDb.getRunArtifact(run.id)
                if (artifact && !artifact.finalizedAt) {
                  _crashDb.finalizeRunArtifact(run.id, {
                    runtime: {
                      status: finalStatus,
                      duration: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : 0,
                    },
                    errors: [{
                      code: isBrowserClose ? 'browser-disconnect' : 'process-close',
                      phase: 'process-close',
                      message: isBrowserClose ? 'Browser closed by user' : redactAuthStateValue(formattedError.failureSummary),
                    }],
                  })
                }
              } catch { /* best-effort cleanup */ }
            }
          } catch { /* best-effort cleanup */ }
        }

        if (_crashDb) {
          try { _crashDb.close() } catch {}
        }
        process.exit(2)
      }
    })

  return cmd
}
