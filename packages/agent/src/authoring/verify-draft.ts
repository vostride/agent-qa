// All four gates always run, and the disposition comes from `computeDraftDisposition` alone.

import {
  computeDraftDisposition,
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
  testFingerprintElements,
} from '@vostride/agent-qa-schema'
import type {
  DraftReceipt,
  PerTestOutcome,
  SuiteStabilityAssessment,
} from '@vostride/agent-qa-schema'

import { addsValueGate } from './adds-value.js'
import { assertionStrengthGate } from './assertion-strength.js'
import { gatherSuiteStability } from './funnel.js'
import type { AuthoringFunnelPortLike } from './funnel.js'
import type {
  DraftReceiptsStoreLike,
  DraftRunPortLike,
  ParsedDraftLike,
  SuiteFingerprintIndexLike,
  SuiteTextCorpusEntryLike,
} from './ports.js'
import { runStabilityGates } from './stability-gates.js'

/**
 * A capability the evaluation needs was not supplied by the composition.
 *
 * The named-refusal idiom `FunctionNotBoundError` establishes for the function layer, applied one
 * level down: a host missing a run port cannot evaluate gates 1-2 at all, and the honest answer is
 * to say which port by name rather than to report four booleans computed from nothing.
 */
export class DraftEvaluationPortNotBoundError extends Error {
  constructor(readonly port: string) {
    super(`the draft gate evaluator has no ${port} port bound in this composition`)
    this.name = 'DraftEvaluationPortNotBoundError'
  }
}

export interface EvaluateDraftInput {
  readonly draft: ParsedDraftLike
  // One run, so `computeDraftDisposition` answers `unverified` at best; a false gate still rejects.
  readonly draftMode?: boolean
  // Absent means unattributed: this module adds no default, so a session window leaves it out.
  readonly sessionRef?: string
  // Chosen by the caller, because a shelf file holds only the draft and has no neighbours.
  readonly targetSuitePath?: string
}

export interface EvaluateDraftPorts {
  readonly runs: DraftRunPortLike
  readonly fingerprints: SuiteFingerprintIndexLike
  // Suite tests with no fingerprint evidence; an empty array is an answer, not an absent port.
  readonly textCorpus: readonly SuiteTextCorpusEntryLike[]
  readonly receipts: DraftReceiptsStoreLike
  /** Injected so a receipt's `evaluatedAt` is pinnable in a test. Defaults to the wall clock. */
  readonly now?: () => number
  // `product` is a thunk observed from gate-run acknowledgements; undefined skips the consultation.
  readonly suiteStability?: {
    readonly port: AuthoringFunnelPortLike
    product(): string | undefined
  }
}

/**
 * The draft's own fingerprint elements, from its own gate-run evidence.
 *
 * WHY EVIDENCE AND NOT STEP TEXT. A suite element is minted from what the run actually resolved —
 * `{kind, type, anchor: {t:'el', role, name, ordinal}}` after normalization — so its bytes encode
 * facts (the element's a11y role, its normalized accessible name, its ordinal among peers) that
 * exist only after a browser rendered the page. Deriving the draft's side from the NL step text
 * instead would have to invent those facts, and an invented anchor matches a resolved one only by
 * accident: every draft element would come out novel and gate 3 would return `true` for every
 * draft ever evaluated, including the corpus's own near-duplicate rejector. A gate that cannot
 * return false is not a gate. Gates 1-2 have already executed the draft by the time this runs, so
 * the evidence is in hand and no extra run is taken for it.
 *
 * WHICH RUN'S EVIDENCE. The newest run that yielded any elements, which is the suite fold's own
 * rule applied to the draft: newest evidence wins, and a run contributing zero elements never
 * erases what an earlier one observed. The alternative — unioning across runs — would make the
 * draft's element set grow with N while every suite identity's stays fixed at one run's worth,
 * which is an asymmetry that would quietly make longer evaluations look more novel.
 */
function draftFingerprintElements(members: readonly PerTestOutcome[]): string[] {
  for (let index = members.length - 1; index >= 0; index -= 1) {
    const elements = testFingerprintElements(members[index] as PerTestOutcome)
    if (elements.length > 0) return elements
  }
  return []
}

