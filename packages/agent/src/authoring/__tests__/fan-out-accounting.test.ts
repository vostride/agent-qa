// The fan-out preview against what the loop ACTUALLY spends.
//
// THE PROHIBITION THIS FILE MAKES MECHANICAL. A preview lower than the loop's own worst case is a
// consent defect: a person approved a number and the loop took more. Asserting that the two numbers
// exist would measure nothing. So the load-bearing cell here drives the loop to its GENUINE worst
// case — the full initial stability gate, every one of K's repair iterations spent on a probe, and
// the final stability gate on the repaired candidate — and asserts the runs it consumed against the
// bound the dispatch confirm rendered. The phase's mutation driver (since removed) shaved a term
// off that bound and required this cell to red by name.
//
// A WORST CASE HAS TO BE REACHED, NOT DESCRIBED. `runsConsumed <= runsPreviewed` is unfalsifiable
// against a happy path that spends three runs of a nine-run bound: every wrong bound passes it. The
// sequence below is scripted so that the third repair iteration is the one that succeeds, which is
// the only path on which all three terms are spent.
//
// AND CHEAPER PATHS ARE PINNED BESIDE IT, because a loop that always spent nine would satisfy the
// worst-case cell and nothing else. The happy path spends the initial gate alone, a fenced
// iteration spends NO run at all, and a stage-2 refusal spends nothing and previews nothing.
//
// vitest does not typecheck `.test.ts` (`typecheck.include` is `*.test-d.ts`); `tsc --noEmit` is
// this file's only type authority.

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
  TestEditPatchSetSchema,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  DraftReceipt,
  RunsStartInput,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { memberOutcome, runDocument } from './evidence-fixtures.js'
import type { MemberFixture } from './evidence-fixtures.js'
import { authoringFanOutBound, runAuthoringLoop } from '../loop.js'
import { REPAIR_ITERATION_CAP } from '../repair.js'
import type { AuthoringLoopDeps, AuthoringLoopInput } from '../loop.js'
import type { DraftStageOutcome, ParsedDraftLike } from '../ports.js'

const DRAFT_PATH = 'tests/.agent-qa-drafts/fan-out-fixture.yaml'
const DRAFT_NAME = 'Submit the local account form'

const DRAFT_STEPS: readonly string[] = [
  'Open the local account form',
  'Type "alice" into the Username field',
  'Click the Submit button',
  'Verify the confirmation banner says "Saved"',
]

/** The document the scripted model compiles at stage 3. Its bytes are never parsed here. */
const MODEL_DOCUMENT = 'name: Submit the local account form\nsteps:\n  - a\n'

/**
 * The draft's member in a run: two leading steps passed, the third could not be carried out.
 *
 * `execution-mechanics` evidence, which is what routes a rejected receipt to REPAIR rather than to
 * a finding — and the repair arm is the only one that can spend the probe term.
 */
function mechanicsFailureMember(): MemberFixture {
  return {
    filePath: DRAFT_PATH,
    testName: DRAFT_NAME,
    outcome: 'failed',
    steps: [
      [{ type: 'navigate', url: 'http://127.0.0.1:8931/form.html' }],
      [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
      [{ type: 'click', ref: 'e9', role: 'button', name: 'submit', success: false }],
    ],
    failedSteps: [2],
    infeasibleSteps: [2],
  }
}

/** The same member with every step passing — a probe that repaired the draft. */
function passingMember(): MemberFixture {
  return {
    filePath: DRAFT_PATH,
    testName: DRAFT_NAME,
    outcome: 'passed',
    steps: mechanicsFailureMember().steps,
  }
}

/**
 * One run record, with a completion time this fixture chooses.
 *
 * `runDocument` stamps every run `endedAt: 1`, which would make the whole sequence tie and leave
 * the report's completion ordering untested. Distinct times exercise the primary key; the two runs
 * that deliberately SHARE a time exercise the run-id tiebreak.
 */
function runAt(runId: string, endedAt: number, members: readonly MemberFixture[]): CompletedRunHandoff {
  return { ...runDocument(runId, members), endedAt } as CompletedRunHandoff
}

/** A receipt naming the gate runs it took, PARSED by the shipped schema. */
function receiptFor(
  disposition: 'rejected' | 'keep-eligible',
  runIds: readonly string[],
  digest: string,
): DraftReceipt {
  const passed = disposition === 'keep-eligible'
  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: { filePath: DRAFT_PATH, testId: DRAFT_NAME, testName: DRAFT_NAME, contentDigest: digest },
    gates: {
      executesDefinitive: { pass: passed, runRefs: [...runIds], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: passed,
        runRefs: [...runIds],
        distinctOutcomes: passed ? ['passed'] : ['failed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: runIds.map((runId) => ({
      runId,
      memberOutcome: passed ? 'passed' : 'failed',
      definitive: true,
      healed: false,
    })),
    addsValueFinding: { novelElements: ['el:button "submit"'], comparedTests: [] },
    stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
    stabilityRunsCompleted: runIds.length,
    disposition,
    evaluatedAt: 1,
  })
}

