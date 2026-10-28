// The per-caller server factory (Phase 396 plans 01 + 04, D-01 / D-02 / D-05 / D-11 / D-13 / D-16).
//
// WHY THIS FILE EXISTS. `buildAgentQaMcpServer(deps)` is the only thing this package hands a host:
// give it a composed registry, the caller that host minted, and a masker, and it returns an
// `McpServer` carrying the tools and resource templates this composition can serve, each of which
// does nothing but validate and call `invokeFunction`. Every serving entry in the v2 SDK takes a
// FACTORY and runs it once per serving unit — once per HTTP request, once per stdio connection.
//
// 2026-10-01 (432-20, D-12): THE SAME CATALOGUE FOR EVERY CALLER. The per-caller visibility law
// (`visibleToCaller` over required and granted scopes) and the mark tool's credential hiding are
// deleted, so a tool is absent only when this composition does not register its op — a fact about
// the host, identical for a tokenless stdio caller and a tokenless HTTP one. Since 432-21 the mark
// tool's handler refuses nobody either: there is no bearer credential for it to read.
//
// THE HANDLERS DO NOTHING. That is D-01's "pure projection" spelled as code, and it is the whole
// architectural claim of the phase: no MCP-local business logic, no second data path, no reaching
// past the function layer the way the v1 server reached the dashboard's REST API. Read any handler
// below and the only verbs are `invokeFunction` and the masker.
//
// THREE DISPATCH SHAPES AND NO FOURTH, all of them still nothing but validate-and-invoke:
//   single   — one op, called with the caller's arguments unchanged.
//   union    — D-01's fold. The discriminant names the arm, is CHECKED against the tool's declared
//              op set, is stripped, and the rest goes to that op. The check is T-396-10's mitigation:
//              a caller cannot smuggle an op this tool does not declare, and even if the composed
//              union were wrong, `invokeFunction` re-validates against the op's own contract.
//   pipeline — D-02's one read door. Two `invokeFunction` calls, the second reached only through the
//              first's resolved arm. Two calls and not one because that is what the resolve-then-get
//              contract IS; a single call could not tell an ambiguous reference from a resolved one.
//
// NO PROMPTS ARE REGISTERED (D-14). The authoring brief reaches callers as data through the
// authoring tools, and 398's build-time capability catalog owns discoverability. The SDK's prompt
// registration verb is therefore named NOWHERE in this file — including in prose, since an
// acceptance grep counts occurrences of that symbol and requires zero, and a guard a comment can
// defeat is not a guard.
//
// Protocol grounding: SEP-2567 (no per-connection list variance — and since 432-20 no per-caller
// variance either), SEP-2549 (list results carry cache hints), SEP-2106 (full JSON Schema 2020-12
// for the advertised contracts).

import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { invokeFunction, RUNS_ARTIFACT_FUNCTION_ID } from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { MCP_APPS_EXTENSION_ID, appResourceUriFor, registerAppResources } from './app-resource.js'
import { AGENT_QA_MCP_INSTRUCTIONS } from './instructions.js'
import { liveLinkLineFor } from './live-link.js'
import type { LiveLinkSupplier } from './live-link.js'
import {
  advertisedContracts,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
} from './mapping.js'
import type { ToolProjection } from './mapping.js'
import {
  decorateRunEvidenceImage,
  maskedToolError,
  maskedToolResult,
} from './masked-result.js'
import { V1_TOOL_MIGRATION_MAP } from './migration-map.js'
import type { V1ToolMigrationEntry } from './migration-map.js'
import { McpProjectionError, toRegisterToolConfig } from './projection.js'
import type { ProjectedOpSpec } from './projection.js'
import { registerEntityResources } from './resources.js'

/**
 * The version this server reports.
 *
 * A constant here and NOT the package version read off disk: reading `package.json` at runtime is a
 * host capability this package does not have and must not acquire (its runtime dependency allow-list
 * is the two protocol packages, D-20). Plan 05 decides whether the host should pass its own version
 * in, which is the only place that fact honestly lives.
 */
export const AGENT_QA_MCP_SERVER_VERSION = '2.0.0'

