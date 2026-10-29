// The dual-posture entity-resolution corpus (Phase 387, D-08 / ENTY-01's validation clause).
//
// WHAT IS REAL HERE AND WHAT IS NOT
//
// Real: the addressing ledger (its own sqlite file), the entity index projection, `lexicalLeg`
// over FTS5, `denseLeg` over stored vectors, `fuseWeightedRrf`, and `resolveEntityRef` — the
// same entry every surface calls. Nothing is stubbed between the query and the answer.
//
// Not real: the embedding model. It is replaced by the fixture's authored geometry, because
// D-08 requires the corpus to run in CI with no live stores and a floor host has no model at
// all. See the fixture's header for how a cosine is computed by hand there.
//
// THE TWO POSTURES, AND WHY NEITHER SETS A FLAG
//
// `hybrid.ts` has no posture switch by design: `hasDenseCandidates` skips the dense leg when
// nothing is embedded, and an absent leg contributes nothing to the fusion. So the floor
// posture here is built by NOT embedding — which is what a host without a model actually looks
// like — rather than by telling the resolver which rung to run. A posture the test selects is a
// posture the test can get wrong; a posture that falls out of the data cannot.

import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_EMBEDDING_PROFILE,
  ENTITY_EXACT_MATCH_SCORE,
  formatEntityUri,
  formatOrdinalShortId,
  formatSlugShortId,
  isSlugAddressedKind,
  type EntityKind,
  type EntityResolution,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openAddressingLedger, type AddressingLedger } from '../../addressing/ledger.js'
import type { EmbedderPort } from '../../embedder-port.js'
import {
  embedPendingEntities,
  openEntityIndex,
  ENTITY_INDEX_SCOPE,
  type EntityIndexHandle,
} from '../../entity-index/entity-index.js'
import { hasDenseCandidates } from '../../retrieve.js'
import { renderEntityForEmbedding } from '../../entity-index/renderings.js'
import { applyStrongHitRule, rankEntityCandidates, type ResolveHybridDeps } from '../hybrid.js'
import {
  getEntityDescriptor,
  resolveEntityRef,
  type EntitySighting,
  type EntitySightingSource,
  type ResolveEntityRefDeps,
} from '../resolve.js'
import {
  CORPUS_CASES,
  CORPUS_CATEGORIES,
  CORPUS_ENTITIES,
  corpusVector,
  entityAxes,
  type CorpusCase,
  type CorpusEntity,
  type CorpusExpectation,
} from './fixtures/entity-corpus.js'
import {
  CORPUS_POSTURES,
  corpusReportPath,
  reportShapeProblems,
  writeCorpusReport,
  type CorpusCaseRow,
  type CorpusPosture,
  type CorpusReport,
} from './corpus-report.js'
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

const DIM = DEFAULT_EMBEDDING_PROFILE.dim