/** A patch outside the passing prefix (steps 0-1), so the static fence ADMITS it. */
const OUTSIDE_PREFIX: TestEditPatchSet = TestEditPatchSetSchema.parse({
  thoughts: 'the submit control is addressed by a different label',
  patches: [{ op: 'replace', path: '/steps/2', value: 'Click the "Save account" button' }],
})

/** A patch NAMING a protected step, which the fence refuses before anything runs. */
const PREFIX_TOUCHING: TestEditPatchSet = TestEditPatchSetSchema.parse({
  thoughts: 'rewrite the step that already passed',
  patches: [{ op: 'replace', path: '/steps/1', value: 'Type "bob" into the Username field' }],
})

interface Bench {
  readonly deps: AuthoringLoopDeps
  readonly startInputs: RunsStartInput[]
  readonly startedRunIds: string[]
  readonly verifyCalls: number
  readonly published: string[]
}

/**
 * The loop's host, scripted end to end.
 *
 * `verifyReceipts` is consumed in order: the FIRST is the evaluation's receipt at stage 4, and a
 * second — when repair reaches a passing probe — is the final stability gate's. `probes` is one
 * entry per probe run, in order.
 */
function bench(input: {
  readonly emissions: readonly string[]
  readonly verifyReceipts: readonly DraftReceipt[]
  readonly probes: readonly (readonly MemberFixture[])[]
  readonly suiteText?: readonly { filePath: string; testName: string; stepsText: readonly string[] }[]
}): Bench {
  const startInputs: RunsStartInput[] = []
  const startedRunIds: string[] = []
  const documents = new Map<string, CompletedRunHandoff>()
  let emitted = 0
  let verified = 0
  const state = { verifyCalls: 0 }
  const published: string[] = []

  // The evaluation's own gate runs, on record before the loop starts — exactly as a real
  // `authoring.draft.verify` would have left them, since the verify op is what takes them.
  const gateRunIds = ['r_gate-0', 'r_gate-1', 'r_gate-2']
  gateRunIds.forEach((runId, index) => {
    documents.set(runId, runAt(runId, 100 + index, [mechanicsFailureMember()]))
  })
  // The final stability gate's runs, likewise — and TWO of them share a completion time, so the
  // run-id tiebreak is exercised by a real record rather than by a hand-made pair.
  const finalRunIds = ['r_final-0', 'r_final-1', 'r_final-2']
  finalRunIds.forEach((runId, index) => {
    documents.set(runId, runAt(runId, 300 + (index === 2 ? 1 : index), [passingMember()]))
  })

  const runs = {
    start(started: RunsStartInput) {
      const index = startInputs.length
      startInputs.push(started)
      const runId = `r_probe-${index}`
      startedRunIds.push(runId)
      const members = input.probes[index]
      if (members !== undefined) documents.set(runId, runAt(runId, 200 + index, members))
      return Promise.resolve({ runId } as never)
    },
    get(runId: string) {
      return Promise.resolve(documents.get(runId))
    },
  }

  const draft: ParsedDraftLike = {
    testId: DRAFT_NAME,
    filePath: DRAFT_PATH,
    testName: DRAFT_NAME,
    target: 'local-form',
    steps: [...DRAFT_STEPS],
    contentDigest: 'digest-0',
  }

  const shelf = {
    runs,
    model: () => Promise.resolve({
      modelId: 'fixture:fan-out',
      generate() {
        const text = input.emissions[emitted] ?? input.emissions.at(-1) ?? MODEL_DOCUMENT
        emitted += 1
        return Promise.resolve({ text })
      },
    }),
    write: () => Promise.resolve({ kind: 'staged', draft } as DraftStageOutcome),
    applyPatches(candidate: ParsedDraftLike, set: TestEditPatchSet): Promise<DraftStageOutcome> {
      return Promise.resolve({
        kind: 'staged',
        draft: { ...candidate, contentDigest: `${candidate.contentDigest}+${set.patches.length}` },
      })
    },
    verifyDraft(): Promise<DraftReceipt> {
      state.verifyCalls += 1
      const receipt = input.verifyReceipts[verified] ?? input.verifyReceipts.at(-1)
      verified += 1
      if (receipt === undefined) throw new Error('the bench was asked for a receipt it has none of')
      return Promise.resolve(receipt)
    },
    // the final write. It starts no run, so it cannot move a single figure below.
    publish: (request: { readonly targetPath: string }) => {
      published.push(request.targetPath)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: 'written',
      })
    },
  }

  return {
    startInputs,
    startedRunIds,
    published,
    get verifyCalls() {
      return state.verifyCalls
    },
    deps: {
      read: {
        // the `target` vocabulary the compile prompt serves. This bench never
        // inspects it — its model is scripted — so one name is the whole answer.
        configuredTargetNames: () => Promise.resolve(['local-form']),
        getAuthoringBrief: () => Promise.resolve({
          scope: { tier: 'product', key: 'local-form' },
          facts: [],
          cautions: [],
          procedures: [],
          exemplars: [],
        } as never),
        suiteTextCorpus: () => Promise.resolve(input.suiteText ?? []),
      },
      shelf: shelf as never,
    },
  }
}

