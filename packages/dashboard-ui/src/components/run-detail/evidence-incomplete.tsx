import { EvidenceState } from '@/components/run-detail/evidence-state'
import { EVIDENCE_COPY, EVIDENCE_INCOMPLETE_EXPLANATION } from '@/lib/evidence-state-view'
import { EVIDENCE_INCOMPLETE_LABEL } from '@/lib/run-detail-view'
import { useTranslation } from '@/i18n'

export type EvidenceIncompleteVariant = 'pane' | 'inline'

export function EvidenceIncomplete({ variant }: { variant: EvidenceIncompleteVariant }) {
  useTranslation()
  return (
    <EvidenceState
      kind="frame"
      state="unavailable"
      incomplete
      variant={variant}
      title={variant === 'inline' ? EVIDENCE_INCOMPLETE_LABEL() : EVIDENCE_COPY.frame.unavailable.title}
      explanation={EVIDENCE_INCOMPLETE_EXPLANATION()}
    />
  )
}
