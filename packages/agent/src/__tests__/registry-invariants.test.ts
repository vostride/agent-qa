// The agent-side remainder of the retired 384 coverage stub.
//
// WHAT HAPPENED. `parity-coverage.test.ts` shipped in 384 as "conformance-suite LEG 1", a coverage
// leg written against the registry rather than a hand list, and it grew with the layer for six
// phases. 397 landed the full conformance & parity suite in `packages/cli/src/__tests__/
// conformance/`, and that suite carries the SAME universe: one scenario row per capability, asserted
// set-equal to the census in both directions. Two registers over one universe is precisely the
// divergence D-10 exists to close — so the stub retires, and this file is what could not travel.
//
// WHY A RETIREMENT NEEDS A REGISTER. Deleting a guard file and writing a paragraph about where its
// duty went is how assertions get silently dropped: the paragraph is unfalsifiable, and the file is
// gone. So the retirement is audited instead. Every describe block, every `it` block and every
// top-level constant and function of the pre-deletion file is enumerated below BY ITS VERBATIM NAME
// with a ruled destination and a one-line reason, the row count is pinned by a cell in this file
// against the census taken before the delete, and the ground truth for both is git history: the
// stub's last revision is addressable at the commit immediately preceding this one.
//
// THE PRE-DELETION BLOCK CENSUS, MEASURED 2026-08-16 (not counted by hand):
//
//     grep -c '^describe(' parity-coverage.test.ts                    ->  1
//     grep -c '^  it('     parity-coverage.test.ts                    ->  8
//     grep -cE '^(const|function|async function) ' parity-coverage…   -> 15
//                                                                    ----
//                                                                       24
//
// and `RETIREMENT_REGISTER` below holds 24 rows, one per block, checked mechanically by
// `pins the retirement register against the pre-deletion block census` further down. An equality
// nothing can check is an assertion rather than a check (the 394 lesson), so the register is DATA.
//
// THE COVERAGE CONTINUITY WAS MEASURED, NOT ASSERTED. Before the delete, one mutation was applied to
// the shipped registry — `runs.digest` renamed to `digest.runs`, i.e. a capability arriving in a
// domain nothing pins — and both sides were run. The stub reddened 5 of its 8 cells; the conformance
// suite reddened 16 of 80, including the domain census (`digest.runs`), the scenario census
// (`digest.runs`) and the golden ledger; and `declaration-immutability.test.ts` reddened the
// contract-projection cell with the identical message the stub's own copy produced. The destinations
// red on what the stub red on, which is the only form of "its duty is carried" worth writing down.
//
// ONE DUTY IS CARRIED IN A DELIBERATELY WEAKER FORM, AND IT IS NAMED RATHER THAN IMPLIED.
// `EXPECTED_BINDING_STATUS` pinned all 41 ids to a `bound`/`unbound` literal under THIS fixture's
// ports. Its op-universe half is the scenario table's job now, and its binding-column half is the
// golden ledger's `bindingStatusAtRoot` — but the ledger's column describes the CLI composition root
// (which binds all 41), not this fixture. So the per-op statuses under a partially-supplied
// composition are no longer pinned as a 41-row literal. What is kept here is the fact that literal
// existed to state: which capabilities these ports BIND. It is kept as a derived subset
// (`BOUND_OP_INPUTS`) rather than a census — a capability arriving unbound here needs no row, so
// this file cannot become the second denominator D-10 just closed.

import { readFileSync } from 'node:fs'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { UnknownFunctionError, invokeFunction } from '../functions/invoke.js'
import { createFunctionRegistry } from '../functions/registry.js'
import type { FunctionDeclaration, FunctionDeps } from '../functions/spec.js'
import { CONTRACTS_BY_ID } from './projection-relation.js'

// ---- The retirement register --------------------------------------------------

