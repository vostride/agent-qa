// Found by session id alone, never via the run registry; the token's signed kind picks the lookup.

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
