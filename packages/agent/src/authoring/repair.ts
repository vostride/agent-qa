// Repair is fenced twice: paths are checked before a run, and the probe re-checks the prefix.
// expressed as a type, pinned by the `@ts-expect-error` cell in `router.test-d.ts` and by the
// The patch applier lives in `core`, which this package cannot import, so the host binds it.

import {
  RUN_EVIDENCE_CHANNELS,
  TestEditPatchSetSchema,
  parseJsonPointer,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftReceipt,
  DraftRef,
  PerTestOutcome,
  StepEvidence,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'

// `loop.ts` imports this module for `repairDraft`; both names are only touched inside a call.
import { DraftSecretMarkerRefusedError, refuseLiteralSecretMarkers } from './loop.js'
import type { DraftRunPortLike, DraftShelfPortLike, ParsedDraftLike } from './ports.js'
import type { RepairRoute } from './router.js'
import { missingStatedValues, statedValuesMissingReason } from './stated-values.js'
import { buildTieredPrompt } from '../prompt/tiered-prompt-builder.js'

export const REPAIR_ITERATION_CAP = 3

// Names the compile op, because a repair is a stage of that op, not an op of its own.
export const REPAIR_AGENT_CONTEXT =
  'authoring.draft.write — repair a draft that failed for a test reason'

// Only the leading passed steps are protected: a step after the failure never ran.
export interface PassingPrefix {
  /** The run this prefix was read out of — carried so a refusal can name its own evidence. */
  readonly runId: string
  /** Steps `[0, length)` passed. Zero means nothing is protected. */
  readonly length: number
}

// Returned, not thrown, so a fenced patch still spends an iteration and the loop terminates.
export class PassingPrefixViolationError extends Error {
  constructor(
    readonly path: string,
    readonly stepIndex: number,
    readonly prefix: PassingPrefix,
  ) {
    super(
      `repair: the patch path ${path} addresses step ${stepIndex}, which is inside the `
        + `passing prefix of ${prefix.length} step(s) established by run ${prefix.runId}; `
        + 'the whole patch set is refused before anything runs',
    )
    this.name = 'PassingPrefixViolationError'
  }
}

// The probe broke a protected step it did not name; the four fields address the probed member.
export class PassingPrefixRegressedError extends Error {
  constructor(
    readonly stepIndex: number,
    readonly runId: string,
    readonly filePath: string,
    readonly testName: string,
  ) {
    super(
      `repair: probe run ${runId} shows step ${stepIndex} failing, and that step passed in the `
        + 'best prior run; the candidate is discarded and repair ends',
    )
    this.name = 'PassingPrefixRegressedError'
  }
}

/**
 * K iterations were spent and none produced a passing probe.
 *
 * Carries the count and the LAST refusal so a caller can distinguish two very different reports: we
 * tried K times and the model kept missing, versus every patch it proposed was fenced. A bare
 * boolean collapses them, and they call for opposite things from the person reading the result.
 */
export class RepairExhaustedError extends Error {
  constructor(
    readonly iterations: number,
    readonly lastRefusal: string,
  ) {
    super(
      `repair: ${iterations} iteration(s) produced no passing probe; the last one ended with: `
        + lastRefusal,
    )
    this.name = 'RepairExhaustedError'
  }
}

/** Why repair stopped without a repaired draft. Two named reasons, never a bare `false`. */
export type RepairAbandonment =
  | { readonly kind: 'exhausted'; readonly error: RepairExhaustedError }
  | { readonly kind: 'prefix-regressed'; readonly error: PassingPrefixRegressedError }

// `iterations` is on both arms, so a successful repair's cost is reported too.
export type RepairOutcome =
  | {
      readonly kind: 'repaired'
      readonly draft: ParsedDraftLike
      readonly receipt: DraftReceipt
      readonly iterations: number
      readonly probeRunIds: readonly string[]
    }
  | {
      readonly kind: 'abandoned'
      readonly abandonment: RepairAbandonment
      readonly iterations: number
      readonly probeRunIds: readonly string[]
    }

/**
 * What repair needs from its host.
 *
 * `handoff` is the BEST PRIOR RUN — the run the receipt's gates judged — and it is where both the
 * prefix and the repair prompt's evidence come from. It is a parameter rather than something this
 * module fetches, on the router's own posture: choosing among an evaluation's several runs is the
 * stage-5 wiring's job, and a module that picked one itself would be a second answer to a question
 * the wiring already has to answer.
 */
export interface RepairDeps {
  readonly draft: ParsedDraftLike
  readonly handoff: CompletedRunHandoff
  readonly shelf: DraftShelfPortLike
  readonly runs: DraftRunPortLike
  // Read off the receipt stage 4 minted, and absent when the invocation had none.
  readonly sessionRef?: string
  // Handed in: the repaired candidate joins the same suite as the draft.
  readonly targetSuitePath?: string
  // The request's stated values, which no repair patch may lose.
  readonly statedValues: readonly string[]
}

// ---- the prefix ------------------------------------------------------------------------------

function draftMember(
  draftRef: DraftRef | ParsedDraftLike,
  handoff: CompletedRunHandoff | undefined,
): PerTestOutcome | undefined {
  return handoff?.tests.find(
    (member) => member.filePath === draftRef.filePath && member.testName === draftRef.testName,
  )
}

function stepFailed(step: StepEvidence): boolean {
  return step.verifierVerdict.pass === false
}

/**
 * The leading contiguous run of steps that passed, read out of the best prior run.
 *
 * A run with no member for this draft yields a prefix of zero, which protects nothing — the honest
 * answer, since a prefix asserted with no evidence behind it would fence a repair out of a region
 * nobody has ever seen work.
 */
export function derivePassingPrefix(
  draftRef: DraftRef | ParsedDraftLike,
  handoff: CompletedRunHandoff | undefined,
): PassingPrefix {
  const runId = handoff?.runId ?? ''
  const member = draftMember(draftRef, handoff)
  if (member === undefined) return { runId, length: 0 }

  let length = 0
  for (const step of member.steps) {
    if (stepFailed(step)) break
    length += 1
  }
  return { runId, length }
}

/**
 * Which step position a pointer addresses, if any.
 *
 * `'all'` is not "no step" — it is EVERY step, and it is what the whole-document pointer and the
 * bare `/steps` pointer address. Both are treated as reaching into the prefix, because a patch
 * that replaces the step sequence wholesale reaches the protected part of it too.
 */
function stepPositionAddressedBy(path: string): number | 'all' | null {
  const segments = parseJsonPointer(path)
  if (segments.length === 0) return 'all'
  if (segments[0] !== 'steps') return null
  if (segments.length === 1) return 'all'
  const index = Number(segments[1])
  return Number.isInteger(index) && index >= 0 ? index : 'all'
}

// An `add` addresses its position because it shifts every later step, the prefix included.
export function fencePatchAgainstPassingPrefix(
  patchSet: TestEditPatchSet,
  prefix: PassingPrefix,
): PassingPrefixViolationError | null {
  for (const op of patchSet.patches) {
    const position = stepPositionAddressedBy(op.path)
    if (position === null) continue
    if (position === 'all') {
      if (prefix.length > 0) return new PassingPrefixViolationError(op.path, 0, prefix)
      continue
    }
    if (position < prefix.length) {
      return new PassingPrefixViolationError(op.path, position, prefix)
    }
  }
  return null
}

// Returned, not thrown, so a model emitting only renames still terminates.
export class RepairIdentityViolationError extends Error {
  constructor(readonly path: string) {
    super(
      `repair: the patch path ${path} changes the test's identity rather than its mechanics; `
        + 'a renamed test is a different test, so the whole patch set is refused before anything runs',
    )
    this.name = 'RepairIdentityViolationError'
  }
}

// No repair may rename: the suite target is a slug of the name, read before and after repair.
export function fencePatchAgainstDraftIdentity(
  patchSet: TestEditPatchSet,
): RepairIdentityViolationError | null {
  for (const op of patchSet.patches) {
    if (parseJsonPointer(op.path)[0] === 'name') {
      return new RepairIdentityViolationError(op.path)
    }
  }
  return null
}

// Returned rather than thrown, so the caller counts it against K.
export class RepairStatedValueViolationError extends Error {
  constructor(readonly missingValues: readonly string[]) {
    super(
      `repair: ${statedValuesMissingReason(missingValues)}; `
        + 'the whole patch set is refused before anything runs',
    )
    this.name = 'RepairStatedValueViolationError'
  }
}

export function fencePatchAgainstStatedValues(
  draft: ParsedDraftLike,
  statedValues: readonly string[],
): RepairStatedValueViolationError | null {
  const missing = missingStatedValues(statedValues, draft.steps)
  return missing.length > 0 ? new RepairStatedValueViolationError(missing) : null
}

// An absent prefix step is no regression: a probe that stopped early recorded no verdict on it.
function prefixRegression(
  draft: ParsedDraftLike,
  probe: CompletedRunHandoff | undefined,
  prefix: PassingPrefix,
): PassingPrefixRegressedError | null {
  const member = draftMember(draft, probe);
  if (member === undefined || probe === undefined) return null
  for (const step of member.steps) {
    if (step.stepIndex < prefix.length && stepFailed(step)) {
      return new PassingPrefixRegressedError(
        step.stepIndex,
        probe.runId,
        draft.filePath,
        draft.testName,
      )
    }
  }
  return null
}

// A heal is a pass; a skip never ran.
const PROBE_PASSING_OUTCOMES: readonly string[] = ['passed', 'healed']

function probePassed(draft: ParsedDraftLike, probe: CompletedRunHandoff | undefined): boolean {
  const member = draftMember(draft, probe)
  if (member === undefined) return false
  return PROBE_PASSING_OUTCOMES.includes(member.outcome) && !member.steps.some(stepFailed)
}

// ---- the repair prompt -------------------------------------------------------------------------

/**
 * The failure, in the run's OWN words plus coordinates into its durable records.
 *
 * The trace is rendered as text because a prompt is text; the a11y screen states are rendered as
 * CHANNEL COORDINATES rather than as inlined snapshots, in the same map-not-territory posture the
 * finding arm takes. A pasted element tree would be a second copy of a record the run already
 * holds, and a large one — the model gets what it needs to ask for the right edit, not the whole
 * screen.
 */
function failureBlockBody(route: RepairRoute, member: PerTestOutcome | undefined): string {
  const lines: string[] = []
  lines.push(`mechanics signals: ${route.mechanics.map((signal) => signal.signal).join(', ')}`)
  if (route.failingStepIndex === null) {
    lines.push('the failure is recorded at the member level, with no step to point at')
  }
  for (const step of member?.steps ?? []) {
    const marker = step.stepIndex === route.failingStepIndex ? ' <- FAILED HERE' : ''
    lines.push(`step ${step.stepIndex}: ${step.stepText}${marker}`)
    lines.push(`  verdict: ${step.verifierVerdict.pass ? 'pass' : 'fail'} — ${step.verifierVerdict.reasoning}`)
    if (step.stepIndex !== route.failingStepIndex) continue
    step.subActions.forEach((subAction, subActionIndex) => {
      lines.push(`  plan: ${subAction.plan}`)
      for (const channel of RUN_EVIDENCE_CHANNELS) {
        if (channel === 'step-trace') continue
        if (channel === 'state-after' && subAction.stateAfter === undefined) continue
        lines.push(`  a11y ${channel}: step ${step.stepIndex} sub-action ${subActionIndex}`)
      }
    })
  }
  return lines.join('\n')
}

/**
 * The repair prompt: two drafts, and the parameter names carry which is which.
 *
 * `originalDraft` is the draft the handoff's run EXECUTED, and the failure block joins on it. The
 * host mints a shelf path from the content digest, so `candidate` lives at a new `filePath` from
 * iteration 2 onward and joining the handoff on it returns no member at all — a block that
 * collapses to the mechanics-signals line with no arm and no counter. Two names rather than one
 * parameter and a comment, so the stability is visible in the signature.
 */
function repairPromptFor(
  route: RepairRoute,
  originalDraft: ParsedDraftLike,
  candidate: ParsedDraftLike,
  handoff: CompletedRunHandoff,
  lastRefusal: string | undefined,
): ReturnType<typeof buildTieredPrompt> {
  return buildTieredPrompt({
    agent_context: REPAIR_AGENT_CONTEXT,
    stable: [
      {
        title: 'Role',
        body: 'You repair the MECHANICS of an agent-qa test draft that could not be carried out. '
          + 'Emit ONE JSON object and nothing else: {"thoughts": string, "patches": [...]}, where '
          + 'each patch is an RFC-6902 add, remove or replace whose path is a JSON Pointer into '
          + 'the test document. You may not change what the test CLAIMS in order to make it pass, '
          + 'and you may not touch a step that already worked.',
      },
    ],
    context: [
      // The two titles carry the two numberings. An index in the block below addresses the run's
      // draft; an index in the block above addresses the candidate the next patch will be applied
      // to. They diverge as soon as a patch adds or removes a step.
      {
        title: 'The draft as it stands (numbered against the current candidate)',
        body: candidate.steps.map((step, index) => `${index}: ${step}`).join('\n'),
      },
      {
        title: `What happened in run ${handoff.runId} (steps numbered against the draft that run executed)`,
        body: failureBlockBody(route, draftMember(originalDraft, handoff)),
      },
    ],
    volatile: lastRefusal === undefined
      ? []
      : [{ title: 'Why the previous attempt was not kept', body: lastRefusal }],
  })
}

/** Every probe is ONE gate-run over the draft file and nothing else. */
function probeStartInput(draft: ParsedDraftLike): Parameters<DraftRunPortLike['start']>[0] {
  return { patterns: [draft.filePath], gateRun: true, excludedFromOutcomes: true }
}

// ---- the loop -----------------------------------------------------------------------------------

// One probe per iteration and one full stability gate at the end; probes mint no receipt.
export async function repairDraft(route: RepairRoute, deps: RepairDeps): Promise<RepairOutcome> {
  const prefix = derivePassingPrefix(deps.draft, deps.handoff)
  const model = await deps.shelf.model()

  let candidate = deps.draft
  let lastRefusal = 'no iteration was taken'
  // Probe runs actually started; `iterations` also counts fenced emissions that started nothing.
  const probeRunIds: string[] = []

  for (let iteration = 1; iteration <= REPAIR_ITERATION_CAP; iteration += 1) {
    const emitted = await model.generate(
      repairPromptFor(
        route,
        deps.draft,
        candidate,
        deps.handoff,
        iteration === 1 ? undefined : lastRefusal,
      ),
    )

    const parsed = parsePatchSet(emitted.text)
    if (typeof parsed === 'string') {
      // An unusable emission spends an iteration exactly as a fenced patch does. It is not retried
      // for free: a hidden retry would make the fan-out preview a number that does not describe
      // what happens, which is the same argument the compile stage's single model call rests on.
      lastRefusal = parsed
      continue
    }

    const violation = fencePatchAgainstPassingPrefix(parsed, prefix)
    if (violation !== null) {
      // THE ITERATION IS SPENT AND NOTHING RAN. Both halves matter: nothing ran, so a refused
      // patch costs no child process; and the iteration is spent, so a model emitting only fenced
      // patches still terminates.
      lastRefusal = violation.message
      continue
    }

    // A rename is refused, the try spent and nothing run; the prefix fence may answer first.
    const identityViolation = fencePatchAgainstDraftIdentity(parsed)
    if (identityViolation !== null) {
      lastRefusal = identityViolation.message
      continue
    }

    const staged = await deps.shelf.applyPatches(candidate, parsed)
    if (staged.kind === 'unparsable') {
      lastRefusal = `the patched document did not parse: ${staged.reason}`
      continue
    }

    // The try is spent, nothing runs and `candidate` stays put.
    const valueViolation = fencePatchAgainstStatedValues(staged.draft, deps.statedValues)
    if (valueViolation !== null) {
      lastRefusal = valueViolation.message
      continue
    }

    // A literal `[secret:NAME]` spends the try and starts no probe.
    try {
      refuseLiteralSecretMarkers(staged.draft)
    } catch (error) {
      if (!(error instanceof DraftSecretMarkerRefusedError)) throw error
      lastRefusal = error.message
      continue
    }

    const acknowledgement = await deps.runs.start(probeStartInput(staged.draft))
    probeRunIds.push(acknowledgement.runId)
    const probe = await deps.runs.get(acknowledgement.runId)

    const regression = prefixRegression(staged.draft, probe, prefix)
    if (regression !== null) {
      return {
        kind: 'abandoned',
        abandonment: { kind: 'prefix-regressed', error: regression },
        iterations: iteration,
        probeRunIds: [...probeRunIds],
      }
    }

    if (probePassed(staged.draft, probe)) {
      // The pinned-N gate, WITHOUT the draft-mode marker — the whole point of stabilising at the
      // end. `stabilityRunsRequested` reaching the disposition table as `DRAFT_STABILITY_RUNS_N`
      // rather than as 1 is what lets a repaired draft be anything other than `unverified`.
      const receipt = await deps.shelf.verifyDraft({
        draftPath: staged.draft.filePath,
        ...(deps.sessionRef === undefined ? {} : { sessionRef: deps.sessionRef }),
        ...(deps.targetSuitePath === undefined
          ? {}
          : { targetSuitePath: deps.targetSuitePath }),
      })
      return {
        kind: 'repaired',
        draft: staged.draft,
        receipt,
        iterations: iteration,
        probeRunIds: [...probeRunIds],
      }
    }

    candidate = staged.draft
    lastRefusal = `probe run ${acknowledgement.runId} did not pass`
  }

  return {
    kind: 'abandoned',
    abandonment: {
      kind: 'exhausted',
      error: new RepairExhaustedError(REPAIR_ITERATION_CAP, lastRefusal),
    },
    iterations: REPAIR_ITERATION_CAP,
    probeRunIds: [...probeRunIds],
  }
}

/**
 * The model's emission as a patch set, or the reason it is not one.
 *
 * A string return rather than a throw, because an unusable emission is an ordinary thing for a
 * model to produce and the loop's answer to it is to spend an iteration, not to fail the draft.
 */
function parsePatchSet(text: string): TestEditPatchSet | string {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return `the model did not emit JSON: ${error instanceof Error ? error.message : String(error)}`
  }
  const parsed = TestEditPatchSetSchema.safeParse(json)
  if (!parsed.success) {
    return `the model emitted JSON that is not a patch set: ${parsed.error.message}`
  }
  return parsed.data
}

