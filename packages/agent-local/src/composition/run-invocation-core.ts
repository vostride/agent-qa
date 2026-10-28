// The one in-process run invocation core (Phase 401, D-02; approval removed 432-13).
//
// WHAT THIS FILE IS. Every local run trigger — `agent-qa run`, the chat/MCP `runs.start` op, the
// daemon drainer, the dashboard's run button — resolves to ONE function here. It owns the ORDER a
// run is started in:
//
//   resolve the run id (refuse an unminted or colliding one)
//     → afterRefusal (the door's own code: its run record, then its plugins)
//     → persistence ports → assemble → startRun → onSession → await the run
//
// NOTHING ASKS. There is no approval ladder, no confirm port and no session trust here: a run
// starts in every execution context, whatever environment its targets declare. The only refusals
// are of the request's run id, and they land BEFORE assembly — assembly is where the run-start
// baseline probe fetches the target and where the build-ordinal counter is advanced — so a refused
// run leaves no probe, no ordinal bump, no run directory and no browser. `assembleRun` is a port
// this file calls once, below every refusal.
//
// THE ONE `startRun` OWNER. `packages/arch/src/lint/startrun-pin.ts` pins this file as the only
// production file that starts a run in-process.
//
// IT NEVER READS AMBIENT CONTEXT (D-07). There is no `resolveRunExecutionContext()` call here, no
// `getActiveExecutionContext`, no ALS read, no `process.env` sniff for who is asking. The door
// that knows supplies `executionContext`, and the run records it: a daemon serving a browser and a
// terminal on the same machine carries two different answers.

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

/**
 * The assembler port's own vocabulary, re-exported from the module that DECLARES the port.
 *
 * IT PASSES THROUGH HERE RATHER THAN THROUGH THE BARREL because the composition carveout admits
 * `@vostride/agent-qa-runner` only under `composition/` — the rule that keeps the job store proper
 * lean. A host writing a `RunAssembler` needs the types a `RunConfig` is made of; naming the runner
 * package itself would put a surface through the firewall (FUNC-02) for the vocabulary of a port
 * this file defined. Types only: erased before anything runs, granting no reach.
 */
export type {
  BaselineProbeResult,
  ConfigDigests,
  MemberTestExecutor,
  // 404-01 (D-10): the post-verdict step's vocabulary, on the same terms as the rest of this
  // block — a host writing the factory below needs the shape it must return.
  PostVerdictOutcome,
  PostVerdictPort,
  PostVerdictStepInput,
  RunConfig,
  RunMemberDescriptor,
} from '@vostride/agent-qa-runner'

/**
 * The request named a run id this system would not have minted.
 *
 * A decision, not a fault: the caller asked for something this seam declines, and it says so by
 * name before anything happens.
 *
 * WHY IT IS ASKED HERE AND NOT IN THE SCHEMA. `packages/schema` owns PATH-SAFETY on the id — the
 * id becomes a directory name and that is judgeable with no dependencies — but it may not name
 * `@vostride/agent-qa-ids` and must not re-spell the canonical id shape. So "is this an id this
 * system would have minted" is asked here, through a predicate supplied beside `mintRunId` and for
 * `mintRunId`'s stated reason: a locally invented answer would be a second spelling of a run's
 * identity. Measured pre-fix: `runId: 'not-a-minted-id'` was acknowledged, and `runId: ''` ran a
 * whole run into a shared `runs/default/` directory before the op reported `RunNotRecordedError`.
 */
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

