// Range audit is status-agnostic, so `includeSuperseded` and `asOfRange` stay orthogonal.
import { supersessionKey } from '@vostride/agent-qa-schema'
import type { Anchor } from '@vostride/agent-qa-schema'

import { readLatestBuildOrdinal } from '../build-ordinal-read.js'

export interface AsOfRange {
  lo: number
  hi: number
}

export interface ValidityOptions {
  asOfBuild?: number
  resolveLatestOrdinal?: (product: string) => number | undefined
  runtimeRoot?: string
  asOfRange?: AsOfRange
}

export interface ValidityCandidate {
  readonly bundleId: string
  readonly anchors: readonly Anchor[]
  readonly openedAtOrdinal: number
  readonly closedAtOrdinal: number | null
  readonly createdAtOrdinal: number
  readonly status: string
  readonly product: string
}

export interface ResolveAsOfBuildOptions<TCandidate extends ValidityCandidate>
  extends ValidityOptions {
  product: string
  candidates: readonly TCandidate[]
}

export interface ValidityAudit {
  status: string
  openedAtOrdinal: number
  closedAtOrdinal: number | null
}

export interface ValidityAnnotation {
  servedAs?: 'current' | 'prior-build-hypothesis'
  audit?: ValidityAudit
}

function finiteOrdinal(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/**
 * Resolve explicit → injected → disk truth → index-known maximum. The final rung is degraded:
 * candidate rows cannot reveal a fresh build for which no facts have been observed yet.
 */
export function resolveAsOfBuild<TCandidate extends ValidityCandidate>(
  options: ResolveAsOfBuildOptions<TCandidate>,
): number | undefined {
  const explicit = finiteOrdinal(options.asOfBuild)
  if (explicit !== undefined) return explicit

  const injected = finiteOrdinal(options.resolveLatestOrdinal?.(options.product))
  if (injected !== undefined) return injected

  const disk = options.runtimeRoot === undefined
    ? undefined
    : readLatestBuildOrdinal(options.runtimeRoot, options.product)
  if (disk !== undefined) return disk

  let latest: number | undefined
  for (const candidate of options.candidates) {
    if (!Number.isFinite(candidate.openedAtOrdinal)) continue
    latest = latest === undefined
      ? candidate.openedAtOrdinal
      : Math.max(latest, candidate.openedAtOrdinal)
  }
  return latest
}

function isCurrentAt(candidate: ValidityCandidate, asOfBuild: number): boolean {
  return (
    candidate.openedAtOrdinal <= asOfBuild
    && (candidate.closedAtOrdinal === null || candidate.closedAtOrdinal > asOfBuild)
  )
}

function overlapsRange(candidate: ValidityCandidate, range: AsOfRange): boolean {
  return (
    candidate.openedAtOrdinal <= range.hi
    && (candidate.closedAtOrdinal === null || candidate.closedAtOrdinal > range.lo)
  )
}

function primaryAnchorKey(candidate: ValidityCandidate): string | undefined {
  const primary = candidate.anchors[0]
  return primary === undefined ? undefined : supersessionKey([primary])
}

function isPriorAt(candidate: ValidityCandidate, asOfBuild: number): boolean {
  return (
    candidate.openedAtOrdinal <= asOfBuild
    && candidate.closedAtOrdinal !== null
    && candidate.closedAtOrdinal <= asOfBuild
  )
}

function comparePrior(left: ValidityCandidate, right: ValidityCandidate): number {
  const leftClosed = left.closedAtOrdinal ?? Number.NEGATIVE_INFINITY
  const rightClosed = right.closedAtOrdinal ?? Number.NEGATIVE_INFINITY
  return (
    rightClosed - leftClosed
    || right.createdAtOrdinal - left.createdAtOrdinal
    || (left.bundleId < right.bundleId ? -1 : left.bundleId > right.bundleId ? 1 : 0)
  )
}

function auditAnnotation(candidate: ValidityCandidate): ValidityAudit {
  return {
    status: candidate.status,
    openedAtOrdinal: candidate.openedAtOrdinal,
    closedAtOrdinal: candidate.closedAtOrdinal,
  }
}

/**
 * Apply the half-open current window or, in range-audit posture, return every overlapping fact.
 * Default fallback is selected per normalized primary anchor and preserves the incoming rank order.
 */
export function applyValidity<TCandidate extends ValidityCandidate>(
  candidates: readonly TCandidate[],
  resolvedAsOf: number | undefined,
  options: Pick<ValidityOptions, 'asOfRange'> = {},
): Array<TCandidate & ValidityAnnotation> {
  const range = options.asOfRange
  if (range !== undefined) {
    if (!Number.isFinite(range.lo) || !Number.isFinite(range.hi) || range.lo > range.hi) {
      return []
    }
    return candidates
      .filter((candidate) => overlapsRange(candidate, range))
      .map((candidate) => ({
        ...candidate,
        ...(resolvedAsOf !== undefined && isCurrentAt(candidate, resolvedAsOf)
          ? { servedAs: 'current' as const }
          : {}),
        audit: auditAnnotation(candidate),
      }))
  }

  if (resolvedAsOf === undefined || !Number.isFinite(resolvedAsOf)) return []

  const groups = new Map<
    string,
    { hasCurrent: boolean; prior: TCandidate | undefined }
  >()
  for (const candidate of candidates) {
    const key = primaryAnchorKey(candidate)
    if (key === undefined) continue

    const group = groups.get(key) ?? { hasCurrent: false, prior: undefined }
    if (isCurrentAt(candidate, resolvedAsOf)) {
      group.hasCurrent = true
    } else if (isPriorAt(candidate, resolvedAsOf)) {
      if (group.prior === undefined || comparePrior(candidate, group.prior) < 0) {
        group.prior = candidate
      }
    }
    groups.set(key, group)
  }

  const admitted: Array<TCandidate & ValidityAnnotation> = []
  for (const candidate of candidates) {
    if (isCurrentAt(candidate, resolvedAsOf)) {
      admitted.push({ ...candidate, servedAs: 'current' })
      continue
    }

    const key = primaryAnchorKey(candidate)
    const group = key === undefined ? undefined : groups.get(key)
    if (
      group?.hasCurrent === false
      && group.prior?.bundleId === candidate.bundleId
    ) {
      admitted.push({ ...candidate, servedAs: 'prior-build-hypothesis' })
    }
  }
  return admitted
}
