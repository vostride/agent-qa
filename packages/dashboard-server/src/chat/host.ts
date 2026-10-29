// The injected-host seam the dashboard's run-detail and mark routes dispatch through (Phase 400 plan
// 01, D-01; narrowed by 430 D-02 and 432-14 D-14).
//
// WHY THIS FILE IS A TYPE AND NOTHING ELSE. D-01 puts the composed agent host in THIS PROCESS —
// dashboard-server's — and the shortest reading of that is "dashboard-server calls
// `composeLocalAgent()`". It is also the wrong one. This package has no dependency on `agent`,
// `agent-local` or `safety` and its ownership contract says so by name; acquiring them would mean
// re-assembling the ~3,500 lines of port wiring `composeCliLocalAgent` already owns — the run
// executor, the draft authoring and apply ports, the config editor's four halves, the masked config
// reader — and the moment that second assembly exists there are two answers to "what can this
// product do", which is the exact drift the whole function layer was built to abolish (385 D-15,
// one composition root).
//
// So the host is composed by `agent-qa dashboard` — the CLI command that starts this server, in the
// same process — and handed in. The process is the one D-01 names, and this package still names no
// agent package. That standing decision survives 430: the conversation door it was first built for
// is gone, and the same host now serves run detail, analysis, knowledge, marks and post-processing.
// the run-confirm pair it also served is deleted, and with it the two
// members only that pair read.
//
// WHAT CROSSES THIS SEAM, AND WHY IT IS SHAPED THIS WAY. Everything below is a function or a value
// the CALLER supplies, not one this package computes. `invokeFunction` is the agent package's own
// export, bound by the composer; `registry` and `caller` are opaque handles this package never
// inspects; and every op id is the agent package's constant, PASSED rather than re-spelled — a
// string literal here would be a second spelling of an op id, free to drift from the one that
// dispatches.
//
// THE SEAM CARRIES NO CAPABILITY OF ITS OWN. There is no `runTest`, no `listRuns`, no per-capability
// verb: every route reaches its capability through one gated invocation of one registered op, which
// is 397 D-03's rule ("bespoke per-capability handlers stay off the roster") expressed as a type.
// A second method here would be a private power with no roster row. `AGENT_HOST_MEMBERS` below
// states the member set as data, and 430's closed-set cells pin it against the interface both ways.

import type { FunctionCaller } from '@vostride/agent-qa-schema'

/**
 * The composed function registry, OPAQUE to this package.
 *
 * Deliberately not structurally described. The registry's real type lives in `agent`, this package
 * may not name it, and a hand-written mirror of its shape here would be a second declaration of
 * somebody else's contract — stale on the day `agent` changes it, and silently so, because nothing
 * would compare the two. What this package does with the value is hand it straight back to the
 * functions below, which is all an opaque handle has to support.
 */
export type AgentRegistryHandle = object

/**
 * The whole of what the run-detail and mark routes may ask of the process that started them.
 *
 * A single object rather than loose options, because the members are one decision: they all come
 * from ONE composition, and a server holding an invoke from one host and a registry from another is
 * a state nobody should be able to construct.
 */
