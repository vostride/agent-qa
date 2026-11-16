import { Ban, CircleCheck, CircleDashed, FileQuestionMark, MousePointerClick, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { EvidenceAbsenceReason, EvidenceDocument, EvidenceEntry, RecordingEntry, RunDetailStep, StepEvidenceEntries } from '@vostride/agent-qa-schema'
import type { RunEvidenceRead } from './api'
import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'

export type EvidenceState = 'empty' | 'not-captured' | 'unsupported' | 'unavailable' | 'failed' | 'no-selection'
export const EVIDENCE_STATES = [
  'empty', 'not-captured', 'unsupported', 'unavailable', 'failed', 'no-selection',
] as const satisfies readonly EvidenceState[]
export type EvidenceTone = 'positive' | 'neutral' | 'alert'
export const EVIDENCE_TONES = ['positive', 'neutral', 'alert'] as const satisfies readonly EvidenceTone[]
export type EvidenceFailure = 'capture' | 'load'
export const EVIDENCE_FAILURES = ['capture', 'load'] as const satisfies readonly EvidenceFailure[]
export type EvidenceKindLabel = 'variables' | 'network' | 'console' | 'aria' | 'a11y' | 'video' | 'frame'
export const EVIDENCE_KIND_LABELS = [
  'variables', 'network', 'console', 'aria', 'a11y', 'video', 'frame',
] as const satisfies readonly EvidenceKindLabel[]

export const EVIDENCE_STATE_OF_REASON = {
  empty: 'empty', 'not-captured': 'not-captured', unsupported: 'unsupported',
  unavailable: 'unavailable', failed: 'failed',
} as const satisfies Record<EvidenceAbsenceReason, EvidenceState>
export const EVIDENCE_TONE_OF_STATE = {
  empty: 'positive', 'not-captured': 'neutral', unsupported: 'neutral',
  unavailable: 'neutral', failed: 'alert', 'no-selection': 'neutral',
} as const satisfies Record<EvidenceState, EvidenceTone>
export const EVIDENCE_ICON_OF_STATE = {
  empty: CircleCheck, 'not-captured': CircleDashed, unsupported: Ban,
  unavailable: FileQuestionMark, failed: TriangleAlert, 'no-selection': MousePointerClick,
} satisfies Record<EvidenceState, LucideIcon>

export const EVIDENCE_LOADING_LABEL = () => t('evidence.loading')
export const EVIDENCE_INCOMPLETE_EXPLANATION = () => t('evidence.incompleteExplanation')
export const RECORDED_ELSEWHERE_LABEL = (step: number) => t('evidence.recordedOnStep', { step })

export function explanationWithStep(explanation: string, step: string): string {
  return t('evidence.explanationWithStep', { explanation, step })
}

export const GO_TO_STEP_LABEL = (step: number) => t('evidence.goToStep', { step })
export const EVIDENCE_RETRY_LABELS = textTable({
  variables: () => t('evidence.retry.variables'),
  network: () => t('evidence.retry.network'),
  console: () => t('evidence.retry.console'),
  aria: () => t('evidence.retry.aria'),
  a11y: () => t('evidence.retry.a11y'),
  video: () => t('evidence.retry.video'),
  frame: () => t('evidence.retry.frame'),
}) satisfies Record<EvidenceKindLabel, string>

type CopyPair = { title: string; explanation: string }
type KindCopy = Record<Exclude<EvidenceState, 'failed'>, CopyPair> & {
  failed: Record<EvidenceFailure, CopyPair>
  retry?: string
}

export const EVIDENCE_COPY = {
  variables: {
    empty: textTable({
      title: () => t('evidence.variables.empty.title'),
      explanation: () => t('evidence.variables.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.variables.notCaptured.title'),
      explanation: () => t('evidence.variables.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.variables.unsupported.title'),
      explanation: () => t('evidence.variables.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.variables.unavailable.title'),
      explanation: () => t('evidence.variables.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.variables.failed.capture.title'),
        explanation: () => t('evidence.variables.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.variables.failed.load.title'),
        explanation: () => t('evidence.variables.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.variables.noSelection.title'),
      explanation: () => t('evidence.variables.noSelection.explanation'),
    }),
  },
  network: {
    empty: textTable({
      title: () => t('evidence.network.empty.title'),
      explanation: () => t('evidence.network.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.network.notCaptured.title'),
      explanation: () => t('evidence.network.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.network.unsupported.title'),
      explanation: () => t('evidence.network.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.network.unavailable.title'),
      explanation: () => t('evidence.network.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.network.failed.capture.title'),
        explanation: () => t('evidence.network.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.network.failed.load.title'),
        explanation: () => t('evidence.network.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.network.noSelection.title'),
      explanation: () => t('evidence.network.noSelection.explanation'),
    }),
  },
  console: {
    empty: textTable({
      title: () => t('evidence.console.empty.title'),
      explanation: () => t('evidence.console.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.console.notCaptured.title'),
      explanation: () => t('evidence.console.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.console.unsupported.title'),
      explanation: () => t('evidence.console.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.console.unavailable.title'),
      explanation: () => t('evidence.console.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.console.failed.capture.title'),
        explanation: () => t('evidence.console.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.console.failed.load.title'),
        explanation: () => t('evidence.console.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.console.noSelection.title'),
      explanation: () => t('evidence.console.noSelection.explanation'),
    }),
  },
  aria: {
    empty: textTable({
      title: () => t('evidence.aria.empty.title'),
      explanation: () => t('evidence.aria.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.aria.notCaptured.title'),
      explanation: () => t('evidence.aria.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.aria.unsupported.title'),
      explanation: () => t('evidence.aria.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.aria.unavailable.title'),
      explanation: () => t('evidence.aria.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.aria.failed.capture.title'),
        explanation: () => t('evidence.aria.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.aria.failed.load.title'),
        explanation: () => t('evidence.aria.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.aria.noSelection.title'),
      explanation: () => t('evidence.aria.noSelection.explanation'),
    }),
  },
  a11y: {
    empty: textTable({
      title: () => t('evidence.a11y.empty.title'),
      explanation: () => t('evidence.a11y.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.a11y.notCaptured.title'),
      explanation: () => t('evidence.a11y.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.a11y.unsupported.title'),
      explanation: () => t('evidence.a11y.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.a11y.unavailable.title'),
      explanation: () => t('evidence.a11y.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.a11y.failed.capture.title'),
        explanation: () => t('evidence.a11y.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.a11y.failed.load.title'),
        explanation: () => t('evidence.a11y.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.a11y.noSelection.title'),
      explanation: () => t('evidence.a11y.noSelection.explanation'),
    }),
    get retry() {
      return EVIDENCE_RETRY_LABELS.a11y
    },
  },
  video: {
    empty: textTable({
      title: () => t('evidence.video.empty.title'),
      explanation: () => t('evidence.video.empty.explanation'),
    }),
    'not-captured': textTable({
      title: () => t('evidence.video.notCaptured.title'),
      explanation: () => t('evidence.video.notCaptured.explanation'),
    }),
    unsupported: textTable({
      title: () => t('evidence.video.unsupported.title'),
      explanation: () => t('evidence.video.unsupported.explanation'),
    }),
    unavailable: textTable({
      title: () => t('evidence.video.unavailable.title'),
      explanation: () => t('evidence.video.unavailable.explanation'),
    }),
    failed: {
      capture: textTable({
        title: () => t('evidence.video.failed.capture.title'),
        explanation: () => t('evidence.video.failed.capture.explanation'),
      }),
      load: textTable({
        title: () => t('evidence.video.failed.load.title'),
        explanation: () => t('evidence.video.failed.load.explanation'),
      }),
    },
    'no-selection': textTable({
      title: () => t('evidence.video.noSelection.title'),
      explanation: () => t('evidence.video.noSelection.explanation'),
    }),
  },
  frame: {
    'not-captured': {
      'sub-action': textTable({
        title: () => t('evidence.frame.notCaptured.subAction.title'),
        explanation: () => t('evidence.frame.notCaptured.subAction.explanation'),
      }),
      step: textTable({
        title: () => t('evidence.frame.notCaptured.step.title'),
        explanation: () => t('evidence.frame.notCaptured.step.explanation'),
      }),
    },
    unavailable: textTable({
      title: () => t('evidence.frame.unavailable.title'),
      explanation: () => EVIDENCE_INCOMPLETE_EXPLANATION(),
    }),
    failed: {
      load: textTable({
        title: () => t('evidence.frame.failed.load.title'),
        explanation: () => t('evidence.frame.failed.load.explanation'),
      }),
    },
  },
} satisfies Record<Exclude<EvidenceKindLabel, 'frame'>, KindCopy> & {
  frame: {
    'not-captured': { 'sub-action': CopyPair; step: CopyPair }
    unavailable: CopyPair
    failed: { load: CopyPair }
  }
}

export type EvidenceView =
  | { kind: 'records'; document: EvidenceDocument }
  | { kind: 'loading' }
  | ({
      kind: 'state'
      state: EvidenceState
      failure?: EvidenceFailure
      incomplete?: boolean
      action?:
        | { type: 'retry'; label: string }
        | { type: 'step'; label: string; description: string; stepIndex: number }
    } & CopyPair)

type EvidenceStep = Pick<RunDetailStep, 'stepIndex' | 'evidence'>

export function recordedElsewhere<T extends EvidenceStep>(
  steps: readonly T[],
  currentStepIndex: number,
  kind: keyof StepEvidenceEntries,
): T | undefined {
  let nearest: T | undefined
  for (const step of steps) {
    if (step.stepIndex === currentStepIndex || step.evidence?.[kind].state !== 'present') continue
    const distance = Math.abs(step.stepIndex - currentStepIndex)
    const nearestDistance = nearest ? Math.abs(nearest.stepIndex - currentStepIndex) : Infinity
    if (distance < nearestDistance || (distance === nearestDistance && step.stepIndex > nearest!.stepIndex)) {
      nearest = step
    }
  }
  return nearest
}

export function resolveEvidenceView({ kind, selection, entry, read, elsewhere }: {
  kind: Exclude<EvidenceKindLabel, 'frame'>
  selection: 'none' | 'hook' | 'execution-log' | 'step' | 'sub-action'
  entry: EvidenceEntry | RecordingEntry | undefined
  read: 'idle' | 'loading' | RunEvidenceRead
  elsewhere?: { steps: readonly EvidenceStep[]; currentStepIndex: number }
}): EvidenceView {
  const stateView = (state: EvidenceState, failure?: EvidenceFailure, incomplete?: boolean): EvidenceView => {
    const copy = state === 'failed' ? EVIDENCE_COPY[kind].failed[failure ?? 'capture'] : EVIDENCE_COPY[kind][state]
    const result: Extract<EvidenceView, { kind: 'state' }> = {
      kind: 'state', state, ...copy,
      ...(failure ? { failure } : {}),
      ...(incomplete ? { incomplete: true, explanation: EVIDENCE_INCOMPLETE_EXPLANATION() } : {}),
    }
    if (state === 'failed' && failure === 'load') {
      result.action = { type: 'retry', label: EVIDENCE_RETRY_LABELS[kind] }
    } else if (state === 'not-captured' && elsewhere && kind !== 'aria' && kind !== 'video') {
      const step = recordedElsewhere(elsewhere.steps, elsewhere.currentStepIndex, kind)
      if (step) result.action = {
        type: 'step', stepIndex: step.stepIndex,
        label: GO_TO_STEP_LABEL(step.stepIndex + 1),
        description: RECORDED_ELSEWHERE_LABEL(step.stepIndex + 1),
      }
    }
    return result
  }
  const absentView = (absent: { reason: EvidenceAbsenceReason; evidenceIncomplete?: boolean }) => {
    if (absent.evidenceIncomplete) return stateView('unavailable', undefined, true)
    const state = EVIDENCE_STATE_OF_REASON[absent.reason]
    return stateView(state, state === 'failed' ? 'capture' : undefined)
  }
  if (selection === 'none' || selection === 'hook' || selection === 'execution-log'
    || (kind === 'aria' && selection !== 'sub-action')) return stateView('no-selection')
  if (!entry) return stateView('unavailable')
  if (entry.state === 'absent') return absentView(entry)
  if ('ref' in entry && entry.ref.evidenceIncomplete) return stateView('unavailable', undefined, true)
  if (read === 'idle' || read === 'loading') return { kind: 'loading' }
  if (read.kind === 'failed' || read.result.outcome === 'read-error') return stateView('failed', 'load')
  if (read.result.outcome === 'absent') return absentView(read.result.evidence)
  const document = read.result.document
  if (document.kind !== kind) return stateView('failed', 'load')
  const empty = document.kind === 'aria' ? document.tree.length === 0
    : document.kind === 'variables' ? Object.keys(document.records).length === 0
      : document.records.length === 0
  return empty ? stateView('empty') : { kind: 'records', document }
}
