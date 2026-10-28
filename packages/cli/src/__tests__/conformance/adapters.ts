// The four surface adapters the parity suite enumerates through (Phase 397 plan 01, D-01/D-02/D-03;
// the `fn` door added 2026-08-20, Phase 399.1 plan 06, D-07; the dashboard door added 2026-08-21,
// Phase 400 plan 01, D-09/D-12).
//
// 2026-09-28 (Phase 430, D-03): four adapters again, for `chat`, `mcp`, `fn` and `run-service`. The
// dashboard chat door's adapter is removed with the door (430 D-02); the counts above are history.
//
// WHAT AN ADAPTER ANSWERS, AND IN WHAT VOCABULARY. `enumerateOpIds()` returns the set of REGISTRY OP
// IDS a surface can reach, never the surface's own names. D-01 makes the op id the comparison
// currency of every leg in this phase and of 398's catalogue projection, because the two surfaces
// spell the same capability differently — `runs.list` is `agent_qa_list_runs` over MCP and
// `runs_list` in a model plan — and a comparison conducted in either surface's spelling would be
// comparing that surface to itself.
//
// EVERY ENUMERATION BELOW IS PRODUCED. The MCP side reads `tools/list` off a REAL `McpServer` built
// by the shipped factory and driven by a real protocol client over the SDK's own in-process handler;
// the chat side runs the shipped planner projection and the shipped resolver table's own resolvers.
// Nothing here contains a listing of tool names or op ids. A hand-assembled listing would make this
// file's idea of a surface the subject, and the defect class the suite exists to catch — a
// capability reachable on a surface that the declared data never catalogued — is invisible to a
// comparison of a table against itself.
//
// THE FOLD EXPANSION AND THE STRAY DIAGNOSTIC ARE THE SAME MECHANISM (D-01). An MCP tool stands in
// front of one or more ops per the declared mapping; expanding a listed tool through that mapping is
// how a wire name becomes op ids, and a listed tool the mapping does not know is what is left over.
// That leftover IS the uncatalogued-capability shape the FUNC-06 mutation plants, so it is returned
// as data rather than thrown, and the suite asserts it empty by name.
//
// THE CORES ARE PURE so their named-RED branches can be driven with synthetic input in a control
// cell without mutating a shipped file or introducing a skip. A detector nobody has seen fire is a
// comment.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import {
  CHAT_RESOLVER_TABLE,
  createFunctionRegistry,
  fromToolName,
  isChatMetaToolName,
  projectPlannerTools,
  ANALYSIS_GET_FUNCTION_ID,
  RUNS_ARTIFACT_FUNCTION_ID,
  RUNS_DETAIL_FUNCTION_ID,
  RUNS_EVIDENCE_FUNCTION_ID,
  RUNS_LIVE_URL_FUNCTION_ID,
  RUNS_MARK_PREVIEW_FUNCTION_ID,
  RUNS_MARKS_HISTORY_FUNCTION_ID,
  RUNS_START_FUNCTION_ID,
  type ChatResolverTable,
  type FunctionDeclaration,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import { CHAT_PLANNER_CALLER } from '@vostride/agent-qa-agent-local'
