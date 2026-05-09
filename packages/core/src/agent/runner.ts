import { randomUUID } from 'node:crypto'
import type { LanguageModel } from 'ai'
import type { PlatformAdapter } from '../types/platform.js'
import type { AccessibilityViolation, StepPhaseEvent, StepResult, TestResult } from '../types/result.js'
import type { TestDefinition } from '../types/test.js'
import type { Planner, Verifier, ActionCache, HealingConfig, StepContext } from './types.js'
import type { MemoryProvider } from '../memory/provider.js'
import type { CircuitBreaker } from '../memory/circuit-breaker.js'
import type { MemoryIndexParams } from '../memory/memory-index.js'
import type { Action } from '../types/platform.js'
import { formatAction } from './prompts.js'
import type { Reporter, StepEventContext } from '../reporter/types.js'
import { MultiReporter } from '../reporter/types.js'
import { captureFailureScreenshot } from '../reporter/screenshot.js'
import { createTimeoutAbortReason, executeStep, getTimeoutAbortReason, withAbort } from './loop.js'
import { VariableStore, interpolateVariables, findUnresolvedTemplates, createExtractor } from './variables.js'
import { resolveSecretTemplatesInValue, redactSecretValue, type SecretRedactor, type SecretStore } from './secrets.js'
import { parseAppiumInline } from './appium-inline.js'
import { parseHookInline, stripHookInline } from './hook-inline.js'
import { parseRunJSInline, coerceRunJSResult } from './runjs-inline.js'
import { generateFailureSummary } from './failure-summary.js'
import type { LogManager } from '../logging/log-manager.js'
import type { HookDefinition } from '../hooks/types.js'
import { runHookInSandbox, type SandboxRunnerOptions } from '../hooks/sandbox-runner.js'

const accessibilityWebModuleName: string = '@vostride/agent-qa-web'

export interface RunTestConfig {
  runId?: string
  parentRunId?: string | null
  adapter: PlatformAdapter
  planner: Planner
  verifier?: Verifier
  cache?: ActionCache
  healingConfig: HealingConfig
  plannerModel: LanguageModel
  verifierModel: LanguageModel
  reporters?: Reporter[]
  captureScreenshots?: boolean
  screenshotMode?: 'failure' | 'every-step'
  timeouts?: { step?: number; test?: number; navigation?: number }
  recording?: { enabled: boolean; videoDir: string; videoSize?: { width: number; height: number } }
  accessibility?: {
    enabled: boolean
    standard?: 'wcag2a' | 'wcag2aa' | 'wcag2aaa'
    runAfter?: 'every-step' | 'navigation' | 'test-end'
    failOnViolation?: boolean
    disableRules?: string[]
    exclude?: string[]
  }
  plannerConfig?: import('./types.js').PlannerConfig
  logger?: LogManager
  configContent?: string
  testFileContent?: string
  envFileVars?: Record<string, string>
  inlineVars?: Record<string, string>
  suiteVars?: Record<string, string>
  cliVars?: Record<string, string>
  hookSetupVars?: Record<string, string>
  inlineHookDefs?: Map<string, HookDefinition>
  inlineHookSandboxOptions?: SandboxRunnerOptions
  suiteFileContent?: string
  suiteTestIndex?: number
  suiteContext?: string
  logCapture?: { console?: boolean; network?: boolean }
  screenshotSize?: number
  effectiveResolution?: number
  contextWindow?: number
  memoryProvider?: MemoryProvider
  memoryInitParams?: MemoryIndexParams
  circuitBreaker?: CircuitBreaker
  skipReporterOnTestStart?: boolean
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
  secretsFileMetadata?: { path: string | null; status: string; count?: number } | null
}

