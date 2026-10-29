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

/**
 * The Channel-1 brief and the serve-time trace that explains it, as ONE value.
 *
 * The pairing is the guarantee, not a convenience. A reader implementation cannot satisfy this
 * port while producing a brief and no trace, and a consumer cannot receive a brief without also
 * being handed how it was chosen — which is what makes 387-06's why-verb able to answer about the
 * moment of serving rather than about a re-query of today's index.
 */
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
  /**
   * D-08 port evolution: source-tagged binding NAMES cross here (variables, memory, secrets) so
   * matcher fillability mirrors loop binding; no value ever crosses the reader port in any form.
   * Value binding stays loop-side at replay time. Absent availability is treated as empty, so a
   * referenced-parameter procedure downranks to hint (fail-conservative).
   */
  getProcedure(
    intent: string,
    screenState: ScreenState,
    availability?: ProcedureBindingAvailability,
  ): ProcedureMatch | undefined
  emitCanaryOutcome(payload: CanaryOutcome): void
}
