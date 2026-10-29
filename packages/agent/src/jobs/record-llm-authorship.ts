// Read the checkpoint; on a miss author once and publish before returning, so resumes never re-ask.

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
  // Attached only when the capability advertises vision and a blob reader is bound; absent is text.
  readonly images?: readonly Uint8Array[]
  // Set by the engine from the host's per-run signal.
  readonly signal?: AbortSignal
}

/** What a model answered. Text, because a caller that needs structure parses it. */
export interface JobModelOutput {
  readonly text: string
}

// A type, never an import: a handler gets one only as the author callback's parameter.
export interface JobModelCapability {
  readonly modelId: string
  // Whether the bound model accepts image parts; absent means text only.
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
