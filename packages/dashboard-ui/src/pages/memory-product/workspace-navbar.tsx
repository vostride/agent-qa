import { ChevronRight, Copy, Keyboard } from "lucide-react"
import { Link } from "react-router"

import { ShortcutLegend } from "@/components/shortcut-hints"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { routes } from "@/lib/routes"

interface WorkspaceNavbarProps {
  onCopyPage: () => void | Promise<void>
  onShortcutsOpenChange: (open: boolean) => void
  productKey: string
  shortcutsOpen: boolean
}

export function WorkspaceNavbar({
  onCopyPage,
  onShortcutsOpenChange,
  productKey,
  shortcutsOpen,
}: WorkspaceNavbarProps) {
  return (
    <div
      data-workspace-navbar="true"
      className="flex h-14 min-w-0 shrink-0 items-center justify-between border-b bg-background px-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to={routes.memory}
          className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Memory
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{productKey}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          data-workspace-copy-button="true"
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 rounded-sm px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5"
          onClick={() => {
            void onCopyPage()
          }}
        >
          <Copy className="size-4" />
          Copy page
        </Button>

        <Popover open={shortcutsOpen} onOpenChange={onShortcutsOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Keyboard shortcuts"
                  onClick={() => onShortcutsOpenChange(!shortcutsOpen)}
                >
                  <Keyboard className="size-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Shortcuts</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
            <div className="space-y-3">
              <div>
                <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Navigation
                </h4>
                <ShortcutLegend
                  hints={[
                    { key: "J / ↓", label: "Next entry" },
                    { key: "K / ↑", label: "Previous entry" },
                  ]}
                />
              </div>
              <div>
                <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </h4>
                <ShortcutLegend
                  hints={[
                    { key: "C", label: "Copy page" },
                    { key: "Shift+?", label: "Toggle shortcuts" },
                    { key: "Esc", label: "Close" },
                  ]}
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
