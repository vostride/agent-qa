// The six-stage authoring loop.
//
// ONE function takes a plain-English intent to a verified draft with a real receipt. The six
// stages are evaluated in THIS order, once each, and the order is the contract rather than an
// implementation detail — D-01 puts the whole loop inside one registered op precisely so that no
// caller, including the chat planner that binds every registered op 1:1, can reorder a stage, skip
// one, or reach a later one without the earlier ones having happened.
//
//   1. brief     Read what this project already knows about the intent's scope. Stage 3 compiles
//                from this and from nothing else the host had lying around; an absent brief is a
//                refusal at the op, never an empty one served silently.
//   2. dedup     Screen the intent against the authored suite BEFORE a byte is authored. Being
//                first is the whole of "dedup-before-author": there is exactly one call site and
//                it is here, so the property is structural rather than a habit of this code.
//   3. compile   ONE model call emits a WHOLE document (D-02: creation is not an edit — a new
//                file has no untouched lines to preserve, so WTST-07's letter holds). What it
//                emitted is parsed before it becomes bytes; an unparsable draft is a named
//                refusal and leaves nothing on disk.
//   4. verify    The staged draft is judged by `authoring.draft.verify`, dispatched as the
//                REGISTERED op. No gate is re-implemented here and no disposition is re-derived
//                here — `computeDraftDisposition` is the one site, and the receipt already
//                carries what it decided.
//   5. route     Turn the receipt into an outcome. Deterministic by contract: a clean
//                definitive assertion-fail must never reach repair, because "repairing" one means
//                rewriting the expectation to match what the app shows, which is oracle capture.
//   6. compound  NO CODE, AND THAT IS THE POINT. `projectProcedureTargets` already fires for every
//                verified-PASS multi-step trajectory on every drain, and a gate-run reaches it
//                because `runs.start` spawns a full child `agent-qa run` (C8: gate-runs curate).
//                D-07's induction therefore needs no write path from here, and adding one would be
//                a SECOND Curator write path for a fact the existing one already records. The
//                stage is entered and recorded so the loop's own trace states the six, and so a
//                later reader finds this paragraph instead of an apparent gap.
//
// WHAT THIS TRACER IMPLEMENTS AND WHAT IT DOES NOT. Stage 2 walks the corpus and reports the
// closest match; the REFUSING arm and its pinned threshold land in plan 04, RED-first against a
// frozen corpus, so no constant is minted here for a later plan to re-litigate. Stage 5 answers
// `drafted` for a receipt the gates were able to judge and refuses BY NAME for the dispositions
// plans 05 and 06 own — a named refusal that a later plan replaces with a branch, never a wrong
// answer returned in the meantime. {@link AuthoringLoopOutcome} declares all four arms today so
// those plans add a case behind a discriminant every consumer already reads.

import { literalSecretMarkerRefusal } from '@vostride/agent-qa-runner'
import {
  DRAFT_STABILITY_RUNS_N,
  authoredSuiteTargetPath,
  NO_RUNS_FAN_OUT_BOUND,
  buildFanOutReport,
  computeFanOutBound,
  draftDispositionWritesTarget,
  draftGateBooleans,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringBrief,
  CompletedRunHandoff,
  ConsumedRun,
  DraftDisposition,
  DraftReceipt,
  DraftRef,
  FanOutBound,
  AuthoringDraftWriteOutput,
  FanOutReport,
  ScopeKey,
  WrittenTestReceipt,
} from '@vostride/agent-qa-schema'

import {
  CONFIGURED_TARGETS_BLOCK_TITLE,
  PROCEDURE_BY_REFERENCE_INSTRUCTION,
  REQUEST_WINS_INSTRUCTION,
  TEST_DOCUMENT_FORMAT_BLOCK_TITLE,
  TEST_DOCUMENT_FORMAT_INSTRUCTION,
  configuredTargetsBlockBody,
  exemplarBlockBody,
  knowledgeBlockBody,
} from './brief-blocks.js'
import { dedupBeforeAuthor } from './dedup.js'
import type { DedupScreening } from './dedup.js'
import type {
  AuthoringReadPortLike,
  DraftRunPortLike,
  DraftShelfPortLike,
  ParsedDraftLike,
} from './ports.js'
import { refineDraft } from './refine.js'
import type { RefinementOutcome } from './refine.js'
import { REPAIR_ITERATION_CAP, repairDraft } from './repair.js'
import type { RepairAbandonment, RepairOutcome } from './repair.js'
import { extractStatedValues, missingStatedValues } from './stated-values.js'
import {
  AuthoringRouterUnroutableError,
  routeRepairOrStop,
  stopRouteForAbandonedRepair,
} from './router.js'
import type { StopRoute } from './router.js'
import { buildTieredPrompt } from '../prompt/tiered-prompt-builder.js'

/**
 * The stage vocabulary, closed and ordered.
 *
 * The DECLARATION ORDER is the execution order, and `loop-ordering.test.ts` asserts the observed
 * trace equals this array — sequence equality over the whole run rather than a set of per-stage
 * "was it called" checks, because what has to be pinned is that nothing ran out of order and
 * nothing was skipped, which a call count cannot say.
 */
export const AUTHORING_LOOP_STAGES = [
  'brief',
  'dedup',
  'compile',
  'verify',
  'route',
  'compound',
] as const

export type AuthoringLoopStage = (typeof AUTHORING_LOOP_STAGES)[number]

/**
 * The `agent_context` every compile call carries into the ONE tiered prompt builder.
 *
 * A pinned string rather than a computed one: it lands in the stable tier, which is the byte
 * prefix provider prompt caches key on, so a per-invocation value would defeat the caching the
 * tier law exists to enable.
 */
