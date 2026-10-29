// @vitest-environment jsdom

// THE USAGE CARD A PERSON ACTUALLY OPENS (425-05 · D-21..D-24, UI-SPEC S6/E5).
//
// WHY THESE CELLS MOUNT THE REAL RADIX PRIMITIVES. The card IS a `TooltipContent`, so a mock would
// replace the one thing under test — that the content opens from the trigger, portals out of the
// header and carries its contract attributes. The component deliberately carries no provider (the
// page owns the single one), so every mount wraps it in `TooltipProvider delayDuration={0}`, and
// the card is read off `document` rather than the container because it is portalled.
//
// EVERY LINE IS A FACT SOMEBODY REPORTED. The cells below are mostly ABSENCE claims — no cached
// line without a provider report, no coverage line on a fully measured run, no model line on a
// pre-423 run — because a card that states a line it has no fact for is the failure mode this
// whole plan exists to prevent, and an assertion that only checks what IS rendered cannot see it.

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { RunUsageCard } from "@/components/run-detail/run-usage-card"
import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  MODELS_HEADING,
  TOKENS_NOT_MEASURED_LABEL,
  usageTotalsLine,
} from "@/lib/run-detail-view"
import type { RunModelSummary, RunTokenTotals } from "@vostride/agent-qa-schema"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => { root?.unmount() })
  container?.remove()
  root = undefined
  container = undefined
})

/** Mount the card behind a bare trigger and open it the way a keyboard reader does. */
async function openCard(tokens: RunTokenTotals, models?: RunModelSummary): Promise<HTMLElement> {
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-usage-probe tabIndex={0} />
          </TooltipTrigger>
          <RunUsageCard tokens={tokens} models={models} />
        </Tooltip>
      </TooltipProvider>,
    )
  })

  const trigger = container.querySelector<HTMLElement>("[data-usage-probe]")
  if (trigger === null) throw new Error("no usage trigger rendered")
  await act(async () => { trigger.focus() })

  const card = document.querySelector<HTMLElement>("[data-usage-card]")
  if (card === null) throw new Error("no usage card opened")
  return card
}

/**
 * The card's VISIBLE lines, in render order, as `[kind, text]` pairs.
 *
 * Radix renders the content twice — once for the eye and once inside a visually-hidden
 * `role="tooltip"` node so a screen reader announces it — so an unfiltered query returns every
 * line twice. The duplicate is the primitive's accessibility mechanism, not a second card: what
 * these cells are about is the line SET, so the announced copy is excluded here and the fact that
 * it exists at all is the primitive's own contract.
 */
function lines(card: HTMLElement): [string, string][] {
  return [...card.querySelectorAll<HTMLElement>("[data-usage-line]")]
    .filter(el => el.closest('[role="tooltip"]') === null)
    .map(el => [el.getAttribute("data-usage-line") ?? "", el.textContent ?? ""])
}

const MEASURED: RunTokenTotals = {
  measuredSteps: 3,
  unmeasuredSteps: 0,
  promptTokens: 103074,
  completionTokens: 456,
  totalTokens: 103530,
}

const ONE_MODEL: RunModelSummary = {
  declared: [{ provider: "openai", modelId: "gpt-5.6-terra", stepCount: 3 }],
}

describe("the usage card says the total and the identity", () => {
  it("USAGE-CARD-POPULATED: a fully measured single-model run is two lines and no caveats", async () => {
    const card = await openCard(MEASURED, ONE_MODEL)

    expect(lines(card)).toEqual([
      ["totals", "103,530 total · 103,074 in · 456 out"],
      ["model", "Model gpt-5.6-terra (openai)"],
    ])
    expect(card.querySelector('[data-usage-line="totals"]')?.className).toContain("font-medium")
    expect(card.className).toContain("max-w-[320px]")
  })

  it("USAGE-CARD-POPULATED: the card holds no per-step table, no link and no cost", async () => {
    const card = await openCard(MEASURED, ONE_MODEL)

    expect(card.querySelector("table")).toBeNull()
    expect(card.querySelector("a")).toBeNull()
    expect(card.textContent).not.toContain("$")
  })
})

