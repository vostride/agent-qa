import type { RunArtifactReporterContext } from '../artifacts/run-artifact.js'
import {
  ATTR_RUNNER,
  ATTR_TRIGGER,
  buildInternalRunAttributes,
  type RunAttributes,
  validateTrustedRunAttributes,
} from '../run-attributes.js'
import type {
  HookResultEvent,
  Reporter,
  RunSummary,
  SuiteSummary,
} from '../reporter/types.js'
import type { SuiteDefinition } from '../suite/types.js'
import type { StepResult, TestResult, TokenUsage } from '../types/result.js'
import type { TestDefinition } from '../types/test.js'
import { buildAnalyticsEvent, type AnalyticsEventProperties, type AnalyticsSurface } from './events.js'
import {
  createAnalyticsService,
  resolveAnalyticsStandardProperties,
  type AnalyticsService,
  type AnalyticsServiceConfig,
  type AnalyticsServiceOptions,
} from './service.js'
import type { AnalyticsTransport } from './transport.js'

type RecordLike = Record<string, unknown>

interface RunState {
  runId: string
  parentRunId?: string
  testId?: string
  suiteId?: string
  attributes: RunAttributes
  platform?: AnalyticsEventProperties['platform']
  browserName?: string
  mobileTransport?: string
  mobileProvider?: string
  appState?: string
  executionDestination?: string
  provider?: string
  providerMode?: string
  plannerModel?: string
  verifierModel?: string
  memoryEnabled?: boolean
  memoryInjectedObservationCount?: number
  hookCount: number
  failedHookCount: number
}

interface SuiteState {
  runId: string
  suiteId?: string
  attributes: RunAttributes
  executionMode?: AnalyticsEventProperties['suite_execution_mode']
}

