// The funnel projection and the mixed-verdict stability gather.
//
// A PROJECTION AND NOTHING ELSE. Everything here reads durable records this project already keeps
// — the draft receipts, the run-outcome projection, the quarantine ledger —
// scopes them to a window, and hands them to `computeAuthoringFunnel`, which owns every number.
// NOTHING NEW IS PERSISTED: the receipts ARE the funnel's truth, so every caller of the one
// read op — today, a read-scoped function caller; there is no CLI funnel command and no per-run
// digest section — reads the same numbers by construction rather than by consumers agreeing to.
// This module re-derives nothing and re-sorts nothing that the computation owns.
//
// THE WINDOW IS A SCOPE, NOT A FILTER. It selects which invocations the projection is over — the
// denominator — rather than which rows survive a projection already taken. The `session` arm
// compares `sessionRef` by EXACT STRING EQUALITY, and a receipt carrying NO ref is EXCLUDED rather
// than defaulted in: folding an unattributed receipt into whichever session is asking would
// attribute another author's drafts, and in the direction that matters it would inflate `built`
// under somebody else's keep rate.
//
// THE STABILITY GATHER STARTS ZERO RUNS. It reads the outcome history and the quarantine
// ledger, both of which are records of runs that already happened, and hands rows to the pure
// `assessSuiteStability`. WTST-08's fan-out preview promises a bound before dispatch; a stability
// check that took its own runs would make that promise one nobody could honour, which is why D-14
// is read-side and why the port bundle below carries no run capability at all — the absence is
// structural rather than a rule somebody has to remember.

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
  /**
   * The stable identities the target suite file has run evidence for, in ONE product.
   *
   * `product` LEADS BOTH VERBS because the projection these read is keyed
   * (product, filePath, testName) and nothing else is a stable identity there. A port shaped
   * without it could only be bound by guessing a product or by serving every product's history
   * under one file path — and the second would report another application's flakiness as this
   * target's, which is the whole failure the message exists to avoid.
   */
  testsIn(product: string, filePath: string): Promise<readonly SuiteTestIdentity[]>
  /** One identity's recorded member outcomes, newest last. */
  outcomesFor(product: string, filePath: string, testName: string): Promise<readonly string[]>
}

/**
 * The capability `authoring.funnel.get` binds through — the funnel's reads, bundled.
 *
 * the proposals inbox read is deleted with the inbox. An authored test
 * that a keep-gate did not reject is written in its own call, so no person accepts it afterwards
 * and nothing records such a decision. The terminal stage reads the receipts alone (see
 * {@link projectAuthoringFunnel}).
 *
 * THE STABILITY HALVES RIDE THE SAME BUNDLE for the same argument, and they are OPTIONAL within
 * it: a host may genuinely have receipts and no outcome projection, and D-14's whole point is
 * that a missing history reads as `no-history` rather than as a refusal. What is NOT here is any
 * way to start a run.
 */
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

/**
 * Project the funnel over one window.
 *
 * `dedupRefusals` is deliberately left ABSENT: a stage-2 refusal ends the invocation with nothing
 * authored — no draft, no receipt and no gate-run — so nothing on this host durably records
 * one, and reporting `0` would say "no author was ever refused" about something nothing counts.
 *
 * THE TERMINAL STAGE IS READ OFF THE RECEIPTS. It was `accepted`,
 * applied decisions read off `test-draft` proposal envelopes. Since 432-08 a draft a keep-gate did
 * not reject is written to its test path in the call that authored it and nothing is filed, and
 * 432-17 deleted the inbox, so `accepted` read 0 on every host. `writeEligible` counts the receipts
 * whose stored disposition D-06 writes, which `computeAuthoringFunnel` reads itself, so this
 * projection hands it nothing but the window's receipts.
 */
export async function projectAuthoringFunnel(
  window: AuthoringFunnelWindow,
  port: AuthoringFunnelPortLike,
): Promise<AuthoringFunnel> {
  const receipts = scopeReceiptsToWindow(await port.receipts.list(), window)
  return computeAuthoringFunnel({ receipts, sideCounters: {} })
}

/**
 * Gather the target's existing tests and assess them. STARTS ZERO RUNS.
 *
 * The draft's OWN identity is excluded from its neighbours: a draft under evaluation is not
 * evidence about the suite it is trying to join, and counting its own flip as a neighbour's
 * would let every mixed verdict explain itself.
 *
 * An unbound outcome port is `no-history` rather than a refusal, which is D-14's degraded posture
 * arriving through the composition instead of through a special case: a host that cannot read the
 * projection genuinely has no history to report, and saying so is the honest answer.
 */
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
