// Internals live in a module-private WeakMap, so `invokeFunction` is the only way to run a spec.

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { toOutputProjection, toSchemaProjection } from './declaration-projection.js'
import type { FunctionBindingStatus } from './spec.js'
import { agentAskSpec } from './ops/agent-ask.js'
import { analysisGetSpec } from './ops/analysis-get.js'
import { authoringDraftEditSpec } from './ops/authoring-draft-edit.js'
import { authoringDraftWriteSpec } from './ops/authoring-draft-write.js'
import { authoringFunnelGetSpec } from './ops/authoring-funnel-get.js'
import { authoringVerifyDraftSpec } from './ops/authoring-verify-draft.js'
import { configAuthSetSpec } from './ops/config-auth-set.js'
import { configFieldSetSpec } from './ops/config-field-set.js'
import { configHookAddSpec } from './ops/config-hook-add.js'
import { configGetSpec } from './ops/config-get.js'
import { configTargetCreateSpec } from './ops/config-target-create.js'
import { configProjectScaffoldSpec } from './ops/config-project-scaffold.js'
import { configTargetEditSpec } from './ops/config-target-edit.js'
import { entitiesGetSpec } from './ops/entities-get.js'
import { explainSpec } from './ops/explain.js'
import { entitiesResolveSpec } from './ops/entities-resolve.js'
import { knowledgeAcceptSpec } from './ops/knowledge-accept-propose.js'
import { knowledgeBriefWhySpec } from './ops/knowledge-brief-why.js'
import { knowledgeBundlesListSpec } from './ops/knowledge-bundles-list.js'
import { knowledgeGatesListSpec } from './ops/knowledge-gates-list.js'
import { knowledgeForgetSpec } from './ops/knowledge-forget-propose.js'
import { knowledgeRecordShowSpec } from './ops/knowledge-record-show.js'
import { knowledgeRecordsDiffSpec } from './ops/knowledge-records-diff.js'
import { knowledgeRecordsInspectSpec } from './ops/knowledge-records-inspect.js'
import { knowledgeRejectSpec } from './ops/knowledge-reject-propose.js'
import { quarantineAddSpec } from './ops/quarantine-add.js'
import { quarantineListSpec } from './ops/quarantine-list.js'
import { quarantineReleaseSpec } from './ops/quarantine-release.js'
import { runsEventsSpec } from './ops/runs-events.js'
import { runsLiveUrlSpec } from './ops/runs-live-url.js'
import { editorLiveUrlSpec } from './ops/editor-live-url.js'
import { runsDigestSpec } from './ops/runs-digest.js'
import { runsArtifactSpec } from './ops/runs-artifact.js'
import { runsDetailSpec } from './ops/runs-detail.js'
import { RUNS_EVIDENCE_FUNCTION_ID, runsEvidenceSpec } from './ops/runs-evidence.js'
import { runsGetSpec } from './ops/runs-get.js'
import { runsKnowledgeSpec } from './ops/runs-knowledge.js'
import { runsListSpec } from './ops/runs-list.js'
import { runsMarkSpec } from './ops/runs-mark.js'
import { runsMarkPreviewSpec } from './ops/runs-mark-preview.js'
import { runsMarksHistorySpec } from './ops/runs-marks-history.js'
import { runsOverviewSpec } from './ops/runs-overview.js'
import { runsPostProcessingSpec } from './ops/runs-post-processing.js'
import { runsStartSpec } from './ops/runs-start.js'
import type { FunctionDeclaration, FunctionDeps, FunctionSpec } from './spec.js'

/** Thrown at construction when two declarations claim the same id — never last-wins. */
export class DuplicateFunctionIdError extends Error {
  constructor(readonly functionId: string) {
    super(`Duplicate function id: ${functionId}`)
    this.name = 'DuplicateFunctionIdError'
  }
}

// Otherwise a declaration would describe one contract while dispatch validated another.
export class OutputRepresentationMismatchError extends Error {
  constructor(readonly functionId: string) {
    super(
      `${functionId} declares an outputRepresentation whose runtimeSchema is not its output schema; `
        + 'the companion must describe the exact object invokeFunction validates with',
    )
    this.name = 'OutputRepresentationMismatchError'
  }
}