export const AUTHORING_COMPILE_AGENT_CONTEXT =
  'authoring.draft.write — compile a whole test document from an intent and a brief'

/**
 * How one loop invocation ended.
 *
 * Discriminated on the CLOSED schema vocabulary, and all four arms are declared here in the
 * tracer even though only `drafted` is reachable from it. See the vocabulary's own doc block: a
 * union that grew an arm per plan would make plans 04-06 changes to the shape every consumer
 * branches on rather than new cases behind a discriminant they already read.
 *
 * The `stopped` arm carries the ROUTE and the abandonment facts and writes nothing — the op
 * projects the result's `stop` payload from it.
 *
 * the `drafted` and `repaired` arms carry the WRITTEN-TEST RECEIPT where they
 * used to carry a proposal for a person to accept. The final draft is written to its target unless
 * its final receipt is `rejected`, and the receipt says which file was written or why none was.
 */
export type AuthoringLoopOutcome =
  | {
      readonly kind: 'drafted'
      readonly draftRef: DraftRef
      readonly receipt: DraftReceipt
      readonly written: WrittenTestReceipt
    }
  | {
      readonly kind: 'refused'
      readonly draftRef?: DraftRef
      readonly receipt?: DraftReceipt
      readonly statedValueRefusal?: NonNullable<AuthoringDraftWriteOutput['statedValueRefusal']>
    }
  | {
      readonly kind: 'repaired'
      readonly draftRef: DraftRef
      readonly receipt: DraftReceipt
      readonly written: WrittenTestReceipt
      /** Repair iterations spent reaching the repaired draft, fenced ones included. */
      readonly repairIterations: number
    }
  | {
      readonly kind: 'stopped'
      readonly draftRef: DraftRef
      readonly receipt: DraftReceipt
      readonly route: StopRoute
      /**
       * ITS KIND AND ITS SPEND ARE ONE PARAMETER, so `repairAbandonment` and `repairIterations`
       * land on the op's payload together or not at all. Present as one object or
       * absent — never two independent optionals, which could disagree: a kind with no spend, or a
       * spend on a stop repair never touched, which reads as "repair was tried and cost nothing".
       *
       * `iterations` is `RepairOutcome.iterations` INCLUDING iterations a fence refused, which
       * started nothing — which is why it is not derivable from the run ids `fanOut` counts.
       */
      readonly abandonment?: {
        readonly kind: RepairAbandonment['kind']
        readonly iterations: number
      }
    }

export interface AuthoringLoopInput {
  readonly intent: string
  readonly scope: ScopeKey
  /** Handed straight through to stage 4. See the op's input contract for what it costs. */
  readonly draftMode?: true
  /**
   * The invoking session, threaded to EVERY receipt this invocation mints.
   *
   * Both of them: stage 4's own evaluation and the final stability gate a repaired candidate goes
   * through. A thread that stopped at the first would attribute first-try drafts and silently
   * unattribute every draft that needed repairing — the population a keep rate most needs.
   */
  readonly sessionRef?: string
}

/**
 * The fan-out ONE invocation of this loop can cost, in child `agent-qa run` processes.
 *
 * THE SINGLE PLACE THE THREE TERMS ARE ASSEMBLED, and the only caller of `computeFanOutBound` in
 * this package. The dispatch confirm renders what this returns and the finished proposal reports
 * against it, so the number a person consents on and the number they are shown afterwards are the
 * same function of the same input rather than two agreeing arithmetics. A surface recomputing
 * `N + K + N` for itself would be free to drift the moment either constant moved — which is what
 * mutation I of the phase's mutation driver (since removed) demonstrated rather than asserted.
 *
 * DRAFT MODE IS THE CASE WHERE THE TWO N TERMS DIFFER. A draft-mode caller asks for ONE cheap gate
 * run (rule 1 of the disposition table), but the FINAL stability gate still runs the pinned N on
 * the repaired candidate — `repairDraft` deliberately drops the draft-mode marker for it. So the
 * bound is `1 + K + N`, not `2 * 1 + K`, and it is the configuration the schema cells use to prove
 * the two terms stay separate: with the shipped constants they are both 3, and a collapse would be
 * invisible under default values.
 */
export function authoringFanOutBound(input: { readonly draftMode?: true }): FanOutBound {
  return computeFanOutBound({
    initialN: input.draftMode === true ? 1 : DRAFT_STABILITY_RUNS_N,
    probeK: REPAIR_ITERATION_CAP,
    finalN: DRAFT_STABILITY_RUNS_N,
  })
}

export interface AuthoringLoopDeps {
  readonly read: AuthoringReadPortLike
  /**
   * The compile half, plus stage 5's run reader.
   *
   * The run capability rides this bundle rather than arriving as a third dep: see the port's own
   * `runs` doc. What it buys the loop is that "can this host author" stays ONE question with one
   * answer, which is the property D-01's composition rests on.
   */
  readonly shelf: DraftShelfPortLike
}

/**
 * What one invocation produced, and the stages it actually entered.
 *
 * `stages` is DATA the loop answers with, not a test hook. Plan 04's refusal ends an invocation
 * at stage 2 and plan 05's repair re-enters stages 3-4, so "where did this stop" and "how many
 * times did it iterate" are questions about a real invocation that a caller — and the funnel's
 * side counters — has to be able to ask. It is also what makes the ordering claim
 * checkable at all: the trace is pushed by each stage as it is entered, so a reordered loop
 * reports a reordered trace.
 */
