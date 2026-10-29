// Every registry op is chat-reachable, so these inputs come from untrusted callers and stay strict.

import { z } from 'zod'

import { AuthoringFunnelSchema } from '../authoring/funnel'
import {
  DraftReceiptSchema,
  DraftRefSchema,
  TestFileWriteSchema,
  WrittenTestReceiptSchema,
} from '../authoring/draft-receipt'
import { FanOutReportSchema } from '../authoring/fan-out'
import { PatchOpSchema } from '../authoring/patch-ops'
import { RunEvidenceRefSchema } from '../authoring/proposal-arms'
import type { ScopeTier } from '../identity/scope-key'

export const AuthoringVerifyDraftInputSchema = z.object({
  /** Path to the draft test file to evaluate. Resolved and boundary-checked at the invoke. */
  draftPath: z.string().min(1),
  // Draft mode forces the disposition to `unverified`; `false` is refused, not read as absent.
  draftMode: z.literal(true).optional(),
  /**
   * The invoking session, carried to the receipt this evaluation mints.
   *
   * Optional and never defaulted, under {@link DraftReceiptSchema}'s own absence-is-exclusion rule
   * — see the field's doc there for why a defaulted ref is the one shape that misattributes.
   */
  sessionRef: z.string().min(1).optional(),
  // Absent means the draft's own file; the loop passes the suite the draft would join.
  targetSuitePath: z.string().min(1).optional(),
}).strict()

export type AuthoringVerifyDraftInput = z.infer<typeof AuthoringVerifyDraftInputSchema>

export const AuthoringVerifyDraftOutputSchema = DraftReceiptSchema

export type AuthoringVerifyDraftOutput = z.infer<typeof AuthoringVerifyDraftOutputSchema>

/**
 * The scope the brief is read at and the draft is authored for.
 *
 * A module-private schema on the `functions/runs.ts` and `functions/knowledge.ts` idiom — each
 * file that has to validate a scope keeps its own, because there is no exported `ScopeKeySchema`
 * in this package and minting one now would publish a fourth spelling of a two-field object three
 * files already validate identically.
 */
const scopeKeySchema = z.object({
  tier: z.enum(['global', 'product', 'suite', 'test'] satisfies readonly ScopeTier[]),
  key: z.string().min(1),
}).strict()

// `refused` means already covered, `repaired` passed after repair, `stopped` ends on the stop arm.
export const AUTHORING_LOOP_OUTCOMES = [
  'drafted',
  'refused',
  'repaired',
  'stopped',
] as const

export type AuthoringLoopOutcomeKind = (typeof AUTHORING_LOOP_OUTCOMES)[number]

// Lives in schema because the op output validates it and chat renders it.
export const AUTHORING_DEDUP_CONTINUATIONS = [
  'extend-that-test',
  'name-the-differing-assertion',
] as const

export type AuthoringDedupContinuation = (typeof AUTHORING_DEDUP_CONTINUATIONS)[number]

// `matchedRef` is `<filePath>::<testName>` for `entities.resolve`, never a `TST` short ID.
export const AuthoringDedupRefusalSchema = z.object({
  /** Workspace-relative path of the suite test the intent duplicates. */
  filePath: z.string().min(1),
  /** That test's display name — identity half two, never `testId`. */
  testName: z.string().min(1),
  /** The `entities.resolve` reference for it, in one spelling. */
  matchedRef: z.string().min(1),
  /** Token-set similarity, in [0,1]. */
  score: z.number().min(0).max(1),
  /** The pinned value it met or exceeded. */
  threshold: z.number().min(0).max(1),
  /** How many normalized tokens the intent and that test share — the score's numerator. */
  sharedTokens: z.number().int().min(0),
  /** How many suite tests were screened. The universe is the suite, not a covered subset. */
  comparedTests: z.number().int().min(0),
  /** Both continuations, always — see the vocabulary's own doc block. */
  continuations: z.array(z.enum(AUTHORING_DEDUP_CONTINUATIONS)).length(2),
}).strict()

