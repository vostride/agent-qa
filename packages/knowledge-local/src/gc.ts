import { rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { asRecordId, survivingOutcomeEvents } from '@vostride/agent-qa-schema'
import type {
  DerivedTrustState,
  RecordId,
} from '@vostride/agent-qa-schema'

import { deriveBundleTrust, loadBundle } from './bundle-read.js'
import type { LoadedBundle } from './bundle-read.js'
import { enumerateBundleDirs } from './bundle-scan.js'
import { assertWithinKnowledgeRoot } from './knowledge-containment.js'
import {
  foldSupersessionLineage,
  scanCanonicalBundles,
} from './curator/lineage-fold.js'
import type { CanonicalBundleSnapshot } from './curator/lineage-fold.js'
import {
  withCurrentWriterAuthority,
  type WriterLeaseAuthority,
} from './lease/writer-lease.js'

/**
 * PROVISIONAL D-13 superseded-generation retention depth. M3 may calibrate the
 * value against gate receipts, but it remains an internal constitution value
 * and never a runtime config key.
 */
export const GC_SUPERSEDED_RETAIN_K = 3

/**
 * D-13 gate seam. M2 always passes `{ kind: 'none' }`; M3 plugs real gate
 * receipt ordinals into the second variant with zero shape change.
 */
export type GateHorizon =
  | { kind: 'none' }
  | { kind: 'ordinal'; deepestGateOrdinal: number }

export interface GcSummary {
  trimmedRecordIds: RecordId[]
  skipped: {
    unknownRef: number
    withinK: number
    userOrigin: number
    horizon: number
  }
}

export interface RunKnowledgeGcInput {
  knowledgeRoot: string
  horizon: GateHorizon
  retainK?: number
}

export interface RunKnowledgeGcHooks {
  /** Test/chaos seam immediately before the authority check for one planned removal. */
  beforeGcRemoval?(recordId: RecordId): void
}

interface GcBundle {
  recordId: RecordId
  dir: string
  bundle: LoadedBundle
  // GC selection depends only on lifecycle and horizon, never numerical trust.
  trust: Pick<DerivedTrustState, 'status' | 'validity'>
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validateInput(input: RunKnowledgeGcInput): number {
  if (!isAbsolute(input.knowledgeRoot)) {
    throw new TypeError('runKnowledgeGc knowledgeRoot must be absolute')
  }
  const retainK = input.retainK ?? GC_SUPERSEDED_RETAIN_K
  if (!Number.isSafeInteger(retainK) || retainK < 0) {
    throw new RangeError('runKnowledgeGc retainK must be a non-negative safe integer')
  }
  if (
    input.horizon.kind === 'ordinal'
    && (
      !Number.isSafeInteger(input.horizon.deepestGateOrdinal)
      || input.horizon.deepestGateOrdinal < 0
    )
  ) {
    throw new RangeError(
      'runKnowledgeGc deepestGateOrdinal must be a non-negative safe integer',
    )
  }
  return retainK
}

function loadGcBundles(knowledgeRoot: string): Map<RecordId, GcBundle> {
  const bundles = new Map<RecordId, GcBundle>()
  for (const entry of enumerateBundleDirs(knowledgeRoot)) {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') continue
    const recordId = asRecordId(loaded.bundle.manifest.id)
    bundles.set(recordId, {
      recordId,
      dir: entry.dir,
      bundle: loaded.bundle,
      trust: deriveBundleTrust(loaded.bundle),
    })
  }
  return bundles
}

function latestBuildOrdinal(bundles: readonly CanonicalBundleSnapshot[]): number {
  let latest = 1
  for (const bundle of bundles) {
    latest = Math.max(latest, bundle.createdAtOrdinal)
    for (const event of bundle.events) latest = Math.max(latest, event.buildOrdinal)
  }
  return latest
}

function latestSupersessionOrdinal(bundle: CanonicalBundleSnapshot): number {
  let latest = bundle.createdAtOrdinal
  for (const event of survivingOutcomeEvents(bundle.events)) {
    if (event.type === 'superseded') latest = Math.max(latest, event.buildOrdinal)
  }
  return latest
}

function unknownConflictRecordIds(bundle: LoadedBundle): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bundle.manifest.identityCore.discriminantKey)
  } catch (error) {
    throw new TypeError(
      `unknown bundle ${bundle.manifest.id} has a non-JSON discriminant key`,
      { cause: error },
    )
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || !('kind' in parsed)
    || parsed.kind !== 'unknown'
    || !('conflictRecordIds' in parsed)
    || !Array.isArray(parsed.conflictRecordIds)
    || parsed.conflictRecordIds.some((recordId) => typeof recordId !== 'string')
  ) {
    throw new TypeError(
      `unknown bundle ${bundle.manifest.id} has an invalid conflict-record discriminant`,
    )
  }
  return parsed.conflictRecordIds
}

