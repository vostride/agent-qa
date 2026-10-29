// Gate 3, the D-14/D-16 behavior table (393-06, Task 3).
//
// Two lanes, and the receipt must say which one answered for each compared test. The FINGERPRINT
// lane is a set comparison with no threshold — D-14 is spec §6.3 verbatim, and conservatism lives
// in the normalizer rather than in a constant. The TEXT lane exists only for suite tests the
// derived index has no evidence for, over-flags toward "already covered" (the safe direction), and
// is the one place in this gate where a pinned number decides anything.
//
// The corpus texts below are copied verbatim from `fixtures/corpus/*.yaml` and
// `demo/init/tests/uat-381-local-form.yaml`. The near-duplicate draft was authored to mirror
// uat-381's anchors with cosmetically different wording; the accept control was authored not to.
// Those two are what the threshold has to separate, so they are what the tests measure it on.

import { describe, expect, it } from 'vitest'

import { ACCEPT_CONTROL_DRAFT, fakeFingerprintIndex } from './evidence-fixtures.js'
import {
  addsValueGate,
  TEXT_FALLBACK_SIMILARITY_THRESHOLD,
  textSimilarity,
} from '../adds-value.js'
import type { SuiteTextCorpusEntryLike } from '../ports.js'

const UAT_381 = {
  filePath: 'demo/init/tests/uat-381-local-form.yaml',
  testName: 'Sign in on the local account form',
  stepsText: [
    'Type "{{env:PROBE_USER}}" into the Username field',
    'Type "{{secret:PROBE_TOKEN}}" into the Password field',
    'Click the Submit button',
    'Verify the page says "Received!"',
  ],
} satisfies SuiteTextCorpusEntryLike

/** `fixtures/corpus/gate3-near-duplicate.yaml`, verbatim. */
const NEAR_DUPLICATE_DRAFT = {
  testName: 'Log in on the local account form',
  steps: [
    'Enter "bob" in the Username field',
    'Enter "correct-horse" in the Password field',
    'Press the Submit button',
    'Verify the page says "Received!"',
  ],
}

const ACCEPT_CONTROL_TEXT = {
  testName: ACCEPT_CONTROL_DRAFT.testName,
  steps: ACCEPT_CONTROL_DRAFT.steps,
}

const EMPTY_INDEX = fakeFingerprintIndex([])

describe('addsValueGate — the fingerprint lane', () => {
  it('passes on at least one element absent from the union, and NAMES it', () => {
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: ['el-username', 'el-heading'],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: ['el-username'] }]),
      textCorpus: [],
    })

    expect(result.pass).toBe(true)
    expect(result.finding.novelElements).toEqual(['el-heading'])
  })

  it('fails when every element the draft exercised is already in the union', () => {
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: ['el-username', 'el-password', 'el-submit', 'el-received'],
      index: fakeFingerprintIndex([{
        ...UAT_381,
        elements: ['el-username', 'el-password', 'el-submit', 'el-received'],
      }]),
      textCorpus: [],
    })

    expect(result.pass).toBe(false)
    expect(result.finding.novelElements).toEqual([])
  })

  it('marks every fingerprint-lane comparison as such, per compared test', () => {
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: ['el-heading'],
      index: fakeFingerprintIndex([
        { ...UAT_381, elements: ['el-username'] },
        { filePath: 'demo/init/tests/uat-381-ladder.yaml', testName: 'Ladder', elements: ['el-x'] },
      ]),
      textCorpus: [],
    })

    expect(result.finding.comparedTests.map((row) => row.lane)).toEqual([
      'fingerprint',
      'fingerprint',
    ])
    expect(result.finding.comparedTests).toHaveLength(2)
  })

  it('per-test `covered` means SUBSUMES the draft, not merely overlaps it', () => {
    // Found by a surviving mutant: swapping `every` for `some` in the per-test coverage check
    // changed no outcome, because every case so far had the two agreeing. They are different
    // claims, and the receipt publishes one of them — "this test already covers your draft" is
    // actionable, "this test touches something your draft also touches" is noise dressed as an
    // answer. The union-level verdict is unaffected either way, which is exactly why the
    // difference could hide.
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: ['el-a', 'el-b'],
      index: fakeFingerprintIndex([
        { filePath: 'suite/partial.yaml', testName: 'Touches only A', elements: ['el-a'] },
        { filePath: 'suite/whole.yaml', testName: 'Covers A and B', elements: ['el-a', 'el-b'] },
      ]),
      textCorpus: [],
    })

    const byName = new Map(result.finding.comparedTests.map((row) => [row.testName, row.covered]))
    expect(byName.get('Touches only A')).toBe(false)
    expect(byName.get('Covers A and B')).toBe(true)
    // The gate itself turns on the UNION, which holds both — the per-test rows explain, they do
    // not decide (D-14).
    expect(result.pass).toBe(false)
  })

  it('has no similarity threshold on the fingerprint lane — one novel element is enough', () => {
    // 19 of 20 elements shared, and the draft still adds value. A gate that scored overlap would
    // call this covered; D-14 says the answer is set membership, not proportion.
    const shared = Array.from({ length: 19 }, (_, index) => `el-${index}`)
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: [...shared, 'el-novel'],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: shared }]),
      textCorpus: [],
    })

    expect(result.pass).toBe(true)
    expect(result.finding.novelElements).toEqual(['el-novel'])
  })
})

