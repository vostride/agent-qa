import { Play, ChevronDown, Monitor, Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { ShortcutKey } from "@/components/shortcut-hints"
import { cn } from "@/lib/utils"
import { useRunConfig } from "@/hooks/use-run-config"

interface SplitButtonProps {
  onRun: (local: boolean) => void
  onRunNoCache?: (local: boolean) => void
  onPurgeCache?: () => void
  disabled?: boolean
  size?: "default" | "sm"
  className?: string
  label?: string
  shortcutKey?: string
  runButtonTourId?: string
}

export function SplitButton({
  onRun,
  onRunNoCache,
  onPurgeCache,
  disabled = false,
  size = "default",
  className,
  label,
  shortcutKey,
  runButtonTourId,
}: SplitButtonProps) {
  const { hasFarm } = useRunConfig()

  const hasDropdownItems = hasFarm || !!onRunNoCache || !!onPurgeCache
  const buttonLabel = label ?? "Run"
  const shortcutBadge = shortcutKey ? (
    <ShortcutKey
      shortcut={shortcutKey}
      className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground"
    />
  ) : null

  if (!hasDropdownItems) {
    return (
      <Button
        size={size}
        disabled={disabled}
        onClick={() => onRun(true)}
        className={className}
        data-tour-id={runButtonTourId}
      >
        <Play className="size-4" />
        {buttonLabel}
        {shortcutBadge}
      </Button>
    )
  }

  return (
    <div className={cn("inline-flex items-center", className)}>
      <Button
        size={size}
        disabled={disabled}
        onClick={() => onRun(true)}
        className="rounded-r-none"
        data-tour-id={runButtonTourId}
      >
        <Play className="size-4" />
        {buttonLabel}
        {shortcutBadge}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="default"
            size={size}
            disabled={disabled}
            className="rounded-l-none border-l border-l-primary-foreground/20 px-2"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onRun(true)}>
            <Monitor className="mr-2 h-4 w-4" />
            Run Local
          </DropdownMenuItem>
          {hasFarm && (
            <DropdownMenuItem onClick={() => onRun(false)}>
              <Globe className="mr-2 h-4 w-4" />
              Run on Farm
            </DropdownMenuItem>
          )}
          {(onRunNoCache || onPurgeCache) && <DropdownMenuSeparator />}
          {onRunNoCache && (
            <DropdownMenuItem onClick={() => onRunNoCache(true)}>
              Run without cache
            </DropdownMenuItem>
          )}
          {onPurgeCache && (
            <DropdownMenuItem onClick={onPurgeCache}>
              Purge cache
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