export interface AuthoringLoopResult {
  readonly outcome: AuthoringLoopOutcome
  readonly stages: readonly AuthoringLoopStage[]
  readonly dedup: DedupScreening
  /** Which named side counters this invocation incremented. See the vocabulary's doc block. */
  readonly sideCounters: readonly AuthoringLoopSideCounter[]
  /**
   * What was previewed at dispatch, beside the runs this invocation actually spent.
   *
   * ON THE RESULT AND NOT ONLY ON THE PROPOSAL ARM, because a stage-2 refusal has no arm — D-04
   * ends it with no draft, no receipt and no envelope — and "this invocation cost nothing" is a
   * fact a caller is entitled to for every outcome, not only the ones that produced something.
   */
  readonly fanOut: FanOutReport
  /**
   * What stage 3's one refinement round did.
   *
   * ABSENT exactly when the round never ran — a stage-2 refusal, or a compile refusal for a lost
   * stated value — and present on every other invocation, including the ones where the round
   * changed nothing. The
   * distinction the field exists to keep is between a round that found nothing (`no-op`) and one
   * whose emission could not be used (`not-applied`): both leave the draft alone, and only one of
   * them is the loop working as designed.
   */
  readonly refinement?: RefinementOutcome
}

/**
 * Facts about an invocation that are counted BESIDE the funnel, never as a stage of it.
 *
 * A dedup refusal is the first member, and the distinction is the whole reason the vocabulary
 * exists. Plan 07 projects the loop as a funnel — how many intents reached compile, verify, a
 * keep-eligible receipt — and a refusal that was folded into a funnel stage would read as an
 * invocation the pipeline FILTERED. It is not: it is an invocation the pipeline never entered,
 * refused for a working-as-intended reason before any cost was incurred. Counting it inside the
 * funnel would inflate the filter rate with successes and break comparison against the reference
 * distribution, which is exactly the number the funnel exists to be compared against.
 */
export const AUTHORING_LOOP_SIDE_COUNTERS = ['dedup-refused'] as const

export type AuthoringLoopSideCounter = (typeof AUTHORING_LOOP_SIDE_COUNTERS)[number]

/**
 * The model emitted something that is not a parsable test document.
 *
 * A NAMED refusal and not a retry: this tracer takes one model call by design, and a second
 * attempt hidden inside the first would make the fan-out preview a number that does not
 * describe what happens. The bytes were never written — the shelf parses before it writes — so
 * there is no partial draft to clean up either.
 */
export class AuthoringDraftUnparsableError extends Error {
  constructor(readonly reason: string) {
    super(
      'authoring.draft.write: the compiled draft is not a parsable test document, '
        + `so nothing was written to the shelf: ${reason}`,
    )
    this.name = 'AuthoringDraftUnparsableError'
  }
}

/**
 * The model emitted a `target` this project does not declare.
 *
 * A REFUSAL AND NOT A REPAIR, and the two halves of that are separate facts. It cannot be
 * repaired: `target` is outside `EDITABLE_POINTER_ROOTS`, so no patch the repair loop may emit
 * reaches the key. And it must not be run: `runs.start` spawns a real child `agent-qa run`, whose
 * own `resolveTarget` throws on the name — so the cost of discovering this downstream is up to
 * `DRAFT_STABILITY_RUNS_N` real child processes (nine across a repaired invocation), a receipt on
 * disk, and a draft nothing can fix.
 *
 * IT NAMES BOTH SIDES OF THE COMPARISON. A message carrying only the emitted name would leave a
 * person unable to tell whether the target was misspelled or the config was, which is the same
 * D-19 posture `AuthoringScopeUnresolvableError` takes one file over: refuse, and hand over the
 * evidence the refusal was made on.
 */
export class AuthoringDraftUnconfiguredTargetError extends Error {
  constructor(
    readonly target: string,
    readonly configuredTargets: readonly string[],
  ) {
    super(
      `authoring.draft.write: the compiled draft names target "${target}", which this project `
        + `does not declare, so no gate run was started: configured targets are `
        + `${configuredTargets.join(', ')}`,
    )
    this.name = 'AuthoringDraftUnconfiguredTargetError'
  }
}

export class DraftSecretMarkerRefusedError extends Error {
  constructor(
    readonly location: string,
    refusal: string,
    readonly stepIndex?: number,
  ) {
    super(`${location}: ${refusal}`)
    this.name = 'DraftSecretMarkerRefusedError'
  }
}

export function refuseLiteralSecretMarkers(draft: {
  readonly testName: string
  readonly steps: readonly string[]
  readonly context?: string
}): void {
  const locations: readonly { text: string; label: string; stepIndex?: number }[] = [
    { text: draft.testName, label: 'the test name' },
    ...(draft.context === undefined ? [] : [{ text: draft.context, label: 'the test context' }]),
    ...draft.steps.map((text, index) => ({ text, label: `step ${index + 1}`, stepIndex: index })),
  ]
  for (const location of locations) {
    const refusal = literalSecretMarkerRefusal(location.text)
    if (refusal === undefined) continue
    throw new DraftSecretMarkerRefusedError(location.label, refusal, location.stepIndex)
  }
}

/**
 * The router could not place a rejected receipt's evidence.
 *
 * The honest answer for the one case stage 5 genuinely cannot decide: the gates said no, and the
 * run record the receipt names is not readable, or holds no member with this draft's identity. That
 * is a broken precondition rather than an ambiguous signal — reporting an evidence-less stop would
 * report an application bug nobody observed, which is the cardinal error pointed the other way.
 */
export class AuthoringLoopUnroutableEvidenceError extends Error {
  constructor(readonly disposition: DraftDisposition, readonly cause: Error) {
    super(
      `authoring.draft.write: a ${disposition} receipt could not be routed — ${cause.message}`,
    )
    this.name = 'AuthoringLoopUnroutableEvidenceError'
  }
}

