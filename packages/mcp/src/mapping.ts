// The declared tool -> op mapping (Phase 396 plans 01 + 04, D-01 / D-03 / D-04 / D-16 · MCPS-02).
//
// WHY THIS FILE EXISTS. The v1 server carried its catalogue as 33 hand-written handlers, each free
// to reach data its own way; the whole point of the re-derivation is that a tool is a PROJECTION of
// a registry op and nothing else. What is left over once the handlers are gone is DATA — which tool
// names exist, which op ids each one stands in front of, and what class of thing it does — and this
// module is where that data lives so a single artifact can be ranged over by 397's parity suite.
// Anything that is not data belongs in `projection.ts` or `catalog.ts`.
//
// sixteen tools over twenty-six registry ops; the other TWENTY-FIVE
// ops are listed below in `UNPROJECTED_OPS` with a reason each. Twenty-six plus twenty-five is the
// registry's own count, and `packages/cli/src/__tests__/conformance/parity.test.ts` checks that
// partition against the registry's enumeration rather than against the arithmetic in this
// sentence. The two new tools are the feedback reads (marks history and the mark consequence
// preview); the typed evidence read lands unprojected on `runs.detail`'s completed-run footing.
//
// the unprojected side grows to TWENTY-SIX when `editor.liveurl` is
// registered; the projected side and the tool count do not move. The editor subject's mint is
// reachable only through the dashboard door, by ruling.
//
// TWENTY tools over THIRTY registry ops; the other TWENTY-THREE stay
// in `UNPROJECTED_OPS`, and the registry is still fifty-three. The two change tools are renamed
// `agent_qa_change_knowledge` and `agent_qa_change_config` and write in the call. The four proposal
// apply/list/show tools and the config undo arm are gone with no alias, and their five ops are
// dispositioned below until 432-17 deletes them from the registry.
//
// TWENTY tools over THIRTY registry ops; the other SIXTEEN stay in
// `UNPROJECTED_OPS`, and the registry is forty-six. The seven proposal, apply and undo ops are
// deleted from the registry, so their five '432' dispositions and the two 397 dispositions of
// `proposals.accept` and `proposals.reject` leave the scoping note, and '432' leaves the adjudicator
// vocabulary with no member left to rule on.
//
// 2026-10-01, written 2026-10-03 (quick-261003-tsr IN-28): TWENTY tools over
// THIRTY registry ops; the other FOURTEEN stay in `UNPROJECTED_OPS`, and the registry is forty-four.
// `grants.list` and `grants.revoke` are deleted with the grant ledger.
//
// the unprojected side moved from nineteen to twenty when `agent.explain`
// was registered. This sentence is prose and the parity suite's partition check is the mechanism —
// but the prose is updated in the same change-set anyway, because a header that goes on stating a
// partition the code stopped having is the class of untruth the ops' own docstrings were caught in
//
// the unprojected side grows again, and the registry with it, when
// `runs.knowledge` is registered — so the partition holds with both sides one larger. Unprojected
// DELIBERATELY and on `runs.detail`'s footing: a completed run's whole used-and-learned projection
// is a large one-shot payload, not a mid-flight read. The partition check is the mechanism; this
// sentence is updated in the same change-set for the reason the paragraph below states.
//
// twenty to twenty-one, and the registry from forty-two to forty-three,
// when `runs.liveurl` was registered. Unprojected DELIBERATELY: minting a live-view capability
// token is handing out a credential, and whether an MCP caller may mint one is Phase 408's
// question (the MCP App embed) rather than a side effect of this phase registering the op.
//
// that question is ANSWERED and the partition does not move for it. The
// ruling is internal mint only — the App-rendering path invokes `runs.liveurl` by reference and
// the token reaches a person only through host-rendered HTML — so the op stays on the
// unprojected side, now by RULING rather than by deferral. Recorded here, at the entry, and at
// the conformance row, because a deferral that quietly becomes a permanent absence is the same
// untruth as a partition the code stopped having.
// 2026-09-01 (408-08, the gap round, road `demote`): the partition still does not move, and the
// em-dashed half above is corrected in the same place it was claimed. "The token reaches a person
// only through host-rendered HTML" is a statement about what the CALLER does with a document it
// asked for, not about this server. What this server does is write the token into exactly one
// place — the frame src of the document the `ui://` read serves — and that door is bounded by the
// `read` scope an operator granted the caller plus a bound mint, never by the caller's own
// capability declaration. The op stays unprojected on the same, stronger footing.
//
// Protocol grounding: SEP-2567 removed per-connection list variance, so the tool NAMES a caller can
// see are a property of the caller's grants and of this table — never of a session. SEP-2549 makes
// those listings cacheable, which is the other half of the same reason the table is static data.

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import {
  AuthoringDraftEditInputSchema,
  AuthoringDraftEditOutputSchema,
  AuthoringDraftWriteInputSchema,
  AuthoringDraftWriteOutputSchema,
  AuthoringRefineFoldInputSchema,
  AuthoringRefineFoldOutputSchema,
  AuthoringVerifyDraftInputSchema,
  AuthoringVerifyDraftOutputSchema,
  BriefWhyInputSchema,
  BriefWhyResultSchema,
  ConfigAuthSetInputSchema,
  ConfigChangeFoldInputSchema,
  ConfigChangeFoldOutputSchema,
  ConfigChangeOutputSchema,
  ConfigFieldSetInputSchema,
  ConfigHookAddInputSchema,
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
  ConfigTargetEditInputSchema,
  EntitiesGetInputSchema,
  EntitiesResolveInputSchema,
  EntityCardResolutionSchema,
  EntityCardSchema,
  KnowledgeAcceptChangeInputSchema,
  KnowledgeBundlesListInputSchema,
  KnowledgeBundlesListOutputSchema,
  KnowledgeChangeFoldInputSchema,
  KnowledgeChangeFoldOutputSchema,
  KnowledgeForgetChangeInputSchema,
  KnowledgeGatesListInputSchema,
  KnowledgeGatesListResultSchema,
  KnowledgeChangeOutputSchema,
  KnowledgeRecordShowInputSchema,
  KnowledgeRecordShowResultSchema,
  KnowledgeRecordsDiffInputSchema,
  KnowledgeRecordsDiffOutputSchema,
  KnowledgeRecordsInspectInputSchema,
  KnowledgeRecordsInspectOutputSchema,
  KnowledgeRejectChangeInputSchema,
  RunDigestSchema,
  RunKnowledgeProjectionSchema,
  RunOverviewProjectionSchema,
  RunStartAcknowledgementSchema,
  RunsArtifactInputSchema,
  RunsArtifactOutputContract,
  RunsDigestInputSchema,
  RunsEvidenceFoldInputSchema,
  RunsEvidenceFoldOutputContract,
  RunsEvidenceInputSchema,
  RunsEvidenceOutputContract,
  RunsKnowledgeInputSchema,
  RunsListInputSchema,
  RunsListOutputContract,
  RunsMarkInputSchema,
  RunsMarkOutcomeSchema,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryInputSchema,
  RunsMarksHistoryResultSchema,
  RunsOverviewInputSchema,
  RunsStartInputSchema,
  TOOL_FOLD_DISCRIMINANT,
} from '@vostride/agent-qa-schema'