export interface AnalyticsRunReporterOptions extends Omit<AnalyticsServiceOptions, 'transport'> {
  surface?: AnalyticsSurface
  service?: AnalyticsService
  transport?: AnalyticsTransport
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readNestedRecord(source: unknown, key: string): RecordLike | undefined {
  if (!isRecord(source)) return undefined
  const value = source[key]
  return isRecord(value) ? value : undefined
}

function readAttributes(value: unknown): RunAttributes | undefined {
  try {
    const attributes = validateTrustedRunAttributes(value, 'run artifact attributes')
    return Object.keys(attributes).length > 0 ? attributes : undefined
  } catch {
    return undefined
  }
}

function readAttributesFromEnv(env: Record<string, string | undefined> = process.env): RunAttributes | undefined {
  const raw = env.AGENT_QA_RUN_ATTRIBUTES_JSON
  if (!raw) return undefined
  try {
    return readAttributes(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function fallbackAttributes(): RunAttributes {
  return buildInternalRunAttributes({ trigger: 'cli', runner: 'local' })
}

function normalizeTriggerSource(value: unknown): AnalyticsEventProperties['trigger_source'] {
  if (value === 'cli' || value === 'dashboard' || value === 'api' || value === 'mcp') return value
  return 'unknown'
}

function normalizeRunner(value: unknown): AnalyticsEventProperties['runner'] {
  if (value === 'local' || value === 'browserstack') return value
  return 'unknown'
}

function normalizePlatform(value: unknown): AnalyticsEventProperties['platform'] | undefined {
  if (value === 'web' || value === 'android' || value === 'ios') return value
  return undefined
}

function normalizeStatus(value: unknown): AnalyticsEventProperties['status'] {
  if (value === 'passed' || value === 'failed' || value === 'skipped' || value === 'cancelled') return value
  return 'unknown'
}

function normalizeSuiteExecutionMode(value: unknown): AnalyticsEventProperties['suite_execution_mode'] | undefined {
  if (value === 'parallel' || value === 'sequential' || value === 'unknown') return value
  if (typeof value === 'boolean') return value ? 'parallel' : 'sequential'
  return undefined
}

function readArtifactSource(context?: RunArtifactReporterContext): RecordLike | undefined {
  return isRecord(context?.artifact?.source) ? context?.artifact?.source : undefined
}

function readArtifactConfig(context?: RunArtifactReporterContext): RecordLike | undefined {
  return isRecord(context?.artifact?.config) ? context?.artifact?.config : undefined
}

function readArtifactRuntime(context?: RunArtifactReporterContext): RecordLike {
  const artifactRuntime = isRecord(context?.artifact?.runtime) ? context?.artifact?.runtime : undefined
  const configRuntime = readNestedRecord(readArtifactConfig(context), 'runtime')
  return {
    ...(configRuntime ?? {}),
    ...(artifactRuntime ?? {}),
  }
}

function readTestId(test: TestDefinition, context?: RunArtifactReporterContext): string | undefined {
  const fromTest = readString((test as RecordLike)['test-id'])
  if (fromTest) return fromTest
  return readString(readArtifactSource(context)?.testId)
}

function readSuiteId(suite: SuiteDefinition, context?: RunArtifactReporterContext): string | undefined {
  const fromSuite = readString((suite as RecordLike)['suite-id'])
  if (fromSuite) return fromSuite
  return readString(readArtifactSource(context)?.suiteId)
}

function resolveAttributes(context?: RunArtifactReporterContext, env?: Record<string, string | undefined>): RunAttributes {
  return readAttributes(context?.artifact?.metadata?.attributes)
    ?? readAttributesFromEnv(env)
    ?? fallbackAttributes()
}

function readRunState(input: {
  test: TestDefinition
  context?: RunArtifactReporterContext
  env?: Record<string, string | undefined>
}): RunState {
  const runtime = readArtifactRuntime(input.context)
  const config = readArtifactConfig(input.context)
  const model = readNestedRecord(config, 'model')
  const planner = readNestedRecord(model, 'planner')
  const verifier = readNestedRecord(model, 'verifier')
  const memory = readNestedRecord(config, 'memory')
  const runId = input.context?.runId ?? readString(input.context?.artifact?.runtime?.runId) ?? readTestId(input.test, input.context) ?? 'unknown'

  return {
    runId,
    parentRunId: input.context?.parentRunId ?? readString(input.context?.artifact?.parentRunId),
    testId: readTestId(input.test, input.context),
    suiteId: readString(runtime?.parentSuiteId) ?? readString(readArtifactSource(input.context)?.suiteId),
    attributes: resolveAttributes(input.context, input.env),
    platform: normalizePlatform(runtime.platform),
    browserName: readString(runtime.browserName) ?? readString(runtime.browser),
    mobileTransport: readString(runtime.mobileTransport) ?? readString(runtime.mobile_transport),
    mobileProvider: readString(runtime.mobileProvider) ?? readString(runtime.mobile_provider),
    appState: readString(runtime.appState) ?? readString(runtime.app_state),
    executionDestination: readString(runtime.executionDestination) ?? readString(runtime.execution_destination),
    provider: readString(planner?.provider),
    providerMode: readString(model?.providerMode) ?? readString(model?.provider_mode),
    plannerModel: readString(planner?.model),
    verifierModel: readString(verifier?.model),
    memoryEnabled: readBoolean(memory?.enabled),
    memoryInjectedObservationCount: readNumber(memory?.injectedObservationCount) ?? readNumber(memory?.injected_observation_count),
    hookCount: 0,
    failedHookCount: 0,
  }
}

function addTokenUsage(metrics: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  plannerCallCount?: number
}, tokenUsage: TokenUsage | undefined): void {
  if (!tokenUsage) return
  metrics.inputTokens = (metrics.inputTokens ?? 0) + tokenUsage.promptTokens
  metrics.outputTokens = (metrics.outputTokens ?? 0) + tokenUsage.completionTokens
  metrics.totalTokens = (metrics.totalTokens ?? 0) + tokenUsage.totalTokens
  metrics.plannerCallCount = (metrics.plannerCallCount ?? 0) + 1
}

function collectExecutionMetrics(result: TestResult, state?: RunState): AnalyticsEventProperties {
  const properties: AnalyticsEventProperties = {
    step_count: result.steps.length,
  }
  let passed = 0
  let failed = 0
  let skipped = 0
  let subactions = 0
  let cachedSubactions = 0
  let failedSubactions = 0
  let healingAttempts = 0
  let verifierCallCount: number | undefined
  const tokenMetrics: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    plannerCallCount?: number
  } = {}

  for (const step of result.steps) {
    if (step.status === 'passed' || step.status === 'healed') passed += 1
    if (step.status === 'failed' || step.status === 'cancelled') failed += 1
    if (step.status === 'skipped') skipped += 1
    healingAttempts += step.healingAttempts?.length ?? 0

    addTokenUsage(tokenMetrics, step.trace?.tokenUsage)
    if (step.trace?.verifierReasoning) verifierCallCount = (verifierCallCount ?? 0) + 1

    for (const subAction of step.trace?.subActions ?? []) {
      subactions += 1
      if (subAction.cached) cachedSubactions += 1
      if (subAction.result === 'failure') failedSubactions += 1
      addTokenUsage(tokenMetrics, subAction.tokenUsage)
      if (subAction.verifierReasoning) verifierCallCount = (verifierCallCount ?? 0) + 1
    }
  }

  properties.passed_step_count = passed
  properties.failed_step_count = failed
  properties.skipped_step_count = skipped
  properties.subaction_count = subactions
  properties.cached_subaction_count = cachedSubactions
  properties.failed_subaction_count = failedSubactions
  properties.healing_attempt_count = healingAttempts
  if (state?.hookCount !== undefined) properties.hook_count = state.hookCount
  if (state?.failedHookCount !== undefined) properties.failed_hook_count = state.failedHookCount
  if (tokenMetrics.inputTokens !== undefined) properties.input_tokens = tokenMetrics.inputTokens
  if (tokenMetrics.outputTokens !== undefined) properties.output_tokens = tokenMetrics.outputTokens
  if (tokenMetrics.totalTokens !== undefined) properties.total_tokens = tokenMetrics.totalTokens
  if (tokenMetrics.plannerCallCount !== undefined) properties.planner_call_count = tokenMetrics.plannerCallCount
  if (verifierCallCount !== undefined) properties.verifier_call_count = verifierCallCount

  return properties
}

function collectMemoryMetrics(result: TestResult, state?: RunState): AnalyticsEventProperties {
  const log = (result as TestResult & { memoryLog?: unknown }).memoryLog
  const properties: AnalyticsEventProperties = {}
  if (state?.memoryEnabled !== undefined) properties.memory_enabled = state.memoryEnabled
  if (state?.memoryInjectedObservationCount !== undefined) {
    properties.memory_injected_observation_count = state.memoryInjectedObservationCount
  }
  if (!isRecord(log)) return properties

  properties.memory_enabled = properties.memory_enabled ?? true
  properties.memory_added_count = readNumber(log.added)
  properties.memory_confirmed_count = readNumber(log.confirmed)
  properties.memory_deprecated_count = readNumber(log.deprecated)
  properties.memory_deleted_count = readNumber(log.deleted)
  properties.memory_error_count = Array.isArray(log.errors) ? log.errors.length : undefined

  const tokenUsage = isRecord(log.tokenUsage) ? log.tokenUsage : undefined
  properties.memory_curator_input_tokens = readNumber(tokenUsage?.promptTokens)
  properties.memory_curator_output_tokens = readNumber(tokenUsage?.completionTokens)
  properties.memory_curator_total_tokens = readNumber(tokenUsage?.totalTokens)
  return properties
}

function classifyFailureCategory(result: TestResult): AnalyticsEventProperties['failure_category'] | undefined {
  if (result.status === 'passed' || result.status === 'skipped') return undefined
  if (result.status === 'cancelled') return 'cancelled'

  const metadataPhase = readString(result.metadata?.phase)
  if (metadataPhase?.includes('hook')) return 'hook'
  if (metadataPhase?.includes('setup')) return 'setup'

  const text = `${result.failureSummary ?? ''} ${readString(result.metadata?.error) ?? ''}`.toLowerCase()
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  if (text.includes('cancel')) return 'cancelled'
  if (text.includes('hook')) return 'hook'
  if (text.includes('appium')) return 'appium'
  if (text.includes('browser') && text.includes('install')) return 'browser_install'
  if (text.includes('context length') || text.includes('token limit')) return 'llm_context'
  if (text.includes('openai') || text.includes('anthropic') || text.includes('provider') || text.includes('llm')) return 'llm_provider'
  if (text.includes('memory')) return 'memory'
  if (text.includes('setup')) return 'setup'
  if (text.includes('assert') || text.includes('expect')) return 'assertion'
  return 'unknown'
}

function definedProperties(properties: AnalyticsEventProperties): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) {
      output[key] = value
    }
  }
  return output
}

