import {
  canonicalJson,
  deriveEvidenceToken,
  normalizeAnchor,
  supersessionKey,
} from '@vostride/agent-qa-schema'
import type {
  Anchor,
  BundleDraft,
  CurationAuthorship,
  CurationFallbackReason,
  Delta,
  ScopeKey,
} from '@vostride/agent-qa-schema'

import type { CurationJobView, NeighborRecord } from './author-contract.js'

export const RESTRICTED_FALLBACK_DELTA_KINDS = [
  'Add',
  'Confirm',
  'Supersede',
  'Noop',
] as const

type RestrictedFallbackKind = (typeof RESTRICTED_FALLBACK_DELTA_KINDS)[number]
type RestrictedFallbackDelta = Extract<Delta, { kind: RestrictedFallbackKind }>
type FallbackBundleDraft = BundleDraft & { needsEnrichment?: true }

function cloneAnchor(anchor: Anchor): Anchor {
  switch (anchor.t) {
    case 'page':
      return { t: anchor.t, route: anchor.route }
    case 'flow':
      return { t: anchor.t, name: anchor.name }
    case 'el':
      return {
        t: anchor.t,
        role: anchor.role,
        name: anchor.name,
        ...(anchor.ordinal === undefined ? {} : { ordinal: anchor.ordinal }),
      }
    case 'platform':
      return { t: anchor.t, platform: anchor.platform }
    case 'selector':
      return { t: anchor.t, literal: anchor.literal }
    case 'error':
      return { t: anchor.t, message: anchor.message }
  }
}

function cloneScope(scope: ScopeKey): ScopeKey {
  return { tier: scope.tier, key: scope.key }
}

function assertStructurallyPossibleJob(job: CurationJobView): void {
  if (!/^[0-9a-f]{64}$/.test(job.candidateId)) {
    throw new TypeError('fallback requires a guarded candidate content address')
  }
  if (job.anchors.length === 0) {
    throw new TypeError('fallback requires a verified primary anchor')
  }
  if (job.attributingObservationId.length === 0) {
    throw new TypeError('fallback requires an attributing observation id')
  }
  if (job.kind === 'fact' && job.subtype === undefined) {
    throw new TypeError('fallback fact candidates require a subtype')
  }
  if (job.kind !== 'fact' && job.subtype !== undefined) {
    throw new TypeError('fallback non-fact candidates cannot carry a fact subtype')
  }
}

function requiresCapableModelEnrichment(job: CurationJobView): boolean {
  const evidenceFullyDerivable =
    (
      job.kind === 'fact'
      && (job.subtype === 'selector' || job.subtype === 'measurement')
    )
    || (
      job.kind === 'caution'
      && job.rootCauseClass !== undefined
      && job.distilledObservations.some(
        (observation) => observation.error?.rootCauseClass === job.rootCauseClass,
      )
    )
  return !evidenceFullyDerivable || job.summarySeed.trim() === ''
}

function fallbackAuthorship(
  job: CurationJobView,
  fallbackReason: CurationFallbackReason,
): CurationAuthorship {
  return {
    path: 'deterministic-fallback',
    executionContext: job.executionContext,
    fallbackReason,
  }
}

function fallbackDraft(job: CurationJobView): FallbackBundleDraft {
  const needsEnrichment = requiresCapableModelEnrichment(job)

  // Deterministic fallback and capable-model authoring share these identity fields. Because prose
  // is excluded from the content address, later capable re-processing enriches THE SAME bundle
  // rather than minting a duplicate.
  return {
    kind: job.kind,
    ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
    anchors: job.anchors.map(cloneAnchor),
    scope: cloneScope(job.scope),
    summary: job.summarySeed,
    body: job.bodySeed,
    distilledEvidenceRef: {
      id: `curation-candidate-${job.candidateId}`,
      sha: job.candidateId,
    },
    originStage: 'run-curation',
    ...(needsEnrichment ? { needsEnrichment: true as const } : {}),
  }
}

