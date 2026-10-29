// Composes no sentence: each line is a `run-detail-view.ts` call; an absent fact renders nothing.

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

// `align="end"` and a wrapping `max-w-[320px]`, so a long model id grows the card downward.
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
