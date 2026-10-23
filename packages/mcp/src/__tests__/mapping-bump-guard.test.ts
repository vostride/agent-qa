// The bump guard: the catalogue cannot change by accident (Phase 396 plan 04, D-04 · MCPS-02).
//
// WHY A COUNT WOULD NOT HAVE DONE. D-04 rejects a count-only guard by name, and the reason is the
// door-enumeration weakness this project has measured before: a count admits CANCELLING changes.
// Rename one tool and add nothing, or swap one tool's op for another's, and a count of fourteen stays
// fourteen while the vocabulary every downstream consumer binds against has silently moved. So the
// pin is the exact sorted NAME list plus each tool's exact OP SET — the one place in this
// repository where those names are restated, and that restatement IS the pin.
//
// EVERYTHING ELSE IS PRODUCED, NOT LITERAL. The registry's own enumeration is the denominator: the
// partition law below ranges over `registry.list(...)` rather than over a number written here, so
// "how many ops are there" is answered by the catalogue rather than by this file's opinion of it.
// MEASURED 2026-08-17 (398 D-09): the registry declares 42 ops. 22 are projected by the twelve
// tools; the other 20 are dispositioned in `UNPROJECTED_OPS`. Was 41/22/19 as measured 2026-08-16;
// `agent.explain` is the arrival, and it lands on the unprojected side with its own dated reason.
// RE-MEASURED 2026-08-27 (405-01 D-03): 44/22/22. `runs.detail` is the arrival and it lands on the
// unprojected side too, with its own dated reason; the count cell below carries the live numbers.
// RE-MEASURED AGAIN 2026-08-27 (405-05 D-12/D-13): 45/22/23. `runs.artifact` is the arrival and it
// lands unprojected for a reason of its own — its result is a base64 blob, and a `tools/call` round
// trip is the wrong carriage for bytes no conversation can render.
// RE-MEASURED AGAIN 2026-08-29 (407-01 D-05): 46/22/24. `runs.knowledge` is the arrival and it
// lands unprojected on `runs.detail`'s footing — a completed run's whole used-and-learned
// projection, three served channels and a retrieval trace per step, is a large one-shot payload
// rather than a mid-flight read.
// RE-MEASURED 2026-09-08 (419 D-19/D-20): fourteen tools; 48 declarations / 24 projected /
// 24 unprojected. runs.mark arrives projected; knowledge.gates.list moves to the read door.
// RE-MEASURED 2026-09-15 (423-21 D-04/D-18): sixteen tools; 51 declarations / 26 projected /
// 25 unprojected. runs.marks.history and runs.mark.preview arrive as two read tools, and
// runs.evidence lands unprojected on runs.detail's completed-run footing.
// RE-MEASURED 2026-09-25 (428 D-07): sixteen tools; 52 declarations / 26 projected /
// 26 unprojected. editor.liveurl lands unprojected by ruling — the editor mint is dashboard-only.
// RE-MEASURED 2026-09-28 (431-04 D-01/D-04/D-10): twenty-four tools; 53 declarations / 35 projected /
// 18 unprojected. runs.overview arrives projected, and eight previously unprojected reads move over:
// the five knowledge reads, runs.knowledge, and runs.evidence with runs.artifact behind one fold.
// RE-MEASURED 2026-09-30 (432-12 D-05/D-02): twenty tools; 53 declarations / 30 projected /
// 23 unprojected. The two change tools are renamed and write in the call; the four proposal
// apply/list/show tools and the config undo arm leave with no alias, and their five ops are
// dispositioned with a dated '432' ruling until 432-17 deletes them.
// RE-MEASURED 2026-10-01 (432-17 D-05/D-02): twenty tools; 46 declarations / 30 projected /
// 16 unprojected. The seven proposal, apply and undo ops are deleted from the registry, so the five
// '432' entries and the two 397 entries for proposals.accept/reject leave the scoping note, and
// '432' leaves the adjudicator vocabulary with no member left to rule on.
// RE-MEASURED 2026-10-01 (432-18 D-14/D-15): twenty tools; 44 declarations / 30 projected /
// 14 unprojected. `grants.list` and `grants.revoke` (both 397 entries) are deleted with the grant
// ledger and leave the scoping note; the projection is unmoved.
// The original measurement settles the 41-vs-43 discrepancy the phase
// context carried — whatever the registry answers IS the denominator, and this suite reds if the
// two sets ever stop covering it exactly.
//
// MUTATION LEGS — the acceptance bar, measured by the phase's mutation driver (since removed).
// Every leg was applied to `packages/mcp/src/mapping.ts`, the suite re-run, and the subject
// restored from a byte snapshot with sha-256 compared. Observed on 2026-08-16:
//
//   M1  a thirteenth tool planted (`agent_qa_cancel_run` over `runs.get`)          -> RED (6 cells)
//   M2  `agent_qa_start_run` renamed to `agent_qa_begin_run`                       -> RED (4 cells)
//   M3  `agent_qa_show_proposal` remapped onto `proposals.list`                    -> RED (4 cells)
//   M4  `config.get` added to the config fold WITHOUT leaving `UNPROJECTED_OPS`    -> RED (5 cells)
//
// M2 IS THE ONE TO READ. A pure rename adds nothing and removes nothing, so a count-only guard sees
// an unchanged catalogue; four named cells here disagree. That is the whole of D-04's argument,
// measured rather than argued.
//
// A GREEN SUITE UNDER ANY LEG IS A FAILURE OF THE GUARD, NOT A PASS.
//
// ---- THE SECOND PINNED SET: THE MIGRATION MAP (2026-08-17, Phase 398 plan 02 · D-14) ------------
//
// ONE LAW, TWO PINNED SETS. `migration-map.ts` beside `mapping.ts` carries the thirty-three RETIRED
// v1 tool names and the arm each one was ruled onto, and it is pinned here for the same reason and
// by the same idiom as the live catalogue above: the two tables together are this package's whole
// tool-name vocabulary — the names that exist and the names that used to — and a bump to either is
// a change to what every downstream consumer binds against.
//
// WHY A COUNT WOULD NOT HAVE DONE HERE EITHER. A count cannot see an ARM: rule
// `agent_qa_cancel_run` retired instead of pending and the count stays the same — while an external
// agent calling the retired name is now told the capability is answered elsewhere when in truth it
// is owed by M5. So the pin is the exact sorted NAME list WITH ITS ARM, and a swapped arm is a
// visible diff in this file rather than a silent change in behaviour. With the deletion inventory
// retired, this pin is also the only check on the SET itself.
//
// THE TARGETS ARE PINNED TOO, and that is one step past D-14's letter, taken for D-14's reason. The
// `renamed-to` targets are already joined LIVE against `AGENT_QA_TOOL_PROJECTIONS`, so a target
// naming a tool that does not exist reds there. What neither that join nor the arm pin can see is a
// target swapped for a DIFFERENT LIVE tool — `agent_qa_read_test` pointed at `agent_qa_list_runs`
// passes the join (it is a real tool), passes the arm pin (still `renamed-to`) and sends every v1
// caller of the read door to the run list. That is exactly the cancelling change M2 above exists to
// refuse, seen from the map's side, so it is pinned by name here.
//
// THE PARTITION SIZES ARE DERIVED ON BOTH SIDES. The counts below are computed from
// `V1_TOOL_MIGRATION_MAP` and compared against counts computed from the PIN's own groupings —
// never against an integer typed into this file, which could be edited to agree with a drift in one
// keystroke and would then read as a measurement.

