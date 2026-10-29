// A trigger channel with no history: pages re-read `runs.postprocessing`; routing keys on `runId`.

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
