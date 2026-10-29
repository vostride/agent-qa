// This list is the ceiling denominator; a scenario joins only by an explicit line here.

import type { ScenarioClass, ScenarioExpectationKind, ScenarioLane } from '@vostride/agent-qa-schema'

// Bumped whenever the corpus changes, so a recorded rate is attributable to a known set.
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

// Class order, then arrival order; each entry's lane decides which gate runs it.
export const SCENARIO_CORPUS: readonly ScenarioCorpusEntry[] = Object.freeze([
  // Deterministic: the canon aliases.
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
  // Deterministic: the stage-1 edge scenarios.
  entry({ id: 'quoted-conjunction', class: 'deterministic', lane: 'hermetic', kind: 'should_execute' }),
  entry({ id: 'near-miss-alias', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  // `write_test` is not a registered id, so `/fn` reaches `invokeFunction` with an unknown op.
  entry({ id: 'fn-unknown-op', class: 'deterministic', lane: 'hermetic', kind: 'fail_closed' }),
  // Planner: natural language, live lane.
  entry({ id: 'list-recent-runs', class: 'planner', lane: 'live', kind: 'should_execute' }),
  entry({ id: 'explain-flaky', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // Pins planned equals executed, so a turn that planned authoring without reaching it fails.
  entry({ id: 'write-test-for-checkout', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // Pins one planned and executed `config.field.set`, the propose op for any schema path.
  entry({ id: 'config-edit-timeout', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // A prose answer executes nothing, so one executed `agent.explain` proves the catalog was cited.
  entry({ id: 'what-can-you-do', class: 'planner', lane: 'live', kind: 'should_execute' }),
  entry({ id: 'how-do-i-explain', class: 'planner', lane: 'live', kind: 'should_execute' }),
  // Compound: the canon pair, live lane.
  entry({ id: 'run-42-and-digest', class: 'compound', lane: 'live', kind: 'should_execute' }),
  // Both clauses route, so pre-flight atomicity has a plan it can admit.
  entry({ id: 'write-test-2fa-and-run', class: 'compound', lane: 'live', kind: 'should_execute' }),
  // Fail-closed cells that see a refused turn which carried something out.
  entry({ id: 'run-42-and-delete-root', class: 'compound', lane: 'live', kind: 'fail_closed' }),
  // Its refusal comes from the hermetic lane's tripwire model, not from authoring being absent.
  entry({ id: 'pin-and-write-test', class: 'compound', lane: 'hermetic', kind: 'fail_closed' }),
  // A refused later directive in a batch, and an empty-prose `answer_only`.
  entry({
    id: 'run-42-and-delete-root-empty-answer',
    class: 'compound',
    lane: 'hermetic',
    kind: 'fail_closed',
  }),
  entry({ id: 'pin-and-pin-nonsense', class: 'compound', lane: 'hermetic', kind: 'fail_closed' }),
  // A table-mapped clause beside a planner-bound one, plus a model call about the mapped one.
  entry({
    id: 'run-42-and-summarise-extra-call',
    class: 'compound',
    lane: 'hermetic',
    kind: 'fail_closed',
  }),
])
