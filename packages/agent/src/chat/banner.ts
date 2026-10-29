// The chat-open banner.
//
// ONE READ, ONCE, WHEN A PERSON OPENS A CONVERSATION. There is no timer in this file, no watcher,
// and no second pass — 388 D-14's one-read law is the whole design, and the reason is that the
// alternative is not "a fresher banner" but a background process that keeps a project's stores
// warm for a person who may have walked away. Live push is M5's, where a transport earns it.
//
// AT MOST ONE LINE, AND USUALLY NONE. A REPL that greeted every open with a status report trains a
// person to skip the greeting, and then the one open that had something to say goes unread. So the
// idle case is SILENCE rather than a reassuring sentence.
//
// EVERY READ DEGRADES TO SILENCE. A banner may never block chat open, and it may never turn an
// unbound or refused op into a failure the person has to deal with before they can type.
//
// the pending-proposals half is deleted with the inbox. Nothing is
// filed for a person to decide, and old proposal files are never read, so the banner is the latest
// run's digest headline or silence.
//
// IT COMPOSES REGISTERED OPS AND NOTHING ELSE. Every fact here is read through the same
// `invokeFunction` binding a turn dispatches through, with the session's own caller — the read is
// user-initiated, so it is read exactly as the person typing `digest` would read it. This file
// reaches no store, holds no reader, and widens no DTO: `RunDigest.lines` is carried across
// verbatim, which is the one-renderer law applied to a greeting.

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { RUNS_DIGEST_FUNCTION_ID } from '../functions/ops/runs-digest.js'
import { RUNS_LIST_FUNCTION_ID } from '../functions/ops/runs-list.js'
import type { ChatInvokeBinding } from './ports.js'

/**
 * One read, or nothing.
 *
 * Swallowed HERE and nowhere else, and the swallow is narrow by construction: it wraps exactly one
 * invocation, so a failure inside the banner's own composition cannot be mistaken for a refused op.
 */
async function readOrNothing(
  invoke: ChatInvokeBinding,
  functionId: string,
  input: unknown,
  caller: FunctionCaller,
): Promise<unknown> {
  try {
    // THE PAYLOAD ONLY (399.1). The seam answers a classified envelope now, and the banner is the
    // one consumer that legitimately wants none of it: it composes a greeting out of two reads, it
    // reports no receipt, and a verdict has nowhere on a banner to go. The fragments below parse
    // what they read, so a payload that is not what they expect renders nothing — the posture this
    // function already had for a read that threw.
    return (await invoke(functionId, input, caller)).payload
  } catch {
    return undefined
  }
}

/**
 * The latest run this project produced, or nothing.
 *
 * `runs.list` owns the chronology: newest finished first, `runId` breaking a tie, so the
 * banner asks for one row and takes it. Choosing again here would be a second ordering free to
 * disagree with `agent-qa digest`, which reads the same first row.
 */
function latestRunId(answer: unknown): string | undefined {
  if (!Array.isArray(answer)) return undefined
  return (answer as readonly { runId?: string }[])[0]?.runId
}

/**
 * The digest half: the digest's OWN first rendered line.
 *
 * Carried across rather than composed here. `RunDigest.lines` is what `agent-qa digest` prints and
 * what the post-run tail emits, so re-deriving a headline would put a second sentence about one
 * run in front of a person — the failure the one-renderer law names.
 */
function digestFragment(answer: unknown): string | undefined {
  const lines = (answer as { lines?: readonly string[] } | undefined)?.lines
  const headline = lines?.[0]
  return headline === undefined || headline.trim() === '' ? undefined : headline
}

/**
 * Compose the banner for one chat open.
 *
 * Sequential rather than concurrent, deliberately: the digest read is CONDITIONAL on the run list
 * having produced a run, and a project with no runs must not issue a `runs.digest` call against an
 * id it invented. Two reads at open is the ceiling; a third would need a decision.
 */
export async function composeBanner(
  invoke: ChatInvokeBinding,
  caller: FunctionCaller,
): Promise<string | undefined> {
  const runId = latestRunId(
    await readOrNothing(invoke, RUNS_LIST_FUNCTION_ID, { limit: 1 }, caller),
  )
  const digest =
    runId === undefined
      ? undefined
      : digestFragment(await readOrNothing(invoke, RUNS_DIGEST_FUNCTION_ID, { runId }, caller))

  return digest
}
