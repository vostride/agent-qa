import type {
  ArtifactRef,
  DeclaredModelProfile,
  RecordedRetrievalRung,
  ScreenState,
  ServedBrief,
  ToolExchangeEvidence,
  WorkingMemoryEntry,
} from '@vostride/agent-qa-schema'

/** The complete recorded planner input for one live decision. */
export interface CassetteInputLeg {
  /** Stable authored test identity copied from the recorded test outcome. */
  testId: string
  /** Recorded zero-based test position within the run handoff. */
  testIndex: number
  /** Recorded zero-based step position within the test. */
  stepIndex: number
  /** Recorded zero-based live-decision position within the step. */
  decisionOrdinal: number
  /** Resolved instruction text presented for the recorded step. */
  stepText: string
  /** Persisted observation the planner received before choosing the action. */
  stateBefore: ScreenState
  /** Exact three-channel knowledge brief served for this step (D-03/A11). */
  servedBrief: ServedBrief
  /** Run-scoped planner memory served beside, never merged into, the brief (D-03/A11). */
  workingMemory?: WorkingMemoryEntry[]
  /**
   * Run-constant retrieval rung recorded beside — never inside — the brief (413 D-07,
   * 407 D-13), so `briefDigest` and §A11's exactly-three channels stay untouched. Absent on
   * legacy cassettes and on runs with no knowledge reader bound; the census counts those as
   * `legacy-no-rung` rather than hiding them.
   */
  retrievalRung?: RecordedRetrievalRung
  /**
   * Ordered non-action exchanges from the live turn. They are opaque
   * evidence data; consumers must never execute their model-authored arguments or results.
   */
  exchanges: ToolExchangeEvidence[]
  /** Declared model and sampling intent; unavailable values remain absent. */
  modelProfile?: DeclaredModelProfile
  /** Typed planner-screenshot identity; absent until later phases mint it. */
  decisionScreenshotRef?: ArtifactRef
  /** Ordered non-screenshot evidence refs kept distinct from the screenshot role. */
  auxiliaryArtifactRefs?: readonly ArtifactRef[]
}
