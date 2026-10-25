// 2026-09-08, 419 D-06/D-07/D-08/D-12: the Gate-3 neutral contracts.
import { z } from 'zod'

import { MARKS } from '../knowledge/gate-receipt'
import { DeltaSchema, KnowledgeChangeIdSchema, KnowledgeTargetRefSchema } from '../knowledge/change'
import { runIdSchema as runIdCodec, type RunId } from '../run/run-id'
import { VERDICT_CLASSES, type VerdictClass } from '../verdict/verdict'
import { oneJoinArm, recordJoinShape } from './record-join'

// Reuse the canonical path validator before its type-only branding transform. The bytes
// are unchanged; this structural schema also supports output JSON-schema projection.
const runIdSchema = runIdCodec.in as unknown as z.ZodType<RunId>
const markIdSchema = z.string().regex(/^mark_[0-9a-f]{12}$/)
const indexSchema = z.number().int().nonnegative()
type ExactlyEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// prettier-ignore
export const MARK_QUARANTINE_CLASSES = ['flake', 'environment', 'timeout'] as const satisfies readonly VerdictClass[]
export type MarkQuarantineClass = (typeof MARK_QUARANTINE_CLASSES)[number]

export const MARK_FIX_KINDS = ['fact', 'caution', 'procedure-hint', 'test-edit'] as const
export type MarkFixKind = (typeof MARK_FIX_KINDS)[number]

// 2026-09-30, 432-09 (D-04/D-22): a mark applies its fix in the call, so the writer's vocabulary is
// `applied`. `drafted` is the pre-432 receipt that filed a proposal instead: it stays readable in an
// existing ledger (430 D-08) and no writer produces it.
// 2026-10-03 (quick 261003-mqc): `not-applied` closes a mark whose own planned fix was refused,
// under the mark's own identity, so its gold and evidence count once and the run takes a new mark.
// prettier-ignore
export const MARK_DISPOSITIONS = ['quarantined', 'applied', 'no-draftable-fix', 'confirmed-bug', 'not-applied'] as const
export const MARK_HISTORICAL_DISPOSITIONS = ['drafted'] as const

/**
 * Why a mark's planned fix was not applied. Each comes from the plan itself, so retrying the same
 * plan could never apply it: the knowledge target is gone, the policy text is refused, or the test
 * file is outside the workspace.
 */
export const MARK_FIX_REFUSALS = [
  'target-not-found',
  'policy-materialize-refused',
  'outside-workspace',
] as const
export type MarkFixRefusal = (typeof MARK_FIX_REFUSALS)[number]

export const MARK_APPLIED_CHANGE_KINDS = ['knowledge', 'test-file'] as const

/**
 * What an applied fix changed. A knowledge change names its stable change id and the records the
 * write read back; a test edit names the file it wrote and the digest of the exact bytes written.
 */
export const MarkAppliedChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('knowledge'),
    changeId: KnowledgeChangeIdSchema,
    recordIds: z.array(z.string().min(1)),
  }).strict(),
  z.object({
    kind: z.literal('test-file'),
    filePath: z.string().min(1),
    contentDigest: z.string().min(1),
  }).strict(),
])
export type MarkAppliedChange = z.infer<typeof MarkAppliedChangeSchema>

export const NoDraftableFixCheckedSchema = z.object({
  servedRecords: indexSchema,
  procedureReads: indexSchema,
  assertionDrift: z.boolean(),
  rootCause: z.enum(VERDICT_CLASSES).optional(),
}).strict()
export type NoDraftableFixChecked = z.infer<typeof NoDraftableFixCheckedSchema>

