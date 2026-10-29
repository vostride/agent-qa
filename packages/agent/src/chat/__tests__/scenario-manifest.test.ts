// THE FROZEN DENOMINATOR (Phase 392 plan 09, D-15 / CHAT-03 / RESEARCH Pitfall 2).
//
// CHAT-03's ceiling is a RATIO, and a ratio is only a measurement if its denominator holds still.
// This project's dominant historical failure is the opposite: a scoring set that grows as work is
// added, so the number improves without anyone deciding it should. `SCENARIO_CORPUS` is the answer
// — an explicit, versioned list of every scenario by class — and this file is what makes the list
// true. Both directions are walked:
//
//   manifest -> file: every listed scenario exists, parses through the schema, and AGREES with
//                     what the manifest says about it (class, lane, expectation kind).
//   file -> manifest: every `.yml` under `scenarios/` is listed. A file dropped on disk without a
//                     manifest line FAILS THE BUILD, which is the whole anti-treadmill mechanism:
//                     the only way into the denominator is a deliberate edit to a committed list.
//
// THE EXPECTATION KIND IS PINNED HERE TOO, and that is deliberate rather than incidental. The
// ceiling is computed over `should_execute` entries, so the kind IS part of the denominator's
// definition — a scenario quietly flipping from `fail_closed` to `should_execute` would move the
// number the ceiling holds down. D-08's flip law already says a flip is a phase's arrival proof;
// pinning the kind makes that flip a two-file edit rather than a one-file one.
//
// RECONCILIATION WITH 392-02's STRUCTURAL CAP (`resolver-table-meta.test.ts`). That file also pins
// an exact scenario set, for a different claim: every resolver-table row is characterised. The two
// denominators must be the same set or the phase has two answers to "what is the corpus", so this
// file asserts the manifest against the same on-disk directories AND asserts that every table alias
// appears in the manifest. The manifest is authoritative for the CEILING; the meta-test stays
// authoritative for "no untested top-level branch". Neither can drift from the other in silence.

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
    // THE SIZE AND THE VERSION MOVE TOGETHER, in one commit, or the ratio reported afterwards is a
    // number about a set nobody can name. v4 was 392-11's gap round: 18 + two regression cells.
    // v5 is 392-14's: 20 + the two the ROUND-2 verification found still invisible. v6 is 392-15's:
    // 22 + the mixed-mapping cell the ROUND-3 verification found neither lane had. v7 is 394-11's
    // ARRIVAL FLIP: the size is unchanged at 23 and two live cells change arm, which is exactly the
    // case this pin exists to make visible — a flip moves the denominator without moving the size.
    //
    // v8 IS 395-09's ARRIVAL ADMISSION, and it is the OTHER movement this pair exists to tell apart.
    // 392 D-08 designed the config handoff as a flip; 395's research enumerated the whole v7 corpus
    // and found no config cell to flip, so the handoff lands as an admission instead. The size rises
    // to 24 AND the live denominator rises to 6 — both, together — where v7's flip moved only the
    // denominator. Reading the two numbers in one assertion is the only thing that distinguishes
    // "a capability arrived" from "a cell changed its mind", and after this commit a reader can say
    // which happened without reconstructing it from the diff.
    //
    // v9 IS 398-07's EXPLAIN ARRIVAL, an admission on v8's shape: two `planner/` cells for a
    // capability that did not exist in v8's build, so the size rises to 26 AND the live denominator
    // rises to 8 — both, together, which is what distinguishes this from a flip.
    //
    // v10 IS 432-13's TWO RETIREMENTS: `pin` and `proposals` stay in the corpus as `fail_closed`
    // absence cells, so the size is unchanged at 26 and the hermetic denominator falls to 9 — a flip
    // in the other direction, stated rather than slipped through.
    expect(SCENARIO_CORPUS.length).toBe(26)
    expect(SCENARIO_CORPUS_VERSION).toBe(10)
    // The denominators the ceiling is computed over, pinned per lane. Every gap-round cell is
    // `fail_closed` precisely so these two numbers did NOT move — a corpus round that quietly grew
    // the denominator would report a better rate for having done work (the treadmill law). What
    // DOES move them is a deliberate flip, and 394-11 is the first one: the live count rises by the
    // two write-test cells the authoring loop makes routable, and the hermetic count is unchanged
    // because `fn-unknown-op` names an id this build still does not register (see its manifest
    // comment — the loop shipped as `authoring.draft.write`, so that cell keeps proving the
    // negative rather than joining the population).
    const denominator = (lane: string): number =>
      SCENARIO_CORPUS.filter((entry) => entry.lane === lane && entry.kind === 'should_execute')
        .length
    expect(denominator('hermetic')).toBe(9)
    expect(denominator('live')).toBe(8)
  })

  it('records the authoring loop\'s arrival flip by name: two cells route, and two still refuse', () => {
    // D-08's FLIP LAW, made an assertion rather than a paragraph. The authoring loop registering
    // `authoring.draft.write` is what moves these lines, so a build that lost the op would red HERE
    // as well as in the parity walk — and a reader who found all four cells refusing would know the
    // capability had regressed rather than having to reconstruct it.
    //
    // THE TWO THAT STAY REFUSING ARE THE POINT OF THIS CELL. A phase that registers ops can make an
    // unknown-op test pass for the wrong reason, so the negative direction is pinned beside the
    // positive one: `fn-unknown-op` addresses an id nothing registers, and `pin-and-write-test`
    // measures the CR-04 directive/pin probe rather than the write-test half.
    const kindOf = (id: string): string | undefined =>
      SCENARIO_CORPUS.find((entry) => entry.id === id)?.kind
    expect(kindOf('write-test-for-checkout')).toBe('should_execute')
    expect(kindOf('write-test-2fa-and-run')).toBe('should_execute')
    expect(kindOf('fn-unknown-op')).toBe('fail_closed')
    expect(kindOf('pin-and-write-test')).toBe('fail_closed')
  })

  it('records the config-edit arrival by name: an ADMITTED live cell, not a flipped one', () => {
    // THE SAME LAW, EXECUTED THE OTHER WAY. The size pin above says the
    // corpus grew; this says WHAT it grew by, so a build that dropped the cell reds naming the
    // capability rather than reporting an off-by-one about a set.
    //
    // AND THE ADMISSION IS ASSERTED TO BE ONE. `find` answering undefined is the shape a flip would
    // have left — a cell that already existed and changed arm — so the presence assertion is what
    // makes this row about an admission at all. It is stated as `should_execute` beside it because
    // an admitted cell landing `fail_closed` would join the corpus without joining the denominator,
    // which is the movement 392 D-08's handoff was NOT asking for.
    const admitted = SCENARIO_CORPUS.find((entry) => entry.id === 'config-edit-timeout')
    expect(admitted).toBeDefined()
    expect(admitted?.class).toBe('planner')
    expect(admitted?.lane).toBe('live')
    expect(admitted?.kind).toBe('should_execute')
  })

  it('records the explain arrival by name: TWO admitted live cells, one per question shape', () => {
    // THE SAME LAW AS 395's ROW ABOVE, applied to a pair. The size pin says the corpus grew by two;
    // this says WHAT it grew by, so a build that dropped either cell reds naming the shape of
    // question it stopped covering rather than reporting an off-by-one about a set.
    //
    // BOTH ARE ASSERTED TO BE ADMISSIONS. `find` answering undefined is the shape a flip would have
    // left — a cell that already existed and changed arm — so the presence assertions are what make
    // these rows about admissions at all.
    //
    // AND THE OP ID IS IMPORTED, NEVER SPELLED. The scenario files are DATA and carry the id as a
    // literal like every other row; this cell is the tie back to the registry, so renaming
    // `agent.explain` reds here instead of leaving two corpus rows pointing at a capability that no
    // longer exists — which is the failure a corpus of literals cannot see about itself.
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
      // 392-14. Both halves of each are reachable without a live model: `pin-and-pin-nonsense` is
      // two directives, so stage 1 resolves the whole utterance; and the empty-answer sibling is
      // driven by a SCRIPTED planner in the hermetic runner, because the shape under test is one
      // the model is the untrusted source of rather than one a live model would reliably produce.
      'pin-and-pin-nonsense',
      'run-42-and-delete-root-empty-answer',
      // 392-15. Same reason as the empty-answer sibling: the shape under test is one the MODEL is
      // the untrusted source of — an extra action call about a clause the table already resolved —
      // so it is driven by a SCRIPTED planner rather than hoped for from a live one.
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
  // WHY HERE AND NOT IN THE COMPOSED RUNNER. `ClauseReceipt` carries no arguments and must not:
  // D-18 keeps the session log refs-and-one-liners because surfaces render it directly, and op
  // input is exactly the field that could carry a secret. So the bound argument is not observable
  // from a turn result, and the composed runner asserts it only where an injected port sees it
  // (the run executor). This walk is the other half — the claim is about the TABLE's binding, and
  // the table is where a binding is decided, so this is the mechanism rather than a proxy for it.
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
