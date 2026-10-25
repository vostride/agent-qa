import { expect, test } from 'vitest'
import {
  CURATION_BREAKDOWN_BUCKETS, CURATION_BUCKET_PRECEDENCE, CURATION_SNAPSHOT_SCHEMA_VERSION,
  CurationBucketSchema, CurationSnapshotSchema, CurationSnapshotRowSchema,
  CurationSnapshotChangeSchema, CurationBreakdownSchema, CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  guardRunNotification, RunNotificationSchemaError, RunNotificationViewSchema, toRunNotificationView,
} from '../index'
import type {
  CurationSnapshot, CurationSnapshotChange, CurationSnapshotRow, RunNotification,
} from '../index'

// Independent inputs and expected counts: no production fold constructs the oracle.
const zero = { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0 }
const added: CurationSnapshotRow = {
  recordId: 'record-added', bucket: 'added', changes: [{ bucket: 'added', change: {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-added', change: 'added', atOrdinal: 2,
    evidenceToken: 'synthetic-add', sourceRunId: 'synthetic-source',
  } }],
}
const confirmed: CurationSnapshotRow = {
  recordId: 'record-confirmed', bucket: 'confirmed', changes: [
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-confirmed',
      change: 'confirmed', atOrdinal: 3, evidenceToken: 'synthetic-confirm' } },
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-confirmed',
      change: 'confirmed', atOrdinal: 3, evidenceToken: 'synthetic-canary',
      observationId: 'synthetic-observation' } },
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-confirmed',
      change: 'promoted', atOrdinal: 4, promotionPath: 'user-sovereign' } },
  ],
}
const superseded: CurationSnapshotRow = {
  recordId: 'record-victim', bucket: 'superseded', byRecordId: 'record-replacement', changes: [
    { bucket: 'superseded', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-victim',
      change: 'superseded', atOrdinal: 5, byRecordId: 'record-replacement' } },
    { bucket: 'added', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-replacement',
      change: 'added', atOrdinal: 5 } },
  ],
}
const deprecated: CurationSnapshotRow = {
  recordId: 'record-deprecated', bucket: 'deprecated', changes: [{ bucket: 'deprecated', change: {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-deprecated', change: 'deprecated', atOrdinal: 6,
  } }],
}
const proposed: CurationSnapshotRow = {
  recordId: 'record-held', bucket: 'proposed', changes: [{ bucket: 'proposed', change: {
    schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-held', change: 'added', atOrdinal: 7,
  } }],
}
const five: CurationSnapshot = {
  schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [added, confirmed, superseded, deprecated, proposed],
  breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
}

function notification(version: number, curationSnapshot?: unknown) {
  return {
    schemaVersion: version, runId: 'synthetic-notification-run', outcome: 'done',
    verdictSummary: { total: 2, byClass: { timeout: 2 } },
    stages: {
      analysis: { status: 'done' },
      curation: { status: 'done', curated: 17, deprecated: 9,
        ...(curationSnapshot === undefined ? {} : { curationSnapshot }) },
    },
  }
}

test('NOTIFICATION-ROUNDTRIP: both strict readers preserve full snapshot bytes', () => {
  const stored = notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, five)
  expect(() => guardRunNotification(stored)).not.toThrow()
  expect(guardRunNotification(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  const view = toRunNotificationView(stored as RunNotification)
  expect(RunNotificationViewSchema.safeParse(view).success).toBe(true)
  const wire = RunNotificationViewSchema.parse(view)
  expect(wire).toEqual(view)
  expect(JSON.stringify(wire.stages.curation.curationSnapshot))
    .toBe(JSON.stringify(stored.stages.curation.curationSnapshot))
  expect(RunNotificationViewSchema.safeParse(toRunNotificationView(notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION) as RunNotification)).success)
    .toBe(true)
  expect(RunNotificationViewSchema.safeParse(stored).success).toBe(false)
})

test('NOTIFICATION-OTHER-REFUSE: invalid and other versions refuse without a guessed walk', () => {
  for (const version of [0, -1, 1, 1.5, 3, 4, 4.5, 5, 100, NaN, Infinity]) {
    expect(() => guardRunNotification(notification(version))).toThrow(RunNotificationSchemaError)
    expect(RunNotificationViewSchema.safeParse(toRunNotificationView(notification(version) as RunNotification)).success)
      .toBe(false)
  }
  expect(() => guardRunNotification(notification(5))).toThrow(/this build reads 2\./)
})

