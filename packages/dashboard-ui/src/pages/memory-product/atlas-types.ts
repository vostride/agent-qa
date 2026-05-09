import type { MemoryAtlasObservation } from "../../lib/api"

export type AtlasSortMode =
  | "atlas"
  | "newest"
  | "recently-confirmed"
  | "highest-trust"
  | "most-contradicted"

export type AtlasFreshnessFilter =
  | "all"
  | "confirmed-7d"
  | "confirmed-30d"
  | "older-or-unconfirmed"

export type AtlasTrustFilter = "any" | "high" | "medium" | "low"

export interface AtlasFilters {
  query: string
  scope: "all" | "product" | "suite" | "test"
  freshness: AtlasFreshnessFilter
  trust: AtlasTrustFilter
  source: string | "all"
  sort: AtlasSortMode
}

export interface AtlasSection {
  id:
    | "core-facts"
    | "recent-learnings"
    | "needs-verification"
    | "remaining-memory"
    | "results"
  title: string
  items: MemoryAtlasObservation[]
}

export const DEFAULT_ATLAS_FILTERS: AtlasFilters = {
  query: "",
  scope: "all",
  freshness: "all",
  trust: "any",
  source: "all",
  sort: "atlas",
}
