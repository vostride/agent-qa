import { Zap } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface CacheStatusIconWrapperProps {
  children: React.ReactNode
  marker: "step-status" | "sub-action-status"
  state: "all" | "some" | "cached"
  tone: "primary" | "amber"
  label: string
}

export function CacheStatusIconWrapper({
  children,
  marker,
  state,
  tone,
  label,
}: CacheStatusIconWrapperProps) {
  const toneClass = tone === "primary" ? "text-primary" : "text-amber-500"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex shrink-0 cursor-default">
          {children}
          <span
            data-cache-marker={marker}
            data-cache-state={state}
            aria-label={label}
            className={cn(
              "absolute -bottom-px -right-px inline-flex size-2 items-center justify-center rounded-full border border-background/90 bg-background/70 shadow-[0_0_0_1px_color-mix(in_srgb,var(--border)_70%,transparent)]",
              toneClass
            )}
          >
            <Zap className={cn("size-1.5 fill-current stroke-[2.5]", toneClass)} />
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