test('INVALID-BREAKDOWN: notification guards reject malformed snapshot membership with generic errors', () => {
  // Prove the valid arm first so a blanket refusal cannot satisfy the negative cells.
  expect(() => guardRunNotification(notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, five))).not.toThrow()
  const invalids = [null, { ...five, schemaVersion: 1 }, { ...five, syntheticSecretKey: true },
    { ...five, breakdown: { ...five.breakdown, added: 0 } },
    { ...five, rows: [...five.rows, added], breakdown: { ...five.breakdown, added: 2 } },
    { ...five, rows: [{ ...added, recordId: 'syntheticSecretIdentity' }] }]
  for (const invalid of invalids) {
    expect(RunNotificationViewSchema.safeParse(toRunNotificationView(notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, invalid) as RunNotification)).success)
      .toBe(false)
    expect(() => guardRunNotification(notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, invalid))).toThrow(RunNotificationSchemaError)
    try { guardRunNotification(notification(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, invalid)) } catch (error) {
      expect(String(error)).not.toMatch(/syntheticSecret(Key|Identity)/)
    }
  }
})

test('C423-BUCKETS-EXACT: exactly five literals and version two with strict keys', () => {
  expect(CURATION_BREAKDOWN_BUCKETS).toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'proposed'])
  expect(CurationBucketSchema.options).toEqual(['added', 'confirmed', 'superseded', 'deprecated', 'proposed'])
  expect(CURATION_BUCKET_PRECEDENCE).toEqual(['superseded', 'deprecated', 'proposed', 'added', 'confirmed'])
  expect(CURATION_SNAPSHOT_SCHEMA_VERSION).toBe(2)
  expect(CurationSnapshotSchema.parse(five)).toEqual(five)
  expect(Object.keys(CurationBreakdownSchema.shape)).toEqual([
    'added', 'confirmed', 'superseded', 'deprecated', 'proposed',
  ])
  for (const invalid of ['curated', 'promoted', 'purged', 'reinforced', '', null]) {
    expect(CurationBucketSchema.safeParse(invalid).success).toBe(false)
  }
  for (const invalid of [
    { ...five, schemaVersion: 1 }, { ...five, schemaVersion: 3 }, { ...five, schemaVersion: undefined },
    { ...five, currentStatus: 'active' }, { ...five, breakdown: { ...five.breakdown, curated: 5 } },
    { ...five, rows: [{ ...added, unknown: true }] },
  ]) expect(CurationSnapshotSchema.safeParse(invalid).success).toBe(false)
})

test('STRONGEST-ONCE: duplicate affected records reject even with matching inflated counts', () => {
  expect(CurationSnapshotSchema.safeParse({ ...five, rows: [...five.rows, added],
    breakdown: { ...five.breakdown, added: 2 } }).success).toBe(false)
  expect(CurationSnapshotSchema.safeParse({ ...five, rows: [...five.rows,
    { ...added, bucket: 'confirmed', changes: [{ bucket: 'confirmed', change: {
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: added.recordId, change: 'confirmed', atOrdinal: 20,
    } }] }], breakdown: { ...five.breakdown, confirmed: 2 } }).success).toBe(false)
})

test('STRONGEST-ONCE: every stronger historical bucket wins regardless of ordering', () => {
  const histories: CurationSnapshotChange[] = [
    { bucket: 'superseded', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'subject',
      change: 'superseded', atOrdinal: 1, byRecordId: 'replacement' } },
    { bucket: 'deprecated', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'subject', change: 'deprecated', atOrdinal: 2 } },
    { bucket: 'proposed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'subject', change: 'added', atOrdinal: 3 } },
    { bucket: 'added', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'subject', change: 'added', atOrdinal: 4 } },
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'subject', change: 'confirmed', atOrdinal: 5 } },
  ]
  for (let stronger = 0; stronger < histories.length; stronger++) {
    for (let weaker = stronger + 1; weaker < histories.length; weaker++) {
      for (const changes of [[histories[stronger]!, histories[weaker]!],
        [histories[weaker]!, histories[stronger]!]]) {
        const winner = histories[stronger]!.bucket
        const row = { recordId: 'subject', bucket: winner, changes,
          ...(winner === 'superseded' ? { byRecordId: 'replacement' } : {}) }
        expect(CurationSnapshotRowSchema.safeParse(row).success).toBe(true)
        expect(CurationSnapshotRowSchema.safeParse({ ...row, bucket: histories[weaker]!.bucket }).success).toBe(false)
      }
    }
  }
})

test('STRONGEST-ONCE: confirmation, canary and promotion retain distinct identities in one unit', () => {
  const snapshot = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [confirmed], breakdown: { ...zero, confirmed: 1 } }
  expect(CurationSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  expect(CurationSnapshotSchema.safeParse({ ...snapshot, breakdown: { ...zero, confirmed: 3 } }).success).toBe(false)
})

