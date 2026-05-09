import { Loader2 } from "lucide-react"
import { CacheStatusIconWrapper } from "./cache-status-marker"
import type { SubActionData } from "@/lib/api"
import { cn, formatDuration } from "@/lib/utils"

interface SubActionTreeItemProps {
  sub: SubActionData
  index: number
  stepId: string
  isSelected: boolean
  onSelect: () => void
}

function formatAction(action: unknown): string | null {
  if (!action) return null
  try {
    const parsed = typeof action === "string" ? JSON.parse(action) : action
    if (parsed && typeof parsed === "object") {
      const type = (parsed as Record<string, string>).type || (parsed as Record<string, string>).action || ""
      const target = (parsed as Record<string, string>).target || (parsed as Record<string, string>).selector || ""
      return [type, target].filter(Boolean).join(" ")
    }
  } catch {
    return String(action)
  }
  return null
}

export function SubActionTreeItem({ sub, index, stepId, isSelected, onSelect }: SubActionTreeItemProps) {
  const actionLabel = formatAction(sub.plannedAction)
  const duration = sub.phaseDurations
    ? (sub.phaseDurations.observe ?? 0) + (sub.phaseDurations.plan ?? 0) +
      (sub.phaseDurations.execute ?? 0) + (sub.phaseDurations.verify ?? 0)
    : null
  const statusGlyph = sub.result === 'in-progress' ? (
    <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
  ) : sub.result === 'success' ? (
    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
  ) : (
    <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
  )
  const statusHost = (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
      {statusGlyph}
    </span>
  )

  return (
    <li
      role="treeitem"
      aria-level={2}
      aria-selected={isSelected}
      data-sub-action-id={`${stepId}-${index}`}
    >
      <button
        className={cn(
          "flex w-full items-center gap-2 py-1.5 px-3 text-left rounded-[2px] text-sm",
          "hover:bg-muted/50 transition-colors",
          isSelected && "bg-primary/10 ring-1 ring-primary/30"
        )}
        onClick={onSelect}
      >
        {sub.cached ? (
          <CacheStatusIconWrapper
            marker="sub-action-status"
            state="cached"
            tone="primary"
            label="Cached action"
          >
            {statusHost}
          </CacheStatusIconWrapper>
        ) : (
          statusHost
        )}
        <span className="text-xs text-muted-foreground shrink-0">#{index + 1}</span>
        {actionLabel && (
          <span className="flex-1 min-w-0 text-xs truncate text-muted-foreground">
            {actionLabel}
          </span>
        )}
        {duration != null && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {formatDuration(duration)}
          </span>
        )}
      </button>
    </li>
  )
}
