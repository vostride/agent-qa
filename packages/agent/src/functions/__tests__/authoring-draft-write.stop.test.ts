// The app-broken branch on the op's OWN output, and the store it does NOT write to (411 · WTST-11).
//
// THE STOP BRANCH'S WHOLE HUMAN SURFACE IS THE OP RESULT. Nothing is minted for a correctly-failing
// draft — it is already on the shelf with its receipt, and it IS the regression test for the defect
// (411 D-10) — so what a caller learns about the application is the `stop` arm this file reads, and
// what a caller must NOT find is an envelope in the inbox.
//
// THE ZERO IS MEASURED ON THE STORE, NEVER INFERRED FROM THE LOOP'S RETURN. The recording proposals
// port below IS the store the sibling cells in `authoring-draft-write.fanout.test.ts` already read;
// every cell here lists it AFTER `invoke` returns. A cell that asserted "the outcome is stopped, so
// nothing was filed" would be re-stating the branch rather than measuring the write, which is the
// one thing the ledger's mutation (re-add a `put` on the stopped arm) has to be able to red.
//
// MEASURED THROUGH THE SHIPPED CONTRACT. `carried()` parses what `invoke` answered with
// `AuthoringDraftWriteOutputSchema` before anything is asserted: the schema is `.strict()`, so a
// `stop` arm the op returns but the contract lacks throws here rather than reading as carried.
//
// vitest does not typecheck `.test.ts` (`typecheck.include` is `*.test-d.ts`); `tsc --noEmit` is
// this file's only type authority.
//
// The draft and receipt constants below are COPIES of the fanout suite's, which are module-private
// there. Importing a sibling `.test.ts` would re-run its cells (388-06 D-2), so the fixtures are
// spelled here and the app-broken deltas are made explicit against them.

