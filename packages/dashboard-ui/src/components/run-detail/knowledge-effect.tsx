// Effect on this run: measured effects only, problems first, each a sentence with its own glyph.

import { useId } from "react"
import {
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  Hourglass,
  ListChecks,
  ListX,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { KnowledgeStepRefs } from "./knowledge-step-ref"
import {
  EFFECT_HEADING,
  UNCOUNTED_TRIALS_TOOLTIP,
  formatStepRefs,
  type EffectEntryView,
  type EffectOutcome,
  type EffectSectionView,
  type EffectTone,
  type StepRefContext,
} from "@/lib/knowledge-view"

const HEADING_CLASS = "text-base font-medium leading-snug"

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

// Eight distinct shapes, so a colour-stripped render still tells every outcome apart.
const EFFECT_GLYPHS: Record<EffectOutcome, LucideIcon> = {
  contradicted: CircleX,
  harmful: ThumbsDown,
  "replay-stopped": ListX,
  confirmed: CircleCheck,
  helpful: ThumbsUp,
  "replay-complete": ListChecks,
  pending: Hourglass,
  unknown: CircleQuestionMark,
}

const TONE_LOOK: Record<EffectTone, { readonly glyph: string; readonly sentence: string }> = {
  problem: { glyph: "text-destructive", sentence: "text-destructive font-medium" },
  positive: { glyph: "text-emerald-500", sentence: "text-foreground" },
  pending: { glyph: "text-amber-500", sentence: "text-foreground" },
  unknown: { glyph: "text-muted-foreground", sentence: "text-muted-foreground" },
}

export function KnowledgeEffect({
  view,
  stepRefs,
  testNames = stepRefs?.testNames,
}: {
  view: EffectSectionView
  stepRefs?: StepRefContext
  testNames?: ReadonlyMap<number, string>
}) {
  const headingId = useId()
  const uncountedMeaningId = useId()
  return (
    <section data-knowledge-section="effect" aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className={HEADING_CLASS}>{EFFECT_HEADING}</h4>
      {view.entries.length === 0 ? (
        <p data-section-absence className="text-sm text-muted-foreground">{view.absence}</p>
      ) : (
        <ul data-effect-list className="space-y-2">
          {view.entries.map(entry => (
            <EffectEntry key={entry.key} entry={entry} stepRefs={stepRefs} testNames={testNames} />
          ))}
        </ul>
      )}
      {view.uncounted === undefined ? null : (
        <p data-effect-uncounted={String(view.uncounted.count)} className="text-xs text-muted-foreground">
          <Tooltip>
            {/* The trigger's own described-by replaces Radix's open-time one, so the meaning is announced once, open or closed. */}
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-describedby={uncountedMeaningId}
                className={`cursor-help rounded-sm text-left underline decoration-dotted underline-offset-4 ${FOCUS_RING}`}
              >
                {view.uncounted.line}
              </button>
            </TooltipTrigger>
            <span id={uncountedMeaningId} hidden>{UNCOUNTED_TRIALS_TOOLTIP}</span>
            <TooltipContent side="bottom" align="start" sideOffset={4} className="max-w-[320px] text-left">
              {UNCOUNTED_TRIALS_TOOLTIP}
            </TooltipContent>
          </Tooltip>
        </p>
      )}
      {view.unmeasured === undefined ? null : (
        <p data-effect-unmeasured={String(view.unmeasured.count)} className="text-xs text-muted-foreground tabular-nums">
          {view.unmeasured.line}
        </p>
      )}
    </section>
  )
}

function EffectEntry({
  entry,
  stepRefs,
  testNames,
}: {
  entry: EffectEntryView
  stepRefs?: StepRefContext
  testNames?: ReadonlyMap<number, string>
}) {
  const Glyph = EFFECT_GLYPHS[entry.outcome]
  const look = TONE_LOOK[entry.tone]
  return (
    <li
      data-effect-entry
      data-effect-outcome={entry.outcome}
      data-effect-tone={entry.tone}
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1"
    >
      {/* mt-0.5: the 2px optical offset that seats a 14px glyph on the 14px sentence's first line */}
      <Glyph className={`mt-0.5 size-3.5 ${look.glyph}`} aria-hidden />
      <p data-effect-sentence className={`text-sm ${look.sentence}`}>
        {entry.parts.lead}{" "}
        <KnowledgeStepRefs segments={formatStepRefs(entry.addresses, testNames)} stepRefs={stepRefs} testNames={testNames} />
        {entry.parts.tail}
      </p>
      <p data-effect-record className="col-start-2 text-xs text-muted-foreground wrap-anywhere">
        {entry.record}
      </p>
    </li>
  )
}
