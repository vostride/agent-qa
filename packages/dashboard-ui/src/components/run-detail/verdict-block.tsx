// No copy button or title write: restored secrets in the sentence must not reach either one.

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
    // `tabIndex` -1 is off the tab order; the ring is `:focus`, as a click hides `:focus-visible`.
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
