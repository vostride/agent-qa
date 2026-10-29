// The draft receipt: what a keep-gate evaluation durably says about one draft (393, WTST-02).
//
// Two shape rules govern everything below.
//
// MAP, NOT TERRITORY. The receipt carries REFS to the runs it judged plus
// the findings it derived — never run payloads, never resolved secrets, never post-interpolation
// step text. Run bytes live in the run store, which is the only place that owns them. Every
// object here is `.strict()`, so smuggling a payload in is a typed refusal rather than a field
// nobody notices until it shows up in a durable file.
//
// KEYED, NOT POSITIONAL. `DraftGateResultsSchema` names its gates, so a later gate can join
// without re-minting this DTO or renumbering anything a 394 consumer already reads.
// the bug-repro anchoring gate that was to join here left with the
// Issue-slot cleanup.

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

/**
 * One parsed NL step, as gate 4's deterministic check classified it.
 *
 * Lands VERBATIM in the receipt: D-12 tunes ambiguity toward reject, which is only defensible
 * if the rejected author can read exactly which step was called what and why.
 */
export const StepClassificationRowSchema = z.object({
  /** Pre-interpolation step text. Post-interpolation text can carry resolved secrets. */
  stepText: z.string(),
  role: z.enum(['assertion', 'action']),
  /** Clause (ii) of D-09: references concrete expected content. Always false for actions. */
  falsifiable: z.boolean(),
  /** The vacuity-lexicon phrase this step matched, named so the author can see the term. */
  vacuityHit: z.string().optional(),
  /** Capture-signature pattern names hit by this step's expected value. */
  captureSignatureHits: z.array(z.string()),
  /** D-10 tautology detection: the assertion restates a prior action's own content. */
  tautologyHit: z.boolean().optional(),
}).strict()

export type StepClassificationRow = z.infer<typeof StepClassificationRowSchema>

/**
 * One stability run, as a REF plus the judgment made about it.
 *
 * `healed` is separable from `definitive` and from `memberOutcome` on purpose. Measured on the
 * frozen corpus (393-01, F3): the definitive-pass arm arrives as `healed`, not `passed` — the
 * accept control itself heals. A gate 1 that does not count a healed pass as a pass fails the
 * one draft it exists to accept. Recording the heal separately lets gate 1 count it as a pass
 * while 394 still reads the heal as the weak-grounding signal it is.
 *
 * `definitive` is a judgment, not a field copy. 393-01's F1 measured that
 * `termination.kind === 'infeasible'` does NOT separate gate 1 from gate 2 on this build — 19
 * of 21 failed members carry one — so no single terminal field decides definitiveness, and
 * `reason` is where the evaluator says what it actually read.
 */
export const GateRunRecordSchema = z.object({
  /** A ref into the run store. Deliberately not the run's contents. */
  runId: z.string().min(1),
  /** The draft's own MEMBER outcome, not the aggregate verdict. */
  memberOutcome: z.string().min(1),
  definitive: z.boolean(),
  healed: z.boolean(),
  /** Why this run was judged definitive or not — the F1 escape hatch. */
  reason: z.string().optional(),
}).strict()

export type GateRunRecord = z.infer<typeof GateRunRecordSchema>

/**
 * Gate 3's finding: which suite tests were compared, in which lane, and what was novel.
 *
 * `lane` is D-16's per-test disclosure. A suite test with run evidence is compared by anchor
 * fingerprint; an evidence-less one falls back to title/step-text similarity and over-flags
 * toward "covered" (the safe direction). Reporting the lane per test is what stops a
 * fingerprint-lane claim from being read into a text-lane guess.
 */
export const AddsValueFindingSchema = z.object({
  /**
   * Fingerprint elements absent from the suite union — NAMED, not counted. No
   * similarity threshold exists to defend, so the receipt shows the elements themselves.
   */
  novelElements: z.array(z.string()),
  comparedTests: z.array(z.object({
    filePath: z.string().min(1),
    testName: z.string().min(1),
    lane: z.enum(['fingerprint', 'text']),
    covered: z.boolean(),
  }).strict()),
}).strict()

