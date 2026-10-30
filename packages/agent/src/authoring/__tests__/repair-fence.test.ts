// Tested both ways: a prefix-touching patch is refused, and one outside the prefix reaches a run.

import {
  AUTHORING_REPAIR_ABANDONMENTS,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
  TestEditPatchSetSchema,
  authoredSuiteTargetPath,
  computeDraftDisposition,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftReceipt,
  DraftRef,
  RunsStartInput,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { memberOutcome, runDocument, shelfPathForDigest } from './evidence-fixtures.js'
import type { MemberFixture } from './evidence-fixtures.js'
import { routeRepairOrStop } from '../router.js'
import type { RepairRoute } from '../router.js'
import type {
  DraftRunPortLike,
  DraftStageOutcome,
  ParsedDraftLike,
} from '../ports.js'

/** The subject, resolved per cell. Absent it, each cell reds by NAME rather than the file. */
async function loadRepair(): Promise<typeof import('../repair.js')> {
  return await import('../repair.js')
}

// ---- the draft and its best prior run ---------------------------------------------------------

const DRAFT: ParsedDraftLike = {
  testId: 't_repair-fixture',
  filePath: 'tests/.agent-qa-drafts/repair-fixture.yaml',
  testName: 'Submit the local account form',
  target: 'local-form',
  steps: [
    'Open the local account form',
    'Type "alice" into the Username field',
    'Click the Submit button',
    'Verify the confirmation banner says "Saved"',
  ],
  contentDigest: 'digest-repair-0',
}

const DRAFT_REF: DraftRef = {
  filePath: DRAFT.filePath,
  testId: DRAFT.testId,
  testName: DRAFT.testName,
  contentDigest: DRAFT.contentDigest,
}

/**
 * The best prior run: steps 0 and 1 passed, step 2 could not be carried out.
 *
 * Step 3 has no evidence at all because the run stopped — which is what a real member looks like
 * and is why the prefix is derived from the leading contiguous PASSING run rather than from
 * "every step that is not failed". A prefix of `{0,1,3}` would protect a step nobody ever saw
 * pass.
 */
const BEST_PRIOR_MEMBER: MemberFixture = {
  filePath: DRAFT.filePath,
  testName: DRAFT.testName,
  outcome: 'failed',
  steps: [
    [{ type: 'navigate', url: 'http://127.0.0.1:8931/form.html' }],
    [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
    [{ type: 'click', ref: 'e9', role: 'button', name: 'submit', success: false }],
  ],
  failedSteps: [2],
  infeasibleSteps: [2],
}

const BEST_PRIOR_RUN: CompletedRunHandoff = runDocument('r_best-prior', [BEST_PRIOR_MEMBER])

/** The route repair is entered through — PRODUCED by the shipped router, never a literal. */
function repairRoute(): RepairRoute {
  const route = routeRepairOrStop(DRAFT_REF, BEST_PRIOR_RUN)
  if (route.kind !== 'repair') {
    throw new Error(`the fixture must route to repair, and it routed to ${route.kind}`)
  }
  return route
}

// ---- the patch corpus, every member validated by the shipped schema ----------------------------
//
// Built through `TestEditPatchSetSchema.parse` rather than as type literals, so no cell can pin a
// patch shape the schema would reject: an unproducible fixture reds under every mutation and can
// therefore never tell a vacuous corpus from a real closure.

function patchSet(thoughts: string, patches: readonly unknown[]): TestEditPatchSet {
  return TestEditPatchSetSchema.parse({ thoughts, patches })
}

/** Names step 1 — INSIDE the passing prefix. The static fence's positive case. */
const PREFIX_TOUCHING = patchSet('retype the username', [
  { op: 'replace', path: '/steps/1', value: 'Type "bob" into the Username field' },
])

/** Names step 2 — OUTSIDE the prefix. The ALLOW case; without it a total refusal would pass. */
const OUTSIDE_PREFIX = patchSet('name the submit control the way the page labels it', [
  { op: 'replace', path: '/steps/2', value: 'Click the "Save account" button' },
])

/**
 * Names no step at all — and RENAMES THE TEST, which is the identity fence's rejected case.
 *
 * Two fences read this one patch set and they answer differently, which is the point. The prefix
 * fence ADMITS it, correctly: its contract is step positions, and `/name` addresses none. The
 * identity fence refuses it, because `/name` is what the test IS, and repair's grant is mechanics.
 */
const NON_STEP = patchSet('retitle', [
  { op: 'replace', path: '/name', value: 'Submit the local account form and confirm' },
])

/** What {@link NON_STEP} renames the test to — read by the applier-integrity cell. */
const RENAMED_TO = 'Submit the local account form and confirm'

/** An `add` at index 0 shifts every later step, so it addresses the prefix even though it names it once. */
const PREFIX_SHIFTING = patchSet('open the page first', [
  { op: 'add', path: '/steps/0', value: 'Wait for the local account form to load' },
])

/** One legal op and one prefix-touching op: the WHOLE set must be refused, not the legal half kept. */
const MIXED_SET = patchSet('two edits', [
  { op: 'replace', path: '/steps/2', value: 'Click the "Save account" button' },
  { op: 'remove', path: '/steps/0' },
])

const CORPUS: readonly (readonly [string, TestEditPatchSet])[] = [
  ['prefix-touching', PREFIX_TOUCHING],
  ['outside-prefix', OUTSIDE_PREFIX],
  ['non-step', NON_STEP],
  ['prefix-shifting', PREFIX_SHIFTING],
  ['mixed-set', MIXED_SET],
]

// ---- the scripted host ------------------------------------------------------------------------

/**
 * How many patches this harness will hand out before it refuses — the INSTRUMENT's own bound.
 *
 * Measured, not guessed. An implementation in which a fenced patch does not consume an iteration
 * does not FAIL the adversarial cells below: it never returns from them. Mutation C was run
 * without this ceiling and vitest reported a killed worker and a V8 heap exhaustion after 26s,
 * with no cell named at all — a differential whose red says only "something hung" has not shown
 * which property broke. Neither does a per-cell timeout rescue it, because vitest's timeout marks
 * a cell failed without interrupting the loop, which then exhausts the heap anyway.
 *
 * So the instrument carries the bound instead. Twelve is four times K: comfortably above any
 * legitimate sequence, and finite, so an unbounded loop reds by NAME on the cell that provoked it
 * rather than taking the whole file down with it.
 */
const HARNESS_EMISSION_CEILING = 12

interface ProbeScript {
  /** One entry per probe, in order. `undefined` models a probe whose record is unreadable. */
  readonly probes: readonly (readonly MemberFixture[] | undefined)[]
  /** Probe indices the run boundary refuses: `start` throws {@link RunRefusal} for them. */
  readonly refuseProbes?: readonly number[]
  /** The final stability gate is refused the same way: its gate runs never start. */
  readonly refuseVerify?: boolean
}

/**
 * A refusal the host's run boundary raises when a start is refused. What repair must do with it is
 * the same for any refusal a start throws.
 */
class RunRefusal extends Error {
  constructor() {
    super('The run port refused to start this run.')
    this.name = 'RunRefusal'
  }
}

interface Harness {
  readonly deps: Record<string, unknown>
  readonly promptsSeen: string[]
  readonly startInputs: RunsStartInput[]
  readonly appliedSets: TestEditPatchSet[]
  readonly appliedDrafts: ParsedDraftLike[]
  readonly verifyCalls: number[]
  readonly receipt: DraftReceipt
}

/**
 * The receipt the FINAL stability gate answers with — the one receipt a repair sequence mints.
 *
 * Built through `DraftReceiptSchema.parse` rather than cast, so this fixture cannot pin a receipt
 * shape the store would reject; its `disposition` is what `computeDraftDisposition` answers for
 * its own gate booleans, which is what the derivation cell below re-checks.
 */
const FINAL_RECEIPT: DraftReceipt = DraftReceiptSchema.parse({
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: { ...DRAFT_REF, contentDigest: 'digest-repair-final' },
  gates: {
    executesDefinitive: { pass: true, runRefs: ['r_probe-0'], indefinitiveRunRefs: [] },
    stableVerdict: {
      pass: true,
      runRefs: ['r_probe-0'],
      distinctOutcomes: ['passed'],
      earlyStopped: false,
    },
    addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
    falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
  },
  stepTable: [],
  gateRuns: [],
  addsValueFinding: { novelElements: ['el:button "submit"'], comparedTests: [] },
  stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
  stabilityRunsCompleted: DRAFT_STABILITY_RUNS_N,
  disposition: 'keep-eligible',
  evaluatedAt: 1,
})

/** The four booleans a `DraftGateResults` carries, in the evaluator's own reading (`.pass`). */
function gateBooleans(receipt: DraftReceipt) {
  return {
    executesDefinitive: receipt.gates.executesDefinitive.pass,
    stableVerdict: receipt.gates.stableVerdict.pass,
    addsValue: receipt.gates.addsValue.pass,
    falsifiableAssertion: receipt.gates.falsifiableAssertion.pass,
  }
}

// Honours `/name` and moves the path, as the real applier and `stageDraft` do, so cells can fail.
function applyPatchesToDraft(draft: ParsedDraftLike, set: TestEditPatchSet): ParsedDraftLike {
  const steps = [...draft.steps]
  let testName = draft.testName
  for (const op of set.patches) {
    const segments = op.path.split('/').slice(1)
    if (segments[0] === 'name' && op.op === 'replace') {
      testName = op.value
      continue
    }
    if (segments[0] !== 'steps') continue
    const index = Number(segments[1])
    if (!Number.isInteger(index)) continue
    if (op.op === 'replace') steps[index] = op.value
    if (op.op === 'add') steps.splice(index, 0, op.value)
    if (op.op === 'remove') steps.splice(index, 1)
  }
  const contentDigest = `${draft.contentDigest}+${set.patches.length}`
  return {
    ...draft,
    steps,
    testName,
    contentDigest,
    filePath: shelfPathForDigest(draft.filePath, contentDigest),
  }
}

function harness(
  emissions: readonly string[],
  script: ProbeScript,
  /** Runs already on record, addressed by id — what stage 5's routing handoff reads. */
  preloaded: Readonly<Record<string, readonly MemberFixture[]>> = {},
  statedValues: readonly string[] = [],
): Harness {
  const promptsSeen: string[] = []
  const startInputs: RunsStartInput[] = []
  const appliedSets: TestEditPatchSet[] = []
  const appliedDrafts: ParsedDraftLike[] = []
  const verifyCalls: number[] = []
  const documents = new Map<string, CompletedRunHandoff | undefined>(
    Object.entries(preloaded).map(([runId, members]) => [runId, runDocument(runId, members)]),
  )
  let emitted = 0

  const runs: DraftRunPortLike = {
    async start(input: RunsStartInput) {
      const index = startInputs.length
      startInputs.push(input)
      if (script.refuseProbes?.includes(index) === true) throw new RunRefusal()
      const runId = `r_probe-${index}`
      const members = script.probes[index]
      // A RUN'S MEMBERS CARRY THE PATH IT WAS POINTED AT. The probe runs the STAGED candidate, whose
      // path moved with the patch above, so a scripted member keeping the pre-repair path would
      // describe a file this run never opened — and `draftMember` joins on exactly that pair. The
      // script says what the run FOUND; the harness supplies where it looked.
      const probedPath = (input.patterns?.[0] as string | undefined) ?? DRAFT.filePath
      documents.set(
        runId,
        members === undefined
          ? undefined
          : runDocument(runId, members.map((member) => ({ ...member, filePath: probedPath }))),
      )
      return {
        runId,
        scope: { tier: 'product', key: 'local-form' },
        executionContext: 'local-headless',
        buildOrdinal: 1,
        startedAt: 0,
        testCount: 1,
        gateRun: true,
        excludedFromOutcomes: true,
      } as never
    },
    async get(runId: string) {
      return documents.get(runId)
    },
  }

  // ONE run port instance, reachable both as the repair loop's own dep and as the shelf's member.
  // The shelf carries it because stage 5 reads run evidence through the same capability the
  // repair arm probes with — a second instance here would let a cell count starts on one and
  // assert against the other.
  const shelf = {
    runs,
    model: () => Promise.resolve({
      modelId: 'fixture:repair',
      generate(request: { prompt: string }) {
        if (promptsSeen.length >= HARNESS_EMISSION_CEILING) {
          throw new Error(
            `the repair loop asked for patch ${promptsSeen.length + 1} of a scripted sequence `
              + `capped at ${HARNESS_EMISSION_CEILING}: K did not bound the iterations`,
          )
        }
        promptsSeen.push(request.prompt)
        const text = emissions[emitted] ?? emissions.at(-1) ?? '{}'
        emitted += 1
        return Promise.resolve({ text })
      },
    }),
    write: () => Promise.resolve({ kind: 'unparsable', reason: 'unused' } as DraftStageOutcome),
    applyPatches(draft: ParsedDraftLike, set: TestEditPatchSet): Promise<DraftStageOutcome> {
      appliedSets.push(set)
      appliedDrafts.push(draft)
      return Promise.resolve({ kind: 'staged', draft: applyPatchesToDraft(draft, set) })
    },
    verifyDraft(input: { draftPath: string; draftMode?: true }): Promise<DraftReceipt> {
      verifyCalls.push(input.draftMode === true ? 1 : 0)
      if (script.refuseVerify === true) return Promise.reject(new RunRefusal())
      return Promise.resolve(FINAL_RECEIPT)
    },
  }

  return {
    deps: { draft: DRAFT, handoff: BEST_PRIOR_RUN, shelf, runs, statedValues },
    promptsSeen,
    startInputs,
    appliedSets,
    appliedDrafts,
    verifyCalls,
    receipt: FINAL_RECEIPT,
  }
}

const emit = (set: TestEditPatchSet): string => JSON.stringify(set)

/**
 * The per-cell timeout the four adversarial cells carry — a second net behind the harness ceiling.
 *
 * Every one of them scripts an emission that repeats forever, so K is the ONLY thing that can end
 * the call.
 */
const ADVERSARIAL_CELL_TIMEOUT_MS = 5_000

/** A probe in which every step the patch left in place passed — a repaired draft. */
function passingProbe(): readonly MemberFixture[] {
  return [{ filePath: DRAFT.filePath, testName: DRAFT.testName, outcome: 'passed', steps: BEST_PRIOR_MEMBER.steps }]
}

/** A probe whose PREFIX step 0 now fails — the state-dependent regression no path inspection sees. */
function prefixRegressedProbe(): readonly MemberFixture[] {
  return [{
    filePath: DRAFT.filePath,
    testName: DRAFT.testName,
    outcome: 'failed',
    steps: BEST_PRIOR_MEMBER.steps,
    failedSteps: [0],
  }]
}

/** A probe that still fails on the same unprotected step — an iteration that bought nothing. */
function stillFailingProbe(): readonly MemberFixture[] {
  return [{ ...BEST_PRIOR_MEMBER }]
}

// ---- integrity cells: these never touch the subject and stay GREEN in the RED record -----------

describe('the patch corpus is producible', () => {
  it('every corpus patch set is one the shipped schema accepts', () => {
    for (const [name, set] of CORPUS) {
      expect(TestEditPatchSetSchema.safeParse(set).success, name).toBe(true)
    }
  })

  it('the fixture routes to the repair arm through the shipped router', () => {
    expect(repairRoute().kind).toBe('repair')
    expect(repairRoute().signalClass).toBe('execution-mechanics')
  })

  it('the best prior run really passes two steps and fails the third', () => {
    const member = memberOutcome(BEST_PRIOR_MEMBER)
    expect(member.steps.map((step) => step.verifierVerdict.pass)).toEqual([true, true, false])
  })

  it('the stand-in applier really can rename — the identity cells are not vacuous', () => {
    // Without this, "repair did not rename the test" would pass against a build with no fence,
    // because the instrument itself would be incapable of the thing the fence exists to prevent.
    expect(applyPatchesToDraft(DRAFT, NON_STEP).testName).toBe(RENAMED_TO)
    expect(applyPatchesToDraft(DRAFT, OUTSIDE_PREFIX).testName).toBe(DRAFT.testName)
  })
})

// Repair fixes mechanics, not identity: a rename would desync the stability and accept targets.

describe('identity-fence: repair cannot change what the test IS', () => {
  it('identity-fence REFUSES a patch that renames the test, naming the offending path', async () => {
    const { fencePatchAgainstDraftIdentity } = await loadRepair()

    const refusal = fencePatchAgainstDraftIdentity(NON_STEP)
    expect(refusal?.name).toBe('RepairIdentityViolationError')
    expect(refusal?.path).toBe('/name')
  })

  it('identity-fence spends the iteration and starts NOTHING when a patch renames', async () => {
    const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
    // Nothing but renames, forever: the fence is the only thing that can end this, and the
    // consequence is the prefix fence's exactly — the iteration is spent, no child process runs.
    const bench = harness([emit(NON_STEP)], { probes: [] })

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(bench.startInputs).toEqual([])
    expect(bench.appliedSets).toEqual([])
    expect(outcome.kind).toBe('abandoned')
    expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
    expect(bench.promptsSeen).toHaveLength(REPAIR_ITERATION_CAP)
  }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('identity-fence ADMITS a step patch beyond the prefix — the case it must let through', async () => {
    const { fencePatchAgainstDraftIdentity, fencePatchAgainstPassingPrefix, derivePassingPrefix, repairDraft }
      = await loadRepair()
    const prefix = derivePassingPrefix(DRAFT_REF, BEST_PRIOR_RUN)

    // A real `/steps` patch beyond the prefix, not a near-miss shaped to pass: BOTH fences answer
    // and it goes on to reach a run and repair the draft.
    expect(fencePatchAgainstDraftIdentity(OUTSIDE_PREFIX)).toBeNull()
    expect(fencePatchAgainstPassingPrefix(OUTSIDE_PREFIX, prefix)).toBeNull()

    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] })
    const outcome = await repairDraft(repairRoute(), bench.deps as never)
    expect(bench.startInputs).toHaveLength(1)
    expect(outcome.kind).toBe('repaired')
  })

  it('identity-fence makes the single-derivation claim TRUE: the repaired SUITE TARGET equals the draft\'s', async () => {
    const { repairDraft } = await loadRepair()
    // Unfenced, the rename lands and the probe's member cannot join on `(filePath, testName)`.
    const bench = harness(
      [emit(NON_STEP), emit(OUTSIDE_PREFIX)],
      { probes: [passingProbe(), passingProbe()] },
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('repaired')
    const repaired = outcome.kind === 'repaired' ? outcome.draft : DRAFT
    // The fence guarantees the name; the shelf path moves with the digest on every applied set.
    expect(repaired.testName).toBe(DRAFT.testName)
    expect(repaired.filePath).not.toBe(DRAFT.filePath)
    // AND THE PROPERTY THE SINGLE DERIVATION NEEDS, which is not that both inputs are equal: the
    // suite target is the suite DIRECTORY plus a slug of the test NAME, and the shelf filename that
    // moved is the one segment the recipe drops. The stability read (pre-repair draft) and the
    // accept target (repaired ref) therefore agree BECAUSE the name is pinned, not because nothing
    // changed.
    expect(authoredSuiteTargetPath(repaired.filePath, repaired.testName))
      .toBe(authoredSuiteTargetPath(DRAFT.filePath, DRAFT.testName))
  }, ADVERSARIAL_CELL_TIMEOUT_MS)
})

// ---- the five named cells ---------------------------------------------------------------------

describe('static-fence: the prefix is protected before anything runs', () => {
  it('static-fence refuses a patch addressing a step inside the passing prefix', async () => {
    const { derivePassingPrefix, fencePatchAgainstPassingPrefix } = await loadRepair()
    const prefix = derivePassingPrefix(DRAFT_REF, BEST_PRIOR_RUN)
    expect(prefix.length).toBe(2)

    const refusal = fencePatchAgainstPassingPrefix(PREFIX_TOUCHING, prefix)
    expect(refusal?.name).toBe('PassingPrefixViolationError')
    expect(refusal?.path).toBe('/steps/1')
  })

  it('static-fence starts ZERO runs when the first patch names a prefix step', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(PREFIX_TOUCHING)], { probes: [] })

    await repairDraft(repairRoute(), bench.deps as never)

    // "Before anything runs" is MEASURED here, not described: the run port recorded no start at
    // all, so the refusal cannot have been taken after a probe had already spent a child process
    // against the user's application.
    expect(bench.startInputs).toEqual([])
    expect(bench.appliedSets).toEqual([])
  })

  it('static-fence ADMITS a patch that names only steps outside the prefix', async () => {
    const { fencePatchAgainstPassingPrefix, derivePassingPrefix, repairDraft } = await loadRepair()
    const prefix = derivePassingPrefix(DRAFT_REF, BEST_PRIOR_RUN)

    expect(fencePatchAgainstPassingPrefix(OUTSIDE_PREFIX, prefix)).toBeNull()
    expect(fencePatchAgainstPassingPrefix(NON_STEP, prefix)).toBeNull()

    // And it reaches a run, which is the half a fence refusing everything would also pass without.
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] })
    const outcome = await repairDraft(repairRoute(), bench.deps as never)
    expect(bench.startInputs).toHaveLength(1)
    expect(outcome.kind).toBe('repaired')
  })

  it('static-fence refuses the WHOLE set when one op of several names the prefix', async () => {
    const { derivePassingPrefix, fencePatchAgainstPassingPrefix } = await loadRepair()
    const prefix = derivePassingPrefix(DRAFT_REF, BEST_PRIOR_RUN)
    expect(fencePatchAgainstPassingPrefix(MIXED_SET, prefix)?.path).toBe('/steps/0')
    // An `add` at index 0 names one position and moves every later one, so it addresses the prefix.
    expect(fencePatchAgainstPassingPrefix(PREFIX_SHIFTING, prefix)?.path).toBe('/steps/0')
  })
})

