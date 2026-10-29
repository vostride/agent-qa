// A torn final line is skipped and reported; a dangling turn gets a synthesized `aborted` appended.

import { guardChatSessionEvent } from '@vostride/agent-qa-schema'
import type {
  ChatAbortedEvent,
  ChatSessionEvent,
  RefusedChatSessionLine,
} from '@vostride/agent-qa-schema'

/** One line off a session file, with the number an editor would show the person reading it. */
export interface SessionLogLine {
  /** 1-based and counting the header, so a refusal names what the operator will actually see. */
  readonly lineNumber: number
  readonly text: string
}

export interface RepairSessionOptions {
  /** Taken off the header the adapter has already validated. Never read off a line. */
  readonly declaredVersion: number
  /** The composition's clock — a synthesized event carries the instant repair happened. */
  readonly now: () => string
}

export interface SessionRepair {
  /** Every event the log can still be read as, in file order, with synthesis appended. */
  readonly repaired: readonly ChatSessionEvent[]
  /** What the caller must APPEND to the file to make it match {@link repaired}. */
  readonly synthesized: readonly ChatAbortedEvent[]
  /** Mid-file damage. Present forever; a caller should say so out loud. */
  readonly refusedLines: readonly RefusedChatSessionLine[]
  /** The one line a crash truncated, if there was one. Expected, bounded, not damage. */
  readonly tornTail: RefusedChatSessionLine | undefined
}

/**
 * The event kinds that CLOSE a turn.
 *
 * A turn whose last event is one of these ended; anything else means the process stopped talking
 * mid-turn. `aborted` counts whichever way it was written, which is what makes repair idempotent:
 * running it twice on the same file cannot produce two abort records for one interrupted turn.
 */
const TURN_CLOSING_KINDS: readonly ChatSessionEvent['kind'][] = ['turn_complete', 'aborted']

/**
 * Read a session's event lines, closing any turn the crash left open.
 *
 * Never throws for damaged content. The one thing that can still propagate is an error the guard
 * raises for a reason that is not about a line — and there is none today, because the version is
 * asked per call with the value the header supplied, so a foreign-version log refuses every line
 * with the version named. That path is unreachable through the JSONL adapter, whose open guard
 * refuses a foreign header before this function is called, and it is pinned by a test anyway.
 */
export function repairSession(
  lines: readonly SessionLogLine[],
  options: RepairSessionOptions,
): SessionRepair {
  const events: ChatSessionEvent[] = []
  const refusedLines: RefusedChatSessionLine[] = []
  let tornTail: RefusedChatSessionLine | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const isFinal = index === lines.length - 1

    let parsed: unknown
    try {
      parsed = JSON.parse(line.text)
    } catch (error) {
      const reason = `unparseable line: ${error instanceof Error ? error.message : String(error)}`
      // Only the final line may be torn: that is what a killed process leaves behind.
      if (isFinal) tornTail = { lineNumber: line.lineNumber, reason }
      else refusedLines.push({ lineNumber: line.lineNumber, reason })
      continue
    }

    try {
      events.push(guardChatSessionEvent(parsed, options.declaredVersion))
    } catch (error) {
      // It parsed as JSON and still does not describe an event: another build wrote it, or it was
      // edited in place. Truncation does not produce this, so a final line is no different here.
      refusedLines.push({
        lineNumber: line.lineNumber,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const last = events.at(-1)
  const dangling = last !== undefined && !TURN_CLOSING_KINDS.includes(last.kind)
  const synthesized: ChatAbortedEvent[] = dangling
    ? [{ kind: 'aborted', turnId: last.turnId, at: options.now(), source: 'synthesized' }]
    : []

  return {
    repaired: [...events, ...synthesized],
    synthesized,
    refusedLines,
    tornTail,
  }
}

/** One line of rebuilt conversation. Refs and one-liners only — never a payload body. */
export interface ChatReplayMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly turnId: string
}

export interface SessionReplay {
  readonly messages: readonly ChatReplayMessage[]
  /** Every turn the log records as interrupted, however it was interrupted. */
  readonly abortedTurnIds: readonly string[]
}

// Runs after repair and before pruning, and drops an aborted turn whole so nothing re-executes it.
export function replaySession(events: readonly ChatSessionEvent[]): SessionReplay {
  const abortedTurnIds = events
    .filter((event) => event.kind === 'aborted')
    .map((event) => event.turnId)
  const aborted = new Set(abortedTurnIds)

  const messages: ChatReplayMessage[] = []
  for (const event of events) {
    if (aborted.has(event.turnId)) continue
    switch (event.kind) {
      case 'user_message':
        // The one payload body in this vocabulary, and the exception is principled: the utterance
        // is not a reference to content held elsewhere, it IS the content.
        messages.push({ role: 'user', text: event.text, turnId: event.turnId })
        break
      case 'clause_receipt':
        // Op id plus the one-line outcome. The result itself stayed wherever the op put it, and a
        // replay that reconstituted it would be re-deriving a payload the log declined to carry.
        messages.push({
          role: 'assistant',
          text: `${event.functionId}: ${event.outcome}`,
          turnId: event.turnId,
        })
        break
      case 'mark_unhandled':
        messages.push({ role: 'assistant', text: event.reason, turnId: event.turnId })
        break
      default:
        // Stage outcomes, approvals, config drift and compaction are the record of HOW a turn
        // happened, not of what was said. They belong to the triage report and not to the
        // conversation a resumed session continues.
        break
    }
  }

  return { messages, abortedTurnIds }
}