/** The capabilities every composition of this layer registers. */
const BUILT_IN_FUNCTION_SPECS: readonly FunctionSpec[] = [
  runsListSpec as FunctionSpec,
  runsGetSpec as FunctionSpec,
  runsEventsSpec as FunctionSpec,
  // Bound through optional `liveView`; a host with no served origin lists it `unbound`.
  runsLiveUrlSpec as FunctionSpec,
  // Same `liveView` dep; not projected to MCP.
  editorLiveUrlSpec as FunctionSpec,
  // Bound where a composition supplies `runInvocation`; `composeLocalAgent()` is the binding site.
  runsStartSpec as FunctionSpec,
  // Bound through optional `postProcessing`, so a host with no durable queue lists it `unbound`.
  runsPostProcessingSpec as FunctionSpec,
  // Bound through optional `runDetail`, so a host with no projection database lists it `unbound`.
  runsDetailSpec as FunctionSpec,
  // Parsed evidence uses the detail and blob readers together.
  runsEvidenceSpec as FunctionSpec,
  // The mark write binds only where the host supplies feedback.
  runsMarkSpec as FunctionSpec,
  // Binds through `feedbackReads`, never through the writer above.
  runsMarksHistorySpec as FunctionSpec,
  // Reads `runs.mark`'s shared plan through `feedbackReads`, never the writer.
  runsMarkPreviewSpec as FunctionSpec,
  // Bound through optional `evidenceBlobs`, so a host with no runtime root lists it `unbound`.
  runsArtifactSpec as FunctionSpec,
  // Bound through optional `analysis`; `recurrence` only enriches the sentence, never the binding.
  analysisGetSpec as FunctionSpec,
  knowledgeBundlesListSpec as FunctionSpec,
  // Gate history through the knowledge port's optional member; an absent one is a named refusal.
  knowledgeGatesListSpec as FunctionSpec,
  // Bound through the required `knowledge` port, so every composition can run these.
  knowledgeRecordsInspectSpec as FunctionSpec,
  knowledgeRecordsDiffSpec as FunctionSpec,
  knowledgeRecordShowSpec as FunctionSpec,
  // Bound everywhere, because its substrate is the required runs port.
  knowledgeBriefWhySpec as FunctionSpec,
  // Bound everywhere on the runs port; its optional deps only enrich the Learned half.
  runsKnowledgeSpec as FunctionSpec,
  // Bound through `runDetail`, so a host with no projection lists it `unbound`.
  runsOverviewSpec as FunctionSpec,
  // Bound only where a composition supplies `knowledgeReview`; otherwise listed `unbound`.
  knowledgeAcceptSpec as FunctionSpec,
  knowledgeRejectSpec as FunctionSpec,
  knowledgeForgetSpec as FunctionSpec,
  configGetSpec as FunctionSpec,
  // Config ops write in the call through optional deps; a host with no config lists them `unbound`.
  configFieldSetSpec as FunctionSpec,
  // One op per action, because the planner and MCP pick actions by tool name.
  configAuthSetSpec as FunctionSpec,
  configHookAddSpec as FunctionSpec,
  configTargetCreateSpec as FunctionSpec,
  configTargetEditSpec as FunctionSpec,
  // Not folded into `config.target.create`: a create never upserts and a scaffold never overwrites.
  configProjectScaffoldSpec as FunctionSpec,
  // Bound through optional `quarantine`; `release` and `add` write directly.
  quarantineListSpec as FunctionSpec,
  quarantineReleaseSpec as FunctionSpec,
  quarantineAddSpec as FunctionSpec,
  // Filed under `runs.` because it answers a fact about a run; it adds no dep.
  runsDigestSpec as FunctionSpec,
  // The directory is a required dep, so every composition can run these.
  entitiesResolveSpec as FunctionSpec,
  entitiesGetSpec as FunctionSpec,
  // Bound through optional `chatTurn`, so a host with no engine lists it `unbound`.
  agentAskSpec as FunctionSpec,
  // Bound through optional `capabilityCatalog`, so a host never explains from model memory.
  explainSpec as FunctionSpec,
  // Bound where a host can both parse a test and start a run; otherwise listed `unbound`.
  authoringVerifyDraftSpec as FunctionSpec,
  // Every stage runs inside this op, so a planner cannot reorder or skip one.
  authoringDraftWriteSpec as FunctionSpec,
  // An unbound host refuses rather than answer a zero funnel that reads as filtering everything.
  authoringFunnelGetSpec as FunctionSpec,
  // Not a loop stage: it edits a committed test; `draftEvaluation` is checked inside the invoke.
  authoringDraftEditSpec as FunctionSpec,
]