describe('dynamic-regression: the prefix is re-verified after the probe', () => {
  it('dynamic-regression ends repair without keeping a candidate that regressed a prefix step', async () => {
    const { repairDraft } = await loadRepair()
    // The patch clears the static fence — it names step 2 only — and the probe shows step 0, a
    // PROTECTED step, now failing. No path inspection can see that; only the run can.
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [prefixRegressedProbe()] })

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('abandoned')
    expect(outcome.kind === 'abandoned' && outcome.abandonment.kind).toBe('prefix-regressed')
    expect(outcome.kind === 'abandoned' && outcome.abandonment.error.name)
      .toBe('PassingPrefixRegressedError')
    // Ends repair — it does not spend the remaining iterations on a draft already known to have
    // broken a step that used to pass.
    expect(bench.startInputs).toHaveLength(1)
    // And the candidate is NOT kept: no stability gate was run on it.
    expect(bench.verifyCalls).toEqual([])
  })
})

describe('fenced-counts-against-K: a refused patch spends an iteration', () => {
  it('fenced-counts-against-K makes a fenced patch consume an iteration exactly as a failed probe does', async () => {
    const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
    expect(REPAIR_ITERATION_CAP).toBe(3)

    // Iteration 1: fenced (no probe). Iteration 2: admitted, probe still fails. Iteration 3:
    // fenced. K is spent, and only ONE probe was taken — which is the accounting the plain
    // `AUTHOR_REPAIR_CAP` precedent does not have and the reason this cell exists.
    const bench = harness(
      [emit(PREFIX_TOUCHING), emit(OUTSIDE_PREFIX), emit(PREFIX_SHIFTING)],
      { probes: [stillFailingProbe()] },
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('abandoned')
    expect(outcome.iterations).toBe(3)
    expect(bench.startInputs).toHaveLength(1)
    expect(bench.promptsSeen).toHaveLength(3)
  }, ADVERSARIAL_CELL_TIMEOUT_MS)
})

describe('K-termination: repair is bounded for every input', () => {
  it('K-termination stops an adversarial model that emits only fenced patches', async () => {
    const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
    // Nothing but fenced patches, forever. The bound is the ONLY thing that can stop this, so the
    // case genuinely REACHES K rather than succeeding early and proving nothing about it.
    const bench = harness([emit(PREFIX_TOUCHING)], { probes: [] })

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('abandoned')
    expect(outcome.kind === 'abandoned' && outcome.abandonment.kind).toBe('exhausted')
    expect(outcome.kind === 'abandoned' && outcome.abandonment.error.name)
      .toBe('RepairExhaustedError')
    expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
    expect(bench.promptsSeen).toHaveLength(REPAIR_ITERATION_CAP)
    expect(bench.startInputs).toEqual([])
  }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('K-termination takes at most K probe runs when every patch is admitted and every probe fails', async () => {
    const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
    const bench = harness(
      [emit(OUTSIDE_PREFIX)],
      { probes: Array.from({ length: 10 }, () => stillFailingProbe()) },
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('abandoned')
    expect(bench.startInputs).toHaveLength(REPAIR_ITERATION_CAP)
    expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
  }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('K-termination stops a model whose emission is not a patch set at all', async () => {
    const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
    const bench = harness(['not json at all'], { probes: [] })

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('abandoned')
    expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
    expect(bench.startInputs).toEqual([])
  }, ADVERSARIAL_CELL_TIMEOUT_MS)
})

describe('one receipt per draft, and one disposition derivation', () => {
  it('a full repair sequence writes exactly ONE receipt, not 1 + K', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness(
      [emit(OUTSIDE_PREFIX), emit(OUTSIDE_PREFIX)],
      { probes: [stillFailingProbe(), passingProbe()] },
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('repaired')
    // Two probes were taken and ONE receipt was minted. Probes are loop-internal; the receipt is
    // per draft, so the funnel counts one draft rather than one draft plus its own attempts.
    expect(bench.startInputs).toHaveLength(2)
    expect(bench.verifyCalls).toHaveLength(1)
  })

  it('the final stability gate runs the pinned N, without the draft-mode marker', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] })

    await repairDraft(repairRoute(), bench.deps as never)

    // `0` is this harness's record of a request with no `draftMode`.
    expect(bench.verifyCalls).toEqual([0])
  })

  it('repair derives no disposition of its own — the receipt carries the ONE derivation', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] })

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind === 'repaired' && outcome.receipt).toBe(bench.receipt)
    expect(outcome.kind === 'repaired' && outcome.receipt.disposition).toBe(
      computeDraftDisposition({
        gates: gateBooleans(bench.receipt),
        stabilityRunsRequested: bench.receipt.stabilityRunsRequested,
        stabilityRunsCompleted: bench.receipt.stabilityRunsCompleted,
      }),
    )
  })
})

