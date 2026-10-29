// THE FEEDBACK COMPOSER'S CLOSED SETS, PINNED IN BOTH DIRECTIONS (426-02 · D-11, D-12, v54 bar).
//
// Each runtime array and its union are two spellings of one closed set. A runtime cell sees only the
// array; a never-bar is the assertion that catches the other half of a drift — a third outcome class
// or a sixth composer state added to the union alone compiles everywhere and is never painted, and a
// choice order that drops or repeats a mark still type-checks as a string list without the shape pin.

import { expectTypeOf, test } from 'vitest'
import type { Mark } from '@vostride/agent-qa-schema'
import {
  FEEDBACK_CHOICE_ORDER,
  FEEDBACK_COMPOSER_STATES,
  FEEDBACK_ENTRY_SCOPES,
  FEEDBACK_HISTORY_STATES,
  FEEDBACK_LAYOUTS,
  FEEDBACK_OUTCOME_CLASSES,
  FEEDBACK_PREVIEW_STATES,
  type FeedbackComposerState,
  type FeedbackEntryScope,
  type FeedbackHistoryState,
  type FeedbackLayout,
  type FeedbackOutcomeClass,
  type FeedbackPreviewState,
} from '../feedback-view'

test('outcome classes are an exact union', () => {
  type Expected = 'passed' | 'failed'
  expectTypeOf<FeedbackOutcomeClass>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_OUTCOME_CLASSES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackOutcomeClass, (typeof FEEDBACK_OUTCOME_CLASSES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_OUTCOME_CLASSES)[number], FeedbackOutcomeClass>>().toEqualTypeOf<never>()
})

test('each outcome class orders all three marks', () => {
  type Order = typeof FEEDBACK_CHOICE_ORDER
  expectTypeOf<keyof Order>().toEqualTypeOf<FeedbackOutcomeClass>()
  expectTypeOf<Order[FeedbackOutcomeClass]['length']>().toEqualTypeOf<3>()
  expectTypeOf<Order[FeedbackOutcomeClass]>().toExtend<readonly [Mark, Mark, Mark]>()
  expectTypeOf<Exclude<Mark, Order['failed'][number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Mark, Order['passed'][number]>>().toEqualTypeOf<never>()
})

// the approval state is deleted; the exact set is the four that remain.
test('composer states are an exact union', () => {
  type Expected = 'composing' | 'submitting' | 'recorded' | 'retained'
  expectTypeOf<FeedbackComposerState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_COMPOSER_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackComposerState, (typeof FEEDBACK_COMPOSER_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_COMPOSER_STATES)[number], FeedbackComposerState>>().toEqualTypeOf<never>()
})

test('entry scopes are an exact union', () => {
  type Expected = 'test' | 'step'
  expectTypeOf<FeedbackEntryScope>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_ENTRY_SCOPES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackEntryScope, (typeof FEEDBACK_ENTRY_SCOPES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_ENTRY_SCOPES)[number], FeedbackEntryScope>>().toEqualTypeOf<never>()
})

test('preview states are an exact union', () => {
  type Expected = 'idle' | 'loading' | 'consequences' | 'quarantined' | 'already-marked' | 'refused' | 'failed'
  expectTypeOf<FeedbackPreviewState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_PREVIEW_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackPreviewState, (typeof FEEDBACK_PREVIEW_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_PREVIEW_STATES)[number], FeedbackPreviewState>>().toEqualTypeOf<never>()
})

test('history states are an exact union', () => {
  type Expected = 'loading' | 'history' | 'empty' | 'run-not-found' | 'ledger-corrupt' | 'ledger-unavailable' | 'failed'
  expectTypeOf<FeedbackHistoryState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_HISTORY_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackHistoryState, (typeof FEEDBACK_HISTORY_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_HISTORY_STATES)[number], FeedbackHistoryState>>().toEqualTypeOf<never>()
})

test('feedback layouts are an exact union', () => {
  type Expected = 'docked' | 'stacked'
  expectTypeOf<FeedbackLayout>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FEEDBACK_LAYOUTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FeedbackLayout, (typeof FEEDBACK_LAYOUTS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FEEDBACK_LAYOUTS)[number], FeedbackLayout>>().toEqualTypeOf<never>()
})