import {
  createFunctionRegistry,
  type FunctionDeclaration,
  type FunctionDeps,
  type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import {
  RunsMarkInputSchema,
  RunsMarkPreviewResultSchema,
  RunsMarksHistoryInputSchema,
  RunsMarksHistoryResultSchema,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  AGENT_QA_COMPOSED_CONTRACTS,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
  DEGRADED_OUTPUT_CONTRACTS,
  UNPROJECTED_ADJUDICATIONS,
  UNPROJECTED_OPS,
} from '../mapping.js'
import { toRegisterToolConfig } from '../projection.js'
import { V1_TOOL_MIGRATION_MAP, type V1MigrationArm } from '../migration-map.js'

/**
 * The registry, listing only.
 *
 * `deps` is EMPTY and cast, which is honest for exactly this question: `list()` consults the deps
 * for one thing — whether an op is bound in this composition — and membership of the catalogue is a
 * property of the catalogue, not of a host. A fixture supplying rich fakes would list the same
 * forty-two ids and take fifty lines to do it. Nothing here dispatches, so nothing here can reach a
 * port that is not there.
 */
function builtInRegistry(): FunctionRegistry {
  return createFunctionRegistry({ deps: {} as unknown as FunctionDeps })
}

/** Every scope, and not safe mode: this suite asks what the CATALOGUE holds, not what a caller sees. */
const EVERY_SCOPE_CALLER: FunctionCaller = {
  surface: 'mcp',
  origin: 'agent',
}

function declarations(): readonly FunctionDeclaration[] {
  return builtInRegistry().list(EVERY_SCOPE_CALLER)
}

const projectedOpIds = (): readonly string[] =>
  AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) => [...projection.ops])

// ---- THE PIN. The one restatement, and it is deliberate. ----------------------------------------

/** D-04's exact sorted list. Adding, removing or renaming a tool reds the first cell below. */
const PINNED_TOOL_NAMES: readonly string[] = [
  'agent_qa_change_config',
  'agent_qa_change_knowledge',
  'agent_qa_diff_knowledge_records',
  'agent_qa_explain_brief',
  'agent_qa_get_entity',
  'agent_qa_get_run_digest',
  'agent_qa_get_run_evidence',
  'agent_qa_get_run_knowledge',
  'agent_qa_get_run_marks',
  'agent_qa_get_run_overview',
  'agent_qa_inspect_knowledge_records',
  'agent_qa_list_knowledge_bundles',
  'agent_qa_list_knowledge_gates',
  'agent_qa_list_runs',
  'agent_qa_mark_run',
  'agent_qa_preview_run_mark',
  'agent_qa_refine_test',
  'agent_qa_show_knowledge_record',
  'agent_qa_start_run',
  'agent_qa_write_test',
]

/** D-04's other half: WHICH ops each tool stands in front of. A remap reds without a rename. */
const PINNED_TOOL_OPS: Readonly<Record<string, readonly string[]>> = {
  agent_qa_change_config: [
    'config.field.set',
    'config.target.create',
    'config.target.edit',
    'config.auth.set',
    'config.hook.add',
    'config.project.scaffold',
  ],
  agent_qa_change_knowledge: [
    'knowledge.accept',
    'knowledge.reject',
    'knowledge.forget',
  ],
  agent_qa_diff_knowledge_records: ['knowledge.records.diff'],
  agent_qa_explain_brief: ['knowledge.brief.why'],
  agent_qa_get_entity: ['entities.resolve', 'entities.get'],
  agent_qa_get_run_digest: ['runs.digest'],
  agent_qa_get_run_evidence: ['runs.evidence', 'runs.artifact'],
  agent_qa_get_run_knowledge: ['runs.knowledge'],
  agent_qa_get_run_marks: ['runs.marks.history'],
  agent_qa_get_run_overview: ['runs.overview'],
  agent_qa_inspect_knowledge_records: ['knowledge.records.inspect'],
  agent_qa_list_knowledge_bundles: ['knowledge.bundles.list'],
  agent_qa_list_knowledge_gates: ['knowledge.gates.list'],
  agent_qa_mark_run: ['runs.mark'],
  agent_qa_preview_run_mark: ['runs.mark.preview'],
  agent_qa_list_runs: ['runs.list'],
  agent_qa_refine_test: ['authoring.draft.edit', 'authoring.draft.verify'],
  agent_qa_show_knowledge_record: ['knowledge.record.show'],
  agent_qa_start_run: ['runs.start'],
  agent_qa_write_test: ['authoring.draft.write'],
}

