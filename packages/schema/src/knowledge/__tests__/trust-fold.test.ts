import { describe, expect, it } from 'vitest'

import {
  BundleOutcomeEventSchema,
  survivingOutcomeEvents,
  type BundleOutcomeEvent,
  type OriginClass,
} from '../outcome-event'
import {
  EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT,
  ORIGIN_PRIORS,
  SERVING_ATTRIBUTION_WEIGHT,
  foldBundleTrust,
} from '../trust-fold'

function event(
  type: BundleOutcomeEvent['type'],
  token: string,
  buildOrdinal = 1,
  payload: Readonly<Record<string, unknown>> = {},
): BundleOutcomeEvent {
  return BundleOutcomeEventSchema.parse({
    type,
    evidenceToken: token,
    curationJobId: `job-${token}`,
    buildOrdinal,
    ...payload,
  })
}

function retraction(
  target: BundleOutcomeEvent,
  token: string,
  buildOrdinal = target.buildOrdinal + 1,
): BundleOutcomeEvent {
  return event('retracted', token, buildOrdinal, {
    retractsEvidenceToken: target.evidenceToken,
    retractsCurationJobId: target.curationJobId,
    rollbackReceiptId: 'rollback-receipt-a',
  })
}

function fold(
  events: readonly BundleOutcomeEvent[],
  originClass: OriginClass = 'user',
  evidenceIncomplete = false,
) {
  return foldBundleTrust(events, {
    originClass,
    evidenceIncomplete,
    createdAtOrdinal: 5,
  })
}

describe('overturned evidence cancellation', () => {
  function overturn(target: BundleOutcomeEvent, token = 'overturn') {
    return event('overturned', token, 99, {
      overturnsEvidenceToken: target.evidenceToken,
      overturnsCurationJobId: target.curationJobId,
      markId: 'mark_012345abcdef',
    })
  }

  it('cancels the pair without mutating either audit line or counting harm', () => {
    const confirmed = event('confirmed', 'a', 7)
    const overturned = overturn(confirmed)
    const log = Object.freeze([Object.freeze(confirmed), Object.freeze(overturned)])
    const bytes = JSON.stringify(log)
    expect(fold(log)).toEqual(fold([]))
    expect(survivingOutcomeEvents(log)).toEqual([])
    expect(JSON.stringify(log)).toBe(bytes)
    expect(log).toEqual([confirmed, overturned])
  })

  it('cancels only the exact token and job pair, including replay and reversed order', () => {
    const a = event('confirmed', 'a', 7)
    const b = event('confirmed', 'a', 8, { curationJobId: 'another-job' })
    const overturned = overturn(a)
    expect(fold([a, b, overturned])).toEqual(fold([b]))
    expect(fold([overturned, b, a, overturned])).toEqual(fold([b]))
  })

  it.each(['confirmed', 'contradicted', 'helpful', 'harmful'] as const)(
    'cancels %s evidence and retains a previously promoted status', (kind) => {
      const observation = event(kind, 'observation', 7)
      const promoted = event('promoted', 'promoted', 8)
      expect(fold([observation, promoted, overturn(observation)])).toEqual(fold([promoted]))
      expect(fold([promoted, overturn(promoted)])).toEqual(fold([promoted]))
    },
  )
})

