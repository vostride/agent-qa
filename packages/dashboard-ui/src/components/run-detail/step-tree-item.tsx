import type { RunDetailMemberMark } from '@vostride/agent-qa-schema'
import { CheckCircle2, XCircle, RefreshCw, Circle } from "lucide-react"
import { SubActionTreeItem } from "./sub-action-tree-item"
import { ExecutionTreeItem } from "./execution-tree-item"
import { StepNameWithPills } from "./step-name-pills"
import { CacheStatusIconWrapper } from "./cache-status-marker"
import { FeedbackEntryButton, MarkGlyph } from "./feedback-entry"
import { feedbackAddress, feedbackEntryLabel, stepTriggerTooltip } from "@/lib/feedback-view"
import type { ExecutionLogEntry } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import type { Selection } from "@/lib/selection"
import type { Playhead } from '@/lib/playhead'
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
  marks?: readonly RunDetailMemberMark[]
  step: DisplayStep
  isSelected: boolean
  isExpanded: boolean
  selection: Selection | null
  playhead?: Playhead | null
  onSelect: (sel: Selection | null) => void
  inlineLogs?: ExecutionLogEntry[]
  embedded?: boolean
  onOpenFeedback?: (opener: HTMLElement) => void
  feedbackExpanded?: boolean
  composerId?: string
}

export function StepTreeItem({ step, isSelected, isExpanded, selection, playhead, onSelect, inlineLogs = [], embedded = false, marks, onOpenFeedback, feedbackExpanded = false, composerId = '' }: StepTreeItemProps) {
  const mark = marks?.find(entry => entry.stepIndex === step.stepIndex)
  const address = step.testIndex === undefined || step.stepIndex === undefined
    ? undefined
    : feedbackAddress({ testIndex: step.testIndex, stepIndex: step.stepIndex })
  // the door sits on the row that owns the selection only; a marked row elsewhere keeps a
  // passive trace instead, so one row never shows two bubbles.
  const showTrigger = isSelected && onOpenFeedback !== undefined && marks !== undefined && address !== undefined
  const stepNumber = (step.stepIndex ?? 0) + 1
  // THE DURABLE SUB-ACTIONS, NOT THE v1 BLOB (405-08/405-11). The v1 sub-action array this row
  // used to read had no producer on this page, and 405-11 deleted it with the overview's readers.
  const subActions = step.subActions ?? []
  const hasSubActions = subActions.length > 0

  // The step owns the cache answer. `hit` means every action in the step came from the cache;
  // `miss`, `bypass` and `disabled` mean it was not. Nothing per sub-action is recorded, so there
  // is no partial state to render.
  const servedFromCache = step.cacheStatus === 'hit'

  const hasChildren = hasSubActions || inlineLogs.length > 0
  // A self-heal is a fact about the step the verdict alone does not carry, so it wins the glyph:
  // a step that passed only after healing is not the same story as one that just passed.
  const stepStatusIcon = <StepStatusIcon status={step.selfHealOccurred ? 'healed' : step.status} />
  const statusIconWithCacheMarker = servedFromCache ? (
    <CacheStatusIconWrapper
      marker="step-status"
      state="all"
      tone="primary"
      label="All actions cached"
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
        "relative",
        showTrigger && "@container/row",
        !embedded && "mx-2 mb-1.5 rounded-[2px]",
        hasChildren && isExpanded && !embedded && "border border-border/70 bg-muted/15"
      )}
    >
      <button
        className={cn(
          "flex w-full items-start gap-2 py-2 px-3 text-left rounded-[2px]",
          "hover:bg-muted/50 transition-colors",
          isSelected && "rounded-md ring-1 ring-inset ring-border",
          isSelected && selection?.type === 'step' && "bg-muted/30",
          // Below 14rem the name column would collapse beside the door, so the duration takes its
          // own line under the name instead.
          showTrigger && "pr-9 @max-[14rem]/row:flex-wrap"
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
        {mark !== undefined && address !== undefined && !showTrigger ? (
          <MarkGlyph scope="step" target={address} kind={mark.kind} />
        ) : null}
        <span className={cn("text-xs text-muted-foreground shrink-0 pt-0.5", showTrigger && "@max-[14rem]/row:basis-full @max-[14rem]/row:pl-6")}>
          {formatDuration(step.duration)}
        </span>
      </button>
      {showTrigger ? (
        <span className="absolute right-1 top-1">
          <FeedbackEntryButton
            scope="step"
            label={feedbackEntryLabel({ scope: 'step', stepNumber, markedChoice: mark?.kind })}
            tooltip={stepTriggerTooltip(stepNumber, mark !== undefined)}
            target={address}
            marked={mark !== undefined}
            expanded={feedbackExpanded}
            controls={composerId}
            onOpen={onOpenFeedback}
          />
        </span>
      ) : null}

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
          {subActions.map((sub) => (
            <SubActionTreeItem
              key={sub.subActionIndex}
              sub={sub}
              stepId={step.id}
              cached={servedFromCache}
              isPlayheadRow={playhead?.testIndex === sub.testIndex && playhead.stepIndex === sub.stepIndex && playhead.subActionIndex === sub.subActionIndex}
              isSelected={
                selection?.type === 'subaction' &&
                selection.stepId === step.id &&
                selection.subIndex === sub.subActionIndex
              }
              onSelect={() => onSelect({ type: 'subaction', stepId: step.id, subIndex: sub.subActionIndex })}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