import {
  AGENT_QA_TOOL_PROJECTIONS,
  buildAgentQaMcpServer,
  type ToolProjection,
} from '@vostride/agent-qa-mcp'
import {
  RUN_SERVICE_ANALYSIS_TEMPLATE,
  RUN_SERVICE_ARTIFACT_TEMPLATE,
  RUN_SERVICE_DETAIL_TEMPLATE,
  RUN_SERVICE_EVENTS_TEMPLATE,
  RUN_SERVICE_EVIDENCE_TEMPLATE,
  RUN_SERVICE_LIVE_URL_TEMPLATE,
  RUN_SERVICE_MARK_PREVIEW_TEMPLATE,
  RUN_SERVICE_MARKS_TEMPLATE,
  RUN_SERVICE_OK_ROUTE,
  RUN_SERVICE_ROUTE_TABLE,
  RUN_SERVICE_START_ROUTE,
} from '@vostride/agent-qa-dashboard'
import {
  RunServiceReadinessSchema,
  RunsEvidenceResultSchema,
  RunsLiveUrlResultSchema,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryResultSchema,
  RunStartAcknowledgementSchema,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { Command } from 'commander'
import { vi } from 'vitest'

import {
  composeDashboardDoor,
  composeRunServicePorts,
  createDashboardRunDoor,
} from '../../commands/dashboard.js'
import { composeLiveView } from '../../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../../composition/run-service-session-registry.js'
import { createFnCommand } from '../../commands/fn.js'
import { MCP_FUNCTION_CALLER } from '../../commands/mcp.js'
import { runServiceFixtureProject } from './spawned-chat.js'

/** Which enumeration produced a capability the declared data does not catalogue. */
export interface SurfaceStray {
  readonly kind:
    | 'mcp-listed-tool'
    | 'chat-alias-target'
    | 'fn-listed-op'
    // 402-07's two, and they are two because the run-service door's reach is folded from a ROUTE
    // TABLE rather than from a listing of names. A route the door answers that the binding below
    // does not cover is a door widened without this suite seeing it; a bound op id the registry
    // census does not declare is the uncatalogued-capability shape every other row already reports.
    | 'run-service-unbound-route'
    | 'run-service-bound-op'
    // The reverse direction of the same register: a binding naming a route the shipped table no
    // longer carries. Without it the binding could keep certifying a door that is gone, which is
    // the half-a-register shape `probeResolverTable` refuses by name.
    | 'run-service-stale-binding'
    // And the third direction, which is the one that keeps the fold from being vacuous: a route the
    // shipped table PUBLISHES that the running door did not answer. Without it a door that answered
    // nothing at all would still enumerate whatever the declared binding names, and the roster's
    // "enumerated nothing" leg — the one guard against a surface going silent — could never fire.
    | 'run-service-unanswered-route'
  /** The stray itself — a wire tool name, a resolver alias's function-id target, a listed op id. */
  readonly name: string
}

/**
 * A capability class a rostered door structurally does not expose — DECLARED, never absent (D-04).
 *
 * WHY THIS IS A FIELD AND NOT A SILENCE. Four of the five rostered doors reach the whole registry
 * census, so "what this door cannot do" was never a question the roster had to answer. The run
 * service is the first door with a NARROW reach by design — one op and a stream — and a narrow door
 * whose narrowness is expressed only by the ops it happens not to enumerate is indistinguishable
 * from a door that lost half its reach in a regression. 397 D-12 refuses to start keeping a skip
 * list; this is the opposite of one, because every member states a fact about the door's SHAPE that
 * a reader can check against the door.
 *
 * `why` IS A FACT ABOUT THE DOOR, NEVER A SCHEDULE. "403 will add this" is a plan; "this door
 * publishes no route that dispatches it" is a property somebody can go and disprove.
 */
export interface SurfaceNotApplicable {
  /** The capability class, in the roster's own words. */
  readonly capability: string
  /** Why this door cannot reach it — a property of the door, checkable today. */
  readonly why: string
}

/** What one surface reaches, plus what it reached that nothing declares. */
export interface SurfaceEnumeration {
  readonly opIds: ReadonlySet<string>
  readonly strays: readonly SurfaceStray[]
}

/**
 * One rostered surface, as the suite drives it.
 *
 * `enumerateOpIds` is async because one of the two surfaces answers over a protocol round trip and
 * the other does not, and a shape that could only carry the synchronous one would have forced the
 * MCP side into a second, non-wire read — which is the hand-assembled listing this file refuses.
 */
export interface SurfaceAdapter {
  readonly id: string
  enumerateOpIds(): Promise<SurfaceEnumeration>
  /**
   * What this door structurally cannot do — REQUIRED, so a door declares it rather than omits it.
   *
   * Required and not optional on purpose: an optional field lets a narrow door say nothing and read
   * exactly like a wide one, which is the omission {@link SurfaceNotApplicable} exists to make
   * impossible. The four wide doors declare an EMPTY list, which is a claim ("this door reaches the
   * census") rather than a silence, and a door that later narrows has to come and edit it.
   */
  readonly notApplicable: readonly SurfaceNotApplicable[]
}

/**
 * The caller every census in this suite lists under.
 *
 * 2026-10-02 (432-37, D-12): no `grantedScopes` and no `safeMode`. Until 432-20 the listing was a
 * scope-subset check and safe mode hid the mutating ops, so the census needed every scope and safe
 * mode off; the registry reads neither now, so a census under this caller is the whole catalogue.
 * `origin: 'human'` is kept as the caller's provenance; no op refuses on it since 432-20.
 */
export const CONFORMANCE_CENSUS_CALLER: FunctionCaller = Object.freeze({
  surface: 'conformance',
  origin: 'human',
})

// 2026-10-02 (432-39, D-10/D-12): `MCP_ENUMERATION_SCOPES`, `mcpServerCaller` and the
// `MCP_ENUMERATION_CALLER` alias are deleted with the caller's `grantedScopes` member. The MCP
// helpers below take a whole CALLER instead of a scope set: absent, the server's caller is the
// shipped `MCP_FUNCTION_CALLER`; a cell that must show a retired field is unread builds its own
// smuggled caller (a cast) and hands it in, so the smuggle is visible where the claim is made.

// 2026-10-15 (441-29, D-15): no `ConformanceRegistryOptions`. Its last member forwarded the
// registry's audit sink, which the registry no longer accepts, so the registry is built from deps.

/**
 * The built-in registry, with empty deps.
 *
 * Honest for a listing question: `list()` consults the deps for one thing — whether an op is BOUND
 * in this composition — and membership of the catalogue is a property of the catalogue rather than
 * of a host.
 *
 * EMPTY DEPS ARE THE ZERO-MUTATION GUARANTEE FOR THE VERDICT LEGS, and structurally rather than by
 * assertion: 30 of the 41 capabilities read `unbound` in this composition and refuse by name at
 * step 6, and the 11 that read `bound` hold no port to have an effect through, so an invocation
 * that gets past the gate here reaches a dependency that does not exist and stops. No cell in this
 * suite can write a file, start a run or commit anything.
 */
export function conformanceRegistry(): FunctionRegistry {
  return createFunctionRegistry({
    deps: {} as unknown as FunctionDeps,
  })
}

/** The census, as declarations. */
export function registryDeclarations(): readonly FunctionDeclaration[] {
  return conformanceRegistry().list(CONFORMANCE_CENSUS_CALLER)
}

/**
 * The census, as ids — this phase's reading of the `registry.ids()` the success criteria name.
 *
 * There is no such method: the public enumeration is `list(caller)`, which is why the caller above
 * is exported beside this and used by everything that asks the census a question.
 */
export function registryOpIds(): readonly string[] {
  return registryDeclarations().map((declaration) => declaration.id)
}

// ---- The MCP side ------------------------------------------------------------------------------

/** What a fold expansion produced, and what it could not expand. */
export interface McpFoldExpansion {
  readonly opIds: ReadonlySet<string>
  /** Listed tool names absent from the declared mapping — D-01's uncatalogued-capability shape. */
  readonly strayTools: readonly string[]
}

/**
 * Listed tool names, expanded through the declared mapping into registry op ids.
 *
 * PURE, TOTAL AND SYNCHRONOUS, and the two arguments are both supplied by the caller so a control
 * cell can drive it with a synthetic listing. The alternative — folding this into the wire read —
 * would have left the stray branch reachable only by mutating a shipped file, and a branch that
 * expensive to exercise is a branch nobody exercises.
 *
 * A stray is COLLECTED rather than thrown. The suite names it in a failure message alongside every
 * other stray on that surface; a throw would report the first one and hide the rest, and "how many
 * uncatalogued capabilities are there" is exactly the question a reader of that failure has.
 */
export function expandMcpListedTools(
  listedToolNames: readonly string[],
  projections: readonly ToolProjection[],
): McpFoldExpansion {
  const byName = new Map(projections.map((projection) => [projection.name, projection]))
  const opIds = new Set<string>()
  const strayTools: string[] = []
  for (const name of listedToolNames) {
    const projection = byName.get(name)
    if (projection === undefined) {
      strayTools.push(name)
      continue
    }
    for (const opId of projection.ops) opIds.add(opId)
  }
  return { opIds, strayTools }
}

/**
 * One connected protocol client against a real server, for the duration of one body.
 *
 * The SDK's own in-process handler driver, exactly as `projection-fidelity.test.ts` uses it: the
 * only thing replaced is the socket. `maskText` is passed by name and never defaulted — a masker
 * that can be omitted is a masker that will be — and the identity function is the right one here
 * because these reads' subject is WHICH tools exist rather than what their text says.
 *
 * The connection is scoped to the callback and closed in a `finally`, so nothing is left open for a
 * caller to remember to drain — and the callback shape is what lets the 397-03 absence probes ask
 * nineteen questions of ONE server instance rather than of nineteen freshly built ones, which would
 * make a disagreement between two answers unattributable.
 */
export async function withMcpClient<Answer>(
  body: (client: Client) => Promise<Answer>,
  // 2026-10-02 (432-39, D-12): the caller the server is built over. Absent, the shipped tokenless
  // `MCP_FUNCTION_CALLER`; a cell proving a retired field is unread passes its own smuggled caller.
  caller: FunctionCaller = MCP_FUNCTION_CALLER,
): Promise<Answer> {
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: conformanceRegistry(),
      caller,
      maskText: (text: string) => text,
    }),
  )
  const client = new Client({ name: 'agent-qa-397-conformance', version: '0.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://conformance.local/mcp'), {
        fetch: ((url: URL | string, init?: RequestInit) =>
          handler.fetch(new Request(url, init))) as typeof fetch,
      }),
    )
    return await body(client)
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * A real `tools/list`, off a real server. 2026-10-02 (432-39, D-12): the caller is handed through
 * to {@link withMcpClient}; see there.
 */
