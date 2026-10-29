// The fan-out report on the op's OWN output (394-14 · WTST-08, SC-5's reporting half).
//
// WHY THIS FILE EXISTS AND `fan-out-accounting.test.ts` DOES NOT COVER IT. That file measures the
// LOOP: `runAuthoringLoop` returns an `AuthoringLoopResult` whose `fanOut` is correct on every arm,
// and every one of its cells reads that in-process value. 394-VERIFICATION found the whole of it
// unreachable one layer up — `invoke()` built its answer from four fields and DISCARDED
// `result.fanOut`, and `AuthoringDraftWriteOutputSchema` was `.strict()` with no field the report
// could have ridden. So the loop's number was correct and no caller on any host could read it.
//
// THE MEASUREMENT IS THEREFORE THROUGH THE OUTPUT SCHEMA, NEVER OFF THE RETURNED OBJECT. Every
// cell below parses what `invoke` answered with the shipped contract before asserting anything: a
// field the op returns but the contract strips is not carried, and a cell reading the raw object
// would have reported a pass for exactly the shape this plan exists to fix.
//
// vitest does not typecheck `.test.ts` (`typecheck.include` is `*.test-d.ts`); `tsc --noEmit` is
// this file's only type authority.

import {
  AuthoringDraftWriteOutputSchema,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { authoringDraftWriteSpec } from '../ops/authoring-draft-write.js'
import { authoringFanOutBound } from '../../authoring/loop.js'
import type { AuthoringLoopInput } from '../../authoring/loop.js'
import { FunctionNotBoundError } from '../spec.js'
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

const DRAFT_PATH = 'tests/.agent-qa-drafts/report-fixture.yaml'
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

/**
 * A keep-eligible receipt naming the gate runs it took, PARSED by the shipped schema.
 *
 * Parsed rather than cast for the produced-not-literal reason: a receipt this file typed as a
 * literal could pin a shape the evaluator would never mint, and the report's `consumed` list is
 * read straight off `gateRuns`.
 */
const ACCEPTED: DraftReceipt = DraftReceiptSchema.parse({
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
})

interface SuiteText {
  readonly filePath: string
  readonly testName: string
  readonly stepsText: readonly string[]
}

/**
 * The op's host, scripted to the two arms this file needs.
 *
 * The run port answers only `get`: this file drives the happy path and the stage-2 refusal, and
 * neither starts a probe — so a `start` that THROWS is the structural statement that no cell here
 * is quietly exercising the repair arm.
 */
function deps(options: {
  readonly suiteText?: readonly SuiteText[]
  /** Leave the retired proposals port unbound — since 432 D-06 nothing consults it. */
  readonly unboundProposals?: true
  /** Leave the shelf unbound — the host with no write half at all. */
  readonly unboundShelf?: true
  readonly filed?: AuthoringProposalWrite[]
  readonly published?: { readonly draftPath: string; readonly targetPath: string }[]
  /** How the writer answers; written by default. */
  readonly writeFails?: true
} = {}): FunctionDeps {
  const documents = new Map<string, { endedAt: number }>()
  GATE_RUN_IDS.forEach((runId, index) => documents.set(runId, { endedAt: 100 + index }))

  const shelf = {
    runs: {
      start: () => { throw new Error('neither arm in this file starts a run') },
      get: (runId: string) => Promise.resolve(documents.get(runId)),
    },
    model: () => Promise.resolve({
      modelId: 'fixture:report',
      generate: () => Promise.resolve({ text: MODEL_DOCUMENT }),
    }),
    write: () => Promise.resolve({ kind: 'staged', draft: DRAFT } as DraftStageOutcome),
    applyPatches: (candidate: ParsedDraftLike) => Promise.resolve({
      kind: 'staged' as const,
      draft: candidate,
    }),
    verifyDraft: () => Promise.resolve(ACCEPTED),
    // 432 D-06: the direct writer the loop's final write reaches. It starts no run.
    publish: (request: { readonly draftPath: string; readonly targetPath: string }) => {
      options.published?.push(request)
      if (options.writeFails === true) {
        return Promise.resolve({
          kind: 'not-written' as const,
          targetPath: request.targetPath,
          reason: 'write-failed' as const,
          detail: 'ENOSPC: no space left on device',
        })
      }
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: DRAFT.contentDigest,
      })
    },
  }

  const filed = options.filed ?? []

  return {
    ...(options.unboundProposals === true ? {} : {
      authoringProposals: {
        put: (record: AuthoringProposalWrite) => {
          filed.push(record)
          return Promise.resolve({ proposalId: `prop_filed-${filed.length}` })
        },
      },
    }),
    ...(options.unboundShelf === true ? {} : { draftShelf: shelf }),
    authoringRead: {
      getAuthoringBrief: () => Promise.resolve({
        scope: { tier: 'product', key: 'local-form' },
        facts: [],
        cautions: [],
        procedures: [],
        exemplars: [],
      }),
      suiteTextCorpus: () => Promise.resolve(options.suiteText ?? []),
      // 394-33 WR-07: the `target` vocabulary the compile prompt serves. This bench's model is
      // scripted and reads none of it — the verb is here because the port requires it, and
      // because this deps object is cast, so nothing but a run would have told us.
      configuredTargetNames: () => Promise.resolve(['local-form']),
    },
  } as unknown as FunctionDeps
}

