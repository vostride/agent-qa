import {
  asRecordId,
  normalizeAnchor,
  survivingOutcomeEvents,
  supersessionKey,
  type Anchor,
  type BundleOutcomeEvent,
  type BundleStatus,
  type RecordId,
  type ScopeKey,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle } from './bundle-read.js'
import { enumerateBundleDirs } from './bundle-scan.js'

/**
 * LOCKED memory.md §9.5 trip depth. This is a constitution value ratified as
 * three supersessions, never a runtime config key.
 */
export const THRASH_MAX_SUPERSESSIONS = 3

/**
 * LOCKED memory.md §9.5 ordinal window. This is a five-build constitution
 * value, never wall-clock time and never a runtime config key.
 */
export const THRASH_WINDOW_BUILDS = 5

// Stable-window closure runs disposition-side on Confirm, reusing the thrash window's width.
export const STABLE_WINDOW_BUILDS = 5

export const SCOPE_BURST_THRESHOLD = 8

export const SCOPE_BURST_WINDOW_BUILDS = 5

export interface CanonicalBundleSnapshot {
  recordId: RecordId
  kind: 'fact' | 'procedure' | 'caution' | 'unknown' | 'policy'
  anchors: readonly Anchor[]
  scope: ScopeKey
  createdAtOrdinal: number
  events: readonly BundleOutcomeEvent[]
  status: BundleStatus
  curationJobId?: string
}

export interface SupersessionLineageFold {
  supersededDepthInWindow: number
  latestSupersessionOrdinal?: number
  chainRecordIds: RecordId[]
  windowOpenOrdinal: number
}

export interface FirstSeenScopeFold {
  firstSeenCount: number
  windowOpenOrdinal: number
  recordIds: RecordId[]
  supersessionKeys: string[]
}

export interface OrdinalWindowOptions {
  windowBuilds: number
  asOfBuildOrdinal?: number
}

function compareRecordIds(left: RecordId, right: RecordId): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareSnapshots(
  left: CanonicalBundleSnapshot,
  right: CanonicalBundleSnapshot,
): number {
  return left.createdAtOrdinal - right.createdAtOrdinal
    || compareRecordIds(left.recordId, right.recordId)
}

function resolveAsOfBuildOrdinal(
  bundles: readonly CanonicalBundleSnapshot[],
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit
  let latest = 0
  for (const bundle of bundles) {
    latest = Math.max(latest, bundle.createdAtOrdinal)
    for (const event of bundle.events) latest = Math.max(latest, event.buildOrdinal)
  }
  return latest
}

function windowOpenOrdinal(asOfBuildOrdinal: number, windowBuilds: number): number {
  if (!Number.isInteger(windowBuilds) || windowBuilds < 1) {
    throw new TypeError('windowBuilds must be a positive integer')
  }
  // The runner-local ordinal counter starts each product at one.
  return Math.max(1, asOfBuildOrdinal - windowBuilds + 1)
}

/**
 * Materialize one immutable canonical-bundle snapshot. Index rows never enter a
 * lifecycle decision: every status and event comes from complete bundle truth.
 */
export function scanCanonicalBundles(knowledgeRoot: string): CanonicalBundleSnapshot[] {
  return enumerateBundleDirs(knowledgeRoot)
    .flatMap((entry): CanonicalBundleSnapshot[] => {
      const loaded = loadBundle(entry.dir)
      if (loaded.kind !== 'loaded') return []
      // Lineage counts events and status; it has no numerical trust projection.
      const status = deriveBundleTrust(loaded.bundle).status
      return [{
        recordId: asRecordId(loaded.bundle.manifest.id),
        kind: loaded.bundle.frontmatter.kind,
        anchors: loaded.bundle.frontmatter.anchors.map(({ normalized }) => normalized),
        scope: loaded.bundle.frontmatter.scope,
        createdAtOrdinal: loaded.bundle.manifest.createdAtOrdinal,
        events: loaded.bundle.events,
        status,
        ...(loaded.bundle.provenance.mode === 'run-linked'
          && loaded.bundle.provenance.curationJobId !== undefined
          ? { curationJobId: loaded.bundle.provenance.curationJobId }
          : {}),
      }]
    })
    .sort(compareSnapshots)
}