/**
 * THE FINAL-WRITE BRANCH: whether a final draft is written to its target.
 *
 * It is also the set stage 5 answers `drafted` for, because the two are one fact: the gates did
 * not say no. `unverified` is a DRAFT-MODE evaluation whose gates 1, 3 and 4 passed (rule 1 of the
 * disposition table; 261003-cpv, WR-09), and such a draft is neither a stop — no run said the
 * application is wrong — nor repairable — no mechanics evidence exists to repair against — so it
 * is written, and its receipt says it is unverified. `rejected` is the only disposition that
 * routes and the only one never written, because it is the only one a gate actually refused. A
 * rejected draft whose run passed has nothing to route either; `routeAfterVerify` answers it
 * `drafted`, not written, with the rejecting gates on its receipt.
 */
function writesFinalDraft(disposition: DraftDisposition): boolean {
  return draftDispositionWritesTarget(disposition)
}

/** The draft's identity as the receipt and both envelope arms spell it. */
function draftRefOf(draft: ParsedDraftLike): DraftRef {
  return {
    filePath: draft.filePath,
    testId: draft.testId,
    testName: draft.testName,
    contentDigest: draft.contentDigest,
  }
}

/**
 * Write the final draft, or say why it was not written.
 *
 * The target is derived from where the DRAFT already sits (394-10's recipe). There is deliberately
 * no `sourceDigest`: a loop-authored draft is a NEW file (D-02 — creation is not an edit), so the
 * writer re-checks the target as still absent. That is the collision guard for two drafts whose
 * names slug the same way, and it fails toward `target-changed` rather than an overwrite.
 *
 * The receipt carries the disposition and the four gate booleans whatever happened to the file, so
 * the author always learns how well the draft was verified beside where it went.
 */
async function writeFinalDraft(
  draft: ParsedDraftLike,
  receipt: DraftReceipt,
  shelf: DraftShelfPortLike,
  statedValues: readonly string[],
): Promise<FinalWrite> {
  const gates = draftGateBooleans(receipt.gates)
  const targetPath = authoredSuiteTargetPath(draft.filePath, draft.testName)
  if (!writesFinalDraft(receipt.disposition)) {
    return {
      written: {
        file: { kind: 'not-written', targetPath, reason: 'rejected' },
        disposition: receipt.disposition,
        gates,
      },
    }
  }
  // the exact draft about to be written is checked here, the only door
  // to publish, so no route can write a draft that lost a stated value.
  const missingValues = missingStatedValues(statedValues, draft.steps)
  if (missingValues.length > 0) return { missingValues }
  const file = await shelf.publish({ draftPath: draft.filePath, targetPath })
  return { written: { file, disposition: receipt.disposition, gates } }
}

type FinalWrite =
  | { readonly written: WrittenTestReceipt }
  | { readonly missingValues: readonly string[] }

function keepRefusal(
  draftRef: DraftRef,
  receipt: DraftReceipt,
  missingValues: readonly string[],
  fanOut: FanOutReport,
): AuthoringLoopRouting {
  return {
    outcome: {
      kind: 'refused',
      draftRef,
      receipt,
      statedValueRefusal: { stage: 'keep', missingValues: [...missingValues] },
    },
    fanOut,
  }
}

/**
 * Stage 3, first half — ONE model call, one whole document, parsed before it is written.
 *
 * The prompt extends the ONE tiered builder through `agent_context` (389 D-04's law); there is no
 * second renderer and no persona fork here. What the model returns is handed to the shelf, which
 * parses it and answers `unparsable` without writing when it is not a test.
 *
 * The two brief renderers live in `brief-blocks.ts` because the refinement round reads the same
 * substrate; see that module's header for why they are shared rather than copied.
 */
