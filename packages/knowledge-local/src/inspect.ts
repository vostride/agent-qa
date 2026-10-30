import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  InspectFilterSchema,
  InspectRecordViewSchema,
  canonicalJson,
  normalizeAnchor,
  survivingOutcomeEvents,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  DerivedTrustState,
  InspectFilter,
  InspectRecordView,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import { isServable } from './bundle-scan.js'
import type { EnumeratedBundleDir } from './bundle-scan.js'
import {
  enumerateMaintenanceBundleDirs,
  loadMaintenanceBundle,
} from './maintenance-scan.js'

export interface InspectRecordsOptions {
  knowledgeRoot: string
  filter: InspectFilter
}

// Maintenance exposes lifecycle and evidence counts, never the numerical trust scalar.
type InspectionTrustState = Pick<DerivedTrustState, 'status' | 'counters' | 'validity'>

const TRUST_NARRATIVE_REL_PATH = 'evidence/evidence.md'

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parsedAnchor(value: string): Anchor | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  const record = objectRecord(parsed)
  if (record === undefined || typeof record.t !== 'string') return undefined

  switch (record.t) {
    case 'page':
      return typeof record.route === 'string' ? { t: 'page', route: record.route } : undefined
    case 'flow':
      return typeof record.name === 'string' ? { t: 'flow', name: record.name } : undefined
    case 'el':
      return typeof record.role === 'string' && typeof record.name === 'string'
        ? {
            t: 'el',
            role: record.role,
            name: record.name,
            ...(typeof record.ordinal === 'number' ? { ordinal: record.ordinal } : {}),
          }
        : undefined
    case 'platform':
      return typeof record.platform === 'string'
        ? parsed as Anchor
        : undefined
    case 'selector':
      return typeof record.literal === 'string'
        ? { t: 'selector', literal: record.literal }
        : undefined
    case 'error':
      return typeof record.message === 'string'
        ? { t: 'error', message: record.message }
        : undefined
    default:
      return undefined
  }
}

function scalarAnchorMatches(anchor: Anchor, filter: string): boolean {
  switch (anchor.t) {
    case 'page':
      return canonicalJson(normalizeAnchor({ t: 'page', route: filter }))
        === canonicalJson(anchor)
    case 'flow':
      return canonicalJson(normalizeAnchor({ t: 'flow', name: filter }))
        === canonicalJson(anchor)
    case 'el': {
      const normalizedName = normalizeAnchor({
        t: 'el',
        role: anchor.role,
        name: filter,
      })
      return normalizedName.t === 'el' && normalizedName.name === anchor.name
    }
    case 'platform':
      return filter.trim().toLowerCase() === anchor.platform
    case 'selector':
      return canonicalJson(normalizeAnchor({ t: 'selector', literal: filter }))
        === canonicalJson(anchor)
    case 'error':
      return canonicalJson(normalizeAnchor({ t: 'error', message: filter }))
        === canonicalJson(anchor)
  }
}

function anchorMatches(bundle: LoadedBundle, filter: string | undefined): boolean {
  if (filter === undefined) return true
  const normalizedAnchors = bundle.frontmatter.anchors.map(({ raw }) => normalizeAnchor(raw))
  const structured = parsedAnchor(filter)
  if (structured !== undefined) {
    const canonicalFilter = canonicalJson(normalizeAnchor(structured))
    return normalizedAnchors.some((anchor) => canonicalJson(anchor) === canonicalFilter)
  }
  return normalizedAnchors.some((anchor) => scalarAnchorMatches(anchor, filter))
}

function readTrustNarrative(dir: string, bundle: LoadedBundle): string | undefined {
  if (!(TRUST_NARRATIVE_REL_PATH in bundle.manifest.contentHashes)) return undefined
  const file = join(dir, TRUST_NARRATIVE_REL_PATH)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

/**
 * Project ONE loaded bundle and its already-derived trust into the maintenance view.
 *
 * The fold below and `showRecord` both render through this, so a record's row and detail agree.
 * `bundle.events` is taken as given: an as-of caller narrows the visible events first.
 */
export function toInspectRecordView(
  entry: EnumeratedBundleDir,
  bundle: LoadedBundle,
  trust: InspectionTrustState,
): InspectRecordView {
  const survivingEvents = survivingOutcomeEvents(bundle.events)
  const evidenceTokens = [...new Set(
    survivingEvents.map((event) => String(event.evidenceToken)),
  )].sort(compareText)
  const lastEventOrdinal = survivingEvents.reduce(
    (latest, event) => Math.max(latest, event.buildOrdinal),
    bundle.manifest.createdAtOrdinal,
  )
  const trustNarrative = readTrustNarrative(entry.dir, bundle)

  return InspectRecordViewSchema.parse({
    schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
    recordId: bundle.manifest.id,
    product: entry.product,
    scope: bundle.frontmatter.scope.key,
    kind: bundle.frontmatter.kind,
    status: trust.status,
    confirmations: trust.counters.confirmed,
    contradictions: trust.counters.contradicted,
    evidenceTokens,
    lastEventOrdinal,
    openedAtOrdinal: trust.validity.openedAtOrdinal,
    ...(trust.validity.closedAtOrdinal === undefined
      ? {}
      : { closedAtOrdinal: trust.validity.closedAtOrdinal }),
    anchors: bundle.frontmatter.anchors
      .map(({ raw }) => canonicalJson(normalizeAnchor(raw)))
      .sort(compareText),
    ...(trustNarrative === undefined ? {} : { trustNarrative }),
  })
}

/**
 * Fold canonical committed bundles into maintenance views. Explicit non-live status filters and
 * as-of queries enable audit visibility; an unqualified query retains the serving firewall.
 */
export function inspectRecords(options: InspectRecordsOptions): InspectRecordView[] {
  const filter = InspectFilterSchema.parse(options.filter)
  const records: InspectRecordView[] = []
  const auditVisibility = filter.asOfBuild !== undefined
    || filter.status === 'superseded'
    || filter.status === 'deprecated'

  for (const entry of enumerateMaintenanceBundleDirs(options.knowledgeRoot)) {
    if (filter.product !== undefined && filter.product !== entry.product) continue
    const bundle = loadMaintenanceBundle(entry)
    const asOfBuild = filter.asOfBuild
    if (
      asOfBuild !== undefined
      && bundle.manifest.createdAtOrdinal > asOfBuild
    ) continue
    const visibleEvents = asOfBuild === undefined
      ? bundle.events
      : bundle.events.filter((event) => event.buildOrdinal <= asOfBuild)
    const visibleBundle = visibleEvents === bundle.events
      ? bundle
      : { ...bundle, events: visibleEvents }
    const trust: InspectionTrustState = deriveBundleTrust(visibleBundle)
    if (!auditVisibility && !isServable(trust)) continue
    if (filter.scope !== undefined && filter.scope !== bundle.frontmatter.scope.key) continue
    if (filter.kind !== undefined && filter.kind !== bundle.frontmatter.kind) continue
    if (filter.status !== undefined && filter.status !== trust.status) continue
    if (filter.recordId !== undefined && filter.recordId !== bundle.manifest.id) continue
    if (!anchorMatches(bundle, filter.anchor)) continue
    if (filter.unresolvedOnly === true && (
      bundle.frontmatter.kind !== 'unknown' || !isServable(trust)
    )) continue

    records.push(toInspectRecordView(entry, visibleBundle, trust))
  }

  return records.sort((left, right) => (
    compareText(left.recordId, right.recordId)
    || compareText(left.product, right.product)
  ))
}