/** What a host must supply to build a server for one caller. */
export interface AgentQaMcpServerDeps {
  /** The composed function registry. Built by the HOST, never by this package (D-09). */
  readonly registry: FunctionRegistry
  /**
   * WHO this server answers as. Minted by the composition root and passed through untouched to
   * `invokeFunction`. Since 432-20 (D-12) nothing here reads it to decide what to list or serve;
   * its `surface` and `origin` reach only the receipts that already consume them. Since 432-21 no
   * field of it is a credential this package reads.
   */
  readonly caller: FunctionCaller
  // 2026-10-14 (441-07, D-06): `maskText` is the host's declared-secret mask.
  /**
   * How text leaving this process is masked (threat T-396-01).
   *
   * REQUIRED, not optional, and the reason is a measured one rather than a preference: the defect
   * class this replaces (T-395-R5-10, closed in 395's final round) was a credential reaching an MCP
   * caller verbatim through an error serialization. An optional masker is absent exactly where
   * nobody thought to pass one, which is the same place the leak was found.
   */
  readonly maskText: (text: string) => string
  /**
   * Which dashboard this process is pointed at, for D-08's permanent link (408 plan 03).
   *
   * OPTIONAL, AND ITS ABSENCE IS THE DEGENERATE CASE RATHER THAN A SECOND BRANCH: a host that
   * supplies nothing and a supplier that answers `undefined` are the same fact — no dashboard is
   * configured and none is running here — and both take the same path to the same named-absence
   * line. There is no arm below that asks which of the two happened, deliberately: a distinction
   * nothing acts on is a distinction that eventually acquires a wrong action.
   *
   * A FACTORY, NOT A STRING, because on the co-hosted composition the bound origin does not exist
   * until a port has been bound — `commands/dashboard.ts` composes this host before it listens.
   */
  readonly liveLink?: LiveLinkSupplier
}

/** The host-bound `(registry, caller)` closure over `invokeFunction`. */
type BoundInvoke = (opId: string, input: unknown) => Promise<unknown>

/**
 * Join the mapping's declared contracts with this host's registry declarations.
 *
 * Returns `undefined` when any arm is missing from the registry — which is a REAL answer and not an
 * error: a projection naming an op a given composition does not register is a tool that composition
 * genuinely cannot serve, and refusing to build the whole server over it would take an editor's MCP
 * connection down because one capability was unavailable. A contract missing from the mapping table
 * IS an error, because that is this repository disagreeing with itself.
 */
function resolveSpecs(
  projection: ToolProjection,
  declarations: ReadonlyMap<string, ProjectedOpSpec>,
): readonly ProjectedOpSpec[] | undefined {
  const specs: ProjectedOpSpec[] = []
  for (const opId of projection.ops) {
    const resolved = declarations.get(opId)
    if (resolved === undefined) return undefined
    specs.push(resolved)
  }
  return specs
}

/**
 * Read a fold call's arm, refusing anything the tool does not declare (T-396-10).
 *
 * The SDK has already validated the arguments against the fold's discriminated union, so this
 * check is the SECOND reading of the same fact — kept for the reason every other double-check in
 * this layer is kept: the two readings have independent sources (the composed schema in
 * `@vostride/agent-qa-schema`, the op list in `mapping.ts`), so a disagreement between them is
 * exactly the drift worth refusing on rather than dispatching through.
 */
function selectFoldArm(
  projection: ToolProjection,
  args: unknown,
): { readonly opId: string; readonly input: Record<string, unknown> } {
  const key = projection.discriminant!
  const record = (args ?? {}) as Record<string, unknown>
  const selected = record[key]
  if (typeof selected !== 'string' || !projection.ops.includes(selected)) {
    throw new McpProjectionError(
      projection.name,
      `was called with ${key}=${JSON.stringify(selected)}, which is not one of the ops it declares`,
    )
  }
  // The discriminant is WIRE vocabulary and stops here: what crosses the function-layer wall is the
  // object `invokeFunction` will parse against the op's own `.strict()` contract, which would refuse
  // the extra key.
  const { [key]: _arm, ...input } = record
  return { opId: selected, input }
}

