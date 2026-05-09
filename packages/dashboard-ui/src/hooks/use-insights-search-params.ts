import { useCallback, useEffect, useMemo } from "react"
import { useSearchParams } from "react-router"

import type { InsightsBreakdownDimension } from "@/lib/api"

export type InsightsTimeWindow = "1d" | "7d" | "30d" | "all"

const VALID_WINDOWS = new Set<InsightsTimeWindow>(["1d", "7d", "30d", "all"])
const VALID_BREAKDOWNS = new Set<InsightsBreakdownDimension>(["test", "suite", "platform"])

function buildCanonicalParams(state: {
  window: InsightsTimeWindow
  breakdown: InsightsBreakdownDimension
}) {
  const next = new URLSearchParams()

  if (state.window !== "7d") next.set("window", state.window)
  if (state.breakdown !== "test") next.set("breakdown", state.breakdown)

  return next
}

export function useInsightsSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const windowParam = searchParams.get("window")
  const window = VALID_WINDOWS.has(windowParam as InsightsTimeWindow)
    ? windowParam as InsightsTimeWindow
    : "7d"

  const breakdownParam = searchParams.get("breakdown")
  const breakdown = VALID_BREAKDOWNS.has(breakdownParam as InsightsBreakdownDimension)
    ? breakdownParam as InsightsBreakdownDimension
    : "test"

  const state = useMemo(
    () => ({
      window,
      breakdown,
    }),
    [window, breakdown],
  )

  useEffect(() => {
    const canonical = buildCanonicalParams(state)
    if (searchParams.toString() !== canonical.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams, state])

  const patchParams = useCallback(
    (patch: Partial<{ window: InsightsTimeWindow; breakdown: InsightsBreakdownDimension }>) => {
      setSearchParams(
        buildCanonicalParams({
          ...state,
          ...patch,
        }),
        { replace: true },
      )
    },
    [setSearchParams, state],
  )

  return {
    window,
    breakdown,
    setWindow: useCallback((value: InsightsTimeWindow) => patchParams({ window: value }), [patchParams]),
    setBreakdown: useCallback((value: InsightsBreakdownDimension) => patchParams({ breakdown: value }), [patchParams]),
  }
}
