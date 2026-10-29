// THE EXPANDED STEP ROW.
//
// IT FILLS THE SLOT 407-02 LEFT. `tab-knowledge.tsx` shipped `<div data-step-detail />` as a
// structural anchor precisely so this plan would be an addition rather than a re-shaping of the
// row; this component is what goes in it.
//
// IT IS PRESENTATIONAL AND KNOWS NO RUN. It takes a `StepDetailView` and paints it. Every sentence
// it renders — the channel eyebrows, the cut-candidates label, the replay/hint sentence, the rung
// line — is an exported constant or a function of `lib/knowledge-view.ts`. Nothing here decides a
// word.
//
// ONLY WHAT WAS SERVED. This block lives inside Retrieval details, so a channel the step
// was not served is left out rather than named empty; a step served nothing keeps its row, which
// says `no brief served`. Every id carries a copy button, and the plan source is plain text.
//
// THE PAGE IS THE OVERFLOW STRATEGY, not virtualisation (UI-SPEC). Step rows render collapsed, so
// the tab's DOM is bounded by step count; the one unbounded case — a single step served hundreds
// of lines — is bounded by `channelPage` and a `Show all {n} lines` disclosure. The remainder is a
// SECOND `<ul>` inside the disclosure rather than more `<li>`s inside the first, because an `<li>`
// nested under a `<div>` under a `<ul>` is not a list.
//
// ALL TEXT GOES THROUGH REACT TEXT NODES. No raw-HTML injection escape hatch appears anywhere in
// this file — a grep for React's one is an acceptance criterion. Producer strings (caution
// summaries here, brief summaries in `KnowledgeBriefLine`) are shown as written.

import { ChevronRight } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { KnowledgeBriefLine, NESTED_TRIGGER_CLASS } from "./knowledge-brief-line"
import { RecordIdCopy } from "./record-id-copy"
import {
  CHANNEL_EYEBROWS,
  CHANNEL_PAGE_SIZE,
  channelPage,
  ledgerRungLine,
  type BriefLineView,
  type PlanSourceView,
  type StepDetailView,
} from "@/lib/knowledge-view"

const EYEBROW_CLASS = "text-xs uppercase tracking-wider font-medium text-muted-foreground"

/** Children of a section indent by the chevron width — `artifact-config-tab.tsx`'s own offset. */
const CHANNEL_LIST_CLASS = "pl-5 space-y-2"

/** A record id or a cut-candidate line: mono, `tabular-nums` so a column of scores lines up. */
const MONO_CLASS = "font-mono text-xs text-muted-foreground tabular-nums"

/** The cut ledger's own eyebrow — the fourth sub-section caption of the UI-SPEC's list. */
const CUT_EYEBROW = "CUT CANDIDATES"

