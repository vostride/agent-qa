// The disclosure fragment scrub, measured where it is published: one untrusted fragment comes out
// with its control bytes replaced, its length capped with a visible mark, and quoted.

import { describe, expect, it } from 'vitest'

import {
  DISCLOSURE_FRAGMENT_MAX_LENGTH,
  DISCLOSURE_REPLACEMENT_CHARACTER,
  DISCLOSURE_TRUNCATION_MARK,
  scrubDisclosureFragment,
} from '../action-descriptor'

/** C0 and C1 together — the whole control range a terminal or a browser acts on. */
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Every byte class that can act on the channel, one per row.
 *
 * ENUMERATED RATHER THAN SAMPLED. Each row is a different mechanism — add a line, redraw a line,
 * erase the line above, break a line in a browser, reorder what a reader sees — and a corpus that
 * carried only the newline would certify a scrub that only handled newlines.
 */
const ACTING_BYTES: readonly { label: string; value: string }[] = [
  { label: 'newline', value: 'a\nb' },
  { label: 'carriage return', value: 'a\rb' },
  { label: 'ESC (introduces every CSI sequence)', value: 'a\u001b[2Kb' },
  { label: 'NUL', value: 'a\u0000b' },
  { label: 'C1 NEL', value: 'a\u0085b' },
  { label: 'line separator', value: 'a\u2028b' },
  { label: 'paragraph separator', value: 'a\u2029b' },
  { label: 'right-to-left override', value: 'a\u202eb' },
  { label: 'first strong isolate', value: 'a\u2068b' },
]

describe('scrubDisclosureFragment — an untrusted noun, safe on one line', () => {
  it.each(ACTING_BYTES)('replaces $label with a visible byte', ({ value }) => {
    const scrubbed = scrubDisclosureFragment(value)

    expect(scrubbed).not.toMatch(CONTROL_BYTES)
    expect(scrubbed).toContain(DISCLOSURE_REPLACEMENT_CHARACTER)
    // REPLACED, NOT DROPPED — the two neighbours survive, so the length tells the truth about
    // what was there. A dropped byte would leave `"ab"`, which reads as an ordinary name.
    expect(scrubbed).toContain('a')
    expect(scrubbed).toContain('b')
  })

  it('quotes the fragment so where an odd name ENDS is legible', () => {
    expect(scrubDisclosureFragment('checkout-staging')).toBe('"checkout-staging"')
  })

  it('caps a long fragment and marks the truncation', () => {
    const long = 'x'.repeat(DISCLOSURE_FRAGMENT_MAX_LENGTH + 50)
    const scrubbed = scrubDisclosureFragment(long)

    expect(scrubbed).toContain(DISCLOSURE_TRUNCATION_MARK)
    // The quotes and the mark are the only things beyond the cap.
    expect(scrubbed.length).toBe(DISCLOSURE_FRAGMENT_MAX_LENGTH + 3)
  })

  it('leaves a fragment exactly AT the cap unmarked — the boundary, both sides', () => {
    const exact = 'x'.repeat(DISCLOSURE_FRAGMENT_MAX_LENGTH)

    expect(scrubDisclosureFragment(exact)).toBe(`"${exact}"`)
    expect(scrubDisclosureFragment(exact)).not.toContain(DISCLOSURE_TRUNCATION_MARK)
  })

  it('an empty fragment is still a legible nothing rather than an invisible one', () => {
    expect(scrubDisclosureFragment('')).toBe('""')
  })
})

describe('the scrub is what `packages/schema` is allowed to be', () => {
  it('is pure — the same input answers the same thing, and no input is mutated', () => {
    const input = 'a\nb'

    expect(scrubDisclosureFragment(input)).toBe(scrubDisclosureFragment(input))
    expect(input).toBe('a\nb')
  })
})