async function compileDraft(
  input: AuthoringLoopInput,
  brief: AuthoringBrief,
  shelf: DraftShelfPortLike,
  read: AuthoringReadPortLike,
): Promise<ParsedDraftLike> {
  // the `target` vocabulary, read HERE rather than threaded in from the caller. It is
  // needed by exactly one prompt and nothing else in the invocation consults it, so a value
  // fetched at the top of `runAuthoringLoop` would be a read the dedup refusal path pays for and
  // never uses — and one more argument that could be edited in transit.
  const targetNames = await read.configuredTargetNames()

  const request = buildTieredPrompt({
    agent_context: AUTHORING_COMPILE_AGENT_CONTEXT,
    stable: [
      {
        title: 'Role',
        body: 'You author agent-qa test documents. Emit ONE complete YAML test document and '
          + 'nothing else — no prose, no fences, no partial edit. Steps are natural language, one '
          + 'per line, and at least one of them must assert concrete expected content. '
          + REQUEST_WINS_INSTRUCTION,
      },
      // The document schema, on the same placement argument and for WINDOWS 111's reason: a brief
      // serving no exemplars must still teach the format. See the constant's own header.
      {
        title: TEST_DOCUMENT_FORMAT_BLOCK_TITLE,
        body: TEST_DOCUMENT_FORMAT_INSTRUCTION,
      },
      // D-17's syntactic half, in the STABLE tier beside the role it qualifies. It is a standing
      // rule about how any step is written rather than a fact about this intent, so it belongs
      // where the byte prefix is shared across invocations.
      { title: 'Procedures', body: PROCEDURE_BY_REFERENCE_INSTRUCTION },
    ],
    context: [
      { title: 'Intent', body: input.intent },
      { title: 'Scope', body: `${input.scope.tier}:${input.scope.key}` },
      // WR-07, AND IT RIDES BESIDE THE BLOCK IT CORRECTS. `Scope` renders `${tier}:${key}` and
      // that key is a PRODUCT — `deriveDefaultAuthoringScope` answers `target.product ??
      // targetName` — so a stage asked for a `target` while served only the Scope block was being
      // asked to guess on every project where the two differ. CONTEXT tier and not stable: these
      // names are per-project facts, and the stable tier's shared byte prefix must stay
      // project-independent for the prompt cache the tier law exists to enable.
      {
        title: CONFIGURED_TARGETS_BLOCK_TITLE,
        body: configuredTargetsBlockBody(targetNames),
      },
      { title: 'What this project knows', body: knowledgeBlockBody(brief) },
    ],
    volatile: [{ title: 'Exemplar tests', body: exemplarBlockBody(brief) }],
  })

  const model = await shelf.model()
  const emitted = await model.generate(request)
  const staged = await shelf.write(emitted.text)
  if (staged.kind === 'unparsable') throw new AuthoringDraftUnparsableError(staged.reason)

  // THE VOCABULARY IS SERVED AND THEN CHECKED. Round 5 read `targetNames` for the
  // prompt above and compared it against nothing, and a prompt is ADVICE: a model that skips the
  // `target` bullet — copying the block's own example, say — emits a name this project does not
  // declare, and the check that would have caught it is eight lines up in a local variable.
  //
  // THE REFUSAL BELONGS HERE, BEFORE THE FIRST GATE RUN, on two facts that hold together.
  // `runs.start` types this value into a live application and `resolveTarget` THROWS on it inside
  // a real child process, so the downstream cost is up to `DRAFT_STABILITY_RUNS_N` spawns (nine
  // with repair) rather than one comparison. And `target` is outside `EDITABLE_POINTER_ROOTS`, so
  // the repair loop those runs would feed cannot correct the value it discovers is wrong — the
  // spend buys nothing at all. D-19's refuse-rather-than-guess posture, applied to the loop's own
  // emission instead of to its inputs.
  //
  // THE EMPTY-VOCABULARY ARM STAYS PERMISSIVE, DELIBERATELY. A project that declares no targets
  // has nothing for this to compare against, and refusing there would turn a derivation problem
  // (`deriveDefaultAuthoringScope` already refuses such a project by name) into a compile-stage
  // refusal that names the wrong cause. `configuredTargetsBlockBody` tells the model the same
  // thing in the same case: ask, do not invent.
  if (targetNames.length > 0 && !targetNames.includes(staged.draft.target)) {
    throw new AuthoringDraftUnconfiguredTargetError(staged.draft.target, targetNames)
  }
  return staged.draft
}

/**
 * What stage 5 answers: the outcome, and the runs the whole invocation spent reaching it.
 *
 * The fan-out report rides OUT of stage 5 rather than being assembled by the caller, because stage
 * 5 is the only place that knows what repair spent. A caller totalling it from the outside would be
 * counting attempts it can see rather than runs that happened.
 */
export interface AuthoringLoopRouting {
  readonly outcome: AuthoringLoopOutcome
  readonly fanOut: FanOutReport
}

/**
 * The gate runs a receipt names, as consumed runs with their completion times.
 *
 * The time is read from the run's OWN record rather than stamped here: `GateRunRecord` carries a
 * run id and the draft's member outcome, not a clock, and a timestamp minted at read time would
 * order the sequence by when somebody looked rather than by when the runs finished. A record that
 * cannot be read still COUNTS — the run happened — and simply carries no time, which is what the
 * report's ordering rule has an unknown-time arm for.
 */
async function consumedGateRuns(
  receipt: DraftReceipt,
  runs: DraftRunPortLike,
): Promise<readonly ConsumedRun[]> {
  const consumed: ConsumedRun[] = []
  for (const record of receipt.gateRuns) {
    const document = await runs.get(record.runId)
    consumed.push({
      runId: record.runId,
      purpose: 'gate',
      ...(document?.endedAt === undefined ? {} : { completedAt: document.endedAt }),
    })
  }
  return consumed
}

/** The probe runs a repair sequence started, on `consumedGateRuns`' terms. */
async function consumedProbeRuns(
  probeRunIds: readonly string[],
  runs: DraftRunPortLike,
): Promise<readonly ConsumedRun[]> {
  const consumed: ConsumedRun[] = []
  for (const runId of probeRunIds) {
    const document = await runs.get(runId)
    consumed.push({
      runId,
      purpose: 'probe',
      ...(document?.endedAt === undefined ? {} : { completedAt: document.endedAt }),
    })
  }
  return consumed
}

/**
 * The run whose evidence stage 5 routes on: the LAST gate run the receipt names.
 *
 * ONE ANSWER TO A QUESTION THE DERIVATION DELIBERATELY DOES NOT OWN. `routeRepairOrStop` takes
 * a single run document because a routing rule that also chose its own evidence would be two rules
 * in one function. Which of an evaluation's several runs supplies that document is a fact about
 * the EVALUATION, and it is answered here: the last one taken, because gate 2 early-stops on a
 * verdict flip and the run that stopped it is the one carrying the failure the gates
 * ultimately reported. An absent record yields `undefined`, which the router refuses BY NAME
 * rather than routing on.
 */
async function routingHandoff(
  receipt: DraftReceipt,
  runs: DraftRunPortLike,
): Promise<CompletedRunHandoff | undefined> {
  const lastRun = receipt.gateRuns.at(-1)
  return lastRun === undefined ? undefined : await runs.get(lastRun.runId)
}

