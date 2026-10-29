import { describe, expect, test } from 'vitest'

import {
  MARK_APPLIED_CHANGE_KINDS,
  MARK_DISPOSITIONS,
  MARK_HISTORICAL_DISPOSITIONS,
  MARK_PREVIEW_DRAFT_KINDS,
  MARK_PREVIEW_EVIDENCE_DIRECTIONS,
  MARK_PREVIEW_LATEST_KINDS,
  MARK_PREVIEW_RECORD_EVIDENCE_KINDS,
  MARK_PREVIEW_OUTCOMES,
  MARK_PREVIEW_REFUSALS,
  MARK_QUARANTINE_CLASSES,
  MARK_TARGET_REASONS,
  MARKS,
  MARKS_HISTORY_OUTCOMES,
  MarkDispositionSchema,
  MarkPreviewDraftSchema,
  MarkPreviewEvidenceEffectSchema,
  MarkPreviewKnowledgeRecordSchema,
  MarkPreviewLatestSchema,
  MarkAppliedChangeSchema,
  MarkHistoryChangedRecordSchema,
  RunsMarkOutcomeSchema,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryResultSchema,
  asRunId,
} from '../index'

// Independent vocabularies, spelled by hand so no expected list is derived from production.
// Plan 423-23 owns the mutation script; C423-FEEDBACK-RESULTS-EXACT is its required RED cell.
const HISTORY_OUTCOMES = ['history', 'run-not-found', 'ledger-corrupt', 'ledger-unavailable'] as const
// 2026-09-30, 432-09: an applied fix names a knowledge change or a written test file.
const APPLIED_CHANGE_KINDS = ['knowledge', 'test-file'] as const
const REFUSALS = ['run-not-found', 'member-not-found', 'step-not-found', 'ambiguous-address'] as const
const PREVIEW_OUTCOMES = ['consequences', 'quarantined', 'already-marked', ...REFUSALS] as const
const MARK_OUTCOMES = ['marked', 'already-marked', ...REFUSALS] as const
const MARK_KINDS = ['false-fail', 'false-pass', 'confirmed-bug'] as const
const TARGET_REASONS = ['step-mark', 'failing-step', 'passing-verdict'] as const
const LATEST_KINDS = ['first', 'supersedes'] as const
const DRAFT_KINDS = ['confirmed-bug', 'knowledge', 'test-edit', 'no-draftable-fix'] as const
const EVIDENCE_DIRECTIONS = ['confirm', 'overturn'] as const
const RECORD_EVIDENCE_KINDS = ['effects', 'unreadable'] as const
// 2026-09-15, 423-25: the inherited 419 vocabularies the quarantined and already-marked arms carry.
const QUARANTINE_CLASSES = ['flake', 'environment', 'timeout'] as const
// 2026-09-30, 432-09: the writer's vocabulary is `applied`; `drafted` is a readable pre-432 receipt.
// 2026-10-03 (quick 261003-mqc): `not-applied` closes a mark whose planned fix was refused.
const DISPOSITIONS = ['quarantined', 'applied', 'no-draftable-fix', 'confirmed-bug', 'not-applied'] as const
const HISTORICAL_DISPOSITIONS = ['drafted'] as const

const runId = asRunId('run-feedback-contract')
type Options = { options: readonly { shape: Record<string, { value?: unknown }> }[] }
const armsOf = (union: unknown, key: string) => (union as Options).options.map(option => option.shape[key]!.value)

const HISTORY_CASES: Record<(typeof HISTORY_OUTCOMES)[number], unknown> = {
  history: { kind: 'history', runId, entries: [] },
  'run-not-found': { kind: 'run-not-found', runId },
  'ledger-corrupt': { kind: 'ledger-corrupt', runId, line: 3 },
  'ledger-unavailable': { kind: 'ledger-unavailable', runId },
}

const APPLIED_CASES: Record<(typeof APPLIED_CHANGE_KINDS)[number], unknown> = {
  knowledge: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: ['mem_1'] },
  'test-file': { kind: 'test-file', filePath: 'tests/checkout.yaml', contentDigest: 'abc123' },
}

const member = { testIndex: 0 }
const PREVIEW_CASES: Record<(typeof PREVIEW_OUTCOMES)[number], unknown> = {
  consequences: { kind: 'consequences', runId, prospective: true, markKind: 'false-fail', member,
    resolvedStep: { stepIndex: 0, reason: 'failing-step' },
    knowledge: { servedRecordIds: [], appendsEvidence: false, records: [], evidence: { confirmed: 0, overturned: 0 } },
    draft: { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: true } },
    latest: { kind: 'first' }, basis: { ledgerOrdinal: 0 } },
  quarantined: { kind: 'quarantined', runId, prospective: true, markKind: 'false-pass', member, class: 'timeout',
    resolvedStep: { stepIndex: 1, reason: 'step-mark' },
    latest: { kind: 'supersedes', markId: 'mark_000000000001', ordinal: 1 }, basis: { ledgerOrdinal: 1, priorMarkOrdinal: 1 } },
  'already-marked': { kind: 'already-marked', runId,
    prior: { markId: 'mark_000000000001', kind: 'confirmed-bug', ordinal: 1, testIndex: 0,
      disposition: { kind: 'confirmed-bug', confirmedRecords: 0 } },
    basis: { ledgerOrdinal: 1, priorMarkOrdinal: 1 } },
  'run-not-found': { kind: 'run-not-found', runId },
  'member-not-found': { kind: 'member-not-found', runId, testId: 'missing' },
  'step-not-found': { kind: 'step-not-found', runId, testIndex: 0, stepIndex: 4, stepCount: 2 },
  'ambiguous-address': { kind: 'ambiguous-address', runId, candidates: [{ testIndex: 0 }, { testIndex: 1 }] },
}

