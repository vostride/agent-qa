// The `authoring.draft.verify` op contract (393, D-01).
//
// D-01 sketches the verb as `authoring.verify_draft`; that spelling is unrepresentable — the
// parity taxonomy regex forbids underscores and the chat tool-name mapping refuses one.
// The schema symbols keep the sketch's camel-case spelling; the dispatchable id does not.
//
// The planner binds ALL registry ops 1:1, so this op is chat-reachable the moment
// it registers — its input is crossing a trust boundary from an arbitrary caller, not being
// handed over between two halves of the same program. `.strict()` plus a non-empty path is
// therefore the refusal surface, not a formality. Path-boundary enforcement (is this draft
// inside the workspace at all?) belongs at the op invoke where the resolved config exists;
// this schema's job is to make sure the invoke is never handed a shape it must guess about.

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
  /**
   * Draft mode: run the stability gate ONCE instead of the pinned N.
   *
   * D-18 makes this consequential rather than a speed knob — a draft-mode evaluation's
   * disposition is forced to `unverified` unconditionally, so nothing evaluated this way can
   * be auto-kept no matter how its four booleans read. Only the literal marker is accepted,
   * matching the `gateRun` / `excludedFromOutcomes` carrier idiom: `false` is a refusal, not a
   * synonym for absence, so a caller cannot half-express the intent.
   */
  draftMode: z.literal(true).optional(),
  /**
   * The invoking session, carried to the receipt this evaluation mints.
   *
   * Optional and never defaulted, under {@link DraftReceiptSchema}'s own absence-is-exclusion rule
   * — see the field's doc there for why a defaulted ref is the one shape that misattributes.
   */
  sessionRef: z.string().min(1).optional(),
  /**
   * The suite file this draft proposes to JOIN — the stability read's target.
   *
   * ABSENT MEANS THE DRAFT'S OWN FILE, which is the right answer for a standalone verify: a
   * committed suite file IS its own target. It is a CHOSEN contract rather than a derivation
   * because on the loop path the draft sits on a one-test-per-file shelf, so a target derived from
   * `draftPath` can never have neighbours and D-14's `neighbours-flaky` arm was unreachable from
   * `authoring.draft.write` for that reason alone. Only the caller knows which suite a draft would
   * join; the loop computes it through the same `authoredSuiteTargetPath` its accept arm uses.
   */
  targetSuitePath: z.string().min(1).optional(),
}).strict()

export type AuthoringVerifyDraftInput = z.infer<typeof AuthoringVerifyDraftInputSchema>

/**
 * The op returns the receipt it persisted — the same bytes, not a summary of them, so a
 * caller never has to re-read the store to learn what was just decided.
 */
export const AuthoringVerifyDraftOutputSchema = DraftReceiptSchema

export type AuthoringVerifyDraftOutput = z.infer<typeof AuthoringVerifyDraftOutputSchema>

// ---- `authoring.draft.write`: the six-stage loop's one public entry (394, D-01 · WTST-01) ------

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

/**
 * How one loop invocation ended — the CLOSED vocabulary, declared whole in 394-02.
 *
 * All four members exist from the tracer onward and only `drafted` is reachable in it. That is
 * deliberate rather than premature: the loop is a six-stage pipeline whose stages land across
 * plans 04, 05 and 06, and a vocabulary that grew a member per plan would make each of those a
 * change to the SHAPE every consumer branches on — the op's output contract, 396's MCP
 * projection, 397's parity walk — instead of a new branch behind a discriminant they already
 * read. Declaring the whole set now costs one enum and buys three plans that add a case.
 *
 *   `drafted`  the draft was compiled, staged and verified; the receipt carries the verdict.
 *   `refused`  stage 2 found the intent already covered and ended the invocation.
 *   `repaired` stage 5 routed to bounded repair and a later iteration passed.
 *   `stopped`  stage 5 routed to the stop arm: the gate run's verdict rides this result's `stop`
 *              payload and the correctly-failing draft stays on the shelf with its receipt
 *
 * the proposal arm for a correctly-failing draft left with the Issue-slot
 * cleanup.
 */
export const AUTHORING_LOOP_OUTCOMES = [
  'drafted',
  'refused',
  'repaired',
  'stopped',
] as const

export type AuthoringLoopOutcomeKind = (typeof AUTHORING_LOOP_OUTCOMES)[number]