/** Where one block of the retired file went. A closed vocabulary: four rulings, no fifth. */
type RetirementDestination =
  /** Its universe or its content is now carried by the conformance scenario table. */
  | 'folded → scenario-table'
  /** The claim is re-stated in the conformance suite, derived off the census rather than moved. */
  | 're-derived → conformance leg'
  /** It needs in-package access, so it lives on in this file. */
  | 'retained here'
  /** Its natural home was already another agent-side file, which already carries it. */
  | 'retained → declaration-immutability'
  /** Its content is now a column of the committed golden ledger. */
  | 'folded → golden ledger'
  | 'retired → subject deleted'

interface RetirementRow {
  /** The block's name, VERBATIM as it read in the pre-deletion file. */
  readonly block: string
  readonly kind: 'describe' | 'it' | 'constant'
  readonly destination: RetirementDestination
  readonly reason: string
}

/**
 * Every block of `parity-coverage.test.ts`, with a ruled destination. 24 rows, one per block.
 *
 * NO ROW IS "dropped". If a duty is carried in a weaker form, the row says so in its reason — the
 * one thing this register may not do is let a deletion read as coverage.
 */
const RETIREMENT_REGISTER: readonly RetirementRow[] = Object.freeze([
  Object.freeze({
    block: 'parity leg 1 — registry coverage',
    kind: 'describe',
    destination: 're-derived → conformance leg',
    reason:
      'the leg itself: `conformance/parity.test.ts` is now the coverage leg, ranged over the roster '
      + 'and the census rather than over one package\'s registry',
  }),
  Object.freeze({
    block: 'registers a nonzero, uniquely-identified capability set',
    kind: 'it',
    destination: 'retained here',
    reason:
      'a registry-internal invariant (uniqueness and id order are properties of `list()`, not of '
      + 'any surface), and the conformance census asserts only the non-emptiness half',
  }),
  Object.freeze({
    block: 'names every capability dot-namespaced over the fixed domain taxonomy (D-15)',
    kind: 'it',
    destination: 're-derived → conformance leg',
    reason:
      'D-18: the taxonomy is now `conformance/domain-list.ts`, censused ids→list and list→ids with '
      + 'dated reserved markers; the grammar sweep travelled with it as `OP_ID_GRAMMAR`',
  }),
  Object.freeze({
    block: 'carries a complete declaration for every capability',
    kind: 'it',
    destination: 'retained here',
    reason:
      'BL-01/T-384-20: the per-field completeness sweep and the inert-projection checks read live '
      + 'registry internals, so they cannot leave `packages/agent`',
  }),
  Object.freeze({
    block: 'projects each contract FROM the schema it was declared with, naming no field',
    kind: 'it',
    destination: 'retained → declaration-immutability',
    reason:
      'it was already a verbatim duplicate of the cell of the same name in '
      + '`declaration-immutability.test.ts`; both reddened identically under the retirement '
      + 'mutation, so the delete removes a copy rather than a check',
  }),
  Object.freeze({
    block: 'pins the registered capability set and each id binding state',
    kind: 'it',
    destination: 'folded → scenario-table',
    reason:
      'its op-universe half IS the census (asserted both directions against the table); its binding '
      + 'column is the golden ledger\'s `bindingStatusAtRoot`; what this fixture binds is kept below '
      + 'as a derived subset rather than a 41-row literal (see the header note)',
  }),
  Object.freeze({
    block: 'holds an invocation sample for every registered id — no capability without one',
    kind: 'it',
    destination: 'folded → scenario-table',
    reason:
      'D-10: the scenario row IS the invocation sample, and the conformance suite asserts both the '
      + 'set equality and that every row still parses against its op\'s own contract',
  }),
  Object.freeze({
    block: 'resolves every BOUND capability into a value its declared output contract accepts',
    kind: 'it',
    destination: 'retained here',
    reason:
      'the output contracts live in `projection-relation.ts`, which the package does not export, '
      + 'and the conformance registry composes EMPTY deps — a bound op there reaches no port to '
      + 'return a parseable value from',
  }),
  Object.freeze({
    block: 'refuses every UNBOUND capability by name — covered, not missing (Pitfall 11)',
    kind: 'it',
    destination: 're-derived → conformance leg',
    reason:
      'the refusal is observable across the package boundary (`FunctionNotBoundError` is exported '
      + 'and carries `functionId`), so the cell re-derives there off the scenario table\'s inputs — '
      + 'which is what keeps the third state asserted without a second sample map',
  }),
  Object.freeze({
    block: 'ALLOWED_ID_DOMAINS',
    kind: 'constant',
    destination: 're-derived → conformance leg',
    reason:
      'D-18: became `CANONICAL_ID_DOMAINS` — 14 distinct domains with a charter apiece, the seven '
      + 'dated widening notes folded into one, and the 392 note\'s miscount corrected',
  }),
  Object.freeze({
    block: 'EXPECTED_BINDING_STATUS',
    kind: 'constant',
    destination: 'folded → golden ledger',
    reason:
      'the ledger publishes a binding status per op, READ off the composition root rather than '
      + 'spelled; the literal dies so that no second op→status table can disagree with it',
  }),
  Object.freeze({
    block: 'FIXTURE_RUN_ID',
    kind: 'constant',
    destination: 'retained here',
    reason: 'fixture identity for the retained dispatch leg',
  }),
  Object.freeze({
    block: 'FIXTURE_ENTITY_SHORT_ID',
    kind: 'constant',
    destination: 'retained here',
    reason: 'fixture identity for the retained dispatch leg',
  }),
  Object.freeze({
    block: 'FIXTURE_ENTITY_DESCRIPTOR',
    kind: 'constant',
    destination: 'retained here',
    reason:
      'the one entity this fixture directory knows: a REAL descriptor, because the dispatch leg '
      + 'parses `entities.get`\'s answer against its declared output contract',
  }),
  Object.freeze({
    block: 'INVOCATION_SAMPLES',
    kind: 'constant',
    destination: 'folded → scenario-table',
    reason:
      'every sample, and the per-op reasoning for its shape, moved into `SCENARIO_TABLE` in 397-03; '
      + '`BOUND_OP_INPUTS` below re-states only the ones this fixture can actually dispatch',
  }),
  Object.freeze({
    block: 'FIXED_CONTEXT',
    kind: 'constant',
    destination: 'retired → subject deleted',
    reason:
      'the fixture\'s execution context, never the ambient one — retained here until 432-39, which '
      + 'deleted the registry option it was handed to; no op decides in a context',
  }),
  Object.freeze({
    block: 'handoff',
    kind: 'constant',
    destination: 'retained here',
    reason: 'the completed-run document the fake runs port serves',
  }),
  Object.freeze({
    block: 'fakeDeps',
    kind: 'constant',
    destination: 'retained here',
    reason:
      'the whole reason this file exists on the agent side: a composition where every port resolves, '
      + 'which the conformance suite deliberately does not have',
  }),
  Object.freeze({
    block: 'FULLY_GRANTED',
    kind: 'constant',
    destination: 'retained here',
    reason:
      'a human-origin caller, so a refusal here can never be a missing grant wearing a binding '
      + 'refusal\'s clothes; 432-39 deleted the scope set it once derived off the scope union',
  }),
  Object.freeze({
    block: 'noOpSink',
    kind: 'constant',
    destination: 'retired → subject deleted',
    reason:
      'retained here until 441-28, which deleted the registry\'s audit-sink requirement it existed '
      + 'to satisfy (D-15); this file asserts on coverage, never on an audit trail',
  }),
  Object.freeze({
    block: 'EVERY_ASK_STANDING_APPROVED',
    kind: 'constant',
    destination: 'retired → subject deleted',
    reason:
      'retained here until 432-13 (without it an ask-tier capability was refused at the GATE '
      + 'before the binding check); the op gate is gone, so the dispatch leg reaches the binding '
      + 'check directly and the control has nothing left to control',
  }),
  Object.freeze({
    block: 'registry',
    kind: 'constant',
    destination: 'retained here',
    reason: 'the composed fixture registry',
  }),
  Object.freeze({
    block: 'declarations',
    kind: 'constant',
    destination: 'retained here',
    reason: 'the fixture\'s listing, taken through the fully-granted caller',
  }),
  Object.freeze({
    block: 'drain',
    kind: 'constant',
    destination: 'retained here',
    reason: 'a stream result collected into elements, so each is re-parsed against its contract',
  }),
] as const satisfies readonly RetirementRow[])

