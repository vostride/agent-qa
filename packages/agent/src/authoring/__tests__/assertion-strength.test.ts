// Clause-level cases; cli's `corpus-static-gates.test.ts` runs the same check through the parser.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { StepClassificationRowSchema } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACTION_VERBS,
  ASSERTION_VERBS,
  CAPTURE_SIGNATURE_PATTERNS,
  ELEMENT_NOUNS,
  EXPECTED_STATE_TERMS,
  FUNCTION_WORDS,
  PAGE_WHOLE_NOUNS,
  VACUOUS_ASSERTION_PHRASES,
  assertionStrengthGate,
  classifyDraftSteps,
  evaluateAssertionStrength,
} from '../assertion-strength.js'

// Expected verdicts are read from disk, so no local copy can drift from the frozen table.
const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/corpus')

interface ExpectationsTable {
  drafts: Record<string, { expectedGates: { falsifiableAssertion: boolean } }>
}

const EXPECTATIONS = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'expectations.json'), 'utf8'),
) as ExpectationsTable

/**
 * Title-case every word OUTSIDE double-quoted spans.
 *
 * Quoted spans are left byte-identical on purpose: a quoted literal is the app's own content,
 * and recasing it would change WHAT the draft asserts rather than how the sentence is written.
 * The point of the walk is that the casing of the PROSE cannot move a verdict.
 */
