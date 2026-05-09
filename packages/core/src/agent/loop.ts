import { resolve as resolvePath, isAbsolute, dirname } from 'node:path'
import type { Action, ActionResult, ScreenState } from '../types/platform.js'
import type { StepResult, StepTrace, StepAnnotation, TokenUsage, SubActionTrace } from '../types/result.js'
import type { ActionPlan } from '../schema/action-schema.js'
import type { AgentLoopConfig, StepContext, PlanResult } from './types.js'
import { hashScreenState, hashStepInstruction } from './observation.js'
import { formatAction } from './prompts.js'
import { compressScreenshot } from '../screenshot/compress.js'
import { normalizePointerActionForStep } from '../tools/pointer-action-normalization.js'
import { findSecretTemplates, redactSecretValue, resolveSecretTemplatesInValue } from './secrets.js'
import sharp from 'sharp'

export type AgentAbortScope = 'test' | 'step'

export interface AgentTimeoutAbortReason {
  type: 'agent-qa-timeout'
  scope: AgentAbortScope
  timeoutMs: number
  message: string
}

export function createTimeoutAbortReason(scope: AgentAbortScope, timeoutMs: number): AgentTimeoutAbortReason {
  const label = scope === 'test' ? 'Test' : 'Step'
  return {
    type: 'agent-qa-timeout',
    scope,
    timeoutMs,
    message: `${label} timed out after ${timeoutMs}ms`,
  }
}

export function getTimeoutAbortReason(signal: AbortSignal | undefined): AgentTimeoutAbortReason | undefined {
  const reason = signal?.reason
  if (!reason || typeof reason !== 'object') return undefined
  const maybeReason = reason as Partial<AgentTimeoutAbortReason>
  return maybeReason.type === 'agent-qa-timeout'
    && (maybeReason.scope === 'test' || maybeReason.scope === 'step')
    && typeof maybeReason.timeoutMs === 'number'
    && typeof maybeReason.message === 'string'
    ? maybeReason as AgentTimeoutAbortReason
    : undefined
}

export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw signal.reason ?? new Error('Operation aborted')

  let onAbort: (() => void) | undefined
  const abortPromise = new Promise<T>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Operation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

const REDACTED_SECRET_MARKER_RE = /\[secret:\w+\]/

function containsRedactedSecretMarker(value: unknown): boolean {
  if (typeof value === 'string') return REDACTED_SECRET_MARKER_RE.test(value)
  if (Array.isArray(value)) return value.some((item) => containsRedactedSecretMarker(item))
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return false
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some((item) => containsRedactedSecretMarker(item))
  }
  return false
}

