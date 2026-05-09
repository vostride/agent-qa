import { ChevronDown, Globe, Monitor, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"

interface TestRunOptionsPopoverProps {
  selectedCount: number
  hiddenCount: number
  useCache: boolean
  useMemory: boolean
  browserStackAvailable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onUseCacheChange: (checked: boolean) => void
  onUseMemoryChange: (checked: boolean) => void
  onRunLocal: () => void
  onRunBrowserStack: () => void
  disabled?: boolean
}

export function TestRunOptionsPopover({
  selectedCount,
  hiddenCount,
  useCache,
  useMemory,
  browserStackAvailable,
  open,
  onOpenChange,
  onUseCacheChange,
  onUseMemoryChange,
  onRunLocal,
  onRunBrowserStack,
  disabled = false,
}: TestRunOptionsPopoverProps) {
  const handleRunLocal = () => {
    if (disabled) return
    onRunLocal()
    onOpenChange(false)
  }

  const handleRunBrowserStack = () => {
    if (disabled || !browserStackAvailable) return
    onRunBrowserStack()
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
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Use memory</span>
            <Checkbox
              checked={useMemory}
              onCheckedChange={(checked) => onUseMemoryChange(checked === true)}
              disabled={disabled}
            />
          </label>
        </div>
        <Separator />
        <div className="space-y-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="w-full justify-between" disabled={disabled}>
                <span className="inline-flex items-center gap-2">
                  <Play className="size-4" />
                  Run
                </span>
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[240px]">
              <DropdownMenuItem onClick={handleRunLocal}>
                <Monitor className="size-4" />
                Run Local
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleRunBrowserStack}
                disabled={!browserStackAvailable}
              >
                <Globe className="size-4" />
                Run on BrowserStack
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!browserStackAvailable ? (
            <p className="text-xs text-muted-foreground">
              BrowserStack is unavailable in the current config.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