/**
 * The block census taken on the pre-deletion file, spelled as its three parts.
 *
 * SPELLED AS THE THREE GREPS rather than as `24`, so the equality below is auditable against git
 * history one kind at a time: whoever re-runs the three commands on the parent commit gets these
 * three numbers, and the register has to match each of them, not merely their sum.
 */
const PRE_RETIREMENT_BLOCK_CENSUS = Object.freeze({ describe: 1, it: 8, constant: 15 })

// ---- The retained fixture (verbatim from the stub, imports adjusted) ---------------------------

const FIXTURE_RUN_ID = 'run-alpha'

const FIXTURE_ENTITY_SHORT_ID = 'MEM-001'

/**
 * The one entity this fixture directory knows about.
 *
 * A REAL descriptor rather than a refusing stub, because the dispatch leg below calls every bound
 * capability and parses the answer against its declared output contract — so a port that refused
 * would make `entities.get` uncallable in the file that exists to check exactly that.
 */
const FIXTURE_ENTITY_DESCRIPTOR = {
  kind: 'MEM' as const,
  shortId: FIXTURE_ENTITY_SHORT_ID,
  uri: 'agentqa://memory/MEM-001',
  machineId: 'bundle-fixture',
  title: 'a fixture memory record',
  statusSource: 'active',
}