export async function listMcpToolNames(caller?: FunctionCaller): Promise<readonly string[]> {
  return withMcpClient(async (client) => {
    const listed = await client.listTools()
    return listed.tools.map((tool) => tool.name)
  }, caller)
}

/**
 * The wire name an unprojected op WOULD carry if this surface projected it, derived from its id.
 *
 * DERIVED RATHER THAN INVENTED PER OP, because the point of the D-12 absence probe is that the door
 * is not there under any spelling a caller would reach for, and nineteen hand-picked guesses would
 * be nineteen chances to pick a name nobody would ever try. The shipped prefix plus the op's own id
 * is the spelling a caller who knows the capability exists would attempt first.
 *
 * `parity.test.ts` asserts that the produced name is ABSENT from the live listing before it calls
 * it. Without that check, a derived spelling that happened to collide with a real tool would turn
 * an absence probe into a call against a live capability while still looking like a probe.
 */
export function plausibleMcpToolSpelling(opId: string): string {
  return `agent_qa_${opId.replace(/\./g, '_')}`
}

/**
 * The MCP surface's op-id reach, read off the wire and folded through the mapping. 2026-10-02
 * (432-39, D-12): the caller is handed through; see {@link withMcpClient}.
 */
export async function enumerateMcpOpIds(caller?: FunctionCaller): Promise<SurfaceEnumeration> {
  const listedToolNames = await listMcpToolNames(caller)
  const expansion = expandMcpListedTools(listedToolNames, AGENT_QA_TOOL_PROJECTIONS)
  return {
    opIds: expansion.opIds,
    strays: expansion.strayTools.map((name) => ({ kind: 'mcp-listed-tool' as const, name })),
  }
}

export const mcpSurfaceAdapter: SurfaceAdapter = Object.freeze({
  id: 'mcp',
  enumerateOpIds: () => enumerateMcpOpIds(),
  // WIDE BY CLAIM, not by silence: this door reaches the whole registry census, so there is no
  // capability class it declines. See {@link SurfaceNotApplicable} for why an empty list is stated.
  notApplicable: Object.freeze([]),
})

// ---- The chat side -----------------------------------------------------------------------------

/** One resolver alias and the registry op it bound, as the shipped rule produced it. */
export interface ResolverOpTarget {
  readonly alias: string
  readonly functionId: string
}

/**
 * What a resolver row is FOR — declared here, checked against what the row actually produces.
 *
 * The chat surface has three kinds of row and only one of them is a capability: an alias that binds
 * a registry op, a session directive that binds no op at all (`/model`, `/pin`, `/help`, `/quit` —
 * chrome and session state, not powers), and the one generic passthrough. Stating the kind and then
 * asserting the row produces it is what keeps this from being a curated reading of the table: a
 * directive that starts binding an op, or an alias that stops, is a mismatch the suite names.
 */
export type ResolverProbeRole = 'capability-alias' | 'directive' | 'generic-passthrough'

/**
 * A clause that makes one resolver row bind, and what that row is declared to be.
 *
 * THE CLAUSE IS AN INPUT, NOT AN ANSWER. Every rule in the shipped table folds matching and argument
 * binding into one function, so the only way to learn which op an alias targets is to run the rule —
 * the rows carry no static `functionId` field to read. What comes back is therefore produced by the
 * shipped resolver; nothing below states an op id.
 *
 * `/fn` is the generic passthrough and its target is whatever the person typed, so it contributes NO
 * op id to the enumeration: it reaches the whole registry by construction, and the id it carries is
 * validated where every id is, at the dispatch that knows what is registered. Counting the id from
 * this probe would be counting this file's own argument.
 */
export interface ResolverProbe {
  readonly alias: string
  readonly clause: string
  readonly role: ResolverProbeRole
}

export const CHAT_RESOLVER_PROBES: readonly ResolverProbe[] = Object.freeze([
  Object.freeze({ alias: 'run', clause: 'run tests/checkout.yaml', role: 'capability-alias' }),
  Object.freeze({ alias: 'status', clause: 'status', role: 'capability-alias' }),
  Object.freeze({ alias: 'test-ref', clause: 'test 42', role: 'capability-alias' }),
  Object.freeze({ alias: 'digest', clause: 'digest r_conformance', role: 'capability-alias' }),
  Object.freeze({ alias: 'model', clause: '/model a-model', role: 'directive' }),
  // 432-13 (C432-CHAT-DIRECT): the `proposals` alias and the `/pin` directive left the table.
  Object.freeze({ alias: 'fn', clause: '/fn runs.list {}', role: 'generic-passthrough' }),
  Object.freeze({ alias: 'help', clause: '/help', role: 'directive' }),
  Object.freeze({ alias: 'quit', clause: '/quit', role: 'directive' }),
] as const satisfies readonly ResolverProbe[])

/**
 * What probing a resolver table produced, WITH the register's own two-directional self-check.
 *
 * A register that can only red on one side is half a register. `unprobedAliases` reds when a row
 * lands in the shipped table with nothing here driving it — the way a new alias would otherwise
 * enter the surface unwatched — and `unknownProbeAliases` reds when a probe here names a row that no
 * longer exists, which is how this file would otherwise keep asserting about a deleted alias.
 */
export interface ResolverProbeOutcome {
  readonly targets: readonly ResolverOpTarget[]
  /** Rows whose produced entry disagreed with the role declared for them. */
  readonly roleMismatches: readonly string[]
  readonly unprobedAliases: readonly string[]
  readonly unknownProbeAliases: readonly string[]
}

