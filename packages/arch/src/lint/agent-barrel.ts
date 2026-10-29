// Exact equality, value and type sets apart: a contains check misses a dispatch path added beside.

import { parseModuleStatements, stripCodeComments } from './evaluate-pin.js'

/** The pinned barrel, repo-relative. */
export const AGENT_BARREL_FILE = 'packages/agent/src/index.ts'

// Sorted: the list is compared with the barrel's sorted export set position by position.
export const EXPECTED_AGENT_BARREL_VALUE_EXPORTS: readonly string[] = [
  'AGENT_ASK_FUNCTION_ID',
  'ANALYSIS_GET_FUNCTION_ID',
  'ANSWER_ONLY_TOOL_NAME',
  'AUTHORING_DRAFT_EDIT_FUNCTION_ID',
  'AUTHORING_DRAFT_VERIFY_FUNCTION_ID',
  'AUTHORING_DRAFT_WRITE_FUNCTION_ID',
  'AUTHORING_FUNNEL_GET_FUNCTION_ID',
  'AUTHORING_LOOP_STAGES',
  'AmbiguousStepAddressError',
  'CHAT_DIRECTIVES',
  'CHAT_HELP_ENTRIES',
  'CHAT_HELP_TEXT',
  'CHAT_MINIMUM_CONTEXT',
  'CHAT_RESOLVER_TABLE',
  'COMPACTION_RATIO',
  'CONFIG_AUTH_SET_FUNCTION_ID',
  'CONFIG_FIELD_SET_FUNCTION_ID',
  'CONFIG_HOOK_ADD_FUNCTION_ID',
  'CONFIG_TARGET_CREATE_FUNCTION_ID',
  'CONFIG_TARGET_EDIT_FUNCTION_ID',
  'DuplicateFunctionIdError',
  'DuplicateJobKindError',
  'EDITOR_LIVE_URL_FUNCTION_ID',
  'EXPLAIN_FUNCTION_ID',
  'EntityNotFoundError',
  'EvidenceBlobAbsentError',
  'FunctionInputError',
  'FunctionNotBoundError',
  'IncompleteJobKindDeclarationError',
  'InconsistentJobKindDeclarationError',
  'JobCancellationNotRequestedError',
  'JobCancelledError',
  'KNOWLEDGE_GATES_LIST_FUNCTION_ID',
  'KnowledgeGatesUnboundError',
  'LIVE_EMBED_PATH_PREFIX',
  'LIVE_URL_TOKEN_VERSION',
  'LIVE_URL_TTL_MS',
  'LiveViewUnavailableError',
  'MARK_UNHANDLED_CEILING',
  'MissingIdempotencyKeyError',
  'OPTIONAL_FUNCTION_DEP_KEYS',
  'QUARANTINE_ADD_FUNCTION_ID',
  'QUARANTINE_LIST_FUNCTION_ID',
  'QUARANTINE_RELEASE_FUNCTION_ID',
  'QuarantinedJobRequeueError',
  'REAL_JOB_KIND_DECLARATIONS',
  'RUNS_ARTIFACT_FUNCTION_ID',
  'RUNS_DETAIL_FUNCTION_ID',
  'RUNS_DIGEST_FUNCTION_ID',
  'RUNS_EVENTS_FUNCTION_ID',
  'RUNS_EVIDENCE_FUNCTION_ID',
  'RUNS_KNOWLEDGE_FUNCTION_ID',
  'RUNS_LIST_FUNCTION_ID',
  'RUNS_LIVE_URL_FUNCTION_ID',
  'RUNS_MARKS_HISTORY_FUNCTION_ID',
  'RUNS_MARK_FUNCTION_ID',
  'RUNS_MARK_PREVIEW_FUNCTION_ID',
  'RUNS_OVERVIEW_FUNCTION_ID',
  'RUNS_POST_PROCESSING_FUNCTION_ID',
  'RUNS_START_FUNCTION_ID',
  'RunEndedWithoutVerdictError',
  'RunNotFinishedError',
  'RunNotFoundError',
  'RunNotRecordedError',
  'SCENARIO_CORPUS',
  'SCENARIO_CORPUS_VERSION',
  'StaleJobStoreEpochError',
  'StreamReplayFloorError',
  'UndeclaredJobCheckpointError',
  'UndeclaredJobSuccessorError',
  'UnknownFunctionError',
  'UnknownJobKindError',
  'UnknownLiveEditorSessionError',
  'UnknownRunError',
  'authoringFanOutBound',
  'ceilingExceeded',
  'chainJobIdsForRun',
  'clusterVerdicts',
  'composeBanner',
  'computeMarkUnhandledRate',
  'createAgentJobQueue',
  'createChatCompactionHook',
  'createChatState',
  'createFunctionRegistry',
  'createJobKindRegistry',
  'createPlannerStage',
  'createRealJobKindRegistry',
  'createTurnEngine',
  'decodeBase64Url',
  'deterministicOverrideStrategy',
  'encodeBase64Url',
  'evaluateAssertionStrength',
  'foldFunctionResult',
  'fromToolName',
  'gatherSuiteStability',
  'invokeFunction',
  'isChatMetaToolName',
  'liveUrlOf',
  'maybeCompact',
  'mintLiveUrlToken',
  'parseScenario',
  'projectAuthoringFunnel',
  'projectPlannerTools',
  'recordLlmAuthorship',
  'renderAnalysisClusterBlock',
  'renderVerdictSentence',
  'repairSession',
  'replaySession',
  'replayToModelMessages',
  'resolveClause',
  'runAuthoringLoop',
  'scenarioRelativePath',
  'scopeReceiptsToWindow',
  'splitClauses',
  'unhandledReason',
  'validateLiveUrlToken',
]

