// The CLI's run assembly — the `RunAssembler` the in-process invocation core calls.
//
// WHAT MOVED HERE AND WHY IT MOVED. `run.ts`'s single-test path used to compute all of this inline,
// immediately before its own `startRun`. Three of the steps have effects on the world outside this
// process, and the whole point of the core is that they happen AFTER the policy verdict:
//
//   - the run-start baseline probe FETCHES THE TARGET URL. It is the network touch the D-16 denial
//     cell asserts does not happen for a denied run;
//   - `resolveRunBuildOrdinal` ADVANCES A DURABLE PER-PRODUCT COUNTER under `.agent-qa`. A run that
//     was never allowed to start must not consume a build ordinal;
//   - the quarantine fold reads the committed ledger.
//
// So they live behind this function, and this function is reached from exactly one line in the core
// — the line after the gate. The ordering is structural rather than remembered: `run.ts` cannot
// probe before the gate because `run.ts` no longer holds the probe.
//
// IT IS A CLI MODULE, NOT A COMPOSITION-PACKAGE ONE, for the reason the `RunAssembler` port exists:
// members, the executor closure, reporters and the run's redactor are decisions a host answers for
// itself. What crosses into `agent-local` is the TYPE. What stays here is the assembly.
//
// NOT A SECOND SPELLING OF ANYTHING. Every step below calls the SAME shared helper the suite path
// calls (`resolveRunBuildOrdinal`, `resolveRunQuarantineSnapshot`, `runBaselineProbe`); nothing is
// re-implemented, so the suite path's migration in 401-04 is a move of its own orchestration onto
// this function rather than a reconciliation of two divergent copies.
//
// 401-04 CASHED THAT IN, AND THE NAME MOVED WITH IT. This function was `assembleDirectRun` while
// only the single-test path called it. The suite path's migration found the two inputs IDENTICAL —
// same probe, same ordinal advance, same quarantine fold, same `RunConfig` shape, differing only in
// the members and the executor a door hands over — so the suite path calls THIS function rather
// than a sibling of it. A second `assembleSuiteRun` beside it would have been the fork the comment
// above says this extraction exists to prevent, and it would have re-opened the ordering question
// (probe/ordinal before or after the verdict?) once per copy. One assembler, one order, one name
// that says which door it belongs to: `assembleCliRun`.

import type {
  PlannerLimitsRecord,
  QuarantineAppliedEntry,
  RunArtifactStageInput,
  RunId,
} from '@vostride/agent-qa-schema'
import {
  resolveRunBuildOrdinal,
  resolveRunQuarantineSnapshot,
} from '@vostride/agent-qa-agent-local'
// The runner vocabulary travels through the composition root, which is where the `RunAssembler`
// port this module implements is declared (FUNC-02: a surface names its composition root, not the
// private packages behind it).
import type {
  BaselineProbeResult,
  ConfigDigests,
  MemberTestExecutor,
  RunConfig,
  RunExecutionContext,
  RunMemberDescriptor,
  RunPersistencePorts,
} from '@vostride/agent-qa-agent-local'

import { runBaselineProbe } from '../commands/baseline-probe.js'

export interface CliRunAssemblyInput {
  /** The run's identity, minted by the door and carried through the core. */
  readonly runId: string
  /** The context the gate decided in — recorded on the run unchanged. */
  readonly executionContext: RunExecutionContext
  /** The project directory (the config's own directory). */
  readonly configDir: string
  /** The knowledge root the quarantine ledger is read from. */
  readonly knowledgeRoot: string
  /** The durable ports the core built under `<configDir>/.agent-qa` (Pitfall 5). */
  readonly ports: RunPersistencePorts
  /** The redactor the producer read at the run's start; the shell masks every bus event with it. */
  readonly secretRedactor: NonNullable<RunConfig['secretRedactor']>
  readonly members: readonly RunMemberDescriptor[]
  readonly executor: MemberTestExecutor
  readonly configDigests: ConfigDigests
  /** The run's product — the scope key and the build-ordinal/quarantine partition. */
  readonly product: string
  /** The resolved `--build-tag`/env/config setting, when one is set. */
  readonly buildTag?: string
  /**
   * ONE ENTRY PER MEMBER, index-aligned with `members`: the URL whose health reading belongs to
   * that member.
   *
   * AN `undefined` ENTRY MEANS NO PROBE FOR THAT MEMBER, which is the mobile posture: a
   * device-session-create failure is the equivalent environment signal there, so there is nothing
   * to fetch. An absent array means no member has a URL at all.
   */
  readonly memberProbeUrls?: readonly (string | undefined)[]
  /** Where a quarantine-fold warning goes. The command owns its own rendering. */
  readonly warn: (message: string) => void
  /**
   * how many members may execute concurrently, ALREADY RESOLVED by
   * `resolveEffectiveWorkers` at the drive. Absent or 1 leaves the `RunConfig` byte-identical to
   * the pre-402 shape, which is why it is spread conditionally rather than always written: a run
   * that nobody configured for concurrency must not become distinguishable from one that ran
   * before this field existed.
   *
   * IT IS A COUNT, NOT A CONFIG READ. This assembler resolves nothing about it — a second read
   * here could disagree with the drive's, and the formula has exactly one site.
   */
  readonly workers?: number
  /** the producer's resolved planner limits, carried onto the run's own record. */
  readonly plannerLimits?: PlannerLimitsRecord
  /** The masked source and target names the run stages as `artifact.json`. */
  readonly runArtifact?: RunArtifactStageInput
}