export const MarkDispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('quarantined'), class: z.enum(MARK_QUARANTINE_CLASSES) }).strict(),
  z.object({
    kind: z.literal('applied'),
    fix: z.enum(MARK_FIX_KINDS),
    change: MarkAppliedChangeSchema,
  }).strict().superRefine((value, ctx) => {
    if ((value.fix === 'test-edit') !== (value.change.kind === 'test-file')) {
      ctx.addIssue({ code: 'custom', path: ['change', 'kind'], message: 'a test edit writes a test file and every other fix changes knowledge' })
    }
  }),
  z.object({ kind: z.literal('no-draftable-fix'), checked: NoDraftableFixCheckedSchema }).strict(),
  z.object({ kind: z.literal('confirmed-bug'), confirmedRecords: indexSchema }).strict(),
  /** The mark's planned fix was refused, so nothing was changed; the mark itself stands. */
  z.object({
    kind: z.literal('not-applied'),
    fix: z.enum(MARK_FIX_KINDS),
    reason: z.enum(MARK_FIX_REFUSALS),
  }).strict(),
  /** Historical (read only): a pre-432 mark that filed a proposal. Its change was never recorded. */
  z.object({
    kind: z.literal('drafted'),
    fix: z.enum(MARK_FIX_KINDS),
    proposalId: z.string().min(1),
    proposalKind: z.enum(['knowledge', 'test-draft']),
  }).strict(),
])
export type MarkDisposition = z.infer<typeof MarkDispositionSchema>
const _dispositionsCover: ExactlyEqual<
  (typeof MARK_DISPOSITIONS)[number] | (typeof MARK_HISTORICAL_DISPOSITIONS)[number], MarkDisposition['kind']> = true
void _dispositionsCover
const _appliedChangeKindsCover: ExactlyEqual<(typeof MARK_APPLIED_CHANGE_KINDS)[number], MarkAppliedChange['kind']> = true
void _appliedChangeKindsCover

export const MarkAddressSchema = z.object({
  runId: runIdSchema,
  testIndex: indexSchema,
  testId: z.string().min(1).optional(),
  stepIndex: indexSchema.optional(),
}).strict()
export type MarkAddress = z.infer<typeof MarkAddressSchema>

export const MARK_RECEIPT_SCHEMA_VERSION = 2
export const MarkReceiptSchema = z.object({
  schemaVersion: z.literal(MARK_RECEIPT_SCHEMA_VERSION),
  markId: markIdSchema,
  ...MarkAddressSchema.shape,
  runSlug: z.string().min(1),
  kind: z.enum(MARKS),
  origin: z.literal('user'),
  /** The 1-based append position governs latest-wins, never markedAt (419 D-11). */
  ordinal: z.number().int().positive(),
  markedAt: indexSchema,
  note: z.string().max(2000).optional(),
  rootCause: z.object({ class: z.enum(VERDICT_CLASSES), producer: z.string().min(1) }).strict().optional(),
  isRerun: z.literal(true).optional(),
  disposition: MarkDispositionSchema,
  gold: z.array(z.object({
    cassetteId: z.string().min(1),
    sourceCassetteId: z.string().min(1),
    channel: z.enum(['user-mark', 'overturned-verdict']),
  }).strict()),
  evidence: z.object({ confirmed: indexSchema, overturned: indexSchema }).strict(),
  supersedes: markIdSchema.optional(),
}).strict()
export type MarkReceipt = z.infer<typeof MarkReceiptSchema>

export const RunsMarkInputSchema = z.object({
  runId: runIdSchema,
  testId: z.string().min(1).optional(),
  stepIndex: indexSchema.optional(),
  kind: z.enum(MARKS),
  note: z.string().max(2000).optional(),
}).strict()
export type RunsMarkInput = z.infer<typeof RunsMarkInputSchema>

export const RunsMarkOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('marked'), receipt: MarkReceiptSchema }).strict(),
  z.object({ kind: z.literal('already-marked'), receipt: MarkReceiptSchema }).strict(),
  z.object({ kind: z.literal('run-not-found'), runId: runIdSchema }).strict(),
  z.object({ kind: z.literal('member-not-found'), runId: runIdSchema, testId: z.string().optional() }).strict(),
  z.object({
    kind: z.literal('step-not-found'), runId: runIdSchema,
    testIndex: indexSchema, stepIndex: indexSchema, stepCount: indexSchema,
  }).strict(),
  z.object({
    kind: z.literal('ambiguous-address'), runId: runIdSchema,
    candidates: z.array(z.object({ testIndex: indexSchema, testId: z.string().optional() }).strict()).min(2),
  }).strict(),
])
export type RunsMarkOutcome = z.infer<typeof RunsMarkOutcomeSchema>