/** The one arm of an entity resolution that has something further to fetch (D-02). */
function resolvedCardId(resolution: unknown): string | undefined {
  if (typeof resolution !== 'object' || resolution === null) return undefined
  const record = resolution as { kind?: unknown; card?: unknown }
  if (record.kind !== 'resolved') return undefined
  const card = record.card as { id?: unknown } | undefined
  return typeof card?.id === 'string' ? card.id : undefined
}

/**
 * Run one projected call and answer what the op answered, with the op that answered it.
 *
 * Every branch is `invokeFunction` and argument shuffling. Nothing computes a result, nothing reads
 * a store, nothing decides a policy.
 */
async function runProjection(
  projection: ToolProjection,
  args: unknown,
  invoke: BoundInvoke,
): Promise<{ readonly opId: string; readonly output: unknown }> {
  switch (compositionOf(projection)) {
    case 'single':
      return { opId: projection.ops[0]!, output: await invoke(projection.ops[0]!, args) }
    case 'union': {
      const arm = selectFoldArm(projection, args)
      return { opId: arm.opId, output: await invoke(arm.opId, arm.input) }
    }
    case 'pipeline': {
      // D-02's one read door: resolve the reference the caller has, then — and only when the
      // resolver committed to ONE entity — re-read that entity at its canonical address. The second
      // read is the never-guess `entities.get`, so what a caller finally holds is the card an exact
      // address renders rather than the resolver's own rendering of a match.
      const resolution = await invoke(projection.ops[0]!, args)
      const id = resolvedCardId(resolution)
      if (id === undefined) return { opId: projection.ops[0]!, output: resolution }
      const card = await invoke(projection.ops[1]!, { ref: id })
      return { opId: projection.ops[1]!, output: { ...(resolution as Record<string, unknown>), card } }
    }
  }
}

/**
 * The concrete run this carrier's result is ABOUT, read from the source the projection declares.
 *
 * DEFENSIVE ON BOTH ARMS, and neither arm is hypothetical. `runIdFrom: 'input'` reads the args the
 * SDK already validated against the advertised input schema; `runIdFrom: 'output'` reads the op's
 * own result, which is a `RunStartAcknowledgement` today and could be a fold's arm tomorrow. Either
 * can answer with something that is not a string — and the honest treatment of that is the same as
 * the honest treatment of a missing dashboard: the LINE becomes the named absence and there is no
 * concrete App address to advertise. What it must never be is a crash, because that would turn a
 * decoration into a way to fail a tool call that had already succeeded.
 */
function carrierRunIdOf(
  projection: ToolProjection,
  args: unknown,
  output: unknown,
): string | undefined {
  const source = projection.ui?.runIdFrom === 'output' ? output : args
  const runId = (source as { runId?: unknown } | null | undefined)?.runId
  return typeof runId === 'string' && runId !== '' ? runId : undefined
}

