import type { StepRow, SubActionData, StepAnnotation } from './api'
import type { LivePhase } from '@/hooks/use-execution-events'
import type { EditorStep } from '@/hooks/use-live-editor'
import { normalizeStepStatus } from '@/lib/status'

export interface DisplayStep {
  id: string
  name: string
  status: string
  duration: number
  subActionsData: SubActionData[] | null
  originalStepName: string | null
  variableSnapshot: Record<string, { value: string; source: string }> | null
  screenshotPath: string | null
  screenshotBeforePath: string | null
  annotationData: StepAnnotation | null
  observation: string | null
  reasoning: string | null
  plannedAction: unknown | null
  action: unknown | null
  error: string | null
  confidence: number | null
  runId: string | null
  stepOrder: number
  consoleLogs: Array<{
    level: string
    text: string
    location?: { url: string; lineNumber: number; columnNumber: number }
    timestamp: number
  }> | null
  networkLogs: Array<{
    url: string
    method: string
    status: number
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    body?: string
    requestBody?: string
    startTime: number
    endTime: number
    timing?: Record<string, number>
  }> | null
  healingAttempts: unknown[] | null
  accessibilityViolations?: StepRow['accessibilityViolations']
  screenContextBefore: string | null
  screenContextAfter: string | null
  rawRunId: string | null
  rawStepOrder: number
  displayStepOrder: number
  displayStepTotal: number | null
}

export function fromStepRow(step: StepRow): DisplayStep {
  return {
    id: step.id,
    name: step.name,
    status: step.status,
    duration: step.duration,
    subActionsData: step.subActionsData,
    originalStepName: step.originalStepName,
    variableSnapshot: step.variableSnapshot,
    screenshotPath: step.screenshotPath,
    screenshotBeforePath: step.screenshotBeforePath,
    annotationData: step.annotationData,
    observation: step.observation,
    reasoning: step.reasoning,
    plannedAction: step.plannedAction,
    action: step.action,
    error: step.error,
    confidence: step.confidence,
    runId: step.runId,
    stepOrder: step.stepOrder,
    consoleLogs: step.consoleLogs,
    networkLogs: step.networkLogs,
    healingAttempts: step.healingAttempts,
    accessibilityViolations: step.accessibilityViolations,
    screenContextBefore: step.screenContextBefore,
    screenContextAfter: step.screenContextAfter,
    rawRunId: step.runId,
    rawStepOrder: step.stepOrder,
    displayStepOrder: step.stepOrder + 1,
    displayStepTotal: null,
  }
}

export function fromEditorStep(step: EditorStep, index: number): DisplayStep {
  const observe = step.phases.find(p => p.phase === 'observe')
  const plan = step.phases.find(p => p.phase === 'plan')
  const execute = step.phases.find(p => p.phase === 'execute')
  const fallbackSubAction = step.subActionsData?.find((subAction) =>
    Boolean(
      subAction.observation
      || subAction.reasoning
      || subAction.plannedAction != null,
    ),
  )

  return {
    id: step.id,
    name: step.instruction,
    status: normalizeStepStatus(step.status),
    duration: step.duration ?? 0,
    subActionsData: step.subActionsData ?? groupPhasesIntoSubActions(step.phases),
    originalStepName: step.originalStepName,
    variableSnapshot: step.variableSnapshot,
    screenshotPath: null,
    screenshotBeforePath: null,
    annotationData: null,
    observation: observe?.text ?? fallbackSubAction?.observation ?? null,
    reasoning: plan?.text ?? fallbackSubAction?.reasoning ?? null,
    plannedAction: execute?.action ?? fallbackSubAction?.plannedAction ?? null,
    action: execute?.action ?? fallbackSubAction?.plannedAction ?? null,
    error: step.error ?? null,
    confidence: plan?.confidence ?? fallbackSubAction?.confidence ?? null,
    runId: null,
    stepOrder: index,
    consoleLogs: step.consoleLogs,
    networkLogs: step.networkLogs,
    healingAttempts: null,
    accessibilityViolations: null,
    screenContextBefore: null,
    screenContextAfter: null,
    rawRunId: null,
    rawStepOrder: index,
    displayStepOrder: index + 1,
    displayStepTotal: null,
  }
}

export function withDisplayStepProgress<T extends DisplayStep>(steps: T[]): T[] {
  const total = steps.length
  return steps.map((step, index) => ({
    ...step,
    displayStepOrder: index + 1,
    displayStepTotal: total,
  }))
}

export function groupPhasesIntoSubActions(phases: LivePhase[]): SubActionData[] | null {
  if (phases.length === 0) return null

  const groups: LivePhase[][] = []
  let current: LivePhase[] = []

  for (const phase of phases) {
    if ((phase.phase === 'observe' || phase.phase === 'heal') && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(phase)
  }
  if (current.length > 0) groups.push(current)

  return groups.map((group, index) => {
    const observe = group.find(p => p.phase === 'observe')
    const plan = group.find(p => p.phase === 'plan')
    const execute = group.find(p => p.phase === 'execute')
    const verify = group.find(p => p.phase === 'verify')

    return {
      index,
      observation: observe?.text ?? '',
      reasoning: plan?.text ?? '',
      plannedAction: execute?.action ?? null,
      result: verify
        ? (verify.success ? 'success' : 'failure')
        : (index === groups.length - 1 ? 'in-progress' : 'failure'),
      error: undefined,
      screenStateBefore: '',
      cached: false,
      confidence: plan?.confidence,
      verifierReasoning: verify?.text,
      phaseDurations: {
        observe: observe?.duration,
        plan: plan?.duration,
        execute: execute?.duration,
        verify: verify?.duration,
      },
    }
  })
}
