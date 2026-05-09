import { createPortal } from "react-dom"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SplitButton } from "@/components/split-button"

interface BatchActionBarProps {
  selectedCount: number
  onRun?: (local: boolean) => void
  onRunNoCache?: (local: boolean) => void
  onPurgeCache?: () => void
  onCancel: () => void
  isRunning?: boolean
  summaryMeta?: string
  secondaryLabel?: string
  secondaryIcon?: React.ReactNode
  secondaryAriaLabel?: string
  actionSlot?: React.ReactNode
  onDelete?: () => void
}

export function BatchActionBar({
  selectedCount,
  onRun,
  onRunNoCache,
  onPurgeCache,
  onCancel,
  isRunning = false,
  summaryMeta,
  secondaryLabel,
  secondaryIcon,
  secondaryAriaLabel,
  actionSlot,
  onDelete,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null

  const isIconOnlySecondary = !secondaryLabel && !!secondaryIcon

  return createPortal(
    <div className="fixed bottom-6 left-1/2 z-50 flex w-max max-w-[calc(100vw-1rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-md border bg-background px-4 py-3 shadow-lg sm:flex-nowrap">
      <div className="min-w-[6.5rem] shrink-0">
        <span className="text-sm font-medium">
          {selectedCount} selected
        </span>
        {summaryMeta ? (
          <p className="text-xs text-muted-foreground">
            {summaryMeta}
          </p>
        ) : null}
      </div>
      {actionSlot ?? (
        onRun && onRunNoCache ? (
          <SplitButton
            onRun={onRun}
            onRunNoCache={onRunNoCache}
            onPurgeCache={onPurgeCache}
            disabled={isRunning}
            size="sm"
          />
        ) : null
      )}
      {onDelete ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          disabled={isRunning}
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
      ) : null}
      <Button
        variant={isIconOnlySecondary ? "ghost" : "outline"}
        size={isIconOnlySecondary ? "icon-sm" : "sm"}
        aria-label={secondaryAriaLabel}
        title={secondaryAriaLabel}
        onClick={onCancel}
        disabled={isRunning}
      >
        {secondaryIcon ?? secondaryLabel ?? "Cancel"}
      </Button>
    </div>,
    document.body,
  )
}
