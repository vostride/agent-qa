import type * as React from "react"
import { useNavigate } from "react-router"
import { routes } from "@/lib/routes"
import { toast } from "sonner"
import {
  ArrowUpRight, Clock, Cpu, ExternalLink,
  RotateCcw, ChevronRight, Keyboard, PanelRightOpen,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ShortcutLegend } from "@/components/shortcut-hints"
import { PostProcessingChips } from "@/components/run-detail/post-processing-chips"
import { RetrievalRungBanner } from "@/components/run-detail/retrieval-rung-banner"
import { RunUsageCard } from "@/components/run-detail/run-usage-card"
import { FeedbackEntryButton, type FeedbackEntryButtonProps } from "@/components/run-detail/feedback-entry"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import type { PostProcessingView } from "@/lib/post-processing-view"
import type { RunRow } from "@/lib/api"
import { triggerRun } from "@/lib/api"
import { TOKEN_USAGE_TRIGGER_LABEL, tokenPairLine } from "@/lib/run-detail-view"
import { statusBadgeLook } from "@/lib/status"
import { cn, formatDuration } from "@/lib/utils"
import type { RecordedRetrievalRung, RunModelSummary, RunTokenTotals } from "@vostride/agent-qa-schema"

/**
 * THE HEADER'S VERDICT BADGE, ADDRESSABLE (2026-08-26, Phase 404 · LIFE-01, D-13/D-15).
 *
 * The badge's visible text is a LABEL — title-cased, and `Cancelled` for a row that says
 * `cancelled`. A DOM cell reading that text would be asserting on presentation, and a page that
 * painted the right word into the wrong element would still pass. The hook below carries the RAW
 * status string instead — the same bytes the dashboard subscriber wrote to the run row at the
 * `verdict` envelope — so "the viewer was moved to run detail AND the verdict is painted in its
 * header" is one selector against one fact.
 *
 * WHY THE SWITCH BECAME A LOOKUP. The attribute belongs on the badge ROOT, and seven `return`
 * arms meant seven places for it to drift out of. One render site is one place it can be wrong.
 * Nothing about what is painted changed.
 *
 * ENLARGED, NOT RE-PALETTED (2026-09-22, Phase 425 · D-02, PXH-RUN-01). Dominance comes from size
 * and fill in an unchanged row order: the size classes go through `cn` so tailwind-merge drops the
 * `Badge` base `text-xs px-2 py-0.5`, while `statusBadgeLook` keeps deciding the colour. A second
 * palette would be two answers to one question about one run.
 */
function StatusBadge({ status }: { status: string }) {
  const { label, ...look } = statusBadgeLook(status)
  return (
    <Badge
      data-verdict-badge={status}
      {...look}
      className={cn(look.className, "text-sm font-medium px-2 py-1 rounded-sm")}
    >
      {label}
    </Badge>
  )
}