/**
 * What a tool DOES, coarsely — the axis annotations are derived along (`projection.ts`).
 *
 * `read` answers; `workflow` changes something in the call (a test file, a run, knowledge,
 * configuration). `apply` names the mark door, which records the mark and applies its fix in the
 * call and asks nothing.
 */
export type ToolProjectionKind = 'read' | 'workflow' | 'apply'

/**
 * How a tool's arms compose — DERIVED from the entry, never stated a second time on it.
 *
 * `single` is a 1:1 projection. `union` is D-01's declared fold: several sibling ops behind one
 * discriminated-union input, the arm selected by a literal. `pipeline` is D-02's one read door:
 * two ops invoked in sequence, the first one's answer choosing whether the second runs at all.
 *
 * A third field on the entry would have been a third thing to keep in step with the first two, and
 * the failure it would have hidden is a fold declared `single` — which registers a tool advertising
 * one arm's contract while the entry declares two.
 */
export type ToolComposition = 'single' | 'union' | 'pipeline'

/** The tool-listing `_meta` key a host reads as the largest result it should keep. */
export const MAX_RESULT_SIZE_META_KEY = 'anthropic/maxResultSizeChars'

/** the size hint the three whole-run reads carry. */
export const RUN_READ_MAX_RESULT_SIZE_CHARS = 100000

