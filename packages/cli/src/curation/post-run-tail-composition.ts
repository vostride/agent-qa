// The ONE place the post-run tail's option literal is spelled.
//
// WHY IT EXISTS. `runPostRunTail` takes eleven fields, and until now the literal that fills them
// was written twice — once at each of `commands/run.ts`'s two tail sites — with `agentQaRoot` and
// `configPath` derived by hand at both. That was tolerable while ONE command had a tail. D-06 gives
// the `runs.start` door (dashboard, MCP, chat) a drain leg of its own, which would have made three
// spellings of "how this project's tail is composed" — and the way three spellings fail is not that
// one is wrong on the day it is written, but that a field added to the tail reaches two of them.
//
// A COMPOSITION, NOT A POLICY. Everything here is either handed in or DERIVED from something handed
// in; nothing is chosen. The two derivations are the two every caller was doing anyway:
// `agentQaRoot` is `<configDir>/.agent-qa` and `configPath` is the resolved config file.
//
// WHAT IT DOES NOT DO. It does not drain, finish, or decide who pumps. It hands back the SAME
// `PostRunTailHandle` the tail has always returned, and the caller drives its two legs — because
// which legs run is the caller's knowledge: `commands/run.ts` gates the drain on `--detach` through
// `runVerdictFirstCurationTail`, and the `runs.start` door gates it on whether the post-verdict
// step's lease was actually takeable.
//
// Import discipline: a file written today may name only `agent`, `agent-local`,
// `analytics` and `schema` across package boundaries, and the ledger only ever shrinks. This file
// names `schema` for types and nothing else; the mask arrives through relative modules that are
// already ledgered for it.

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
  /**
   * The declared mask, when the caller has one.
   *
   * Conditionally spread rather than passed as `undefined`, because the tail DERIVES its candidate-
   * prose posture from this field's PRESENCE (388-10, UF-388-01): a tail composed without one
   * declares `no-masker` and may not claim `curate-memory` at all.
   */
  readonly mask?: RunCurationTailOptions['mask']
  readonly modelDeps?: RunCurationTailOptions['modelDeps']
  readonly signal?: RunCurationTailOptions['signal']
  readonly log: RunCurationTailOptions['log']
  /** What the shell's post-verdict step reported about the durable hand-off. */
  readonly enqueueOutcome?: PostRunEnqueueOutcome
  readonly postVerdict?: import('./post-verdict-step.js').PostVerdictHandoff
  readonly deadlineMs?: number
  /**
   * The dashboard's SECOND chip sink, threaded through to the emitter in 404-05.
   *
   * Accepted here now rather than later so the emitter side is the only thing 404-05 has to fill:
   * a field added on the emitter alone would leave this composition — the one place every host's
   * tail is spelled — unable to name it, and the alternative is a second literal somewhere.
   */
  readonly relay?: (envelope: RunEventEnvelope) => void
  /** Focused test seam. Production callers omit it. */
  readonly operations?: Partial<PostRunTailOperations>
  /** picks the CI wording for a pending stage. */
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
