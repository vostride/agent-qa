import { describe, expectTypeOf, test } from 'vitest'

import type {
  MARK_APPLIED_CHANGE_KINDS,
  MARK_DISPOSITIONS,
  MARK_HISTORICAL_DISPOSITIONS,
  MARK_PREVIEW_DRAFT_KINDS,
  MARK_PREVIEW_EVIDENCE_DIRECTIONS,
  MARK_PREVIEW_LATEST_KINDS,
  MARK_PREVIEW_RECORD_EVIDENCE_KINDS,
  MARK_PREVIEW_OUTCOMES,
  MARK_PREVIEW_REFUSALS,
  MARK_TARGET_REASONS,
  MARKS,
  MARKS_HISTORY_OUTCOMES,
} from '../index'
import type {
  Mark,
  MarkAppliedChange,
  MarkDisposition,
  MarkPreviewDraft,
  MarkPreviewEvidenceEffect,
  MarkPreviewKnowledgeRecord,
  MarkPreviewLatest,
  RunsMarkOutcome,
  RunsMarkPreviewResult,
  RunsMarksHistoryResult,
} from '../index'

// Independent literal unions: no expected vocabulary is derived from production.
// Plan 423-23 owns the mutation script; C423-FEEDBACK-RESULTS-EXACT is its required RED cell.
type HistoryOutcome = 'history' | 'run-not-found' | 'ledger-corrupt' | 'ledger-unavailable'
type AppliedChangeKind = 'knowledge' | 'test-file'
// `not-applied` closes a mark whose planned fix was refused.
type WrittenDisposition = 'quarantined' | 'applied' | 'no-draftable-fix' | 'confirmed-bug' | 'not-applied'
type Refusal = 'run-not-found' | 'member-not-found' | 'step-not-found' | 'ambiguous-address'
type PreviewOutcome = 'consequences' | 'quarantined' | 'already-marked' | Refusal
type MarkOutcome = 'marked' | 'already-marked' | Refusal
type MarkKind = 'false-fail' | 'false-pass' | 'confirmed-bug'

describe('mark result types are exact unions', () => {
  test('pins the four marks-history outcome arms in both directions', () => {
    expectTypeOf<RunsMarksHistoryResult['kind']>().toEqualTypeOf<HistoryOutcome>()
    expectTypeOf<(typeof MARKS_HISTORY_OUTCOMES)[number]>().toEqualTypeOf<HistoryOutcome>()
    expectTypeOf<
      Exclude<RunsMarksHistoryResult['kind'], (typeof MARKS_HISTORY_OUTCOMES)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof MARKS_HISTORY_OUTCOMES)[number], RunsMarksHistoryResult['kind']>
    >().toEqualTypeOf<never>()
  })

  test('pins the applied change kinds and the written dispositions', () => {
    expectTypeOf<MarkAppliedChange['kind']>().toEqualTypeOf<AppliedChangeKind>()
    expectTypeOf<(typeof MARK_APPLIED_CHANGE_KINDS)[number]>().toEqualTypeOf<AppliedChangeKind>()
    expectTypeOf<(typeof MARK_DISPOSITIONS)[number]>().toEqualTypeOf<WrittenDisposition>()
    expectTypeOf<MarkDisposition['kind']>().toEqualTypeOf<WrittenDisposition | (typeof MARK_HISTORICAL_DISPOSITIONS)[number]>()
  })

  test('pins the eight preview outcome arms in both directions', () => {
    expectTypeOf<RunsMarkPreviewResult['kind']>().toEqualTypeOf<PreviewOutcome>()
    expectTypeOf<(typeof MARK_PREVIEW_OUTCOMES)[number]>().toEqualTypeOf<PreviewOutcome>()
    expectTypeOf<
      Exclude<RunsMarkPreviewResult['kind'], (typeof MARK_PREVIEW_OUTCOMES)[number]>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Exclude<(typeof MARK_PREVIEW_OUTCOMES)[number], RunsMarkPreviewResult['kind']>
    >().toEqualTypeOf<never>()
    expectTypeOf<Extract<RunsMarkPreviewResult['kind'], 'marked'>>().toEqualTypeOf<never>()
  })

  test('pins the preview refusals to runs.mark refusal objects and keeps the runs.mark and MARKS sets', () => {
    expectTypeOf<(typeof MARK_PREVIEW_REFUSALS)[number]>().toEqualTypeOf<Refusal>()
    expectTypeOf<Extract<RunsMarkPreviewResult, { kind: Refusal }>>().toEqualTypeOf<Extract<RunsMarkOutcome, { kind: Refusal }>>()
    expectTypeOf<RunsMarkOutcome['kind']>().toEqualTypeOf<MarkOutcome>()
    expectTypeOf<Mark>().toEqualTypeOf<MarkKind>()
    expectTypeOf<(typeof MARKS)[number]>().toEqualTypeOf<MarkKind>()
  })

  test('pins the preview sub-vocabularies in both directions', () => {
    type Reason = 'step-mark' | 'failing-step' | 'passing-verdict'
    type Latest = 'first' | 'supersedes'
    type Draft = 'confirmed-bug' | 'knowledge' | 'test-edit' | 'no-draftable-fix'
    type Consequences = Extract<RunsMarkPreviewResult, { kind: 'consequences' }>
    expectTypeOf<Consequences['resolvedStep']['reason']>().toEqualTypeOf<Reason>()
    expectTypeOf<(typeof MARK_TARGET_REASONS)[number]>().toEqualTypeOf<Reason>()
    expectTypeOf<MarkPreviewLatest['kind']>().toEqualTypeOf<Latest>()
    expectTypeOf<(typeof MARK_PREVIEW_LATEST_KINDS)[number]>().toEqualTypeOf<Latest>()
    expectTypeOf<MarkPreviewDraft['kind']>().toEqualTypeOf<Draft>()
    expectTypeOf<Exclude<(typeof MARK_PREVIEW_DRAFT_KINDS)[number], MarkPreviewDraft['kind']>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<MarkPreviewDraft['kind'], (typeof MARK_PREVIEW_DRAFT_KINDS)[number]>>().toEqualTypeOf<never>()
    type Direction = 'confirm' | 'overturn'
    type RecordEvidence = 'effects' | 'unreadable'
    expectTypeOf<MarkPreviewEvidenceEffect['direction']>().toEqualTypeOf<Direction>()
    expectTypeOf<(typeof MARK_PREVIEW_EVIDENCE_DIRECTIONS)[number]>().toEqualTypeOf<Direction>()
    expectTypeOf<MarkPreviewKnowledgeRecord['evidence']['kind']>().toEqualTypeOf<RecordEvidence>()
    expectTypeOf<(typeof MARK_PREVIEW_RECORD_EVIDENCE_KINDS)[number]>().toEqualTypeOf<RecordEvidence>()
  })
})
