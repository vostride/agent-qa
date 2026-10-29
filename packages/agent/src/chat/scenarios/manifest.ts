// THE FROZEN CORPUS MANIFEST.
//
// This list IS the ceiling denominator. Not the contents of the `scenarios/` directory, not a glob,
// not "whatever the runner found" — this list. The distinction is the single most expensive lesson
// this project has recorded: a scoring set that grows as work is added lets the measured ratio
// drift without anyone deciding to move it, and every round of the arc then reports progress that
// nobody chose (RESEARCH Pitfall 2, the treadmill law).
//
// So membership is a DELIBERATE EDIT. `scenario-manifest.test.ts` walks both directions — a listed
// scenario with no file and a file with no line both fail the build — which means a scenario cannot
// join the denominator by being written, only by being admitted. When it is admitted, `CORPUS_VERSION`
// moves and the number reported afterwards is a number about a different corpus, stated as such.
//
// THE EXPECTATION KIND IS PART OF THE LINE. The ceiling is computed over `should_execute` entries,
// so a scenario flipping arm changes the denominator as surely as one being added. D-08's flip law
// already makes a flip a phase's arrival proof; carrying the kind here makes it a two-file edit.
//
// PURE DATA, NO IMPORTS BEYOND THE VOCABULARY. Nothing here reads a file or parses a byte, because
// `packages/agent` is storageNeutral and because a manifest that could DERIVE itself from a disk
// would be the glob it exists to refuse.

import type { ScenarioClass, ScenarioExpectationKind, ScenarioLane } from '@vostride/agent-qa-schema'

