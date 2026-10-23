// Stage 5's deterministic repair-vs-stop derivation (Phase 394 D-08 · WTST-04; 411 D-01).
//
// ONE function decides whether a failing draft is the DRAFT's problem or the APPLICATION's, and
// this file is the only place that decision is made. The table below is the contract, not an
// implementation detail; it is evaluated in this order, over the draft's OWN member inside one
// run's evidence.
//
//   0. The run evidence holds no member with the draft's identity — or there is no run evidence
//      at all -> `no-run-evidence` -> REFUSED BY NAME. This is a broken precondition, not an
//      ambiguous signal: the router was not given the input it exists to read.
//   1. The member did not fail — a terminal outcome of passed, healed or skipped with no step
//      verdict false -> `no-failure` -> REFUSED BY NAME. A healed pass is a pass (393-01 F3).
//      Nothing here is a routing question, and either arm would be a wrong answer wearing a
//      correct one's clothes.
//   1b. SOME step carries a typed `limitStop` block -> `indefinitive-failure` -> STOP. The run ran
//      out of an action or planning-turn limit rather than into an answer, so it says nothing
//      about the application, and repairing it could iterate a dead control into a passing test
//      (436 D-14). Evaluated before rule 2, so a verdictSource on another step never makes it
//      definitive; a limit is never a mechanics signal.
//   1c. SOME step the verifier left unproven (`stepOutcomeUnproven`: a condition unverified or
//      inconclusive, none not met) and carrying no mechanics signal -> `indefinitive-failure` ->
//      STOP. Nothing says the application failed, and repairing it would rewrite an unproven claim
//      into a passing one (439 D-07, after 436 D-14's limit stop). An infeasible step keeps its
//      termination as its primary reason (439 D-08) and routes by rule 3.
//   2. SOME step is a CLEAN DEFINITIVE ASSERTION-FAIL — its verifier said no, a `verdictSource`
//      records which path produced that verdict, and that step carries no mechanics signal of
//      its own. Then:
//        2a. no mechanics signal anywhere in the member
//            -> `clean-definitive-assertion-fail` -> STOP, unconditionally.
//        2b. a mechanics signal somewhere else in the member
//            -> `mixed-evidence` -> STOP.
//   3. A mechanics signal on any step, or a member outcome of timeout or cancelled
//      -> `execution-mechanics` -> REPAIR.
//   4. Anything else -> `indefinitive-failure` -> STOP.
//
// WHY RULE 2 IS EVALUATED BEFORE RULE 3, AND WHY AMBIGUITY LANDS IN THE STOP ARM. Repairing a
// clean assertion-fail can only mean rewriting what the test CLAIMS to match what the application
// actually showed, which is oracle capture by construction — the draft class gate 4's corpus
// exists to reject, manufactured by the very loop that is supposed to filter it. So D-08 says a
// clean definitive assertion-fail routes to a stop ALWAYS, which is only true if the clean-fail
// test is asked first; a mechanics-first table would let one unrelated timed-out step pull a
// perfectly clean fail into the repair arm. The same asymmetry decides every remaining case: a
// mis-filed test-wrong costs one human look and is undone by that look, while a mis-routed
// application bug gets iterated into passing and is then indistinguishable from a test that
// always worked. Only the second is unrecoverable, so every class this file cannot place with
// confidence points at the stop arm.
//
// THE MECHANICS SCAN COVERS THE WHOLE MEMBER, NOT THE FAILING STEP. Rule 2's split between 2a and
// 2b is what makes mixed evidence land in a stop, and narrowing the scan to the failing step
// collapses that split: a termination on step 0 and a termination on the failing step would
// classify identically. The frozen corpus carries that exact pair, differing in one integer.
//
// THE MODEL NEVER MAKES THIS DECISION. Both exported functions take a draft IDENTITY and one run
// document. Neither takes a model, a prompt, or any string a model produced — `router.test-d.ts`
// pins both parameter lists as exact tuples, so there is no argument for model output to arrive
// through, and the identity is a lookup key rather than a decision input: every value that
// decides is a field of the run's own `PerTestOutcome` or `StepEvidence`. The model writes nothing
// this arm carries: the stop's payload is projected downstream from the route and from typed facts,
// once the branch is already chosen, and no prose field survives on it (411 D-05).
//
// THE STOP CARRIES REFS, NEVER PAYLOADS (391 D-18, map not territory). WTST-04 asks the stop arm
// to name the exact trace and the a11y snapshot at the failure point; both already live on the
// handoff, the snapshots as `SubActionEvidence.stateBefore` and `stateAfter`, so this arm carries
// coordinates into the run's own durable records. That is also why the loop binds
// `DraftRunPortLike.get` rather than reading `runs.get`'s projection: the per-step sub-action
// evidence these coordinates address does not survive that projection.
//
// THIS FILE DOES NOT WIRE ITSELF IN. Plan 06 owns the stage-5 call site, together with the repair
// arm's consumer, so the two land in one commit and the wiring is never half-connected. `loop.ts`
// keeps its own `routeAfterVerify`, which answers a DIFFERENT question — which outcome a
// disposition implies — and the derivation here is named for the question it answers so the two
// can coexist until plan 06 makes one call the other.