export async function runTest(
  test: TestDefinition,
  config: RunTestConfig,
  filePath: string,
  failureContext?: string,
): Promise<TestResult> {
  const startTime = performance.now()
  const steps: StepResult[] = []
  const previousSteps: { instruction: string; outcome: string; reasoning?: string; plannedAction?: string; verifierResponse?: string }[] = []
  const variableStore = new VariableStore()
  if (config.envFileVars) variableStore.setAll(config.envFileVars, 'env')
  if (config.inlineVars) variableStore.setAll(config.inlineVars, 'inline')
  if (config.suiteVars) variableStore.setAll(config.suiteVars, 'suite')
  // test.variables block removed — use .env files, hooks, or setVariable action
  if (config.cliVars) variableStore.setAll(config.cliVars, 'cli')
  if (config.hookSetupVars) variableStore.setAll(config.hookSetupVars, 'hook')
  const reporter = config.reporters?.length ? new MultiReporter(config.reporters) : undefined

  if (config.skipReporterOnTestStart !== true) {
    if (config.runId) {
      await reporter?.onTestStart(test, filePath, { runId: config.runId, parentRunId: config.parentRunId })
    } else {
      await reporter?.onTestStart(test, filePath)
    }
  }

  let testFailed = false
  const testTimeout = (test.meta?.timeout as number | undefined) ?? config.timeouts?.test
  const testDeadline = testTimeout ? startTime + testTimeout : 0
  const testAbortController = new AbortController()
  const testDeadlineTimer = testTimeout
    ? setTimeout(() => {
        if (!testAbortController.signal.aborted) {
          testAbortController.abort(createTimeoutAbortReason('test', testTimeout))
        }
      }, testTimeout)
    : undefined

  // Handle graceful cancellation (SIGINT) — set flag so the main loop breaks cleanly
  let cancelled = false
  let activeStepController: AbortController | undefined
  const onCancel = () => {
    cancelled = true
    const cancelReason = new Error('Test cancelled by user')
    if (!testAbortController.signal.aborted) {
      testAbortController.abort(cancelReason)
    }
    if (activeStepController && !activeStepController.signal.aborted) {
      activeStepController.abort(testAbortController.signal.reason ?? cancelReason)
    }
  }
  process.on('SIGINT', onCancel)

  const runnerLog = config.logger?.createScopedLogger('runner')

  // Navigate to test URL before executing steps (url injected by CLI from resolved target)
  let shouldRunSteps = true
  if ((test as any).url) {
    const interpolatedUrl = interpolateVariables((test as any).url, variableStore)
    const navigateAction: Action = {
      type: 'navigate',
      url: resolveSecretTemplatesInValue(interpolatedUrl, config.secretStore),
    }
    try {
      await withAbort(config.adapter.execute(navigateAction), testAbortController.signal)
    } catch (err) {
      const aborted = createAbortedStepResult(
        'Navigate to test URL',
        performance.now() - startTime,
        testAbortController.signal,
        navigateAction,
        '',
        'Navigate to test URL',
      )
      if (!aborted) throw err
      steps.push(aborted)
      testFailed = aborted.status !== 'cancelled'
      shouldRunSteps = false
    }
  }

  let memoryProvider = config.memoryProvider ?? null
  if (shouldRunSteps && memoryProvider && config.memoryInitParams) {
    try {
      await memoryProvider.init(config.memoryInitParams)
    } catch (err) {
      runnerLog?.warn('Memory init failed, continuing without memory', { error: (err as Error).message })
      memoryProvider = null
    }
  } else if (shouldRunSteps && memoryProvider && !config.memoryInitParams) {
    memoryProvider = null
  }

  const cacheState = config.cache ? { invalidated: false } : undefined

  try {

  for (let stepIndex = 0; shouldRunSteps && stepIndex < test.steps.length; stepIndex++) {
    if (cancelled) break
    if (testDeadline && performance.now() >= testDeadline) {
      steps.push(createTimeoutStepResult(
        typeof test.steps[stepIndex] === 'string' ? test.steps[stepIndex] as string : (test.steps[stepIndex] as { step: string }).step,
        'Test',
        testTimeout!,
      ))
      testFailed = true
      break
    }

    const stepDef = test.steps[stepIndex]
    const rawInstruction = typeof stepDef === 'string' ? stepDef : stepDef.step
    const perStepTimeout = typeof stepDef !== 'string' ? stepDef.timeout : undefined
    const stepMaxAttempts = typeof stepDef !== 'string' ? stepDef.maxAttempts : undefined
    const stepTimeout = perStepTimeout ?? config.timeouts?.step
    const stepAbortController = new AbortController()
    activeStepController = stepAbortController
    const deadlineTimers: ReturnType<typeof setTimeout>[] = []
    const abortStepWithTestReason = () => {
      if (!stepAbortController.signal.aborted) {
        stepAbortController.abort(testAbortController.signal.reason ?? new Error('Test cancelled by user'))
      }
    }
    const abortForTimeout = (scope: 'test' | 'step', timeoutMs: number) => {
      if (!stepAbortController.signal.aborted) {
        stepAbortController.abort(createTimeoutAbortReason(scope, timeoutMs))
      }
    }
    const clearStepScope = () => {
      for (const timer of deadlineTimers) clearTimeout(timer)
      testAbortController.signal.removeEventListener('abort', abortStepWithTestReason)
      if (activeStepController === stepAbortController) activeStepController = undefined
      config.logger?.flush()
      config.logger?.clearCurrentStep()
    }
    if (testAbortController.signal.aborted) {
      abortStepWithTestReason()
    } else {
      testAbortController.signal.addEventListener('abort', abortStepWithTestReason, { once: true })
    }
    if (testDeadline && testTimeout) {
      const remainingTestTime = testDeadline - performance.now()
      if (remainingTestTime <= 0) {
        abortForTimeout('test', testTimeout)
      } else {
        deadlineTimers.push(setTimeout(() => abortForTimeout('test', testTimeout), remainingTestTime))
      }
    }
    if (stepTimeout) {
      deadlineTimers.push(setTimeout(() => abortForTimeout('step', stepTimeout), stepTimeout))
    }

    // Inline hook execution: runs BEFORE variable interpolation (D-04, D-07)
    let instructionAfterHooks = rawInstruction
    let inlineHookFailed = false
    let inlineHookAbortResult: StepResult | undefined
    if (config.inlineHookDefs && config.inlineHookSandboxOptions) {
      const inlineHookCalls = parseHookInline(rawInstruction)
      for (const call of inlineHookCalls) {
        const hookDef = config.inlineHookDefs.get(call.hookId)
        if (!hookDef) continue
        const hookExecId = randomUUID()
        const allVars = Object.fromEntries(variableStore.getAll())
        await reporter?.onHookStart?.({
          hookId: hookDef.id,
          hookName: hookDef.name,
          phase: 'inline',
          hookExecutionId: hookExecId,
          runId: config.runId,
          stepId: String(stepIndex),
        })
        try {
          const result = await withAbort(
            runHookInSandbox(hookDef, {
              ...config.inlineHookSandboxOptions,
              secretStore: config.secretStore,
              secretRedactor: config.secretRedactor,
              envVars: { ...config.inlineHookSandboxOptions.envVars, ...allVars },
            }),
            stepAbortController.signal,
          )
          await reporter?.onHookEnd?.({
            hookId: hookDef.id, hookName: hookDef.name, phase: 'inline', hookExecutionId: hookExecId,
            runId: config.runId,
            stepId: String(stepIndex),
            status: result.success ? 'passed' : 'failed',
            duration: result.duration, stdout: result.stdout, stderr: result.stderr,
            variables: result.variables, error: result.error,
          })
          if (result.success) {
            variableStore.setAll(result.variables, 'hook')
          } else {
            inlineHookFailed = true
            break
          }
        } catch (err: any) {
          const error = getErrorMessage(err)
          inlineHookAbortResult = createAbortedStepResult(
            rawInstruction,
            performance.now() - startTime,
            stepAbortController.signal,
          )
          await reporter?.onHookEnd?.({
            hookId: hookDef.id, hookName: hookDef.name, phase: 'inline', hookExecutionId: hookExecId,
            runId: config.runId,
            stepId: String(stepIndex),
            status: 'failed', duration: 0, stdout: '', stderr: '',
            variables: {}, error,
          })
          inlineHookFailed = true
          break
        }
      }
      instructionAfterHooks = stripHookInline(rawInstruction)
    }

    if (inlineHookFailed) {
      steps.push(inlineHookAbortResult ?? {
        name: rawInstruction,
        status: 'failed',
        duration: 0,
        error: 'Inline hook execution failed',
        trace: {
          observation: '',
          reasoning: 'Inline hook execution failed before step could run',
          plannedAction: { type: 'waitFor', condition: 'none', timeout: 0 },
          result: 'failure',
          error: 'Inline hook execution failed',
          screenStateBefore: '',
        },
      })
      testFailed = inlineHookAbortResult?.status !== 'cancelled'
      clearStepScope()
      break
    }

    const originalStepName = instructionAfterHooks
    let instruction = interpolateVariables(instructionAfterHooks, variableStore)
    let hasTemplateVars = originalStepName !== instruction

    const stepId = randomUUID()
    config.logger?.setCurrentStep(stepId)

    const runJSMatches = parseRunJSInline(instruction)
    let runJSAbortResult: StepResult | undefined
    if (runJSMatches.length > 0) {
      if (config.adapter.platform === 'web') {
        const page = 'getPage' in config.adapter ? (config.adapter as { getPage: () => { evaluate: (code: string) => Promise<unknown> } | undefined }).getPage() : undefined
        if (page) {
          for (const match of runJSMatches) {
            const runJSStart = performance.now()
            let runJSStatus: 'passed' | 'failed' = 'passed'
            let runJSError: string | undefined
            let runJSResultValue: string
            try {
              const raw = await withAbort(page.evaluate(match.code), stepAbortController.signal)
              runJSResultValue = coerceRunJSResult(raw)
              instruction = instruction.replace(match.fullMatch, runJSResultValue)
            } catch (err: any) {
              runJSStatus = 'failed'
              runJSError = getErrorMessage(err)
              runJSResultValue = `[runJS error: ${runJSError}]`
              instruction = instruction.replace(match.fullMatch, runJSResultValue)
              runJSAbortResult = createAbortedStepResult(
                instruction,
                performance.now() - runJSStart,
                stepAbortController.signal,
              )
            }
            const runJSDuration = performance.now() - runJSStart

            await reporter?.onHookEnd?.({
              hookName: match.code.slice(0, 200),
              phase: 'inline',
              hookExecutionId: randomUUID(),
              runId: config.runId,
              status: runJSStatus,
              duration: runJSDuration,
              stdout: runJSStatus === 'passed' ? runJSResultValue : '',
              stderr: runJSError ?? '',
              variables: {},
              stepId,
              type: 'runjs',
            })
            if (runJSAbortResult) break
          }
        } else {
          for (const match of runJSMatches) {
            instruction = instruction.replace(
              match.fullMatch,
              '[runJS error: no browser page available]',
            )
          }
        }
      } else {
        for (const match of runJSMatches) {
          instruction = instruction.replace(
            match.fullMatch,
            '[runJS error: runJS is only supported on web platform]',
          )
        }
      }
      runnerLog?.debug('runJS resolved', { instruction })
      hasTemplateVars = true
    }

    if (runJSAbortResult) {
      steps.push(runJSAbortResult)
      testFailed = runJSAbortResult.status !== 'cancelled'
      clearStepScope()
      break
    }

    const unresolvedTemplates = findUnresolvedTemplates(instruction)
    if (unresolvedTemplates.length > 0) {
      const errorLines = unresolvedTemplates.map(t => `  - ${t.pattern}: ${t.message}`)
      const errorMsg = `Unresolved template variable(s):\n${errorLines.join('\n')}`
      steps.push({
        name: instruction,
        status: 'failed',
        duration: 0,
        error: errorMsg,
        trace: {
          observation: '',
          reasoning: errorMsg,
          plannedAction: { type: 'waitFor', condition: 'none', timeout: 0 },
          result: 'failure',
          error: errorMsg,
          screenStateBefore: '',
        },
      })
      testFailed = true
      clearStepScope()
      break
    }

    let memoryContext: string | undefined
    if (memoryProvider && !config.circuitBreaker?.isTripped()) {
      try {
        const memResult = memoryProvider.queryForStep(instruction, stepIndex)
        if (memResult) memoryContext = memResult.formatted
      } catch {
        // Memory query failure is non-fatal
      }
    }

    runnerLog?.info('Step started', { stepIndex, totalSteps: test.steps.length, testName: test.name })

    const stepEventContext: StepEventContext = {
      runId: config.runId,
      parentRunId: config.parentRunId,
      suiteIndex: config.suiteTestIndex,
      testIndex: config.suiteTestIndex,
      stepIndex,
      stepId,
    }

    await reporter?.onStepStart(instruction, test.name, stepEventContext)

    const context: StepContext = {
      stepInstruction: instruction,
      testName: test.name,
      testContext: test.context,
      suiteContext: config.suiteContext,
      previousSteps: previousSteps.slice(-(config.plannerConfig?.previousStepCount ?? 5)),
      plannerModel: config.plannerModel,
      verifierModel: config.verifierModel,
      healingConfig: config.healingConfig,
      modelId: typeof config.plannerModel === 'object' && config.plannerModel && 'modelId' in config.plannerModel ? (config.plannerModel as { modelId: string }).modelId : undefined,
      variables: redactSecretValue(Object.fromEntries(variableStore.getAll()), config.secretRedactor),
      memoryContext,
      failureContext,
      plannerConfig: config.plannerConfig,
      contextWindow: config.contextWindow,
    }

    const loopConfig = {
        adapter: config.adapter,
        planner: config.planner,
        verifier: config.verifier,
        cache: config.cache,
        healingConfig: config.healingConfig,
        plannerConfig: config.plannerConfig,
        stepTimeout,
        maxAttempts: stepMaxAttempts,
        logger: config.logger,
        configContent: config.configContent,
        testFileContent: config.testFileContent,
        testFilePath: filePath,
        stepIndex,
        suiteFileContent: config.suiteFileContent,
        suiteTestIndex: config.suiteTestIndex,
        cacheState,
        logCapture: config.logCapture,
        screenshotSize: config.screenshotSize,
        effectiveResolution: config.effectiveResolution,
        onSetVariable: (name: string, value: string) => {
          variableStore.set(name, value, 'step')
        },
        onPhase: (event: StepPhaseEvent) => reporter?.onStepPhase?.(event, instruction, test.name, stepEventContext),
        abortSignal: stepAbortController.signal,
        secretStore: config.secretStore,
        secretRedactor: config.secretRedactor,
      }

    let result: StepResult
    try {
      const appiumAction = parseAppiumInline(instruction)
      if (appiumAction) {
        const stepStart = performance.now()
        try {
          const actionResult = await withAbort(
            config.adapter.execute(resolveSecretTemplatesInValue(appiumAction, config.secretStore)),
            stepAbortController.signal,
          )
          result = {
            name: instruction,
            status: actionResult.success ? 'passed' : 'failed',
            duration: performance.now() - stepStart,
            action: redactSecretValue(appiumAction, config.secretRedactor),
            error: redactSecretValue(actionResult.error, config.secretRedactor),
            trace: {
              observation: 'Inline appium command (LLM bypassed)',
              reasoning: 'Direct execution of {{appium: ...}} syntax',
              plannedAction: redactSecretValue(appiumAction, config.secretRedactor),
              result: actionResult.success ? 'success' : 'failure',
              error: redactSecretValue(actionResult.error, config.secretRedactor),
              screenStateBefore: '',
            },
          }
          if (actionResult.data !== undefined) {
            result.observation = `Script returned: ${JSON.stringify(actionResult.data)}`
          }
        } catch (err: any) {
          result = createAbortedStepResult(
            instruction,
            performance.now() - stepStart,
            stepAbortController.signal,
            appiumAction,
            'Inline appium command (LLM bypassed)',
            'Direct execution of {{appium: ...}} syntax',
          ) ?? {
            name: instruction,
            status: 'failed',
            duration: performance.now() - stepStart,
            action: appiumAction,
            error: getErrorMessage(err),
            trace: {
              observation: 'Inline appium command (LLM bypassed)',
              reasoning: 'Direct execution of {{appium: ...}} syntax',
              plannedAction: appiumAction,
              result: 'failure',
              error: getErrorMessage(err),
              screenStateBefore: '',
            },
          }
        }
      } else {
        result = await executeStep(instruction, loopConfig, context)
      }

      result.originalStepName = hasTemplateVars ? originalStepName : undefined
      const abortResultForCurrentStep = () => createAbortedStepResult(
        result.name,
        result.duration,
        stepAbortController.signal,
        result.action,
        result.trace?.observation,
        result.trace?.reasoning,
      )

      // Capture "after" screenshot (current screen state after the step executed)
      if (config.captureScreenshots === true && stepAbortController.signal.aborted) {
        const aborted = abortResultForCurrentStep()
        if (aborted) result = aborted
      } else if (config.captureScreenshots === true) {
        try {
          const screenshot = await withAbort(
            captureFailureScreenshot(config.adapter),
            stepAbortController.signal,
          )
          if (screenshot) result.screenshot = screenshot
        } catch (err) {
          const aborted = abortResultForCurrentStep()
          if (aborted) {
            result = aborted
          } else {
            throw err
          }
        }
      }

      // Accessibility check — only for web platform when enabled
      if (!stepAbortController.signal.aborted && config.accessibility?.enabled && config.adapter.platform === 'web') {
        const runAfter = config.accessibility.runAfter ?? 'every-step'
        const shouldRun = runAfter === 'every-step'
          || (runAfter === 'test-end' && stepIndex === test.steps.length - 1)
        if (shouldRun) {
          try {
            const webMod = await withAbort(
              import(accessibilityWebModuleName) as Promise<{
                runAccessibilityCheck: (page: unknown, options: {
                  standard?: 'wcag2a' | 'wcag2aa' | 'wcag2aaa'
                  disableRules?: string[]
                  exclude?: string[]
                }) => Promise<AccessibilityViolation[]>
              }>,
              stepAbortController.signal,
            )
            const page = 'getPage' in config.adapter ? (config.adapter as { getPage: () => unknown }).getPage() : undefined
            if (page) {
              const violations = await withAbort(
                webMod.runAccessibilityCheck(page, {
                  standard: config.accessibility.standard,
                  disableRules: config.accessibility.disableRules,
                  exclude: config.accessibility.exclude,
                }),
                stepAbortController.signal,
              )
              result.accessibilityViolations = violations
              if (config.accessibility.failOnViolation && violations.length > 0) {
                const critical = violations.filter((v: any) => v.impact === 'critical').length
                const serious = violations.filter((v: any) => v.impact === 'serious').length
                if (critical + serious > 0) {
                  result.status = 'failed'
                  result.error = `Accessibility violations found: ${critical} critical, ${serious} serious`
                }
              }
            }
          } catch {
            const aborted = abortResultForCurrentStep()
            if (aborted) {
              result = aborted
            } else {
              // Don't fail the step if accessibility check fails
            }
          }
        }
      }

      let capturedVars: Record<string, string> | undefined

      if (result.status !== 'failed' && typeof stepDef !== 'string' && stepDef.capture) {
        const extractor = createExtractor(config.verifierModel, stepDef.capture.method ?? 'ai')
        try {
          const screenState = await withAbort(config.adapter.observe(), stepAbortController.signal)
          const captureResult = await withAbort(extractor.extract({
            method: stepDef.capture.method ?? 'ai',
            variableName: stepDef.capture.variable,
            pattern: stepDef.capture.pattern,
            selector: stepDef.capture.selector,
            description: stepDef.capture.description,
          }, screenState), stepAbortController.signal)

          if (captureResult.success && captureResult.value) {
            variableStore.set(captureResult.variableName, captureResult.value)
            capturedVars = { [captureResult.variableName]: captureResult.value }
            result.capturedVariables = capturedVars
          }
        } catch (err) {
          const aborted = createAbortedStepResult(
            result.name,
            result.duration,
            stepAbortController.signal,
            result.action,
            result.trace?.observation,
            result.trace?.reasoning,
          )
          if (aborted) {
            result = aborted
          } else {
            throw err
          }
        }
      }

      result.variableSnapshot = variableStore.snapshot()
      result = redactSecretValue(result, config.secretRedactor)

      if (result.status === 'failed') {
        runnerLog?.warn('Step failed', { stepIndex, status: result.status, duration: result.duration, error: result.error })
      } else {
        runnerLog?.info('Step completed', { stepIndex, status: result.status, duration: result.duration })
      }

      // Per-step drain: attach console/network logs BEFORE reporter persists
      if (!stepAbortController.signal.aborted && 'pollDeviceLogs' in config.adapter && typeof (config.adapter as { pollDeviceLogs?: () => Promise<void> }).pollDeviceLogs === 'function') {
        try {
          await withAbort(
            (config.adapter as { pollDeviceLogs: () => Promise<void> }).pollDeviceLogs(),
            stepAbortController.signal,
          )
        } catch (err) {
          const aborted = abortResultForCurrentStep()
          if (aborted) {
            result = aborted
          } else {
            throw err
          }
        }
      }
      if (!stepAbortController.signal.aborted && config.logCapture?.console !== false) {
        result.consoleLogs = config.adapter.drainConsoleLogs?.()
      }
      if (!stepAbortController.signal.aborted && config.logCapture?.network !== false) {
        result.networkLogs = config.adapter.drainNetworkLogs?.()
      }

      result.id = stepId
      await reporter?.onStepEnd(result, test.name, stepEventContext)
    } finally {
      clearStepScope()
    }

    steps.push(result)

    if (result.status === 'failed') {
      testFailed = true
      break
    }

    const outcomeParts: string[] = [result.status]
    if (result.capturedVariables) {
      outcomeParts.push(`(captured: ${Object.entries(result.capturedVariables).map(([k, v]) => `${k}=${v}`).join(', ')})`)
    }

    previousSteps.push({
      instruction,
      outcome: outcomeParts.join(' '),
      reasoning: result.trace?.reasoning,
      plannedAction: result.trace?.plannedAction ? formatAction(result.trace.plannedAction as Action) : undefined,
      verifierResponse: result.trace?.verifierReasoning,
    })
  }

  } finally {
    memoryProvider?.destroy()
  }

  const isDisconnected = 'isBrowserDisconnected' in config.adapter
    && (config.adapter as { isBrowserDisconnected?: boolean }).isBrowserDisconnected

  // Capture video path before teardown (video is finalized on context close)
  let videoPath: string | undefined
  if (config.recording?.enabled && 'getVideoPath' in config.adapter) {
    try {
      videoPath = (await (config.adapter as { getVideoPath: () => Promise<string | undefined> }).getVideoPath()) ?? undefined
    } catch {
      // ignore video path capture failure
    }
  }

  const failureSummary = isDisconnected ? 'Browser closed by user'
    : testFailed ? generateFailureSummary(steps)
    : cancelled ? `Test cancelled after ${steps.length} step(s)` : undefined

  process.removeListener('SIGINT', onCancel)
  if (testDeadlineTimer) clearTimeout(testDeadlineTimer)

  const testResult: TestResult = {
    runId: config.runId,
    name: test.name,
    filePath,
    status: cancelled ? 'cancelled'
      : isDisconnected ? 'cancelled'
      : testFailed ? 'failed' : 'passed',
    steps,
    duration: performance.now() - startTime,
    metadata: test.meta as Record<string, unknown> | undefined,
    videoPath,
    failureSummary: failureSummary || undefined,
  }
  await reporter?.onTestEnd(testResult)
  return testResult
}