export interface AgentHost {
  /** The composed registry every call goes through. Opaque here. */
  readonly registry: AgentRegistryHandle
  /**
   * The caller this door dispatches as, MINTED by the composition root and never by this package.
   *
   * Attribution and grants both. The composer derives it from the CLI chat door's own mint with
   * only the surface name changed (D-08/Pitfall 9) — a hand-typed scope list here would be the
   * drift vector the parity legs exist to catch, and this package could not type-check one anyway.
   */
  readonly caller: FunctionCaller
  /**
   * The agent package's `runs.postprocessing` id.
   *
   * SUPPLIED BY THE COMPOSITION, NEVER SPELLED HERE. The post-processing read route dispatches
   * chip truth through this door, and the op id is the agent package's constant: a string literal
   * in this package would be a second declaration of a capability's name, free to drift from the
   * spec that answers to it. This package also may not import `@vostride/agent-qa-agent`
   * (validate:arch), so there is nowhere here the real constant could come from.
   */
  readonly runsPostProcessingFunctionId: string
  /**
   * The agent package's `runs.events` id, on the line above's footing.
   *
   * A SECOND ID BECAUSE THE READ ROUTE JOINS TWO FACTS from two different records: the chain's
   * chips live in the durable job store, and the run's POSTURE — who was going to drain it — lives
   * on the `runFinished` line of the run's own event log, beside the last per-stage failure text.
   * Reading the log any other way would mean this package opening a file the function layer owns.
   */
  readonly runsEventsFunctionId: string
  /**
   * The agent package's `runs.detail` id, on `runsPostProcessingFunctionId`'s exact footing (405
   * D-03).
   *
   * SUPPLIED BY THE COMPOSITION, NEVER SPELLED HERE, for the reason its two neighbours are: the
   * op id is the agent package's constant, a string literal in this package would be a second
   * declaration of a capability's name free to drift from the spec that answers to it, and this
   * package may not import `@vostride/agent-qa-agent` at all (validate:arch) — so there is nowhere
   * here the real constant could come from.
   *
   * WHAT IT REPLACES is worth naming: run detail used to be assembled by reading SQLite from
   * inside the router. Routing it through this id is what makes the same durable read available
   * to the CLI, MCP and chat instead of to the browser alone.
   */
  readonly runsDetailFunctionId: string
  /** The evidence op identity supplied by the same composition as the detail reader. */
  readonly runsEvidenceFunctionId: string
  /**
   * The agent package's `runs.artifact` id, on `runsDetailFunctionId`'s exact footing.
   *
   * SUPPLIED BY THE COMPOSITION, NEVER SPELLED HERE, for the reason its four neighbours are — and
   * for one more that is specific to this route: the artifact arm serves BYTES, and the alternative
   * to dispatching them through the function layer is this package constructing the evidence store
   * and reading a file. That would be a private store read no roster row covers and no audit sink
   * sees, on a path whose two inputs both arrive from a URL. Routing it through an id is what makes
   * the containment rule the store's own and the capability one the CLI, MCP and 408's embed reach
   * the same way.
   */
  readonly runsArtifactFunctionId: string
  /**
   * The agent package's `analysis.get` id, on `runsArtifactFunctionId`'s exact footing.
   *
   * SUPPLIED BY THE COMPOSITION, NEVER SPELLED HERE, for the reason its five neighbours are: the
   * op id is the agent package's constant, a string literal in this package would be a second
   * declaration of a capability's name free to drift from the spec that answers to it, and this
   * package may not import `@vostride/agent-qa-agent` at all (validate:arch) — so there is nowhere
   * here the real constant could come from.
   *
   * WHAT IT SERVES is the failure view: the resolved verdicts and rendered sentences a person
   * reads inside each failed member's group, on BOTH doors through one adapter. `analysis.get` is
   * the single producer of those sentences, so routing the page's read through this id
   * is what keeps the browser, the CLI, chat and 408's embed reading one answer.
   */
  readonly analysisGetFunctionId: string
  /**
   * The agent package's `runs.knowledge` id, on `analysisGetFunctionId`'s exact footing
   *
   * THE SIXTH ID THE RUN-SERVICE ROUTES DISPATCH, supplied by the composition and never spelled
   * here, for the reason its five neighbours are: the op id is the agent package's constant, a
   * string literal in this package would be a second declaration of a capability's name free to
   * drift from the spec that answers to it, and this package may not import
   * `@vostride/agent-qa-agent` at all (validate:arch) — so there is nowhere here the real constant
   * could come from.
   *
   * WHAT IT SERVES is the Knowledge panel: what a run USED (the brief channels served per step,
   * the serve-time trace behind each, procedure replay and hint use, the recorded retrieval rung)
   * and what it LEARNED (curation counts, the record changes attributable to it, canary outcomes).
   * `runs.knowledge` is the single producer of that whole view, so routing the page's
   * read through this id is what keeps the browser, the CLI, MCP and chat reading one answer
   * instead of a page composing it from N per-step calls that can disagree.
   */
  readonly runsKnowledgeFunctionId: string
  /** the eighth op id arrives as data, on the knowledge id's footing. */
  readonly runsMarkFunctionId: string
  /** the marks-history read id, supplied as data like its neighbours. */
  readonly runsMarksHistoryFunctionId: string
  /** the read-tier mark consequence preview id. */
  readonly runsMarkPreviewFunctionId: string
  /**
   * `invokeFunction`, bound by the composer. THE one door call.
   *
   * `input` IS `unknown`. Every op this seam carries has its own strict input schema.
   * Narrowing here would mean this package describing other packages' input contracts — and the
   * real `invokeFunction` has always taken `unknown`, because the op's own schema is what validates
   * it, once, inside the invocation.
   */
  invokeFunction(
    registry: AgentRegistryHandle,
    functionId: string,
    input: unknown,
    caller: FunctionCaller,
  ): Promise<unknown>
}

// prettier-ignore
export const AGENT_HOST_MEMBERS = [
  'registry',
  'caller',
  'runsPostProcessingFunctionId',
  'runsEventsFunctionId',
  'runsDetailFunctionId',
  'runsEvidenceFunctionId',
  'runsArtifactFunctionId',
  'analysisGetFunctionId',
  'runsKnowledgeFunctionId',
  'runsMarkFunctionId',
  'runsMarksHistoryFunctionId',
  'runsMarkPreviewFunctionId',
  'invokeFunction',
] as const satisfies readonly (keyof AgentHost)[]
