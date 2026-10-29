// Gates win over run counts: an early-stopped unstable draft is `rejected`, not `proposal-only`.

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

export const DRAFT_STABILITY_RUNS_N = 3

// All four are always evaluated, so a draft failing only gate 4 proves that gate catches alone.
export interface DraftGateBooleans {
  // A `failed` member with a recorded termination is indefinitive, so in practice passes count.
  readonly executesDefinitive: boolean
  /** Gate 2: the verdict did not flip across the stability runs. */
  readonly stableVerdict: boolean
  /** Gate 3: the draft exercises at least one element absent from the suite union. */
  readonly addsValue: boolean
  /** Gate 4: at least one assertion step references concrete, falsifiable content. */
  readonly falsifiableAssertion: boolean
}

// Every gate except `stableVerdict`; draft mode rejects on these alone.
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
  // Below the requested count after an early stop on a verdict flip, or when a run failed to start.
  readonly stabilityRunsCompleted: number
}

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

// Every disposition but `rejected`; a rejected draft stays on the private shelf.
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