/**
 * D-05's pin (2026-08-31, Phase 408 plan 01 · MCPA-01): which tools CARRY the live-view App, and
 * where each one's concrete runId is found.
 *
 * THE THIRD RESTATEMENT IN THIS FILE, and it earns its place on the same argument as the first two.
 * `projection-fidelity.test.ts` censuses the carrier set FROM the projection table, which catches a
 * carrier planted or dropped — it cannot catch a carrier whose `runIdFrom` was swapped, because
 * both halves of a derived comparison move together. A swapped `runIdFrom` is a cancelling change
 * of exactly the M2 class: nothing is added, nothing is removed, and every derived cell stays
 * green while Plan 03's per-call reference starts decorating a result with a live view of a run
 * nobody asked about. So the pair is pinned by name here.
 *
 * IT IS ALSO THE COUNT THAT MATTERS MOST IN THIS FILE. A carrier is a door onto a channel that
 * mints a live-view CREDENTIAL, so "which tools carry the App" is not a vocabulary question the way
 * the name list is — a third entry appearing without a diff in this file is the failure this pin
 * exists to make impossible.
 */
const PINNED_TOOL_UI_CARRIERS: Readonly<
  Record<string, { readonly resource: string; readonly runIdFrom: string }>
> = {
  // The ack carries the runId the run was given, so a per-call reference reads it off the OUTPUT.
  agent_qa_start_run: { resource: 'live-run', runIdFrom: 'output' },
  // The watch/status read is ASKED about a run, so its runId is on the INPUT — this is the
  // late-attach door (D-07): a run started from CLI, CI or the dashboard is watchable through it.
  agent_qa_get_run_digest: { resource: 'live-run', runIdFrom: 'input' },
}

/**
 * D-14's pin: every retired v1 name, sorted, with the arm it was ruled onto.
 *
 * The second restatement in this file, and deliberate for the same reason as the first — this IS
 * the pin. A name added, removed or renamed reds the membership cell; an arm swapped reds the arm
 * cell by that name.
 */
const PINNED_V1_MIGRATION_ARMS: Readonly<Record<string, V1MigrationArm>> = {
  agent_qa_cancel_run: 'pending',
  agent_qa_classify_failure: 'retired',
  agent_qa_create_hook: 'renamed-to',
  agent_qa_create_suite: 'retired',
  agent_qa_create_test: 'renamed-to',
  agent_qa_delete_hook: 'retired',
  agent_qa_delete_suite: 'retired',
  agent_qa_delete_test: 'retired',
  agent_qa_discover: 'retired',
  agent_qa_enqueue_suite_run: 'renamed-to',
  agent_qa_enqueue_test_run: 'renamed-to',
  agent_qa_generate_id: 'retired',
  agent_qa_get_config: 'retired',
  agent_qa_get_run: 'retired',
  agent_qa_get_run_artifact: 'pending',
  agent_qa_get_run_execution_logs: 'retired',
  agent_qa_get_run_logs: 'retired',
  agent_qa_get_run_steps: 'retired',
  agent_qa_list_hooks: 'pending',
  agent_qa_list_suites: 'pending',
  agent_qa_list_tests: 'pending',
  agent_qa_read_hook: 'pending',
  agent_qa_read_suite: 'retired',
  agent_qa_read_test: 'renamed-to',
  agent_qa_run_hook: 'retired',
  agent_qa_schema_reference: 'retired',
  agent_qa_update_hook: 'pending',
  agent_qa_update_suite: 'retired',
  agent_qa_update_test: 'renamed-to',
  agent_qa_validate_definition: 'retired',
  agent_qa_validate_id: 'retired',
  agent_qa_validate_suite: 'retired',
  agent_qa_validate_test: 'retired',
}

/**
 * The other half, and the one the live join cannot supply: WHICH live tool each `renamed-to` name
 * was pointed at. A remap onto a different real tool reds here and nowhere else.
 */
const PINNED_V1_RENAMED_TARGETS: Readonly<Record<string, string>> = {
  agent_qa_create_hook: 'agent_qa_change_config',
  agent_qa_create_test: 'agent_qa_write_test',
  agent_qa_enqueue_suite_run: 'agent_qa_start_run',
  agent_qa_enqueue_test_run: 'agent_qa_start_run',
  agent_qa_read_test: 'agent_qa_get_entity',
  agent_qa_update_test: 'agent_qa_refine_test',
}

/** Arm -> how many names carry it, computed from a table. Used on BOTH sides of the size cell. */
function armSizes(entries: readonly (readonly [string, V1MigrationArm])[]): Record<string, number> {
  const sizes: Record<string, number> = { 'renamed-to': 0, retired: 0, pending: 0 }
  for (const [, arm] of entries) sizes[arm] = (sizes[arm] ?? 0) + 1
  return sizes
}

/** 2026-09-28 (431-04 D-10): the closed adjudicator vocabulary, pinned beside its runtime tuple. */
// 2026-09-30 (432-12 D-05): `'432'` arrives for the five proposal ops that left the catalogue.
// 2026-10-01 (432-17 D-05): those five ops are deleted, so `'432'` leaves with them.
const PINNED_ADJUDICATIONS: readonly string[] = ['397', '398', '405', '408', '428']

/** MCPS-02's stated band. Asserted AT the bound, not implied by the exact pin above it. */
const MCPS_02_MIN_TOOLS = 8
/**
 * 2026-09-15 (423-21, REQUIREMENTS reconciliation 7): MCPS-02's "~8-15" ceiling is widened to the
 * MX milestone's decided catalogue. D-18 publishes the two feedback reads here, and PXH-AGENT-04
 * (Phase 431) projects six knowledge reads, so the decided total is 16 + 6. The exact name and op
 * pins above still red on every change; this bound only states how far the owner has decided to go.
 * 2026-09-28 (431 D-01): the owner widened 431 to the run overview and the evidence fold as well,
 * so the decided total is 16 + 8.
 * 2026-09-30 (432-12 D-05): the four proposal apply/list/show tools are deleted, so the decided
 * total is 24 - 4 = 20, and the ceiling moves down with it: a returned proposal tool reds here too.
 */