export function KnowledgeStepDetail({ detail }: { detail: StepDetailView }) {
  return (
    <div className="space-y-4">
      {detail.channel1.length > 0 ? <Channel1 lines={detail.channel1} /> : null}

      {detail.channel2.length > 0 ? (
        <section data-ledger-channel="2" className="space-y-2">
          <p className={EYEBROW_CLASS}>{CHANNEL_EYEBROWS[2]}</p>
          <ul className={CHANNEL_LIST_CLASS}>
            {detail.channel2.map(trace => (
              <li key={trace.id} data-served-channel="2" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* This id is a flex item sized from its own content, so its min-content
                    contribution would be the whole unbroken record id. `overflow-wrap: anywhere`
                    is the value that reduces it; `break-word` would not. Applied here rather than
                    in the shared mono constant. */}
                <span className="flex min-w-0 items-center gap-1">
                  <span className={`${MONO_CLASS} wrap-anywhere`}>{trace.id}</span>
                  <RecordIdCopy id={trace.id} />
                </span>
                <span className="text-xs text-muted-foreground">{trace.detailLevel}</span>
                <span className={`${MONO_CLASS} wrap-anywhere`}>{trace.bodyDigest}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.channel3.length > 0 ? (
        <section data-ledger-channel="3" className="space-y-2">
          <p className={EYEBROW_CLASS}>{CHANNEL_EYEBROWS[3]}</p>
          <ul className={CHANNEL_LIST_CLASS}>
            {detail.channel3.map(caution => (
              <li key={caution.id} data-served-channel="3" className="space-y-1">
                {/* `overflow-wrap: anywhere`, NOT `break-word`: a caution summary is regularly one
                    unbroken token, and only `anywhere` participates in intrinsic sizing. */}
                <span className="block text-xs wrap-anywhere">{caution.summary}</span>
                <div className="flex min-w-0 items-center gap-1">
                  <p className={`${MONO_CLASS} min-w-0 wrap-anywhere`}>{caution.id}</p>
                  <RecordIdCopy id={caution.id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detail.cut === undefined ? null : (
        <div data-cut-candidates={String(detail.cut.lines.length)}>
          <Collapsible>
            <CollapsibleTrigger className={NESTED_TRIGGER_CLASS}>
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              {detail.cut.label}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-1">
              <p className={EYEBROW_CLASS}>{CUT_EYEBROW}</p>
              <ul className={CHANNEL_LIST_CLASS}>
                {/* Only the LEADING token of this sentence is unbroken — the record id — but that
                    is enough to set the line's min-content width, so it gets the same treatment at
                    the same use site. The spaced leg/rank/score remainder is unaffected. */}
                {detail.cut.lines.map(candidate => (
                  <li key={candidate.recordId} className={`${MONO_CLASS} wrap-anywhere`}>
                    {candidate.recordId} · leg {candidate.leg} · rank {String(candidate.rank)} · score{" "}
                    {candidate.score.toFixed(3)}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {detail.planSource === undefined ? null : <PlanSourceRow planSource={detail.planSource} />}

      {detail.rung === undefined ? null : (
        <p data-ledger-rung className="text-xs text-muted-foreground">
          {ledgerRungLine(detail.rung.rung, detail.rung.reason)}
        </p>
      )}
    </div>
  )
}

/**
 * Channel 1 — the brief itself, paged.
 *
 * The first {@link CHANNEL_PAGE_SIZE} lines render in the list a reader sees on open; the rest sit
 * in a second list behind the disclosure, so opening it grows the page rather than replacing it.
 */
function Channel1({ lines }: { lines: readonly BriefLineView[] }) {
  const page = channelPage(lines)

  return (
    <section data-ledger-channel="1" className="space-y-2">
      <p className={EYEBROW_CLASS}>{CHANNEL_EYEBROWS[1]}</p>
      <ul className={CHANNEL_LIST_CLASS}>
        {page.lines.map(line => (
          <KnowledgeBriefLine key={line.id} line={line} />
        ))}
      </ul>
      {page.showAllLabel === undefined ? null : (
        <Collapsible>
          <CollapsibleTrigger data-channel-show-all={String(lines.length)} className={NESTED_TRIGGER_CLASS}>
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            {page.showAllLabel}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <ul className={CHANNEL_LIST_CLASS}>
              {lines.slice(CHANNEL_PAGE_SIZE).map(line => (
                <KnowledgeBriefLine key={line.id} line={line} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  )
}

/**
 * The procedure row: which procedure the step's plan came from, and how that went.
 *
 * Plain text since 427 D-19. The SENTENCE is the view's, and a replay that broke reads as a break
 * even at a full check count — that judgement is made once, in `planSourceView`. The tone rides
 * on `data-plan-source-outcome` only.
 */
function PlanSourceRow({ planSource }: { planSource: PlanSourceView }) {
  return (
    <div data-plan-source-outcome={planSource.tone} className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <span className={`${MONO_CLASS} wrap-anywhere`}>{planSource.procedureId}</span>
        <RecordIdCopy id={planSource.procedureId} />
      </div>
      <p className="text-xs">{planSource.sentence}</p>
      {planSource.missReason === undefined ? null : <p className={MONO_CLASS}>{planSource.missReason}</p>}
    </div>
  )
}
