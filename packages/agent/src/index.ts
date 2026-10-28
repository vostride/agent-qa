export type {
  AuthoringReadPort,
  KnowledgePort,
  PersistencePort,
  ClockPort,
} from './ports/index.js'

// 384 FUNC-01 — the typed function layer.
//
// `invokeFunction` is the ONLY exported way to run a capability, and it always crosses
// the policy gate. `FunctionSpec` (declaration + implementation), the spec-level
// `invoke`, the registry internals, and `createRegistryFromSpecs` are all deliberately
// absent from this barrel: exporting any of them would hand a surface a dispatch path
// that skips the gate (T-384-01). The arch barrel assertion pins this exact export set.
export { createFunctionRegistry, DuplicateFunctionIdError } from './functions/registry.js'
// 399.1 D-01/D-03: the result fold, published because the composition root is the ONE place that
// holds both a registry and the invoke call — the chat subtree may not, by construction. It runs a
// spec's declared classifier and render fold and answers with DATA; it dispatches nothing, and a
// caller holding it can run no capability it could not already run through `invokeFunction`.
export { foldFunctionResult } from './functions/classify.js'
export type { FunctionResultFold } from './functions/classify.js'
export type { CreateFunctionRegistryOptions, FunctionRegistry } from './functions/registry.js'
// 399.1 D-01/D-02: what a classifier answers. A two-field DATA type a receipt is built from; the
// classifier itself stays on the spec, which never leaves `functions/`.
export type { ClauseVerdict } from './functions/spec.js'
// 419 GATE3-01: the optional dep vocabulary is DATA, carrying no dispatch capability.
export { OPTIONAL_FUNCTION_DEP_KEYS } from './functions/spec.js'
export {
  invokeFunction,
  FunctionInputError,
  FunctionNotBoundError,
  UnknownFunctionError,
} from './functions/invoke.js'
// 388 D-14 adds `PostProcessingChainState`, `PostProcessingJobRow` and
// `PostProcessingReaderPort` below: the durable chip-truth read port and the two shapes it
// answers with. Types, so none of them carries a database across this barrel — the only value
// that ever implements the port is built by a composition in the one package sqlite is legal
// in, and `invokeFunction` is still the only dispatch. They are here so a composition root can
// NAME what it supplies; `postProcessing` is an OPTIONAL member, so a host that omits it is
// making a statement rather than forgetting.
//
// The rationale lives ABOVE the clause and not inside it, and that is load-bearing rather than
// stylistic: the arch barrel pin strips comments before it grows a multi-line clause, a
// stripped comment line becomes a blank one, and a blank line ENDS the clause — so a comment
// between two names here does not annotate the export, it deletes every export in the
// statement from the pinned set.
export type {
  AnalysisArtifactReaderPort,
  ConfigReaderPort,
  EntityDirectoryPort,
  FunctionBindingStatus,
  FunctionDeclaration,
  FunctionDeps,
  FunctionResultKind,
  FunctionStream,
  KnowledgeReaderPort,
  KnowledgeReviewPort,
  OptionalFunctionDepKey,
  PostProcessingChainState,
  PostProcessingJobRow,
  PostProcessingReaderPort,
  ReplayedRunEvent,
  RunInvocationPort,
  RunsReaderPort,
  StartedRun,
  StepEvidenceAddress,
  StepEvidenceLookup,
} from './functions/spec.js'
// 403-01 (D-03): the live-view mint seam's port shape — a host BINDS one, so it must be able to
// name what it supplies.
//
// ITS OWN STATEMENT, and that is mechanical rather than stylistic: the arch barrel pin's clause
// scanner gives up after 24 continuation lines (`evaluate-pin.ts` MAX_CLAUSE_LINES), and the
// clause above is already at that bound — a twenty-fifth name would not annotate the export, it
// would delete EVERY export in that statement from the pinned set. Split, both are read.
export type { LiveViewPort } from './functions/spec.js'
// 405 D-03: the run-detail projection read port's shape — a host BINDS one, so it must be able to
// name what it supplies. Its own statement for the reason `LiveViewPort` above is: the clause
// scanner's continuation bound (`evaluate-pin.ts` MAX_CLAUSE_LINES) is already reached by the
// block above, and a name added there would delete that whole statement from the pinned set. A
// TYPE, so nothing carrying a database crosses this barrel — the only value that ever implements
// it is built in the one package sqlite is legal in, and `invokeFunction` is still the only
// dispatch.
export type { RunDetailReaderPort } from './functions/spec.js'
// 405-05 D-12/D-13: the evidence-blob read port's shape, on the line above's exact footing — a
// host BINDS one, so it must be able to name what it supplies. Its own statement for the same
// clause-continuation reason. A TYPE, so nothing carrying a filesystem crosses this barrel: the
// only value that ever implements it is built in the one package `node:fs` is legal in.
export type { EvidenceBlobReaderPort } from './functions/spec.js'
// Caller-facing refusals a surface may legitimately catch and report. Op-level errors live
// with the op that throws them; only the error CLASS crosses the barrel, never the spec.
export {
  RunEndedWithoutVerdictError,
  RunNotFinishedError,
  RunNotFoundError,
} from './functions/ops/runs-get.js'
// 419 GATE3-01: publish identity DATA only; the spec's invoke must stay behind the gate.
export { RUNS_MARK_FUNCTION_ID } from './functions/ops/runs-mark.js'
// 423 D-19: identity only; the history spec stays behind invokeFunction.
export { RUNS_MARKS_HISTORY_FUNCTION_ID } from './functions/ops/runs-marks-history.js'
// 423 D-16: identity only; the preview spec stays behind invokeFunction.
export { RUNS_MARK_PREVIEW_FUNCTION_ID } from './functions/ops/runs-mark-preview.js'
// 416 D-17: the gate-history op identity and its named unbound refusal.
export { KNOWLEDGE_GATES_LIST_FUNCTION_ID, KnowledgeGatesUnboundError } from './functions/ops/knowledge-gates-list.js'
export { RunNotRecordedError } from './functions/ops/runs-start.js'
export { StreamReplayFloorError } from './functions/ops/runs-events.js'
// 403 D-03: the liveUrl mint/validate PAIR, its op id and the two refusals a surface reports.
// The dashboard route and the frame proxy bind `validateLiveUrlToken` BY REFERENCE — there is
// exactly one parse of a liveUrl token in the system, and this is where it lives.
export {
  LIVE_EMBED_PATH_PREFIX,
  LIVE_URL_TOKEN_VERSION,
  LIVE_URL_TTL_MS,
  decodeBase64Url,
  encodeBase64Url,
  liveUrlOf,
  mintLiveUrlToken,
  validateLiveUrlToken,
} from './functions/live-url.js'
export {
  LiveViewUnavailableError,
  RUNS_LIVE_URL_FUNCTION_ID,
  UnknownRunError,
} from './functions/ops/runs-live-url.js'
// 428 D-07: the editor subject's mint id and its named refusal. The spec stays behind invokeFunction.
export {
  EDITOR_LIVE_URL_FUNCTION_ID,
  UnknownLiveEditorSessionError,
} from './functions/ops/editor-live-url.js'
// 387 ENTY-02: the caller-facing refusal for an address nothing ever minted. A permanently
// minted address whose entity was tombstoned still resolves (D-04) — this is not that case.
export { EntityNotFoundError } from './functions/ops/entities-get.js'
// 387 KREV-02: the why-verb's one refusal. `stepIndex` is numbered per member test, so an
// address that names no test can match two steps; the verb refuses rather than answering
// about whichever test came first, and a surface catches this to say which testIds to pick
// between.
export { AmbiguousStepAddressError } from './functions/ops/knowledge-brief-why.js'
// 387-08 D-18: the ONE op id a surface must be able to NAME rather than infer. A host that
// delegates an apply to the writer-lease holder has to put an id on the wire, and the alternative
// is a string literal in the CLI — a second declaration of a capability's name, free to drift from
// the spec that answers to it. An ID is not a dispatch handle: naming a capability still buys
// nothing without a registry, a caller and the gate.
// 388 D-14: the second op id a surface must be able to NAME, on exactly the footing above. The
// CLI's exit summary line (plan 04) dispatches chip truth through the registry, and the
// alternative is a string literal in the CLI — a second declaration of a capability's name,
// free to drift from the spec that answers to it. An ID is not a dispatch handle.
export { RUNS_POST_PROCESSING_FUNCTION_ID } from './functions/ops/runs-post-processing.js'
// 404 D-22: the fourth op id a surface must be able to NAME, on exactly the footing above. The
// dashboard's post-processing read route joins chip truth with the run's own recorded POSTURE —
// the `runFinished` disposition and the last per-stage failure line — and reads it by dispatching
// this op through the injected host. `packages/dashboard-server` may not import this package at
// all, so the alternative is not a literal there but a literal it cannot type-check; the id is
// handed to it by the composition, exactly as `agent.ask`'s is.
export { RUNS_EVENTS_FUNCTION_ID } from './functions/ops/runs-events.js'
// 405 D-03: the fifth op id a surface must be able to NAME, on exactly the footing above. The
// dashboard's run-detail route dispatches the durable projection read through the injected host,
// and `packages/dashboard-server` may not import this package at all — so the id reaches it the
// only way an id can, as data from the composition that already knows it. An ID IS NOT A DISPATCH
// HANDLE: the spec itself stays inside `functions/`, so `runs.detail` remains reachable only
// through `invokeFunction`, and neither the pure `projectRunTokenTotals` nor `runsDetailSpec`
// joins this barrel (a spec carries its own `invoke`, which is the private power SC1 abolishes).
export { RUNS_DETAIL_FUNCTION_ID } from './functions/ops/runs-detail.js'
// 423 D-04: publish identity only; the executable spec remains behind invokeFunction.
export { RUNS_EVIDENCE_FUNCTION_ID } from './functions/ops/runs-evidence.js'
// 405-05 D-12/D-13: the sixth op id a surface must be able to NAME, on the line above's exact
// footing. The dashboard's artifact arm — on BOTH doors — dispatches the ref-resolving read
// through the injected host, and `packages/dashboard-server` may not import this package at all.
// The refusal class travels beside it because a surface must be able to tell "no such run" from
// "that run holds no such blob" (D-15), and a name is the only thing that distinction can be
// carried by across a boundary neither package's types cross. `runsArtifactSpec` and the sniffer
// stay inside `functions/` — a spec carries its own `invoke`, which is the private power SC1
// abolishes, and the sniffer is a detail of what the op serves rather than of what a caller reads.
export {
  EvidenceBlobAbsentError,
  RUNS_ARTIFACT_FUNCTION_ID,
} from './functions/ops/runs-artifact.js'
// 389 D-11: the third op id a surface must be able to NAME, on the same footing as the two
// above. Plan 07's CLI sentence block and the D-12 exit-line fetch hint both dispatch the
// analysis read through the registry, and the alternative is a string literal in the CLI — a
// second declaration of a capability's name, free to drift. An ID is not a dispatch handle.
export { ANALYSIS_GET_FUNCTION_ID } from './functions/ops/analysis-get.js'
// 391 D-16/D-17: the per-run digest's id, on exactly the footing of the three above. The CLI's
// `digest` verb, the tail's digest block and the exit-line fetch pointer all have to put this
// name on the wire, and the alternative is a string literal in each — a second declaration of a
// capability's name, free to drift. An ID is not a dispatch handle.
export { RUNS_DIGEST_FUNCTION_ID } from './functions/ops/runs-digest.js'
// 2026-08-29 (407 D-05): the Knowledge panel read's id, on exactly the footing of the constants
// above. The dashboard's `/api/runs/:id/knowledge` arm dispatches it through the injected host,
// and `packages/dashboard-server` may not import this package at all — so the id reaches that
// route the only way an id can, as data from the composition that already knows it. The SPEC
// stays inside `functions/`: a spec carries its own `invoke`, which is the private power SC1
// abolishes, so `runs.knowledge` remains reachable only through `invokeFunction`.
export { RUNS_KNOWLEDGE_FUNCTION_ID } from './functions/ops/runs-knowledge.js'
// 431 D-06: the run overview's id, on the same footing. The spec stays inside `functions/`.
export { RUNS_OVERVIEW_FUNCTION_ID } from './functions/ops/runs-overview.js'
// 392 plan 07: the run LISTING's id, on the same footing. The `status` alias resolves to it, so the
// composed compound e2e's assertion that the second clause really dispatched there must break when
// the op is renamed — which it cannot if the test compares against a string it spelled itself
// (387 D-11's imported-not-literal rule). A string is not a dispatch handle.
export { RUNS_LIST_FUNCTION_ID } from './functions/ops/runs-list.js'
// 390 D-13: the three quarantine verb ids, on exactly the footing of the three constants above.
// A later plan's CLI verbs and M5's quarantine management both have to put a name on the wire,
// and the alternative is a string literal in each surface — a second declaration of a
// capability's name, free to drift. An ID is not a dispatch handle.
//
// The SPECS themselves are deliberately absent, as every other op's are: `FunctionSpec` carries
// the implementation and the live validators, so exporting one would hand a surface a dispatch
// path around `invokeFunction`'s gate (T-384-01) — which for two verbs that write the committed
// ledger is precisely the escalation this plan's threat register names (T-390-11).
export { QUARANTINE_ADD_FUNCTION_ID } from './functions/ops/quarantine-add.js'
export { QUARANTINE_LIST_FUNCTION_ID } from './functions/ops/quarantine-list.js'
export { QUARANTINE_RELEASE_FUNCTION_ID } from './functions/ops/quarantine-release.js'
// 392 D-24: the chat turn entry's id, plus the id of the ONE op the tracer's deterministic table
// resolves to. Both on exactly the footing of the constants above — a name a surface puts on the
// wire, never a dispatch handle.
//
// `AGENT_ASK_FUNCTION_ID` is the one a production surface names: `agent-qa ask` and the REPL both
// reach the turn engine through `invokeFunction` with this id, which is what makes chat a CLIENT of
// the function layer rather than a holder of a private power (§3's L10 law).
export { AGENT_ASK_FUNCTION_ID } from './functions/ops/agent-ask.js'
// 398 D-09/D-11: `explain`'s id, and the PORT TYPE a composition root must implement to bind it.
//
// The id is on the footing of every constant above — a name a caller puts on the wire. It is
// published because the conformance differentials and the chat routing assertions must break when
// this op is renamed, and a test comparing against a string it spelled itself cannot.
//
// The port and its record are TYPES, and what they describe is a SEAT A COMPOSITION FILLS. That is
// the whole reason they belong here and the renderer, the scorer and the abstention templates do
// not: publishing `renderExplainOutput` would hand a surface a second way to compose an explain
// answer, which is the private power this layer abolishes. A host that can only IMPLEMENT the port
// gets nothing it could run — every character a person reads is still quoted out of a catalog row
// by code this barrel does not expose.
export { EXPLAIN_FUNCTION_ID } from './functions/ops/explain.js'
export type { CapabilityCatalogPort, ExplainAbstentionRecord } from './explain/index.js'
// 393 D-01/D-02: the keep-gate evaluator's id, and the id of the sibling op its gate-runs go
// through. Both on exactly the footing of every constant above — a name a caller puts on the wire,
// never a dispatch handle.
//
// `AUTHORING_DRAFT_VERIFY_FUNCTION_ID` is what a surface and this phase's e2e proof both name to
// reach the evaluator through `invokeFunction`, which is what makes the keep-filter a catalogued
// capability rather than a private power of whatever writes tests.
//
// `RUNS_START_FUNCTION_ID` is published for D-02's op-calls-op binding: `composeLocalAgent()`
// dispatches every gate-run through the REAL `runs.start` — so the markers are confirmed off the
// run's own durable record by the one function that reads them there, instead of a second
// acknowledgment recipe being spelled at the composition. 387 D-11's rule then applies with full
// force: the id is IMPORTED, so renaming the op breaks the binding's compile rather than leaving a
// literal pointing at a string nothing dispatches.
export { AUTHORING_DRAFT_VERIFY_FUNCTION_ID } from './functions/ops/authoring-verify-draft.js'
export { RUNS_START_FUNCTION_ID } from './functions/ops/runs-start.js'
// 394 D-01: the authoring loop's one public entry, on exactly the footing of the two ids above —
// a name a caller puts on the wire, never a dispatch handle. Published because
// `composeLocalAgent()` binds the loop's verify closure by IMPORTING the verify id (387 D-11), and
// because this phase's e2e proof reaches the loop the way a surface does: through
// `invokeFunction`, by name, on a real registry.
export { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from './functions/ops/authoring-draft-write.js'
// 394-09 D-21 · WTST-07: the user-facing edit's id, on exactly the footing of the three ids above.
// Published because this phase's byte-confinement proof has to reach the op the way a surface does
// — through `invokeFunction`, by name, on a real registry — and that proof can only live in
// `packages/cli`, where the yaml CST applier the op reuses is actually bound. The SPEC stays inside
// `functions/`, so this opens no dispatch path (T-384-01).
export { AUTHORING_DRAFT_EDIT_FUNCTION_ID } from './functions/ops/authoring-draft-edit.js'
// 394 D-01 · WTST-01: the loop's own vocabulary. `AUTHORING_LOOP_STAGES` is the closed, ORDERED
// stage list the ordering pin asserts sequence equality against, and `runAuthoringLoop` is the
// orchestration itself — published so a pin can drive the real function over injected fakes rather
// than re-deriving a stage order from the op's observable side effects. Neither is a capability:
// the loop is a pure function of (input, deps) and cannot reach a host API or a registry.
// 394-08 D-03/D-10 · WTST-08: `authoringFanOutBound` is the ONE site that assembles the bound's
// three terms — `DRAFT_STABILITY_RUNS_N` (or 1 in draft mode), `REPAIR_ITERATION_CAP`, and
// `DRAFT_STABILITY_RUNS_N` again — and the only caller of `computeFanOutBound` in this package.
// Published because the dispatch-confirm cells compare the rendered figure against THIS FUNCTION
// rather than against a literal: a hard-coded 9 in a test would pass just as happily against a
// second, drifting arithmetic, which is the exact failure the single source exists to prevent.
export { AUTHORING_LOOP_STAGES, authoringFanOutBound, runAuthoringLoop } from './authoring/loop.js'
export type {
  AuthoringLoopDeps,
  AuthoringLoopInput,
  AuthoringLoopOutcome,
  AuthoringLoopResult,
  AuthoringLoopStage,
} from './authoring/loop.js'
export type {
  AuthoringReadPortLike,
  DraftReceiptsReadPortLike,
  DraftShelfPortLike,
  DraftStageOutcome,
} from './authoring/ports.js'
// 395 D-01/D-03/D-17 · CFGM-01/03/04: the config editor's four host ports, published for the
// reason the authoring ports above are — `composeLocalAgent()` and the CLI host implement them
// and neither may name a type that lives only inside `functions/`.
export type {
  ConfigFieldSetResult,
  ConfigFieldValue,
  ConfigFileBytes,
  ConfigFileSet,
  ConfigFilesPortLike,
  ConfigPathFacts,
  ConfigScaffoldContentPortLike,
  ConfigStructuredValue,
  ConfigValidatePortLike,
  ConfigValidation,
  ConfigValidationIssue,
} from './config-mutation/ports.js'
export {
  CONFIG_FIELD_SET_FUNCTION_ID,
} from './functions/ops/config-field-set.js'
// 395-05 D-01: the rest of the closed action class's op ids, on the footing of the two above — a
// name a surface puts on the wire, never a dispatch handle. The SPECS stay inside `functions/`.
export { CONFIG_AUTH_SET_FUNCTION_ID } from './functions/ops/config-auth-set.js'
export { CONFIG_HOOK_ADD_FUNCTION_ID } from './functions/ops/config-hook-add.js'
export { CONFIG_TARGET_CREATE_FUNCTION_ID } from './functions/ops/config-target-create.js'
export { CONFIG_TARGET_EDIT_FUNCTION_ID } from './functions/ops/config-target-edit.js'
// 2026-10-01 (432-17, D-05/D-09): the undo's and the config apply's ids are deleted with their ops.
// 394-07 D-12/D-13 · WTST-05: the funnel read's id, on the exact footing of the op-id constants
// above — a name a surface puts on the wire, never a dispatch handle. Published because
// `composeLocalAgent()` has to name it when it binds the capability, and 387 D-11 forbids the
// literal it would otherwise spell. The SPEC stays inside `functions/`.
export { AUTHORING_FUNNEL_GET_FUNCTION_ID } from './functions/ops/authoring-funnel-get.js'
// 394-07 D-12/D-14: the projection and the mixed-verdict stability gather, plus the port bundle a
// composition root fills. Both functions are PURE over injected reads — they reach no host API,
// no registry and no run capability, which is D-14's zero-runs claim expressed as an absence in
// the port's own shape rather than as a promise. Published because the composition root is the
// only thing that can bind the bundle, and because `scopeReceiptsToWindow` is the exact-equality
// session rule a cell drives alone.
export {
  gatherSuiteStability,
  projectAuthoringFunnel,
  scopeReceiptsToWindow,
} from './authoring/funnel.js'
export type {
  AuthoringFunnelPortLike,
  SuiteOutcomeHistoryPortLike,
} from './authoring/funnel.js'
export { createTurnEngine } from './chat/turn-engine.js'
// 398 plan 09: `CHAT_DIRECTIVES` and `CHAT_HELP_ENTRIES` join the two that were already here
// because the help ↔ catalog census lives in `packages/cli` and has to be able to NAME the three
// classes a help line can belong to — a capability alias, a session directive, the passthrough —
// without re-spelling any of them. Both are frozen data and neither dispatches anything.
export {
  CHAT_DIRECTIVES,
  CHAT_HELP_ENTRIES,
  CHAT_HELP_TEXT,
  CHAT_RESOLVER_TABLE,
  resolveClause,
} from './chat/resolver-table.js'
export { deterministicOverrideStrategy, unhandledReason } from './chat/reconcile.js'
// 392 plan 10, D-16: the two halves of the dotted-id ↔ provider-safe tool-name mapping that a
// reader of a MODEL PLAN needs. Published because plan 10's mutation proof composes the real host
// with a reconciliation strategy that trusts the model's plan verbatim — the override-OFF arm —
// and such a strategy has to turn a tool name back into the id the function layer answers to. A
// differential that spelled its own `.` ↔ `_` rename would be a second catalogue, which is the
// exact drift `tool-names.ts` exists as one module to prevent, and it would let the off-arm fail
// for a reason that has nothing to do with the override being off.
//
// Neither is a dispatch path. `isChatMetaToolName` answers a boolean about a string;
// `fromToolName` REFUSES the two orchestration names and otherwise returns a string. Nothing on
// either side of the mapping can reach a registry, a capability or a host API, and an id that
// nothing registered still dies at `invokeFunction`'s own named refusal.
//
// `ANSWER_ONLY_TOOL_NAME` joins them in 392-14 for the same reason and no other. Removing
// `PlannerStageOutcome.answer` left those two differentials — whose whole content is the ABSENCE of
// a read of `input.mapped` — needing to re-derive the turn-level prose carry they deliberately
// model, and the only alternative was a literal `'answer_only'` in each of them: the second
// catalogue this module exists to prevent, in the files least able to afford one.
export { ANSWER_ONLY_TOOL_NAME, fromToolName, isChatMetaToolName } from './chat/tool-names.js'
// 392 plan 02, D-09: the real conjunction grammar. Published because the composition root binds
// it as the engine's `ClauseSplitter`, and it REPLACES the tracer's whole-utterance splitter,
// which is deleted rather than left beside it — one bound answer, not two available ones.
export { splitClauses } from './chat/clause-split.js'
// 392 plan 03, CHAT-05 / D-19: what a damaged session file MEANS, and what a resumed session
// remembers. Published because every storage adapter has to reach the SAME verdict about a
// half-written log — `agent-local`'s JSONL adapter and its in-memory twin both call `repairSession`
// on the resume path, and M5's session reader will too. A second adapter deciding for itself
// whether a turn dangled is two hosts disagreeing about whether a conversation happened.
//
// Neither is dispatch and neither can reach a host capability: both are pure functions over
// records, with no filesystem, no model and no registry anywhere in their reach.
export { repairSession, replaySession } from './chat/session-repair.js'
// 392 plan 05 published the session pin holder here. 2026-10-01 (432-18, D-14): it is deleted with the
// op gate it tightened; `/pin` is an ordinary unresolved clause.
// 392 plan 08, RESEARCH Open Q2: the live turn state. Published because its two consumers are the
// composition root that creates it and the REPL that renders from it, and neither is in this
// package. It is a plain in-memory container — no fs, no model, no dispatch, and no subscription
// — and the module head carries the ratified reason it is not the SDK's `AbstractChat` yet.
export { createChatState } from './chat/chat-state.js'
export type {
  ChatLastTurn,
  ChatStateContainer,
  ChatStateSnapshot,
  CreateChatStateInput,
} from './chat/chat-state.js'
// 392 plan 08, D-23: the chat-open banner. Published because the only surface that opens a chat is
// the REPL, in `cli`. It composes REGISTERED reads through the invoke binding it is handed, holds
// no reader of its own, and has no timer — the suite pins the last of those as source text,
// because a scheduler would pass every behavioural case.
export { composeBanner } from './chat/banner.js'
// 392 plan 09, D-15 / CHAT-03: the frozen corpus and the one validator that reads a scenario back.
// Published because the two lane runners live outside this package — the hermetic gate in
// `agent-local` and the live gate in `cli` — and both must iterate THE SAME admitted list. A
// manifest each runner assembled for itself would be two denominators, which is the treadmill this
// list exists to stop. Neither export can reach a host: the manifest is a frozen array of records,
// and `parseScenario` takes an already-decoded document precisely so no file reader lives in a
// storageNeutral package.
export { parseScenario, scenarioRelativePath } from './chat/scenario-loader.js'
// 392 plan 09, CHAT-03 / D-15: the pinned ceiling and the ONE projection over `mark_unhandled`
// rows. Published because the same function has to serve two readings that must never disagree —
// the harness's rate over the frozen corpus, and a live deployment's field rate over its session
// logs. A second counter somewhere else would be a second definition of what a refusal is.
export { MARK_UNHANDLED_CEILING, ceilingExceeded, computeMarkUnhandledRate } from './chat/ceiling.js'
export type { MarkUnhandledCounts } from './chat/ceiling.js'
export { SCENARIO_CORPUS, SCENARIO_CORPUS_VERSION } from './chat/scenarios/manifest.js'
export type { ScenarioCorpusEntry } from './chat/scenarios/manifest.js'
// 392 plan 06, CHAT-04 / D-20: the compaction trigger policy. Published because the ONLY thing
// that can bind it is outside this package — the composition root, which is also the only place
// holding a `TokenAccounting` instance and a session log to emit onto. An unpublished hook would
// be a seat declared in `ports.ts` with no reachable way to fill it.
//
// The two constants ride along deliberately. They are the numbers D-20 pins, and a pin nobody can
// READ is a pin a second surface re-spells with a different value; publishing them is what lets a
// later conformance assertion name them rather than a literal. Neither is dispatch, neither is a
// host capability, and the hook reaches a model only through the accounting instance it is HANDED
// — it cannot construct one, cannot resolve capabilities, and cannot reach a provider.
export {
  CHAT_MINIMUM_CONTEXT,
  COMPACTION_RATIO,
  createChatCompactionHook,
  maybeCompact,
  replayToModelMessages,
} from './chat/compaction.js'
export type {
  ChatCompactionHookDeps,
  ChatDegradeOptions,
  ChatDegradeOutcome,
  ChatTokenAccounting,
  CompactionPass,
  CompactionPassInput,
} from './chat/compaction.js'
export type { TurnEngine, TurnEngineDeps } from './chat/turn-engine.js'
// 392 plan 07, D-04 / CHAT-05: what a session's configuration IS, as the drift check compares it.
// Published as types only — the diff and the fold stay internal to the engine, because the one
// caller that could reach them is the engine itself and a published differ would be a second place
// a `model_change` could be born. What the composition root needs is the ability to NAME the state
// it re-reads per turn, which is exactly these two.
export type { ChatConfigState, ChatToolsetFingerprint } from './chat/config-drift.js'
// 392 plan 07, CHAT-01 / CHAT-06 / D-07: stage 2, published because plan 04 built it and this is
// the plan that BINDS it — the composition root is its only caller, exactly as that plan said.
//
// Neither value is a private power. `projectPlannerTools` reads the registry LISTING and emits
// execute-less tools: what it produces cannot run anything, by the absence of a callback rather
// than by a promise. `createPlannerStage` takes an already-built model and answers with a PLAN;
// it names no provider, cannot construct a model, and the arch rollcall reds the build if that
// stops being true. `ChatLanguageModel` rides along because a composition root that binds a model
// must be able to name the one shape allowed here — an object, never a model id a global registry
// would resolve by constructing a client (CHAT-06's second door, closed at the type).
export { createPlannerStage } from './chat/planner-stage.js'
export { projectPlannerTools } from './chat/planner-tools.js'
export type { ChatLanguageModel } from './chat/planner-stage.js'
// The repair contract's own vocabulary. A caller that could invoke `repairSession` but not NAME
// what it hands over or gets back would spell the shapes again locally, which is the second
// vocabulary this subtree is written to avoid (388 C13).
export type {
  ChatReplayMessage,
  RepairSessionOptions,
  SessionLogLine,
  SessionRepair,
  SessionReplay,
} from './chat/session-repair.js'
// 392 plan 02: `ChatResolution` joins the three plan-01 shapes because it is what the published
// `resolveClause` now RETURNS — a two-variant union with no confidence member, and pinning it on
// the barrel is what makes a third variant (or a number) a visible edit rather than an incidental
// one. `ChatDirectiveName` rides along because the entry union names it.
export type {
  ChatDirectiveName,
  ChatHelpEntry,
  ChatResolution,
  ChatResolverEntry,
  ChatResolverRule,
  ChatResolverTable,
} from './chat/resolver-table.js'
// 392 plan 04: stage 2's contract vocabulary. `PlannerStagePort` already named an outcome shape;
// now that shape is the model's RAW plan — unexecuted tool calls plus the optional prose answer and
// the optional typed transport failure — and the three pieces are published for the reason the
// repair contract's were: a composition root that can supply a planner but cannot NAME what one
// answers with would spell the shapes again locally (388 C13). None of them is dispatch: a tool
// call is a description of an intention, and the only thing that can act on one is the reconciler.
//
// 392 plan 07: `ClauseAction` and the stage name it carries. An execute verdict's steps now say
// WHICH stage proved each binding, because the caller a clause runs under is decided by that fact
// and by nothing else (Pitfall 1) — and a consumer holding a verdict it cannot fully NAME would
// spell the shape again locally, which is the second vocabulary this subtree avoids (388 C13).
// 392 plan 08: the directive handlers and the live-state sink. Both are seats a COMPOSITION fills
// — the handlers are how `/model` and `/pin` stop being refusals, and the sink is how a surface
// learns the turn id it would otherwise never see. Types only; nothing here dispatches.
export type {
  CallerMint,
  ChatBindingStage,
  ChatClause,
  ChatDirectiveHandlers,
  ChatInvokeAnswer,
  ChatInvokeBinding,
  ChatModelDirectiveOutcome,
  ChatTurnStateSink,
  ClauseAction,
  ClauseSplitter,
  CompactionHook,
  PlannerStageFailure,
  PlannerStageOutcome,
  PlannerStagePort,
  PlannerToolCall,
  ReconcileInput,
  ReconcileStrategy,
  ReconcileVerdict,
  ResolvedClause,
} from './chat/ports.js'
export type { ChatTurnPort } from './functions/spec.js'

// 391-06: the clustered BLOCK layout, relocated here from the CLI when it acquired its second
// caller (`runs.digest`'s first section). Published on the same footing as the sentence renderer
// below and for the same reason — one layout, imported, never a second composition per surface.
// Pure string work over an op result: no fs, no model, no store, no dispatch. It sits ahead of
// its sibling because the barrel pin compares by the barrel's OWN order.
export { renderAnalysisClusterBlock } from './analysis/render-cluster-block.js'

// 389 D-05/D-08: THE sentence renderer, and the recurrence seam it joins through. The value
// is a pure string composer over typed parts — no fs, no model, no store — published so plan
// 07's CLI print and every later surface import THIS symbol rather than composing a second
// sentence (SC3's "no second code path" is structural, not reviewed). The three port types
// are what a composition root implements to bind the seam: 389 bound it to v51's run-outcome
// projection (plan 06), and 390-06 rebound the SAME seam to its fingerprint window plus the
// committed ledger's ladder state (`RecurrenceLadder`, published for the same reason its
// siblings are — the composition root names it in the function that computes it). None of this
// is dispatch and none of it reaches storage, so publishing it opens no path around
// `invokeFunction`.
export { renderVerdictSentence } from './analysis/render-sentence.js'
export type {
  RecurrenceAnswer,
  RecurrenceLadder,
  RecurrenceProvider,
  RecurrenceQuery,
} from './analysis/render-sentence.js'

// 389 D-13..D-16: render-time pure clustering over the one fingerprint vocabulary. A total
// deterministic function of (resolved verdicts, handoff) — no store, no port, no minted
// identity: the cluster DTO carries the fingerprint value, count and member refs ONLY, and
// a cluster or verdict has no short-ID and no `agentqa://` address (D-16). Published so plan
// 07's CLI block and every later surface fold through ONE function rather than re-deriving
// groups.
// 2026-09-02 (Phase 410): the sixth entity kind left with the Issue-slot cleanup.
export { clusterVerdicts } from './analysis/cluster.js'
export type { AnalysisCluster, AnalysisClusterMember } from './analysis/cluster.js'

// 385 JOBQ-01/JOBQ-02 — the agent job queue: its store port, its per-kind registry, and the
// pumpable engine over both.
//
// What is published is the CONTRACT and the two constructors a composition root calls. What
// is absent is any way to reach storage without the port: no store implementation, no
// checkpoint reader, no path helper. `agent` is storageNeutral, so a host capability
// arriving on this barrel would be a class violation with no legal repair — the store lives
// in `agent-local` and is handed in as a port at composition time.
//
// The refusals are exported as CLASSES because a caller legitimately distinguishes them:
// losing store authority means "another writer is ahead of you, stand down", while an
// undeclared successor or checkpoint means "this handler's declaration is wrong". A single
// opaque error would collapse an operational condition and a programming error together.
//
// No model accessor is exported here and none may ever be (D-11 layer 1): a job's only path
// to a model is the authorship primitive's callback argument, so a handler cannot reach one
// on its own, and the resume path therefore cannot re-invoke one by any route at all.
// The DTO vocabulary itself is NOT republished here (385 plan 02). The request, checkpoint
// envelope and handler outcome are schema's, and a consumer reaches them there — a second
// route to the same names is how two spellings of one contract start to drift.
export {
  JobCancellationNotRequestedError,
  QuarantinedJobRequeueError,
  StaleJobStoreEpochError,
} from './ports/index.js'
export type {
  ChainTerminalRecord,
  ClaimNextOptions,
  JobCancelOutcome,
  JobCheckpointRecord,
  JobCheckpointReadOutcome,
  JobClaimOutcome,
  JobCompleteOutcome,
  JobEnqueueOutcome,
  JobFailureDisposition,
  JobInsert,
  JobRequeueOutcome,
  JobStoreDump,
  JobStoreDumpRow,
  JobStoreFence,
  JobStorePort,
} from './ports/index.js'
export {
  createJobKindRegistry,
  DuplicateJobKindError,
  IncompleteJobKindDeclarationError,
  InconsistentJobKindDeclarationError,
  UnknownJobKindError,
} from './jobs/kind-registry.js'
export type {
  FallbackContinuationInput,
  FallbackContinuationProducer,
  JobBackoffPolicy,
  JobHandler,
  JobHandlerContext,
  JobKindDeclaration,
  JobKindRegistry,
  JobPermanentFailureDisposition,
} from './jobs/kind-registry.js'
// The real job kinds. A composition root registers THESE; the declarations are the contract
// the crash matrix iterates.
export { createRealJobKindRegistry, REAL_JOB_KIND_DECLARATIONS } from './jobs/kinds.js'
export type { PostRunJobCapabilities, StandInJobScript } from './jobs/kinds.js'
// 388 Pattern 2: THE post-run chain's id derivation. A value rather than a type because the
// chip projection, the chain-terminal check and every later reader must ADDRESS the
// same two rows from a runId alone — two copies of this hash input would be two chains that look
// identical in review. It reaches no storage and holds no capability: given a runId and an id
// source it returns two strings, which is why publishing it opens nothing.
// 2026-09-02 (Phase 412): two rather than three — the chain's third derived id left with the
// Issue-slot cleanup.
export { chainJobIdsForRun } from './jobs/chain-identity.js'
export type { ChainJobIds } from './jobs/chain-identity.js'
export {
  createAgentJobQueue,
  JobCancelledError,
  MissingIdempotencyKeyError,
  UndeclaredJobCheckpointError,
  UndeclaredJobSuccessorError,
} from './jobs/engine.js'
export type {
  AgentJobQueue,
  CancelJobInput,
  CreateAgentJobQueueOptions,
  JobIdSource,
  RanJobOutcomeBase,
  RecoverAbandonedClaimsInput,
  RecoverAbandonedClaimsOutcome,
  RunNextJobInput,
  RunNextJobOutcome,
} from './jobs/engine.js'
// 385 plan 05 — the one memoizing checkpointed effect (D-10). The primitive is published so
// every later handler binds THIS contract rather than a private copy of its conditional; the
// capability beside it is a TYPE a composition root implements, and there is still no accessor
// on this barrel that could hand anyone one (D-11 layer 1).
export { recordLlmAuthorship } from './jobs/record-llm-authorship.js'
export type {
  BoundRecordLlmAuthorship,
  JobAuthorCallback,
  JobCheckpointContext,
  JobModelCapability,
  JobModelOutput,
  JobModelRequest,
  JobRecordedValueOutcome,
} from './jobs/record-llm-authorship.js'

// 393 D-08/D-11, WTST-02: gate 4's static assertion-strength check.
//
// ONE value, and it is the narrowest one that satisfies the contract. Plan 01 committed
// `packages/cli/src/authoring/__tests__/corpus-static-gates.test.ts` FAILING against a named
// export on this barrel, before any evaluator existed, and that ordering is the phase's whole
// signature proof — so this export exists to be reached by a suite that named it first, not
// because a consumer asked for a lexicon.
//
// The module's other exports — `assertionStrengthGate`, `classifyDraftSteps` and the five
// pinned lexicons — are deliberately NOT here. Every one of their consumers (the receipt
// assembler, the gate orchestration, the unit differentials) lives inside this package and
// reaches them by relative import, and publishing a lexicon would make widening it a change
// another package could make without touching the retune comment that governs it.
//
// It opens no dispatch path, and the reason is structural rather than by analogy: it is a
// total pure function from an array of strings to a plain object. No fs, no clock, no model,
// no registry, no storage is in its reach — D-06 forces exactly that, because the hermetic
// lane runs this per commit with no LLM by contract.
export { evaluateAssertionStrength } from './authoring/assertion-strength.js'