const INPUT: AuthoringLoopInput = {
  intent: 'Check that submitting the local account form shows the confirmation banner',
  scope: { tier: 'product', key: 'local-form' },
}

/** The suite test the intent already describes, so the dedup screen refuses before compile. */
const DUPLICATE_SUITE: readonly SuiteText[] = [{
  filePath: 'tests/local-form-submit.yaml',
  testName: 'Check that submitting the local account form shows the confirmation banner',
  stepsText: ['Submit the local account form and check the confirmation banner'],
}]

/** Invoke the op and hand back what the SHIPPED CONTRACT carries — never the raw return. */
async function carried(options: { readonly suiteText?: readonly SuiteText[] } = {}) {
  const answered = await authoringDraftWriteSpec.invoke(INPUT, deps(options))
  return AuthoringDraftWriteOutputSchema.parse(answered)
}

describe('the op carries the fan-out report it computed (the reporting half)', () => {
  it('a drafted invocation answers with a fanOut report that survives the output contract', async () => {
    const output = await carried()

    expect(output.outcome).toBe('drafted')
    // THE WHOLE OF THE GAP, IN ONE ASSERTION. `invoke()` discarded `result.fanOut` and the
    // `.strict()` contract had no field it could have ridden, so this key was unreachable on
    // every host — the loop's number was correct and nobody could read it.
    expect(output).toHaveProperty('fanOut')
    expect(output.fanOut?.consumedTotal).toBe(DRAFT_STABILITY_RUNS_N)
    expect(output.fanOut?.exceedsPreview).toBe(false)
    // The runs are named, not merely counted — a total with no refs cannot be checked against the
    // run store by whoever doubts it.
    expect(output.fanOut?.consumed.map((run) => run.runId)).toEqual([...GATE_RUN_IDS])
  })

  it('the reported ceiling IS the disclosed one — one function of one input', async () => {
    const output = await carried()

    // The number a person approved at the confirm and the number they are shown afterwards are
    // the SAME arithmetic, asserted against `authoringFanOutBound` rather than against a literal:
    // a literal would keep passing while the bound and the disclosure drifted apart.
    expect(output.fanOut?.previewed).toEqual(authoringFanOutBound(INPUT))
    expect(output.fanOut?.previewed.total).toBe(authoringFanOutBound(INPUT).total)
  })

  it('a stage-2 refusal reports its cost too — the field is PRESENT and the count is 0', async () => {
    const output = await carried({ suiteText: DUPLICATE_SUITE })

    expect(output.outcome).toBe('refused')
    // "This invocation cost nothing" is a fact a caller is entitled to, and an ABSENT field says
    // something different from a zero one: absent is "nobody counted", zero is "nothing ran".
    expect(output).toHaveProperty('fanOut')
    expect(output.fanOut?.consumedTotal).toBe(0)
    expect(output.fanOut?.previewed.total).toBe(0)
    expect(output.fanOut?.exceedsPreview).toBe(false)
  })

  it('no PROPOSAL rides the wire — only the report and the written-test receipt ride', async () => {
    const output = await carried()

    // The control for the three cells above. A fix that had widened the contract to "carry what
    // the loop returned" would pass every cell above and red this one. 2026-09-30, 432 D-06: the
    // written-test receipt joins the report — the file written and how well it was verified.
    expect(output).not.toHaveProperty('proposal')
    expect(output).not.toHaveProperty('stages')
    expect(Object.keys(output).sort())
      .toEqual(['draftRef', 'fanOut', 'outcome', 'receipt', 'written'])
  })
})

