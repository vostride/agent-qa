// The parity suite's one denominator: typed rows, census-equal to `registry.ids()` both ways.

import {
  AgentAskInputSchema,
  AnalysisGetInputSchema,
  AuthoringDraftEditInputSchema,
  AuthoringDraftWriteInputSchema,
  AuthoringFunnelGetInputSchema,
  AuthoringVerifyDraftInputSchema,
  BriefWhyInputSchema,
  ConfigAuthSetInputSchema,
  ConfigFieldSetInputSchema,
  ConfigGetInputSchema,
  ConfigHookAddInputSchema,
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
  ConfigTargetEditInputSchema,
  EditorLiveUrlInputSchema,
  ENTITY_DASHBOARD_ROUTES,
  ENTITY_KINDS,
  EntitiesGetInputSchema,
  EntitiesResolveInputSchema,
  ExplainInputSchema,
  KnowledgeAcceptChangeInputSchema,
  KnowledgeBundlesListInputSchema,
  KnowledgeGatesListInputSchema,
  KnowledgeForgetChangeInputSchema,
  KnowledgeRecordShowInputSchema,
  KnowledgeRecordsDiffInputSchema,
  KnowledgeRecordsInspectInputSchema,
  KnowledgeRejectChangeInputSchema,
  QuarantineAddInputSchema,
  QuarantineListInputSchema,
  QuarantineReleaseInputSchema,
  RunsArtifactInputSchema,
  RunsDetailInputSchema,
  RunsDigestInputSchema,
  RunsEventsInputSchema,
  RunsEvidenceInputSchema,
  RunsKnowledgeInputSchema,
  RunsLiveUrlInputSchema,
  RunsGetInputSchema,
  RunsListInputSchema,
  RunsMarkInputSchema,
  RunsMarksHistoryInputSchema,
  RunsOverviewInputSchema,
  RunsPostProcessingInputSchema,
  RunsStartInputSchema,
} from '@vostride/agent-qa-schema'
import type { EntityDashboardRouteGrain, EntityKind } from '@vostride/agent-qa-schema'
import type { z } from 'zod'

/**
 * Each op's LIVE input contract, keyed by op id.
 *
 * THE SAME OBJECTS, NOT COPIES. Every value here is the exact schema singleton the op's spec passes
 * to `FunctionSpec.input`, imported from the one module the ops import it from — the identical move
 * `mapping.ts` makes for the 22 ops it projects, and for the identical reason: a re-derived contract
 * is a second contract, free to disagree with the one dispatch enforces, and the disagreement would
 * be invisible because nothing would compare the two.
 *
 * It is a GROWTH SEAM in the `INVOCATION_SAMPLES` / `CONTRACTS_BY_ID` tradition: `parity.test.ts`
 * asserts its keys set-equal to the registry census in both directions, so a capability cannot land
 * without someone stating the contract its scenario is typed against.
 */
export const OP_INPUT_CONTRACTS = {
  'agent.ask': AgentAskInputSchema,
  'agent.explain': ExplainInputSchema,
  'analysis.get': AnalysisGetInputSchema,
  'authoring.draft.edit': AuthoringDraftEditInputSchema,
  'authoring.draft.verify': AuthoringVerifyDraftInputSchema,
  'authoring.draft.write': AuthoringDraftWriteInputSchema,
  'authoring.funnel.get': AuthoringFunnelGetInputSchema,
  'config.auth.set': ConfigAuthSetInputSchema,
  'config.field.set': ConfigFieldSetInputSchema,
  'config.get': ConfigGetInputSchema,
  'config.hook.add': ConfigHookAddInputSchema,
  'config.project.scaffold': ConfigProjectScaffoldInputSchema,
  'config.target.create': ConfigTargetCreateInputSchema,
  'config.target.edit': ConfigTargetEditInputSchema,
  // The editor subject's mint.
  'editor.liveurl': EditorLiveUrlInputSchema,
  'entities.get': EntitiesGetInputSchema,
  'entities.resolve': EntitiesResolveInputSchema,
  'knowledge.accept': KnowledgeAcceptChangeInputSchema,
  'knowledge.brief.why': BriefWhyInputSchema,
  'knowledge.bundles.list': KnowledgeBundlesListInputSchema,
  'knowledge.gates.list': KnowledgeGatesListInputSchema,
  'knowledge.forget': KnowledgeForgetChangeInputSchema,
  'knowledge.record.show': KnowledgeRecordShowInputSchema,
  'knowledge.records.diff': KnowledgeRecordsDiffInputSchema,
  'knowledge.records.inspect': KnowledgeRecordsInspectInputSchema,
  'knowledge.reject': KnowledgeRejectChangeInputSchema,
  'quarantine.add': QuarantineAddInputSchema,
  'quarantine.list': QuarantineListInputSchema,
  'quarantine.release': QuarantineReleaseInputSchema,
  'runs.artifact': RunsArtifactInputSchema,
  'runs.detail': RunsDetailInputSchema,
  'runs.digest': RunsDigestInputSchema,
  'runs.events': RunsEventsInputSchema,
  // The preview validates with `runs.mark`'s exact input singleton and adds no schema of its own.
  'runs.evidence': RunsEvidenceInputSchema,
  'runs.knowledge': RunsKnowledgeInputSchema,
  'runs.liveurl': RunsLiveUrlInputSchema,
  'runs.get': RunsGetInputSchema,
  'runs.list': RunsListInputSchema,
  'runs.mark': RunsMarkInputSchema,
  'runs.mark.preview': RunsMarkInputSchema,
  'runs.marks.history': RunsMarksHistoryInputSchema,
  // The run overview, the agent's map of one completed run.
  'runs.overview': RunsOverviewInputSchema,
  'runs.postprocessing': RunsPostProcessingInputSchema,
  'runs.start': RunsStartInputSchema,
} as const