interface RunNavbarProps {
  run: RunRow
  /**
   * The run's model spend, as the read op summed it (405-11 · D-06).
   *
   * OPTIONAL BECAUSE THE READ MAY NOT HAVE LANDED — `undefined` here means "nobody has answered
   * yet", which is a different fact from a projection that answered "nothing was measured". The
   * first renders no line at all; the second renders the not-measured sentence, because a run
   * that recorded no usage is a fact worth stating. The header previously summed three counters
   * off v1 step rows and guarded the span on a positive total, which spelled "unmeasured" and
   * "zero" identically — the exact collapse D-06 exists to prevent.
   */
  tokens?: RunTokenTotals
  /**
   * Who answered this run, as `runs.detail` summarised it (425-05 · D-23).
   *
   * UNDEFINED IS TWO FACTS THIS HEADER CANNOT TELL APART, and both render no model line: the read
   * has not landed, or the run is a pre-423 one that recorded no model identity at all. Neither is
   * a licence to fall back to the legacy model fields on the run row — those name what the host
   * was configured with, not what answered THIS run, and substituting one for the other would make
   * a claim about a run out of a fact about a machine. Those fields, and the icon item that
   * announced them, left this file in 425-05 and a grep gate keeps them out.
   */
  models?: RunModelSummary
  shortcutsOpen: boolean
  onToggleShortcuts: () => void
  /**
   * The drawer tabs this header can ASK FOR. Narrowed to the two the artifact record feeds
   * (407-05 · D-02): the v1 `memory` tab is deleted, and `m` reaches the Knowledge tab through
   * the page's own shortcut map rather than through this prop.
   */
  onOpenArtifacts?: (tab: "test" | "config") => void
  /**
   * The post-processing projection to paint beside the verdict badge (404-07, D-20).
   *
   * TWO PROPS AND NOT ONE, because "no read has landed yet" and "this header was never wired for
   * chips" are different facts that a single optional prop would spell identically. The navbar is
   * PRESENTATIONAL (400 D-13): it neither knows a run id nor asks anything, so it cannot tell those
   * two apart on its own, and a chip area that appeared out of a `undefined` would put a permanent
   * placeholder into every surface that renders this header without a client behind it.
   */
  postProcessing?: PostProcessingView | undefined
  /** Whether a chip client is wired at all. See {@link RunNavbarProps.postProcessing}. */
  hasPostProcessing?: boolean
  /**
   * What pressing the `curation` chip should do (407-09 · LERN-02, D-01).
   *
   * FORWARDED, NOT DECIDED. The navbar is presentational and owns no tab state; the page passes
   * `() => setActiveTab('knowledge')`. Absent → the chip stays the shipped `<span>`, which is what
   * every surface rendering this header without a run-detail page behind it should get.
   */
  onCurationClick?: () => void
  /**
   * What pressing the `analysis` chip should do (425-09 · PXH-RUN-03, D-11).
   *
   * FORWARDED, NOT DECIDED — the same rule as {@link RunNavbarProps.onCurationClick} one door
   * along. Curation always has a half of the Knowledge tab to open, so the page passes its handler
   * unconditionally; analysis has somewhere to go only on a run that produced a verdict, and this
   * header knows neither the run's outcome nor whether a block is mounted. Absent → the analysis
   * indicator stays the focusable `<span>` it has always been, which is what every surface that
   * renders this header without a run-detail page behind it should get.
   */
  onOpenVerdict?: () => void
  /**
   * The rung that served THIS run, as the durable `runs.knowledge` read recorded it (407-10 · D-13).
   *
   * UNDEFINED IS TWO FACTS THIS HEADER CANNOT TELL APART, and both render the same nothing: the
   * read has not landed, or the run recorded no rung (a pre-407 run, or a project with no
   * knowledge reader bound — D-16). That collapse is deliberate here, unlike `postProcessing`
   * above: a chip area exists to say WHICH stage is pending, whereas the only honest thing to
   * paint about a rung nobody has stated is no element at all.
   *
   * IT IS THE RECORDED VALUE AND NEVER A HOST PROBE. Fixing the machine tomorrow must not change
   * what this header says about a run that already happened; the page reads it through
   * `bannerRung`, which is where the "no store bound is not a rung" judgement lives.
   */
  retrievalRung?: RecordedRetrievalRung
  /**
   * The test-level feedback door beside the verdict (426 D-02). Absent means the element is absent,
   * never disabled: the page passes it only when the target member can be marked at all.
   */
  feedbackEntry?: Omit<FeedbackEntryButtonProps, "scope">
}

