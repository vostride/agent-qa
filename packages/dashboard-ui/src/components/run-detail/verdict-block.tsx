// ONE MEMBER'S VERDICT, AS A PERSON READS IT (406-01 · DETL-04, D-05 / D-10 / D-12;
// grown in 406-06 · D-02 / D-08 / D-09 / D-11).
//
// PRESENTATIONAL, AND DELIBERATELY SO. This component takes a view the page already projected out
// of `analysis.get` and paints it. It fetches nothing, holds no run id, derives no fact and
// composes no prose: the sentence is the op's own bytes, copied through, and every other string it
// shows — the provenance chip, the lifecycle marker, the sibling line, the cited-step label — comes
// out of `lib/analysis-view.ts`, which is pure and separately pinned. THE ONLY BRANCHES HERE ARE
// PRESENCE BRANCHES: is there a marker, are there cited steps, are there siblings. Anything that
// had to be decided was decided in the projection.
//
// THE SENTENCE IS A PRODUCER STRING, rendered as the stored text. It quotes the failing
// step's recorded error verbatim — Playwright's own text — inside `observed (step N): "…"`, so a
// declared value in it shows as the `[secret:<name>]` the producer recorded.
//
// NO COPY AFFORDANCE AND NO TITLE WRITE. WINDOWS #302/#303 name the clipboard and the
// document title as unenumerated egress sinks for RESTORED cleartext: the local door restores
// declared secrets into this sentence for the person reading the page, and a copy button would
// move that value into a bug report, while a title write would move it into a bfcache entry and
// every window-title log. Neither is here; the sentence stays where the reader can see it.
//
// TEXT NODES AND ELEMENTS, NEVER MARKUP. Nothing in this file hands React raw HTML —
// the acceptance gate greps this file for the escape hatch's name and requires zero occurrences,
// which is why the name is not written anywhere in it. A jsdom cell feeds this component markup
// and asserts no element was constructed.
//
// A CITED STEP IS A BUTTON AND A SIBLING IS A BUTTON, because both DO something: the
// first selects that step in this member's tree through the page's existing `Selection`, the second
// narrows the member filter to that sibling's group. Neither mints a route, an id spelling or a
// scroller of its own — the page owns all three and this component hands it two handles.
//
// A CITED STEP THE VIEW DOES NOT NAME IS NOT RENDERED AS A DEAD CHIP. An index the
// projection did not carry never becomes a button, and a button whose step the page cannot resolve
// is a no-op there rather than a throw here.
//
// A CITED ARTIFACT OPENS IN THE DRAWER, AND ONLY THE PAGE KNOWS WHERE THAT IS (406-08 · D-02,
// second half). The block hands up a sha and nothing else: no run id, no URL, no window. The page
// turns that sha into the drawer's screenshot tab, whose `src` the one route minter mints. Rendering
// the picture here instead was rejected — it duplicates the overview's rendering and grows the page
// once per red member on a 40-red run.
//
// AND AN ARTIFACT WHOSE BYTES ARE GONE IS STILL THERE, AS A CHIP. The absent ref
// keeps its place in the row wearing `EvidenceIncomplete inline` — never dropped (a reader would
// count the links and conclude the verdict cited fewer things than it did) and never a button (an
// affordance that opens nothing is the worse lie the one component's own header names). Its
// siblings that ARE present stay clickable, and a count line under the row says how many of how
// many are gone, so a reader scanning collapsed groups can see evidence is missing without opening
// one. The sentence, the provenance, the marker and the member's outcome badge are all untouched:
// ONE MISSING SCREENSHOT IS NOT AN UNTRUSTWORTHY VERDICT, and the whole-verdict badge that would
// say otherwise was rejected. Bundle-level `evidence-incomplete` semantics belong to bundles.
//
// THE RECORDS ON THE FAILING PATH are the verdict's own declaration, listed when it made one and
// absent otherwise.
//
// `data-*` DESCRIBES WHAT IS RENDERED, not what was passed (the banner's `showingFull` lesson).

import { EvidenceIncomplete } from "@/components/run-detail/evidence-incomplete"
import {
  CITED_ARTIFACT_LABEL,
  citedStepLabel,
  MEMORY_ON_PATH_RECORDS_LABEL,
  type MemberVerdictView,
} from "@/lib/analysis-view"
import { memberHandleLabel } from "@/lib/run-detail-view"

interface VerdictBlockProps {
  view: MemberVerdictView
  /** Select the cited step in this member's tree — `(memberHandle, stepOrdinal)`. */
  onCitedStep: (testIndex: number, stepIndex: number) => void
  /** Narrow the member filter to a cluster sibling's own group. */
  onSelectMember: (testIndex: number) => void
  /** Open the cited artifact — the sha is the whole handle the page needs. */
  onCitedArtifact: (sha: string) => void
}

/** The one look every affordance in this block wears — a quiet inline chip, never a coloured link. */
const AFFORDANCE_CLASS =
  "rounded-[2px] border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] " +
  "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"

