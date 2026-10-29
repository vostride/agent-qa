// 427 · D-15, D-16, D-17, D-19 part 2 — Memory changes as one row per affected record in 425's
// five words, and every technical fact of those changes gathered for Retrieval details.

import { describe, expect, it } from 'vitest'
import {
  CURATION_BREAKDOWN_BUCKETS,
  CurationSnapshotSchema,
  RunKnowledgeProjectionSchema,
  type RunKnowledgeProjection,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'

import { BREAKDOWN_NOT_RECORDED_TEXT, NO_MEMORY_CHANGES_TEXT, curationBreakdownLine } from '@/lib/post-processing-view'
import {
  BUCKET_LABELS,
  BUCKET_MEANINGS,
  CHANGES_PENDING_TEXT,
  LEDGER_ROW_LABELS,
  NO_MEMORY_CHANGES_SENTENCE,
  OPEN_QUESTION_NOTE,
  PROPOSED_NOTE,
  RECORD_CONTENT_NOT_RECORDED_LEAD,
  RECORD_UNREADABLE_LEAD,
  SINCE_THEN_DETAILS,
  WAS_PREFIX,
  changeLedgerViews,
  learnedView,
  ledgerEventText,
  ledgerValidityText,
  projectKnowledgeView,
  sinceThenDetail,
  sinceThisRunHeading,
} from '@/lib/knowledge-view'

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type LearnedChange = ReadyProjection['learned']['changes'][number]
type Content = NonNullable<LearnedChange['recordContent']>
type CurationStatus = ReadyProjection['curation']['status']

const RUN = 'run-427-08-changes'
const DIGEST = '0123456789abcdef'.repeat(4)

function content(recordId: string, overrides: Partial<Content> = {}): Content {
  return {
    content: `body ${recordId}`,
    summary: `summary ${recordId}`,
    kind: 'fact',
    applicability: { product: 'shop', scope: 'checkout', anchors: [], openedAtOrdinal: 3 },
    currentStatus: 'active',
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [] as string[], lastEventOrdinal: 30 },
    ...overrides,
  }
}

function recorded(recordId: string, change: LearnedChange['change'], atOrdinal: number, extra: Partial<LearnedChange> = {}) {
  return {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION as typeof RECORD_CHANGE_SCHEMA_VERSION, recordId, change, atOrdinal, sourceRunId: RUN,
    evidenceToken: `receipt-${recordId}-${String(atOrdinal)}`, ...extra,
  }
}

function joined(change: ReturnType<typeof recorded>, overrides: Partial<Content> = {}): LearnedChange {
  return { ...change, recordContent: content(change.recordId, overrides) }
}

function fiveBucketSnapshot() {
  return CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: 'fact-added', bucket: 'added', changes: [{ bucket: 'added', change: recorded('fact-added', 'added', 20) }] },
      { recordId: 'fact-confirmed', bucket: 'confirmed', changes: [{ bucket: 'confirmed', change: recorded('fact-confirmed', 'promoted', 21, {
        promotionPath: 'user-sovereign', promotionReceiptDigest: DIGEST,
      }) }] },
      { recordId: 'fact-victim', bucket: 'superseded', byRecordId: 'fact-replacement', changes: [
        { bucket: 'superseded', change: recorded('fact-victim', 'superseded', 22, { byRecordId: 'fact-replacement' }) },
        { bucket: 'added', change: recorded('fact-replacement', 'added', 22) },
      ] },
      { recordId: 'fact-deprecated', bucket: 'deprecated', changes: [{ bucket: 'deprecated', change: recorded('fact-deprecated', 'deprecated', 23, {
        observationId: 'obs-deprecated',
      }) }] },
      { recordId: 'fact-proposed', bucket: 'proposed', changes: [{ bucket: 'proposed', change: recorded('fact-proposed', 'added', 24) }] },
    ],
    breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
  })
}

function snapshotChanges(snapshot: ReturnType<typeof fiveBucketSnapshot>): LearnedChange[] {
  return snapshot.rows.flatMap(row => row.changes.map(entry => joined(entry.change as ReturnType<typeof recorded>)))
}

function projection(
  status: CurationStatus,
  learned: Partial<ReadyProjection['learned']>,
  counts?: { curated: number; deprecated: number },
): ReadyProjection {
  const parsed = RunKnowledgeProjectionSchema.parse({
    kind: 'ready', runId: RUN, buildOrdinal: 2, knowledgeStore: 'bound', steps: [],
    curation: { status, ...(counts === undefined ? {} : { counts }) },
    learned: { changes: [], canaryAttributions: [], ...learned },
  })
  if (parsed.kind !== 'ready') throw new Error('expected a ready projection')
  return parsed
}