function buildUnknownReferenceExclusion(bundles: Iterable<GcBundle>): Set<string> {
  const referenced = new Set<string>()
  for (const candidate of bundles) {
    if (
      candidate.bundle.frontmatter.kind !== 'unknown'
      || candidate.trust.status === 'deprecated'
      || candidate.trust.status === 'superseded'
    ) {
      continue
    }
    for (const recordId of unknownConflictRecordIds(candidate.bundle)) {
      referenced.add(recordId)
    }
    for (const relation of candidate.bundle.relations.relations) {
      referenced.add(relation.targetId)
    }
  }
  return referenced
}

function intersectsGateHorizon(
  validity: DerivedTrustState['validity'],
  horizon: GateHorizon,
): boolean {
  if (horizon.kind === 'none') return false
  // Validity is half-open [opened, closed). It intersects [N, +infinity) iff
  // it remains open strictly beyond N; an unclosed window always intersects.
  return validity.closedAtOrdinal === undefined
    || validity.closedAtOrdinal > horizon.deepestGateOrdinal
}

function buildWithinKExclusion(
  snapshots: readonly CanonicalBundleSnapshot[],
  retainK: number,
): { supersededChainIds: Set<RecordId>; withinK: Set<RecordId> } {
  const byRecordId = new Map(snapshots.map((snapshot) => [snapshot.recordId, snapshot]))
  const asOfBuildOrdinal = latestBuildOrdinal(snapshots)
  const lineage = foldSupersessionLineage(snapshots, {
    windowBuilds: asOfBuildOrdinal,
    asOfBuildOrdinal,
  })
  const supersededChainIds = new Set<RecordId>()
  const withinK = new Set<RecordId>()

  for (const folded of lineage.values()) {
    const superseded = folded.chainRecordIds
      .flatMap((recordId) => {
        const snapshot = byRecordId.get(recordId)
        return snapshot?.status === 'superseded' ? [snapshot] : []
      })
      .sort((left, right) =>
        latestSupersessionOrdinal(right) - latestSupersessionOrdinal(left)
        || right.createdAtOrdinal - left.createdAtOrdinal
        || compareText(right.recordId, left.recordId),
      )
    for (const snapshot of superseded) supersededChainIds.add(snapshot.recordId)
    for (const snapshot of superseded.slice(0, retainK)) withinK.add(snapshot.recordId)
  }

  return { supersededChainIds, withinK }
}

/**
 * Trim only whole superseded bundle directories after constructing every D-13
 * exclusion set. No projection SQL exists here by design: the drain tail feeds
 * trimmedRecordIds straight into removeBundleProjectionRows, so the disposable
 * index heals in the same drain.
 *
 * RATIFICATION: this typed in-memory summary, surfaced through drain diagnostics,
 * is the low-cost §9.2-style operational note. GC writes no persisted note artifact.
 */
export function runKnowledgeGc(
  input: RunKnowledgeGcInput,
  writerAuthority: WriterLeaseAuthority,
  hooks: RunKnowledgeGcHooks = {},
): GcSummary {
  const retainK = validateInput(input)
  if (writerAuthority.knowledgeRoot !== input.knowledgeRoot) {
    throw new TypeError('GC writerAuthority must belong to knowledgeRoot')
  }
  const snapshots = scanCanonicalBundles(input.knowledgeRoot)
  const loaded = loadGcBundles(input.knowledgeRoot)

  // Pitfall 10: build the complete exclusion set before the first destructive write.
  const unknownRef = buildUnknownReferenceExclusion(loaded.values())
  const { supersededChainIds, withinK } = buildWithinKExclusion(snapshots, retainK)
  const userOrigin = new Set(
    [...loaded.values()]
      .filter(({ bundle }) => bundle.frontmatter.originClass === 'user')
      .map(({ recordId }) => recordId),
  )
  const horizon = new Set(
    [...loaded.values()]
      .filter(({ trust }) => intersectsGateHorizon(trust.validity, input.horizon))
      .map(({ recordId }) => recordId),
  )

  const skipped = { unknownRef: 0, withinK: 0, userOrigin: 0, horizon: 0 }
  const trim: GcBundle[] = []
  for (const recordId of [...supersededChainIds].sort(compareText)) {
    const candidate = loaded.get(recordId)
    if (candidate === undefined || candidate.trust.status !== 'superseded') continue
    if (withinK.has(recordId)) {
      skipped.withinK += 1
      continue
    }
    let excluded = false
    if (unknownRef.has(recordId)) {
      skipped.unknownRef += 1
      excluded = true
    }
    if (userOrigin.has(recordId)) {
      skipped.userOrigin += 1
      excluded = true
    }
    if (horizon.has(recordId)) {
      skipped.horizon += 1
      excluded = true
    }
    if (!excluded) trim.push(candidate)
  }

  for (const candidate of trim) {
    hooks.beforeGcRemoval?.(candidate.recordId)
    withCurrentWriterAuthority(
      input.knowledgeRoot,
      writerAuthority,
      () => {
        // never delete a bundle reached through a link out of the knowledge root.
        assertWithinKnowledgeRoot(input.knowledgeRoot, candidate.dir)
        rmSync(candidate.dir, { recursive: true, force: false })
      },
    )
  }
  return {
    trimmedRecordIds: trim.map(({ recordId }) => recordId),
    skipped,
  }
}
