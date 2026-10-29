// Reads existing records only and starts no runs; a receipt with no `sessionRef` is excluded.

import {
  assessSuiteStability,
  computeAuthoringFunnel,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringFunnel,
  AuthoringFunnelWindow,
  DraftReceipt,
  QuarantineEntryState,
  SuiteNeighbourRow,
  SuiteStabilityAssessment,
} from '@vostride/agent-qa-schema'

import type { DraftReceiptsReadPortLike, SuiteTestIdentity } from './ports.js'

/**
 * One test's recorded member outcomes, as the run-outcome projection already keys them.
 *
 * A STRUCTURAL MIRROR on this file's siblings' discipline: the real reader lives in
 * `knowledge-local` and this package may not name it. Outcomes are free strings in the run
 * store's own words — the runner owns that vocabulary and grows it, and a closed copy here would
 * read a newer runner's outcome as unknown.
 *
 * An EMPTY array is "nothing recorded", never "recorded as fine"; `assessSuiteStability` turns
 * that into the honest `no-history` posture rather than into a clean bill of health.
 */
export interface SuiteOutcomeHistoryPortLike {
  // `product` comes first: the projection is keyed by product, so another app's history stays out.
  testsIn(product: string, filePath: string): Promise<readonly SuiteTestIdentity[]>
  /** One identity's recorded member outcomes, newest last. */
  outcomesFor(product: string, filePath: string, testName: string): Promise<readonly string[]>
}

// The funnel's reads; the stability halves are optional, and nothing here can start a run.
export interface AuthoringFunnelPortLike {
  readonly receipts: DraftReceiptsReadPortLike
  readonly outcomes?: SuiteOutcomeHistoryPortLike
  readonly quarantine?: { list(): Promise<readonly QuarantineEntryState[]> }
}

/**
 * Scope the receipt population to the window. PURE, exported so a cell can drive it alone.
 *
 * `last-n` orders by `evaluatedAt` DESC and takes n. The store's own `list()` order is
 * digest-lexicographic — deterministic, and deliberately not chronological — so a `last-n` that
 * inherited it would return an arbitrary n rather than the most recent n. Ties keep the store's
 * order, which is why the sort is stable rather than a comparator that reorders equal instants.
 */
export function scopeReceiptsToWindow(
  receipts: readonly DraftReceipt[],
  window: AuthoringFunnelWindow,
): readonly DraftReceipt[] {
  switch (window.scope) {
    case 'all-time':
      return receipts
    case 'session':
      // EXACT string equality, and an ABSENT ref is excluded. See the header.
      return receipts.filter((receipt) => receipt.sessionRef === window.sessionRef)
    case 'last-n':
      return [...receipts]
        .map((receipt, index) => ({ receipt, index }))
        .sort((left, right) => (
          right.receipt.evaluatedAt - left.receipt.evaluatedAt || left.index - right.index
        ))
        .slice(0, window.n)
        .map((row) => row.receipt)
  }
}

// `dedupRefusals` stays absent: a stage-2 refusal leaves no record, so `0` would be false.
export async function projectAuthoringFunnel(
  window: AuthoringFunnelWindow,
  port: AuthoringFunnelPortLike,
): Promise<AuthoringFunnel> {
  const receipts = scopeReceiptsToWindow(await port.receipts.list(), window)
  return computeAuthoringFunnel({ receipts, sideCounters: {} })
}

// Starts no runs; the draft's own identity is excluded, and an unbound port is `no-history`.
export async function gatherSuiteStability(
  input: {
    /**
     * The partition the outcome projection keys on — `slugBranch` of the run's own scope, as the
     * fold wrote it. REQUIRED and never defaulted: there is no correct product to fall back to,
     * and a caller that does not know one must not ask at all.
     */
    readonly product: string
    readonly targetFilePath: string
    readonly draftTestName?: string
  },
  port: AuthoringFunnelPortLike,
): Promise<SuiteStabilityAssessment> {
  if (port.outcomes === undefined) {
    return assessSuiteStability({ targetFilePath: input.targetFilePath, neighbours: [] })
  }

  const quarantined = new Set(
    (await port.quarantine?.list() ?? [])
      .filter((entry) => entry.filePath === input.targetFilePath)
      .map((entry) => entry.testName),
  )

  const identities = (await port.outcomes.testsIn(input.product, input.targetFilePath))
    .filter((identity) => identity.testName !== input.draftTestName)

  const neighbours: SuiteNeighbourRow[] = []
  for (const identity of identities) {
    neighbours.push({
      filePath: identity.filePath,
      testName: identity.testName,
      outcomes: await port.outcomes.outcomesFor(
        input.product,
        identity.filePath,
        identity.testName,
      ),
      quarantined: quarantined.has(identity.testName),
    })
  }

  return assessSuiteStability({ targetFilePath: input.targetFilePath, neighbours })
}
