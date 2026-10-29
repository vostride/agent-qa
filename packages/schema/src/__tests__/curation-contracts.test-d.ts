import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import { CURATION_BREAKDOWN_BUCKETS, CURATION_BUCKET_PRECEDENCE, CurationSnapshotSchema } from '../index'
import type { CurationBucket, CurationSnapshot, CurationBreakdown,
  CurationSnapshotRow, CurationSnapshotChange, RunNotification } from '../index'

test('independent literal union and both never bars', () => {
  type Expected = 'added' | 'confirmed' | 'superseded' | 'deprecated' | 'proposed'
  expectTypeOf<CurationBucket>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CURATION_BREAKDOWN_BUCKETS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CURATION_BUCKET_PRECEDENCE)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<Expected, CurationBucket>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<CurationBucket, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<CurationBucket, (typeof CURATION_BREAKDOWN_BUCKETS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof CURATION_BREAKDOWN_BUCKETS)[number], CurationBucket>>().toEqualTypeOf<never>()
})

test('STRONGEST-ONCE: rows retain historical changes with exact bucket discriminants', () => {
  expectTypeOf<CurationSnapshotRow['bucket']>().toEqualTypeOf<
    'added' | 'confirmed' | 'superseded' | 'deprecated' | 'proposed'>()
  expectTypeOf<Extract<CurationSnapshotChange, { bucket: 'confirmed' }>['change']['change']>()
    .toEqualTypeOf<'confirmed' | 'promoted'>()
  expectTypeOf<Extract<CurationSnapshotChange, { bucket: 'proposed' }>['change']['change']>()
    .toEqualTypeOf<'added' | 'confirmed'>()
  expectTypeOf<Extract<CurationSnapshotChange['change']['change'], 'purged'>>().toEqualTypeOf<never>()
  expectTypeOf<CurationSnapshotRow['changes']>().toEqualTypeOf<CurationSnapshotChange[]>()
})

test('REPLACEMENT-NOT-ADDED: supersession has a required historical replacement identity', () => {
  type Superseded = Extract<CurationSnapshotChange, { bucket: 'superseded' }>['change']
  expectTypeOf<Superseded['change']>().toEqualTypeOf<'superseded'>()
  expectTypeOf<Superseded['byRecordId']>().toEqualTypeOf<string>()
  expectTypeOf<CurationSnapshotRow['byRecordId']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Extract<CurationSnapshotChange, { bucket: 'added' }>['change']['change']>()
    .toEqualTypeOf<'added'>()
})

test('SNAPSHOT-COUNTS-EXACT: version and exact five numeric count keys', () => {
  expectTypeOf<CurationSnapshot['schemaVersion']>().toEqualTypeOf<2>()
  expectTypeOf<keyof CurationSnapshot>().toEqualTypeOf<'schemaVersion' | 'rows' | 'breakdown'>()
  expectTypeOf<CurationBreakdown>().toEqualTypeOf<{
    added: number, confirmed: number, superseded: number, deprecated: number, proposed: number,
  }>()
  expectTypeOf<z.infer<typeof CurationSnapshotSchema>>().toEqualTypeOf<CurationSnapshot>()
})

test('NOTIFICATION-ROUNDTRIP: exact current version and optional snapshot carrier', () => {
  expectTypeOf<RunNotification['schemaVersion']>().toEqualTypeOf<2>()
  type Curation = RunNotification['stages']['curation']
  expectTypeOf<keyof Curation>().toEqualTypeOf<'status' | 'curated' | 'deprecated' | 'curationSnapshot'>()
  // Conditional access keeps the preimplementation RED inside this counted assertion.
  type Snapshot = Curation extends { curationSnapshot?: infer S } ? S : never
  expectTypeOf<Snapshot>().toEqualTypeOf<CurationSnapshot>()
  expectTypeOf<{}>().toMatchTypeOf<Pick<Curation, Exclude<keyof Curation, 'status'>>>()
})
