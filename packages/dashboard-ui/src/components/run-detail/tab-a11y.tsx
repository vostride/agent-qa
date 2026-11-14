import type { EvidenceDocument } from '@vostride/agent-qa-schema'
import { Badge } from '@/components/ui/badge'
import { useEvidenceRecords } from '@/hooks/use-evidence-records'
import type { DisplayStep } from '@/lib/display-step'
import { resolveEvidenceView } from '@/lib/evidence-state-view'
import { cn } from '@/lib/utils'
import { EvidenceState, EvidenceLoading } from './evidence-state'
import { t } from "@/lib/i18n"

function impactColor(impact: string): string {
  switch (impact) {
    case 'critical': return 'bg-red-500/15 text-red-500 border-red-500/20'
    case 'serious': return 'bg-orange-500/15 text-orange-500 border-orange-500/20'
    case 'moderate': return 'bg-amber-500/15 text-amber-500 border-amber-500/20'
    case 'minor': return 'bg-blue-500/15 text-blue-500 border-blue-500/20'
    default: return 'bg-muted text-muted-foreground'
  }
}

function Violations({ records }: { records: Extract<EvidenceDocument, { kind: 'a11y' }>['records'] }) {
  return (
    <div className="p-3">
      {(['critical', 'serious', 'moderate', 'minor'] as const).map(impact => {
        const group = records.filter(record => record.impact === impact)
        if (group.length === 0) return null
        return <section key={impact} data-a11y-impact={impact} className="space-y-3 [&+section]:pt-6">
          <h3 className="text-[10px] font-medium uppercase tracking-wider">{impact} · {group.length}</h3>
          {group.map((v, i) => <div key={i} className="border border-border/50 rounded-sm p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <Badge className={cn('text-[10px] px-1.5 py-0', impactColor(v.impact))}>{v.impact}</Badge>
              <span className="text-sm font-medium">{v.help}</span>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground">{v.ruleId}</div>
            <p className="text-xs text-muted-foreground">{v.description}</p>
            {v.nodes.length > 0 && <div className="space-y-1 mt-1">
              {v.nodes.map((node, j) => <pre key={j} className="text-[10px] font-mono bg-muted/30 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-words">{node.html}</pre>)}
            </div>}
            <a href={v.helpUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline">{t("Learn more")}</a>
          </div>)}
        </section>
      })}
    </div>
  )
}

export function TabA11y({ step, runId, selection = step ? 'step' : 'none', allSteps = [], onSelectStep }: {
  step: DisplayStep | null
  runId: string | null
  selection?: Parameters<typeof resolveEvidenceView>[0]['selection']
  allSteps?: DisplayStep[]
  onSelectStep?: (stepId: string) => void
}) {
  const entry = step?.evidence?.a11y
  const testIndex = step?.testIndex
  const stepIndex = step?.stepIndex
  const enabled = entry?.state === 'present' && !entry.ref.evidenceIncomplete
    && (selection === 'step' || selection === 'sub-action')
  const { read, retry } = useEvidenceRecords(testIndex !== undefined && stepIndex !== undefined
    ? { runId: runId ?? '', testIndex, stepIndex, kind: 'a11y' } : null, enabled)
  const memberSteps = allSteps.filter(s => s.testIndex === testIndex && s.stepIndex !== undefined)
    .map(s => ({ ...s, stepIndex: s.stepIndex! }))
  const view = resolveEvidenceView({ kind: 'a11y', selection, entry, read,
    elsewhere: stepIndex === undefined ? undefined : { steps: memberSteps, currentStepIndex: stepIndex } })
  if (view.kind === 'loading') return <EvidenceLoading kind="a11y" />
  if (view.kind === 'state') {
    const action = view.action
    return <EvidenceState {...view} kind="a11y"
      explanation={action?.type === 'step' ? `${view.explanation} ${action.description}` : view.explanation}
      actionLabel={action?.label} onAction={action?.type === 'retry' ? retry : action?.type === 'step' && onSelectStep
        ? () => { const target = memberSteps.find(s => s.stepIndex === action.stepIndex); if (target) onSelectStep(target.id) } : undefined} />
  }
  return view.document.kind === 'a11y' ? <Violations records={view.document.records} /> : null
}