/**
 * The two continuations a dedup refusal offers — CLOSED, and minted here.
 *
 * It lives in `schema` rather than beside the lane that produces it because the op's output
 * validates it and chat renders it, and 384 D-16 puts a DTO's vocabulary where every surface
 * reading it can share one spelling. A second `as const` in `agent` would be the drift that law
 * exists to prevent, and would make "which continuation did an author take" — a question plan
 * 07's funnel asks — answerable two ways.
 *
 * TWO MEMBERS, and neither covers the other. An author whose intent really is the existing test
 * takes `extend-that-test`; an author whose intent is a DIFFERENT assertion about the same flow
 * has nothing to extend and takes `name-the-differing-assertion`, which is the honest question to
 * put to someone the screen may have over-flagged. Offering only the first would make an
 * over-flagging screen — the ratified safe direction — unappealable.
 */
export const AUTHORING_DEDUP_CONTINUATIONS = [
  'extend-that-test',
  'name-the-differing-assertion',
] as const

export type AuthoringDedupContinuation = (typeof AUTHORING_DEDUP_CONTINUATIONS)[number]

/**
 * What a stage-2 refusal NAMES.
 *
 * THE OUTPUT'S ONE PAYLOAD ARM, AND THE EXCEPTION IS PRINCIPLED. The output contract below states
 * that it carries no payload per outcome, because a draft's bytes are written to its test file and
 * named by `written`, and a second copy here would be a second place to read one artifact. A dedup
 * refusal has NO such home: nothing was authored, so there is no draft, no
 * receipt, no gate-run and no envelope, and D-04 makes the refusal a typed op RESULT that ends the
 * invocation and is rendered by chat. Omitting the payload would not avoid a second read path, it
 * would remove the only one — leaving a caller told `refused` with no way to learn what it
 * matched, which is precisely the refuse-and-LINK requirement.
 *
 * `matchedRef` is the reference a caller hands to `entities.resolve`, spelled
 * `<filePath>::<testName>`. It is deliberately NOT a `TST-###` short-ID: a short-ID exists only
 * once something has sighted the entity, sighting is what mints the permanent address, and no
 * `TST` sighting source is wired on any host in this build — so printing one would publish an
 * address that resolves to nothing (ENTY-01's never-guess law).
 *
 * `threshold` rides beside `score` because a refusal reporting 0.52 without saying what it was
 * compared against cannot tell an author whether their intent was borderline or identical.
 */
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

// names the stage and the request's own missing values, never draft or
// model text.
export const AuthoringStatedValueRefusalSchema = z.object({
  stage: z.enum(AUTHORING_STATED_VALUE_STAGES),
  missingValues: z.array(z.string().min(1)).min(1),
}).strict()

export type AuthoringStatedValueRefusal = z.infer<typeof AuthoringStatedValueRefusalSchema>

/**
 * The three classes the stop arm may carry — one definitive, two ambiguous.
 *
 * The schema spelling of the router's own `RouterStopSignalClass`. Two files, one vocabulary:
 * `loop.test-d.ts` pins the two equal by type so neither can drift from the other.
 */
export const AUTHORING_STOP_SIGNAL_CLASSES = [
  'clean-definitive-assertion-fail',
  'mixed-evidence',
  'indefinitive-failure',
] as const

export type AuthoringStopSignalClass = (typeof AUTHORING_STOP_SIGNAL_CLASSES)[number]

/** How a bounded repair gave up, in the repair lane's own two words. */
export const AUTHORING_REPAIR_ABANDONMENTS = ['exhausted', 'prefix-regressed'] as const

export type AuthoringRepairAbandonment = (typeof AUTHORING_REPAIR_ABANDONMENTS)[number]

/**
 * Where the failure was observed, in the run's own words.
 *
 * No `runId` here: it rides at the payload's top level so a NULL failure point still
 * names the run stage 5 routed on.
 */
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

/**
 * What a `stopped` invocation REPORTS — the gate run's verdict and the router's reading.
 *
 * NOTHING A MODEL WROTE IS ON IT. The payload is projected from the route the router derived and
 * from the receipt's own last gate run, both typed facts; there is no prose field for model output
 * to arrive through, which is the whole of "the model never makes this decision" expressed as a
 * shape rather than as an ordering. `.strict()` is the refusal surface for anything else.
 *
 * `repairAbandonment` AND `repairIterations` ARE PRESENT EXACTLY TOGETHER.
 * The loop carries the kind and the spend as ONE parameter and the op spreads both or neither, so
 * the two optionals here can never disagree — a kind with no spend, or a spend on a stop repair
 * never touched, are not states the loop can be in. They are two optionals rather than one nested
 * object for the reason the retired arm's were: a strict object with no effects, so the MCP
 * projection and the golden digest see a plain shape.
 */
