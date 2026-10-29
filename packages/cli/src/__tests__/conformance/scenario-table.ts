// The scenario table — the parity suite's ONE denominator.
//
// THE CLAIM THIS FILE MAKES POSSIBLE. A capability exists iff it is one row: in the registry, and
// here. Census equality between `registry.ids()` and this table's keys is asserted set-equal in BOTH
// directions by `parity.test.ts`, so a capability landing without a row is a named RED on every PR
// (D-15: that leg, running in the workspace `turbo run test` job, IS SC-4's CI rule — there is no
// second diff-parsing mechanism on purpose).
//
// WHY TYPESCRIPT AND NOT YAML. Each row's `input` is typed against THAT op's own input
// contract — the very schema object the op's spec validates with, imported from the schema package
// exactly as `mapping.ts` imports it. A row whose input is the wrong shape for its op fails `tsc`,
// which is a thing no YAML corpus can do. The chat scenario corpus (`scenarios/<class>/<id>.yml`)
// keeps its own, different job (utterance routing); typed invocations stay here.
//
// SEEDED FROM 384's INVOCATION SAMPLES, WITH THEIR REASONING. Every `input` below arrived
// from `packages/agent/src/__tests__/parity-coverage.test.ts`'s `INVOCATION_SAMPLES`, and the
// per-op arguments for WHY each sample looks the way it does travelled with it — most of them turn
// on the same fact, that `invokeFunction` validates input BEFORE it consults binding, so a sample
// that failed its contract would make an unbound-refusal leg report an input error and certify
// nothing about binding.
//
// TRANSITION NOTE, 2026-08-16. `parity-coverage.test.ts` is NOT deleted by this plan. It
// retires in plan 397-08, which owns the destination register for the assertions it still carries
// (the binding-status pin, the id-taxonomy sweep, the contract-projection relation). Until then both
// files exist and this table is the successor denominator: the census leg here is what a new
// capability reds against. Two registers over one universe is the divergence D-10 exists to close,
// so the overlap is dated and time-boxed rather than permanent.
//
// NOTHING HERE IS A SECOND CATALOGUE OF SCHEMAS. `OP_INPUT_CONTRACTS` names the same schema OBJECTS
// the ops themselves validate with — not copies — and `parity.test.ts` proves the pairing two ways:
// by object identity against `AGENT_QA_OP_CONTRACTS` for the 22 ops the MCP surface publishes a
// handle for, and, for all 41, by comparing each paired schema's projection to the projection the
// registry itself published on the declaration.
//
// DATED RECONCILIATION, 2026-10-02. The counts above are the 397
// originals and stay as written. Measured at the guidance cutover: 44 registry ops and 44 rows, 30
// projected onto MCP behind 20 tools and 14 unprojected, 42 bound at the composition root and 2
// unbound (C432-REGISTRY-GOLDEN pins these). The proposal and grant ops left in 432-17/18, and no
// row's policy points refuse: `refuse` is `allow`.
//
// The `policyPoints` column keeps its name. It is test-only (no shipped byte spells it), every
// value in it is the direct claim (`allow`), and cells outside this file read it,
// `read-ops-door-parity.test.ts` among them. Renaming it would rename those claims without changing
// one; the registry golden pins that no point refuses.

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
  // the editor subject's mint.
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
  // the typed evidence read and the two feedback reads. The preview
  // validates with runs.mark's exact input singleton; it adds no input schema of its own.
  'runs.evidence': RunsEvidenceInputSchema,
  'runs.knowledge': RunsKnowledgeInputSchema,
  'runs.liveurl': RunsLiveUrlInputSchema,
  'runs.get': RunsGetInputSchema,
  'runs.list': RunsListInputSchema,
  'runs.mark': RunsMarkInputSchema,
  'runs.mark.preview': RunsMarkInputSchema,
  'runs.marks.history': RunsMarksHistoryInputSchema,
  // the run overview, the agent's map of one completed run.
  'runs.overview': RunsOverviewInputSchema,
  'runs.postprocessing': RunsPostProcessingInputSchema,
  'runs.start': RunsStartInputSchema,
} as const

