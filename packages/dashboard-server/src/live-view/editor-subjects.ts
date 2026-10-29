// THE LIVE EDITOR SUBJECTS — the frame socket's lookup for editor sessions.
//
// An editor session is the second subject a live view can show. It shares everything else with a
// run: the view scope, the signer, the fragment carriage, the TTL, the embed page and this frame
// socket. What it does not share is the lookup. A run is found through the run registry; an editor
// session is found here, keyed by its session id alone, and this module holds no run entry and
// consults no run registry. The frame proxy picks one registry or the other by the token's signed
// subject kind, so a run token never reaches this map and an editor token never reaches the runs.
//
// The registry is in-memory and bounded by the sessions themselves: the session manager registers
// an editor session when it is created and unregisters it when it ends (Plan 10 wires both).

import type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveStreamDeclaration,
} from '@vostride/agent-qa-schema'

/** The frame-facing slice of a `RunSession`, for an editor session. */
export interface LiveEditorAttachment {
  streamCapabilityOf(handle: number): LiveStreamDeclaration
  subscribeFrames(
    handle: number,
    onFrame: (frame: LiveFrame) => void,
    onEnd?: (reason: LiveFrameEndReason) => void,
  ): LiveFrameSubscription | undefined
  /** Settles when the editor session is over. The frame socket then says `sessionEnded`. */
  readonly ended: Promise<void>
}

export interface LiveEditorSubjects {
  register(sessionId: string, attachment: LiveEditorAttachment): void
  unregister(sessionId: string): void
  attach(sessionId: string): LiveEditorAttachment | undefined
  /** The session's declared stream (its handle 0), or undefined when no such session is held. */
  capabilityOf(sessionId: string): LiveStreamDeclaration | undefined
}

export function createLiveEditorSubjects(): LiveEditorSubjects {
  const attachments = new Map<string, LiveEditorAttachment>()
  return {
    register: (sessionId, attachment) => {
      attachments.set(sessionId, attachment)
    },
    unregister: (sessionId) => {
      attachments.delete(sessionId)
    },
    attach: (sessionId) => attachments.get(sessionId),
    capabilityOf: (sessionId) => attachments.get(sessionId)?.streamCapabilityOf(0),
  }
}
