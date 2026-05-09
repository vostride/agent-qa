import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  X,
  CircleDashed,
  CheckCircle2,
  XCircle,
  Play,
  Square,
  Webhook,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { LiveHookExecution, TestStepDetail } from '@/hooks/use-live-editor'
import { fromEditorStep } from '@/lib/display-step'
import type { SubActionData } from '@/lib/api'
import type { Selection } from '@/lib/selection'

interface SuiteTestRowProps {
  id: string
  name: string
  path: string
  testId: string
  isMissing: boolean
  onRemove: () => void
  disabled?: boolean
  actionsLocked?: boolean
  sortableDisabled?: boolean

  // Live mode additions (all optional — back-compat-safe)
  liveMode?: boolean
  liveStatus?: 'idle' | 'running' | 'cancelling' | 'passed' | 'failed' | 'cancelled'
  liveDuration?: number
  liveError?: string | null
  liveSteps?: TestStepDetail[]
  runningStepIndex?: number | null
  perTestSetupHooks?: LiveHookExecution[]
  perTestTeardownHooks?: LiveHookExecution[]
  canRunTest?: boolean
  onRunTest?: () => void
  onCancelTest?: () => void
  testIndex?: number
  selection?: Selection | null
  onSelect?: (selection: Selection | null) => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

function HookStatusIcon({ status }: { status: LiveHookExecution['status'] }) {
  switch (status) {
    case 'running': return <CircleDashed className="size-3 text-primary" />
    case 'passed':  return <CheckCircle2 className="size-3 text-emerald-500" />
    case 'failed':  return <AlertTriangle className="size-3 text-destructive" />
    default:        return <Webhook className="size-3 text-muted-foreground" />
  }
}

function StepStatusIcon({ status }: { status: TestStepDetail['status'] }) {
  switch (status) {
    case 'running':
    case 'cancelling':
      return <CircleDashed className="size-3 text-primary" />
    case 'passed':
      return <CheckCircle2 className="size-3 text-emerald-500" />
    case 'failed':
      return <XCircle className="size-3 text-red-500" />
    case 'cancelled':
      return <Square className="size-3 text-amber-500" />
    default:
      return <CircleDashed className="size-3 text-muted-foreground/50" />
  }
}

function formatSubActionSummary(subAction: SubActionData): string {
  if (subAction.observation) return subAction.observation
  if (subAction.reasoning) return subAction.reasoning
  if (subAction.plannedAction != null) return 'Planned action captured'
  if (subAction.verifierReasoning) return subAction.verifierReasoning
  return subAction.result
}

export function SuiteTestRow({
  id,
  name,
  path,
  testId,
  isMissing,
  onRemove,
  disabled = false,
  actionsLocked = false,
  sortableDisabled = false,
  liveMode = false,
  liveStatus = 'idle',
  liveDuration,
  liveError = null,
  liveSteps = [],
  runningStepIndex = null,
  perTestSetupHooks = [],
  perTestTeardownHooks = [],
  canRunTest = true,
  onRunTest,
  onCancelTest,
  testIndex,
  selection = null,
  onSelect,
}: SuiteTestRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || sortableDisabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 10 : undefined,
  } as const

  const isRunning = liveMode && liveStatus === 'running'
  const isPassed = liveMode && liveStatus === 'passed'
  const isFailed = liveMode && liveStatus === 'failed'
  const isCancelled = liveMode && liveStatus === 'cancelled'
  const showDuration = liveMode
    && (isPassed || isFailed || isCancelled)
    && liveDuration != null

  const isRowSelected = liveMode
    && selection?.type === 'test'
    && testIndex !== undefined
    && selection.testIndex === testIndex

  const hasNestedHooks = liveMode
    && (perTestSetupHooks.length + perTestTeardownHooks.length > 0)
  const liveStepRows = liveMode
    ? liveSteps.map((step) => ({ step, displayStep: fromEditorStep(step, step.stepIndex) }))
    : []
  const selectedStepId = selection && 'stepId' in selection ? selection.stepId : null
  const selectedSubActionIndex = selection?.type === 'subaction' ? selection.subIndex : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative overflow-hidden flex flex-col gap-0.5 rounded-md border bg-card/60 px-3 py-2 hover:bg-card transition-colors',
        isMissing && 'border-amber-500/30',
        isMissing && 'bg-amber-500/[0.06]',
        !isMissing && 'border-border/70',
        isDragging && 'shadow-lg ring-2 ring-primary/20',
        disabled && 'opacity-60',
        isRunning && 'live-running-surface border-border/60 bg-primary/5',
        isFailed && !isRunning && 'border-destructive/30',
        isFailed && !isRunning && !isRowSelected && 'ring-1 ring-destructive/20',
        isRowSelected && !isRunning && 'bg-primary/10 ring-1 ring-primary/30',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-0.5 flex shrink-0 items-center p-0.5 text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none disabled:cursor-not-allowed"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${name}`}
          aria-disabled={disabled || sortableDisabled}
          disabled={disabled || sortableDisabled}
        >
          <GripVertical className="size-3.5" />
        </button>

        {isRunning && (
          <CircleDashed className="size-4 shrink-0 mt-0.5 text-primary" />
        )}
        {isPassed && (
          <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0 mt-1" />
        )}
        {isFailed && (
          <XCircle className="size-3.5 text-red-500 shrink-0 mt-1" />
        )}

