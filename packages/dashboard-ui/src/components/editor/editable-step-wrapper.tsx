import { useState, useRef, useEffect, useCallback } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X, Play, Loader2, Square, CheckCircle2, XCircle, Ban, ChevronRight } from 'lucide-react'
import { StepTreeItem } from '@/components/run-detail/step-tree-item'
import { SubActionTreeItem } from '@/components/run-detail/sub-action-tree-item'
import { cn, formatDuration } from '@/lib/utils'
import type { DisplayStep } from '@/lib/display-step'
import type { EditorStep } from '@/hooks/use-live-editor'
import type { Selection } from '@/lib/selection'

interface EditableStepWrapperProps {
  step: DisplayStep
  editorStep: EditorStep
  index: number
  isSelected: boolean
  isExpanded: boolean
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  onInstructionChange: (index: number, value: string) => void
  onRun: (index: number) => void
  onDelete: (index: number) => void
  onCancel: () => void
  runningStepId: string | null
}

function CompletedStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'passed':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
    case 'cancelled':
      return <Ban className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
    default:
      return <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
  }
}

export function EditableStepWrapper({
  step,
  editorStep,
  index,
  isSelected,
  isExpanded,
  selection,
  onSelect,
  onInstructionChange,
  onRun,
  onDelete,
  onCancel,
  runningStepId,
}: EditableStepWrapperProps) {
  const isThisStepRunning = editorStep.id === runningStepId
  const isThisStepCancelling = editorStep.status === 'cancelling'
  const isLocked = isThisStepRunning || isThisStepCancelling

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: editorStep.id, disabled: isLocked })

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [subActionsExpanded, setSubActionsExpanded] = useState(false)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => { autoResize() }, [editorStep.instruction, autoResize])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => autoResize())
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [autoResize])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  } as const

  const isRunning = editorStep.status === 'running'
  const isCancelling = editorStep.status === 'cancelling'
  const isComplete = editorStep.status === 'passed' || editorStep.status === 'failed' || editorStep.status === 'cancelled'
  const hasSubActions = step.subActionsData && step.subActionsData.length > 0

  return (
    <li role="none" ref={setNodeRef} style={style}>
      <div
        className={cn(
          'relative overflow-hidden rounded-[2px] border bg-card transition-[border-color] duration-300',
          isRunning ? 'live-running-surface border-border/60 bg-primary/5' : 'border-border/70',
          isCancelling && 'border-amber-500/30 bg-amber-500/5',
          isDragging && 'shadow-lg ring-2 ring-primary/20',
          isSelected && !isRunning && !isCancelling && 'bg-primary/10 ring-1 ring-primary/30',
        )}
      >
        {(isRunning || isCancelling) ? (
          <div className="flex items-start">
            <button
              type="button"
              className="flex shrink-0 items-center text-muted-foreground/40 touch-none p-0.5 mt-2 ml-1 cursor-default"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="size-4" />
            </button>
            <div className="flex-1 min-w-0">
              <StepTreeItem
                step={step}
                isSelected={isSelected}
                isExpanded={isExpanded}
                selection={selection}
                onSelect={onSelect}
                embedded
              />
            </div>
            <div className="flex items-center gap-1 shrink-0 mt-2 mr-1">
              {isRunning && (
                <button
                  type="button"
                  onClick={() => onCancel()}
                  className="shrink-0 flex items-center justify-center size-7 rounded-sm text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label="Cancel running step"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              )}
              {isCancelling && (
                <div className="flex items-center gap-1.5 shrink-0 mr-1">
                  <Loader2 className="size-3.5 text-muted-foreground animate-spin" />
                  <span className="text-xs text-muted-foreground">Cancelling...</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 py-2 px-3">
            <button
              type="button"
              className={cn(
                'flex shrink-0 items-center text-muted-foreground/40 touch-none p-0.5 hover:text-muted-foreground mt-0.5',
                'cursor-grab active:cursor-grabbing',
              )}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="size-4" />
            </button>

            {isComplete ? (
              <button
                type="button"
                onClick={() => onSelect(
                  selection?.type === 'step' && selection.stepId === step.id
                    ? null
                    : { type: 'step', stepId: step.id }
                )}
                className="flex items-center gap-2 flex-1 min-w-0 rounded-sm px-1 -mx-1 py-0.5 text-left hover:bg-muted/50 transition-colors"
              >
                <CompletedStatusIcon status={editorStep.status} />
                <span className="text-sm truncate flex-1">{editorStep.instruction}</span>
              </button>
            ) : (
              <>
                <span className="shrink-0 text-xs text-muted-foreground font-mono mt-0.5">#{index + 1}</span>
                <textarea
                  ref={textareaRef}
                  value={editorStep.instruction}
                  onChange={(e) => { onInstructionChange(index, e.target.value); autoResize() }}
                  placeholder="Describe what this step should do..."
                  rows={1}
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 outline-none border-none p-0 min-w-0 resize-none overflow-hidden mt-0.5"
                />
              </>
            )}

            {isComplete && editorStep.duration !== undefined && (
              <span className="shrink-0 text-xs text-muted-foreground mt-0.5">
                {formatDuration(editorStep.duration)}
              </span>
            )}

            <button
              type="button"
              onClick={() => onRun(index)}
              disabled={!editorStep.instruction.trim()}
              className={cn(
                'shrink-0 flex items-center justify-center size-7 rounded-sm transition-colors',
                !editorStep.instruction.trim()
                  ? 'text-muted-foreground/30 cursor-default'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              aria-label={isComplete ? `Re-run step ${index + 1}` : `Run step ${index + 1}`}
            >
              <Play className="size-3.5" />
            </button>

            <button
              type="button"
              onClick={() => onDelete(index)}
              className="shrink-0 text-muted-foreground hover:text-destructive transition-colors p-0.5 rounded"
              aria-label={`Delete step ${index + 1}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {isComplete && hasSubActions && (
          <>
            <button
              type="button"
              onClick={() => setSubActionsExpanded(!subActionsExpanded)}
              className="flex items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full border-t border-border/40"
            >
              <ChevronRight className={cn('size-3 transition-transform', subActionsExpanded && 'rotate-90')} />
              {step.subActionsData!.length} sub-action{step.subActionsData!.length !== 1 ? 's' : ''}
            </button>
            {subActionsExpanded && (
              <ul role="group" className="border-t border-border/40">
                {step.subActionsData!.map((sub, subIdx) => (
                  <SubActionTreeItem
                    key={subIdx}
                    sub={sub}
                    index={subIdx}
                    stepId={step.id}
                    isSelected={selection?.type === 'subaction' && 'subIndex' in selection && selection.subIndex === subIdx && selection.stepId === step.id}
                    onSelect={() => onSelect({ type: 'subaction', stepId: step.id, subIndex: subIdx })}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {editorStep.status === 'failed' && editorStep.error && (
          <p className="text-destructive text-xs py-1.5 px-3 border-t border-border/40 line-clamp-2">
            {editorStep.error}
          </p>
        )}
      </div>
    </li>
  )
}
