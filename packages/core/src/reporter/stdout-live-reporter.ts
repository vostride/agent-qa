import type { Reporter, RunSummary, HookEvent, HookResultEvent, StepEventContext } from './types.js'
import type { TestDefinition } from '../types/test.js'
import type { StepResult, StepPhaseEvent, TestResult } from '../types/result.js'
import type { RunArtifactReporterContext } from '../artifacts/run-artifact.js'
import { redactSecretValue, type SecretRedactor } from '../agent/secrets.js'

export interface StdoutLiveReporterOptions {
  active?: boolean
  redactor?: SecretRedactor
}

export class StdoutLiveReporter implements Reporter {
  private active: boolean
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private activeRunId: string | undefined
  private activeParentRunId: string | null | undefined
  private activeSuiteIndex: number | undefined
  private activeSuiteTotal: number | undefined
  private redactor?: SecretRedactor

  constructor(options: StdoutLiveReporterOptions = {}) {
    this.active = options.active ?? process.env.AGENT_QA_LIVE_EVENTS === 'true'
    this.redactor = options.redactor
  }

  private emit(event: Record<string, unknown>): void {
    if (!this.active) return
    process.stdout.write(`AGENT_QA_EVENT:${JSON.stringify(redactSecretValue(event, this.redactor))}\n`)
  }

  private withRunId(event: Record<string, unknown>, runId = this.activeRunId): Record<string, unknown> {
    return runId ? { ...event, runId } : event
  }

  private withRunContext(event: Record<string, unknown>, context?: StepEventContext): Record<string, unknown> {
    const runId = context?.runId ?? this.activeRunId
    const parentRunId = context?.parentRunId ?? this.activeParentRunId
    const suiteIndex = context?.suiteIndex ?? this.activeSuiteIndex
    const suiteTotal = context?.suiteTotal ?? this.activeSuiteTotal
    return {
      ...this.withRunId(event, runId),
      ...(parentRunId ? { parentRunId } : {}),
      ...(typeof suiteIndex === 'number' ? { suiteIndex } : {}),
      ...(typeof suiteTotal === 'number' ? { suiteTotal } : {}),
      ...(typeof context?.testIndex === 'number' ? { testIndex: context.testIndex } : {}),
      ...(typeof context?.stepIndex === 'number' ? { stepIndex: context.stepIndex } : {}),
      ...(context?.stepId ? { stepId: context.stepId } : {}),
    }
  }

  onTestStart(test: TestDefinition, filePath: string, context?: RunArtifactReporterContext): void {
    this.activeRunId = context?.runId
    this.activeParentRunId = context?.parentRunId
    this.activeSuiteIndex = typeof context?.artifact?.suiteIndex === 'number'
      ? context.artifact.suiteIndex
      : typeof context?.artifact?.runtime === 'object'
        && context.artifact.runtime !== null
        && typeof (context.artifact.runtime as { suiteIndex?: unknown }).suiteIndex === 'number'
        ? (context.artifact.runtime as { suiteIndex: number }).suiteIndex
        : undefined
    this.activeSuiteTotal = readSuiteTotal(context)
    if (process.env.AGENT_QA_PARENT_RUN_ID) {
      this.emit(this.withRunContext({
        type: 'retry-attempt',
        attempt: parseInt(process.env.AGENT_QA_ATTEMPT_NUMBER ?? '1', 10),
        maxRetries: parseInt(process.env.AGENT_QA_MAX_RETRIES ?? '0', 10),
        testName: test.name,
      }))
    }
    this.emit(this.withRunContext({
      type: 'test-start',
      testName: test.name,
      filePath,
      totalSteps: test.steps.length,
    }))
    if (this.active) {
      this.heartbeatInterval = setInterval(() => this.emit(this.withRunContext({ type: 'heartbeat' })), 10_000)
    }
  }

  onStepStart(step: string, testName: string, context?: StepEventContext): void {
    this.emit(this.withRunContext({
      type: 'step-start',
      stepName: step,
      testName,
      timestamp: new Date().toISOString(),
    }, context))
  }

  onStepEnd(result: StepResult, testName: string, context?: StepEventContext): void {
    this.emit(this.withRunContext({
      type: 'step-complete',
      stepName: result.name,
      testName,
      status: result.status,
      duration: result.duration,
      screenshot: result.screenshot?.toString('base64'),
      screenshotBefore: result.screenshotBefore?.toString('base64'),
      observation: result.trace?.observation,
      reasoning: result.trace?.reasoning,
      plannedAction: result.trace?.plannedAction,
      result: result.trace?.result,
      error: result.error,
      annotation: result.annotation,
    }, context))
  }

  onStepPhase(phase: StepPhaseEvent, stepName: string, testName: string, context?: StepEventContext): void {
    this.emit(this.withRunContext({
      type: 'step-phase',
      stepName,
      testName,
      phase: phase.phase,
      subActionIndex: phase.subActionIndex,
      phaseOrdinal: phase.phaseOrdinal,
      text: phase.text,
      confidence: phase.confidence,
      action: phase.action,
      success: phase.success,
      duration: phase.duration,
      timestamp: new Date().toISOString(),
    }, context))
  }

  onHookStart(event: HookEvent): void {
    this.emit(this.withRunContext({
      type: 'hook-start',
      hookId: event.hookId,
      hookName: event.hookName,
      phase: event.phase,
      hookExecutionId: event.hookExecutionId,
      stepId: event.stepId,
      timestamp: new Date().toISOString(),
    }, { runId: event.runId }))
  }

  onHookEnd(event: HookResultEvent): void {
    this.emit(this.withRunContext({
      type: 'hook-end',
      hookId: event.hookId,
      hookName: event.hookName,
      phase: event.phase,
      hookExecutionId: event.hookExecutionId,
      stepId: event.stepId,
      status: event.status,
      duration: event.duration,
      stdout: event.stdout,
      stderr: event.stderr,
      variables: event.variables,
      error: event.error,
      logType: event.type,
      timestamp: new Date().toISOString(),
    }, { runId: event.runId }))
  }

  onTestEnd(result: TestResult): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    const runId = result.runId ?? this.activeRunId
    this.emit(this.withRunContext({
      type: 'test-complete',
      testName: result.name,
      status: result.status,
      duration: result.duration,
    }, { runId }))
    this.activeRunId = undefined
    this.activeParentRunId = undefined
    this.activeSuiteIndex = undefined
    this.activeSuiteTotal = undefined
  }
}

function readSuiteTotal(context?: RunArtifactReporterContext): number | undefined {
  const runtime = context?.artifact?.runtime
  if (runtime && typeof runtime === 'object') {
    const total = (runtime as { suiteTotal?: unknown }).suiteTotal
    if (typeof total === 'number' && Number.isInteger(total) && total > 0) return total
  }

  const source = context?.artifact?.source
  if (source && typeof source === 'object') {
    const members = (source as { members?: unknown }).members
    if (Array.isArray(members) && members.length > 0) return members.length
  }

  return undefined
}