export const IMPROVEMENT_PLAN_SCHEMA_VERSION = 2
const improvementPlanShape = {
  schemaVersion: z.literal(IMPROVEMENT_PLAN_SCHEMA_VERSION),
  markId: markIdSchema,
  feedbackSource: MarkAddressSchema.extend({ kind: z.enum(MARKS) }),
  runTraceRef: z.object({ runId: runIdSchema, runSlug: z.string().min(1) }).strict(),
}
const wordingSchema = z.enum(['model', 'floor'])
export const ImprovementPlanKnowledgeSchema = z.object({
  kind: z.literal('knowledge'),
  ...improvementPlanShape,
  fix: z.enum(['fact', 'caution', 'procedure-hint']),
  target: KnowledgeTargetRefSchema,
  deltas: z.array(DeltaSchema).min(1),
  wording: wordingSchema,
}).strict().superRefine((value, ctx) => {
  value.deltas.forEach((delta, index) => {
    if (delta.kind === 'MintUnknown') {
      ctx.addIssue({ code: 'custom', path: ['deltas', index, 'kind'], message: 'a mark never mints unknown knowledge (419 D-12)' })
    }
  })
})
export type ImprovementPlanKnowledge = z.infer<typeof ImprovementPlanKnowledgeSchema>

export const ImprovementPlanSchema = z.discriminatedUnion('kind', [
  ImprovementPlanKnowledgeSchema,
  z.object({
    kind: z.literal('test-edit'), ...improvementPlanShape,
    fix: z.literal('test-edit'), testRef: z.string().min(1), intent: z.string().min(1), wording: wordingSchema,
  }).strict(),
  z.object({
    kind: z.literal('no-draftable-fix'), ...improvementPlanShape, checked: NoDraftableFixCheckedSchema,
  }).strict(),
])
export type ImprovementPlan = z.infer<typeof ImprovementPlanSchema>

// 2026-10-01, 432-17: the commit receipt is a direct change receipt and lives with the change
// contracts; it is re-exported here so every existing import keeps its path.
export { COMMIT_RECEIPT_SCHEMA_VERSION, CommitReceiptSchema } from '../knowledge/change'
export type { CommitReceipt } from '../knowledge/change'

export const RunDetailMemberMarkSchema = z.object({
  markId: markIdSchema,
  kind: z.enum(MARKS),
  ordinal: z.number().int().positive(),
  stepIndex: indexSchema.optional(),
  disposition: MarkDispositionSchema,
}).strict()
export type RunDetailMemberMark = z.infer<typeof RunDetailMemberMarkSchema>

/** OQ5: gate3ArmSchema.stepId uses the same test:step spelling as DisplayStep addressing. */
export function deriveMarkStepId(testIndex: number, stepIndex: number): string {
  return `${testIndex}:${stepIndex}`
}

// 2026-10-02 (432-42, D-15): no mark refusal body. `MarkRefusalSchema` described the 403 the browser
// door answered when the execution gate denied a mark; the gate is deleted (432-19), no route
// answers that body, and the dashboard's branch that read it is deleted with it.

/** Shared by runs.mark and runs.detail's ledger projection. */
export interface FeedbackPort {
  mark(input: RunsMarkInput): Promise<RunsMarkOutcome>
  marksFor(runId: RunId): Promise<readonly MarkReceipt[]>
}

/** The ledger's latest-wins address: member plus step, testId deliberately excluded (419 D-11). */
export function markAddressKey(address: Pick<MarkAddress, 'testIndex' | 'stepIndex'>): string {
  return `${address.testIndex}:${address.stepIndex ?? 'run'}`
}

// 2026-09-15, 423 D-19: marks history. 2026-09-30, 432-09 (D-04/D-25): each applied knowledge fix
// joins the records it changed, read now; nothing is read from a proposal store.

export const RunsMarksHistoryInputSchema = z.object({ runId: runIdSchema }).strict()
export type RunsMarksHistoryInput = z.infer<typeof RunsMarksHistoryInputSchema>

