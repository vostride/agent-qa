// Probe, ordinal advance and quarantine fold run here, reached once from the core.

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
// Runner types come through the composition root, which declares the `RunAssembler` port.
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
  /** The durable ports the core built under `<configDir>/.agent-qa`. */
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
  // Index-aligned with `members`; an `undefined` entry means no probe, the mobile posture.
  readonly memberProbeUrls?: readonly (string | undefined)[]
  /** Where a quarantine-fold warning goes. The command owns its own rendering. */
  readonly warn: (message: string) => void
  // Already resolved at the drive; absent or 1 leaves `RunConfig` without the field.
  readonly workers?: number
  // The producer's resolved planner limits, carried onto the run's own record.
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
  // Returned so the reporters get the same set `startRun` receives; a second fold could disagree.
  readonly quarantined: readonly QuarantineAppliedEntry[]
}

// One probe per distinct member URL; a probe throw is caught so the member reports the failure.
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
