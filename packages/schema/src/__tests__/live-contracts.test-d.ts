import { expectTypeOf, test } from 'vitest'
import { LIVE_FRAME_END_REASONS, LIVE_STREAM_KINDS, LIVE_VIEW_SUBJECT_KINDS } from '../index'
import type {
  LiveFrameEndReason,
  LiveStreamDeclaration,
  LiveStreamKind,
  LiveViewSubject,
  LiveViewSubjectKind,
  LiveViewSubjectRef,
  TestStartedPayload,
} from '../index'

test('C428-LIVE-STREAM-KINDS-EXACT', () => {
  type Expected = 'cdp-screencast' | 'snapshot' | 'mjpeg' | 'webrtc'
  expectTypeOf<LiveStreamKind>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_STREAM_KINDS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveStreamKind, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveStreamKind>>().toEqualTypeOf<never>()
  expectTypeOf<LiveStreamDeclaration['kind']>().toEqualTypeOf<Expected | 'none'>()
})

test('C428-FRAME-END-REASONS-EXACT', () => {
  type Expected = 'withdrawn' | 'closed'
  expectTypeOf<LiveFrameEndReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_FRAME_END_REASONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveFrameEndReason, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveFrameEndReason>>().toEqualTypeOf<never>()
})

test('C428-LIVE-VIEW-SUBJECT-KINDS-EXACT', () => {
  type Expected = 'run' | 'editor'
  expectTypeOf<LiveViewSubjectKind>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_VIEW_SUBJECT_KINDS)[number]>().toEqualTypeOf<LiveViewSubjectKind>()
  expectTypeOf<Exclude<LiveViewSubject['kind'], Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveViewSubject['kind']>>().toEqualTypeOf<never>()

  const ref: LiveViewSubjectRef = { kind: 'editor', id: 's1' }
  expectTypeOf(ref).toEqualTypeOf<LiveViewSubjectRef>()
  // @ts-expect-error a suite is not a live-view subject
  const suite: LiveViewSubjectRef = { kind: 'suite', id: 's1' }
  void suite
})

test('C428-TEST-STARTED-STEP-TEXTS-OPTIONAL', () => {
  expectTypeOf<TestStartedPayload['stepTexts']>().toEqualTypeOf<readonly string[] | undefined>()

  const bare = { testId: 't1', testIndex: 0, name: 'a test' }
  expectTypeOf(bare).toExtend<TestStartedPayload>()
  const payload: TestStartedPayload = bare
  void payload
})
