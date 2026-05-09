import { randomUUID } from 'node:crypto'
import {
  executeStep,
  createModel,
  getProviderOptions,
  LLMPlanner,
  LLMVerifier,
  VariableStore,
  interpolateVariables,
  findUnresolvedTemplates,
  parseHookInline,
  stripHookInline,
  runHooks,
  runHookInSandbox,
  MobileSetupError,
  redactSecretValue,
  resolveSecretTemplatesInValue,
} from '@vostride/agent-qa-core'
import type {
  AgentLoopConfig,
  StepContext,
  PlatformAdapter,
  PlatformConfig,
  StepResult,
  StepPhaseEvent,
  HookDefinition,
  MobilePlatform,
  SecretRedactor,
  SecretStore,
} from '@vostride/agent-qa-core'
import type { LanguageModel } from 'ai'
import { prepareMobileLiveSession } from './mobile-bootstrap.js'
import type { MobileLiveAppiumLease } from './mobile-bootstrap.js'
import type { AppiumManager } from '../execution/appium-manager.js'
import type { ConfigManager } from '../config/index.js'
import type {
  SessionState,
  LiveDraftMetadata,
  LiveExecutionLog,
  LiveHookOwner,
  LiveSessionConfig,
  LiveStepResultPayload,
  LiveSubActionData,
  LiveHookPayload,
  LiveTestExecutionPayload,
  LiveTestResultPayload,
  LiveTestStepPayload,
  ServerMessage,
} from './types.js'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000

const RUNJS_DBL_RE = /\{\{runJS:"((?:[^"\\]|\\.)*)"\}\}/g
const RUNJS_SGL_RE = /\{\{runJS:'((?:[^'\\]|\\.)*)'\}\}/g

export interface LiveSessionDeps {
  appiumManager?: AppiumManager
  configManager?: ConfigManager
  configPath?: string
}

export interface LiveStepExecutionResult extends StepResult {
  executionLogs?: LiveExecutionLog[]
  subActionsData?: LiveSubActionData[]
}

// Shared with ws-handler.ts toStepResultPayload. Kept in-module so that
// executeTestCommand can assemble its stepResults array without a
// cross-module import that would create a circular dependency.
function toStepResultPayload(result: LiveStepExecutionResult): LiveStepResultPayload {
  const status = result.status === 'passed'
    ? 'passed'
    : result.status === 'cancelled'
      ? 'cancelled'
      : 'failed'

  return {
    status,
    duration: result.duration,
    error: result.error,
    capturedVariables: result.capturedVariables,
    variableSnapshot: result.variableSnapshot,
    originalStepName: result.originalStepName,
    consoleLogs: result.consoleLogs,
    networkLogs: result.networkLogs,
    executionLogs: result.executionLogs,
    subActionsData: result.subActionsData,
  }
}

interface RunJSMatch {
  fullMatch: string
  code: string
}

function parseRunJSInline(text: string): RunJSMatch[] {
  const matches: RunJSMatch[] = []
  for (const match of text.matchAll(RUNJS_DBL_RE)) {
    matches.push({ fullMatch: match[0], code: match[1] })
  }
  for (const match of text.matchAll(RUNJS_SGL_RE)) {
    matches.push({ fullMatch: match[0], code: match[1] })
  }
  return matches.sort((a, b) => text.indexOf(a.fullMatch) - text.indexOf(b.fullMatch))
}