const MX_MAX_TOOLS = 20

describe('the pinned catalogue (D-04)', () => {
  it('MCP-NAMES-EXACT: declares exactly the pinned sorted tool-name list', () => {
    const names = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name).sort()
    expect(names).toEqual([...PINNED_TOOL_NAMES])
  })

  it('MCP-OPS-EXACT: declares exactly the pinned op set for every tool', () => {
    const actual: Record<string, readonly string[]> = {}
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) actual[projection.name] = [...projection.ops]
    expect(actual).toEqual(PINNED_TOOL_OPS)
  })

  // The MCPS-02 boundary, asserted with BOTH comparisons rather than inferred from the exact count.
  // Fourteen is one step inside each bound, so neither can be crossed silently: a thirteenth tool
  // still passes here and reds the exact pin, and a drop to seven reds here.
  it('holds a tool count inside the MCPS-02 band, at both ends', () => {
    const count = AGENT_QA_TOOL_PROJECTIONS.length
    expect(count).toBe(20)
    expect(count).toBeGreaterThanOrEqual(MCPS_02_MIN_TOOLS)
    expect(count).toBeLessThanOrEqual(MX_MAX_TOOLS)
  })

  it('declares exactly the pinned App carriers, with the pinned runId source (408 D-05)', () => {
    const actual: Record<string, { resource: string; runIdFrom: string }> = {}
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      if (projection.ui === undefined) continue
      actual[projection.name] = { ...projection.ui }
    }
    expect(actual).toEqual(PINNED_TOOL_UI_CARRIERS)
  })

  it('declares no duplicate tool name', () => {
    const names = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // THE ADMITTED/REJECTED PAIR (the `protected-classes-registry` analog). Without it, every cell
  // above could be satisfied by a comparison that matches loosely — a `startsWith`, a substring, a
  // set that answers yes to anything shaped like a name. A near-miss spelling of a real member must
  // match NOTHING, on both axes.
  it('matches nothing for a near-miss tool name or a near-miss op id', () => {
    const names = new Set(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name))
    expect(names.has('agent_qa_start_run')).toBe(true)
    expect(names.has('agent_qa_start_runs')).toBe(false)
    expect(names.has('agent_qa_start')).toBe(false)

    const ops = new Set(projectedOpIds())
    expect(ops.has('runs.start')).toBe(true)
    expect(ops.has('runs.started')).toBe(false)
    expect(ops.has('runs')).toBe(false)
  })
})

describe('the projection resolves against the registry, produced not literal', () => {
  it('names only ops the registry actually declares', () => {
    const registered = new Set(declarations().map((declaration) => declaration.id))
    for (const opId of projectedOpIds()) {
      expect(registered.has(opId), `${opId} is projected but not registered`).toBe(true)
    }
  })

  // One op, one door. Two tools over one op would make "which tool applies this proposal" a
  // question with two answers, and 397's parity walk would count the op twice.
  it('projects each op through exactly one tool', () => {
    const seen = new Map<string, string>()
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      for (const opId of projection.ops) {
        const first = seen.get(opId)
        expect(first, `${opId} is projected by both ${first} and ${projection.name}`).toBeUndefined()
        seen.set(opId, projection.name)
      }
    }
    expect(seen.size).toBe(projectedOpIds().length)
  })

  // THE GENERAL RULE BEHIND TWO NAMED PROHIBITIONS. The plan forbids projecting `proposals.accept`
  // because `requiresHumanOrigin` dead-ends an agent-origin caller (RESEARCH Pitfall 7). That is a
  // property of the OP, so it is asserted over every projected op rather than over one name — which
  // is what caught `proposals.reject`, a tool the plan's own table listed and this cell refuses.
  // A door that can never open is worse than an absent one: it advertises a capability and spends
  // every caller's call finding out it has none.
  it('projects no op that requires a human origin', () => {
    const projected = new Set(projectedOpIds())
    // 432-20 (D-10): declarations no longer carry the key at all, so a declaration that grew it back
    // would show up here as a key rather than as a `true` value.
    const humanOnly = declarations()
      .filter((declaration) => Object.keys(declaration).includes('requiresHumanOrigin'))
      .map((declaration) => declaration.id)

    // RE-SPELLED 2026-10-01 (432-18, D-15): the integrity check was `humanOnly.length > 0`. The last
    // op declaring `requiresHumanOrigin` (`grants.revoke`) is deleted, so the set is empty now and
    // the rule holds over the whole projection; the filter is still measured over a non-empty
    // census. 2026-10-02 (432-39, D-10): the field is deleted from the metadata type, so the key
    // census is the only way it could come back.
    expect(declarations().length).toBeGreaterThan(0)
    expect(projected.size).toBeGreaterThan(0)
    expect(humanOnly, 'an op declares requiresHumanOrigin again; it must stay unprojected').toEqual([])
    for (const opId of humanOnly) {
      expect(projected.has(opId), `${opId} requires a human origin and cannot serve this surface`)
        .toBe(false)
    }
  })

  it('carries a contract-table entry for every projected op', () => {
    for (const opId of projectedOpIds()) {
      expect(AGENT_QA_OP_CONTRACTS[opId], opId).toBeDefined()
    }
    // The reverse direction too: a contract left behind by a tool that was removed is dead weight
    // whose only effect is to make the two tables look like they agree.
    expect(Object.keys(AGENT_QA_OP_CONTRACTS).sort()).toEqual([...projectedOpIds()].sort())
  })
})