describe('foldBundleTrust priors and Beta evidence', () => {
  it.each([
    ['user', 3 / 4],
    ['agent-verified', 2 / 3],
    ['agent-observed', 1 / 2],
    ['import', 1 / 3],
  ] as const)('starts %s at its exact clean prior', (originClass, expected) => {
    expect(fold([], originClass).trust).toBeCloseTo(expected)
  })

  it('discounts only prior alpha when evidence is incomplete', () => {
    const state = fold([], 'user', true)
    const discountedAlpha = ORIGIN_PRIORS.user.alpha * EVIDENCE_INCOMPLETE_ALPHA_DISCOUNT

    expect(state.trust).toBeCloseTo(discountedAlpha / (discountedAlpha + ORIGIN_PRIORS.user.beta))
    expect(state.trust).toBeCloseTo(1.5 / 2.5)
  })

  it('folds direct confirmation to alpha and contradiction to beta', () => {
    expect(fold([event('confirmed', 'confirmed')]).trust).toBeCloseTo(4 / 5)
    expect(fold([event('contradicted', 'contradicted')]).trust).toBeCloseTo(3 / 5)
  })

  it('folds helpful and harmful serving attribution at the provisional fractional weight', () => {
    const helpful = fold([event('helpful', 'helpful')])
    const harmful = fold([event('harmful', 'harmful')])

    expect(SERVING_ATTRIBUTION_WEIGHT).toBe(0.25)
    expect(helpful.trust).toBeCloseTo(3.25 / 4.25)
    expect(harmful.trust).toBeCloseTo(3 / 4.25)
    expect(helpful.counters).toEqual({
      confirmed: 0,
      contradicted: 0,
      helpful: 1,
      harmful: 0,
    })
    expect(harmful.counters).toEqual({
      confirmed: 0,
      contradicted: 0,
      helpful: 0,
      harmful: 1,
    })
  })
})

describe('foldBundleTrust replay and merge laws', () => {
  it('moves no counter when the same evidence-token and job event is replayed', () => {
    const confirmed = event('confirmed', 'same-evidence')

    expect(fold([confirmed, confirmed])).toEqual(fold([confirmed]))
    expect(fold([confirmed, confirmed]).counters.confirmed).toBe(1)
  })

  it('is idempotent when a complete event set is replayed', () => {
    const events = [
      event('confirmed', 'confirm'),
      event('harmful', 'harm'),
      event('promoted', 'promote', 8),
      event('window-close', 'close', 9, { closedAtOrdinal: 9 }),
    ]

    expect(fold([...events, ...events])).toEqual(fold(events))
  })

  it('is commutative for a shuffled set of distinct events', () => {
    const events = [
      event('confirmed', 'confirm'),
      event('helpful', 'help'),
      event('superseded', 'supersede', 6, { byRecordId: 'record-next' }),
      event('promoted', 'promote', 7),
      event('window-close', 'close', 8, { closedAtOrdinal: 12 }),
    ]

    expect(fold([events[4]!, events[2]!, events[0]!, events[3]!, events[1]!])).toEqual(
      fold(events),
    )
  })
})

describe('foldBundleTrust lifecycle derivation', () => {
  it('defaults to candidate and maps each lifecycle event to its status', () => {
    expect(fold([]).status).toBe('candidate')
    expect(fold([event('superseded', 'superseded', 6, { byRecordId: 'record-next' })]).status)
      .toBe('superseded')
    expect(fold([event('deprecated', 'deprecated', 6, { reason: 'obsolete' })]).status)
      .toBe('deprecated')
    expect(fold([event('promoted', 'promoted', 6)]).status).toBe('active')
  })

  it('lets the latest build ordinal win between conflicting lifecycle events', () => {
    const promoted = event('promoted', 'promoted', 10)
    const deprecated = event('deprecated', 'deprecated', 11, { reason: 'unsafe' })

    expect(fold([deprecated, promoted]).status).toBe('deprecated')
  })

  it('breaks equal-build ties by active over candidate over superseded over deprecated', () => {
    const deprecated = event('deprecated', 'deprecated', 12, { reason: 'obsolete' })
    const superseded = event('superseded', 'superseded', 12, { byRecordId: 'record-next' })
    const promoted = event('promoted', 'promoted', 12)

    expect(fold([event('superseded', 'birth-tie', 5, { byRecordId: 'record-next' })]).status)
      .toBe('candidate')
    expect(fold([deprecated, superseded]).status).toBe('superseded')
    expect(fold([promoted, deprecated, superseded]).status).toBe('active')
  })

  it('opens at creation and closes at the latest window-close ordinal when present', () => {
    expect(fold([]).validity).toEqual({ openedAtOrdinal: 5 })

    const earlier = event('window-close', 'close-earlier', 10, { closedAtOrdinal: 10 })
    const later = event('window-close', 'close-later', 20, { closedAtOrdinal: 20 })

    expect(fold([later, earlier]).validity).toEqual({
      openedAtOrdinal: 5,
      closedAtOrdinal: 20,
    })
  })
})