export interface CliRunAssembly {
  /** The `RunConfig` the core hands `startRun` (identity + markers stamped on top by the core). */
  readonly config: RunConfig
  /**
   * The advanced build ordinal, returned as well as embedded because the member closures read it
   * for their knowledge `asOfBuild` window.
   */
  readonly buildOrdinal: number
  /**
   * The resolved quarantine set, returned because the reporters must be handed the SAME set
   * `startRun` was given (390 D-15/D-16, Pitfall 8 — a second fold could disagree with the first).
   */
  readonly quarantined: readonly QuarantineAppliedEntry[]
}

/**
 * Assemble the run for the `agent-qa run` door — BOTH of its paths (401-03 single-test, 401-04
 * suite). The door hands over what only it knows (its members, its executor closure, its
 * redactor, its product); everything with an effect outside this process happens here, which is to
 * say after the verdict.
 *
 * THE PROBE'S FAILURE IS NOT THE RUN'S FAILURE. `runBaselineProbe` is a best-effort health reading
 * for the root-cause classifier; a throw here would turn an unreachable target into a framework
 * error before the member could report it as the test failure it is. That is the shipped posture
 * (`run.ts` wrapped the same call in a swallowing try), preserved verbatim — the catch covers the
 * PROBE and nothing else, so it is not a defensive wrapper around the run.
 *
 * THE PROBE IS PER MEMBER AND DEDUPED BY URL. Each DISTINCT member URL is fetched
 * once and its result is carried onto the members that named it, so an N-member run over one target
 * still costs one GET while a run over two targets no longer diagnoses one of them with the other's
 * health. There is no run-level baseline any more: a run-level value beside a per-member one is two
 * spellings of the same fact, and this file's own comments argue against exactly that.
 */
export async function assembleCliRun(
  input: CliRunAssemblyInput,
): Promise<CliRunAssembly> {
  const memberProbeUrls = input.memberProbeUrls ?? []
  const probesByUrl = new Map<string, BaselineProbeResult>()
  for (const url of memberProbeUrls) {
    if (url === undefined || probesByUrl.has(url)) continue
    try {
      probesByUrl.set(url, await runBaselineProbe(url))
    } catch {
      // Best-effort: the member closure surfaces the real target error.
    }
  }
  const members = input.members.map((member, index) => {
    const url = memberProbeUrls[index]
    const baselineProbe = url === undefined ? undefined : probesByUrl.get(url)
    return baselineProbe === undefined ? member : { ...member, baselineProbe }
  })

  const buildOrdinal = await resolveRunBuildOrdinal({
    configDir: input.configDir,
    product: input.product,
    ...(input.buildTag === undefined ? {} : { buildTag: input.buildTag }),
  })

  const quarantined = resolveRunQuarantineSnapshot({
    knowledgeRoot: input.knowledgeRoot,
    product: input.product,
    now: new Date().toISOString(),
    warn: input.warn,
  })

  const config: RunConfig = {
    runId: input.runId as RunId,
    scope: { tier: 'product', key: input.product },
    executionContext: input.executionContext,
    configDigests: input.configDigests,
    buildOrdinal,
    members,
    executor: input.executor,
    secretRedactor: input.secretRedactor,
    ports: input.ports,
    ...(quarantined.length > 0 ? { quarantined } : {}),
    ...(input.workers !== undefined && input.workers > 1 ? { workers: input.workers } : {}),
    ...(input.plannerLimits === undefined ? {} : { plannerLimits: input.plannerLimits }),
    ...(input.runArtifact === undefined ? {} : { runArtifact: input.runArtifact }),
  }

  return {
    config,
    buildOrdinal,
    quarantined,
  }
}