function coerceRunJSResult(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

function toLiveSubActionData(result: StepResult): LiveSubActionData[] | undefined {
  return result.trace?.subActions?.map((subAction) => ({
    index: subAction.index,
    observation: subAction.observation,
    reasoning: subAction.reasoning,
    plannedAction: subAction.plannedAction,
    result: subAction.result,
    error: subAction.error,
    screenStateBefore: subAction.screenStateBefore,
    screenStateAfter: subAction.screenStateAfter,
    confidence: subAction.confidence,
    verifierReasoning: subAction.verifierReasoning,
    cached: subAction.cached,
    tokenUsage: subAction.tokenUsage,
    phaseDurations: subAction.phaseDurations,
    annotation: subAction.annotation,
    screenContextBefore: subAction.screenContextBefore,
    screenContextAfter: subAction.screenContextAfter,
    data: subAction.data,
  }))
}

function mobileSetupMessage(err: MobileSetupError): string {
  return `${err.category}: ${err.message}`
}

function classifyAdapterSetupError(err: unknown): MobileSetupError['category'] {
  const message = err instanceof Error ? err.message : String(err)
  if (/appium|ECONNREFUSED|connect|\/session|status/i.test(message)) {
    return 'appium-startup'
  }
  return 'device-readiness'
}

function wrapAdapterSetupError(
  err: unknown,
  platform: MobilePlatform,
  config: PlatformConfig,
): MobileSetupError {
  if (err instanceof MobileSetupError) return err
  const appId = platform === 'android'
    ? config.appPackage
    : config.bundleId
  return new MobileSetupError({
    category: classifyAdapterSetupError(err),
    message: `Failed to create ${platform} adapter session: ${err instanceof Error ? err.message : String(err)}`,
    platform,
    deviceName: config.device?.name,
    appId,
    cause: err,
  })
}

function buildHookExecutionLog(hook: LiveHookPayload): LiveExecutionLog {
  return {
    id: hook.executionId,
    type: 'hook',
    name: hook.hookName,
    hookId: hook.hookId,
    phase: hook.phase,
    status: hook.status === 'failed' ? 'failed' : 'passed',
    duration: hook.duration ?? 0,
    stdout: hook.stdout ?? null,
    stderr: hook.stderr ?? null,
    returnData: null,
    variables: hook.variables ?? null,
    createdAt: hook.createdAt,
  }
}

export class LiveSession {
  readonly sessionId: string
  status: 'idle' | 'executing' | 'disconnected' | 'terminated' = 'idle'
  private abortController: AbortController | null = null
  stepsExecuted = 0
  createdAt = 0

  private adapter: PlatformAdapter | null = null
  private planner: LLMPlanner | null = null
  private verifier: LLMVerifier | null = null
  private model: LanguageModel | null = null
  private variableStore: VariableStore | null = null
  private previousSteps: { instruction: string; outcome: string; reasoning?: string; plannedAction?: string; verifierResponse?: string }[] = []
  private currentStep: string | null = null
  private platform: 'web' | 'android' | 'ios' = 'web'
  private currentUrl: string | null = null
  private executing = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private _modelName = 'unknown'
  private screenshotSize: number | undefined
  private effectiveResolution: number | undefined
  private readyForInteraction = false
  private terminalError: string | null = null
  private setupHooks: string[] = []
  private teardownHooks: string[] = []
  private resolvedHooks = new Map<string, HookDefinition>()
  private hookRegistryError: string | null = null
  private pendingMessages: ServerMessage[] = []
  private messageSink: ((message: ServerMessage) => void) | null = null
  private mobileAppiumLease: MobileLiveAppiumLease | null = null
  private secretStore: SecretStore | undefined
  private secretRedactor: SecretRedactor | undefined

  constructor(sessionId: string, private deps: LiveSessionDeps = {}) {
    this.sessionId = sessionId
  }

  get modelName(): string {
    return this._modelName
  }

  attachMessageSink(sink: ((message: ServerMessage) => void) | null): void {
    this.messageSink = sink
    if (!sink || this.pendingMessages.length === 0) return

    for (const message of this.pendingMessages) {
      sink(message)
    }
    this.pendingMessages = []
  }

  private dispatch(message: ServerMessage): void {
    message = this.redact(message)
    if (this.messageSink) {
      this.messageSink(message)
      return
    }
    this.pendingMessages.push(message)
  }

  private redact<T>(value: T): T {
    return redactSecretValue(value, this.secretRedactor)
  }

  private resolveSecrets<T>(value: T): T {
    return resolveSecretTemplatesInValue(value, this.secretStore)
  }

  private emitHookStart(
    hookDef: Pick<HookDefinition, 'id' | 'name'>,
    phase: 'setup' | 'teardown',
    owner: LiveHookOwner = { scope: 'suite' },
  ): LiveHookPayload {
    const hook: LiveHookPayload = {
      executionId: randomUUID(),
      hookId: hookDef.id,
      hookName: hookDef.name,
      phase,
      owner,
      status: 'running',
      createdAt: new Date().toISOString(),
    }
    this.dispatch({ type: 'hook-start', hook })
    return hook
  }

  private emitHookComplete(
    started: LiveHookPayload,
    updates: Omit<LiveHookPayload, 'executionId' | 'hookId' | 'hookName' | 'phase' | 'owner' | 'createdAt'>,
  ): LiveHookPayload {
    const hook: LiveHookPayload = this.redact({
      ...started,
      ...updates,
    })
    this.dispatch({ type: 'hook-complete', hook })
    return hook
  }

  private emitTestStepStart(step: LiveTestStepPayload): void {
    this.dispatch({ type: 'test-step-start', step })
  }

  private emitTestStepPhase(step: LiveTestStepPayload, event: StepPhaseEvent): void {
    this.dispatch({
      type: 'test-step-phase',
      step,
      phase: event.phase,
      data: {
        text: event.text,
        confidence: event.confidence,
        action: event.action,
        success: event.success,
        duration: event.duration,
      },
    })
  }

  private emitTestStepComplete(step: LiveTestStepPayload, result: LiveStepExecutionResult): void {
    if (result.status === 'cancelled') {
      this.dispatch({ type: 'test-step-cancelled', step })
      return
    }

    this.dispatch({
      type: 'test-step-complete',
      step,
      result: toStepResultPayload(result),
    })
  }

  private emitTestStepError(step: LiveTestStepPayload, error: string): void {
    this.dispatch({ type: 'test-step-error', step, error })
  }

  private getHookEnvVars(): Record<string, string> {
    const envVars: Record<string, string> = {}
    if (!this.variableStore) return envVars

    for (const [key, value] of this.variableStore.getAll()) {
      envVars[key] = value
    }

    return envVars
  }

  private async runLifecycleHooks(
    phase: 'setup' | 'teardown',
    hookIds: string[],
    owner: LiveHookOwner = { scope: 'suite' },
  ): Promise<{ allPassed: boolean; logs: LiveExecutionLog[] }> {
    const logs: LiveExecutionLog[] = []

    for (const hookId of hookIds) {
      const hookDef = this.resolvedHooks.get(hookId)
      const started = this.emitHookStart(
        hookDef ?? { id: hookId, name: hookId },
        phase,
        owner,
      )

      if (!hookDef) {
        const registryHint = this.hookRegistryError ? ` (${this.hookRegistryError})` : ''
        const completed = this.emitHookComplete(started, {
          status: 'failed',
          duration: 0,
          stdout: null,
          stderr: this.hookRegistryError ?? null,
          variables: null,
          error: `Hook ID "${hookId}" is not defined in hooks.yaml${registryHint}`,
        })
        logs.push(buildHookExecutionLog(completed))
        if (phase === 'setup') {
          return { allPassed: false, logs }
        }
        continue
      }

      const result = await runHooks([hookDef], {
        envVars: this.getHookEnvVars(),
        secretStore: this.secretStore,
        secretRedactor: this.secretRedactor,
      })
      const hookResult = result.results.get(hookDef.name)
      const completed = this.emitHookComplete(started, {
        status: hookResult?.success ? 'passed' : 'failed',
        duration: hookResult?.duration ?? 0,
        stdout: hookResult?.stdout ?? null,
        stderr: hookResult?.stderr ?? null,
        variables: hookResult && Object.keys(hookResult.variables).length > 0 ? hookResult.variables : null,
        error: hookResult?.error,
      })
      logs.push(buildHookExecutionLog(completed))

      if (hookResult?.success && hookResult.variables && this.variableStore) {
        this.variableStore.setAll(hookResult.variables, 'hook')
      }

      if (!hookResult?.success && phase === 'setup') {
        return { allPassed: false, logs }
      }
    }

    return { allPassed: true, logs }
  }

  async executeHookCommand(
    phase: 'setup' | 'teardown',
    hookId: string,
  ): Promise<LiveExecutionLog> {
    if (!this.readyForInteraction || !this.variableStore) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }

    if (this.executing) {
      throw new Error('Live session is busy')
    }

    this.executing = true
    this.status = 'executing'
    const hookName = this.resolvedHooks.get(hookId)?.name ?? hookId
    this.currentStep = `${phase} hook: ${hookName}`

    try {
      const { logs } = await this.runLifecycleHooks(phase, [hookId])
      return logs[0] ?? {
        id: randomUUID(),
        type: 'hook',
        name: hookName,
        hookId,
        phase,
        status: 'failed',
        duration: 0,
        stdout: null,
        stderr: null,
        returnData: null,
        variables: null,
        createdAt: new Date().toISOString(),
      }
    } finally {
      this.executing = false
      this.currentStep = null
      this.status = 'idle'
    }
  }

  private releaseMobileAppiumLease(reason: string): void {
    if (!this.mobileAppiumLease) return
    this.mobileAppiumLease.release(reason)
    this.mobileAppiumLease = null
  }

  private legacyMobilePlatformConfig(config: LiveSessionConfig): PlatformConfig {
    const platform = config.platform as MobilePlatform
    return {
      platform,
      bundleId: config.bundleId,
      appPackage: config.appPackage,
      appActivity: config.appActivity,
      deepLinkAppId: platform === 'android' ? config.appPackage : config.bundleId,
      appState: config.appState,
      device: config.device
        ? {
            name: config.device.name,
            platform,
            transport: 'local',
            match: config.device,
          }
        : undefined,
    }
  }

  private async resolveMobilePlatformConfig(config: LiveSessionConfig): Promise<PlatformConfig> {
    if (
      this.deps.appiumManager
      && this.deps.configManager
      && this.deps.configPath
      && config.targetName
    ) {
      const prepared = await prepareMobileLiveSession({
        sessionId: this.sessionId,
        platform: config.platform as MobilePlatform,
        targetName: config.targetName,
        useDeviceName: config.useDeviceName,
        appState: config.appState,
        appiumManager: this.deps.appiumManager,
        configManager: this.deps.configManager,
        configPath: this.deps.configPath,
      })
      this.mobileAppiumLease = prepared.appiumLease
      return prepared.platformConfig
    }

    return this.legacyMobilePlatformConfig(config)
  }

  private async setupMobileAdapter(platform: MobilePlatform, config: LiveSessionConfig): Promise<void> {
    let adapter: PlatformAdapter | null = null
    try {
      const platformConfig = await this.resolveMobilePlatformConfig(config)
      const platformLabel = platform === 'android' ? 'Android' : 'iOS'
      try {
        if (platform === 'android') {
          const { AndroidPlatformAdapter } = await import('@vostride/agent-qa-android')
          adapter = new AndroidPlatformAdapter()
        } else {
          const { IOSPlatformAdapter } = await import('@vostride/agent-qa-ios')
          adapter = new IOSPlatformAdapter()
        }
      } catch (err) {
        throw new MobileSetupError({
          category: 'adapter-load',
          message: `Failed to load ${platformLabel} adapter (@vostride/agent-qa-${platform}). Is the package installed? ${err instanceof Error ? err.message : String(err)}`,
          platform,
          targetName: config.targetName,
          deviceName: platformConfig.device?.name,
          appId: platform === 'android' ? platformConfig.appPackage : platformConfig.bundleId,
          cause: err,
        })
      }

      try {
        await adapter.setup(platformConfig)
      } catch (err) {
        throw wrapAdapterSetupError(err, platform, platformConfig)
      }
      this.adapter = adapter
    } catch (err) {
      try {
        await adapter?.cleanup()
      } catch {}
      this.releaseMobileAppiumLease('setup-failed')
      if (err instanceof MobileSetupError) {
        throw new Error(mobileSetupMessage(err))
      }
      throw err
    }
  }

  async initialize(config: LiveSessionConfig): Promise<void> {
    this.platform = config.platform
    this._modelName = config.llmConfig.model ?? 'unknown'
    this.variableStore = new VariableStore()
    this.secretStore = config.secretStore
    this.secretRedactor = config.secretRedactor
    if (config.envVars) {
      this.variableStore.setAll(config.envVars, 'env')
    }
    this.setupHooks = [...(config.setupHooks ?? [])]
    this.teardownHooks = [...(config.teardownHooks ?? [])]
    this.resolvedHooks = new Map(config.resolvedHooks ?? [])
    this.hookRegistryError = config.hookRegistryError ?? null
    this.screenshotSize = config.llmConfig.screenshotSize
    this.effectiveResolution = config.llmConfig.effectiveResolution
    this.readyForInteraction = false
    this.terminalError = null

    const setupResult = await this.runLifecycleHooks('setup', this.setupHooks)
    if (!setupResult.allPassed) {
      this.status = 'idle'
      this.createdAt = Date.now()
      this.terminalError = 'Setup hooks failed. End the session or fix the hook configuration and reconnect.'
      return
    }

    if (config.platform === 'android') {
      await this.setupMobileAdapter('android', config)
      this.currentUrl = null
    } else if (config.platform === 'ios') {
      await this.setupMobileAdapter('ios', config)
      this.currentUrl = null
    } else {
      const { WebPlatformAdapter } = await import('@vostride/agent-qa-web')
      const adapter = new WebPlatformAdapter()
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: config.headless ?? true } })
      this.adapter = adapter

      if (config.url) {
        const resolvedUrl = this.resolveSecrets(config.url)
        await adapter.execute({ type: 'navigate', url: resolvedUrl })
        this.currentUrl = resolvedUrl
      } else {
        this.currentUrl = 'about:blank'
      }
    }

    const modelConfig = {
      ...config.llmConfig,
      ...(config.authFetch ? { fetch: config.authFetch } : {}),
    }
    this.model = await createModel(modelConfig)
    const providerOptions = getProviderOptions(modelConfig)
    this.planner = new LLMPlanner(this.model, config.platform, providerOptions, undefined, config.agentRules)
    this.verifier = new LLMVerifier(this.model, providerOptions)

    this.status = 'idle'
    this.createdAt = Date.now()
    this.readyForInteraction = true
  }

  private async resolveStepInstruction(stepInstruction: string): Promise<{
    instruction: string
    originalStepName?: string
    executionLogs: LiveExecutionLog[]
    preparationError?: string
  }> {
    const originalStepName = stepInstruction
    let instruction = stepInstruction
    let hasTemplateVars = false
    const executionLogs: LiveExecutionLog[] = []

    const inlineHookCalls = parseHookInline(stepInstruction)
    if (inlineHookCalls.length > 0) {
      let inlineHookFailed = false

      for (const call of inlineHookCalls) {
        const hookDef = this.resolvedHooks.get(call.hookId)
        if (!hookDef) {
          return {
            instruction: stepInstruction,
            originalStepName,
            executionLogs,
            preparationError: `Inline hook "${call.hookId}" is not defined in hooks.yaml`,
          }
        }

        const startedAt = performance.now()
        try {
          const result = await runHookInSandbox(hookDef, {
            envVars: this.getHookEnvVars(),
            secretStore: this.secretStore,
            secretRedactor: this.secretRedactor,
          })
          executionLogs.push({
            id: randomUUID(),
            type: 'hook',
            name: hookDef.name,
            hookId: hookDef.id,
            phase: 'inline',
            status: result.success ? 'passed' : 'failed',
            duration: result.duration,
            stdout: this.redact(result.stdout),
            stderr: this.redact(result.stderr),
            returnData: null,
            variables: Object.keys(result.variables).length > 0 ? this.redact(result.variables) : null,
            createdAt: new Date().toISOString(),
          })

          if (result.success) {
            if (Object.keys(result.variables).length > 0) {
              this.variableStore!.setAll(result.variables, 'hook')
            }
          } else {
            inlineHookFailed = true
            break
          }
        } catch (error) {
          executionLogs.push({
            id: randomUUID(),
            type: 'hook',
            name: hookDef.name,
            hookId: hookDef.id,
            phase: 'inline',
            status: 'failed',
            duration: performance.now() - startedAt,
            stdout: null,
            stderr: this.redact(error instanceof Error ? error.message : String(error)),
            returnData: null,
            variables: null,
            createdAt: new Date().toISOString(),
          })
          inlineHookFailed = true
          break
        }
      }

      instruction = stripHookInline(stepInstruction)
      hasTemplateVars = true

      if (inlineHookFailed) {
        return {
          instruction,
          originalStepName,
          executionLogs,
          preparationError: 'Inline hook execution failed',
        }
      }
    }

    instruction = interpolateVariables(instruction, this.variableStore!)
    hasTemplateVars = hasTemplateVars || originalStepName !== instruction

    const runJSMatches = parseRunJSInline(instruction)
    if (runJSMatches.length > 0) {
      if (this.adapter?.platform === 'web') {
        const page = 'getPage' in this.adapter
          ? (this.adapter as { getPage?: () => { evaluate: (code: string) => Promise<unknown> } | undefined }).getPage?.()
          : undefined

        if (page) {
          for (const match of runJSMatches) {
            const startedAt = performance.now()
            let status: 'passed' | 'failed' = 'passed'
            let stderr: string | null = null
            let stdout: string
            let returnData: unknown = null

            try {
              returnData = await page.evaluate(match.code)
              returnData = this.redact(returnData)
              stdout = this.redact(coerceRunJSResult(returnData))
              instruction = instruction.replace(match.fullMatch, stdout)
            } catch (err) {
              status = 'failed'
              stderr = this.redact(err instanceof Error ? err.message : String(err))
              stdout = `[runJS error: ${stderr}]`
              instruction = instruction.replace(match.fullMatch, stdout)
            }

            executionLogs.push({
              id: randomUUID(),
              type: 'runjs',
              name: match.code.slice(0, 200),
              phase: 'inline',
              status,
              duration: performance.now() - startedAt,
              stdout: status === 'passed' ? stdout : '',
              stderr,
              returnData,
              variables: null,
              createdAt: new Date().toISOString(),
            })
          }
        } else {
          for (const match of runJSMatches) {
            const stdout = '[runJS error: no browser page available]'
            instruction = instruction.replace(
              match.fullMatch,
              stdout,
            )
            executionLogs.push({
              id: randomUUID(),
              type: 'runjs',
              name: match.code.slice(0, 200),
              phase: 'inline',
              status: 'failed',
              duration: 0,
              stdout: null,
              stderr: 'no browser page available',
              returnData: null,
              variables: null,
              createdAt: new Date().toISOString(),
            })
          }
        }
      } else {
        for (const match of runJSMatches) {
          const stdout = '[runJS error: runJS is only supported on web platform]'
          instruction = instruction.replace(
            match.fullMatch,
            stdout,
          )
          executionLogs.push({
            id: randomUUID(),
            type: 'runjs',
            name: match.code.slice(0, 200),
            phase: 'inline',
            status: 'failed',
            duration: 0,
            stdout: null,
            stderr: 'runJS is only supported on web platform',
            returnData: null,
            variables: null,
            createdAt: new Date().toISOString(),
          })
        }
      }
      hasTemplateVars = true
    }

    return {
      instruction,
      originalStepName: hasTemplateVars ? originalStepName : undefined,
      executionLogs,
    }
  }

  private buildPreparationFailureResult(
    instruction: string,
    error: string,
    originalStepName: string | undefined,
    executionLogs: LiveExecutionLog[],
  ): LiveStepExecutionResult {
    const result: LiveStepExecutionResult = {
      name: instruction,
      status: 'failed',
      duration: 0,
      error,
      trace: {
        observation: '',
        reasoning: error,
        plannedAction: { type: 'waitFor', condition: 'none', timeout: 0 },
        result: 'failure',
        error,
        screenStateBefore: '',
      },
      variableSnapshot: this.variableStore!.snapshot(),
      executionLogs,
      originalStepName,
    }
    return this.redact(result)
  }

  // Inner step execution — no gating. Callers must own the executing/status
  // lifecycle (executeStepCommand for single steps, executeTestCommand for
  // the per-test loop that runs many steps under one outer gate).
  private async executeStepInternal(
    stepInstruction: string,
    stepIndex: number | undefined,
    onPhase: ((event: StepPhaseEvent) => void) | undefined,
    draft: LiveDraftMetadata | undefined,
  ): Promise<LiveStepExecutionResult> {
    this.abortController = new AbortController()
    try {
      const prepared = await this.resolveStepInstruction(stepInstruction)
      if (prepared.preparationError) {
        const result = this.buildPreparationFailureResult(
          prepared.instruction,
          prepared.preparationError,
          prepared.originalStepName,
          prepared.executionLogs,
        )
        this.stepsExecuted++
        return result
      }
      const unresolvedTemplates = findUnresolvedTemplates(prepared.instruction)
      if (unresolvedTemplates.length > 0) {
        const errorLines = unresolvedTemplates.map((template) => `  - ${template.pattern}: ${template.message}`)
        const error = `Unresolved template variable(s):\n${errorLines.join('\n')}`
        const result = this.buildPreparationFailureResult(
          prepared.instruction,
          error,
          prepared.originalStepName,
          prepared.executionLogs,
        )
        this.stepsExecuted++
        return result
      }

      const loopConfig: AgentLoopConfig = {
        adapter: this.adapter!,
        planner: this.planner!,
        verifier: this.verifier!,
        healingConfig: { maxAttempts: 3 },
        plannerConfig: { maxSubActions: 50, previousStepCount: 5 },
        screenshotSize: this.screenshotSize,
        effectiveResolution: this.effectiveResolution,
        onSetVariable: (name, value) => this.variableStore!.set(name, value, 'step'),
        onPhase,
        stepIndex,
        abortSignal: this.abortController.signal,
        secretStore: this.secretStore,
        secretRedactor: this.secretRedactor,
      }

      const allVars = this.variableStore!.getAll()
      const variables: Record<string, string> = {}
      for (const [k, v] of allVars) variables[k] = v

      const stepContext: StepContext = {
        stepInstruction: prepared.instruction,
        testName: draft?.testName?.trim() || 'Unnamed live draft',
        testContext: draft?.testContext?.trim() || undefined,
        previousSteps: this.previousSteps,
        plannerModel: this.model!,
        verifierModel: this.model!,
        healingConfig: { maxAttempts: 3 },
        variables: this.redact(variables),
      }

      let result = await executeStep(prepared.instruction, loopConfig, stepContext) as LiveStepExecutionResult
      result.originalStepName = prepared.originalStepName
      result.variableSnapshot = this.variableStore!.snapshot()
      result.executionLogs = this.redact(prepared.executionLogs)
      result.subActionsData = toLiveSubActionData(result)
      if ('pollDeviceLogs' in this.adapter! && typeof (this.adapter as { pollDeviceLogs?: () => Promise<void> }).pollDeviceLogs === 'function') {
        await (this.adapter as { pollDeviceLogs: () => Promise<void> }).pollDeviceLogs()
      }
      result.consoleLogs = this.adapter!.drainConsoleLogs?.()
      result.networkLogs = this.adapter!.drainNetworkLogs?.()
      result = this.redact(result)

      if (result.status !== 'cancelled') {
        this.previousSteps.push({ instruction: prepared.instruction, outcome: result.status })
      }
      this.stepsExecuted++
      return result
    } finally {
      this.abortController = null
    }
  }

  async executeStepCommand(
    stepInstruction: string,
    stepIndex?: number,
    onPhase?: (event: StepPhaseEvent) => void,
    draft?: LiveDraftMetadata,
  ): Promise<LiveStepExecutionResult> {
    if (!this.readyForInteraction || !this.adapter || !this.model || !this.planner || !this.verifier || !this.variableStore) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }

    if (this.executing) {
      throw new Error('Step already executing')
    }

    this.executing = true
    this.status = 'executing'
    this.currentStep = stepInstruction
    try {
      return await this.executeStepInternal(stepInstruction, stepIndex, onPhase, draft)
    } finally {
      this.executing = false
      this.currentStep = null
      this.status = 'idle'
    }
  }

  async executeTestCommand(
    testExecutionId: string,
    testDraft: {
      testIndex: number
      testId: string
      testName: string
      testContext?: string
      steps: string[]
      setup: string[]
      teardown: string[]
    },
    onPhase?: (event: StepPhaseEvent) => void,
  ): Promise<LiveTestResultPayload> {
    if (!this.readyForInteraction || !this.adapter || !this.model || !this.planner || !this.verifier || !this.variableStore) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }

    if (this.executing) {
      throw new Error('Test already executing')
    }

    this.executing = true
    this.status = 'executing'
    this.currentStep = `test: ${testDraft.testName}`
    const start = performance.now()
    const testExecution: LiveTestExecutionPayload = {
      testExecutionId,
      testIndex: testDraft.testIndex,
      testId: testDraft.testId,
      testName: testDraft.testName,
    }
    const testOwner: LiveHookOwner = {
      scope: 'test',
      testExecutionId,
      testIndex: testDraft.testIndex,
      testId: testDraft.testId,
      testName: testDraft.testName,
    }

    try {
      // Per-test setup (D-09). Per-test setup failure short-circuits the
      // test AND skips per-test teardown, matching suite/runner.ts:230 break
      // (Pitfall 2). Suite-level teardown still fires at session cleanup.
      const setupHookPayloads: LiveHookPayload[] = []
      const setupResult = await this.runLifecycleHooksCapturing(
        'setup',
        testDraft.setup,
        setupHookPayloads,
        testOwner,
      )
      if (!setupResult.allPassed) {
        const failedHook = setupHookPayloads.find((h) => h.status === 'failed')
        const detail = failedHook
          ? `Setup hook "${failedHook.hookName}" failed${failedHook.error ? `: ${failedHook.error}` : ''}${failedHook.stderr ? ` — ${failedHook.stderr.split('\n')[0].slice(0, 200)}` : ''}`
          : 'Per-test setup hook failed'
        console.warn(`[live-session] executeTestCommand: ${detail}`, {
          testName: testDraft.testName,
          setupHooks: testDraft.setup,
          failedHook: failedHook ? { name: failedHook.hookName, stderr: failedHook.stderr, error: failedHook.error } : null,
        })
        return {
          status: 'failed',
          duration: performance.now() - start,
          error: detail,
          setupHookExecutions: setupHookPayloads,
          stepResults: [],
          teardownHookExecutions: [],
        }
      }

      // Shared browser context (D-01): each step reuses the same adapter
      // instance. Per-step context carries the TEST's name/context, not
      // the suite's, so the LLMPlanner matches production runTest behaviour.
      const stepResults: LiveStepResultPayload[] = []
      const perStepDraft: LiveDraftMetadata = {
        testName: testDraft.testName,
        testContext: testDraft.testContext,
      }
      let anyCancelled = false
      let anyFailed = false
      for (let i = 0; i < testDraft.steps.length; i++) {
        const stepPayload: LiveTestStepPayload = {
          ...testExecution,
          stepIndex: i,
          stepInstruction: testDraft.steps[i],
        }
        this.emitTestStepStart(stepPayload)

        let execResult: LiveStepExecutionResult
        try {
          execResult = await this.executeStepInternal(
            testDraft.steps[i],
            i,
            (event) => {
              this.emitTestStepPhase(stepPayload, event)
              onPhase?.(event)
            },
            perStepDraft,
          )
        } catch (error) {
          const message = this.redact(error instanceof Error ? error.message : String(error))
          this.emitTestStepError(stepPayload, message)
          stepResults.push({
            status: 'failed',
            duration: 0,
            error: message,
          })
          anyFailed = true
          break
        }

        this.emitTestStepComplete(stepPayload, execResult)
        stepResults.push(toStepResultPayload(execResult))
        if (execResult.status === 'cancelled') {
          anyCancelled = true
          break
        }
        if (execResult.status === 'failed') {
          anyFailed = true
          break
        }
      }

      // Per-test teardown always fires when steps began (D-09 + D-25).
      const teardownHookPayloads: LiveHookPayload[] = []
      const teardownResult = await this.runLifecycleHooksCapturing(
        'teardown',
        testDraft.teardown,
        teardownHookPayloads,
        testOwner,
      )

      const finalStatus: LiveTestResultPayload['status'] = anyCancelled
        ? 'cancelled'
        : anyFailed || !teardownResult.allPassed
          ? 'failed'
          : 'passed'

      let topLevelError: string | undefined
      if (anyFailed) {
        const failedStep = stepResults.find((s) => s.status === 'failed')
        if (failedStep) {
          const stepIdx = stepResults.indexOf(failedStep)
          topLevelError = `Step ${stepIdx + 1} (${testDraft.steps[stepIdx] ?? '<unknown>'}) failed${failedStep.error ? `: ${failedStep.error}` : ''}`
        }
      } else if (!teardownResult.allPassed) {
        const failedHook = teardownHookPayloads.find((h) => h.status === 'failed')
        topLevelError = failedHook
          ? `Teardown hook "${failedHook.hookName}" failed${failedHook.error ? `: ${failedHook.error}` : ''}`
          : 'Teardown hook failed'
      }
      if (topLevelError) {
        console.warn(`[live-session] executeTestCommand: ${topLevelError}`, { testName: testDraft.testName })
      }

      return this.redact({
        status: finalStatus,
        duration: performance.now() - start,
        error: topLevelError,
        setupHookExecutions: setupHookPayloads,
        stepResults,
        teardownHookExecutions: teardownHookPayloads,
      })
    } finally {
      this.executing = false
      this.currentStep = null
      this.status = 'idle'
    }
  }

  // Thin wrapper around runLifecycleHooks that also captures the dispatched
  // hook payloads (hook-start / hook-complete) for inclusion in the
  // LiveTestResultPayload. Uses a sink intercept so existing callers of
  // runLifecycleHooks (executeHookCommand, initialize, cleanup) keep their
  // current behaviour unchanged.
  private async runLifecycleHooksCapturing(
    phase: 'setup' | 'teardown',
    hookIds: string[],
    sink: LiveHookPayload[],
    owner: LiveHookOwner = { scope: 'suite' },
  ): Promise<{ allPassed: boolean; logs: LiveExecutionLog[] }> {
    const originalSink = this.messageSink
    const wrappedSink = (message: ServerMessage) => {
      if (message.type === 'hook-complete') {
        sink.push(message.hook)
      }
      if (originalSink) originalSink(message)
      else this.pendingMessages.push(message)
    }
    this.messageSink = wrappedSink
    try {
      return await this.runLifecycleHooks(phase, hookIds, owner)
    } finally {
      this.messageSink = originalSink
    }
  }

  cancelStep(): void {
    this.abortController?.abort()
  }

  async navigate(url: string): Promise<string | null> {
    if (!this.readyForInteraction || !this.adapter) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }
    const resolvedUrl = this.resolveSecrets(url)
    await this.adapter!.execute({ type: 'navigate', url: resolvedUrl })
    if (this.platform === 'web') {
      this.currentUrl = resolvedUrl
    } else {
      this.currentUrl = null
    }
    return this.currentUrl
  }

  async refreshPage(): Promise<string | null> {
    if (!this.readyForInteraction || !this.adapter) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }
    if (this.platform !== 'web') return this.currentUrl
    await this.adapter!.execute({ type: 'refresh' })
    const page = (this.adapter as any).getPage?.()
    if (page) this.currentUrl = page.url()
    return this.currentUrl ?? 'about:blank'
  }

  async goBack(): Promise<string | null> {
    if (!this.readyForInteraction || !this.adapter) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }
    if (this.platform !== 'web') return this.currentUrl
    await this.adapter!.execute({ type: 'navigateHistory', direction: 'back' })
    const page = (this.adapter as any).getPage?.()
    if (page) this.currentUrl = page.url()
    return this.currentUrl ?? 'about:blank'
  }

  async goForward(): Promise<string | null> {
    if (!this.readyForInteraction || !this.adapter) {
      throw new Error(this.terminalError ?? 'Live session is not ready')
    }
    if (this.platform !== 'web') return this.currentUrl
    await this.adapter!.execute({ type: 'navigateHistory', direction: 'forward' })
    const page = (this.adapter as any).getPage?.()
    if (page) this.currentUrl = page.url()
    return this.currentUrl ?? 'about:blank'
  }

  async drainDeviceLogs(): Promise<Array<{ level: string; message: string; timestamp: number }>> {
    if (!this.adapter) return []
    if (typeof (this.adapter as any).pollDeviceLogs === 'function') {
      await (this.adapter as any).pollDeviceLogs()
    }
    if (typeof this.adapter.drainConsoleLogs === 'function') {
      return this.redact(this.adapter.drainConsoleLogs().map((e) => ({ level: e.level, message: e.text, timestamp: e.timestamp })))
    }
    return []
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      platform: (this.adapter?.platform ?? this.platform) as 'web' | 'android' | 'ios',
      status: this.status === 'terminated' ? 'idle' : this.status === 'executing' ? 'executing' : this.status,
      currentStep: this.currentStep,
      currentUrl: this.currentUrl,
      stepsExecuted: this.stepsExecuted,
      createdAt: this.createdAt,
      interactive: this.readyForInteraction,
      terminalError: this.terminalError,
    }
  }

  async getScreenshot(): Promise<Buffer | undefined> {
    if (!this.readyForInteraction) return undefined
    return this.adapter?.screenshot?.()
  }

  async getAriaTree(): Promise<string | null> {
    if (!this.readyForInteraction || !this.adapter) return null
    if (!this.adapter) return null
    const screenState = await this.adapter.observe()
    return screenState.tree
  }

  startIdleTimer(onExpire: () => void): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(onExpire, IDLE_TIMEOUT_MS)
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  async cleanup(): Promise<void> {
    this.clearIdleTimer()
    this.readyForInteraction = false
    try {
      await this.adapter?.cleanup()
    } finally {
      try {
        await this.runLifecycleHooks('teardown', this.teardownHooks)
      } finally {
        this.releaseMobileAppiumLease('session-cleanup')
        this.messageSink = null
        this.status = 'terminated'
      }
    }
  }
}