function createTimeoutStepResult(name: string, scopeLabel: 'Test' | 'Step', timeoutMs: number): StepResult {
  const error = `${scopeLabel} timed out after ${timeoutMs}ms`
  return {
    name,
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
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function createAbortedStepResult(
  name: string,
  duration: number,
  signal: AbortSignal,
  action?: Action,
  observation = '',
  reasoning?: string,
): StepResult | undefined {
  if (!signal.aborted) return undefined
  const plannedAction = action ?? { type: 'waitFor', condition: 'none', timeout: 0 }
  const timeoutReason = getTimeoutAbortReason(signal)
  const error = timeoutReason?.message ?? 'Step cancelled by user'
  return {
    name,
    status: timeoutReason ? 'failed' : 'cancelled',
    duration,
    action: plannedAction,
    error,
    trace: {
      observation,
      reasoning: reasoning ?? error,
      plannedAction,
      result: 'failure',
      error,
      screenStateBefore: '',
    },
  }
}

export async function runTestWithRetry(
  test: TestDefinition,
  config: RunTestConfig,
  filePath: string,
): Promise<TestResult> {
  const startTime = performance.now()
  const maxRetries = test.meta?.retries ?? 0
  let lastResult: TestResult | undefined
  let failureContext: string | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runTest(test, config, filePath, failureContext)

    if (result.status === 'passed') {
      return {
        ...result,
        duration: performance.now() - startTime,
        retryCount: attempt,
      }
    }

    lastResult = result
    failureContext = result.failureSummary
      ? `Attempt ${attempt + 1} failure:\n${result.failureSummary}`
      : undefined
  }

  return {
    ...lastResult!,
    duration: performance.now() - startTime,
    retryCount: maxRetries,
  }
}