function normalizedAnchorKey(anchor: Anchor): string {
  return canonicalJson(normalizeAnchor(anchor))
}

function exactPrimaryAnchorNeighbor(
  primaryAnchor: Anchor,
  neighbors: readonly NeighborRecord[],
): NeighborRecord | undefined {
  const primaryKey = normalizedAnchorKey(primaryAnchor)
  return [...neighbors]
    .filter((neighbor) => {
      const neighborPrimary = neighbor.anchors[0]
      return neighborPrimary !== undefined && normalizedAnchorKey(neighborPrimary) === primaryKey
    })
    .sort(
      (left, right) =>
        left.alias - right.alias || String(left.recordId).localeCompare(String(right.recordId)),
    )[0]
}

function citedEnvelope(
  job: CurationJobView,
  fallbackReason: CurationFallbackReason,
  neighbor?: NeighborRecord,
) {
  return {
    origin: 'agent' as const,
    scope: cloneScope(job.scope),
    citedIds: neighbor === undefined ? [] : [neighbor.recordId],
    ...(neighbor === undefined
      ? {}
      : {
          precondition: [
            {
              recordId: neighbor.recordId,
              observedStatus: neighbor.observedStatus,
              observedOrdinal: neighbor.observedOrdinal,
            },
          ],
        }),
    authorship: fallbackAuthorship(job, fallbackReason),
  }
}

// Pure; a procedure job falls back to a one-element Noop, retried on a later drain.
export function constructFallbackDeltas(
  job: CurationJobView,
  neighbors: NeighborRecord[],
  fallbackReason: CurationFallbackReason,
): Delta[] {
  assertStructurallyPossibleJob(job)
  if (job.kind === 'procedure') {
    return [{ ...citedEnvelope(job, fallbackReason), kind: 'Noop' }]
  }
  const primaryAnchor = job.anchors[0]!
  const exactNeighbor = exactPrimaryAnchorNeighbor(primaryAnchor, neighbors)
  const evidenceToken = deriveEvidenceToken({
    attributingObservationId: job.attributingObservationId,
    anchor: primaryAnchor,
    buildOrdinal: job.buildOrdinal,
  })

  if (
    job.kind === 'fact' &&
    job.subtype === 'measurement' &&
    exactNeighbor?.kind === 'fact' &&
    exactNeighbor.subtype === 'measurement' &&
    supersessionKey(job.anchors) === supersessionKey(exactNeighbor.anchors)
  ) {
    return [
      {
        ...citedEnvelope(job, fallbackReason, exactNeighbor),
        kind: 'Supersede',
        victimId: exactNeighbor.recordId,
        newBundle: fallbackDraft(job),
        evidenceToken,
      },
    ]
  }

  if (exactNeighbor !== undefined) {
    return [
      {
        ...citedEnvelope(job, fallbackReason, exactNeighbor),
        kind: 'Confirm',
        targetId: exactNeighbor.recordId,
        evidenceToken,
      },
    ]
  }

  return [
    {
      ...citedEnvelope(job, fallbackReason),
      kind: 'Add',
      bundle: fallbackDraft(job),
    },
  ]
}

/** Refuse any model-judgment mutation masquerading as deterministic fallback authorship. */
export function assertRestrictedFallbackDelta(
  delta: Delta,
): asserts delta is RestrictedFallbackDelta {
  switch (delta.kind) {
    case 'Add':
    case 'Confirm':
    case 'Noop':
      return
    case 'Supersede':
      if (delta.newBundle.kind === 'fact' && delta.newBundle.subtype === 'measurement') return
      throw new TypeError('deterministic fallback may supersede measurement facts only')
    case 'Deprecate':
    case 'MintUnknown':
      throw new TypeError(`deterministic fallback cannot emit ${delta.kind}`)
  }
}
