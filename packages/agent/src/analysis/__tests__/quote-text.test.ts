// Control characters are spelled as `\u00xx` escapes, because a raw ESC is invisible in review.

import { describe, expect, it } from 'vitest'

import { sanitizeQuoteText } from '../quote-text.js'

const ESC = '\u001b'
const BEL = '\u0007'
const NUL = '\u0000'

// A literal, not read off a fixture, so input and expectation cannot go wrong together.
const SEEDED_RED_399_QUOTE =
  'locator.click: Timeout 30000ms exceeded.\n'
  + 'Call log:\n'
  + `${ESC}[2m  - waiting for getByRole('button', { name: 'Close ad', exact: true }).first()`
  + `${ESC}[22m\n`

// Every non-control word of the raw quote, in order, on one line.
const SEEDED_RED_399_READABLE =
  'locator.click: Timeout 30000ms exceeded. Call log: - waiting for '
  + "getByRole('button', { name: 'Close ad', exact: true }).first()"

describe('sanitizeQuoteText — control sequences out, whitespace collapsed', () => {
  it('removes CSI/SGR sequences and collapses an embedded newline to one space', () => {
    expect(sanitizeQuoteText(`a${ESC}[2m b${ESC}[22m\nc`)).toBe('a b c')
  })

  it('renders the recorded seeded-red quote as the readable one-line form, verbatim', () => {
    const sanitized = sanitizeQuoteText(SEEDED_RED_399_QUOTE)

    expect(sanitized).toBe(SEEDED_RED_399_READABLE)
    // The meaning survives: nothing is truncated, so the reader still gets the locator.
    expect(sanitized).toContain('Close ad')
    expect(sanitized).not.toContain(ESC)
    expect(sanitized).not.toContain('\n')
  })

  it('removes an OSC sequence and bare C0 controls, collapses tabs and CRLF, and trims', () => {
    expect(sanitizeQuoteText(`${ESC}]0;title${BEL}ready`)).toBe('ready')
    expect(sanitizeQuoteText(`${ESC}]0;title${ESC}\\ready`)).toBe('ready')
    expect(sanitizeQuoteText(`bell${BEL} nul${NUL} `)).toBe('bell nul')
    expect(sanitizeQuoteText('  a\t\tb\r\nc  ')).toBe('a b c')
  })

  it('returns an already-clean quote byte-identical', () => {
    const clean = 'Error: element "Submit" not found'

    expect(sanitizeQuoteText(clean)).toBe(clean)
  })

  it('leaves a declared [secret:<name>] marker byte-identical — masking is never this function', () => {
    const marker = '[secret:PW_441]'
    const sanitized = sanitizeQuoteText(`token ${marker} rejected${ESC}[0m`)

    expect(sanitized).toContain(marker)
    expect(sanitized).toBe(`token ${marker} rejected`)
  })

  it('passes a <SECRET_n> placeholder through verbatim', () => {
    expect(sanitizeQuoteText(`auth header was <SECRET_1>${ESC}[22m`)).toBe(
      'auth header was <SECRET_1>',
    )
  })

  it('answers an empty and a control-only quote as the empty string, never a padded one', () => {
    expect(sanitizeQuoteText('')).toBe('')
    expect(sanitizeQuoteText(`${ESC}[2m${ESC}[22m\n\t`)).toBe('')
  })
})
