// The deterministic closest-capability proofs.
//
// DETERMINISM IS A TWO-SIDED CLAIM and both sides are cells here. One side is the easy one: the
// right answer for a query. The other is the one that actually bites — that the SAME input cannot
// produce a DIFFERENT answer on another run, another row order, or another machine's locale. So:
// repeated invocation is deep-equal, a shuffled row array gives an identical answer (nothing here
// depends on Map/Set iteration order), and the tie-break comparator is asserted against code-unit
// order directly, because `localeCompare` is the machine-dependent comparison this must not be.

import { CatalogRowSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { closestCapabilities, compareRowIds } from '../scorer.js'
import { CATALOG_ROWS } from './fixtures.js'

/** Two rows with byte-identical scored text and different ids — a tie by construction. */
const TIED_ROWS: readonly CatalogRow[] = Object.freeze([
  CatalogRowSchema.parse({
    kind: 'op',
    id: 'zulu',
    description: 'the identical scored text',
    params: { type: 'object' },
    surfaces: ['chat'],
    mcpUnprojectedReasonKey: 'not-projected',
    docPath: null,
    docAbsentReason: 'fixture',
    // `params` declares no required property, so the derived example is the empty call.
    exampleCall: { arguments: {} },
  }),
  CatalogRowSchema.parse({
    kind: 'alias',
    alias: 'zulu',
    targetOpId: 'zulu',
    description: 'the identical scored text',
    docPath: null,
    docAbsentReason: 'fixture',
  }),
])

describe('closestCapabilities — the answer', () => {
  it('picks the capability whose name and description the query actually overlaps', () => {
    expect(closestCapabilities('how do I start a run', CATALOG_ROWS, 1)).toEqual(['op:runs.start'])
    expect(closestCapabilities('list my recent runs', CATALOG_ROWS, 1)).toEqual(['op:runs.list'])
    expect(closestCapabilities('authoring a test safely', CATALOG_ROWS, 1)).toEqual([
      'skill:agent-qa-authoring',
    ])
  })

  it('honours k and never answers more than the catalog holds', () => {
    expect(closestCapabilities('run', CATALOG_ROWS, 2)).toHaveLength(2)
    expect(closestCapabilities('run', CATALOG_ROWS, 99).length).toBeLessThanOrEqual(
      CATALOG_ROWS.length,
    )
  })

  it('answers [] on an empty catalog rather than reaching for something', () => {
    expect(closestCapabilities('anything at all', [], 3)).toEqual([])
  })

  it('answers [] when NOTHING overlaps — an unrelated suggestion would be an invention', () => {
    expect(closestCapabilities('zzzz qqqq wwww', CATALOG_ROWS, 3)).toEqual([])
  })
})

describe('closestCapabilities — determinism', () => {
  it('gives a deep-equal answer on repeated invocation', () => {
    const first = closestCapabilities('run a test', CATALOG_ROWS, 3)
    for (let attempt = 0; attempt < 25; attempt += 1) {
      expect(closestCapabilities('run a test', CATALOG_ROWS, 3)).toEqual(first)
    }
  })

  it('does not depend on the order the rows arrived in', () => {
    const canonical = closestCapabilities('run a test', CATALOG_ROWS, 4)
    const permutations = [
      [...CATALOG_ROWS].reverse(),
      [CATALOG_ROWS[2], CATALOG_ROWS[0], CATALOG_ROWS[3], CATALOG_ROWS[1]],
      [CATALOG_ROWS[3], CATALOG_ROWS[2], CATALOG_ROWS[1], CATALOG_ROWS[0]],
    ] as CatalogRow[][]
    for (const permutation of permutations) {
      expect(closestCapabilities('run a test', permutation, 4)).toEqual(canonical)
    }
  })

  it('breaks a tie by canonical row id ascending, not by arrival', () => {
    const forward = closestCapabilities('the identical scored text', TIED_ROWS, 2)
    const reversed = closestCapabilities('the identical scored text', [...TIED_ROWS].reverse(), 2)
    expect(forward).toEqual(['alias:zulu', 'op:zulu'])
    expect(reversed).toEqual(forward)
  })
})

describe('compareRowIds — code-unit order, never a locale collation', () => {
  it('orders by code unit, which is where a locale collation would disagree', () => {
    // 'Z' (U+005A) precedes 'a' (U+0061) by code unit; an en-locale collation puts 'a' first, so
    // this pair is the differential between the two comparisons rather than an example of one.
    expect(compareRowIds('skill:Zulu', 'skill:alpha')).toBeLessThan(0)
    expect('skill:Zulu'.localeCompare('skill:alpha')).toBeGreaterThan(0)

    expect(compareRowIds('op:a', 'op:b')).toBeLessThan(0)
    expect(compareRowIds('op:b', 'op:a')).toBeGreaterThan(0)
    expect(compareRowIds('op:a', 'op:a')).toBe(0)
  })

  it('is a total order — antisymmetric and transitive over a sampled id set', () => {
    const ids = ['op:a', 'op:B', 'alias:a', 'skill:Z', 'op:a-b', 'op:ab', 'skill:a']
    for (const left of ids) {
      for (const right of ids) {
        // `| 0` collapses -0 to 0: `Math.sign(0)` is +0 and `-Math.sign(0)` is -0, and `toBe` is
        // `Object.is`, which distinguishes them. The sign is the claim; the zero's sign is not.
        expect(Math.sign(compareRowIds(left, right)) | 0).toBe(
          -Math.sign(compareRowIds(right, left)) | 0,
        )
        for (const third of ids) {
          if (compareRowIds(left, right) < 0 && compareRowIds(right, third) < 0) {
            expect(compareRowIds(left, third)).toBeLessThan(0)
          }
        }
      }
    }
  })
})
