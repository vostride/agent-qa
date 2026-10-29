// Refs to runs, never run payloads, secrets or interpolated step text; every object is strict.

import { z } from 'zod'

import { DRAFT_DISPOSITIONS, draftDispositionWritesTarget, singleRunGatesPass } from './disposition'
import type { DraftGateBooleans } from './disposition'

/**
 * Bumping this is a breaking change to a durable store. The record schema pins the literal, so
 * a receipt written by an earlier build fails loudly at read time instead of being silently
 * reinterpreted under the new shape (the house stamp-and-hard-fail convention).
 */
export const CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION = 2

/**
 * Which draft this receipt is about.
 *
 * `filePath` + `testName` is the STABLE identity the suite comparison keys on — the ratified
 * project-wide rule, never `testId`. `testId` is carried anyway because it is what
 * `parseTestFile` mints for the draft and what the run's own evidence cites, so a reader
 * tracing a receipt back to a handoff needs it; it is provenance, not identity.
 */
export const DraftRefSchema = z.object({
  filePath: z.string().min(1),
  testId: z.string().min(1),
  testName: z.string().min(1),
  /** Digest of the draft bytes evaluated, so a later edit cannot inherit this receipt. */
  contentDigest: z.string().min(1),
}).strict()

export type DraftRef = z.infer<typeof DraftRefSchema>

// Lands verbatim, so a rejected author can read which step was classified how.
export const StepClassificationRowSchema = z.object({
  /** Pre-interpolation step text. Post-interpolation text can carry resolved secrets. */
  stepText: z.string(),
  role: z.enum(['assertion', 'action']),
  // References concrete expected content; always false for actions.
  falsifiable: z.boolean(),
  /** The vacuity-lexicon phrase this step matched, named so the author can see the term. */
  vacuityHit: z.string().optional(),
  /** Capture-signature pattern names hit by this step's expected value. */
  captureSignatureHits: z.array(z.string()),
  // The assertion restates a prior action's own content.
  tautologyHit: z.boolean().optional(),
}).strict()

export type StepClassificationRow = z.infer<typeof StepClassificationRowSchema>

// `healed` is kept apart from `definitive`: a healed run counts as a pass for gate 1.
export const GateRunRecordSchema = z.object({
  /** A ref into the run store. Deliberately not the run's contents. */
  runId: z.string().min(1),
  // The draft's own member outcome, not the aggregate verdict.
  memberOutcome: z.string().min(1),
  definitive: z.boolean(),
  healed: z.boolean(),
  /** Why this run was judged definitive or not — the F1 escape hatch. */
  reason: z.string().optional(),
}).strict()

export type GateRunRecord = z.infer<typeof GateRunRecordSchema>

// An evidence-less suite test falls back to text similarity, which over-flags toward covered.
export const AddsValueFindingSchema = z.object({
  // Named, not counted: no similarity threshold exists, so the receipt shows the elements.
  novelElements: z.array(z.string()),
  comparedTests: z.array(z.object({
    filePath: z.string().min(1),
    testName: z.string().min(1),
    lane: z.enum(['fingerprint', 'text']),
    covered: z.boolean(),
  }).strict()),
}).strict()

export type AddsValueFinding = z.infer<typeof AddsValueFindingSchema>

// All four gates are always evaluated; rich tables live once, at the receipt level.
export const DraftGateResultsSchema = z.object({
  // A recorded termination makes even a `failed` member indefinitive; read it as the run answered.
  executesDefinitive: z.object({
    pass: z.boolean(),
    /** Refs into `gateRuns`. */
    runRefs: z.array(z.string()),
    /** The subset judged indefinitive, so "why did gate 1 fail" is answerable per run. */
    indefinitiveRunRefs: z.array(z.string()),
    reason: z.string().optional(),
  }).strict(),
  /** Gate 2: the member outcome did not flip across the completed runs. */
  stableVerdict: z.object({
    pass: z.boolean(),
    runRefs: z.array(z.string()),
    /** Distinct member outcomes observed; length > 1 is the flip. */
    distinctOutcomes: z.array(z.string()),
    // True when early-stop fired, which is why a completed count may be below N.
    earlyStopped: z.boolean(),
    reason: z.string().optional(),
  }).strict(),
  /** Gate 3: set semantics over anchor elements, no threshold. */
  addsValue: z.object({
    pass: z.boolean(),
    novelElementCount: z.number().int().nonnegative(),
    comparedTestCount: z.number().int().nonnegative(),
    reason: z.string().optional(),
  }).strict(),
  /** Gate 4: the deterministic two-clause lexical check. */
  falsifiableAssertion: z.object({
    pass: z.boolean(),
    /** Clause (i): steps that classified as assertions at all. */
    assertionStepCount: z.number().int().nonnegative(),
    /** Clause (ii): of those, how many reference concrete expected content. */
    falsifiableAssertionCount: z.number().int().nonnegative(),
    reason: z.string().optional(),
  }).strict(),
}).strict()

