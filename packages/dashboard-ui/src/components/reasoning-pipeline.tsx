import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react"
import {
  Eye,
  Brain,
  Play,
  ShieldCheck,
  RefreshCw,
  ChevronRight,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { ConfidenceBadge } from "@/components/confidence-badge"
import { HealingChain } from "@/components/healing-chain"
import type { ReasoningTrace } from "@/lib/api"
import type { DisplayStep } from "@/lib/display-step"
import { fetchStepReasoning } from "@/lib/api"
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

type ReasoningPipelineProps =
  | { mode?: 'fetch'; runId: string; stepOrder: number; stepData: DisplayStep }
  | { mode: 'static'; sections: SectionDef[] }

const PHASES: PhaseConfig[] = [
  { key: "observe", label: "Observe", icon: Eye },
  { key: "plan", label: "Plan", icon: Brain },
  { key: "execute", label: "Execute", icon: Play },
  { key: "verify", label: "Verify", icon: ShieldCheck },
  { key: "heal", label: "Heal", icon: RefreshCw },
]

function formatJson(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
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

function buildFallbackSections(step: DisplayStep): SectionDef[] {
  const sections: SectionDef[] = []
  if (step.observation) {
    sections.push({ key: 'observation', label: 'Observe', icon: PHASES[0].icon, content: step.observation, duration: null })
  }
  if (step.reasoning) {
    sections.push({ key: 'reasoning', label: 'Plan', icon: PHASES[1].icon, content: step.reasoning, duration: null })
  }
  if (step.plannedAction != null) {
    sections.push({
      key: 'plannedAction', label: 'Execute', icon: PHASES[2].icon, content: null, duration: null,
      children: (
        <pre className="min-w-0 max-w-full text-xs font-mono bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {typeof step.plannedAction === "string"
            ? step.plannedAction
            : JSON.stringify(step.plannedAction, null, 2)}
        </pre>
      ),
    })
  }
  return sections
}

const FallbackView = forwardRef<ReasoningPipelineHandle, { step: DisplayStep }>(
  function FallbackView({ step }, ref) {
    const sections = buildFallbackSections(step)

    if (sections.length === 0 && step.error) {
      return (
        <div className="bg-destructive/10 text-destructive rounded p-2 text-sm break-words [overflow-wrap:anywhere]">
          {step.error}
        </div>
      )
    }

    return (
      <>
        <StaticPipeline ref={ref} sections={sections} />
        {step.error && (
          <div className="pl-6 pb-2">
            <div className="bg-destructive/10 text-destructive rounded p-2 text-sm break-words [overflow-wrap:anywhere]">
              {step.error}
            </div>
          </div>
        )}
      </>
    )
  }
)

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

const FetchPipeline = forwardRef<ReasoningPipelineHandle, { runId: string; stepOrder: number; stepData: DisplayStep }>(
  function FetchPipeline({ runId, stepOrder, stepData }, ref) {
    const [trace, setTrace] = useState<ReasoningTrace | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const [phaseOpen, setPhaseOpen] = useState<boolean[]>([false, false, false, false])
    const phaseRefs = useRef<(HTMLButtonElement | null)[]>([null, null, null, null])

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

    useEffect(() => {
      let cancelled = false

      fetchStepReasoning(runId, stepOrder)
        .then((res) => {
          if (!cancelled) {
            setTrace(res.trace)
            setLoading(false)
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load reasoning")
            setLoading(false)
          }
        })

      return () => {
        cancelled = true
      }
    }, [runId, stepOrder])

    if (loading) {
      return (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )
    }

    if (!trace && error) {
      return <FallbackView ref={ref} step={stepData} />
    }

    if (!trace) {
      return <FallbackView ref={ref} step={stepData} />
    }

    const hasHealAttempts = trace.healAttempts && trace.healAttempts.length > 0

    return (
      <div className="relative space-y-0">
        <div className="absolute left-[7px] top-4 bottom-4 w-px bg-border" />

        <PhaseSection
          config={PHASES[0]}
          content={trace.observeText}
          duration={trace.observeDuration}
          open={phaseOpen[0]}
          onOpenChange={(o) => setPhaseOpen(prev => { const n = [...prev]; n[0] = o; return n })}
          sectionRef={(el) => { phaseRefs.current[0] = el }}
        />

        <PhaseSection
          config={PHASES[1]}
          content={trace.planReasoning}
          duration={trace.planDuration}
          outcome={
            trace.planConfidence != null ? (
              <ConfidenceBadge confidence={trace.planConfidence} />
            ) : undefined
          }
          open={phaseOpen[1]}
          onOpenChange={(o) => setPhaseOpen(prev => { const n = [...prev]; n[1] = o; return n })}
          sectionRef={(el) => { phaseRefs.current[1] = el }}
        >
          {trace.planAction != null && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">
                Planned Action
              </p>
              <pre className="min-w-0 max-w-full text-xs font-mono bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {formatJson(trace.planAction)}
              </pre>
            </div>
          )}
        </PhaseSection>

        <PhaseSection
          config={PHASES[2]}
          content={null}
          duration={trace.executeDuration}
          open={phaseOpen[2]}
          onOpenChange={(o) => setPhaseOpen(prev => { const n = [...prev]; n[2] = o; return n })}
          sectionRef={(el) => { phaseRefs.current[2] = el }}
        >
          {trace.executeAction != null && (
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-0.5">
                Executed Action
              </p>
              <pre className="min-w-0 max-w-full text-xs font-mono bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {formatJson(trace.executeAction)}
              </pre>
            </div>
          )}
        </PhaseSection>

        <PhaseSection
          config={PHASES[3]}
          content={trace.verifyReasoning}
          duration={trace.verifyDuration}
          outcome={
            trace.verifySuccess != null ? (
              <span
                className={cn(
                  "text-xs font-medium",
                  trace.verifySuccess ? "text-emerald-500" : "text-red-500"
                )}
              >
                {trace.verifySuccess ? "Passed" : "Failed"}
              </span>
            ) : undefined
          }
          open={phaseOpen[3]}
          onOpenChange={(o) => setPhaseOpen(prev => { const n = [...prev]; n[3] = o; return n })}
          sectionRef={(el) => { phaseRefs.current[3] = el }}
        />

        {hasHealAttempts && (
          <PhaseSection
            config={PHASES[4]}
            content={null}
            duration={null}
          >
            <HealingChain attempts={trace.healAttempts} />
          </PhaseSection>
        )}
      </div>
    )
  }
)

export const ReasoningPipeline = forwardRef<ReasoningPipelineHandle, ReasoningPipelineProps>(
  function ReasoningPipeline(props, ref) {
    if (props.mode === 'static') {
      return <StaticPipeline sections={props.sections} ref={ref} />
    }
    return <FetchPipeline runId={props.runId} stepOrder={props.stepOrder} stepData={props.stepData} ref={ref} />
  }
)
