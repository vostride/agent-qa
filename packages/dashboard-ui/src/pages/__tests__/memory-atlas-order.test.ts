import { describe, expect, it } from "vitest"

import type { MemoryAtlasObservation } from "@/lib/api"
import type { AtlasFilters, AtlasSortMode } from "@/pages/memory-product/atlas-types"
import {
  buildAtlasArticle,
  filterAtlasObservations,
} from "@/pages/memory-product/atlas-order"

const NOW = "2026-04-22T12:00:00.000Z"

function makeObservation(
  overrides: Partial<MemoryAtlasObservation> &
    Pick<MemoryAtlasObservation, "id" | "content">,
): MemoryAtlasObservation {
  const { id, content, ...rest } = overrides

  return {
    id,
    title: `Observation: ${content}`,
    content,
    trust: 0.55,
    created: "2026-04-01T09:00:00.000Z",
    last_confirmed: "2026-04-05T09:00:00.000Z",
    confirmed_count: 2,
    contradicted_count: 0,
    source_test: "shared-source",
    scope: "product",
    scopeId: "alpha-product",
    ...rest,
  }
}

const ATLAS_FIXTURE: MemoryAtlasObservation[] = [
  makeObservation({
    id: "obs-core-product",
    title: "Checkout: shipping address persists across retries",
    content: "Checkout keeps the selected shipping address between retries.",
    trust: 0.95,
    created: "2026-04-12T09:00:00.000Z",
    last_confirmed: "2026-04-21T09:00:00.000Z",
    source_test: "checkout-smoke",
    scope: "product",
    scopeId: "alpha-product",
  }),
  makeObservation({
    id: "obs-core-suite",
    title: "Suite handoff: tax estimates stay stable after login",
    content: "Suite runs keep tax estimates stable after login handoff.",
    trust: 0.78,
    created: "2026-04-11T09:00:00.000Z",
    last_confirmed: "2026-04-20T09:00:00.000Z",
    source_test: "suite-handoff",
    scope: "suite",
    scopeId: "s_checkout",
  }),
  makeObservation({
    id: "obs-watchout-contradicted",
    title: "Fallback sorting: contradicted note says atlas sections disappear",
    content: "A contradicted fact should stay in needs verification even when trust is high.",
    trust: 0.91,
    created: "2026-04-18T09:00:00.000Z",
    last_confirmed: "2026-04-21T18:00:00.000Z",
    confirmed_count: 4,
    contradicted_count: 2,
    source_test: "checkout-smoke",
    scope: "product",
    scopeId: "alpha-product",
  }),
  makeObservation({
    id: "obs-watchout-low",
    title: "Mobile checkout: second submit tap can still be needed",
    content: "Mobile checkout sometimes needs a second submit tap after network jitter.",
    trust: 0.22,
    created: "2026-04-17T09:00:00.000Z",
    last_confirmed: "2026-04-17T09:00:00.000Z",
    source_test: "qa-triage",
    scope: "test",
    scopeId: "t_mobile-checkout",
  }),
  makeObservation({
    id: "obs-recent-1",
    title: "Promo recovery: handoff copy now explains the path",
    content: "New handoff copy now mentions promo code recovery.",
    trust: 0.62,
    created: "2026-04-22T08:00:00.000Z",
    last_confirmed: "2026-04-22T08:00:00.000Z",
    source_test: "suite-handoff",
    scope: "suite",
    scopeId: "s_checkout",
  }),
  makeObservation({
    id: "obs-recent-2",
    title: "Guest checkout: cart survives sign-in redirect",
    content: "Guest checkout preserves cart contents after sign-in redirect.",
    trust: 0.66,
    created: "2026-04-21T07:00:00.000Z",
    last_confirmed: "2026-04-21T07:00:00.000Z",
    source_test: "guest-checkout",
    scope: "test",
    scopeId: "t_guest",
  }),
  makeObservation({
    id: "obs-recent-3",
    title: "Payment retry: selected card stays in summary",
    content: "Payment retry keeps the selected card visible in the summary.",
    trust: 0.58,
    created: "2026-04-20T07:00:00.000Z",
    last_confirmed: "2026-04-20T07:00:00.000Z",
    source_test: "payment-retry",
    scope: "product",
    scopeId: "alpha-product",
  }),
  makeObservation({
    id: "obs-recent-4",
    title: "Shipping labels: delivery windows appear inline",
    content: "Shipping method labels now include delivery windows.",
    trust: 0.49,
    created: "2026-04-19T07:00:00.000Z",
    last_confirmed: "2026-04-19T07:00:00.000Z",
    source_test: "shipping-methods",
    scope: "product",
    scopeId: "alpha-product",
  }),
  makeObservation({
    id: "obs-recent-5",
    title: "Order summary: discount rows remain visible",
    content: "Order summary keeps discount rows visible after refresh.",
    trust: 0.53,
    created: "2026-04-16T07:00:00.000Z",
    last_confirmed: "2026-04-16T07:00:00.000Z",
    source_test: "order-summary",
    scope: "suite",
    scopeId: "s_checkout",
  }),
  makeObservation({
    id: "obs-recent-6",
    title: "Saved addresses: manual entry comes second",
    content: "Saved addresses appear before manual address entry.",
    trust: 0.65,
    created: "2026-04-15T07:00:00.000Z",
    last_confirmed: "2026-04-15T07:00:00.000Z",
    source_test: "addresses",
    scope: "product",
    scopeId: "alpha-product",
  }),
  makeObservation({
    id: "obs-recent-7",
    title: "Tax recalculation: confirm button waits for completion",
    content: "Tax recalculation finishes before the confirmation button re-enables.",
    trust: 0.46,
    created: "2026-04-14T07:00:00.000Z",
    last_confirmed: "2026-04-14T07:00:00.000Z",
    source_test: "tax-recalc",
    scope: "test",
    scopeId: "t_tax",
  }),
  makeObservation({
    id: "obs-recent-8",
    title: "Promo validation: focus stays near the form after errors",
    content: "Promo code validation keeps focus near the form after an error.",
    trust: 0.41,
    created: "2026-04-13T07:00:00.000Z",
    last_confirmed: "2026-04-13T07:00:00.000Z",
    source_test: "promo-codes",
    scope: "suite",
    scopeId: "s_promos",
  }),
  makeObservation({
    id: "obs-remaining",
    title: "Legacy checkout: old bundle naming still appears",
    content: "Legacy checkout copy still references old bundle naming.",
    trust: 0.52,
    created: "2026-03-01T07:00:00.000Z",
    last_confirmed: "2026-03-02T07:00:00.000Z",
    source_test: "legacy-checkout",
    scope: "test",
    scopeId: "t_legacy",
  }),
]