// 2026-09-30, 432 D-06: re-spelled in place. These cells pinned the proposal 394-18 filed before
// the op answered. The drafted outcome is now written, not filed, so each keeps its subject — what
// the op does with a drafted outcome before it answers — and measures the write.
describe('the drafted outcome is WRITTEN before this op answers', () => {
  it('writes the drafted outcome once through the shelf and files no proposal', async () => {
    const filed: AuthoringProposalWrite[] = []
    const published: { readonly draftPath: string; readonly targetPath: string }[] = []

    const output = AuthoringDraftWriteOutputSchema.parse(
      await authoringDraftWriteSpec.invoke(INPUT, deps({ filed, published })),
    )

    expect(output.outcome).toBe('drafted')
    expect(filed).toEqual([])
    expect(published).toHaveLength(1)
    expect(published[0]?.draftPath).toBe(DRAFT.filePath)
    expect(output.written?.file).toEqual({
      kind: 'written',
      filePath: published[0]?.targetPath,
      contentDigest: DRAFT.contentDigest,
    })
    expect(output.written?.disposition).toBe(ACCEPTED.disposition)
  })

  it('a stage-2 REFUSAL writes nothing and files nothing — the arm has no draft', async () => {
    // The two-sided control. A write outside the outcome narrow would put a file in the suite for
    // an invocation that authored nothing, and every cell above would still pass.
    const filed: AuthoringProposalWrite[] = []
    const published: { readonly draftPath: string; readonly targetPath: string }[] = []

    const output = await authoringDraftWriteSpec.invoke(
      INPUT,
      deps({ suiteText: DUPLICATE_SUITE, filed, published }),
    )

    expect((output as { outcome: string }).outcome).toBe('refused')
    expect(filed).toEqual([])
    expect(published).toEqual([])
  })

  it('a host that cannot WRITE refuses by name, before a single run is spent', async () => {
    // FAIL-CLOSED AT THE TOP. The writer rides the shelf, so a host without the write half is
    // refused with the read/write check, never after up to nine child runs.
    let caught: unknown
    try {
      await authoringDraftWriteSpec.invoke(INPUT, deps({ unboundShelf: true }))
    } catch (error) {
      caught = error
    }

    expect(typeof FunctionNotBoundError).toBe('function')
    expect(caught).toBeInstanceOf(FunctionNotBoundError)
    expect((caught as Error).message).toContain('authoring.draft.write')
  })

  it('no longer needs the retired proposals port — a host without it still writes', async () => {
    const published: { readonly draftPath: string; readonly targetPath: string }[] = []

    const output = await authoringDraftWriteSpec.invoke(
      INPUT,
      deps({ unboundProposals: true, published }),
    )

    expect((output as { outcome: string }).outcome).toBe('drafted')
    expect(published).toHaveLength(1)
  })

  it('a drafted outcome whose write failed is reported failed, never executed', async () => {
    const output = AuthoringDraftWriteOutputSchema.parse(
      await authoringDraftWriteSpec.invoke(INPUT, deps({ writeFails: true })),
    )

    expect(output.outcome).toBe('drafted')
    expect(output.written?.file).toMatchObject({ kind: 'not-written', reason: 'write-failed' })
    const verdict = authoringDraftWriteSpec.classify?.(output)
    expect(verdict?.status).toBe('failed')
    expect(verdict?.outcome).toContain('not written: write-failed')
    // …and the written arm is the control: the same invocation that lands is executed.
    const landed = AuthoringDraftWriteOutputSchema.parse(
      await authoringDraftWriteSpec.invoke(INPUT, deps()),
    )
    expect(authoringDraftWriteSpec.classify?.(landed)?.status).toBe('executed')
    expect(authoringDraftWriteSpec.classify?.(landed)?.outcome).toContain(' — wrote tests/')
  })
})