/** The pinned rule the report's rows were decided under, logged beside them. */
function corpusConstants(): Record<string, number> {
  return {
    RESOLVER_STRONG_HIT_MIN_SCORE,
    RESOLVER_STRONG_HIT_MARGIN,
    RESOLVER_FUSED_SCORE_NORMALIZER,
    RESOLVER_LEG_WEIGHT_LEXICAL,
    RESOLVER_LEG_WEIGHT_DENSE,
    RESOLVER_LEXICAL_MIN_BM25,
    RESOLVER_CANDIDATE_K,
    C_RRF,
    tau_dense: DEFAULT_EMBEDDING_PROFILE.tau_dense,
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture, turned into the three things the resolver needs: sighting sources, an index, and
// an embedder. Everything below is derived from the fixture and nothing is hand-maintained
// beside it.
// ---------------------------------------------------------------------------------------------

/** The short-ID the ledger will mint, derived from this array's order. */
function expectedShortId(machineId: string): string {
  const target = entityOf(machineId)
  if (isSlugAddressedKind(target.kind)) return formatSlugShortId(target.kind, target.machineId)

  let ordinal = 0
  for (const entity of CORPUS_ENTITIES) {
    if (entity.kind !== target.kind) continue
    ordinal += 1
    if (entity.machineId === machineId) return formatOrdinalShortId(target.kind, ordinal)
  }
  throw new Error(`the corpus never reaches ${JSON.stringify(machineId)}`)
}

function entityOf(machineId: string): CorpusEntity {
  const found = CORPUS_ENTITIES.find((entity) => entity.machineId === machineId)
  if (found === undefined) {
    throw new Error(`the corpus holds no entity with machine id ${JSON.stringify(machineId)}`)
  }
  return found
}

function sightingSources(): EntitySightingSource[] {
  const kinds = [...new Set(CORPUS_ENTITIES.map((entity) => entity.kind))]
  const sources = kinds.map((kind): EntitySightingSource => {
    const own = new Map(
      CORPUS_ENTITIES
        .filter((entity) => entity.kind === kind)
        .map((entity): [string, EntitySighting] => [entity.machineId, {
          machineId: entity.machineId,
          title: entity.title,
          statusSource: entity.statusSource ?? 'active',
        }]),
    )
    const sight = (machineId: string): EntitySighting | undefined => own.get(machineId)
    return { kind, sight, hydrate: sight }
  })
  return sources
}

/** Rendering text and query text to the fixture's authored vectors. Unknown text is loud. */
function corpusEmbedder(): EmbedderPort {
  const vectors = new Map<string, Float32Array>()
  for (const entity of CORPUS_ENTITIES) {
    vectors.set(
      renderEntityForEmbedding({
        kind: entity.kind,
        shortId: expectedShortId(entity.machineId),
        uri: formatEntityUri(entity.kind, expectedShortId(entity.machineId)),
        machineId: entity.machineId,
        title: entity.title,
        statusSource: entity.statusSource ?? 'active',
      }),
      corpusVector(entityAxes(entity), DIM),
    )
  }
  for (const testCase of CORPUS_CASES) {
    if (testCase.axes === undefined) continue
    vectors.set(queryOf(testCase), corpusVector(testCase.axes, DIM))
  }
  const lookup = async (text: string): Promise<Float32Array> => {
    const found = vectors.get(text)
    // A missing vector is a fixture defect, not a resolver outcome. Answering with zeros would
    // turn an unauthored case into a silently plausible one.
    if (found === undefined) throw new Error(`the corpus authored no vector for ${JSON.stringify(text)}`)
    return found
  }
  return { embedDocument: lookup, embedQuery: lookup }
}

/** The reference as it is actually put to the resolver. */
function queryOf(testCase: CorpusCase): string {
  const { ref } = testCase
  switch (ref.form) {
    case 'text':
    case 'literal':
      return ref.text
    case 'short-id':
      return expectedShortId(ref.entity)
    case 'uri':
      return formatEntityUri(entityOf(ref.entity).kind, expectedShortId(ref.entity))
    case 'machine-id':
      return ref.entity
  }
}

interface Posture {
  readonly name: CorpusPosture
  readonly deps: ResolveEntityRefDeps
  readonly index: EntityIndexHandle
  close(): void
}

/**
 * Seed one posture: mint every address by sighting, project, and embed only for `full`.
 *
 * Sighting is what mints AND projects (D-01/D-06), so the corpus is built the way a running
 * system builds one — no direct writes to the ledger or the index anywhere in this file.
 */
async function seedPosture(root: string, name: CorpusPosture): Promise<Posture> {
  const ledger = openAddressingLedger({ path: join(root, `${name}-addresses.db`) })
  const index: EntityIndexHandle = openEntityIndex({ path: join(root, `${name}-index.db`) })
  const embedder = corpusEmbedder()
  const deps: ResolveEntityRefDeps = {
    ledger,
    sources: sightingSources(),
    entityIndex: index,
    ...(name === 'full' ? { embedder } : {}),
  }

  for (const entity of CORPUS_ENTITIES) {
    const outcome = await resolveEntityRef(entity.machineId, deps)
    if (outcome.kind !== 'resolved') {
      throw new Error(`seeding ${entity.machineId} did not mint: ${JSON.stringify(outcome)}`)
    }
  }
  if (name === 'full') await embedPendingEntities(index, embedder)

  return {
    name,
    deps,
    index,
    close(): void {
      index.close()
      ledger.close()
    },
  }
}

function postureNamed(name: CorpusPosture): Posture {
  const found = postures.find((posture) => posture.name === name)
  if (found === undefined) throw new Error(`the corpus run has no ${name} posture`)
  return found
}

function candidatesOf(resolution: EntityResolution): CorpusCaseRow['topScores'] {
  if (resolution.kind === 'resolved') {
    return [{
      shortId: resolution.descriptor.shortId,
      machineId: resolution.descriptor.machineId,
      score: resolution.score,
    }]
  }
  if (resolution.kind === 'ambiguous') {
    return resolution.candidates.map(({ descriptor, score }) => ({
      shortId: descriptor.shortId,
      machineId: descriptor.machineId,
      score,
    }))
  }
  return []
}

function rowFor(
  testCase: CorpusCase,
  posture: CorpusPosture,
  resolution: EntityResolution,
): CorpusCaseRow {
  return {
    caseId: testCase.id,
    category: testCase.category,
    posture,
    query: queryOf(testCase),
    outcome: resolution.kind,
    ...(resolution.kind === 'none' ? { reason: resolution.reason } : {}),
    ...(resolution.kind === 'resolved' ? { resolved: resolution.descriptor.machineId } : {}),
    topScores: candidatesOf(resolution),
  }
}

// ---------------------------------------------------------------------------------------------
// One execution of the whole corpus, shared by every assertion below. Running it once and
// asserting many times is what keeps the two postures comparable: every claim is about the same
// outcomes, not about two independent runs that happened to agree.
// ---------------------------------------------------------------------------------------------

interface CorpusRun {
  readonly outcomes: ReadonlyMap<string, EntityResolution>
  readonly rows: readonly CorpusCaseRow[]
}

function key(caseId: string, posture: CorpusPosture): string {
  return `${posture}:${caseId}`
}

async function runCorpus(postures: readonly Posture[]): Promise<CorpusRun> {
  const outcomes = new Map<string, EntityResolution>()
  const rows: CorpusCaseRow[] = []
  for (const posture of postures) {
    for (const testCase of CORPUS_CASES) {
      const resolution = await resolveEntityRef(queryOf(testCase), posture.deps)
      outcomes.set(key(testCase.id, posture.name), resolution)
      rows.push(rowFor(testCase, posture.name, resolution))
    }
  }
  return { outcomes, rows }
}

let root: string
let postures: Posture[]
let run: CorpusRun
let report: CorpusReport

beforeAll(async () => {
  root = join(tmpdir(), `entity-corpus-${randomUUID()}`)
  postures = []
  for (const name of CORPUS_POSTURES) postures.push(await seedPosture(root, name))
  run = await runCorpus(postures)
  report = {
    report: 'entity-resolution-corpus',
    schemaVersion: 1,
    entityCount: CORPUS_ENTITIES.length,
    caseCount: CORPUS_CASES.length,
    postures: CORPUS_POSTURES,
    constants: corpusConstants(),
    cases: run.rows,
  }
  // Removed before it is written, and the reason is a mutation probe: with a previous run's
  // artifact still on disk, a writer that had stopped writing left the read-back assertion
  // passing against a file THIS run never produced.
  rmSync(corpusReportPath(), { force: true })
  writeCorpusReport(report)
}, 120_000)

afterAll(() => {
  for (const posture of postures) posture.close()
  rmSync(root, { recursive: true, force: true })
})

function outcome(caseId: string, posture: CorpusPosture): EntityResolution {
  const found = run.outcomes.get(key(caseId, posture))
  if (found === undefined) throw new Error(`the corpus run holds no ${posture} outcome for ${caseId}`)
  return found
}

describe('the corpus is a committed population, not a handful of examples', () => {
  it('holds at least a hundred entities spanning the five mintable kinds', () => {
    expect(CORPUS_ENTITIES.length).toBeGreaterThanOrEqual(100)

    const byKind = new Map<EntityKind, number>()
    for (const entity of CORPUS_ENTITIES) {
      byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1)
    }
    expect([...byKind.keys()].sort()).toEqual(['MEM', 'POL', 'RUN', 'TGT', 'TST'])
    for (const [kind, count] of byKind) {
      expect({ kind, atLeastFive: count >= 5 }).toEqual({ kind, atLeastFive: true })
    }
  })

  it('holds at least a hundred query cases with five or more in every category', () => {
    expect(CORPUS_CASES.length).toBeGreaterThanOrEqual(100)

    for (const category of CORPUS_CATEGORIES) {
      const count = CORPUS_CASES.filter((testCase) => testCase.category === category).length
      expect({ category, atLeastFive: count >= 5 }).toEqual({ category, atLeastFive: true })
    }
    expect(new Set(CORPUS_CASES.map((testCase) => testCase.id)).size).toBe(CORPUS_CASES.length)
  })

  it('never seeds through anything but the sighting path', async () => {
    // The corpus is built by resolving each machine id, which is the mint-and-project seam
    // itself. Re-resolving one address must answer identically rather than mint a second.
    const first = await resolveEntityRef('checkout-happy-path', postures[0]!.deps)
    const second = await resolveEntityRef('checkout-happy-path', postures[0]!.deps)
    expect(second).toEqual(first)
    expect(first.kind === 'resolved' && first.descriptor.shortId).toBe(
      expectedShortId('checkout-happy-path'),
    )
  })
})

describe('every case is scored in both postures and the log says so', () => {
  it('logs one row per case per posture, in score order, on the reported scale', () => {
    expect(reportShapeProblems(report, CORPUS_CASES.map((testCase) => testCase.id))).toEqual([])
    expect(report.cases.length).toBe(CORPUS_CASES.length * CORPUS_POSTURES.length)
    expect(report.cases.length).toBeGreaterThanOrEqual(200)
  })

  it('would flag a report that lost a posture, a row, or its ordering', () => {
    // Positive controls. A shape check that has never rejected anything is not a check.
    const ids = CORPUS_CASES.map((testCase) => testCase.id)
    const withoutFloor: CorpusReport = {
      ...report,
      postures: ['full'],
      cases: report.cases.filter((row) => row.posture !== 'floor'),
    }
    expect(reportShapeProblems(withoutFloor, ids).length).toBeGreaterThan(0)
    expect(reportShapeProblems(withoutFloor, ids)[0]).toContain('posture')

    const withoutOneRow: CorpusReport = { ...report, cases: report.cases.slice(1) }
    expect(reportShapeProblems(withoutOneRow, ids).length).toBeGreaterThan(0)

    const ambiguous = report.cases.find((row) => row.topScores.length >= 2)
    expect(ambiguous).toBeDefined()
    const misordered: CorpusReport = {
      ...report,
      cases: report.cases.map((row) => (
        row === ambiguous ? { ...row, topScores: [...row.topScores].reverse() } : row
      )),
    }
    expect(reportShapeProblems(misordered, ids).some((problem) => problem.includes('score order')))
      .toBe(true)

    const lying: CorpusReport = {
      ...report,
      cases: report.cases.map((row) => (
        row.outcome === 'resolved' ? { ...row, resolved: undefined } : row
      )),
    }
    expect(lying.cases.some((row) => row.outcome === 'resolved')).toBe(true)
    expect(reportShapeProblems(lying, ids).some((problem) => problem.includes('without naming')))
      .toBe(true)
  })

  it('writes an artifact a later retune can read back', () => {
    const written = JSON.parse(readFileSync(corpusReportPath(), 'utf8')) as CorpusReport
    expect(written.cases.length).toBe(report.cases.length)
    expect(written.constants).toEqual(corpusConstants())
    expect(reportShapeProblems(written, CORPUS_CASES.map((testCase) => testCase.id))).toEqual([])
  })
})

describe('the corpus is deterministic', () => {
  it('answers a second full execution identically, outcome for outcome', async () => {
    const second = await runCorpus(postures)
    expect(second.rows).toEqual(run.rows)
  }, 120_000)

  it('mints the same addresses into a freshly seeded pair of postures', async () => {
    const otherRoot = join(tmpdir(), `entity-corpus-repeat-${randomUUID()}`)
    const other = await seedPosture(otherRoot, 'full')
    try {
      const sample = ['checkout-happy-path', 'r_visual_diff_review', 'pol_no_silent_skip', 'mobile-ios']
      for (const machineId of sample) {
        const resolution = await resolveEntityRef(machineId, other.deps)
        expect(resolution.kind === 'resolved' && resolution.descriptor.shortId)
          .toBe(expectedShortId(machineId))
      }
    } finally {
      other.close()
      rmSync(otherRoot, { recursive: true, force: true })
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// The four claims the corpus exists to hold, and the proof that the third one's gate can fail.
// ---------------------------------------------------------------------------------------------

/** Where a case's declaration lives for one posture. */
function declaredFor(testCase: CorpusCase, posture: CorpusPosture): CorpusExpectation {
  return posture === 'full' ? testCase.full : testCase.floor
}

function describeOutcome(resolution: EntityResolution): string {
  if (resolution.kind === 'resolved') return `resolved(${resolution.descriptor.machineId})`
  if (resolution.kind === 'ambiguous') {
    return `ambiguous(${resolution.candidates.map(({ descriptor }) => descriptor.machineId).join(', ')})`
  }
  return `none(${resolution.reason})`
}

function describeDeclaration(expectation: CorpusExpectation): string {
  if (expectation.outcome === 'resolved') return `resolved(${expectation.target})`
  if (expectation.outcome === 'ambiguous') return `ambiguous(${expectation.mustContain.join(', ')})`
  return `none(${expectation.reason})`
}

/** Every way one outcome disagrees with its declaration, as sentences naming the case. */
function disagreements(
  testCase: CorpusCase,
  posture: CorpusPosture,
  resolution: EntityResolution,
): string[] {
  const declared = declaredFor(testCase, posture)
  const where = `${testCase.id}/${posture}`
  if (resolution.kind !== declared.outcome) {
    return [`${where}: declared ${describeDeclaration(declared)}, answered ${describeOutcome(resolution)}`]
  }

  const problems: string[] = []
  if (declared.outcome === 'resolved' && resolution.kind === 'resolved') {
    if (resolution.descriptor.machineId !== declared.target) {
      problems.push(`${where}: declared ${declared.target}, resolved ${resolution.descriptor.machineId}`)
    }
    if (declared.exact === true && resolution.score !== ENTITY_EXACT_MATCH_SCORE) {
      problems.push(`${where}: an exact address scored ${resolution.score}`)
    }
  }
  if (declared.outcome === 'ambiguous' && resolution.kind === 'ambiguous') {
    const offered = resolution.candidates.map(({ descriptor }) => descriptor.machineId)
    for (const required of declared.mustContain) {
      if (!offered.includes(required)) {
        problems.push(`${where}: the card omits ${required}; it offered ${offered.join(', ')}`)
      }
    }
  }
  if (declared.outcome === 'none' && resolution.kind === 'none') {
    if (resolution.reason !== declared.reason) {
      problems.push(`${where}: declared ${declared.reason}, answered ${resolution.reason}`)
    }
  }
  return problems
}

describe('never guess: no case resolves to an entity nobody named', () => {
  it('answers every case as its declaration says, in both postures', () => {
    const problems: string[] = []
    for (const testCase of CORPUS_CASES) {
      for (const posture of CORPUS_POSTURES) {
        problems.push(...disagreements(testCase, posture, outcome(testCase.id, posture)))
      }
    }
    expect(problems).toEqual([])
  })

  it('resolves no authored miss, in either posture', () => {
    const guessed = CORPUS_CASES
      .filter((testCase) => testCase.category === 'miss')
      .flatMap((testCase) => CORPUS_POSTURES
        .map((posture) => ({ testCase, posture, resolution: outcome(testCase.id, posture) }))
        .filter(({ resolution }) => resolution.kind === 'resolved')
        .map(({ testCase: named, posture }) => `${named.id}/${posture}`))

    expect(guessed).toEqual([])
    // The vacuity guard on this very claim: a corpus in which nothing ever resolves would
    // satisfy it by refusing everything.
    const resolvedCount = CORPUS_CASES.flatMap((testCase) => CORPUS_POSTURES
      .map((posture) => outcome(testCase.id, posture)))
      .filter((resolution) => resolution.kind === 'resolved').length
    expect(resolvedCount).toBeGreaterThan(20)
  })

  it('resolves under the floor posture too, so the ladder is not silently dead', () => {
    const floorResolved = CORPUS_CASES
      .filter((testCase) => outcome(testCase.id, 'floor').kind === 'resolved')
      .filter((testCase) => testCase.category !== 'exact')
    // Tier (a) is posture-independent, so exact addresses prove nothing about the floor RUNG.
    // Free text resolving with no dense leg at all is what proves the lexical leg is alive.
    expect(floorResolved.length).toBeGreaterThan(0)
  })
})

describe('the degradation invariant, in its two halves', () => {
  it('compares two genuinely different hosts', () => {
    // The vacuity a mutation probe found. Every claim below diffs `full` against `floor`, and a
    // "floor" that had been embedded like the full posture would satisfy all of them by being
    // the same host twice — with nothing in the suite noticing. Two independent pins: the leg
    // the floor rung is defined by absence of, and the outcomes that absence actually changes.
    expect(hasDenseCandidates(postureNamed('full').index.connection.db, ENTITY_INDEX_SCOPE))
      .toBe(true)
    expect(hasDenseCandidates(postureNamed('floor').index.connection.db, ENTITY_INDEX_SCOPE))
      .toBe(false)

    const differing = CORPUS_CASES.filter((testCase) => (
      JSON.stringify(outcome(testCase.id, 'full')) !== JSON.stringify(outcome(testCase.id, 'floor'))
    ))
    expect(differing.length).toBeGreaterThan(30)
  })

  it('never resolves a DIFFERENT entity at the floor than at the full posture', () => {
    const divergent: string[] = []
    for (const testCase of CORPUS_CASES) {
      const full = outcome(testCase.id, 'full')
      const floor = outcome(testCase.id, 'floor')
      if (full.kind !== 'resolved' || floor.kind !== 'resolved') continue
      if (full.descriptor.machineId !== floor.descriptor.machineId) {
        divergent.push(
          `${testCase.id}: full resolved ${full.descriptor.machineId}, floor resolved ${floor.descriptor.machineId}`,
        )
      }
    }
    expect(divergent).toEqual([])

    // The comparison covers the whole corpus, and the pairs it compares are real: if the two
    // postures never both resolved, "they never disagreed" would mean nothing.
    const bothResolved = CORPUS_CASES.filter((testCase) => (
      outcome(testCase.id, 'full').kind === 'resolved'
      && outcome(testCase.id, 'floor').kind === 'resolved'
    ))
    expect(bothResolved.length).toBeGreaterThan(5)
  })

  it('is MORE confident at the floor in exactly the cases that declare it', () => {
    // The monotone half — "the floor only ever ADDS disambiguation" — is empirically FALSE, and
    // 387-03's handoff named the class before this corpus existed: a sole lexical match with no
    // dense hit, tied by a dense-only rival, resolves at the floor and disambiguates in full.
    // Asserting the strong form would have meant authoring a corpus with no case of that shape.
    const rank = (resolution: EntityResolution): number => (
      resolution.kind === 'resolved' ? 0 : resolution.kind === 'ambiguous' ? 1 : 2
    )
    const moreConfident = CORPUS_CASES
      .filter((testCase) => rank(outcome(testCase.id, 'floor')) < rank(outcome(testCase.id, 'full')))
      .map((testCase) => testCase.id)
    const declared = CORPUS_CASES
      .filter((testCase) => testCase.monotonicityCounterexample === true)
      .map((testCase) => testCase.id)

    expect(moreConfident.sort()).toEqual([...declared].sort())
    expect(declared.length).toBeGreaterThan(0)
  })
})

describe('equal strength always disambiguates', () => {
  it('offers both twins at an identical score rather than picking one', () => {
    const equalStrength = CORPUS_CASES.filter((testCase) => testCase.equalStrength === true)
    expect(equalStrength.length).toBeGreaterThanOrEqual(5)

    for (const testCase of equalStrength) {
      for (const posture of CORPUS_POSTURES) {
        const resolution = outcome(testCase.id, posture)
        expect({ case: testCase.id, posture, kind: resolution.kind })
          .toEqual({ case: testCase.id, posture, kind: 'ambiguous' })
      }
      // The scores are asserted, not just the outcome: a case that quietly became a NEAR tie
      // would still disambiguate today and would stop testing "equal strength" tomorrow.
      const full = outcome(testCase.id, 'full')
      expect(full.kind).toBe('ambiguous')
      if (full.kind !== 'ambiguous') continue
      expect({ case: testCase.id, tied: full.candidates[0]!.score === full.candidates[1]!.score })
        .toEqual({ case: testCase.id, tied: true })
      expect(full.candidates[0]!.score - full.candidates[1]!.score).toBe(0)
    }
  })
})

describe('an exact address answers identically whatever the host can embed', () => {
  it('resolves every address form at the exact-match score in both postures', () => {
    const exact = CORPUS_CASES.filter((testCase) => testCase.category === 'exact')
    expect(exact.length).toBeGreaterThanOrEqual(5)
    expect(new Set(exact.map((testCase) => testCase.ref.form)))
      .toEqual(new Set(['short-id', 'uri', 'machine-id']))

    for (const testCase of exact) {
      const full = outcome(testCase.id, 'full')
      const floor = outcome(testCase.id, 'floor')
      expect({ case: testCase.id, same: JSON.stringify(full) === JSON.stringify(floor) })
        .toEqual({ case: testCase.id, same: true })
      expect(full.kind).toBe('resolved')
      if (full.kind !== 'resolved') continue
      expect({ case: testCase.id, score: full.score })
        .toEqual({ case: testCase.id, score: ENTITY_EXACT_MATCH_SCORE })
    }
  })
})

describe('the degradation gate is one an input can actually redden', () => {
  /**
   * The rankings the resolver itself produced, re-decidable at a margin the corpus chooses.
   *
   * `rankEntityCandidates` is the ranking half and `applyStrongHitRule` is the decision half, so
   * this re-runs the SHIPPED decision over the SHIPPED ranking with one number moved. Nothing
   * here re-implements either; a copy of the rule would have proved a copy could fail.
   */
  function hybridDeps(posture: Posture): ResolveHybridDeps {
    const index = posture.deps.entityIndex
    if (index === undefined) throw new Error('the corpus posture lost its projection')
    return {
      index,
      describe: (shortId: string) => getEntityDescriptor(shortId, posture.deps),
      ...(posture.deps.embedder === undefined ? {} : { embedder: posture.deps.embedder }),
    }
  }

  /** Cases that reach the fuzzy tiers at all — an address is decided before the rule runs. */
  function fuzzyCases(): CorpusCase[] {
    return CORPUS_CASES.filter((testCase) => testCase.ref.form === 'text')
  }

  async function divergencesAt(margin: number): Promise<string[]> {
    const byPosture = new Map<CorpusPosture, Map<string, EntityResolution>>()
    for (const posture of postures) {
      const decided = new Map<string, EntityResolution>()
      for (const testCase of fuzzyCases()) {
        const ranked = await rankEntityCandidates(queryOf(testCase), hybridDeps(posture))
        decided.set(testCase.id, applyStrongHitRule(ranked, {
          minScore: RESOLVER_STRONG_HIT_MIN_SCORE,
          margin,
        }))
      }
      byPosture.set(posture.name, decided)
    }

    const divergent: string[] = []
    for (const testCase of fuzzyCases()) {
      const full = byPosture.get('full')!.get(testCase.id)!
      const floor = byPosture.get('floor')!.get(testCase.id)!
      if (full.kind === 'resolved' && floor.kind === 'resolved'
        && full.descriptor.machineId !== floor.descriptor.machineId) {
        divergent.push(testCase.id)
      }
    }
    return divergent
  }

  /**
   * The margin below which the two postures CAN name different entities.
   *
   * Derived, not typed: the floor posture's score comes from the lexical leg alone, so its top
   * is one leg's rank-1 contribution and its runner-up — when it has one — is rank 2. The gap
   * between those two adjacent ranks is the largest margin a floor host can ever clear against
   * a rival, so a margin above it makes "the floor resolved something else" unreachable.
   *
   * This is a far tighter bound than the 0.25 the constants' rationale derives from the
   * continuous inequality: on this discrete scale it is 1/124, about 0.008.
   */
  const ADJACENT_RANK_GAP =
    ((RESOLVER_LEG_WEIGHT_LEXICAL / (C_RRF + 1)) - (RESOLVER_LEG_WEIGHT_LEXICAL / (C_RRF + 2)))
    / RESOLVER_FUSED_SCORE_NORMALIZER

  it('holds at the shipped margin, and stops holding below the adjacent-rank gap', async () => {
    expect(ADJACENT_RANK_GAP).toBeCloseTo(1 / 124, 12)
    expect(RESOLVER_STRONG_HIT_MARGIN).toBeGreaterThan(ADJACENT_RANK_GAP)

    // The claim, at the value that ships.
    expect(await divergencesAt(RESOLVER_STRONG_HIT_MARGIN)).toEqual([])
    // Still nothing between the shipped value and the bound.
    expect(await divergencesAt(ADJACENT_RANK_GAP * 1.5)).toEqual([])

    // And below it, the corpus DOES produce the divergence the shipped margin forbids. Without
    // this the first two assertions would be a gate no input could redden.
    const belowBound = await divergencesAt(ADJACENT_RANK_GAP / 2)
    expect(belowBound.length).toBeGreaterThan(0)

    const witnesses = CORPUS_CASES
      .filter((testCase) => testCase.divergenceWitness === true)
      .map((testCase) => testCase.id)
    expect(witnesses.length).toBeGreaterThan(0)
    for (const witness of witnesses) expect(belowBound).toContain(witness)
  }, 120_000)
})