export class AnalyticsRunReporter implements Reporter {
  private readonly service: AnalyticsService
  private readonly surface: AnalyticsSurface
  private readonly identityPath?: string
  private readonly env?: Record<string, string | undefined>
  private readonly disabled: boolean
  private readonly runStates = new Map<string, RunState>()
  private readonly suiteStates = new Map<string, SuiteState>()

  constructor(options: AnalyticsRunReporterOptions = {}) {
    this.surface = options.surface ?? 'core'
    this.identityPath = options.identityPath
    this.env = options.env
    this.disabled = options.config?.analytics?.privacy === true
    this.service = options.service ?? createAnalyticsService({
      ...options,
      surface: this.surface,
      transport: options.transport,
    })
  }

  async onSuiteStart(suite: SuiteDefinition, context?: RunArtifactReporterContext): Promise<void> {
    if (this.disabled) return
    const runId = context?.runId ?? readString(context?.artifact?.runtime?.runId)
    if (!runId) return
    const runtime = isRecord(context?.artifact?.runtime) ? context?.artifact?.runtime : {}
    this.suiteStates.set(runId, {
      runId,
      suiteId: readSuiteId(suite, context),
      attributes: resolveAttributes(context, this.env),
      executionMode: normalizeSuiteExecutionMode(runtime.executionMode ?? runtime.execution_mode ?? runtime.parallel),
    })
  }