function titleCaseOutsideQuotes(text: string): string {
  return text
    .split(/("[^"]*")/)
    .map((segment, index) => (
      index % 2 === 1 ? segment : segment.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    ))
    .join('')
}

function onlyRow(steps: readonly string[]) {
  const rows = classifyDraftSteps(steps)
  const row = rows[rows.length - 1]

  if (row === undefined) throw new Error('classifyDraftSteps returned no rows')
  return row
}

describe('classifyDraftSteps — role classification (clause (i))', () => {
  it('classifies a leading assertion verb as an assertion', () => {
    expect(onlyRow(['Verify the page says "Received!"']).role).toBe('assertion')
  })

  it('classifies a leading action verb as an action', () => {
    expect(onlyRow(['Type "alice" into the Username field']).role).toBe('action')
  })

  it('matches the assertion verb case-insensitively', () => {
    expect(onlyRow(['VERIFY the page says "Received!"']).role).toBe('assertion')
  })

  it('matches the leading verb EXACTLY, not as a prefix', () => {
    // `verifying` begins with a member and is not one. A prefix test would classify this as
    // an assertion and hand the gate a clause (i) it never earned.
    expect(onlyRow(['Verifying the page says "Received!"']).role).toBe('action')
  })

  it('matches the leading verb by POSITION-ANCHORED membership, not by occurrence anywhere', () => {
    // An element literally named "Verify" is an element, not an assertion. A contains-check
    // over the whole step would read this as an assertion with a quoted literal and PASS the
    // gate on a draft that asserts nothing.
    expect(onlyRow(['Type "alice" into the Verify field']).role).toBe('action')
  })

  it('never marks an action row falsifiable', () => {
    const row = onlyRow(['Click the "Back to the form" link'])

    expect(row.role).toBe('action')
    expect(row.falsifiable).toBe(false)
  })
})

describe('classifyDraftSteps — falsifiability (clause (ii))', () => {
  it('a quoted expected literal makes an assertion falsifiable', () => {
    const row = onlyRow(['Verify the page says "Received!"'])

    expect(row.falsifiable).toBe(true)
    expect(row.vacuityHit).toBeUndefined()
  })

  it('a named element plus an expected-state term makes an assertion falsifiable', () => {
    expect(onlyRow(['Verify the Submit button is disabled']).falsifiable).toBe(true)
  })

  it('an expected-state term with no named element is NOT falsifiable', () => {
    // `visible` is a member; nothing in the step says visible WHAT. Tune toward reject.
    expect(onlyRow(['Verify the content is visible']).falsifiable).toBe(false)
  })

  it('an assertion with neither a quoted literal nor an element+state is not falsifiable', () => {
    expect(onlyRow(['Verify everything worked']).falsifiable).toBe(false)
  })

  it('a vacuous assertion is still an assertion, and names the phrase it matched', () => {
    const row = onlyRow(['Verify the page loaded'])

    expect(row.role).toBe('assertion')
    expect(row.falsifiable).toBe(false)
    expect(row.vacuityHit).toBe('page loaded')
  })

  it('matches the vacuity lexicon EXACTLY on the remainder, never as a substring', () => {
    // The vacuous phrase appears inside a quoted literal. The step asserts concrete page
    // content and must stay falsifiable; a substring scan over the raw text rejects it.
    const row = onlyRow(['Verify the banner says "the page loaded"'])

    expect(row.vacuityHit).toBeUndefined()
    expect(row.falsifiable).toBe(true)
  })

  it('strips the leading article before matching the vacuity lexicon', () => {
    expect(onlyRow(['Verify that the page is displayed']).vacuityHit).toBe('page is displayed')
  })
})

describe('classifyDraftSteps — capture signatures', () => {
  it('flags a 32-char hex expected value and NAMES the pattern', () => {
    const row = onlyRow([
      'Verify the page shows the submission reference "3f9c1ab27d5e4086bb17c2e5a94d0f6b"',
    ])

    expect(row.falsifiable).toBe(false)
    expect(row.captureSignatureHits).toEqual(['long-hex'])
  })

  it('flags a UUID expected value', () => {
    const row = onlyRow(['Verify the request id is "3f9c1ab2-7d5e-4086-bb17-c2e5a94d0f6b"'])

    expect(row.falsifiable).toBe(false)
    expect(row.captureSignatureHits).toEqual(['uuid'])
  })

  it('flags an ISO-8601 timestamp expected value', () => {
    const row = onlyRow(['Verify the receipt shows "2026-08-10T04:15:00Z"'])

    expect(row.falsifiable).toBe(false)
    expect(row.captureSignatureHits).toEqual(['iso-8601-timestamp'])
  })

  it('flags an opaque session/token id expected value', () => {
    const row = onlyRow(['Verify the header shows "sess_9f2ba71cd4e8"'])

    expect(row.falsifiable).toBe(false)
    expect(row.captureSignatureHits).toEqual(['opaque-id'])
  })

  it('leaves a human-authored expected value alone', () => {
    const row = onlyRow(['Verify the page heading says "Local Form"'])

    expect(row.captureSignatureHits).toEqual([])
    expect(row.falsifiable).toBe(true)
  })

  it('applies capture patterns ONLY to assertion steps', () => {
    // An action legitimately TYPES machine-shaped content; that is not a weak oracle.
    const row = onlyRow(['Type "3f9c1ab27d5e4086bb17c2e5a94d0f6b" into the Token field'])

    expect(row.role).toBe('action')
    expect(row.captureSignatureHits).toEqual([])
  })
})

describe('classifyDraftSteps — tautology', () => {
  it('flags an assertion that restates a PRIOR action step\'s own literal', () => {
    const row = onlyRow([
      'Type "alice" into the Username field',
      'Verify the Username field contains "alice"',
    ])

    expect(row.role).toBe('assertion')
    expect(row.tautologyHit).toBe(true)
    expect(row.falsifiable).toBe(false)
  })

  it('does not flag a literal introduced AFTER the assertion', () => {
    // "prior" is the whole content of the rule: an assertion cannot restate what has not
    // happened yet, and an order-blind set would reject a legitimate pre-condition check.
    const row = classifyDraftSteps([
      'Verify the Username field contains "alice"',
      'Type "alice" into the Username field',
    ])[0]

    expect(row?.tautologyHit).toBeUndefined()
    expect(row?.falsifiable).toBe(true)
  })

  it('compares literals byte-for-byte, not case-insensitively', () => {
    const row = onlyRow([
      'Type "alice" into the Username field',
      'Verify the Username field contains "Alice"',
    ])

    expect(row.tautologyHit).toBeUndefined()
    expect(row.falsifiable).toBe(true)
  })
})

describe('classifyDraftSteps — mixed act-and-verify steps', () => {
  it('an assertion whose residue also names an action verb contributes no falsifiable assertion', () => {
    const row = onlyRow(['Verify the form is submitted and click the "Continue" button'])

    expect(row.role).toBe('assertion')
    expect(row.falsifiable).toBe(false)
  })

  it('a step that acts first and verifies second never classifies as an assertion at all', () => {
    const row = onlyRow(['Click Submit and verify it worked'])

    expect(row.role).toBe('action')
    expect(row.falsifiable).toBe(false)
  })

  it('does not read an action verb out of a QUOTED expected value', () => {
    // The literal the page must show happens to contain an action word. Scanning the raw
    // text would reject a perfectly concrete oracle.
    const row = onlyRow(['Verify the page says "Click here to continue"'])

    expect(row.falsifiable).toBe(true)
  })

  it('does not read a SEPARATOR out of a quoted expected value either', () => {
    // The stronger control: the literal carries both a separator and an action verb after
    // it, so a mixed scan over the raw step splits INSIDE the expected value and rejects a
    // single-verdict assertion. Only stripping quotes before the scan gets this right.
    const row = onlyRow(['Verify the page says "Saved, then click Continue"'])

    expect(row.falsifiable).toBe(true)
  })
})

describe('the concreteness relation — a page-whole SUBJECT is refused whatever else the sentence mentions', () => {
  // No step here quotes a span or trips another arm, so each cell reads only the concreteness arm.

  const VACUOUS_PAGE_CASINGS = [
    'Verify the page is visible',
    'Verify the Page is visible',
    'Verify The page is visible',
    'Verify The Page is visible',
    'Verify The Page Is Visible',
    'Verify THE PAGE IS VISIBLE',
  ] as const

  const NAMED_ELEMENT_CASINGS = [
    'Verify the submit button is disabled',
    'Verify the Submit button is disabled',
    'Verify The submit button is disabled',
    'Verify The Submit button is disabled',
    'Verify The Submit Button Is Disabled',
    'Verify THE SUBMIT BUTTON IS DISABLED',
  ] as const

  // Function-word padding does not turn a claim about the whole page into an element claim.
  const VACUOUS_PAGE_PADDINGS = [
    'Verify the page is not visible',
    'Verify the page is still visible',
    'Verify the page should be visible',
    'Verify the page will be visible',
    'Verify the page is not empty',
    'Verify that the content is now visible',
    'Verify the screen is not empty',
    'Verify the site was also visible',
  ] as const

  // THE CROSSING CELLS: padding under casing variation. Neither axis alone can satisfy these.
  const PADDED_CASINGS = [
    'Verify The Page Is Not Visible',
    'VERIFY THE PAGE SHOULD BE VISIBLE',
    'Verify the Page is still Visible',
    'VERIFY THE SCREEN IS NOT EMPTY',
  ] as const

  // THE ACCEPT DIRECTION of the same padding: a NAMED element beside the same function words must
  // survive. Without these, "refuse everything with `not` in it" would satisfy the loops above.
  const PADDED_NAMED_ELEMENTS = [
    'Verify the submit button is not visible',
    'Verify the username field is still empty',
    'Verify The Submit Button Is Not Visible',
  ] as const

  // An empty quoted capture asserts nothing, so it must not satisfy the concreteness arm.
  const EMPTY_LITERALS = [
    'Verify ""',
    'Verify the page shows ""',
    'Verify the page shows " "',
  ] as const

  // THE MEMBER-NOUN AXIS. One frame, every member of the lexicon in turn. The claim's SUBJECT is
  // the page in all 33 sentences and no member has a state asserted of it, so every one of them
  // must be refused. Built from the exported constant rather than a copied list: a lexicon change
  // moves the loop with it, and a member added tomorrow is tested the day it lands.
  const vacuousFrameNear = (noun: string) => `Verify the page is visible near the ${noun}`

  // The same axis with the member standing as a VERB rather than a noun. `tab` and `label` are
  // lexicon members; neither sentence names a thing in a state.
  const VERB_MEMBERS = [
    'Verify the page is visible so the user can tab through it',
    'Verify the page is visible when we label the release',
  ] as const

  // THE ACCEPT DIRECTION of the member-noun axis: a member that IS the subject of the state term
  // must still carry the claim. Without these, "refuse every sentence containing `page`" — or
  // simply "refuse everything" — would satisfy the three loops above.
  const SUBJECT_MEMBER_ACCEPTS = [
    'Verify the submit button is disabled',
    'Verify the banner is visible',
    'Verify the username field is still empty',
    'Verify The Submit Button Is Not Visible',
  ] as const

  // These vary only the subject noun's form: plurals, synonyms and compounds of page-whole nouns.

  // Generated from the exported refuser lexicon, so a membership change moves the loop with it.
  const pluralPageWholeFrame = (noun: string) =>
    `Verify the banner appears and the ${noun}s are visible`

  // PRESERVATION. The singular of the same frame, refused on BOTH sides of the fix: the enumerated
  // refuser stopped these by name, and the total rule still stops them by name one branch ahead of
  // the unknown-token stop. Its job is to red if the named refusal class is ever dropped.
  const singularPageWholeFrame = (noun: string) =>
    `Verify the banner appears and the ${noun} is visible`

  // DETECTOR. Page-whole subjects the seven-member set does not hold at all. A fixed list rather
  // than a generated one BECAUSE the point is precisely that these are non-members: no exported
  // constant can produce them, and generating them from one would test the opposite property.
  const UNLISTED_PAGE_WHOLE_SYNONYMS = [
    'window',
    'webpage',
    'view',
    'dashboard',
    'viewport',
    'document',
    'body',
    'application',
    'website',
    'ui',
  ] as const

  const unlistedSynonymFrame = (noun: string) =>
    `Verify the banner loads and the ${noun} is visible`

  // Accepted cost: `currently` and an unknown subject nearer the anchor stop the walk and refuse.
  const UNKNOWN_TOKEN_STOPS = [
    'Verify the submit button is currently visible',
    'Verify the button badge is visible',
  ] as const

  // The member sits left of the anchor, the side the walk reads, with a page-whole noun nearer.
  const memberLeftOfAnchorFrame = (noun: string) =>
    `Verify the ${noun} loads and the page is visible`

  // Prior actions keep their empty captures, so quoting a typed `""` again is a restatement.
  const RESTATED_EMPTY_CAPTURES = [
    {
      action: 'Type "" into the Username field',
      assertion: 'Verify the Username field is empty and shows ""',
    },
    {
      action: 'Type " " into the Username field',
      assertion: 'Verify the Username field is empty and shows " "',
    },
  ] as const

  it.each(VACUOUS_PAGE_CASINGS)('refuses the generic-page claim in every casing: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    // Arm attribution: the CONCRETENESS arm refused this, not the vacuity or capture arm. Without
    // these two lines a future vacuity-lexicon widening could carry the cell while the arm under
    // test rots underneath it.
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(NAMED_ELEMENT_CASINGS)('accepts the named-element claim in every casing: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })

    expect(result.pass).toBe(true)
    expect(result.falsifiableAssertionCount).toBe(1)
    expect(result.table[0]?.vacuityHit).toBeUndefined()
    expect(result.table[0]?.captureSignatureHits).toEqual([])
  })

  it.each(VACUOUS_PAGE_PADDINGS)('refuses the generic-page claim with a function word inserted: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    // Arm attribution: the CONCRETENESS arm refused this. An exact-match vacuity lexicon holds no
    // padded remainder, so without these two lines a vacuity-lexicon widening could carry the cell
    // while the arm under test stayed exactly as leaky as the verifier measured it.
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(PADDED_CASINGS)('refuses the padded generic-page claim under recasing too: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(PADDED_NAMED_ELEMENTS)('still accepts a NAMED element beside the same function words: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })

    expect(result.pass).toBe(true)
    expect(result.falsifiableAssertionCount).toBe(1)
    expect(result.table[0]?.vacuityHit).toBeUndefined()
    expect(result.table[0]?.captureSignatureHits).toEqual([])
  })

  it.each(EMPTY_LITERALS)('an EMPTY quoted literal never satisfies concreteness: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(ELEMENT_NOUNS)('refuses the page-subject claim however the sentence mentions a member: near the %s', (noun) => {
    const step = vacuousFrameNear(noun)
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    // Arm attribution: the CONCRETENESS arm refused this and nothing else fired. `page is visible
    // near the header` equals no vacuity member, quotes nothing, restates nothing.
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(VERB_MEMBERS)('refuses the page-subject claim when the member is a VERB: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it('refuses the page-subject claim with a member sixty spaces away: distance is not a defence', () => {
    // The degenerate end of the same axis. A rule that admits the claim because a member appears
    // ANYWHERE admits it here too; a rule that reads the state term's own subject cannot.
    const step = `Verify the page is visible${' '.repeat(60)}header`
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect(result.pass).toBe(false)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(SUBJECT_MEMBER_ACCEPTS)('still accepts a member that IS the subject of the state term: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })

    expect({ step, pass: result.pass }).toEqual({ step, pass: true })
    expect(result.falsifiableAssertionCount).toBe(1)
    expect(result.table[0]?.vacuityHit).toBeUndefined()
    expect(result.table[0]?.captureSignatureHits).toEqual([])
  })

  it.each(PAGE_WHOLE_NOUNS)('DETECTOR — refuses the PLURALIZED page-whole subject: %ss are visible', (noun) => {
    const step = pluralPageWholeFrame(noun)
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    // Arm attribution: the CONCRETENESS arm refused this and nothing else fired. The remainder
    // equals no vacuity member, quotes nothing, restates nothing, and `appears` is no action verb.
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(PAGE_WHOLE_NOUNS)('PRESERVATION — still refuses the SINGULAR page-whole subject by name: %s is visible', (noun) => {
    const step = singularPageWholeFrame(noun)
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(UNLISTED_PAGE_WHOLE_SYNONYMS)('DETECTOR — refuses an UNLISTED page-whole subject: the %s is visible', (noun) => {
    const step = unlistedSynonymFrame(noun)
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it('DETECTOR — refuses the HYPHENATED page-whole subject, which normalizes to one unknown token', () => {
    // `normalizeToken` strips non-letters, so `Web-Page` folds to a single token that is a member of
    // nothing. Under the enumerated refuser that made it invisible and the walk sailed past it; the
    // title casing is carried through because the leaked form the verifier measured was title-cased.
    const step = 'Verify The Banner Loads And The Web-Page Is Visible'
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(UNKNOWN_TOKEN_STOPS)('DETECTOR — stops FALSE on the first token outside the continue set: %s', (step) => {
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(ELEMENT_NOUNS)('PRESERVATION — refuses the page-subject claim with the member LEFT of the anchor: the %s loads', (noun) => {
    const step = memberLeftOfAnchorFrame(noun)
    const result = assertionStrengthGate({ steps: [step] })
    const row = result.table[0]

    expect({ step, pass: result.pass }).toEqual({ step, pass: false })
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(row?.role).toBe('assertion')
    expect(row?.falsifiable).toBe(false)
    expect(row?.vacuityHit).toBeUndefined()
    expect(row?.captureSignatureHits).toEqual([])
  })

  it.each(FUNCTION_WORDS)('PRESERVATION — every continue-set member really does bridge member to anchor: the banner %s visible', (word) => {
    // Each continue-set member must bridge member to anchor; the stop loop above pins the rest.
    const step = `Verify the banner ${word} visible`
    const result = assertionStrengthGate({ steps: [step] })

    expect({ step, pass: result.pass }).toEqual({ step, pass: true })
    expect(result.falsifiableAssertionCount).toBe(1)
    expect(result.table[0]?.vacuityHit).toBeUndefined()
    expect(result.table[0]?.captureSignatureHits).toEqual([])
  })

  it.each(RESTATED_EMPTY_CAPTURES)('refuses an assertion restating a prior EMPTY capture: $assertion', ({ action, assertion }) => {
    const row = onlyRow([action, assertion])

    expect(row.role).toBe('assertion')
    expect(row.tautologyHit).toBe(true)
    expect(row.falsifiable).toBe(false)
    expect(assertionStrengthGate({ steps: [action, assertion] }).pass).toBe(false)
  })

  it('restoring RAW captures does not over-reject: an assertion that quotes nothing is no tautology', () => {
    // Control: an empty prior capture does not poison an assertion that quotes nothing.
    const steps = ['Type "" into the Username field', 'Verify the username field is empty']
    const row = onlyRow(steps)

    expect(row.tautologyHit).toBeUndefined()
    expect(assertionStrengthGate({ steps }).pass).toBe(true)
  })

  it('the empty-literal filter TRIMS, it does not over-reject: a non-empty literal still decides', () => {
    // The control half of the pair above. `"0"` is one character of real expected content, and a
    // filter written as a falsiness test rather than a trim test would drop it.
    expect(assertionStrengthGate({ steps: ['Verify the page shows "0"'] }).pass).toBe(true)
  })

  it('a quoted literal decides in any casing, and the prose around it is never consulted', () => {
    // These short-circuit on a quoted literal, so they never reach the arm the casing loops read.
    expect(assertionStrengthGate({ steps: ['Verify the page says "Received!"'] }).pass).toBe(true)
    expect(assertionStrengthGate({ steps: ['Verify The Page Says "Received!"'] }).pass).toBe(true)
  })

  it('accepts the title-cased concrete assertions the two-sided-case rule falsely rejected', () => {
    // THE MEASURED FALSE REJECT, fixed rather than disclosed. The rule this group replaced required
    // the residue to carry BOTH a capital-initial and a lowercase-initial word, so these two steps —
    // each naming a real control in a binary observable state, in the title case the module's own
    // premise says LLM drafts commonly use — lost gate 4 while their prose-cased twins kept it.
    expect(assertionStrengthGate({ steps: ['Verify The Submit Button Is Disabled'] }).pass).toBe(true)
    expect(assertionStrengthGate({ steps: ['Verify The Username Field Is Empty'] }).pass).toBe(true)
  })

  it('an expected-state term with no element noun beside it is still refused', () => {
    expect(assertionStrengthGate({ steps: ['Verify the content is visible'] }).pass).toBe(false)
  })

  it('leaves the documented residual open on purpose: a lexicon MEMBER reads as an element name', () => {
    // THE RESIDUAL, pinned deliberately so closing it is a conscious retune rather than an accident.
    // A lexical check cannot know the PAGE: `banner` is an ELEMENT_NOUNS member, so this passes
    // whether or not the page has a banner. Membership decides that the word names a KIND of
    // element; nothing lexical can decide that this page holds one. Closing it needs the resolved
    // a11y evidence gate 3 works from, not a lexicon retune — and never a character-case test,
    // which is the shape that shipped two of the three prior defects.
    expect(assertionStrengthGate({ steps: ['Verify the banner is visible'] }).pass).toBe(true)
  })

  it('leaves the SECOND residual open on purpose: nearest-preceding is a subject PROXY, not syntax', () => {
    // THE OTHER RESIDUAL, pinned deliberately so closing it is a conscious change rather than an
    // accident. The relation reads the nearest set-noun to the left of a state term as that state's
    // subject, which it usually is and need not be. Here `banner` stands between the page-whole
    // subject head and `visible`, so the claim reads as a claim about the banner and passes — though
    // what the sentence asserts is that the PAGE is visible. Closing it needs a parse, not a lexicon,
    // which is a different class of tool from a deterministic hermetic membership check.
    expect(assertionStrengthGate({ steps: ['Verify the page with the banner is visible'] }).pass).toBe(true)
  })

  it('pays the WIDENED accepted cost: unlisted nouns, PLURALS as a class, six common nouns, and attachment', () => {
    // Accepted cost: unlisted element nouns, plurals and a nearer page-whole noun are refused.
    for (const step of [
      'Verify the widget is visible',
      'Verify the carousel is visible',
      'Verify the Login form is empty',
      'Verify the Form is empty',
      'Verify the form is empty',
      'Verify the Submit buttons are disabled',
      'Verify the error message is visible',
      'Verify the text is visible',
      'Verify the title is visible',
      'Verify the item is selected',
      'Verify the cell is empty',
      'Verify the card is visible',
      'Verify the header on the page is visible',
    ]) {
      const row = onlyRow([step])

      expect({ step, pass: assertionStrengthGate({ steps: [step] }).pass }).toEqual({ step, pass: false })
      expect(row.vacuityHit).toBeUndefined()
    }

    // The ACCEPT side of the same price: the author's recovery route, and the singular whose plural
    // is refused two lines above. Without these the loop above is satisfied by refusing everything.
    expect(assertionStrengthGate({ steps: ['Verify the login field is empty'] }).pass).toBe(true)
    expect(assertionStrengthGate({ steps: ['Verify the Submit button is disabled'] }).pass).toBe(true)
  })
})

describe('classifyDraftSteps — the table', () => {
  it('emits exactly one row per input step, in order, with the text carried verbatim', () => {
    const steps = [
      'Type "alice" into the Username field',
      'Click the Submit button',
      'Verify the page says "Received!"',
    ]

    expect(classifyDraftSteps(steps).map((row) => row.stepText)).toEqual(steps)
  })

  it('omits the optional hit fields when they did not fire', () => {
    // The receipt schema is `.strict()`, and an always-present `tautologyHit: false` would
    // put a claim on every row that only two rows in the whole corpus earn.
    const row = onlyRow(['Type "alice" into the Username field'])

    expect(Object.hasOwn(row, 'vacuityHit')).toBe(false)
    expect(Object.hasOwn(row, 'tautologyHit')).toBe(false)
  })
})

describe('assertionStrengthGate — the two clauses composed', () => {
  it('fails clause (i): no step classifies as an assertion at all', () => {
    const result = assertionStrengthGate({
      steps: [
        'Type "alice" into the Username field',
        'Click the Submit button',
      ],
    })

    expect(result.pass).toBe(false)
    expect(result.assertionStepCount).toBe(0)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(result.reason).toContain('no step')
  })

  it('fails clause (ii): an assertion exists but none is falsifiable', () => {
    const result = assertionStrengthGate({
      steps: [
        'Click the Submit button',
        'Verify the page loaded',
      ],
    })

    expect(result.pass).toBe(false)
    expect(result.assertionStepCount).toBe(1)
    expect(result.falsifiableAssertionCount).toBe(0)
    expect(result.reason).toContain('page loaded')
  })

  it('passes when at least one assertion is falsifiable', () => {
    const result = assertionStrengthGate({
      steps: [
        'Type "alice" into the Username field',
        'Verify the page heading says "Local Form"',
      ],
    })

    expect(result.pass).toBe(true)
    expect(result.assertionStepCount).toBe(1)
    expect(result.falsifiableAssertionCount).toBe(1)
  })

  it('passes on ONE falsifiable assertion beside a vacuous one', () => {
    const result = assertionStrengthGate({
      steps: [
        'Verify the page loaded',
        'Verify the page says "Received!"',
      ],
    })

    expect(result.pass).toBe(true)
    expect(result.assertionStepCount).toBe(2)
    expect(result.falsifiableAssertionCount).toBe(1)
  })

  // The reason string is the only place a receipt shows that a step mixed act and verify.
  it('says a mixed act-and-verify step was mixed, rather than that it quoted nothing', () => {
    const result = assertionStrengthGate({
      steps: ['Verify the page says "Saved" and click Continue'],
    })

    expect(result.pass).toBe(false)
    expect(result.reason).toContain('acts and verifies in one step')
    // The false explanation this case exists to prevent. The step quotes "Saved".
    expect(result.reason).not.toContain('no quoted expected value')
  })

  it('still reports the no-concrete-content cause when that is genuinely why (clause (ii))', () => {
    // The fallback is not dead — it is the honest answer for an assertion that names nothing,
    // and this pairs with the case above so a fix to one cannot silently swallow the other.
    const result = assertionStrengthGate({ steps: ['Verify the content is correct'] })

    expect(result.pass).toBe(false)
    expect(result.reason).toContain('no quoted expected value')
    expect(result.reason).toContain('with only function words between them')
    expect(result.reason).not.toContain('acts and verifies in one step')
  })

  it('states the relation the walk decides, VERBATIM, on a step the stop refused', () => {
    // THE SECOND FALSE TAIL, pinned so a third cannot land quietly. The tail this replaced said no
    // element noun stood NEAREST the anchor among the walk's set-nouns — which is a durable false
    // statement about exactly this step, because `button` is an element noun and is the nearest such
    // noun before `visible`. The gate refuses this step because `currently` stands between them, not
    // because the sentence named nothing. The retired wording is described here rather than quoted,
    // so no greppable copy of it survives its own pin. The live tail is asserted VERBATIM rather
    // than by fragment: a fragment match is what let the previous tail drift out from under it.
    const result = assertionStrengthGate({ steps: ['Verify the submit button is currently visible'] })

    expect(result.pass).toBe(false)
    expect(result.reason).toBe(
      '1 assertion step(s), none falsifiable: no quoted expected value, and no element noun this gate knows stands before an expected-state term with only function words between them',
    )
  })

  it('never tells an author who NAMED an element that they named none', () => {
    // The receipt the plural author gets. `Verify the Submit buttons are disabled` loses gate 4 for
    // a real and disclosed reason — membership is exact, so `buttons` is not `button` — but the
    // durable explanation may not deny that the step named an element, because it did. The old tail
    // said exactly that; a tune-toward-reject gate cannot afford a false explanation, which is the
    // rule this file's mixed-step case above already enforces for the other fallback path.
    const result = assertionStrengthGate({ steps: ['Verify the Submit buttons are disabled'] })

    expect(result.pass).toBe(false)
    expect(result.reason).not.toContain('no named element in a checkable state')
    expect(result.reason).toContain('with only function words between them')
  })

  it('reports the same table classifyDraftSteps does', () => {
    const steps = ['Type "alice" into the Username field', 'Verify the page loaded']

    expect(assertionStrengthGate({ steps }).table).toEqual(classifyDraftSteps(steps))
  })

  it('is deterministic: the same steps give the same answer', () => {
    const steps = ['Type "alice" into the Username field', 'Verify the page says "Received!"']

    expect(assertionStrengthGate({ steps })).toEqual(assertionStrengthGate({ steps }))
  })

  it('an empty draft fails clause (i) rather than throwing', () => {
    expect(assertionStrengthGate({ steps: [] }).pass).toBe(false)
  })
})

describe('evaluateAssertionStrength — the frozen suite projection', () => {
  it('projects the gate boolean and the per-step table onto the frozen contract shape', () => {
    const steps = ['Type "alice" into the Username field', 'Verify the page loaded']
    const result = evaluateAssertionStrength(steps)

    expect(result.falsifiable).toBe(false)
    expect(result.steps.map((entry) => entry.text)).toEqual(steps)
    expect(result.steps.map((entry) => entry.kind)).toEqual(['action', 'assertion'])
    expect(result.steps.map((entry) => entry.captureSignatureHits)).toEqual([[], []])
  })

  it('agrees with assertionStrengthGate on every corpus draft (one projection, one answer)', () => {
    const steps = [
      'Type "alice" into the Username field',
      'Verify the page shows the submission reference "3f9c1ab27d5e4086bb17c2e5a94d0f6b"',
    ]

    expect(evaluateAssertionStrength(steps).falsifiable)
      .toBe(assertionStrengthGate({ steps }).pass)
  })
})

describe('the frozen corpus classes, by literal step text (4180c78b)', () => {
  const CORPUS: ReadonlyArray<{
    readonly draft: string
    readonly expected: boolean
    readonly steps: readonly string[]
  }> = [
    {
      draft: 'accept-control.yaml',
      expected: true,
      steps: [
        'Type "alice" into the Username field',
        'Verify the page heading says "Local Form"',
      ],
    },
    {
      draft: 'assertion-free.yaml',
      expected: false,
      steps: [
        'Type "alice" into the Username field',
        'Type "hunter2" into the Password field',
        'Click the Submit button',
        'Click the "Back to the form" link',
      ],
    },
    {
      draft: 'gate1-indefinitive.yaml',
      expected: true,
      steps: [
        'Open the Reports panel from the top navigation bar',
        'Click the Export report button',
        'Verify the export status banner says "Export complete"',
      ],
    },
    {
      draft: 'gate2-unstable.yaml',
      expected: true,
      steps: ['Verify the page shows the text "Username"'],
    },
    {
      draft: 'gate3-near-duplicate.yaml',
      expected: true,
      steps: [
        'Enter "bob" in the Username field',
        'Enter "correct-horse" in the Password field',
        'Press the Submit button',
        'Verify the page says "Received!"',
      ],
    },
    {
      draft: 'oracle-capture-signature.yaml',
      expected: false,
      steps: [
        'Type "alice" into the Username field',
        'Type "hunter2" into the Password field',
        'Click the Submit button',
        'Verify the page shows the submission reference "3f9c1ab27d5e4086bb17c2e5a94d0f6b"',
      ],
    },
    {
      draft: 'oracle-capture-tautology.yaml',
      expected: false,
      steps: [
        'Type "alice" into the Username field',
        'Verify the Username field contains "alice"',
      ],
    },
    {
      draft: 'page-loaded-only.yaml',
      expected: false,
      steps: [
        'Type "alice" into the Username field',
        'Type "hunter2" into the Password field',
        'Click the Submit button',
        'Click the "Back to the form" link',
        'Verify the page loaded',
      ],
    },
  ]

  it.each(CORPUS)('$draft → falsifiable=$expected', ({ expected, steps }) => {
    expect(evaluateAssertionStrength(steps).falsifiable).toBe(expected)
  })

  it('every inline `expected` above agrees with the frozen table, draft for draft', () => {
    // The literals in CORPUS are a convenience copy; expectations.json is the denominator.
    // This is the assertion that stops the copy from becoming a second answer.
    expect(Object.fromEntries(CORPUS.map((entry) => [entry.draft, entry.expected])))
      .toEqual(Object.fromEntries(
        Object.entries(EXPECTATIONS.drafts)
          .map(([draft, entry]) => [draft, entry.expectedGates.falsifiableAssertion]),
      ))
  })

  // Casing only: every true draft quotes a literal, so this walk never reaches the relation.
  it.each(CORPUS)('title-casing $draft — the frozen corpus is casing-insensitive (this walk cannot observe the concreteness relation)', ({ draft, steps }) => {
    const frozen = EXPECTATIONS.drafts[draft]?.expectedGates.falsifiableAssertion

    expect(frozen).toBeTypeOf('boolean')
    expect(assertionStrengthGate({ steps: steps.map(titleCaseOutsideQuotes) }).pass).toBe(frozen)
  })

  it('the walk actually recased something, and kept every assertion row an assertion', () => {
    // A no-op helper would make the walk above pass vacuously, which is the one failure mode a
    // case-insensitivity pin cannot afford. Seven of the eight drafts carry an assertion step;
    // `assertion-free.yaml` is the eighth and is walked too, because its frozen `false` must
    // survive recasing as well.
    const recased = CORPUS.filter((entry) =>
      entry.steps.some((step) => titleCaseOutsideQuotes(step) !== step))

    expect(recased).toHaveLength(CORPUS.length)

    for (const entry of CORPUS) {
      expect(classifyDraftSteps(entry.steps.map(titleCaseOutsideQuotes)).map((row) => row.role))
        .toEqual(classifyDraftSteps(entry.steps).map((row) => row.role))
    }
  })

  it('assertion-free classifies EVERY step as an action', () => {
    const draft = CORPUS.find((entry) => entry.draft === 'assertion-free.yaml')

    expect(classifyDraftSteps(draft?.steps ?? []).every((row) => row.role === 'action')).toBe(true)
  })

  it('page-loaded-only holds exactly one assertion row, and it is vacuous', () => {
    const draft = CORPUS.find((entry) => entry.draft === 'page-loaded-only.yaml')
    const assertions = classifyDraftSteps(draft?.steps ?? [])
      .filter((row) => row.role === 'assertion')

    expect(assertions).toHaveLength(1)
    expect(assertions[0]?.vacuityHit).toBe('page loaded')
  })

  it('every row of every draft survives the receipt schema at RUNTIME, not just at compile time', () => {
    // The strict schema refuses a stray key at runtime, which a type annotation cannot catch.
    for (const entry of CORPUS) {
      for (const row of classifyDraftSteps(entry.steps)) {
        expect(StepClassificationRowSchema.safeParse(row).success).toBe(true)
      }
    }
  })

  it('the two oracle-capture drafts fail for DIFFERENT recorded reasons', () => {
    const signature = CORPUS.find((entry) => entry.draft === 'oracle-capture-signature.yaml')
    const tautology = CORPUS.find((entry) => entry.draft === 'oracle-capture-tautology.yaml')

    const signatureRows = classifyDraftSteps(signature?.steps ?? [])
    const tautologyRows = classifyDraftSteps(tautology?.steps ?? [])

    expect(signatureRows.some((row) => row.captureSignatureHits.length > 0)).toBe(true)
    expect(signatureRows.some((row) => row.tautologyHit === true)).toBe(false)
    expect(tautologyRows.some((row) => row.tautologyHit === true)).toBe(true)
    expect(tautologyRows.some((row) => row.captureSignatureHits.length > 0)).toBe(false)
  })
})

describe('the lexicons are closed pinned sets', () => {
  it('every lexicon is frozen at its declared membership', () => {
    expect([...ASSERTION_VERBS]).toEqual(['assert', 'check', 'confirm', 'ensure', 'expect', 'verify'])
    expect([...VACUOUS_ASSERTION_PHRASES]).toEqual([
      'it works',
      'no errors',
      'no errors occurred',
      'page appears',
      'page displayed',
      'page is displayed',
      'page loaded',
      'page loads',
      'page works',
    ])
    expect([...EXPECTED_STATE_TERMS]).toEqual([
      'checked',
      'disabled',
      'empty',
      'enabled',
      'hidden',
      'selected',
      'unchecked',
      'visible',
    ])
    expect([...ACTION_VERBS]).toEqual([
      'click',
      'drag',
      'enter',
      'fill',
      'hover',
      'navigate',
      'open',
      'press',
      'scroll',
      'select',
      'submit',
      'type',
      'upload',
      'visit',
    ])
    expect([...ELEMENT_NOUNS]).toEqual([
      'alert',
      'banner',
      'button',
      'checkbox',
      'dialog',
      'dropdown',
      'field',
      'footer',
      'header',
      'heading',
      'icon',
      'image',
      'input',
      'label',
      'link',
      'list',
      'menu',
      'modal',
      'option',
      'panel',
      'popup',
      'radio',
      'row',
      'sidebar',
      'slider',
      'spinner',
      'tab',
      'table',
      'textbox',
      'toast',
      'toggle',
      'toolbar',
      'tooltip',
    ])
    expect([...PAGE_WHOLE_NOUNS]).toEqual([
      'app',
      'browser',
      'content',
      'form',
      'page',
      'screen',
      'site',
    ])
    expect([...FUNCTION_WORDS]).toEqual([
      'are',
      'be',
      'been',
      'being',
      'is',
      'not',
      'still',
      'was',
      'were',
    ])
    // An unrecognised token stops the walk, so an omission from any lexicon refuses, never accepts.
    for (const nonMember of PAGE_WHOLE_NOUNS) {
      expect({ nonMember, member: (ELEMENT_NOUNS as readonly string[]).includes(nonMember) })
        .toEqual({ nonMember, member: false })
    }
    expect(CAPTURE_SIGNATURE_PATTERNS.map((entry) => entry.name)).toEqual([
      'iso-8601-timestamp',
      'long-hex',
      'opaque-id',
      'uuid',
    ])
  })

  it('every lexicon is sorted and duplicate-free, so membership is the only reading', () => {
    const lexicons: ReadonlyArray<readonly string[]> = [
      ASSERTION_VERBS,
      VACUOUS_ASSERTION_PHRASES,
      EXPECTED_STATE_TERMS,
      ACTION_VERBS,
      ELEMENT_NOUNS,
      PAGE_WHOLE_NOUNS,
      FUNCTION_WORDS,
      CAPTURE_SIGNATURE_PATTERNS.map((entry) => entry.name),
    ]

    for (const lexicon of lexicons) {
      expect([...lexicon]).toEqual([...new Set(lexicon)].sort())
    }
  })

  it('the relation\'s four input sets are pairwise disjoint, so the walk has one answer per token', () => {
    // A token in two lexicons would answer two of the walk's questions, so the sets stay disjoint.
    const overlaps = (left: readonly string[], right: readonly string[]) =>
      left.filter((token) => right.includes(token))

    expect(overlaps(PAGE_WHOLE_NOUNS, ELEMENT_NOUNS)).toEqual([])
    expect(overlaps(PAGE_WHOLE_NOUNS, EXPECTED_STATE_TERMS)).toEqual([])
    expect(overlaps(ELEMENT_NOUNS, EXPECTED_STATE_TERMS)).toEqual([])
    expect(overlaps(FUNCTION_WORDS, ELEMENT_NOUNS)).toEqual([])
    expect(overlaps(FUNCTION_WORDS, PAGE_WHOLE_NOUNS)).toEqual([])
    expect(overlaps(FUNCTION_WORDS, EXPECTED_STATE_TERMS)).toEqual([])
  })

  it('no vacuity phrase survives as a falsifiable assertion, in any casing', () => {
    // Recasing a member changes nothing: the relation is casing-blind and `page` stops the walk.
    const titleCase = (phrase: string) =>
      phrase.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())

    for (const phrase of VACUOUS_ASSERTION_PHRASES) {
      for (const step of [`Verify ${phrase}`, `Verify the ${phrase}`, `Verify the ${titleCase(phrase)}`]) {
        expect({ step, falsifiable: onlyRow([step]).falsifiable }).toEqual({ step, falsifiable: false })
      }
      expect(onlyRow([`Verify the ${phrase}`]).vacuityHit).toBe(phrase)
    }
  })

  it('every capture-signature pattern is anchored at both ends', () => {
    // An unanchored pattern matches a substring of a longer human sentence, which is how a
    // machine-content heuristic starts rejecting prose.
    for (const entry of CAPTURE_SIGNATURE_PATTERNS) {
      expect(entry.pattern.source.startsWith('^')).toBe(true)
      expect(entry.pattern.source.endsWith('$')).toBe(true)
    }
  })
})
