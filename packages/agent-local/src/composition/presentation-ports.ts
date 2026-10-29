// A port where a headless drainer would substitute; its type lives here, its build in the host.

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

/** A bus subscriber a host attaches: an envelope `handler` plus an optional post-run `flush`. */
export interface RunSubscriberHandle {
  handler: (envelope: RunEventEnvelope) => void
  flush?: () => Promise<void>
}

/** The minimal RunSession surface a subscriber attachment needs (subscribe replay-then-live). */
export interface AttachableRunSession {
  subscribe(fromSeq: number | undefined, handler: (envelope: RunEventEnvelope) => void): () => void
}