  async onTestStart(test: TestDefinition, _filePath: string, context?: RunArtifactReporterContext): Promise<void> {
    if (this.disabled) return
    const state = readRunState({ test, context, env: this.env })
    this.runStates.set(state.runId, state)
  }

  async onHookEnd(event: HookResultEvent): Promise<void> {
    if (this.disabled) return
    const runId = event.runId
    if (!runId) return
    const state = this.runStates.get(runId)
    if (!state) return
    state.hookCount += 1
    if (event.status === 'failed') state.failedHookCount += 1
  }

  async onTestEnd(): Promise<void> {
    // Retry attempts can emit onTestEnd before the final retry-aware result exists.
  }

  async onRunEnd(summary: RunSummary): Promise<void> {
    if (this.disabled) return
    for (const result of summary.results) {
      await this.captureTestResult(result)
    }
  }

  async onSuiteEnd(summary: SuiteSummary): Promise<void> {
    if (this.disabled) return
    await this.captureSuiteResult(summary)
  }

  async flush(): Promise<void> {
    try {
      await this.service.flush()
    } catch {
      // Analytics is intentionally best-effort.
    }
  }

  private findStateForResult(result: TestResult): RunState | undefined {
    if (result.runId) return this.runStates.get(result.runId)
    return [...this.runStates.values()].find(state => state.testId && result.metadata?.testId === state.testId)
  }

