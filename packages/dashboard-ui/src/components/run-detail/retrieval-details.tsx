// The only section where storage vocabulary and record ids may appear.

import { Fragment, useId, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NESTED_TRIGGER_CLASS } from "./knowledge-brief-line"
import { KnowledgeStepDetail } from "./knowledge-step-detail"
import { RecordIdCopy } from "./record-id-copy"
import {
  LEDGER_ROW_LABELS,
  MEMORY_CHANGES_HEADING,
  RETRIEVAL_DETAILS_LABEL,
  STEP_NO_BRIEF_TEXT,
  ledgerEventText,
  ledgerValidityText,
  promotionPathLabel,
  type ChangeLedgerView,
  type LedgerRow,
  type LedgerView,
  type StepRowView,
} from "@/lib/knowledge-view"

export function RetrievalDetails({ ledger }: { ledger: LedgerView }) {
  const triggerId = useId()
  return (
    <section data-knowledge-section="retrieval-details" aria-labelledby={triggerId} className="border-t pt-4">
      <Collapsible>
        <CollapsibleTrigger id={triggerId} className={NESTED_TRIGGER_CLASS}>
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          {RETRIEVAL_DETAILS_LABEL}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4 space-y-4">
          <p data-used-summary className="text-xs text-muted-foreground tabular-nums">{ledger.summary}</p>
          {ledger.steps.length > 0 ? (
            <ul className="space-y-1">
              {ledger.steps.map(row => (
                <StepRow key={`${String(row.testIndex)}:${String(row.stepIndex)}`} row={row} />
              ))}
            </ul>
          ) : null}
          {ledger.changes.length === 0 ? null : (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{MEMORY_CHANGES_HEADING}</p>
              {ledger.changes.map(entry => (
                <ChangeLedgerEntry key={entry.key} entry={entry} />
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

// Closed by default, which bounds the DOM; a row that served nothing stays and says so.
function StepRow({ row }: { row: StepRowView }) {
  return (
    <Collapsible asChild>
      <li
        data-step-index={String(row.stepIndex)}
        data-test-index={String(row.testIndex)}
        data-plan-source={row.planSource}
        data-brief-lines={String(row.briefLines)}
        data-canary-lines={String(row.canaryLines)}
      >
        <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1 text-left text-xs font-medium hover:text-foreground">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="truncate">{row.title}</span>
          {row.noBrief === true ? (
            <span className="text-xs text-muted-foreground">{STEP_NO_BRIEF_TEXT}</span>
          ) : (
            // flex-wrap lets the badges shrink to their widest one, so the truncating title keeps room.
            <span className="flex flex-wrap items-center gap-1">
              {row.facts.map(fact => (
                <Badge key={fact} variant="outline" className="text-xs font-medium">{fact}</Badge>
              ))}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="bg-muted/40 rounded-[var(--radius)] px-3 py-2 space-y-2">
          <div data-step-detail>
            <KnowledgeStepDetail detail={row.detail} />
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

function lines(values: readonly string[]): ReactNode {
  return values.map((value, index) => (
    <span key={index} className="block">
      {value}
    </span>
  ))
}

/** Record ids, one per line, each followed by its copy button; a line's text stays the id alone. */
function idLines(values: readonly string[]): ReactNode {
  return values.map((value, index) => (
    <span key={index} className="block">
      {value}
      <RecordIdCopy id={value} className="ml-1" />
    </span>
  ))
}

// A row is pushed only when its fact exists; the link's href comes from the view, never a string.
function ChangeLedgerEntry({ entry }: { entry: ChangeLedgerView }) {
  const rows: [LedgerRow, ReactNode][] = [
    ["bucket", entry.bucket],
    ["record", idLines(entry.recordIds)],
  ]
  if (entry.events.length > 0) rows.push(["events", lines(entry.events.map(ledgerEventText))])
  if (entry.promotionPath !== undefined) rows.push(["promotion", promotionPathLabel(entry.promotionPath)])
  if (entry.promotionReceiptDigest !== undefined) rows.push(["receipt", entry.promotionReceiptDigest])
  if (entry.evidenceTokens.length > 0) rows.push(["evidence", lines(entry.evidenceTokens)])
  if (entry.observationIds.length > 0) rows.push(["observation", lines(entry.observationIds)])
  if (entry.sourceRunIds.length > 0) rows.push(["sourceRun", lines(entry.sourceRunIds)])
  if (entry.validity !== undefined) rows.push(["validity", ledgerValidityText(entry.validity)])
  if (entry.ref !== undefined) {
    rows.push([
      "link",
      entry.href === undefined ? entry.ref : (
        <a href={entry.href} className="text-primary underline-offset-4 hover:underline">
          {entry.ref}
        </a>
      ),
    ])
  }
  return (
    <dl
      data-ledger-changes
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-xs"
    >
      {rows.map(([row, value]) => (
        <Fragment key={row}>
          <dt className="text-muted-foreground">{LEDGER_ROW_LABELS[row]}</dt>
          <dd data-ledger-row={row} className="font-mono break-all select-text">
            {value}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}
