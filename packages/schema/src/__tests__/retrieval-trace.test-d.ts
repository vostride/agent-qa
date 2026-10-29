// The runtime suite builds untyped records, so only these type assertions catch a lost field.
import { expectTypeOf } from 'vitest'

import type { ServedBrief } from '../brief/served-brief'
import { RETRIEVAL_TRACE_SCHEMA_VERSION } from '../brief/retrieval-trace'
import type {
  RetrievalTraceLeg,
  ServedRetrievalTraceV1,
  TraceLine,
} from '../brief/retrieval-trace'
import type { StepEvidence } from '../handoff/step-evidence'

// 1. The beside-field exists, is optional, and is the trace type — not `unknown`.
expectTypeOf<StepEvidence['retrievalTrace']>().toEqualTypeOf<
  ServedRetrievalTraceV1 | undefined
>()

const withoutTrace: Pick<
  StepEvidence,
  'stepIndex' | 'stepText' | 'cacheStatus' | 'retrievalTrace'
> = {
  stepIndex: 0,
  stepText: 'buy something',
  cacheStatus: 'miss',
}
void withoutTrace

// 2. BESIDE, never a widening: no trace member on the ServedBrief contract. If a future
// change added one, `computeBriefDigest` would silently change the digest of every brief
// ever served — so the absence is asserted, not left to reviewer diligence.
expectTypeOf<Extract<keyof ServedBrief, 'retrievalTrace' | 'trace' | 'channel4'>>()
  .toEqualTypeOf<never>()

// The leg vocabulary is exactly three arms at the TYPE level as well as the schema level —
// an extra arm or a missing one is a compile error here, not just a parse failure.
expectTypeOf<RetrievalTraceLeg>().toEqualTypeOf<'lexical' | 'dense' | 'anchor'>()
expectTypeOf<TraceLine['leg']>().toEqualTypeOf<'lexical' | 'dense' | 'anchor'>()

// The stamp is a literal, so a value carrying `schemaVersion: number` cannot pass for a
// trace — that is what makes the stamp a contract statement rather than a field.
expectTypeOf<ServedRetrievalTraceV1['schemaVersion']>().toEqualTypeOf<2>()

const trace: ServedRetrievalTraceV1 = {
  schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
  servedLines: [{ recordId: 'rec-1', leg: 'anchor', rank: 1, score: 0.9 }],
  truncated: [],
}

// @ts-expect-error the retrieval-leg vocabulary is closed; `graph` is a projection, not a leg.
trace.servedLines[0].leg = 'graph'

// @ts-expect-error the trace object is closed; a producer cannot widen it by writing to it.
trace.legWeights = {}

void trace
