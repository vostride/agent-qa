// in ci and cloud the curation outcome line says what CI does with what
// it learns, a record kept as a candidate and never promoted, instead of "applied".

import { describe, expect, it } from 'vitest'

import { curationOutcomeLine } from '../curation/curation-tail.js'

describe('the curation outcome line in ci, cloud and local runs', () => {
  it('in ci the outcome line says the changes were recorded and never promoted', () => {
    expect(curationOutcomeLine({ executionContext: 'ci', committed: 1, downgraded: 0 }))
      .toBe('curation: 1 learned change(s) recorded, 0 kept proposed (ci runs never promote learned knowledge)')
    expect(curationOutcomeLine({ executionContext: 'ci', committed: 3, downgraded: 1 }))
      .toBe('curation: 2 learned change(s) recorded, 1 kept proposed (ci runs never promote learned knowledge)')
  })

  it('in cloud the outcome line names cloud and says the changes were never promoted', () => {
    expect(curationOutcomeLine({ executionContext: 'cloud', committed: 2, downgraded: 2 }))
      .toBe('curation: 0 learned change(s) recorded, 2 kept proposed (cloud runs never promote learned knowledge)')
  })

  it('a local run still reports what it applied to the knowledge root', () => {
    for (const executionContext of ['local-interactive', 'local-headless', undefined] as const) {
      expect(curationOutcomeLine({ executionContext, committed: 3, downgraded: 1 }))
        .toBe('curation: 2 learned change(s) applied, 1 kept proposed (local runs apply learned knowledge to the knowledge root)')
    }
  })
})