/**
 * The request named a run id that already belongs to a run (2026-08-23, 401-20 · CR-04).
 *
 * WHAT A COLLISION COSTS, measured rather than reasoned about. Pre-fix, a second `runs.start`
 * naming a completed run's id APPENDED seven more envelopes to that run's `events.jsonl`
 * (2111 → 4221 bytes), OVERWROTE its `handoff.json`, and added a second row to its
 * `execution_audit.jsonl` — and then acknowledged the caller with the victim's own id. The
 * acknowledgment law makes that worse rather than better: `runs.start` reads every ack field back
 * off the run's durable record specifically so a host cannot fabricate one, and a colliding id
 * satisfies that read with a PRIOR run's record. So the refusal has to land before the record is
 * touched at all — which is why it sits in the identity step, above assembly.
 *
 * THE TEST IS THE RUN'S OWN DIRECTORY, derived through `runDirFor` — the same composition the
 * run's ports use — because every artifact a collision could tamper with lives inside it.
 * Asking after `handoff.json` alone would let a run that crashed before writing one be silently
 * appended to.
 */
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
  /** The durable ports, rooted at `<configDir>/.agent-qa` (Pitfall 5 — the evidence check's root). */
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
  /**
   * The context this door's runs are started in and record (D-07).
   *
   * CALLER-RESOLVED, NEVER SNIFFED. The CLI resolves its TTY posture, the daemon carries
   * `local-headless`, CI passes its own. A core that detected this itself would be answering a
   * question about the machine when the question is about the door.
   */
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
  /**
   * Is this a run id this system would have minted? (2026-08-23, 401-20 · CR-04)
   *
   * REQUIRED, WITH NO DEFAULT AND NO FALLBACK, for exactly `mintRunId`'s reason and one more. The
   * canonical predicate lives in `@vostride/agent-qa-ids`, which this package does not depend on,
   * and a locally invented shape check would be a second spelling of a run's identity — the same
   * argument that made minting an option. The extra reason is that an OPTIONAL predicate with a
   * permissive fallback is this defect wearing a type: every composition that forgot it would be
   * back to accepting any string, and the build would say nothing. A composition that omits this
   * does not compile.
   *
   * It answers about the SHAPE only. Whether the id is free is this file's own question, asked
   * against the run's own directory.
   */
  readonly isMintedRunId: (value: string) => boolean
  /**
   * Notified with the started session, synchronously, before the core awaits it (D-09's bridge
   * hook). Subscribers attach here; the bus replays from seq 1, so nothing is missed.
   */
  readonly onSession?: (session: RunSession) => void
  /**
   * Build this run's post-verdict step (404 D-05/D-10) — the durable `analyze-run` enqueue plus
   * ONE writer-lease consult, awaited by the shell between `verdict` and `runFinished`, whose
   * answer becomes `runFinished.disposition`.
   *
   * HOST-COMPOSED, CORE-THREADED, and both halves are load-bearing. It is host-composed because
   * the step speaks queue and writer-lease vocabulary this package's runner seam may not name —
   * the same argument that made `mintRunId` an option rather than a local. It is threaded HERE
   * rather than left to each door because the enqueue is precisely what the `runs.start` door and
   * the daemon door forgot: a door that supplies no factory gets a run whose wire honestly reads
   * `detached`, and a door that supplies one cannot then forget to wire it in.
   *
   * Called ONCE per run, after every refusal has passed and the persistence ports exist, so a
   * refused run never composes one. Absent ⇒ no `postVerdict` member reaches `RunConfig.ports` at all
   * (conditional spread, never an `undefined` field), and the shell reports `detached` with no
   * warning — which is the truth about a host from which nothing will be drained.
   */
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

/**
 * The one in-process run execution core.
 *
 * Returns a `RunExecutionPort` (the shape `createLocalRunInvocation` binds `runs.start` over), so
 * the op's evidence check — read the run's own event log back, refuse an empty one — applies to
 * this seam unchanged.
 *
 * NO DEFENSIVE CATCH ANYWHERE (D-03). A run that crashes hard takes its host with it, on purpose:
 * crash-through surfaces bugs instead of absorbing them, and the runner's budget/abort machinery
 * is the orderly containment. The only `throw`s this file introduces are the two refusals above,
 * which are decisions rather than faults.
 */
export function createRunInvocationCore(
  options: RunInvocationCoreOptions,
): { execute(request: RunsStartInput): Promise<{ runId: RunId }> } {
  const configDir = dirname(options.agentQaRoot)

  return {
    async execute(request: RunsStartInput): Promise<{ runId: RunId }> {
      // (1) Identity, and it REFUSES before it resolves (401-20, CR-04).
      //
      // A caller-supplied id carries exactly the trust the old `AGENT_QA_RUN_ID` child environment
      // variable carried — the door minting it is the door running it. What it does NOT carry, and
      // used to be described here as if it did, is a guarantee about the id itself: 394-11 removed
      // host-side id minting from the CLI precisely because a run's identity is not a caller's to
      // invent, and `RunsStartInputSchema` now refuses a path-shaped one but cannot ask the other
      // two questions. Both land here, and both land BEFORE anything is minted, read or written:
      //
      //   SHAPE — is this an id this system would have minted? The predicate is injected, because
      //     the canonical shape lives in a package this one does not depend on.
      //   FREEDOM — does it already name a run? Asked against the run's OWN directory, through the
      //     same `runDirFor` the run's ports are rooted at.
      //
      // ORDER IS THE CONTROL. Both refusals sit above `afterRefusal` and above assembly —
      // so a refused request leaves no run directory, no build-ordinal bump and, above all, not one
      // byte changed in the run it named. A refusal that half-wrote into somebody else's run
      // directory would be the defect performing itself.
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
      // 404 D-05/D-10: the post-verdict step, built ONCE per run and spread into the ports the
      // assembler receives — so it rides the same hop `handoffStore` does and reaches
      // `RunConfig.ports` through the door's own assembler without the door remembering to add it.
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

      // (4) Start. The markers ride straight from the request onto the RunConfig — the chain that
      // used to be request → port → argv → command flag → RunConfig is now request → RunConfig,
      // and only the literal `true` carries (a `false` is a refusal, not a synonym for absence).
      // `runId` is stamped over whatever the assembler returned so the id this call acknowledges
      // is provably the id the run was started under.
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