export function probeResolverTable(
  table: ChatResolverTable,
  probes: readonly ResolverProbe[] = CHAT_RESOLVER_PROBES,
): ResolverProbeOutcome {
  const byAlias = new Map(table.map((rule) => [rule.alias, rule]))
  const targets: ResolverOpTarget[] = []
  const roleMismatches: string[] = []
  const unknownProbeAliases: string[] = []
  const probed = new Set<string>()

  for (const probe of probes) {
    const rule = byAlias.get(probe.alias)
    if (rule === undefined) {
      unknownProbeAliases.push(probe.alias)
      continue
    }
    probed.add(probe.alias)
    const entry = rule.resolve(probe.clause)
    const produced = entry === undefined ? 'no-match' : entry.kind
    const expected = probe.role === 'directive' ? 'directive' : 'op'
    if (produced !== expected) {
      roleMismatches.push(`${probe.alias}: declared ${probe.role}, produced ${produced}`)
      continue
    }
    if (probe.role === 'capability-alias' && entry !== undefined && entry.kind === 'op') {
      targets.push({ alias: probe.alias, functionId: entry.functionId })
    }
  }

  return {
    targets,
    roleMismatches,
    unknownProbeAliases,
    unprobedAliases: table.map((rule) => rule.alias).filter((alias) => !probed.has(alias)),
  }
}

/** What the chat surface reaches, over both of its routes. */
export interface ChatEnumeration {
  readonly opIds: ReadonlySet<string>
  /** Alias targets naming nothing the registry declares — D-03's uncatalogued-capability shape. */
  readonly strayAliasTargets: readonly ResolverOpTarget[]
}

/**
 * The chat surface's op-id reach: the planner's vocabulary UNION the deterministic route's targets.
 *
 * BOTH ROUTES, because a rule that only watches one door cannot claim there are no private powers.
 * The planner route is the one an LLM drives; the resolver route never touches a model at all, and
 * an alias bound to something the registry does not declare is a capability reachable by typing
 * three letters and catalogued nowhere.
 *
 * The two meta-tools are SUBTRACTED rather than mapped: `answer_only` and `mark_unhandled` are how a
 * model says it answered in prose or that nothing can carry a clause out. They name no registry op,
 * the shipped reverse mapping refuses them by name for that reason, and counting them would inflate
 * this surface's reach by two capabilities that do not exist.
 *
 * A STRAY TARGET IS COUNTED INTO `opIds` AS WELL AS REPORTED. That is deliberate: the reverse
 * completeness leg is a subset claim, and a stray excluded from the set it is a member of would
 * leave that leg unable to fire on the very defect it exists for. Both legs red, and each names the
 * id.
 */
export function chatEnumerationOf(
  plannerToolNames: readonly string[],
  resolverTargets: readonly ResolverOpTarget[],
  registryOpIdSet: ReadonlySet<string>,
): ChatEnumeration {
  const opIds = new Set<string>()
  for (const name of plannerToolNames) {
    if (isChatMetaToolName(name)) continue
    opIds.add(fromToolName(name))
  }
  const strayAliasTargets: ResolverOpTarget[] = []
  for (const target of resolverTargets) {
    opIds.add(target.functionId)
    if (!registryOpIdSet.has(target.functionId)) strayAliasTargets.push(target)
  }
  return { opIds, strayAliasTargets }
}

/**
 * The planner's actual tool vocabulary for this host's registry.
 *
 * Read off the shipped projection under the shipped planner caller, so the set is whatever the
 * composition root's planner would be handed. A walk of the registry spelled here instead would be a
 * second projection, free to disagree with the one the model is given.
 */
export function plannerToolNamesOf(registry: FunctionRegistry): readonly string[] {
  return Object.keys(projectPlannerTools(registry, CHAT_PLANNER_CALLER))
}

export async function enumerateChatOpIds(): Promise<SurfaceEnumeration> {
  const registry = conformanceRegistry()
  const registryOpIdSet = new Set(registry.list(CONFORMANCE_CENSUS_CALLER).map((d) => d.id))
  const probed = probeResolverTable(CHAT_RESOLVER_TABLE)
  const enumeration = chatEnumerationOf(
    plannerToolNamesOf(registry),
    probed.targets,
    registryOpIdSet,
  )
  return {
    opIds: enumeration.opIds,
    strays: enumeration.strayAliasTargets.map((target) => ({
      kind: 'chat-alias-target' as const,
      name: target.functionId,
    })),
  }
}

export const chatSurfaceAdapter: SurfaceAdapter = Object.freeze({
  id: 'chat',
  enumerateOpIds: () => enumerateChatOpIds(),
  // WIDE BY CLAIM, not by silence: this door reaches the whole registry census, so there is no
  // capability class it declines. See {@link SurfaceNotApplicable} for why an empty list is stated.
  notApplicable: Object.freeze([]),
})

// ---- The fn side (2026-08-20, Phase 399.1 plan 06, D-07) ----------------------------------------

/**
 * A project the `fn` listing can be taken in, and nothing more.
 *
 * `composeCliLocalAgent` resolves the configuration before it builds a registry, so a listing taken
 * against a path that does not exist would report a resolution failure rather than a surface. The
 * three keys below are the minimum `AgentQaConfigSchema` accepts — `use.mobile.appState` is required
 * unconditionally, which `surface-dispatch.ts` records having measured. Nothing is planted beyond
 * that: a LISTING consults no store, starts no run and reads no knowledge, so a fixture carrying any
 * of those would be furniture this enumeration never touches.
 */
function fnListingFixture(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-399-1-06-fn-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return { root, configPath }
}

/**
 * What the `fn` door reaches, read off the door's OWN listing rather than off a registry.
 *
 * THE COMMAND IS DRIVEN, NOT RE-DERIVED, and that is the whole reason this function is eight lines
 * of plumbing instead of one call to `registryOpIds()`. `agent-qa fn --list --json` runs commander's
 * argument parse, the CLI composition root, `registry.list(CLI_FUNCTION_CALLER)` and the declaration
 * projection `declarationRow` publishes — four stages, any of which could filter. A comparison
 * against a set this file assembled from the same registry the door lists from would be the
 * table-against-itself shape `adapters.ts`'s header refuses by name: it would pass on a door that
 * had stopped listing half the registry, because both sides would have shrunk together.
 *
 * THE CALLER IS THE DOOR'S OWN (`CLI_FUNCTION_CALLER`) and is deliberately not overridden — a
 * narrowing of the door's posture is a fact about the product this enumeration should report rather
 * than paper over. Until 432-37 the MCP side was the opposite move: it enumerated under an every-scope
 * caller because the MCP host's default grant withheld `config-write`. 2026-10-02 (432-37/432-39,
 * D-12): no grant narrows a listing since 432-20, the caller carries no scope set since 432-39, and
 * the MCP enumeration lists under the shipped `MCP_FUNCTION_CALLER`, so both doors are enumerated
 * under their own callers.
 *
 * STDOUT IS THE READ SURFACE. `--json` is the machine channel the command already publishes, so what
 * is parsed here is bytes the door emitted, not an object this file was handed.
 */
