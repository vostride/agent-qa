// Spells the tail's options once: it derives `agentQaRoot` and `configPath` and decides nothing.

import { resolve } from 'node:path'

import type { ExecutionContext, RunEventEnvelope } from '@vostride/agent-qa-schema'

import type { RunCurationTailOptions } from './curation-tail.js'
import {
  runPostRunTail,
  type PostRunEnqueueOutcome,
  type PostRunTailHandle,
  type PostRunTailOperations,
} from './post-run-tail.js'

/**
 * What a host has to answer to get this project's post-run tail.
 *
 * `configDir` and `configFilePath` rather than `agentQaRoot`/`configPath`: those two are the facts
 * a door actually holds (the drive hands both to `afterVerdict` as `CliRunVerdictContext`), and the
 * roots below are derived from them here so no caller derives them again.
 */
export interface ComposeCliPostRunTailInput {
  readonly runId: string
  /** The directory the project's config file lives in. `<configDir>/.agent-qa` is derived from it. */
  readonly configDir: string
  /** The project's resolved config file. */
  readonly configFilePath: string
  readonly knowledgeConfig: RunCurationTailOptions['knowledgeConfig']
  // Spread only if present: a tail without a mask declares `no-masker` and cannot claim curation.
  readonly mask?: RunCurationTailOptions['mask']
  readonly modelDeps?: RunCurationTailOptions['modelDeps']
  readonly signal?: RunCurationTailOptions['signal']
  readonly log: RunCurationTailOptions['log']
  /** What the shell's post-verdict step reported about the durable hand-off. */
  readonly enqueueOutcome?: PostRunEnqueueOutcome
  readonly postVerdict?: import('./post-verdict-step.js').PostVerdictHandoff
  readonly deadlineMs?: number
  // The dashboard's second chip sink, threaded through to the emitter.
  readonly relay?: (envelope: RunEventEnvelope) => void
  /** Focused test seam. Production callers omit it. */
  readonly operations?: Partial<PostRunTailOperations>
  // Picks the CI wording for a pending stage.
  readonly executionContext?: ExecutionContext
}

/**
 * Compose this project's post-run tail. Every host calls exactly this.
 */
export function composeCliPostRunTail(input: ComposeCliPostRunTailInput): PostRunTailHandle {
  return runPostRunTail({
    runId: input.runId,
    agentQaRoot: resolve(input.configDir, '.agent-qa'),
    configPath: resolve(input.configFilePath),
    knowledgeConfig: input.knowledgeConfig,
    configDir: input.configDir,
    log: input.log,
    ...(input.mask === undefined ? {} : { mask: input.mask }),
    ...(input.modelDeps === undefined ? {} : { modelDeps: input.modelDeps }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.enqueueOutcome === undefined ? {} : { enqueueOutcome: input.enqueueOutcome }),
    ...(input.postVerdict === undefined ? {} : { postVerdict: input.postVerdict }),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.relay === undefined ? {} : { relay: input.relay }),
    ...(input.operations === undefined ? {} : { operations: input.operations }),
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
  })
}