describe('foldBundleTrust retraction restoration', () => {
  it('restores the pre-supersession status and reopens the validity window', () => {
    const confirmed = event('confirmed', 'confirmed-at-5', 5)
    const superseded = event('superseded', 'superseded-at-8', 8, {
      byRecordId: 'record-next',
    })
    const windowClose = event('window-close', 'window-close-at-8', 8, {
      closedAtOrdinal: 8,
    })
    const supersededState = fold([confirmed, superseded, windowClose])

    expect(supersededState.status).toBe('superseded')
    expect(supersededState.validity).toEqual({ openedAtOrdinal: 5, closedAtOrdinal: 8 })

    const restoredState = fold([
      confirmed,
      superseded,
      windowClose,
      retraction(superseded, 'retract-superseded', 9),
      retraction(windowClose, 'retract-window-close', 9),
    ])

    expect(restoredState.status).toBe('candidate')
    expect(restoredState.validity).toEqual({ openedAtOrdinal: 5 })
  })

  it('restores counters, trust, and deprecated status through the same exclusion rule', () => {
    const initialConfirmed = event('confirmed', 'initial-confirmed', 5)
    const laterConfirmed = event('confirmed', 'later-confirmed', 7)
    const deprecated = event('deprecated', 'deprecated-at-9', 9, { reason: 'obsolete' })
    const before = fold([initialConfirmed, laterConfirmed, deprecated])
    const after = fold([
      initialConfirmed,
      laterConfirmed,
      deprecated,
      retraction(laterConfirmed, 'retract-later-confirmed', 10),
      retraction(deprecated, 'retract-deprecated', 10),
    ])

    expect(before.counters.confirmed).toBe(2)
    expect(before.status).toBe('deprecated')
    expect(before.trust).toBeCloseTo(5 / 6)
    expect(after.counters.confirmed).toBe(1)
    expect(after.status).toBe('candidate')
    expect(after.trust).toBeCloseTo(4 / 5)
  })

  it('applies one retraction once when its append is replayed', () => {
    const confirmed = event('confirmed', 'confirmed-to-retract', 5)
    const retractConfirmed = retraction(confirmed, 'retract-confirmed', 6)

    expect(fold([confirmed, retractConfirmed, retractConfirmed])).toEqual(
      fold([confirmed, retractConfirmed]),
    )
    expect(fold([confirmed, retractConfirmed, retractConfirmed]).counters.confirmed).toBe(0)
  })

  it('tracks the latest surviving real confirmation and never a restoration append', () => {
    const confirmedAt3 = event('confirmed', 'confirmed-at-3', 3)
    const confirmedAt7 = event('confirmed', 'confirmed-at-7', 7)
    const deprecated = event('deprecated', 'deprecated-at-9', 9, { reason: 'obsolete' })

    expect(fold([confirmedAt3, confirmedAt7, deprecated])).toHaveProperty(
      'lastConfirmedOrdinal',
      7,
    )
    expect(fold([
      confirmedAt3,
      confirmedAt7,
      deprecated,
      retraction(confirmedAt7, 'retract-confirmed-at-7', 10),
    ])).toHaveProperty('lastConfirmedOrdinal', 3)

    const initialConfirmed = event('confirmed', 'initial-confirmed-only', 5)
    expect(fold([initialConfirmed])).toHaveProperty('lastConfirmedOrdinal', 5)
    expect(fold([
      initialConfirmed,
      deprecated,
      retraction(deprecated, 'late-restoration-append', 100),
    ])).toHaveProperty('lastConfirmedOrdinal', 5)
  })
})