/**
 * Add D-08's link-out line and D-05's concrete App address to a CARRIER's result.
 *
 * ADDITIVE, AND ONLY ADDITIVE. One `content` text part is appended and one `_meta` key is set; the
 * op's own answer — the masked serialization `structuredContent` and its text are both composed
 * from — is byte-identical to what it was. This is deliberately NOT a second serialization: a
 * result whose data channel was rebuilt beside its text channel is exactly the two-channel drift
 * `masked-result.ts` exists to prevent.
 *
 * THE LINE PASSES THROUGH `maskText`, on the house law that everything a surface prints does. It is
 * a no-op on a well-formed link and it is supposed to be: the dashboard base is `masked: false` by
 * the overlay law (a loopback origin this process minted is not the operator's secret), and the
 * page it names is tokenless by D-08. Masking it anyway costs nothing and means nobody has to
 * remember that this one printed string is exempt — which is how the 396-03 gap happened.
 *
 * `_meta.ui.resourceUri` ATTACHES UNCONDITIONALLY — it is not gated on negotiation. This is a
 * RECORDED DEVIATION FROM D-09's LETTER, which says the App reference attaches ONLY when the host
 * negotiated the Apps extension and explicitly rejected unconditional attachment. It is not an
 * oversight, and as of 2026-09-01 it is not the planner's or the executor's judgment either — see
 * the ruling line below. Two grounds were originally recorded; only the first survives:
 *
 *   1. `_meta` IS INERT (RESEARCH A2). A host that never negotiated `io.modelcontextprotocol/ui`
 *      has no code that reads it, so what it receives is a key it ignores. Gating the
 *      ADVERTISEMENT would buy nothing and cost the thing D-09 actually asks for — a host must be
 *      able to SEE that an App exists in order to ask for it — and it would also contradict the
 *      already-shipped tools/list `_meta.ui` TEMPLATE, which is advertised unconditionally too.
 *   2. SUPERSEDED 2026-09-01. The second ground read "the ACTING channel is the `ui://` read, and
 *      THAT is gated — by `negotiatedAppsExtension`". The 408 gap round re-adjudicated that gate:
 *      it reads a value the caller composes in its own per-request `_meta` and the SDK forwards
 *      unauthenticated, so it is a host-capability signal and not an authorization control
 *      (`app-resource.ts`'s header, THE 2026-09-01 GAP-ROUND RULING, road `demote`). The clause is
 *      struck as a ground. What DOES bound the acting channel, and what this ground is replaced
 *      by: the `ui://` read is reachable only in a composition where the mint is BOUND
 *      (`bindingStatus === 'bound'`, D-03's floor), a fact this server verifies. (Until 432-20
 *      it was also scope-gated by `visibleToCaller`; D-12 deletes that gate for every caller.)
 *
 * THE RULING, dated 2026-09-01 (408-08 task 1, question 2 — the USER'S answer at that plan's
 * checkpoint, `d09-retain`, quoted verbatim in `408-08-SUMMARY.md`). The deviation from D-09's
 * letter is RETAINED by that ruling, not by a better rationale: D-09 is a ratified user decision,
 * so its letter's fate was the user's to decide and was decided there. Three things this line
 * exists to keep visible. (i) The ORIGINAL justification rested in part on a gate the 2026-08-31
 * verification measured and the 2026-09-01 gap round re-adjudicated — that ground is falsified and
 * struck, above, rather than quietly reworded. (ii) The retention is the user's dated ruling.
 * (iii) RESEARCH A2 — that a host ignores unknown `_meta` keys gracefully — remains `[ASSUMED]`
 * and OPEN: no individual host has been measured choking on one, and UAT item 3 (the real-host
 * App-less leg) is the measurement that would settle it. The code is unchanged by this ruling:
 * `_meta.ui.resourceUri` still attaches whenever a run id is resolvable.
 *
 * A REFUSAL IS NOT DECORATED. `maskedToolError` results, and the withheld-result arm of
 * `maskedToolResult`, are left exactly as they are: a refusal is not a carrier of a watch
 * affordance, and appending "watch live" to a sentence explaining why nothing happened would be a
 * link to a run that was never started.
 */
function decorateCarrierResult(input: {
  readonly result: CallToolResult
  readonly projection: ToolProjection
  readonly args: unknown
  readonly output: unknown
  readonly maskText: (text: string) => string
  readonly liveLink?: LiveLinkSupplier
}): CallToolResult {
  if (input.projection.ui === undefined) return input.result
  if (input.result.isError === true) return input.result

  const runId = carrierRunIdOf(input.projection, input.args, input.output)
  const line = liveLinkLineFor(input.liveLink?.dashboardBaseUrl(), runId)

  return {
    ...input.result,
    content: [...input.result.content, { type: 'text' as const, text: input.maskText(line) }],
    ...(runId === undefined
      ? {}
      : { _meta: { ...input.result._meta, ui: { resourceUri: appResourceUriFor(runId) } } }),
  }
}

/**
 * The one generic tool handler.
 *
 * Input validation happened twice before the invoke — once by the SDK against the tool's input
 * contract, once inside `invokeFunction` against the op's own — and both parses are kept, because
 * they are the same check made by two independent parties.
 */
