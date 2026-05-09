import type { MemoryAtlasObservation } from "../../lib/api"
import type {
  AtlasFilters,
  AtlasSection,
  AtlasSortMode,
  AtlasTrustFilter,
} from "./atlas-types"

const DAY_IN_MS = 24 * 60 * 60 * 1000
const SCOPE_ORDER = ["product", "suite", "test"] as const

const SECTION_TITLES: Record<AtlasSection["id"], string> = {
  "core-facts": "Core facts",
  "recent-learnings": "Recent learnings",
  "needs-verification": "Needs verification",
  "remaining-memory": "Remaining memory",
  results: "Results",
}

export function listAtlasSources(
  observations: MemoryAtlasObservation[],
): string[] {
  const uniqueSources = new Set<string>()

  for (const observation of observations) {
    const source = observation.source_test.trim()
    if (!source) {
      continue
    }
    uniqueSources.add(source)
  }

  return Array.from(uniqueSources).sort(compareSource)
}

export function filterAtlasObservations(
  observations: MemoryAtlasObservation[],
  filters: AtlasFilters,
  now: string | Date,
): MemoryAtlasObservation[] {
  const query = filters.query.trim().toLowerCase()
  const nowMs = toTime(now) ?? Date.now()

  return observations.filter((observation) => {
    if (
      query &&
      !observation.title.toLowerCase().includes(query) &&
      !observation.content.toLowerCase().includes(query) &&
      !observation.source_test.toLowerCase().includes(query)
    ) {
      return false
    }

    if (filters.scope !== "all" && observation.scope !== filters.scope) {
      return false
    }

    if (filters.source !== "all" && observation.source_test !== filters.source) {
      return false
    }

    if (!matchesTrust(observation.trust, filters.trust)) {
      return false
    }

    return matchesFreshness(observation, filters.freshness, nowMs)
  })
}

export function buildAtlasArticle(
  observations: MemoryAtlasObservation[],
  filters: AtlasFilters,
  now: string | Date,
): AtlasSection[] {
  const filtered = filterAtlasObservations(observations, filters, now)

  if (filters.sort !== "atlas") {
    if (filtered.length === 0) {
      return []
    }

    return [
      {
        id: "results",
        title: SECTION_TITLES.results,
        items: sortObservations(filtered, getResultsComparator(filters.sort)),
      },
    ]
  }

  const seenIds = new Set<string>()

  const needsVerification = collectBucket(
    filtered,
    (observation) =>
      observation.contradicted_count > 0 || observation.trust < 0.4,
    compareNeedsVerification,
    seenIds,
  )
  const coreFacts = collectBucket(
    filtered,
    (observation) =>
      observation.contradicted_count === 0 && observation.trust >= 0.7,
    compareCoreFacts,
    seenIds,
  )
  const recentLearnings = collectBucket(
    filtered,
    () => true,
    compareRecentLearnings,
    seenIds,
    8,
  )
  const remainingMemory = collectBucket(
    filtered,
    () => true,
    compareRemainingMemory,
    seenIds,
  )

  return [
    createSection("core-facts", coreFacts),
    createSection("recent-learnings", recentLearnings),
    createSection("needs-verification", needsVerification),
    createSection("remaining-memory", remainingMemory),
  ].filter((section): section is AtlasSection => section !== null)
}

function matchesTrust(trust: number, filter: AtlasTrustFilter): boolean {
  switch (filter) {
    case "high":
      return trust >= 0.7
    case "medium":
      return trust >= 0.4 && trust < 0.7
    case "low":
      return trust < 0.4
    case "any":
      return true
  }
}

function matchesFreshness(
  observation: MemoryAtlasObservation,
  freshness: AtlasFilters["freshness"],
  nowMs: number,
): boolean {
  const lastConfirmedMs = toTime(observation.last_confirmed)

  switch (freshness) {
    case "all":
      return true
    case "confirmed-7d":
      return lastConfirmedMs !== null && lastConfirmedMs >= nowMs - 7 * DAY_IN_MS
    case "confirmed-30d":
      return lastConfirmedMs !== null && lastConfirmedMs >= nowMs - 30 * DAY_IN_MS
    case "older-or-unconfirmed":
      return lastConfirmedMs === null || lastConfirmedMs < nowMs - 30 * DAY_IN_MS
  }
}