/** An EXPOSED record: a quiet chip, the same weight as every other read-only fact in the block. */
const ON_PATH_CHIP_CLASS =
  "inline-block max-w-full break-all rounded-[2px] border border-border/60 bg-background/60 px-1.5 py-0.5 font-mono text-xs " +
  "text-muted-foreground"

export function VerdictBlock({
  view,
  onCitedStep,
  onSelectMember,
  onCitedArtifact,
}: VerdictBlockProps) {
  return (
    // WHERE THE HEADER'S VERDICT DOOR LANDS (425-09 · D-11, UI-SPEC S4 / Color 2). `-1` is
    // reachable programmatically and skipped by Tab, so a reader working through a failed run does
    // not stop on every sentence on the way to the controls. The ring keys on `:focus` rather than
    // `:focus-visible` because the door is activated by pointer as often as by keyboard, and a
    // browser suppresses `:focus-visible` after a click — which would move a reader somewhere and
    // then show them nothing about where they landed.
    <div
      data-verdict-block
      data-verdict-producer={view.producer}
      data-verdict-confidence={String(view.confidence)}
      tabIndex={-1}
      className="mx-2 mt-1 mb-1.5 rounded-[2px] border border-border/60 bg-muted/10 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50"
    >
      <span data-verdict-sentence className="select-text text-foreground/80">
        {view.sentence}
      </span>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        {view.marker === undefined ? null : (
          <span data-verdict-marker={view.marker} className="whitespace-nowrap text-amber-500">
            {view.markerText}
          </span>
        )}
        <span data-verdict-provenance className="whitespace-nowrap">
          {view.provenance}
        </span>
      </div>

      {view.citedSteps.length === 0 ? null : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {view.citedSteps.map((stepIndex) => (
            <button
              key={stepIndex}
              type="button"
              data-cited-step={String(stepIndex)}
              onClick={() => { onCitedStep(view.testIndex, stepIndex) }}
              className={AFFORDANCE_CLASS}
            >
              {citedStepLabel(stepIndex)}
            </button>
          ))}
        </div>
      )}

      {view.citedArtifacts.length === 0 ? null : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {view.citedArtifacts.map((ref) =>
            // `ref.incomplete ?` IS SPELLED HERE, ONCE, AND NOT HOISTED — 406-11's mutation legs
            // match this expression literally. One leg drops the absent ref from the row, the other
            // renders it as an ordinary link; both edit this ternary and both must red a cell.
            ref.incomplete ? (
              <span
                key={ref.id}
                data-cited-artifact-state="unavailable"
                data-cited-artifact-sha={ref.sha}
                className="inline-flex items-center"
              >
                <EvidenceIncomplete variant="inline" />
              </span>
            ) : (
              <button
                key={ref.id}
                type="button"
                data-cited-artifact={ref.sha}
                onClick={() => { onCitedArtifact(ref.sha) }}
                className={AFFORDANCE_CLASS}
              >
                {CITED_ARTIFACT_LABEL}
              </button>
            ),
          )}
        </div>
      )}

      {view.missingEvidence === undefined ? null : (
        <div
          data-evidence-incomplete={`${String(view.missingEvidence.missing)}/${String(view.missingEvidence.total)}`}
          className="mt-1.5 text-[10px] text-muted-foreground"
        >
          {view.missingEvidenceText}
        </div>
      )}

      {view.memoryOnPath === undefined ? null : (
        <>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span data-misdirection-on-path className="min-w-0">
              {view.memoryOnPath.onPathText}
            </span>
          </div>

          {view.memoryOnPath.onPath.length === 0 ? null : (
          <dl className="mt-2 space-y-2 text-xs text-muted-foreground">
            <div data-misdirection-exposed={String(view.memoryOnPath.onPath.length)}>
              <dt className="mb-1">{MEMORY_ON_PATH_RECORDS_LABEL}</dt>
              <dd>
                <ul className="flex flex-wrap items-start gap-1">
                  {view.memoryOnPath.onPath.map((entry) => (
                    <li key={entry.recordId} className="min-w-0 max-w-full">
                      <span
                        data-misdirection-on-path-record={entry.recordId}
                        data-misdirection-trust={entry.trust}
                        className={ON_PATH_CHIP_CLASS}
                      >
                        {entry.recordId}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
          )}
        </>
      )}

      {view.siblings.length === 0 ? null : (
        <div
          data-cluster-siblings={String(view.siblings.length)}
          className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
        >
          <span className="whitespace-nowrap">{view.siblingText}</span>
          {view.siblings.map((sibling) => (
            <button
              key={sibling.testIndex}
              type="button"
              data-cluster-sibling={String(sibling.testIndex)}
              onClick={() => { onSelectMember(sibling.testIndex) }}
              className={AFFORDANCE_CLASS}
            >
              {memberHandleLabel(sibling.testIndex)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