export async function enumerateFnOpIds(): Promise<SurfaceEnumeration> {
  const fixture = fnListingFixture()
  const printed: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    printed.push(values.map(String).join(' '))
  })
  try {
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(createFnCommand())
    program.exitOverride()
    await program.parseAsync([
      'node',
      'agent-qa',
      '--config',
      fixture.configPath,
      'fn',
      '--list',
      '--json',
    ])
  } finally {
    log.mockRestore()
    rmSync(fixture.root, { recursive: true, force: true })
  }

  // A listing that printed nothing is returned as an EMPTY enumeration rather than thrown on: the
  // roster leg already asserts no surface enumerates nothing, by name, and a throw here would report
  // the same fact in a voice that does not say which surface it was about.
  let rows: readonly { readonly id?: unknown }[] = []
  try {
    rows = JSON.parse(printed.join('\n')) as readonly { readonly id?: unknown }[]
  } catch {
    rows = []
  }

  const registryOpIdSet = new Set(registryOpIds())
  const opIds = new Set<string>()
  const strays: SurfaceStray[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') continue
    opIds.add(row.id)
    // The uncatalogued-capability shape for this door, collected rather than thrown on the reason
    // `expandMcpListedTools` states: "how many" is exactly the question a reader of that failure has.
    if (!registryOpIdSet.has(row.id)) strays.push({ kind: 'fn-listed-op', name: row.id })
  }
  return { opIds, strays }
}

export const fnSurfaceAdapter: SurfaceAdapter = Object.freeze({
  id: 'fn',
  enumerateOpIds: () => enumerateFnOpIds(),
  // WIDE BY CLAIM, not by silence: this door reaches the whole registry census, so there is no
  // capability class it declines. See {@link SurfaceNotApplicable} for why an empty list is stated.
  notApplicable: Object.freeze([]),
})

// ---- The run-service side (2026-08-24, Phase 402 plan 07, D-04) ---------------------------------
//
// THE FIFTH DOOR, AND THE FIRST NARROW ONE. `roster.ts`'s 2026-08-16 registration note reserved a
// row for "any post-v2.0 REST or SDK surface"; the authed run service is one, shipped by 402-01, and
// it joins in the phase that ships it. What makes it unlike the four above is its REACH: the chat
// host, the MCP server, `fn` and the dashboard chat door each stand in front of the whole registry
// census, and this one stands in front of exactly one op and one stream.
//
// WHY THE ENUMERATION IS FOLDED FROM A ROUTE TABLE AND NOT FROM A LISTING. Every adapter above reads
// a LISTING off its door — `tools/list`, the planner projection, `fn --list`,
// `GET /api/chat/capabilities` — and folds the names it finds into op ids. This door publishes no
// listing and must not: `run-service-routes.ts` states the reason at `/ok`, that an unauthenticated
// caller learning which routes a process serves is itself a disclosure, and even the authed `/ok`
// answers measured facts rather than a capability catalogue. So the produced side here is not a set
// of NAMES but a set of ROUTES THE DOOR ANSWERED, driven one by one against a real server, read off
// response bytes; the fold is a declared binding from route to registry op.
//
// WHAT THAT MEASURES, AND WHAT IT HONESTLY DOES NOT. It measures that every route the shipped table
// publishes is answered by a running door, that every answered route is bound to something, that
// every binding names a route the shipped table still carries, and that every op id a binding names
// is one the registry census declares. It does NOT prove by construction that `POST /run` dispatches
// `runs.start` rather than some other op — no byte on this wire carries a function id. What narrows
// that gap is the CORROBORATION below: the observed 202 body is parsed under
// `RunStartAcknowledgementSchema`, which is `runs.start`'s own declared result contract, so a route
// re-pointed at a different op answers a body this fold refuses. That is a constraint rather than an
// identity, and saying so is the point — `parity-anchors.test.ts` states the same kind of limit
// about what its two halves can and cannot see.
//
// NOTHING HERE SPELLS AN OP ID. `RUNS_START_FUNCTION_ID` is the product's own exported constant and
// the route table is the product's own exported data; a string literal on either side would make
// this file's idea of the door the subject of the comparison.

/**
 * One published route, bound to the registry capability it stands in front of — or to none.
 *
 * `ownsNoCapability` IS AN ARM, NOT AN OMISSION, and it is the same distinction
 * {@link SurfaceNotApplicable} draws one level up. `/ok` reaches no registry op at all: it answers
 * four facts this process measures about itself. A route left out of the binding because it happens
 * to reach nothing would be indistinguishable from a route somebody forgot, and the fold below
 * reports the second as a stray — so the first has to be able to say so out loud.
 */
export type RunServiceRouteBinding =
  | { readonly key: string; readonly opId: string }
  | { readonly key: string; readonly ownsNoCapability: string }

/** The table's own key for a row, so both sides of the set-equality are spelled once. */
export function runServiceRouteKey(row: { method: string; path: string }): string {
  return `${row.method} ${row.path}`
}

/**
 * What each published route of the run-service door stands in front of (402-07).
 *
 * DECLARED DATA, ASSERTED SET-EQUAL AGAINST THE SHIPPED TABLE IN BOTH DIRECTIONS by the fold below.
 * That two-way equality is what keeps this from being a table compared against itself: a route added
 * to `RUN_SERVICE_ROUTE_TABLE` tomorrow with no entry here is a named RED in the change that adds
 * it, and an entry here naming a route the door no longer serves is a named RED too.
 */
