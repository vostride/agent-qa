// `classify` is a required type, but a cast defeats it, so this reads the shipped registry.

import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { registryDeclarations, registryOpIds } from './adapters.js'
import { GOLDEN_PATH, GOLDEN_REGEN_INSTRUCTION } from './golden.js'
import type { GoldenFile } from './golden.js'
import { censusDiff } from './scenario-table.js'

/** Ids whose SHIPPED declaration carries the classifier projection — read, never listed. */
function classifyingOpIds(): readonly string[] {
  return registryDeclarations()
    .filter((declaration) => declaration.classifies === true)
    .map((declaration) => declaration.id)
}

/** Ids the committed ledger pins as folding their own result. */
function goldenClassifyingOpIds(): readonly string[] {
  const file = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile
  return file.rows.filter((row) => row.classifies === true).map((row) => row.id)
}

/** Sorted, so a named RED reads the same on every machine. */
function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

describe('the classifier census: no capability ships without a fold', () => {
  it('declares a classifier on every registered capability, naming any that does not', () => {
    // `toEqual([])` prints the ids of ops with no fold, so the failure names the capability.
    const undeclared = sorted(
      registryDeclarations()
        .filter((declaration) => declaration.classifies !== true)
        .map((declaration) => declaration.id),
    )

    expect(
      undeclared,
      'capabilities the registry declares that fold no result — every op reports what its own '
        + 'result MEANT (399.1 D-01); an op with no `classify` reports the legacy `executed` for '
        + 'every arm it can return, including the ones where a guardrail declined',
    ).toEqual([])
  })

  it('carries exactly one classifier per registered capability, in both directions', () => {
    // Both directions, so a classifying set sourced from anywhere else shows as a stray.
    const diff = censusDiff(registryOpIds(), classifyingOpIds())

    expect(
      diff.missing,
      'capabilities the registry declares that no classifier covers — declare `classify` on the '
        + "op's own spec, over its own output union",
    ).toEqual([])
    expect(
      diff.stray,
      'classifier declarations naming a capability the registry no longer declares',
    ).toEqual([])

    // …and the census is not empty, which every line above would pass on.
    expect(classifyingOpIds().length, 'the classifying set is empty — this census ranges nothing')
      .toBeGreaterThan(0)
    expect(registryOpIds().length, 'the registry census is empty — this cell ranges nothing')
      .toBeGreaterThan(0)
  })

  it('agrees with the committed ledger, so an op that STOPS folding is a reviewed diff', () => {
    // The drift half. Both sets above are computed from one live enumeration, so an op losing its
    // fold shrinks them together and both directions stay equal. The golden is a committed artifact
    // a person reviewed; comparing against it is what turns "this build declares N folds" into "this
    // build declares the N folds somebody approved".
    expect(existsSync(GOLDEN_PATH), `the committed ledger is missing — ${GOLDEN_REGEN_INSTRUCTION}`)
      .toBe(true)

    const diff = censusDiff(sorted(goldenClassifyingOpIds()), sorted(classifyingOpIds()))

    expect(
      diff.missing,
      `the ledger pins these capabilities as folding their own result and the live registry does `
        + `not — a fold that was removed is a reviewed ledger entry, so ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toEqual([])
    expect(
      diff.stray,
      `these capabilities fold their own result and the ledger does not say so — a new fold is a `
        + `reviewed ledger entry, so ${GOLDEN_REGEN_INSTRUCTION}`,
    ).toEqual([])
  })

  it('control: the census self-check fires on a missing classifier AND on a stray one', () => {
    // The Edge-Coverage-Register lesson, made mechanical, in the idiom `parity.test.ts` established.
    // Each side is driven with synthetic input so the branch is exercised without mutating a shipped
    // file and without a skip, and a CLEAN input is fed in the same cell — a self-check that fires
    // on everything certifies as little as one that fires on nothing.
    const census = registryOpIds()
    const SYNTHETIC_UNFOLDED_OP_ID = 'synthetic.census.op-that-folds-nothing'
    const SYNTHETIC_STRAY_FOLD_OP_ID = 'synthetic.census.fold-for-an-op-that-is-gone'

    expect(censusDiff(census, census), 'identical id sets must diff to nothing').toEqual({
      missing: [],
      stray: [],
    })

    expect(
      censusDiff([...census, SYNTHETIC_UNFOLDED_OP_ID], census).missing,
      'a registered capability covered by no classifier must be named on the missing side',
    ).toEqual([SYNTHETIC_UNFOLDED_OP_ID])
    expect(
      censusDiff(census, census.filter((id) => id !== census[0])).missing,
      'a classifier removed from a shipped op must be named on the missing side',
    ).toEqual([census[0]])

    expect(
      censusDiff(census, [...census, SYNTHETIC_STRAY_FOLD_OP_ID]).stray,
      'a classifier naming a capability the registry does not declare must be named on the stray side',
    ).toEqual([SYNTHETIC_STRAY_FOLD_OP_ID])
  })
})