function createProjectionHandler(
  projection: ToolProjection,
  invoke: BoundInvoke,
  maskText: (text: string) => string,
  liveLink?: LiveLinkSupplier,
) {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      const { opId, output } = await runProjection(projection, args, invoke)
      // BOTH channels from ONE masked serialization (396-06). `structuredContent` used to be the
      // raw op output, and a declared credential reached the wire through it verbatim while the
      // text beside it read `<SECRET_0>` — RESEARCH Pitfall 9's own named channel, measured.
      const masked = maskedToolResult(output, maskText)
      // 431-05 D-07: the image block is decided AFTER masking, from bytes the masked value still
      // carries unchanged. Deciding it from the raw output would put bytes beside a withheld result.
      const result = opId === RUNS_ARTIFACT_FUNCTION_ID
        ? decorateRunEvidenceImage({ result: masked, output, maskText })
        : masked
      // 408 D-05/D-08/D-09: the watch affordance, on every carrier result, for every host class.
      return decorateCarrierResult({
        result,
        projection,
        args,
        output,
        maskText,
        ...(liveLink === undefined ? {} : { liveLink }),
      })
    } catch (err) {
      // A refusal is a RESULT, not a transport failure: the caller gets the reason as a tool
      // error it can read. The message is masked for the reason the whole file exists — an
      // error string is the channel 395's credential disclosure actually travelled down.
      return maskedToolError(err, maskText)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The retired-v1-name redirect (Phase 398 plan 05, D-15 · XPLN-03)
// ---------------------------------------------------------------------------------------------
//
// WHAT THIS IS. `migration-map.ts` holds thirty-three rulings about names this surface no longer
// serves. An external agent still pinned to one of them gets the ruling instead of a bare
// unknown-tool error — and gets it as an ERROR, always. Nothing below invokes anything, forwards
// anything, or registers anything: a v1 name that became a listed alias would be the v1 surface
// resurrected with a mismatched input shape, which is the door D-15 refuses to reopen.
//
// WHY IT LIVES HERE AND NOT IN `http.ts`. Both hosts reach this one factory — `serveStdio` wraps it
// on stdio and `createMcpHandler` wraps it on loopback HTTP — so a redirect installed on either
// transport would answer on one and not the other. SEP-2567's per-request factory model is also
// what makes the answer per-CALLER: the wrapper below closes over `registered`, the set this
// instance built for THIS caller, and never over connection state.
//
// WHY IT WRAPS THE DISPATCH EDGE (measured 2026-08-17, recorded in `__tests__/redirect.test.ts`).
// A name nobody registered never reaches code this package wrote: `McpServer` installs its own
// `tools/call` handler, looks the name up in its registered-tool table, and throws `InvalidParams`
// on a miss. There is no fall-through to hook and no unknown-tool callback in the SDK's surface, so
// the only seam that can answer a name with NO handler is that installed handler itself. It is
// wrapped rather than replaced, and the wrapper's non-member branch is a bare call to the SDK's own
// function with the arguments it was given — which is what makes "answers exactly as today" a
// structural fact rather than a string this package keeps in step by hand.

/** The JSON-RPC method the wrapper owns. Named once. */
const TOOLS_CALL_METHOD = 'tools/call'

/**
 * The narrow shape of the SDK's low-level handler table.
 *
 * Reaching for it is the one liberty this module takes with its dependency, and it is taken with
 * eyes open: `removeRequestHandler` is public API, `setRequestHandler` is public API, and the only
 * unpublished thing is READING BACK the handler already installed so it can be delegated to.
 * The alternative — writing a `tools/call` handler that dispatches registered tools itself — is a
 * second dispatch path through the SDK's private validation, execution and wire-projection steps,
 * which is a far larger bet than one map lookup.
 */
interface LowLevelDispatch {
  readonly _requestHandlers?: Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>
  removeRequestHandler(method: string): void
  setRequestHandler(method: string, handler: (request: unknown, ctx: unknown) => unknown): void
}

/** The tool name a `tools/call` carries, or `undefined` when the request is not shaped like one. */
function callToolName(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return undefined
  const params = (request as { params?: unknown }).params
  if (typeof params !== 'object' || params === null) return undefined
  const name = (params as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

/**
 * The map entry for an EXACT wire name, or `undefined`.
 *
 * `===` on the string the caller sent, with no normalisation of any kind. Membership is byte
 * equality because the retired set is a set of NAMES: a case-variant is a name nobody ever served,
 * and answering it with a retirement notice would widen the distinguishable set from "the closed
 * v1 list" to "anything that case-folds onto it" — a strictly larger oracle for nothing gained.
 */
function v1MigrationEntryFor(toolName: string): V1ToolMigrationEntry | undefined {
  return V1_TOOL_MIGRATION_MAP.find((entry) => entry.v1Name === toolName)
}

/**
 * The redirect's whole decision: which entry, if any, answers this name on this instance.
 *
 * A LIVE HANDLER ALWAYS WINS. The migration map and the live tool vocabulary are disjoint — asserted
 * by name in `__tests__/mapping-bump-guard.test.ts` — and this ordering is what makes that
 * assertion's failure harmless instead of catastrophic: the worst a bad map entry could do is fail
 * to redirect, never shadow a tool a caller can actually call.
 *
 * It is a separate exported function for one reason. Inside the wrapper the ordering is
 * observationally inert while disjointness holds, so no cell driving the server could tell it from
 * its own absence — a guard nothing can red is decoration (measured: mutation leg M9 reds nothing
 * through the server). Pulled out here it takes a `registered` set a cell can doctor, and the
 * ordering becomes a claim with a bar.
 */
export function v1RedirectFor(
  toolName: string,
  registered: ReadonlySet<string>,
): V1ToolMigrationEntry | undefined {
  if (registered.has(toolName)) return undefined
  return v1MigrationEntryFor(toolName)
}

/**
 * One line about how the v2 tool is called, DERIVED from its declared composition.
 *
 * Not a hand-written sentence per tool: the thing a v1 caller actually gets wrong is the SHAPE, and
 * the shape is exactly what `compositionOf` already reads off the mapping. A fold's line names its
 * discriminant and every arm, because "which arm" is the field v1's one-tool-per-verb vocabulary
 * has no equivalent for.
 */
function v1InputShapeNote(projection: ToolProjection): string {
  switch (compositionOf(projection)) {
    case 'single':
      return 'it takes one input object'
    case 'union':
      return `set \`${projection.discriminant!}\` to one of ${projection.ops
        .map((op) => `\`${op}\``)
        .join(', ')} and pass that arm's own fields`
    case 'pipeline':
      return 'it takes one entity reference and answers the card that reference resolves to'
  }
}

/**
 * What a caller who named a retired v1 tool is told.
 *
 * THE WITHHOLDING IS IN THE SIGNATURE, not in a branch inside the text. `visibleTarget` is passed
 * ONLY when the caller may see that tool, so the sighted sentence cannot be written without it and
 * the unsighted branch has no tool name in scope to leak. A conditional on a boolean would have put
 * the name in scope on both sides, which is how the wrong branch ends up carrying it.
 *
 * The `retired` and `pending` arms take no caller-dependent input at all — they read the entry and
 * nothing else — so their bytes are the same for every caller by construction rather than by a
 * cell's permission (T-398-13).
 */
export function v1RedirectMessage(
  entry: V1ToolMigrationEntry,
  visibleTarget?: ToolProjection,
): string {
  const opening = `\`${entry.v1Name}\` is a retired agent-qa v1 tool name and is not served.`

  if (entry.arm === 'renamed-to') {
    if (visibleTarget === undefined) {
      // The retirement notice. It names no tool, because the caller cannot see the one that
      // carries this capability and a name they cannot call is a grant hint, not help (D-08).
      return (
        `${opening} Call \`tools/list\` for the tools you may call on this server, and `
        + `\`agent-qa init --agent\` for this workspace's capability manifest, which carries the `
        + 'v1 tool-name migration map.'
      )
    }
    return (
      `${opening} The capability it named is now \`${visibleTarget.name}\`. ${entry.note} `
      + `Its input shape is not v1's — ${v1InputShapeNote(visibleTarget)}; \`tools/list\` `
      + 'advertises the contract the call is validated against.'
    )
  }

  if (entry.arm === 'pending') {
    const owned
      = entry.owner === undefined
        ? ''
        : ` The capability it named is a known gap owned by ${entry.owner}.`
    const until = entry.route === undefined ? '' : ` Until then: ${entry.route}`
    return `${opening}${owned} ${entry.note}${until}`
  }

  return `${opening} ${entry.note}${entry.route === undefined ? '' : ` Instead: ${entry.route}`}`
}

/** What the redirect needs to know about the instance it is being installed on. */
interface V1RedirectDeps {
  /**
   * The tool names registered on THIS instance — i.e. exactly what `tools/list` answers.
   *
   * Consulting the recorded set rather than recomputing it is deliberate: "named by the redirect"
   * and "listed by `tools/list`" are the SAME fact rather than two computations that agree today.
   * Since 432-20 (D-12) the only reason a tool is absent is an op this composition does not
   * register, and naming a tool this host cannot serve would be a worse answer than saying nothing.
   */
  readonly registered: ReadonlySet<string>
  readonly maskText: (text: string) => string
}

/**
 * Wrap the installed `tools/call` handler so exact v1 names are answered and nothing else changes.
 *
 * TWO OUTCOMES AND NOTHING ELSE.
 *   * `v1RedirectFor` answers `undefined` — for a live tool, for a non-member, for a request that is
 *     not shaped like a `tools/call` — and the SDK's own function is called with the arguments it
 *     was given, and its answer returned unchanged. Byte identity is not maintained on this path;
 *     it is impossible to lose on it.
 *   * It answers an entry, and the entry is THROWN as the same `InvalidParams` class the SDK throws
 *     for a name nobody serves, so the sole thing distinguishing a retired name from an unknown one
 *     is the sentence — which is history, not a grant. Throwing before any dispatch is also what
 *     makes "never invokes anything" structural (T-398-12).
 */
function installV1NameRedirect(server: McpServer, deps: V1RedirectDeps): void {
  const dispatch = server.server as unknown as LowLevelDispatch
  const sdkHandler = dispatch._requestHandlers?.get(TOOLS_CALL_METHOD)
  if (typeof sdkHandler !== 'function') {
    // Fail loudly rather than ship a server whose redirect silently is not there. This is the same
    // class as the other throws in this file — the package's belief about its own dependency turned
    // out to be false — and it surfaces at the first build, which is where an SDK upgrade should
    // meet it rather than in a caller's error log months later.
    throw new McpProjectionError(
      TOOLS_CALL_METHOD,
      'has no installed request handler to wrap; the SDK no longer registers tool dispatch where '
        + 'this package reads it, so the retired-v1-name redirect cannot be placed',
    )
  }

  dispatch.removeRequestHandler(TOOLS_CALL_METHOD)
  dispatch.setRequestHandler(TOOLS_CALL_METHOD, (request: unknown, ctx: unknown) => {
    const name = callToolName(request)
    // 432-20 (D-12): no tool is hidden from a caller any more, so there is no hidden-tool refusal
    // to answer here. The mark tool is registered for every caller and its own handler answers.
    const entry = name === undefined ? undefined : v1RedirectFor(name, deps.registered)
    if (entry === undefined) return sdkHandler(request, ctx)

    const target
      = entry.arm === 'renamed-to' && entry.v2Tool !== undefined && deps.registered.has(entry.v2Tool)
        ? AGENT_QA_TOOL_PROJECTIONS.find((projection) => projection.name === entry.v2Tool)
        : undefined

    // Masked for the reason every other string this package emits is masked: the exemption list is
    // the thing that goes wrong, not the mask. The text is declared data, so this is a no-op today
    // and stays one only because nobody has to remember that it is.
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      deps.maskText(v1RedirectMessage(entry, target)),
    )
  })
}

