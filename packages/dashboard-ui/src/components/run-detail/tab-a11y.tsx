import { Badge } from "@/components/ui/badge"
import type { AccessibilitySummary, StepRow } from "@/lib/api"
import { cn } from "@/lib/utils"

interface TabA11yProps {
  step: StepRow
  summary?: AccessibilitySummary | null
}

function impactColor(impact: string): string {
  switch (impact) {
    case 'critical': return 'bg-red-500/15 text-red-500 border-red-500/20'
    case 'serious': return 'bg-orange-500/15 text-orange-500 border-orange-500/20'
    case 'moderate': return 'bg-amber-500/15 text-amber-500 border-amber-500/20'
    case 'minor': return 'bg-blue-500/15 text-blue-500 border-blue-500/20'
    default: return 'bg-muted text-muted-foreground'
  }
}

export function TabA11y({ step, summary }: TabA11yProps) {
  const violations = step.accessibilityViolations

  if (violations == null) {
    const message = summary?.enabled === false
      ? 'Accessibility checks were disabled for this run.'
      : 'Accessibility checks did not record data for this step.'
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
        {message}
      </div>
    )
  }

  if (violations.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm py-12">
        No accessibility violations detected
      </div>
    )
  }

  return (
    <div className="p-3 space-y-3">
      {violations.map((v, i) => (
        <div key={i} className="border border-border/50 rounded-sm p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge className={cn("text-[10px] px-1.5 py-0", impactColor(v.impact))}>{v.impact}</Badge>
            <span className="text-sm font-medium">{v.help}</span>
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">{v.ruleId}</div>
          <p className="text-xs text-muted-foreground">{v.description}</p>
          {v.nodes.length > 0 && (
            <div className="space-y-1 mt-1">
              {v.nodes.map((node, j) => (
                <pre key={j} className="text-[10px] font-mono bg-muted/30 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-words">{node.html}</pre>
              ))}
            </div>
          )}
          <a href={v.helpUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline">Learn more</a>
        </div>
      ))}
    </div>
  )
}
