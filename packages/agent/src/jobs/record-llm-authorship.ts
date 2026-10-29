// The one memoizing checkpointed effect (Phase 385, D-10 / D-11 layer 2).
//
// Every job's access to a model goes through this function and there is no second route. The
// capability arrives as the author callback's ARGUMENT, so a handler cannot obtain one on its
// own however it is written: the context that carries the model is built by the engine and is
// never handed to a handler, and the handler-facing surface has no member of that kind and
// nowhere to grow one (pinned by exact `keyof` equality in the tests). That is why this
// package can stay provider-neutral while jobs still author with a model — the model is a
// value the composition binds at the edge, never a name this package resolves.
//
// The control flow is the guarantee, not an optimization:
//
//   1. read the recorded value for this checkpoint
//   2. HIT  -> return the recorded bytes; `author` is never reached at all
//   3. MISS -> invoke `author` exactly once, publish what it produced, THEN return
//
// Step 3's order is the whole of JOBQ-03. A resume can only be re-invocation-free if the bytes
// were durable before the caller ever saw them, so publishing after the return — or without
// awaiting it — would leave a window in which a host dies holding an answer no store accepted,
// and the next host has no choice but to ask the model again. The publish is awaited and its
// failure propagates; this function never hands back a value the store has not taken.
//
// The memoization lives HERE and nowhere else. A conditional re-author written into a handler
// (`if (!checkpoint) …`) is still a re-author, and five kinds each carrying their own copy of
// that conditional is five chances to get it wrong — which is exactly the anti-pattern the
// research names.
//
// five rather than six — the reserved sixth job kind left with the
// Issue-slot cleanup.

import type { JobId } from '@vostride/agent-qa-schema'

/**
 * What an author asks a model for.
 *
 * Minimal on purpose. This package cannot name a provider SDK, so the capability is described
 * structurally and the composition root adapts the real thing onto it. A wider shape here
 * would be a second, drifting copy of a vocabulary that already has an owner.
 */
export interface JobModelRequest {
  readonly system?: string
  readonly prompt: string
  /**
   * Optional image parts riding the SAME request. Screenshots are
   * capability-gated per the v46 negotiation the host binding surfaces as `vision` below:
   * an author attaches evidence bytes here only when the capability advertises vision AND
   * a blob reader is bound. Absent means a text-only request — the L9 graceful-degradation
   * posture — and every pre-widening caller and stub stays assignable unchanged.
   */
  readonly images?: readonly Uint8Array[]
  // set by the engine from the host's per-run signal.
  readonly signal?: AbortSignal
}

/** What a model answered. Text, because a caller that needs structure parses it. */
export interface JobModelOutput {
  readonly text: string
}

/**
 * The model, as a job may see it (D-11 layer 2).
 *
 * A TYPE, never an import: a job handler receives a value shaped like this from exactly one
 * place — the author callback's parameter — and the barrel publishes no accessor that could
 * produce one. `modelId` is here so a checkpoint's provenance is recordable without the engine
 * having to know anything else about the binding.
 */
export interface JobModelCapability {
  readonly modelId: string
  /**
   * Whether the bound model accepts image parts — the v46 capability
   * negotiation surfaced as one flag by the host binding. OPTIONAL and absent means
   * text-only: a text-only BYOM binding and every existing stub keep compiling and keep
   * their L9 posture without declaring anything. Nothing else in the memoization
   * contract moves with this flag.
   */
  readonly vision?: boolean
  generate(request: JobModelRequest): Promise<JobModelOutput>
}

/**
 * What a checkpoint already holds, with the engine's envelope already peeled.
 *
 * The engine owns the envelope (attempt, recorded-at, the job it belongs to) and the store
 * owns the bytes; this primitive is handed the VALUE, so the same call returns the same thing
 * whether it authored it a moment ago or is reading it back after a crash. A primitive that
 * returned an envelope on resume and a bare value on the first pass would be two functions
 * wearing one name.
 */
export type JobRecordedValueOutcome =
  | { readonly recorded: false }
  | { readonly recorded: true; readonly value: unknown }

/**
 * The narrow context the engine builds for one claimed job.
 *
 * It carries the model and no handler ever receives it. Everything a handler can reach is on
 * `JobHandlerContext`, whose member set is pinned for exact equality — so "there is no ambient
 * model accessor" is a fact about the type surface rather than a habit of the code.
 */
export interface JobCheckpointContext {
  readonly jobId: JobId
  readonly model: JobModelCapability
  readRecordedValue(checkpointId: string): Promise<JobRecordedValueOutcome>
  publishCheckpoint(checkpointId: string, value: unknown): Promise<void>
}

/** The only signature that ever receives a model inside a job. */
export type JobAuthorCallback<T> = (model: JobModelCapability) => Promise<T>

/**
 * The primitive, partially applied to one job. This is what a handler is handed.
 *
 * Present on every kind's handler context, including uncheckpointed ones: calling it there is
 * refused by name rather than being unavailable, because an optional member would push a
 * `?.()` into every handler and make "this kind cannot author" a runtime shrug instead of a
 * refusal that says which declaration is wrong.
 */
export type BoundRecordLlmAuthorship = <T>(
  checkpointId: string,
  author: JobAuthorCallback<T>,
) => Promise<T>

export async function recordLlmAuthorship<T>(
  context: JobCheckpointContext,
  checkpointId: string,
  author: JobAuthorCallback<T>,
): Promise<T> {
  const recorded = await context.readRecordedValue(checkpointId)
  if (recorded.recorded) {
    // The resume path. `author` is not merely skipped — control never reaches it, so there is
    // no flag, no option and no argument that could make a resumed job invoke a model.
    return recorded.value as T
  }

  const authored = await author(context.model)
  // Awaited BEFORE the return, so what the caller receives is what the store already holds.
  await context.publishCheckpoint(checkpointId, authored)
  return authored
}
