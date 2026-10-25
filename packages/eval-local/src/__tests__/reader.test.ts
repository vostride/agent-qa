// 414 D-18 / D-19 / D-20 (ROOT-10 SC5) — the proposer's read port, measured.
//
// Three pins hold the `/reader` subpath to one value export whose methods cannot return a
// private held-out entry. This file is TWO of them: the runtime export key-set cell (Test 1)
// and the behavioural non-leak cells (Tests 2-5). The third is the source-anchored export-set
// cell in `packages/arch/src/__tests__/validate-arch.test.ts`, and the fourth is the
// `.test-d.ts` never-bar beside this file.
//
// The imports are RELATIVE on purpose (the `410-five-entity-kinds.test.ts` idiom): a planted
// export must RED here without anyone rebuilding `dist/`.

import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  assignSplit,
  buildSeedingPlan,
  committedFileText,
  extractRunCassettes,
  projectPartitionManifest,
} from '@vostride/agent-qa-eval'
import type {
  ArtifactSource,
  CorpusEntry,
  ExtractedCassette,
  SeedingPlan,
} from '@vostride/agent-qa-eval'
import { asRef } from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, Decision, SubActionEvidence } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { committedCorpusPath } from '../committed-root-store.js'
import { openCorpusReader } from '../corpus-reader.js'
import { seedCommittedCorpus, writePartitionManifest } from '../seeding-composition.js'
import {
  LOCAL_FIXTURE_BLOB_BYTES,
  LOCAL_FIXTURE_BLOB_SHA,
  makeLocalV2Handoff,
} from './fixtures/local-handoff-fixture.js'

const NO_DECLARED_SECRETS = (text: string) => text

const PRODUCT = 'default'

/**
 * A product dir holding nothing but a private held-out entry. `listEntries(GHOST_PRODUCT)`
 * must be `[]` — not an empty-because-filtered count, not a "no visible entries" notice.
 * A product whose only members are private is a product the proposer cannot learn exists.
 */
const GHOST_PRODUCT = 'ghost-product'

/**
 * The 414-05 shared partition vector's salt and fractions (`committed-corpus-source.test.ts`,
 * `committed-root-proof.test.ts`), reused verbatim per 414-05's own handoff note. Under this
 * salt the CLONED silver leaves below split into BOTH held-out visibilities — the cells assert
 * each set is non-empty before using it, so a fixture change that collapses one of them fails
 * loudly rather than making the non-leak cells vacuous.
 */
const READER_PARTITION = {
  saltHex: 'a3f'.repeat(21).concat('b'),
  heldOutFraction: 0.95,
  privateFraction: 0.5,
} as const

/** How many silver tests the fixture handoff is cloned into (see READER_PARTITION). */
const SILVER_CLONE_COUNT = 8

function fullArtifacts(): ArtifactSource {
  const entries = new Map<string, Uint8Array>([[LOCAL_FIXTURE_BLOB_SHA, LOCAL_FIXTURE_BLOB_BYTES]])
  return { getBlob: (sha) => entries.get(sha) }
}

function decisionFor(subAction: SubActionEvidence): Decision {
  return {
    plan: subAction.plan,
    plannedAction: structuredClone(subAction.plannedAction),
    result: structuredClone(subAction.result),
  }
}

/**
 * The `committed-corpus-source.test.ts` fixture — one silver test plus one resolvable self-heal
 * pair — widened by `SILVER_CLONE_COUNT` further silver tests. The clones exist because the base
 * fixture yields exactly ONE bucketable leaf, and one leaf can be held-out private or held-out
 * shared but never both; the non-leak cells need one of each in the SAME root.
 */