import { stepOutcomeUnproven } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftRef,
  MemberTestOutcome,
  PerTestOutcome,
  RunEvidenceRef,
  StepEvidence,
  VerdictSource,
} from '@vostride/agent-qa-schema'

/**
 * The closed vocabulary of what one member's failure evidence WAS.
 *
 * Six members, because refusing is a classification too: a router that could only answer `repair`
 * or `stop` would have to invent one of them for a run it should not have been handed, and the
 * two refusing classes are how the caller learns which of its own preconditions broke.
 */
export const ROUTER_SIGNAL_CLASSES = [
  'execution-mechanics',
  'clean-definitive-assertion-fail',
  'mixed-evidence',
  'indefinitive-failure',
  'no-failure',
  'no-run-evidence',
] as const

export type RouterSignalClass = (typeof ROUTER_SIGNAL_CLASSES)[number]

/** The single class the repair arm may carry. */
export type RouterRepairSignalClass = 'execution-mechanics'

/** The three classes the stop arm may carry — one definitive, two ambiguous. */
export type RouterStopSignalClass =
  | 'clean-definitive-assertion-fail'
  | 'mixed-evidence'
  | 'indefinitive-failure'

/**
 * The closed set of execution-mechanics signals, spelled once.
 *
 * The first two are read as PRESENCE exactly as gate 1 reads them: a recorded termination block is
 * a turn declaring the step could not be carried out, and narrowing that to today's single `kind`
 * literal would silently reclassify a later one as an assertion problem. The last two are
 * member-level and carried by the outcome rather than by any step, which is why a scan over
 * `StepEvidence` alone cannot see them.
 */
// 2026-10-07 (436-06): 'cycle' and 'stagnation' left with the progress subsystem (D-14); their
// blocks survive only in pre-change handoffs and are no longer read as mechanics.
export const ROUTER_MECHANICS_SIGNALS = [
  'termination',
  'planning-failure',
  'member-timeout',
  'member-cancelled',
] as const

export type RouterMechanicsSignalName = (typeof ROUTER_MECHANICS_SIGNALS)[number]

/** One mechanics signal and where it was found. `stepIndex: null` ⇒ carried by the member. */
export interface MechanicsSignal {
  readonly stepIndex: number | null
  readonly signal: RouterMechanicsSignalName
}

/** Where the failure was observed, in the run's own words. */
export interface RouterFailurePoint {
  readonly runId: string
  readonly stepIndex: number
  /** Pre-interpolation step text, the same rule every other authoring surface follows. */
  readonly stepText: string
  /** The verifier's own reasoning for saying no. */
  readonly reasoning: string
  /** Which path produced the verdict. Absent ⇒ the failure was not definitive. */
  readonly verdictSource?: VerdictSource
}

/**
 * The draft's mechanics need work; nothing here is a claim about the application.
 *
 * Carries `mechanics` and `failingStepIndex`, neither of which exists on {@link StopRoute}.
 * That is deliberate rather than incidental: two records differing only by a `kind` literal are
 * assignable in enough directions to make a type-level unreachability pin decorative, and SC-2's
 * claim is exactly an unreachability claim.
 */
export interface RepairRoute {
  readonly kind: 'repair'
  readonly signalClass: RouterRepairSignalClass
  /** Every signal found, with its location. Non-empty whenever this arm is produced. */
  readonly mechanics: readonly MechanicsSignal[]
  /** The first step whose verifier said no, or `null` for a member-level signal. */
  readonly failingStepIndex: number | null
}