        <div
          className={cn('flex-1 min-w-0 space-y-0.5', liveMode && onSelect && 'cursor-pointer')}
          onClick={
            liveMode && onSelect && testIndex !== undefined
              ? () => onSelect({ type: 'test', testIndex })
              : undefined
          }
        >
          <div className="text-sm font-medium text-foreground truncate">{name}</div>
          <div className="text-[11px] font-mono text-muted-foreground truncate">{path}</div>
          <div className="text-[10px] font-mono text-muted-foreground/70 truncate">{testId}</div>
          {liveStepRows.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {liveStepRows.map(({ step, displayStep }, stepRowIndex) => {
                const isRunningStep = step.status === 'running' || runningStepIndex === step.stepIndex
                const isImplicitSelectedStep = isRowSelected
                  && selectedStepId === null
                  && (isRunningStep || (runningStepIndex === null && stepRowIndex === liveStepRows.length - 1))
                const isStepSelected = selectedStepId === step.id || isImplicitSelectedStep
                const subActions = displayStep.subActionsData ?? []
                return (
                  <div
                    key={step.id}
                    className={cn(
                      'relative overflow-hidden rounded-sm border bg-background/60',
                      isRunningStep
                        ? 'live-running-surface border-border/60 bg-primary/5'
                        : isStepSelected
                          ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/30'
                          : 'border-border/60',
                    )}
                  >
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelect?.({ type: 'step', stepId: step.id })
                      }}
                      aria-label={`Select step ${step.stepIndex + 1} ${step.instruction}`}
                    >
                      <StepStatusIcon status={step.status} />
                      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Step {step.stepIndex + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {step.instruction}
                      </span>
                    </button>

                    {(isRunningStep || isStepSelected) && (
                      <div className="flex flex-wrap gap-x-2 gap-y-0.5 px-2 pb-1 text-[11px] text-muted-foreground">
                        {isRunningStep && <span>Current step</span>}
                        {isStepSelected && <span>Inspecting below</span>}
                      </div>
                    )}

                    {subActions.length > 0 && (
                      <div className="space-y-1 border-t border-border/50 px-2 py-1.5">
                        {subActions.map((subAction) => {
                          const isSubActionSelected = isStepSelected && selectedSubActionIndex === subAction.index
                          return (
                            <button
                              key={`${step.id}-sub-${subAction.index}`}
                              type="button"
                              className={cn(
                                'flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-[11px] transition-colors',
                                isSubActionSelected ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/40',
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                onSelect?.({ type: 'subaction', stepId: step.id, subIndex: subAction.index })
                              }}
                              aria-label={`Select sub-action ${subAction.index + 1} for step ${step.stepIndex + 1}`}
                            >
                              <span className="shrink-0 font-medium">Sub {subAction.index + 1}</span>
                              <span className="min-w-0 flex-1 truncate">{formatSubActionSummary(subAction)}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {isMissing && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300">
              This test file no longer exists in your workspace.
            </div>
          )}
        </div>

        <div className="mt-0.5 flex shrink-0 self-start items-center gap-1">
          {showDuration && (
            <span className="text-xs leading-none text-muted-foreground whitespace-nowrap shrink-0">
              {formatDuration(liveDuration as number)}
            </span>
          )}

          {liveMode && !isRunning && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onRunTest}
              disabled={!canRunTest || !onRunTest || actionsLocked}
              className={cn(
                'text-muted-foreground hover:text-foreground',
                (!canRunTest || !onRunTest || actionsLocked) && 'text-muted-foreground/30',
              )}
              aria-label={liveStatus === 'idle' ? `Run test ${name}` : `Re-run test ${name}`}
            >
              <Play className="size-3.5" />
            </Button>
          )}

          {liveMode && isRunning && onCancelTest && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCancelTest}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Cancel test ${name}`}
            >
              <Square className="size-3" />
            </Button>
          )}

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            disabled={disabled || actionsLocked}
            aria-label={`Remove ${name}`}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {isFailed && liveError && (
        <p className="text-destructive text-xs mt-1 ml-7 line-clamp-2">
          {liveError} — see Reasoning tab for details
        </p>
      )}

      {hasNestedHooks && (
        <ul className="mt-1.5 space-y-1 pl-5">
          {perTestSetupHooks.map((hook) => {
            const isSelected = selection?.type === 'test-hook' && selection.hookId === hook.id
            return (
              <li key={`setup-${hook.id}`}>
                <button
                  type="button"
                  onClick={() => testIndex !== undefined && onSelect?.({ type: 'test-hook', testIndex, phase: 'setup', hookId: hook.id })}
                  className={cn(
                    'relative flex w-full items-center gap-2 overflow-hidden rounded-sm border px-1.5 py-0.5 text-left transition-colors',
                    hook.status === 'running'
                      ? 'live-running-surface border-border/60 bg-primary/5'
                      : isSelected
                        ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/30'
                        : 'border-transparent bg-transparent hover:bg-muted/40',
                  )}
                >
                  <Webhook className="size-3 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    setup: {hook.name}
                  </span>
                  <HookStatusIcon status={hook.status} />
                </button>
              </li>
            )
          })}
          {perTestTeardownHooks.map((hook) => {
            const isSelected = selection?.type === 'test-hook' && selection.hookId === hook.id
            return (
              <li key={`teardown-${hook.id}`}>
                <button
                  type="button"
                  onClick={() => testIndex !== undefined && onSelect?.({ type: 'test-hook', testIndex, phase: 'teardown', hookId: hook.id })}
                  className={cn(
                    'relative flex w-full items-center gap-2 overflow-hidden rounded-sm border px-1.5 py-0.5 text-left transition-colors',
                    hook.status === 'running'
                      ? 'live-running-surface border-border/60 bg-primary/5'
                      : isSelected
                        ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/30'
                        : 'border-transparent bg-transparent hover:bg-muted/40',
                  )}
                >
                  <Webhook className="size-3 text-muted-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    teardown: {hook.name}
                  </span>
                  <HookStatusIcon status={hook.status} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