// A probe is a run, and so is the repaired draft's final verification. Both go through the run
// port, so the host's run boundary can refuse them. Repair does not catch that refusal: it reaches
// the caller at once, and nothing after it is asked, patched, probed or verified.
describe('a refusal at the run boundary ends repair where it lands', () => {
  it('a refused probe reaches the caller, and repair asks for no further patch and verifies nothing', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness(
      [emit(OUTSIDE_PREFIX), emit(OUTSIDE_PREFIX)],
      { probes: [passingProbe(), passingProbe()], refuseProbes: [0] },
    )

    await expect(repairDraft(repairRoute(), bench.deps as never)).rejects.toBeInstanceOf(RunRefusal)

    expect(bench.startInputs).toHaveLength(1)
    expect(bench.promptsSeen).toHaveLength(1)
    expect(bench.appliedSets).toHaveLength(1)
    expect(bench.verifyCalls).toEqual([])
  })

  it('a passing probe returns to verifyDraft, and a refusal there reaches the caller with no receipt', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()], refuseVerify: true })

    await expect(repairDraft(repairRoute(), bench.deps as never)).rejects.toBeInstanceOf(RunRefusal)

    // The probe ran, then the final gate was asked for once, without the draft-mode marker.
    expect(bench.startInputs).toHaveLength(1)
    expect(bench.verifyCalls).toEqual([0])
    expect(bench.promptsSeen).toHaveLength(1)
  })
})