/**
 * The application looks wrong, or the evidence does not say clearly enough to risk repairing — so
 * the loop STOPS here and reports what the run said.
 *
 * Carries `failurePoint` and `evidenceRefs`, neither of which exists on {@link RepairRoute}.
 * `failurePoint` is nullable because rule 4 admits a member that failed at the member level with
 * no step verdict to point at; `evidenceRefs` is not, because a stop a reader cannot trace is not
 * a report.
 *
 * 2026-09-02 (Phase 411): the proposal arm for a correctly-failing draft left with the Issue-slot
 * cleanup.
 */
export interface StopRoute {
  readonly kind: 'stop'
  readonly signalClass: RouterStopSignalClass
  readonly failurePoint: RouterFailurePoint | null
  readonly evidenceRefs: readonly RunEvidenceRef[]
}

export type PostVerifyRoute = RepairRoute | StopRoute

/**
 * The router was handed something that is not a routing question.
 *
 * Named rather than silently answered, on the loop's own precedent: an outcome invented for an
 * input the rules do not cover is a wrong answer at the exact seam where the cardinal error — a
 * real application bug iterated into a passing test — lives.
 */
export class AuthoringRouterUnroutableError extends Error {
  constructor(readonly signalClass: RouterSignalClass) {
    super(
      `authoring router: ${signalClass} is not a routable class; `
        + 'the router decides repair versus stop for a draft that FAILED, '
        + 'and this evidence poses no such question',
    )
    this.name = 'AuthoringRouterUnroutableError'
  }
}

/**
 * Which arm each class produces. THE ONE MAPPING SITE.
 *
 * A table rather than a chain of returns so that the routing decision has a single line per class
 * that a differential can edit and a reader can audit. The phase's mutation driver (since removed)
 * mutated exactly the clean-fail line here and required the corpus to red on the signature row by name.
 */
const ROUTE_ARM_BY_SIGNAL_CLASS = {
  'execution-mechanics': 'repair',
  'clean-definitive-assertion-fail': 'stop',
  'mixed-evidence': 'stop',
  'indefinitive-failure': 'stop',
  'no-failure': 'refuse',
  'no-run-evidence': 'refuse',
} as const satisfies Record<RouterSignalClass, 'repair' | 'stop' | 'refuse'>

/** Member outcomes that are not a failure. A heal is a pass; a skip never ran. */
const NON_FAILING_OUTCOMES: readonly MemberTestOutcome[] = ['passed', 'healed', 'skipped']

/** Member outcomes that ARE an execution-mechanics fact rather than a verdict about the app. */
const MEMBER_MECHANICS: ReadonlyMap<MemberTestOutcome, RouterMechanicsSignalName> = new Map([
  ['timeout', 'member-timeout'],
  ['cancelled', 'member-cancelled'],
])

/** The mechanics signals recorded ON one step, in the declared vocabulary order. */
function stepMechanics(step: StepEvidence): readonly RouterMechanicsSignalName[] {
  const found: RouterMechanicsSignalName[] = []
  if (step.termination !== undefined) found.push('termination')
  if (step.planningFailure !== undefined) found.push('planning-failure')
  return found
}

/** A step a per-step action or planning-turn limit stopped (436 D-12). Never a mechanics signal. */
export function stepLimitStopped(step: StepEvidence): boolean {
  return step.limitStop !== undefined
}

/** A step the verifier left unverified or inconclusive, with nothing not met (439 D-07). */
export function stepUnproven(step: StepEvidence): boolean {
  return stepOutcomeUnproven(step)
}

/** Rule 1c's step: unproven, and no mechanics signal of its own to route it to repair. */
function unprovenWithoutMechanics(step: StepEvidence): boolean {
  return stepUnproven(step) && stepMechanics(step).length === 0
}

/** Every mechanics signal in the member: the whole step scan, then the member-level outcome. */
function scanMechanics(member: PerTestOutcome): readonly MechanicsSignal[] {
  const signals: MechanicsSignal[] = []
  for (const step of member.steps) {
    for (const signal of stepMechanics(step)) signals.push({ stepIndex: step.stepIndex, signal })
  }
  const memberSignal = MEMBER_MECHANICS.get(member.outcome)
  if (memberSignal !== undefined) signals.push({ stepIndex: null, signal: memberSignal })
  return signals
}

