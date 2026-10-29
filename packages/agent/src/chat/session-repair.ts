// What a damaged session file MEANS, and what a resumed session remembers (Phase 392, CHAT-05 /
// D-18 / D-19).
//
// PURE, AND IN `agent` RATHER THAN IN THE ADAPTER. Deciding what to make of a half-written log is
// a different kind of work than moving bytes: it has a corpus, it has edge cases that deserve
// names, and every storage adapter — the JSONL one, the in-memory twin, whatever M5 reads sessions
// with — has to reach the SAME verdict or two hosts will disagree about whether a conversation
// happened. A branch inside one adapter's read loop would be that disagreement waiting to be
// written. Nothing here touches a filesystem; the adapter hands over lines and takes back events.
//
// THE TWO CRASH SHAPES D-19 NAMES, AND NO OTHERS.
//
//   1. A TORN FINAL LINE. The process died part-way through a write, so the last line is not a
//      whole JSON document. It is skipped and reported by line number. This is the EXPECTED cost
//      of a crash and the fsync discipline bounds it: at most the in-flight turn.
//   2. A DANGLING TURN. The last event this build can read is neither `turn_complete` nor
//      `aborted`, so a turn was in flight when the process died. Repair APPENDS a synthesized
//      `aborted` naming that turn.
//
// Everything else that fails the guard is ordinary DAMAGE, and damage is data: a named refusal
// beside the events that still fold, on the posture the grant ledger had (391; the ledger was
// deleted in 432-18).
// The two are deliberately not collapsed into one word. A tear is what a crash costs; a mid-file
// line that will not guard was written by another build or damaged in place and will still be
// broken tomorrow. Telling an operator to go and repair a file whose real problem is that it was
// killed sends them to fix the wrong thing.
//
// NO FURTHER CRASH SHAPE IS CLAIMED COVERED. A torn HEADER is refused by the adapter's own open
// guard before this function is reached — a session whose header cannot be read is not a session
// this build may append to, and guessing at its version would be the one mistake an append-only
// log cannot take back.
//
// THE DECLARED VERSION IS AN ARGUMENT (392-01's decision, unchanged here). The file states its
// version ONCE, on the header, and the open path has already read it; a per-line stamp would be a
// second answer to a question the header closed, free to disagree with the first.

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
      // The ONLY place the final line is treated differently, and the difference is the whole of
      // D-19's first arm: bytes that stop mid-document at the very end of an append-only file are
      // what a killed process leaves behind.
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

/**
 * Rebuild the live conversation a resumed session continues from, over REPAIRED events.
 *
 * IT RUNS AFTER REPAIR AND BEFORE ANY PRUNE, and the order is not decoration: replaying the raw
 * events of a crashed session yields a conversation in which the interrupted turn looks answered,
 * so a caller that pruned first would trim a conversation that never happened. CHAT-05 asks for
 * the repair on "the next turn, before pruning" for exactly this reason.
 *
 * AN ABORTED TURN IS EXCLUDED WHOLE, not merely truncated. Its user message is a question nobody
 * answered; carrying it forward would put an unanswered request in the model's context and invite
 * the next turn to act on it — which is the silent re-execution CHAT-05's repair exists to
 * prevent. The turn is not lost: it is on the log, with an `aborted` record naming it.
 */
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
