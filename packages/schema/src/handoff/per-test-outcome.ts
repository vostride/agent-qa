import type { MemberTestOutcome } from '../run/member-outcome'
import type { StepEvidence } from './step-evidence'
import type { Verdict } from '../verdict/verdict'

export interface PerTestOutcome {
  testId: string
  /**
   * The parsed test's human display name exactly as core binds it.
   * Stable test identity = filePath + testName. `testId` remains the explicit
   * machine id and never substitutes for this name.
   */
  testName: string
  /**
   * The member test file's path exactly as the CLI resolves it. Stable test
   * identity = filePath + testName — rebuildable from handoff.json alone. REQUIRED, not
   * optional, under the v2 no-back-compat law: new handoffs always mint it; older
   * handoff.json files that fail the current-schema load are skipped by the projection
   * rebuild (RESEARCH A2, doc-commented at the rebuild site in plan 381-05).
   */
  filePath: string
  testIndex: number
  outcome: MemberTestOutcome
  steps: StepEvidence[]
  /**
   * Bounded root-cause classification for this member test (D-01, §A9).
   * Present iff a failure occurred to classify — outcome 'failed'/'timeout',
   * or 'passed' with retryCount > 0 (class 'flake'); clean passes, skipped,
   * and cancelled members omit it. Populated by the runner's deterministic
   * classifier (Phase 373 Plans 06/07); M4's analyze-run upgrades 'unknown'
   * verdicts at this same per-test granularity via ordinary supersession.
   */
  rootCause?: Verdict
  /**
   * the quarantine disposition, living BESIDE the outcome rather than replacing
   * it. `outcome` stays truthful for a quarantined test — a `'failed'` member reads `'failed'`
   * here forever, so the projection window and the M-consecutive-passes auto-exit keep seeing
   * reality. What changes is the AGGREGATE rule (deriveAggregateVerdict skips flagged failures),
   * and this marker is how every later consumer — reporters, the projection, digests — knows the
   * failure was licensed.
   *
   * Only the literal marker is meaningful; absence denotes an ordinary member and remains absent
   * in JSON (the `excludedFromOutcomes` idiom).
   */
  quarantined?: true
  /**
   * 2026-09-07, 418 D-09 / approved OQ-1: reruns are member-grain retries, narrowing
   * D-09's run-level wording. The runner stamps this from TestResult.retryCount > 0;
   * the canary seam projects no attribution, positive or negative, for this member.
   * The curator's analyze-run / attributed-deprecation path is unchanged.
   * Only literal true is meaningful; absence denotes an ordinary member.
   */
  isRerun?: true
  /** Positive attempt index that produced the recorded outcome; absent on an ordinary member. */
  rerunAttempt?: number
  /**
   * actual first failed attempt, independently of the final retry's verdict.
   * Optional without a version bump: historic absence is missing evidence, never a guess.
   * Decision addresses and masked recorded facts support an exact downstream receipt join;
   * neither a cassette identity nor a historical receipt is invented here.
   */
  rerunOrigin?: {
    attempt: number
    outcome: 'failed' | 'timeout'
    rootCause?: Verdict
    /** SHA-256 of canonical JSON of this block with evidenceDigest omitted. */
    evidenceDigest: string
    decisions: Array<{
      runId: string
      testId: string
      testIndex: number
      stepIndex: number
      decisionOrdinal: number
      /** Recomputed from the masked recorded state, using screenStateHash. */
      screenStateHash: string
      /** Canonical address + evidence digest (both hash fields omitted). */
      evidenceDigest: string
      /** Actual step context, including receipt inputs; ordinal selects its subAction. */
      evidence: StepEvidence
    }>
  }
}
