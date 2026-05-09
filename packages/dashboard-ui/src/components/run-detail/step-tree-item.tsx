import { CheckCircle2, XCircle, RefreshCw, Circle } from "lucide-react"
import { SubActionTreeItem } from "./sub-action-tree-item"
import { ExecutionTreeItem } from "./execution-tree-item"
import { StepNameWithPills } from "./step-name-pills"
import { CacheStatusIconWrapper } from "./cache-status-marker"
import type { ExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import type { Selection } from "@/lib/selection"
import { cn, formatDuration } from "@/lib/utils"

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
    case "healed":
    case "flaky":
      return <RefreshCw className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
  }
}

interface StepTreeItemProps {
  step: DisplayStep
  isSelected: boolean
  isExpanded: boolean
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  inlineLogs?: ExecutionLogEntry[]
  embedded?: boolean
}

export function StepTreeItem({ step, isSelected, isExpanded, selection, onSelect, inlineLogs = [], embedded = false }: StepTreeItemProps) {
  const subActions = step.subActionsData ?? []
  const hasSubActions = subActions.length > 0
  const cachedCount = subActions.filter(s => s.cached).length
  const cacheStatus = subActions.length === 0 ? 'none'
    : cachedCount === subActions.length ? 'all'
    : cachedCount > 0 ? 'some'
    : 'none'

  const hasChildren = hasSubActions || inlineLogs.length > 0
  const stepStatusIcon = <StepStatusIcon status={step.status} />
  const statusIconWithCacheMarker = cacheStatus === 'all' ? (
    <CacheStatusIconWrapper
      marker="step-status"
      state="all"
      tone="primary"
      label="All actions cached"
    >
      {stepStatusIcon}
    </CacheStatusIconWrapper>
  ) : cacheStatus === 'some' ? (
    <CacheStatusIconWrapper
      marker="step-status"
      state="some"
      tone="amber"
      label={`${cachedCount} of ${subActions.length} actions cached`}
    >
      {stepStatusIcon}
    </CacheStatusIconWrapper>
  ) : stepStatusIcon

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected && selection?.type === 'step'}
      aria-level={1}
      data-step-id={step.id}
      className={cn(
        !embedded && "mx-2 mb-1.5 rounded-[2px]",
        hasChildren && isExpanded && !embedded && "border border-border/70 bg-muted/15 relative before:absolute before:left-[19.5px] before:w-px before:bg-border/60 before:top-[19px] before:bottom-[13px]",
        hasChildren && isExpanded && embedded && "relative before:absolute before:left-[19.5px] before:w-px before:bg-border/60 before:top-[19px] before:bottom-[13px]"
      )}
    >
      <button
        className={cn(
          "flex w-full items-start gap-2 py-2 px-3 text-left rounded-[2px]",
          "hover:bg-muted/50 transition-colors",
          isSelected && selection?.type === 'step' && "bg-primary/10 ring-1 ring-primary/30"
        )}
        onClick={() => onSelect({ type: 'step', stepId: step.id })}
      >
        {statusIconWithCacheMarker}
        <div className="min-w-0 flex-1">
          {step.displayStepTotal ? (
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Step {step.displayStepOrder} of {step.displayStepTotal}
            </div>
          ) : null}
          <StepNameWithPills step={step} />
        </div>
        <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
          {formatDuration(step.duration)}
        </span>
      </button>

      {isExpanded && hasChildren && (
        <ul role="group">
          {inlineLogs.map(log => (
            <ExecutionTreeItem
              key={log.id}
              log={log}
              isSelected={
                selection?.type === 'execution' &&
                selection.logId === log.id
              }
              onSelect={() => onSelect({ type: 'execution', stepId: step.id, logId: log.id })}
            />
          ))}
          {subActions.map((sub, i) => (
            <SubActionTreeItem
              key={i}
              sub={sub}
              index={i}
              stepId={step.id}
              isSelected={
                selection?.type === 'subaction' &&
                selection.stepId === step.id &&
                selection.subIndex === i
              }
              onSelect={() => onSelect({ type: 'subaction', stepId: step.id, subIndex: i })}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