export const AuthoringStopSchema = z.object({
  /** The LAST gate run on the receipt — the run stage 5 routed on. */
  runId: z.string().min(1),
  /** The draft's OWN member outcome, as the receipt's `GateRunRecord` spells it. */
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

/**
 * What a caller hands the loop.
 *
 * `.strict()` and a non-empty intent for the reason the verify input states above, and here the
 * argument is sharper: `intent` is free text from an arbitrary caller that reaches an LLM and then
 * becomes bytes on this workspace's disk. The refusal surface a schema can hold is the
 * shape and the emptiness; what the model produces is validated again, by the parser, before a
 * single byte is written.
 */
export const AuthoringDraftWriteInputSchema = z.object({
  /** Plain-English description of the test to author. */
  intent: z.string().min(1),
  /**
   * Which scope the authoring brief is read at, and the draft is authored for.
   *
   * OPTIONAL, and absent resolves from the host's configured targets and committed tests — the
   * `RunsStartInputSchema.scope` law one op over, applied here for the reason that op adopted it:
   * a model cannot know this project's product keys, and a required field it can only guess at is
   * a field it refuses the whole call over. A supplied scope always wins; the host
   * derives only on absence, and refuses by name rather than guessing when the answer is not
   * unique.
   *
   * THE `.describe()` BELOW IS THE HUMAN-FACING HALF, AND IT IS WHY IT IS A `.describe()` RATHER
   * THAN THIS DOC BLOCK. A JSDoc comment documents this field for whoever opens
   * this file; it reaches no reader of the product. The capability catalog is PRODUCED from the
   * declarations — `params` is the JSON-Schema projection of this very object — so a description
   * attached HERE is the single edit that documents `scope` on the surfaces that project `params`,
   * and a paragraph anywhere else is a paragraph the product never says.
   *
   * WHICH SURFACES THOSE ARE WAS MEASURED, NOT ASSUMED. An earlier version
   * of this block claimed `/help`, `explain` and the chat type-ahead were "all projections of that
   * ONE committed artifact". They are not, and the claim was measured FALSE: `/help` and the
   * type-ahead render `row.description` (the op summary) rather than `params`, and `explain`
   * deliberately withholds params from its prompt (`explain-port.ts:17`, D-10-sanctioned charter
   * design). They project a different FIELD of the same artifact. The surfaces this `.describe()`
   * actually reaches are the committed capability catalog row, `init --agent` and MCP
   * `tools/list`; a person finds the op itself through `agent-qa fn --list` or the committed
   * catalog. 2026-09-28: the dashboard's served catalog, the fourth surface in the D-19
   * letter RATIFIED on 2026-08-22, was deleted with its server door.
   * `packages/cli/src/__tests__/scope-doc-surfaces.test.ts` pins the committed leg and the served
   * leg's absence.
   * Projecting `params` into `/help` and the type-ahead stays open as a Rule-4 design question
   * it needs resolver-table surgery, not a wider sentence here.
   *
   * The 399 rehearsal measured what its absence costs: `/fn authoring.draft.write` ROUTES, meets
   * the confirm interactively, and then fails on `AuthoringScopeUnresolvableError` naming targets
   * the caller was never told they had to choose between — a field that is undocumented on every
   * surface a person reads is a field they can only learn about by being refused over it.
   *
   * IT DOES NOT RESTATE THE MODEL-FACING SENTENCE AND MUST NOT CONTRADICT IT.
   * `planner-tools.ts`'s `HOST_DERIVES_SCOPE` already tells the PLANNER who fills this field and
   * that the host never guesses; that sentence is load-bearing (it carries the 394-35 dist-gate
   * sentinel) and is untouched. This text says the same things in the same direction and adds the
   * half the planner has no use for: what a `/fn` caller typing JSON by hand has to pass.
   */
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

/**
 * What one loop invocation answers.
 *
 * The receipt is the WHOLE receipt the evaluator minted and persisted, not a summary of it — the
 * verify op's own rule, inherited because this op reaches that op rather than re-deciding
 * anything. `draftRef` is carried beside it even though the receipt already holds one, because it
 * is the answer to a different question: which draft this call produced, addressable without
 * knowing that a receipt is a thing that has a ref inside it.
 *
 * There is no payload arm per outcome. Since 432 the final draft is written to its test file
 * in the call, and `written` is that write's file record (which file, or why none), not its bytes;
 * a stop's verdict rides THIS result, because nothing is written for it — see `stop`
 * below.
 *
 * `fanOut` IS THE ONE RECORDED EXCEPTION: the preview-versus-spent disclosure.
 * WTST-08's owner decision was preview plus honest reporting with NO enforced budget, so the number
 * previewed and the number actually spent are both reported, and `exceedsPreview` says when the
 * second outran the first. It is counts, run REFERENCES and one boolean — no draft body, no receipt
 * payload and no step evidence. (2026-10-03: the dispatch confirm that showed the preview and the
 * proposal inbox this paragraph used to contrast it with are deleted in 432.)
 *
 * BOTH ARE OPTIONAL, AND `outcome` SAYS WHICH TO EXPECT. A `drafted`, `repaired` or `stopped`
 * invocation carries both; a `refused` one ends at
 * stage 2 with no draft compiled and therefore no receipt to mint. Requiring them
 * would have made plan 04's arrival a WIDENING of this op's output contract — the shape change the
 * whole-vocabulary-now discipline exists to avoid — and padding a refusal with an empty receipt
 * would be worse: a receipt is a durable record of gates that ran, and a synthetic one would be a
 * verdict about a draft that was never authored.
 */
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
  /**
   * Present exactly on a `stopped` invocation: the gate run's verdict, the router's
   * reading and the evidence coordinates — never a proposal of any class. Same rule as `refusal`:
   * `outcome` says which to expect.
   */
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
  /**
   * The final draft's written-test receipt: which file was written, or why none was,
   * with the disposition and the four gate booleans. Present exactly on `drafted` and `repaired`;
   * a `rejected` final draft is reported here as not written. Its disposition is the receipt's.
   */
  written: WrittenTestReceiptSchema.optional(),
}).strict().superRefine((output, ctx) => {
  // 2026-10-03 (quick 261003-cpv, 432 review IN-21): the two rules above, enforced. Producer-parsed
  // only (the op's output validation and the MCP projection); no stored record is read through it.
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

// ---- `authoring.funnel.get`: the honesty funnel's one read op (394, D-12/D-13 · WTST-05) -------

/**
 * The window a funnel is computed over — a CLOSED, DISCRIMINATED three-arm scope.
 *
 * IT IS A SCOPE, NOT A FILTER, and the distinction is why it exists where `quarantine.list`
 * deliberately has none. That op's header refuses a filter because "a filter here would make the
 * verb's answer depend on how it was asked" — a reader concern over rows already in hand. This
 * parameter does something different in kind: it selects WHICH INVOCATIONS the projection is over,
 * which is the projection's denominator rather than a predicate applied after it. A funnel with no
 * scope would be forced to answer all-time, and "how is this session doing" — D-12's stated
 * default and the question WTST-05 asks — would be unanswerable from any surface.
 *
 * THE SESSION ARM CARRIES THE REF, because the op cannot know it. `FunctionSpec.invoke` receives
 * `(input, deps)` and nothing else — no caller — and `FunctionDeps` holds no session. D-12's
 * "default scope = current session" is therefore a SURFACE default, honoured where the session is
 * actually known, never a schema default that would have to guess. A defaulted session ref is the
 * one shape that could quietly report a different session's drafts as this one's.
 *
 * CHAT IS THE SURFACE THAT CONSTRUCTS ONE. It stamps its own session onto the two
 * `sessionRef`-carrying authoring ops, so receipts are ATTRIBUTED; and at the same invoke it
 * supplies THIS window — the session arm by default when a planner step carries none, and the
 * session arm's REF overwritten when the model emitted one — which is D-12's surface default
 * honoured exactly where the session is known. The all-time and last-n arms pass through
 * untouched. The CLI has no session, so it constructs nothing and asks all-time, which is the
 * honest answer for a caller that has none.
 *
 * `sessionRef` is compared by EXACT STRING EQUALITY and is opaque here: this package mints no
 * session ids and parses none, so any host's spelling round-trips unexamined.
 */
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

/**
 * What a caller hands the funnel read. The window and nothing else.
 *
 * `.strict()` on the loop input's reasoning: 392 D-07 binds every registry op into the planner's
 * toolset, so this shape crosses a trust boundary from an arbitrary caller rather than being
 * handed between two halves of one program.
 */
export const AuthoringFunnelGetInputSchema = z.object({
  /**
   * ITS `scope` IS A HOMONYM, AND THAT IS EXACTLY WHY IT IS DOCUMENTED HERE.
   *
   * `authoring.draft.write.scope` names a PRODUCT to author for. This op's `window.scope` names a
   * SPAN OF HISTORY to count over — `session` / `all-time` / `last-n`. Two fields spelled the same
   * with nothing in common, sitting on two ops a person meets in the same breath. D-19's doc half
   * would have made that worse, not better, if this row had inherited the product-target sentence:
   * a catalog that documented this `scope` as "the target product" would be a produced artifact
   * confidently describing a capability the product does not have.
   *
   * AND THE HUMAN IS THE ONLY READER THIS TEXT HAS. `window` is host-stamped for the planner —
   * `WINDOW_STAMPED_FUNCTION_IDS` carries this op, so `modelFacingInput()` drops `window` from
   * `required` and the model is told it will be supplied. So this description is not planner
   * guidance at all; it exists for the human-facing surfaces D-19 says were undocumented — which,
   * as MEASURED by 400-12 and narrowed by 430 D-02, are the committed capability
   * catalog row, `init --agent` and MCP `tools/list`, with `agent-qa fn --list` and the committed
   * catalog as the way a person finds the op. NOT `/help`, `explain` or the type-ahead: those
   * render `row.description`, or withhold params by charter. See the `scope` field's doc block
   * above for the full measurement and the D-19 ratification.
   */
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

// ---- `authoring.draft.edit`: the patch contract's second consumer ------

/**
 * What a caller hands the edit op.
 *
 * TWO FIELDS, AND BOTH CROSS A TRUST BOUNDARY. `testRef` decides WHICH of a person's committed
 * tests is rewritten, and `intent` is free text that reaches a model and becomes a patch set. So
 * `.strict()` and non-empty are the shape refusal, and everything a schema cannot check is refused
 * downstream by a named error: the ref by the never-guess binder, the emitted patches by the
 * region fence, and the patched document by the parser before anything is proposed.
 *
 * `testRef` accepts the `<filePath>::<testName>` spelling this project already prints — the same
 * string a dedup refusal hands back — as well as free text, which is routed to the house resolver.
 * Which of the two arrived is not a caller's declaration but a fact about the string, decided in
 * one place; a `kind` discriminant here would let a caller assert an exact address for text that
 * is not one.
 */
export const AuthoringDraftEditInputSchema = z.object({
  /** The test to edit: `<filePath>::<testName>`, or a name to resolve. Never guessed at. */
  testRef: z.string().min(1),
  /** Plain-English description of the change. */
  intent: z.string().min(1),
}).strict()

export type AuthoringDraftEditInput = z.infer<typeof AuthoringDraftEditInputSchema>

/**
 * What one edit answers: the draft it points at, the diff that produced it, and what it wrote.
 *
 * THE DIFF RIDES THE OUTPUT. The patch set is a fact about THIS invocation, and this is the shape
 * that invocation's caller reads. 2026-10-01: the `test-draft` proposal arm this output
 * used to carry is deleted with the inbox; `written` says which file the edit wrote.
 *
 * The ops are the diff in the contract's own vocabulary, and they are more precise than a line
 * range: a JSON Pointer names a node, and the guarantee that the rendered bytes changed only where
 * those pointers reach is 394-03's frozen corpus over the very applier this op reuses — which is
 * the whole argument for reusing it rather than writing a second one.
 */
export const AuthoringDraftEditOutputSchema = z.object({
  /**
   * The edited test. Since 432 D-06 the edit is written to the file it edited, and this ref points
   * at that file, so the verify arm reads the written test; it stays on the shelf copy only when
   * the write did not land (see `written`).
   */
  draftRef: DraftRefSchema,
  /** The committed test this edit was applied to, as the binder resolved it. */
  editedFrom: z.object({
    filePath: z.string().min(1),
    testName: z.string().min(1),
    /** How the ref bound: an exact address, or a unique high-confidence resolver hit. */
    boundBy: z.enum(['exact-ref', 'resolver']),
  }).strict(),
  /** The RFC-6902 ops that were applied — the diff. See the contract's doc block. */
  patches: z.array(PatchOpSchema),
  /** The model's own account of the change, stored as prose so nothing downstream parses it. */
  thoughts: z.string(),
  /**
   * What the edit did to the file it edited: written over the exact bytes it read, or
   * not written because that file changed, left the workspace, or could not be written.
   */
  written: TestFileWriteSchema,
}).strict()

export type AuthoringDraftEditOutput = z.infer<typeof AuthoringDraftEditOutputSchema>
