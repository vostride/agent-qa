import { t, useTranslation } from '@/i18n'

export type EvidenceScope = 'step' | 'sub-action'
export const EVIDENCE_SCOPES = ['step', 'sub-action'] as const satisfies readonly EvidenceScope[]

export const SCOPE_LINE_STEP = (step: number, total: number) =>
  t('evidence.scope.step', { step, total })
export const SCOPE_LINE_SUB_ACTION = (number: number, total: number, step: number) =>
  t('evidence.scope.subAction', { number, total, step })

export function EvidenceScopeLine({ scope, step, total, subAction }: {
  scope: EvidenceScope
  step: number
  total: number
  subAction?: number
}) {
  useTranslation()
  if (scope === 'sub-action' && subAction === undefined) return null
  return (
    <div data-evidence-scope={scope} className="shrink-0 px-3 py-2 border-b text-xs text-muted-foreground tabular-nums">
      {scope === 'step' ? SCOPE_LINE_STEP(step, total) : SCOPE_LINE_SUB_ACTION(subAction!, total, step)}
    </div>
  )
}
