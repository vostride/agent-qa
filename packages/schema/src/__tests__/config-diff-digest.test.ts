// The vendored differ's acceptance bar, and the raw-bytes digest law.
//
// WHAT MAKES EACH CELL RED, stated per cell rather than claimed for the file:
//
//   the round-trip cells      — a dropped line, a prefix on the wrong side, an off-by-one hunk
//                               start, a context group that ran off an end. Each of those renders a
//                               diff that reads correctly and describes a different change, which
//                               is the ONE failure mode a hand-rolled differ has and the reason the
//                               obligation is checked rather than asserted.
//   the digest-basis cell     — any decode/re-encode inserted between the caller's bytes and the
//                               digest (394's CR-02 class). It drives a byte sequence NO decoding
//                               round-trips, so a primitive that hashed `utf8Encode(utf8Decode(b))`
//                               answers a different hex string.
//   the shown-bytes cell      — a renderer whose output depends on the caller's enumeration order,
//                               which would make the D-19 byte comparison fail across two processes
//                               that read the same file set in different orders.
//   the empty-input refusal   — a primitive that silently rendered a file with no bytes on either
//                               side as an empty section, which is a proposal about nothing.

// 395-02 SPLIT THE FILE'S SUBJECT, and the split is worth stating so nobody adds a second copy of
// either half. THIS file is the vendored differ's round-trip corpus plus the primitive's basic
// contract. `config-mutation/__tests__/diff-digest.test.ts` is the EDGES 395-02 pinned — ordering
// under a byte-wise total order, the typed unchanged answer, the CRLF / non-NFC representation
// corpus and the unrenderable-difference refusal. Neither restates the other.

import { describe, expect, it } from 'vitest'

import { base64Decode, base64Encode } from '../config-mutation/base64'
import { EmptyConfigDiffFileError, renderConfigDiff } from '../config-mutation/diff-digest'
import type { ConfigDiffChanged, ConfigDiffResult } from '../config-mutation/diff-digest'
import { reconstructSides, toUnifiedHunks } from '../config-mutation/line-diff'
import { utf8Decode, utf8Encode } from '../config-mutation/utf8'
import { sha256hexBytes } from '../determinism/sha256'

/** Narrow to the arm that has bytes, failing the cell rather than the type check if it is not. */
function changed(result: ConfigDiffResult): ConfigDiffChanged {
  expect(result.outcome).toBe('changed')
  return result as ConfigDiffChanged
}

/**
 * The round trip, at FULL context so the hunks cover the whole file.
 *
 * Full context is what makes the rebuild total: with three lines of context a hunk legitimately
 * omits the untouched parts of a file, so a rebuild would be comparing against a fragment and could
 * not distinguish "correctly omitted" from "lost".
 */
function roundTrips(oldText: string, newText: string): { oldText: string; newText: string } {
  return reconstructSides(toUnifiedHunks(oldText, newText, Number.MAX_SAFE_INTEGER))
}

const CASES: readonly (readonly [name: string, oldText: string, newText: string])[] = [
  ['one line changed in the middle', 'a\nb\nc\nd\ne\n', 'a\nb\nCHANGED\nd\ne\n'],
  ['a line inserted', 'a\nb\nc\n', 'a\nb\nnew\nc\n'],
  ['a line removed', 'a\nb\nc\n', 'a\nc\n'],
  ['the first line changed', 'a\nb\nc\n', 'A\nb\nc\n'],
  ['the last line changed', 'a\nb\nc\n', 'a\nb\nC\n'],
  ['two changes far apart', Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n',
    Array.from({ length: 40 }, (_, i) => (i === 2 ? 'X' : i === 30 ? 'Y' : `l${i}`)).join('\n') + '\n'],
  ['two changes close together', 'a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n'],
  ['everything replaced', 'a\nb\nc\n', 'x\ny\nz\n'],
  ['empty to content', '', 'a\nb\n'],
  ['content to empty', 'a\nb\n', ''],
  ['no trailing newline on the new side', 'a\nb\n', 'a\nB'],
  ['no trailing newline on the old side', 'a\nB', 'a\nb\n'],
  ['no trailing newline on both sides', 'a\nb', 'a\nB'],
  ['CRLF line endings are content, not structure', 'a\r\nb\r\n', 'a\r\nB\r\n'],
  ['a blank line added', 'a\nb\n', 'a\n\nb\n'],
  ['duplicated lines, one removed', 'x\nx\nx\n', 'x\nx\n'],
]