/** Every op id the table knows how to type — the compile-time half of the census. */
export type ScenarioOpId = keyof typeof OP_INPUT_CONTRACTS

/** The wire shape a caller SENDS for one op — `z.input`, matching the projection's `io: 'input'`. */
export type ScenarioInput<Id extends ScenarioOpId> = z.input<(typeof OP_INPUT_CONTRACTS)[Id]>

// ---- The MCP partition, as row data joined to `mapping.ts` both ways ---------------------

// The row cites a class, and `parity.test.ts` derives the class from the shipped prose to compare.
export type UnprojectedReasonKey =
  | 'agent-ask-delegation-deferral'
  // `agent.explain`'s question is one the protocol already answers for machines.
  | 'discovery-answered-by-protocol'
  // `runs.liveurl` hands out a credential, which is why it has no MCP door.
  | 'credential-mint-deferral'
  | 'not-mid-flight-write'
  | 'not-mid-flight-read'

// In precedence order, highest first: an overlapping reason takes the stronger class.
export const UNPROJECTED_REASON_SIGNATURES: readonly (readonly [UnprojectedReasonKey, string])[] =
  Object.freeze([
    Object.freeze(['agent-ask-delegation-deferral', 'nested-agent delegation'] as const),
    // Above the mid-flight lines: a question the protocol answers is the stronger fact.
    Object.freeze(['discovery-answered-by-protocol', 'answers machine discovery'] as const),
    // Above the mid-flight lines: a credential mint is a stronger fact than a scoping line.
    Object.freeze(['credential-mint-deferral', 'MINTS A CREDENTIAL'] as const),
    Object.freeze(['not-mid-flight-write', 'mid-flight workflow write'] as const),
    Object.freeze(['not-mid-flight-read', 'mid-flight workflow read'] as const),
  ])

/**
 * The class a shipped `UNPROJECTED_OPS` reason falls into, or `undefined` if it falls into none.
 *
 * PURE AND TOTAL, so `parity.test.ts` can drive it with synthetic prose in a control cell. The
 * `undefined` branch is not a defensive nicety: a new unprojected op written with a reason outside
 * this vocabulary must RED rather than be silently filed under whichever class happened to be last,
 * because "we scoped this out" and "this can never work here" are the two answers a reader needs to
 * be able to tell apart.
 */
export function unprojectedReasonKeyOf(reason: string): UnprojectedReasonKey | undefined {
  for (const [key, signature] of UNPROJECTED_REASON_SIGNATURES) {
    if (reason.includes(signature)) return key
  }
  return undefined
}

/** What one row claims about the MCP surface: a door, or a dated decision not to have one. */
export type McpSurfaceExpectation =
  | { readonly reachable: { readonly tool: string } }
  | { readonly unprojected: UnprojectedReasonKey }

// A boolean, so the join against the live chat enumeration can be said in both directions.
export interface ChatSurfaceExpectation {
  readonly reachable: boolean
}

// A boolean: `fn` has no projection or wire name, so reach is all a row claims.
export interface FnSurfaceExpectation {
  readonly reachable: boolean
}

