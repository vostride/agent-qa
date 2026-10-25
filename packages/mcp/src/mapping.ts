// The declared tool -> op mapping (Phase 396 plans 01 + 04, D-01 / D-03 / D-04 / D-16 · MCPS-02).
//
// WHY THIS FILE EXISTS. The v1 server carried its catalogue as 33 hand-written handlers, each free
// to reach data its own way; the whole point of the re-derivation is that a tool is a PROJECTION of
// a registry op and nothing else. What is left over once the handlers are gone is DATA — which tool
// names exist, which op ids each one stands in front of, and what class of thing it does — and this
// module is where that data lives so a single artifact can be pinned by the bump guard and ranged
// over by 397's parity suite. Anything that is not data belongs in `projection.ts` or `catalog.ts`.
//
// 2026-09-15, 423-21 D-04/D-18: sixteen tools over twenty-six registry ops; the other TWENTY-FIVE
// ops are listed below in `UNPROJECTED_OPS` with a reason each. Twenty-six plus twenty-five is the
// registry's own count, and `__tests__/mapping-bump-guard.test.ts` asserts that partition against
// the registry's enumeration rather than against the arithmetic in this sentence. The two new
// tools are the feedback reads (marks history and the mark consequence preview); the typed
// evidence read lands unprojected on `runs.detail`'s completed-run footing.
//
// 2026-09-25 (428 D-07): the unprojected side grows to TWENTY-SIX when `editor.liveurl` is
// registered; the projected side and the tool count do not move. The editor subject's mint is
// reachable only through the dashboard door, by ruling.
//
// 2026-09-28 (431-04 D-01/D-04/D-10): TWENTY-FOUR tools over THIRTY-FIVE registry ops; the other
// EIGHTEEN stay in `UNPROJECTED_OPS`, and the registry is fifty-three. `runs.overview` arrives
// projected, and eight reads move across: the five knowledge reads, `runs.knowledge`, and
// `runs.evidence` with `runs.artifact` behind one fold. Their prior rulings are kept verbatim in
// `PROJECTED_RULING_ADDENDA`, each with its dated 431 addendum.
//
// 2026-09-30 (432-12 D-05/D-02): TWENTY tools over THIRTY registry ops; the other TWENTY-THREE stay
// in `UNPROJECTED_OPS`, and the registry is still fifty-three. The two change tools are renamed
// `agent_qa_change_knowledge` and `agent_qa_change_config` and write in the call. The four proposal
// apply/list/show tools and the config undo arm are gone with no alias, and their five ops are
// dispositioned below until 432-17 deletes them from the registry.
//
// 2026-10-01 (432-17 D-05/D-02): TWENTY tools over THIRTY registry ops; the other SIXTEEN stay in
// `UNPROJECTED_OPS`, and the registry is forty-six. The seven proposal, apply and undo ops are
// deleted from the registry, so their five '432' dispositions and the two 397 dispositions of
// `proposals.accept` and `proposals.reject` leave the scoping note, and '432' leaves the adjudicator
// vocabulary with no member left to rule on.
//
// 2026-10-01 (432-18 D-14/D-15), written 2026-10-03 (quick-261003-tsr IN-28): TWENTY tools over
// THIRTY registry ops; the other FOURTEEN stay in `UNPROJECTED_OPS`, and the registry is forty-four.
// `grants.list` and `grants.revoke` are deleted with the grant ledger.
//
// 2026-08-17 (398 D-09): the unprojected side moved from nineteen to twenty when `agent.explain`
// was registered. This sentence is prose and the guard is the mechanism — but the prose is updated
// in the same change-set anyway, because a header that goes on stating a partition the code stopped
// having is the class of untruth the ops' own docstrings were caught in (397 D-18).
//
// 2026-08-29 (407-01 D-05): the unprojected side grows again, and the registry with it, when
// `runs.knowledge` is registered — so the partition holds with both sides one larger. Unprojected
// DELIBERATELY and on `runs.detail`'s footing: a completed run's whole used-and-learned projection
// is a large one-shot payload, not a mid-flight read. The guard is the mechanism; this sentence is
// updated in the same change-set for the reason the paragraph below states.
//
// 2026-08-25 (403-01 D-03): twenty to twenty-one, and the registry from forty-two to forty-three,
// when `runs.liveurl` was registered. Unprojected DELIBERATELY: minting a live-view capability
// token is handing out a credential, and whether an MCP caller may mint one is Phase 408's
// question (the MCP App embed) rather than a side effect of this phase registering the op.
//
// 2026-08-31 (408 D-01): that question is ANSWERED and the partition does not move for it. The
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
// capability declaration. The entry's own reason carries the full addendum; `app-resource.ts`'s
// header carries the ruling. The op stays unprojected on the same, stronger footing.
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
 * one arm's contract while the guard reports two arms and agrees with itself.
 */