  private async captureTestResult(result: TestResult): Promise<void> {
    const state = this.findStateForResult(result)
    const resultMetadata = isRecord(result.metadata) ? result.metadata : undefined
    const resultRuntime = readNestedRecord(resultMetadata, 'runtime')
    const resultAttributes = readAttributes(resultMetadata?.attributes)
    const retryCount = typeof result.retryCount === 'number' && result.retryCount >= 0 ? result.retryCount : undefined
    const properties = definedProperties({
      ...await resolveAnalyticsStandardProperties({
        surface: this.surface,
        identityPath: this.identityPath,
        env: this.env,
      }),
      run_id: result.runId ?? state?.runId,
      parent_run_id: state?.parentRunId,
      test_id: state?.testId ?? readString(resultMetadata?.testId),
      suite_id: state?.suiteId ?? readString(resultMetadata?.suiteId),
      trigger_source: normalizeTriggerSource(state?.attributes[ATTR_TRIGGER] ?? resultAttributes?.[ATTR_TRIGGER]),
      runner: normalizeRunner(state?.attributes[ATTR_RUNNER] ?? resultAttributes?.[ATTR_RUNNER]),
      platform: state?.platform ?? normalizePlatform(resultRuntime?.platform ?? resultMetadata?.platform),
      browser_name: state?.browserName ?? readString(resultRuntime?.browserName) ?? readString(resultRuntime?.browser),
      mobile_transport: state?.mobileTransport ?? readString(resultRuntime?.mobileTransport) ?? readString(resultRuntime?.mobile_transport),
      mobile_provider: state?.mobileProvider ?? readString(resultRuntime?.mobileProvider) ?? readString(resultRuntime?.mobile_provider),
      app_state: state?.appState ?? readString(resultRuntime?.appState) ?? readString(resultRuntime?.app_state),
      execution_destination: state?.executionDestination ?? readString(resultRuntime?.executionDestination) ?? readString(resultRuntime?.execution_destination),
      provider: state?.provider,
      provider_mode: state?.providerMode,
      planner_model: state?.plannerModel,
      verifier_model: state?.verifierModel,
      status: normalizeStatus(result.status),
      duration_ms: result.duration,
      retry_count: retryCount,
      is_flaky: retryCount !== undefined ? result.status === 'passed' && retryCount > 0 : undefined,
      cancelled: result.status === 'cancelled' ? true : undefined,
      timed_out: classifyFailureCategory(result) === 'timeout' ? true : undefined,
      failure_category: classifyFailureCategory(result),
      ...collectExecutionMetrics(result, state),
      ...collectMemoryMetrics(result, state),
    })

    try {
      await this.service.capture(buildAnalyticsEvent({
        name: 'agent-qa.test_run.completed',
        properties,
      }))
    } catch {
      // Analytics is intentionally best-effort.
    }
  }

  private async captureSuiteResult(summary: SuiteSummary): Promise<void> {
    const state = summary.runId ? this.suiteStates.get(summary.runId) : undefined
    const properties = definedProperties({
      ...await resolveAnalyticsStandardProperties({
        surface: this.surface,
        identityPath: this.identityPath,
        env: this.env,
      }),
      run_id: summary.runId ?? state?.runId,
      suite_id: state?.suiteId,
      trigger_source: normalizeTriggerSource(state?.attributes[ATTR_TRIGGER]),
      runner: normalizeRunner(state?.attributes[ATTR_RUNNER]),
      status: normalizeStatus(summary.status),
      duration_ms: summary.duration,
      suite_child_count: summary.tests.length,
      suite_passed_count: summary.passed,
      suite_failed_count: summary.failed,
      suite_skipped_count: summary.skipped,
      suite_execution_mode: state?.executionMode,
    })

    try {
      await this.service.capture(buildAnalyticsEvent({
        name: 'agent-qa.suite_run.completed',
        properties,
      }))
    } catch {
      // Analytics is intentionally best-effort.
    }
  }
}

export function createAnalyticsRunReporter(options: AnalyticsRunReporterOptions = {}): AnalyticsRunReporter {
  return new AnalyticsRunReporter(options)
}
