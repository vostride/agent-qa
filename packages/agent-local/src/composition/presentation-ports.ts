// The presentation ports the run composition is HANDED rather than constructs.
//
// The dissection line this phase drew, stated once so 386 and every later host can apply the same
// one: a symbol is host-neutral when a process with no controlling terminal and nobody reading its
// output can run it to completion — its inputs and outputs are data and ports. A symbol is
// presentation when its only consumer is a human at this process's terminal. The operational test
// is a question about the daemon, not about the code: would a headless drainer call this symbol as
// written, or would it have to substitute something else (a log sink for a reporter, a policy for a
// prompt)? If it would substitute, the thing it substitutes is a port, and the port's TYPE is what
// lives here while the construction stays in the host.
//
// Consequence worth naming: types cross into this package, constructions that only a terminal host
// needs do not. 2026-10-02: the live-line pause seam a confirm prompt used is
// deleted with its type; no run asks, so nothing pauses a reporter.

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

// `RunPresentationPorts` is deleted. It carried the human confirm
// channel and the host's human-decoration hook. Nothing in a run asks a person, so the composition
// is handed no presentation capability at all; the reporter and live-line vocabulary above is what
// a host still attaches over.