/** One record an applied fix changed: its id, then its content as the store shows it now, or why not. */
export const MarkHistoryChangedRecordSchema = z.object({
  recordId: z.string().min(1),
  ...recordJoinShape,
}).strict().superRefine((record, ctx) => {
  oneJoinArm(record, ctx)
  if (record.recordContent === undefined && record.contentAbsence === undefined) {
    ctx.addIssue({ code: 'custom', path: ['recordContent'], message: 'a changed record leads with its content or the typed absence of it' })
  }
})
export type MarkHistoryChangedRecord = z.infer<typeof MarkHistoryChangedRecordSchema>

const receiptFactShape = MarkReceiptSchema.omit({
  schemaVersion: true, runSlug: true, note: true,
}).shape

export const MarkHistoryEntrySchema = z.object({
  ...receiptFactShape,
  // Masked free text can differ in length from the recorded note, so the writer's cap is not reapplied.
  note: z.string().optional(),
  active: z.boolean(),
  supersededBy: markIdSchema.optional(),
  /** The records an applied knowledge fix changed, in the receipt's order, joined at read time. */
  changedRecords: z.array(MarkHistoryChangedRecordSchema).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.active === (entry.supersededBy !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['active'], message: 'exactly the unsuperseded receipt on an address is active' })
  }
  const recordIds = entry.disposition.kind === 'applied' && entry.disposition.change.kind === 'knowledge'
    ? entry.disposition.change.recordIds : undefined
  if (recordIds === undefined ? entry.changedRecords !== undefined
    : entry.changedRecords?.map(record => record.recordId).join('\n') !== recordIds.join('\n')) {
    ctx.addIssue({ code: 'custom', path: ['changedRecords'], message: 'an applied knowledge fix joins exactly the records its receipt names' })
  }
})
export type MarkHistoryEntry = z.infer<typeof MarkHistoryEntrySchema>

export const MARKS_HISTORY_OUTCOMES = ['history', 'run-not-found', 'ledger-corrupt', 'ledger-unavailable'] as const

export const RunsMarksHistoryResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('history'), runId: runIdSchema, entries: z.array(MarkHistoryEntrySchema) }).strict()
    .superRefine((value, ctx) => {
      value.entries.forEach((entry, index) => {
        if (entry.ordinal !== index + 1 || entry.runId !== value.runId) {
          ctx.addIssue({ code: 'custom', path: ['entries', index, 'ordinal'], message: 'history is this run ledger in ordinal order' })
        }
      })
    }),
  z.object({ kind: z.literal('run-not-found'), runId: runIdSchema }).strict(),
  z.object({ kind: z.literal('ledger-corrupt'), runId: runIdSchema, line: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('ledger-unavailable'), runId: runIdSchema }).strict(),
])
export type RunsMarksHistoryResult = z.infer<typeof RunsMarksHistoryResultSchema>
const _historyOutcomesCover: ExactlyEqual<(typeof MARKS_HISTORY_OUTCOMES)[number], RunsMarksHistoryResult['kind']> = true
void _historyOutcomesCover

// The preview's refusals are runs.mark's own arms, taken by position and type-pinned below.
const [, , markRunNotFoundArm, markMemberNotFoundArm, markStepNotFoundArm, markAmbiguousAddressArm] = RunsMarkOutcomeSchema.options

export const MARK_PREVIEW_REFUSALS = ['run-not-found', 'member-not-found', 'step-not-found', 'ambiguous-address'] as const
export const MARK_PREVIEW_OUTCOMES = ['consequences', 'quarantined', 'already-marked', ...MARK_PREVIEW_REFUSALS] as const
export const MARK_TARGET_REASONS = ['step-mark', 'failing-step', 'passing-verdict'] as const
export const MARK_GOLD_CHANNELS = ['user-mark', 'overturned-verdict'] as const
export const MARK_PREVIEW_LATEST_KINDS = ['first', 'supersedes'] as const
export const MARK_PREVIEW_DRAFT_KINDS = ['confirmed-bug', 'knowledge', 'test-edit', 'no-draftable-fix'] as const

const _refusalArmsInOrder: ExactlyEqual<
  [z.infer<typeof markRunNotFoundArm>['kind'], z.infer<typeof markMemberNotFoundArm>['kind'],
    z.infer<typeof markStepNotFoundArm>['kind'], z.infer<typeof markAmbiguousAddressArm>['kind']],
  [...typeof MARK_PREVIEW_REFUSALS]> = true
