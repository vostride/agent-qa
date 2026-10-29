// C439-FILE-COMPARE (439 D-17): the saved-file comparator keeps every separator, space, tab, blank
// line and line break; CRLF equals LF and one byte-order mark is ignored; the name is exact; the
// first difference is masked and each side windowed to FILE_DIFFERENCE_WINDOW characters.

import { describe, expect, it } from 'vitest'
import { FILE_DIFFERENCE_WINDOW, compareSavedFile } from '../file-compare.js'
import type { SavedFileExpectation } from '../file-compare.js'

const NAME = 'invoice-1042.csv'
const identity = (value: string) => value
const bytes = (text: string) => new TextEncoder().encode(text)

function compare(
  text: string,
  expected: string,
  match: SavedFileExpectation['match'] = 'exact',
  options: { name?: string; mask?: (value: string) => string; raw?: Uint8Array } = {},
) {
  return compareSavedFile({
    expected: { name: NAME, match, text: expected },
    name: options.name ?? NAME,
    bytes: options.raw ?? bytes(text),
    mask: options.mask ?? identity,
  })
}

function sides(difference: string | undefined): string[] {
  return [...(difference ?? '').matchAll(/«([^»]*)»/g)].map((match) => match[1]!)
}

describe('C439-FILE-COMPARE', () => {
  it('an exact match passes and any other character differs', () => {
    expect(compare('order,total\nORD-1001,42.50\n', 'order,total\nORD-1001,42.50\n')).toEqual({
      name: 'match',
      content: 'match',
    })
    expect(compare('order,total\nORD-1001,42.50\n', 'order,total\nORD-1001,42.5\n')).toMatchObject({
      content: 'differs',
      line: 2,
    })
  })

  it('lines match when each expected line is a whole file line, in order', () => {
    const file = 'order,total\nORD-1001,42.50\nORD-1002,17.00\n'
    expect(compare(file, 'ORD-1001,42.50\nORD-1002,17.00', 'lines').content).toBe('match')
    expect(compare(file, 'order,total\nORD-1002,17.00', 'lines').content).toBe('match')
    expect(compare(file, 'ORD-1001', 'lines')).toMatchObject({ content: 'differs', line: 2 })
  })

  it('a tab, a double space, a blank line and a trailing separator each matter', () => {
    expect(compare('a\tb\n', 'a b\n').content).toBe('differs')
    expect(compare('a  b\n', 'a b', 'lines').content).toBe('differs')
    expect(compare('a\nb\n', 'a\n\nb', 'lines').content).toBe('differs')
    expect(compare('a\n\nb\n', 'a\n\nb', 'lines').content).toBe('match')
    expect(compare('ORD-1001,42.50,\n', 'ORD-1001,42.50', 'lines').content).toBe('differs')
    expect(compare('ORD-1001,42.50\n', 'ORD-1001,42.50').content).toBe('differs')
  })

  it('CRLF and LF are one line break', () => {
    expect(compare('order,total\r\nORD-1001,42.50\r\n', 'order,total\nORD-1001,42.50\n').content).toBe('match')
    expect(compare('order,total\r\nORD-1001,42.50\r\n', 'ORD-1001,42.50', 'lines').content).toBe('match')
    expect(compare('a\rb\n', 'a\nb\n').content).toBe('differs')
  })

  it('one leading byte-order mark is ignored', () => {
    expect(compare('﻿order,total\n', 'order,total\n').content).toBe('match')
    expect(compare('﻿﻿order,total\n', 'order,total\n').content).toBe('differs')
  })

  it('two rows merged into one line differ, and so does a single-newline merge', () => {
    const merged = compare('order,total\nORD-1001,42.50 ORD-1002,17.00\n', 'ORD-1001,42.50\nORD-1002,17.00', 'lines')
    expect(merged).toMatchObject({ content: 'differs', line: 2 })
    expect(merged.firstDifference).toBe('line 2: expected «ORD-1001,42.50» found «ORD-1001,42.50 ORD-1002,17.00»')
    const joined = compare('ORD-1001,42.50ORD-1002,17.00\n', 'ORD-1001,42.50\nORD-1002,17.00', 'lines')
    expect(joined).toMatchObject({ content: 'differs', line: 1 })
    expect(compare('ORD-1001,42.50ORD-1002,17.00\n', 'ORD-1001,42.50\nORD-1002,17.00\n').content).toBe('differs')
  })

  it("the same lines out of order differ for 'lines'", () => {
    const file = 'ORD-1001,42.50\nORD-1002,17.00\n'
    expect(compare(file, 'ORD-1002,17.00\nORD-1001,42.50', 'lines').content).toBe('differs')
  })

  it('the name is case-sensitive and includes the extension', () => {
    expect(compare('x', 'x', 'exact', { name: 'Invoice-1042.csv' })).toEqual({ name: 'differs', content: 'unverified' })
    expect(compare('x', 'x', 'exact', { name: 'invoice-1042.txt' }).name).toBe('differs')
    expect(compare('x', 'x', 'exact', { name: 'invoice-1042' }).name).toBe('differs')
    expect(compare('x', 'y', 'none')).toEqual({ name: 'match', content: 'unverified' })
  })

  it('an empty expected text matches only a zero-byte file', () => {
    expect(compare('', '').content).toBe('match')
    expect(compare('', '', 'lines').content).toBe('match')
    expect(compare('\n', '').content).toBe('differs')
    expect(compare('﻿', '', 'exact').content).toBe('differs')
    expect(compare(' ', '', 'lines').content).toBe('differs')
  })

  it('bytes that are not held or not UTF-8 leave the content unverified', () => {
    expect(compareSavedFile({
      expected: { name: NAME, match: 'exact', text: 'x' },
      name: NAME,
      bytes: undefined,
      mask: identity,
    })).toEqual({ name: 'match', content: 'unverified' })
    expect(compare('', 'x', 'exact', { raw: new Uint8Array([0xff, 0xfe, 0xfd]) })).toEqual({
      name: 'match',
      content: 'unverified',
    })
  })

  it('an email in the differing line is masked in the first difference', () => {
    const mask = (value: string) => value.replace(/[\w.]+@[\w.]+/g, '<EMAIL_0>')
    const result = compare('owner,ana@shop.test,closed\n', 'owner,ana@shop.test,open\n', 'exact', { mask })
    expect(result.content).toBe('differs')
    expect(result.firstDifference).toBe('line 1: expected «owner,<EMAIL_0>,open» found «owner,<EMAIL_0>,closed»')
    expect(result.firstDifference).not.toContain('ana@shop.test')
    expect(compare('owner,ana@shop.test\n', 'owner,<EMAIL_0>\n', 'exact', { mask }).content).toBe('match')
  })

  it('each side of the first difference is at most 80 characters', () => {
    const head = 'x'.repeat(150)
    const result = compare(`${head}A${'y'.repeat(150)}\n`, `${head}B${'y'.repeat(150)}\n`)
    const [expected, found] = sides(result.firstDifference)
    expect(expected!.length).toBeLessThanOrEqual(FILE_DIFFERENCE_WINDOW)
    expect(found!.length).toBeLessThanOrEqual(FILE_DIFFERENCE_WINDOW)
    expect(expected).toContain('B')
    expect(found).toContain('A')
    expect(expected!.startsWith('…') && expected!.endsWith('…')).toBe(true)
    const missing = compare('a\n', 'a\nb\n')
    expect(missing.firstDifference).toBe('line 2: expected «b» found «»')
  })
})
