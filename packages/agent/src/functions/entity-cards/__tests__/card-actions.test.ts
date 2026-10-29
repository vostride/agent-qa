// `actions[]` are registry op refs, and both ops are one projection (Phase 387 plan 07, D-11).
//
// Two claims, and neither is a shape check.
//
// D-11's claim is that a card can only advertise what the REGISTRY contains. So the assertion
// resolves every advertised id against a registry built from the DEFAULT spec list — the same
// list every composition registers — rather than against a list this file maintains. A test
// that compared the action table to its own expected array would be true by construction and
// would stay green through the exact drift D-11 exists to prevent.
//
// ENTY-02's claim is that `entities.resolve` and `entities.get` are projections of the SAME
// value. So the assertion runs both real ops over one descriptor through one deps record and
// compares the cards deeply. Comparing two hand-built cards, or comparing each op's card to an
// expected literal, would pass for two independent renderers that happen to agree today.

import {
  ENTITY_KINDS,
  ENTITY_URI_SEGMENTS,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type {
  EntityCard,
  EntityCardResolution,
  EntityDescriptor,
  EntityKind,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ADVERTISED_FUNCTION_IDS, actionsForKind } from '../actions.js'
import { entitiesGetSpec } from '../../ops/entities-get.js'
import { entitiesResolveSpec } from '../../ops/entities-resolve.js'
import { createFunctionRegistry } from '../../registry.js'
import type { FunctionDeps } from '../../spec.js'

const SHORT_IDS = {
  TST: 'TST-001',
  RUN: 'RUN-002',
  MEM: 'MEM-004',
  POL: 'POL-005',
  TGT: 'TGT-checkout',
} as const satisfies Record<EntityKind, string>

function descriptorFor(kind: EntityKind): EntityDescriptor {
  return {
    kind,
    shortId: SHORT_IDS[kind],
    uri: `agentqa://${ENTITY_URI_SEGMENTS[kind]}/${SHORT_IDS[kind]}`,
    machineId: `machine-${kind.toLowerCase()}`,
    title: `The ${kind} entity`,
    statusSource: kind === 'MEM' ? 'active' : kind === 'RUN' ? 'passed' : 'active',
  } as EntityDescriptor
}

const MEM_DESCRIPTOR = descriptorFor('MEM')

// 2026-10-02 (432-36, D-12): no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither (432-20), so every caller lists the whole default registry.
const FULL_CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

// 2026-10-02 (432-36, D-12): a deliberate smuggle. The retired `safeMode: true` rides past the type
// so the safe-mode cell below keeps proving the listing does not read it; the cast keeps this
// witness compiling once the field is deleted (432-39).
const SAFE_CALLER = { ...FULL_CALLER, safeMode: true } as FunctionCaller

function deps(): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve({
        kind: 'not-found' as const,
        schemaVersion: 2 as const,
        recordId,
      }),
    },
    entities: {
      resolve: (ref) => Promise.resolve(
        ref === MEM_DESCRIPTOR.shortId
          ? { kind: 'resolved' as const, descriptor: MEM_DESCRIPTOR, score: 1 }
          : { kind: 'none' as const, reason: 'no-match' as const },
      ),
      get: (ref) => Promise.resolve(ref === MEM_DESCRIPTOR.shortId ? MEM_DESCRIPTOR : undefined),
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

/** The ids the DEFAULT registry actually contains, read off a real listing. */
function defaultRegistryIds(caller: FunctionCaller = FULL_CALLER): Set<string> {
  const registry = createFunctionRegistry({
    deps: deps(),
    // 2026-10-02 (432-36, D-12): no `resolveExecutionContext` registry option; the registry reads
    // no context (432-20).
  })
  return new Set(registry.list(caller).map((declaration) => declaration.id))
}

// ---- Test 1: every advertised action resolves in the default registry (D-11) --------------

describe('cards advertise only what the registry contains', () => {
  it('resolves every id every kind can advertise, against the DEFAULT spec list', () => {
    const registryIds = defaultRegistryIds()
    // Non-vacuity first: an empty listing would satisfy nothing below by containing nothing,
    // and an empty action set would satisfy it by advertising nothing.
    expect(registryIds.size).toBeGreaterThan(0)

    let asserted = 0
    for (const kind of ENTITY_KINDS) {
      for (const action of actionsForKind(descriptorFor(kind))) {
        expect(registryIds.has(action.functionId), `${kind} → ${action.functionId}`).toBe(true)
        asserted += 1
      }
    }
    // The count is pinned so a table that quietly stopped advertising cannot pass by
    // iterating nothing: 5 kinds, one `Open card` each, plus 1 TST, 2 RUN, 2 MEM
    // (387-08 completes the MEM row with `knowledge.forget.propose` — D-11's table completion).
    expect(asserted).toBe(10)

    // …and the declared id set is exactly what the tables can produce, so a new action whose
    // id is never asserted above cannot slip in.
    const fromTables = new Set(
      ENTITY_KINDS.flatMap((kind) => actionsForKind(descriptorFor(kind))
        .map((action) => action.functionId)),
    )
    expect([...fromTables].sort()).toEqual([...ADVERTISED_FUNCTION_IDS].sort())
  })

  it('is shaped {functionId, label, inputSeed} with the entity\'s OWN refs, never a literal', () => {
    for (const kind of ENTITY_KINDS) {
      const descriptor = descriptorFor(kind)
      for (const action of actionsForKind(descriptor)) {
        expect(Object.keys(action).sort(), kind).toEqual(['functionId', 'inputSeed', 'label'])
        expect(action.label.length, kind).toBeGreaterThan(0)
        // Every seed names this entity — by short-ID or by machine id. A seed that named
        // neither would be an action about some other entity.
        const seeded = JSON.stringify(action.inputSeed)
        expect(
          seeded.includes(descriptor.shortId) || seeded.includes(descriptor.machineId),
          `${kind} → ${action.functionId}: ${seeded}`,
        ).toBe(true)
      }
    }
  })

  it('advertises at least one action for every kind, so a table that advertises nothing cannot pass', () => {
    // The surviving positive control from the deleted reserved-family cell: no filter, so a
    // table that answered with an empty array for ANY kind reds here by name.
    for (const kind of ENTITY_KINDS) {
      expect(actionsForKind(descriptorFor(kind)).length, kind).toBeGreaterThan(0)
    }
  })

  // RE-SPELLED 2026-10-01 (432-20, D-12): the registry's safe-mode filter is deleted, so the listing
  // no longer hides `runs.start` from anyone. The claim that survives: the card decides nothing
  // about callers, and the listing it is checked against is the same for every caller.
  it('leaves the safe-mode decision to the LISTING, not to the card', () => {
    const safe = defaultRegistryIds(SAFE_CALLER)
    const full = defaultRegistryIds(FULL_CALLER)
    expect(full.has('runs.start')).toBe(true)
    expect(safe).toEqual(full)
    expect(actionsForKind(descriptorFor('TST')).map((action) => action.functionId))
      .toContain('runs.start')
  })
})

// ---- Test 3: the two ops are projections of ONE value (ENTY-02) ---------------------------

describe('entities.resolve and entities.get render through the ONE producer', () => {
  it('answers the same entity with deeply equal cards', async () => {
    const shared = deps()
    const resolved = await entitiesResolveSpec.invoke(
      { ref: MEM_DESCRIPTOR.shortId },
      shared,
    ) as EntityCardResolution
    const got = await entitiesGetSpec.invoke({ ref: MEM_DESCRIPTOR.shortId }, shared) as EntityCard

    expect(resolved.kind).toBe('resolved')
    if (resolved.kind !== 'resolved') return
    expect(resolved.card).toEqual(got)
    // Non-vacuity: an empty card would satisfy a deep-equality check against another empty
    // card. These are the fields the claim is about.
    expect(got.actions.length).toBeGreaterThan(0)
    expect(got.keyFacts.length).toBeGreaterThan(0)
    expect(got.id).toBe(MEM_DESCRIPTOR.shortId)
  })

  it('renders every candidate of a disambiguation through the same producer too', async () => {
    const second: EntityDescriptor = { ...MEM_DESCRIPTOR, shortId: 'MEM-005', uri: 'agentqa://memory/MEM-005' }
    const shared: FunctionDeps = {
      ...deps(),
      entities: {
        resolve: () => Promise.resolve({
          kind: 'ambiguous' as const,
          candidates: [
            { descriptor: MEM_DESCRIPTOR, score: 0.9 },
            { descriptor: second, score: 0.8 },
          ],
        }),
        get: (ref) => Promise.resolve(
          ref === second.shortId ? second : ref === MEM_DESCRIPTOR.shortId ? MEM_DESCRIPTOR : undefined,
        ),
      },
    }

    const ambiguous = await entitiesResolveSpec.invoke({ ref: 'cart' }, shared) as EntityCardResolution
    expect(ambiguous.kind).toBe('ambiguous')
    if (ambiguous.kind !== 'ambiguous') return
    for (const candidate of ambiguous.candidates) {
      const direct = await entitiesGetSpec.invoke({ ref: candidate.card.id }, shared) as EntityCard
      expect(candidate.card, candidate.card.id).toEqual(direct)
    }
  })

  it('constructs no card literal in either op file', () => {
    // The one-producer claim is about the TYPE GRAPH, and this is its source half: neither op
    // may name the card schema's construction path. `produceEntityCard` is the only import
    // either file has into the card vocabulary.
    for (const file of ['entities-get.ts', 'entities-resolve.ts']) {
      const source = readOpSource(file)
      expect(countOccurrences(source, 'produceEntityCard('), file).toBeGreaterThan(0)
      expect(countOccurrences(source, 'keyFacts'), file).toBe(0)
      expect(countOccurrences(source, 'actions:'), file).toBe(0)
      expect(countOccurrences(source, 'EntityCardSchema.parse'), file).toBe(0)
    }

    // POSITIVE CONTROL: the scan catches a planted card literal. Without this the three
    // zero-counts above are satisfied by a scanner reading the wrong file.
    const planted = 'const card = { keyFacts: [], actions: [] }\n'
    expect(countOccurrences(planted, 'keyFacts')).toBe(1)
    expect(countOccurrences(planted, 'actions:')).toBe(1)
  })
})

function readOpSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../ops/${file}`, import.meta.url)), 'utf8')
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}
