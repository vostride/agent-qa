// Walks both directions, so a scenario joins the ceiling's denominator only by a manifest line.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCENARIO_CLASSES } from '@vostride/agent-qa-schema'
import type { ScenarioClass } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { CHAT_RESOLVER_TABLE, resolveClause } from '../resolver-table.js'
import { splitClauses } from '../clause-split.js'
import { parseScenario, scenarioRelativePath } from '../scenario-loader.js'
import { EXPLAIN_FUNCTION_ID } from '../../functions/ops/explain.js'
import { SCENARIO_CORPUS, SCENARIO_CORPUS_VERSION } from '../scenarios/manifest.js'

const SCENARIOS_ROOT = fileURLToPath(new URL('../scenarios', import.meta.url))

function idsOnDisk(scenarioClass: ScenarioClass): string[] {
  const directory = join(SCENARIOS_ROOT, scenarioClass)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => file.endsWith('.yml'))
    .map((file) => file.slice(0, -'.yml'.length))
    .sort()
}

function manifestIds(scenarioClass: ScenarioClass): string[] {
  return SCENARIO_CORPUS.filter((entry) => entry.class === scenarioClass)
    .map((entry) => entry.id)
    .sort()
}

describe('the corpus manifest is versioned and internally coherent', () => {
  it('pins a corpus version', () => {
    // An integer that a reader can quote when they say "measured over corpus N". A ratio reported
    // without one is a number whose meaning nobody can reconstruct six months later.
    expect(Number.isInteger(SCENARIO_CORPUS_VERSION)).toBe(true)
    expect(SCENARIO_CORPUS_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('lists a non-empty corpus with unique ids', () => {
    // A manifest that silently emptied would make every closure assertion below vacuously true.
    expect(SCENARIO_CORPUS.length).toBeGreaterThan(10)
    const ids = SCENARIO_CORPUS.map((entry) => `${entry.class}/${entry.id}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is exactly the corpus its version says it is', () => {
    expect(SCENARIO_CORPUS.length).toBe(26)
    expect(SCENARIO_CORPUS_VERSION).toBe(10)
    const denominator = (lane: string): number =>
      SCENARIO_CORPUS.filter((entry) => entry.lane === lane && entry.kind === 'should_execute')
        .length
    expect(denominator('hermetic')).toBe(9)
    expect(denominator('live')).toBe(8)
  })

  it('records the authoring loop\'s arrival flip by name: two cells route, and two still refuse', () => {
    const kindOf = (id: string): string | undefined =>
      SCENARIO_CORPUS.find((entry) => entry.id === id)?.kind
    expect(kindOf('write-test-for-checkout')).toBe('should_execute')
    expect(kindOf('write-test-2fa-and-run')).toBe('should_execute')
    expect(kindOf('fn-unknown-op')).toBe('fail_closed')
    expect(kindOf('pin-and-write-test')).toBe('fail_closed')
  })

  it('records the config-edit arrival by name: an ADMITTED live cell, not a flipped one', () => {
    const admitted = SCENARIO_CORPUS.find((entry) => entry.id === 'config-edit-timeout')
    expect(admitted).toBeDefined()
    expect(admitted?.class).toBe('planner')
    expect(admitted?.lane).toBe('live')
    expect(admitted?.kind).toBe('should_execute')
  })

  it('records the explain arrival by name: TWO admitted live cells, one per question shape', () => {
    // The op id is imported, so renaming `agent.explain` fails here instead of orphaning rows.
    for (const id of ['what-can-you-do', 'how-do-i-explain']) {
      const admitted = SCENARIO_CORPUS.find((entry) => entry.id === id)
      expect(admitted, `${id} is not in the corpus`).toBeDefined()
      expect(admitted?.class).toBe('planner')
      expect(admitted?.lane).toBe('live')
      expect(admitted?.kind).toBe('should_execute')

      const path = join(SCENARIOS_ROOT, 'planner', `${id}.yml`)
      const scenario = parse(readFileSync(path, 'utf8')) as {
        readonly expect?: { readonly ops?: readonly string[] }
      }
      expect(scenario.expect?.ops, `${id} must name the explain op`).toEqual([EXPLAIN_FUNCTION_ID])
    }
  })

  it('assigns each class its lane, with every exception NAMED', () => {
    // The rule is about what a cell NEEDS, and the class is usually a faithful proxy for it:
    // `deterministic` never touches the LLM by contract, `planner` cannot be answered without one.
    // A `compound` cell is live BY DEFAULT because its clauses usually reach a model — but a
    // compound turn whose every half is deterministic buys nothing from a live one. That exception
    // is a LIST rather than a predicate, so a cell cannot choose its own lane quietly: joining it
    // is an edit to this file as well as to the manifest.
    const HERMETIC_COMPOUND = new Set([
      'pin-and-write-test',
      // Two directives resolve at stage 1, and the empty-answer sibling runs on a scripted planner.
      'pin-and-pin-nonsense',
      'run-42-and-delete-root-empty-answer',
      // The extra action call comes from the model, so a scripted planner drives it hermetically.
      'run-42-and-summarise-extra-call',
    ])
    for (const entry of SCENARIO_CORPUS) {
      const expected =
        entry.class === 'deterministic'
          ? 'hermetic'
          : entry.class === 'compound' && HERMETIC_COMPOUND.has(entry.id)
            ? 'hermetic'
            : 'live'
      expect(entry.lane).toBe(expected)
    }
    // The two arms with NO exception, asserted apart so the list above can never grow into them.
    expect(
      SCENARIO_CORPUS.filter((entry) => entry.class === 'deterministic').every(
        (entry) => entry.lane === 'hermetic',
      ),
    ).toBe(true)
    expect(
      SCENARIO_CORPUS.filter((entry) => entry.class === 'planner').every(
        (entry) => entry.lane === 'live',
      ),
    ).toBe(true)
  })
})

describe('manifest -> file: every listed scenario exists and agrees with its line', () => {
  it.each(SCENARIO_CORPUS.map((entry) => [`${entry.class}/${entry.id}`, entry] as const))(
    '%s exists, parses through the schema, and matches its manifest line',
    (_label, entry) => {
      const path = join(SCENARIOS_ROOT, scenarioRelativePath(entry))
      expect(
        existsSync(path),
        `the manifest lists ${entry.class}/${entry.id} and no such file exists — either add `
          + `src/chat/scenarios/${scenarioRelativePath(entry)} or remove the manifest line`,
      ).toBe(true)

      const scenario = parseScenario(parse(readFileSync(path, 'utf8')), entry)
      expect(scenario.id).toBe(entry.id)
      expect(scenario.class).toBe(entry.class)
      expect(scenario.lane).toBe(entry.lane)
      // The kind is the denominator's own definition: the ceiling counts `should_execute` entries.
      expect(scenario.expect.kind).toBe(entry.kind)
    },
  )
})

describe('file -> manifest: an unlisted file is a build error (the anti-treadmill mechanism)', () => {
  it.each(SCENARIO_CLASSES)('class %s is an EXACT set, never a directory listing', (scenarioClass) => {
    expect(
      idsOnDisk(scenarioClass),
      `the ${scenarioClass}/ directory and the manifest disagree — a scenario enters the `
        + 'ceiling denominator only through a deliberate manifest edit (D-15)',
    ).toEqual(manifestIds(scenarioClass))
  })

  it('scans a real, non-empty scenarios tree', () => {
    // A walker pointed at a moved directory would find nothing and agree with an empty manifest
    // forever, which is the way a set-equality pin dies quietly.
    expect(existsSync(SCENARIOS_ROOT)).toBe(true)
    expect(SCENARIO_CLASSES.flatMap(idsOnDisk).length).toBe(SCENARIO_CORPUS.length)
  })
})

describe('the manifest and the structural cap describe ONE corpus', () => {
  it.each(CHAT_RESOLVER_TABLE.map((rule) => rule.alias))(
    'resolver-table alias %s is in the manifest as a deterministic scenario',
    (alias) => {
      expect(manifestIds('deterministic')).toContain(alias)
    },
  )
})

describe('every argsPin is what stage 1 actually binds (corpus walk)', () => {
  // `ClauseReceipt` carries no arguments, so the table's bound arguments are checked here.
  const PINNED = SCENARIO_CORPUS.filter((corpusEntry) => corpusEntry.class === 'deterministic')
    .map((corpusEntry) => ({
      corpusEntry,
      scenario: parseScenario(
        parse(readFileSync(join(SCENARIOS_ROOT, scenarioRelativePath(corpusEntry)), 'utf8')),
        corpusEntry,
      ),
    }))
    .filter(({ scenario }) => scenario.expect.argsPin !== undefined)

  it('walks a non-empty set of pinned arguments', () => {
    // Four cells pin arguments today. A filter that silently matched none would make the walk
    // below green forever.
    expect(PINNED.length).toBeGreaterThanOrEqual(4)
  })

  it.each(PINNED.map((pinned) => [pinned.scenario.id, pinned] as const))(
    '%s binds the arguments its file pins',
    (_id, { scenario }) => {
      const clauses = splitClauses(scenario.utterance)
      // Every cell with an argsPin is single-clause today; a compound one would need the pin to
      // say WHICH clause, and the vocabulary deliberately has no such field yet.
      expect(clauses).toHaveLength(1)
      const resolution = resolveClause(CHAT_RESOLVER_TABLE, clauses[0]!.text)
      expect(resolution.kind).toBe('resolved')
      const entry = resolution.kind === 'resolved' ? resolution.entry : undefined
      expect(entry?.kind).toBe('op')
      expect(entry?.kind === 'op' ? entry.input : undefined).toMatchObject(
        scenario.expect.argsPin ?? {},
      )
    },
  )
})

describe('parseScenario refuses by name rather than returning a shape nobody checked', () => {
  it('names the scenario when the document violates the schema', () => {
    expect(() =>
      parseScenario({ id: 'broken', class: 'deterministic', lane: 'hermetic' }, {
        id: 'broken',
        class: 'deterministic',
      }),
    ).toThrow(/deterministic\/broken/)
  })

  it('names the scenario when the document disagrees with the manifest line', () => {
    // The id inside the file and the id the manifest used to find it are two different facts, and
    // a loader that trusted the filename would let them drift.
    expect(() =>
      parseScenario(
        {
          id: 'somebody-else',
          class: 'deterministic',
          lane: 'hermetic',
          utterance: 'proposals',
          expect: { kind: 'should_execute', executed: 1 },
        },
        { id: 'proposals', class: 'deterministic' },
      ),
    ).toThrow(/proposals/)
  })

  it('returns the parsed scenario when the document is well formed', () => {
    const scenario = parseScenario(
      {
        id: 'proposals',
        class: 'deterministic',
        lane: 'hermetic',
        utterance: 'proposals',
        expect: { kind: 'should_execute', executed: 1, ops: ['proposals.list'] },
      },
      { id: 'proposals', class: 'deterministic' },
    )
    expect(scenario.utterance).toBe('proposals')
    expect(scenario.expect.ops).toEqual(['proposals.list'])
  })
})