describe('the repair prompt carries the run evidence at the failure point', () => {
  it('the prompt names the failing step text and the a11y state channels', async () => {
    const { repairDraft, REPAIR_AGENT_CONTEXT } = await loadRepair()
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] })

    await repairDraft(repairRoute(), bench.deps as never)

    const prompt = bench.promptsSeen[0] ?? ''
    expect(REPAIR_AGENT_CONTEXT).toContain('authoring.draft.write')
    expect(prompt).toContain('step 2')
    expect(prompt).toContain('state-before')
    expect(prompt).toContain('termination')
  })
})

// ---- at the call site: the stop branch never enters repair, even through a cast ----

/** A clean definitive assertion-fail: the verifier said no, a verdict source says which path. */
const CLEAN_FAIL_MEMBER: MemberFixture = {
  filePath: DRAFT.filePath,
  testName: DRAFT.testName,
  outcome: 'failed',
  steps: BEST_PRIOR_MEMBER.steps,
  failedSteps: [2],
  verdictSourceSteps: [{ stepIndex: 2, source: 'assert-value' as never }],
}

const ROUTING_RUN_ID = 'r_gate-2'

/** A `rejected` receipt whose last gate run is the one stage 5 reads evidence out of. */
const REJECTED_RECEIPT: DraftReceipt = DraftReceiptSchema.parse({
  ...FINAL_RECEIPT,
  draftRef: DRAFT_REF,
  gates: {
    ...FINAL_RECEIPT.gates,
    executesDefinitive: { pass: false, runRefs: [ROUTING_RUN_ID], indefinitiveRunRefs: [] },
  },
  gateRuns: [{
    runId: ROUTING_RUN_ID,
    memberOutcome: 'failed',
    definitive: true,
    healed: false,
    reason: 'fixture: the claim was evaluated and did not hold',
  }],
  disposition: 'rejected',
})