describe('addsValueGate — the text fallback lane', () => {
  it('fails the gate when an evidence-less suite test is similar enough to the draft', () => {
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      // A novel element on the fingerprint lane: the fingerprint lane alone would PASS this draft.
      draftElements: ['el-novel'],
      index: EMPTY_INDEX,
      textCorpus: [UAT_381],
    })

    expect(result.pass).toBe(false)
    const row = result.finding.comparedTests.find((entry) => entry.filePath === UAT_381.filePath)
    expect(row?.lane).toBe('text')
    expect(row?.covered).toBe(true)
  })

  it('does not fail the gate on an evidence-less suite test the draft does not resemble', () => {
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: ['el-heading'],
      index: EMPTY_INDEX,
      textCorpus: [UAT_381],
    })

    expect(result.pass).toBe(true)
    const row = result.finding.comparedTests.find((entry) => entry.filePath === UAT_381.filePath)
    expect(row?.lane).toBe('text')
    expect(row?.covered).toBe(false)
  })

  it('separates the corpus near-duplicate from the corpus accept control', () => {
    // The pair the pinned constant exists to separate. Recording both scores here means a retune
    // has to look at the margin it is spending, not just at the case it is trying to rescue.
    const duplicateScore = textSimilarity(NEAR_DUPLICATE_DRAFT, UAT_381)
    const controlScore = textSimilarity(ACCEPT_CONTROL_TEXT, UAT_381)

    expect(duplicateScore).toBeGreaterThanOrEqual(TEXT_FALLBACK_SIMILARITY_THRESHOLD)
    expect(controlScore).toBeLessThan(TEXT_FALLBACK_SIMILARITY_THRESHOLD)
  })

  it('a score exactly AT the threshold reads as covered — ties fail the gate', () => {
    // Over-flagging toward "already covered" is the safe direction, so the boundary belongs on the
    // covered side. A strict `>` would hand the tie to the draft.
    const identical = {
      filePath: 'demo/init/tests/twin.yaml',
      testName: NEAR_DUPLICATE_DRAFT.testName,
      stepsText: NEAR_DUPLICATE_DRAFT.steps,
    }
    expect(textSimilarity(NEAR_DUPLICATE_DRAFT, identical)).toBe(1)

    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: ['el-novel'],
      index: EMPTY_INDEX,
      textCorpus: [identical],
    })
    expect(result.pass).toBe(false)
  })

  it('never puts a fingerprint-covered identity on the text lane', () => {
    // The text lane's population is the authored universe MINUS `coveredTests()`. If a host hands
    // over an identity that has evidence anyway, the lane with evidence answers — otherwise one
    // test would appear twice with two lanes and the receipt would contradict itself.
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: ['el-novel'],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: ['el-username'] }]),
      textCorpus: [UAT_381],
    })

    const rows = result.finding.comparedTests.filter((row) => row.filePath === UAT_381.filePath)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lane).toBe('fingerprint')
    expect(result.pass).toBe(true)
  })
})

