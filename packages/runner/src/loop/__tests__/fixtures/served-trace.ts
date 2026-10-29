// Stubs return the `{ brief, trace }` pair; a cast here would let a port change pass unnoticed.
import { RETRIEVAL_TRACE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  BriefBlock,
  CautionBlock,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'
import type { ServedCautions, ServedRunBrief } from '../../../knowledge-hint-reader.js'

/** A structurally valid trace with nothing in it — a stub reader served nothing to attribute. */
export function emptyTrace(): ServedRetrievalTraceV1 {
  return { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [], truncated: [] }
}

export function servedBrief(
  brief: BriefBlock,
  trace: ServedRetrievalTraceV1 = emptyTrace(),
): ServedRunBrief {
  return { brief, trace }
}

export function servedCautions(
  block: CautionBlock,
  trace: ServedRetrievalTraceV1 = emptyTrace(),
): ServedCautions {
  return { block, trace }
}

/** The empty Channel-3 result most stubs return. */
export function noCautions(): ServedCautions {
  return servedCautions({ cautions: [], budgetUsed: 0, admissions: [] })
}