describe('the vendored line differ describes the change it was rendered from', () => {
  for (const [name, oldText, newText] of CASES) {
    it(`rebuilds both sides: ${name}`, () => {
      expect(roundTrips(oldText, newText)).toEqual({ oldText, newText })
    })
  }

  it('is not vacuous: every case above really produced hunks unless the sides are equal', () => {
    for (const [name, oldText, newText] of CASES) {
      const hunks = toUnifiedHunks(oldText, newText, Number.MAX_SAFE_INTEGER)
      expect({ name, hunks: hunks.length > 0 }).toEqual({ name, hunks: oldText !== newText })
    }
  })

  it('an unchanged file produces no hunks at all — nothing to review is not an empty review', () => {
    expect(toUnifiedHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('each hunk header counts exactly the lines the hunk carries', () => {
    for (const [name, oldText, newText] of CASES) {
      for (const hunk of toUnifiedHunks(oldText, newText)) {
        const body = hunk.lines.filter((line) => !line.startsWith('\\'))
        expect({
          name,
          old: hunk.oldLines,
          new: hunk.newLines,
        }).toEqual({
          name,
          old: body.filter((line) => line.startsWith(' ') || line.startsWith('-')).length,
          new: body.filter((line) => line.startsWith(' ') || line.startsWith('+')).length,
        })
      }
    }
  })

  it('hunks never overlap and are emitted in ascending order', () => {
    const oldText = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') + '\n'
    const newText = Array.from({ length: 60 }, (_, i) => ([4, 5, 40].includes(i) ? `X${i}` : `l${i}`))
      .join('\n') + '\n'
    const hunks = toUnifiedHunks(oldText, newText)
    expect(hunks.length).toBeGreaterThan(1)
    for (let index = 1; index < hunks.length; index++) {
      const previous = hunks[index - 1]!
      const current = hunks[index]!
      expect(current.oldStart).toBeGreaterThan(previous.oldStart + previous.oldLines - 1)
    }
  })
})

describe('renderConfigDiff — the ONE primitive both halves of a config proposal call', () => {
  const oldBytes = utf8Encode('use:\n  timeout: 30s\n')
  const newBytes = utf8Encode('use:\n  timeout: 45s\n')

  it('digests RAW bytes, never a decoding of them', () => {
    // A byte sequence NO UTF-8 decoding round-trips: 0x80 is a bare continuation byte, so
    // `utf8Encode(utf8Decode(bytes))` is three bytes of U+FFFD and not this value.
    const undecodable = Uint8Array.from([0x61, 0x80, 0x62])
    expect(utf8Encode(utf8Decode(undecodable))).not.toEqual(undecodable)

    const rendered = renderConfigDiff([{ path: 'agent-qa.config.yaml', oldBytes: undecodable, newBytes }])
    expect(rendered.perFileDigests[0]?.oldDigest).toBe(sha256hexBytes(undecodable))
    // The negative half: had the primitive digested a decoding, this is the value it would answer.
    expect(rendered.perFileDigests[0]?.oldDigest)
      .not.toBe(sha256hexBytes(utf8Encode(utf8Decode(undecodable))))
  })

  it('renders the same bytes whatever order the caller enumerated the file set in', () => {
    const files = [
      { path: 'hooks.yaml', oldBytes: utf8Encode('h: 1\n'), newBytes: utf8Encode('h: 2\n') },
      { path: 'agent-qa.config.yaml', oldBytes, newBytes },
    ]
    const forwards = changed(renderConfigDiff(files))
    const backwards = changed(renderConfigDiff([...files].reverse()))
    expect(backwards.diffBytes).toEqual(forwards.diffBytes)
    expect(backwards.diffDigest).toBe(forwards.diffDigest)
    // And the order is the SORTED one rather than either enumeration.
    expect(forwards.perFileDigests.map((entry) => entry.path))
      .toEqual(['agent-qa.config.yaml', 'hooks.yaml'])
  })

  it('the stored digest is over exactly the stored bytes', () => {
    const rendered = changed(renderConfigDiff([{ path: 'agent-qa.config.yaml', oldBytes, newBytes }]))
    expect(rendered.diffDigest).toBe(sha256hexBytes(rendered.diffBytes))
  })

  it('names the change kind from which side has bytes', () => {
    expect(renderConfigDiff([{ path: 'a', newBytes }]).changes[0]?.changeKind).toBe('add')
    expect(renderConfigDiff([{ path: 'a', oldBytes }]).changes[0]?.changeKind).toBe('delete')
    expect(renderConfigDiff([{ path: 'a', oldBytes, newBytes }]).changes[0]?.changeKind).toBe('modify')
  })

  it('an add renders /dev/null on the old side, a delete on the new side', () => {
    expect(utf8Decode(changed(renderConfigDiff([{ path: 'a', newBytes }])).diffBytes))
      .toContain('--- /dev/null')
    expect(utf8Decode(changed(renderConfigDiff([{ path: 'a', oldBytes }])).diffBytes))
      .toContain('+++ /dev/null')
  })

  it('refuses a file with no bytes on either side BY NAME', () => {
    expect(() => renderConfigDiff([{ path: 'agent-qa.config.yaml' }]))
      .toThrow(EmptyConfigDiffFileError)
  })

  it('an unchanged file answers `unchanged` and carries no diff bytes at all', () => {
    const rendered = renderConfigDiff([{ path: 'a', oldBytes, newBytes: oldBytes }])
    expect(rendered.outcome).toBe('unchanged')
    expect('diffBytes' in rendered).toBe(false)
  })
})

describe('the vendored byte codecs round-trip', () => {
  it('base64 round-trips arbitrary bytes, including every length modulo three', () => {
    for (let length = 0; length < 12; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256)
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes)
    }
  })

  it('base64 refuses a value it cannot read rather than shortening it', () => {
    expect(() => base64Decode('!!!!')).toThrow(TypeError)
    expect(() => base64Decode('abc')).toThrow(TypeError)
  })

  it('utf8 round-trips text outside the basic plane', () => {
    const text = 'timeout: 45s — “quoted” — 🧪\n'
    expect(utf8Decode(utf8Encode(text))).toBe(text)
  })
})