void _refusalArmsInOrder
const _goldChannelsCover: ExactlyEqual<(typeof MARK_GOLD_CHANNELS)[number], MarkReceipt['gold'][number]['channel']> = true
void _goldChannelsCover

export const MarkPreviewBasisSchema = z.object({
  ledgerOrdinal: indexSchema,
  /** The addressed prior mark's ordinal as observed. Not a lock: runs.mark re-plans under its transaction. */
  priorMarkOrdinal: z.number().int().positive().optional(),
}).strict().refine(basis => basis.priorMarkOrdinal === undefined || basis.priorMarkOrdinal <= basis.ledgerOrdinal,
  { message: 'the prior mark lies inside the observed ledger', path: ['priorMarkOrdinal'] })
export type MarkPreviewBasis = z.infer<typeof MarkPreviewBasisSchema>

export const MarkPreviewLatestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('first') }).strict(),
  z.object({ kind: z.literal('supersedes'), markId: markIdSchema, ordinal: z.number().int().positive() }).strict(),
])
export type MarkPreviewLatest = z.infer<typeof MarkPreviewLatestSchema>

const previewMemberSchema = z.object({ testIndex: indexSchema, testId: z.string().min(1).optional() }).strict()
const resolvedStepSchema = z.object({ stepIndex: indexSchema, reason: z.enum(MARK_TARGET_REASONS) }).strict()

export const MarkPreviewGroundTruthSchema = z.object({
  testIndex: indexSchema,
  stepIndex: indexSchema,
  /** The verdict the mark asserts for this step. */
  verdict: z.enum(['pass', 'fail']),
  recordedVerdict: z.object({ pass: z.boolean(), reasoning: z.string() }).strict(),
}).strict()
export type MarkPreviewGroundTruth = z.infer<typeof MarkPreviewGroundTruthSchema>

/** A label a freeze would write. Gold cassette ids and ordinals are writer-minted and never appear. */
export const MarkPreviewLabelSchema = z.object({
  testIndex: indexSchema,
  stepIndex: indexSchema,
  decisionOrdinal: indexSchema,
  sourceCassetteId: z.string().min(1),
  channel: z.enum(MARK_GOLD_CHANNELS),
  correction: z.object({ verdict: z.enum(['pass', 'fail']) }).strict().optional(),
}).strict()
export type MarkPreviewLabel = z.infer<typeof MarkPreviewLabelSchema>

export const MARK_PREVIEW_EVIDENCE_DIRECTIONS = ['confirm', 'overturn'] as const
export const MARK_PREVIEW_RECORD_EVIDENCE_KINDS = ['effects', 'unreadable'] as const

/** One evidence event the writer's append would land; an overturn names the prior positive it reverses. */
export const MarkPreviewEvidenceEffectSchema = z.discriminatedUnion('direction', [
  z.object({ direction: z.literal('confirm') }).strict(),
  z.object({ direction: z.literal('overturn'), overturnsEvidenceToken: z.string(), overturnsCurationJobId: z.string().min(1) }).strict(),
])
export type MarkPreviewEvidenceEffect = z.infer<typeof MarkPreviewEvidenceEffectSchema>

/**
 * 2026-09-15, 423 D-17: one record the mark reaches, led by its joined content (or the typed reason
 * there is none) and followed by its complete planned effects. A record the store cannot read keeps
 * its id and is `unreadable`, exactly as the writer skips it.
 */
