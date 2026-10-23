// The v1 -> v2 tool-name migration map (Phase 398 plan 02, D-13 / D-14 · XPLN-03).
//
// WHY THIS FILE EXISTS. 397 ruled each of the thirty-three v1 tools in a deletion inventory, with a
// dated disposition per tool. This module records those rulings in a shape a handler can switch on,
// so an external agent still pinned to a v1 tool name receives the ruling instead of a bare
// unknown-tool error (D-15's refuse-and-teach redirect, plan 05). The inventory itself is retired;
// `__tests__/mapping-bump-guard.test.ts` pins the exact names and arms here, so the record cannot
// drift silently.
//
// WHY THE UNIVERSE IS THE TOOL ROWS ONLY (2026-08-17). The inventory also carried one prompt row
// (`agent_qa_authoring_context`) and six `agent-qa://schema/...` resource rows. Neither is a name a
// caller can put in a `tools/call`, so neither can ever arrive at the seam this map answers: a
// retired PROMPT name reaches a prompt request the server does not serve, and a retired RESOURCE
// URI reaches a scheme that no longer parses. Widening this map to cover them would put entries in
// it that nothing can look up, which is the same as an unreachable branch with a comment on it.
//
// PROTOCOL GROUNDING. SEP-2567 removed per-connection list variance, so the tool names a caller can
// see are a property of `mapping.ts` — never of a session, and since 432-20 (D-12) never of the
// caller either. That is what makes a RETIRED name a permanent fact rather than a per-connection
// one: no listing on any connection will ever carry these thirty-three names again, which is
// precisely why the history is worth keeping as data. SEP-2575's stateless posture is the other
// half — there is no handshake in which a server could once have negotiated the old vocabulary, so
// the only place a v1 caller's name can be answered is at the call itself.
//
// THREE ARMS AND NO FOURTH (D-13). The arms mirror the inventory's `Disposition (397, 2026-08-16)`
// column exactly:
//
//   renamed-to  the inventory's `n/a -> projected by 396` rows whose target op IS projected — the
//               capability is here under a new name, and `v2Tool` carries it.
//   retired     the inventory's `not-a-gap` rows (the capability did not go missing; it is answered
//               elsewhere, or its absence is a rule), PLUS the five A4 rows below.
//   pending     the inventory's `gap -> <owner>` rows — a real absence, routed to the milestone that
//               owns it. `owner` carries that milestone and `route` the interim answer.
//
// THE A4 ADJUDICATION, MADE HERE DELIBERATELY (2026-08-17, RESEARCH assumption A4 · this plan).
// Five inventory rows are ruled `n/a -> projected by 396` and yet name ops that ended up in
// `UNPROJECTED_OPS` after 396 plan 04's fold decisions: `agent_qa_get_config` (`config.get`),
// `agent_qa_get_run` (`runs.get`), and `agent_qa_get_run_steps` / `agent_qa_get_run_logs` /
// `agent_qa_get_run_execution_logs` (`runs.get` / `runs.events`). D-13's law is that every
// `renamed-to` target is a LIVE tool name, and there is no live tool in front of an unprojected op,
// so these five cannot take that arm. They are ruled RETIRED with route text mirroring the
// corresponding `UNPROJECTED_OPS` reason — the entity door, the digest, the manifest's posture
// section — rather than given a fourth arm, because "the op exists but this surface does not project
// it" is not a different KIND of answer to a caller: the name is gone and here is what to call
// instead, which is what `retired` already means. The inventory's own ruling is untouched; what is
// added is the join those two tables did not have between them.

/** Which of D-13's three closed answers a retired v1 name gets. */
export type V1MigrationArm = 'renamed-to' | 'retired' | 'pending'

/** One retired v1 tool name and its ruled disposition. */
export interface V1ToolMigrationEntry {
  /** The v1 tool name, verbatim from the inventory's tool table. */
  readonly v1Name: string
  readonly arm: V1MigrationArm
  /** The live v2 tool that carries this capability. Present ONLY on `renamed-to`. */
  readonly v2Tool?: string
  /** The inventory's ruled reason, dated. Never empty. */
  readonly note: string
  /** What to call instead. Present on `retired` and `pending`; a `renamed-to` row's route is its tool. */
  readonly route?: string
  /** The milestone that owns the absence. Present ONLY on `pending`. */
  readonly owner?: string
}

/**
 * THE MAP. One entry per v1 tool, in the inventory's original row order.
 *
 * The order is the inventory's rather than alphabetical, and the bump guard pins the SORTED set
 * separately — order is a reading convenience here and a pinned fact nowhere, which is why nothing
 * below depends on it.
 */