import {
  AuthoringDraftWriteOutputSchema,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { authoringDraftWriteSpec } from '../ops/authoring-draft-write.js'
import { runDocument } from '../../authoring/__tests__/evidence-fixtures.js'
import type { MemberFixture } from '../../authoring/__tests__/evidence-fixtures.js'
import { routeRepairOrStop } from '../../authoring/router.js'
import type { AuthoringLoopInput } from '../../authoring/loop.js'
import type { FunctionDeps } from '../spec.js'
import type {
  DraftStageOutcome,
  ParsedDraftLike,
} from '../../authoring/ports.js'

// 2026-10-01 (432-17, D-06): the authoring proposal writer and its record type are deleted. The spy
// stays as an excess dependency so "nothing was filed" remains a measurement rather than a type.
interface AuthoringProposalWrite {
  readonly kind: string
  readonly emittedBy: string
  readonly payload: unknown
}

const DRAFT_PATH = 'tests/.agent-qa-drafts/stop-fixture.yaml'
const DRAFT_NAME = 'Submit the local account form'

/** The document the scripted model compiles at stage 3. Its bytes are never parsed here. */
const MODEL_DOCUMENT = 'name: Submit the local account form\nsteps:\n  - a\n'

const DRAFT: ParsedDraftLike = {
  testId: DRAFT_NAME,
  filePath: DRAFT_PATH,
  testName: DRAFT_NAME,
  // The name the read double below serves as this project's only configured target.
  target: 'local-form',
  steps: [
    'Open the local account form',
    'Type "alice" into the Username field',
    'Click the Submit button',
    'Verify the confirmation banner says "Saved"',
  ],
  contentDigest: 'digest-0',
}

const GATE_RUN_IDS = ['r_gate-0', 'r_gate-1', 'r_gate-2'] as const

/** The run stage 5 ROUTES ON: the LAST gate run the receipt names (`routingHandoff`). */
const ROUTING_RUN_ID = GATE_RUN_IDS.at(-1) as string

const RECEIPT_BASE = {
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: {
    filePath: DRAFT_PATH,
    testId: DRAFT_NAME,
    testName: DRAFT_NAME,
    contentDigest: 'digest-0',
  },
  gates: {
    executesDefinitive: { pass: true, runRefs: [...GATE_RUN_IDS], indefinitiveRunRefs: [] },
    stableVerdict: {
      pass: true,
      runRefs: [...GATE_RUN_IDS],
      distinctOutcomes: ['passed'],
      earlyStopped: false,
    },
    addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
    falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
  },
  stepTable: [],
  gateRuns: GATE_RUN_IDS.map((runId) => ({
    runId,
    memberOutcome: 'passed',
    definitive: true,
    healed: false,
  })),
  addsValueFinding: { novelElements: ['el:button "submit"'], comparedTests: [] },
  stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
  stabilityRunsCompleted: GATE_RUN_IDS.length,
  disposition: 'keep-eligible',
  evaluatedAt: 1,
}

/** The keep-eligible receipt, PARSED by the shipped schema — the drafted control's half. */
const ACCEPTED: DraftReceipt = DraftReceiptSchema.parse(RECEIPT_BASE)

/**
 * A clean definitive assertion-fail: the verifier said no, a verdict source says which path.
 *
 * The same member `repair-fence.test.ts` routes with, so the class this file measures is the one
 * the shipped router derives rather than one this file asserted into place.
 */
const CLEAN_FAIL_MEMBER: MemberFixture = {
  filePath: DRAFT_PATH,
  testName: DRAFT_NAME,
  outcome: 'failed',
  steps: [
    [{ type: 'navigate', url: 'http://127.0.0.1:8931/form.html' }],
    [{ type: 'fill', ref: 'e1', role: 'textbox', name: 'username' }],
    [{ type: 'click', ref: 'e9', role: 'button', name: 'submit', success: false }],
  ],
  failedSteps: [2],
  verdictSourceSteps: [{ stepIndex: 2, source: 'assert-value' as never }],
}

/** A `rejected` receipt whose last gate run is the one stage 5 reads evidence out of. */
const REJECTED_RECEIPT: DraftReceipt = DraftReceiptSchema.parse({
  ...RECEIPT_BASE,
  gates: {
    ...RECEIPT_BASE.gates,
    executesDefinitive: { pass: false, runRefs: [ROUTING_RUN_ID], indefinitiveRunRefs: [] },
  },
  gateRuns: [{
    runId: ROUTING_RUN_ID,
    memberOutcome: 'failed',
    definitive: true,
    healed: false,
    reason: 'fixture: the claim was evaluated and did not hold',
  }],
  stabilityRunsCompleted: 1,
  disposition: 'rejected',
})

/** The run document the router reads — the routed run's own evidence, built by the shared builder. */
function routedRun() {
  return runDocument(ROUTING_RUN_ID, [CLEAN_FAIL_MEMBER])
}

/**
 * The op's host, scripted to the APP-BROKEN path.
 *
 * Two deltas from the fanout suite's `deps()`: `runs.get` answers a real `CompletedRunHandoff` for
 * the routed run (stage 5 routes on the document, not on the receipt), and `verifyDraft` answers
 * the `rejected` receipt. `runs.start` still THROWS, which is the structural statement that the
 * stop branch starts no probe — reaching repair would trip it before any assertion below.
 */
function deps(options: {
  readonly filed?: AuthoringProposalWrite[]
  readonly published?: string[]
  /** Answer the keep-eligible receipt instead — the two-sided `drafted` control. */
  readonly drafted?: true
} = {}): FunctionDeps {
  const documents = new Map<string, unknown>()
  GATE_RUN_IDS.forEach((runId, index) => documents.set(runId, { endedAt: 100 + index }))
  documents.set(ROUTING_RUN_ID, routedRun())

  const shelf = {
    runs: {
      start: () => { throw new Error('the stop branch in this file starts no run') },
      get: (runId: string) => Promise.resolve(documents.get(runId)),
    },
    model: () => Promise.resolve({
      modelId: 'fixture:stop',
      generate: () => Promise.resolve({ text: MODEL_DOCUMENT }),
    }),
    write: () => Promise.resolve({ kind: 'staged', draft: DRAFT } as DraftStageOutcome),
    applyPatches: (candidate: ParsedDraftLike) => Promise.resolve({
      kind: 'staged' as const,
      draft: candidate,
    }),
    verifyDraft: () => Promise.resolve(options.drafted === true ? ACCEPTED : REJECTED_RECEIPT),
    // 432 D-06: the direct writer. A stopped invocation must never reach it.
    publish: (request: { readonly targetPath: string }) => {
      options.published?.push(request.targetPath)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: DRAFT.contentDigest,
      })
    },
  }

  const filed = options.filed ?? []

  return {
    authoringProposals: {
      put: (record: AuthoringProposalWrite) => {
        filed.push(record)
        return Promise.resolve({ proposalId: `prop_filed-${filed.length}` })
      },
    },
    draftShelf: shelf,
    authoringRead: {
      getAuthoringBrief: () => Promise.resolve({
        scope: { tier: 'product', key: 'local-form' },
        facts: [],
        cautions: [],
        procedures: [],
        exemplars: [],
      }),
      suiteTextCorpus: () => Promise.resolve([]),
      configuredTargetNames: () => Promise.resolve(['local-form']),
    },
  } as unknown as FunctionDeps
}

const INPUT: AuthoringLoopInput = {
  intent: 'Check that submitting the local account form shows the confirmation banner',
  scope: { tier: 'product', key: 'local-form' },
}

/** Invoke the op and hand back what the SHIPPED CONTRACT carries — never the raw return. */
async function carried(hostDeps: FunctionDeps) {
  const answered = await authoringDraftWriteSpec.invoke(INPUT, hostDeps)
  return AuthoringDraftWriteOutputSchema.parse(answered)
}

