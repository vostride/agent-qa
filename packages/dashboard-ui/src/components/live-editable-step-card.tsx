import { useRef, useEffect, useCallback } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  X,
  Play,
  CircleDashed,
  CheckCircle2,
  XCircle,
  Eye,
  Brain,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import type { LivePhase } from '@/hooks/use-execution-events'

export interface EditableStep {
  id: string
  instruction: string
  status: 'idle' | 'running' | 'passed' | 'failed' | 'cancelled'
  duration?: number
  error?: string
  phases: LivePhase[]
}

interface LiveEditableStepCardProps {
  step: EditableStep
  index: number
  onInstructionChange: (index: number, value: string) => void
  onRun: (index: number) => void
  onDelete: (index: number) => void
  isAnyStepRunning: boolean
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

function phaseIcon(phase: LivePhase['phase']) {
  switch (phase) {
    case 'observe': return { Icon: Eye, label: 'Observing', color: 'text-primary' }
    case 'plan': return { Icon: Brain, label: 'Planning', color: 'text-purple-400' }
    case 'execute': return { Icon: Play, label: 'Executing', color: 'text-emerald-400' }
    case 'verify': return { Icon: ShieldCheck, label: 'Verifying', color: 'text-amber-400' }
    case 'heal': return { Icon: RefreshCw, label: 'Healing', color: 'text-red-400' }
  }
}

export function LiveEditableStepCard({
  step,
  index,
  onInstructionChange,
  onRun,
  onDelete,
  isAnyStepRunning,
}: LiveEditableStepCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id, disabled: isAnyStepRunning })

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => { autoResize() }, [step.instruction, autoResize])

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

  const isRunning = step.status === 'running'
  const isComplete = step.status === 'passed' || step.status === 'failed' || step.status === 'cancelled'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative overflow-hidden rounded-[2px] border bg-card py-2 px-3',
        isRunning ? 'live-running-surface border-border/60 bg-primary/5' : 'border-border/70',
        isDragging && 'shadow-lg ring-2 ring-primary/20',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center text-muted-foreground/40 touch-none p-0.5 hover:text-muted-foreground mt-0.5',
            isAnyStepRunning ? 'cursor-default' : 'cursor-grab active:cursor-grabbing',
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>

        <span className="shrink-0 text-xs text-muted-foreground font-mono mt-0.5">
          #{index + 1}
        </span>

        <textarea
          ref={textareaRef}
          value={step.instruction}
          onChange={(e) => { onInstructionChange(index, e.target.value); autoResize() }}
          placeholder="Describe what this step should do..."
          disabled={isRunning}
          rows={1}
          className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/40 outline-none border-none p-0 min-w-0 resize-none overflow-hidden mt-0.5"
        />

        {step.status === 'idle' && (
          <button
            type="button"
            onClick={() => onRun(index)}
            disabled={isAnyStepRunning || !step.instruction.trim()}
            className={cn(
              'shrink-0 flex items-center justify-center size-7 rounded-sm transition-colors',
              isAnyStepRunning || !step.instruction.trim()
                ? 'text-muted-foreground/30 cursor-default'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
            aria-label={`Run step ${index + 1}`}
          >
            <Play className="size-3.5" />
          </button>
        )}

        {isRunning && (
          <CircleDashed className="size-4 shrink-0 mt-0.5 text-primary" />
        )}
        {step.status === 'passed' && (
          <CheckCircle2 className="size-4 text-emerald-500 shrink-0 mt-0.5" />
        )}
        {step.status === 'failed' && (
          <XCircle className="size-4 text-red-500 shrink-0 mt-0.5" />
        )}

        {isComplete && step.duration != null && (
          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">
            {formatDuration(step.duration)}
          </span>
        )}

        {/* Re-run button for completed steps */}
        {isComplete && (
          <button
            type="button"
            onClick={() => onRun(index)}
            disabled={isAnyStepRunning}
            className={cn(
              'shrink-0 flex items-center justify-center size-7 rounded-sm transition-colors',
              isAnyStepRunning
                ? 'text-muted-foreground/30 cursor-default'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
            aria-label={`Re-run step ${index + 1}`}
          >
            <Play className="size-3.5" />
          </button>
        )}

        {!isRunning && (
          <button
            type="button"
            onClick={() => onDelete(index)}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-0.5 rounded"
            aria-label={`Delete step ${index + 1}`}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {step.status === 'failed' && step.error && (
        <p className="text-destructive text-xs mt-1 ml-[3.25rem] line-clamp-2">
          {step.error}
        </p>
      )}

      {isRunning && step.phases && step.phases.length > 0 && (
        <div className="mt-2 ml-[3.25rem] space-y-1.5">
          {step.phases.map((p, i) => {
            const { Icon, label, color } = phaseIcon(p.phase)
            return (
              <motion.div
                key={`${p.phase}-${i}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: 0.05 }}
                className="flex items-center gap-2 text-xs min-w-0"
              >
                <Icon className={cn("h-3 w-3", color)} />
                <span className="text-muted-foreground">{label}</span>
                {p.text && (
                  <span className="text-muted-foreground/70 truncate max-w-[180px]">
                    — {p.text.slice(0, 80)}
                  </span>
                )}
                {p.phase === 'plan' && p.confidence != null && (
                  <span className={cn(
                    "text-[10px] font-mono px-1 rounded",
                    p.confidence > 0.8 ? "bg-emerald-500/10 text-emerald-500" :
                    p.confidence >= 0.5 ? "bg-amber-500/10 text-amber-500" :
                    "bg-red-500/10 text-red-500"
                  )}>
                    {Math.round(p.confidence * 100)}%
                  </span>
                )}
                {p.duration != null && (
                  <span className="text-muted-foreground/50 font-mono">
                    {p.duration < 1000 ? `${p.duration}ms` : `${(p.duration / 1000).toFixed(1)}s`}
                  </span>
                )}
              </motion.div>
            )
          })}
        </div>
      )}
    </div>
  )
}