/** One declared tool. */
export interface ToolProjection {
  /** Curated `verb_noun` name per spec section 3.3. */
  readonly name: string
  /** The registry op ids this tool projects. Length 1 = 1:1; length > 1 = a declared fold. */
  readonly ops: readonly string[]
  readonly kind: ToolProjectionKind
  // the `credential?: 'required'` marker is deleted with the
  // MCP bearer credential. No tool declares a credential and no handler reads one.
  /**
   * A union fold's discriminant key — absent on a 1:1 tool AND on the pipeline.
   *
   * Its presence is what tells a fold from a pipeline, which is why it is spelled per entry rather
   * than assumed from `ops.length > 1`.
   */
  readonly discriminant?: string
  /**
   * This tool CARRIES the live-view MCP App.
   *
   * ITS PRESENCE IS THE SIGNAL, exactly as `discriminant`'s above is. A carrier is a tool whose
   * declaration references the `ui://` App resource, so a host that negotiated the Apps extension
   * can render the run's live view beside the result; a tool without this member references
   * nothing, and `projection.ts` derives an ABSENT `_meta` for it rather than an empty one. Spelled
   * per entry rather than inferred from a name, a kind or an op id, because the census that
   * enumerates carriers reads THIS field — and a predicate over names would be a second, unwritten
   * declaration of which doors reach a credential channel (the 399.1 lesson).
   *
   * `resource` names which `ui://` template the reference points at; one template exists today and
   * the field is spelled anyway, so a second App is an added member here rather than a second
   * meaning for a boolean.
   *
   * `runIdFrom` names where the CONCRETE runId for a per-call reference is found — on the call's
   * input or in the op's own result. `agent_qa_start_run` answers a `RunStartAcknowledgement`
   * carrying the id the run was given, so its reference is derivable only from the OUTPUT;
   * `agent_qa_get_run_digest` is asked about a run by id, so its reference is derivable from the
   * INPUT, which is what makes it the late-attach door.
   *
   * Both carriers are plain tools that answer immediately, so the reference rides their result.
   */
  readonly ui?: {
    readonly resource: 'live-run'
    readonly runIdFrom: 'input' | 'output'
  }
  /**
   * the result-size hint, advertised as `_meta[MAX_RESULT_SIZE_META_KEY]`.
   * Present only on reads whose one-shot answer can outgrow a host's default result budget.
   */
  readonly maxResultSizeChars?: number
}

/** The composition, read off the entry. See {@link ToolComposition}. */
export function compositionOf(projection: ToolProjection): ToolComposition {
  if (projection.ops.length === 1) return 'single'
  return projection.discriminant === undefined ? 'pipeline' : 'union'
}