describe('the app-broken branch reports the verdict and stops', () => {
  it("a stop writes NO envelope of any kind — the proposals store is read after the invocation, never the loop's return", async () => {
    const filed: AuthoringProposalWrite[] = []
    const published: string[] = []
    const hostDeps = deps({ filed, published })
    const output = await carried(hostDeps)

    expect(output.outcome).toBe('stopped')
    // THE STORE, LISTED AFTER THE INVOCATION. Not `output`, and not the loop's arm: the claim is
    // about what reached the inbox, and only the port that writes it can answer that. Since 432
    // D-06 the same holds for the suite: a stopped draft is never written.
    expect(filed).toEqual([])
    expect(published).toEqual([])

    // IDEMPOTENCY: a second app-broken invocation against the SAME host writes zero envelopes too.
    // Nothing about a stop is recorded, so there is no second-time path that could differ.
    const again = await carried(hostDeps)
    expect(again.outcome).toBe('stopped')
    expect(filed).toEqual([])
  })

  it("reports the gate run's verdict on the typed result: run id, member outcome, signal class, the failing step's pre-interpolation text and the verifier's reasoning", async () => {
    const filed: AuthoringProposalWrite[] = []
    const output = await carried(deps({ filed }))

    expect(output.stop?.runId).toBe(ROUTING_RUN_ID)
    expect(output.stop?.memberOutcome).toBe('failed')
    expect(output.stop?.signalClass).toBe('clean-definitive-assertion-fail')
    expect(output.stop?.failurePoint?.stepIndex).toBe(2)
    // PRE-INTERPOLATION, by exact equality with the fixture's own coordinate. Post-interpolation
    // text can carry a resolved secret, so this is a copy of the router's `stepText` rather than a
    // second reading of the step.
    expect(output.stop?.failurePoint?.stepText).toBe('step 2')
    expect(output.stop?.failurePoint?.verdictSource).toBe('assert-value')

    // THE ROUTER'S OWN READING, computed here through the SHIPPED router over the same run, so the
    // reasoning and the step text on the result are the ones the routing derived rather than ones
    // this cell typed as literals.
    const route = routeRepairOrStop(output.draftRef!, routedRun())
    if (route.kind !== 'stop') throw new Error(`the fixture must route to stop, not ${route.kind}`)
    expect(output.stop?.failurePoint?.reasoning).toBe(route.failurePoint?.reasoning)
    expect(output.stop?.failurePoint?.stepText).toBe(route.failurePoint?.stepText)

    expect(output.stop?.evidenceRefs.length).toBeGreaterThan(0)
    for (const ref of output.stop?.evidenceRefs ?? []) {
      expect(ref.runId).toBe(ROUTING_RUN_ID)
    }
    // The WHOLE key set: an ordinary stop carries no abandonment pair and no prose field.
    expect(Object.keys(output.stop!).sort())
      .toEqual(['evidenceRefs', 'failurePoint', 'memberOutcome', 'runId', 'signalClass'])
  })

  it('keeps the correctly-failing draft on the shelf with its rejected receipt and starts no probe', async () => {
    const filed: AuthoringProposalWrite[] = []
    const output = await carried(deps({ filed }))

    expect(output.draftRef?.testName).toBe(DRAFT_NAME)
    expect(output.receipt?.disposition).toBe('rejected')
    expect(output.receipt?.gateRuns.at(-1)?.runId).toBe(ROUTING_RUN_ID)
    // The no-probe half is structural: `runs.start` throws, so reaching it would fail this cell
    // with that error rather than with an assertion.
    expect(Object.keys(output).sort())
      .toEqual(['draftRef', 'fanOut', 'outcome', 'receipt', 'stop'])
  })

  it('carries the stop payload only on a stopped invocation — a drafted one has no stop key', async () => {
    const filed: AuthoringProposalWrite[] = []
    const published: string[] = []
    const output = await carried(deps({ filed, published, drafted: true }))

    expect(output.outcome).toBe('drafted')
    expect('stop' in output).toBe(false)
    // THE TWO-SIDED CONTROL, restated here so the zero above is a statement about the stop branch
    // rather than about an inert writer that writes nothing on any arm. 2026-09-30, 432 D-06: the
    // drafted arm is WRITTEN rather than filed, so the control counts the write.
    expect(published).toHaveLength(1)
    expect(filed).toEqual([])
  })

  it('classify keeps the status executed and spells the new outcome word', async () => {
    const filed: AuthoringProposalWrite[] = []
    const output = await carried(deps({ filed }))

    // D-11: a spelling behind a status chat's render contract and the 397 parity walk already read.
    const verdict = authoringDraftWriteSpec.classify?.(output)
    expect(verdict?.status).toBe('executed')
    expect(verdict?.outcome.startsWith(`stopped ${DRAFT_NAME}`)).toBe(true)
  })
})