describe("the card states a caveat only when there is one", () => {
  it("USAGE-CARD-PARTIAL: an undercount and a narrower cache window are stated, in reading order", async () => {
    const card = await openCard({
      measuredSteps: 2,
      unmeasuredSteps: 1,
      promptTokens: 103074,
      completionTokens: 456,
      totalTokens: 103530,
      cachedInputTokens: 40000,
      cachedMeasuredSteps: 1,
      cachedInputMeasuredTokens: 90000,
    }, ONE_MODEL)

    expect(lines(card)).toEqual([
      ["totals", "103,530 total · 103,074 in · 456 out"],
      ["cached", "cached input 40,000 of 90,000 (provider-reported) over 1 of 2 measured steps"],
      ["coverage", "measured 2 of 3 steps — totals are an undercount"],
      ["model", "Model gpt-5.6-terra (openai)"],
    ])
  })

  it("USAGE-CARD-PARTIAL: a cache that covers every measured step states the sum alone", async () => {
    const card = await openCard({ ...MEASURED, cachedInputTokens: 40000, cachedMeasuredSteps: 3 })

    expect(lines(card)).toEqual([
      ["totals", "103,530 total · 103,074 in · 456 out"],
      ["cached", "cached input 40,000 (provider-reported)"],
    ])
  })

  // RESEARCH reconciliation 4: a run whose steps were served from the EXECUTION cache reports no
  // provider caching at all, and the card must say nothing rather than borrow the other fact.
  it("CACHED-ONLY-WHEN-REPORTED: execution cache hits with no provider report render no cached line", async () => {
    const card = await openCard(MEASURED, ONE_MODEL)

    expect(card.querySelector('[data-usage-line="cached"]')).toBeNull()
    expect(card.textContent).not.toContain("cached")
  })
})

describe("an unmeasured run still says what it knows", () => {
  it("USAGE-CARD-UNMEASURED: the totals line reads the label and the model line survives", async () => {
    const card = await openCard({ measuredSteps: 0, unmeasuredSteps: 3 }, ONE_MODEL)

    // No coverage line: a run nobody measured has no total to be an undercount of.
    expect(lines(card)).toEqual([
      ["totals", TOKENS_NOT_MEASURED_LABEL],
      ["model", "Model gpt-5.6-terra (openai)"],
    ])
    expect(usageTotalsLine({ measuredSteps: 0, unmeasuredSteps: 3 })).toBe(TOKENS_NOT_MEASURED_LABEL)
  })

  it("USAGE-CARD-UNMEASURED: a run with no measured step renders the label and no model line at all", async () => {
    const card = await openCard({ measuredSteps: 0, unmeasuredSteps: 3 })

    expect(lines(card).map(([kind]) => kind)).toEqual(["totals"])
    expect(card.querySelector('[data-usage-line="model"]')).toBeNull()
    expect(card.querySelector('[data-usage-line="models"]')).toBeNull()
  })
})

describe("who answered this run, for no, one or many models", () => {
  it("USAGE-MODEL-LINES: a differing responding id is named under the declared one", async () => {
    const card = await openCard(MEASURED, {
      ...ONE_MODEL,
      responding: [{ modelId: "gpt-5.6-terra-2026-09-01", stepCount: 3 }],
    })

    expect(lines(card)).toEqual([
      ["totals", "103,530 total · 103,074 in · 456 out"],
      ["model", "Model gpt-5.6-terra (openai)"],
      ["responded", "responded as gpt-5.6-terra-2026-09-01"],
    ])
  })

  it("USAGE-MODEL-LINES: a mixed run is a heading and one line per identity", async () => {
    const card = await openCard(MEASURED, {
      declared: [
        { provider: "openai", modelId: "gpt-5.6-terra", stepCount: 2 },
        { provider: "anthropic", modelId: "claude-opus-5", stepCount: 1 },
      ],
    })

    expect(lines(card)).toEqual([
      ["totals", "103,530 total · 103,074 in · 456 out"],
      ["heading", MODELS_HEADING],
      ["models", "gpt-5.6-terra (openai) × 2 steps"],
      ["models", "claude-opus-5 (anthropic) × 1 steps"],
    ])
  })
})

// a model id is a PRODUCER string, rendered as the stored text.
describe("producer ids render as the stored text", () => {
  it("USAGE-MODEL-LINES: a stored [secret:<name>] model id renders as text, with no chip", async () => {
    const card = await openCard(MEASURED, {
      declared: [{ provider: "openai", modelId: "[secret:MODEL_ID]", stepCount: 3 }],
    })

    const model = card.querySelector<HTMLElement>('[data-usage-line="model"]')
    expect(model).not.toBeNull()
    expect(model?.textContent).toContain("[secret:MODEL_ID]")
    expect(model?.querySelector("[data-masked]")).toBeNull()
  })
})
