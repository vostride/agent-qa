// Static only: the caller passes the sections, so the panel cannot disagree with the tree.

import { useState, useCallback, useRef, forwardRef, useImperativeHandle } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn, formatDuration } from "@/lib/utils"

export interface ReasoningPipelineHandle {
  togglePhase: (index: number) => void
}

export interface SectionDef {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  content: string | null
  duration: number | null
  outcome?: React.ReactNode
  children?: React.ReactNode
}

export interface PhaseConfig {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

/**
 * The only shape this component takes.
 *
 * `mode` survives as a literal because every call site already spells it and it reads as an
 * intention at the seam ("these sections are all there is"), not because a second mode exists.
 */
interface ReasoningPipelineProps {
  mode: 'static'
  sections: SectionDef[]
}

function PhaseSection({
  config,
  content,
  duration,
  outcome,
  children,
  open: controlledOpen,
  onOpenChange,
  sectionRef,
}: {
  config: PhaseConfig
  content: string | null
  duration: number | null
  outcome?: React.ReactNode
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  sectionRef?: React.Ref<HTMLButtonElement>
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = isControlled ? onOpenChange! : setInternalOpen
  const Icon = config.icon
  const hasContent = content || children

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger ref={sectionRef} className="flex w-full items-center gap-2 py-1.5 text-left group sticky top-0 z-20 bg-background">
        <div className="flex items-center justify-center h-4 w-4 rounded-full bg-background border shrink-0">
          <Icon className="h-2.5 w-2.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-medium">{config.label}</span>
        {duration != null && (
          <span className="text-xs text-muted-foreground">
            {formatDuration(duration)}
          </span>
        )}
        {outcome}
        <span className="flex-1" />
        {hasContent && (
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground transition-transform duration-200",
              open && "rotate-90"
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasContent && (
        <CollapsibleContent className="overflow-hidden min-w-0 max-w-full">
          <div className="min-w-0 max-w-full pl-6 pb-2 space-y-2">
            {content && (
              <div data-reasoning-content-shell="true" className="min-w-0 max-w-full rounded-sm">
                <div
                  data-reasoning-prose="true"
                  className="m-0 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {content}
                </div>
              </div>
            )}
            {children && (
              <div data-reasoning-children="true" className="min-w-0 max-w-full">
                {children}
              </div>
            )}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

const StaticPipeline = forwardRef<ReasoningPipelineHandle, { sections: SectionDef[] }>(
  function StaticPipeline({ sections }, ref) {
    const [phaseOpen, setPhaseOpen] = useState<boolean[]>(() => sections.map(() => false))
    const phaseRefs = useRef<(HTMLButtonElement | null)[]>([])

    const togglePhase = useCallback((index: number) => {
      setPhaseOpen(prev => {
        const next = [...prev]
        const wasOpen = next[index]
        next[index] = !wasOpen
        if (!wasOpen) {
          requestAnimationFrame(() => {
            phaseRefs.current[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          })
        }
        return next
      })
    }, [])

    useImperativeHandle(ref, () => ({ togglePhase }), [togglePhase])

    return (
      <div className="relative space-y-0">
        <div className="absolute left-[7px] top-4 bottom-4 w-px bg-border" />
        {sections.map((section, i) => (
          <PhaseSection
            key={section.key}
            config={{ key: section.key, label: section.label, icon: section.icon }}
            content={section.content}
            duration={section.duration}
            outcome={section.outcome}
            open={phaseOpen[i]}
            onOpenChange={(o) => setPhaseOpen(prev => { const n = [...prev]; n[i] = o; return n })}
            sectionRef={(el) => { phaseRefs.current[i] = el }}
          >
            {section.children}
          </PhaseSection>
        ))}
      </div>
    )
  }
)

export const ReasoningPipeline = forwardRef<ReasoningPipelineHandle, ReasoningPipelineProps>(
  function ReasoningPipeline({ sections }, ref) {
    return <StaticPipeline sections={sections} ref={ref} />
  }
)