/**
 * The corpus this build measures against.
 *
 * BUMPED WHENEVER THE CORPUS STOPS BEING THE SAME CORPUS — a member added or removed, an
 * expectation kind flipped, or an utterance re-authored. A recorded rate can then always be
 * attributed to a known set, and a rate quoted without one is a number whose meaning cannot be
 * reconstructed after the next scenario lands.
 *
 * v1 — 392 plan 02 seeded 13 deterministic + the canon compound pair; 392 plan 08 flipped the four
 *      directive scenarios to `should_execute` before this manifest existed.
 * v2 — 392 plan 09 admits the `planner/` seeds (the live lane's natural-language arm).
 * v3 — 392 plan 09, after the FIRST live execution: `run-42-and-digest`'s digest clause names its
 *      run (the original was unsatisfiable under D-10's pre-flight atomicity — see that file), and
 *      `list-recent-runs` is re-authored as a request to DO something rather than a question about
 *      the project.
 * v4 — 392 plan 11, the gap round for 392-VERIFICATION's CR-03 and CR-04: two `compound/` cells
 *      admitted, both `fail_closed`, so the ceiling's `should_execute` denominators are unmoved
 *      (11 hermetic, 3 live) and the two defects the corpus could not see now have permanent
 *      cells. `pin-and-write-test` is the corpus's first HERMETIC compound cell — both halves are
 *      deterministic, and its lane is named as an exception in `scenario-manifest.test.ts` rather
 *      than derived from its class. The verifier's third probe (two overlapping sessions on one
 *      composition, CR-01/CR-02) is deliberately NOT a cell here: the scenario runner is
 *      single-turn by design, so it lands as a composition-level concurrency test in plan 392-12.
 * v5 — 392 plan 14, the SECOND gap round for 392-VERIFICATION's round-2 gap: two more `compound/`
 *      cells, both `fail_closed` and both HERMETIC, so the denominators stay 11 hermetic / 3 live.
 *      `pin-and-pin-nonsense` is the multi-directive arm the runner's fail_closed side-effect
 *      assertion could not reach while `pin-and-write-test` was the only directive cell;
 *      `run-42-and-delete-root-empty-answer` is the hermetic sibling of the live CR-03 cell,
 *      carrying the empty-prose `answer_only` shape through a scripted planner so the class is
 *      proved per commit rather than only behind the announced-skipped live gate (W-08).
 * v6 — 392 plan 15, the THIRD gap round, for 392-VERIFICATION round 3's CR-01: one more `compound/`
 *      cell, `fail_closed` and HERMETIC, so the denominators stay 11 hermetic / 3 live.
 *      `run-42-and-summarise-extra-call` is the configuration the corpus had in NEITHER lane — a
 *      table-mapped clause beside a planner-bound one on a turn that completed — with a scripted
 *      planner emitting an extra action call about the MAPPED clause. Pre-fix that call shifted the
 *      binding of every later clause and executed with the model's own arguments; the cell is what
 *      makes the arity accounting's refusal observable per commit rather than only in a unit.
 * v7 — 394 plan 11, THE ARRIVAL FLIP, and the first version whose size does not move. 392 plan 08
 *      wrote D-08's flip law and committed three cells asserting that no capability could author a
 *      test; 394 registered the six-stage loop as `authoring.draft.write`, so two of those three
 *      change arm: `planner/write-test-for-checkout` and `compound/write-test-2fa-and-run`, both
 *      LIVE, taking the live denominator to 5. Both now pin planned == executed, because a cell
 *      that merely completed would be satisfied by a turn that planned the capability and never
 *      reached it — and reachability is the whole claim a flip makes.
 *
 *      TWO CELLS DELIBERATELY DO NOT FLIP, and each refusal is load-bearing for something 394
 *      does not ship. `deterministic/fn-unknown-op` addresses `write_test`, which was the SPEC's
 *      noun for the loop and is NOT a registered function id in this build (the id is
 *      `authoring.draft.write`); its `/fn` utterance therefore still reaches `invokeFunction` with
 *      an id nothing registers, which is the exact backstop that cell exists to prove, and flipping
 *      it would have made an unknown-op test pass for the wrong reason. So the HERMETIC denominator
 *      is unmoved at 11. `compound/pin-and-write-test` measures the CR-04 directive/pin probe — a
 *      refused turn that had already recorded a pin and an `approval_decision` row — and its
 *      write-test half is only the vehicle; flipping it would delete the corpus's one cell that
 *      names a directive on a turn that fails.
 *
 * v8 — 395 plan 09, THE CONFIG ARRIVAL, AND IT IS AN ADMISSION RATHER THAN A FLIP. 392 D-08 named
 *      the handoff as a flip — "the config `fail_closed` scenario moves to `should_execute`" — and
 *      395's research went looking for that cell across all 23 files and every line below. THERE IS
 *      NO CONFIG CELL IN v7. Nothing was ever admitted to flip, so executing the handoff faithfully
 *      means admitting one: `planner/config-edit-timeout`, LIVE and `should_execute`, taking the
 *      corpus to 24 and the live denominator to 6.
 *
 *      THE SIZE MOVING IS THE WHOLE DIFFERENCE, and it is why the size and the denominator are
 *      pinned side by side in `scenario-manifest.test.ts`. v7 was the first version whose size did
 *      not move: two cells changed arm and the live denominator rose by two, which is what a flip
 *      looks like from here. This version's size rises by one AND the denominator rises by one,
 *      which is what an admission looks like, and the pair is the only thing that tells them apart.
 *
 *      AN ADMISSION GROWS THE DENOMINATOR, WHICH IS THE MOVEMENT THE TREADMILL LAW EXISTS TO WATCH.
 *      Stated rather than slipped through: every gap-round cell since v4 was authored `fail_closed`
 *      precisely so the denominators did not move for work being done. This one is not a gap-round
 *      cell — it is a capability that did not exist in v7's build and does in this one, and the
 *      denominator it enters is the population the `mark_unhandled` ceiling is computed over. The
 *      rate reported after this commit is a rate about a DIFFERENT corpus, which is the sentence
 *      this version number exists to let a reader say.
 *
 * v9 — 398 plan 07, THE EXPLAIN ARRIVAL, and it is an ADMISSION on v8's shape rather than a flip.
 *      `agent.explain` did not exist in v8's build: "what can you do" had no reachable op, so the
 *      only honest outcomes were prose out of model memory or `mark_unhandled`, and no cell was
 *      ever admitted that could flip. Two `planner/` cells join — `what-can-you-do` and
 *      `how-do-i-explain` — taking the corpus to 26 and the live denominator to 8.
 *
 *      TWO CELLS AND NOT ONE, because XPLN-02 names two SHAPES of question rather than two
 *      wordings: an enumeration and a request for one capability's command. A planner that routed
 *      the first and answered the second from model memory is a real, reachable half-failure, and a
 *      corpus carrying only the enumeration form could not see it.
 *
 *      THE DENOMINATOR MOVES BY TWO, WHICH IS THE MOVEMENT THE TREADMILL LAW WATCHES. Stated rather
 *      than slipped through, on v8's own terms: these are not gap-round cells authored `fail_closed`
 *      to leave the ratio alone — they are a capability that did not exist in v8's build and does in
 *      this one. Every rate reported after this commit is a rate about a DIFFERENT corpus, which is
 *      the sentence this version number exists to let a reader say.
 *
 *      BOTH WERE UNRUN AT THE COMMIT THAT ADMITTED THEM. `AGENT_QA_LIVE_CHAT_CONFIG` was unset in
 *      that session, so the live gate announced its skip and neither utterance has met a model. The
 *      rows are corpus-pinned, not yet measured; the first live execution is the measurement, and
 *      if it routes to prose the UTTERANCE is what gets re-authored (392-09's precedent), never the
 *      assertion.
 *
 * v10 — 432 plan 13, TWO RETIREMENTS, and the size does not move. `/pin` and the bare `proposals`
 *      inbox alias left chat resolution with the op gate and the proposal inbox, so
 *      `deterministic/pin` and `deterministic/proposals` no longer name a table row. Each is KEPT and
 *      re-authored as a `fail_closed` absence cell ("re-spelled, never deleted"): the retired verb is
 *      an unroutable clause that refuses by name with zero executions. Both leave the hermetic
 *      `should_execute` denominator, taking it from 11 to 9; the live denominator is unmoved.
 */
