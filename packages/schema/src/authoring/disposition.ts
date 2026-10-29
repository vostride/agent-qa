// The draft disposition: ONE derivation site.
//
// A draft receipt reports four independent gate booleans. The disposition is what
// those booleans plus the stability-run counts MEAN, and it is computed here — once — so that no
// consumer can re-derive its own answer.
//
// the never-auto-keep rule is superseded. The disposition stays as the
// verification report, and what it now decides is whether the final draft is WRITTEN to its test
// path: `keep-eligible`, `proposal-only` and `unverified` are written, `rejected` is not. That
// decision is `draftDispositionWritesTarget` below, beside the table it reads.
//
// 2026-10-03 (quick 261003-cpv, 432 review WR-09): rule 1 now follows D-06 literally, "writes the
// test file unless a keep-gate rejected it". One draft-mode run DECIDES gates 1, 3 and 4: gate 1
// reads that run's own verdict, gate 3 that run's fingerprint against the suite plus the step text,
// gate 4 the static assertion check (`verify-draft.ts` evaluates all four on every evaluation and
// holds none at a constant). Only gate 2 needs more than one run: with one run it is true exactly
// when a verdict was observed, so it can never report instability and never rejects in draft mode.
// Before this, rule 1 answered 'unverified' unconditionally, so a draft-mode draft whose run
// reached no verdict, or that added nothing or asserted nothing falsifiable, was written into the
// suite. Stored receipts keep the disposition they were given.
//
// THE TABLE (contract, not implementation detail), evaluated in this order:
//   1. `stabilityRunsRequested === 1` (draft mode): any of `executesDefinitive`, `addsValue` or
//      `falsifiableAssertion` false → 'rejected'; otherwise 'unverified', including when all four
//      gates passed. One run cannot observe stability, so a one-run evaluation never earns a
//      keep-shaped answer; 'unverified' rather than 'rejected' because no gate one run decides
//      said no.
//   2. any gate boolean false → 'rejected'. Early-stopped stability runs (D-17 stops on the
//      first verdict flip) arrive here with `stabilityRunsCompleted` below N and must still
//      read 'rejected': the flip already proved instability, and the unrun runs would only
//      re-prove it. Letting the short count win would write a proven-unstable draft.
//   3. all four true AND `stabilityRunsCompleted >= DRAFT_STABILITY_RUNS_N` → 'keep-eligible'.
//   4. all four true with fewer completed runs → 'proposal-only'. The name is historical: a short
//      evaluation used to become a proposal. Since 432 D-06 it is written like the others, and
//      the name tells the reader the evaluation was short.

/**
 * The closed disposition vocabulary. Stored receipts and the written-test receipt carry these
 * exact names; renaming one is a migration of durable records, not a rename.
 */
export const DRAFT_DISPOSITIONS = [
  'keep-eligible',
  'proposal-only',
  'rejected',
  'unverified',
] as const

export type DraftDisposition = (typeof DRAFT_DISPOSITIONS)[number]

/**
 * Stability runs a draft must complete before it can be keep-eligible. PINNED, never config.
 *
 * changing this number changes what the stability gate MEANS, so a retune is a
 * measurement, not a preference. Before moving it, re-measure on the frozen corpus: (a) the
 * gate-2 rejector's flip rate at the new N — the corpus rejector alternates on a pinned
 * per-request schedule, so a wrong N can make a proven-unstable draft read stable; (b) the
 * accept control's pass rate at the new N, since a higher N multiplies the chance that an
 * unrelated flake denies a good draft; (c) the wall-clock cost per draft (local-form runs are
 * ~22s each, so N is a direct multiplier on the authoring loop's latency budget). Record the
 * new numbers beside the frozen expectations table; a retune that only argues from intuition
 * is the failure this comment exists to prevent.
 */
export const DRAFT_STABILITY_RUNS_N = 3

/**
 * The four keep-gates, reported separately and never collapsed.
 *
 * All four are always present: D-04 forbids short-circuiting, because the corpus proves gate
 * INDEPENDENCE — a draft whose only failing gate is 4 demonstrates that gate 4 is the sole
 * catcher, which is unprovable if evaluation stops at the first `false`.
 */
