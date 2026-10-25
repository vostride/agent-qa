// THE TWO CHIPS IN THE RUN HEADER (404-07 · LIFE-03, D-20..D-23, T-404-01).
//
// PRESENTATIONAL, AND DELIBERATELY SO (400 D-13). This component takes a view and paints it. It
// opens no socket, holds no timer and does not know a run id — run detail owns the client and hands
// the projection down. A header that fetched for itself would open one client per mount of a
// component that remounts on every tab change, and would be a second answer to "what does this page
// know about this chain".
//
// EVERY VISIBLE SENTENCE COMES FROM `post-processing-view.ts`. This file composes no prose at all:
// it paints `view.word` on the root and `view.card`'s lines in the card, so the words a person
// reads live beside the reasoning for them and cannot drift from the cells that pin them.
//
// THE HEADER IS A GLYPH AND A WORD (425 D-06/D-09). Every detail that used to sit beside the chip —
// the drain posture, the committed counts, the failure reason, the refusal's error — now lives in
// the card behind it, so the header stays scannable and nothing that left is lost.
//
// THE FAILURE TEXT IS A TEXT NODE AND NOTHING ELSE (T-404-01). It is the producer's masked, bounded
// string, forwarded by the route and forwarded again by the projection; React escapes it on the way
// into the DOM and there is no `dangerouslySetInnerHTML` anywhere in this file. A cell feeds it an
// `<img onerror=...>` and asserts no element was created.
//
// THE `data-*` ATTRIBUTES ARE THE CONTRACT 404-08's Playwright cells address on the built bundle.
// `data-chip-status` carries the RAW store word and `data-stage-state` the presentation state, both
// on the root, because a cell reading visible text would be asserting on presentation, and a page
// that painted the right word into the wrong element would still pass.

import { Circle, CircleCheck, CircleDashed, CircleMinus, CircleX, type LucideIcon } from "lucide-react"
import type { ReactElement } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  CHIPS_UNAVAILABLE_TEXT,
  DOOR_LINE_TEXT,
  POST_PROCESSING_LOADING_LABEL,
  POST_PROCESSING_UNAVAILABLE_WORD,
  curationChipAccessibleName,
  stageIndicatorAccessibleName,
  type PostProcessingChipView,
  type PostProcessingStage,
  type PostProcessingView,
  type StageCardView,
  type StageIndicatorDoor,
  type StagePresentationState,
} from "@/lib/post-processing-view"

type IndicatorLook = { Glyph: LucideIcon; glyphClass: string; wordClass: string }

/**
 * The six presentation states as a closed record onto one anatomy.
 *
 * SHAPE CARRIES THE STATE AND COLOUR ONLY REINFORCES IT (425 D-06, roadmap SC2): a check, a dashed
 * ring, an empty ring, a cross and a dash still separate the states with the colour stripped out,
 * which a tinted badge never did. The tint moves onto the glyph alone; the header's one filled
 * element is the verdict badge (UI-SPEC S2). A `Record` with no default arm so a seventh state
 * fails to compile rather than falling through to a look nobody chose.
 *
 * `skipped` and `unavailable` share the dash ON PURPOSE — their words are what separate them.
 */
const INDICATOR_LOOK: Record<StagePresentationState, IndicatorLook> = {
  complete: { Glyph: CircleCheck, glyphClass: "text-emerald-500", wordClass: "text-muted-foreground" },
  running: {
    Glyph: CircleDashed,
    glyphClass: "text-amber-500 motion-safe:animate-pulse",
    wordClass: "text-muted-foreground",
  },
  pending: { Glyph: Circle, glyphClass: "text-muted-foreground", wordClass: "text-muted-foreground" },
  failed: { Glyph: CircleX, glyphClass: "text-destructive", wordClass: "text-destructive" },
  skipped: { Glyph: CircleMinus, glyphClass: "text-muted-foreground", wordClass: "text-muted-foreground" },
  unavailable: {
    Glyph: CircleMinus,
    glyphClass: "text-muted-foreground",
    wordClass: "text-muted-foreground",
  },
}

/** The chip root's shipped layout, shared by every root below so they cannot drift apart. */
const CHIP_ROOT_CLASS = "inline-flex items-center gap-1 min-h-6 rounded-sm text-xs"

/** The one accent use this phase adds (UI-SPEC Color 1) — the same ring the primitives draw. */
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * One card, as its lines in reading order.
 *
 * The door line is LAST and only on a door root: it names what activating the indicator does, and
 * an indicator with nowhere to go must not grow an instruction that goes nowhere.
 */