describe('the partition law (D-03 / D-15)', () => {
  it('MCP-PARTITION: disposition every registry op exactly once, in exactly one of the two sets', () => {
    const registryIds = declarations().map((declaration) => declaration.id).sort()
    const projected = projectedOpIds()
    const unprojected = UNPROJECTED_OPS.map((entry) => entry.opId)

    // Disjoint: an op in both is a tool shipping something the scoping note says is deferred.
    const overlap = projected.filter((opId) => unprojected.includes(opId))
    expect(overlap, 'ops declared BOTH projected and unprojected').toEqual([])

    // Complete: an op in neither has landed with nobody having decided anything about it, which is
    // exactly what 397's parity walk would then be scoped around by accident.
    expect([...projected, ...unprojected].sort()).toEqual(registryIds)
  })

  it('measures the registry at the count this suite header records', () => {
    // The denominator, stated where a reader can see it move. Not a rule — a MEASUREMENT, and the
    // sentence in the header is only true while this cell is green.
    // 2026-09-08, 419 D-19/D-20: mark arrives and gates becomes projected (48/24/24).
    // 2026-09-15, 423-21 D-04/D-18: two feedback reads projected, evidence unprojected (51/26/25).
    // 2026-09-25, 428 D-07: editor.liveurl arrives unprojected (52/26/26).
    // 2026-09-28, 431-04 D-01/D-10: runs.overview arrives projected and eight reads move (53/35/18).
    // 2026-09-30, 432-12 D-05: five proposal ops leave the projected side with their tools (53/30/23).
    // 2026-10-01, 432-17 D-05: the seven proposal, apply and undo ops leave the registry (46/30/16).
    // 2026-10-01, 432-18 D-15: the two grant ops leave the registry (44/30/14).
    expect(declarations().length).toBe(44)
    expect(projectedOpIds().length).toBe(30)
    expect(UNPROJECTED_OPS.length).toBe(14)
  })

  it('lists no op twice in the scoping note', () => {
    const ids = UNPROJECTED_OPS.map((entry) => entry.opId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('MCP-ADJUDICATIONS: gives every unprojected op a non-empty reason and a NAMED adjudicator', () => {
    // 2026-08-17 (398 D-09). This cell used to assert `'397'` for every entry, and that literal was
    // right for exactly as long as 397 was the last phase to add an op. `agent.explain` arrived in
    // 398, so a phase that could not have ruled on it would have been recorded as having done so —
    // which is the one failure a provenance column has.
    //
    // WIDENED AS A PIN, NOT AS A RELAXATION. The vocabulary is a closed two-member set AND the
    // membership is spelled by op id below, so a later entry stamped `'398'` because it was easier
    // reds here rather than joining a set that has quietly become "any phase number".
    const ADJUDICATED_BY_398 = new Set(['agent.explain'])
    // 2026-08-31 (408 D-01). NOT a widening: a RE-STAMP. `runs.liveurl` arrived in 403 and was
    // stamped `'403'`, but what 403 recorded was a DEFERRAL — "whether an MCP caller may mint one
    // is Phase 408's question". 408 answered it (internal mint only), so the phase that ruled this
    // absence is 408 and the stamp moves with the ruling. `'403'` leaves the vocabulary with it,
    // rather than staying as a member-less literal this pin would pass over in silence.
    const ADJUDICATED_BY_408 = new Set(['runs.liveurl'])
    // 2026-08-27 (405-01 D-03). The same widening for the same reason, two phases later:
    // `runs.detail` arrived in 405 and 397 could not have ruled on it. Membership is still
    // spelled by op id, so an entry stamped `'405'` because it was easier reds here.
    // 2026-09-28 (431-04 D-10): `runs.artifact` left for the evidence fold; `runs.detail` stays.
    const ADJUDICATED_BY_405 = new Set(['runs.detail'])
    // 2026-08-29 (407-01 D-05) and 2026-09-15 (423-21 D-04) added `'407'` for `runs.knowledge` and
    // `'423'` for `runs.evidence`. 431-04 D-10 projects both, so both literals leave the vocabulary
    // rather than staying as member-less entries; the cells below pin that they are gone.
    // 2026-09-25 (428 D-07). The same widening for the same reason: `editor.liveurl` arrived in
    // 428, unprojected by ruling. Membership is spelled by op id.
    const ADJUDICATED_BY_428 = new Set(['editor.liveurl'])
    // 2026-09-30 (432-12 D-05): the five pre-432 proposal ops were ruled off the catalogue by 432.
    // 2026-10-01 (432-17 D-05): they are deleted from the registry, so no entry carries `'432'`.
    const expectedAdjudicator = (opId: string): string =>
      ADJUDICATED_BY_428.has(opId)
        ? '428'
        : ADJUDICATED_BY_398.has(opId)
        ? '398'
        : ADJUDICATED_BY_408.has(opId)
          ? '408'
          : ADJUDICATED_BY_405.has(opId)
            ? '405'
            : '397'
    for (const entry of UNPROJECTED_OPS) {
      expect(entry.reason.length, entry.opId).toBeGreaterThan(20)
      expect(entry.adjudication, entry.opId).toBe(expectedAdjudicator(entry.opId))
    }
    // The set is not vacuous in either direction: an id that left the register would leave this
    // pin naming nothing, which is the hole an allow-list-shaped literal always has.
    expect(
      UNPROJECTED_OPS.filter((entry) => ADJUDICATED_BY_398.has(entry.opId)).map((e) => e.opId),
      'the 398-adjudicated pin names entries the scoping note does not carry',
    ).toEqual([...ADJUDICATED_BY_398])
    expect(
      UNPROJECTED_OPS.filter((entry) => ADJUDICATED_BY_408.has(entry.opId)).map((e) => e.opId),
      'the 408-adjudicated pin names entries the scoping note does not carry',
    ).toEqual([...ADJUDICATED_BY_408])
    // …and the vocabulary really shed `'403'` rather than keeping it as a member-less literal.
    expect(
      UNPROJECTED_OPS.map((entry) => entry.adjudication as string).filter((a) => a === '403'),
      "`'403'` left the adjudicator vocabulary with the ruling it deferred — no entry may carry it",
    ).toEqual([])
    expect(
      UNPROJECTED_OPS.filter((entry) => ADJUDICATED_BY_405.has(entry.opId)).map((e) => e.opId),
      'the 405-adjudicated pin names entries the scoping note does not carry',
    ).toEqual([...ADJUDICATED_BY_405])
    expect(
      UNPROJECTED_OPS.map((entry) => entry.adjudication as string).filter((a) => a === '407' || a === '423'),
      "`'407'` and `'423'` left the adjudicator vocabulary with the ops 431 projected",
    ).toEqual([])
    // The runtime tuple beside the type is the vocabulary, pinned, and every member is inhabited.
    expect([...UNPROJECTED_ADJUDICATIONS]).toEqual(PINNED_ADJUDICATIONS)
    for (const adjudication of UNPROJECTED_ADJUDICATIONS) {
      expect(
        UNPROJECTED_OPS.some((entry) => entry.adjudication === adjudication),
        `'${adjudication}' is in the vocabulary with no member`,
      ).toBe(true)
    }
    for (const entry of UNPROJECTED_OPS) {
      expect(UNPROJECTED_ADJUDICATIONS as readonly string[], entry.opId).toContain(entry.adjudication)
    }
    expect(
      UNPROJECTED_OPS.filter((entry) => ADJUDICATED_BY_428.has(entry.opId)).map((e) => e.opId),
      'the 428-adjudicated pin names entries the scoping note does not carry',
    ).toEqual([...ADJUDICATED_BY_428])
    expect(
      UNPROJECTED_OPS.map((entry) => entry.adjudication as string).filter((a) => a === '432'),
      "`'432'` left the adjudicator vocabulary with the proposal ops 432-17 deleted",
    ).toEqual([])
  })

  it('C432-NO-PROPOSAL-OPS: the scoping note dispositions no retired proposal, apply or undo op', () => {
    const retired = [
      'proposals.list', 'proposals.show', 'proposals.accept', 'proposals.reject',
      'knowledge.proposal.apply', 'config.proposal.apply', 'config.undo.propose',
    ]
    const registryIds = declarations().map((declaration) => declaration.id)
    expect(retired.filter((opId) => registryIds.includes(opId)), 'a retired op is still registered').toEqual([])
    expect(
      UNPROJECTED_OPS.map((entry) => entry.opId).filter((opId) => retired.includes(opId)),
      'the scoping note still dispositions a deleted op',
    ).toEqual([])
    expect(projectedOpIds().filter((opId) => retired.includes(opId))).toEqual([])
  })

  // D-03's own note leads the list, and the ORDER is part of the decision: a reader scanning the
  // scoping note meets the one exclusion that was argued before the ones that were merely scoped.
  it('leads the scoping note with agent.ask and its dated D-03 rationale', () => {
    expect(UNPROJECTED_OPS[0]?.opId).toBe('agent.ask')
    expect(UNPROJECTED_OPS[0]?.reason).toContain('D-03')
    expect(UNPROJECTED_OPS[0]?.reason).toContain('2026-08-15')
  })
})

describe('the composed fold contracts answer for the ops the mapping declares', () => {
  /** The arm literals the ADVERTISED schema actually carries, read out of its JSON Schema. */
  function advertisedArms(toolName: string, discriminant: string): readonly unknown[] {
    const contracts = AGENT_QA_COMPOSED_CONTRACTS[toolName]
    expect(contracts, `${toolName} has no composed contract`).toBeDefined()
    const json = contracts!.input['~standard'].jsonSchema.input({ target: 'draft-2020-12' }) as {
      oneOf?: readonly { properties?: Record<string, { const?: unknown }> }[]
    }
    return (json.oneOf ?? []).map((arm) => arm.properties?.[discriminant]?.const)
  }

  // The fold unions are composed in `@vostride/agent-qa-schema`, which may not import the function
  // layer and therefore spells the op ids as literals. This cell is what makes that restatement
  // safe: the literals are read back OUT of the composed schema and compared against the mapping's
  // declared arms, so a fold that silently gained, lost or renamed an arm reds here.
  it('advertises exactly the declared arms, in the declared order', () => {
    const folds = AGENT_QA_TOOL_PROJECTIONS.filter(
      (projection) => compositionOf(projection) === 'union',
    )
    expect(folds.map((fold) => fold.name)).toEqual([
      'agent_qa_refine_test',
      'agent_qa_change_config',
      'agent_qa_change_knowledge',
      'agent_qa_get_run_evidence',
    ])

    for (const fold of folds) {
      expect(advertisedArms(fold.name, fold.discriminant!), fold.name).toEqual([...fold.ops])
    }
  })

  it('gives every multi-arm tool a composed contract, and no 1:1 tool one', () => {
    for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
      const composed = AGENT_QA_COMPOSED_CONTRACTS[projection.name] !== undefined
      if (projection.ops.length > 1) {
        expect(composed, `${projection.name} folds but has no composed contract`).toBe(true)
        continue
      }
      // 2026-10-01 (432-21, D-12): no exception. The mark door advertised its credential refusal
      // beside the op's outcome (419 D-20); that refusal left with the MCP bearer credential, so the
      // door inherits its op's contracts like every other 1:1 tool. (The D-11 apply doors went in
      // 432-12.)
      expect(composed, `${projection.name} restates a contract it could inherit`).toBe(false)
    }
  })
})

describe('the pinned migration map (D-14)', () => {
  it('declares exactly the pinned sorted v1-name list', () => {
    const names = V1_TOOL_MIGRATION_MAP.map((entry) => entry.v1Name).sort()
    expect(names).toEqual(Object.keys(PINNED_V1_MIGRATION_ARMS).sort())
  })

  it('declares exactly the pinned arm for every v1 name', () => {
    const actual: Record<string, V1MigrationArm> = {}
    for (const entry of V1_TOOL_MIGRATION_MAP) actual[entry.v1Name] = entry.arm
    expect(actual).toEqual(PINNED_V1_MIGRATION_ARMS)
  })

  it('declares exactly the pinned renamed-to target for every renamed name', () => {
    const actual: Record<string, string> = {}
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      if (entry.arm !== 'renamed-to') continue
      actual[entry.v1Name] = entry.v2Tool as string
    }
    expect(actual).toEqual(PINNED_V1_RENAMED_TARGETS)
  })

  // The partition, derived on both sides. The module's own enumeration versus the pin's own
  // groupings — so this cell measures agreement between two tables rather than agreement between a
  // table and an integer somebody typed beside it.
  it('partitions the map into the arm sizes the pin groups', () => {
    const fromModule = armSizes(V1_TOOL_MIGRATION_MAP.map((entry) => [entry.v1Name, entry.arm]))
    const fromPin = armSizes(Object.entries(PINNED_V1_MIGRATION_ARMS))
    expect(fromModule).toEqual(fromPin)

    // Integrity: every arm is actually populated, so the equality above is three real comparisons
    // rather than one real one and two matching zeroes.
    for (const [arm, size] of Object.entries(fromModule)) {
      expect(size, `arm ${arm} has no members`).toBeGreaterThan(0)
    }
    expect(Object.values(fromModule).reduce((a, b) => a + b, 0)).toBe(V1_TOOL_MIGRATION_MAP.length)
  })

  // The two vocabularies are DISJOINT, and that is the whole point of keeping both. A name that is
  // both live and retired would make `tools/list` and the redirect disagree about whether it exists
  // — and the redirect's teaching error would be handed to a caller whose call could have worked.
  it('shares no name with the live catalogue', () => {
    const live = new Set(AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name))
    const overlap = V1_TOOL_MIGRATION_MAP
      .map((entry) => entry.v1Name)
      .filter((name) => live.has(name))
    expect(overlap, 'names declared BOTH live and retired').toEqual([])
  })

  // The admitted/rejected pair, as above. A near-miss spelling of a retired name must match
  // NOTHING, or the redirect would answer for names it was never given.
  it('matches nothing for a near-miss retired name', () => {
    const retired = new Set(V1_TOOL_MIGRATION_MAP.map((entry) => entry.v1Name))
    expect(retired.has('agent_qa_cancel_run')).toBe(true)
    expect(retired.has('agent_qa_cancel_runs')).toBe(false)
    expect(retired.has('agent_qa_cancel')).toBe(false)
  })
})

