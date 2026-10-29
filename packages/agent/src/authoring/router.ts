// A clean assertion-fail is checked before mechanics, so it always stops; ambiguity stops too.

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

// Carries fields `StopRoute` lacks, so the two routes are not assignable to each other.
export interface RepairRoute {
  readonly kind: 'repair'
  readonly signalClass: RouterRepairSignalClass
  /** Every signal found, with its location. Non-empty whenever this arm is produced. */
  readonly mechanics: readonly MechanicsSignal[]
  /** The first step whose verifier said no, or `null` for a member-level signal. */
  readonly failingStepIndex: number | null
}

// `failurePoint` may be null for a member-level failure; `evidenceRefs` always traces it.
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

// One line per class, so the routing decision is a single auditable edit.
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

/** A step a per-step action or planning-turn limit stopped. Never a mechanics signal. */
export function stepLimitStopped(step: StepEvidence): boolean {
  return step.limitStop !== undefined
}

/** A step the verifier left unverified or inconclusive, with nothing not met. */
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

// Shared by the routed stop and the abandoned-repair stop, so both point at the same step.
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

// An abandoned repair stops as `indefinitive-failure`, a class inside `ROUTER_SIGNAL_CLASSES`.
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

// Pure; the two non-routing classes refuse by name instead of returning an arm.
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