export type AuthoringDedupRefusal = z.infer<typeof AuthoringDedupRefusalSchema>

export const AUTHORING_STATED_VALUE_STAGES = ['compile', 'keep'] as const

export type AuthoringStatedValueStage = (typeof AUTHORING_STATED_VALUE_STAGES)[number]

// It names the stage and the request's missing values, never draft or model text.
export const AuthoringStatedValueRefusalSchema = z.object({
  stage: z.enum(AUTHORING_STATED_VALUE_STAGES),
  missingValues: z.array(z.string().min(1)).min(1),
}).strict()

export type AuthoringStatedValueRefusal = z.infer<typeof AuthoringStatedValueRefusalSchema>

// Mirrors the router's `RouterStopSignalClass`; `loop.test-d.ts` keeps the two equal by type.
export const AUTHORING_STOP_SIGNAL_CLASSES = [
  'clean-definitive-assertion-fail',
  'mixed-evidence',
  'indefinitive-failure',
] as const

export type AuthoringStopSignalClass = (typeof AUTHORING_STOP_SIGNAL_CLASSES)[number]

export const AUTHORING_REPAIR_ABANDONMENTS = ['exhausted', 'prefix-regressed'] as const

export type AuthoringRepairAbandonment = (typeof AUTHORING_REPAIR_ABANDONMENTS)[number]

// `runId` sits on the payload, so a null failure point still names the run.
export const AuthoringStopFailurePointSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  /** Pre-interpolation step text — post-interpolation text can carry resolved secrets. */
  stepText: z.string(),
  /** The verifier's own reasoning for saying no. */
  reasoning: z.string(),
  /**
   * Which path produced the verdict. A free string rather than an enum: the run's own
   * `VerdictSource` vocabulary is owned by the handoff schema and grows there, and a second closed
   * copy here would refuse to report a real stop because the verdict came through a path this file
   * had not heard of.
   */
  verdictSource: z.string().min(1).optional(),
}).strict()

export type AuthoringStopFailurePoint = z.infer<typeof AuthoringStopFailurePointSchema>

// `repairAbandonment` and `repairIterations` come as a pair; no field holds model text.
export const AuthoringStopSchema = z.object({
  /** The LAST gate run on the receipt — the run stage 5 routed on. */
  runId: z.string().min(1),
  memberOutcome: z.string().min(1),
  /** The router's reading: which of the three stop classes this evidence was. */
  signalClass: z.enum(AUTHORING_STOP_SIGNAL_CLASSES),
  /** Null when the member failed at the member level with no step verdict to point at. */
  failurePoint: AuthoringStopFailurePointSchema.nullable(),
  /** Coordinates into the run's own durable records. Never a payload. */
  evidenceRefs: z.array(RunEvidenceRefSchema).readonly(),
  /** Present exactly with `repairIterations` — how a bounded repair gave up before this stop. */
  repairAbandonment: z.enum(AUTHORING_REPAIR_ABANDONMENTS).optional(),
  /**
   * Present exactly with `repairAbandonment` — `RepairOutcome.iterations`, INCLUDING iterations a
   * fence refused, which started nothing and are therefore not derivable from `fanOut`'s run ids.
   */
  repairIterations: z.number().int().min(0).optional(),
}).strict()

export type AuthoringStop = z.infer<typeof AuthoringStopSchema>

