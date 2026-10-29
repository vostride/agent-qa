/**
 * Test fixtures for the 387-04 composite reader port.
 *
 * `KnowledgeHintReader.getRunBrief` and `.getCautions` now return `{ brief|block, trace }` as one
 * value, so a stub reader cannot hand back a bare block. These helpers keep every existing case's
 * INTENT unchanged while making the widened contract explicit at each stub — deliberately not a
 * cast, because an `as unknown as KnowledgeHintReader` stub is precisely the shape that stops a
 * port change from reddening anything.
 */
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