describe('the degradation list names tools that exist (D-16)', () => {
  it('names a declared tool and one of its declared ops for every entry', () => {
    const byName = new Map(AGENT_QA_TOOL_PROJECTIONS.map((p) => [p.name, p]))
    for (const entry of DEGRADED_OUTPUT_CONTRACTS) {
      const projection = byName.get(entry.tool)
      expect(projection, `${entry.tool} is degraded but not declared`).toBeDefined()
      expect(projection!.ops).toContain(entry.opId)
      expect(entry.measured.length).toBeGreaterThan(0)
      expect(entry.adjudication).toBe('397')
    }
  })
})

// RE-SPELLED 2026-10-01 (432-21, D-12) from '419 D-20 pins the credential-required vocabulary'. The
// `credential: 'required'` marker left with the MCP bearer credential, so no projection declares
// one; the mark door is still the one `apply` entry.
it('419 D-20 pins the credential-required vocabulary', () => {
  expect(AGENT_QA_TOOL_PROJECTIONS.filter(row => Object.hasOwn(row, 'credential')).map(row => row.name)).toEqual([])
  expect(AGENT_QA_TOOL_PROJECTIONS.filter(row => row.kind === 'apply').map(row => row.name)).toEqual(['agent_qa_mark_run'])
})

// 2026-09-15, 423-21 D-18/D-04: the two feedback reads are read tools with their ops' own strict
// contracts, and the evidence read was the one new op on the unprojected side.
// 2026-09-28 (431-04 D-07/D-10): the evidence read is now projected through the evidence fold.
describe('423-21 feedback read tools (D-18)', () => {
  it('MCP-TWO-TOOLS: two read-only feedback tools over their exact contracts, evidence folded, no new write authority', () => {
    const byName = new Map(AGENT_QA_TOOL_PROJECTIONS.map((projection) => [projection.name, projection]))
    const declarationsById = new Map(declarations().map((declaration) => [declaration.id, declaration]))
    const expected = [
      ['agent_qa_get_run_marks', 'runs.marks.history', RunsMarksHistoryInputSchema, RunsMarksHistoryResultSchema],
      ['agent_qa_preview_run_mark', 'runs.mark.preview', RunsMarkInputSchema, RunsMarkPreviewResultSchema],
    ] as const
    for (const [tool, opId, input, output] of expected) {
      const projection = byName.get(tool)
      expect(projection, tool).toBeDefined()
      expect(projection).toEqual({ name: tool, ops: [opId], kind: 'read' })
      // The exact schema singletons the ops validate with, never copies.
      expect(AGENT_QA_OP_CONTRACTS[opId]?.input, `${opId} input`).toBe(input)
      expect(AGENT_QA_OP_CONTRACTS[opId]?.output, `${opId} output`).toBe(output)
      expect(AGENT_QA_COMPOSED_CONTRACTS[tool], `${tool} inherits its op contract`).toBeUndefined()
      const declaration = declarationsById.get(opId)
      // 432-20 (D-10/D-12): no scope or origin key on a declaration; the read claim is the risk's.
      expect(Object.keys(declaration ?? {}), `${opId} scopes`).not.toContain('requiredScopes')
      expect(declaration?.risk.readOnly, `${opId} risk`).toBe(true)
      expect(Object.keys(declaration ?? {}), `${opId} origin`).not.toContain('requiresHumanOrigin')
      const config = toRegisterToolConfig(projection!, [{ id: opId, summary: declaration!.summary,
        risk: declaration!.risk, input, output }], { input, output }, (text) => text)
      expect(config.annotations, `${tool} annotations`).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
      expect(config.outputSchema, `${tool} advertises its strict output`).toBeDefined()
    }
    // The preview is the mark writer's exact input, read-tier: it adds no credential and no apply door.
    expect(Object.hasOwn(byName.get('agent_qa_preview_run_mark') ?? {}, 'credential')).toBe(false)
    // 432-21 (D-12): the mark door declares no credential any more.
    expect(byName.get('agent_qa_mark_run')).toEqual({ name: 'agent_qa_mark_run', kind: 'apply', ops: ['runs.mark'] })
    expect(declarationsById.get('runs.mark')?.risk.readOnly).toBe(false)

    expect(UNPROJECTED_OPS.find((entry) => entry.opId === 'runs.evidence')).toBeUndefined()
    expect(byName.get('agent_qa_get_run_evidence')?.ops).toEqual(['runs.evidence', 'runs.artifact'])
    expect(declarationsById.get('runs.evidence')?.risk.readOnly).toBe(true)
  })
})