/**
 * THE PRODUCTION READ of `abandonment.error`, and the only one: its typed coordinates.
 *
 * A prefix-regressed abandonment means a PROBE run showed a step that used to pass now failing, and
 * `PassingPrefixRegressedError` carries the whole coordinate: which run, which member of it, and
 * which step. That is an addressable, replayable coordinate into a durable record — the same thing
 * every other `evidenceRefs` entry is — so the stop a person reads can reach the run that ended
 * the repair instead of merely stating that one did. Appended BESIDE the routed run's own refs: the
 * routed run says why the draft failed, this says why repair stopped, and they are different runs.
 *
 * ALL FOUR FIELDS COME FROM THE ERROR, AND THAT IS THE FIX RATHER THAN A TIDY-UP. This used
 * to take `filePath`/`testName` from the invocation's `draftRef`, which is the PRE-repair draft: a
 * probe runs the candidate `applyPatches` just staged, and staging addresses a draft by the digest
 * of its new bytes, so the two paths differ by construction on every iteration that reached a run.
 * The persisted coordinate named a real run and a file that run never opened, and a reader joining
 * on the four-tuple found nothing — a stop nobody can audit. The error is built at the
 * one site that held the probed member, which is also why this stays a read of typed facts and not
 * a second walk of the run store (394-24's one-derivation law).
 *
 * WHAT IS DELIBERATELY NOT READ: `error.message`, and through it `RepairExhaustedError.lastRefusal`,
 * which ends in the model's own bytes. There is no prose field on the stop payload for it to reach
 * and this read stays a read of typed coordinates.
 *
 * The exhausted arm gets no such ref because it has no such coordinate — its last iteration may have
 * been a fenced patch or an unparsable emission, neither of which started a run.
 */
function withRegressedProbeEvidence(
  route: StopRoute,
  abandonment: RepairAbandonment,
): StopRoute {
  if (abandonment.kind !== 'prefix-regressed') return route
  return {
    kind: 'stop',
    signalClass: route.signalClass,
    failurePoint: route.failurePoint,
    evidenceRefs: [
      ...route.evidenceRefs,
      {
        runId: abandonment.error.runId,
        filePath: abandonment.error.filePath,
        testName: abandonment.error.testName,
        stepIndex: abandonment.error.stepIndex,
        channel: 'step-trace',
      },
    ],
  }
}

/**
 * Stage 5 — the receipt becomes an outcome; the drafted and repaired ones carry their envelope arm.
 *
 * The stopped outcome carries the ROUTE the loop derived and nothing is minted for it.
 *
 * the proposal arm for a correctly-failing draft left with the Issue-slot
 * cleanup.
 *
 * TWO DERIVATIONS, ASKED IN ORDER, NEITHER RE-IMPLEMENTED HERE. The first is
 * `computeDraftDisposition`'s, already stored on the receipt: did the gates say no. The second is
 * `routeRepairOrStop`'s, over the run's own evidence: is a rejection the DRAFT's problem or the
 * APPLICATION's. This function asks them; it answers neither. The two are separate functions
 * rather than one because they read different things — a disposition reads four booleans and two
 * counts, a route reads per-step execution evidence — and a single function taking both would be
 * a parameter list through which a gate verdict could influence the branch.
 *
 * THE REPAIR ARM IS ENTERED ONLY THROUGH A `RepairRoute`. `repairDraft` cannot be handed the stop
 * arm — the two route types are mutually non-assignable — so the app-broken branch is structurally
 * unable to reach repair rather than merely not wired to it (SC-2, T-394-22).
 *
 * A REPAIR THAT DID NOT SUCCEED BECOMES A STOP, not a silent failure. The draft failed, repair was
 * allowed K attempts and none produced a passing probe, and the honest thing to hand a person is
 * the evidence plus what was tried. The route's own evidence refs are what the stop carries, so an
 * exhausted repair and a first-pass stop are the same artifact class differing only in how much was
 * spent before the loop stopped.
 */