export interface CreateFunctionRegistryOptions {
  /** Host-backed implementations the ops read through; built at the composition root. */
  deps: FunctionDeps
}

export interface FunctionRegistry {
  // The caller argument is unread; every caller lists the same set.
  list(caller: FunctionCaller): readonly FunctionDeclaration[]
}

interface RegistryInternals {
  specs: ReadonlyMap<string, FunctionSpec>
  deps: FunctionDeps
}

const REGISTRY_INTERNALS = new WeakMap<FunctionRegistry, RegistryInternals>()

/**
 * INTERNAL seam for `invokeFunction`. Returns `undefined` for any object that did not
 * come out of `createFunctionRegistry` — such an object registers no specs at all, so
 * every id looks unknown to it.
 */
export function registryInternals(registry: FunctionRegistry): RegistryInternals | undefined {
  return REGISTRY_INTERNALS.get(registry)
}

// Registration freezes specs in place; the zod schemas stay unfrozen for zod's lazy caching.
function freezeSpec(spec: FunctionSpec): FunctionSpec {
  Object.freeze(spec.risk)
  return Object.freeze(spec)
}

// Exported so `invokeFunction` refuses on the same answer a listing renders.
export function resolveBindingStatus(
  spec: FunctionSpec,
  deps: FunctionDeps,
): FunctionBindingStatus {
  // Both readers are required even for addresses whose recorded evidence is absent.
  // Keep listing and invocation on this same answer without hiding runs.detail itself.
  if (spec.id === RUNS_EVIDENCE_FUNCTION_ID) {
    return deps.runDetail === undefined || deps.evidenceBlobs === undefined ? 'unbound' : 'bound'
  }
  if (spec.boundThrough === undefined) return 'bound'
  return deps[spec.boundThrough] === undefined ? 'unbound' : 'bound'
}

// Built field by field, so a new spec field can never leak the implementation into a listing.
function declarationView(spec: FunctionSpec, deps: FunctionDeps): FunctionDeclaration {
  return Object.freeze({
    id: spec.id,
    summary: spec.summary,
    // Conditional spreads keep absent absent; only the boolean fact crosses to a listing.
    ...(spec.classify === undefined ? {} : { classifies: true as const }),
    ...(spec.renderResult === undefined ? {} : { rendersResult: true as const }),
    resultKind: spec.resultKind,
    bindingStatus: resolveBindingStatus(spec, deps),
    input: toSchemaProjection(spec.input),
    output: toOutputProjection(spec.output, spec.outputRepresentation),
    risk: Object.freeze({ ...spec.risk }),
  })
}

// Absent from the barrel: a surface supplying its own specs could mint undeclared capabilities.
export function createRegistryFromSpecs(
  specs: readonly FunctionSpec[],
  options: CreateFunctionRegistryOptions,
): FunctionRegistry {
  const byId = new Map<string, FunctionSpec>()
  for (const spec of specs) {
    if (byId.has(spec.id)) {
      throw new DuplicateFunctionIdError(spec.id)
    }
    if (
      spec.outputRepresentation !== undefined
      && spec.outputRepresentation.runtimeSchema !== spec.output
    ) {
      throw new OutputRepresentationMismatchError(spec.id)
    }
    byId.set(spec.id, freezeSpec(spec))
  }

  const sorted = [...byId.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ))

  const registry: FunctionRegistry = {
    list() {
      return sorted.map((spec) => declarationView(spec, options.deps))
    },
  }

  REGISTRY_INTERNALS.set(registry, {
    specs: byId,
    deps: options.deps,
  })

  return registry
}

/** Build the registry of built-in capabilities over composition-supplied dependencies. */
export function createFunctionRegistry(
  options: CreateFunctionRegistryOptions,
): FunctionRegistry {
  return createRegistryFromSpecs(BUILT_IN_FUNCTION_SPECS, options)
}