/**
 * The live input/output contracts of one projected op.
 *
 * WHY THIS TABLE EXISTS AT ALL, since it looks like a second declaration of something the registry
 * already knows. It is not: `FunctionSpec` — the record holding the LIVE validators — deliberately
 * never leaves the function layer's own directory, and what a surface can see
 * through `registry.list(caller)` is a `FunctionDeclaration` whose `input`/`output` are already
 * INERT JSON-Schema projections. D-16 mechanic (a) needs the live Standard-Schema objects, so the
 * projection names them here, imported from the ONE module the ops themselves import them from.
 * Drift is therefore impossible in the only sense that matters: this is not a copy of the contract,
 * it is the same object, so the schema advertised in `tools/list` and the schema `invokeFunction`
 * validates with are one thing that cannot disagree.
 *
 * The alternative — `fromJsonSchema(declaration.output)` — was available and rejected: it is a
 * SECOND conversion recipe beside the SDK's own, and the anti-pattern this phase's research names
 * first is exactly two recipes for one conversion.
 *
 * The field type is the SDK's `StandardSchemaWithJSON` and NOT a zod type, which is the same
 * decision seen from the other side: this package's runtime dependency allow-list is exactly the
 * two protocol packages, so naming a validator library here — even in a type position, which
 * the dependency lint reads no differently — would reopen the collapse the phase exists to make.
 * A zod 4.4 schema satisfies the interface, which is the whole of what either side needs to know.
 */
export interface ToolOpContracts {
  readonly input: StandardSchemaWithJSON
  readonly output: StandardSchemaWithJSON
}

/**
 * Op id -> its live contracts, for every op any declared projection names.
 *
 * `catalog.ts` refuses to build a tool whose op is missing from it, so the two tables can never
 * drift apart silently.
 */