export const EXPECTED_AGENT_BARREL_TYPE_EXPORTS: readonly string[] = [
  'AgentJobQueue',
  'AnalysisArtifactReaderPort',
  'AnalysisCluster',
  'AnalysisClusterMember',
  'AuthoringFunnelPortLike',
  'AuthoringLoopDeps',
  'AuthoringLoopInput',
  'AuthoringLoopOutcome',
  'AuthoringLoopResult',
  'AuthoringLoopStage',
  'AuthoringReadPort',
  'AuthoringReadPortLike',
  'BoundRecordLlmAuthorship',
  'CallerMint',
  'CancelJobInput',
  'CapabilityCatalogPort',
  'ChainJobIds',
  'ChainTerminalRecord',
  'ChatBindingStage',
  'ChatClause',
  'ChatCompactionHookDeps',
  'ChatConfigState',
  'ChatDegradeOptions',
  'ChatDegradeOutcome',
  'ChatDirectiveHandlers',
  'ChatDirectiveName',
  'ChatHelpEntry',
  'ChatInvokeAnswer',
  'ChatInvokeBinding',
  'ChatLanguageModel',
  'ChatLastTurn',
  'ChatModelDirectiveOutcome',
  'ChatReplayMessage',
  'ChatResolution',
  'ChatResolverEntry',
  'ChatResolverRule',
  'ChatResolverTable',
  'ChatStateContainer',
  'ChatStateSnapshot',
  'ChatTokenAccounting',
  'ChatToolsetFingerprint',
  'ChatTurnPort',
  'ChatTurnStateSink',
  'ClaimNextOptions',
  'ClauseAction',
  'ClauseSplitter',
  'ClauseVerdict',
  'ClockPort',
  'CompactionHook',
  'CompactionPass',
  'CompactionPassInput',
  'ConfigFieldSetResult',
  'ConfigFieldValue',
  'ConfigFileBytes',
  'ConfigFileSet',
  'ConfigFilesPortLike',
  'ConfigPathFacts',
  'ConfigReaderPort',
  'ConfigScaffoldContentPortLike',
  'ConfigStructuredValue',
  'ConfigValidatePortLike',
  'ConfigValidation',
  'ConfigValidationIssue',
  'CreateAgentJobQueueOptions',
  'CreateChatStateInput',
  'CreateFunctionRegistryOptions',
  'DraftReceiptsReadPortLike',
  'DraftShelfPortLike',
  'DraftStageOutcome',
  'EntityDirectoryPort',
  'EvidenceBlobReaderPort',
  'ExplainAbstentionRecord',
  'FallbackContinuationInput',
  'FallbackContinuationProducer',
  'FunctionBindingStatus',
  'FunctionDeclaration',
  'FunctionDeps',
  'FunctionRegistry',
  'FunctionResultFold',
  'FunctionResultKind',
  'FunctionStream',
  'JobAuthorCallback',
  'JobBackoffPolicy',
  'JobCancelOutcome',
  'JobCheckpointContext',
  'JobCheckpointReadOutcome',
  'JobCheckpointRecord',
  'JobClaimOutcome',
  'JobCompleteOutcome',
  'JobEnqueueOutcome',
  'JobFailureDisposition',
  'JobHandler',
  'JobHandlerContext',
  'JobIdSource',
  'JobInsert',
  'JobKindDeclaration',
  'JobKindRegistry',
  'JobModelCapability',
  'JobModelOutput',
  'JobModelRequest',
  'JobPermanentFailureDisposition',
  'JobRecordedValueOutcome',
  'JobRequeueOutcome',
  'JobStoreDump',
  'JobStoreDumpRow',
  'JobStoreFence',
  'JobStorePort',
  'KnowledgePort',
  'KnowledgeReaderPort',
  'KnowledgeReviewPort',
  'LiveViewPort',
  'MarkUnhandledCounts',
  'OptionalFunctionDepKey',
  'PersistencePort',
  'PlannerStageFailure',
  'PlannerStageOutcome',
  'PlannerStagePort',
  'PlannerToolCall',
  'PostProcessingChainState',
  'PostProcessingJobRow',
  'PostProcessingReaderPort',
  'PostRunJobCapabilities',
  'RanJobOutcomeBase',
  'ReconcileInput',
  'ReconcileStrategy',
  'ReconcileVerdict',
  'RecoverAbandonedClaimsInput',
  'RecoverAbandonedClaimsOutcome',
  'RecurrenceAnswer',
  'RecurrenceLadder',
  'RecurrenceProvider',
  'RecurrenceQuery',
  'RepairSessionOptions',
  'ReplayedRunEvent',
  'ResolvedClause',
  'RunDetailReaderPort',
  'RunInvocationPort',
  'RunNextJobInput',
  'RunNextJobOutcome',
  'RunsReaderPort',
  'ScenarioCorpusEntry',
  'SessionLogLine',
  'SessionRepair',
  'SessionReplay',
  'StandInJobScript',
  'StartedRun',
  'StepEvidenceAddress',
  'StepEvidenceLookup',
  'SuiteOutcomeHistoryPortLike',
  'TurnEngine',
  'TurnEngineDeps',
]