export const V1_TOOL_MIGRATION_MAP: readonly V1ToolMigrationEntry[] = Object.freeze([
  // 1
  Object.freeze({
    v1Name: 'agent_qa_discover',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): the protocol answers discovery itself, so a hand-written '
      + 'catalogue tool beside it would be a second, drifting answer to one question.',
    route:
      '`tools/list` (plus SEP-2575 `server/discover`) answers machine discovery; 398\'s build-time '
      + 'capability catalog, carried by `agent-qa init --agent`, answers the human-facing version.',
  }),
  // 2
  Object.freeze({
    v1Name: 'agent_qa_get_config',
    arm: 'retired',
    note:
      'A4 adjudication (2026-08-17, phase 398 plan 02): the inventory rules this row `n/a -> '
      + 'projected by 396`, but `config.get` is in UNPROJECTED_OPS after 396 plan 04 — not a '
      + 'mid-flight workflow read per D-02 — so there is no live tool to rename to.',
    route:
      'no MCP tool reads configuration; the workspace posture an agent needs reaches it through '
      + '`agent-qa init --agent`\'s manifest (398 D-16), by env-ref name and never by value.',
  }),
  // 3
  Object.freeze({
    v1Name: 'agent_qa_schema_reference',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): a served COPY of a contract is exactly the drift that '
      + 'advertising the live contract replaced.',
    route:
      'every tool advertises its op\'s live `inputSchema`/`outputSchema` in `tools/list` (396 D-16), '
      + 'so a caller reads the contract the gate actually validates with; a fold lists its arms\' '
      + 'fields as one object, and its `action` field says which fields each action takes.',
  }),
  // 4
  Object.freeze({
    v1Name: 'agent_qa_validate_definition',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): a standalone linter over arbitrary text is a second validator '
      + 'that can disagree with the one that gates writes.',
    route:
      'validation reaches a caller as `authoring.draft.verify`\'s verdict inside the authoring '
      + 'funnel — the verify arm of `agent_qa_refine_test`.',
  }),
  // 5
  Object.freeze({
    v1Name: 'agent_qa_generate_id',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): died with the CRUD model. Minting a canonical id on a surface '
      + 'is what 394-11 removed from the CLI, for this same reason.',
    route:
      'ids are minted host-side where the entity is written; a caller names what it wants and reads '
      + 'the id back off the entity card `agent_qa_get_entity` returns.',
  }),
  // 6
  Object.freeze({
    v1Name: 'agent_qa_validate_id',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): died with the CRUD model. A standalone validator would be a '
      + 'second answer to a question already answered at every parse point.',
    route:
      'the one URI codec (`packages/schema/src/entity/uri.ts`) validates every `agentqa://` '
      + 'reference as it is parsed, including the one `agent_qa_get_entity` resolves.',
  }),
  // 7
  Object.freeze({
    v1Name: 'agent_qa_list_tests',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): nothing in the registry enumerates the test corpus — `entities.resolve` '
      + 'resolves a reference to an entity, which is a different question.',
    route:
      'until the owning milestone mints `entities.list`, a known reference resolves through '
      + '`agent_qa_get_entity`; enumeration has no tool.',
    owner: 'M5 (live view & run invocation)',
  }),
  // 8
  Object.freeze({
    v1Name: 'agent_qa_read_test',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_get_entity',
    note:
      'projected by 396 (inventory row 8, 2026-08-16): `entities.get` is D-02\'s universal entity '
      + 'read, kind TST, behind the one read door.',
  }),
  // 9
  Object.freeze({
    v1Name: 'agent_qa_validate_test',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): row 4\'s ruling. `authoring.draft.verify` is the only validator, '
      + 'and it validates a draft in the funnel rather than arbitrary text a caller pasted.',
    route:
      'the verify arm of `agent_qa_refine_test` returns the same verdict that gates the write.',
  }),
  // 10
  Object.freeze({
    v1Name: 'agent_qa_create_test',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_write_test',
    note:
      'projected by 396 (inventory row 10, 2026-08-16): `authoring.draft.write` is workflow-coarse '
      + 'and verifies a draft rather than performing v1\'s blind write, so the input shape differs. '
      + 'Since 2026-10-02 (432-40, D-06) it writes the test file in the call unless a keep-gate '
      + 'rejected the draft.',
  }),
  // 11
  Object.freeze({
    v1Name: 'agent_qa_update_test',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_refine_test',
    note:
      'projected by 396 (inventory row 11, 2026-08-16): `authoring.draft.edit` is the edit arm of '
      + 'the refine fold, selected by the fold discriminant.',
  }),
  // 12
  Object.freeze({
    v1Name: 'agent_qa_delete_test',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): a rule, not an absence. MCPS-02 forbids a surface delete verb '
      + 'for irreversible deletes.',
    route:
      'removing a committed test is a repository edit a person makes and reviews; no surface has a '
      + 'delete door and none is coming.',
  }),
  // 13
  Object.freeze({
    v1Name: 'agent_qa_list_suites',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): folded into row 7\'s verb — enumerating the corpus answers "which '
      + 'tests exist, and in which files". A suite is a file, so this is not a second registry.',
    route:
      'until `entities.list` lands, suite membership is read from the workspace files themselves; '
      + 'the TST records inside them resolve through `agent_qa_get_entity`.',
    owner: 'M5 (live view & run invocation)',
  }),
  // 14
  Object.freeze({
    v1Name: 'agent_qa_read_suite',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): there is no suite RECORD to read. `ENTITY_KINDS` has no suite '
      + 'kind and a suite is a committed file addressed by workspace path.',
    route:
      'the TST records inside a suite are `agent_qa_get_entity`\'s job; the file itself is read '
      + 'from the workspace.',
  }),
  // 15
  Object.freeze({
    v1Name: 'agent_qa_validate_suite',
    arm: 'retired',
    note: 'not-a-gap (397, 2026-08-16): row 4\'s ruling — one validator, inside the funnel.',
    route:
      'the verify arm of `agent_qa_refine_test` validates the draft that joins the suite file.',
  }),
  // 16
  Object.freeze({
    v1Name: 'agent_qa_create_suite',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): a suite is a committed file the authoring funnel writes. A '
      + 'blind create is the v1 write the verified authoring funnel replaced (re-spelled '
      + '2026-10-02, 432-40, D-06: the funnel writes in the call).',
    route:
      '`agent_qa_write_test` names the suite file a draft joins and writes it in the call, unless a '
      + 'keep-gate rejected the draft.',
  }),
  // 17
  Object.freeze({
    v1Name: 'agent_qa_update_suite',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): row 16\'s ruling, through the edit arm instead of the write '
      + '(re-spelled 2026-10-02, 432-40, D-06: the edit lands in the call).',
    route: '`agent_qa_refine_test` edits the written test; the suite file changes in the call.',
  }),
  // 18
  Object.freeze({
    v1Name: 'agent_qa_delete_suite',
    arm: 'retired',
    note: 'not-a-gap (397, 2026-08-16): row 12\'s MCPS-02 rule, applied to the file rather than the record.',
    route: 'removing a suite file is a repository edit a person makes and reviews; no surface door exists.',
  }),
  // 19
  Object.freeze({
    v1Name: 'agent_qa_list_hooks',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16, corrected the same day): the 396 reason overstated `config.get`, which '
      + 'projects the resolved CONFIG\'s leaves; hook definitions live in the separate '
      + '`workspace.hooksFile`, so no registered op reads them today.',
    route:
      'until the owning milestone re-opens the hook execution model, hooks are read from '
      + '`workspace.hooksFile` in the workspace; no tool enumerates them.',
    owner: 'M7 (skills layer)',
  }),
  // 20
  Object.freeze({
    v1Name: 'agent_qa_read_hook',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): with row 19, ONE hook-read verb and not two. What `config.get` shows '
      + 'is `workspace.hooksFile` — the path, not the hooks.',
    route:
      'until that verb lands, a single hook is read from the hooks file itself; no tool projects it.',
    owner: 'M7 (skills layer)',
  }),
  // 21
  Object.freeze({
    v1Name: 'agent_qa_create_hook',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_change_config',
    note:
      'projected by 396 (inventory row 21, 2026-08-16): `config.hook.add` is an arm of the config '
      + 'fold. Since 2026-09-30 (432-12, D-05) the fold is `agent_qa_change_config` and the hook is '
      + 'written in the call, with the files it changed on the answer.',
  }),
  // 22
  Object.freeze({
    v1Name: 'agent_qa_update_hook',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): `config.field.set` reaches any schema-addressable CONFIG path and the '
      + 'hooks file is not one, so an existing hook has no edit verb. Minting one now would pin an '
      + 'edit shape to a contract the owning milestone revisits.',
    route:
      'adding a hook goes through `agent_qa_change_config`; editing an existing one is a '
      + 'hooks-file edit a person makes until the owner rules on the verb.',
    owner: 'M7 (skills layer)',
  }),
  // 23
  Object.freeze({
    v1Name: 'agent_qa_delete_hook',
    arm: 'retired',
    note: 'not-a-gap (397, 2026-08-16): row 12\'s MCPS-02 rule.',
    route: 'removing a hook is an edit to the hooks file that a person makes and reviews.',
  }),
  // 24
  Object.freeze({
    v1Name: 'agent_qa_run_hook',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): a hook\'s whole contract is "runs at this lifecycle point". '
      + 'Invoking one by name from a surface is arbitrary script execution decoupled from the '
      + 'lifecycle that gives it meaning — the private-power shape M4 abolished.',
    route:
      'hooks run at their declared lifecycle points during a run started by `agent_qa_start_run`; '
      + 'nothing invokes one out of band.',
  }),
  // 25
  Object.freeze({
    v1Name: 'agent_qa_enqueue_test_run',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_start_run',
    note:
      'projected by 396 (inventory row 25, 2026-08-16): `runs.start` is workflow-coarse, and the '
      + 'test scope is an argument rather than a tool of its own.',
  }),
  // 26
  Object.freeze({
    v1Name: 'agent_qa_enqueue_suite_run',
    arm: 'renamed-to',
    v2Tool: 'agent_qa_start_run',
    note:
      'projected by 396 (inventory row 26, 2026-08-16): the SAME op as row 25 at suite scope, which '
      + 'is why D-01 allows one tool over both.',
  }),
  // 27
  Object.freeze({
    v1Name: 'agent_qa_get_run',
    arm: 'retired',
    note:
      'A4 adjudication (2026-08-17, phase 398 plan 02): the inventory rules this row `n/a -> '
      + 'projected by 396`, but `runs.get` is in UNPROJECTED_OPS after 396 plan 04 — not a '
      + 'mid-flight workflow read per D-02 — so there is no live tool to rename to.',
    route:
      'the entity door renders a run\'s card: `agent_qa_get_entity` on the run reference. '
      + '`agent_qa_list_runs` enumerates recent runs.',
  }),
  // 28
  Object.freeze({
    v1Name: 'agent_qa_get_run_steps',
    arm: 'retired',
    note:
      'A4 adjudication (2026-08-17, phase 398 plan 02): ruled `n/a -> projected by 396` against '
      + '`runs.get`/`runs.events`, both of which are in UNPROJECTED_OPS — `runs.events` is a stream '
      + 'op besides, and a `tools/call` is one round trip with no shape for a resumable feed.',
    route:
      '`agent_qa_get_run_digest` carries what triage needs from a run, including its steps\' '
      + 'outcome; the run\'s card comes from `agent_qa_get_entity`.',
  }),
  // 29
  Object.freeze({
    v1Name: 'agent_qa_get_run_logs',
    arm: 'retired',
    note:
      'A4 adjudication (2026-08-17, phase 398 plan 02): ruled `n/a -> projected by 396` against '
      + '`runs.events`, which is in UNPROJECTED_OPS as a stream op with no single-round-trip shape.',
    route:
      '`agent_qa_get_run_digest` carries the triage-relevant remainder of a run; the full event '
      + 'feed is read from the run artifacts on disk, not over this surface.',
  }),
  // 30
  Object.freeze({
    v1Name: 'agent_qa_get_run_execution_logs',
    arm: 'retired',
    note:
      'A4 adjudication (2026-08-17, phase 398 plan 02): row 29\'s reading — `runs.events` is '
      + 'unprojected, so the second logs alias has no live tool either.',
    route:
      '`agent_qa_get_run_digest` for triage; execution logs live in the run\'s artifacts on disk.',
  }),
  // 31
  Object.freeze({
    v1Name: 'agent_qa_get_run_artifact',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): artifact bytes over a tool result is a disclosure surface nobody has '
      + 'scoped, so the read is routed WITH that scoping rather than minted without it — an artifact '
      + 'read without it is the gap made worse.',
    route:
      'until the owning milestone ships artifact resolution, artifacts are read from the run '
      + 'directory on disk; `agent_qa_get_run_digest` names what a run produced.',
    owner: 'M5 (artifact resolution route)',
  }),
  // 32
  Object.freeze({
    v1Name: 'agent_qa_cancel_run',
    arm: 'pending',
    note:
      'gap (397, 2026-08-16): ruled a REAL gap as `runs.cancel` and routed to its owner rather than '
      + 'minted in 397, because D-17 binds the adjudicator too.',
    route:
      'until `runs.cancel` lands, a run is stopped by the host that started it; this surface starts '
      + 'runs through `agent_qa_start_run` and cannot stop one.',
    owner: 'M5 (live-view control arbiter)',
  }),
  // 33
  Object.freeze({
    v1Name: 'agent_qa_classify_failure',
    arm: 'retired',
    note:
      'not-a-gap (397, 2026-08-16): classification on demand over dashboard-fetched data is the '
      + 'private data path M4 abolished, not a capability that went missing.',
    route:
      '`analysis.get` reads the verdict the `analyze-run` job produced; over this surface the '
      + 'triage answer is `agent_qa_get_run_digest`.',
  }),
] as const satisfies readonly V1ToolMigrationEntry[])
