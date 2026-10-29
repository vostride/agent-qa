import { Fragment, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Mark, MarkPreviewBasis } from '@vostride/agent-qa-schema'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  TECHNICAL_DETAILS_LABEL,
  TECHNICAL_DETAILS_ROW_LABELS,
  basisDetailText,
  type TechnicalDetailsRow,
} from '@/lib/feedback-view'

export interface FeedbackTechnicalDetailsProps {
  kind?: Mark
  address: string
  testId?: string
  recordIds?: readonly string[]
  basis?: MarkPreviewBasis
}

/**
 * the only component that renders a raw mark word or an id as text. Collapsed, at the foot
 * of the composer; a row whose fact is absent is not rendered.
 */
export function FeedbackTechnicalDetails({ kind, address, testId, recordIds = [], basis }: FeedbackTechnicalDetailsProps) {
  const rows: [TechnicalDetailsRow, ReactNode][] = []
  if (kind !== undefined) rows.push(['kind', kind])
  rows.push(['address', address])
  if (testId) rows.push(['testId', testId])
  if (recordIds.length > 0) rows.push(['records', recordIds.join(', ')])
  if (basis !== undefined) rows.push(['basis', basisDetailText(basis)])
  return (
    <Collapsible className="mt-6">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {TECHNICAL_DETAILS_LABEL}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div data-feedback-technical className="mt-2 rounded-md bg-muted/40 px-3 py-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {rows.map(([row, value]) => (
              <Fragment key={row}>
                <dt className="text-muted-foreground">{TECHNICAL_DETAILS_ROW_LABELS[row]}</dt>
                <dd data-technical-row={row} className="font-mono break-all select-text">
                  {value}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
