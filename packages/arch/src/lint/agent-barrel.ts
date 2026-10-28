// The agent barrel export-set pin (Phase 384, FUNC-01 / SC1).
//
// `invokeFunction` is the only dispatch this package publishes, and it always crosses the
// policy gate. The spec type (declaration PLUS implementation), the spec-level invoke, the
// registry internals seam, and the construct-from-arbitrary-specs factory are all absent
// on purpose: a surface holding any one of them could run a capability without the gate,
// or mint one the catalog never declared. That is a private power, which is exactly what
// the function layer abolishes (T-384-20).
//
// "Absent on purpose" is worth nothing as a comment and everything as an assertion, so the
// pinned set below is compared for EXACT equality — never a contains check. A contains
// check passes happily while the barrel grows a dispatch path beside the pinned names,
// which is the one drift direction SC1 exists to catch.
//
// The value and type sets are pinned SEPARATELY. A name moving between them is a real
// change of kind: a type is erased, a value is callable, and a pinned type quietly
// promoted to a value is precisely how a dispatch symbol would arrive wearing a familiar
// name.

import { parseModuleStatements, stripCodeComments } from './evaluate-pin.js'

/** The pinned barrel, repo-relative. */
export const AGENT_BARREL_FILE = 'packages/agent/src/index.ts'

/**
 * The exact VALUE exports, as finalized by plan 05 and extended by Phase 385 plan 01.
 *
 * The registry factory and the one dispatch; the layer's six caller-facing refusals; the
 * two op-level refusals a surface may legitimately catch and report; and the two masking
 * helpers, which are STAGED for Phase 386's wiring and are a no-op today — every surface
 * that phase built constructs a fresh, empty masking context, so unmasking is the identity
 * function and there is no display boundary for them to carry yet. They are pinned here
 * now so that wiring is a non-breaking change rather than a firewall widening. Neither
 * helper can resolve, gate or run anything, so publishing them opens no path around the
 * dispatch.
 *
 * 385 adds the agent job queue's two constructors and its named refusals. They are
 * safe here for the same structural reason the masking helpers are: none of them is
 * dispatch, and none of them is a host capability. The queue reaches storage only through
 * an injected `JobStorePort`, so nothing on this list can read or write a byte on its own.
 * The list deliberately does NOT carry a store implementation, a checkpoint reader, a path
 * helper, or any model accessor — `agent` is storageNeutral and providerNeutral, and an
 * arrival of that kind is precisely the drift this exact-equality pin exists to catch.
 *
 * 385 plan 04 REMOVES that refusal and adds the six real kinds. The driver now dispatches
 * every handler outcome — a retryable report is retried until the declared bound is spent and
 * a permanent one is terminal — so the class that stood in for the unbuilt path has nothing
 * left to throw, and an error nobody throws is decorative. Its departure from this list is
 * the visible edit plan 02 said it would be. The two declaration refusals that arrive in its
 * place are construction-time: a kind whose declaration is incomplete, and one whose
 * declaration is complete and still cannot be true of any kind.
 *
 * 385 plan 05 adds `recordLlmAuthorship` — and this is the one addition on this list whose
 * ABSENCE would have been the drift. It is the single audited path from a job to a model, so
 * publishing it is what lets every later handler bind one contract instead of re-deriving a
 * "author only if there is no checkpoint" conditional six times. What is still not here, and
 * must never be, is anything that could HAND someone a model: the capability crosses this
 * barrel as a type, and the only value that ever holds one is the argument the primitive gives
 * its author callback (D-11 layer 1).
 *
 * 387 plan 06 adds `AmbiguousStepAddressError`, on the same footing: one more caller-facing
 * refusal, an error CLASS and nothing else. It is here because a surface has to be able to tell
 * an ambiguous ADDRESS apart from an absent answer — the why-verb's `no-trace` arms all say
 * 'that step recorded nothing', and answering an ambiguous address that way would report two
 * steps as none. The class carries the candidate testIds so the surface can say which to choose
 * between; it opens no dispatch path, because the spec it belongs to stays inside `functions/`.
 *
 * 387 plan 01 adds `EntityNotFoundError` — one more caller-facing refusal, on the exact
 * footing as `RunNotFoundError` beside it: a surface asked for one specific address, nothing
 * was ever minted at it, and the surface needs to be able to say so. It is an error CLASS and
 * nothing else; the two `entities.*` specs it belongs to stay inside `functions/`, so the two
 * new capabilities remain reachable only through `invokeFunction` and this addition opens no
 * dispatch path.
 *
 * 2026-10-01 (432-17, D-05): six values and eleven types left with the proposal inbox — the
 * `proposals.accept`/`list`, `knowledge.proposal.apply`, `config.proposal.apply` and
 * `config.undo.propose` ids, `ConfigProposalNotApplicableError`, and the apply, undo-source,
 * proposal-write and propose/apply-outcome port types. Removed, not waived: nothing exports them.
 *
 * 2026-10-01 (432-18, D-14): two values and one type left with the session pin overlay —
 * `ChatPinError`, `createPinOverlay` and `ChatPinOverlayHolder`. Removed, not waived.
 */