function fiveBucketRun(): ReadyProjection {
  const snapshot = fiveBucketSnapshot()
  return projection('complete', {
    changes: snapshotChanges(snapshot), curationSnapshot: snapshot, sinceThen: { changes: [], count: 0 },
  }, { curated: 4, deprecated: 1 })
}

describe('Memory changes are one row per affected record, in the curation bucket words', () => {
  it('ROWS-EQUAL-COUNTS: the five-bucket snapshot is five curation rows in snapshot order under its own breakdown', () => {
    const view = learnedView(fiveBucketRun())
    const breakdown = fiveBucketSnapshot().breakdown

    expect(view.rows.map(row => row.bucket)).toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'proposed'])
    expect(view.rows.map(row => row.section)).toEqual(['curation', 'curation', 'curation', 'curation', 'curation'])
    expect(view.rows.length).toBe(CURATION_BREAKDOWN_BUCKETS.reduce((total, bucket) => total + breakdown[bucket], 0))
    expect(view.countLine).toBe('1 added · 1 confirmed · 1 superseded · 1 deprecated · 1 proposed')
    expect(view.countLine).toBe(curationBreakdownLine(breakdown))
    expect(view.curationSnapshot?.reconciliation).toBeUndefined()
    expect(view.rows.map(row => row.primary)).toEqual([
      'summary fact-added', 'summary fact-confirmed', 'summary fact-replacement', 'summary fact-deprecated', 'summary fact-proposed',
    ])
  })

  it('SUPERSESSION-ONE-ROW: the new version leads and the old one reads on a Was: line', () => {
    const snapshot = CurationSnapshotSchema.parse({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: [{ recordId: 'fact-old', bucket: 'superseded', byRecordId: 'fact-new', changes: [
        { bucket: 'superseded', change: recorded('fact-old', 'superseded', 40, { byRecordId: 'fact-new' }) },
        { bucket: 'added', change: recorded('fact-new', 'added', 40) },
      ] }],
      breakdown: { added: 0, confirmed: 0, superseded: 1, deprecated: 0, proposed: 0 },
    })
    const both = learnedView(projection('complete', {
      changes: [joined(recorded('fact-old', 'superseded', 40, { byRecordId: 'fact-new' })), joined(recorded('fact-new', 'added', 40))],
      curationSnapshot: snapshot,
    }))

    expect(both.rows.length).toBe(1)
    expect(both.rows[0]?.bucket).toBe('superseded')
    expect(both.rows[0]?.primary).toBe('summary fact-new')
    expect(both.rows[0]?.leadSource).toBe('joined')
    expect(both.rows[0]?.content?.summary).toBe('summary fact-new')
    expect(both.rows[0]?.was).toEqual({ primary: 'summary fact-old', leadSource: 'joined' })
    expect(WAS_PREFIX).toBe('Was:')

    const newOnly = learnedView(projection('complete', {
      changes: [recorded('fact-old', 'superseded', 40, { byRecordId: 'fact-new' }), joined(recorded('fact-new', 'added', 40))],
      curationSnapshot: snapshot,
    }))
    expect(newOnly.rows[0]?.primary).toBe('summary fact-new')
    expect(newOnly.rows[0]?.was).toEqual({ primary: RECORD_CONTENT_NOT_RECORDED_LEAD, leadSource: 'not-recorded' })
  })

  it('NO-SNAPSHOT-MAPPING: without a snapshot, changes group per record onto the same words and Proposed is never guessed', () => {
    const view = learnedView(projection('complete', {
      changes: [
        joined(recorded('rec-a', 'added', 1)),
        recorded('rec-b', 'promoted', 2),
        recorded('rec-b', 'confirmed', 3),
        joined(recorded('rec-c', 'superseded', 4, { byRecordId: 'rec-d' })),
        joined(recorded('rec-d', 'added', 4)),
        recorded('rec-e', 'deprecated', 5),
        recorded('rec-f', 'purged', 6),
      ],
    }, { curated: 3, deprecated: 1 }))

    expect(view.rows.map(row => row.bucket)).toEqual(['added', 'confirmed', 'superseded', 'deprecated'])
    expect(view.rows.every(row => row.section === undefined)).toBe(true)
    expect(view.rows.map(row => row.bucket)).not.toContain('proposed')
    expect(view.rows[2]?.primary).toBe('summary rec-d')
    expect(view.rows[2]?.was?.primary).toBe('summary rec-c')
    expect(view.countNote).toBe(BREAKDOWN_NOT_RECORDED_TEXT)
    expect(view.curationSnapshot).toBeUndefined()
  })

  it('LEARNED-ROW-CONTENT-JOIN: a row leads with its joined summary, or says why it cannot, and is shown either way', () => {
    const snapshot = CurationSnapshotSchema.parse({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: ['rec-joined', 'rec-gone', 'rec-unrecorded'].map((id, index) => ({
        recordId: id, bucket: 'added', changes: [{ bucket: 'added', change: recorded(id, 'added', 50 + index) }],
      })),
      breakdown: { added: 3, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const view = learnedView(projection('complete', {
      changes: [
        joined(recorded('rec-joined', 'added', 50)),
        { ...recorded('rec-gone', 'added', 51), contentAbsence: { reason: 'not-found' } },
      ],
      curationSnapshot: snapshot,
    }))

    expect(view.rows.map(row => row.primary)).toEqual(['summary rec-joined', RECORD_UNREADABLE_LEAD, RECORD_CONTENT_NOT_RECORDED_LEAD])
    expect(view.rows.map(row => row.leadSource)).toEqual(['joined', 'absent', 'not-recorded'])
    expect(view.rows[1]?.contentAbsence).toEqual({ reason: 'not-found' })
    expect(view.rows[0]?.applicability?.lead).toBe('Applies to shop · checkout')
    expect(view.rows[2]).not.toHaveProperty('content')
    expect(view.curationSnapshot?.reconciliation).toBeUndefined()
    expect(RECORD_CONTENT_NOT_RECORDED_LEAD).toBe("A record whose content isn't part of this run's record")
  })

  // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 1): was "PROPOSED-HELD-FOR-REVIEW: a
  // proposed row is held for review". Nothing reviews it; it is recorded and not applied.
  it('PROPOSED-NOT-APPLIED: a proposed row is recorded and not applied, and an open question says so', () => {
    const snapshot = CurationSnapshotSchema.parse({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: [
        { recordId: 'rec-fact', bucket: 'proposed', changes: [{ bucket: 'proposed', change: recorded('rec-fact', 'added', 60) }] },
        { recordId: 'rec-question', bucket: 'proposed', changes: [{ bucket: 'proposed', change: recorded('rec-question', 'added', 61) }] },
        { recordId: 'rec-plain', bucket: 'added', changes: [{ bucket: 'added', change: recorded('rec-plain', 'added', 62) }] },
      ],
      breakdown: { added: 1, confirmed: 0, superseded: 0, deprecated: 0, proposed: 2 },
    })
    const view = learnedView(projection('complete', {
      changes: [
        joined(recorded('rec-fact', 'added', 60)),
        joined(recorded('rec-question', 'added', 61), { kind: 'unknown' }),
        joined(recorded('rec-plain', 'added', 62)),
      ],
      curationSnapshot: snapshot,
    }))

    expect(view.rows.map(row => row.note)).toEqual([PROPOSED_NOTE, OPEN_QUESTION_NOTE, undefined])
    expect(view.rows[2]).not.toHaveProperty('note')
    expect(PROPOSED_NOTE).toBe('recorded, not applied')
    expect(OPEN_QUESTION_NOTE).toBe('open question recorded')
  })

  it('SINCE-THEN-ROWS: a later change is its own row with what happened later, and never moves the counts', () => {
    const snapshot = CurationSnapshotSchema.parse({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
      rows: ['rec-a', 'rec-b'].map((id, index) => ({
        recordId: id, bucket: 'added', changes: [{ bucket: 'added', change: recorded(id, 'added', 70 + index) }],
      })),
      breakdown: { added: 2, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const later = joined(recorded('rec-a', 'promoted', 90))
    const view = learnedView(projection('complete', {
      changes: [joined(recorded('rec-a', 'added', 70)), joined(recorded('rec-b', 'added', 71)), later],
      curationSnapshot: snapshot,
      sinceThen: { changes: [later], count: 1 },
    }))

    expect(view.rows.map(row => row.section)).toEqual(['curation', 'curation', 'since-then'])
    expect(view.rows[2]?.bucket).toBe('confirmed')
    expect(view.rows[2]?.sinceDetail).toBe('promoted to trusted, later')
    expect(view.rows[0]).not.toHaveProperty('sinceDetail')
    expect(view.countLine).toBe('2 added')
    expect(view.curationSnapshot?.sinceThenCount).toBe(1)
    expect(sinceThisRunHeading(1)).toBe('Since this run · 1 change')
    expect(sinceThisRunHeading(3)).toBe('Since this run · 3 changes')
    expect(sinceThenDetail('promoted')).toBe('promoted to trusted, later')
  })
})

describe('every bucket word explains itself, and the section speaks of memory changes', () => {
  it('BUCKET-LABEL-MEANINGS: each of the five buckets has one meaning, and Proposed says it changed nothing agents are given', () => {
    expect(BUCKET_MEANINGS).toEqual({
      added: 'New knowledge recorded from this run.',
      confirmed: 'Existing knowledge this run backed up, including knowledge promoted to trusted.',
      superseded: 'Replaced by a newer version; agents are given the new one.',
      deprecated: 'Retired; agents are no longer given it.',
      // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 1).
      proposed: 'Recorded, but not applied: agents are not given it.',
    })
    expect(Object.keys(BUCKET_MEANINGS)).toEqual(Object.keys(BUCKET_LABELS))
    expect(new Set(Object.values(BUCKET_MEANINGS)).size).toBe(CURATION_BREAKDOWN_BUCKETS.length)

    expect(CHANGES_PENDING_TEXT).toBe('Memory changes appear after post-run processing finishes.')
    expect(NO_MEMORY_CHANGES_SENTENCE).toBe('Post-run processing finished and changed nothing in memory.')
    for (const status of ['pending', 'running'] as const) {
      const unsettled = learnedView(projection(status, {}))
      expect(unsettled.sentence).toBe(CHANGES_PENDING_TEXT)
      expect(unsettled.curationSnapshot?.reconciliation).toBeUndefined()
    }
    const zero = CurationSnapshotSchema.parse({
      schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 },
    })
    const nothing = learnedView(projection('complete', { curationSnapshot: zero, sinceThen: { changes: [], count: 0 } }))
    expect(nothing.countLine).toBe(NO_MEMORY_CHANGES_TEXT)
    expect(nothing.sentence).toBe(NO_MEMORY_CHANGES_SENTENCE)
    expect(nothing.rows).toEqual([])
  })
})

describe('every technical fact of a changed record is gathered for Retrieval details', () => {
  it('CHANGE-LEDGER-ENTRIES: one entry per changed record with its ids, raw events and provenance', () => {
    const run = fiveBucketRun()
    const snapshot = fiveBucketSnapshot()
    const entries = changeLedgerViews(run)

    expect(entries.length).toBe(5)
    expect(entries.map(entry => entry.bucket)).toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'proposed'])
    expect(entries[2]?.recordIds).toEqual(['fact-replacement', 'fact-victim'])
    expect(entries.map(entry => entry.events)).toEqual(
      snapshot.rows.map(row => row.changes.map(({ change }) => ({ change: change.change, atOrdinal: change.atOrdinal }))),
    )
    expect(entries[1]).toMatchObject({ promotionPath: 'user-sovereign', promotionReceiptDigest: DIGEST })
    expect(entries[0]).not.toHaveProperty('promotionPath')
    expect(entries[0]?.evidenceTokens).toEqual(['receipt-fact-added-20'])
    expect(entries[3]?.observationIds).toEqual(['obs-deprecated'])
    expect(entries[0]?.sourceRunIds).toEqual([RUN])
    expect(entries[0]?.validity).toEqual({ openedAtOrdinal: 3 })
    expect(ledgerEventText({ change: 'superseded', atOrdinal: 22 })).toBe('superseded @ 22')
    expect(ledgerValidityText({ openedAtOrdinal: 3, closedAtOrdinal: 9 })).toBe('opened @ 3 · closed @ 9')
    expect(ledgerValidityText({ openedAtOrdinal: 3 })).toBe('opened @ 3')

    const view = projectKnowledgeView({ kind: 'read', projection: run })
    if (view.state !== 'ready') throw new Error('expected ready')
    expect(view.ledger.changes).toEqual(entries)
    for (const row of view.learned.rows) {
      for (const key of ['recordId', 'recordIds', 'ref', 'href', 'promotionPath', 'promotionReceiptDigest', 'events']) {
        expect(row).not.toHaveProperty(key)
      }
    }
  })

  it('the bucket labels, since-then details and ledger row labels', () => {
    expect(BUCKET_LABELS).toEqual({
      added: 'Added', confirmed: 'Confirmed', superseded: 'Superseded', deprecated: 'Deprecated', proposed: 'Proposed',
    })
    for (const bucket of CURATION_BREAKDOWN_BUCKETS) expect(BUCKET_LABELS[bucket].toLowerCase()).toBe(bucket)
    expect(SINCE_THEN_DETAILS).toEqual({
      added: 'added later',
      confirmed: 'confirmed again, later',
      promoted: 'promoted to trusted, later',
      superseded: 'superseded later',
      deprecated: 'retired later',
    })
    expect(Object.keys(LEDGER_ROW_LABELS)).toEqual([
      'bucket', 'record', 'events', 'promotion', 'receipt', 'evidence', 'observation', 'sourceRun', 'validity', 'link',
    ])
  })
})