export function RunNavbar({
  run,
  tokens,
  models,
  shortcutsOpen,
  onToggleShortcuts,
  onOpenArtifacts,
  postProcessing,
  hasPostProcessing = false,
  onCurationClick,
  onOpenVerdict,
  retrievalRung,
  feedbackEntry,
}: RunNavbarProps) {
  const navigate = useNavigate()
  const isSuiteParent = run.suiteId != null && run.parentRunId == null
  const sourceHref = isSuiteParent && run.suiteId
    ? routes.suiteView(run.suiteId)
    : run.testId
      ? routes.testView(run.testId)
      : null
  const sourceLabel = isSuiteParent && run.suiteId ? "Open suite" : "Open test"

  const farmUrl = (run.metadata as Record<string, unknown>)?.farmSessionUrl as string | undefined

  const handleRerun = () => {
    const wasLocal = run.attributes["agent-qa.runner"] === "local"
    triggerRun({ file: run.filePath ?? run.name, local: wasLocal })
      .then((result) => {
        toast.success("Re-run started")
        navigate(routes.runLive(result.runId))
      })
      .catch(() => toast.error("Failed to start re-run"))
  }

  return (
    // A MIN-HEIGHT BLOCK, NOT A FIXED ONE (2026-09-22, Phase 425 · D-03, PXH-RUN-07, WINDOWS #459).
    //
    // The banner is a second full-width row inside this wrapper rather than a sibling of the
    // page's panel group, so the header stays ONE block the layout can measure. What it measures
    // is no longer a number anyone wrote down: 56px is the header row's MINIMUM, the page's panel
    // group is already `min-h-0 flex-1` inside a flex column, and flex takes whatever the header
    // turns out to be. That is what lets the header grow a second row instead of overlapping when
    // the width runs out — the old fixed-height class and the "56, or 56 + 28" arithmetic that
    // went with it could only clip.
    //
    // THE BREAKPOINT IS A CONTAINER QUERY, and deliberately not a viewport one. A 1280px viewport
    // at 200% zoom is a 640px container and a ~400px viewport is a ~400px container: one rule
    // sends both down the stacked path, and any narrower shell this header is ever dropped into
    // inherits it without a second breakpoint being invented.
    //
    // THE STEP IS 64rem, NOT 48rem (WINDOWS #480). One row needs about 890px once 426's entry sits
    // beside the verdict, so beside the 192px sidebar a ~1000px page stayed one row at 48rem and the
    // analysis chip painted over the badge and the entry. A 1280px page is a 1088px container and
    // keeps its single row.
    //
    // It is NOT a third pane and NOT a toast: 403's two-pane rule holds on the live page and the
    // same discipline holds here.
    <div className="shrink-0 @container">
    <div className="flex flex-col gap-y-2 min-h-14 border-b px-4 py-2 min-w-0 @5xl:flex-row @5xl:items-center @5xl:justify-between @5xl:gap-y-0 @5xl:py-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={() => navigate(routes.runs)}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          Runs
        </button>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {/*
          THE ONE FLEXIBLE ITEM (D-04). Everything else on this row is `shrink-0`, so a long name
          spends its own width and then truncates rather than pushing the verdict out of view. The
          floor keeps it from truncating to nothing. The full name is still reachable — here in
          `title`, and in the page title, which already carries it (423 D-24).
        */}
        <span className="text-sm font-medium truncate min-w-[96px]" title={run.name}>
          {run.name}
        </span>
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={sourceLabel}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {/* The verdict, then the slot after it, filled by Phase 426's feedback entry. */}
        <StatusBadge status={run.status} />
        {feedbackEntry === undefined ? null : (
          <FeedbackEntryButton scope="test" {...feedbackEntry} />
        )}
      </div>

      {/*
        ROW 2 WHEN STACKED, THE RIGHT CLUSTER WHEN NOT. The meta wraps before the actions do, and
        the actions sit in an `ml-auto` cluster that is always this row's last child — so at ~400px
        nothing hides, nothing folds into an overflow menu and nothing overlaps (D-05).
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 shrink-0">
        {/* D-20: the lifecycle story on one line — execution truth, then post-processing truth. */}
        {hasPostProcessing ? (
          <PostProcessingChips
            view={postProcessing}
            onCurationClick={onCurationClick}
            onOpenVerdict={onOpenVerdict}
          />
        ) : null}
        {/*
          THE TOKEN LINE IS A GLANCE AND A DOOR (425-05 · D-21/D-22, UI-SPEC S6). It says the pair
          and nothing else — the total, the provider's cached input, the coverage caveat and the
          model identity are all one focus away, in the card. The root is a `span` with `tabIndex`
          rather than a `button` because there is nowhere to go: the card IS the destination, and a
          button would promise a page that does not exist. Rendered only when `tokens` is not
          undefined, which is the shipped rule — no read yet, no element.
        */}
        {tokens === undefined ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-run-token-summary
                tabIndex={0}
                className="text-xs text-muted-foreground flex items-center gap-1 tabular-nums cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Cpu className="h-3.5 w-3.5" />
                {tokenPairLine(tokens)}
                <span className="sr-only">{TOKEN_USAGE_TRIGGER_LABEL}</span>
              </span>
            </TooltipTrigger>
            <RunUsageCard tokens={tokens} models={models} />
          </Tooltip>
        )}
        <span data-run-duration className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {formatDuration(run.duration)}
        </span>

        <div className="ml-auto flex items-center gap-3">
        <div className="h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open run artifacts"
          title="Run details (I/C/M)"
          onClick={() => onOpenArtifacts?.("test")}
        >
          <PanelRightOpen className="h-3.5 w-3.5" />
        </Button>

        <div className="relative">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Keyboard shortcuts"
            aria-expanded={shortcutsOpen}
            title="Shortcuts (Shift+?)"
            onClick={onToggleShortcuts}
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
          {shortcutsOpen ? (
            <div
              role="dialog"
              aria-label="Keyboard shortcuts"
              className="absolute right-0 top-full z-50 mt-2 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md"
            >
              <div className="space-y-3">
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Navigation</h4>
                  <ShortcutLegend hints={[
                    { key: '← →', label: 'Previous / next action' },
                    { key: 'Space', label: 'Play / pause' },
                    { key: 'V', label: 'Frames / Video' },
                    { key: "\u2191 / K", label: "Previous item" },
                    { key: "\u2193 / J", label: "Next item" },
                    { key: "Shift+\u2191", label: "Previous step" },
                    { key: "Shift+\u2193", label: "Next step" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Tabs</h4>
                  <ShortcutLegend hints={[
                    { key: "1", label: "Overview" },
                    { key: "2", label: "Env" },
                    { key: "3", label: "Network" },
                    { key: "4", label: "Console" },
                    { key: "5", label: "ARIA" },
                    { key: "6", label: "A11y" },
                    { key: "7", label: "Knowledge" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Phases</h4>
                  <ShortcutLegend hints={[
                    { key: "Shift+1", label: "Toggle Observe" },
                    { key: "Shift+2", label: "Toggle Plan" },
                    { key: "Shift+3", label: "Toggle Execute" },
                    { key: "Shift+4", label: "Toggle Verify" },
                  ]} />
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Actions</h4>
                  <ShortcutLegend hints={[
                    { key: "I", label: "Details: Attributes" },
                    { key: "C", label: "Artifacts: Config" },
                    { key: "M", label: "Knowledge tab" },
                    { key: "R", label: "Re-run" },
                    { key: "Shift+?", label: "Shortcuts" },
                    { key: "Esc", label: "Close" },
                  ]} />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Re-run"
          title="Re-run (R)"
          onClick={handleRerun}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>

        {farmUrl && (
          <a href={farmUrl} target="_blank" rel="noopener noreferrer" title="BrowserStack">
            <Button variant="ghost" size="icon-sm">
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </a>
        )}
        </div>
      </div>
    </div>
    <RetrievalRungBanner rung={retrievalRung?.rung} reason={retrievalRung?.reason} />
    </div>
  )
}
