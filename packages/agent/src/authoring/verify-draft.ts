// The gate evaluator.
//
// ONE call takes a parsed draft to a persisted, schema-valid receipt: four separately-named gate
// booleans, the per-step classification table, the per-run records, the adds-value finding, and a
// disposition that this module does not compute.
//
// ALL FOUR GATES, ALWAYS. There is no short-circuit anywhere below, and the omission is
// the point rather than an oversight. The frozen corpus proves gate INDEPENDENCE — the
// "page loaded"-only draft must report executes ✓ · stable ✓ · adds-value ✓ · falsifiable ✗ so
// that gate 4 is demonstrably the only catcher — and a vector with three of its four entries
// missing proves nothing at all. Early-stop inside gate 2 skips redundant RUNS; it never
// skips a gate. The case that makes this concrete is a draft whose gate 1 fails: gates 2, 3 and 4
// are still computed and still reported, and gate 3 in particular reports what the evidence
// actually supports rather than a default.
//
// THE DISPOSITION IS NOT DERIVED HERE. `computeDraftDisposition` is imported and its
// return is assigned. No `switch`, no `if` chain, no "keep-eligible when all four are true"
// reading of the rule lives in this package — 394 consumes the disposition and must be
// structurally unable to re-derive its own, which is only true if this side cannot either.
//
// MAP, NOT TERRITORY. The receipt is built strictly against `DraftReceiptSchema`:
// run IDs as refs, pre-interpolation step text, findings. There is no field on it that could hold
// a run payload or a resolved secret, and `.strict()` makes an attempt to add one a typed refusal
// rather than a durable leak.

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
  /**
   * Draft mode: take ONE stability run instead of the pinned N.
   *
   * Consequential rather than a speed knob — `computeDraftDisposition` answers a one-run
   * evaluation `unverified` at best, so nothing evaluated this way is keep-eligible however its
   * four booleans read (D-18, SC3); a false gate 1, 3 or 4 still rejects it.
   */
  readonly draftMode?: boolean
  /**
   * The invoking session, spread onto the receipt when the caller supplied one.
   *
   * ABSENCE IS EXCLUSION AND THIS MODULE ADDS NO DEFAULT — the receipt schema's own rule, and the
   * reason the spread below is conditional rather than an assignment. A surface that owns a
   * session stamps it at the op boundary; every other caller mints an unattributed receipt, which
   * a session window then leaves out rather than folding into whoever is asking.
   */
  readonly sessionRef?: string
  /**
   * The suite file this draft proposes to JOIN — the stability read's target.
   *
   * CHOSEN BY THE CALLER, with the draft's own file as the fallback. The shelf path a loop-staged
   * draft carries is a STAGING fact, not a membership fact: it names a digest-named file holding
   * exactly one test, so a stability read pointed at it finds only the draft itself, which the
   * neighbour exclusion then removes. D-14 asks about the suite the draft would join, and only the
   * caller knows which that is.
   */
  readonly targetSuitePath?: string
}

export interface EvaluateDraftPorts {
  readonly runs: DraftRunPortLike
  readonly fingerprints: SuiteFingerprintIndexLike
  /** D-16's evidence-less population. An empty array is a legitimate answer, not an absent port. */
  readonly textCorpus: readonly SuiteTextCorpusEntryLike[]
  readonly receipts: DraftReceiptsStoreLike
  /** Injected so a receipt's `evaluatedAt` is pinnable in a test. Defaults to the wall clock. */
  readonly now?: () => number
  /**
   * D-14's read side, consulted ONLY when gate 2 flips.
   *
   * ONE BUNDLE OF TWO HALVES that are useless apart, on the `AuthoringFunnelPortLike` reasoning
   * one level down. `port` is the funnel's read bundle — which carries NO run capability at all,
   * so the zero-runs law is structural rather than remembered. `product` is the partition the
   * projection is keyed on, and it is a THUNK because the answer is OBSERVED rather than derived:
   * a composition learns it from the first gate-run acknowledgement, and D-04 forbids
   * short-circuiting, so by the time gate 2 can flip at least one run has been acknowledged. It
   * answers `undefined` when nothing was observed, and the consultation is then SKIPPED —
   * deriving a product from configuration instead would be a second rule for a fact the write
   * side already decides, and the first time the two disagreed this message would report another
   * application's flakiness as this target's.
   */
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

/**
 * Evaluate one parsed draft through all four keep-gates and persist the receipt.
 *
 * Returns the receipt AND writes it, so a caller never has to re-read the store to learn
 * what was just decided.
 */
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

  // D-14'S LIVE ARM, ON THE FLIP PATH AND NOWHERE ELSE. A mixed verdict rejects the draft, and
  // the naive answer — discard it silently — is wrong often enough to matter: a target whose
  // EXISTING tests already flip or sit in quarantine is a target where the APPLICATION is
  // unstable, and an author can only act on that if somebody says it. The read is over records
  // that already exist and starts nothing.
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

  // Gate 4 — the deterministic static check, whose table lands verbatim on the receipt.
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

/**
 * Read the target's recorded stability, on a FLIP and only on a flip.
 *
 * THREE WAYS TO GET NOTHING, and all three are the honest answer rather than a degraded guess: the
 * verdict did not flip (there is nothing to explain), the composition bound no consultation, or no
 * product was observed. In the last case the posture is stated by NOTHING — the reason string
 * stays exactly what it has always been — because a fabricated product would read another
 * application's history and say so with names.
 *
 * The gather itself carries no run capability, so "zero extra runs" is a property of the port's
 * shape rather than a rule this call site has to keep.
 */
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
