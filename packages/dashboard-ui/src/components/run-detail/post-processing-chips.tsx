// Presentational: the header is a glyph and a word, and every sentence comes from the view.

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

// Shape carries the state and colour only reinforces it; `skipped` and `unavailable` share a dash.
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

/** The accent ring, the same one the primitives draw. */
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

// No provider here: a second one would give the header its own delay and open-state bookkeeping.
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

// The root swaps element but keeps `data-chip` and `data-chip-status`, so selectors still hold.
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

// `undefined` is the first read not landed yet, distinct from `pending` and from `unavailable`.
export function PostProcessingChips({
  view,
  onCurationClick,
  onOpenVerdict,
}: {
  view: PostProcessingView | undefined
  // What pressing the `curation` chip does; absent, the chip is not a control.
  onCurationClick?: (() => void) | undefined
  // The page decides whether a verdict exists, so the analysis chip is a door only when given one.
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

  // Absent rather than empty: an empty attribute would claim a recorded blank reason.
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