export const AGENT_QA_OP_CONTRACTS: Readonly<Record<string, ToolOpContracts>> = Object.freeze({
  'runs.mark': Object.freeze({ input: RunsMarkInputSchema, output: RunsMarkOutcomeSchema }),
  // the feedback reads keep their ops' own strict contracts. The preview
  // takes runs.mark's exact input and answers the read-only plan result.
  'runs.marks.history': Object.freeze({
    input: RunsMarksHistoryInputSchema,
    output: RunsMarksHistoryResultSchema,
  }),
  'runs.mark.preview': Object.freeze({ input: RunsMarkInputSchema, output: RunsMarkPreviewResultSchema }),
  'knowledge.gates.list': Object.freeze({
    input: KnowledgeGatesListInputSchema,
    output: KnowledgeGatesListResultSchema,
  }),
  'authoring.draft.write': Object.freeze({
    input: AuthoringDraftWriteInputSchema,
    output: AuthoringDraftWriteOutputSchema,
  }),
  'authoring.draft.edit': Object.freeze({
    input: AuthoringDraftEditInputSchema,
    output: AuthoringDraftEditOutputSchema,
  }),
  'authoring.draft.verify': Object.freeze({
    input: AuthoringVerifyDraftInputSchema,
    output: AuthoringVerifyDraftOutputSchema,
  }),
  'runs.start': Object.freeze({
    input: RunsStartInputSchema,
    output: RunStartAcknowledgementSchema,
  }),
  'config.field.set': Object.freeze({
    input: ConfigFieldSetInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  'config.target.create': Object.freeze({
    input: ConfigTargetCreateInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  'config.target.edit': Object.freeze({
    input: ConfigTargetEditInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  'config.auth.set': Object.freeze({
    input: ConfigAuthSetInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  'config.hook.add': Object.freeze({
    input: ConfigHookAddInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  'config.project.scaffold': Object.freeze({
    input: ConfigProjectScaffoldInputSchema,
    output: ConfigChangeOutputSchema,
  }),
  // the three knowledge changes answer what they applied.
  'knowledge.accept': Object.freeze({
    input: KnowledgeAcceptChangeInputSchema,
    output: KnowledgeChangeOutputSchema,
  }),
  'knowledge.reject': Object.freeze({
    input: KnowledgeRejectChangeInputSchema,
    output: KnowledgeChangeOutputSchema,
  }),
  'knowledge.forget': Object.freeze({
    input: KnowledgeForgetChangeInputSchema,
    output: KnowledgeChangeOutputSchema,
  }),
  'entities.resolve': Object.freeze({
    input: EntitiesResolveInputSchema,
    output: EntityCardResolutionSchema,
  }),
  'entities.get': Object.freeze({
    input: EntitiesGetInputSchema,
    output: EntityCardSchema,
  }),
  // the canonical list contract — `RunsListOutputSchema` as the
  // validator, the same object `runs.list` enforces with, plus its explicit output document.
  'runs.list': Object.freeze({
    input: RunsListInputSchema,
    output: RunsListOutputContract,
  }),
  'runs.digest': Object.freeze({
    input: RunsDigestInputSchema,
    output: RunDigestSchema,
  }),
  // the eight reads keep their ops' own contracts. The
  // evidence arms use the canonical output contracts, whose validators are the runtime schemas.
  'knowledge.bundles.list': Object.freeze({
    input: KnowledgeBundlesListInputSchema,
    output: KnowledgeBundlesListOutputSchema,
  }),
  'knowledge.records.inspect': Object.freeze({
    input: KnowledgeRecordsInspectInputSchema,
    output: KnowledgeRecordsInspectOutputSchema,
  }),
  'knowledge.records.diff': Object.freeze({
    input: KnowledgeRecordsDiffInputSchema,
    output: KnowledgeRecordsDiffOutputSchema,
  }),
  'knowledge.record.show': Object.freeze({
    input: KnowledgeRecordShowInputSchema,
    output: KnowledgeRecordShowResultSchema,
  }),
  'knowledge.brief.why': Object.freeze({
    input: BriefWhyInputSchema,
    output: BriefWhyResultSchema,
  }),
  'runs.knowledge': Object.freeze({
    input: RunsKnowledgeInputSchema,
    output: RunKnowledgeProjectionSchema,
  }),
  'runs.overview': Object.freeze({
    input: RunsOverviewInputSchema,
    output: RunOverviewProjectionSchema,
  }),
  'runs.evidence': Object.freeze({
    input: RunsEvidenceInputSchema,
    output: RunsEvidenceOutputContract,
  }),
  'runs.artifact': Object.freeze({
    input: RunsArtifactInputSchema,
    output: RunsArtifactOutputContract,
  }),
})

/**
 * THE CATALOGUE. Twenty tools.
 * (Sixteen until 2026-09-28, when 431 D-01 added the eight discovery reads; twenty-four until
 * 2026-09-30, when 432-12 removed the four proposal tools.)
 *
 * The read side is D-02: one universal entity door plus the reads a workflow needs mid-flight and
 * the 431 discovery reads. The write side changes things IN THE CALL: every
 * `workflow` entry writes what it names and answers what it changed, and nothing waits for a second
 * call. There is no apply tool, no `confirmed` input and no elicitation; the mark door is the one
 * `apply` entry, and since 432-21 it checks no credential.
 *
 * WHY THERE IS NO PROPOSAL TOOL AT ALL. The inbox's verbs declared a human-origin requirement, so a
 * tool over either decision verb would have listed for every caller and refused every call.
 * 432-12 unprojected the whole inbox and 432-17 deleted it, ops and all (re-spelled 2026-10-02,
 * 432-42).
 */
export const AGENT_QA_TOOL_PROJECTIONS: readonly ToolProjection[] = Object.freeze([
  Object.freeze({
    name: 'agent_qa_write_test',
    ops: Object.freeze(['authoring.draft.write']),
    kind: 'workflow',
  }),
  Object.freeze({
    name: 'agent_qa_refine_test',
    ops: Object.freeze(['authoring.draft.edit', 'authoring.draft.verify']),
    kind: 'workflow',
    discriminant: TOOL_FOLD_DISCRIMINANT,
  }),
  Object.freeze({
    name: 'agent_qa_start_run',
    ops: Object.freeze(['runs.start']),
    kind: 'workflow',
    // a run starts and is immediately watchable. The ack carries the runId, so the
    // per-call reference is derived from the OUTPUT.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'output' } as const),
  }),
  // the config change tool writes in the call. The undo arm is gone.
  Object.freeze({
    name: 'agent_qa_change_config',
    ops: Object.freeze([
      'config.field.set',
      'config.target.create',
      'config.target.edit',
      'config.auth.set',
      'config.hook.add',
      'config.project.scaffold',
    ]),
    kind: 'workflow',
    discriminant: TOOL_FOLD_DISCRIMINANT,
  }),
  // accept, reject and forget apply in the call. Forget is the
  // explicit removal; a wrong record is otherwise corrected by new feedback.
  Object.freeze({
    name: 'agent_qa_change_knowledge',
    ops: Object.freeze([
      'knowledge.accept',
      'knowledge.reject',
      'knowledge.forget',
    ]),
    kind: 'workflow',
    discriminant: TOOL_FOLD_DISCRIMINANT,
  }),
  Object.freeze({
    name: 'agent_qa_mark_run',
    ops: Object.freeze(['runs.mark']),
    kind: 'apply',
  }),
  // marks history and the mark consequence preview beside the mark
  // writer. Both are read projections with no apply envelope, so `agent_qa_mark_run` stays the
  // only door that lands a mark.
  Object.freeze({
    name: 'agent_qa_get_run_marks',
    ops: Object.freeze(['runs.marks.history']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_preview_run_mark',
    ops: Object.freeze(['runs.mark.preview']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_list_knowledge_gates',
    ops: Object.freeze(['knowledge.gates.list']),
    kind: 'read',
  }),
  // the knowledge reads, named one-to-one with their CLI verbs.
  Object.freeze({
    name: 'agent_qa_list_knowledge_bundles',
    ops: Object.freeze(['knowledge.bundles.list']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_inspect_knowledge_records',
    ops: Object.freeze(['knowledge.records.inspect']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_diff_knowledge_records',
    ops: Object.freeze(['knowledge.records.diff']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_show_knowledge_record',
    ops: Object.freeze(['knowledge.record.show']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_explain_brief',
    ops: Object.freeze(['knowledge.brief.why']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_get_entity',
    ops: Object.freeze(['entities.resolve', 'entities.get']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_list_runs',
    ops: Object.freeze(['runs.list']),
    kind: 'read',
  }),
  Object.freeze({
    name: 'agent_qa_get_run_digest',
    ops: Object.freeze(['runs.digest']),
    kind: 'read',
    // the watch/status read, and therefore the LATE-ATTACH door — a run started
    // from the CLI, from CI or from the dashboard is watchable through it exactly as an
    // MCP-started one is, because a viewer attaches and never owns. Its runId is on the INPUT.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'input' } as const),
  }),
  // one completed run's whole reads. The overview is the map, run
  // knowledge the whole used-and-learned projection unchanged, and evidence one addressed document
  // or blob. All three carry the result-size hint.
  Object.freeze({
    name: 'agent_qa_get_run_overview',
    ops: Object.freeze(['runs.overview']),
    kind: 'read',
    maxResultSizeChars: RUN_READ_MAX_RESULT_SIZE_CHARS,
  }),
  Object.freeze({
    name: 'agent_qa_get_run_knowledge',
    ops: Object.freeze(['runs.knowledge']),
    kind: 'read',
    maxResultSizeChars: RUN_READ_MAX_RESULT_SIZE_CHARS,
  }),
  Object.freeze({
    name: 'agent_qa_get_run_evidence',
    ops: Object.freeze(['runs.evidence', 'runs.artifact']),
    kind: 'read',
    discriminant: TOOL_FOLD_DISCRIMINANT,
    maxResultSizeChars: RUN_READ_MAX_RESULT_SIZE_CHARS,
  }),
] as const satisfies readonly ToolProjection[])

/**
 * Tool name -> the contract that tool ADVERTISES, where it is not simply its one op's contract.
 *
 * Exactly two reasons an entry exists here, and no third:
 *
 *  1. A UNION FOLD validates with the discriminated union of its arms' own DTOs, composed in
 *     `@vostride/agent-qa-schema` (see `functions/tool-folds.ts` for why it is composed there and
 *     not here). Its output is the union of the arms' own outputs, collapsed when they are one.
 *     Its input is listed as one object by `projection.ts`.
 *  2. THE PIPELINE advertises the FIRST op's contract on both sides: a caller hands `entities.resolve`
 *     the reference it has, and reads back the resolution union — a card, a small disambiguation
 *     set, or an honest miss. `entities.get` runs inside the resolved arm and contributes no shape
 *     of its own, which is why its contract is absent from the advertisement.
 *
 * THE MARK DOOR'S ENTRY IS DELETED. It advertised the op's outcome OR the
 * credential refusal; the refusal left with the MCP bearer credential, so the door
 * advertises exactly its op's own contracts and needs no entry. (The D-11 apply envelope it once
 * carried, `proposal_id` and `confirmed`, went with the apply tools in 432-12, D-05/D-14.)
 */
export const AGENT_QA_COMPOSED_CONTRACTS: Readonly<Record<string, ToolOpContracts>> = Object.freeze({
  agent_qa_refine_test: Object.freeze({
    input: AuthoringRefineFoldInputSchema,
    output: AuthoringRefineFoldOutputSchema,
  }),
  agent_qa_change_config: Object.freeze({
    input: ConfigChangeFoldInputSchema,
    output: ConfigChangeFoldOutputSchema,
  }),
  agent_qa_change_knowledge: Object.freeze({
    input: KnowledgeChangeFoldInputSchema,
    output: KnowledgeChangeFoldOutputSchema,
  }),
  // the evidence fold, composed in the schema package from both arms'
  // canonical contracts and routed by full op id.
  agent_qa_get_run_evidence: Object.freeze({
    input: RunsEvidenceFoldInputSchema,
    output: RunsEvidenceFoldOutputContract,
  }),
  agent_qa_get_entity: Object.freeze({
    input: EntitiesResolveInputSchema,
    output: EntityCardResolutionSchema,
  }),
})

/** The contract a tool advertises: its composition when it has one, its one op's otherwise. */
export function advertisedContracts(
  projection: ToolProjection,
): ToolOpContracts | undefined {
  const composed = AGENT_QA_COMPOSED_CONTRACTS[projection.name]
  if (composed !== undefined) return composed
  const [only] = projection.ops
  return only === undefined ? undefined : AGENT_QA_OP_CONTRACTS[only]
}

/**
 * A tool whose advertised OUTPUT cannot be represented as JSON Schema, and therefore ships with no
 * `outputSchema` at all (2026-08-16, D-16's explicit-degradation clause).
 *
 * MEASURED, NOT PREDICTED. `tools/list` converts every `outputSchema` in zod's OUTPUT mode
 * (`mcp-DXXb3Vv3.mjs:1391`, uncaught), and a contract built over a branded id — `z.string()
 * .transform(asRunId)` — makes that conversion throw `Transforms cannot be represented in JSON
 * Schema`. The consequence is not a poorer listing for one tool: the throw takes the WHOLE
 * `tools/list` response down for every caller who can see the tool. Phase 384 hit the same wall from
 * the other side and answered it by projecting both sides in input mode (`declaration-projection.ts`).
 *
 * WHY OMISSION RATHER THAN A SECOND CONVERSION. Advertising the INPUT-mode document as the output
 * would have worked and been a lie of exactly the kind D-16 forbids: a schema derived by a second
 * recipe, no longer the object `invokeFunction` validates with, presented as though it were. What a
 * caller gets instead is `content` plus `structuredContent` and no advertised shape — less, and
 * true. `validateToolOutput` skips a tool with no `outputSchema`, so the result still flows.
 *
 * THE LIST IS TWO-SIDED. `projection.ts` PROBES the conversion for every tool: an undeclared
 * failure throws, and a declared entry whose contract has since become convertible throws too. So
 * this list cannot silently grow and cannot silently rot.
 *
 * the way off this list is a canonical `OutputContract` from
 * `@vostride/agent-qa-schema` — the op's own runtime schema as validator, with an explicit output
 * document — never a narrowed stand-in authored here. `agent_qa_start_run` keeps its row.
 */
export interface OutputSchemaDegradation {
  readonly tool: string
  readonly opId: string
  /** The schema symbol whose transform the converter refused, for a reader chasing the cause. */
  readonly schema: string
  /** The converter's own message, verbatim. */
  readonly measured: string
}

export const DEGRADED_OUTPUT_CONTRACTS: readonly OutputSchemaDegradation[] = Object.freeze([
  // The branded run id is a transform; un-branding it would trade type safety for one listing.
  Object.freeze({
    tool: 'agent_qa_start_run',
    opId: 'runs.start',
    schema: 'RunStartAcknowledgementSchema',
    measured: 'Transforms cannot be represented in JSON Schema',
  }),
] as const satisfies readonly OutputSchemaDegradation[])

// Every registry op is projected above or listed here; parity.test.ts checks the partition.
export interface UnprojectedOp {
  readonly opId: string
  readonly reason: string
}

const NOT_MID_FLIGHT_READ =
  'not a mid-flight workflow read: this surface carries only the reads a workflow needs while it '
  + 'runs'

const NOT_MID_FLIGHT_WRITE =
  'not a mid-flight workflow write: this surface carries only the writes a workflow needs while it '
  + 'runs'

export const UNPROJECTED_OPS: readonly UnprojectedOp[] = Object.freeze([
  Object.freeze({
    opId: 'agent.ask',
    reason:
      'Ask over MCP is nested-agent delegation: a tool call would spend this project\'s model '
      + 'tokens, take the lease the local host holds and stream through a channel a single '
      + '`tools/call` round trip has no shape for.',
  }),
  Object.freeze({
    opId: 'runs.get',
    reason:
      'not a mid-flight workflow read: the entity door renders a run\'s card and the digest '
      + 'carries what triage needs',
  }),
  Object.freeze({
    opId: 'runs.events',
    reason:
      'not a mid-flight workflow read, and a stream besides: a `tools/call` is one round trip and '
      + 'has no shape for a resumable event feed',
  }),
  Object.freeze({
    opId: 'runs.postprocessing',
    reason: NOT_MID_FLIGHT_READ,
  }),
  Object.freeze({
    opId: 'runs.detail',
    reason:
      'not a mid-flight workflow read: it is a completed run\'s whole step tree, read by the '
      + 'run-detail page, and a large one-shot payload with no shape a `tools/call` round trip '
      + 'wants',
  }),
  Object.freeze({
    opId: 'runs.liveurl',
    reason:
      'The op MINTS A CREDENTIAL, a short-lived view token for a running browser: the MCP server '
      + 'mints it only inside its App-rendering path and writes it into the frame src of the '
      + 'unlisted `ui://agent-qa/live-run/{runId}` resource, so a mint tool would put the '
      + 'credential on a channel a model reads by default.',
  }),
  Object.freeze({
    opId: 'editor.liveurl',
    reason:
      'The op MINTS A CREDENTIAL, a view credential for a live editor session that is private to '
      + 'the dashboard page owning it, so it is reachable only through the dashboard door and '
      + 'never through an MCP tool or the MCP App live-run resource.',
  }),
  Object.freeze({
    opId: 'config.get',
    reason: NOT_MID_FLIGHT_READ,
  }),
  Object.freeze({
    opId: 'analysis.get',
    reason: NOT_MID_FLIGHT_READ,
  }),
  Object.freeze({
    opId: 'authoring.funnel.get',
    reason: NOT_MID_FLIGHT_READ,
  }),
  Object.freeze({
    opId: 'quarantine.add',
    reason: NOT_MID_FLIGHT_WRITE,
  }),
  Object.freeze({
    opId: 'quarantine.release',
    reason: NOT_MID_FLIGHT_WRITE,
  }),
  Object.freeze({
    opId: 'quarantine.list',
    reason: NOT_MID_FLIGHT_READ,
  }),
  Object.freeze({
    opId: 'agent.explain',
    reason:
      'The protocol answers machine discovery itself through `tools/list` and SEP-2575 '
      + '`server/discover`, and `init --agent` answers agent discovery from the committed catalog; '
      + 'this op answers a person asking in prose, which a discovery tool would only restate.',
  }),
] as const satisfies readonly UnprojectedOp[])