export const EXPECTED_AGENT_BARREL_VALUE_EXPORTS: readonly string[] = [
  // 392 plan 01, D-24: the chat turn entry's id. It is here for the reason every op-id constant
  // on this list is — `agent-qa ask` and the REPL must put a name on the wire — and for one more
  // that is specific to this id: publishing it is what makes chat a CLIENT of the function layer.
  // A surface holding the string can still run nothing without a registry, a caller and the gate,
  // and the turn engine's own SPEC stays inside `functions/` like every other.
  'AGENT_ASK_FUNCTION_ID',
  // 389 plan 05: the analysis read op's id, on the exact footing of the two op-id constants
  // below — a string a surface names on the wire, never a dispatch handle.
  'ANALYSIS_GET_FUNCTION_ID',
  // 392 plan 14: the `answer_only` tool NAME, joining `fromToolName` / `isChatMetaToolName` below
  // on their footing and for their reason. Removing `PlannerStageOutcome.answer` left the two live
  // differentials — whose whole content is the ABSENCE of a read of `input.mapped` — needing to
  // re-derive the turn-level prose carry they deliberately model, and the only alternative was a
  // literal `'answer_only'` in each of them: the second catalogue `tool-names.ts` exists as one
  // module to prevent, in the two files least able to afford one. A frozen string; naming a tool
  // reaches no capability, and the tool it names carries no execute callback in any projection.
  'ANSWER_ONLY_TOOL_NAME',
  // 393 plan 07, D-01: the keep-gate evaluator's id, in ASCII sort position and on the exact
  // footing of every op-id constant on this list. Two callers must put this name on the wire — a
  // surface reaching the evaluator, and this phase's e2e proof driving the REGISTERED op rather
  // than the orchestrator behind it — and the alternative is a literal in each, which 387 D-11
  // forbids for the reason a renamed op would then leave a string nothing dispatches. The SPEC
  // stays inside `functions/` like every other, so this opens no dispatch path.
  // 394-09 plan 09, D-21: the user-facing edit's id, on the exact footing of its siblings and for
  // the identical reason — the byte-confinement proof lives in `packages/cli` (the applier needs
  // the yaml CST, which `agent` may not depend on) and reaches the op through `invokeFunction` by
  // name, and 387 D-11 forbids the literal it would otherwise spell. The SPEC stays inside
  // `functions/`, so this opens no dispatch path.
  'AUTHORING_DRAFT_EDIT_FUNCTION_ID',
  'AUTHORING_DRAFT_VERIFY_FUNCTION_ID',
  // 394 plan 02, D-01: the authoring LOOP's id, on the exact footing of its sibling above and for
  // the identical reason — `composeLocalAgent()` and this phase's e2e proof both put this name on
  // the wire, and 387 D-11 forbids the literal each would otherwise spell. The SPEC stays inside
  // `functions/`.
  'AUTHORING_DRAFT_WRITE_FUNCTION_ID',
  // 394-07 plan 07, D-12/D-13: the honesty funnel read's id, on the exact footing of its two
  // siblings above and for the identical reason — `composeLocalAgent()` binds through it and a
  // CLI render must put this name on the wire, and 387 D-11 forbids the literal each would
  // otherwise spell. The SPEC stays inside `functions/`, so this opens no dispatch path.
  'AUTHORING_FUNNEL_GET_FUNCTION_ID',
  // 394 plan 02, D-01: the CLOSED, ORDERED stage vocabulary. A frozen string tuple, and it is on
  // this list because it is the SUBJECT of a claim rather than decoration — the ordering pin
  // asserts sequence equality against it, and a vocabulary a pin cannot name is one the pin has to
  // re-spell, which makes the pin a second list of the stages instead of a check on the first.
  'AUTHORING_LOOP_STAGES',
  'AmbiguousStepAddressError',
  // 392 plan 01: the closed stage-1 resolver table and its lookup. A DECLARATION and a pure
  // predicate walk over it — the table's entries name op ids, and naming an op buys nothing
  // without the registry, the caller and the gate. Published because the composition root
  // assembles the engine over it and the D-05 meta-test walks it.
  // 392 plan 06, CHAT-04 / D-20: the two pinned compaction numbers. They are on this list for a
  // reason the other constants here do not have — they are the SUBJECT of a decision. D-20 refuses
  // spec §4.1's configurable fraction, and a pinned value no surface can name is a value a second
  // surface re-spells with its own number. Publishing them is what lets a later conformance
  // assertion compare against the declaration rather than a literal. Neither is dispatch, and
  // neither can be written: they are frozen module constants.
  // 392 plan 08, D-06: what `/help` prints, spelled beside the table it describes. A frozen string
  // constant — it dispatches nothing — and it is pinned because help text kept anywhere other than
  // the canon it documents becomes a second list of what chat understands, free to drift from the
  // one that actually routes.
  // 398 plan 09, D-01/SC-1: the two halves the help ↔ catalog census joins on. `CHAT_DIRECTIVES`
  // is the closed set of forms that map to NO capability and `CHAT_HELP_ENTRIES` is what `/help`
  // prints in a shape a census can read. Both are frozen data; `CHAT_HELP_TEXT` below is now a
  // projection of the entries rather than a second spelling of them.
  'CHAT_DIRECTIVES',
  'CHAT_HELP_ENTRIES',
  'CHAT_HELP_TEXT',
  'CHAT_MINIMUM_CONTEXT',
  'CHAT_RESOLVER_TABLE',
  'COMPACTION_RATIO',
  // 395-01, D-01/D-03: the config editor's two op ids, on the exact footing of the
  // `AUTHORING_*_FUNCTION_ID` constants above and for the identical reason — `composeLocalAgent()`
  // and this phase's composed proof both put these names on the wire, and 387 D-11 forbids the
  // literals each would otherwise spell. The SPECS stay inside `functions/`, so this opens no
  // dispatch path.
  'CONFIG_AUTH_SET_FUNCTION_ID',
  'CONFIG_FIELD_SET_FUNCTION_ID',
  'CONFIG_HOOK_ADD_FUNCTION_ID',
  // 395-05, D-01: the rest of the closed action class's op ids, in SORT position beside the two
  // above and published for the identical reason — `composeLocalAgent()` and this phase's composed
  // proofs put these names on the wire, and 387 D-11 forbids the literals each would spell.
  'CONFIG_TARGET_CREATE_FUNCTION_ID',
  'CONFIG_TARGET_EDIT_FUNCTION_ID',
  'DuplicateFunctionIdError',
  'DuplicateJobKindError',
  // 428-07, D-07: the editor subject's minter, published beside runs.liveurl's — its id and its
  // named refusal only. Its spec stays private like every other: a spec carries its own `invoke`.
  'EDITOR_LIVE_URL_FUNCTION_ID',
  // 398 D-09: `explain`'s id, on the exact footing of every `*_FUNCTION_ID` elsewhere in this list — a name a caller
  // puts on the wire, never a dispatch handle. In SORT position: this list is compared against the
  // barrel's sorted export set by exact positional equality.
  'EXPLAIN_FUNCTION_ID',
  'EntityNotFoundError',
  // 405-05 (D-15): the caller-facing refusal for a run that EXISTS and holds no blob under that
  // content address, on the exact footing of its siblings here — an error CLASS, not a dispatch
  // path, so a surface holding it can run nothing. It crosses because "no such run" and "no such
  // blob" are different things a page must render, and across a boundary neither package's types
  // cross, a NAME is the only carrier that distinction has. In SORT position; this list is
  // compared against the barrel's sorted export set by exact positional equality.
  'EvidenceBlobAbsentError',
  // 2026-10-01 (432-19, D-15): 'FunctionDeniedError' left with the execution gate that raised it.
  'FunctionInputError',
  'FunctionNotBoundError',
  // 2026-10-01 (432-20, D-12): 'FunctionOriginError' and 'FunctionScopeError' left with the scope
  // and human-origin checks that raised them.
  'IncompleteJobKindDeclarationError',
  'InconsistentJobKindDeclarationError',
  'JobCancellationNotRequestedError',
  'JobCancelledError',
  // 2026-09-06, 416 D-17: a read-op name and named refusal, never a dispatch handle.
  'KNOWLEDGE_GATES_LIST_FUNCTION_ID',
  'KnowledgeGatesUnboundError',
  // 392 plan 09, CHAT-03 / D-15: the pinned rational ceiling. On this list because a SUMMARY, a
  // gate run and a field projection all have to quote the same pin — a ceiling re-spelled at a
  // consumer would let two readings of "within tolerance" coexist. It is a frozen pair of
  // integers: it reaches nothing and decides nothing on its own.
  // 403-01 (D-01..D-04): the liveUrl token pair, its op id and its two caller-facing refusals,
  // each in its own sorted slot. VALUES rather than types because there is exactly ONE mint and
  // ONE parse of a live-view capability token in this system, and every surface reaches them BY
  // REFERENCE through this barrel — a dashboard route or a frame proxy that could only name the
  // shapes would have to write its own parse, which is the second token authority LIVE-02 forbids.
  'LIVE_EMBED_PATH_PREFIX',
  'LIVE_URL_TOKEN_VERSION',
  'LIVE_URL_TTL_MS',
  'LiveViewUnavailableError',
  'MARK_UNHANDLED_CEILING',
  'MissingIdempotencyKeyError',
  // 2026-09-08, 419 GATE3-01: runtime dep vocabulary, DATA with no dispatch handle.
  'OPTIONAL_FUNCTION_DEP_KEYS',
  // 390 plan 04: the three quarantine verb ids, on the same footing as the op-id constants
  // above and below — strings a surface names on the wire, never dispatch handles. The three
  // SPECS are deliberately NOT here: a spec carries the implementation and the live
  // validators, and two of these verbs write the committed ledger.
  'QUARANTINE_ADD_FUNCTION_ID',
  'QUARANTINE_LIST_FUNCTION_ID',
  'QUARANTINE_RELEASE_FUNCTION_ID',
  'QuarantinedJobRequeueError',
  'REAL_JOB_KIND_DECLARATIONS',
  // 388 plan 03: the chip-truth op's id, on the same footing as the apply id above. Plan 04's
  // exit summary line dispatches through the registry and has to put a name on the wire; the
  // alternative is a literal in the CLI, which is a second declaration of a capability's name.
  // A string is not a dispatch handle — naming an op still buys nothing without a registry, a
  // caller and the gate.
  // 391 D-16/D-17: the per-run digest op's id, on exactly the footing of the four op-id
  // constants around it. The CLI's `digest` verb and the tail's fetch pointer both have to put
  // this name on the wire, and the alternative is a literal in the CLI — a second declaration of
  // a capability's name. A string is not a dispatch handle.
  // 405-01 (D-03): the durable run-detail read's id, on the footing of every op-id constant
  // around it. `packages/dashboard-server` may not import the agent package at all, so the route
  // that serves `GET /api/runs/:id/detail` receives this name as DATA from the composition that
  // knows it. A string is not a dispatch handle — and its SPEC is deliberately not on this list,
  // because a spec carries its own `invoke`.
  // 405-05 (D-12/D-13): the ref-resolving read's id, on the footing of every op-id constant around
  // it. BOTH doors' artifact arms live in `packages/dashboard-server`, which may not import the
  // agent package at all, so the name reaches them as DATA from the composition that knows it. A
  // string is not a dispatch handle — and its SPEC is deliberately not on this list, because a
  // spec carries its own `invoke`.
  'RUNS_ARTIFACT_FUNCTION_ID',
  'RUNS_DETAIL_FUNCTION_ID',
  'RUNS_DIGEST_FUNCTION_ID',
  // 404 plan 05 (D-22): the recorded-event stream's id, on the footing of every op-id constant
  // around it. The dashboard's post-processing read joins chip truth with the run's own recorded
  // POSTURE — who was going to drain the chain, and the last per-stage failure line — and it
  // dispatches that read through the injected host. `packages/dashboard-server` may not import
  // this package at all, so the id has to be HANDED to it; a literal there would be a name it
  // cannot type-check against the spec that answers to it. A string is not a dispatch handle.
  'RUNS_EVENTS_FUNCTION_ID',
  'RUNS_EVIDENCE_FUNCTION_ID',
  // 407-01 (D-05): the Knowledge panel read's id, on the footing of every op-id constant around
  // it. The route that serves `GET /api/runs/:id/knowledge` lives in `packages/dashboard-server`,
  // which may not import the agent package at all, so the name reaches it as DATA from the
  // composition that knows it. A string is not a dispatch handle — and `runsKnowledgeSpec` is
  // deliberately not on this list, because a spec carries its own `invoke`, which is the private
  // power SC1 abolishes.
  'RUNS_KNOWLEDGE_FUNCTION_ID',
  // 392 plan 07: the run listing's id — what the `status` alias resolves to, published so the
  // composed compound e2e names the op by IMPORT rather than by a literal it made up.
  'RUNS_LIST_FUNCTION_ID',
  // 403-01 (D-03): the mint op's id — the second op id a surface must be able to NAME rather
  // than infer, on the `RUNS_START_FUNCTION_ID` footing below: the dashboard command dispatches
  // the mint through the registry, and the alternative is a string literal in the CLI.
  'RUNS_LIVE_URL_FUNCTION_ID',
  // 2026-09-15, 423 D-19: identity DATA; the executable history spec remains private.
  'RUNS_MARKS_HISTORY_FUNCTION_ID',
  // 2026-09-08, 419 GATE3-01: identity DATA; the executable mark spec remains private.
  'RUNS_MARK_FUNCTION_ID',
  // 2026-09-15, 423 D-16: identity DATA; the executable preview spec remains private.
  'RUNS_MARK_PREVIEW_FUNCTION_ID',
  // 431 D-06: the run overview's id; `runsOverviewSpec` stays off this list like every spec.
  'RUNS_OVERVIEW_FUNCTION_ID',
  'RUNS_POST_PROCESSING_FUNCTION_ID',
  // 393 plan 07, D-02: the run-start op's id. It is the last of the `runs.` constants to be
  // published and the only one published for a reason INSIDE the composition rather than at a
  // surface: `composeLocalAgent()` dispatches every gate-run through the real `runs.start`
  // (op-calls-op), so the markers a gate-run is confirmed by are read off the run's own record by
  // the one function that reads them there. Naming it by import is what makes a rename break that
  // binding's compile instead of leaving it pointing at a string nothing dispatches.
  'RUNS_START_FUNCTION_ID',
  // 2026-10-18 (444-13, D-17): the verdictless refusals beside `RunNotFoundError`.
  'RunEndedWithoutVerdictError',
  'RunNotFinishedError',
  'RunNotFoundError',
  'RunNotRecordedError',
  // 392 plan 09, D-15 / CHAT-03: THE frozen corpus and its version. This is the ceiling's
  // denominator, and it is on this list for the reason the treadmill law states — both lane
  // runners must iterate the SAME admitted set, and a manifest each assembled for itself would be
  // two denominators that drift silently. A frozen array of records: no storage, no dispatch, and
  // nothing in its reach can decode a byte, which is what stops it from becoming the glob it
  // exists to refuse.
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
  // 388 plan 01: the post-run chain's ONE id derivation. It joins the value list rather than
  // the type list because addressing is a computation, not a shape — the chip projection, the
  // chain-terminal check and every later reader must derive the same three job ids from a
  // runId, and a second copy of that hash input would be a second chain that reviews
  // identically. It is a pure function of a string and an injected id source: it reaches no
  // storage, holds no capability, and dispatches nothing, so publishing it opens no path.
  // 392 plan 09: the ceiling comparison itself — strict greater-than on cross-multiplied
  // integers. Published so no consumer re-derives it as a rounded percentage, which is the exact
  // failure the exact arithmetic exists to prevent.
  // 394-08 plan 08, D-03/D-10 · WTST-08: the ONE site that assembles the fan-out bound's three
  // terms, and the only caller of `computeFanOutBound` in this package. It joins the value list on
  // `ceilingExceeded`'s precedent and for its stated reason — that constant is published so no
  // consumer re-derives the comparison as a rounded percentage — with one addition that is this
  // op's whole point: the dispatch-confirm cells compare the number a person was SHOWN against this
  // function rather than against a literal, and a literal in a test passes just as happily against
  // a second arithmetic that has drifted. It is a pure function of one optional boolean: it reaches
  // no storage, holds no capability and dispatches nothing.
  'authoringFanOutBound',
  'ceilingExceeded',
  'chainJobIdsForRun',
  // 389 plan 05: render-time pure clustering (D-14). A total deterministic function of
  // (resolved verdicts, handoff) keyed on schema's one `failureFingerprint` vocabulary — it
  // persists nothing, reaches no storage and mints no identity (D-16), so publishing it
  // opens no path and no second problem-identity vocabulary.
  'clusterVerdicts',
  // 392 plan 08, D-23: the chat-open banner. Published because the only surface that opens a chat
  // lives in `cli`. It composes REGISTERED reads through the invoke binding it is HANDED — it holds
  // no reader, reaches no store, and cannot dispatch anything the caller did not already grant.
  // The one-read law is what it exists to keep, and its suite pins the absence of a scheduler.
  'composeBanner',
  // 392 plan 09, D-15: the ONE projection over `mark_unhandled` rows. The harness's corpus rate
  // and a live deployment's field rate are the same function over the same event kind, and a
  // second counter anywhere would be a second definition of what a refusal is.
  'computeMarkUnhandledRate',
  'createAgentJobQueue',
  // 392 plan 06, CHAT-04: the compaction hook factory and, below, the pure pass it wraps and the
  // replay projection it feeds on. All three are published because the ONLY thing that can bind a
  // compaction hook is the composition root — the one place holding both a `TokenAccounting`
  // instance and a session log. None of them can construct a model or resolve capabilities: the
  // accounting instance is DATA a host hands over, which is why `agent` still declares no
  // dependency on `model` and this list gains no path to a provider.
  'createChatCompactionHook',
  // 392 plan 08, RESEARCH Open Q2: the live turn state container. On this list because its two
  // consumers — the composition root that creates it and the REPL that renders from it — are both
  // outside this package. A plain in-memory object: no fs, no model, no dispatch, no subscription.
  'createChatState',
  'createFunctionRegistry',
  'createJobKindRegistry',
  // 392 plan 07, CHAT-01 / CHAT-06: stage 2 itself. It is on this list because the composition root
  // is the only thing that can bind it, and it opens no path this pin exists to close: the stage
  // takes an ALREADY-BUILT model and answers with a PLAN — intentions over execute-less tools — so
  // nothing it returns can run without crossing `invokeFunction`. In SORT position, like its
  // siblings: this list is compared against the barrel's sorted export set positionally.
  'createPlannerStage',
  'createRealJobKindRegistry',
  // 392 plan 01, D-16/D-24: the turn engine factory, the deterministic reconciliation strategy,
  // the clause splitter, the refusal sentence and the table lookup. Every one is a pure
  // assembly or a pure function over injected seams: the engine reaches capabilities ONLY through
  // the `ChatInvokeBinding` its composition supplies, so nothing here dispatches, and the
  // strategy's presence on this list is what lets the D-16 mutation proof compose the real host
  // twice without a production knob existing that could do the same.
  'createTurnEngine',
  // 403-01 (D-01): the token body's codec, published as the mint/validate pair's own helpers so
  // no consumer hand-rolls a second base64url over the claims body.
  'decodeBase64Url',
  'deterministicOverrideStrategy',
  // 392 plan 10, D-16: the model-plan reader's half of the tool-name mapping, in ASCII sort
  // position around `invokeFunction` because this list is compared positionally. Published so the
  // mutation proof's override-OFF strategy reverses a tool name through the ONE module that owns
  // the rename instead of spelling a second one — a differential whose test double re-derived the
  // grammar could red for a reason unrelated to the mechanism it is measuring. Neither symbol is
  // dispatch: one answers a boolean about a string, the other refuses the two orchestration names
  // and otherwise returns a string, and an unregistered id still dies at `invokeFunction`.
  // 393 plan 04, D-08/WTST-02: gate 4's static assertion-strength check, in SORT position
  // like its neighbours. It is on this list because plan 01's cli-side proving suite NAMED it on
  // this barrel while no evaluator existed — the RED-first receipt — so its absence would have
  // been the drift. A total pure function of an array of strings: it holds no capability, reaches
  // no storage and dispatches nothing, and the four lexicons plus the two receipt-facing entry
  // points it sits beside stay off this list on purpose, so widening a lexicon remains an edit
  // inside the module that carries its retune comment.
  // 403-01 (D-01): the token body's codec — see `decodeBase64Url` above.
  'encodeBase64Url',
  'evaluateAssertionStrength',
  // 399.1 D-01/D-03: the result fold the composition root runs on the invoke return path — it
  // executes a spec's declared classifier and render fold and answers with DATA. It is on this list
  // because it is the ONE published function that touches a spec, and a reader has to be able to
  // see that it dispatches nothing: it takes a registry it did not construct, runs no capability,
  // reaches no port, and a caller holding it can run nothing it could not already run through
  // `invokeFunction`. In ASCII SORT position; this list is compared positionally.
  'foldFunctionResult',
  'fromToolName',
  // 394-07 plan 07, D-12/D-14: the funnel projection, the mixed-verdict stability gather and the
  // pure window scope — this entry and `projectAuthoringFunnel` / `scopeReceiptsToWindow` below,
  // each in ASCII SORT position because this list is compared positionally. All three are pure
  // functions over INJECTED reads, and the bundle a composition fills carries no run capability at
  // all — which is what makes D-14's zero-runs claim structural rather than a rule. They are here
  // because the composition root that binds the bundle and the surfaces that render the funnel are
  // both outside this package, and because the exact-equality session rule is driven by a cell
  // directly rather than through the op's observable output.
  'gatherSuiteStability',
  'invokeFunction',
  'isChatMetaToolName',
  // 403-01 (D-04): the URL composer. Published because it is the one expression of "the token
  // rides the fragment" — a surface that assembled the URL itself could put it in a query.
  'liveUrlOf',
  // 392 plan 06: the pure trigger pass (see `createChatCompactionHook` above). A total function of
  // (messages, accounting, turnId, clock) returning a conversation and at most one event — no
  // storage, no dispatch, and no branch that fails to return a conversation.
  'maybeCompact',
  // 403-01 (D-01): the ONE minter of live-view capability tokens, published so `runs.liveurl`
  // stays its only caller and every other surface must go through the op.
  'mintLiveUrlToken',
  // 392 plan 09, CHAT-02: the ONE validator that turns a decoded scenario document into a
  // `ChatScenario`. It takes an already-decoded value rather than a path, which is why it can live
  // in a storageNeutral package at all: no `node:fs` is in its reach, and the eight lines of file
  // reading stay in the runners. Published because both lane gates — hermetic in `agent-local`,
  // live in `cli` — must reach the same verdict about a malformed corpus file.
  'parseScenario',
  // 392 plan 07: the registry walk projected to execute-less tools. Safe here for a reason the
  // absence of a callback makes structural: what it returns cannot run anything, so a surface
  // holding it holds a catalogue description and not a dispatch path.
  'projectAuthoringFunnel',
  'projectPlannerTools',
  'recordLlmAuthorship',
  // 391-06: the clustered BLOCK layout, relocated out of the CLI when `runs.digest` became its
  // second caller. Published on the sentence renderer's footing and for its reason — one layout,
  // imported once. A pure string fold over an op result: no storage, no capability, no dispatch.
  'renderAnalysisClusterBlock',
  // 389 plan 05: THE sentence renderer (D-05). A pure string composer over typed parts — it
  // reads no storage, holds no capability and dispatches nothing; it is published precisely so
  // plan 07's CLI print and every later surface compose sentences through ONE symbol instead of
  // spelling a second one (SC3 structural).
  'renderVerdictSentence',
  // 392 plan 03, CHAT-05: the two pure functions that decide what a damaged session log means and
  // what a resumed session remembers. They are on this list because BOTH session-log adapters and
  // any later session reader must reach the same verdict — a second adapter deciding for itself
  // whether a turn dangled would be two hosts disagreeing about whether a conversation happened.
  // Neither is dispatch: they take records and return records, and nothing in their reach can
  // touch a filesystem, a model or the registry.
  'repairSession',
  'replaySession',
  // 392 plan 06: the repaired replay as messages the accounting substrate can measure. A pure
  // carry-across, and its place on this list is what lets a host feed a conversation the SAME way
  // the hook's default does rather than deriving a second one beside it.
  'replayToModelMessages',
  // 392 plan 01: the pure table walk stage 1 is (see `CHAT_RESOLVER_TABLE` above).
  'resolveClause',
  // 394 plan 02, D-01: the six-stage orchestration itself. A PURE function of (input, deps) — it
  // reaches no host API and no registry; every capability it needs arrives in the deps record the
  // op hands it, and the op is the only thing that can assemble one. Published so the ordering pin
  // drives the real function over injected fakes rather than inferring a stage order from the op's
  // observable side effects, which is the difference between pinning the order and pinning a
  // shadow of it.
  'runAuthoringLoop',
  // 392 plan 09: how a scenario is ADDRESSED — `<class>/<id>.yml`. A pure string join, published
  // beside the manifest so the two runners and the closure walk cannot spell a corpus path three
  // ways.
  'scenarioRelativePath',
  // 394-07 plan 07: see the funnel note beside `gatherSuiteStability` above.
  'scopeReceiptsToWindow',
  // 392 plan 02, D-09: THE conjunction grammar — the quote-aware tokenizer the composition root
  // binds as the engine's `ClauseSplitter`. It REPLACES `wholeUtteranceSplitter`, which plan 01
  // published as the tracer's placeholder and which this plan deletes: a published splitter that
  // nothing binds is a second answer to "how is an utterance split", and the one thing this
  // subtree cannot afford is two of those. Pure and total — no host API, no throw, no dispatch.
  'splitClauses',
  // 392 plan 01, D-08: the ONE refusal sentence a fail-closed turn carries. A pure string
  // function — published so a surface (and plan 02's scenario corpus) asserts against the
  // shipped wording rather than re-spelling it.
  'unhandledReason',
  // 403-01 (D-02): the ONE parse of a live-view token. The dashboard route and the frame proxy
  // bind THIS by reference; a private parse anywhere else is a second token authority.
  'validateLiveUrlToken',
]

