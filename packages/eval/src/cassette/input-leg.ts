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
  // Exact three-channel knowledge brief served for this step.
  servedBrief: ServedBrief
  // Run-scoped planner memory served beside, never merged into, the brief.
  workingMemory?: WorkingMemoryEntry[]
  // Recorded beside the brief so `briefDigest` is untouched; absent on legacy cassettes.
  retrievalRung?: RecordedRetrievalRung
  // Ordered non-action exchanges: opaque evidence whose model-authored contents never execute.
  exchanges: ToolExchangeEvidence[]
  /** Declared model and sampling intent; unavailable values remain absent. */
  modelProfile?: DeclaredModelProfile
  // Typed planner-screenshot identity; absent when the decision recorded no screenshot.
  decisionScreenshotRef?: ArtifactRef
  /** Ordered non-screenshot evidence refs kept distinct from the screenshot role. */
  auxiliaryArtifactRefs?: readonly ArtifactRef[]
}