describe('stage 5: the app-broken branch cannot reach repair', () => {
  it('stop-branch-never-repairs answers a stop without starting a single probe', async () => {
    const { routeAfterVerify } = await import('../loop.js')
    // Nothing is scripted for the model or for probes. If the stop branch reached repair, the
    // very first thing it would do is ask for a patch — so this harness has nothing to give it.
    const bench = harness([], { probes: [] }, { [ROUTING_RUN_ID]: [CLEAN_FAIL_MEMBER] })

    // Repair is where an invocation's runs are known, so the fan-out report leaves from stage 5.
    const { outcome } = await routeAfterVerify(DRAFT, REJECTED_RECEIPT, {
      read: {
        getAuthoringBrief: () => { throw new Error('stage 5 does not read the brief') },
        suiteTextCorpus: () => { throw new Error('stage 5 does not screen the suite') },
        // Stage 5 compiles nothing, so a vocabulary read here throws like its neighbours.
        configuredTargetNames: () => { throw new Error('stage 5 serves no target vocabulary') },
      },
      shelf: bench.deps.shelf as never,
    }, [])

    expect(outcome.kind).toBe('stopped')
    // No probe and no patch: repairing a test the app failed would capture the oracle.
    expect(bench.startInputs).toEqual([])
    expect(bench.promptsSeen).toEqual([])
    expect(bench.appliedSets).toEqual([])
  })

  it('stop-branch-never-repairs carries the evidence refs the route derived', async () => {
    const { routeAfterVerify } = await import('../loop.js')
    const bench = harness([], { probes: [] }, { [ROUTING_RUN_ID]: [CLEAN_FAIL_MEMBER] })

    // Repair is where an invocation's runs are known, so the fan-out report leaves from stage 5.
    const { outcome } = await routeAfterVerify(DRAFT, REJECTED_RECEIPT, {
      read: {
        getAuthoringBrief: () => { throw new Error('stage 5 does not read the brief') },
        suiteTextCorpus: () => { throw new Error('stage 5 does not screen the suite') },
        // Stage 5 compiles nothing, so a vocabulary read here throws like its neighbours.
        configuredTargetNames: () => { throw new Error('stage 5 serves no target vocabulary') },
      },
      shelf: bench.deps.shelf as never,
    }, [])

    expect(outcome.kind === 'stopped' && outcome.route.signalClass)
      .toBe('clean-definitive-assertion-fail')
    expect(outcome.kind === 'stopped' && outcome.route.evidenceRefs.length).toBeGreaterThan(0)
    // An ordinary stop carries no abandonment key and no prose field.
    expect(Object.keys(outcome).sort()).toEqual(['draftRef', 'kind', 'receipt', 'route'])
  })
})