test('REPLACEMENT-NOT-ADDED: victim represents replacement Add identity without a second membership', () => {
  const snapshot = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [superseded], breakdown: { ...zero, superseded: 1 } }
  expect(CurationSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  const replacement = { recordId: 'record-replacement', bucket: 'added', changes: [superseded.changes[1]] }
  expect(CurationSnapshotSchema.safeParse({ ...snapshot, rows: [superseded, replacement],
    breakdown: { ...zero, superseded: 1, added: 1 } }).success).toBe(false)
  expect(CurationSnapshotSchema.safeParse({ ...snapshot, rows: [replacement, superseded],
    breakdown: { ...zero, superseded: 1, added: 1 } }).success).toBe(false)
  // A successfully committed replacement without a victim effect is an actual Add.
  expect(CurationSnapshotSchema.safeParse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [replacement],
    breakdown: { ...zero, added: 1 } }).success).toBe(true)
})

test('SNAPSHOT-COUNTS-EXACT: each bucket counts unique rows rather than events or a grand total', () => {
  expect(CurationSnapshotSchema.parse(five)).toEqual(five)
  for (const bucket of ['added', 'confirmed', 'superseded', 'deprecated', 'proposed'] as const) {
    for (const bad of [0, 2, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(CurationSnapshotSchema.safeParse({ ...five,
        breakdown: { ...five.breakdown, [bucket]: bad } }).success).toBe(false)
    }
  }
  expect(CurationSnapshotSchema.safeParse({ ...five,
    breakdown: { added: 0, confirmed: 2, superseded: 1, deprecated: 1, proposed: 1 } }).success).toBe(false)
  expect(CurationSnapshotSchema.parse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: zero })).toEqual({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: zero,
  })
})

test('SNAPSHOT-HISTORY: conflicting, foreign, duplicate and empty identities reject', () => {
  for (const row of [
    { ...added, changes: [] }, { ...added, changes: [...added.changes, ...added.changes] },
    { ...added, changes: confirmed.changes }, { ...added, byRecordId: 'unrelated' },
    { ...superseded, byRecordId: 'wrong-replacement' }, { ...superseded, byRecordId: undefined },
    { ...superseded, recordId: 'record-replacement' },
    { ...added, changes: [added.changes[0], { ...added.changes[0], bucket: 'proposed' }] },
  ]) expect(CurationSnapshotRowSchema.safeParse(row).success).toBe(false)
})

test('SNAPSHOT-DISCRIMINANTS: downgrade classifications and unlinked purge stay distinct', () => {
  const heldExisting = { bucket: 'proposed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
    recordId: 'held-existing', change: 'confirmed', atOrdinal: 8 } }
  expect(CurationSnapshotChangeSchema.safeParse(heldExisting).success).toBe(true)
  for (const invalid of [
    { ...heldExisting, change: { ...heldExisting.change, change: 'deprecated' } },
    { bucket: 'added', change: confirmed.changes[2]!.change },
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'purged', change: 'purged', atOrdinal: 9 } },
    { bucket: 'confirmed', change: { ...confirmed.changes[0]!.change, promotionPath: 'user-sovereign' } },
  ]) expect(CurationSnapshotChangeSchema.safeParse(invalid).success).toBe(false)
})

test('SNAPSHOT-STABLE: parse preserves historical order and detaches all nested facts', () => {
  const input = structuredClone(five)
  const parsed = CurationSnapshotSchema.parse(input)
  expect(parsed).toEqual(five)
  input.rows[1]!.changes[0]!.change.atOrdinal = 999
  input.rows[2]!.byRecordId = 'later-replacement'
  input.breakdown.confirmed = 50
  expect(parsed).toEqual(five)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(five)
})

test('REPLACEMENT-NOT-ADDED: historical replacements remain suppressed after a later supersession', () => {
  const row: CurationSnapshotRow = {
    ...superseded, byRecordId: 'later-replacement', changes: [
      ...superseded.changes,
      { bucket: 'superseded', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-victim',
        change: 'superseded', atOrdinal: 10, byRecordId: 'later-replacement' } },
    ],
  }
  expect(CurationSnapshotRowSchema.parse(row)).toEqual(row)
  expect(CurationSnapshotRowSchema.safeParse({ ...row, byRecordId: 'record-replacement' }).success).toBe(false)
  expect(CurationSnapshotSchema.safeParse({ schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [row, { recordId: 'record-replacement', bucket: 'added', changes: [superseded.changes[1]] }],
    breakdown: { ...zero, superseded: 1, added: 1 },
  }).success).toBe(false)
})