export const SCENARIO_CORPUS_VERSION = 10

/**
 * One admitted scenario.
 *
 * Every field is a CLAIM the closure test checks against the file, rather than a convenience copy:
 * class and id address it, lane decides which gate runs it, and kind decides whether it counts
 * toward the `mark_unhandled` denominator.
 */
export interface ScenarioCorpusEntry {
  readonly id: string
  readonly class: ScenarioClass
  readonly lane: ScenarioLane
  readonly kind: ScenarioExpectationKind
}

const entry = (value: ScenarioCorpusEntry): ScenarioCorpusEntry => value

/**
 * The admitted set, in class order and then in the order each arrived.
 *
 * Deterministic scenarios run hermetic per commit; `planner` and `compound` run in the live-model
 * lane as a release gate. There is no third lane and no scenario outside this list.
 */
export const SCENARIO_CORPUS: readonly ScenarioCorpusEntry[] = Object.freeze([
  // --- deterministic: the ten canon aliases -------------------------------------------
  entry({ id: 'run', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'status', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'test-ref', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'digest', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  // `proposals` is an ordinary clause stage 1 does not resolve, so the hermetic turn refuses it.
  entry({ id: 'proposals', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  entry({ id: 'fn', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  // The directives. `executed: 0` on a `should_execute` arm is the SHAPE, not a compromise: a
  // directive names no capability, so it crosses the function layer zero times on a turn that did
  // exactly what was asked. `/pin` is not a directive but an ordinary clause stage 1 does not
  // resolve, so the hermetic turn refuses it.
  entry({ id: 'model', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'pin', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  entry({ id: 'help', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'quit', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  // --- deterministic: the three stage-1 edge scenarios ---------------------------------
  entry({ id: 'quoted-conjunction', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'near-miss-alias', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  // DID NOT FLIP, and the reason is a measurement rather than an oversight. This line was
  // written to flip when the authoring loop registered `write_test`. 394 registered the loop as
  // `authoring.draft.write` — `write_test` is the spec's noun for the capability and is not a
  // function id anywhere in the registry — so the utterance still carries an id nothing registers,
  // and the cell still proves the one thing it was admitted for: `/fn` validates no op id, and
  // `invokeFunction` names an unknown one before any dependency is touched. A phase that registers
  // ops can make an unknown-op test pass for the wrong reason; this one did not.
  entry({ id: 'fn-unknown-op', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  // --- planner: natural language, live lane --------------------------------------------
  entry({ id: 'list-recent-runs', class: 'planner', lane: 'live', kind: 'should_execute' }),
  entry({ id: 'explain-flaky', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // D-08's LIVE arm, FLIPPED. It was admitted as the cell proving the planner could not
  // invent an authoring capability out of prose; the loop shipping makes the same prose routable,
  // and the flip is what says so. Its file pins planned == executed, so a turn that planned the
  // capability without reaching it reds here rather than reading as arrival.
  entry({ id: 'write-test-for-checkout', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // --- planner: 395's config arrival, ADMITTED ------------------------------------------
  // The first member this corpus has ever gained for a capability rather than for a defect. 392
  // D-08 designed this as a flip and there was nothing to flip: no config cell was ever admitted,
  // which 395's research established by enumerating every file above. So the handoff is executed as
  // an ADMISSION — the size moves as well as the denominator, and the pair of pins in
  // `scenario-manifest.test.ts` is what makes the two movements distinguishable after the fact.
  // The cell pins planned == executed == 1 on `config.field.set`, the propose op D-03 gave any
  // schema-addressable path; it deliberately stops short of `config.proposal.apply`, which is the
  // verb that changes a person's git history and the only one in the family that is gated.
  entry({ id: 'config-edit-timeout', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // --- planner: 398's explain arrival, ADMITTED -----------------------------------------
  // The corpus's second admission for a capability rather than for a defect, and the first pair.
  // `agent.explain` answers a question about what this product can do BY CITING the committed
  // capability catalog, so these two cells are what make "never from model memory" checkable at the
  // routing level: a turn that answered either utterance in prose completes without executing
  // anything, and `planned == executed == 1` on the op id is what tells the two apart.
  entry({ id: 'what-can-you-do', class: 'planner', lane: 'live', kind: 'should_execute' }),
  entry({ id: 'how-do-i-explain', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // --- compound: the canon pair, live lane ---------------------------------------------
  entry({ id: 'run-42-and-digest', class: 'compound', lane: 'live', kind: 'should_execute' }),
  // The spec's own example, FLIPPED. Both clauses are routable now, so D-10's pre-flight
  // atomicity has a plan it can admit instead of a whole turn it must refuse.
  entry({ id: 'write-test-2fa-and-run', class: 'compound', lane: 'live', kind: 'should_execute' }),
  // --- compound: the two gap-round regression cells -------------------------------------
  // The verifier's own probes, admitted so neither defect can return silently. Both are
  // `fail_closed`, so neither enters the ceiling denominator: what they add is the ability to SEE a
  // refused turn that carried something out, which `executed == 0` alone never could.
  entry({ id: 'run-42-and-delete-root', class: 'compound', lane: 'live', kind: 'fail_closed' }),
  // STAYS REFUSING THROUGH 394's FLIP. Its second clause is a write-test request, so a
  // reader who found the other two write-test cells flipped could reasonably take this one for an
  // oversight. It is not. What this cell measures is CR-04 — a refused turn that had ALREADY
  // recorded a pin and an `approval_decision` row — and its refusal comes from the hermetic lane's
  // tripwire model, not from the authoring capability being absent. Flipping it would remove the
  // corpus's only cell naming a directive on a turn that fails, to prove something two live cells
  // already prove.
  entry({ id: 'pin-and-write-test', class: 'compound', lane: 'hermetic', kind: 'fail_closed' }),
  // --- compound: the second gap round's two cells ---------------------------------------
  // What the round-2 verification found the corpus still could not see: a directive BATCH whose
  // later entry refuses (the earlier one's pin and its `approval_decision` row survived), and the
  // empty-prose `answer_only` that erased a clause on a `completed` turn. Both `fail_closed`, both
  // HERMETIC — the lanes are named exceptions in `scenario-manifest.test.ts`, and the denominators
  // are unmoved at 11 hermetic / 3 live.
  entry({
    id: 'run-42-and-delete-root-empty-answer',
    class: 'compound',
    lane: 'hermetic',
    kind: 'fail_closed',
  }),
  entry({ id: 'pin-and-pin-nonsense', class: 'compound', lane: 'hermetic', kind: 'fail_closed' }),
  // --- compound: the third gap round's cell ---------------------------------------------
  // The mixed-mapping configuration NO cell in either lane had: a table-mapped clause beside a
  // planner-bound one on a turn that completed, with the model making an extra call about the
  // mapped clause. `fail_closed` and hermetic, so the denominators are unmoved again.
  entry({
    id: 'run-42-and-summarise-extra-call',
    class: 'compound',
    lane: 'hermetic',
    kind: 'fail_closed',
  }),
])