/**
 * A valid input for every capability THESE PORTS BIND — and deliberately for no other.
 *
 * NOT A CENSUS, AND THAT IS THE POINT. The retired file keyed a sample by every one of the 41
 * ids and asserted exact set equality against the registry, which made it a second denominator over
 * the op universe. This map is keyed by the ids this fixture can actually DISPATCH; the cell below
 * derives that set off the live listing and asserts the keys equal it, so the map cannot drift and
 * cannot silently become a register. A capability landing unbound here needs no row — its scenario
 * row in `conformance/scenario-table.ts` is the one place that obligation lives now.
 *
 * The inputs themselves are the stub's, unchanged: a well-formed document per op that names nothing
 * in any fixture, because `invokeFunction` validates input before it consults binding.
 */
const BOUND_OP_INPUTS: Readonly<Record<string, unknown>> = {
  'config.get': {},
  'entities.get': { ref: FIXTURE_ENTITY_SHORT_ID },
  'entities.resolve': { ref: 'nothing in this fixture is called this' },
  'knowledge.brief.why': { runId: FIXTURE_RUN_ID, stepIndex: 0 },
  'knowledge.bundles.list': {},
  // this fixture binds the optional reader and supplies its dispatch input.
  'knowledge.gates.list': { recordId: 'rec-not-in-this-fixture' },
  'knowledge.record.show': { recordId: 'rec-not-in-this-fixture' },
  'knowledge.records.diff': { sinceOrdinal: 0 },
  'knowledge.records.inspect': { filter: {} },
  // bound under these ports because the digest no longer needs the proposals
  // inbox; its substrate is the REQUIRED runs port, and the mark ledger it reads is optional.
  'runs.digest': { runId: FIXTURE_RUN_ID },
  'runs.events': { runId: FIXTURE_RUN_ID },
  'runs.get': { runId: FIXTURE_RUN_ID },
  // bound under these ports because its substrate is the REQUIRED runs port — it
  // declares no optional-dep binding key at all, so there is no composition that lists it and
  // cannot run it.
  'runs.knowledge': { runId: FIXTURE_RUN_ID },
  'runs.list': {},
}

function handoff(runId: string): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 7,
    executionContext: 'local-headless',
    aggregateVerdict: 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: 1_000,
    endedAt: 2_000,
    tests: [],
  }
}

/**
 * Fully-faked dependencies: every port resolves, nothing reaches a host API.
 *
 * The point of faking ALL of them is that a `bound` op which quietly needed something the ports do
 * not offer would fail here rather than in whichever composition root first tried to run it. The
 * conformance suite composes EMPTY deps on purpose (it asks listing questions), which is why this
 * fixture could not travel with the rest of the stub.
 */
