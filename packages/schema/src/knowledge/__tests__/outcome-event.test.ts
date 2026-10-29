import { describe, expect, expectTypeOf, it } from 'vitest'

import { asEvidenceToken, asRecordId } from '../../ids/record-id'
import {
  BundleOutcomeEventSchema,
  OVERTURNED_EVENT_TYPE,
  dedupeEvents,
  eventDedupKey,
  survivingOutcomeEvents,
  type BundleOutcomeEvent,
  type OriginClass,
} from '../outcome-event'

const baseEvent = {
  evidenceToken: asEvidenceToken('evidence-a'),
  curationJobId: 'curation-a',
  buildOrdinal: 42,
  observationOrdinal: 7,
  observationId: 'observation-a',
}

describe('BundleOutcomeEventSchema', () => {
  it('pins and round-trips the strict overturned citing arm', () => {
    expect(OVERTURNED_EVENT_TYPE).toBe('overturned')
    const line = {
      ...baseEvent, type: 'overturned', overturnsEvidenceToken: 'target',
      overturnsCurationJobId: 'target-job', markId: 'mark_012345abcdef',
    }
    expect(BundleOutcomeEventSchema.parse(JSON.parse(JSON.stringify(line)))).toEqual(line)
    expect(BundleOutcomeEventSchema.safeParse({ ...line, markId: undefined }).success).toBe(false)
    expect(BundleOutcomeEventSchema.safeParse({ ...line, markId: 'mark_invalid' }).success).toBe(false)
    expect(BundleOutcomeEventSchema.safeParse({ ...line, origin: 'user' }).success).toBe(false)
  })
  it('keeps OriginClass closed to the four origin-prior classes', () => {
    expectTypeOf<OriginClass>().toEqualTypeOf<
      'user' | 'agent-verified' | 'agent-observed' | 'import'
    >()
  })

  it.each<BundleOutcomeEvent>([
    { ...baseEvent, type: 'confirmed', origin: 'user' },
    { ...baseEvent, type: 'contradicted', origin: 'agent-verified' },
    { ...baseEvent, type: 'helpful', origin: 'agent-observed' },
    { ...baseEvent, type: 'harmful', origin: 'import' },
    { ...baseEvent, type: 'superseded', byRecordId: asRecordId('record-successor') },
    { ...baseEvent, type: 'deprecated', reason: 'superseded by product behavior' },
    { ...baseEvent, type: 'promoted' },
    { ...baseEvent, type: 'window-close', closedAtOrdinal: 51 },
  ])('parses the $type event variant', (event) => {
    expect(BundleOutcomeEventSchema.parse(event)).toEqual(event)
  })

  it('rejects an unknown event type', () => {
    expect(BundleOutcomeEventSchema.safeParse({
      ...baseEvent,
      type: 'invented-by-payload',
    }).success).toBe(false)
  })

  it('rejects extra and derived scalar keys instead of accepting payload-set trust', () => {
    expect(BundleOutcomeEventSchema.safeParse({
      ...baseEvent,
      type: 'confirmed',
      trust: 1,
    }).success).toBe(false)
  })

  it.each(['evidenceToken', 'curationJobId', 'buildOrdinal'] as const)(
    'rejects a line missing required %s',
    (field) => {
      const event: Record<string, unknown> = { ...baseEvent, type: 'promoted' }
      delete event[field]

      expect(BundleOutcomeEventSchema.safeParse(event).success).toBe(false)
    },
  )

  it('rejects a per-line schemaVersion because the bundle manifest owns versioning', () => {
    expect(BundleOutcomeEventSchema.safeParse({
      ...baseEvent,
      type: 'promoted',
      schemaVersion: 1,
    }).success).toBe(false)
  })

  it('parses the strict retracted restoration event', () => {
    const event = {
      ...baseEvent,
      type: 'retracted',
      retractsEvidenceToken: asEvidenceToken('evidence-target'),
      retractsCurationJobId: 'curation-target',
      rollbackReceiptId: 'rollback-receipt-a',
    }

    expect(BundleOutcomeEventSchema.parse(event)).toEqual(event)
    expect(BundleOutcomeEventSchema.safeParse({
      ...event,
      rollbackReceiptId: undefined,
    }).success).toBe(false)
    expect(BundleOutcomeEventSchema.safeParse({
      ...event,
      derivedRestorationStatus: 'active',
    }).success).toBe(false)
  })
})