function sourceHandoff(): CompletedRunHandoff {
  const handoff = makeLocalV2Handoff()
  for (const test of handoff.tests) {
    for (const step of test.steps) {
      for (const subAction of step.subActions) {
        subAction.stateBefore = { ...subAction.stateBefore, timestamp: 1_725_000_000 }
      }
    }
  }
  const silverTest = handoff.tests[0]!
  const pairTest = structuredClone(silverTest)
  pairTest.testId = 'eval-local::self-heal'
  pairTest.testIndex = 1
  pairTest.steps = [structuredClone(silverTest.steps[0]!)]
  const step = pairTest.steps[0]!
  const failedSub = step.subActions[0]!
  const continueRef2 = asRef('e-continue-2')
  const primaryElement = failedSub.stateBefore.elements[0]!
  failedSub.stateBefore.elements = [
    primaryElement,
    {
      ...structuredClone(primaryElement),
      ref: continueRef2,
      name: 'Continue again',
      nameNormalized: 'continue again',
      labels: { ariaLabel: 'Continue again' },
    },
  ]
  failedSub.stateBefore.refMap = {
    ...failedSub.stateBefore.refMap,
    [continueRef2]: structuredClone(failedSub.stateBefore.refMap[primaryElement.ref]!),
  }
  const recoveringSub = structuredClone(failedSub)
  recoveringSub.plannedAction = { type: 'click', ref: continueRef2 }
  step.subActions = [failedSub, recoveringSub]
  step.selfHeal = {
    failedDecision: decisionFor(failedSub),
    recoveringDecision: decisionFor(recoveringSub),
  }

  const clones = Array.from({ length: SILVER_CLONE_COUNT }, (_unused, index) => {
    const clone = structuredClone(silverTest)
    clone.testId = `eval-local::silver-${String(index)}`
    clone.testIndex = index + 2
    return clone
  })

  handoff.tests = [silverTest, pairTest, ...clones]
  return handoff
}

function extract(handoff: CompletedRunHandoff): ExtractedCassette[] {
  return extractRunCassettes({ handoff, artifacts: fullArtifacts() }).cassettes
}

/** Write committed bytes at a root-relative path, creating parents. */
function writeCommitted(root: string, relPath: string, value: unknown): void {
  const file = join(root, relPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, committedFileText(value), 'utf8')
}

/** A v2 PRIVATE held-out entry under a product dir of its own (see GHOST_PRODUCT). */
const GHOST_PRIVATE_ENTRY = {
  schemaVersion: 2,
  cassetteId: 'r_ghost-run/test-00-step-00-d00-leaf',
  product: GHOST_PRODUCT,
  split: 'held-out',
  heldOutVisibility: 'private',
  captured_at_ordinal: 7,
  run_links: { runId: 'r_ghost-run', runSlug: 'r_ghost-run' },
  receiptDigest: '5e'.repeat(32),
} as const satisfies CorpusEntry

