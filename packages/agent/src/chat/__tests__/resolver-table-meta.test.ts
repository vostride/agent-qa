// THE STRUCTURAL CAP (Phase 392, D-05 / CHAT-02).
//
// "No new top-level branches without a test" is not reviewer discipline here — it is
// BUILD-IMPOSSIBLE. This file walks the resolver table and demands a scenario file for every row,
// so an eleventh alias added to the canon fails the suite until somebody says, in committed data,
// what typing it is supposed to do. That is the whole mechanism, and it is why plan 01 shipped
// the table with ONE entry: adding six aliases before the thing that makes untested branches
// impossible would have been six untested branches.
//
// IT WALKS BOTH DIRECTIONS. Table → file catches a branch nobody characterised. File → table
// catches the opposite drift, a scenario claiming canon status for an alias that no longer
// exists, which would otherwise sit in the corpus asserting something about a code path that was
// deleted. The second direction is an EXACT set comparison against the table's aliases plus a
// pinned list of the edge scenarios that deliberately belong to no single row — a frozen
// denominator by construction (D-15 / RESEARCH Pitfall 2), never a `glob` whose contents are
// whatever happens to be on disk.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ChatScenarioSchema } from '@vostride/agent-qa-schema'
import type { ChatScenario } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { CHAT_RESOLVER_TABLE } from '../resolver-table.js'

const SCENARIOS_ROOT = fileURLToPath(new URL('../scenarios', import.meta.url))
const DETERMINISTIC_ROOT = join(SCENARIOS_ROOT, 'deterministic')
const COMPOUND_ROOT = join(SCENARIOS_ROOT, 'compound')

/**
 * Deterministic scenarios that belong to NO single table row.
 *
 * Each one characterises a property of stage 1 as a whole rather than of one alias, and each is
 * listed here by hand so that the both-directions walk stays exact. A new file appearing on disk
 * without a line added here fails the suite — which is the point: the corpus is a manifest, not
 * a directory listing.
 */
const EDGE_SCENARIOS = [
  // Pitfall 5: a quoted conjunction must not manufacture a second clause.
  'quoted-conjunction',
  // CHAT-01 boundary: a misspelled alias does not resolve at stage 1, and there is no partial arm.
  'near-miss-alias',
  // D-08: an op id no registry knows comes back named, from `invokeFunction` rather than a check
  // inside the table.
  'fn-unknown-op',
  // 432-13 (D-05/D-14): two RETIRED aliases, kept as measured absences. `/pin` and the bare
  // `proposals` inbox left the table; each cell pins that the clause is now unroutable and the
  // turn refuses by name with zero executions ("re-spelled, never deleted").
  'pin',
  'proposals',
] as const

/**
 * The compound cells, as committed data (CONTEXT specifics; 392-11's gap round).
 *
 * The canon PAIR plus the two regression cells the gap round admitted — the verifier's own probes
 * for CR-03 (a model answer erasing an unroutable action clause) and CR-04 (a directive carried out
 * on a turn that was then refused). They are listed here for the same reason the pair was: this set
 * is exact, so a file appearing in `compound/` without a line here fails the build.
 */
const COMPOUND_SCENARIOS = [
  'write-test-2fa-and-run',
  'run-42-and-digest',
  'run-42-and-delete-root',
  'pin-and-write-test',
  // 392-14's pair: the hermetic sibling of the live CR-03 cell (so the class is proved per commit
  // rather than behind an announced-skipped gate), and the multi-directive batch arm.
  'run-42-and-delete-root-empty-answer',
  'pin-and-pin-nonsense',
  // 392-15's cell: a table-mapped clause beside a planner-bound one, with the model making an extra
  // action call about the mapped one (CR-01). The mixed-mapping configuration neither lane had.
  'run-42-and-summarise-extra-call',
] as const

function scenarioIdsIn(directory: string): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => file.slice(0, -'.yml'.length))
    .sort()
}

/** Read one scenario THROUGH the zod schema — a file that parses as YAML is not yet a scenario. */
function readScenario(directory: string, id: string): ChatScenario {
  return ChatScenarioSchema.parse(parse(readFileSync(join(directory, `${id}.yml`), 'utf8')))
}

const TABLE_ALIASES = CHAT_RESOLVER_TABLE.map((rule) => rule.alias)

describe('every resolver-table entry has a scenario (table → file)', () => {
  it.each(TABLE_ALIASES)('alias %s has scenarios/deterministic/<alias>.yml', (alias) => {
    expect(
      existsSync(join(DETERMINISTIC_ROOT, `${alias}.yml`)),
      `no scenario file characterises the "${alias}" alias — add `
        + `src/chat/scenarios/deterministic/${alias}.yml saying what typing it does`,
    ).toBe(true)
  })

  it.each(TABLE_ALIASES)('alias %s validates against the ChatScenario schema', (alias) => {
    const scenario = readScenario(DETERMINISTIC_ROOT, alias)
    // The filename IS the key the walk uses, so a file whose `id` disagrees with its name would
    // be found by one direction of the walk and missed by the other.
    expect(scenario.id).toBe(alias)
    expect(scenario.class).toBe('deterministic')
    // Deterministic scenarios never touch the LLM BY CONTRACT, which is why they need no mock
    // and why "no mocks in either lane" is a true statement rather than an aspiration (D-13).
    expect(scenario.lane).toBe('hermetic')
  })
})