const LOOP_INPUT: AuthoringLoopInput = {
  intent: 'Check that submitting the local account form shows the confirmation banner',
  scope: { tier: 'product', key: 'local-form' },
}

const REJECTED = receiptFor('rejected', ['r_gate-0', 'r_gate-1', 'r_gate-2'], 'digest-0')
const REPAIRED = receiptFor('keep-eligible', ['r_final-0', 'r_final-1', 'r_final-2'], 'digest-0+1')
const ACCEPTED = receiptFor('keep-eligible', ['r_gate-0', 'r_gate-1', 'r_gate-2'], 'digest-0')

// ---- integrity cells: these assert the fixture, not the subject ---------------------------------

describe('the fixture reaches the paths it claims to', () => {
  it('the failing member really passes two steps and fails the third on mechanics', () => {
    const member = memberOutcome(mechanicsFailureMember())
    expect(member.steps.map((step) => step.verifierVerdict.pass)).toEqual([true, true, false])
  })

  it('both patch sets are ones the shipped schema accepts', () => {
    expect(TestEditPatchSetSchema.safeParse(OUTSIDE_PREFIX).success).toBe(true)
    expect(TestEditPatchSetSchema.safeParse(PREFIX_TOUCHING).success).toBe(true)
  })
})

// ---- the worst case ----------------------------------------------------------------------------

