import { describe, expect, it } from 'vitest'

import { AUTHORING_LOOP_OUTCOMES } from '../authoring.js'

describe('the loop outcome vocabulary is closed and spelled once', () => {
  it('has exactly four outcomes, in declaration order', () => {
    expect(AUTHORING_LOOP_OUTCOMES).toEqual(['drafted', 'refused', 'repaired', 'stopped'])

    const RETIRED = 'find' + 'ing'
    expect((AUTHORING_LOOP_OUTCOMES as readonly string[]).includes(RETIRED)).toBe(false)
    expect((AUTHORING_LOOP_OUTCOMES as readonly string[]).includes('halted')).toBe(false)
  })
})