/** Both pinned sets as one sorted list, for membership questions that ignore kind. */
export const EXPECTED_AGENT_BARREL_EXPORTS: readonly string[] = [
  ...EXPECTED_AGENT_BARREL_VALUE_EXPORTS,
  ...EXPECTED_AGENT_BARREL_TYPE_EXPORTS,
].sort()

export interface AgentBarrelExports {
  values: string[]
  types: string[]
}

const LOCAL_DECLARATION_RE =
  /^export\s+(?:declare\s+)?(const|let|var|function|async\s+function|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm

const TYPE_DECLARATION_KEYWORDS = new Set(['interface', 'type'])

/**
 * The names a barrel publishes, split by kind.
 *
 * Re-export statements are read through the shared module-statement parser, so a clause
 * spread over several lines is one statement rather than several partial ones. The
 * EXPORTED name is the right-hand side of an alias: renaming on the way out changes what
 * a consumer can reach, which is the thing being pinned.
 */
export function readAgentBarrelExports(source: string): AgentBarrelExports {
  const values = new Set<string>()
  const types = new Set<string>()

  for (const statement of parseModuleStatements(source)) {
    if (statement.keyword !== 'export') continue

    const clause = statement.clause
    const statementIsTypeOnly = /^type\b/.test(clause)
    const braced = /\{([\s\S]*)\}/.exec(clause)

    if (braced === null) {
      // `export * from ...` republishes an unknown set. The barrel does not do this, and
      // a pin cannot describe what it cannot enumerate, so it is reported as its own name.
      values.add(clause.trim() === '' ? 'default' : clause.trim())
      continue
    }

    for (const raw of (braced[1] ?? '').split(',')) {
      const entry = raw.trim()
      if (entry === '') continue
      const entryIsTypeOnly = /^type\b/.test(entry)
      const withoutModifier = entry.replace(/^type\s+/, '')
      const parts = withoutModifier.split(/\s+as\s+/)
      const exported = (parts[parts.length - 1] ?? withoutModifier).trim()
      if (exported === '') continue
      if (statementIsTypeOnly || entryIsTypeOnly) types.add(exported)
      else values.add(exported)
    }
  }

  for (const match of stripCodeComments(source).matchAll(LOCAL_DECLARATION_RE)) {
    const keyword = (match[1] ?? '').trim()
    const name = match[2]
    if (name === undefined) continue
    if (TYPE_DECLARATION_KEYWORDS.has(keyword)) types.add(name)
    else values.add(name)
  }

  if (/^export\s+default\b/m.test(stripCodeComments(source))) {
    values.add('default')
  }

  return { values: [...values].sort(), types: [...types].sort() }
}

function setDrift(
  kind: 'value' | 'type',
  actual: readonly string[],
  expected: readonly string[],
): string[] {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)

  return [
    ...[...actualSet]
      .filter(name => !expectedSet.has(name))
      .sort()
      .map(name => `agent-barrel: unexpected ${kind} export ${name}`),
    ...[...expectedSet]
      .filter(name => !actualSet.has(name))
      .sort()
      .map(name => `agent-barrel: missing ${kind} export ${name}`),
  ]
}

// Arrivals and departures are separate offenders, so the failure names the mistake.
export function findAgentBarrelOffenders(source: string): string[] {
  const actual = readAgentBarrelExports(source)

  return [
    ...setDrift('value', actual.values, EXPECTED_AGENT_BARREL_VALUE_EXPORTS),
    ...setDrift('type', actual.types, EXPECTED_AGENT_BARREL_TYPE_EXPORTS),
  ]
}