// 2026-09-30 (432-12, D-05/D-02): the catalogue after the apply round is gone. The two change tools
// are renamed and write in the call; the four proposal apply/list/show tools and the config undo
// arm leave, with no alias. Their ops are dispositioned on the unprojected side until 432-17
// deletes them from the registry.
const TWENTY_TOOL_NAMES: readonly string[] = [
  'agent_qa_change_config',
  'agent_qa_change_knowledge',
  'agent_qa_diff_knowledge_records',
  'agent_qa_explain_brief',
  'agent_qa_get_entity',
  'agent_qa_get_run_digest',
  'agent_qa_get_run_evidence',
  'agent_qa_get_run_knowledge',
  'agent_qa_get_run_marks',
  'agent_qa_get_run_overview',
  'agent_qa_inspect_knowledge_records',
  'agent_qa_list_knowledge_bundles',
  'agent_qa_list_knowledge_gates',
  'agent_qa_list_runs',
  'agent_qa_mark_run',
  'agent_qa_preview_run_mark',
  'agent_qa_refine_test',
  'agent_qa_show_knowledge_record',
  'agent_qa_start_run',
  'agent_qa_write_test',
]

const RETIRED_TOOL_NAMES: readonly string[] = [
  'agent_qa_apply_config_proposal',
  'agent_qa_apply_proposal',
  'agent_qa_list_proposals',
  'agent_qa_propose_config_change',
  'agent_qa_propose_knowledge_change',
  'agent_qa_show_proposal',
]

