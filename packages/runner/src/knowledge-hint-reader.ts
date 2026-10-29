import type {
  Anchor,
  BriefBlock,
  CanaryOutcome,
  CautionBlock,
  IndexEntry,
  ProcedureMatch,
  ProcedureBindingAvailability,
  ReadOptions,
  RecordBody,
  RecordId,
  ScopeKey,
  ScreenState,
  SearchOptions,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'

// A brief and its serve-time trace as one value, so no reader can serve one without the other.
export interface ServedRunBrief {
  brief: BriefBlock
  trace: ServedRetrievalTraceV1
}

/** The Channel-3 caution block with its own serve-time trace, on the same one-value contract. */
export interface ServedCautions {
  block: CautionBlock
  trace: ServedRetrievalTraceV1
}

export interface KnowledgeHintReader {
  getRunBrief(scope: ScopeKey, budget: number): ServedRunBrief
  search(query: string, options: SearchOptions): IndexEntry[]
  read(id: RecordId, options?: ReadOptions): RecordBody | undefined
  getCautions(anchors: Anchor[], budget: number): ServedCautions
  // Only binding names cross; absent availability downranks a parameterized procedure to hint.
  getProcedure(
    intent: string,
    screenState: ScreenState,
    availability?: ProcedureBindingAvailability,
  ): ProcedureMatch | undefined
  emitCanaryOutcome(payload: CanaryOutcome): void
}