// Returns the receipt and writes it, so a caller never re-reads the store.
export async function evaluateDraft(
  input: EvaluateDraftInput,
  ports: EvaluateDraftPorts,
): Promise<DraftReceipt> {
  if (ports.runs === undefined) throw new DraftEvaluationPortNotBoundError('runs')
  if (ports.fingerprints === undefined) throw new DraftEvaluationPortNotBoundError('fingerprints')
  if (ports.receipts === undefined) throw new DraftEvaluationPortNotBoundError('receipts')

  const stabilityRunsRequested = input.draftMode === true ? 1 : DRAFT_STABILITY_RUNS_N

  // Gates 1 and 2.
  const stability = await runStabilityGates({
    draft: input.draft,
    runPort: ports.runs,
    runsRequested: stabilityRunsRequested,
  })

  // Only on a flip: unstable existing tests mean the app is unstable, and the author is told so.
  const suiteStability = await consultSuiteStability(
    input.draft,
    input.targetSuitePath,
    stability.distinctOutcomes,
    ports,
  )

  // Gate 3, over the draft's own execution evidence.
  const draftElements = draftFingerprintElements(stability.draftMembers)
  const addsValue = addsValueGate({
    draft: { testName: input.draft.testName, steps: input.draft.steps },
    draftElements,
    index: ports.fingerprints,
    textCorpus: ports.textCorpus,
  })

  // Gate 4, whose table lands verbatim on the receipt.
  const falsifiable = assertionStrengthGate({ steps: input.draft.steps })

  const runRefs = stability.gateRuns.map((row) => row.runId)
  const receipt = DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: input.draft.filePath,
      testId: input.draft.testId,
      testName: input.draft.testName,
      contentDigest: input.draft.contentDigest,
    },
    gates: {
      executesDefinitive: {
        pass: stability.executesDefinitive,
        runRefs,
        indefinitiveRunRefs: stability.gateRuns
          .filter((row) => !row.definitive)
          .map((row) => row.runId),
        reason: stabilityGateOneReason(stability.executesDefinitive, stability.gateRuns.length),
      },
      stableVerdict: {
        pass: stability.stableVerdict,
        runRefs,
        distinctOutcomes: stability.distinctOutcomes,
        earlyStopped: stability.earlyStopped,
        reason: stabilityGateTwoReason(
          stability.distinctOutcomes,
          stability.earlyStopped,
          suiteStability,
        ),
      },
      addsValue: {
        pass: addsValue.pass,
        novelElementCount: addsValue.finding.novelElements.length,
        comparedTestCount: addsValue.finding.comparedTests.length,
        reason: addsValue.reason,
      },
      falsifiableAssertion: {
        pass: falsifiable.pass,
        assertionStepCount: falsifiable.assertionStepCount,
        falsifiableAssertionCount: falsifiable.falsifiableAssertionCount,
        reason: falsifiable.reason,
      },
    },
    stepTable: falsifiable.table,
    gateRuns: stability.gateRuns,
    addsValueFinding: addsValue.finding,
    stabilityRunsRequested,
    stabilityRunsCompleted: stability.runsCompleted,
    disposition: computeDraftDisposition({
      gates: {
        executesDefinitive: stability.executesDefinitive,
        stableVerdict: stability.stableVerdict,
        addsValue: addsValue.pass,
        falsifiableAssertion: falsifiable.pass,
      },
      stabilityRunsRequested,
      stabilityRunsCompleted: stability.runsCompleted,
    }),
    evaluatedAt: (ports.now ?? Date.now)(),
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
  })

  await ports.receipts.put(receipt)
  return receipt
}

function stabilityGateOneReason(pass: boolean, runCount: number): string {
  return pass
    ? `all ${runCount} gate-run(s) reached a final verdict about the draft (D-17)`
    : `${runCount} gate-run(s) taken; at least one reached no final verdict — see gateRuns[].reason`
}

// Nothing on no flip, no bound consultation or no observed product; a guessed one misattributes.
async function consultSuiteStability(
  draft: ParsedDraftLike,
  targetSuitePath: string | undefined,
  distinctOutcomes: readonly string[],
  ports: EvaluateDraftPorts,
): Promise<SuiteStabilityAssessment | undefined> {
  if (distinctOutcomes.length <= 1) return undefined
  const consultation = ports.suiteStability
  if (consultation === undefined) return undefined
  const product = consultation.product()
  if (product === undefined) return undefined

  return await gatherSuiteStability(
    {
      product,
      // THE CHOSEN TARGET, falling back to the draft's own file. A standalone verify names no
      // join, and a committed suite file is its own target; a loop-staged draft names the suite
      // it proposes to join, because its own path is a one-test shelf artifact.
      targetFilePath: targetSuitePath ?? draft.filePath,
      // The draft's OWN identity is not evidence about the suite it is trying to join; counting
      // its own flip as a neighbour's would let every mixed verdict explain itself.
      draftTestName: draft.testName,
    },
    consultation.port,
  )
}

/**
 * Gate 2's reason, composed HERE and nowhere else.
 *
 * The assessment is APPENDED to the draft's own verdict rather than replacing it: "your test
 * flipped" and "your app is unstable here" are two different sentences and an author needs both —
 * told only the second, they would not know their draft was rejected; told only the first, they
 * would go and debug a test the application broke.
 */
function stabilityGateTwoReason(
  distinctOutcomes: readonly string[],
  earlyStopped: boolean,
  suiteStability?: SuiteStabilityAssessment,
): string {
  if (distinctOutcomes.length <= 1) {
    return `one verdict across the completed runs: ${distinctOutcomes[0] ?? 'none observed'}`
  }
  return `the verdict flipped across runs (${distinctOutcomes.join(' -> ')})`
    + (earlyStopped ? ' — remaining runs skipped, the flip is already proven (D-17)' : '')
    + (suiteStability === undefined ? '' : ` — ${suiteStability.message}`)
}