function collectBucket(
  observations: MemoryAtlasObservation[],
  include: (observation: MemoryAtlasObservation) => boolean,
  compare: (
    left: MemoryAtlasObservation,
    right: MemoryAtlasObservation,
  ) => number,
  seenIds: Set<string>,
  limit = Number.POSITIVE_INFINITY,
): MemoryAtlasObservation[] {
  const items: MemoryAtlasObservation[] = []

  for (const observation of sortObservations(observations, compare)) {
    if (!include(observation) || seenIds.has(observation.id)) {
      continue
    }

    seenIds.add(observation.id)
    items.push(observation)

    if (items.length >= limit) {
      break
    }
  }

  return items
}

function createSection(
  id: AtlasSection["id"],
  items: MemoryAtlasObservation[],
): AtlasSection | null {
  if (items.length === 0) {
    return null
  }

  return {
    id,
    title: SECTION_TITLES[id],
    items,
  }
}

function getResultsComparator(
  sort: Exclude<AtlasSortMode, "atlas">,
): (left: MemoryAtlasObservation, right: MemoryAtlasObservation) => number {
  switch (sort) {
    case "newest":
      return compareNewest
    case "recently-confirmed":
      return compareRecentlyConfirmed
    case "highest-trust":
      return compareHighestTrust
    case "most-contradicted":
      return compareMostContradicted
  }
}

function compareCoreFacts(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareNumberDesc(left.trust, right.trust) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareTimeDesc(left.created, right.created) ||
    compareStable(left, right)
  )
}

function compareRecentLearnings(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareTimeDesc(left.created, right.created) ||
    compareNumberDesc(left.trust, right.trust) ||
    compareStable(left, right)
  )
}

function compareNeedsVerification(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareNumberDesc(left.contradicted_count, right.contradicted_count) ||
    compareNumberAsc(left.trust, right.trust) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareStable(left, right)
  )
}

function compareRemainingMemory(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareScope(left, right) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareTimeDesc(left.created, right.created) ||
    compareStable(left, right)
  )
}

function compareNewest(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareTimeDesc(left.created, right.created) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareNumberDesc(left.trust, right.trust) ||
    compareStable(left, right)
  )
}

function compareRecentlyConfirmed(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareTimeDesc(left.created, right.created) ||
    compareNumberDesc(left.trust, right.trust) ||
    compareStable(left, right)
  )
}

function compareHighestTrust(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareNumberDesc(left.trust, right.trust) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareTimeDesc(left.created, right.created) ||
    compareStable(left, right)
  )
}

function compareMostContradicted(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return (
    compareNumberDesc(left.contradicted_count, right.contradicted_count) ||
    compareTimeDesc(left.last_confirmed, right.last_confirmed) ||
    compareTimeDesc(left.created, right.created) ||
    compareStable(left, right)
  )
}

function compareStable(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return compareScope(left, right) || left.id.localeCompare(right.id)
}

function compareScope(
  left: MemoryAtlasObservation,
  right: MemoryAtlasObservation,
): number {
  return scopeIndex(left.scope) - scopeIndex(right.scope)
}

function scopeIndex(scope: MemoryAtlasObservation["scope"]): number {
  return SCOPE_ORDER.indexOf(scope)
}

function compareNumberDesc(left: number, right: number): number {
  return right - left
}

function compareNumberAsc(left: number, right: number): number {
  return left - right
}

function compareTimeDesc(left: string, right: string): number {
  const leftMs = toTime(left)
  const rightMs = toTime(right)

  if (leftMs === rightMs) {
    return 0
  }
  if (leftMs === null) {
    return 1
  }
  if (rightMs === null) {
    return -1
  }
  return rightMs - leftMs
}

function compareSource(left: string, right: string): number {
  return (
    left.localeCompare(right, undefined, { sensitivity: "base" }) ||
    left.localeCompare(right)
  )
}

function sortObservations(
  observations: MemoryAtlasObservation[],
  compare: (left: MemoryAtlasObservation, right: MemoryAtlasObservation) => number,
): MemoryAtlasObservation[] {
  return [...observations].sort(compare)
}

function toTime(value: string | Date): number | null {
  const time =
    value instanceof Date ? value.getTime() : Date.parse(value)

  return Number.isNaN(time) ? null : time
}