export type AddsValueFinding = z.infer<typeof AddsValueFindingSchema>

/**
 * The four gate results, keyed by name (D-04: all four always evaluated, never short-circuited).
 *
 * Each carries `pass` plus a lean evidence sub-shape: counts and refs, with the rich tables
 * living once at the receipt level. Duplicating the tables inside each gate would create a
 * second answer to the same question, which is exactly what one-exported-vocabulary forbids.
 */
export const DraftGateResultsSchema = z.object({
  /**
   * Gate 1: every run reached a DEFINITIVE verdict about the draft.
   *
   * THE ENFORCED RULE, as `stability-gates.ts` classifies it (393-09, WR-04 doc arm). The member
   * outcome must be `passed`, `failed` or `healed` — a healed pass IS a pass (393-01 F3) — AND no
   * step may carry a planning failure, a cycle flag, or ANY recorded termination. That last
   * conjunct is the one this doc used to omit: a `failed` member whose step evidence records a
   * termination is classified indefinitive, and the phase's survey of the demo run store found
   * 9 of 9 failed members carrying one. So on current builds a definitive verdict is effectively
   * a passing one — healed or clean — rather than the symmetric pass-or-fail this doc promised.
   * D-17's `error` class has no enum member here (`RunStatus` is
   * `passed | failed | healed | timeout | cancelled`); it arrives as a structural planning
   * failure or as a run record that cannot be read back at all.
   *
   * The app-broken branch — a draft that fails because the APPLICATION is wrong — is therefore
   * not a keep on this gate; it ends the invocation as a reported stop — the gate run's verdict on
   * the op result, the draft retained on the shelf (411). Read this field as "the run answered",
   * never as "a failing draft can be kept".
   */
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
    /** True when D-17's early-stop fired — the reason a completed count may be below N. */
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

/**
 * The durable receipt. The op returns this AND persists it.
 *
 * `disposition` is the value `computeDraftDisposition` produced for this receipt's own gates
 * and counts. It is stored rather than recomputed at read time so the answer a consumer sees
 * is the answer that was actually given — a later retune of N must not silently rewrite the
 * history of decisions taken under the old one.
 */
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
  /**
   * The invoking session, as an OPAQUE string the caller supplied.
   *
   * OPTIONAL AT THE CURRENT VERSION, AND THE VERSION IS DELIBERATELY NOT BUMPED. `parseReceipt`
   * throws `DraftReceiptSchemaVersionError` on any mismatch, so a bump would make `list()` throw
   * on every receipt already on a developer's or a CI runner's disk — which is precisely how a
   * funnel READ op becomes a crash. Optional-at-version-1 is the additive shape a stamp-and-
   * hard-fail store can actually absorb.
   *
   * ABSENCE IS EXCLUSION, NEVER A DEFAULT. A session-scoped funnel window compares this by exact
   * string equality; a receipt carrying no ref is left OUT rather than folded into whichever
   * session happens to be asking. Defaulting it in would attribute another session's drafts —
   * and, in the direction that matters, would inflate `built` under somebody else's keep rate.
   */
  sessionRef: z.string().min(1).optional(),
}).strict()

export type DraftReceipt = z.infer<typeof DraftReceiptSchema>

// ---- the written test ----------------------------------------------------------
//
// A final draft is written straight to its test path unless its gates rejected it. What the
// author is told is which file was written — or why none was — beside how well the draft was
// verified: the disposition and the four gate booleans, never collapsed into one verdict.

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

/**
 * The written-test receipt: the file, the disposition and the four gate booleans.
 *
 * A `rejected` disposition and a `rejected` not-written reason come together or not at all, and a
 * written file never carries a rejected disposition.
 */
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
  // an unverified draft is a draft-mode draft whose gates 1,
  // 3 and 4 passed; one of them false is a rejection. Producer-parsed only: nothing persists this
  // receipt, so the refinement reads no stored record.
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
