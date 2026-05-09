import { useState } from "react"
import {
  CheckCircle2,
  XCircle,
  RefreshCw,
  Circle,
  ChevronRight,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { StepRow } from "@/lib/api"
import { fromStepRow } from "@/lib/display-step"
import { cn, formatDuration } from "@/lib/utils"
import { ReasoningPipeline } from "@/components/reasoning-pipeline"

interface StepCardProps {
  step: StepRow
  isSelected: boolean
  onSelect: () => void
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
    case "failed":
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
    case "healed":
      return <RefreshCw className="h-4 w-4 shrink-0 text-amber-500" />
    case "flaky":
      return <RefreshCw className="h-4 w-4 shrink-0 text-amber-500" />
    case "skipped":
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
    default:
      return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "passed":
      return "Passed"
    case "failed":
      return "Failed"
    case "healed":
      return "Healed"
    case "flaky":
      return "Flaky"
    case "skipped":
      return "Skipped"
    default:
      return status
  }
}

function formatAction(action: unknown): { type: string; target: string } | null {
  if (!action) return null
  try {
    const parsed = typeof action === "string" ? JSON.parse(action) : action
    if (parsed && typeof parsed === "object") {
      return {
        type: (parsed as Record<string, string>).type || (parsed as Record<string, string>).action || "unknown",
        target: (parsed as Record<string, string>).target || (parsed as Record<string, string>).selector || "",
      }
    }
  } catch {
    // not JSON, treat as string
    return { type: String(action), target: "" }
  }
  return null
}

export function StepCard({ step, isSelected, onSelect }: StepCardProps) {
  const [isOpen, setIsOpen] = useState(false)
  const actionInfo = formatAction(step.action)

  return (
    <Collapsible
      data-step-id={step.id}
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "relative overflow-hidden rounded-lg transition-colors",
        isSelected ? "border-2 border-primary shadow-sm" : "border border-border/50 hover:bg-muted/30"
      )}
    >
      <CollapsibleTrigger
        className="flex w-full items-start gap-2 p-3 text-left"
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
        }}
      >
        <span className="text-xs text-muted-foreground font-mono w-6 shrink-0 mt-0.5">
          #{step.stepOrder}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex mt-0.5">
              <StatusIcon status={step.status} />
            </span>
          </TooltipTrigger>
          <TooltipContent>{statusLabel(step.status)}</TooltipContent>
        </Tooltip>
        <span className="flex-1 min-w-0 text-sm font-medium leading-snug break-words">
          {step.name}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDuration(step.duration)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{step.duration}ms</TooltipContent>
        </Tooltip>
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-90"
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-3 pb-3 space-y-2 border-t pt-2 overflow-x-auto">
          {actionInfo && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">
                Action
              </p>
              <p className="text-sm">
                {actionInfo.type}
                {actionInfo.target && (
                  <span className="text-muted-foreground ml-1">
                    {actionInfo.target}
                  </span>
                )}
              </p>
            </div>
          )}

          <ReasoningPipeline
            runId={step.runId}
            stepOrder={step.stepOrder}
            stepData={fromStepRow(step)}
          />

        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