/** Every op id the table knows how to type — the compile-time half of the census. */
export type ScenarioOpId = keyof typeof OP_INPUT_CONTRACTS

/** The wire shape a caller SENDS for one op — `z.input`, matching the projection's `io: 'input'`. */
export type ScenarioInput<Id extends ScenarioOpId> = z.input<(typeof OP_INPUT_CONTRACTS)[Id]>

// ---- The MCP partition, as row data joined to `mapping.ts` both ways ---------------------

/**
 * The reason CLASSES an op can be unprojected under, as a closed vocabulary.
 *
 * WHY A KEY AND NOT THE PROSE. `UNPROJECTED_OPS` carries a paragraph per op — the right artifact for
 * a person reading the mapping, and the wrong one for a row to restate, because a restatement drifts
 * silently. The row cites the CLASS instead, and `parity.test.ts` derives the class from the shipped
 * prose and asserts the two agree. That is what makes D-03's `agent.ask` scoping note machine-checked
 * data rather than a comment: if someone rewrote that op's reason into an ordinary
 * "not a mid-flight read", the row's key would no longer be the derived key and the suite names it.
 */
export type UnprojectedReasonKey =
  | 'agent-ask-delegation-deferral'
  // `requires-human-origin` LEAVES the vocabulary. Its last member,
  // `grants.revoke`, is deleted with the grant ledger (`proposals.accept`/`reject` left in 432-17),
  // so no registered op declares `requiresHumanOrigin` and the class would be a member-less literal
  // (the 432-17 `proposal-round-removed` precedent).
  // 2026-08-17. The FOURTH class, and it is admitted rather than folded because the
  // vocabulary's whole job is to keep genuinely different facts apart. `agent.explain` is not
  // scoped out of a workflow and is not a door that cannot open — the question it answers is one
  // the PROTOCOL already answers for machines, and 397 ruled the v1 discovery tool not-a-gap on
  // exactly that ground. Filing it under `not-mid-flight-read` would have been the available
  // shortcut and would have recorded a scoping decision where an argued one was made.
  | 'discovery-answered-by-protocol'
  // 2026-08-25. The FIFTH class, admitted on the fourth's own reasoning rather than
  // folded. `runs.liveurl` is not scoped out of a workflow — minting a live-view URL is about as
  // mid-flight as a read gets — and it is not a door that cannot open. The fact is that the op
  // hands out a CREDENTIAL, and who may mint one over MCP is Phase 408's question. Filing it under
  // `not-mid-flight-read` was the available shortcut and would have recorded a scoping decision
  // where a deferred security decision was made.
  //
  // DISPOSITION, 2026-08-31 (408 D-01 · D-14's bookkeeping): the class is RETAINED and RE-GROUNDED,
  // not retired and not re-classified. Retained because its DEFINING fact is unchanged — the op
  // still hands out a credential, and that is still why it has no MCP door; re-grounded because
  // 408 answered the open question the name once pointed at. The class now names a RECORDED
  // internal-only ruling (the MCP server mints by reference inside its App-rendering path; the
  // token reaches a person only in host-rendered HTML) rather than an open deferral. Retiring the
  // class and folding the row into `not-mid-flight-read` was the available shortcut and is the
  // same error 403 refused: it would file a credential ruling as a scoping line. The name keeps
  // its `-deferral` spelling because renaming a key rewrites every row and the golden partition
  // that cite it, to record a fact the prose below and `mapping.ts`'s own reason already carry —
  // and the prose is the record here, by this file's own restatement-drifts law.
  // DISPOSITION, 2026-09-01 (408-08, the gap round · D-14's bookkeeping again, recorded rather
  // than silent). The class is RETAINED, unchanged, and one parenthetical above is corrected. The
  // 2026-08-31 line reads "the token reaches a person only in host-rendered HTML"; whether the
  // document this server serves is host-rendered HTML or text a model consumes is a property of
  // the CALLER, not of this server, so that half described the wrong party. What holds is that
  // the server writes the token into exactly one place — the frame src of the document the
  // `ui://` read serves — and that door is bounded by the operator-granted `read` scope plus a
  // bound mint, never by the caller's own capability declaration (road `demote`; the ruling is in
  // `app-resource.ts`'s header, and `mapping.ts`'s reason carries the same dated addendum). The
  // class's DEFINING fact is untouched by all of this — the op still hands out a credential, and
  // that is still why it has no MCP door — so neither the partition nor the signature phrase
  // moves. Recorded here because a disposition that changes is dated on the record, never edited
  // away.
  | 'credential-mint-deferral'
  // 2026-09-30 admitted a sixth class, `proposal-round-removed`, for the five pre-432
  // proposal ops whose MCP tools left with the proposal round. 2026-10-01: the ops are
  // deleted from the registry, so the class has no member and leaves the vocabulary.
  | 'not-mid-flight-write'
  | 'not-mid-flight-read'