function fakeDeps(): FunctionDeps {
  const documents = [handoff(FIXTURE_RUN_ID)]
  return {
    secretMask: (text: string) => text,
    runs: {
      list: () => Promise.resolve(documents),
      get: runId => Promise.resolve(documents.find(document => document.runId === runId)),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      gateReceipts: ({ candidateId }) => Promise.resolve({
        kind: 'not-found' as const, recordId: candidateId,
      }),
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      // Free text against an empty directory: the none arm, which is what the sample above asks for
      // and what the never-guess contract requires.
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: (ref: string) => Promise.resolve(
        ref === FIXTURE_ENTITY_SHORT_ID ? FIXTURE_ENTITY_DESCRIPTOR : undefined,
      ),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
  }
}

/**
 * A caller no refusal here can be about, so a refusal can never be a missing grant.
 *
 * Until 432-39 it held every scope, derived from the scope union rather than listed. The
 * union and the caller's scope set are deleted, so nothing is left to hold;
 * `origin` is `human` for the same reason on the second axis.
 */
const FULLY_GRANTED: FunctionCaller = {
  surface: 'conformance',
  origin: 'human',
}

function registry() {
  return createFunctionRegistry({
    deps: fakeDeps(),
  })
}

function declarations(): readonly FunctionDeclaration[] {
  return registry().list(FULLY_GRANTED)
}

async function drain(result: unknown): Promise<unknown> {
  if (typeof result === 'object' && result !== null && Symbol.asyncIterator in result) {
    const collected: unknown[] = []
    for await (const element of result as AsyncIterable<unknown>) {
      collected.push(element)
    }
    return collected
  }
  return result
}

describe('the coverage stub retires with a destination for every block', () => {
  it('pins the retirement register against the pre-deletion block census', () => {
    // T-397-19, and the 394 lesson made mechanical: an equality nobody can re-derive is an
    // assertion, not a check. The three numbers are the three greps quoted in this file's header,
    // run against the stub at the commit immediately before its deletion — so this cell is
    // falsifiable by anyone with the repository, which is the property a register needs.
    const byKind = { describe: 0, it: 0, constant: 0 }
    for (const row of RETIREMENT_REGISTER) byKind[row.kind] += 1

    expect(byKind, 'the register does not account for the pre-deletion file block for block')
      .toEqual(PRE_RETIREMENT_BLOCK_CENSUS)
    expect(RETIREMENT_REGISTER.length, 'the register total must equal the census total').toBe(
      PRE_RETIREMENT_BLOCK_CENSUS.describe
      + PRE_RETIREMENT_BLOCK_CENSUS.it
      + PRE_RETIREMENT_BLOCK_CENSUS.constant,
    )

    // No block is named twice — two rows for one block would let the count come out right while a
    // block went unaccounted for, which is the exact shape of the arithmetic error 397-05 found in
    // an inherited count sentence.
    const names = RETIREMENT_REGISTER.map((row) => row.block)
    expect([...new Set(names)].length, 'the register names a block twice').toBe(names.length)

    // Every row rules a destination and states a reason. "Dropped" is not in the vocabulary: a duty
    // carried in a weaker form says so in its reason (the binding-status row does).
    for (const row of RETIREMENT_REGISTER) {
      expect(row.block.trim(), 'a register row names no block').not.toBe('')
      expect(row.reason.trim(), `${row.block}: the row rules a destination and gives no reason`)
        .not.toBe('')
    }
  })

  it('carries every retained block: what the register says stays here, is here', () => {
    // The register is checkable in one more direction than its own arithmetic. Every row ruled
    // `retained here` names something this file must actually contain — and a `retained here` row
    // whose subject was quietly not brought across is precisely the silent drop the register exists
    // to make impossible. The file reads ITSELF rather than a list of names written twice.
    const source = readFileSync(new URL(import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('] as const satisfies readonly RetirementRow[])'))

    for (const row of RETIREMENT_REGISTER) {
      if (row.destination !== 'retained here') continue
      expect(body, `${row.block}: ruled 'retained here' and absent from this file's body`)
        .toContain(row.block)
    }
    // …and the sweep is not vacuous: a block ruled elsewhere is NOT found here. The name is
    // assembled from fragments on `parity.test.ts`'s precedent and for its reason — the sweep reads
    // this very file, so a control written out whole is the sweep finding its own control. Measured:
    // it did, the first time this cell ran.
    const foldedAway = ['INVOCATION', 'SAMPLES'].join('_')
    expect(body, `the retained-block sweep matches anything, including ${foldedAway}`)
      .not.toContain(foldedAway)
  })
})

describe('registry invariants that need in-package access', () => {
  it('registers a nonzero, uniquely-identified capability set', () => {
    const ids = declarations().map(declaration => declaration.id)

    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toEqual(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('carries a complete declaration for every capability', () => {
    for (const declaration of declarations()) {
      const label = declaration.id
      expect(declaration.summary.trim(), label).not.toEqual('')
      // no scope column — a declaration carries no permission metadata.
      expect(Object.keys(declaration), label).not.toContain('requiredScopes')
      expect(Object.keys(declaration), label).not.toContain('requiresHumanOrigin')
      expect(['unary', 'stream'], label).toContain(declaration.resultKind)
      expect(['bound', 'unbound'], label).toContain(declaration.bindingStatus)
      expect(declaration.risk.name, label).toEqual(`fn:${declaration.id}`)
      expect(declaration.risk.recognized, label).toBe(true)
      // The declared contracts arrive as INERT projections, never as live validators (BL-01 /
      // D-14): a listing is a description of the contract, not a handle on it.
      for (const side of ['input', 'output'] as const) {
        const projection = declaration[side]
        expect(typeof projection, `${label}.${side}`).toEqual('object')
        expect(projection, `${label}.${side}`).not.toBeNull()
        expect((projection as Record<string, unknown>)['safeParse'], `${label}.${side}`)
          .toBeUndefined()
        expect((projection as Record<string, unknown>)['parse'], `${label}.${side}`)
          .toBeUndefined()
      }
      // A listing view never carries the implementation.
      expect(declaration, label).not.toHaveProperty('invoke')
    }
  })

  it('binds, under these ports, exactly the capabilities that hold a dispatch input here', () => {
    // The half of `EXPECTED_BINDING_STATUS` that had nowhere else to go, kept DERIVED. The bound set
    // is read off the live listing; the input map's keys must equal it. Two failures, both useful: a
    // capability that starts binding under these ports without a stated input (the growth seam the
    // stub's sample map held for the whole universe, narrowed to the ops that can actually run), and
    // an input left behind for an op that no longer binds.
    const bound = declarations()
      .filter(declaration => declaration.bindingStatus === 'bound')
      .map(declaration => declaration.id)
      .sort()

    expect(bound.length, 'this fixture binds nothing, so the dispatch leg would certify nothing')
      .toBeGreaterThan(0)
    expect(
      Object.keys(BOUND_OP_INPUTS).sort(),
      'the ports this fixture supplies bind a capability with no dispatch input stated here — add '
        + 'one, or say why the port set should stop binding it',
    ).toEqual(bound)

    // …and the set is a SUBSET of the census rather than a copy of it: this file is not a second
    // denominator over the op universe. A fixture binding everything would make it one.
    expect(bound.length, 'this fixture binds the entire census, which would make it a second register')
      .toBeLessThan(declarations().length)
  })

  it('resolves every BOUND capability into a value its declared output contract accepts', async () => {
    // A RELATION between the result and the contract the registry already holds, never an id-keyed
    // table of expected values: the declared output schema must PARSE what came back. The gate this
    // replaced asserted mere defined-ness, which `null`, `[]`, `{}`, `0` and `''` all satisfy.
    const built = registry()

    let checked = 0
    for (const declaration of built.list(FULLY_GRANTED)) {
      if (declaration.bindingStatus !== 'bound') continue

      const contract = CONTRACTS_BY_ID[declaration.id]!
      const drained = await drain(
        await invokeFunction(built, declaration.id, BOUND_OP_INPUTS[declaration.id], FULLY_GRANTED),
      )

      if (declaration.resultKind === 'stream') {
        // A stream spec's output contract describes the ELEMENT, so every drained element is
        // re-parsed. The array assertion makes an empty drain a visible, deliberate pass rather
        // than a silently skipped loop.
        expect(Array.isArray(drained), declaration.id).toBe(true)
        const elements = drained as readonly unknown[]
        for (let index = 0; index < elements.length; index++) {
          expect(contract.output.safeParse(elements[index]).success, `${declaration.id}[${index}]`)
            .toBe(true)
        }
      } else {
        expect(contract.output.safeParse(drained).success, declaration.id).toBe(true)
      }
      checked += 1
    }

    // …and the loop ran: a `bound` set that emptied would otherwise pass every line above.
    expect(checked).toBeGreaterThan(0)
  })
})

// the proposal inbox's four verbs, the two apply ops and the
// config undo op are deleted with the inbox. No alias, hidden inbox or accept/reject follow-up
// survives: each retired id is simply not a capability, so every door refuses it as an unknown
// function before any dependency is consulted.
const RETIRED_PROPOSAL_OP_IDS = [
  'proposals.list',
  'proposals.show',
  'proposals.accept',
  'proposals.reject',
  'knowledge.proposal.apply',
  'config.proposal.apply',
  'config.undo.propose',
] as const

describe('the proposal, apply and undo ops are not capabilities', () => {
  it('the registry lists none of the seven retired ids and no proposals domain', () => {
    const ids = declarations().map(declaration => declaration.id)
    expect(ids.length, 'the listing is empty, so the absence below would be vacuous').toBeGreaterThan(0)
    expect(RETIRED_PROPOSAL_OP_IDS.filter(id => ids.includes(id)), 'a retired proposal op is registered')
      .toEqual([])
    expect(ids.filter(id => id.startsWith('proposals.')), 'the proposals domain is still registered').toEqual([])
    // The direct ops that replaced them are registered.
    for (const id of ['knowledge.accept', 'knowledge.reject', 'knowledge.forget', 'config.field.set']) {
      expect(ids, id).toContain(id)
    }
  })

  it('invoking a retired id is refused as an unknown function', async () => {
    const built = registry()
    for (const id of RETIRED_PROPOSAL_OP_IDS) {
      const refused = await invokeFunction(built, id, {}, FULLY_GRANTED).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(refused, `${id} dispatched`).toBeInstanceOf(UnknownFunctionError)
    }
  })
})

// `grants.list` and `grants.revoke` are deleted with the
// standing-grant ledger they read and wrote. No grant domain survives, no other op takes over the
// revoke, and every door refuses both ids as unknown functions before any dependency is consulted.
const RETIRED_GRANT_OP_IDS = ['grants.list', 'grants.revoke'] as const

describe('the standing-grant ops are not capabilities', () => {
  it('the registry lists neither grant op and no grants domain', () => {
    const ids = declarations().map(declaration => declaration.id)
    expect(ids.length, 'the listing is empty, so the absence below would be vacuous').toBeGreaterThan(0)
    expect(RETIRED_GRANT_OP_IDS.filter(id => ids.includes(id)), 'a retired grant op is registered').toEqual([])
    expect(ids.filter(id => id.startsWith('grants.')), 'the grants domain is still registered').toEqual([])
    expect(
      declarations().filter(declaration => /grant/i.test(declaration.risk.name)).map(declaration => declaration.id),
      'an op still declares a grant-shaped action class',
    ).toEqual([])
  })

  it('invoking a retired grant id is refused as an unknown function', async () => {
    const built = registry()
    for (const id of RETIRED_GRANT_OP_IDS) {
      for (const input of [{}, { grantId: 'grant_0123456789abcdef' }]) {
        const refused = await invokeFunction(built, id, input, FULLY_GRANTED).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(refused, `${id} dispatched`).toBeInstanceOf(UnknownFunctionError)
      }
    }
  })
})
