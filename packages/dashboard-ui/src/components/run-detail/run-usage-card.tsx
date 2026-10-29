// THE USAGE CARD BEHIND THE HEADER'S TOKEN LINE (425-05 · PXH-RUN-05, D-21..D-24, UI-SPEC S6).
//
// PRESENTATIONAL, AND DELIBERATELY SO. It takes the projection's own `tokens` and
// `models` and paints them. It reads nothing, fetches nothing and knows no run id — the page owns
// the read and the header hands it down.
//
// IT COMPOSES NO SENTENCE. Every line here is a call into `run-detail-view.ts`, so the words a
// person reads live beside the reasoning for them and cannot drift from the cells that pin them —
// the `post-processing-view.ts` idiom, applied to usage.
//
// A LINE IS A FACT SOMEBODY REPORTED, OR IT IS NOT THERE. `cached` needs the provider's own
// `cachedInputTokens`; `coverage` needs an unmeasured step; the model lines need the durable
// summary. Each of those functions answers `undefined` when its fact is absent and this file
// renders nothing for it — the card never fills a gap with a zero, an "n/a" or a row of dashes.
//
// Model and provider ids are producer strings rendered as the stored text;
// there is no `dangerouslySetInnerHTML` in this file.

import { TooltipContent } from "@/components/ui/tooltip"
import {
  cachedInputLine,
  usageCoverageLine,
  usageModelLines,
  usageTotalsLine,
  type UsageLine,
} from "@/lib/run-detail-view"
import type { RunModelSummary, RunTokenTotals } from "@vostride/agent-qa-schema"

/** One painted line: the kind rides `data-usage-line`. */
type CardLine = { kind: string; text: string }

/**
 * The card's lines in reading order: what was spent, what the provider discounted, how much of the
 * run that covers, and who answered.
 *
 * TOTALS FIRST AND ALWAYS. It is the line the header's compact pair sends a reader here to check,
 * and it is the only one that has a sentence for every run — an unmeasured run reads the
 * not-measured label rather than disappearing, because "nobody measured this" is itself the answer.
 */
function usageCardLines(
  tokens: RunTokenTotals,
  models: RunModelSummary | undefined,
): CardLine[] {
  const cached = cachedInputLine(tokens)
  const coverage = usageCoverageLine(tokens)
  return [
    { kind: "totals", text: usageTotalsLine(tokens) },
    ...(cached === undefined ? [] : [{ kind: "cached", text: cached }]),
    ...(coverage === undefined ? [] : [{ kind: "coverage", text: coverage }]),
    ...usageModelLines(models).map((line: UsageLine) => ({ kind: line.kind, text: line.text })),
  ]
}

/**
 * The card body — a `TooltipContent`, opened by the header line's trigger.
 *
 * `align="end"` because the token line sits at the right of the header's meta row and Radix
 * collision-avoids the viewport edge from there; `max-w-[320px]` with wrapping so a long model id
 * grows the card downward rather than off the screen (UI-SPEC E5 overflow / long-text).
 */
export function RunUsageCard({
  tokens,
  models,
}: {
  tokens: RunTokenTotals
  models?: RunModelSummary | undefined
}) {
  const lines = usageCardLines(tokens, models)
  return (
    <TooltipContent
      side="bottom"
      align="end"
      sideOffset={4}
      className="max-w-[320px] text-left break-words"
      data-usage-card
    >
      <div className="space-y-1 text-xs tabular-nums">
        {lines.map((line, index) => (
          <p
            key={`${line.kind}-${String(index)}`}
            data-usage-line={line.kind}
            className={line.kind === "totals" ? "font-medium" : "text-muted-foreground"}
          >
            {line.text}
          </p>
        ))}
      </div>
    </TooltipContent>
  )
}
