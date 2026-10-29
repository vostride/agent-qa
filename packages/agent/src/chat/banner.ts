// One read when a conversation opens, at most one line, and every read degrades to silence.

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
    // Only the payload: a banner reports no receipt, and an unexpected payload renders nothing.
    return (await invoke(functionId, input, caller)).payload
  } catch {
    return undefined
  }
}

// `runs.list` owns the chronology, so the banner takes its first row as `agent-qa digest` does.
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
