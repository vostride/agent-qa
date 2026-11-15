import { Play, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { ShortcutKey } from "@/components/shortcut-hints"
import { useTranslation } from "@/i18n"
import { cn } from "@/lib/utils"

interface SplitButtonProps {
  onRun: () => void
  onRunNoCache?: () => void
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
  const { t } = useTranslation()
  const hasDropdownItems = !!onRunNoCache || !!onPurgeCache
  const buttonLabel = label ?? t('common.run')
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
        onClick={() => onRun()}
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
        onClick={() => onRun()}
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
          {onRunNoCache && (
            <DropdownMenuItem onClick={() => onRunNoCache()}>
              {t('common.run.withoutCache')}
            </DropdownMenuItem>
          )}
          {onPurgeCache && (
            <DropdownMenuItem onClick={onPurgeCache}>
              {t('common.run.purgeCache')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