describe('mark result vocabularies', () => {
  test('pins the marks-history outcome arms: runtime list, schema arms and parser', () => {
    expect([...MARKS_HISTORY_OUTCOMES]).toEqual([...HISTORY_OUTCOMES])
    expect(armsOf(RunsMarksHistoryResultSchema, 'kind')).toEqual([...HISTORY_OUTCOMES])
    for (const kind of HISTORY_OUTCOMES) {
      expect(RunsMarksHistoryResultSchema.safeParse(HISTORY_CASES[kind]).success, kind).toBe(true)
    }
    for (const unknown of ['history-partial', 'marked', 'ledger-locked']) {
      expect(RunsMarksHistoryResultSchema.safeParse({ kind: unknown, runId }).success, unknown).toBe(false)
    }
  })

  // RE-SPELLED 432-09 from 'pins the current proposal states: runtime list, schema arms and parser':
  // history joins what an applied fix changed; no proposal state is read or carried.
  test('pins the applied change kinds and the changed-record join: runtime list, schema arms and parser', () => {
    expect([...MARK_APPLIED_CHANGE_KINDS]).toEqual([...APPLIED_CHANGE_KINDS])
    expect(armsOf(MarkAppliedChangeSchema, 'kind')).toEqual([...APPLIED_CHANGE_KINDS])
    for (const kind of APPLIED_CHANGE_KINDS) {
      expect(MarkAppliedChangeSchema.safeParse(APPLIED_CASES[kind]).success, kind).toBe(true)
    }
    for (const unknown of ['proposal', 'pending', 'test-draft']) {
      expect(MarkAppliedChangeSchema.safeParse({ kind: unknown }).success, unknown).toBe(false)
    }
    expect(MarkAppliedChangeSchema.safeParse({ kind: 'knowledge', changeId: 'not-a-change-id', recordIds: [] }).success).toBe(false)
    expect(MarkHistoryChangedRecordSchema.safeParse({ recordId: 'mem_1', contentAbsence: { reason: 'not-found' } }).success).toBe(true)
    expect(MarkHistoryChangedRecordSchema.safeParse({ recordId: 'mem_1' }).success, 'content or its absence').toBe(false)
  })

  test('pins the preview outcome arms: runtime list, schema arms and parser', () => {
    expect([...MARK_PREVIEW_OUTCOMES]).toEqual([...PREVIEW_OUTCOMES])
    expect(armsOf(RunsMarkPreviewResultSchema, 'kind')).toEqual([...PREVIEW_OUTCOMES])
    for (const kind of PREVIEW_OUTCOMES) {
      expect(RunsMarkPreviewResultSchema.safeParse(PREVIEW_CASES[kind]).success, kind).toBe(true)
    }
    for (const unknown of ['marked', 'refused', 'effects', 'preview']) {
      expect(RunsMarkPreviewResultSchema.safeParse({ kind: unknown, runId }).success, unknown).toBe(false)
    }
  })

  test('pins the preview refusals as exactly runs.mark refusal arms, and keeps the runs.mark and MARKS sets', () => {
    expect([...MARK_PREVIEW_REFUSALS]).toEqual([...REFUSALS])
    expect([...MARKS]).toEqual([...MARK_KINDS])
    expect(armsOf(RunsMarkOutcomeSchema, 'kind')).toEqual([...MARK_OUTCOMES])
    const previewArms = (RunsMarkPreviewResultSchema as unknown as Options).options
    const markArms = (RunsMarkOutcomeSchema as unknown as Options).options
    for (const kind of REFUSALS) {
      const arm = previewArms.find(option => option.shape.kind!.value === kind)
      expect(arm, kind).toBe(markArms.find(option => option.shape.kind!.value === kind))
      expect(RunsMarkOutcomeSchema.safeParse(PREVIEW_CASES[kind]).success, kind).toBe(true)
    }
  })

  test('pins the preview sub-vocabularies: reasons, latest and draft kinds', () => {
    expect([...MARK_TARGET_REASONS]).toEqual([...TARGET_REASONS])
    expect([...MARK_PREVIEW_LATEST_KINDS]).toEqual([...LATEST_KINDS])
    expect(armsOf(MarkPreviewLatestSchema, 'kind')).toEqual([...LATEST_KINDS])
    expect([...MARK_PREVIEW_DRAFT_KINDS]).toEqual([...DRAFT_KINDS])
    expect(armsOf(MarkPreviewDraftSchema, 'kind')).toEqual([...DRAFT_KINDS])
    const base = PREVIEW_CASES.consequences as Record<string, unknown>
    expect(RunsMarkPreviewResultSchema.safeParse({ ...base, resolvedStep: { stepIndex: 0, reason: 'last-step' } }).success).toBe(false)
    expect(RunsMarkPreviewResultSchema.safeParse({ ...base, latest: { kind: 'replaces', markId: 'mark_000000000001', ordinal: 1 } }).success).toBe(false)
    expect(MarkPreviewDraftSchema.safeParse({ kind: 'wording', text: 'x' }).success).toBe(false)
    // 423-19 D-17: the reached-record evidence vocabularies.
    expect([...MARK_PREVIEW_EVIDENCE_DIRECTIONS]).toEqual([...EVIDENCE_DIRECTIONS])
    expect(armsOf(MarkPreviewEvidenceEffectSchema, 'direction')).toEqual([...EVIDENCE_DIRECTIONS])
    expect([...MARK_PREVIEW_RECORD_EVIDENCE_KINDS]).toEqual([...RECORD_EVIDENCE_KINDS])
    const recordEvidence = (MarkPreviewKnowledgeRecordSchema as unknown as { shape: { evidence: unknown } }).shape.evidence
    expect(armsOf(recordEvidence, 'kind')).toEqual([...RECORD_EVIDENCE_KINDS])
    expect(MarkPreviewEvidenceEffectSchema.safeParse({ direction: 'withdraw' }).success).toBe(false)
    expect(MarkPreviewKnowledgeRecordSchema.safeParse({ recordId: 'r', contentAbsence: { reason: 'not-found' }, served: true,
      evidence: { kind: 'skipped' } }).success).toBe(false)
  })

  test('pins the inherited quarantine classes and prior dispositions the preview arms carry', () => {
    const previewArms = (RunsMarkPreviewResultSchema as unknown as Options).options
    const quarantined = previewArms.find(option => option.shape.kind!.value === 'quarantined')!
    expect([...MARK_QUARANTINE_CLASSES]).toEqual([...QUARANTINE_CLASSES])
    expect((quarantined.shape.class as unknown as { options: string[] }).options).toEqual([...QUARANTINE_CLASSES])
    const base = PREVIEW_CASES.quarantined as Record<string, unknown>
    for (const value of QUARANTINE_CLASSES) {
      expect(RunsMarkPreviewResultSchema.safeParse({ ...base, class: value }).success, value).toBe(true)
    }
    expect(RunsMarkPreviewResultSchema.safeParse({ ...base, class: 'unclassified' }).success).toBe(false)

    expect([...MARK_DISPOSITIONS]).toEqual([...DISPOSITIONS])
    expect([...MARK_HISTORICAL_DISPOSITIONS]).toEqual([...HISTORICAL_DISPOSITIONS])
    expect(armsOf(MarkDispositionSchema, 'kind')).toEqual([...DISPOSITIONS, ...HISTORICAL_DISPOSITIONS])
    const alreadyMarked = previewArms.find(option => option.shape.kind!.value === 'already-marked')!
    const prior = alreadyMarked.shape.prior as unknown as { shape: { disposition: unknown } }
    expect(prior.shape.disposition).toBe(MarkDispositionSchema)
    const repeat = PREVIEW_CASES['already-marked'] as { prior: Record<string, unknown> } & Record<string, unknown>
    const cases: Record<(typeof DISPOSITIONS)[number] | (typeof HISTORICAL_DISPOSITIONS)[number], unknown> = {
      quarantined: { kind: 'quarantined', class: 'flake' },
      applied: { kind: 'applied', fix: 'fact', change: APPLIED_CASES.knowledge },
      drafted: { kind: 'drafted', fix: 'fact', proposalId: 'proposal-1', proposalKind: 'knowledge' },
      'no-draftable-fix': { kind: 'no-draftable-fix', checked: { servedRecords: 0, procedureReads: 0, assertionDrift: false } },
      'confirmed-bug': { kind: 'confirmed-bug', confirmedRecords: 0 },
      'not-applied': { kind: 'not-applied', fix: 'fact', reason: 'target-not-found' },
    }
    for (const kind of [...DISPOSITIONS, ...HISTORICAL_DISPOSITIONS]) {
      expect(RunsMarkPreviewResultSchema.safeParse({ ...repeat, prior: { ...repeat.prior, disposition: cases[kind] } }).success, kind).toBe(true)
    }
    // A test edit writes a file and every other fix changes knowledge.
    expect(MarkDispositionSchema.safeParse({ kind: 'applied', fix: 'test-edit', change: APPLIED_CASES.knowledge }).success).toBe(false)
    expect(MarkDispositionSchema.safeParse({ kind: 'applied', fix: 'caution', change: APPLIED_CASES['test-file'] }).success).toBe(false)
    expect(RunsMarkPreviewResultSchema.safeParse({ ...repeat, prior: { ...repeat.prior, disposition: { kind: 'withdrawn' } } }).success).toBe(false)
  })
})