// A repair patch that loses a stated value is fenced before anything runs; step 3 has `Saved`.
const LOSES_SAVED = patchSet('reword the banner check', [
  { op: 'replace', path: '/steps/3', value: 'Verify the confirmation banner says "Done"' },
])

const LOWERCASES_SAVED = patchSet('reword the banner check', [
  { op: 'replace', path: '/steps/3', value: 'Verify the confirmation banner says "saved"' },
])

describe('stated values checked on a repair patch', () => {
  it('a repair patch that loses a stated value is refused before any run and spends the try',
    async () => {
      const { repairDraft, REPAIR_ITERATION_CAP } = await loadRepair()
      const bench = harness([emit(LOSES_SAVED)], { probes: [] }, {}, ['Saved'])

      const outcome = await repairDraft(repairRoute(), bench.deps as never)

      expect(outcome.kind).toBe('abandoned')
      expect(outcome.kind === 'abandoned' && outcome.abandonment.kind).toBe('exhausted')
      expect(outcome.iterations).toBe(REPAIR_ITERATION_CAP)
      expect(outcome.iterations).toBe(3)
      expect(bench.startInputs).toHaveLength(0)
      expect(bench.verifyCalls).toEqual([])
    }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('a repair patch that keeps every stated value is probed', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(OUTSIDE_PREFIX)], { probes: [passingProbe()] }, {}, [
      'alice',
      'Saved',
    ])

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('repaired')
    expect(bench.startInputs).toHaveLength(1)
  })

  it('the next try is told which stated value the refused patch dropped', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness(
      [emit(LOSES_SAVED), emit(OUTSIDE_PREFIX)],
      { probes: [passingProbe()] },
      {},
      ['Saved'],
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    const second = bench.promptsSeen[1] ?? ''
    const title = 'Why the previous attempt was not kept'
    expect(second).toContain(title)
    expect(second.slice(second.indexOf(title))).toContain(
      'the request\'s stated values are missing: "Saved"',
    )
    expect(outcome.kind).toBe('repaired')
    expect(outcome.iterations).toBe(2)
    expect(bench.startInputs).toHaveLength(1)
  })

  it('a value-refused try counts toward the cap like any fenced patch', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness(
      [emit(LOSES_SAVED), emit(LOSES_SAVED), emit(OUTSIDE_PREFIX)],
      { probes: [passingProbe()] },
      {},
      ['Saved'],
    )

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind).toBe('repaired')
    expect(outcome.iterations).toBe(3)
    expect(bench.startInputs).toHaveLength(1)
  }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('a case-changed value in a repair patch is refused', async () => {
    const { fencePatchAgainstStatedValues, repairDraft } = await loadRepair()

    const violation = fencePatchAgainstStatedValues(
      applyPatchesToDraft(DRAFT, LOWERCASES_SAVED),
      ['Saved'],
    )
    expect(violation?.name).toBe('RepairStatedValueViolationError')
    expect(violation?.missingValues).toEqual(['Saved'])
    expect(fencePatchAgainstStatedValues(DRAFT, ['Saved'])).toBeNull()

    const bench = harness([emit(LOWERCASES_SAVED)], { probes: [] }, {}, ['Saved'])
    const outcome = await repairDraft(repairRoute(), bench.deps as never)
    expect(outcome.kind).toBe('abandoned')
    expect(bench.startInputs).toEqual([])
  }, ADVERSARIAL_CELL_TIMEOUT_MS)

  it('the candidate is not advanced past a refused patch', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness(
      [emit(LOSES_SAVED), emit(OUTSIDE_PREFIX)],
      { probes: [passingProbe()] },
      {},
      ['Saved'],
    )

    await repairDraft(repairRoute(), bench.deps as never)

    expect(bench.appliedDrafts).toHaveLength(2)
    expect(bench.appliedDrafts[1]).toBe(bench.appliedDrafts[0])
    expect(bench.appliedDrafts[1]?.contentDigest).toBe(DRAFT.contentDigest)
    expect(bench.appliedDrafts[1]?.steps[3]).toBe('Verify the confirmation banner says "Saved"')
  })

  it('running out after value refusals keeps the existing abandonment kinds', async () => {
    const { repairDraft } = await loadRepair()
    const bench = harness([emit(LOSES_SAVED)], { probes: [] }, {}, ['Saved'])

    const outcome = await repairDraft(repairRoute(), bench.deps as never)

    expect(outcome.kind === 'abandoned' && outcome.abandonment.kind).toBe('exhausted')
    expect(outcome.kind === 'abandoned' && outcome.abandonment.error.name)
      .toBe('RepairExhaustedError')
    expect([...AUTHORING_REPAIR_ABANDONMENTS]).toEqual(['exhausted', 'prefix-regressed'])
  }, ADVERSARIAL_CELL_TIMEOUT_MS)
})
