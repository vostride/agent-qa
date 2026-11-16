import { Eye, Brain, Play, ShieldCheck } from 'lucide-react'
import { ReasoningPipeline } from '@/components/reasoning-pipeline'
import type { SectionDef } from '@/components/reasoning-pipeline'
import { ConfidenceBadge } from '@/components/confidence-badge'
import type { LiveSubAction } from '@/hooks/use-live-editor'
import type { DisplayStep } from '@/lib/display-step'
import { RESULT_WORDS } from '@/lib/action-vocabulary'
import { useTranslation } from '@/i18n'
import type { TFunction } from 'i18next'

interface EditorStepDetailProps {
  step: DisplayStep
  subAction: LiveSubAction | null
}

function resultWord(sub: LiveSubAction): string {
  return sub.result === 'no-input' ? RESULT_WORDS['no-input'] : sub.result
}

function resultColour(sub: LiveSubAction): string {
  if (sub.result === 'no-input') return 'text-muted-foreground'
  return sub.result === 'success' ? 'text-emerald-500' : 'text-red-500'
}

function buildSubActionSections(t: TFunction, sub: LiveSubAction): SectionDef[] {
  const sections: SectionDef[] = []

  if (sub.observation) {
    sections.push({
      key: 'observation',
      label: t('editor.detail.observation'),
      icon: Eye,
      content: sub.observation,
      duration: sub.phaseDurations?.observe ?? null,
    })
  }

  if (sub.reasoning) {
    sections.push({
      key: 'reasoning',
      label: t('editor.detail.reasoning'),
      icon: Brain,
      content: sub.reasoning,
      duration: sub.phaseDurations?.plan ?? null,
    })
  }

  if (sub.plannedAction != null) {
    sections.push({
      key: 'plannedAction',
      label: t('editor.detail.plannedAction'),
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
      label: t('editor.detail.verifier'),
      icon: ShieldCheck,
      content: sub.verifierReasoning,
      duration: sub.phaseDurations?.verify ?? null,
    })
  }

  return sections
}

function buildStepSections(t: TFunction, step: DisplayStep): SectionDef[] {
  const sections: SectionDef[] = []

  if (step.observation) {
    sections.push({
      key: 'observation',
      label: t('editor.detail.observation'),
      icon: Eye,
      content: step.observation,
      duration: null,
    })
  }

  if (step.reasoning) {
    sections.push({
      key: 'reasoning',
      label: t('editor.detail.reasoning'),
      icon: Brain,
      content: step.reasoning,
      duration: null,
    })
  }

  if (step.plannedAction != null) {
    sections.push({
      key: 'plannedAction',
      label: t('editor.detail.plannedAction'),
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
  const { t } = useTranslation()
  if (subAction) {
    const sections = buildSubActionSections(t, subAction)
    return (
      <div className="p-3 space-y-3 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{t('editor.detail.subAction', { number: subAction.index + 1 })}</span>
          <span className={`text-xs font-medium ${resultColour(subAction)}`}>
            {resultWord(subAction)}
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

  const sections = buildStepSections(t, step)
  return (
    <div className="p-3 space-y-3 min-w-0">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{t('editor.detail.step', { number: step.stepOrder + 1 })}</span>
        {step.confidence != null && (
          <ConfidenceBadge confidence={step.confidence} />
        )}
      </div>

      {sections.length > 0 ? (
        <ReasoningPipeline mode="static" sections={sections} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('editor.detail.noReasoning')}</p>
      )}

      {step.error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-2 text-xs break-words [overflow-wrap:anywhere]">
          {step.error}
        </div>
      )}
    </div>
  )
}