export interface DraftGateBooleans {
  /**
   * Gate 1: the draft reached a definitive verdict on every run.
   *
   * Definitive as `stability-gates.ts` enforces it (393-09, WR-04 doc arm): a `passed`, `failed`
   * or `healed` member outcome — a heal counts as a pass — with no planning failure, no cycle
   * flag and no recorded step termination on any step. A `failed` member carrying a termination
   * is indefinitive, and 9 of 9 failed members surveyed in the demo run store carry one, so on
   * current builds this gate effectively admits passing runs only. The app-broken branch — a
   * draft that fails because the application is wrong — ends the invocation as a reported stop:
   * the gate run's verdict on the op result, the draft retained on the shelf (411), rather than a
   * keep here.
   */
  readonly executesDefinitive: boolean
  /** Gate 2: the verdict did not flip across the stability runs. */
  readonly stableVerdict: boolean
  /** Gate 3: the draft exercises at least one element absent from the suite union. */
  readonly addsValue: boolean
  /** Gate 4: at least one assertion step references concrete, falsifiable content. */
  readonly falsifiableAssertion: boolean
}

/**
 * The gates one stability run decides: every gate except `stableVerdict`.
 * Draft mode rejects on these and only these.
 */
export const SINGLE_RUN_DRAFT_GATES = [
  'executesDefinitive',
  'addsValue',
  'falsifiableAssertion',
] as const satisfies readonly (keyof DraftGateBooleans)[]

/** Whether every gate one run decides passed. */
export function singleRunGatesPass(gates: DraftGateBooleans): boolean {
  return SINGLE_RUN_DRAFT_GATES.every((gate) => gates[gate])
}

export interface DraftDispositionInput {
  readonly gates: DraftGateBooleans
  /**
   * Stability runs the evaluation ASKED for. `1` is draft mode and is the only value with a
   * special meaning — rule 1 above, where only gates 1, 3 and 4 can reject.
   */
  readonly stabilityRunsRequested: number
  /**
   * Stability runs that actually completed. Below the requested count either because the
   * evaluation early-stopped on a verdict flip or because a run could not be taken.
   */
  readonly stabilityRunsCompleted: number
}

/**
 * The ONE disposition derivation. Pure, total, and order-sensitive exactly as the
 * table above states; every branch is pinned by `__tests__/disposition.test.ts`.
 */
export function computeDraftDisposition(input: DraftDispositionInput): DraftDisposition {
  if (input.stabilityRunsRequested === 1) {
    return singleRunGatesPass(input.gates) ? 'unverified' : 'rejected'
  }

  const { executesDefinitive, stableVerdict, addsValue, falsifiableAssertion } = input.gates
  if (!(executesDefinitive && stableVerdict && addsValue && falsifiableAssertion)) {
    return 'rejected'
  }

  return input.stabilityRunsCompleted >= DRAFT_STABILITY_RUNS_N ? 'keep-eligible' : 'proposal-only'
}

/**
 * The dispositions whose final draft is written to its target.
 *
 * Every disposition except `rejected`: the gates either said yes (`keep-eligible`), said yes over
 * too few runs (`proposal-only`), or said yes on every gate one run decides while stability was
 * not given enough runs (`unverified`; 261003-cpv, WR-09). Only `rejected` is a gate saying no,
 * and a rejected draft stays on the private shelf.
 */
export const DRAFT_WRITTEN_DISPOSITIONS = [
  'keep-eligible',
  'proposal-only',
  'unverified',
] as const satisfies readonly DraftDisposition[]

export type DraftWrittenDisposition = (typeof DRAFT_WRITTEN_DISPOSITIONS)[number]

/** Whether a final draft with this disposition is written to its target. */
export function draftDispositionWritesTarget(
  disposition: DraftDisposition,
): disposition is DraftWrittenDisposition {
  return (DRAFT_WRITTEN_DISPOSITIONS as readonly DraftDisposition[]).includes(disposition)
}