describe("memory atlas order helpers", () => {
  it("assigns each observation once in atlas order with needs-verification precedence", () => {
    const article = buildAtlasArticle(ATLAS_FIXTURE, {
      query: "",
      scope: "all",
      freshness: "all",
      trust: "any",
      source: "all",
      sort: "atlas",
    }, NOW)

    expect(article.map((section) => section.id)).toEqual([
      "core-facts",
      "recent-learnings",
      "needs-verification",
      "remaining-memory",
    ])
    expect(article.find((section) => section.id === "core-facts")?.items.map((item) => item.id)).toEqual([
      "obs-core-product",
      "obs-core-suite",
    ])
    expect(article.find((section) => section.id === "recent-learnings")?.items).toHaveLength(8)
    expect(article.find((section) => section.id === "needs-verification")?.items.map((item) => item.id)).toEqual([
      "obs-watchout-contradicted",
      "obs-watchout-low",
    ])
    expect(article.find((section) => section.id === "remaining-memory")?.items.map((item) => item.id)).toEqual([
      "obs-remaining",
    ])

    const allRenderedIds = article.flatMap((section) => section.items.map((item) => item.id))
    expect(new Set(allRenderedIds).size).toBe(ATLAS_FIXTURE.length)
    expect(allRenderedIds).toHaveLength(ATLAS_FIXTURE.length)
  })

  it("collapses to a single Results section for non-default sort modes", () => {
    const sortModes: AtlasSortMode[] = [
      "newest",
      "recently-confirmed",
      "highest-trust",
      "most-contradicted",
    ]

    for (const sort of sortModes) {
      const article = buildAtlasArticle(ATLAS_FIXTURE, {
        query: "",
        scope: "all",
        freshness: "all",
        trust: "any",
        source: "all",
        sort,
      }, NOW)

      expect(article).toHaveLength(1)
      expect(article[0]?.id).toBe("results")
      expect(article[0]?.title).toBe("Results")
    }
  })

  it("filters before bucketing across query, scope, freshness, trust, and source controls", () => {
    const suiteFilters: AtlasFilters = {
      query: "HANDOFF",
      scope: "suite",
      freshness: "confirmed-7d",
      trust: "medium",
      source: "suite-handoff",
      sort: "atlas",
    }

    const suiteFiltered = filterAtlasObservations(ATLAS_FIXTURE, suiteFilters, NOW)
    expect(suiteFiltered.map((item) => item.id)).toEqual(["obs-recent-1"])

    const suiteArticle = buildAtlasArticle(ATLAS_FIXTURE, suiteFilters, NOW)
    expect(suiteArticle).toHaveLength(1)
    expect(suiteArticle[0]?.id).toBe("recent-learnings")
    expect(suiteArticle[0]?.items.map((item) => item.id)).toEqual(["obs-recent-1"])

    const confirmedThirtyDay = filterAtlasObservations(ATLAS_FIXTURE, {
      query: "",
      scope: "all",
      freshness: "confirmed-30d",
      trust: "high",
      source: "all",
      sort: "highest-trust",
    }, NOW)
    expect(confirmedThirtyDay.map((item) => item.id)).toEqual([
      "obs-core-product",
      "obs-core-suite",
      "obs-watchout-contradicted",
    ])

    const olderOrUnconfirmed = filterAtlasObservations(ATLAS_FIXTURE, {
      query: "",
      scope: "test",
      freshness: "older-or-unconfirmed",
      trust: "medium",
      source: "legacy-checkout",
      sort: "most-contradicted",
    }, NOW)
    expect(olderOrUnconfirmed.map((item) => item.id)).toEqual(["obs-remaining"])
  })

  it("matches title-only queries without changing the existing atlas section ordering rules", () => {
    const results = filterAtlasObservations(ATLAS_FIXTURE, {
      query: "delivery windows",
      scope: "all",
      freshness: "all",
      trust: "any",
      source: "all",
      sort: "atlas",
    }, NOW)

    expect(results.map((item) => item.id)).toEqual(["obs-recent-4"])

    const article = buildAtlasArticle(ATLAS_FIXTURE, {
      query: "delivery windows",
      scope: "all",
      freshness: "all",
      trust: "any",
      source: "all",
      sort: "atlas",
    }, NOW)

    expect(article).toHaveLength(1)
    expect(article[0]?.id).toBe("recent-learnings")
    expect(article[0]?.items.map((item) => item.id)).toEqual(["obs-recent-4"])
  })
})