/**
 * The exact TYPE exports: the agent ports, the registry's options and handle, the
 * function-layer contract vocabulary, and the three injected read ports a composition
 * root implements. `FunctionDeclaration` is the capability-free VIEW of an op; the spec
 * types that carry an implementation are deliberately not here.
 *
 * 385 adds the agent job queue's contract vocabulary: the store port and its verb outcomes,
 * the per-kind declaration surface, and the engine's handle. Types are erased, so none of
 * these can carry behaviour across the barrel — what they carry is the SHAPE later phases
 * bind, and pinning them here is what makes a widening of that shape a visible edit rather
 * than an incidental one.
 *
 * 385 plan 02 REMOVES four names from this list and adds one. The enqueue request, the
 * chained request and the handler outcome now live in the schema package, because each one
 * crosses a boundary where a type is not enough — a caller in another process, bytes an
 * earlier build wrote, data a handler returned — and each therefore needs a runtime schema
 * beside it. Republishing them here would give every consumer two names for one contract and
 * no way to tell which one a later edit widened. What stays is `JobInsert`: the row the
 * engine hands the store, which never crosses a boundary and is nobody's public vocabulary.
 *
 * 385 plan 05 adds the authorship vocabulary. `JobModelCapability` is the interesting one: it
 * describes a model STRUCTURALLY so a composition root can adapt a real one onto it, which is
 * how this package stays provider-neutral while its jobs still author. A type is erased, so
 * its presence here hands nobody a model; what would be a violation is a VALUE that could
 * produce one, and the list above still has none.
 *
 * 385 plan 10 adds `RunInvocationPort`, `StartedRun` and `OptionalFunctionDepKey` — the
 * vocabulary a composition root implements to make `runs.start` bound in its host (D-16),
 * and the union naming which deps that conditional binding may hang on. All three are types,
 * so none of them hands a surface a way to start a run: the only value that could is the
 * port a COMPOSITION constructs and injects, and `invokeFunction` is still the one dispatch.
 *
 * It also adds the cancellation vocabulary. The engine verb and the two refusals are here
 * while NO surface exposes cancel in this phase, and that is deliberate: the semantics are
 * complete now because the seam a cooperative cancel is honoured at is inside the driver, and
 * a driver that shipped without it would have to be reopened with handlers already written
 * against it. Publishing the contract without a UI is the cheap half; retrofitting the check
 * is the expensive one.
 *
 * 387 plan 01 adds `EntityDirectoryPort` — the fourth REQUIRED read port on `FunctionDeps`,
 * the contract a composition root implements to make entity addresses resolvable in its host.
 * It joins for the same reason its three siblings are here: a composition has to be able to
 * NAME the thing it implements, and `entities` would otherwise be the one required port whose
 * shape a host could only satisfy by structural accident.
 *
 * It opens no dispatch path, and the reason is stronger than "types are erased". The port's
 * two verbs answer questions ABOUT entities and hand back data — a descriptor union and a
 * descriptor — with no vocabulary for a card and no way to reach the registry. Nothing on it
 * can resolve, gate or run a capability; the only value that ever implements it is the object
 * a composition constructs and injects, and `invokeFunction` remains the one dispatch. What
 * would have been a violation is publishing the card producer, and it is deliberately absent
 * from both lists: exactly one module in this package builds an `EntityCard` (ENTY-02), and
 * putting it on this barrel would have made "one producer" a convention instead of a fact.
 *
 * 387 plan 06 adds six more types and no values: `KnowledgeReviewPort` with its
 * `KnowledgeProposalRequest` and `KnowledgeApplyOutcome` vocabulary, and the step-evidence
 * read's `StepEvidenceAddress` / `StepEvidenceLookup` pair. They are here for the reason the
 * ports above are — a composition root has to be able to name what it implements, and
 * `knowledgeReview` is an OPTIONAL member, so a host that omits it is making a deliberate
 * statement rather than forgetting, and a statement is easier to make deliberately when the
 * thing being declined has a name.
 *
 * `KnowledgeReviewPort` is the first WRITE-shaped contract on this barrel, so the "opens no
 * dispatch path" argument is worth making explicitly rather than by analogy. It is a type: it
 * has no constructor here, no default, and no module in this package produces one. A surface
 * holding it can write nothing, because there is nothing to hold — the only value that ever
 * implements it is the object a composition constructs over the writer-gated knowledge entry,
 * which lives one package away behind the reader carve-out, and the only way to reach that
 * object at all is `invokeFunction` dispatching an op whose deps the registry owns. Publishing
 * the port's TYPE is what lets a host say "I do not supply this"; publishing anything that
 * could build one would have been the violation, and neither list has such a thing.
 */