describe('addsValueGate — lane precedence', () => {
  /**
   * An evidence-less sibling whose tokens are the draft's own, so `textSimilarity` returns 1.0 —
   * the strongest possible text-lane "covered" claim. Its identity is NOT in the fingerprint
   * index, so it stays on the degraded lane where D-16 put it.
   */
  const TEXT_TWIN: SuiteTextCorpusEntryLike = {
    filePath: 'demo/init/tests/text-twin.yaml',
    testName: NEAR_DUPLICATE_DRAFT.testName,
    stepsText: NEAR_DUPLICATE_DRAFT.steps,
  }

  it('the fingerprint lane DECIDES a pass over a text sibling that resembles the draft', () => {
    // The veto direction, which no case covered before this one: the primary lane has evidence and
    // says NOVEL, and a degraded-lane resemblance is recorded beside it. D-14 gives the verdict to
    // the lane with evidence; the text lane is a fallback for identities the index cannot speak
    // for, not a veto over the identities it can (D-16).
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: ['el-username', 'el-novel'],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: ['el-username'] }]),
      textCorpus: [TEXT_TWIN],
    })

    expect(result.pass).toBe(true)
    expect(result.finding.novelElements).toEqual(['el-novel'])

    // Recorded, not deciding: the sibling still carries its lane and its covered flag, because
    // D-16's value is the per-test attribution on the receipt — only the arithmetic moved.
    const twinRow = result.finding.comparedTests.find((row) => row.filePath === TEXT_TWIN.filePath)
    expect(twinRow?.lane).toBe('text')
    expect(twinRow?.covered).toBe(true)
    expect(textSimilarity(NEAR_DUPLICATE_DRAFT, TEXT_TWIN)).toBe(1)

    // The reason has to name the lane that answered, or a receipt cannot be audited for which
    // claim decided it.
    expect(result.reason).toContain('fingerprint lane')
    expect(result.reason).toContain('without deciding')
  })

  it('the fingerprint lane DECIDES a fail on union subsumption, never via the text sibling', () => {
    // The two-sided pin. Same populated index, same resembling sibling, but zero novel elements —
    // the reject direction the frozen `gate3-near-duplicate` vector rides. The verdict is the same
    // `false` either way, so only the REASON separates a fingerprint fact from a text-lane guess;
    // a receipt that blamed the 0.5 threshold here would be describing a comparison that did not
    // decide anything.
    const covering = ['el-username', 'el-password', 'el-submit', 'el-received']
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: covering,
      index: fakeFingerprintIndex([{ ...UAT_381, elements: covering }]),
      textCorpus: [TEXT_TWIN],
    })

    expect(result.pass).toBe(false)
    expect(result.finding.novelElements).toEqual([])
    expect(result.reason).toContain('already in the suite union')
    expect(result.reason).not.toContain('text fallback lane')
  })

  it('the text lane still DECIDES when the index is empty — the state it exists for', () => {
    const result = addsValueGate({
      draft: NEAR_DUPLICATE_DRAFT,
      draftElements: ['el-novel'],
      index: EMPTY_INDEX,
      textCorpus: [TEXT_TWIN],
    })

    expect(result.pass).toBe(false)
    expect(result.reason).toContain('text fallback lane')
  })
})

describe('addsValueGate — the empty suite', () => {
  it('passes trivially when the union AND the text corpus are both empty', () => {
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: ['el-heading'],
      index: EMPTY_INDEX,
      textCorpus: [],
    })

    expect(result.pass).toBe(true)
    expect(result.reason).toContain('empty')
  })

  it('passes trivially even with no draft evidence — everything is uncovered', () => {
    // The novel-element rule alone would answer `false` here, because an empty draft element set
    // has nothing absent from anything. Against a suite that covers nothing, that answer is wrong.
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: [],
      index: EMPTY_INDEX,
      textCorpus: [],
    })

    expect(result.pass).toBe(true)
  })

  it('does NOT pass trivially once the suite has any coverage at all', () => {
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: [],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: ['el-username'] }]),
      textCorpus: [],
    })

    expect(result.pass).toBe(false)
  })
})

describe('addsValueGate — a draft with no observed evidence', () => {
  it('reports FALSE against a covered suite, and says why (gate 3 is still answered)', () => {
    // The gate-1-failed case, named rather than emergent. A draft whose runs produced no succeeded
    // sub-actions has no elements, so nothing can be shown to be novel — and the honest answer is
    // "not shown to add value", not a default. The receipt has to say which of the two it is.
    const result = addsValueGate({
      draft: ACCEPT_CONTROL_TEXT,
      draftElements: [],
      index: fakeFingerprintIndex([{ ...UAT_381, elements: ['el-username'] }]),
      textCorpus: [],
    })

    expect(result.pass).toBe(false)
    expect(result.reason).toContain('no fingerprint elements')
  })
})

describe('textSimilarity', () => {
  it('is symmetric, and 1 only for identical token sets', () => {
    const a = { testName: 'Alpha beta', steps: ['gamma delta'] }
    const b = { filePath: 'f', testName: 'Beta alpha', stepsText: ['delta gamma'] }

    expect(textSimilarity(a, b)).toBe(1)
    expect(textSimilarity({ testName: 'Alpha', steps: [] }, b)).toBeLessThan(1)
  })

  it('is 0 between two texts sharing no token', () => {
    expect(textSimilarity(
      { testName: 'alpha', steps: ['beta'] },
      { filePath: 'f', testName: 'gamma', stepsText: ['delta'] },
    )).toBe(0)
  })

  it('treats two empty texts as unrelated rather than identical', () => {
    // 0/0 is not 1. An empty text corpus entry must not silently cover every draft.
    expect(textSimilarity(
      { testName: '', steps: [] },
      { filePath: 'f', testName: '', stepsText: [] },
    )).toBe(0)
  })
})