// `intent` is untrusted text that reaches a model; the parser checks the draft before any write.
export const AuthoringDraftWriteInputSchema = z.object({
  /** Plain-English description of the test to author. */
  intent: z.string().min(1),
  // The `.describe()` reaches the catalog, `init --agent` and MCP; match `HOST_DERIVES_SCOPE`.
  scope: scopeKeySchema.optional().describe(
    'Which product this test is authored for — the target key, e.g. `automation-exercise`. '
    + "In chat the planner fills this from the person's own words: a request that names the page, "
    + 'product or site it is for supplies the scope, and nothing needs to be typed. Calling '
    + '`/fn authoring.draft.write` directly, pass it explicitly — `{"scope":{"tier":"product",'
    + '"key":"<target>"}}` — whenever this project scaffolds more than one target. When it is '
    + 'omitted the host derives it ONLY where the project has exactly one candidate product; '
    + 'otherwise the call returns a typed refusal that names every candidate so you can choose '
    + 'one. It never guesses at a product, because authoring against a guessed product writes a '
    + 'test for the wrong application.',
  ),
  /**
   * Draft mode: the stability gate runs ONCE instead of the pinned N.
   *
   * Handed straight through to `authoring.draft.verify`, marker idiom and consequences intact —
   * a draft-mode evaluation's disposition is forced to `unverified`, so nothing authored this way
   * can be auto-kept. `z.literal(true)` for the same reason it is there: `false` is a refusal, not
   * a second spelling of absence.
   */
  draftMode: z.literal(true).optional(),
  /**
   * The invoking session, threaded to every receipt this invocation mints — the loop's own and the
   * one a repaired candidate earns.
   *
   * Optional and never defaulted, under {@link DraftReceiptSchema}'s absence-is-exclusion rule; a
   * session-owning surface stamps it at the invoke and a CLI supplies nothing.
   */
  sessionRef: z.string().min(1).optional(),
}).strict()

export type AuthoringDraftWriteInput = z.infer<typeof AuthoringDraftWriteInputSchema>

// `draftRef` and `receipt` are absent only on `refused`, which ends before a draft is compiled.
export const AuthoringDraftWriteOutputSchema = z.object({
  draftRef: DraftRefSchema.optional(),
  receipt: DraftReceiptSchema.optional(),
  outcome: z.enum(AUTHORING_LOOP_OUTCOMES),
  /**
   * Present exactly on a stage-2 `refused` invocation. See {@link AuthoringDedupRefusalSchema}
   * for why this one payload arm exists where the paragraph above rules the others out.
   */
  refusal: AuthoringDedupRefusalSchema.optional(),
  statedValueRefusal: AuthoringStatedValueRefusalSchema.optional(),
  // Present exactly on `stopped`.
  stop: AuthoringStopSchema.optional(),
  /**
   * What this invocation previewed, beside what it actually spent.
   *
   * REQUIRED ON EVERY ARM, unlike `draftRef` and `receipt`. Those two are absent because a stage-2
   * refusal genuinely has neither. Cost is different in kind: "this invocation ran nothing" is a
   * true and useful answer, and `buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] })`
   * is what the loop already answers with on that arm. An OPTIONAL field would make absent and
   * zero indistinguishable at a caller — "nobody counted" and "nothing ran" read the same — which
   * is the one ambiguity a disclosure may not have.
   */
  fanOut: FanOutReportSchema,
  // Present exactly on `drafted` and `repaired`; a rejected final draft is reported as not written.
  written: WrittenTestReceiptSchema.optional(),
}).strict().superRefine((output, ctx) => {
  // Only producers parse this schema, so the presence rules never refuse a stored record.
  const writes = output.outcome === 'drafted' || output.outcome === 'repaired'
  if (writes !== (output.written !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['written'],
      message: 'the written-test receipt is present exactly on a drafted or repaired invocation',
    })
  }
  if (output.written !== undefined && output.receipt !== undefined
    && output.written.disposition !== output.receipt.disposition) {
    ctx.addIssue({
      code: 'custom',
      path: ['written', 'disposition'],
      message: 'the written-test receipt carries the disposition of the receipt beside it',
    })
  }
  if (output.statedValueRefusal !== undefined && output.outcome !== 'refused') {
    ctx.addIssue({
      code: 'custom',
      path: ['statedValueRefusal'],
      message: 'the stated-value refusal is present only on a refused invocation',
    })
  }
  if (output.statedValueRefusal !== undefined && output.refusal !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['statedValueRefusal'],
      message: 'the stated-value refusal never rides beside the duplicate refusal',
    })
  }
  if (output.outcome === 'refused' && output.statedValueRefusal === undefined
    && output.refusal === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['refusal'],
      message: 'a refused invocation carries the duplicate refusal or the stated-value refusal',
    })
  }
})