// Markers are the op's required output fields, checked against its contract and the drop site.
export interface RenderExpectation {
  readonly markers: readonly [string, ...string[]]
}

// The route half is spread from the shipped `ENTITY_DASHBOARD_ROUTES`, not written here.
export interface EntityCardRenderCase {
  readonly kind: EntityKind
  /** The dashboard route TEMPLATE, or `null` — read off the shipped contract, never restated. */
  readonly dashboardRoute: string | null
  /** WHICH address fills the route's parameter — the grain a link is keyed by. */
  readonly routeKeyedBy: EntityDashboardRouteGrain
  /**
   * The card fields a reader must be able to read on EVERY door, for a card of this kind.
   *
   * Non-empty in the type on {@link RenderExpectation}'s reasoning: a case with nothing to look for
   * is a cell that passes on every build, including the one with no card render at all.
   */
  readonly markers: readonly [string, ...string[]]
}

/**
 * The card's ALWAYS-PRESENT contract fields, sorted — the same derived-then-reviewed rule
 * {@link RenderExpectation} states, applied to the card contract instead of to an op's output.
 *
 * `keyFacts` and `actions` are deliberately absent: they are arrays the contract lets a kind answer
 * with empty, so requiring them per kind would demand of one kind a thing the contract says it
 * need not have.
 */
const ENTITY_CARD_MARKERS = ['id', 'kind', 'status', 'title', 'uri'] as const

// Total over `EntityKind`: unrouted kinds carry a `url` and must still render no link.
function entityCardRenderCase(kind: EntityKind): EntityCardRenderCase {
  return Object.freeze({
    kind,
    dashboardRoute: ENTITY_DASHBOARD_ROUTES[kind].route,
    routeKeyedBy: ENTITY_DASHBOARD_ROUTES[kind].keyedBy,
    markers: ENTITY_CARD_MARKERS,
  })
}

// Named arms, not `Object.fromEntries`: the cast to a total record fails `tsc`.
export const ENTITY_CARD_RENDER_CASES: Readonly<Record<EntityKind, EntityCardRenderCase>> =
  Object.freeze({
    TST: entityCardRenderCase('TST'),
    RUN: entityCardRenderCase('RUN'),
    MEM: entityCardRenderCase('MEM'),
    POL: entityCardRenderCase('POL'),
    TGT: entityCardRenderCase('TGT'),
  })

/**
 * What one row claims about the ENTITY CARDS its op can answer with.
 *
 * The kinds are carried on the ROW rather than assumed, so the join is two-directional the way
 * every other census in this file is: a consumer asserts the row's kinds set-equal to
 * `ENTITY_CARD_RENDER_CASES`'s keys, and a kind that lost its case is a named RED rather than a
 * kind that quietly stopped being measured.
 */
export interface EntityCardRenderExpectation {
  readonly kinds: readonly [EntityKind, ...EntityKind[]]
}

/** Every kind an entity op can answer with — the complete vocabulary, not a chosen subset. */
const EVERY_ENTITY_CARD_KIND: EntityCardRenderExpectation = { kinds: ENTITY_KINDS }

// `refuse` reads `allow`: no scope is declared or read, so every caller is allowed alike.
export interface PolicyPointExpectations {
  readonly grant: 'allow'
  readonly refuse: 'allow'
}

/** One capability, as the suite drives it. */
export interface ScenarioRow<Id extends ScenarioOpId = ScenarioOpId> {
  readonly opId: Id
  /** A valid invocation fixture, typed against THIS op's contract at compile time. */
  readonly input: ScenarioInput<Id>
  readonly perSurface: {
    readonly chat: ChatSurfaceExpectation
    readonly mcp: McpSurfaceExpectation
    readonly fn: FnSurfaceExpectation
  }
  readonly policyPoints: PolicyPointExpectations
  /** What a person must be able to read after this op answers — see {@link RenderExpectation}. */
  readonly renderExpect: RenderExpectation
  // Present only on ops answering with an entity card; the set is checked against card-output ops.
  readonly entityCardExpect?: EntityCardRenderExpectation
}

// Binds `Id` from the `opId` literal, so a row's input checks against its own op's contract.
function scenario<Id extends ScenarioOpId>(row: ScenarioRow<Id>): ScenarioRow<Id> {
  return Object.freeze(row)
}

const FIXTURE_RUN_ID = 'run-alpha'
// 64 lowercase hex, because `RunsArtifactInputSchema` refuses anything else.
const FIXTURE_ARTIFACT_SHA = 'a'.repeat(64)
const FIXTURE_ENTITY_SHORT_ID = 'MEM-001'

