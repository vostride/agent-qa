// Walks both directions: a table row with no scenario file and a file with no row both fail.

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
  // A quoted conjunction must not manufacture a second clause.
  'quoted-conjunction',
  // A misspelled alias does not resolve at stage 1, and there is no partial arm.
  'near-miss-alias',
  // An op id no registry knows comes back named, from `invokeFunction` rather than the table.
  'fn-unknown-op',
  // `/pin` and bare `proposals` are absence cells: unroutable clauses that refuse by name.
  'pin',
  'proposals',
] as const

// Exact set: a file in `compound/` without a line here fails the build.
const COMPOUND_SCENARIOS = [
  'write-test-2fa-and-run',
  'run-42-and-digest',
  'run-42-and-delete-root',
  'pin-and-write-test',
  'run-42-and-delete-root-empty-answer',
  'pin-and-pin-nonsense',
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
    // Deterministic scenarios never reach the model, which is why they need no mock.
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
      // A fail-closed scenario pins zero executions, or a half-run then refused turn passes.
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
      // Each cell pins that nothing ran and that a `mark_unhandled` row was logged.
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
    // The digest clause names its run, because the plan is fixed before clause one starts a run.
    expect(scenario.utterance).toBe('run test 42 and show me the digest for RUN-1')
    expect(scenario.expect.kind).toBe('should_execute')
    expect(scenario.expect.planned).toBe(2)
    expect(scenario.expect.executed).toBe(2)
    expect(scenario.expect.ops).toEqual(['runs.start', 'runs.digest'])
  })
})
