import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { asRunId, runIdSchema } from '../../run/run-id'
import {
  COMMIT_RECEIPT_SCHEMA_VERSION,
  IMPROVEMENT_PLAN_SCHEMA_VERSION,
  MARK_RECEIPT_SCHEMA_VERSION,
  MARK_DISPOSITIONS, MARK_FIX_KINDS, MARK_QUARANTINE_CLASSES,
  CommitReceiptSchema, ImprovementPlanSchema, ImprovementPlanKnowledgeSchema,
  MarkAddressSchema, MarkDispositionSchema, MarkReceiptSchema, NoDraftableFixCheckedSchema,
  RunDetailMemberMarkSchema, RunsMarkInputSchema, RunsMarkOutcomeSchema, deriveMarkStepId,
} from '../feedback'

const runId = asRunId('run-feedback')
const markId = 'mark_0123456789ab'
const checked = { servedRecords: 0, procedureReads: 0, assertionDrift: false }
const receipt = {
  schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId, runId, testIndex: 0, runSlug: 'run-feedback',
  kind: 'false-fail', origin: 'user', ordinal: 1, markedAt: 0,
  disposition: { kind: 'quarantined', class: 'flake' },
  evidence: { confirmed: 0, overturned: 0 },
}
const planBase = {
  schemaVersion: IMPROVEMENT_PLAN_SCHEMA_VERSION, markId,
  feedbackSource: { runId, testIndex: 0, kind: 'false-fail' },
  runTraceRef: { runId, runSlug: 'run-feedback' },
}
const knowledge = {
  ...planBase, kind: 'knowledge', fix: 'fact',
  target: { grain: 'record', recordId: 'rec-1' }, wording: 'floor',
  deltas: [{ kind: 'Confirm', origin: 'user', scope: { tier: 'suite', key: 'checkout' }, citedIds: ['rec-1'], targetId: 'rec-1', evidenceToken: 'ev-1' }],
}
const commitReceipt = {
  schemaVersion: COMMIT_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo', markId, committedAtOrdinal: 0,
  recordIds: ['rec-1'], gate3: [{ candidateId: 'rec-1', receiptDigest: 'a'.repeat(64) }],
  promoted: [{ candidateId: 'rec-1', promotionPath: 'user-sovereign' }],
  held: [{ candidateId: 'rec-2', reason: 'no receipt' }],
}