describe('openCorpusReader on the /reader subpath (414 D-18/D-19/D-20, ROOT-10 SC5)', () => {
  let root: string
  let plan: SeedingPlan
  let privateIds: string[]
  let sharedIds: string[]
  let naturalIds: string[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-reader-root-'))
    const handoff = sourceHandoff()
    const cassettes = extract(handoff)
    plan = buildSeedingPlan({ handoff, cassettes, partition: READER_PARTITION })
    seedCommittedCorpus({
      plan,
      cassettes,
      committedRoot: root,
      mask: NO_DECLARED_SECRETS,
    })
    writePartitionManifest({
      manifest: projectPartitionManifest({
        product: PRODUCT,
        saltHex: READER_PARTITION.saltHex,
        heldOutFraction: READER_PARTITION.heldOutFraction,
        privateFraction: READER_PARTITION.privateFraction,
      }),
      committedRoot: root,
    })
    writeCommitted(
      root,
      committedCorpusPath(GHOST_PRODUCT, GHOST_PRIVATE_ENTRY.cassetteId),
      GHOST_PRIVATE_ENTRY,
    )

    // The ids are DERIVED, not spelled: `assignSplit` over the same salt the seeder used is
    // what decides them, so a partition-recipe change moves these cells with the corpus.
    privateIds = []
    sharedIds = []
    naturalIds = []
    for (const planCase of plan.cases) {
      const entry = planCase.corpusEntry
      if (entry.split === 'natural') naturalIds.push(entry.cassetteId)
      else if (entry.split === 'held-out' && entry.heldOutVisibility === 'private') {
        privateIds.push(entry.cassetteId)
      } else if (entry.split === 'held-out') sharedIds.push(entry.cassetteId)
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exports exactly one value from the /reader subpath (D-20 key-set pin)', async () => {
    const barrel = await import('../reader.js')

    expect(Object.keys(barrel).sort()).toEqual(['openCorpusReader'])
  })

  it('lists every proposer-visible entry and no private held-out one (D-19)', () => {
    // Non-vacuity: the root really carries all three populations, and every id the seeder
    // assigned agrees with `assignSplit` recomputed here.
    expect(privateIds.length).toBeGreaterThan(0)
    expect(sharedIds.length).toBeGreaterThan(0)
    expect(naturalIds).toHaveLength(2)
    for (const cassetteId of privateIds) {
      expect(assignSplit({ ...READER_PARTITION, cassetteId, isPairMember: false })).toEqual({
        split: 'held-out',
        heldOutVisibility: 'private',
      })
    }

    const listed = openCorpusReader(root)
      .listEntries()
      .map((entry) => entry.cassetteId)

    expect(listed).toEqual([...naturalIds, ...sharedIds].sort())
    for (const cassetteId of privateIds) expect(listed).not.toContain(cassetteId)
    // Structural, not just by id: nothing carrying the private marker survives the filter.
    // The static type is deliberately ERASED here — `ProposerVisibleCorpusEntry` already makes
    // `heldOutVisibility === 'private'` a type error, so a cell written against the declared
    // type would be restating the never-bar in `reader.test-d.ts` rather than measuring the
    // filter. What must hold at RUNTIME is that no such object comes back, whatever the types say.
    const erased = openCorpusReader(root).listEntries() as readonly {
      heldOutVisibility?: string
    }[]
    expect(erased.filter((entry) => entry.heldOutVisibility === 'private')).toEqual([])
  })

  it('filters by product over the visible set, and a private-only product lists nothing', () => {
    const reader = openCorpusReader(root)

    expect(reader.listEntries(PRODUCT).map((entry) => entry.cassetteId)).toEqual(
      [...naturalIds, ...sharedIds].sort(),
    )
    // The ghost product's ONLY entry is private: the product itself is unlistable, so the
    // proposer cannot learn a partition exists by counting an empty-but-present product.
    expect(reader.listEntries(GHOST_PRODUCT)).toEqual([])
    expect(reader.listEntries('no-such-product')).toEqual([])
  })

  it('answers a private cassetteId exactly as it answers an absent one (D-19 existence non-leak)', () => {
    const reader = openCorpusReader(root)
    const privateId = privateIds[0]!
    const sharedId = sharedIds[0]!
    const naturalId = naturalIds[0]!
    const absentId = 'does/not-exist'

    // Non-vacuity: the private entry's cassette and label ARE in the committed root, so the
    // not-found below is the filter refusing, not the bytes being missing.
    expect(reader.loadCassette(sharedId)).toEqual({
      kind: 'loaded',
      cassette: expect.objectContaining({ id: sharedId }),
    })
    expect(reader.loadLabel(naturalId)).toEqual({
      kind: 'loaded',
      record: expect.objectContaining({ cassetteId: naturalId }),
    })

    expect(reader.loadCassette(privateId)).toEqual(reader.loadCassette(absentId))
    expect(reader.loadCassette(privateId)).toEqual({ kind: 'not-found' })
    expect(reader.loadLabel(privateId)).toEqual(reader.loadLabel(absentId))
    expect(reader.loadLabel(privateId)).toEqual({ kind: 'not-found' })
    expect(reader.loadCassette(GHOST_PRIVATE_ENTRY.cassetteId)).toEqual({ kind: 'not-found' })
    expect(reader.loadLabel(GHOST_PRIVATE_ENTRY.cassetteId)).toEqual({ kind: 'not-found' })
  })

  it('offers exactly three methods and no widening parameter (D-19: no count, no visibility)', () => {
    const reader = openCorpusReader(root)

    expect(Object.keys(reader).sort()).toEqual(['listEntries', 'loadCassette', 'loadLabel'])
    // Arity: the ONE parameter is the product. A second argument cannot exist to widen.
    expect(reader.listEntries.length).toBeLessThanOrEqual(1)
    const listed = reader.listEntries(PRODUCT)
    const withExtraArgument = (
      reader.listEntries as unknown as (product?: string, widen?: unknown) => unknown[]
    )(PRODUCT, { heldOutVisibility: 'private' })
    expect(withExtraArgument).toEqual(listed)
  })

  it('answers an absent committed root with an empty list and not-found, never a throw', () => {
    const reader = openCorpusReader(join(root, 'no-such-root'))

    expect(reader.listEntries()).toEqual([])
    expect(reader.listEntries(PRODUCT)).toEqual([])
    expect(reader.loadCassette('anything')).toEqual({ kind: 'not-found' })
    expect(reader.loadLabel('anything')).toEqual({ kind: 'not-found' })
  })
})