function isFailedVerdict(step: StepEvidence): boolean {
  return step.verifierVerdict.pass === false
}

/**
 * A step whose failure is about WHAT THE TEST CLAIMS rather than how it acted.
 *
 * Three conjuncts, all required. The verifier said no; a `verdictSource` records which path
 * produced that verdict, so the answer is definitive rather than an unexplained negative; and the
 * step itself carries no mechanics signal, so the claim was actually evaluated against something.
 */
function firstCleanDefinitiveFail(member: PerTestOutcome): StepEvidence | undefined {
  return member.steps.find(
    (step) =>
      isFailedVerdict(step)
      && step.verdictSource !== undefined
      && stepMechanics(step).length === 0
      && !stepLimitStopped(step),
  )
}

/** The draft's own member, keyed on the stable (filePath, testName) identity — never `testId`. */
function memberFor(
  draftRef: DraftRef,
  handoff: CompletedRunHandoff | undefined,
): PerTestOutcome | undefined {
  return handoff?.tests.find(
    (member) => member.filePath === draftRef.filePath && member.testName === draftRef.testName,
  )
}

/**
 * The ONE classification (the table above, in order). Pure and total over every input.
 *
 * The thin half of the scan, in the shipped `textSimilarity` idiom: this answers the class, and
 * the router below re-reads the same member for the evidence its arm has to carry. A caller that
 * wants only the class — a receipt, a counter, a log line — need not build a route to get it.
 */
export function classifyFailureEvidence(
  draftRef: DraftRef,
  handoff: CompletedRunHandoff | undefined,
): RouterSignalClass {
  const member = memberFor(draftRef, handoff)
  if (member === undefined) return 'no-run-evidence'

  const failed = !NON_FAILING_OUTCOMES.includes(member.outcome) || member.steps.some(isFailedVerdict)
  if (!failed) return 'no-failure'
  if (member.steps.some(stepLimitStopped)) return 'indefinitive-failure'
  if (member.steps.some(unprovenWithoutMechanics)) return 'indefinitive-failure'

  const mechanics = scanMechanics(member)
  if (firstCleanDefinitiveFail(member) !== undefined) {
    return mechanics.length === 0 ? 'clean-definitive-assertion-fail' : 'mixed-evidence'
  }
  if (mechanics.length > 0) return 'execution-mechanics'
  return 'indefinitive-failure'
}

/** The coordinates addressing one step's trace and every a11y snapshot recorded under it. */
function evidenceRefsFor(
  runId: string,
  member: PerTestOutcome,
  step: StepEvidence,
): readonly RunEvidenceRef[] {
  const base = { runId, filePath: member.filePath, testName: member.testName, stepIndex: step.stepIndex }
  const refs: RunEvidenceRef[] = [{ ...base, channel: 'step-trace' }]
  step.subActions.forEach((subAction, subActionIndex) => {
    refs.push({ ...base, subActionIndex, channel: 'state-before' })
    if (subAction.stateAfter !== undefined) {
      refs.push({ ...base, subActionIndex, channel: 'state-after' })
    }
  })
  return refs
}

/**
 * THE stop arm's evidence, from ONE step of ONE member. One derivation, two callers.
 *
 * Both callers below build the same two fields from the same walk: `routeRepairOrStop`'s stop arm,
 * and {@link stopRouteForAbandonedRepair} for a repair that was abandoned. They are one function
 * rather than two similar blocks because the alternative was measured — the exhausted arm shipped
 * an empty literal (`failurePoint: null`, `evidenceRefs: []`) beside a routed handoff it never
 * read, and every cell over that arm passed (394-VERIFICATION, CR-02). A construction copied into
 * a second module drifts from this one the first time either side is edited.
 *
 * `undefined` in means the member has no step to point at, which is the ONLY case that yields a
 * null point and no refs — the nullability rule the stop arm has always documented.
 */
function stopEvidenceFor(
  runId: string,
  member: PerTestOutcome,
  point: StepEvidence | undefined,
): Pick<StopRoute, 'failurePoint' | 'evidenceRefs'> {
  if (point === undefined) return { failurePoint: null, evidenceRefs: [] }
  return {
    failurePoint: {
      runId,
      stepIndex: point.stepIndex,
      stepText: point.stepText,
      reasoning: point.verifierVerdict.reasoning,
      ...(point.verdictSource === undefined ? {} : { verdictSource: point.verdictSource }),
    },
    evidenceRefs: evidenceRefsFor(runId, member, point),
  }
}