/**
 * One row per registry op. Adding a capability adds a ROW — never a file and never a `describe`.
 *
 * The rows are sorted by op id so this file reads as an index and a diff adding one is one hunk.
 */
export const SCENARIO_TABLE = Object.freeze([
  // A non-empty message that resolves to nothing.
  scenario({
    opId: 'agent.ask',
    input: { message: 'nothing in this fixture can answer this' },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'agent-ask-delegation-deferral' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['receipts', 'results', 'sessionId', 'status', 'turnId'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // A real question these rows do not answer, so the honest outcome is the abstention arm.
  scenario({
    opId: 'agent.explain',
    input: { query: 'what can you do' },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'discovery-answered-by-protocol' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['citations', 'kind', 'renderedLines'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Validation precedes binding, so a sample failing its contract reports an input error.
  scenario({
    opId: 'analysis.get',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['clusters', 'runId', 'sentences', 'verdicts'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Both fields are required and the ref is an exact address, so free text never resolves.
  scenario({
    opId: 'authoring.draft.edit',
    input: {
      testRef: 'tests/nothing-in-this-fixture.yaml::Nothing In This Fixture',
      intent: 'nothing in this fixture can edit this',
    },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_refine_test' } },
      fn: { reachable: true },
    },
    // `written`: the edit lands in the file it edited, and says so.
    renderExpect: {
      markers: ['draftRef', 'editedFrom', 'patches', 'thoughts', 'written'],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // A well-formed path with the required extension that names nothing in any fixture.
  scenario({
    opId: 'authoring.draft.verify',
    input: { draftPath: 'tests/nothing-in-this-fixture.yaml' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_refine_test' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'addsValueFinding',
        'disposition',
        'draftRef',
        'evaluatedAt',
        'gateRuns',
        'gates',
        'schemaVersion',
        'stabilityRunsCompleted',
        'stabilityRunsRequested',
        'stepTable',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Non-empty intent and a well-formed scope are the contract's requirements.
  scenario({
    opId: 'authoring.draft.write',
    input: {
      intent: 'nothing in this fixture can author this',
      scope: { tier: 'product', key: 'nothing-in-this-fixture' },
    },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_write_test' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['fanOut', 'outcome'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The window is required; `all-time` needs no further field, fitting a fixture with no session.
  scenario({
    opId: 'authoring.funnel.get',
    input: { window: { scope: 'all-time' } },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'acceptanceFailure',
        'line',
        'sideCounters',
        'smallSample',
        'stages',
        'undercounted',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Parsing inputs for the config write half, on the reasoning every unbound row shares.
  scenario({
    opId: 'config.auth.set',
    input: { target: 'shop', pluginPackage: '@acme/auth' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'config.field.set',
    input: { path: 'use.timeout', value: '45s' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'config.get',
    input: {},
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['configPath', 'entries', 'schemaVersion'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'config.hook.add',
    input: { name: 'seed', runtime: 'node', file: 'scripts/seed.mjs' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Hostname-shaped: the gate runs first, and a non-hostname would make this a refusal sample.
  scenario({
    opId: 'config.project.scaffold',
    input: { domain: 'shop.example.com' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Parsing inputs on the reasoning of the rows above.
  scenario({
    opId: 'config.target.create',
    input: { name: 'shop', platform: 'web', url: 'https://shop.example.com' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'config.target.edit',
    input: { name: 'shop', changes: { url: 'https://shop.example.com/basket' } },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // The op writes in the call and answers the files and fields it changed.
      markers: [
        'crossBoundary',
        'crossBoundaryReasons',
        'fields',
        'files',
        'outcome',
        'shownDiff',
        'summaryLine',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // In sort position, which the render matrix's cell names follow; unprojected as a mint.
  scenario({
    opId: 'editor.liveurl',
    input: { sessionId: 'editor-session-1' },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'credential-mint-deferral' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['expiresAt', 'liveUrl', 'stream'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // `get` takes an exact address; the fixture entity directory stands behind it.
  scenario({
    opId: 'entities.get',
    input: { ref: FIXTURE_ENTITY_SHORT_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_entity' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['actions', 'id', 'keyFacts', 'kind', 'status', 'title', 'uri'] },
    entityCardExpect: EVERY_ENTITY_CARD_KIND,
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // `resolve` takes any reference, so unmatched free text gets an empty directory's none arm.
  scenario({
    opId: 'entities.resolve',
    input: { ref: 'nothing in this fixture is called this' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_entity' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['card', 'kind', 'score'] },
    entityCardExpect: EVERY_ENTITY_CARD_KIND,
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Valid inputs: `invokeFunction` validates before it consults the binding.
  scenario({
    opId: 'knowledge.accept',
    input: { target: { grain: 'record', recordId: 'rec-not-in-this-fixture' } },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_knowledge' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['operationId', 'outcome', 'recordIds', 'verb'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The fixture records no run, so the honest answer is the typed no-trace arm.
  scenario({
    opId: 'knowledge.brief.why',
    input: { runId: FIXTURE_RUN_ID, stepIndex: 0 },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_explain_brief' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['kind', 'trace'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'knowledge.bundles.list',
    input: {},
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_list_knowledge_bundles' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'bundleId',
        'counters',
        'dir',
        'evidenceIncomplete',
        'kind',
        'lastConfirmedOrdinal',
        'openedAtOrdinal',
        'product',
        'scope',
        'status',
        'summary',
        'trust',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'knowledge.forget',
    input: { target: { grain: 'bundle', shortId: FIXTURE_ENTITY_SHORT_ID } },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_knowledge' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['operationId', 'outcome', 'recordIds', 'verb'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    // Kept in lexicographic scenario order: forget precedes gates.
    opId: 'knowledge.gates.list',
    input: { recordId: 'rec-not-in-this-fixture' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_list_knowledge_gates' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['recordId', 'kind'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The record id names nothing in this fixture, so the typed miss is the correct answer.
  scenario({
    opId: 'knowledge.record.show',
    input: { recordId: 'rec-not-in-this-fixture' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_show_knowledge_record' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'body',
        'kind',
        'provenance',
        'record',
        'schemaVersion',
        'summary',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The diff baseline is 0: a first-ever diff.
  scenario({
    opId: 'knowledge.records.diff',
    input: { sinceOrdinal: 0 },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_diff_knowledge_records' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['changes', 'schemaVersion', 'sinceOrdinal'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The filter is closed and every member optional, so an empty filter is the everything query.
  scenario({
    opId: 'knowledge.records.inspect',
    input: { filter: {} },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_inspect_knowledge_records' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['records', 'schemaVersion'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'knowledge.reject',
    input: {
      target: { grain: 'record', recordId: 'rec-not-in-this-fixture' },
      reason: 'not reproducible',
    },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_knowledge' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['operationId', 'outcome', 'recordIds', 'verb'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The write verbs take every leg of stable test identity; a partial one is an input error.
  scenario({
    opId: 'quarantine.add',
    input: {
      product: 'shop',
      filePath: 'tests/checkout.test.yaml',
      testName: 'checkout completes',
    },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-write' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['entry', 'kind'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // `list` genuinely takes the empty query: enumeration is the verb.
  scenario({
    opId: 'quarantine.list',
    input: {},
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['entries'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'quarantine.release',
    input: {
      product: 'shop',
      filePath: 'tests/checkout.test.yaml',
      testName: 'checkout completes',
    },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-write' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['entry', 'kind'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Markers are the result's top-level keys, so a projection losing one reds rather than zeroing.
  scenario({
    opId: 'runs.artifact',
    input: { runId: FIXTURE_RUN_ID, sha: FIXTURE_ARTIFACT_SHA },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_evidence' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['bytesBase64', 'byteLength', 'contentType', 'runId', 'sha'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.detail',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['members', 'runId', 'steps', 'subActions', 'tokens'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.digest',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_digest' } },
      fn: { reachable: true },
    },
    // The digest carries the fixes a run's marks applied (`markChanges`), from the run's ledger.
    renderExpect: {
      markers: [
        'candidates',
        'chain',
        'lines',
        'quarantine',
        'runId',
        'verdictClusters',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The one stream op: a `tools/call` is one round trip and has no shape for a resumable feed.
  scenario({
    opId: 'runs.events',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['payload', 'runId', 'seq', 'ts', 'type'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Its markers are the ready arm's required keys: address, recorded entry, outcome and document.
  scenario({
    opId: 'runs.evidence',
    input: { runId: FIXTURE_RUN_ID, testIndex: 0, stepIndex: 0, kind: 'console' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_evidence' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['address', 'document', 'evidence', 'outcome'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.get',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'aggregateVerdict',
        'buildOrdinal',
        'configDigests',
        'endedAt',
        'executionContext',
        'runId',
        'scope',
        'startedAt',
        'tests',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Markers name the `evidence-incomplete` arm, because the fixture records no run under that id.
  scenario({
    opId: 'runs.knowledge',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_knowledge' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['kind', 'runId'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.list',
    input: {},
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_list_runs' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'aggregateVerdict',
        'buildOrdinal',
        'endedAt',
        'executionContext',
        'runId',
        'scope',
        'startedAt',
        'testCount',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // A parsing input; the op hands out a credential, so it stays unprojected.
  scenario({
    opId: 'runs.liveurl',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'credential-mint-deferral' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['expiresAt', 'handle', 'liveUrl', 'stream'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.mark',
    input: { runId: FIXTURE_RUN_ID, kind: 'confirmed-bug' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_mark_run' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['receipt', 'kind'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The consequence preview: runs.mark's exact input, answered read-tier with the postprocessing
  // row's policy points. Its markers are the consequences arm's required keys.
  scenario({
    opId: 'runs.mark.preview',
    input: { runId: FIXTURE_RUN_ID, kind: 'confirmed-bug' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_preview_run_mark' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'basis',
        'draft',
        'kind',
        'knowledge',
        'latest',
        'markKind',
        'member',
        'prospective',
        'resolvedStep',
        'runId',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Marks history, a read tool with read policy points.
  scenario({
    opId: 'runs.marks.history',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_marks' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['entries', 'kind', 'runId'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // The overview, projected as agent_qa_get_run_overview, with read policy points. The fixture
  // records no run under `FIXTURE_RUN_ID`, so every door refuses it as a missing run; the populated
  // answer is measured in `discovery-reads-door-parity.test.ts`. Markers are the projection's
  // required fields.
  scenario({
    opId: 'runs.overview',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_get_run_overview' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'aggregateVerdict',
        'buildOrdinal',
        'endedAt',
        'learned',
        'recordedTargets',
        'runId',
        'scope',
        'startedAt',
        'tests',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  scenario({
    opId: 'runs.postprocessing',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      mcp: { unprojected: 'not-mid-flight-read' },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['chips', 'runId'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // Every field is optional, so the empty object is the whole input.
  scenario({
    opId: 'runs.start',
    input: {},
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_start_run' } },
      fn: { reachable: true },
    },
    renderExpect: {
      markers: [
        'buildOrdinal',
        'executionContext',
        'runId',
        'scope',
        'startedAt',
        'testCount',
      ],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
] as const)

/**
 * COMPILE-TIME completeness: every id `OP_INPUT_CONTRACTS` types must carry a row.
 *
 * The runtime census leg in `parity.test.ts` is the one that ranges the REGISTRY, and it is the
 * load-bearing one. This is the cheaper inner check: it fails `tsc` — naming the missing ids in the
 * error — the moment a contract is paired without a scenario, so the two halves of this file cannot
 * fall out of step even before a test runs.
 */
type UncoveredOpId = Exclude<ScenarioOpId, (typeof SCENARIO_TABLE)[number]['opId']>
const EVERY_TYPED_OP_HAS_A_ROW: [UncoveredOpId] extends [never] ? true : UncoveredOpId = true
void EVERY_TYPED_OP_HAS_A_ROW

/** The two ways a table and a registry can disagree about what exists. */
export interface CensusDiff {
  /** Declared by the registry, carried by no row — a capability nobody wrote a scenario for. */
  readonly missing: readonly string[]
  /** Carried by a row, declared by no registry entry — a scenario for a capability that is gone. */
  readonly stray: readonly string[]
}

// Pure, total and two-directional, returning named ids so a cell can watch each side fire.
export function censusDiff(
  registryIds: readonly string[],
  tableOpIds: readonly string[],
): CensusDiff {
  const inTable = new Set(tableOpIds)
  const inRegistry = new Set(registryIds)
  return {
    missing: [...registryIds].filter((id) => !inTable.has(id)).sort(),
    stray: [...tableOpIds].filter((id) => !inRegistry.has(id)).sort(),
  }
}

/** The table's census, as ids — the comparand `registry.ids()` is asserted set-equal against. */
export function scenarioTableOpIds(): readonly string[] {
  return SCENARIO_TABLE.map((row) => row.opId)
}

/** One row by id, for the legs that iterate the registry rather than the table. */
export function scenarioRowFor(opId: string): ScenarioRow | undefined {
  return SCENARIO_TABLE.find((row) => row.opId === opId)
}
