import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PlatformAdapter, PlatformConfig, RuntimeAuthStateConfig } from '../types/platform.js'
import type { TestResult } from '../types/result.js'
import type { TestDefinition } from '../types/test.js'
import type { SuiteDefinition, SuiteResult } from './types.js'
import type { Reporter, RunSummary, SuiteSummary } from '../reporter/types.js'
import { MultiReporter } from '../reporter/types.js'
import { runTest } from '../agent/runner.js'
import type { RunTestConfig } from '../agent/runner.js'
import type { Planner, Verifier, ActionCache, HealingConfig } from '../agent/types.js'
import type { LanguageModel } from 'ai'
import type { LogManager } from '../logging/log-manager.js'
import type { HookDefinition } from '../hooks/types.js'
import type { SandboxRunnerOptions } from '../hooks/sandbox-runner.js'
import { runHooks } from '../hooks/orchestrator.js'
import type { MemoryProvider } from '../memory/provider.js'
import type { CircuitBreaker } from '../memory/circuit-breaker.js'
import { runCurator, deprecateOnFailure } from '../memory/curator.js'
import type { MemoryLog } from '../memory/curator.js'
import { shouldAblate, collectAllInjectedIds } from '../memory/ablation.js'
import type { MemoryIndexParams } from '../memory/memory-index.js'
import { DEFAULT_MEMORY_DIR } from '../memory/config.js'
import type { ProviderOptions } from '../agent/provider.js'
import { VariableStore, findUnresolvedTemplates, interpolateVariables } from '../agent/variables.js'
import { resolveSecretTemplatesInValue, type SecretRedactor, type SecretStore } from '../agent/secrets.js'
import { withAbort } from '../agent/loop.js'
import { generateRunId } from '../ids/run-id.js'
import pc from 'picocolors'

export interface RunSuiteConfig {
  runId?: string
  adapter: PlatformAdapter
  platformConfig: PlatformConfig
  planner: Planner
  verifier?: Verifier
  cache?: ActionCache
  healingConfig: HealingConfig
  plannerModel: LanguageModel
  verifierModel: LanguageModel
  providerOptions?: ProviderOptions
  reporters?: Reporter[]
  captureScreenshots?: boolean
  screenshotMode?: 'failure' | 'every-step'
  timeouts?: { step?: number; test?: number; navigation?: number }
  logger?: LogManager
  configContent?: string
  suiteFileContent?: string
  envFileVars?: Record<string, string>
  inlineVars?: Record<string, string>
  cliVars?: Record<string, string>
  resolvedHooks?: Map<string, HookDefinition>
  sandboxOptions?: SandboxRunnerOptions
  logCapture?: { console?: boolean; network?: boolean }
  accessibility?: RunTestConfig['accessibility']
  accessibilityCheck?: RunTestConfig['accessibilityCheck']
  screenshotSize?: number
  effectiveResolution?: number
  memoryProvider?: MemoryProvider
  memoryRoot?: string
  memoryConfig?: {
    enabled?: boolean
    curatorEnabled?: boolean
    ablationEnabled?: boolean
    trustConfirmDelta?: number
    trustContradictDelta?: number
  }
  circuitBreaker?: CircuitBreaker
  product?: string
  createAdapter?: () => Promise<PlatformAdapter>
  resolveUrl?: (targetName: string) => string | undefined
  onCuratorComplete?: (testName: string, memoryLog: MemoryLog) => void
  artifactContext?: Record<string, unknown>
  authStateCapture?: {
    capture: () => Promise<RuntimeAuthStateConfig>
    failureSummary: string
  }
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    if (key in result && isPlainObject(result[key]) && isPlainObject(override[key])) {
      result[key] = deepMerge(result[key], override[key])
    } else {
      result[key] = override[key]
    }
  }
  return result
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

