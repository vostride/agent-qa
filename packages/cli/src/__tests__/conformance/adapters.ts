// Every enumeration is read off a real surface; a hand-written listing compares a table to itself.

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
    // A route the run-service door answers that no binding below covers.
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

// Declared, so a narrow door is told apart from a door that lost reach in a regression.
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

// The registry reads no scopes and no safe mode, so a census under this caller is the catalogue.
export const CONFORMANCE_CENSUS_CALLER: FunctionCaller = Object.freeze({
  surface: 'conformance',
  origin: 'human',
})

// With empty deps an invocation past the gate reaches no port, so no cell here has an effect.
export function conformanceRegistry(): FunctionRegistry {
  return createFunctionRegistry({
    deps: {} as unknown as FunctionDeps,
  })
}

/** The census, as declarations. */
export function registryDeclarations(): readonly FunctionDeclaration[] {
  return conformanceRegistry().list(CONFORMANCE_CENSUS_CALLER)
}

// The census as ids; the public enumeration is `list(caller)`, so that caller is exported too.
export function registryOpIds(): readonly string[] {
  return registryDeclarations().map((declaration) => declaration.id)
}

// ---- The MCP side ------------------------------------------------------------------------------

/** What a fold expansion produced, and what it could not expand. */
export interface McpFoldExpansion {
  readonly opIds: ReadonlySet<string>
  // Listed tool names the declared mapping does not know: an uncatalogued capability.
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

// The identity `maskText` fits: these reads ask which tools exist, not what their text says.
export async function withMcpClient<Answer>(
  body: (client: Client) => Promise<Answer>,
  caller: FunctionCaller = MCP_FUNCTION_CALLER,
): Promise<Answer> {
  const handler = createMcpHandler(() =>
    buildAgentQaMcpServer({
      registry: conformanceRegistry(),
      caller,
      maskText: (text: string) => text,
    }),
  )
  const client = new Client({ name: 'agent-qa-conformance', version: '0.0.0' })
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

export async function listMcpToolNames(caller?: FunctionCaller): Promise<readonly string[]> {
  return withMcpClient(async (client) => {
    const listed = await client.listTools()
    return listed.tools.map((tool) => tool.name)
  }, caller)
}

// The shipped prefix plus the op id is the spelling a caller would try first.
export function plausibleMcpToolSpelling(opId: string): string {
  return `agent_qa_${opId.replace(/\./g, '_')}`
}

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
  // Alias targets naming nothing the registry declares: an uncatalogued capability.
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

// ---- The fn side ----------------------------------------

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
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-fn-'))
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

// Driven through the command: a set built from the registry the door lists would shrink with it.
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

// The run-service door publishes no listing, so its reach is the routes it answers, bound to ops.

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

// Set-equal with the shipped route table both ways, so a route added without a binding reds.
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
    // `RunsLiveUrlResultSchema` corroborates: a route re-pointed at another op answers a bad body.
    opId: RUNS_LIVE_URL_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_DETAIL_TEMPLATE}`,
    // Dispatches through `serveRunDetailRead`, the same function the local door's routes call.
    opId: RUNS_DETAIL_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_ARTIFACT_TEMPLATE}`,
    // Through `serveRunArtifact`, the same function the local door calls.
    opId: RUNS_ARTIFACT_FUNCTION_ID,
  }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_ANALYSIS_TEMPLATE}`,
    // Through `serveRunAnalysisRead`, the same function the local door calls.
    opId: ANALYSIS_GET_FUNCTION_ID,
  }),
  // Each dispatched through the shared adapter the local door calls, masked on this door.
  Object.freeze({ key: `GET ${RUN_SERVICE_EVIDENCE_TEMPLATE}`, opId: RUNS_EVIDENCE_FUNCTION_ID }),
  Object.freeze({ key: `GET ${RUN_SERVICE_MARKS_TEMPLATE}`, opId: RUNS_MARKS_HISTORY_FUNCTION_ID }),
  Object.freeze({ key: `POST ${RUN_SERVICE_MARK_PREVIEW_TEMPLATE}`, opId: RUNS_MARK_PREVIEW_FUNCTION_ID }),
  Object.freeze({
    key: `GET ${RUN_SERVICE_OK_ROUTE}`,
    ownsNoCapability: 'readiness answers measured facts about this process and invokes nothing',
  }),
] as const)

// A stray is counted into `opIds` too, or the subset leg could not fire on the defect it is for.
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

// The production composition on real TCP: preflight ordering and SPA fallback are process-level.
export async function withRunServiceDoor<Answer>(
  body: (origin: string) => Promise<Answer>,
): Promise<Answer> {
  const fixture = runServiceFixtureProject('adapter')
  const configDir = dirname(resolve(fixture.configPath))
  const { DashboardDatabase, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined
  // Without the hoisted registry and live view, `runs.liveurl` answers 503 and reads unanswered.
  const sessions = createRunServiceSessionRegistry({ observeSessions: runDoor.observeSessions })
  const liveView = composeLiveView({ sessions, origin: () => boundOrigin })
  // Without the reader, `GET /run/:runId/detail` answers 503 `agent_host_unavailable`.
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
  const runService = composeRunServicePorts({
    door: runDoor,
    sessions,
    // The same host the local door serves through, as `agent-qa dashboard` hands it.
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
    // The door asks for no credential.
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
      // The planted run has no browser, so `stream.kind` is `none`; this asks only that it answers.
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
      // `unknown_run` and `blob_absent` are the ops' own refusals, so they prove the op ran.
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

      // `unknown_run` is `analysis.get`'s own refusal, so it proves the row reached the capability.
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
      // Answered means a body the op's result contract parses, or its own `unknown_run`; never 503.
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
  // Written, not derived: each member can be checked against `RUN_SERVICE_ROUTE_TABLE` at a glance.
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
      why: 'the route table publishes ten paths and only eight of them dispatch — runs.start, '
        + 'runs.liveurl, runs.detail, runs.artifact, analysis.get, runs.evidence, '
        + 'runs.marks.history and runs.mark.preview; a remote caller addresses one run it '
        + 'started, reads its events, its detail, its artifacts, its evidence, its analysis and '
        + 'its marks, previews a mark on it and mints a view link for it, and nothing else. No '
        + 'route reaches any other read',
    }),
    Object.freeze({
      capability: 'run cancellation',
      why: 'deferred, as the run-service module header records — there is no route, '
        + 'so a cancel is unreachable rather than unimplemented',
    }),
  ]),
})
