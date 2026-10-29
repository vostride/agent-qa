import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import { RECORDING_STATES, RECORDING_CONTENT_TYPES, RECORDING_REF_PREFIX, RecordingEntrySchema } from '../index'
import type { RecordingState, RecordingContentType, RecordingRef, RecordingEntry, EvidenceAbsenceReason } from '../index'
import type { SubActionRecordedPayload, TestFinishedPayload } from '../run/bus-events'
import type { RunDetailMember, RunDetailSubAction, RunDetailRows } from '../functions/runs'

test('C424-RECORDING-STATES-EXACT', () => {
  type Expected = 'present' | 'absent'
  expectTypeOf<RecordingState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof RECORDING_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<RecordingState, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, RecordingState>>().toEqualTypeOf<never>()
  expectTypeOf<RecordingEntry['state']>().toEqualTypeOf<Expected>()
})

test('C424-RECORDING-TYPES-EXACT', () => {
  type Expected = 'video/webm' | 'video/mp4'
  expectTypeOf<RecordingContentType>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof RECORDING_CONTENT_TYPES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<RecordingContentType, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, RecordingContentType>>().toEqualTypeOf<never>()
})

test('C424-RECORDING-REF-EXACT', () => {
  expectTypeOf<typeof RECORDING_REF_PREFIX>().toEqualTypeOf<'recording:'>()
  expectTypeOf<RecordingRef['id']>().toEqualTypeOf<`recording:${string}`>()
  expectTypeOf<RecordingEntry>().toEqualTypeOf<z.infer<typeof RecordingEntrySchema>>()
  expectTypeOf<Extract<RecordingEntry, { state: 'absent' }>['reason']>().toEqualTypeOf<EvidenceAbsenceReason>()
  expectTypeOf<Extract<keyof Extract<RecordingEntry, { state: 'absent' }>, 'ref'>>().toEqualTypeOf<never>()
})

test('REC-DTO-OPTIONAL', () => {
  expectTypeOf<SubActionRecordedPayload['recordingOffsetMs']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<RunDetailSubAction['recordingOffsetMs']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<TestFinishedPayload['recording']>().toEqualTypeOf<RecordingEntry | undefined>()
  expectTypeOf<RunDetailMember['recording']>().toEqualTypeOf<RecordingEntry | undefined>()
  expectTypeOf<RunDetailRows['members'][number]['recording']>().toEqualTypeOf<RecordingEntry | undefined>()
  expectTypeOf<RunDetailRows['subActions'][number]['recordingOffsetMs']>().toEqualTypeOf<number | undefined>()
})
