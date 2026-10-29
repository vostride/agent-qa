// Tier (b) and tier (c) of the never-guess resolver (Phase 387, D-05 / D-07 / ENTY-01/02).
//
// Every case below runs the REAL pipeline — `lexicalLeg` and `denseLeg` over a real entity
// index, fused by `fuseWeightedRrf`. The only thing faked is the embedder, which is a fixed set
// of unit vectors: no model runtime, no acquisition ladder, no network, and two runs of the
// same corpus produce byte-identical rankings.

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  formatEntityUri,
  type EntityDescriptor,
  type EntityKind,
  type EntityResolution,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openAddressingLedger, type AddressingLedger } from '../../addressing/ledger.js'
import {
  embedPendingEntities,
  openEntityIndex,
  refreshEntity,
  type EntityIndexHandle,
} from '../../entity-index/entity-index.js'
import type { EmbedderPort } from '../../embedder-port.js'
import { C_RRF } from '../../retrieval/constants.js'
import {
  RESOLVER_CANDIDATE_K,
  RESOLVER_FUSED_SCORE_NORMALIZER,
  RESOLVER_LEG_WEIGHT_DENSE,
  RESOLVER_LEG_WEIGHT_LEXICAL,
  RESOLVER_LEXICAL_MIN_BM25,
  RESOLVER_STRONG_HIT_MARGIN,
  RESOLVER_STRONG_HIT_MIN_SCORE,
} from '../constants.js'
import { resolveHybrid, type ResolveHybridDeps } from '../hybrid.js'
import {
  resolveEntityRef,
  type EntitySighting,
  type EntitySightingSource,
} from '../resolve.js'

const DIM = DEFAULT_EMBEDDING_PROFILE.dim

function entity(
  shortId: string,
  title: string,
  kind: EntityKind = 'TST',
): EntityDescriptor {
  return {
    kind,
    shortId,
    uri: formatEntityUri(kind, shortId),
    machineId: `m_${shortId.toLowerCase().replaceAll('-', '_')}`,
    title,
    statusSource: 'active',
  }
}

/** A unit vector built from weighted axes, so cosine similarity is exactly controllable. */
function unit(axes: Record<number, number>): Float32Array {
  const vector = new Float32Array(DIM)
  let norm = 0
  for (const [axis, weight] of Object.entries(axes)) {
    vector[Number(axis)] = weight
    norm += weight * weight
  }
  const length = Math.sqrt(norm)
  for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / length
  return vector
}

function embedderFor(vectors: ReadonlyMap<string, Float32Array>): EmbedderPort {
  const lookup = async (text: string): Promise<Float32Array> => {
    const found = vectors.get(text)
    if (found === undefined) throw new Error(`no fixture vector for ${JSON.stringify(text)}`)
    return found
  }
  return { embedDocument: lookup, embedQuery: lookup }
}

interface Corpus {
  handle: EntityIndexHandle
  deps: (overrides?: Partial<ResolveHybridDeps>) => ResolveHybridDeps
}

async function seedCorpus(
  root: string,
  entities: readonly EntityDescriptor[],
  /** Rendering text -> vector. An empty map means "no vectors at all": the lexical-only floor. */
  vectors: ReadonlyMap<string, Float32Array>,
  name = 'index',
): Promise<Corpus> {
  const handle = openEntityIndex({ path: join(root, `${name}.db`) })
  for (const descriptor of entities) refreshEntity(handle, descriptor)
  if (vectors.size > 0) await embedPendingEntities(handle, embedderFor(vectors))

  const byShortId = new Map(entities.map((descriptor) => [descriptor.shortId, descriptor]))
  return {
    handle,
    deps: (overrides = {}) => ({
      index: handle,
      describe: (shortId: string) => byShortId.get(shortId),
      ...(vectors.size > 0 ? { embedder: embedderFor(vectors) } : {}),
      ...overrides,
    }),
  }
}

function scoresOf(resolution: EntityResolution): number[] {
  if (resolution.kind === 'resolved') return [resolution.score]
  if (resolution.kind === 'ambiguous') return resolution.candidates.map(({ score }) => score)
  return []
}

function idsOf(resolution: EntityResolution): string[] {
  if (resolution.kind === 'resolved') return [resolution.descriptor.shortId]
  if (resolution.kind === 'ambiguous') {
    return resolution.candidates.map(({ descriptor }) => descriptor.shortId)
  }
  return []
}

