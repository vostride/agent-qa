import type {
  RunDetailStep,
  RunDetailSubAction,
  RunStepTokenUsage,
  StepEvidenceEntries,
  VerifierVerdict,
} from '@vostride/agent-qa-schema'

import type { AccessibilityViolation } from './api'
import type { RunDetailGroup } from './run-detail-view'
import { runDetailStepKey } from './selection'
import type { EditorStep, LiveSubAction } from '@/hooks/use-live-editor'
import { normalizeStepStatus } from '@/lib/status'

export interface LivePhase {
  phase: 'observe' | 'plan' | 'execute' | 'verify' | 'heal'
  subActionIndex?: number
  phaseOrdinal?: number
  text?: string
  confidence?: number
  action?: unknown
  success?: boolean
  duration?: number
  timestamp: string
}

// Live-only fields stay optional, never null-filled: a durable step has no such read at all.
export interface DisplayStep {
  /** `<testIndex>:<stepIndex>` for a durable step (see `runDetailStepKey`); the row id for a v1 one. */
  id: string
  name: string
  status: string
  duration: number
  error?: string | null
  stepOrder: number
  rawStepOrder: number
  displayStepOrder: number
  displayStepTotal: number | null

  // ---- the durable projection's own fields ----
  /** The member handle this step belongs to — present only on a durable step. */
  testIndex?: number
  /** The step's ordinal within its member — present only on a durable step. */
  stepIndex?: number
  /** The sub-actions recorded under this step, in the producer's order. */
  subActions?: readonly RunDetailSubAction[]
  cacheStatus?: RunDetailStep['cacheStatus']
  verifierVerdict?: VerifierVerdict
  selfHealOccurred?: boolean
  // Absent when the step reported no usage, never a zero.
  tokenUsage?: RunStepTokenUsage
  evidence?: StepEvidenceEntries

  // ---- live-editor fields; a durable step carries none of them ----
  liveSubActions?: LiveSubAction[] | null
  originalStepName?: string | null
  variableSnapshot?: Record<string, { value: string; source: string }> | null
  observation?: string | null
  reasoning?: string | null
  plannedAction?: unknown | null
  action?: unknown | null
  confidence?: number | null
  runId?: string | null
  consoleLogs?: Array<{
    level: string
    text: string
    location?: { url: string; lineNumber: number; columnNumber: number }
    timestamp: number
  }> | null
  networkLogs?: Array<{
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
  accessibilityViolations?: AccessibilityViolation[] | null
  rawRunId?: string | null
}

/** What a step with no recorded text is called, so the tree never renders a blank row. */
export const UNNAMED_STEP_LABEL = 'Untitled step'

// Status falls back to the verifier's `pass`, and `tokenUsage` passes through with no `?? 0`.
export function fromRunDetailStep(
  step: RunDetailStep,
  subActions: readonly RunDetailSubAction[],
): DisplayStep {
  return {
    id: runDetailStepKey(step.testIndex, step.stepIndex),
    name: step.stepText ?? UNNAMED_STEP_LABEL,
    status: step.status ?? (step.verifierVerdict.pass ? 'passed' : 'failed'),
    duration: step.durationMs ?? 0,
    error: step.error,
    stepOrder: step.stepIndex,
    rawStepOrder: step.stepIndex,
    displayStepOrder: step.stepIndex + 1,
    displayStepTotal: null,
    testIndex: step.testIndex,
    stepIndex: step.stepIndex,
    subActions,
    cacheStatus: step.cacheStatus,
    verifierVerdict: step.verifierVerdict,
    selfHealOccurred: step.selfHealOccurred,
    tokenUsage: step.tokenUsage,
    evidence: step.evidence,
  }
}

// One flattening feeds both the tree and the page, so ids and step counters cannot disagree.
export function displayStepsForGroups(groups: readonly RunDetailGroup[]): DisplayStep[] {
  return withDisplayStepProgress(
    groups.flatMap((group) =>
      group.steps.map((stepGroup) => fromRunDetailStep(stepGroup.step, stepGroup.subActions)),
    ),
  )
}

export function fromEditorStep(step: EditorStep, index: number): DisplayStep {
  const observe = step.phases.find(p => p.phase === 'observe')
  const plan = step.phases.find(p => p.phase === 'plan')
  const execute = step.phases.find(p => p.phase === 'execute')
  const fallbackSubAction = step.liveSubActions?.find((subAction) =>
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
    liveSubActions: step.liveSubActions ?? groupPhasesIntoSubActions(step.phases),
    originalStepName: step.originalStepName,
    variableSnapshot: step.variableSnapshot,
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
    accessibilityViolations: null,
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

export function groupPhasesIntoSubActions(phases: LivePhase[]): LiveSubAction[] | null {
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