export const EXPECTED_AGENT_BARREL_TYPE_EXPORTS: readonly string[] = [
  'AgentJobQueue',
  // 389 plan 05, three names. `AnalysisArtifactReaderPort` is the optional artifact-read
  // dep a composition root implements (plan 06 binds it over the run-directory analysis.json
  // + version guard) — a type, so it carries no filesystem across the barrel. The other two
  // are the cluster DTO and its member ref (D-16 — fingerprint value, count, member refs,
  // representative testIndex; deliberately NO id and NO address field, and the exact-key pin
  // in cluster.test.ts holds that shape); the value beside them is the pure function pinned
  // in the value list.
  'AnalysisArtifactReaderPort',
  'AnalysisCluster',
  'AnalysisClusterMember',
  // 394 plan 02, D-01: the loop's own vocabulary, types only — its input, its dep record, its
  // four-arm outcome union, its result (outcome + the stages actually entered) and the stage name
  // type — plus the two host-half mirrors a composition root implements and the outcome of staging
  // a compiled draft. Nothing here carries behaviour across the barrel; what they carry is the
  // SHAPE plans 04-06 fill, which is exactly the widening this exact-equality pin exists to make a
  // visible edit rather than a quiet one.
  // 394-07 plan 07, D-12: the funnel's port bundle and (below) the outcome-history mirror a
  // composition root fills, both in ASCII SORT position. TYPES, so neither carries a capability
  // across the barrel; what they carry is the SHAPE `composeLocalAgent()` binds, and pinning them
  // is what makes a widening — a run capability arriving on the funnel's bundle, say — a visible
  // edit to this list rather than a quiet acquisition of the thing D-14 exists to forbid.
  'AuthoringFunnelPortLike',
  'AuthoringLoopDeps',
  'AuthoringLoopInput',
  'AuthoringLoopOutcome',
  'AuthoringLoopResult',
  'AuthoringLoopStage',
  'AuthoringReadPort',
  'AuthoringReadPortLike',
  'BoundRecordLlmAuthorship',
  // 392 plan 01: the turn engine's injected-seam vocabulary and its dep record. Types only, so
  // none of them carries behaviour across the barrel — what they carry is the SHAPE the expansion
  // plans fill (planner stage, reconciliation strategy, compaction hook, per-stage caller mint),
  // which is exactly the widening this exact-equality pin exists to make a visible edit.
  'CallerMint',
  'CancelJobInput',
  // 398 D-09/D-11: the seat a composition root fills to bind `agent.explain` — the catalog as data,
  // the model's citation over it, and the two coverage hooks. A TYPE, so nothing crossing here can
  // read a file or reach a model; what a host receives is the obligation, not a capability. Pinned
  // so a fifth method — or a `citeCapabilities` that could answer a command string — is a visible
  // edit to this list rather than a quiet widening of the one seam D-10's no-invention law rests on.
  'CapabilityCatalogPort',
  // 388 plan 01. `ChainJobIds` is what the derivation above answers with; `ChainTerminalRecord`
  // is the optional argument the two terminal store verbs now accept, and `PostRunJobCapabilities`
  // is what a composition root implements to make analyze-run and curate-memory REAL rather than
  // scripted. All three are types, so none of them hands anyone a handoff reader or a curation
  // drain — the only values that implement the last one are built by a composition, which is the
  // whole point of naming it here.
  'ChainJobIds',
  'ChainTerminalRecord',
  // 392 plan 07, Pitfall 1 / 391 D-06: which stage proved a binding. Pinned because the caller a
  // clause executes under is decided by this value and by nothing else — a third member here would
  // be a third origin story for an invocation, and the pin makes adding one a visible edit.
  'ChatBindingStage',
  'ChatClause',
  // 392 plan 06, CHAT-04 / D-20: the compaction vocabulary. `ChatTokenAccounting` (below) is the
  // one that carries the design decision — it is the SHAPE of the accounting instance a host hands
  // over, restated here rather than imported, because `agent` depends on neither `model` nor a
  // provider and must keep it that way (`AuthorTokenBudget`'s precedent). The degrade option and
  // outcome types ride with it for the same reason: a composition root that could supply an
  // accounting instance but not NAME what one answers with would spell the union again locally,
  // which is the second vocabulary this subtree exists to avoid (388 C13).
  'ChatCompactionHookDeps',
  // 392 plan 07, D-04: the configuration facts a session is sensitive to. A TYPE, and the shape is
  // the feature — a REQUIRED toolset hash beside OPTIONAL ids, because the header line can carry
  // one and not the other, and a fold that filled the ids in would be inventing a delta.
  'ChatConfigState',
  'ChatDegradeOptions',
  'ChatDegradeOutcome',
  // 392 plan 02: the directive vocabulary and stage 1's two-variant answer. `ChatResolution` is
  // what the published `resolveClause` returns, and its presence here is what makes a third
  // variant — or a confidence number — a visible edit to this pin rather than a quiet widening
  // of the one path in the system that OVERRIDES a model's plan (D-09/D-12).
  // 392 plan 08, D-04 / D-21: the four session directives as handlers, and what a `/model` handler
  // reports back. TYPES, so nothing here carries a capability — what they describe is a seat a
  // COMPOSITION fills, and pinning them is what makes a fifth directive a visible edit rather than
  // a quiet widening of the one clause class that never crosses the function layer.
  'ChatDirectiveHandlers',
  'ChatDirectiveName',
  // 398 plan 09: one line of `/help`, as a census reads it. A TYPE over frozen data — the shape is
  // the join key (`alias`) plus the form a person types (`syntax`), and pinning it is what makes a
  // help line growing a field the census cannot read a visible edit.
  'ChatHelpEntry',
  // 399.1 D-01/D-05: what that binding now ANSWERS — payload, verdict, fold lines. Pinned beside
  // the binding itself because the two are one contract: the seam used to answer `unknown`, which
  // is why the engine's only derivation for a receipt status was throw-versus-return, and a member
  // leaving this envelope is exactly the kind of quiet narrowing that gap was made of.
  'ChatInvokeAnswer',
  'ChatInvokeBinding',
  // 392 plan 07, CHAT-06: a model OBJECT, never a model id. The SDK's own `LanguageModel` type also
  // admits a bare id it resolves by constructing a client, which is a second door to the thing the
  // firewall closes — this alias is that door shut at the type, and pinning it is what makes
  // widening it back a visible edit rather than an incidental one.
  'ChatLanguageModel',
  // 392 plan 08: what the last turn did, as a surface renders it. A TYPE over data the turn result
  // already carries; it exists so a REPL reading live state and a REPL reading a result are
  // reading one vocabulary rather than two.
  'ChatLastTurn',
  // 392 plan 08, D-04: the two model names a `/model` moved between. Pinned beside the handler set
  // because the engine turns this pair into the session's `model_change` through `diffChatConfig`
  // — the ONE construction site for that event — and a handler that emitted its own would be the
  // second one 392-07 warned against.
  'ChatModelDirectiveOutcome',
  // 392 plan 03: one rebuilt line of conversation — refs and one-liners, never a payload body.
  'ChatReplayMessage',
  'ChatResolution',
  'ChatResolverEntry',
  'ChatResolverRule',
  'ChatResolverTable',
  // 392 plan 08, RESEARCH Open Q2: the live turn state's three names. TYPES, and the shape is the
  // decision — a plain container the engine mutates and a surface reads, with no subscription and
  // no transport, because the SDK's `AbstractChat` auto-executes tool calls and D-10 says nothing
  // runs before the reconciler has spoken. Pinning them makes adopting that machinery a visible
  // edit here rather than a quiet swap underneath a surface.
  'ChatStateContainer',
  'ChatStateSnapshot',
  // 392 plan 06: the three accounting methods chat needs, and not one more. `recordUsage` is
  // deliberately absent — a compaction pass that could re-anchor the estimator would be writing to
  // the very number it is about to read.
  'ChatTokenAccounting',
  'ChatToolsetFingerprint',
  'ChatTurnPort',
  // 392 plan 08: where the engine publishes the turn id and the turn's outcome. A TYPE and a
  // one-way seam — the engine writes, a surface reads — and the id going out at the START of a
  // turn is what lets a Ctrl+C handler name the turn it is interrupting (D-19's graceful arm).
  'ChatTurnStateSink',
  // 388 plan 09. The optional options argument `claimNext` now accepts — a TYPE, so it hands
  // nobody a store; the exclusion it names is honoured inside the sqlite SELECT and set once
  // at queue construction (`unclaimableKinds` on `CreateAgentJobQueueOptions`, already pinned).
  'ClaimNextOptions',
  // 392 plan 07: one step of an execute verdict — a binding plus the stage that proved it. A TYPE,
  // so it dispatches nothing; what it carries across the barrel is the fact the engine mints a
  // caller with, which a consumer re-deriving it would have to guess at by matching op ids.
  'ClauseAction',
  'ClauseSplitter',
  // 399.1 D-02/D-03: what an op's classifier answers about its own result. A two-field TYPE, and it
  // is pinned because its STATUS SET is the subject of a decision — three members a classifier may
  // return, deliberately excluding `not-run`, which describes a clause the engine never attempted
  // and which no op may claim.
  'ClauseVerdict',
  'ClockPort',
  'CompactionHook',
  // 392 plan 06: what a pass is asked and what it answers. `CompactionPass` carries `messages` on
  // BOTH arms including the cannot-fit one, and pinning that name here is what makes an arm that
  // stopped returning a conversation a visible edit — which is CHAT-04's cannot-wedge clause
  // expressed as a type rather than as a promise.
  'CompactionPass',
  'CompactionPassInput',
  // 395-01, D-01/D-03/D-17 · CFGM-01/03/04: the config editor's host-port vocabulary. TYPES only —
  // shapes a composition root fills — and they are four ports rather than one bundle because
  // reading committed bytes, validating a whole candidate config, committing to a person's history
  // and writing a proposal record are capabilities a host can genuinely hold independently.
  //
  // `ConfigFilesPortLike` carries the field EDIT beside the read, and that pairing is the part
  // worth pinning: `packages/agent`'s ownership contract admits exactly `['ai', 'zod']`, so the
  // `yaml` Document API the comment-preserving mutation needs cannot live in-layer. The edit is a
  // fact about the file FORMAT, and it rides the port that already owns reading it.
  //
  // 395-04 adds `ConfigFieldSetResult` — the edit answers with the value it REPLACED beside
  // the bytes it wrote, because the per-value cross-boundary classifier compares the two and a
  // second parse to recover the old value would be free to disagree with the one that applied the
  // edit. 2026-10-14 (441-39, D-15): the construction scan's port type is deleted with the scan.
  'ConfigFieldSetResult',
  'ConfigFieldValue',
  'ConfigFileBytes',
  'ConfigFileSet',
  'ConfigFilesPortLike',
  // 395-05: `ConfigPathFacts` — what the document HOLDS at a path, structurally. A create that must
  // not overwrite, an edit that must not invent and an append that must not land on an existing
  // member are three questions about the document's SHAPE, and `packages/agent` cannot parse yaml.
  'ConfigPathFacts',
  'ConfigReaderPort',
  // 395-08, D-04: the shared scaffold CONTENT port. Published because `composeLocalAgent()` takes
  // it and the CLI host implements it over `commands/scaffold-content.ts` — the one producer both
  // `agent-qa init` and `config.project.scaffold` render, so the two scaffolds cannot drift.
  'ConfigScaffoldContentPortLike',
  // 395-05: the yaml FORMAT's value vocabulary — scalars, sequences and maps. A target entry and a
  // hook entry are written as one block each, so the port that writes them cannot be scalar-only.
  'ConfigStructuredValue',
  'ConfigValidatePortLike',
  'ConfigValidation',
  // 395-10 WR-11: one validation issue as a { path, message } PAIR. Published for the same reason
  // the port beside it is — the CLI host implements the port and cannot name a type that lives only
  // inside `config-mutation/` — and it is a TYPE, so it costs the runtime surface nothing.
  'ConfigValidationIssue',
  'CreateAgentJobQueueOptions',
  // 392 plan 08: what a chat state container opens under. A TYPE, one member, and it is the model
  // the session DECLARES — which is the value `/model` overrides and the per-turn config re-read
  // compares against, so naming it is what keeps those two from being two answers.
  'CreateChatStateInput',
  'CreateFunctionRegistryOptions',
  // 394-07 plan 07, D-12: the READ half of the receipts store, mirrored narrowly. A separate type
  // from the write port on purpose — the funnel projection is structurally unable to persist
  // anything, which is how "nothing new is persisted" stays a property rather than a promise.
  'DraftReceiptsReadPortLike',
  // 394 plan 02, D-01: the loop's write half and what staging one compiled draft answers. Types
  // only — the port is a shape a composition root fills, and the outcome is a two-arm union whose
  // refusal arm is the T-394-06 mitigation stated as a return type.
  'DraftShelfPortLike',
  'DraftStageOutcome',
  'EntityDirectoryPort',
  // 405-05 (D-12/D-13): the evidence-blob read port's shape. A TYPE, because a host BINDS one —
  // every local composition supplies a reader over the same `FsEvidenceArtifactStore` the runner
  // wrote through, and it has to be able to name what it is supplying. Nothing carrying a
  // filesystem crosses this barrel. In ASCII SORT position; this list is compared positionally.
  'EvidenceBlobReaderPort',
  // 398 D-11: the coverage record a host appends to the local log. A TYPE, and the SHAPE is the
  // feature: a verbatim query and the deterministic closest set, and nothing that could carry it to
  // a network sink. Pinned beside the port because a record gaining a destination field would be
  // the free-text egress D-14 forbids, arriving as an ordinary-looking widening.
  'ExplainAbstentionRecord',
  'FallbackContinuationInput',
  'FallbackContinuationProducer',
  'FunctionBindingStatus',
  'FunctionDeclaration',
  'FunctionDeps',
  'FunctionRegistry',
  // 399.1 D-01/D-04: what `foldFunctionResult` answers — the verdict and the op's extra lines. A
  // TYPE over data; pinned in sort position beside the function that produces it.
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
  // 413-13: the requeue outcome — a TYPE over data, pinned beside the store port it belongs to
  'JobRequeueOutcome',
  'JobStoreDump',
  'JobStoreDumpRow',
  'JobStoreFence',
  'JobStorePort',
  'KnowledgePort',
  'KnowledgeReaderPort',
  'KnowledgeReviewPort',
  // 392 plan 09: the measurement pair, and its two-ness is the claim — a quotient stored beside
  // the counts would be a third number free to disagree with them.
  // 403-01 (D-03): the live-view mint seam's port shape. A TYPE, because a host BINDS one — the
  // CLI composition supplies the signer, the origin and the live-run read, and it has to be able
  // to name what it is supplying. In ASCII SORT position; this list is compared positionally.
  'LiveViewPort',
  'MarkUnhandledCounts',
  'OptionalFunctionDepKey',
  'PersistencePort',
  // 392 plan 04: stage 2's contract vocabulary — the typed transport failure, the outcome the port
  // now answers with, and the unexecuted tool call it is made of. All three are TYPES describing
  // untrusted model output; a tool call is a description of an intention, and the only component
  // that can act on one is the reconciliation strategy the composition supplies. They are pinned
  // here so widening what a planner may hand back — a fourth member, an executable field — is a
  // visible edit to this list rather than a quiet change to what crosses the model boundary.
  'PlannerStageFailure',
  'PlannerStageOutcome',
  'PlannerStagePort',
  'PlannerToolCall',
  // 388 plan 03: the durable chip-truth read port and the two shapes it answers with. Types,
  // so none of them carries a database across the barrel — the only value that implements the
  // port is built by a composition in the one package sqlite is legal in. They are here for the
  // reason the other ports are: a composition root has to be able to NAME what it supplies, and
  // `postProcessing` is an OPTIONAL member, so a host that omits it is making a statement rather
  // than forgetting.
  'PostProcessingChainState',
  'PostProcessingJobRow',
  'PostProcessingReaderPort',
  'PostRunJobCapabilities',
  'RanJobOutcomeBase',
  'ReconcileInput',
  'ReconcileStrategy',
  'ReconcileVerdict',
  // 389 plan 05: the D-08 recurrence seam's vocabulary — the provider port a composition root
  // implements (389 binds it to the run-outcome projection in plan 06; 390 rebinds the same
  // seam to its fingerprint window) and the query/answer shapes it speaks. Types, so nothing
  // here carries a database or a model across the barrel.
  'RecoverAbandonedClaimsInput',
  'RecoverAbandonedClaimsOutcome',
  'RecurrenceAnswer',
  'RecurrenceLadder',
  'RecurrenceProvider',
  'RecurrenceQuery',
  // 392 plan 03: the repair contract's own vocabulary. A caller able to invoke `repairSession`
  // but unable to NAME what it hands over or gets back would spell the shapes again locally,
  // which is the second vocabulary this subtree exists to avoid (388 C13). The refused-line shape
  // is deliberately NOT here — it crosses the session-log port, so `schema` mints it.
  'RepairSessionOptions',
  'ReplayedRunEvent',
  'ResolvedClause',
  // 405-01 (D-03): the durable run-detail projection read port's shape. A TYPE, because a host
  // BINDS one — the CLI dashboard composition supplies a reader over the one `DashboardDatabase`
  // that server holds, and it has to be able to name what it is supplying. Nothing carrying a
  // database crosses this barrel. In ASCII SORT position; this list is compared positionally.
  'RunDetailReaderPort',
  'RunInvocationPort',
  'RunNextJobInput',
  'RunNextJobOutcome',
  'RunsReaderPort',
  // 392 plan 09: one admitted line of the frozen corpus. A TYPE, and it is here because a runner
  // filtering the manifest by lane has to NAME what it is filtering — every field on it is a claim
  // the closure walk checks against the file, so a consumer that could not name the record would
  // be re-deriving the corpus vocabulary a third time.
  'ScenarioCorpusEntry',
  'SessionLogLine',
  'SessionRepair',
  'SessionReplay',
  'StandInJobScript',
  'StartedRun',
  'StepEvidenceAddress',
  'StepEvidenceLookup',
  // 394-07 plan 07, D-14: see the funnel note beside `AuthoringFunnelPortLike` above.
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

/**
 * FUNC-01: the barrel's published set equals the pinned set exactly, in both kinds.
 *
 * Arrival and departure are separate offenders with distinct wording, so the failure names
 * which mistake was made rather than printing two sets and leaving a reader to diff them.
 */
export function findAgentBarrelOffenders(source: string): string[] {
  const actual = readAgentBarrelExports(source)

  return [
    ...setDrift('value', actual.values, EXPECTED_AGENT_BARREL_VALUE_EXPORTS),
    ...setDrift('type', actual.types, EXPECTED_AGENT_BARREL_TYPE_EXPORTS),
  ]
}
