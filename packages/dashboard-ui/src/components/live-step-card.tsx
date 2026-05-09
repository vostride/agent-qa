import {
  CircleDashed,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  SkipForward,
  Circle,
  Eye,
  Brain,
  Play,
  RefreshCw,
  Webhook,
  Square,
} from "lucide-react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import type { LiveStep, LivePhase } from "@/hooks/use-execution-events"

function StepStatusIcon({ status }: { status: LiveStep["status"] }) {
  switch (status) {
    case "running":
      return <CircleDashed className="h-4 w-4 text-primary" />
    case "passed":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    case "failed":
      return <XCircle className="h-4 w-4 text-red-500" />
    case "cancelled":
      return <Square className="h-4 w-4 text-muted-foreground" />
    case "healed":
      return <ShieldCheck className="h-4 w-4 text-primary" />
    case "flaky":
      return <RefreshCw className="h-4 w-4 text-amber-500" />
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground" />
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />
  }
}

function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

function phaseIcon(phase: LivePhase['phase']) {
  switch (phase) {
    case 'observe': return { Icon: Eye, label: 'Observing', color: 'text-primary' }
    case 'plan': return { Icon: Brain, label: 'Planning', color: 'text-purple-400' }
    case 'execute': return { Icon: Play, label: 'Executing', color: 'text-emerald-400' }
    case 'verify': return { Icon: ShieldCheck, label: 'Verifying', color: 'text-amber-400' }
    case 'heal': return { Icon: RefreshCw, label: 'Healing', color: 'text-red-400' }
  }
}

interface LiveStepCardProps {
  step: LiveStep
  index: number
}

export function LiveStepCard({ step, index }: LiveStepCardProps) {
  const isComplete = step.status !== "running" && step.status !== "pending"
  const hookLabel = step.kind === "hook"
    ? step.hookPhase === "setup"
      ? "Setup"
      : step.hookPhase === "teardown"
        ? "Teardown"
        : "Hook"
    : null

  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.2 } }}
      className={cn(
        "relative overflow-hidden flex items-start gap-2 rounded-[2px] border bg-card py-2 px-3",
        step.status === "running" ? "live-running-surface border-border/60 bg-primary/5" : "border-border/70",
      )}
      data-status={step.status}
    >
      <div className="mt-0.5">
        <StepStatusIcon status={step.status} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          {step.kind === "hook" ? (
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Webhook className="h-3 w-3" />
              {hookLabel}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground font-mono shrink-0 mt-0.5">
              #{index + 1}
            </span>
          )}
          <span className="text-sm font-medium break-words">{step.name}</span>
        </div>

        {step.status === "failed" && step.error && (
          <p className="text-destructive text-xs mt-1 line-clamp-2">
            {step.error}
          </p>
        )}

        {step.kind === 'step' && step.status === 'running' && step.phases && step.phases.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {step.phases.map((p, i) => {
              const { Icon, label, color } = phaseIcon(p.phase)
              return (
                <motion.div
                  key={`${p.phase}-${i}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: 0.05 }}
                  className="flex items-center gap-2 text-xs min-w-0"
                >
                  <Icon className={cn("h-3 w-3", color)} />
                  <span className="text-muted-foreground">{label}</span>
                  {p.text && (
                    <span className="text-muted-foreground/70 truncate max-w-[180px]">
                      — {p.text.slice(0, 80)}
                    </span>
                  )}
                  {p.phase === 'plan' && p.confidence != null && (
                    <span className={cn(
                      "text-[10px] font-mono px-1 rounded",
                      p.confidence > 0.8 ? "bg-emerald-500/10 text-emerald-500" :
                      p.confidence >= 0.5 ? "bg-amber-500/10 text-amber-500" :
                      "bg-red-500/10 text-red-500"
                    )}>
                      {Math.round(p.confidence * 100)}%
                    </span>
                  )}
                  {p.duration != null && (
                    <span className="text-muted-foreground/50 font-mono">
                      {p.duration < 1000 ? `${p.duration}ms` : `${(p.duration / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </motion.div>
              )
            })}
          </div>
        )}
      </div>

      {isComplete && step.duration != null && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatStepDuration(step.duration)}
        </span>
      )}
    </motion.div>
  )
}
