import {
  survivingOutcomeEvents,
  type BundleOutcomeEvent,
  type OriginClass,
} from './outcome-event'

/** The trust priors every fold uses, by origin class. Internal values, never config keys. */
export const ORIGIN_PRIORS = {
  user: { alpha: 3, beta: 1 },
  'agent-verified': { alpha: 2, beta: 1 },
  'agent-observed': { alpha: 1, beta: 1 },
  import: { alpha: 0.5, beta: 1 },
} as const satisfies Record<OriginClass, { alpha: number; beta: number }>

// Multiplies alpha only; an internal constant, never a config key.
export const EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT = 0.5

// An internal constant, never a config key.
export const SERVING_ATTRIBUTION_WEIGHT = 0.25

export type BundleStatus = 'active' | 'candidate' | 'superseded' | 'deprecated'

export interface DerivedTrustState {
  trust: number
  counters: {
    confirmed: number
    contradicted: number
    helpful: number
    harmful: number
  }
  status: BundleStatus
  validity: {
    openedAtOrdinal: number
    closedAtOrdinal?: number
  }
  // Retraction and window restoration never refresh this ordinal.
  lastConfirmedOrdinal: number
}

const STATUS_PRECEDENCE: Record<BundleStatus, number> = {
  active: 4,
  candidate: 3,
  superseded: 2,
  deprecated: 1,
}

function lifecycleStatus(event: BundleOutcomeEvent): BundleStatus | undefined {
  switch (event.type) {
    case 'promoted':
      return 'active'
    case 'superseded':
      return 'superseded'
    case 'deprecated':
      return 'deprecated'
    default:
      return undefined
  }
}

// Counters, status and validity are derived, never stored, and the model never supplies trust.
export function foldBundleTrust(
  events: readonly BundleOutcomeEvent[],
  opts: {
    originClass: OriginClass
    evidenceIncomplete: boolean
    createdAtOrdinal: number
  },
): DerivedTrustState {
  const survivingEvents = survivingOutcomeEvents(events)

  const counters = {
    confirmed: 0,
    contradicted: 0,
    helpful: 0,
    harmful: 0,
  }
  let status: BundleStatus = 'candidate'
  let statusBuildOrdinal = opts.createdAtOrdinal
  let latestClose: { buildOrdinal: number; closedAtOrdinal: number } | undefined
  let lastConfirmedOrdinal: number | undefined

  for (const event of survivingEvents) {
    switch (event.type) {
      case 'overturned':
        // `overturnsEvidenceToken` is read by `survivingOutcomeEvents`; this line adds no count.
        break
      case 'confirmed':
        counters.confirmed += 1
        lastConfirmedOrdinal = Math.max(
          lastConfirmedOrdinal ?? event.buildOrdinal,
          event.buildOrdinal,
        )
        break
      case 'contradicted':
        counters.contradicted += 1
        break
      case 'helpful':
        counters.helpful += 1
        break
      case 'harmful':
        counters.harmful += 1
        break
      case 'window-close':
        if (
          latestClose === undefined
          || event.buildOrdinal > latestClose.buildOrdinal
          || (
            event.buildOrdinal === latestClose.buildOrdinal
            && event.closedAtOrdinal > latestClose.closedAtOrdinal
          )
        ) {
          latestClose = {
            buildOrdinal: event.buildOrdinal,
            closedAtOrdinal: event.closedAtOrdinal,
          }
        }
        break
    }

    const nextStatus = lifecycleStatus(event)
    if (
      nextStatus !== undefined
      && (
        event.buildOrdinal > statusBuildOrdinal
        || (
          event.buildOrdinal === statusBuildOrdinal
          && STATUS_PRECEDENCE[nextStatus] > STATUS_PRECEDENCE[status]
        )
      )
    ) {
      status = nextStatus
      statusBuildOrdinal = event.buildOrdinal
    }
  }

  const prior = ORIGIN_PRIORS[opts.originClass]
  const alpha = prior.alpha * (
    opts.evidenceIncomplete ? EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT : 1
  )
  const positiveEvidence = counters.confirmed + SERVING_ATTRIBUTION_WEIGHT * counters.helpful
  const negativeEvidence = counters.contradicted + SERVING_ATTRIBUTION_WEIGHT * counters.harmful
  const trust = (positiveEvidence + alpha) / (
    positiveEvidence + negativeEvidence + alpha + prior.beta
  )

  return {
    trust,
    counters,
    status,
    validity: latestClose === undefined
      ? { openedAtOrdinal: opts.createdAtOrdinal }
      : {
          openedAtOrdinal: opts.createdAtOrdinal,
          closedAtOrdinal: latestClose.closedAtOrdinal,
        },
    lastConfirmedOrdinal: lastConfirmedOrdinal ?? opts.createdAtOrdinal,
  }
}