describe('every deterministic scenario names a table entry (file → table)', () => {
  it('is an EXACT set: the canon plus the pinned edge cases, nothing else', () => {
    expect(scenarioIdsIn(DETERMINISTIC_ROOT)).toEqual(
      [...TABLE_ALIASES, ...EDGE_SCENARIOS].sort(),
    )
  })

  it.each(EDGE_SCENARIOS)('edge scenario %s is a well-formed deterministic scenario', (id) => {
    const scenario = readScenario(DETERMINISTIC_ROOT, id)
    expect(scenario.id).toBe(id)
    expect(scenario.class).toBe('deterministic')
    expect(scenario.lane).toBe('hermetic')
  })
})

describe('the fail-closed arm names what it refused', () => {
  it.each([...TABLE_ALIASES, ...EDGE_SCENARIOS])(
    'scenario %s that expects fail_closed pins zero executions and names the clause',
    (id) => {
      const scenario = readScenario(DETERMINISTIC_ROOT, id)
      if (scenario.expect.kind !== 'fail_closed') return
      // D-10's atomicity is not a property of the failure path — it is the whole claim. A
      // fail-closed scenario that stayed silent about the count would pass against a turn that
      // ran half the request and then refused.
      expect(scenario.expect.executed).toBe(0)
      expect(scenario.expect.namesClause).toBeTruthy()
    },
  )
})

describe('the canon compound pair exists as committed data', () => {
  it('is an EXACT set — the frozen denominator, never a directory listing', () => {
    expect(scenarioIdsIn(COMPOUND_ROOT)).toEqual([...COMPOUND_SCENARIOS].sort())
  })

  it.each([
    'run-42-and-delete-root',
    'pin-and-write-test',
    'run-42-and-delete-root-empty-answer',
    'pin-and-pin-nonsense',
    'run-42-and-summarise-extra-call',
  ])(
    'gap-round cell %s pins a refusal that NAMES its clause and leaves a countable row',
    (id) => {
      // Both cells exist because a refusal that carried something out was invisible to
      // `executed == 0`. What each one pins is the pair: nothing ran, AND the refusal is on the
      // log — the `mark_unhandled` row is what CHAT-03's field rate is a projection over, so a
      // clause erased without one would be missing from the measurement as well as from the answer.
      const scenario = readScenario(COMPOUND_ROOT, id)
      expect(scenario.class).toBe('compound')
      expect(scenario.expect.kind).toBe('fail_closed')
      expect(scenario.expect.executed).toBe(0)
      expect(scenario.expect.namesClause).toBeTruthy()
      expect(scenario.expect.emitsSessionEvent).toBe('mark_unhandled')
      expect(scenario.utterance).toContain(scenario.expect.namesClause ?? '')
    },
  )

  it('pins the spec example on the ARRIVED arm, both clauses routed', () => {
    // THIS PIN CHANGED ARM WITH THE CORPUS, and that is the second half of D-08's flip law. The
    // cell was admitted asserting that `write_test` was in no registry, so pre-flight atomicity
    // refused the whole turn and the runnable second clause did not get to run either. 394
    // registered the loop as `authoring.draft.write`, and a meta-test still pinning the refusal
    // would have made the flip a one-file edit that this file then contradicted.
    const scenario = readScenario(COMPOUND_ROOT, 'write-test-2fa-and-run')
    expect(scenario.class).toBe('compound')
    expect(scenario.utterance).toBe('write a test for 2FA and run it')
    expect(scenario.expect.kind).toBe('should_execute')
    // Planned EQUALS executed, which is what makes this arrival rather than a relabelling: a cell
    // asserting only that the turn completed would be satisfied by one that planned the capability
    // and never reached it.
    expect(scenario.expect.planned).toBe(2)
    expect(scenario.expect.executed).toBe(2)
    expect(scenario.expect.ops).toEqual(['authoring.draft.write', 'runs.start'])
  })

  it('pins the happy path at planned == executed == 2 in utterance order', () => {
    const scenario = readScenario(COMPOUND_ROOT, 'run-42-and-digest')
    expect(scenario.class).toBe('compound')
    // The digest clause NAMES its run (392-09, after the first live execution of this file). The
    // original `show me the digest` was unsatisfiable by construction rather than by model quality:
    // D-10 decides the whole plan before the first side effect, so clause two cannot be handed the
    // run clause one is about to start, and `runId` is required. The file's own head carries the
    // finding; this pin moves with it so the change stays a deliberate two-file edit.
    expect(scenario.utterance).toBe('run test 42 and show me the digest for RUN-1')
    expect(scenario.expect.kind).toBe('should_execute')
    expect(scenario.expect.planned).toBe(2)
    expect(scenario.expect.executed).toBe(2)
    expect(scenario.expect.ops).toEqual(['runs.start', 'runs.digest'])
  })
})