export const MarkPreviewKnowledgeRecordSchema = z.object({
  recordId: z.string().min(1),
  ...recordJoinShape,
  /** Served on a targeted step; otherwise reached only by false-pass correlation. */
  served: z.boolean(),
  evidence: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('effects'), effects: z.array(MarkPreviewEvidenceEffectSchema).min(1) }).strict(),
    z.object({ kind: z.literal('unreadable') }).strict(),
  ]),
}).strict().superRefine((record, ctx) => {
  if ((record.recordContent === undefined) === (record.contentAbsence === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['recordContent'], message: 'a reached record leads with its content or the typed absence of it' })
  }
  if (record.evidence.kind !== 'effects') return
  const confirms = record.evidence.effects.filter(effect => effect.direction === 'confirm').length
  if (confirms !== (record.served ? 1 : 0) || (record.served && record.evidence.effects[0]!.direction !== 'confirm')) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'a served record is confirmed first and once; an unserved record is only overturned' })
  }
})
export type MarkPreviewKnowledgeRecord = z.infer<typeof MarkPreviewKnowledgeRecordSchema>
const _evidenceDirectionsCover: ExactlyEqual<(typeof MARK_PREVIEW_EVIDENCE_DIRECTIONS)[number], MarkPreviewEvidenceEffect['direction']> = true
void _evidenceDirectionsCover
const _recordEvidenceKindsCover: ExactlyEqual<(typeof MARK_PREVIEW_RECORD_EVIDENCE_KINDS)[number], MarkPreviewKnowledgeRecord['evidence']['kind']> = true
void _recordEvidenceKindsCover

/**
 * The knowledge the mark would reach: the writer's own evidence inputs, every reached record
 * (served targets first, then correlated unserved records) and the receipt evidence counts the
 * append would report. Effects are prospective; nothing is appended by a preview.
 */
export const MarkPreviewKnowledgeSchema = z.object({
  servedRecordIds: z.array(z.string().min(1)),
  appendsEvidence: z.boolean(),
  records: z.array(MarkPreviewKnowledgeRecordSchema),
  evidence: z.object({ confirmed: indexSchema, overturned: indexSchema }).strict(),
}).strict().superRefine((knowledge, ctx) => {
  const ids = knowledge.records.map(record => record.recordId)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['records'], message: 'each reached record appears once' })
  const served = knowledge.records.filter(record => record.served).map(record => record.recordId)
  if (served.join('\n') !== [...new Set(knowledge.servedRecordIds)].join('\n')
    || knowledge.records.slice(0, served.length).some(record => !record.served)) {
    ctx.addIssue({ code: 'custom', path: ['records'], message: 'the served records lead, in served order, and no others are served' })
  }
  if (!knowledge.appendsEvidence && knowledge.records.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['records'], message: 'a mark that appends no evidence reaches no record' })
  }
  const effects = knowledge.records.flatMap(record => record.evidence.kind === 'effects' ? record.evidence.effects : [])
  const confirmed = effects.filter(effect => effect.direction === 'confirm').length
  if (knowledge.evidence.confirmed !== confirmed || knowledge.evidence.overturned !== effects.length - confirmed) {
    ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'the evidence counts are the planned effects' })
  }
})
export type MarkPreviewKnowledge = z.infer<typeof MarkPreviewKnowledgeSchema>

/** applyFeedback's plan kind and target: the fix runs.mark will apply. Its wording is a model call and is never previewed. */
export const MarkPreviewDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirmed-bug') }).strict(),
  z.object({ kind: z.literal('knowledge'), fix: z.enum(['fact', 'caution', 'procedure-hint']), target: KnowledgeTargetRefSchema }).strict(),
  z.object({ kind: z.literal('test-edit'), testRef: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('no-draftable-fix'), checked: NoDraftableFixCheckedSchema }).strict(),
])
export type MarkPreviewDraft = z.infer<typeof MarkPreviewDraftSchema>

type LatestWithBasis = { latest: MarkPreviewLatest; basis: MarkPreviewBasis }
function refineLatestBasis(value: LatestWithBasis, ctx: z.RefinementCtx) {
  const prior = value.latest.kind === 'supersedes' ? value.latest.ordinal : undefined
  if (prior !== value.basis.priorMarkOrdinal) {
    ctx.addIssue({ code: 'custom', path: ['basis', 'priorMarkOrdinal'], message: 'the basis names exactly the mark this one would supersede' })
  }
}

const prospectiveShape = {
  runId: runIdSchema,
  /** Every effect below is what runs.mark would do now; nothing has been written. */
  prospective: z.literal(true),
  markKind: z.enum(MARKS),
  member: previewMemberSchema,
  resolvedStep: resolvedStepSchema,
  latest: MarkPreviewLatestSchema,
  basis: MarkPreviewBasisSchema,
}