/**
 * The stop arm for a repair the loop ABANDONED, over the run the router already read (CR-02).
 *
 * WHY IT LIVES HERE AND NOT AT THE CALL SITE. An exhausted or prefix-regressed repair produces the
 * same artifact class as a first-pass stop — `routeAfterVerify`'s own header says so — and that
 * class's evidence is derived in exactly one place. Building it in `loop.ts` would be a second
 * answer to "which step does this stop point at", assembled from the same fields, free to
 * disagree; building it from a literal is what shipped, and a durable stop with no failure point
 * and no refs is unauditable by construction (T-394-90).
 *
 * `signalClass` is `indefinitive-failure` and nothing else: the classification the run's own
 * evidence carried belonged to the REPAIR arm (`execution-mechanics`), and repair having failed is
 * a fact about the loop rather than a new reading of the run. A repair-prefixed class would be a
 * string outside {@link ROUTER_SIGNAL_CLASSES}, which is the WR-09 defect this file already closed.
 *
 * `failingStepIndex` is the repair route's own — the step the loop tried to fix — so the stop
 * points where the repair was aimed. `null` (a member-level signal) falls back to the first step
 * the verifier rejected, and a member with neither yields a null point rather than a fabricated one.
 */
export function stopRouteForAbandonedRepair(
  draftRef: DraftRef,
  handoff: CompletedRunHandoff,
  failingStepIndex: number | null,
): StopRoute {
  const member = memberFor(draftRef, handoff)
  if (member === undefined) {
    // Unreachable through the loop — reaching a repair arm at all means this member was found —
    // and answered rather than thrown, because repair has already been spent by the time this is
    // called and a throw here would lose the abandonment the caller is filing.
    return {
      kind: 'stop',
      signalClass: 'indefinitive-failure',
      failurePoint: null,
      evidenceRefs: [],
    }
  }
  const named = failingStepIndex === null
    ? undefined
    : member.steps.find((step) => step.stepIndex === failingStepIndex)
  return {
    kind: 'stop',
    signalClass: 'indefinitive-failure',
    ...stopEvidenceFor(handoff.runId, member, named ?? member.steps.find(isFailedVerdict)),
  }
}

/**
 * The one deterministic repair-versus-stop derivation (D-08).
 *
 * Pure: it reads the run document and mutates nothing. Total over every classification the table
 * produces — the two non-routing classes refuse BY NAME rather than returning an arm, which is
 * the loop's own posture for a case a later plan owns.
 *
 * The caller supplies the handoff of the run whose evidence the receipt's gates judged; choosing
 * among an evaluation's several runs is the stage-5 wiring's job, and lands with plan 06.
 */
export function routeRepairOrStop(
  draftRef: DraftRef,
  handoff: CompletedRunHandoff | undefined,
): PostVerifyRoute {
  const signalClass = classifyFailureEvidence(draftRef, handoff)
  const arm = ROUTE_ARM_BY_SIGNAL_CLASS[signalClass]
  if (arm === 'refuse') throw new AuthoringRouterUnroutableError(signalClass)

  const member = memberFor(draftRef, handoff)
  if (member === undefined || handoff === undefined) {
    throw new AuthoringRouterUnroutableError('no-run-evidence')
  }

  const failingStep = member.steps.find(isFailedVerdict)
  if (arm === 'repair') {
    return {
      kind: 'repair',
      signalClass: 'execution-mechanics',
      mechanics: scanMechanics(member),
      failingStepIndex: failingStep?.stepIndex ?? null,
    }
  }

  // The stop points at the step a limit stopped when there is one (that is why it stopped), then
  // at the step the verifier left unproven, then at the step whose CLAIM failed, and otherwise at
  // the first step the verifier rejected — never
  // at a step chosen because it carried a mechanics signal, which would name a symptom of the run
  // rather than the application behaviour.
  const point = member.steps.find(stepLimitStopped)
    ?? member.steps.find(unprovenWithoutMechanics)
    ?? firstCleanDefinitiveFail(member)
    ?? failingStep
  return {
    kind: 'stop',
    signalClass: signalClass as RouterStopSignalClass,
    ...stopEvidenceFor(handoff.runId, member, point),
  }
}