export type DraftGateResults = z.infer<typeof DraftGateResultsSchema>

/** The gate names as a value, so a composition root can iterate them and a test can pin closure. */
export const DRAFT_GATE_NAMES = [
  'executesDefinitive',
  'stableVerdict',
  'addsValue',
  'falsifiableAssertion',
] as const

export type DraftGateName = (typeof DRAFT_GATE_NAMES)[number]

// Stored, not recomputed, so a later change to N never rewrites decisions already given.
export const DraftReceiptSchema = z.object({
  schemaVersion: z.literal(CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION),
  draftRef: DraftRefSchema,
  gates: DraftGateResultsSchema,
  stepTable: z.array(StepClassificationRowSchema),
  gateRuns: z.array(GateRunRecordSchema),
  addsValueFinding: AddsValueFindingSchema,
  stabilityRunsRequested: z.number().int().nonnegative(),
  stabilityRunsCompleted: z.number().int().nonnegative(),
  disposition: z.enum(DRAFT_DISPOSITIONS),
  /** Epoch milliseconds. */
  evaluatedAt: z.number().int().nonnegative(),
  // Absent excludes a receipt from session windows; it is never defaulted to the asking session.
  sessionRef: z.string().min(1).optional(),
}).strict()

export type DraftReceipt = z.infer<typeof DraftReceiptSchema>

/** The four gate booleans on their own, as a written-test receipt carries them. */
export const DraftGateBooleansSchema = z.object({
  executesDefinitive: z.boolean(),
  stableVerdict: z.boolean(),
  addsValue: z.boolean(),
  falsifiableAssertion: z.boolean(),
}).strict()

/** The four booleans off a receipt's gate results, one per gate. */
export function draftGateBooleans(gates: DraftGateResults): DraftGateBooleans {
  return {
    executesDefinitive: gates.executesDefinitive.pass,
    stableVerdict: gates.stableVerdict.pass,
    addsValue: gates.addsValue.pass,
    falsifiableAssertion: gates.falsifiableAssertion.pass,
  }
}

/**
 * Why a writer left the target alone. `target-changed` covers both a new test whose path is now
 * taken and an edit whose file no longer holds the bytes it was built from.
 */
export const TEST_FILE_WRITE_REFUSALS = [
  'outside-workspace',
  'target-changed',
  'write-failed',
] as const

/** Why no bytes reached the target: the gates rejected the draft, or the writer refused. */
export const TEST_FILE_NOT_WRITTEN_REASONS = ['rejected', ...TEST_FILE_WRITE_REFUSALS] as const

/**
 * What happened at one test file: written (workspace-relative path and the digest of the exact
 * bytes written), or not written with the reason. A failed write is never reported as written.
 */
export const TestFileWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('written'),
    filePath: z.string().min(1),
    contentDigest: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('not-written'),
    targetPath: z.string().min(1),
    reason: z.enum(TEST_FILE_NOT_WRITTEN_REASONS),
    /** The writer's own error text for `write-failed`; absent otherwise. */
    detail: z.string().optional(),
  }).strict(),
])

export type TestFileWrite = z.infer<typeof TestFileWriteSchema>

// A `rejected` disposition and a `rejected` not-written reason come together or not at all.
export const WrittenTestReceiptSchema = z.object({
  file: TestFileWriteSchema,
  disposition: z.enum(DRAFT_DISPOSITIONS),
  gates: DraftGateBooleansSchema,
}).strict().superRefine((receipt, ctx) => {
  if (receipt.file.kind === 'written' && !draftDispositionWritesTarget(receipt.disposition)) {
    ctx.addIssue({
      code: 'custom',
      path: ['file'],
      message: `a ${receipt.disposition} draft is never written`,
    })
  }
  // An `unverified` draft passed gates 1, 3 and 4; only producers parse this, not stored records.
  if (receipt.disposition === 'unverified' && !singleRunGatesPass(receipt.gates)) {
    ctx.addIssue({
      code: 'custom',
      path: ['disposition'],
      message: 'an unverified draft passed every gate one run decides; one that did not is rejected',
    })
  }
  const rejectedReason = receipt.file.kind === 'not-written' && receipt.file.reason === 'rejected'
  if (rejectedReason !== (receipt.disposition === 'rejected')) {
    ctx.addIssue({
      code: 'custom',
      path: ['file', 'reason'],
      message: 'only a rejected disposition leaves its draft unwritten as rejected',
    })
  }
})

export type WrittenTestReceipt = z.infer<typeof WrittenTestReceiptSchema>
