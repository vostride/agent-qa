// The loop outcome vocabulary, pinned by exact list (411 D-04).
//
// A HAND-MAINTAINED CENSUS, and the reason it stays hand-maintained: every generic consumer of
// `AUTHORING_LOOP_OUTCOMES` reads it generically. The op's output schema declares
// `z.enum(AUTHORING_LOOP_OUTCOMES)`, 396's MCP projection advertises whatever that object holds and
// 397's parity walk digests it — so a fourth word re-spelled, or a fifth member added and never
// decided about, moves a digest and REDS NOTHING BY NAME. A `.toEqual` over an authored literal is
// the only cell that reds for it, and it is the site this phase had to update by hand when the
// fourth word changed with the Issue-slot cleanup.
//
// The rejected half is built from two halves for the reason the arch census cells build theirs
// that way: this file is scanned as a source, and a cell spelling the retired word literally would
// be a hit in the very census it exists beside.

import { describe, expect, it } from 'vitest'

import { AUTHORING_LOOP_OUTCOMES } from '../authoring.js'

describe('the loop outcome vocabulary is closed and spelled once', () => {
  it('has exactly four outcomes, in declaration order', () => {
    expect(AUTHORING_LOOP_OUTCOMES).toEqual(['drafted', 'refused', 'repaired', 'stopped'])

    // The rejected half of the pair, kept as values the vocabulary does not carry: the fourth
    // word's retired spelling, and the near-synonym 411 D-01 considered and did not take.
    const RETIRED = 'find' + 'ing'
    expect((AUTHORING_LOOP_OUTCOMES as readonly string[]).includes(RETIRED)).toBe(false)
    expect((AUTHORING_LOOP_OUTCOMES as readonly string[]).includes('halted')).toBe(false)
  })
})