/**
 * The signature phrase each class is recognised by, in PRECEDENCE ORDER (highest first).
 *
 * Ordered rather than exclusive because the shipped reasons can overlap (until 432-18 `grants.revoke`
 * named both `requiresHumanOrigin` and the mid-flight line), and the honest class is the stronger one —
 * a question the protocol answers is a different fact from a read that was scoped out of a workflow.
 * A first-match rule over a declared order makes that a decision recorded once rather than a
 * judgement call repeated per row.
 */
export const UNPROJECTED_REASON_SIGNATURES: readonly (readonly [UnprojectedReasonKey, string])[] =
  Object.freeze([
    Object.freeze(['agent-ask-delegation-deferral', 'nested-agent delegation'] as const),
    // 398 D-09. Placed ABOVE the two mid-flight lines because its reason is the stronger fact, on
    // the precedence rule this list already states: a question the protocol answers is a different
    // thing from a read that was scoped out of a workflow, and the shipped prose for
    // `agent.explain` deliberately contains neither mid-flight phrase.
    Object.freeze(['discovery-answered-by-protocol', 'answers machine discovery'] as const),
    // 403-01 D-03. Placed ABOVE the two mid-flight lines on the same precedence rule: a credential
    // whose issuance is deferred to a later phase is a stronger fact than a scoping line, and the
    // shipped prose for `runs.liveurl` deliberately contains neither mid-flight phrase.
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

/**
 * What one row claims about the chat surface.
 *
 * `reachable` is a BOOLEAN rather than the literal `true` every row carries today, and the width is
 * deliberate: the field's job is to be joined against the live chat enumeration in both directions,
 * and a type that could only say `true` would make one of those directions unsayable. All 41 rows
 * say `true` because the planner binds the listing 1:1 and the deterministic
 * resolver adds no capability the planner lacks — which is a MEASURED fact about the shipped
 * composition, asserted by `parity.test.ts`, not a property of this type.
 */
export interface ChatSurfaceExpectation {
  readonly reachable: boolean
}

/**
 * What one row claims about the `fn` door.
 *
 * A BOOLEAN, on {@link ChatSurfaceExpectation}'s reasoning and not on {@link McpSurfaceExpectation}'s:
 * `fn` has no projection and no wire name — the id a person types IS the registry id — so there is
 * no tool spelling for a row to carry and no unprojected class for one to cite. What is left to
 * claim is reach, and the field's job is to be joined against the LIVE `fn` listing in both
 * directions, which a type that could only say `true` would make unsayable.
 *
 * All 42 rows say `true`, and that is a MEASURED fact about the shipped composition rather than a
 * property of this type: `agent-qa fn <id>` resolves every id through `invokeFunction`, and since
 * 432-20 no caller is narrowed by a grant — 2026-10-02: the caller carries no scope
 * set at all — so the door's reach is the whole census. `parity.test.ts` asserts it both ways, so
 * the day the CLI door stops reaching an op this reads red.
 */
export interface FnSurfaceExpectation {
  readonly reachable: boolean
}

/**
 * What a person must be able to READ after this op answers, on every door.
 *
 * WHY THE RENDER EXPECTATION IS A COLUMN ON THIS TABLE AND NOT A SECOND CORPUS. D-09's one-
 * denominator rule: the table is already census-equal to `registry.ids()` in both directions, so a
 * capability landing without a render expectation is the SAME named RED as one landing without a
 * scenario. A separate render fixture set would be a second register over one universe, and the two
 * would drift in the direction the busier one was edited.
 *
 * THE MARKERS ARE PAYLOAD CONTENT, NEVER RECEIPT TEXT, and the leg enforces both halves of that
 * mechanically rather than trusting this sentence. `render-parity.test.ts` produces each op's result
 * document from the op's OWN output projection — the inert JSON-Schema the shipped registry
 * publishes on its declaration — and refuses any marker that does not occur in it; so a marker
 * naming a field the contract cannot produce is a named RED here rather than a cell that passes on
 * a shape nothing returns (390-03's produced-not-literal law). It then renders the SAME document
 * through the pre-399.1 drop site (`<op> completed`) and refuses any marker that survives THAT,
 * which is the mutation bar: a marker a completion phrase already contains would be vacuously
 * present on the very build this phase exists to red.
 *
 * THE SET IS THE OP'S REQUIRED OUTPUT FIELDS, DERIVED BY ONE RULE AND THEN REVIEWED — every required
 * property of the first arm of its output contract, sorted. Not a hand-picked subset: hand-picking
 * is the drop site RC-2 was caught being, and a suite that expected a curated few would be
 * asserting the same curation it is supposed to catch. Committing the derived set is the golden-
 * ledger idiom — an op whose required output fields change is then a reviewed one-line diff here.
 *
 * NON-EMPTY IN THE TYPE. `readonly [string, ...string[]]` makes `markers: []` a compile error, so a
 * row cannot be added with nothing to look for; the leg asserts the same fact again at runtime,
 * because a tuple type is defeatable by a cast and an empty expectation is a cell that passes on
 * every build including the blind one.
 */
export interface RenderExpectation {
  readonly markers: readonly [string, ...string[]]
}

/**
 * What a person must be able to read off an ENTITY CARD, per kind, on every door.
 *
 * A COLUMN ON THIS TABLE AND NOT A SECOND CENSUS, on {@link RenderExpectation}'s own reasoning
 * DASH-03's parity clause holds the dashboard's card render and MCP's reference
 * projection to ONE denominator; a dashboard-only card census beside this table would be a table
 * measured against itself, and the two would drift in the direction of whichever was edited more.
 *
 * THE ROUTE HALF IS NOT WRITTEN HERE — IT IS READ. `ENTITY_DASHBOARD_ROUTES` is a SHIPPED contract
 * in the schema package (`entity/dashboard-route.ts`), beside `ENTITY_URL_ROUTE` and for the reason
 * that constant's docstring already gives: the dashboard's renderer mints hrefs from it, so a copy
 * here would be a second route table free to say a kind has a page after the router stopped serving
 * one. Spreading it is what makes "the same row measures both doors" a structural fact across a
 * package boundary neither surface can import across — every package's `tsconfig.json` pins
 * `rootDir` to its own `src`, so the two consumers reach one declaration through `schema` rather
 * than through each other.
 *
 * WHAT THIS TABLE ADDS is the expectation the CONTRACT cannot carry: the fields a reader must
 * actually be able to read. Those are the card's always-present contract fields rather than a
 * per-kind selection, because hand-picking which fields matter per kind is the curation 399.1 D-04
 * caught the drop site being, and it would let a kind quietly expect less.
 */
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

/**
 * THE per-kind card-render cases — one denominator, five kinds, no fallback.
 *
 * TOTAL OVER `EntityKind`, and the totality is the point rather than tidiness. The unrouted kinds
 * are the arm a happy-path suite never drives: `MEM` and `POL` are exactly the cards that
 * carry a `url` (400-01 D-16 overlays a base for any conversation the dashboard serves) and must
 * STILL render no link, because this build serves no page for them. A set listing only the routed
 * three would state the claim it was already going to pass.
 */
function entityCardRenderCase(kind: EntityKind): EntityCardRenderCase {
  return Object.freeze({
    kind,
    dashboardRoute: ENTITY_DASHBOARD_ROUTES[kind].route,
    routeKeyedBy: ENTITY_DASHBOARD_ROUTES[kind].keyedBy,
    markers: ENTITY_CARD_MARKERS,
  })
}

/**
 * WRITTEN AS FIVE NAMED ARMS RATHER THAN AN `Object.fromEntries` WALK (400-09 deviation).
 *
 * The walk read better and did not typecheck: `Object.fromEntries` answers with an index signature,
 * and the `as Record<EntityKind, …>` needed to recover the total type is a TS2352 that `vitest` does
 * not see and `tsc --noEmit` does. Widening the cast through `unknown` would have silenced the
 * compiler by removing the only check that matters here — that the record is TOTAL. Naming the arms
 * moves that check from a runtime census to the type annotation: a sixth member of `EntityKind`
 * fails to compile at this literal. The census cell in `entity-card-parity.test.ts` still asserts
 * the key set against `ENTITY_KINDS`, and every VALUE is still spread from the shipped contract by
 * the helper above rather than restated here.
 */
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

/**
 * The policy points every row declares, as expected VERDICTS.
 *
 * The callers themselves are not spelled here and must not be: `policy-fixtures.ts` mints them.
 *
 * `refuse` is `allow` since 432-20. It named the verdict for a caller holding the covering
 * grant minus one scope, which was `deny`; no scope is declared or read any more, so the formerly
 * refused caller is allowed exactly as the covering one is. The point is kept as a column so the
 * retired claim reads as its direct replacement rather than vanishing.
 */
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
  /**
   * Present on exactly the ops that answer with an ENTITY CARD — see
   * {@link EntityCardRenderCase}.
   *
   * Optional because most ops do not return one; a consumer partitions on the key's presence the
   * same way the MCP leg partitions on `reachable`, and `entity-card-parity.test.ts` asserts the
   * set of rows carrying it set-equal to the set of ops whose OUTPUT CONTRACT is the card contract,
   * in both directions — so an op cannot acquire a card result and quietly skip this expectation.
   */
  readonly entityCardExpect?: EntityCardRenderExpectation
}

/**
 * The identity function that makes a row's `input` check against its OWN op's contract.
 *
 * Without it the table would be an array of a union type and TypeScript would accept any member's
 * input for any member's id — which is the whole compile-time guarantee D-09 chose TypeScript for.
 * The generic binds `Id` from the `opId` literal and `ScenarioInput<Id>` then resolves to one
 * schema, so `{ opId: 'runs.get', input: {} }` is a compile error rather than a runtime surprise.
 */
function scenario<Id extends ScenarioOpId>(row: ScenarioRow<Id>): ScenarioRow<Id> {
  return Object.freeze(row)
}

const FIXTURE_RUN_ID = 'run-alpha'
/**
 * A well-formed content address. 64 LOWERCASE hex, because `RunsArtifactInputSchema`
 * refuses everything else — a placeholder of any other shape would make every `runs.artifact` row
 * an input error, and the surfaces would then be measured refusing a malformed request rather than
 * reaching (or declining to reach) the capability.
 */
const FIXTURE_ARTIFACT_SHA = 'a'.repeat(64)
const FIXTURE_ENTITY_SHORT_ID = 'MEM-001'

/**
 * One row per registry op. Adding a capability adds a ROW — never a file and never a `describe`.
 *
 * The rows are sorted by op id so this file reads as an index and a diff adding one is one hunk.
 */
export const SCENARIO_TABLE = Object.freeze([
  // the message is non-empty (the contract's one requirement) and resolves to nothing.
  // Unprojected over MCP on the one exclusion with a DECISION behind it rather than a scoping line
  // which is why its reason key is its own class.
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
  // `query` is the whole input and it must be non-empty, so `{}` would report an INPUT
  // error exactly where a binding refusal is wanted. The question is a real one a person asks and
  // is deliberately NOT a phrase this fixture's rows answer — the honest outcome under any
  // composition that runs it is the abstention arm, which is the arm this capability exists to be
  // able to give. Unprojected over MCP on the one exclusion 398 argued rather than scoped.
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
  // a PARSING input for a capability most compositions cannot run — validation precedes
  // the binding check, so a sample that failed the contract would make an unbound-refusal leg report
  // an input error and certify nothing about binding.
  //
  // 2026-08-29 (Phase 406 planned 2026-08-28), D-01/D-04 — THE MCP PARTITION DID NOT MOVE. `analysis.get` is now served
  // on BOTH dashboard doors (`GET /api/runs/:id/analysis` locally, `GET /run/:runId/analysis` on
  // the authed remote door), which is a change to which HTTP surfaces reach the op and not to which
  // CALLER ORIGINS may. `not-mid-flight-read` still states the reason it is unprojected on MCP:
  // whether an agent-origin caller reads a completed run's analysis is Phase 408's question, and
  // answering it here — by widening the partition because a browser gained a route — would be
  // deciding an agent-surface question by accident. The line below is unchanged, deliberately.
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
  // BOTH fields are non-empty and required, so `{}` would report an input error where
  // a binding refusal is wanted. The ref is deliberately the exact-address spelling: free text would
  // be routed to the entity resolver, and this fixture resolves nothing.
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
    // `written` — the edit lands in the file it edited, and says so.
    // `proposal` left the output with the authoring proposal record.
    renderExpect: {
      markers: ['draftRef', 'editedFrom', 'patches', 'thoughts', 'written'],
    },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // the path is well-formed, carries the extension the op requires, and names nothing in
  // any fixture; `draftMode` is optional and omitted.
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
  // non-empty intent and a well-formed scope are the contract's two requirements.
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
  // the window is REQUIRED and closed, so `{}` would report an input error.
  // `all-time` is the arm with no further field, which is the honest sample for a fixture that has
  // no session and no receipts.
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
  // PARSING inputs for the config write half, on the reasoning every unbound row shares.
  scenario({
    opId: 'config.auth.set',
    input: { target: 'shop', pluginPackage: '@acme/auth' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // the op writes in the call and answers the files and fields it changed.
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
      // the op writes in the call and answers the files and fields it changed.
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
      // the op writes in the call and answers the files and fields it changed.
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
  // the ONE field the model fills, hostname-shaped — the gate is the first thing the op
  // runs and a non-hostname would make this a refusal sample instead.
  scenario({
    opId: 'config.project.scaffold',
    input: { domain: 'shop.example.com' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // the op writes in the call and answers the files and fields it changed.
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
  // PARSING inputs on the rows above reasoning.
  scenario({
    opId: 'config.target.create',
    input: { name: 'shop', platform: 'web', url: 'https://shop.example.com' },
    perSurface: {
      chat: { reachable: true },
      mcp: { reachable: { tool: 'agent_qa_change_config' } },
      fn: { reachable: true },
    },
    renderExpect: {
      // the op writes in the call and answers the files and fields it changed.
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
      // the op writes in the call and answers the files and fields it changed.
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
  // the editor subject's mint, mirroring runs.liveurl's row, in SORT
  // position (the render matrix derives its cell names from this order). Unprojected on MCP by
  // ruling and keyed `credential-mint-deferral` for the same defining fact: the op hands out a
  // credential. Its result carries no `handle`, since an editor session has one stream.
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
  // 387: `get` takes an exact address; the fixture entity directory is what stands behind it.
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
  // 387: `resolve` takes any reference at all, so the sample is free text that matches nothing — an
  // empty directory's honest answer is the none arm.
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
  // 391 PROP-01 / D-03's `grants.list` and `grants.revoke` rows left with the ops.
  // valid INPUTS for capabilities most compositions cannot run — `invokeFunction` validates
  // before it consults the binding.
  // the three knowledge changes apply in the call and answer the records
  // they changed. The retired `.propose` ids have no row: they are not registered.
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
  // the fixture runs port records no run, so the honest answer is the typed no-trace
  // arm — the arm this verb exists to be able to give.
  scenario({
    opId: 'knowledge.brief.why',
    input: { runId: FIXTURE_RUN_ID, stepIndex: 0 },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
      // projected; re-spelled with the mapping's move.
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
    // keep the existing lexicographic scenario order (forget precedes gates).
    opId: 'knowledge.gates.list',
    input: { recordId: 'rec-not-in-this-fixture' },
    perSurface: {
      chat: { reachable: true },
      // the MCP carry from 416.
      mcp: { reachable: { tool: 'agent_qa_list_knowledge_gates' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['recordId', 'kind'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // 387: the record id names nothing in this fixture and the typed miss is the correct answer.
  scenario({
    opId: 'knowledge.record.show',
    input: { recordId: 'rec-not-in-this-fixture' },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
  // 387: the diff baseline is 0 — a first-ever diff.
  scenario({
    opId: 'knowledge.records.diff',
    input: { sinceOrdinal: 0 },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
      mcp: { reachable: { tool: 'agent_qa_diff_knowledge_records' } },
      fn: { reachable: true },
    },
    renderExpect: { markers: ['changes', 'schemaVersion', 'sinceOrdinal'] },
    policyPoints: { grant: 'allow', refuse: 'allow' },
  }),
  // 387: the filter is closed and every member optional, so an empty filter is the honest
  // 'everything' query.
  scenario({
    opId: 'knowledge.records.inspect',
    input: { filter: {} },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
  // the two write verbs take the three legs of stable test identity — a partial address
  // would report an input error where a binding refusal is wanted. The test named here exists in no
  // fixture; nothing is dispatched either way.
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
  // `list` genuinely takes the empty query — enumeration is the verb.
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
  // a PARSING input for a capability most compositions cannot run.
  // THE durable run-detail read. Unprojected on MCP for the reason its `runs.` read
  // siblings are — it is a completed-run read rather than a mid-flight one — and its markers are
  // the four top-level collections, so a projection that lost the token sum (whose three members
  // are absent by design) would red here rather than silently start declaring zeros.
  // THE ref-resolving read. Unprojected on MCP for its `runs.` read siblings'
  // reason and one of its own — its result is a BASE64 BLOB, which is not a shape a `tools/call`
  // round trip wants and not a payload a conversation can do anything with. Its markers are the
  // four result keys, so a projection that lost `contentType` or `byteLength` would red here
  // rather than start handing a surface bytes it cannot name or size.
  scenario({
    opId: 'runs.artifact',
    input: { runId: FIXTURE_RUN_ID, sha: FIXTURE_ARTIFACT_SHA },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
    // the proposal members are gone; the digest carries the fixes a
    // run's marks applied (`markChanges`), read from the run's own ledger where a host binds it.
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
  // The one STREAM op in the census. Unprojected because a `tools/call` is one round trip and has no
  // shape for a resumable event feed — the reason the mapping gives, and the reason its verdict
  // legs need their own comparison mechanics.
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
  // the typed evidence read. In SORT position after `runs.events`.
  // Unprojected over MCP on `runs.detail`'s completed-run footing, with read policy points. Its
  // markers are the ready arm's four required keys: the address read, the recorded entry, the
  // outcome and the parsed document.
  scenario({
    opId: 'runs.evidence',
    input: { runId: FIXTURE_RUN_ID, testIndex: 0, stepIndex: 0, kind: 'console' },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
  // the Knowledge panel's ONE read. In SORT position after `runs.get` — this table is
  // compared against its own committed sorted order, so a row placed where it reads well rather
  // than where it sorts reds the render-parity leg. Unprojected over MCP on `runs.detail`'s
  // footing: a durable post-run read is not a mid-flight one.
  //
  // THE MARKERS NAME THE `evidence-incomplete` ARM, and that is the honest set rather than a
  // reduced one. The conformance fixture records no run under `FIXTURE_RUN_ID`, so what this op
  // really produces here is the two-field absence arm — which is D-06 working: a pruned or absent
  // handoff is a RESULT a surface renders, never a refusal. Naming `steps` and `learned` would be
  // asserting about a shape nothing returns, which the render-parity leg refuses by construction.
  scenario({
    opId: 'runs.knowledge',
    input: { runId: FIXTURE_RUN_ID },
    perSurface: {
      chat: { reachable: true },
      // projected; re-spelled with the mapping's move.
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
  // a PARSING input for a capability most compositions cannot run.
  // the mint. Unprojected on MCP because handing an agent-origin caller a live-view
  // CREDENTIAL is Phase 408's question, not a side effect of registering the op.
  // RESOLVED 2026-08-31: the question is answered and the row does not move. Internal
  // mint ONLY — the MCP server invokes this op by reference inside its `ui://agent-qa/live-run/`
  // App resource read (408 plans 01/03), so the minted token lands in host-rendered HTML and never
  // in tool-result text; a projected mint tool stays rejected. The op is unprojected BY RULING
  // now, not by deferral, and the `credential-mint-deferral` key stays because the fact it names —
  // this door is absent because the op hands out a credential — is exactly what is still true.
  // CORRECTED 2026-09-01 (408-08, the gap round, road `demote`; the full class-level DISPOSITION is
  // thirty rows up at :197-209 and the ruling is in `app-resource.ts`'s header). The line above
  // reading "the minted token lands in host-rendered HTML and never in tool-result text" is an
  // over-claim and is struck here rather than reworded away: whether the document this server
  // serves is host-rendered HTML or text a model consumes is a property of the CALLER, not of this
  // server. What holds is narrower and verifiable — the server writes the token into exactly one
  // place, the frame src of the document the `ui://` read serves, and that door is bounded by the
  // operator-granted `read` scope plus a bound mint. The ROW does not move for any of it: the op
  // still hands out a credential, so it is still unprojected and still keyed
  // `credential-mint-deferral`.
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
  // marks history, a read tool with read policy points.
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
  // declared in full; every field is optional, so the empty object is the whole input.
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

/**
 * The census self-check, as a PURE function of two id lists.
 *
 * TWO-DIRECTIONAL BY CONSTRUCTION. A one-directional census — "every row names a real op" — passes
 * forever on a table that has simply stopped growing, which is the exact failure mode two registers
 * over one universe produce and the reason D-10 folds them into one. Both sides are returned as
 * NAMED ids rather than counts, because the failure a person needs to read is "which capability",
 * not "one too few".
 *
 * Pure and total so `parity.test.ts` can drive it with a synthetic table missing a row and a
 * synthetic table carrying a stray, and OBSERVE each side fire. A register whose self-check has
 * never been seen to fire is a register that certifies its own arithmetic and nothing else.
 */
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
