import { expectTypeOf, test } from 'vitest'

import { LIVE_EMBED_REPORT_EVENTS, LIVE_EMBED_STATES } from '../live-view/embed-page.js'
import type { LiveEmbedReportEvent, LiveEmbedState } from '../live-view/embed-page.js'
import { LIVE_VIEW_END_REASONS, LIVE_VIEW_REFUSAL_REASONS } from '../live-view/protocol.js'
import type {
  LiveViewEndReason,
  LiveViewRefusalReason,
  LiveViewServerMessage,
} from '../live-view/protocol.js'

test('C428-REFUSAL-REASONS-EXACT', () => {
  type Expected =
    | 'malformed'
    | 'bad_signature'
    | 'expired'
    | 'scope_mismatch'
    | 'unknown_run'
    | 'unknown_handle'
    | 'unknown_session'
  expectTypeOf<LiveViewRefusalReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_VIEW_REFUSAL_REASONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveViewRefusalReason, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveViewRefusalReason>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<LiveViewServerMessage, { type: 'refused' }>['reason']>()
    .toEqualTypeOf<Expected>()
})

test('C428-END-REASONS-EXACT', () => {
  type Expected = 'runFinished' | 'handleFinished' | 'sessionEnded'
  expectTypeOf<LiveViewEndReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_VIEW_END_REASONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveViewEndReason, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveViewEndReason>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<LiveViewServerMessage, { type: 'ended' }>['reason']>()
    .toEqualTypeOf<Expected>()
})

test('C428-EMBED-STATES-EXACT', () => {
  type Expected =
    | 'connecting'
    | 'live'
    | 'no-stream'
    | 'expired'
    | 'refused'
    | 'stream-ended'
    | 'session-ended'
    | 'ended'
    | 'lost'
  expectTypeOf<LiveEmbedState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_EMBED_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveEmbedState, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveEmbedState>>().toEqualTypeOf<never>()
})

test('C428-EMBED-REPORT-EVENTS-EXACT', () => {
  type Expected = 'ready' | 'frame' | 'ended' | 'refused' | 'lost'
  expectTypeOf<LiveEmbedReportEvent>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LIVE_EMBED_REPORT_EVENTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LiveEmbedReportEvent, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LiveEmbedReportEvent>>().toEqualTypeOf<never>()
})
