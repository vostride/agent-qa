import { Eye, Brain, Play, ShieldCheck } from 'lucide-react'
import { ReasoningPipeline } from '@/components/reasoning-pipeline'
import type { SectionDef } from '@/components/reasoning-pipeline'
import { ConfidenceBadge } from '@/components/confidence-badge'
import type { SubActionData } from '@/lib/api'
import type { DisplayStep } from '@/lib/display-step'

interface EditorStepDetailProps {
  step: DisplayStep
  subAction: SubActionData | null
}

function buildSubActionSections(sub: SubActionData): SectionDef[] {
  const sections: SectionDef[] = []

  if (sub.observation) {
    sections.push({
      key: 'observation',
      label: 'Observation',
      icon: Eye,
      content: sub.observation,
      duration: sub.phaseDurations?.observe ?? null,
    })
  }

  if (sub.reasoning) {
    sections.push({
      key: 'reasoning',
      label: 'Reasoning',
      icon: Brain,
      content: sub.reasoning,
      duration: sub.phaseDurations?.plan ?? null,
    })
  }

  if (sub.plannedAction != null) {
    sections.push({
      key: 'plannedAction',
      label: 'Planned Action',
      icon: Play,
      content: null,
      duration: sub.phaseDurations?.execute ?? null,
      children: (
        <pre className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {typeof sub.plannedAction === 'string'
            ? sub.plannedAction
            : JSON.stringify(sub.plannedAction, null, 2)}
        </pre>
      ),
    })
  }

  if (sub.verifierReasoning) {
    sections.push({
      key: 'verifier',
      label: 'Verifier',
      icon: ShieldCheck,
      content: sub.verifierReasoning,
      duration: sub.phaseDurations?.verify ?? null,
    })
  }

  return sections
}

function buildStepSections(step: DisplayStep): SectionDef[] {
  const sections: SectionDef[] = []

  if (step.observation) {
    sections.push({
      key: 'observation',
      label: 'Observation',
      icon: Eye,
      content: step.observation,
      duration: null,
    })
  }

  if (step.reasoning) {
    sections.push({
      key: 'reasoning',
      label: 'Reasoning',
      icon: Brain,
      content: step.reasoning,
      duration: null,
    })
  }

  if (step.plannedAction != null) {
    sections.push({
      key: 'plannedAction',
      label: 'Planned Action',
      icon: Play,
      content: null,
      duration: null,
      children: (
        <pre className="max-w-full min-w-0 text-[10px] font-mono bg-muted/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-words">
          {typeof step.plannedAction === 'string'
            ? step.plannedAction
            : JSON.stringify(step.plannedAction, null, 2)}
        </pre>
      ),
    })
  }

  return sections
}

export function EditorStepDetail({ step, subAction }: EditorStepDetailProps) {
  if (subAction) {
    const sections = buildSubActionSections(subAction)
    return (
      <div className="p-3 space-y-3 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">Sub-action #{subAction.index + 1}</span>
          <span className={`text-xs font-medium ${subAction.result === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
            {subAction.result}
          </span>
          {subAction.confidence != null && (
            <ConfidenceBadge confidence={subAction.confidence} />
          )}
        </div>

        <ReasoningPipeline mode="static" sections={sections} />

        {subAction.error && (
          <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-xs break-words [overflow-wrap:anywhere]">
            {subAction.error}
          </div>
        )}
      </div>
    )
  }

  const sections = buildStepSections(step)
  return (
    <div className="p-3 space-y-3 min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Step #{step.stepOrder + 1}</span>
        {step.confidence != null && (
          <ConfidenceBadge confidence={step.confidence} />
        )}
      </div>

      {sections.length > 0 ? (
        <ReasoningPipeline mode="static" sections={sections} />
      ) : (
        <p className="text-sm text-muted-foreground">No reasoning data yet.</p>
      )}

      {step.error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-xs break-words [overflow-wrap:anywhere]">
          {step.error}
        </div>
      )}
    </div>
  )
}
