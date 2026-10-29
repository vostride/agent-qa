// The shared fill and clear comparator for web, Android and iOS.
//
// Provider- and storage-neutral: no driver and no node:* imports. Four verdicts, kept apart:
// - exact: the read-back equals the requested text;
// - normalized: the field only inserted characters from FILL_SEPARATORS, every typed character is
//   still there, in order, and no inserted space widened or joined a whitespace run;
// - mismatch: anything else, including lost, merged or trimmed whitespace, case changes and
//   truncation; it carries the self-correcting error;
// - unverified: nothing could be read back; not a failure, never presented as verified.
// A secure field is never exact: a non-empty fill read-back is unverified, an empty one is a
// mismatch; a secure clear that leaves text is a mismatch, and an empty or unreadable one is
// unverified (owner, 2026-10-09). Its meta carries length sentinels, never the value. A clear
// compares against the empty string.

import type { FillVerdict } from '@vostride/agent-qa-schema'
import type { FillRereadMeta } from './metadata.js'

export interface FillVerifyInput {
  expected: string
  actual: string | undefined
  secure: boolean
  verb?: 'fill' | 'clearText'
}

export interface FillVerifyResult {
  verdict: FillVerdict
  ok: boolean
  secure?: true
  meta?: FillRereadMeta
  selfCorrectingError?: string
}

export const FILL_SEPARATORS: ReadonlySet<string> = new Set([
  ' ',
  ' ',
  ' ',
  ' ',
  '-',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '.',
  '/',
])

export function compareFillReread(input: FillVerifyInput): FillVerifyResult {
  const { actual, secure } = input
  const expected = input.verb === 'clearText' ? '' : input.expected

  if (secure) {
    if (actual === undefined || (input.verb === 'clearText' && actual === '')) {
      return { verdict: 'unverified', ok: true, secure: true }
    }
    if (input.verb === 'clearText') {
      return { ...mismatch('<len:0>', `<len:${actual.length}>`, 'clearText'), secure: true }
    }
    const expectedSentinel = `<len:${expected.length}>`
    if (actual.length > 0) {
      return {
        verdict: 'unverified',
        ok: true,
        secure: true,
        meta: { expected: expectedSentinel, actual: expectedSentinel },
      }
    }
    return mismatch(expectedSentinel, `<len:${actual.length}>`, input.verb)
  }

  if (actual === undefined) return { verdict: 'unverified', ok: true }
  const meta: FillRereadMeta = { expected, actual }
  if (actual === expected) return { verdict: 'exact', ok: true, meta }
  if (expected !== '' && insertedSeparatorsOnly(expected, actual)) {
    return { verdict: 'normalized', ok: true, meta }
  }
  return mismatch(expected, actual, input.verb)
}

const SPACES: ReadonlySet<string> = new Set([' ', ' ', ' ', ' '])

// Greedy is exact here: a skipped read-back character must be a separator, so consuming the
// earliest equal character is never worse than skipping it. An inserted space must stand alone:
// one that widens or joins a whitespace run changed the typed whitespace, which is a mismatch.
function insertedSeparatorsOnly(expected: string, actual: string): boolean {
  const typed = Array.from(expected)
  const read = Array.from(actual)
  const inserted: boolean[] = []
  let i = 0
  for (const ch of read) {
    if (i < typed.length && ch === typed[i]) {
      i++
      inserted.push(false)
    } else if (FILL_SEPARATORS.has(ch)) {
      inserted.push(true)
    } else {
      return false
    }
  }
  if (i !== typed.length) return false
  return read.every(
    (ch, k) =>
      !(inserted[k] && SPACES.has(ch)) ||
      (!isWhitespace(read[k - 1]) && !isWhitespace(read[k + 1])),
  )
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch)
}

function mismatch(
  metaExpected: string,
  metaActual: string,
  verb: FillVerifyInput['verb'],
): FillVerifyResult {
  return {
    verdict: 'mismatch',
    ok: false,
    meta: { expected: metaExpected, actual: metaActual },
    selfCorrectingError:
      verb === 'clearText'
        ? `field still reads "${metaActual}" after clearing — re-observe and retry`
        : `field reads "${metaActual}" after typing "${metaExpected}" — re-observe and retry`,
  }
}