export type AuthoringDraftWriteOutput = z.infer<typeof AuthoringDraftWriteOutputSchema>

// The op sees no caller session, so the session arm carries its ref; chat fills it in.
export const AuthoringFunnelWindowSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('session'),
    sessionRef: z.string().min(1),
  }).strict(),
  z.object({ scope: z.literal('all-time') }).strict(),
  z.object({
    scope: z.literal('last-n'),
    /** The N most recently EVALUATED drafts, newest first by `evaluatedAt`. */
    n: z.number().int().positive(),
  }).strict(),
])

export type AuthoringFunnelWindow = z.infer<typeof AuthoringFunnelWindowSchema>

export const AuthoringFunnelGetInputSchema = z.object({
  // This `scope` is a span of history, not a product; the planner is told the host stamps `window`.
  window: AuthoringFunnelWindowSchema.describe(
    'Which drafts to count — a span of history, NOT a product. `{"scope":"session","sessionRef":'
    + '"<id>"}` counts only what this conversation authored; `{"scope":"all-time"}` counts every '
    + 'draft this workspace has evaluated; `{"scope":"last-n","n":<count>}` counts the N most '
    + 'recently evaluated, newest first. In chat you never type this: the session supplies its own '
    + 'window, and asking about the current conversation is the default. Do not confuse it with '
    + '`authoring.draft.write`\'s `scope`, which names the product a test is authored for.',
  ),
}).strict()

export type AuthoringFunnelGetInput = z.infer<typeof AuthoringFunnelGetInputSchema>

/**
 * The op answers the ONE computation's result, unchanged — see `authoring/funnel.ts`.
 *
 * Not a summary of it and not a re-shaping: the op re-derives nothing, so the contract IS the
 * DTO the derivation produces. The window is deliberately NOT echoed back; a caller knows what it
 * asked, and echoing it would invite a surface to render the scope off the answer rather than off
 * the request, which is two sources for one fact.
 */
export const AuthoringFunnelGetOutputSchema = AuthoringFunnelSchema

export type AuthoringFunnelGetOutput = z.infer<typeof AuthoringFunnelGetOutputSchema>

// `testRef` takes `<filePath>::<testName>` or free text; the string decides which, not the caller.
export const AuthoringDraftEditInputSchema = z.object({
  /** The test to edit: `<filePath>::<testName>`, or a name to resolve. Never guessed at. */
  testRef: z.string().min(1),
  /** Plain-English description of the change. */
  intent: z.string().min(1),
}).strict()

export type AuthoringDraftEditInput = z.infer<typeof AuthoringDraftEditInputSchema>

export const AuthoringDraftEditOutputSchema = z.object({
  // Points at the written file, or at the shelf copy when the write did not land (see `written`).
  draftRef: DraftRefSchema,
  /** The committed test this edit was applied to, as the binder resolved it. */
  editedFrom: z.object({
    filePath: z.string().min(1),
    testName: z.string().min(1),
    boundBy: z.enum(['exact-ref', 'resolver']),
  }).strict(),
  /** The RFC-6902 ops that were applied — the diff. See the contract's doc block. */
  patches: z.array(PatchOpSchema),
  /** The model's own account of the change, stored as prose so nothing downstream parses it. */
  thoughts: z.string(),
  // Written only over the exact bytes it read; a changed or moved file is not written.
  written: TestFileWriteSchema,
}).strict()

export type AuthoringDraftEditOutput = z.infer<typeof AuthoringDraftEditOutputSchema>
