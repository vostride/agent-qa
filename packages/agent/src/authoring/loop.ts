// Six stages run once each in this order inside one op, so no caller can reorder or skip one.

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

// A pinned string because it lands in the stable tier that provider prompt caches key on.
export const AUTHORING_COMPILE_AGENT_CONTEXT =
  'authoring.draft.write — compile a whole test document from an intent and a brief'

// The `stopped` arm writes nothing; `drafted` and `repaired` carry the written-test receipt.
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
      // Kind and spend are one object, so the payload never shows a kind without its iterations.
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
  // Threaded to every receipt, the repaired candidate's final gate included.
  readonly sessionRef?: string
}

// In draft mode the first gate takes one run and the final gate `N`: the bound is `1 + K + N`.
export function authoringFanOutBound(input: { readonly draftMode?: true }): FanOutBound {
  return computeFanOutBound({
    initialN: input.draftMode === true ? 1 : DRAFT_STABILITY_RUNS_N,
    probeK: REPAIR_ITERATION_CAP,
    finalN: DRAFT_STABILITY_RUNS_N,
  })
}

export interface AuthoringLoopDeps {
  readonly read: AuthoringReadPortLike
  // The run capability rides this bundle, so whether a host can author stays one question.
  readonly shelf: DraftShelfPortLike
}

// `stages` is pushed as each stage is entered, so a reordered loop reports a reordered trace.
export interface AuthoringLoopResult {
  readonly outcome: AuthoringLoopOutcome
  readonly stages: readonly AuthoringLoopStage[]
  readonly dedup: DedupScreening
  /** Which named side counters this invocation incremented. See the vocabulary's doc block. */
  readonly sideCounters: readonly AuthoringLoopSideCounter[]
  // On the result, not an arm, because a stage-2 refusal has no arm and still reports its cost.
  readonly fanOut: FanOutReport
  // Absent only when the round never ran; `no-op` and `not-applied` both leave the draft alone.
  readonly refinement?: RefinementOutcome
}

// Counted beside the funnel: a dedup refusal never entered the pipeline, so it is not a filter.
export const AUTHORING_LOOP_SIDE_COUNTERS = ['dedup-refused'] as const

export type AuthoringLoopSideCounter = (typeof AUTHORING_LOOP_SIDE_COUNTERS)[number]

// A named refusal, not a retry, so the fan-out preview stays true; nothing was written.
export class AuthoringDraftUnparsableError extends Error {
  constructor(readonly reason: string) {
    super(
      'authoring.draft.write: the compiled draft is not a parsable test document, '
        + `so nothing was written to the shelf: ${reason}`,
    )
    this.name = 'AuthoringDraftUnparsableError'
  }
}

// Refused, not repaired: `target` is outside `EDITABLE_POINTER_ROOTS` and a child run would throw.
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

// Every disposition but `rejected` is written; an `unverified` draft is written and says so.
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

// No `sourceDigest`: the writer requires the target absent, so a slug collision never overwrites.
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
  // The draft about to be written is checked here, the only door to publish.
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

// One model call through the tiered builder; the shelf parses the result and writes no unparsable.
async function compileDraft(
  input: AuthoringLoopInput,
  brief: AuthoringBrief,
  shelf: DraftShelfPortLike,
  read: AuthoringReadPortLike,
): Promise<ParsedDraftLike> {
  // Read here, not at the top, so the dedup refusal path never pays for it.
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
      // The document format sits in the stable tier, so a brief with no exemplars still teaches it.
      {
        title: TEST_DOCUMENT_FORMAT_BLOCK_TITLE,
        body: TEST_DOCUMENT_FORMAT_INSTRUCTION,
      },
      // Stable tier: a standing rule about writing any step, shared across invocations.
      { title: 'Procedures', body: PROCEDURE_BY_REFERENCE_INSTRUCTION },
    ],
    context: [
      { title: 'Intent', body: input.intent },
      { title: 'Scope', body: `${input.scope.tier}:${input.scope.key}` },
      // `Scope` renders a product, not a target name, so the configured targets ride beside it.
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

  // Refused before any gate run: a child run throws on an undeclared `target` repair cannot fix.
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

// The last gate run, because gate 2 early-stops on the run that carries the reported failure.
async function routingHandoff(
  receipt: DraftReceipt,
  runs: DraftRunPortLike,
): Promise<CompletedRunHandoff | undefined> {
  const lastRun = receipt.gateRuns.at(-1)
  return lastRun === undefined ? undefined : await runs.get(lastRun.runId)
}

// All four fields come from the error: the probe ran the re-staged candidate, not the old path.
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

// Asks the stored disposition, then the router; repair is entered only through a `RepairRoute`.
export async function routeAfterVerify(
  draft: ParsedDraftLike,
  receipt: DraftReceipt,
  deps: AuthoringLoopDeps,
  statedValues: readonly string[],
  previewed: FanOutBound = NO_RUNS_FAN_OUT_BOUND,
  // Handed in from stage 4's derivation; absent leaves the repaired draft on the fallback.
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
    // The run passed but a gate said no: nothing to repair or stop on, so the draft is not written.
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

  // The repaired candidate's session comes off the receipt stage 4 just minted.
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

  // The abandoned arm takes its failure point and evidence from the run it was routed on.
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

  // Ends before `compileDraft`, the only place a model is reached; `stages` stops at `dedup`.
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
  // A compiled draft that loses a stated value is refused before refine, with no retry or run.
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
  // Unconditional and inside stage 3: refining is part of producing the draft, not its own stage.
  const refinement = await refineDraft(compiled, input, deps)
  const draft = refinement.draft

  // A draft that would type a literal `[secret:NAME]` ends here.
  refuseLiteralSecretMarkers(draft)

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
  // Repair cannot patch `/name`, so this target, computed before repair, matches the one at write.
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