describe('the loop cannot exceed the bound its own dispatch confirm rendered', () => {
  it('WORST CASE: every term spent — initial gate, all K probes, final gate — stays within the preview', async () => {
    // K's LAST iteration is the one that succeeds, so iterations 1 and 2 each spend a probe that
    // fails and iteration 3 spends the probe that passes. That is the only path on which all three
    // terms of the bound are actually paid.
    const harness = bench({
      emissions: [
        MODEL_DOCUMENT,
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
      ],
      verifyReceipts: [REJECTED, REPAIRED],
      probes: [[mechanicsFailureMember()], [mechanicsFailureMember()], [passingMember()]],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    expect(result.outcome.kind).toBe('repaired')
    // The path really is the worst one: K probes started, and the final stability gate ran.
    expect(harness.startInputs).toHaveLength(REPAIR_ITERATION_CAP)
    expect(harness.verifyCalls).toBe(2)

    const previewed = authoringFanOutBound(LOOP_INPUT)
    // THE PROHIBITION, ASSERTED RATHER THAN CLAMPED. `buildFanOutReport` reports an excess as a
    // flag and never repairs it, so this comparison is over the real figures.
    expect(result.fanOut.consumedTotal).toBeLessThanOrEqual(previewed.total)
    expect(result.fanOut.exceedsPreview).toBe(false)
    // And the worst case really does reach the bound — a consumed figure well under it would mean
    // this cell is passing because the path is cheap rather than because the bound is honest.
    expect(result.fanOut.consumedTotal).toBe(previewed.total)
    expect(result.fanOut.previewed).toEqual(previewed)
  })

  it('counts PROBE runs toward the actual figure, not the gate runs alone', async () => {
    const harness = bench({
      emissions: [
        MODEL_DOCUMENT,
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
      ],
      verifyReceipts: [REJECTED, REPAIRED],
      probes: [[mechanicsFailureMember()], [mechanicsFailureMember()], [passingMember()]],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    // 3 gate + 3 probes + 3 final. An actual figure that omitted the probes would report 6 — two
    // thirds of what was spent — while calling itself the honest half of the disclosure.
    expect(result.fanOut.consumedTotal).toBe(9)
    const probeIds = result.fanOut.consumed.filter((run) => run.purpose === 'probe')
    expect(probeIds.map((run) => run.runId)).toEqual(['r_probe-0', 'r_probe-1', 'r_probe-2'])
  })

  it('lists the consumed runs in completion order, ties broken by run id', async () => {
    const harness = bench({
      emissions: [
        MODEL_DOCUMENT,
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
      ],
      verifyReceipts: [REJECTED, REPAIRED],
      probes: [[mechanicsFailureMember()], [mechanicsFailureMember()], [passingMember()]],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    // The gate runs finished at 100-102, the probes at 200-202, and the final gate at 300, 301,
    // 301 — the last two TIE, and the id decides between them. Two renders of one report cannot
    // disagree, which is the property this order exists to have.
    expect(result.fanOut.consumed.map((run) => run.runId)).toEqual([
      'r_gate-0', 'r_gate-1', 'r_gate-2',
      'r_probe-0', 'r_probe-1', 'r_probe-2',
      'r_final-0', 'r_final-1', 'r_final-2',
    ])
  })

  // re-spelled in place. The proposal arm these figures rode is gone — the
  // repaired draft is written, not proposed — so the same two figures are read off the report the
  // invocation answers with, and the iteration count off the repaired arm itself.
  it('reports the two figures TOGETHER on the repaired arm a person reads', async () => {
    const harness = bench({
      emissions: [
        MODEL_DOCUMENT,
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
        JSON.stringify(OUTSIDE_PREFIX),
      ],
      verifyReceipts: [REJECTED, REPAIRED],
      probes: [[mechanicsFailureMember()], [mechanicsFailureMember()], [passingMember()]],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    expect(result.outcome.kind).toBe('repaired')
    expect(result.fanOut.previewed.total).toBe(authoringFanOutBound(LOOP_INPUT).total)
    expect(result.fanOut.consumedTotal).toBe(9)
    // The repair iteration count is a SEPARATE fact and not the run count: it is how many attempts
    // were made, and attempts and runs are exactly what a fenced iteration separates.
    const iterations = result.outcome.kind === 'repaired' ? result.outcome.repairIterations : -1
    expect(iterations).toBe(REPAIR_ITERATION_CAP)
  })

  // 432 D-06, the repaired arm: the FINAL receipt decides the write, exactly as a
  // first-pass one does. A repair that reached a passing probe but whose final stability gate
  // rejected the candidate is reported as repaired and NOT written — its bytes stay on the shelf.
  it('writes a repaired draft only when its final gate did not reject it', async () => {
    const rejectedFinal = receiptFor('rejected', ['r_final-0', 'r_final-1', 'r_final-2'], 'digest-0+1')
    const refused = bench({
      emissions: [MODEL_DOCUMENT, JSON.stringify(OUTSIDE_PREFIX)],
      verifyReceipts: [REJECTED, rejectedFinal],
      probes: [[passingMember()]],
    })
    const kept = bench({
      emissions: [MODEL_DOCUMENT, JSON.stringify(OUTSIDE_PREFIX)],
      verifyReceipts: [REJECTED, REPAIRED],
      probes: [[passingMember()]],
    })

    const refusedResult = await runAuthoringLoop(LOOP_INPUT, refused.deps)
    const keptResult = await runAuthoringLoop(LOOP_INPUT, kept.deps)

    expect(refusedResult.outcome.kind).toBe('repaired')
    expect(refused.published).toEqual([])
    const refusedWrite = refusedResult.outcome.kind === 'repaired'
      ? refusedResult.outcome.written
      : undefined
    expect(refusedWrite?.file).toMatchObject({ kind: 'not-written', reason: 'rejected' })
    expect(refusedWrite?.disposition).toBe('rejected')

    expect(keptResult.outcome.kind).toBe('repaired')
    expect(kept.published).toHaveLength(1)
    const keptWrite = keptResult.outcome.kind === 'repaired' ? keptResult.outcome.written : undefined
    expect(keptWrite?.file).toEqual({
      kind: 'written',
      filePath: kept.published[0],
      contentDigest: 'written',
    })
    expect(keptWrite?.disposition).toBe('keep-eligible')
  })
})

// ---- the cheaper paths, so the worst-case cell is not the only shape that passes ----------------

describe('cheaper paths spend less, and say so', () => {
  it('the happy path consumes the initial gate alone — well under the bound', async () => {
    const harness = bench({
      emissions: [MODEL_DOCUMENT],
      verifyReceipts: [ACCEPTED],
      probes: [],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    expect(result.outcome.kind).toBe('drafted')
    expect(result.fanOut.consumedTotal).toBe(DRAFT_STABILITY_RUNS_N)
    expect(result.fanOut.previewed.total).toBe(authoringFanOutBound(LOOP_INPUT).total)
    expect(result.fanOut.exceedsPreview).toBe(false)
    // No probe was started at all — the accounting is not "the bound, always".
    expect(harness.startInputs).toEqual([])
  })

  it('a FENCED iteration consumes an iteration and NO run — attempts and runs are not the same', async () => {
    const harness = bench({
      emissions: [
        MODEL_DOCUMENT,
        JSON.stringify(PREFIX_TOUCHING),
        JSON.stringify(PREFIX_TOUCHING),
        JSON.stringify(PREFIX_TOUCHING),
      ],
      verifyReceipts: [REJECTED],
      probes: [],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    // Repair spent all K iterations and started nothing, so the actual figure is the initial gate
    // and nothing more. Counting iterations — which is what the arm's previous `actualRuns` field
    // did — would have reported 6 runs for an invocation that spent 3.
    expect(harness.startInputs).toEqual([])
    expect(result.fanOut.consumedTotal).toBe(DRAFT_STABILITY_RUNS_N)
    expect(result.fanOut.exceedsPreview).toBe(false)
  })

  it('a stage-2 refusal previews 0 and consumes 0', async () => {
    const harness = bench({
      emissions: [MODEL_DOCUMENT],
      verifyReceipts: [ACCEPTED],
      probes: [],
      // A suite test the intent already describes, so the dedup screen refuses before compile.
      suiteText: [{
        filePath: 'tests/local-form-submit.yaml',
        testName: 'Check that submitting the local account form shows the confirmation banner',
        stepsText: ['Submit the local account form and check the confirmation banner'],
      }],
    })

    const result = await runAuthoringLoop(LOOP_INPUT, harness.deps)

    expect(result.outcome.kind).toBe('refused')
    // Nothing was ever going to run on this path — the invocation ended before a draft existed —
    // so the report says 0 and 0 rather than disclosing a fan-out this invocation has none of.
    expect(result.fanOut.previewed.total).toBe(0)
    expect(result.fanOut.consumedTotal).toBe(0)
    expect(result.fanOut.consumed).toEqual([])
    expect(result.fanOut.exceedsPreview).toBe(false)
    expect(harness.startInputs).toEqual([])
  })
})