// Only `superseded` events count: a stable widening emits Confirm and adds no depth.
export function foldSupersessionLineage(
  bundles: readonly CanonicalBundleSnapshot[],
  options: OrdinalWindowOptions,
): Map<string, SupersessionLineageFold> {
  const asOfBuildOrdinal = resolveAsOfBuildOrdinal(bundles, options.asOfBuildOrdinal)
  const openOrdinal = windowOpenOrdinal(asOfBuildOrdinal, options.windowBuilds)
  const mutable = new Map<string, {
    supersededDepthInWindow: number
    latestSupersessionOrdinal?: number
    chainRecordIds: Set<RecordId>
  }>()

  for (const bundle of bundles) {
    if (bundle.kind === 'unknown') continue
    const key = supersessionKey(bundle.anchors)
    let folded = mutable.get(key)
    if (folded === undefined) {
      folded = {
        supersededDepthInWindow: 0,
        chainRecordIds: new Set<RecordId>(),
      }
      mutable.set(key, folded)
    }

    for (const event of survivingOutcomeEvents(bundle.events)) {
      if (
        event.type !== 'superseded'
        || event.buildOrdinal < openOrdinal
        || event.buildOrdinal > asOfBuildOrdinal
      ) {
        continue
      }
      folded.supersededDepthInWindow += 1
      folded.latestSupersessionOrdinal = Math.max(
        folded.latestSupersessionOrdinal ?? event.buildOrdinal,
        event.buildOrdinal,
      )
      folded.chainRecordIds.add(bundle.recordId)
      folded.chainRecordIds.add(event.byRecordId)
    }
  }

  return new Map(
    [...mutable.entries()].map(([key, folded]) => [key, {
      supersededDepthInWindow: folded.supersededDepthInWindow,
      ...(folded.latestSupersessionOrdinal === undefined
        ? {}
        : { latestSupersessionOrdinal: folded.latestSupersessionOrdinal }),
      chainRecordIds: [...folded.chainRecordIds].sort(compareRecordIds),
      windowOpenOrdinal: openOrdinal,
    }]),
  )
}

/** Page scopes take precedence; flow scopes cover records without a page anchor. */
export function anchorScopeKey(anchors: readonly Anchor[]): string | undefined {
  const normalized = anchors.map(normalizeAnchor)
  const page = normalized.find(
    (anchor): anchor is Extract<Anchor, { t: 'page' }> => anchor.t === 'page',
  )
  if (page !== undefined) return `page:${page.route}`
  const flow = normalized.find(
    (anchor): anchor is Extract<Anchor, { t: 'flow' }> => anchor.t === 'flow',
  )
  return flow === undefined ? undefined : `flow:${flow.name}`
}

/**
 * Fold first-seen supersession groups by page:/flow: scope. A group contributes
 * exactly once, at its earliest canonical bundle ordinal; later generations do
 * not inflate a restructuring burst.
 */
export function foldFirstSeenAnchorsByScope(
  bundles: readonly CanonicalBundleSnapshot[],
  options: OrdinalWindowOptions,
): Map<string, FirstSeenScopeFold> {
  const asOfBuildOrdinal = resolveAsOfBuildOrdinal(bundles, options.asOfBuildOrdinal)
  const openOrdinal = windowOpenOrdinal(asOfBuildOrdinal, options.windowBuilds)
  const firstBySupersessionKey = new Map<string, CanonicalBundleSnapshot>()

  for (const bundle of bundles) {
    if (bundle.kind === 'unknown' || bundle.createdAtOrdinal > asOfBuildOrdinal) continue
    const key = supersessionKey(bundle.anchors)
    const current = firstBySupersessionKey.get(key)
    if (current === undefined || compareSnapshots(bundle, current) < 0) {
      firstBySupersessionKey.set(key, bundle)
    }
  }

  const mutable = new Map<string, {
    recordIds: RecordId[]
    supersessionKeys: string[]
  }>()
  for (const [key, first] of firstBySupersessionKey) {
    if (first.createdAtOrdinal < openOrdinal) continue
    const scopeKey = anchorScopeKey(first.anchors)
    if (scopeKey === undefined) continue
    const folded = mutable.get(scopeKey) ?? { recordIds: [], supersessionKeys: [] }
    folded.recordIds.push(first.recordId)
    folded.supersessionKeys.push(key)
    mutable.set(scopeKey, folded)
  }

  return new Map(
    [...mutable.entries()].map(([key, folded]) => [key, {
      firstSeenCount: folded.recordIds.length,
      windowOpenOrdinal: openOrdinal,
      recordIds: folded.recordIds.sort(compareRecordIds),
      supersessionKeys: folded.supersessionKeys.sort(),
    }]),
  )
}