export async function routeAfterVerify(
  draft: ParsedDraftLike,
  receipt: DraftReceipt,
  deps: AuthoringLoopDeps,
  statedValues: readonly string[],
  previewed: FanOutBound = NO_RUNS_FAN_OUT_BOUND,
  /**
   * The suite the draft proposes to JOIN, threaded to repair's final stability gate.
   *
   * HANDED IN rather than re-derived here, on the `sessionRef` posture one field over: the caller
   * computed it once for stage 4's own verify, and a second `authoredSuiteTargetPath` call at this
   * site would be a second answer to a question the invocation already answered. Absent — every
   * caller that is not the loop — leaves the repaired draft on the standalone fallback.
   */
  targetSuitePath?: string,
): Promise<AuthoringLoopRouting> {
  const draftRef = draftRefOf(draft)
  // The runs the EVALUATION already spent, read off the receipt's own record of them. It is the
  // receipt's list rather than a count this function keeps, because the receipt is what was
  // durably written — a tally maintained here could drift from the evidence a person later reads.
  const gateRuns = await consumedGateRuns(receipt, deps.shelf.runs)

  if (writesFinalDraft(receipt.disposition)) {
    const fanOut = buildFanOutReport({ previewed, runs: gateRuns })
    const final = await writeFinalDraft(draft, receipt, deps.shelf, statedValues)
    if ('missingValues' in final) return keepRefusal(draftRef, receipt, final.missingValues, fanOut)
    return { outcome: { kind: 'drafted', draftRef, receipt, written: final.written }, fanOut }
  }

  const handoff = await routingHandoff(receipt, deps.shelf.runs)
  let route
  try {
    route = routeRepairOrStop(draftRef, handoff)
  } catch (error) {
    if (!(error instanceof AuthoringRouterUnroutableError)) throw error
    // 2026-10-03 (quick 261003-cpv, 432 review WR-09): THE RUN PASSED AND A GATE STILL SAID NO —
    // the draft adds nothing to the suite, asserts nothing falsifiable, or flipped and then passed.
    // Nothing failed, so there is nothing to repair and no application bug to stop on; the honest
    // answer is the draft, not written, with the gates that rejected it. Draft mode reaches this
    // since rule 1 rejects on gates 1, 3 and 4, and a missing run record still refuses by name.
    if (error.signalClass === 'no-failure') {
      const fanOut = buildFanOutReport({ previewed, runs: gateRuns })
      const final = await writeFinalDraft(draft, receipt, deps.shelf, statedValues)
      if ('missingValues' in final) {
        return keepRefusal(draftRef, receipt, final.missingValues, fanOut)
      }
      return { outcome: { kind: 'drafted', draftRef, receipt, written: final.written }, fanOut }
    }
    throw new AuthoringLoopUnroutableEvidenceError(receipt.disposition, error)
  }

  if (route.kind === 'stop') {
    return {
      outcome: { kind: 'stopped', draftRef, receipt, route },
      fanOut: buildFanOutReport({ previewed, runs: gateRuns }),
    }
  }

  // `handoff` is defined here: the router refuses `no-run-evidence` by name, and that refusal was
  // already converted above — so reaching a repair arm at all means a run document was read.
  // THE SESSION IS READ OFF THE RECEIPT THAT WAS JUST MINTED, never threaded a second time
  // The repaired candidate belongs to the same invocation as the draft that
  // failed, so its receipt must carry the same attribution — and taking it from the record stage 4
  // already wrote makes that true by construction instead of by two threads agreeing. An
  // unattributed evaluation stays unattributed through repair for the same reason.
  const repaired: RepairOutcome = await repairDraft(route, {
    draft,
    handoff: handoff as CompletedRunHandoff,
    shelf: deps.shelf,
    runs: deps.shelf.runs,
    statedValues,
    ...(receipt.sessionRef === undefined ? {} : { sessionRef: receipt.sessionRef }),
    // The repaired candidate joins the SAME suite the draft proposed to join, so the final
    // stability gate reads the same target — one source for the whole invocation.
    ...(targetSuitePath === undefined ? {} : { targetSuitePath }),
  })

  // EVERY RUN THIS INVOCATION SPENT, in one list: the evaluation's gate runs, repair's probes, and
  // the FINAL stability gate's runs off the repaired receipt. The report counts distinct ids, so a
  // run appearing in two of these three lists contributes once — and a fenced iteration, which
  // started nothing, contributes nothing.
  const probes: readonly ConsumedRun[] = await consumedProbeRuns(
    repaired.probeRunIds,
    deps.shelf.runs,
  )

  if (repaired.kind === 'repaired') {
    const repairedRef = draftRefOf(repaired.draft)
    const finalGateRuns = await consumedGateRuns(repaired.receipt, deps.shelf.runs)
    const fanOut = buildFanOutReport({
      previewed,
      runs: [...gateRuns, ...probes, ...finalGateRuns],
    })
    // The repaired draft's FINAL receipt decides, exactly as a first-pass one does: a final
    // stability gate that rejects it leaves it on the shelf, reported as not written.
    const final = await writeFinalDraft(repaired.draft, repaired.receipt, deps.shelf, statedValues)
    if ('missingValues' in final) {
      return keepRefusal(repairedRef, repaired.receipt, final.missingValues, fanOut)
    }
    return {
      outcome: {
        kind: 'repaired',
        draftRef: repairedRef,
        receipt: repaired.receipt,
        written: final.written,
        repairIterations: repaired.iterations,
      },
      fanOut,
    }
  }

  // THE ABANDONED ARM READS THE RUN IT WAS ROUTED ON. It used to be an empty literal —
  // `failurePoint: null`, `evidenceRefs: []` — built with `handoff` and `route.failingStepIndex`
  // both in scope, so a person was handed a durable stop naming no step, no run and no trace. The
  // derivation is the router's, shared with the ordinary stop arm rather than repeated here: an
  // exhausted repair and a first-pass stop are the same artifact class, and this function's own
  // header says so. `handoff` is defined for the reason given at the repair call above — the router
  // refuses `no-run-evidence` by name and that refusal was already converted.
  const exhaustedRoute: StopRoute = withRegressedProbeEvidence(
    stopRouteForAbandonedRepair(draftRef, handoff as CompletedRunHandoff, route.failingStepIndex),
    repaired.abandonment,
  )
  return {
    outcome: {
      kind: 'stopped',
      draftRef,
      receipt,
      route: exhaustedRoute,
      abandonment: { kind: repaired.abandonment.kind, iterations: repaired.iterations },
    },
    fanOut: buildFanOutReport({ previewed, runs: [...gateRuns, ...probes] }),
  }
}

