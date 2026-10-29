import type { MemberTestOutcome } from '../run/member-outcome'
import type { StepEvidence } from './step-evidence'
import type { Verdict } from '../verdict/verdict'

export interface PerTestOutcome {
  testId: string
  // `testId` is the machine id and never substitutes for this display name.
  testName: string
  // Identity is `filePath` plus `testName`, rebuildable from handoff.json alone.
  filePath: string
  testIndex: number
  outcome: MemberTestOutcome
  steps: StepEvidence[]
  // Present only when there is a failure to classify: failed, timed out, or passed after a retry.
  rootCause?: Verdict
  // `outcome` stays truthful for a quarantined test; only the aggregate verdict skips its failure.
  quarantined?: true
  // Stamped when `retryCount > 0`; the canary seam projects no attribution for this member.
  isRerun?: true
  /** Positive attempt index that produced the recorded outcome; absent on an ordinary member. */
  rerunAttempt?: number
  // The first failed attempt, apart from the final verdict; absence is missing evidence.
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