describe('the strong-hit rule: absolute threshold plus margin over the runner-up', () => {
  let root: string
  let corpora: EntityIndexHandle[]

  beforeEach(() => {
    root = join(tmpdir(), `resolver-hybrid-${randomUUID()}`)
    corpora = []
  })

  afterEach(() => {
    for (const handle of corpora) handle.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function corpus(
    entities: readonly EntityDescriptor[],
    vectors: ReadonlyMap<string, Float32Array>,
    name?: string,
  ): Promise<Corpus> {
    const seeded = await seedCorpus(root, entities, vectors, name)
    corpora.push(seeded.handle)
    return seeded
  }

  it('resolves when one entity leads both legs and the runner-up leads neither', async () => {
    const entities = [
      entity('TST-001', 'Buy a hat and pay at the checkout'),
      entity('TST-002', 'Sign in with a saved password'),
      entity('POL-001', 'Never reuse a credential in a run', 'POL'),
    ]
    // Only TST-002 carries the query's words, so it leads the lexical leg alone. POL-001 is
    // dense-only evidence — near in meaning, absent from the text — which is exactly the
    // runner-up shape a strong hit has to beat by more than the margin.
    const seeded = await corpus(entities, new Map([
      ['test Buy a hat and pay at the checkout', unit({ 0: 1 })],
      ['test Sign in with a saved password', unit({ 1: 1 })],
      ['policy Never reuse a credential in a run', unit({ 1: 0.6, 2: 0.8 })],
      ['saved password', unit({ 1: 1 })],
    ]))

    const resolution = await resolveHybrid('saved password', seeded.deps())

    expect(resolution.kind).toBe('resolved')
    expect(idsOf(resolution)).toEqual(['TST-002'])
    // Both legs first: the top of the agreement scale.
    expect(scoresOf(resolution)[0]).toBeCloseTo(1, 10)
  })

  it('always disambiguates two entities of equal strength, never resolves one', async () => {
    const entities = [
      entity('TST-010', 'Checkout with a saved card'),
      entity('TST-011', 'Checkout with a stored card'),
    ]
    // The legs DISAGREE about which near-twin is closer: lexical prefers TST-010 (it carries
    // the query's `saved`), the dense leg prefers TST-011. Ranks 1/2 and 2/1 fuse to exactly
    // the same number, which is the equal-strength case D-07 says must always disambiguate.
    const seeded = await corpus(entities, new Map([
      ['test Checkout with a saved card', unit({ 0: 0.9, 1: 0.435889894354067 })],
      ['test Checkout with a stored card', unit({ 0: 1 })],
      ['checkout with a saved card', unit({ 0: 1 })],
    ]))

    const resolution = await resolveHybrid('checkout with a saved card', seeded.deps())

    expect(resolution.kind).toBe('ambiguous')
    const scores = scoresOf(resolution)
    expect(scores[0]).toBe(scores[1])
    expect(idsOf(resolution)).toEqual(['TST-010', 'TST-011'])
  })

  it('refuses when the surviving top hit is below the absolute threshold', async () => {
    const entities = [
      entity('TST-020', 'The ghost checkout experiment'),
      entity('TST-021', 'The surviving checkout experiment'),
    ]
    const seeded = await corpus(entities, new Map())

    // TST-020 heads the lexical leg but its owning store has forgotten it, so it is dropped
    // after fusion. The survivor behind it must not inherit the confidence of the leader.
    const resolution = await resolveHybrid('ghost checkout experiment', seeded.deps({
      describe: (shortId) => (
        shortId === 'TST-021' ? entities[1] : undefined
      ),
    }))

    expect(resolution).toEqual({
      kind: 'none',
      reason: 'no-match',
      closestSuggestion: 'TST-021',
    })
  })

  it('offers at most three candidates, score-descending with ties broken by short-ID', async () => {
    const entities = [
      entity('TST-031', 'A checkout experiment'),
      entity('TST-030', 'A checkout experiment'),
      entity('TST-033', 'A checkout experiment'),
      entity('TST-032', 'A checkout experiment'),
    ]
    // Four identical renderings: every leg score ties, so ONLY the short-ID tie-break decides
    // the order. Nothing here can pass by accident on a corpus where the scores differ.
    const seeded = await corpus(entities, new Map())

    const first = await resolveHybrid('a checkout experiment', seeded.deps())
    const second = await resolveHybrid('a checkout experiment', seeded.deps())

    expect(first.kind).toBe('ambiguous')
    expect(idsOf(first)).toEqual(['TST-030', 'TST-031', 'TST-032'])
    expect(second).toEqual(first)
    const scores = scoresOf(first)
    expect([...scores].sort((left, right) => right - left)).toEqual(scores)
  })

  it('degrades in one direction only: the floor never resolves a different entity', async () => {
    const entities = [
      entity('TST-001', 'Buy a hat and pay at the checkout'),
      entity('TST-002', 'Sign in with a saved password'),
      entity('TST-003', 'Checkout with an expired card'),
      entity('MEM-001', 'The checkout button moved to the footer', 'MEM'),
      entity('POL-001', 'Never reuse a credential in a run', 'POL'),
    ]
    const vectors = new Map([
      ['test Buy a hat and pay at the checkout', unit({ 0: 1 })],
      ['test Sign in with a saved password', unit({ 1: 1 })],
      ['test Checkout with an expired card', unit({ 0: 0.95, 3: 0.3122498999199199 })],
      ['memory The checkout button moved to the footer', unit({ 0: 0.9, 3: 0.435889894354067 })],
      ['policy Never reuse a credential in a run', unit({ 1: 0.6, 2: 0.8 })],
      ['saved password', unit({ 1: 1 })],
      ['checkout', unit({ 0: 1 })],
      ['pay at the checkout', unit({ 0: 1 })],
      ['expired card', unit({ 0: 0.95, 3: 0.3122498999199199 })],
      ['nothing here mentions elephants', unit({ 5: 1 })],
    ])
    const queries = [
      'saved password',
      'checkout',
      'pay at the checkout',
      'expired card',
      'nothing here mentions elephants',
    ]
    const full = await corpus(entities, vectors, 'full')
    const floor = await corpus(entities, new Map(), 'floor')

    const rank = (resolution: EntityResolution): number => (
      resolution.kind === 'resolved' ? 0 : resolution.kind === 'ambiguous' ? 1 : 2
    )
    const fullOutcomes = await Promise.all(
      queries.map((query) => resolveHybrid(query, full.deps())),
    )
    const floorOutcomes = await Promise.all(
      queries.map((query) => resolveHybrid(query, floor.deps())),
    )

    // The vacuity guard. "Floor is never LESS disambiguated" is trivially true on a corpus
    // where full mode disambiguates everything, so this suite is only a test at all if full
    // mode resolves something.
    expect(fullOutcomes.filter((outcome) => outcome.kind === 'resolved').length)
      .toBeGreaterThan(0)

    for (const [index, query] of queries.entries()) {
      const fullOutcome = fullOutcomes[index]!
      const floorOutcome = floorOutcomes[index]!
      // The structural half: never a different silent answer.
      if (fullOutcome.kind === 'resolved' && floorOutcome.kind === 'resolved') {
        expect({ query, id: idsOf(floorOutcome) }).toEqual({ query, id: idsOf(fullOutcome) })
      }
      if (floorOutcome.kind === 'resolved') {
        expect({ query, kind: fullOutcome.kind }).toEqual({ query, kind: 'resolved' })
      }
      // The corpus half: weaker retrieval only ever became more careful.
      expect({ query, ordered: rank(floorOutcome) >= rank(fullOutcome) })
        .toEqual({ query, ordered: true })
    }
  })
})

describe('the constants sit where the fusion scale puts them', () => {
  it('normalises one leg leading alone to exactly the absolute threshold', () => {
    const oneLegRankOne = RESOLVER_LEG_WEIGHT_LEXICAL / (C_RRF + 1)

    expect(RESOLVER_FUSED_SCORE_NORMALIZER).toBeCloseTo(2 / 61, 12)
    expect(oneLegRankOne / RESOLVER_FUSED_SCORE_NORMALIZER).toBeCloseTo(0.5, 12)
    // At or below one leg's head, or a floor host could never resolve a reference that
    // matched exactly one entity.
    expect(RESOLVER_STRONG_HIT_MIN_SCORE).toBeLessThanOrEqual(0.5)
  })

  it('keeps the margin above the bound that makes the degradation direction structural', () => {
    // The most the dense leg can add to any one candidate, normalised.
    const maxDenseGain =
      (RESOLVER_LEG_WEIGHT_DENSE / (C_RRF + 1)) / RESOLVER_FUSED_SCORE_NORMALIZER

    expect(RESOLVER_STRONG_HIT_MARGIN).toBeGreaterThan(maxDenseGain / 2)
    // Equal weights are what bound `maxDenseGain` at all — see the constants' rationale.
    expect(RESOLVER_LEG_WEIGHT_DENSE).toBe(RESOLVER_LEG_WEIGHT_LEXICAL)
    expect(RESOLVER_CANDIDATE_K).toBeGreaterThan(3)
    expect(RESOLVER_LEXICAL_MIN_BM25).toBeGreaterThanOrEqual(0)
  })
})

describe('tier (b) composes the existing pipeline and implements no scoring of its own', () => {
  function statements(): string {
    return readFileSync(new URL('../hybrid.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart()
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
      })
      .join('\n')
  }

  const SCORING_OF_ITS_OWN = [
    'bm25',
    'cosine',
    'Math.sqrt',
    'Math.log',
    'idf',
    'dotProduct',
  ] as const

  function offenders(text: string): string[] {
    return SCORING_OF_ITS_OWN.filter((name) => new RegExp(
      `(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`,
      'i',
    ).test(text))
  }

  it('imports its legs and its fusion, and computes no score itself', () => {
    const source = statements()

    expect(source).toContain("from '../retrieval/legs.js'")
    expect(source).toContain("from '../retrieval/fusion.js'")
    expect(offenders(source)).toEqual([])
  })

  it('would flag a hand-rolled scorer planted in the module', () => {
    // Positive control: without it, a scan that has never rejected anything is not evidence.
    expect(offenders(`${statements()}\nconst score = Math.log(1 + termFrequency)\n`))
      .toEqual(['Math.log'])
    expect(statements()).toContain('resolveHybrid')
  })
})

describe('tier (a) falls through to tier (b), and an address never does', () => {
  let root: string
  let ledger: AddressingLedger
  let handle: EntityIndexHandle

  const TITLES = new Map([['bundle-checkout', 'The checkout regression bundle']])

  function source(): EntitySightingSource {
    const sight = (machineId: string): EntitySighting | undefined => {
      const title = TITLES.get(machineId)
      return title === undefined ? undefined : { machineId, title, statusSource: 'active' }
    }
    return { kind: 'MEM', sight, hydrate: sight }
  }

  beforeEach(() => {
    root = join(tmpdir(), `resolver-falls-through-${randomUUID()}`)
    ledger = openAddressingLedger({ path: join(root, 'entity-addresses.db') })
    handle = openEntityIndex({ path: join(root, 'entity-index.db') })
  })

  afterEach(() => {
    handle.close()
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('answers free text through the hybrid tiers once the entity has been sighted', async () => {
    const deps = { ledger, sources: [source()], entityIndex: handle }
    // Sighting the machine id mints the address AND projects the entity, which is what makes
    // the fuzzy reference below findable at all.
    expect((await resolveEntityRef('bundle-checkout', deps)).kind).toBe('resolved')

    const resolution = await resolveEntityRef('regression bundle', deps)

    expect(resolution.kind).toBe('resolved')
    expect(idsOf(resolution)).toEqual(['MEM-001'])
  })

  it('keeps a well-formed but unminted address out of the fuzzy tiers', async () => {
    const deps = { ledger, sources: [source()], entityIndex: handle }
    await resolveEntityRef('bundle-checkout', deps)

    // `MEM-404` is an ADDRESS. It is unknown, and answering it with whatever fuzzy text
    // happened to rank would be the silent guess the whole contract forbids.
    expect(await resolveEntityRef('MEM-404', deps)).toEqual({
      kind: 'none',
      reason: 'unknown-address',
    })
    expect(await resolveEntityRef('agentqa://memory/MEM-404', deps)).toEqual({
      kind: 'none',
      reason: 'unknown-address',
    })
  })

  it('still answers tier (a) only, with no index bound at all', async () => {
    const resolution = await resolveEntityRef('regression bundle', {
      ledger,
      sources: [source()],
    })

    expect(resolution).toEqual({ kind: 'none', reason: 'no-match' })
  })
})