describe('C432-MCP-TWENTY-TOOLS: twenty tools, the change tools renamed, no proposal round', () => {
  it('C432-MCP-TWENTY-TOOLS: declares exactly twenty tools by name, and none of the retired names', () => {
    const names = AGENT_QA_TOOL_PROJECTIONS.map((projection) => projection.name).sort()
    expect(names).toEqual([...TWENTY_TOOL_NAMES])
    expect(names).toHaveLength(20)
    for (const retired of RETIRED_TOOL_NAMES) expect(names, retired).not.toContain(retired)
    // No retired name comes back as a v1 redirect target either: the rename is not an alias.
    for (const entry of V1_TOOL_MIGRATION_MAP) {
      if (entry.v2Tool !== undefined) expect(RETIRED_TOOL_NAMES, entry.v1Name).not.toContain(entry.v2Tool)
    }
  })

  it('C432-MCP-TWENTY-TOOLS: the change tools fold the direct ops, and no tool projects an apply or proposal op', () => {
    const byName = new Map(AGENT_QA_TOOL_PROJECTIONS.map((projection) => [projection.name, projection]))
    expect(byName.get('agent_qa_change_knowledge')).toMatchObject({
      ops: ['knowledge.accept', 'knowledge.reject', 'knowledge.forget'], kind: 'workflow',
    })
    expect(byName.get('agent_qa_change_config')).toMatchObject({
      ops: [
        'config.field.set', 'config.target.create', 'config.target.edit',
        'config.auth.set', 'config.hook.add', 'config.project.scaffold',
      ],
      kind: 'workflow',
    })
    const projected = projectedOpIds()
    for (const opId of [
      'config.undo.propose', 'config.proposal.apply', 'knowledge.proposal.apply',
      'proposals.list', 'proposals.show', 'proposals.accept', 'proposals.reject',
    ]) expect(projected, opId).not.toContain(opId)
    expect(projected.filter((opId) => opId.endsWith('.propose'))).toEqual([])
    // The mark door is the only `apply` kind left, and it has no confirmation envelope.
    expect(AGENT_QA_TOOL_PROJECTIONS.filter((p) => p.kind === 'apply').map((p) => p.name))
      .toEqual(['agent_qa_mark_run'])
  })
})

describe('C432-RUNTIME-SETS: the actual registry partition after the cutover', () => {
  // 2026-10-01 (432-17 D-05): 53 -> 46 registered and 23 -> 16 dispositioned. The seven ops that
  // sat here with the removed proposal round are deleted with the inbox; the projection is unmoved.
  // 2026-10-01 (432-18 D-15): 46 -> 44 registered and 16 -> 14 dispositioned; `grants.list` and
  // `grants.revoke` are deleted with the grant ledger.
  it('C432-RUNTIME-SETS: 44 registered ops, 30 projected by twenty tools, 14 dispositioned', () => {
    const registryIds = declarations().map((declaration) => declaration.id).sort()
    const projected = [...projectedOpIds()].sort()
    const unprojected = UNPROJECTED_OPS.map((entry) => entry.opId).sort()
    expect(registryIds).toHaveLength(44)
    expect(projected).toHaveLength(30)
    expect(unprojected).toEqual([
      'agent.ask',
      'agent.explain',
      'analysis.get',
      'authoring.funnel.get',
      'config.get',
      'editor.liveurl',
      'quarantine.add',
      'quarantine.list',
      'quarantine.release',
      'runs.detail',
      'runs.events',
      'runs.get',
      'runs.liveurl',
      'runs.postprocessing',
    ])
    expect([...projected, ...unprojected].sort()).toEqual(registryIds)
    expect(registryIds.filter((id) => id.endsWith('.propose') && id.startsWith('knowledge.'))).toEqual([])
    expect(registryIds.filter((id) => id.startsWith('grants.')), 'C432-NO-GRANT-OPS').toEqual([])
  })
})