export const RunsMarkPreviewResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('consequences'),
    ...prospectiveShape,
    markedDecisionCount: indexSchema,
    groundTruth: z.array(MarkPreviewGroundTruthSchema),
    labels: z.array(MarkPreviewLabelSchema),
    knowledge: MarkPreviewKnowledgeSchema,
    draft: MarkPreviewDraftSchema,
  }).strict().superRefine((value, ctx) => {
    refineLatestBasis(value, ctx)
    if ((value.draft.kind === 'confirmed-bug') !== (value.markKind === 'confirmed-bug')) {
      ctx.addIssue({ code: 'custom', path: ['draft'], message: 'a confirmed bug drafts no fix and every other mark plans one' })
    }
    if (value.markKind !== 'false-pass' && value.labels.some(label => label.channel === 'overturned-verdict')) {
      ctx.addIssue({ code: 'custom', path: ['labels'], message: 'only a false-pass freezes an overturned verdict' })
    }
    if (value.markKind !== 'false-pass' && (value.knowledge.evidence.overturned > 0
      || value.knowledge.records.some(record => !record.served))) {
      ctx.addIssue({ code: 'custom', path: ['knowledge'], message: 'only a false-pass overturns or reaches an unserved record' })
    }
    const foreign = [...value.groundTruth, ...value.labels].some(item => item.testIndex !== value.member.testIndex)
    if (foreign) ctx.addIssue({ code: 'custom', path: ['member'], message: 'ground truth and labels belong to the resolved member' })
  }),
  z.object({
    kind: z.literal('quarantined'),
    ...prospectiveShape,
    class: z.enum(MARK_QUARANTINE_CLASSES),
  }).strict().superRefine(refineLatestBasis),
  z.object({
    kind: z.literal('already-marked'),
    runId: runIdSchema,
    /** The existing mark an identical repeat returns; a present fact, not a prospective one. */
    prior: RunDetailMemberMarkSchema.extend({ testIndex: indexSchema, testId: z.string().min(1).optional() }).strict(),
    basis: MarkPreviewBasisSchema,
  }).strict().superRefine((value, ctx) => {
    if (value.basis.priorMarkOrdinal !== value.prior.ordinal) {
      ctx.addIssue({ code: 'custom', path: ['basis', 'priorMarkOrdinal'], message: 'an identical repeat is computed against its prior mark' })
    }
  }),
  markRunNotFoundArm,
  markMemberNotFoundArm,
  markStepNotFoundArm,
  markAmbiguousAddressArm,
])
export type RunsMarkPreviewResult = z.infer<typeof RunsMarkPreviewResultSchema>
const _previewOutcomesCover: ExactlyEqual<(typeof MARK_PREVIEW_OUTCOMES)[number], RunsMarkPreviewResult['kind']> = true
void _previewOutcomesCover
const _previewRefusalsAreMarkOutcomes: ExactlyEqual<
  Extract<RunsMarkPreviewResult, { kind: (typeof MARK_PREVIEW_REFUSALS)[number] }>,
  Extract<RunsMarkOutcome, { kind: (typeof MARK_PREVIEW_REFUSALS)[number] }>> = true
void _previewRefusalsAreMarkOutcomes

/** One ledger receipt with the records its applied knowledge fix changed, as the host read them. */
export interface MarkHistoryReadEntry {
  receipt: MarkReceipt
  changedRecords?: readonly MarkHistoryChangedRecord[]
}

export type MarkHistoryRead =
  | { kind: 'history'; entries: readonly MarkHistoryReadEntry[] }
  | { kind: 'run-not-found' }
  | { kind: 'ledger-corrupt'; line: number }
  | { kind: 'ledger-unavailable' }

/**
 * Read-only feedback observations. Separate from {@link FeedbackPort} so a host can grant history
 * without the mark writer; implementations never take the ledger lock, reap or write.
 */
export interface FeedbackReadsPort {
  history(runId: RunId): Promise<MarkHistoryRead>
  /**
   * 423 D-16: runs.mark's deterministic plan for this exact input, stopping before any intent,
   * lease, model call, id mint or write. Optional until a host implements it (423-19); a
   * feedbackReads binding without it leaves runs.mark.preview unbound by name.
   */
  preview?(input: RunsMarkInput): Promise<RunsMarkPreviewResult>
}
