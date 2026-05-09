import { useEffect, useRef, useCallback } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StepCard } from "@/components/step-card.tsx"
import type { StepRow } from "@/lib/api"

interface StepTimelineProps {
  steps: StepRow[]
  selectedStepId: string | null
  onStepSelect: (step: StepRow) => void
}

export function StepTimeline({
  steps,
  selectedStepId,
  onStepSelect,
}: StepTimelineProps) {
  const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const selectedRef = useRef<HTMLDivElement>(null)

  const scrollToSelected = useCallback(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" })
    }
  }, [])

  // Scroll selected step into view on selection change,
  // and again after 350ms to account for collapsible expansion animation
  useEffect(() => {
    scrollToSelected()
    const timer = setTimeout(scrollToSelected, 350)
    return () => clearTimeout(timer)
  }, [selectedStepId, scrollToSelected])

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <p className="text-xs text-muted-foreground mb-2 px-1 shrink-0">
        Steps ({steps.length})
      </p>
      <div className="flex-1 overflow-y-auto min-h-0 pr-1">
        <TooltipProvider>
          <div className="space-y-2 pb-2">
            {sorted.map((step) => (
              <div
                key={step.id}
                ref={step.id === selectedStepId ? selectedRef : undefined}
              >
                <StepCard
                  step={step}
                  isSelected={step.id === selectedStepId}
                  onSelect={() => onStepSelect(step)}
                />
              </div>
            ))}
          </div>
        </TooltipProvider>
      </div>
    </div>
  )
}