/**
 * Build the server this caller sees.
 *
 * The listing is read through `registry.list(deps.caller)` — the registry's own view of itself for
 * this host — so `summary` and `risk` describe the composition in front of the caller rather than a
 * table in this package that could describe a different one. The view is the same for every caller
 * (432-20, D-12).
 */
export function buildAgentQaMcpServer(deps: AgentQaMcpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'agent-qa', version: AGENT_QA_MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        // 408 D-04: the official MCP Apps extension, ADVERTISED rather than assumed. Extensions are
        // bilateral opt-in — a client declares support in the `io.modelcontextprotocol/
        // clientCapabilities` envelope it sends on every request, and reads the server's set back
        // from discovery — so a server that renders App HTML without naming the extension here is
        // one no host will ever ask for it. The value is an empty record because this extension
        // carries no server-side options; what it says is that this endpoint speaks it at all.
        extensions: { [MCP_APPS_EXTENSION_ID]: {} },
      },
      // 433-33 (G-433-9): init's pointer, on the one channel every MCP host receives.
      instructions: AGENT_QA_MCP_INSTRUCTIONS,
    },
  )

  const invoke: BoundInvoke = (opId, input) =>
    invokeFunction(deps.registry, opId, input, deps.caller)

  const declarations = new Map<string, ProjectedOpSpec>()
  for (const declaration of deps.registry.list(deps.caller)) {
    const contracts = AGENT_QA_OP_CONTRACTS[declaration.id]
    if (contracts === undefined) continue
    declarations.set(declaration.id, {
      id: declaration.id,
      summary: declaration.summary,
      risk: declaration.risk,
      input: contracts.input,
      output: contracts.output,
    })
  }

  const registered = new Set<string>()
  for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
    if (registered.has(projection.name)) {
      // Unreachable while the mapping table holds distinct names, and asserted anyway: a silent
      // last-wins here would drop a capability from every caller's vocabulary and leave the bump
      // guard comparing two sets that both lost the same member.
      throw new McpProjectionError(
        projection.name,
        'is declared twice in the mapping table; another projection already occupies that name',
      )
    }

    for (const opId of projection.ops) {
      if (AGENT_QA_OP_CONTRACTS[opId] === undefined) {
        throw new McpProjectionError(
          projection.name,
          `names op ${opId}, which has no entry in the contract table`,
        )
      }
    }

    const advertised = advertisedContracts(projection)
    if (advertised === undefined) {
      throw new McpProjectionError(
        projection.name,
        'has no advertised contract; a multi-arm tool needs an entry in AGENT_QA_COMPOSED_CONTRACTS',
      )
    }

    const specs = resolveSpecs(projection, declarations)
    if (specs === undefined) continue

    registered.add(projection.name)
    const config = toRegisterToolConfig(projection, specs, advertised, deps.maskText)

    // 2026-10-01 (432-21, D-12): every tool, the mark door included, goes through the one generic
    // handler. The mark door's credential refusal left with the MCP bearer credential, so a mark
    // answers its receipt on the one call like every other change tool (432-12 D-05/D-14).
    server.registerTool(
      projection.name,
      config,
      createProjectionHandler(projection, invoke, deps.maskText, deps.liveLink),
    )
  }

  // D-15: the retired v1 names, answered at the dispatch edge with `registered` — the set the loop
  // above just built — as the authority on what may be named.
  installV1NameRedirect(server, { registered, maskText: deps.maskText })

  // D-13: the six entity Resource Templates, resolving through the SAME wall. Registered here rather than by the host so a `resource_link` in any tool result
  // above is dereferenceable on the instance that produced it.
  registerEntityResources(server, {
    registry: deps.registry,
    caller: deps.caller,
    maskText: deps.maskText,
  })

  // 408 D-01/D-02/D-04: the App template for a live run, registered HERE for the reason the entity
  // templates are — a `_meta.ui.resourceUri` on any carrier tool above is only a decoration unless
  // it is dereferenceable on the very instance that advertised it. It crosses the SAME wall and
  // registers NOTHING on a composition that cannot honestly mint (D-03's floor), so a host without
  // a live view is told by structural absence rather than by a read that always fails.
  registerAppResources(server, {
    registry: deps.registry,
    caller: deps.caller,
    maskText: deps.maskText,
    // 408 plan 03 (D-08): the SAME supplier the carrier decoration reads, so the anchor inside the
    // App document and the line beside a tool result name one page for one run.
    ...(deps.liveLink === undefined ? {} : { liveLink: deps.liveLink }),
  })

  return server
}