export const RUN_SERVICE_ROUTE_BINDINGS: readonly RunServiceRouteBinding[] = Object.freeze([
  Object.freeze({
    key: `POST ${RUN_SERVICE_START_ROUTE}`,
    // The op the composition dispatches through `invokeFunction` — the product's constant, not a
    // spelling of it. Corroborated on the wire by the ack contract, see `enumerateRunServiceOpIds`.
    opId: RUNS_START_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_EVENTS_TEMPLATE}`,
    // THE STREAM DISPATCHES NO REGISTRY OP, and that is a fact about the product rather than a gap
    // in this binding. `composeRunServicePorts` serves this route from `sessions.attach(runId)` —
    // the in-process bus of a run THIS door already started under a caller the gate already
    // adjudicated — where `POST /run` goes through `invokeFunction`. The registry does declare a
    // `runs.events` op; this route is not it, and binding it here would claim a dispatch that does
    // not happen. What the stream must not do is carry anything the envelope contract does not
    // admit, which is `run-service-anchors.test.ts`'s claim and not an enumeration's.
    ownsNoCapability:
      'the stream attaches to the bus of a run this door already started; it dispatches nothing',
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_LIVE_URL_TEMPLATE}`,
    // 403-03 (D-03, Q3): THE MINT, and unlike the stream one line up it genuinely DISPATCHES. The
    // composition calls `mintLiveUrlThrough` — the same function object the local dashboard door
    // calls — which goes through `invokeFunction` to `runs.liveurl` under a caller built from the
    // verified bearer's trust scope. Corroborated on the wire by `RunsLiveUrlResultSchema`, which
    // is that op's own declared result contract: a route re-pointed at a different op answers a
    // body this fold refuses.
    opId: RUNS_LIVE_URL_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_DETAIL_TEMPLATE}`,
    // 405-05 (D-12 / 402 D-16): the durable run-detail read, mounted behind the same authed door
    // as its local twin. It DISPATCHES — the arm calls `serveRunDetailRead`, the SAME function
    // object `routes.ts` calls, which goes through `invokeFunction` to `runs.detail` under a
    // caller built from the verified bearer's trust scope.
    opId: RUNS_DETAIL_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_ARTIFACT_TEMPLATE}`,
    // 405-05 (D-12 / 402 D-16): the ref-resolving read, on the row above's exact footing and
    // through the same shared adapter — `serveRunArtifact`, one function object, two doors.
    opId: RUNS_ARTIFACT_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_ANALYSIS_TEMPLATE}`,
    // 406-01 (D-04): the failure view's read, on the two rows above's exact footing and through
    // the same shared adapter — `serveRunAnalysisRead`, one function object, two doors.
    opId: ANALYSIS_GET_FUNCTION_ID,
  }),
  // 2026-09-15 (423-21, D-04/D-18): the typed evidence read and the two feedback reads, each
  // dispatched through the shared adapter the local door calls, masked on this door.
  Object.freeze({ key: `GET ${RUN_SERVICE_EVIDENCE_TEMPLATE}`, opId: RUNS_EVIDENCE_FUNCTION_ID }),
  Object.freeze({ key: `GET ${RUN_SERVICE_MARKS_TEMPLATE}`, opId: RUNS_MARKS_HISTORY_FUNCTION_ID }),
  Object.freeze({ key: `POST ${RUN_SERVICE_MARK_PREVIEW_TEMPLATE}`, opId: RUNS_MARK_PREVIEW_FUNCTION_ID }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_OK_ROUTE}`,
    // Readiness reports four facts this process measures about itself. It owns no capability, on the
    // same reasoning 398 D-02 used to keep the capability catalogue off the roster entirely.
    ownsNoCapability: 'readiness answers measured facts about this process and invokes nothing',
  }),
] as const)

/**
 * Fold the routes a door ANSWERED into op ids — PURE, TOTAL and SYNCHRONOUS.
 *
 * Split out from the drive for the reason every fold in this file is: the stray branches are the
 * shapes 397-09's mutation plants, and a branch reachable only by mutating a shipped file is a
 * branch nobody exercises. Every input arrives as an argument — the answered routes, the published
 * table, the bindings and the census — so this function's own idea of the door is empty.
 *
 * THREE NAMED REDS, and each is a different defect. An answered route with no binding is the door
 * widened without this suite seeing it. A binding whose route the table no longer publishes is this
 * file certifying a door that is gone. A bound op id absent from the census is the uncatalogued
 * capability every other row already reports.
 *
 * A STRAY IS COUNTED INTO `opIds` AS WELL AS REPORTED, on `chatEnumerationOf`'s own reasoning:
 * the reverse completeness leg is a subset claim, and a stray excluded from the set it belongs to
 * would leave that leg unable to fire on the very defect it exists for.
 */
export function runServiceEnumerationOf(
  answeredRouteKeys: readonly string[],
  publishedRouteKeys: readonly string[],
  bindings: readonly RunServiceRouteBinding[],
  registryOpIdSet: ReadonlySet<string>,
): SurfaceEnumeration {
  const opIds = new Set<string>()
  const strays: SurfaceStray[] = []
  const boundKeys = new Set(bindings.map((binding) => binding.key))
  const published = new Set(publishedRouteKeys)
  const answered = new Set(answeredRouteKeys)

  for (const key of answered) {
    if (!boundKeys.has(key)) {
      strays.push({ kind: 'run-service-unbound-route', name: key })
    }
  }
  for (const key of published) {
    if (!answered.has(key)) {
      strays.push({ kind: 'run-service-unanswered-route', name: key })
    }
  }
  for (const binding of bindings) {
    if (!published.has(binding.key)) {
      strays.push({ kind: 'run-service-stale-binding', name: binding.key })
      continue
    }
    if (!('opId' in binding)) continue
    // COUNTED ONLY WHEN THE ROUTE ANSWERED. An `opIds` populated straight from the declared binding
    // would be the table-against-itself shape this file's header refuses: a door that had stopped
    // serving every route would enumerate exactly what a working one does, and the roster leg that
    // reds on a surface enumerating nothing could never fire on this row. The unanswered route is
    // already reported above; this is what stops it from being reported and then ignored.
    if (!answered.has(binding.key)) continue
    opIds.add(binding.opId)
    if (!registryOpIdSet.has(binding.opId)) {
      strays.push({ kind: 'run-service-bound-op', name: binding.opId })
    }
  }
  return { opIds, strays }
}

/** A route driven against the door, as the enumeration reads it. */
export interface RunServiceRouteProbe {
  readonly key: string
  readonly status: number
  /** The parsed body, when the answer was JSON. SSE answers report `undefined`. */
  readonly body: unknown
  readonly contentType: string | null
}

/**
 * Stand the shipped run service up on an ephemeral port and hand its origin to one body.
 *
 * THE PRODUCTION COMPOSITION, over real TCP — `startServer` with `runService` from
 * `composeRunServicePorts` over a host from `composeDashboardDoor` and a run door from
 * `createDashboardRunDoor`, which is exactly what `agent-qa dashboard` assembles. What is replaced
 * is nothing at all; what this fixture chooses is a port number and a temp project.
 *
 * IT IS DELIBERATELY NOT `createRunServiceRoutes` MOUNTED ON A BARE SERVER. 402-01's e2e header
 * names that shortcut and refuses it: the verdict standing between a socket and a run, the ordering
 * against the host's wildcard preflight and its SPA fallback are process-level facts, and a router
 * mounted by hand measures none of them.
 *
 * MODEL-FREE by omission, which is the shipped headless posture rather than a stub: no `chatModel`
 * is supplied, so nothing here can reach a provider on a machine that has a credential exported.
 *
 * The server, the host, the composition and the workspace are all torn down in a `finally`.
 */
