import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"

interface TestRunOptionsPopoverProps {
  selectedCount: number
  hiddenCount: number
  useCache: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseCacheChange: (checked: boolean) => void
  onRun: () => void
  disabled?: boolean
}

export function TestRunOptionsPopover({
  selectedCount,
  hiddenCount,
  useCache,
  open,
  onOpenChange,
  onUseCacheChange,
  onRun,
  disabled = false,
}: TestRunOptionsPopoverProps) {
  const handleRun = () => {
    if (disabled) return
    onRun()
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Run
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        sideOffset={8}
        className="w-[280px] max-w-[calc(100vw-2rem)] space-y-4"
      >
        <div className="space-y-1">
          <p className="text-sm font-medium">{selectedCount} selected</p>
          {hiddenCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {hiddenCount} hidden by filters
            </p>
          ) : null}
        </div>
        <Separator />
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Use cache</span>
            <Checkbox
              checked={useCache}
              onCheckedChange={(checked) => onUseCacheChange(checked === true)}
              disabled={disabled}
            />
          </label>
        </div>
        <Separator />
        <Button size="sm" className="w-full" disabled={disabled} onClick={handleRun}>
          <Play className="size-4" />
          Run
        </Button>
      </PopoverContent>
    </Popover>
  )
}
