// Both texts are masked first, so a placeholder the verifier saw compares equal.

import type { ConditionFileCheck } from '@vostride/agent-qa-schema'

/** The most characters of each side `firstDifference` shows. */
export const FILE_DIFFERENCE_WINDOW = 80

const WINDOW_LEAD = 20

export interface SavedFileExpectation {
  name: string
  /** 'none': the name only; 'exact': the whole text; 'lines': each line whole, in order. */
  match: 'none' | 'exact' | 'lines'
  text: string
}

export interface SavedFileComparison extends ConditionFileCheck {
  /** The 1-based file line of the first difference, when the content differs. */
  line?: number
}

function decode(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return normalize(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    return undefined
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function commonPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function windowed(text: string, from: number): string {
  if (text.length <= FILE_DIFFERENCE_WINDOW) return text
  const start = Math.max(0, Math.min(from - WINDOW_LEAD, text.length - FILE_DIFFERENCE_WINDOW))
  let slice = text.slice(start, start + FILE_DIFFERENCE_WINDOW)
  if (start > 0) slice = `…${slice.slice(1)}`
  if (start + FILE_DIFFERENCE_WINDOW < text.length) slice = `${slice.slice(0, -1)}…`
  return slice
}

function difference(
  line: number,
  expected: string | undefined,
  found: string | undefined,
): SavedFileComparison {
  const from = commonPrefix(expected ?? '', found ?? '')
  const want = expected === undefined ? 'end of text' : `«${windowed(expected, from)}»`
  const got = found === undefined ? 'end of file' : `«${windowed(found, from)}»`
  return {
    name: 'match',
    content: 'differs',
    firstDifference: `line ${String(line)}: expected ${want} found ${got}`,
    line,
  }
}

function compareExact(expected: string, found: string): SavedFileComparison {
  if (expected === found) return { name: 'match', content: 'match' }
  const want = expected.split('\n')
  const got = found.split('\n')
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) return difference(i + 1, want[i], got[i])
  }
  return difference(1, expected, found)
}

function compareLines(expected: string, found: string): SavedFileComparison {
  const want = linesOf(expected)
  const got = linesOf(found)
  let next = 0
  for (const line of want) {
    let at = -1
    for (let j = next; j < got.length; j++) {
      if (got[j] === line) {
        at = j
        break
      }
    }
    if (at >= 0) {
      next = at + 1
      continue
    }
    let near = -1
    for (let j = next; j < got.length; j++) {
      if (got[j].length > 0 && (got[j].includes(line) || line.includes(got[j]))) {
        near = j
        break
      }
    }
    const index = near >= 0 ? near : next
    return difference(index + 1, line, got[index])
  }
  return { name: 'match', content: 'match' }
}

/**
 * Compare a held download with the verifier's expectation. The name is exact (case and extension);
 * 'exact' needs the whole text, 'lines' each expected line as a whole file line in order, and an
 * empty expected text matches only a zero-byte file. `bytes` undefined, or bytes that are not valid
 * UTF-8, leave the content 'unverified'.
 */
export function compareSavedFile(input: {
  expected: SavedFileExpectation
  name: string
  bytes: Uint8Array | undefined
  mask: (value: string) => string
}): SavedFileComparison {
  const { expected, name, bytes, mask } = input
  const named = name === expected.name || name === mask(expected.name)
  if (!named) return { name: 'differs', content: 'unverified' }
  if (expected.match === 'none' || bytes === undefined) {
    return { name: 'match', content: 'unverified' }
  }
  const decoded = decode(bytes)
  if (decoded === undefined) return { name: 'match', content: 'unverified' }
  const found = mask(decoded)
  const want = mask(normalize(expected.text))
  if (expected.text === '') {
    return bytes.length === 0
      ? { name: 'match', content: 'match' }
      : difference(1, '', linesOf(found)[0])
  }
  return expected.match === 'exact' ? compareExact(want, found) : compareLines(want, found)
}