describe('Gate-3 neutral feedback contracts', () => {
  it('pins the quarantine, disposition and fix vocabularies in declaration order', () => {
    expect(MARK_QUARANTINE_CLASSES).toEqual(['flake', 'environment', 'timeout'])
    // the writer applies a fix; `drafted` is only read back (MARK_HISTORICAL_DISPOSITIONS).
    // `not-applied` closes a mark whose planned fix was refused.
    expect(MARK_DISPOSITIONS).toEqual(['quarantined', 'applied', 'no-draftable-fix', 'confirmed-bug', 'not-applied'])
    expect(MARK_FIX_KINDS).toEqual(['fact', 'caution', 'procedure-hint', 'test-edit'])
  })

  it('requires only the address and kind, retaining optional user text and zero-based steps', () => {
    expect(RunsMarkInputSchema.shape.runId).toBe(runIdSchema.in)
    const input = { runId, kind: 'false-fail' }
    expect(RunsMarkInputSchema.parse(input)).toEqual(input)
    const full = { ...input, testId: 'member', stepIndex: 0, note: 'check' }
    expect(RunsMarkInputSchema.parse(full)).toEqual(full)
    expect(RunsMarkInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false)
    for (const stepIndex of [-1, 1.5]) {
      expect(RunsMarkInputSchema.safeParse({ ...input, stepIndex }).success).toBe(false)
    }
    expect(RunsMarkInputSchema.safeParse({ ...input, kind: 'confirmed-pass' }).success).toBe(false)
    expect(RunsMarkInputSchema.safeParse({ ...input, note: 'x'.repeat(2000) }).success).toBe(true)
    expect(RunsMarkInputSchema.safeParse({ ...input, note: 'x'.repeat(2001) }).success).toBe(false)
    for (const invalid of ['', '../escape', 'a/b', 'a\\b', 'a\nb']) {
      expect(RunsMarkInputSchema.safeParse({ ...input, runId: invalid }).success).toBe(false)
    }
  })

  it('round-trips all six outcomes and refuses an ambiguous address with one candidate', () => {
    const outcomes = [
      { kind: 'marked', receipt }, { kind: 'already-marked', receipt },
      { kind: 'run-not-found', runId }, { kind: 'member-not-found', runId, testId: 'missing' },
      { kind: 'step-not-found', runId, testIndex: 0, stepIndex: 2, stepCount: 2 },
      { kind: 'ambiguous-address', runId, candidates: [{ testIndex: 0 }, { testIndex: 1, testId: 'member' }] },
    ]
    for (const outcome of outcomes) {
      expect(RunsMarkOutcomeSchema.parse(outcome)).toEqual(outcome)
      expect(RunsMarkOutcomeSchema.safeParse({ ...outcome, extra: 1 }).success).toBe(false)
    }
    expect(RunsMarkOutcomeSchema.safeParse({ kind: 'ambiguous-address', runId, candidates: [{ testIndex: 0 }] }).success).toBe(false)
  })

  it('pins persisted user origin, receipt version and integer ledger positions', () => {
    expect(MarkReceiptSchema.parse(receipt)).toEqual(receipt)
    for (const change of [{ origin: 'agent' }, { schemaVersion: 1 }, { ordinal: 0 }, { ordinal: -1 }, { ordinal: 1.5 }]) {
      expect(MarkReceiptSchema.safeParse({ ...receipt, ...change }).success).toBe(false)
    }
    for (const committedAtOrdinal of [-1, 1.5]) {
      expect(CommitReceiptSchema.safeParse({ ...commitReceipt, committedAtOrdinal }).success).toBe(false)
    }
  })

  it('round-trips every disposition and refuses extra nested fields', () => {
    const dispositions = [receipt.disposition,
      { kind: 'applied', fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_alpha-bravo', recordIds: ['mem_1'] } },
      { kind: 'applied', fix: 'test-edit', change: { kind: 'test-file', filePath: 'checkout.yaml', contentDigest: 'abc' } },
      { kind: 'drafted', fix: 'fact', proposalId: 'prop_alpha-bravo', proposalKind: 'knowledge' },
      { kind: 'no-draftable-fix', checked }, { kind: 'confirmed-bug', confirmedRecords: 1 },
    ]
    for (const disposition of dispositions) {
      expect(MarkDispositionSchema.parse(disposition)).toEqual(disposition)
      expect(MarkDispositionSchema.safeParse({ ...disposition, extra: 1 }).success).toBe(false)
    }
  })

  it('round-trips the three plan arms and refuses empty or MintUnknown knowledge deltas', () => {
    for (const plan of [knowledge,
      { ...planBase, kind: 'test-edit', fix: 'test-edit', testRef: 'checkout.yaml', intent: 'assert visible', wording: 'model' },
      { ...planBase, kind: 'no-draftable-fix', checked },
    ]) {
      expect(ImprovementPlanSchema.parse(plan)).toEqual(plan)
      expect(ImprovementPlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false)
    }
    expect(ImprovementPlanSchema.safeParse({ ...knowledge, deltas: [] }).success).toBe(false)
    const result = ImprovementPlanSchema.safeParse({ ...knowledge, deltas: [{ ...knowledge.deltas[0], kind: 'MintUnknown' }] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['deltas', 0, 'kind'])
  })

  it('round-trips commit receipts with and without policy materialization', () => {
    expect(CommitReceiptSchema.parse(commitReceipt)).toEqual(commitReceipt)
    const withPolicy = { ...commitReceipt, policy: { recordId: 'rec-1', scope: 'suite', relPath: 'policies/suite.md', outcome: 'written' } }
    expect(CommitReceiptSchema.parse(withPolicy)).toEqual(withPolicy)
  })

  it('uses the gate3ArmSchema and DisplayStep address spelling', () => {
    expect(deriveMarkStepId(2, 5)).toBe('2:5')
  })

  it('projects every feedback DTO to JSON schema for both catalogue directions', () => {
    for (const schema of [RunsMarkInputSchema, RunsMarkOutcomeSchema, MarkReceiptSchema,
      ImprovementPlanSchema, ImprovementPlanKnowledgeSchema, CommitReceiptSchema,
      MarkAddressSchema, MarkDispositionSchema, NoDraftableFixCheckedSchema, RunDetailMemberMarkSchema]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow()
      expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow()
    }
  })
})