function patchTestForSuite(
  test: TestDefinition,
  suite: SuiteDefinition,
  index: number,
): TestDefinition {
  const patched = structuredClone(test)

  if (suite.target) {
    ;(patched as any).target = suite.target
  }

  if (suite.use && (patched as any).use) {
    ;(patched as any).use = deepMerge(suite.use, (patched as any).use)
  } else {
    ;(patched as any).use = (patched as any).use ?? suite.use
  }

  delete (patched as any).url

  return patched
}

function resolveSuiteStartUrl(
  rawUrl: string,
  config: RunSuiteConfig,
  suiteHookVars: Record<string, string>,
): { url?: string; error?: string } {
  const variableStore = new VariableStore()
  if (config.envFileVars) variableStore.setAll(config.envFileVars, 'env')
  if (config.inlineVars) variableStore.setAll(config.inlineVars, 'inline')
  if (config.cliVars) variableStore.setAll(config.cliVars, 'cli')
  if (Object.keys(suiteHookVars).length > 0) variableStore.setAll(suiteHookVars, 'hook')

  const interpolatedUrl = interpolateVariables(rawUrl, variableStore)
  const unresolved = findUnresolvedTemplates(interpolatedUrl)
  if (unresolved.length > 0) {
    const details = unresolved.map(item => `- ${item.pattern}: ${item.message}`).join('\n')
    return { error: `Suite target URL has unresolved variable(s):\n${details}` }
  }

  try {
    return { url: resolveSecretTemplatesInValue(interpolatedUrl, config.secretStore) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function runSuite(
  suite: SuiteDefinition,
  testEntries: [TestDefinition, string][],
  config: RunSuiteConfig,
): Promise<SuiteResult> {
  const startTime = performance.now()
  const results: TestResult[] = []
  const reporter = config.reporters?.length ? new MultiReporter(config.reporters) : undefined
  const suiteRunId = config.runId ?? process.env.AGENT_QA_SUITE_QUEUE_ID ?? generateRunId()
  let suiteSandboxOptions = config.sandboxOptions && config.platformConfig.authState
    ? { ...config.sandboxOptions, authState: config.platformConfig.authState }
    : config.sandboxOptions

  const suiteArtifact = (config.artifactContext as { artifact?: Record<string, unknown> } | undefined)?.artifact
    ?? config.artifactContext

  await reporter?.onSuiteStart(suite, {
    runId: suiteRunId,
    artifact: suiteArtifact ? { kind: 'suite-parent', ...suiteArtifact } : { kind: 'suite-parent' },
  } as any)

  const allTests = testEntries.map(([t]) => t)
  await reporter?.onRunStart(allTests)

  const finishEarly = async (message: string, phase: string): Promise<SuiteResult> => {
    const duration = performance.now() - startTime
    const failedResult: TestResult = {
      runId: suiteRunId,
      name: suite.name,
      filePath: '',
      status: 'failed',
      steps: [],
      duration,
      failureSummary: message,
      metadata: { phase },
    }
    const earlyResults = [failedResult]
    const runSummary: RunSummary = { results: earlyResults, duration, passed: 0, failed: 1, skipped: 0 }
    await reporter?.onRunEnd(runSummary)
    await reporter?.onSuiteEnd({
      runId: suiteRunId,
      name: suite.name,
      status: 'failed',
      tests: earlyResults,
      duration,
      passed: 0,
      failed: 1,
      skipped: 0,
    })
    return { runId: suiteRunId, name: suite.name, status: 'failed', tests: earlyResults, duration, failedAt: 0 }
  }

  // Suite-level setup hooks (before adapter.setup, before all tests)
  let suiteHookVars: Record<string, string> = {}
  if ((suite as any).setup?.length && config.resolvedHooks && suiteSandboxOptions) {
    const hookDefs: HookDefinition[] = []
    let hookMissing = false
    for (const hookId of (suite as any).setup) {
      const hook = config.resolvedHooks.get(hookId)
      if (!hook) { hookMissing = true; break }
      hookDefs.push(hook)
    }

    if (hookMissing) {
      return finishEarly('Suite setup hook not found', 'suite-setup')
    }

    const envVars: Record<string, string> = {}
    if (config.envFileVars) Object.assign(envVars, config.envFileVars)
    if (config.inlineVars) Object.assign(envVars, config.inlineVars)
    if (config.cliVars) Object.assign(envVars, config.cliVars)

    const result = await runHooks(hookDefs, {
      ...suiteSandboxOptions,
      secretStore: config.secretStore,
      secretRedactor: config.secretRedactor,
      envVars: { ...suiteSandboxOptions.envVars, ...envVars },
    })

    for (const [name, hr] of result.results) {
      const hookDef = hookDefs.find((hook) => hook.name === name)
      const hookExecId = randomUUID()
      await reporter?.onHookStart?.({ hookId: hookDef?.id, hookName: name, phase: 'setup', hookExecutionId: hookExecId, runId: suiteRunId })
      await reporter?.onHookEnd?.({
        hookId: hookDef?.id, hookName: name, phase: 'setup', hookExecutionId: hookExecId,
        runId: suiteRunId,
        status: hr.success ? 'passed' : 'failed',
        duration: hr.duration, stdout: hr.stdout, stderr: hr.stderr,
        variables: hr.variables, error: hr.error,
      })
    }

    if (!result.allPassed) {
      return finishEarly('Suite setup hook failed', 'suite-setup')
    }
    suiteHookVars = result.variables
  }

  let circuitBreakerTripped = false
  const memoryEnabled = config.memoryConfig?.enabled !== false && !!config.memoryProvider
  const memoryRoot = config.memoryRoot ?? DEFAULT_MEMORY_DIR
  let suiteBootstrapFailure: string | undefined

  try {
    await config.adapter.setup(config.platformConfig)

    const initialTargetName = suite.target ?? testEntries[0]?.[0].target
    if (config.resolveUrl && initialTargetName) {
      const rawSuiteUrl = config.resolveUrl(initialTargetName)
      if (rawSuiteUrl) {
        const resolvedSuiteUrl = resolveSuiteStartUrl(rawSuiteUrl, config, suiteHookVars)
        if (resolvedSuiteUrl.error) {
          suiteBootstrapFailure = resolvedSuiteUrl.error
        } else {
          const navigationTimeout = config.timeouts?.navigation ?? config.timeouts?.test
          const navigationAbortController = navigationTimeout && navigationTimeout > 0
            ? new AbortController()
            : undefined
          const navigationTimeoutId = navigationAbortController
            ? setTimeout(() => {
                navigationAbortController.abort(new Error(`Suite navigation timed out after ${navigationTimeout}ms`))
              }, navigationTimeout)
            : undefined

          try {
            const navigateResult = await withAbort(
              config.adapter.execute({ type: 'navigate', url: resolvedSuiteUrl.url! }),
              navigationAbortController?.signal,
            )
            if (!navigateResult.success) {
              suiteBootstrapFailure = navigateResult.error ?? `Failed to navigate to suite target URL "${resolvedSuiteUrl.url}"`
            }
          } catch (err) {
            suiteBootstrapFailure = err instanceof Error
              ? err.message
              : `Failed to navigate to suite target URL "${resolvedSuiteUrl.url}"`
          } finally {
            if (navigationTimeoutId) clearTimeout(navigationTimeoutId)
          }
        }
      }
    }

    if (suiteBootstrapFailure) {
      results.push({
        runId: suiteRunId,
        name: suite.name,
        filePath: '',
        status: 'failed',
        steps: [],
        duration: performance.now() - startTime,
        failureSummary: suiteBootstrapFailure,
        metadata: { phase: 'suite-bootstrap' },
      })
    } else {
      for (let i = 0; i < testEntries.length; i++) {
        const [test, filePath] = testEntries[i]
        const patched = patchTestForSuite(test, suite, i)

        // Fire onTestStart BEFORE per-test setup hooks so DashboardReporter creates
        // the DB row and runId is available for hook recording (Phase 107 fix)
        const suiteMembers = (suiteArtifact?.source as { members?: unknown[] } | undefined)?.members
        const memberArtifact = Array.isArray(suiteMembers) ? suiteMembers[i] : undefined
        const childRunId = generateRunId()
        await reporter?.onTestStart?.(patched, filePath, {
          runId: childRunId,
          parentRunId: suiteRunId,
          artifact: {
            kind: 'suite-child',
            suiteIndex: i,
            source: {
              kind: 'test',
              ...(memberArtifact && typeof memberArtifact === 'object' ? memberArtifact as Record<string, unknown> : {}),
              resolvedDefinition: patched,
              loadStatus: 'loaded',
            },
            config: suiteArtifact?.config,
            runtime: {
              platform: config.platformConfig.platform,
              suiteIndex: i,
              suiteTotal: testEntries.length,
              parentSuiteId: (suite as any)['suite-id'] ?? suite.name,
            },
          },
        } as any)

        // Per-test setup hooks (before each test, D-01/D-03)
        let perTestHookVars: Record<string, string> = {}
        let perTestSetupFailed = false
        if ((patched as any).setup?.length && config.resolvedHooks && suiteSandboxOptions) {
          const hookDefs: HookDefinition[] = []
          let hookMissing = false
          for (const hookId of (patched as any).setup) {
            const hook = config.resolvedHooks.get(hookId)
            if (!hook) { hookMissing = true; break }
            hookDefs.push(hook)
          }

        if (!hookMissing && hookDefs.length > 0) {
          const allVars: Record<string, string> = {}
          if (config.envFileVars) Object.assign(allVars, config.envFileVars)
          if (config.inlineVars) Object.assign(allVars, config.inlineVars)
          if (config.cliVars) Object.assign(allVars, config.cliVars)
          Object.assign(allVars, suiteHookVars)

          for (const hookDef of hookDefs) {
            const hookExecId = randomUUID()
            await reporter?.onHookStart?.({ hookId: hookDef.id, hookName: hookDef.name, phase: 'setup', hookExecutionId: hookExecId, runId: childRunId })
            const hookResult = await runHooks([hookDef], {
              ...suiteSandboxOptions,
              secretStore: config.secretStore,
              secretRedactor: config.secretRedactor,
              envVars: { ...suiteSandboxOptions.envVars, ...allVars, ...perTestHookVars },
            })
            const hr = hookResult.results.get(hookDef.name)
            await reporter?.onHookEnd?.({
              hookId: hookDef.id, hookName: hookDef.name, phase: 'setup', hookExecutionId: hookExecId,
              runId: childRunId,
              status: hr?.success ? 'passed' : 'failed',
              duration: hr?.duration ?? 0, stdout: hr?.stdout ?? '', stderr: hr?.stderr ?? '',
              variables: hr?.variables ?? {}, error: hr?.error,
            })
            if (!hr?.success) { hookMissing = true; break }
            Object.assign(perTestHookVars, hr.variables)
            Object.assign(allVars, hr.variables)
          }
        }

        if (hookMissing) perTestSetupFailed = true
      }

        if (perTestSetupFailed) {
          const setupFailureResult: TestResult = {
          runId: childRunId,
          name: test.name, filePath, status: 'failed', steps: [],
          duration: 0, failureSummary: 'Setup hook failed',
        }
        results.push(setupFailureResult)
        await reporter?.onTestEnd(setupFailureResult)
        break
      }

      let testFileContent = ''
      try { testFileContent = await readFile(filePath, 'utf-8') } catch { /* best-effort */ }

      const memoryInitParams: MemoryIndexParams | undefined = memoryEnabled ? {
        product: config.product!,
        testId: (test as any)['test-id'] ?? test.name,
        memoryRoot,
        suiteId: (suite as any)['suite-id'] ?? suite.name,
        currentSuiteTests: suite.tests as Array<{ test: string; id: string }>,
        currentPosition: i,
      } : undefined

      const result = await runTest(patched, {
        adapter: config.adapter,
        planner: config.planner,
        verifier: config.verifier,
        cache: config.cache,
        healingConfig: config.healingConfig,
        plannerModel: config.plannerModel,
        verifierModel: config.verifierModel,
        reporters: config.reporters,
        captureScreenshots: config.captureScreenshots,
        screenshotMode: config.screenshotMode,
        timeouts: config.timeouts,
        logger: config.logger,
        configContent: config.configContent,
        testFileContent,
        suiteFileContent: config.suiteFileContent,
        suiteTestIndex: i,
        suiteContext: (suite as any).context,
        envFileVars: config.envFileVars,
        inlineVars: config.inlineVars,
        suiteVars: suiteHookVars,
        cliVars: config.cliVars,
        hookSetupVars: perTestHookVars,
        inlineHookDefs: config.resolvedHooks,
        inlineHookSandboxOptions: suiteSandboxOptions,
        secretStore: config.secretStore,
        secretRedactor: config.secretRedactor,
        accessibility: config.accessibility,
        accessibilityCheck: config.accessibilityCheck,
        logCapture: config.logCapture,
        screenshotSize: config.screenshotSize,
        effectiveResolution: config.effectiveResolution,
        memoryProvider: memoryEnabled ? config.memoryProvider : undefined,
        memoryInitParams,
        circuitBreaker: config.circuitBreaker,
        skipReporterOnTestStart: true,
        runId: childRunId,
        parentRunId: suiteRunId,
      }, filePath)
      if (!result.runId) result.runId = childRunId

      // Per-test teardown hooks (after each test, D-01/D-03)
      if ((patched as any).teardown?.length && config.resolvedHooks && suiteSandboxOptions) {
        for (const hookId of (patched as any).teardown) {
          const hook = config.resolvedHooks.get(hookId)
          if (!hook) continue
          const hookExecId = randomUUID()
          try {
            await reporter?.onHookStart?.({ hookId: hook.id, hookName: hook.name, phase: 'teardown', hookExecutionId: hookExecId, runId: childRunId })
            const teardownVars: Record<string, string> = {}
            if (config.envFileVars) Object.assign(teardownVars, config.envFileVars)
            if (config.cliVars) Object.assign(teardownVars, config.cliVars)
            Object.assign(teardownVars, suiteHookVars, perTestHookVars)
            const hookResult = await runHooks([hook], {
              ...suiteSandboxOptions,
              secretStore: config.secretStore,
              secretRedactor: config.secretRedactor,
              envVars: { ...suiteSandboxOptions.envVars, ...teardownVars },
            })
            const hr = hookResult.results.get(hook.name)
            await reporter?.onHookEnd?.({
              hookId: hook.id, hookName: hook.name, phase: 'teardown', hookExecutionId: hookExecId,
              runId: childRunId,
              status: hr?.success ? 'passed' : 'failed',
              duration: hr?.duration ?? 0, stdout: hr?.stdout ?? '', stderr: hr?.stderr ?? '',
              variables: hr?.variables ?? {}, error: hr?.error,
            })
          } catch {}
        }
      }

      if (memoryEnabled && config.memoryProvider) {
        let ablationHandledDeprecation = false

        if (config.memoryConfig?.ablationEnabled !== false && result.status === 'failed') {
          try {
            if (shouldAblate(result, config.memoryProvider)) {
              if (config.createAdapter) {
                console.log(`  ${pc.dim('Memory:')} ablation retry -- re-running without memory...`)
                const ablationAdapter = await config.createAdapter()
                await ablationAdapter.setup(config.platformConfig)
                try {
                  const ablationResult = await runTest(patched, {
                    adapter: ablationAdapter,
                    planner: config.planner,
                    verifier: config.verifier,
                    healingConfig: config.healingConfig,
                    plannerModel: config.plannerModel,
                    verifierModel: config.verifierModel,
                    cache: config.cache,
                    timeouts: config.timeouts,
                    logger: config.logger,
                    secretStore: config.secretStore,
                    secretRedactor: config.secretRedactor,
                    accessibility: config.accessibility,
                    accessibilityCheck: config.accessibilityCheck,
                  }, filePath)

                  if (config.circuitBreaker) {
                    config.circuitBreaker.record({ withMemory: false, passed: ablationResult.status === 'passed' })
                  }
                  if (ablationResult.status === 'passed') {
                    console.log(`  ${pc.dim('Memory:')} ablation confirmed memory caused failure -- penalizing observations`)
                    const injectedMap = collectAllInjectedIds(result, config.memoryProvider)
                    await deprecateOnFailure({
                      testResult: result,
                      provider: config.memoryProvider,
                      memoryRoot,
                      injectedObservationIds: injectedMap,
                      trustContradictDelta: config.memoryConfig?.trustContradictDelta,
                    })
                    ablationHandledDeprecation = true
                  } else {
                    console.log(`  ${pc.dim('Memory:')} ablation retry also failed -- memory not the cause`)
                  }
                } finally {
                  await ablationAdapter.cleanup()
                }
              }
            }
          } catch (err) {
            console.warn(`  ${pc.dim('Memory:')} ablation error -- ${(err as Error).message}`)
          }
        }

        if (config.memoryConfig?.curatorEnabled !== false && !ablationHandledDeprecation) {
          try {
            const injectedObservationIds = new Map<number, string[]>()
            for (let si = 0; si < result.steps.length; si++) {
              const ids = config.memoryProvider.getInjectedObservations(si)
              if (ids.length > 0) injectedObservationIds.set(si, ids)
            }
            const suiteId = (suite as any)['suite-id'] ?? suite.name
            const testId = (test as any)['test-id'] ?? test.name
            const memoryLog = await runCurator({
              testResult: result,
              provider: config.memoryProvider,
              model: config.plannerModel,
              providerOptions: config.providerOptions,
              memoryRoot,
              product: config.product!,
              testId,
              suiteId,
              suiteContext: {
                tests: suite.tests as Array<{ test: string; id: string }>,
                position: i,
              },
              injectedObservationIds,
              trustConfirmDelta: config.memoryConfig?.trustConfirmDelta,
              trustContradictDelta: config.memoryConfig?.trustContradictDelta,
            })
            ;(result as any).memoryLog = memoryLog
            printMemoryStatus(memoryLog)
            config.onCuratorComplete?.(test.name, memoryLog)
          } catch (err) {
            console.warn(`  ${pc.dim('Memory:')} curator error -- ${(err as Error).message}`)
          }
        }

        if (config.circuitBreaker) {
          const hadMemory = result.steps.some((_, si) => config.memoryProvider!.getInjectedObservations(si).length > 0)
          config.circuitBreaker.record({ withMemory: hadMemory, passed: result.status === 'passed' })
        }
        if (config.circuitBreaker?.isTripped() && !circuitBreakerTripped) {
          circuitBreakerTripped = true
          console.log(`  ${pc.yellow('Memory: circuit breaker tripped -- disabling memory injection for remaining tests')}`)
        }
      }

        results.push(result)

        if (result.status === 'cancelled') {
          break
        }

        if (result.status === 'failed') {
          for (let j = i + 1; j < testEntries.length; j++) {
            const [skippedTest, skippedPath] = testEntries[j]
            results.push({
              runId: generateRunId(),
              name: skippedTest.name,
              filePath: skippedPath,
              status: 'skipped',
              steps: [],
              duration: 0,
              metadata: {
                ...((skippedTest as any).meta ?? {}),
                skipReason: `Skipped: previous test "${test.name}" failed (fail-fast)`,
              },
            })
          }
          break
        }
      }
    }
    if (
      config.authStateCapture
      && results.length > 0
      && results.every((result) => result.status === 'passed')
    ) {
      try {
        const capturedAuthState = await config.authStateCapture.capture()
        suiteSandboxOptions = config.sandboxOptions
          ? { ...config.sandboxOptions, authState: capturedAuthState }
          : config.sandboxOptions
      } catch {
        const captureFailureResult: TestResult = {
          runId: suiteRunId,
          name: 'Auth state capture',
          filePath: '',
          status: 'failed',
          steps: [],
          duration: 0,
          failureSummary: config.authStateCapture.failureSummary,
          metadata: { phase: 'auth-state-capture' },
        }
        results.push(captureFailureResult)
        await reporter?.onTestEnd(captureFailureResult)
      }
    }
  } finally {
    // Suite-level teardown hooks with accumulated variables (D-14)
    if ((suite as any).teardown?.length && config.resolvedHooks && suiteSandboxOptions) {
      const teardownVars: Record<string, string> = {}
      if (config.envFileVars) Object.assign(teardownVars, config.envFileVars)
      if (config.inlineVars) Object.assign(teardownVars, config.inlineVars)
      if (config.cliVars) Object.assign(teardownVars, config.cliVars)
      Object.assign(teardownVars, suiteHookVars)

      for (const hookId of (suite as any).teardown) {
        const hook = config.resolvedHooks.get(hookId)
        if (!hook) continue
        const hookExecId = randomUUID()
        try {
          await reporter?.onHookStart?.({ hookId: hook.id, hookName: hook.name, phase: 'teardown', hookExecutionId: hookExecId, runId: suiteRunId })
          const hookResult = await runHooks([hook], {
            ...suiteSandboxOptions,
            secretStore: config.secretStore,
            secretRedactor: config.secretRedactor,
            envVars: { ...suiteSandboxOptions.envVars, ...teardownVars },
          })
          const hr = hookResult.results.get(hook.name)
          await reporter?.onHookEnd?.({
            hookId: hook.id, hookName: hook.name, phase: 'teardown', hookExecutionId: hookExecId,
            runId: suiteRunId,
            status: hr?.success ? 'passed' : 'failed',
            duration: hr?.duration ?? 0, stdout: hr?.stdout ?? '', stderr: hr?.stderr ?? '',
            variables: hr?.variables ?? {}, error: hr?.error,
          })
        } catch {}
      }
    }

    await config.adapter.cleanup()
    if (config.memoryProvider) {
      try { config.memoryProvider.destroy() } catch {}
    }
  }

  const passed = results.filter(r => r.status === 'passed').length
  const failed = results.filter(r => r.status === 'failed').length
  const cancelled = results.filter(r => r.status === 'cancelled').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const duration = results.reduce((sum, r) => sum + r.duration, 0)
  const suiteStatus: SuiteResult['status'] = failed > 0 ? 'failed' : cancelled > 0 ? 'cancelled' : 'passed'

  const runSummary: RunSummary = { results, duration, passed, failed, skipped }
  await reporter?.onRunEnd(runSummary)

  const suiteSummary: SuiteSummary = {
    runId: suiteRunId,
    name: suite.name,
    status: suiteStatus,
    tests: results,
    duration,
    passed,
    failed,
    skipped,
  }
  await reporter?.onSuiteEnd(suiteSummary)

  const failedIndex = results.findIndex(r => r.status === 'failed')

  return {
    runId: suiteRunId,
    name: suite.name,
    status: suiteStatus,
    tests: results,
    duration,
    failedAt: failedIndex >= 0 ? failedIndex : undefined,
  }
}
