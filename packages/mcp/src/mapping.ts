// Static data: which tool fronts which ops, ranged by the cli parity suite (SEP-2567, SEP-2549).

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

// Derived from the entry rather than stated, so a fold can never be declared `single`.
export type ToolComposition = 'single' | 'union' | 'pipeline'

/** The tool-listing `_meta` key a host reads as the largest result it should keep. */
export const MAX_RESULT_SIZE_META_KEY = 'anthropic/maxResultSizeChars'

export const RUN_READ_MAX_RESULT_SIZE_CHARS = 100000

/** One declared tool. */
export interface ToolProjection {
  /** Curated `verb_noun` name per spec section 3.3. */
  readonly name: string
  /** The registry op ids this tool projects. Length 1 = 1:1; length > 1 = a declared fold. */
  readonly ops: readonly string[]
  readonly kind: ToolProjectionKind
  /**
   * A union fold's discriminant key — absent on a 1:1 tool AND on the pipeline.
   *
   * Its presence is what tells a fold from a pipeline, which is why it is spelled per entry rather
   * than assumed from `ops.length > 1`.
   */
  readonly discriminant?: string
  // Presence marks a carrier; `runIdFrom` says whether the run id is on the input or the result.
  readonly ui?: {
    readonly resource: 'live-run'
    readonly runIdFrom: 'input' | 'output'
  }
  // Present only on reads whose one-shot answer can outgrow a host's default result budget.
  readonly maxResultSizeChars?: number
}

/** The composition, read off the entry. See {@link ToolComposition}. */
export function compositionOf(projection: ToolProjection): ToolComposition {
  if (projection.ops.length === 1) return 'single'
  return projection.discriminant === undefined ? 'pipeline' : 'union'
}

// The ops' own live validators, so the advertised schema and `invokeFunction`'s cannot disagree.
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
  // The preview takes `runs.mark`'s exact input and answers the read-only plan result.
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
  // `RunsListOutputSchema` is the same validator `runs.list` enforces with.
  'runs.list': Object.freeze({
    input: RunsListInputSchema,
    output: RunsListOutputContract,
  }),
  'runs.digest': Object.freeze({
    input: RunsDigestInputSchema,
    output: RunDigestSchema,
  }),
  // The evidence arms use the canonical output contracts, whose validators are the runtime schemas.
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

// Write tools change things in the call and answer what changed; nothing waits for a second call.
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
    // The ack carries the run id, so the per-call reference comes from the output.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'output' } as const),
  }),
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
  // Forget is the explicit removal; a wrong record is otherwise corrected by new feedback.
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
  // Both are reads, so `agent_qa_mark_run` stays the only door that lands a mark.
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
  // The knowledge reads, named one-to-one with their CLI verbs.
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
    // The late-attach door: a viewer attaches to any run, so the run id comes from the input.
    ui: Object.freeze({ resource: 'live-run', runIdFrom: 'input' } as const),
  }),
  // A completed run's whole reads, each carrying the result-size hint.
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

// Entries exist only for a union fold's composed contract and the pipeline's first-op contract.
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
  // Composed in the schema package from both arms' canonical contracts, routed by full op id.
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

// A transform makes the `tools/list` conversion throw for every caller, so no output schema.
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