/**
 * EVERY LINE THIS CARD CAN PAINT, AS THE ADDRESS THAT REACHES IT.
 *
 * Cells assert exported constants rather than prose; this is that rule applied to the DOM. The
 * Playwright legs and the jsdom cells address these same selectors, so a line kind has one
 * declaration site to grep.
 *
 * The record is closed over {@link CardLineKind} with no default arm, so a new line kind has to be
 * declared here before it can be rendered at all.
 */
export const STAGE_CARD_LINE_SELECTORS = {
  outcome: '[data-stage-card-line="outcome"]',
  note: '[data-stage-card-line="note"]',
  timing: '[data-stage-card-line="timing"]',
  retry: '[data-stage-card-line="retry"]',
  door: '[data-stage-card-line="door"]',
  error: '[data-stage-card-line="error"]',
  reason: '[data-stage-card-line="reason"]',
} as const

export type CardLineKind = keyof typeof STAGE_CARD_LINE_SELECTORS

type CardLine = { kind: CardLineKind; text: string }

function stageCardLines(card: StageCardView | undefined, door?: StageIndicatorDoor): CardLine[] {
  if (card === undefined) return []
  return [
    { kind: "outcome", text: card.outcome },
    ...(card.note === undefined ? [] : [{ kind: "note" as const, text: card.note }]),
    // WHEN it happened, then what the chain intends, then where to go. Each kind appears at most
    // once, so the kind doubles as a stable React key.
    ...(card.timing === undefined ? [] : [{ kind: "timing" as const, text: card.timing }]),
    ...(card.retry === undefined ? [] : [{ kind: "retry" as const, text: card.retry }]),
    ...(door === undefined ? [] : [{ kind: "door" as const, text: DOOR_LINE_TEXT[door] }]),
  ]
}

/**
 * The card, hung off the root as a Radix tooltip that opens on hover AND on keyboard focus (D-10).
 *
 * NO PROVIDER HERE. The page mounts the one tooltip provider (`run-detail.tsx`); a second one
 * inside the header would give this surface its own delay and its own open-state bookkeeping, which
 * is two answers to "is a card open right now" on one page.
 *
 * EVERY LINE IS A TEXT NODE (T-404-01); there is no `dangerouslySetInnerHTML` in this file.
 */
