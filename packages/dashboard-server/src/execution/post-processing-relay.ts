// The SECOND sink of the in-process chip emitter.
//
// WHAT THIS IS FOR. A run's post-processing chain runs AFTER `runFinished`, which is exactly where
// the run event stream closes. So the chips a page wants to watch — analysis started, curation
// done — are appended to `events.jsonl` by a leg no open SSE is listening to any more. This
// registry is the push half of the fix: the emitter that writes each envelope to the trail also
// hands it here, and whichever browser has the run's post-processing stream open learns that the
// durable answer moved.
//
// IT IS A TRIGGER CHANNEL, NOT A SOURCE OF TRUTH. Nothing downstream of this object may
// derive a chip from an envelope: the answer is always `runs.postprocessing` over durable rows,
// re-read. The envelope says "look again"; it never says what the answer is. That is why there is
// no history here and no buffering — a relay that replayed what a late subscriber missed would be
// a second, weaker copy of a record the page can simply re-read, and the two would be free to
// disagree the first time a process restarted.
//
// KEYED BY THE ENVELOPE'S OWN `runId`. The pump this feeds is a global FIFO and can
// legitimately observe another run's job; the emitter has its own drop-guard for that, and this is
// the second wall. Routing on the publisher's idea of "the current run" would make the guard the
// only thing between one run's failure text and another run's viewer.
//
// THE SHAPE IS `in-process-backend.ts`'s `Map<runId, …>` BOOKKEEPING, deliberately: this package
// already has one per-run in-memory registry with a per-run teardown, and a second one that
// organised itself differently would be a second idiom for the same thing.

import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

/** One viewer's callback. Runs on the EMITTER'S thread — see `publish`. */
export type PostProcessingListener = (envelope: RunEventEnvelope) => void

export interface PostProcessingRelay {
  /**
   * Hand one chip envelope to whoever is watching THAT run.
   *
   * NEVER THROWS. The caller is the chip emitter, mid-`append`, immediately after the line is on
   * disk: the trail is the record and a viewer's fault is not the emitter's problem (the run bus's
   * own subscriber-fault discipline, applied one layer out). A listener that throws is skipped for
   * this delivery and the remaining listeners still receive it — dropping the rest would let one
   * broken page silence every other page watching the same run.
   */
  publish(envelope: RunEventEnvelope): void
  /** Watch one run. Returns its own disposer, which is idempotent. */
  subscribe(runId: string, listener: PostProcessingListener): () => void
  /** How many listeners that run has — so a host can assert a closed stream released its own. */
  listenerCount(runId: string): number
}

export function createPostProcessingRelay(): PostProcessingRelay {
  const byRun = new Map<string, Set<PostProcessingListener>>()

  return {
    publish(envelope: RunEventEnvelope): void {
      const listeners = byRun.get(envelope.runId)
      if (listeners === undefined || listeners.size === 0) return
      // A COPY, because a listener may legitimately unsubscribe itself from inside its own
      // delivery — the stream door's terminal arm does exactly that — and mutating the set being
      // iterated is how the listener after it silently stops being served.
      for (const listener of [...listeners]) {
        try {
          listener(envelope)
        } catch {
          /* one viewer's fault is not another's, and never the emitter's */
        }
      }
    },
    subscribe(runId: string, listener: PostProcessingListener): () => void {
      const listeners = byRun.get(runId) ?? new Set<PostProcessingListener>()
      listeners.add(listener)
      byRun.set(runId, listeners)
      let released = false
      return (): void => {
        if (released) return
        released = true
        const current = byRun.get(runId)
        if (current === undefined) return
        current.delete(listener)
        // The empty set is DELETED rather than kept: a dashboard that ran ten thousand runs would
        // otherwise hold ten thousand empty sets keyed by ids nobody will ask about again.
        if (current.size === 0) byRun.delete(runId)
      }
    },
    listenerCount(runId: string): number {
      return byRun.get(runId)?.size ?? 0
    },
  }
}