export type ToolComposition = 'single' | 'union' | 'pipeline'

/** The tool-listing `_meta` key a host reads as the largest result it should keep (ADX-03). */
export const MAX_RESULT_SIZE_META_KEY = 'anthropic/maxResultSizeChars'

/** 431 D-05: the size hint the three whole-run reads carry. */
export const RUN_READ_MAX_RESULT_SIZE_CHARS = 100000

/** One declared tool. */
export interface ToolProjection {
  /** Curated `verb_noun` name per spec section 3.3 (D-04). The bump guard pins the exact list. */
  readonly name: string
  /** The registry op ids this tool projects. Length 1 = 1:1; length > 1 = a declared fold. */
  readonly ops: readonly string[]
  readonly kind: ToolProjectionKind
  // 2026-10-01 (432-21, D-12): the `credential?: 'required'` marker (419 D-20) is deleted with the
  // MCP bearer credential. No tool declares a credential and no handler reads one.
  /**
   * A union fold's discriminant key — absent on a 1:1 tool AND on the pipeline.
   *
   * Its presence is what tells a fold from a pipeline, which is why it is spelled per entry rather
   * than assumed from `ops.length > 1`.
   */
  readonly discriminant?: string
  /**
   * This tool CARRIES the live-view MCP App (2026-08-31, Phase 408 plan 01 · D-05 / MCPA-01).
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
   * INPUT, which is what makes it the late-attach door (D-07).
   *
   * THE TASK-SHAPE QUESTION D-05 LEFT OPEN IS CLOSED, and closed by measurement rather than by
   * preference: the task seam is dormant — "It registers nothing, advertises nothing and routes
   * nothing" (task-seam.ts:21-23, and catalog.ts:34-36 states the matching absence) — so both
   * carriers are plain tools answering immediate results, and there is no task completion or
   * status poll for a reference to ride. (2026-08-31; the 2.0.0 core SDK has since grown the Tasks
   * vocabulary, which makes the seam's own dated deferral stale at the SDK layer and changes
   * nothing here: registering Tasks is not this phase's job.)
   */
  readonly ui?: {
    readonly resource: 'live-run'
    readonly runIdFrom: 'input' | 'output'
  }
  /**
   * 2026-09-28 (431 D-05): the result-size hint, advertised as `_meta[MAX_RESULT_SIZE_META_KEY]`.
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
 * never leaves the function layer's own directory (T-384-01 / T-384-14), and what a surface can see
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
 * two protocol packages (D-20), so naming a validator library here — even in a type position, which
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
  // 2026-09-15, 423-21 D-18: the feedback reads keep their ops' own strict contracts. The preview
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
  // 2026-09-30 (432-12 D-05): the three knowledge changes answer what they applied.
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
  // 2026-09-28 (431-03, D-03/D-07): the canonical list contract — `RunsListOutputSchema` as the
  // validator, the same object `runs.list` enforces with, plus its explicit output document.
  'runs.list': Object.freeze({
    input: RunsListInputSchema,
    output: RunsListOutputContract,
  }),
  'runs.digest': Object.freeze({
    input: RunsDigestInputSchema,
    output: RunDigestSchema,
  }),
  // 2026-09-28 (431-04 D-04/D-05/D-07): the eight reads keep their ops' own contracts. The
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
 * THE CATALOGUE. Twenty tools, and the bump guard pins this exact list by name and by op set.
 * (Sixteen until 2026-09-28, when 431 D-01 added the eight discovery reads; twenty-four until
 * 2026-09-30, when 432-12 removed the four proposal tools.)
 *
 * The read side is D-02: one universal entity door plus the reads a workflow needs mid-flight and
 * the 431 discovery reads. The write side changes things IN THE CALL (432 D-05/D-14): every
 * `workflow` entry writes what it names and answers what it changed, and nothing waits for a second
 * call. There is no apply tool, no `confirmed` input and no elicitation; the mark door is the one
 * `apply` entry, and since 432-21 (D-12) it checks no credential.
 *
 * WHY THERE IS NO PROPOSAL TOOL AT ALL. The inbox's verbs declared a human-origin requirement, so a
 * tool over either decision verb would have listed for every caller and refused every call; the
 * bump guard stated the rule generally until 432-39 deleted the field. 432-12 unprojected the whole
 * inbox and 432-17 deleted it, ops and all (re-spelled 2026-10-02, 432-42).
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
    // 408 D-05: a run starts and is immediately watchable. The ack carries the runId, so the
    // per-call reference is derived from the OUTPUT.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'output' } as const),
  }),
  // 2026-09-30 (432-12 D-05): the config change tool writes in the call. The undo arm is gone.
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
  // 2026-09-30 (432-12 D-05/D-09): accept, reject and forget apply in the call. Forget is the
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
  // 2026-09-15, 423-21 D-18: marks history and the mark consequence preview beside the mark
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
  // 2026-09-28, 431 D-04: the knowledge reads, named one-to-one with their CLI verbs.
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
    // 408 D-05/D-07: the watch/status read, and therefore the LATE-ATTACH door — a run started
    // from the CLI, from CI or from the dashboard is watchable through it exactly as an
    // MCP-started one is, because a viewer attaches and never owns. Its runId is on the INPUT.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'input' } as const),
  }),
  // 2026-09-28, 431 D-05/D-06/D-07: one completed run's whole reads. The overview is the map, run
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
 *     Its input is listed as one object by `projection.ts` (2026-10-20, 446-11).
 *  2. THE PIPELINE advertises the FIRST op's contract on both sides: a caller hands `entities.resolve`
 *     the reference it has, and reads back the resolution union — a card, a small disambiguation
 *     set, or an honest miss. `entities.get` runs inside the resolved arm and contributes no shape
 *     of its own, which is why its contract is absent from the advertisement.
 *
 * 2026-10-01 (432-21, D-12): THE MARK DOOR'S ENTRY IS DELETED. It advertised the op's outcome OR the
 * credential refusal (419 D-20); the refusal left with the MCP bearer credential, so the door
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
  // 2026-09-28 (431-04 D-07): the evidence fold, composed in the schema package from both arms'
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
 * 2026-09-28 (431-03): the way off this list is a canonical `OutputContract` from
 * `@vostride/agent-qa-schema` — the op's own runtime schema as validator, with an explicit output
 * document — never a narrowed stand-in authored here. `agent_qa_start_run` keeps its row.
 */
export interface OutputSchemaDegradation {
  readonly tool: string
  readonly opId: string
  /** The schema symbol whose transform the converter refused, for a reader chasing the cause. */
  readonly schema: string
  /** The converter's own message, verbatim as measured on 2026-08-16. */
  readonly measured: string
  readonly adjudication: '397'
}

export const DEGRADED_OUTPUT_CONTRACTS: readonly OutputSchemaDegradation[] = Object.freeze([
  // 397 DISPOSITION (2026-08-16 · D-20): keep-degraded. `agent_qa_start_run` advertises no
  // `outputSchema` and keeps it that way. The cause is a property of the CONTRACT, not of this
  // surface — a branded run id is `z.string().transform(asRunId)`, and the converter refuses a
  // transform because there is no true JSON-Schema for "and then this function runs". The two ways
  // out are both worse: advertising the input-mode document is the second-recipe lie D-16 forbids,
  // and un-branding the id to please a converter would spend a type-safety property of the whole
  // codebase on one surface's listing. 397 rules the degradation ADJUDICATED and CLOSED rather than
  // pending; re-opening it means changing the contract, which is a golden-diff-visible act. The
  // absence itself is not re-pinned here — `projection.ts` probes the conversion both ways and the
  // shipped projection suite owns that fact (RESEARCH Pitfall 9); the conformance suite asserts
  // only the join.
  Object.freeze({
    tool: 'agent_qa_start_run',
    opId: 'runs.start',
    schema: 'RunStartAcknowledgementSchema',
    measured: 'Transforms cannot be represented in JSON Schema',
    adjudication: '397',
  }),
  // 2026-09-28 (431-03, D-03/D-07 · research A1): the `agent_qa_list_runs` row is REMOVED, not
  // re-ruled. Its objection stands — no hand-written array schema is advertised. What changed is the
  // contract: `runs.list` now declares `RunsListOutputContract`, whose validator is the same
  // `RunsListOutputSchema` object and whose output document is derived from the runtime schema's
  // own output conversion. It converts cleanly, so the probe in `projection.ts` would refuse the row.
] as const satisfies readonly OutputSchemaDegradation[])

/**
 * A registry op that this surface deliberately does NOT project, and why (2026-08-16 · D-03/D-15).
 *
 * THE DATED SCOPING NOTE IS THIS TABLE, not a comment beside it. 397's parity suite ranges over the
 * projected set, and a suite that scoped itself to whatever happened to be in the mapping would be
 * discovering an accident rather than honouring a decision. Every op the registry declares appears
 * either above or here — the bump guard asserts that partition against the registry's own
 * enumeration, so a new op cannot land undispositioned.
 *
 * `agent.ask` LEADS THE LIST because its exclusion is the one with a decision behind it (D-03).
 * Projecting the agent's own turn entry over MCP is nested-agent delegation: a caller's tool call
 * would spend this project's model tokens, take the lease the local host holds, and stream through a
 * channel a single `tools/call` round trip has no shape for — four independent reasons, and no MCPS
 * requirement asking for any of them. It is deferred as its own seam rather than left out by
 * oversight, and the deferral is dated so a later reader can tell the two apart.
 *
 * The rest are D-02's line — this surface carries the reads a workflow needs MID-FLIGHT and not the
 * whole catalogue — and the two ops that cannot serve an agent-origin caller at all.
 */
export interface UnprojectedOp {
  readonly opId: string
  readonly reason: string
  /**
   * Who decided this absence is not a gap.
   *
   * 397 for every op that existed when 397's parity walk ruled the whole register (D-15). WIDENED
   * to admit `'398'` on 2026-08-17 for `agent.explain`, and the widening is the honest move rather
   * than a convenience: 397 could not have adjudicated an op that did not exist, and stamping this
   * one `'397'` to keep a literal green would have made the field record a ruling nobody made — the
   * one thing a provenance column is for. The vocabulary is a CLOSED set and the bump guard pins
   * which entries carry which adjudicator by name, so it cannot widen again by habit.
   *
   * 405-05 adds `runs.artifact` under the SAME `'405'` stamp on the same day and by the same
   * ruling; the vocabulary does not widen for it.
   *
   * WIDENED AGAIN on 2026-08-27 (405-01, D-03) for `runs.detail`, on exactly the 398 and 403
   * reasoning and for no new one: 397 could not have ruled on an op registered eight phases
   * later. The bump guard names which entry carries this adjudicator, in both directions, so an
   * entry stamped `'405'` because it was easier reds there rather than joining a set that has
   * quietly become "any phase number".
   *
   * WIDENED AGAIN on 2026-08-29 (407-01, D-05) for `runs.knowledge`, on exactly that reasoning and
   * for no new one: 397 could not have ruled on an op registered ten phases later. Membership is
   * still spelled by op id in the bump guard, in both directions.
   *
   * RE-STAMPED on 2026-08-31 (408 D-01): `'403'` LEAVES this vocabulary and `'408'` enters. This is
   * not a widening and not a rename — it is the provenance moving with the ruling. `runs.liveurl`
   * was the ONLY `'403'` entry, and its 403 stamp recorded a DEFERRAL ("Phase 408's question");
   * 408 D-01 answered that question, so the phase that decided this absence is now 408 and saying
   * `'403'` would credit 403 with a ruling it explicitly declined to make. Leaving `'403'` in a
   * closed set with no member would also be exactly the empty literal the bump guard's
   * non-vacuity check passes silently over, which is the hole that check exists to close.
   */
  // WIDENED AGAIN on 2026-09-15 (423-21, D-04) for `runs.evidence`, on the same reasoning: 397
  // could not have ruled on an op registered in 423. Membership is spelled by op id in the guard.
  // WIDENED AGAIN on 2026-09-25 (428 D-07) for `editor.liveurl`, on the same reasoning.
  // NARROWED on 2026-09-28 (431-04 D-10): `'407'` and `'423'` LEAVE. Their only members,
  // `runs.knowledge` and `runs.evidence`, are projected, and a member-less literal is the hole the
  // guard's non-vacuity check exists to close (the 408 re-stamp precedent). Their rulings live on in
  // `PROJECTED_RULING_ADDENDA`.
  // WIDENED on 2026-09-30 (432-12, D-05) for the five pre-432 proposal ops that leave the projected
  // side: the ruling that removed their tools is 432's, and 432-17 deletes the ops themselves.
  // NARROWED on 2026-10-01 (432-17, D-05): the five ops are deleted from the registry, so `'432'`
  // LEAVES with no member, on the 431-04 precedent above.
  readonly adjudication: UnprojectedAdjudication
}

/** The closed adjudicator vocabulary as a runtime tuple; the type above is derived from it. */
export const UNPROJECTED_ADJUDICATIONS = Object.freeze(['397', '398', '405', '408', '428'] as const)

export type UnprojectedAdjudication = (typeof UNPROJECTED_ADJUDICATIONS)[number]

export const UNPROJECTED_OPS: readonly UnprojectedOp[] = Object.freeze([
  Object.freeze({
    opId: 'agent.ask',
    reason:
      'D-03 (dated 2026-08-15): ask-over-MCP is nested-agent delegation — trust, token-driven LLM '
      + 'spend, lease interaction and streaming are four separate problems and no MCPS requirement '
      + 'asks for any of them. Deferred as its own seam, not omitted by oversight.',
    adjudication: '397',
  }),
  // 2026-10-01 (432-17, D-05): `proposals.accept` and `proposals.reject` (397, requiresHumanOrigin)
  // are deleted with the inbox and leave the scoping note.
  // 2026-10-01 (432-18, D-14/D-15): `grants.revoke` (397, requiresHumanOrigin) and `grants.list`
  // (397, not a mid-flight read) are deleted with the grant ledger and leave the scoping note.
  Object.freeze({
    opId: 'runs.get',
    reason:
      'not a mid-flight workflow read per D-02 — the entity door renders a run\'s card and the '
      + 'digest carries what triage needs; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'runs.events',
    reason:
      'not a mid-flight workflow read per D-02, and a stream op besides: a `tools/call` is one '
      + 'round trip and has no shape for a resumable event feed; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'runs.postprocessing',
    reason: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'runs.detail',
    reason:
      'D-03 (dated 2026-08-27, 405-01): not a mid-flight workflow read per D-02 — this is a '
      + 'COMPLETED run\'s projected step tree, read by the durable run-detail page, and the '
      + 'entity door already renders a run\'s card while the digest carries what triage needs. '
      + 'The whole projection of a run is also a large one-shot payload with no shape a '
      + '`tools/call` round trip wants. Deferred as its own seam, not omitted.',
    adjudication: '405',
  }),
  Object.freeze({
    opId: 'runs.liveurl',
    reason:
      'D-03 (dated 2026-08-25, 403-01): the op MINTS A CREDENTIAL — a short-lived, view-scoped '
      + 'capability token for a running browser. Whether an agent-origin MCP caller may mint one, '
      + 'and what it may hand it to, is Phase 408\'s question (the MCP App embed); projecting it '
      + 'here would answer that question by accident. Deferred as its own seam, not omitted. '
      + 'ANSWERED (dated 2026-08-31, 408 D-01): the deferral above is discharged, and the ruling '
      + 'is INTERNAL MINT ONLY. The MCP server invokes this op BY REFERENCE, inside its '
      + 'App-rendering path and nowhere else, and the minted token lands only in the '
      + 'host-rendered HTML of the unlisted `ui://agent-qa/live-run/{runId}` App resource — '
      + 'never in tool-result text a model reads. Projecting a mint tool stays REJECTED: a live '
      + 'credential in model context is the T-395-R5-10 shape, and masking it would leave a tool '
      + 'that hands back nothing a host could use. The op therefore STAYS unprojected BY RULING '
      + 'rather than by deferral — answered on the record, never silently reclassified. '
      + 'RE-GROUNDED (dated 2026-09-01, 408 gap round, road `demote`; the full ruling is in '
      + "`app-resource.ts`'s header). The answer above STANDS and one half of its stated property "
      + 'is corrected rather than deleted. Whether the document this server serves is '
      + 'host-rendered HTML or text a model consumes is a property of the CALLER, not of this '
      + 'server, so the "never in tool-result text a model reads" half over-claimed. What this '
      + 'server guarantees is narrower and it is verifiable: it writes the token into exactly one '
      + 'place, the frame src of the document the `ui://` read serves, and that door is reachable '
      + 'by any caller of a composition whose mint is bound (dated 2026-10-01, 432-20/432-21, '
      + 'D-12: the scope gate that once also bounded it is deleted for every caller, and the '
      + 'loopback bind and the Host/Origin guards still bound who can reach it). The op STAYS '
      + 'unprojected on exactly '
      + 'the same footing, and the reason is unchanged and STRONGER rather than weaker: a '
      + 'projected mint tool would put the credential on a channel a model consumes BY DEFAULT, '
      + 'on every call, for every caller, whereas the `ui://` read is an unlisted address a '
      + 'caller must already know and deliberately ask for.',
    adjudication: '408',
  }),
  Object.freeze({
    opId: 'editor.liveurl',
    reason:
      'D-07 (dated 2026-09-25, 428): the op MINTS A CREDENTIAL — a view credential for a live '
      + 'EDITOR session, which is private to the dashboard page that owns it; it is reachable only '
      + 'through the dashboard door and never through an MCP tool or the MCP App live-run '
      + 'resource. Projecting it would give an agent a watch carrier for a draft execution, which '
      + 'the owner declined in D-07. Unprojected by ruling, not by deferral.',
    adjudication: '428',
  }),
  Object.freeze({
    opId: 'config.get',
    reason: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'analysis.get',
    reason: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'authoring.funnel.get',
    reason: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'quarantine.add',
    reason: 'not a mid-flight workflow write per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'quarantine.release',
    reason: 'not a mid-flight workflow write per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  Object.freeze({
    opId: 'quarantine.list',
    reason: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    adjudication: '397',
  }),
  // 398 D-09 (dated 2026-08-17): the twentieth entry, and the FIRST op ever dispositioned here that
  // 397 did not rule on — because it did not exist then. Its exclusion is argued rather than scoped,
  // which is why it does not take the mid-flight line: `agent.explain` answers "what can you do",
  // and 397 already ruled the v1 discovery tool NOT a gap on this surface, because the protocol
  // answers machine discovery itself. Projecting it anyway would be the third answer that ruling
  // refuses.
  Object.freeze({
    opId: 'agent.explain',
    reason:
      'D-09 (dated 2026-08-17): the protocol answers machine discovery itself — `tools/list` plus '
      + 'SEP-2575 `server/discover` — and 398\'s `init --agent` manifest answers agent discovery '
      + 'from the committed catalog. This op answers a PERSON asking in prose, which is a third '
      + 'question with a third audience. 397 ruled the v1 discovery TOOL not-a-gap '
      + 'on exactly this reasoning; projecting the op would reinstate it under a new name.',
    adjudication: '398',
  }),
  // 2026-09-30 (432-12 D-05): the five pre-432 proposal ops went off the catalogue with their
  // tools. 2026-10-01 (432-17 D-05): they are deleted from the registry and leave the scoping note.
] as const satisfies readonly UnprojectedOp[])

/**
 * An op that LEFT `UNPROJECTED_OPS` for the projected side, with the ruling it was held under.
 *
 * 2026-09-28 (431-04 D-10). The ruling is kept verbatim and the dated 431 addendum says what
 * answered it, so the history a reader chased through the scoping note does not vanish when the
 * entry moves. `ruledBy` is historical provenance, not the live adjudicator vocabulary.
 */
export interface ProjectedRuling {
  readonly opId: string
  readonly ruledBy: string
  readonly ruling: string
  readonly addendum: string
}

export const PROJECTED_RULING_ADDENDA: readonly ProjectedRuling[] = Object.freeze([
  Object.freeze({
    opId: 'knowledge.bundles.list',
    ruledBy: '397',
    ruling: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    addendum:
      'D-01/D-04 (dated 2026-09-28, 431-04): projected as `agent_qa_list_knowledge_bundles`. A coding agent in a fresh '
      + 'workspace reads knowledge only through structured channels, so the committed-knowledge '
      + 'reads are served here rather than left to files; this supersedes the 2026-09-14 decision '
      + 'that projected the six safe reads only, whose no-search half stands (D-09).',
  }),
  Object.freeze({
    opId: 'knowledge.records.inspect',
    ruledBy: '397',
    ruling: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    addendum:
      'D-01/D-04 (dated 2026-09-28, 431-04): projected as `agent_qa_inspect_knowledge_records`. A coding agent in a fresh '
      + 'workspace reads knowledge only through structured channels, so the committed-knowledge '
      + 'reads are served here rather than left to files; this supersedes the 2026-09-14 decision '
      + 'that projected the six safe reads only, whose no-search half stands (D-09).',
  }),
  Object.freeze({
    opId: 'knowledge.records.diff',
    ruledBy: '397',
    ruling: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    addendum:
      'D-01/D-04 (dated 2026-09-28, 431-04): projected as `agent_qa_diff_knowledge_records`. A coding agent in a fresh '
      + 'workspace reads knowledge only through structured channels, so the committed-knowledge '
      + 'reads are served here rather than left to files; this supersedes the 2026-09-14 decision '
      + 'that projected the six safe reads only, whose no-search half stands (D-09).',
  }),
  Object.freeze({
    opId: 'knowledge.record.show',
    ruledBy: '397',
    ruling: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    addendum:
      'D-01/D-04 (dated 2026-09-28, 431-04): projected as `agent_qa_show_knowledge_record`. A coding agent in a fresh '
      + 'workspace reads knowledge only through structured channels, so the committed-knowledge '
      + 'reads are served here rather than left to files; this supersedes the 2026-09-14 decision '
      + 'that projected the six safe reads only, whose no-search half stands (D-09).',
  }),
  Object.freeze({
    opId: 'knowledge.brief.why',
    ruledBy: '397',
    ruling: 'not a mid-flight workflow read per D-02; 397 adjudicates',
    addendum:
      'D-01/D-04 (dated 2026-09-28, 431-04): projected as `agent_qa_explain_brief`. A coding agent in a fresh '
      + 'workspace reads knowledge only through structured channels, so the committed-knowledge '
      + 'reads are served here rather than left to files; this supersedes the 2026-09-14 decision '
      + 'that projected the six safe reads only, whose no-search half stands (D-09).',
  }),
  Object.freeze({
    opId: 'runs.knowledge',
    ruledBy: '407',
    ruling:
      'D-05 (dated 2026-08-29, 407-01): not a mid-flight workflow read per D-02 — this is a '
      + "COMPLETED run's used-and-learned projection, read by the durable Knowledge tab, and it is "
      + 'unprojected on exactly the footing its sibling `runs.detail` is. It carries every step\'s '
      + "three served brief channels, each one's serve-time retrieval trace and the truncated "
      + 'candidate ledger beside it, so it is a large one-shot payload with no shape a '
      + '`tools/call` round trip wants — larger than the step tree, not smaller. A planner '
      + 'mid-flight also has no use for what a FINISHED run was briefed with; the entity door '
      + "already renders a record's card and the digest carries what triage needs. Deferred as its "
      + 'own seam, not omitted.',
    addendum:
      'D-05 (dated 2026-09-28, 431-04): projected as `agent_qa_get_run_knowledge`, answering the '
      + 'whole `runs.knowledge` projection unchanged; the owner declined a step filter. The size '
      + 'objection above is answered in these terms: `agent_qa_get_run_overview` is the entry point '
      + 'that maps a run without bodies, `agent_qa_explain_brief` and '
      + '`agent_qa_show_knowledge_record` are the drill-down, and the tool carries a '
      + '100000-character result-size hint so a host keeps the one-shot answer whole.',
  }),
  Object.freeze({
    opId: 'runs.evidence',
    ruledBy: '423',
    ruling:
      'D-04 (dated 2026-09-15, 423-21): not a mid-flight workflow read per D-02 — this is one '
      + "COMPLETED run step's parsed evidence document (console, network, variables, accessibility "
      + 'or ARIA), read by the dashboard evidence tabs, and it is unprojected on exactly the footing '
      + 'its sibling `runs.detail` is. A network document alone may carry hundreds of records, so it '
      + 'is a large one-shot payload with no shape a `tools/call` round trip wants, and a planner '
      + 'mid-flight has no use for a finished step\'s captured traffic. The raw SHA bytes stay on '
      + '`runs.artifact` and the two HTTP doors. Deferred as its own seam, not omitted.',
    addendum:
      'D-07 (dated 2026-09-28, 431-04): projected as the `runs.evidence` arm of '
      + '`agent_qa_get_run_evidence`. A caller asks for ONE step document by the exact address '
      + '`agent_qa_get_run_overview` supplies, so the answer is one addressed document rather than '
      + "a run's captured traffic. Masking is unchanged: the op stays on the cold read-scope "
      + 'allowlist. The tool carries the 100000-character result-size hint.',
  }),
  Object.freeze({
    opId: 'runs.artifact',
    ruledBy: '405',
    ruling:
      'D-12/D-13 (dated 2026-08-27, 405-05): not a mid-flight workflow read per D-02 — this '
      + 'resolves ONE completed run\'s content-addressed evidence blob, and its result is a '
      + 'base64 body. A `tools/call` round trip is the wrong carriage for bytes: a conversation '
      + 'cannot render a PNG, and a tool that returned one would spend a context window on a '
      + 'payload no reader can read. The two HTTP doors are its carriage, and 408\'s embed is the '
      + 'surface that renders it. Deferred as its own seam, not omitted. '
      + 'Phase 424 (dated 2026-09-20): the recording fact rides runs.detail; runs.artifact '
      + 'answers a bounded slice when range is supplied; pulling a whole recording through unary '
      + 'base64 is permitted and not recommended; no recording tool is projected because the '
      + 'MX ceiling of 22 is fully allocated.',
    addendum:
      'D-07 (dated 2026-09-28, 431-04): projected as the `runs.artifact` arm of '
      + '`agent_qa_get_run_evidence`. The blob is addressed by the sha the overview supplies, with no '
      + 'step-to-sha lookup inside the tool, and the rendering objection is answered by the image '
      + 'result arm 431-05 adds. The Phase 424 note that the MX ceiling of 22 was fully allocated is '
      + 'superseded: the ceiling is 24 (D-01).',
  }),
] as const satisfies readonly ProjectedRuling[])
