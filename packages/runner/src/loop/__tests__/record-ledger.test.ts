import { describe, expect, it } from 'vitest'
import { asRecordId, type ServingRecordMetadata } from '@vostride/agent-qa-schema'
import { createRecordLedger } from '../record-ledger.js'

function record(
  id: string,
  overrides: Partial<ServingRecordMetadata> = {},
): ServingRecordMetadata {
  return {
    id: asRecordId(id),
    sourceId: id,
    clusterKey: `cluster:${id}`,
    renderedCost: 1,
    ...overrides,
  }
}

describe('createRecordLedger — combined turn serving authority', () => {
  it('admits at cap - 1, refuses a new id at cap, and keeps a counted id slot-free', () => {
    const first = record('record-first')
    const second = record('record-second')
    const third = record('record-third')
    const overflow = record('record-overflow')
    const ledger = createRecordLedger({
      cap: 3,
      budget: 100,
      seedRecords: [first, second],
    })

    expect(ledger.size()).toBe(2)
    expect(ledger.admit(third)).toEqual({ admitted: true })
    expect(ledger.size()).toBe(3)
    expect(ledger.admit(overflow)).toEqual({ admitted: false, reason: 'volume-cap' })
    expect(ledger.admit(first)).toEqual({ admitted: true })
    expect(ledger.size()).toBe(3)
  })

  it('resets each turn to the frozen brief metadata instead of prior-turn accumulation', () => {
    const brief = record('record-brief')
    const firstTurnOnly = record('record-first-turn-only')
    const secondTurnOnly = record('record-second-turn-only')
    const ledger = createRecordLedger({ cap: 2, budget: 100, seedRecords: [brief] })

    expect(ledger.admit(firstTurnOnly)).toEqual({ admitted: true })
    expect(ledger.size()).toBe(2)

    ledger.resetTurn([brief])

    expect(ledger.size()).toBe(1)
    expect(ledger.admit(secondTurnOnly)).toEqual({ admitted: true })
    expect(ledger.admit(firstTurnOnly)).toEqual({ admitted: false, reason: 'volume-cap' })
  })

  it('starts empty when the brief has no learned record metadata', () => {
    const ledger = createRecordLedger({ cap: 2, budget: 100, seedRecords: [] })

    expect(ledger.size()).toBe(0)
    expect(ledger.admit(record('record-one'))).toEqual({ admitted: true })
    expect(ledger.admit(record('record-two'))).toEqual({ admitted: true })
    expect(ledger.admit(record('record-three'))).toEqual({
      admitted: false,
      reason: 'volume-cap',
    })
  })

  it('charges one cluster across Channel 1, Channel 3, and Channel 2 at exact half', () => {
    const sharedCluster = 'cluster:checkout-submit'
    const brief = record('brief-record', { clusterKey: sharedCluster, renderedCost: 20 })
    const caution = record('caution-record', { clusterKey: sharedCluster, renderedCost: 20 })
    const searchAtHalf = record('search-record', {
      clusterKey: sharedCluster,
      renderedCost: 20,
    })
    const searchOverHalf = record('search-overflow', {
      clusterKey: sharedCluster,
      renderedCost: 1,
    })
    const ledger = createRecordLedger({ cap: 8, budget: 120, seedRecords: [brief] })

    expect(ledger.admit(caution)).toEqual({ admitted: true })
    expect(ledger.admit(searchAtHalf)).toEqual({ admitted: true })
    expect(ledger.spent()).toBe(60)
    expect(ledger.inspect(searchOverHalf)).toEqual({
      admitted: false,
      reason: 'cluster-dominance',
    })
    expect(ledger.admit(searchOverHalf)).toEqual({
      admitted: false,
      reason: 'cluster-dominance',
    })
    expect(ledger.spent()).toBe(60)
  })

  it('charges repeated cross-channel bytes even when the distinct id is already counted', () => {
    const repeated = record('repeated-record', { renderedCost: 20 })
    const ledger = createRecordLedger({ cap: 1, budget: 80, seedRecords: [repeated] })

    expect(ledger.admit(repeated)).toEqual({ admitted: true })
    expect(ledger.size()).toBe(1)
    expect(ledger.spent()).toBe(40)
    expect(ledger.admit(repeated)).toEqual({
      admitted: false,
      reason: 'source-dominance',
    })
  })

  it('journals only admitted production exposures in one contiguous step order', () => {
    const brief = record('record-brief', { renderedCost: 5 })
    const repeated = record('record-repeated', { renderedCost: 4 })
    const search = record('record-search', { renderedCost: 3 })
    const refused = record('record-refused', { renderedCost: 100 })
    const ledger = createRecordLedger({ cap: 8, budget: 100, seedRecords: [] })

    ledger.beginStepEvidence()
    ledger.resetTurn([brief], { surface: 'brief-line', turnOrdinal: 0 })
    expect(ledger.admit(repeated, { surface: 'caution', turnOrdinal: 0 })).toEqual({
      admitted: true,
    })
    expect(
      ledger.admit(repeated, { surface: 'procedure-hint', turnOrdinal: 0 }),
    ).toEqual({ admitted: true })
    expect(ledger.admit(search, { surface: 'search-result', turnOrdinal: 1 })).toEqual({
      admitted: true,
    })
    expect(ledger.admit(refused, { surface: 'read-body', turnOrdinal: 1 })).toEqual({
      admitted: false,
      reason: 'budget-cap',
    })

    expect(ledger.drainEvidenceEvents()).toEqual([
      {
        ordinal: 0,
        turnOrdinal: 0,
        surface: 'brief-line',
        id: brief.id,
        sourceId: brief.sourceId,
        clusterKey: brief.clusterKey,
        renderedCost: brief.renderedCost,
        chargeRepeated: false,
      },
      {
        ordinal: 1,
        turnOrdinal: 0,
        surface: 'caution',
        id: repeated.id,
        sourceId: repeated.sourceId,
        clusterKey: repeated.clusterKey,
        renderedCost: repeated.renderedCost,
        chargeRepeated: true,
      },
      {
        ordinal: 2,
        turnOrdinal: 0,
        surface: 'procedure-hint',
        id: repeated.id,
        sourceId: repeated.sourceId,
        clusterKey: repeated.clusterKey,
        renderedCost: repeated.renderedCost,
        chargeRepeated: true,
      },
      {
        ordinal: 3,
        turnOrdinal: 1,
        surface: 'search-result',
        id: search.id,
        sourceId: search.sourceId,
        clusterKey: search.clusterKey,
        renderedCost: search.renderedCost,
        chargeRepeated: true,
      },
    ])
    expect(ledger.drainEvidenceEvents()).toEqual([])
  })

  it('clears only evidence chronology without changing configured admission caps', () => {
    const seed = record('record-seed', { renderedCost: 20 })
    const overflow = record('record-overflow', { renderedCost: 1 })
    const ledger = createRecordLedger({ cap: 1, budget: 80, seedRecords: [seed] })

    ledger.beginStepEvidence()
    ledger.resetTurn([seed], { surface: 'brief-line', turnOrdinal: 4 })
    expect(ledger.drainEvidenceEvents()).toHaveLength(1)

    ledger.beginStepEvidence()
    expect(ledger.drainEvidenceEvents()).toEqual([])
    expect(ledger.size()).toBe(1)
    expect(ledger.spent()).toBe(20)
    expect(ledger.admit(overflow, { surface: 'search-result', turnOrdinal: 5 })).toEqual({
      admitted: false,
      reason: 'volume-cap',
    })
    expect(ledger.drainEvidenceEvents()).toEqual([])
  })
})