describe('outcome-event deduplication', () => {
  it('builds the planner-pinned token and curation-job key', () => {
    const event: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }

    expect(eventDedupKey(event)).toBe('evidence-a:curation-a')
  })

  it('keeps the first event and drops later events with the same dedup key', () => {
    const first: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }
    const duplicate: BundleOutcomeEvent = {
      ...baseEvent,
      type: 'contradicted',
      buildOrdinal: 99,
    }
    const reobservation: BundleOutcomeEvent = {
      ...baseEvent,
      type: 'helpful',
      curationJobId: 'curation-b',
    }

    expect(dedupeEvents([first, duplicate, reobservation])).toEqual([first, reobservation])
  })

  it('gives a retraction its own replay identity instead of colliding with its target', () => {
    const target: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }
    const retraction = BundleOutcomeEventSchema.parse({
      ...baseEvent,
      evidenceToken: asEvidenceToken('retraction-evidence'),
      curationJobId: 'rollback-job',
      type: 'retracted',
      retractsEvidenceToken: target.evidenceToken,
      retractsCurationJobId: target.curationJobId,
      rollbackReceiptId: 'rollback-receipt-a',
    })

    expect(eventDedupKey(retraction)).not.toBe(eventDedupKey(target))
  })
})

describe('survivingOutcomeEvents', () => {
  function retraction(
    target: BundleOutcomeEvent,
    evidenceToken: string,
    curationJobId = `rollback-${evidenceToken}`,
  ): BundleOutcomeEvent {
    return BundleOutcomeEventSchema.parse({
      ...baseEvent,
      evidenceToken,
      curationJobId,
      type: 'retracted',
      retractsEvidenceToken: target.evidenceToken,
      retractsCurationJobId: target.curationJobId,
      rollbackReceiptId: 'rollback-receipt-a',
    })
  }

  it('removes only the exact evidence-token and curation-job target identity', () => {
    const target: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }
    const adjacentIdentity: BundleOutcomeEvent = {
      ...baseEvent,
      type: 'helpful',
      curationJobId: 'curation-b',
    }
    const retractTarget = retraction(target, 'retraction-evidence')
    const input = [target, adjacentIdentity, retractTarget]

    expect(survivingOutcomeEvents(input)).toEqual([adjacentIdentity])
    expect(input).toEqual([target, adjacentIdentity, retractTarget])
  })

  it('returns deterministic empty boundaries for no events and only retractions', () => {
    const absentTarget: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }

    expect(survivingOutcomeEvents([])).toEqual([])
    expect(survivingOutcomeEvents([
      retraction(absentTarget, 'orphan-retraction'),
    ])).toEqual([])
  })

  it('deduplicates first-wins before collecting conflicting replayed retractions', () => {
    const firstTarget: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }
    const secondTarget: BundleOutcomeEvent = {
      ...baseEvent,
      type: 'harmful',
      evidenceToken: asEvidenceToken('evidence-b'),
    }
    const firstRetraction = retraction(firstTarget, 'same-retraction', 'rollback-job')
    const replayedRetraction = retraction(secondTarget, 'same-retraction', 'rollback-job')

    expect(survivingOutcomeEvents([
      firstTarget,
      secondTarget,
      firstRetraction,
      replayedRetraction,
    ])).toEqual([secondTarget])
  })

  it('removes a target even when its retraction appears earlier in append order', () => {
    const target: BundleOutcomeEvent = { ...baseEvent, type: 'confirmed' }
    const retractTarget = retraction(target, 'earlier-retraction')

    expect(survivingOutcomeEvents([retractTarget, target])).toEqual([])
  })
})