export async function executeStep(
  stepInstruction: string,
  config: AgentLoopConfig,
  context: StepContext,
): Promise<StepResult> {
  const startTime = performance.now()
  const maxSubActions = config.plannerConfig?.maxSubActions ?? 50
  const deadline = config.stepTimeout ? startTime + config.stepTimeout : 0
  const subActions: SubActionTrace[] = []
  let consecutiveFailures = 0
  const consecutiveFailureLimit = config.maxAttempts ?? 3

  // Feed sub-action history to planner so it knows what it already tried
  context.subActionHistory = []

  let totalPromptTokens = 0
  let totalCompletionTokens = 0

  const initialAbortResult = buildAbortResult(
    config.abortSignal, stepInstruction, subActions, startTime,
    totalPromptTokens, totalCompletionTokens,
  )
  if (initialAbortResult) return initialAbortResult

  // Capture "before" screenshot at the start of the step
  let screenshotBefore: Buffer | undefined
  if (config.adapter.screenshot) {
    try { screenshotBefore = await withAbort(config.adapter.screenshot(), config.abortSignal) } catch { /* best-effort */ }
  }

  const stepHash = hashStepInstruction({
    step: stepInstruction, platform: config.adapter.platform, configContent: config.configContent,
    testFileContent: config.testFileContent, stepIndex: config.stepIndex,
    suiteFileContent: config.suiteFileContent, suiteTestIndex: config.suiteTestIndex,
  })
  let lastAnnotation: StepAnnotation | undefined
  const abortResultForCurrentState = () => buildAbortResult(
    config.abortSignal, stepInstruction, subActions, startTime,
    totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
  )
  let previousScreenHash: string | undefined
  let nextSubScreenshotBefore: Buffer | undefined = screenshotBefore

  for (let actionIndex = 0; actionIndex < maxSubActions; actionIndex++) {
    const subScreenshotBefore = nextSubScreenshotBefore

    const abortBeforeObserve = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortBeforeObserve) return abortBeforeObserve

    if (deadline && performance.now() > deadline) {
      return buildMultiActionFailure(
        stepInstruction, subActions, startTime,
        `Step timed out after ${config.stepTimeout}ms`,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
    }

    const subPhaseTimings: Record<string, number> = {}

    if (actionIndex === 0 && config.cacheState?.invalidated) {
      config.logger?.createScopedLogger('cache')?.debug(
        'Skipping cache reads for step (prefix invalidated)',
        { stepHash },
      )
    }

    // 1. OBSERVE: always re-observe
    let phaseStart = performance.now()
    let screenState: ScreenState
    try {
      screenState = await withAbort(
        config.adapter.observe({ extractDom: true }),
        config.abortSignal,
      )
    } catch (err) {
      const abortResult = abortResultForCurrentState()
      if (abortResult) return abortResult
      throw err
    }
    let screenshot: Buffer | undefined
    if (config.adapter.screenshot) {
      try { screenshot = await withAbort(config.adapter.screenshot(), config.abortSignal) } catch { /* best-effort */ }
    }
    subPhaseTimings.observe = performance.now() - phaseStart
    await config.onPhase?.({ phase: 'observe', subActionIndex: actionIndex, duration: subPhaseTimings.observe })

    const screenContextBefore = screenState.url

    const abortAfterObserve = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortAfterObserve) return abortAfterObserve

    // Detect whether the screen changed since the last action
    const currentScreenHash = hashScreenState(screenState)
    if (previousScreenHash !== undefined && context.subActionHistory!.length > 0) {
      const lastEntry = context.subActionHistory![context.subActionHistory!.length - 1]
      lastEntry.screenChanged = currentScreenHash !== previousScreenHash
    }
    previousScreenHash = currentScreenHash

    // Compress screenshot for LLM planner (dashboard screenshots stay raw)
    if (screenshot && (config.screenshotSize || config.effectiveResolution)) {
      if (!config.effectiveResolution) {
        throw new Error('effectiveResolution is required in LLM config when screenshot compression is enabled')
      }
      try {
        const compressLogger = config.logger?.createScopedLogger('agent')
        const actionSpaceWidth = (screenState.metadata.viewportWidth as number | undefined)
          ?? (await withAbort(sharp(screenshot).metadata(), config.abortSignal)).width
          ?? 0
        const result = await withAbort(
          compressScreenshot(screenshot, {
            effectiveResolution: config.effectiveResolution,
            maxBytes: config.screenshotSize,
            actionSpaceWidth,
          }, compressLogger),
          config.abortSignal,
        )
        screenshot = result.buffer
        screenState.metadata.imageWidth = result.imageWidth
        screenState.metadata.imageHeight = result.imageHeight
      } catch (err) {
        const abortResult = abortResultForCurrentState()
        if (abortResult) return abortResult
        throw err
      }
    }

    // 2. PLAN: cache-first, then LLM
    phaseStart = performance.now()
    if (screenshot) context.screenshot = screenshot

    let planResult: PlanResult
    let cached = false

    const prefixValid = !config.cacheState?.invalidated

    if (prefixValid && config.cache?.getSubAction) {
      const cachedPlan = await config.cache.getSubAction(stepHash, actionIndex)
      if (cachedPlan) {
        const secretStepUsesRuntimeTemplate = findSecretTemplates(stepInstruction).length > 0
        if (secretStepUsesRuntimeTemplate && containsRedactedSecretMarker(cachedPlan.action)) {
          await config.cache.invalidateSubActionsFrom?.(stepHash, actionIndex)
          config.logger?.createScopedLogger('cache')?.debug(
            'Ignoring cached sub-action with redacted secret marker',
            { stepHash, actionIndex },
          )
        } else {
          planResult = { plan: cachedPlan }
          cached = true
        }
      }
    }

    if (!cached) {
      // Cache miss at index N → invalidate all remaining cached sub-actions
      if (config.cache?.invalidateSubActionsFrom) {
        await config.cache.invalidateSubActionsFrom(stepHash, actionIndex)
      }
      if (config.cacheState && !config.cacheState.invalidated) {
        config.cacheState.invalidated = true
        config.logger?.createScopedLogger('cache')?.debug(
          'Cache prefix invalidated — subsequent steps will skip cache reads',
          { stepHash, actionIndex },
        )
      }
      try {
        planResult = await withAbort(
          config.planner.plan(stepInstruction, screenState, context, config.abortSignal),
          config.abortSignal,
        )
      } catch (planError: unknown) {
        const abortDuringPlan = buildAbortResult(
          config.abortSignal, stepInstruction, subActions, startTime,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
        if (abortDuringPlan) return abortDuringPlan
        const errorMsg = planError instanceof Error ? planError.message : String(planError)
        const contextErrorPatterns = [
          'context length', 'maximum context', 'token limit',
          'too many tokens', 'exceeds.*max', 'input.*too long',
        ]
        const isContextError = contextErrorPatterns.some(p =>
          new RegExp(p, 'i').test(errorMsg)
        )
        const displayMsg = isContextError
          ? `Model context window exceeded. ${errorMsg}. Increase contextWindow on your LLM config or reduce previousStepCount in planner config.`
          : `LLM planning failed: ${errorMsg}`
        return buildMultiActionFailure(
          stepInstruction, subActions, startTime, displayMsg,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
      }
    }

    if (planResult!.tokenUsage) {
      totalPromptTokens += planResult!.tokenUsage.promptTokens
      totalCompletionTokens += planResult!.tokenUsage.completionTokens
    }
    subPhaseTimings.plan = performance.now() - phaseStart

    const rawPlan = planResult!.plan
    const normalizedAction = normalizePointerActionForStep(rawPlan.action as Action, stepInstruction)
    const action = redactSecretValue(normalizedAction, config.secretRedactor)
    const plan: ActionPlan = {
      ...rawPlan,
      reasoning: redactSecretValue(rawPlan.reasoning, config.secretRedactor),
      action,
    }
    const cachePlan: ActionPlan = {
      ...rawPlan,
      action: normalizedAction,
    }
    await config.onPhase?.({ phase: 'plan', subActionIndex: actionIndex, text: plan.reasoning, confidence: plan.confidence, action: plan.action, duration: subPhaseTimings.plan })

    const abortAfterPlan = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortAfterPlan) return abortAfterPlan

    // Cast action to Action — runtime validation already done by toolCallToActionPlan in the registry
    // Check stepFailed before execution
    if (plan.stepFailed) {
      subActions.push({
        index: actionIndex,
        observation: screenState.tree,
        reasoning: plan.reasoning,
        plannedAction: action,
        result: 'failure' as const,
        error: `Planner signaled step failure: ${plan.reasoning}`,
        screenStateBefore: screenState.tree,
        screenContextBefore,
        confidence: plan.confidence,
        cached: false,
        tokenUsage: planResult!.tokenUsage,
        phaseDurations: subPhaseTimings,
        screenshotBefore: subScreenshotBefore,
      })

      return buildMultiActionFailure(
        stepInstruction, subActions, startTime,
        `Step failed: ${plan.reasoning}`,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
    }

    // 3. EXECUTE
    phaseStart = performance.now()
    let execResult: ActionResult
    let execError: string | undefined
    try {
      const actionForExecution = resolveSecretTemplatesInValue(normalizedAction, config.secretStore)
      if (actionForExecution.type === 'setVariable') {
        const sv = actionForExecution as Extract<Action, { type: 'setVariable' }>
        config.onSetVariable?.(sv.name, sv.value)
        execResult = { success: true }
      } else {
        // Pre-resolve fileUpload relative paths to absolute using testFilePath (per research Pattern 3)
        let actionToExecute = actionForExecution
        if (actionForExecution.type === 'fileUpload' && config.testFilePath) {
          const testDir = dirname(config.testFilePath)
          const resolvedFiles = actionForExecution.files.map(f =>
            isAbsolute(f) ? f : resolvePath(testDir, f)
          )
          actionToExecute = { ...actionForExecution, files: resolvedFiles }
        }
        execResult = redactSecretValue(
          await withAbort(config.adapter.execute(actionToExecute), config.abortSignal),
          config.secretRedactor,
        )
      }
      if (!execResult.success) execError = execResult.error ?? 'Action failed'
    } catch (err) {
      execError = redactSecretValue(err instanceof Error ? err.message : String(err), config.secretRedactor)
      execResult = { success: false, error: execError }
    }
    subPhaseTimings.execute = performance.now() - phaseStart
    await config.onPhase?.({ phase: 'execute', subActionIndex: actionIndex, action, success: !execError, duration: subPhaseTimings.execute })

    const abortAfterExecute = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortAfterExecute) return abortAfterExecute

    // setVariable is purely in-memory -- skip verification and return success immediately
    if (action.type === 'setVariable' && plan.stepComplete) {
      subActions.push({
        index: actionIndex,
        observation: screenState.tree,
        reasoning: plan.reasoning,
        plannedAction: action,
        result: 'success',
        screenStateBefore: screenState.tree,
        screenContextBefore,
        screenContextAfter: screenContextBefore,
        confidence: plan.confidence,
        cached,
        tokenUsage: planResult!.tokenUsage,
        phaseDurations: subPhaseTimings,
        screenshotBefore: subScreenshotBefore,
        screenshotAfter: subScreenshotBefore,
      })

      if (!cached && config.cache?.setSubAction) {
        await config.cache.setSubAction(stepHash, actionIndex, cachePlan)
      }

      return buildMultiActionSuccess(
        stepInstruction, subActions, startTime,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
    }

    // Non-visual assert: LLM evaluated the condition without screen evidence -- trust its judgment
    if (action.type === 'assert' && (action as Extract<Action, { type: 'assert' }>).visual === false && plan.stepComplete) {
      subActions.push({
        index: actionIndex,
        observation: screenState.tree,
        reasoning: plan.reasoning,
        plannedAction: action,
        result: 'success',
        screenStateBefore: screenState.tree,
        screenContextBefore,
        screenContextAfter: screenContextBefore,
        confidence: plan.confidence,
        cached,
        tokenUsage: planResult!.tokenUsage,
        phaseDurations: subPhaseTimings,
        screenshotBefore: subScreenshotBefore,
        screenshotAfter: subScreenshotBefore,
      })

      if (!cached && config.cache?.setSubAction) {
        await config.cache.setSubAction(stepHash, actionIndex, cachePlan)
      }

      return buildMultiActionSuccess(
        stepInstruction, subActions, startTime,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
    }

    // Build annotation from execution result (coordinates/boundingBox)
    const actionType = action.type as StepAnnotation['type']
    const annotationType = ['click', 'fill', 'tap', 'hover', 'scroll', 'swipe', 'pinch', 'navigate'].includes(actionType)
      ? actionType : 'other' as const
    const vw = screenState.metadata?.viewportWidth as number | undefined
    const vh = screenState.metadata?.viewportHeight as number | undefined
    lastAnnotation = {
      type: annotationType,
      clickPoint: execResult.coordinates,
      boundingBox: execResult.boundingBox,
      viewport: vw && vh ? { width: vw, height: vh } : undefined,
    }

    if (annotationType === 'scroll' && vw && vh) {
      if (lastAnnotation.clickPoint) {
        lastAnnotation.clickPoint = {
          x: Math.max(0, Math.min(lastAnnotation.clickPoint.x, vw)),
          y: Math.max(0, Math.min(lastAnnotation.clickPoint.y, vh)),
        }
      }
      if (lastAnnotation.boundingBox) {
        let { x, y, width, height } = lastAnnotation.boundingBox
        if (y < 0) { height += y; y = 0 }
        if (x < 0) { width += x; x = 0 }
        if (x + width > vw) width = vw - x
        if (y + height > vh) height = vh - y
        width = Math.max(0, width)
        height = Math.max(0, height)
        if (width <= 0 || height <= 0) {
          lastAnnotation.boundingBox = undefined
        } else {
          lastAnnotation.boundingBox = { x, y, width, height }
        }
      }
    }

    if (action.type === 'scroll') {
      const a = action as Extract<Action, { type: 'scroll' }>
      if (a.scrollType === 'vertical') {
        lastAnnotation.direction = a.value > 0 ? 'down' : 'up'
      } else {
        lastAnnotation.direction = a.value > 0 ? 'right' : 'left'
      }
    } else if (action.type === 'swipe') {
      const a = action as Extract<Action, { type: 'swipe' }>
      lastAnnotation.direction = a.direction
      if (execResult.startCoordinates) {
        lastAnnotation.startPoint = execResult.startCoordinates
      } else if (a.startX !== undefined && a.startY !== undefined) {
        lastAnnotation.startPoint = { x: a.startX, y: a.startY }
      }
      if (execResult.endCoordinates) {
        lastAnnotation.endPoint = execResult.endCoordinates
      } else if (a.endX !== undefined && a.endY !== undefined) {
        lastAnnotation.endPoint = { x: a.endX, y: a.endY }
      }
    } else if (action.type === 'pinch') {
      const a = action as Extract<Action, { type: 'pinch' }>
      lastAnnotation.pinchScale = a.scale > 1 ? 'out' : 'in'
      if (execResult.coordinates) {
        lastAnnotation.startPoint = execResult.coordinates
      } else if (a.x !== undefined && a.y !== undefined) {
        lastAnnotation.startPoint = { x: a.x, y: a.y }
      }
    } else if (action.type === 'drag') {
      if (execResult.startCoordinates) lastAnnotation.startPoint = execResult.startCoordinates
      if (execResult.endCoordinates) lastAnnotation.endPoint = execResult.endCoordinates
    }

    // Capture "after" screenshot post-execution
    let subScreenshotAfter: Buffer | undefined
    if (config.adapter.screenshot) {
      try { subScreenshotAfter = await withAbort(config.adapter.screenshot(), config.abortSignal) } catch { /* best-effort */ }
    }
    nextSubScreenshotBefore = subScreenshotAfter

    const abortAfterPostActionScreenshot = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortAfterPostActionScreenshot) return abortAfterPostActionScreenshot

    // 4. Handle execution failure
    if (execError) {
      consecutiveFailures++

      subActions.push({
        index: actionIndex,
        observation: screenState.tree,
        reasoning: plan.reasoning,
        plannedAction: action,
        result: 'failure',
        error: execError,
        screenStateBefore: screenState.tree,
        screenContextBefore,
        confidence: plan.confidence,
        cached,
        tokenUsage: planResult!.tokenUsage,
        phaseDurations: subPhaseTimings,
        screenshotBefore: subScreenshotBefore,
        screenshotAfter: subScreenshotAfter,
        annotation: lastAnnotation ? { ...lastAnnotation, failureHighlight: lastAnnotation.boundingBox } : undefined,
        data: execResult.data,
      })

      context.subActionHistory!.push({
        action: formatAction(action),
        reasoning: plan.reasoning,
        result: 'failure',
        error: execError,
        data: execResult.data !== undefined ? JSON.stringify(execResult.data).slice(0, 2000) : undefined,
      })

      // If this was a cached action that failed, invalidate cache and replan
      if (cached && config.cache?.invalidateSubActionsFrom) {
        await config.cache.invalidateSubActionsFrom(stepHash, actionIndex)
      }

      // Bail out on consecutive failure limit
      if (consecutiveFailures >= consecutiveFailureLimit) {
        if (lastAnnotation) lastAnnotation.failureHighlight = lastAnnotation.boundingBox
        const succeeded = subActions.filter(s => s.result === 'success').length
        const failed = subActions.filter(s => s.result === 'failure').length
        return buildMultiActionFailure(
          stepInstruction, subActions, startTime,
          `Consecutive failure limit reached (${consecutiveFailureLimit}). ${succeeded} succeeded, ${failed} failed. Last error: ${execError}`,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
      }

      // Inject error into context for next planning call
      context.failureContext = `Sub-action ${actionIndex + 1} failed: ${execError}\n` +
        `Failed action: ${JSON.stringify(action)}\n` +
        `Adapt your approach — try a different element or strategy.`

      continue
    }

    // Execution succeeded
    consecutiveFailures = 0
    context.failureContext = undefined

    // 5. VERIFY (hybrid strategy — only when stepComplete is true)
    let verifierReasoning: string | undefined
    if (plan.stepComplete && config.verifier) {
      phaseStart = performance.now()
      // For assert actions, use the planner's observation as afterState — assert doesn't
      // change the screen, and re-observing may lose scrolled content (e.g., "More" link
      // visible after scroll but gone after re-observe from default viewport)
      let afterState: ScreenState
      try {
        afterState = action.type === 'assert'
          ? screenState
          : await withAbort(config.adapter.observe(), config.abortSignal)
      } catch (err) {
        const abortResult = abortResultForCurrentState()
        if (abortResult) return abortResult
        throw err
      }
      let verifyScreenshot: Buffer | undefined
      if (config.adapter.screenshot) {
        try { verifyScreenshot = await withAbort(config.adapter.screenshot(), config.abortSignal) } catch { /* best-effort */ }
      }
      if (verifyScreenshot && (config.screenshotSize || config.effectiveResolution)) {
        if (!config.effectiveResolution) {
          throw new Error('effectiveResolution is required in LLM config when screenshot compression is enabled')
        }
        try {
          const compressLogger = config.logger?.createScopedLogger('agent')
          const actionSpaceWidth = (screenState.metadata.viewportWidth as number | undefined)
            ?? (await withAbort(sharp(verifyScreenshot).metadata(), config.abortSignal)).width
            ?? 0
          const result = await withAbort(
            compressScreenshot(verifyScreenshot, {
              effectiveResolution: config.effectiveResolution,
              maxBytes: config.screenshotSize,
              actionSpaceWidth,
            }, compressLogger),
            config.abortSignal,
          )
          verifyScreenshot = result.buffer
          screenState.metadata.imageWidth = result.imageWidth
          screenState.metadata.imageHeight = result.imageHeight
        } catch (err) {
          const abortResult = abortResultForCurrentState()
          if (abortResult) return abortResult
          throw err
        }
      }
      const abortBeforeVerify = buildAbortResult(
        config.abortSignal, stepInstruction, subActions, startTime,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
      if (abortBeforeVerify) return abortBeforeVerify
      let verifyResult
      try {
        verifyResult = await withAbort(
          config.verifier.verify(
            stepInstruction, screenState, afterState, action, verifyScreenshot, config.abortSignal,
          ),
          config.abortSignal,
        )
      } catch (verifyError: unknown) {
        const abortDuringVerify = buildAbortResult(
          config.abortSignal, stepInstruction, subActions, startTime,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
        if (abortDuringVerify) return abortDuringVerify
        throw verifyError
      }
      if (verifyResult.tokenUsage) {
        totalPromptTokens += verifyResult.tokenUsage.promptTokens
        totalCompletionTokens += verifyResult.tokenUsage.completionTokens
      }
      subPhaseTimings.verify = performance.now() - phaseStart
      await config.onPhase?.({ phase: 'verify', subActionIndex: actionIndex, text: verifyResult.verification.reasoning, success: verifyResult.verification.success, duration: subPhaseTimings.verify })
      verifierReasoning = verifyResult.verification.reasoning

      const abortAfterVerify = buildAbortResult(
        config.abortSignal, stepInstruction, subActions, startTime,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
      if (abortAfterVerify) return abortAfterVerify

      if (verifyResult.verification.success) {
        // Goal met — record final sub-action, return success
        subActions.push({
          index: actionIndex,
          observation: screenState.tree,
          reasoning: plan.reasoning,
          plannedAction: action,
          result: 'success',
          screenStateBefore: screenState.tree,
          screenStateAfter: afterState.tree,
          screenContextBefore,
          screenContextAfter: afterState.url,
          confidence: plan.confidence,
          verifierReasoning,
          cached,
          tokenUsage: planResult!.tokenUsage,
          phaseDurations: subPhaseTimings,
          screenshotBefore: subScreenshotBefore,
          screenshotAfter: subScreenshotAfter,
          annotation: lastAnnotation,
          data: execResult.data,
        })

        // Cache the sub-action if not already cached
        if (!cached && config.cache?.setSubAction) {
          await config.cache.setSubAction(stepHash, actionIndex, cachePlan)
        }

        return buildMultiActionSuccess(
          stepInstruction, subActions, startTime,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
      }

      if (verifyResult.verification.isAppError) {
        if (lastAnnotation) lastAnnotation.failureHighlight = lastAnnotation.boundingBox
        // App error — bail out
        subActions.push({
          index: actionIndex,
          observation: screenState.tree,
          reasoning: plan.reasoning,
          plannedAction: action,
          result: 'failure',
          error: verifyResult.verification.reasoning,
          screenStateBefore: screenState.tree,
          screenContextBefore,
          confidence: plan.confidence,
          verifierReasoning,
          cached,
          tokenUsage: planResult!.tokenUsage,
          phaseDurations: subPhaseTimings,
          screenshotBefore: subScreenshotBefore,
          screenshotAfter: subScreenshotAfter,
          annotation: lastAnnotation,
          data: execResult.data,
        })
        return buildMultiActionFailure(
          stepInstruction, subActions, startTime,
          `Application error: ${verifyResult.verification.reasoning}`,
          totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
        )
      }

      // Verifier says not done — planner was wrong about stepComplete, continue loop
    }

    const abortAfterVerifierBlock = buildAbortResult(
      config.abortSignal, stepInstruction, subActions, startTime,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
    )
    if (abortAfterVerifierBlock) return abortAfterVerifierBlock

    // No verifier but planner claims step is complete — trust the planner
    if (plan.stepComplete && !config.verifier) {
      subActions.push({
        index: actionIndex,
        observation: screenState.tree,
        reasoning: plan.reasoning,
        plannedAction: action,
        result: 'success',
        screenStateBefore: screenState.tree,
        screenContextBefore,
        confidence: plan.confidence,
        cached,
        tokenUsage: planResult!.tokenUsage,
        phaseDurations: subPhaseTimings,
        screenshotBefore: subScreenshotBefore,
        screenshotAfter: subScreenshotAfter,
        annotation: lastAnnotation,
        data: execResult.data,
      })

      if (!cached && config.cache?.setSubAction) {
        await config.cache.setSubAction(stepHash, actionIndex, cachePlan)
      }

      return buildMultiActionSuccess(
        stepInstruction, subActions, startTime,
        totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
      )
    }

    // Record successful sub-action (goal not yet met)
    subActions.push({
      index: actionIndex,
      observation: screenState.tree,
      reasoning: plan.reasoning,
      plannedAction: action,
      result: 'success',
      screenStateBefore: screenState.tree,
      screenContextBefore,
      confidence: plan.confidence,
      verifierReasoning,
      cached,
      tokenUsage: planResult!.tokenUsage,
      phaseDurations: subPhaseTimings,
      screenshotBefore: subScreenshotBefore,
      screenshotAfter: subScreenshotAfter,
      annotation: lastAnnotation,
      data: execResult.data,
    })

    // If planner claimed stepComplete but verifier disagreed, pass the reason
    const wasVerifierRejected = plan.stepComplete && verifierReasoning !== undefined
    context.subActionHistory!.push({
      action: formatAction(action),
      reasoning: plan.reasoning,
      result: 'success',
      verifierRejection: wasVerifierRejected ? verifierReasoning : undefined,
      data: execResult.data !== undefined ? JSON.stringify(execResult.data).slice(0, 2000) : undefined,
    })

    // Cache the sub-action
    if (!cached && config.cache?.setSubAction) {
      await config.cache.setSubAction(stepHash, actionIndex, cachePlan)
    }
  }

  // Loop exhausted — replan limit hit
  if (lastAnnotation) lastAnnotation.failureHighlight = lastAnnotation.boundingBox
  const succeeded = subActions.filter(s => s.result === 'success').length
  const failed = subActions.filter(s => s.result === 'failure').length
  const lastAction = subActions.length > 0 ? JSON.stringify(subActions[subActions.length - 1].plannedAction) : 'none'
  return buildMultiActionFailure(
    stepInstruction, subActions, startTime,
    `Sub-action limit reached (${maxSubActions} actions). ${succeeded} succeeded, ${failed} failed. Last action: ${lastAction}. Step did not complete.`,
    totalPromptTokens, totalCompletionTokens, screenshotBefore, lastAnnotation,
  )
}

function buildAbortResult(
  abortSignal: AbortSignal | undefined,
  stepInstruction: string,
  subActions: SubActionTrace[],
  startTime: number,
  totalPromptTokens: number,
  totalCompletionTokens: number,
  screenshotBefore?: Buffer,
  annotation?: StepAnnotation,
): StepResult | null {
  if (!abortSignal?.aborted) return null
  const timeoutReason = getTimeoutAbortReason(abortSignal)
  if (timeoutReason) {
    return buildMultiActionFailure(
      stepInstruction, subActions, startTime, timeoutReason.message,
      totalPromptTokens, totalCompletionTokens, screenshotBefore, annotation,
    )
  }
  return buildCancelledResult(
    stepInstruction, subActions, startTime,
    totalPromptTokens, totalCompletionTokens, screenshotBefore, annotation,
  )
}

function buildMultiActionSuccess(
  stepInstruction: string,
  subActions: SubActionTrace[],
  startTime: number,
  totalPromptTokens: number,
  totalCompletionTokens: number,
  screenshotBefore?: Buffer,
  annotation?: StepAnnotation,
): StepResult {
  const lastSub = subActions[subActions.length - 1]
  const tokenUsage: TokenUsage | undefined =
    (totalPromptTokens > 0 || totalCompletionTokens > 0)
      ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }
      : undefined

  const aggregatedDurations: Record<string, number> = {}
  for (const sub of subActions) {
    if (sub.phaseDurations) {
      for (const [phase, dur] of Object.entries(sub.phaseDurations)) {
        aggregatedDurations[phase] = (aggregatedDurations[phase] ?? 0) + (dur ?? 0)
      }
    }
  }

  const trace: StepTrace = {
    observation: lastSub.observation,
    reasoning: lastSub.reasoning,
    plannedAction: lastSub.plannedAction,
    result: 'success',
    screenStateBefore: subActions[0].screenStateBefore,
    screenStateAfter: lastSub.screenStateAfter,
    screenContextBefore: subActions[0]?.screenContextBefore,
    screenContextAfter: lastSub?.screenContextAfter,
    confidence: lastSub.confidence,
    verifierReasoning: lastSub.verifierReasoning,
    tokenUsage,
    phaseDurations: {
      observe: aggregatedDurations.observe,
      plan: aggregatedDurations.plan,
      execute: aggregatedDurations.execute,
      verify: aggregatedDurations.verify,
    },
    subActions,
  }

  return {
    name: stepInstruction,
    status: 'passed',
    duration: performance.now() - startTime,
    action: lastSub.plannedAction,
    screenshotBefore,
    annotation,
    trace,
  }
}

function buildMultiActionFailure(
  stepInstruction: string,
  subActions: SubActionTrace[],
  startTime: number,
  error: string,
  totalPromptTokens: number,
  totalCompletionTokens: number,
  screenshotBefore?: Buffer,
  annotation?: StepAnnotation,
): StepResult {
  const lastSub = subActions.length > 0 ? subActions[subActions.length - 1] : undefined
  const tokenUsage: TokenUsage | undefined =
    (totalPromptTokens > 0 || totalCompletionTokens > 0)
      ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }
      : undefined

  const aggregatedDurations: Record<string, number> = {}
  for (const sub of subActions) {
    if (sub.phaseDurations) {
      for (const [phase, dur] of Object.entries(sub.phaseDurations)) {
        aggregatedDurations[phase] = (aggregatedDurations[phase] ?? 0) + (dur ?? 0)
      }
    }
  }

  const trace: StepTrace = {
    observation: lastSub?.observation ?? '',
    reasoning: lastSub?.reasoning ?? error,
    plannedAction: lastSub?.plannedAction ?? { type: 'waitFor', condition: 'none', timeout: 0 },
    result: 'failure',
    error,
    screenStateBefore: lastSub?.screenStateBefore ?? '',
    screenContextBefore: subActions[0]?.screenContextBefore,
    screenContextAfter: lastSub?.screenContextAfter,
    confidence: lastSub?.confidence,
    tokenUsage,
    phaseDurations: {
      observe: aggregatedDurations.observe,
      plan: aggregatedDurations.plan,
      execute: aggregatedDurations.execute,
      verify: aggregatedDurations.verify,
    },
    subActions,
  }

  return {
    name: stepInstruction,
    status: 'failed',
    duration: performance.now() - startTime,
    action: lastSub?.plannedAction,
    error,
    screenshotBefore,
    annotation,
    trace,
  }
}

function buildCancelledResult(
  stepInstruction: string,
  subActions: SubActionTrace[],
  startTime: number,
  totalPromptTokens: number,
  totalCompletionTokens: number,
  screenshotBefore?: Buffer,
  annotation?: StepAnnotation,
): StepResult {
  const lastSub = subActions.length > 0 ? subActions[subActions.length - 1] : undefined
  const tokenUsage: TokenUsage | undefined =
    (totalPromptTokens > 0 || totalCompletionTokens > 0)
      ? { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens }
      : undefined

  const aggregatedDurations: Record<string, number> = {}
  for (const sub of subActions) {
    if (sub.phaseDurations) {
      for (const [phase, dur] of Object.entries(sub.phaseDurations)) {
        aggregatedDurations[phase] = (aggregatedDurations[phase] ?? 0) + (dur ?? 0)
      }
    }
  }

  const trace: StepTrace = {
    observation: lastSub?.observation ?? '',
    reasoning: lastSub?.reasoning ?? 'Step cancelled by user',
    plannedAction: lastSub?.plannedAction ?? { type: 'waitFor', condition: 'none', timeout: 0 },
    result: 'failure',
    error: 'Step cancelled by user',
    screenStateBefore: lastSub?.screenStateBefore ?? '',
    confidence: lastSub?.confidence,
    tokenUsage,
    phaseDurations: {
      observe: aggregatedDurations.observe,
      plan: aggregatedDurations.plan,
      execute: aggregatedDurations.execute,
      verify: aggregatedDurations.verify,
    },
    subActions,
  }

  return {
    name: stepInstruction,
    status: 'cancelled',
    duration: performance.now() - startTime,
    action: lastSub?.plannedAction,
    error: 'Step cancelled by user',
    screenshotBefore,
    annotation,
    trace,
  }
}