export async function withRunServiceDoor<Answer>(
  body: (origin: string) => Promise<Answer>,
): Promise<Answer> {
  const fixture = runServiceFixtureProject('adapter')
  const configDir = dirname(resolve(fixture.configPath))
  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined
  // 403-03 (D-14, Q3): THE REGISTRY IS HOISTED AND THE LIVE VIEW COMPOSED, exactly as
  // `agent-qa dashboard` does it. `GET /run/:runId/live-url` dispatches `runs.liveurl`, which
  // reads the run's declared stream capability out of the session registry and needs a served
  // origin to build a link against — so a fixture that composed neither would answer 503
  // `live_view_unavailable` and the route-table enumeration would report an unanswered route.
  // Composing the SHIPPED composers rather than a stand-in is this module's whole rule.
  const sessions = createRunServiceSessionRegistry({ observeSessions: runDoor.observeSessions })
  const liveView = composeLiveView({ sessions, origin: () => boundOrigin })
  // 405-05 (D-12 / 402 D-16): THE PROJECTION READER, bound over the same handle the ingest writes
  // through — exactly as `agent-qa dashboard` binds it. Without it `GET /run/:runId/detail` would
  // answer 503 `agent_host_unavailable`, which is a fact about a composition that forgot a port
  // rather than about the door this file is enumerating.
  const { createDashboardRunDetailReader } = await import('@vostride/agent-qa-dashboard')
  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot: join(configDir, '.agent-qa'),
    configPath: fixture.configPath,
    boundOrigin: () => boundOrigin,
    liveView: liveView.liveView,
    runDetail: createDashboardRunDetailReader(db),
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(host)
  // 432-21 (D-12): tokenless — no declared entries and no environment to read.
  const runService = composeRunServicePorts({
    door: runDoor,
    sessions,
    // 405-05: the SAME host the local door serves through, as `agent-qa dashboard` hands it.
    agentHost,
  })
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath: fixture.configPath,
    agentHost,
    executionBackend: runDoor.backend,
    runService: runService.ports,
    runServiceReadiness: runService.readiness,
  })
  try {
    const address = (started.server as { address(): unknown }).address()
    if (address === null || typeof address !== 'object' || !('port' in address)) {
      throw new TypeError('the run service bound no port')
    }
    boundOrigin = `http://127.0.0.1:${String((address as { port: number }).port)}`
    return await body(boundOrigin)
  } finally {
    started.close()
    runService.dispose()
    // The hoisted registry is this fixture's to dispose — `composeRunServicePorts` leaves a
    // registry it did not build alone.
    sessions.dispose()
    await host.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
}

/**
 * What the run-service door reaches, produced by DRIVING every route the shipped table publishes.
 *
 * EVERY ROW IS DRIVEN, IN THE TABLE'S OWN ORDER, and the run id the stream row needs comes off the
 * start row's own answer — so the two are one conversation with the door rather than two probes that
 * happen to agree. A route that answered `unknown_route` counts as NOT answered, which is the
 * door's own word for a path it does not serve.
 *
 * THE ACK IS PARSED, NOT INSPECTED. `RunStartAcknowledgementSchema.parse` is the corroboration this
 * module's header promises: the start route is bound to `runs.start` in the declared table, and the
 * body it answered has to satisfy `runs.start`'s own result contract or the route is not counted as
 * answered at all.
 *
 * A DOOR THAT ANSWERED NOTHING PARSEABLE yields an empty answered set rather than a throw, on
 * `enumerateFnOpIds`'s reasoning: the roster leg already asserts no surface enumerates
 * nothing, by name, and a throw here would report the same fact in a voice that does not say which
 * surface it was about.
 */
