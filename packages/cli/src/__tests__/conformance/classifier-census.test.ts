// The classifier census: every registered capability folds its own result (399.1-04 · D-01).
//
// WHY A CENSUS AND NOT A REVIEW HABIT. D-01 put refusal knowledge in a per-op declared fold rather
// than in a chat-side rule that pattern-matches values, because a rule that can only refuse what it
// can NAME cannot be driven to zero by naming more things. The price of that choice is coverage: an
// op that declared no fold reported the legacy `executed` for every result it could return, and did
// so silently — which is how forty ops rendered nothing for two phases. This file is the register
// that makes the gap countable, and its failure names the op.
//
// TWO LAYERS, AND NEITHER IS THE OTHER'S RESTATEMENT. `FunctionSpec.classify` is REQUIRED as of this
// plan, so an op file that declares none does not compile — that is the layer that catches the
// ordinary case, at the keystroke. It is also defeatable: a spec registered through an `as`-cast, a
// spread of a partial literal, or a registry assembled from a different type entirely all satisfy
// `tsc` and ship an op with no fold. This census reads the SHIPPED registry's own listing, so it
// answers the question the type cannot: what does the product actually contain.
//
// WHICH TWO SETS THE CENSUS COMPARES, SAID PLAINLY (397 D-14's lesson). It compares (1) the op ids
// the shipped registry enumerates against (2) the op ids whose declaration carries `classifies`.
// Both sides are read off real declarations from a composed host; neither is a list somebody typed.
// The `classifies` projection exists precisely so this package — which cannot reach a `FunctionSpec`
// by construction (BL-01 / 384 FUNC-03) — can ask the question without reading forty-four op files.
//
// AND THE THIRD REGISTER, WHICH IS THE ONE THAT CATCHES DRIFT. A live-only census passes forever on
// a registry that quietly stopped declaring: `classifies` disappearing from an op would leave BOTH
// sides above smaller together, and both directions would still be equal. The golden ledger is a
// committed artifact a person reviewed, so the last cell asserts the live classifying set is
// set-equal to the golden's `classifies` column — an op that stops folding is then a named RED here
// and a one-line ledger diff in review, rather than a silent return to `executed`.
//
// WHAT THIS FILE CANNOT SEE. A census compares MEMBERSHIP. It is blind to a classifier that is
// present and WRONG — one that folds a refusal arm to `executed`, say. That half is
// `packages/agent/src/functions/__tests__/refusal-classifiers.test.ts`'s, which drives each fold
// over fixtures produced through the op's own output contract, and it is deliberately not
// duplicated here: a second copy of that judgement in a package that cannot reach a spec would be a
// weaker restatement free to disagree with the real one.

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
    // THE PRIMARY DIRECTION, and the one a person reads when it fires: the ids, sorted, of every op
    // the registry enumerates whose declaration carries no fold. `toEqual([])` prints them, which is
    // the named-RED requirement — the failure a person needs is "which capability", not "one too
    // few" (397 D-06/D-07's own words, applied to a second register).
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
    // BOTH DIRECTIONS, because a census that only checks one is the register that never notices it
    // has stopped growing (397 D-10). The `stray` side is the one that fires if the classifying set
    // is ever sourced from anywhere other than the same enumeration — a hand-written roster, a
    // second registry, a golden row for a capability that no longer exists — and it is asserted
    // rather than reasoned away, because "structurally impossible today" is a property of one
    // afternoon's code and this register outlives it. `censusDiff`'s ability to fire on EACH side is
    // proven by the control cell below rather than assumed from this cell's green.
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
