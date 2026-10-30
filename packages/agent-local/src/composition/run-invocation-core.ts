// Every local run trigger starts here, and id refusals precede assembly, which probes the target.

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  RunId,
  RunSession,
  RunsStartInput,
} from '@vostride/agent-qa-schema'
import { startRun } from '@vostride/agent-qa-runner'
import type { PostVerdictPort, RunConfig } from '@vostride/agent-qa-runner'

import { buildRunPorts, runDirFor } from './run-composition.js'
import type { RunExecutionContext, RunPersistencePorts } from './run-composition.js'

// Types pass through: the composition carve-out admits the runner only under `composition/`.
export type {
  BaselineProbeResult,
  ConfigDigests,
  MemberTestExecutor,
  // The post-verdict vocabulary: a host writing the factory below needs the shape it returns.
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
  RunConfig,
  RunMemberDescriptor,
} from '@vostride/agent-qa-runner'

// Schema cannot import the ids package, so the minted-id predicate is passed in beside `mintRunId`.
export class RunIdNotMintedError extends Error {
  constructor(readonly runId: string) {
    super(
      `agent-qa cannot start a run under ${JSON.stringify(runId)}: a caller-named run id must be `
        + 'one this system minted. Start the run without naming an id and read the id back off the '
        + 'acknowledgment, or name an id `agent-qa` handed you.',
    )
    this.name = 'RunIdNotMintedError'
  }
}

// Refused before the record is touched, or a collision appends to the victim's log.
export class RunIdAlreadyInUseError extends Error {
  constructor(readonly runId: string) {
    super(
      `agent-qa cannot start a run under ${JSON.stringify(runId)}: that id already names a run in `
        + 'this project. Starting a second run under it would append to the first run\'s event log '
        + 'and overwrite its handoff. Start the run without naming an id.',
    )
    this.name = 'RunIdAlreadyInUseError'
  }
}

/**
 * The identity refusals, asked against the run's own directory: an id this system would not have
 * minted, or one that already names a run.
 */
function refuseUnavailableRunId(input: {
  readonly configDir: string
  readonly runId: string
  readonly isMintedRunId: (value: string) => boolean
}): void {
  if (!input.isMintedRunId(input.runId)) throw new RunIdNotMintedError(input.runId)
  if (existsSync(runDirFor({ configDir: input.configDir, runId: input.runId }))) {
    throw new RunIdAlreadyInUseError(input.runId)
  }
}

/** What the assembler is handed: everything the core resolved, and nothing it did not. */
export interface RunAssemblyContext {
  /** The run's identity, already resolved. The core starts the run under THIS id and no other. */
  readonly runId: string
  /** The caller's request, its run id already checked. */
  readonly request: RunsStartInput
  /** The context the door carried — the same value, so a run cannot record a different one. */
  readonly executionContext: RunExecutionContext
  /** The durable ports, rooted at `<configDir>/.agent-qa`, the evidence check's root. */
  readonly ports: RunPersistencePorts
  /** `dirname(agentQaRoot)` — the project directory the config sits in. */
  readonly configDir: string
  /** The config file this run resolves against (request override honoured). */
  readonly configPath: string
}

/**
 * Build the `RunConfig` the runner shell starts.
 *
 * A PORT rather than shared code, on `RunExecutionPort`'s own argument: members, executor,
 * reporters and masking are decisions a host answers differently. What crosses into the core is
 * the type; what stays with the door is the assembly. The core supplies the identity fields
 * (`runId` and the markers) over whatever the assembler returns, so a door cannot start a run
 * under an id the caller was not acknowledged with.
 *
 * EVERYTHING WITH A SIDE EFFECT BELONGS HERE, not in the door's pre-flight: the baseline probe
 * (network), the build-ordinal advance (a durable write), the quarantine fold. This function is
 * called below every refusal, so a refused run costs the target nothing.
 */
export type RunAssembler = (context: RunAssemblyContext) => Promise<RunConfig> | RunConfig

export interface RunInvocationCoreOptions {
  /** The config file runs resolve against unless the request names another. */
  readonly configPath: string
  /** The project's runtime root, i.e. `<configDir>/.agent-qa`. */
  readonly agentQaRoot: string
  // Caller-resolved, never sniffed: the context is a fact about the door, not the machine.
  readonly executionContext: RunExecutionContext
  /** Build the `RunConfig`. Called ONLY once every refusal has passed. */
  readonly assembleRun: RunAssembler
  /**
   * Mint a run id when the request carries none.
   *
   * REQUIRED rather than defaulted: the id generator lives in `@vostride/agent-qa-ids` (via core),
   * which this package does not depend on, and a locally invented id shape would be a second
   * spelling of a run's identity. Every shipped door already holds `generateRunId`.
   */
  readonly mintRunId: () => string
  // Required with no fallback: the canonical shape lives in `@vostride/agent-qa-ids`.
  readonly isMintedRunId: (value: string) => boolean
  // Called synchronously before the core awaits the session; the bus replays from seq 1.
  readonly onSession?: (session: RunSession) => void
  // Built once per run after every refusal; absent, the shell reports `detached` with no warning.
  readonly postVerdict?: (input: {
    readonly runId: string
    readonly configDir: string
  }) => PostVerdictPort
  /**
   * The door's own code, awaited once the request and its run id are allowed and before any port.
   * A door opens its run record and loads its plugins here.
   */
  readonly afterRefusal?: () => Promise<void>
}

// No defensive catch: a hard crash takes the host down, and runner budgets contain the rest.
export function createRunInvocationCore(
  options: RunInvocationCoreOptions,
): { execute(request: RunsStartInput): Promise<{ runId: RunId }> } {
  const configDir = dirname(options.agentQaRoot)

  return {
    async execute(request: RunsStartInput): Promise<{ runId: RunId }> {
      // Both refusals sit above `afterRefusal` and assembly, so a refused id changes no byte.
      if (request.runId !== undefined) {
        refuseUnavailableRunId({
          configDir,
          runId: request.runId,
          isMintedRunId: options.isMintedRunId,
        })
      }
      const runId = request.runId ?? options.mintRunId()

      // (2) The door's own code runs only for an allowed request, and a failure here still leaves
      // no run directory.
      await options.afterRefusal?.()

      // (3) Assembly — the first line that may touch the target, and it is below every refusal.
      const ports = buildRunPorts({ configDir, runId })
      // Spread into the assembler's ports, so it reaches `RunConfig.ports` without the door's help.
      const postVerdict = options.postVerdict?.({ runId, configDir })
      const assembled = await options.assembleRun({
        runId,
        request,
        executionContext: options.executionContext,
        ports: {
          ...ports,
          ...(postVerdict === undefined ? {} : { postVerdict }),
        },
        configDir,
        configPath: request.configPath ?? options.configPath,
      })

      // (4) Start. Markers ride from the request to the RunConfig; only a literal `true` carries.
      const session = startRun({
        ...assembled,
        runId: runId as RunId,
        ...(request.gateRun === true ? { gateRun: true as const } : {}),
        ...(request.excludedFromOutcomes === true
          ? { excludedFromOutcomes: true as const }
          : {}),
      })

      options.onSession?.(session)

      // The handoff is assembled and persisted before `done` resolves (runner shell's terminal
      // sequence), so awaiting it is awaiting the run AND its durable record.
      await session.done

      return { runId: runId as RunId }
    },
  }
}