export async function enumerateRunServiceOpIds(): Promise<SurfaceEnumeration> {
  const publishedKeys = RUN_SERVICE_ROUTE_TABLE.map((row) => runServiceRouteKey(row))
  const answered = await withRunServiceDoor(async (origin) => {
    // 432-21 (D-12): the door asks for no credential.
    const bearer: Record<string, string> = {}
    const keys: string[] = []
    let runId: string | undefined

    const started = await fetch(`${origin}${RUN_SERVICE_START_ROUTE}`, {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ patterns: ['tests/probe.test.yaml'] }),
    })
    if (started.status === 202) {
      try {
        const ack = RunStartAcknowledgementSchema.parse(await started.json())
        runId = ack.runId
        keys.push(`POST ${RUN_SERVICE_START_ROUTE}`)
      } catch {
        // A 202 whose body the ack contract refuses is a route answering something other than the
        // capability it is bound to. Left unanswered, so the fold reports the binding as unproduced.
      }
    }

    if (runId !== undefined) {
      const stream = await fetch(
        `${origin}/run/${encodeURIComponent(runId)}/events`,
        { headers: bearer },
      )
      if ((stream.headers.get('content-type') ?? '').includes('text/event-stream')) {
        keys.push(`GET ${RUN_SERVICE_EVENTS_TEMPLATE}`)
      }
      // Read nothing and release the socket: what this enumeration asks of the stream is that the
      // door OPENS it. What the frames carry is `run-service-anchors.test.ts`'s question, asked
      // over the wire against the shipped binary rather than against this composition.
      await stream.body?.cancel().catch(() => undefined)
    }

    if (runId !== undefined) {
      // 403-03 (D-03, Q3): THE MINT, DRIVEN. The fixture's planted run may already be over and it
      // has no browser either way, so `stream.kind` is the honest `none` — the route answering at
      // all, with a body the op's own result contract accepts, is what this enumeration asks.
      const minted = await fetch(
        `${origin}/run/${encodeURIComponent(runId)}/live-url`,
        { headers: bearer },
      )
      if (minted.status === 200) {
        try {
          RunsLiveUrlResultSchema.parse(await minted.json())
          keys.push(`GET ${RUN_SERVICE_LIVE_URL_TEMPLATE}`)
        } catch {
          // Same reasoning as the ack: a 200 whose body the result contract refuses is a route
          // answering something other than the capability it is bound to.
        }
      }
    }

    if (runId !== undefined) {
      // 405-05 (D-12 / 402 D-16): THE TWO READ ROWS, DRIVEN.
      //
      // WHAT COUNTS AS ANSWERED HERE, AND WHY IT IS NOT A 200. These two rows read DURABLE state
      // about a run the fixture only just started, so whether a projection or a blob exists yet is
      // a race this enumeration has no business winning. What is NOT a race is which vocabulary the
      // door answers in: `unknown_run` and `blob_absent` are `runs.detail`'s and `runs.artifact`'s
      // OWN refusals, minted inside the ops and classified by the shared adapters — so a body
      // carrying one is proof the verdict passed, the pattern matched, the id decoded and the op
      // ran. 503 `agent_host_unavailable` is deliberately NOT accepted: that is the door reached
      // and the capability absent, which is the very state a route enumeration must not launder.
      const detailWords = new Set(['unknown_run'])
      const artifactWords = new Set(['unknown_run', 'blob_absent'])
      const detail = await fetch(
        `${origin}/run/${encodeURIComponent(runId)}/detail`,
        { headers: bearer },
      )
      if (detail.status === 200) {
        keys.push(`GET ${RUN_SERVICE_DETAIL_TEMPLATE}`)
      } else if (detail.status === 404) {
        const body = await detail.json().catch(() => undefined) as { error?: string } | undefined
        if (body !== undefined && detailWords.has(body.error ?? '')) {
          keys.push(`GET ${RUN_SERVICE_DETAIL_TEMPLATE}`)
        }
      }

      // 406-01 (D-04): THE ANALYSIS ROW, on the detail row's exact footing. `unknown_run` is
      // `analysis.get`'s own refusal, minted inside the op through `runs.get`, so a body carrying
      // it proves this row reached the capability rather than merely the door.
      const analysis = await fetch(
        `${origin}/run/${encodeURIComponent(runId)}/analysis`,
        { headers: bearer },
      )
      if (analysis.status === 200) {
        keys.push(`GET ${RUN_SERVICE_ANALYSIS_TEMPLATE}`)
      } else if (analysis.status === 404) {
        const body = await analysis.json().catch(() => undefined) as { error?: string } | undefined
        if (body !== undefined && detailWords.has(body.error ?? '')) {
          keys.push(`GET ${RUN_SERVICE_ANALYSIS_TEMPLATE}`)
        }
      }

      // A well-formed content address the store has certainly never written: 64 lowercase hex, so
      // the CONTRACT admits it and the answer comes from the op rather than from the schema.
      const artifact = await fetch(
        `${origin}/run/${encodeURIComponent(runId)}/artifacts/${'a'.repeat(64)}`,
        { headers: bearer },
      )
      if (artifact.status === 404) {
        const body = await artifact.json().catch(() => undefined) as { error?: string } | undefined
        if (body !== undefined && artifactWords.has(body.error ?? '')) {
          keys.push(`GET ${RUN_SERVICE_ARTIFACT_TEMPLATE}`)
        }
      }
    }

    if (runId !== undefined) {
      // 423-21 (D-04/D-18): the evidence and feedback read rows, DRIVEN. Each counts as answered on
      // the op's own vocabulary: a body its result contract parses, or the evidence read's own
      // `unknown_run` refusal for a run whose projection has not landed yet. 503 is never accepted.
      const run = encodeURIComponent(runId)
      const evidence = await fetch(`${origin}/run/${run}/evidence?kind=console&testIndex=0&stepIndex=0`,
        { headers: bearer })
      if (evidence.status === 200) {
        if (RunsEvidenceResultSchema.safeParse(await evidence.json()).success) {
          keys.push(`GET ${RUN_SERVICE_EVIDENCE_TEMPLATE}`)
        }
      } else if (evidence.status === 404) {
        const body = await evidence.json().catch(() => undefined) as { error?: string } | undefined
        if (body?.error === 'unknown_run') keys.push(`GET ${RUN_SERVICE_EVIDENCE_TEMPLATE}`)
      }
      const marks = await fetch(`${origin}/run/${run}/marks`, { headers: bearer })
      if (marks.status === 200 && RunsMarksHistoryResultSchema.safeParse(await marks.json()).success) {
        keys.push(`GET ${RUN_SERVICE_MARKS_TEMPLATE}`)
      }
      const preview = await fetch(`${origin}/run/${run}/mark-preview`, {
        method: 'POST',
        headers: { ...bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, kind: 'confirmed-bug' }),
      })
      if (preview.status === 200 && RunsMarkPreviewResultSchema.safeParse(await preview.json()).success) {
        keys.push(`POST ${RUN_SERVICE_MARK_PREVIEW_TEMPLATE}`)
      }
    }

    const ok = await fetch(`${origin}${RUN_SERVICE_OK_ROUTE}`, { headers: bearer })
    if (ok.status === 200) {
      try {
        RunServiceReadinessSchema.parse(await ok.json())
        keys.push(`GET ${RUN_SERVICE_OK_ROUTE}`)
      } catch {
        // Same reasoning as the ack: a readiness answer the contract refuses is not this route.
      }
    }
    return keys
  })
  return runServiceEnumerationOf(
    answered,
    publishedKeys,
    RUN_SERVICE_ROUTE_BINDINGS,
    new Set(registryOpIds()),
  )
}

export const runServiceSurfaceAdapter: SurfaceAdapter = Object.freeze({
  id: 'run-service',
  enumerateOpIds: () => enumerateRunServiceOpIds(),
  /**
   * WHAT THIS DOOR CANNOT DO, DECLARED (D-04) — and every member is a property of the door today.
   *
   * The list is derived from nothing: it is written, reviewed, and readable beside
   * `RUN_SERVICE_ROUTE_TABLE`, which publishes seven routes and no eighth. A reader can check every
   * line of it against that table in one screen, which is the whole reason the door's routes are
   * exported data.
   */
  notApplicable: Object.freeze([
    Object.freeze({
      capability: 'conversation — the chat surfaces\' whole vocabulary (agent.ask and its session)',
      why: 'this door publishes no conversational route and mints no session; its caller holds the '
        + 'single scope `run`, so an ask would be refused at the caller band even if one existed',
    }),
    Object.freeze({
      capability: 'authoring and configuration writes (config.field.set, authoring.draft.*)',
      why: '`runServiceCallerFor` grants a LITERAL [\'run\', \'read\'] rather than a spread of the '
        + 'CLI\'s, so no scope a later phase mints reaches this door by default and no write op is '
        + 'in reach',
    }),
    Object.freeze({
      capability: 'every OTHER read op the registry declares (runs.get, runs.list, knowledge.*, …)',
      // 403-03: the grant gained `read` so the mint can dispatch, and the honest statement of what
      // still bounds this door is the ROUTE TABLE rather than the scope list. A scope is not a
      // route. 405-05 added the two run-shaped reads and 406-01 the analysis read, so the count is
      // seven paths of which five dispatch — and every one of the five is a row a reader can point
      // at, which is the property this entry exists to keep true.
      // 423-21: the evidence read and the two feedback reads joined, so ten paths of which eight
      // dispatch — still every one of them a row a reader can point at.
      why: 'the route table publishes ten paths and only eight of them dispatch — runs.start, '
        + 'runs.liveurl, runs.detail, runs.artifact, analysis.get, runs.evidence, '
        + 'runs.marks.history and runs.mark.preview; a remote caller addresses one run it '
        + 'started, reads its events, its detail, its artifacts, its evidence, its analysis and '
        + 'its marks, previews a mark on it and mints a view link for it, and nothing else. No '
        + 'route reaches any other read',
    }),
    Object.freeze({
      capability: 'run cancellation',
      why: 'deferred by 402-01 and recorded in the run-service module header — there is no route, '
        + 'so a cancel is unreachable rather than unimplemented',
    }),
  ]),
})