function WithCard({
  stage,
  lines,
  children,
}: {
  stage: PostProcessingStage | "unavailable"
  lines: CardLine[]
  children: ReactElement
}) {
  if (lines.length === 0) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="max-w-[320px] text-left break-words"
        data-stage-card={stage}
      >
        <div className="space-y-1">
          {lines.map((line, index) => (
            <p
              key={line.kind}
              data-stage-card-line={line.kind}
              className={index === 0 ? "font-medium" : "text-muted-foreground"}
            >
              {line.text}
            </p>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * One chip — a `<span>`, or a `<button>` when the page gave it somewhere to go (407-09 · D-01).
 *
 * THE CHIP STAYS PRESENTATIONAL. It is handed a callback and calls it; it knows no tab, no route
 * and no run id (400 D-13). A chip that navigated for itself would be a second answer to "what does
 * this header do", and would grow an affordance in every surface that renders the navbar without a
 * page behind it — which is exactly why the callback is optional and its absence is the shipped
 * `<span>` unchanged.
 *
 * THE ROOT SWAPS ELEMENT, NOT CONTRACT. `data-chip` and `data-chip-status` ride the root either
 * way and the body is one expression rendered into both, so the cells 404-08 addresses on the built
 * bundle read the same selectors whether or not the chip is a door. Only `curation` ever becomes
 * one: `analysis` has no half of the Knowledge tab to open.
 */
function Chip({
  stage,
  chip,
  onActivate,
  door,
}: {
  stage: PostProcessingStage
  chip: PostProcessingChipView
  onActivate?: (() => void) | undefined
  door?: StageIndicatorDoor | undefined
}) {
  const { Glyph, glyphClass, wordClass } = INDICATOR_LOOK[chip.state]
  const isDoor = onActivate !== undefined && door !== undefined
  const lines = stageCardLines(chip.card, isDoor ? door : undefined)
  const body = (
    <>
      <Glyph aria-hidden="true" className={`h-3.5 w-3.5 ${glyphClass}`} />
      <span className={wordClass}>{chip.word}</span>
    </>
  )

  if (isDoor) {
    return (
      <WithCard stage={stage} lines={lines}>
        <button
          type="button"
          data-chip={stage}
          data-chip-status={chip.status}
          data-stage-state={chip.state}
          onClick={onActivate}
          aria-label={
            stage === "curation"
              ? curationChipAccessibleName(chip)
              : stageIndicatorAccessibleName(stage, chip.state, chip.card?.outcome, door)
          }
          className={`${CHIP_ROOT_CLASS} ${FOCUS_RING} cursor-pointer transition-colors hover:text-foreground`}
        >
          {body}
        </button>
      </WithCard>
    )
  }

  return (
    <WithCard stage={stage} lines={lines}>
      <span
        data-chip={stage}
        data-chip-status={chip.status}
        data-stage-state={chip.state}
        tabIndex={0}
        className={`${CHIP_ROOT_CLASS} ${FOCUS_RING} cursor-default`}
      >
        {body}
        <span className="sr-only">
          {stageIndicatorAccessibleName(stage, chip.state, chip.card?.outcome)}
        </span>
      </span>
    </WithCard>
  )
}

/**
 * The chip area: two chips, a named refusal, or the honest gap before the first read.
 *
 * THREE STATES AND NOT TWO. `undefined` is "the first read has not landed", which is NOT the same
 * claim as `pending` ("the store says this chain has not started") and not the same as
 * `unavailable` ("the store could not be read"). D-23 forbids collapsing the third into the first;
 * collapsing the second into the first would be the same lie one step earlier.
 */
export function PostProcessingChips({
  view,
  onCurationClick,
  onOpenVerdict,
}: {
  view: PostProcessingView | undefined
  /** What pressing the `curation` chip should do. Absent → the chip is not a control (D-01). */
  onCurationClick?: (() => void) | undefined
  /**
   * What pressing the `analysis` chip should do (425-09 · D-11). Absent → not a control.
   *
   * ASYMMETRIC WITH CURATION ON PURPOSE. The Knowledge tab always exists, so the page hands
   * `onCurationClick` down unconditionally; a verdict exists only on a run that produced one, and
   * whether a block is mounted is a fact about the tree below this header. Both are the page's to
   * know, and this component decides neither — it paints a door exactly where it was given one.
   */
  onOpenVerdict?: (() => void) | undefined
}) {
  if (view === undefined) {
    return (
      <span
        data-chips-state="loading"
        role="status"
        className="text-xs text-muted-foreground shrink-0"
      >
        …
        <span className="sr-only">{POST_PROCESSING_LOADING_LABEL}</span>
      </span>
    )
  }

  if (view.kind === "unavailable") {
    const { Glyph, glyphClass, wordClass } = INDICATOR_LOOK.unavailable
    return (
      <WithCard
        stage="unavailable"
        lines={[
          { kind: "outcome", text: CHIPS_UNAVAILABLE_TEXT },
          { kind: "error", text: view.error },
          ...(view.reason === undefined ? [] : [{ kind: "reason" as const, text: view.reason }]),
        ]}
      >
        <span
          data-chips-state="unavailable"
          data-stage-state="unavailable"
          tabIndex={0}
          className={`${CHIP_ROOT_CLASS} ${FOCUS_RING} cursor-default ${wordClass}`}
        >
          <Glyph aria-hidden="true" className={`h-3.5 w-3.5 ${glyphClass}`} />
          {POST_PROCESSING_UNAVAILABLE_WORD}
        </span>
      </WithCard>
    )
  }

  // THE REASON RIDES THE CONTAINER AS ITS OWN ATTRIBUTE (425 D-08). The absence-spread rather than
  // a `?? ''` default: an attribute present and empty is a claim that a reason was recorded and was
  // blank, which is exactly the absent/zero conflation this phase is about. `data-chips-state`
  // stays `chips` — skipped is a fact ABOUT the chips, not a fourth area state.
  return (
    <span
      data-chips-state="chips"
      {...(view.skipped === undefined
        ? {}
        : { "data-postprocessing-skipped": view.skipped.reason })}
      className="inline-flex items-center gap-2 min-w-0"
    >
      <Chip stage="analysis" chip={view.analysis} onActivate={onOpenVerdict} door="verdict" />
      <Chip stage="curation" chip={view.curation} onActivate={onCurationClick} door="knowledge" />
    </span>
  )
}