export async function runAuthoringLoop(
  input: AuthoringLoopInput,
  deps: AuthoringLoopDeps,
): Promise<AuthoringLoopResult> {
  const stages: AuthoringLoopStage[] = []
  // The SAME function the dispatch confirm rendered, over the SAME input. Not a number handed in
  // from the op — a threaded value could be edited in transit, and then the receipt would report a
  // preview nobody was shown. One function, two callers, identical arguments.
  const previewed = authoringFanOutBound(input)

  stages.push('brief')
  const brief = await deps.read.getAuthoringBrief(input.intent, input.scope)

  stages.push('dedup')
  const dedup = dedupBeforeAuthor(input.intent, await deps.read.suiteTextCorpus())

  // THE INVOCATION ENDS HERE, and it ends BEFORE `compileDraft` — which is the only place a model
  // is reached. D-04: the refusal is a typed op result, fail-closed and stateless. There is no
  // suspended-op state and no in-turn "continue anyway": chat renders the refusal with its link
  // and its two continuations, and the user re-invokes deliberately. An in-turn continue would
  // need a suspended op to resume into, which is machinery this phase does not build and which
  // would turn a refusal a user must read into one they can dismiss.
  //
  // `stages` stops at `dedup`, so the trace says WHERE this invocation ended rather than claiming
  // six stages ran. The `refused` arm carries neither a `draftRef` nor a `receipt` because there
  // is no draft and no gate-run to have produced one; the evidence lives on `dedup`, which is a
  // fact about the SCREENING rather than about the outcome.
  if (dedup.kind === 'duplicate') {
    return {
      outcome: { kind: 'refused' },
      stages,
      dedup,
      sideCounters: ['dedup-refused'],
      // ZERO PREVIEWED AND ZERO CONSUMED, and the first of those is a decision. The dispatch
      // confirm disclosed the worst case for these inputs, as it must — it fires before anything
      // is known. This report describes the INVOCATION, and this invocation ended before a draft
      // existed, so nothing was ever going to run. `NO_RUNS_FAN_OUT_BOUND` is that fact; carrying
      // the dispatch bound here would report a fan-out for a path that has none.
      fanOut: buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] }),
    }
  }

  const statedValues = extractStatedValues(input.intent)

  stages.push('compile')
  const compiled = await compileDraft(input, brief, deps.shelf, deps.read)
  // a compiled draft that loses a stated value is refused before refine,
  // with no retry and no run spent.
  const missing = missingStatedValues(statedValues, compiled.steps)
  if (missing.length > 0) {
    return {
      outcome: {
        kind: 'refused',
        draftRef: draftRefOf(compiled),
        statedValueRefusal: { stage: 'compile', missingValues: [...missing] },
      },
      stages,
      dedup,
      sideCounters: [],
      fanOut: buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] }),
    }
  }
  // THE ROUND IS UNCONDITIONAL AND IT IS INSIDE STAGE 3. Unconditional: there is no `if`
  // above this line and no argument that could turn it off — see `refine.ts` for why a trigger
  // heuristic is the thing D-18 rules out rather than the thing it configures. Inside stage 3
  // rather than beside it: `AUTHORING_LOOP_STAGES` is a pinned six, refining is part of producing
  // the draft, and a seventh stage would have re-opened an ordering contract that plans 02-08 all
  // built against for a step that has no independent entry point.
  const refinement = await refineDraft(compiled, input, deps)
  const draft = refinement.draft

  // a draft that would type a literal [secret:NAME] ends here.
  refuseLiteralSecretMarkers(draft)

  // the dispatch runs directly. The optional dispatch-grant scope that
  // used to wrap stages 4-6 is deleted; no host bound it after 432-18 and nothing asks for an
  // approval a gate run could collect.
  return await runAuthoringLoopDispatch(input, deps, {
    stages,
    previewed,
    dedup,
    draft,
    refinement,
    statedValues,
  })
}

/**
 * Stages 4-6 — the dispatch: verification, routing and the final write.
 *
 * `stages`, `previewed` and `dedup` are threaded rather than recomputed: `previewed` in
 * particular must stay the SAME value the caller derived, because the fan-out report's whole claim
 * is that the number a person approved and the number they are shown afterwards are one function
 * of one input.
 */
async function runAuthoringLoopDispatch(
  input: AuthoringLoopInput,
  deps: AuthoringLoopDeps,
  carried: {
    readonly stages: AuthoringLoopStage[]
    readonly previewed: FanOutBound
    readonly dedup: DedupScreening
    readonly draft: ParsedDraftLike
    readonly refinement: RefinementOutcome
    readonly statedValues: readonly string[]
  },
): Promise<AuthoringLoopResult> {
  const { stages, previewed, dedup, draft, refinement, statedValues } = carried

  stages.push('verify')
  // WHERE THE FINAL WRITE WILL PUT IT, computed ONCE for the whole invocation through the SAME
  // exported recipe the final write uses (`writeFinalDraft`'s `targetPath`) — so the suite the
  // stability read consults and the suite the draft is written into cannot disagree.
  // ONE DERIVATION IS ONLY ENOUGH BECAUSE THE INPUT THAT MOVES DOES NOT REACH THE ANSWER: this value
  // is derived here from the PRE-repair draft and recomputed at the write from the REPAIRED draft,
  // whose shelf path is a DIFFERENT file — repair re-stages every patched candidate under its new
  // digest — and `authoredSuiteTargetPath` drops that filename, keeping only the suite directory and
  // a slug of the test NAME. The name is therefore the one input a repair could move the target
  // with, and that is now ENFORCED rather than assumed — `fencePatchAgainstDraftIdentity` refuses a
  // repair patch addressing `/name`, so both ends of the recipe read the same name.
  // Without it the read targets `draft.filePath`, a one-test shelf artifact whose only member is
  // the draft itself, and `neighbours-flaky` is unreachable from this entry point for any app.
  const targetSuitePath = authoredSuiteTargetPath(draft.filePath, draft.testName)
  const receipt = await deps.shelf.verifyDraft({
    draftPath: draft.filePath,
    targetSuitePath,
    ...(input.draftMode === undefined ? {} : { draftMode: input.draftMode }),
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
  })

  stages.push('route')
  const routed = await routeAfterVerify(
    draft,
    receipt,
    deps,
    statedValues,
    previewed,
    targetSuitePath,
  )

  stages.push('compound')

  return {
    outcome: routed.outcome,
    stages,
    dedup,
    sideCounters: [],
    fanOut: routed.fanOut,
    refinement,
  }
}
