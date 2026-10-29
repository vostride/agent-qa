// Both call sites hash raw bytes; a decode, line-ending fold or NFC step fails the cells below.

import { describe, expect, it } from 'vitest'

import { base64Decode, base64Encode } from '../base64'
import {
  CONFIG_DIFF_OUTCOMES,
  UnrenderableConfigDiffError,
  renderConfigDiff,
} from '../diff-digest'
import type { ConfigDiffChanged, ConfigDiffFileInput, ConfigDiffResult } from '../diff-digest'
import { utf8Decode, utf8Encode } from '../utf8'

function changed(result: ConfigDiffResult): ConfigDiffChanged {
  expect(result.outcome).toBe('changed')
  return result as ConfigDiffChanged
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The corpus. PRODUCED THROUGH THE PRIMITIVE, never written as a type literal, and every expected
// digest below is a hex string computed OUTSIDE this codebase (`hashlib.sha256` over the same byte
// list) rather than by calling the same function the primitive calls. A cell whose expectation came
// from the implementation's own recipe cannot tell a correct recipe from a consistently wrong one.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = 'agent-qa.config.yaml'

const LF_OLD = Uint8Array.from([117, 115, 101, 58, 10, 32, 32, 112, 97, 114, 97, 108, 108, 101, 108,
  58, 32, 102, 97, 108, 115, 101, 10])
const LF_OLD_SHA = '19b2238679b0640cc5ccb16d4a59b2e1f82e19e012ab29eb9736a459211c9d73'

/** `use:\r\n  parallel: true\r\n` — the same change a Windows checkout would produce. */
const CRLF_NEW = Uint8Array.from([117, 115, 101, 58, 13, 10, 32, 32, 112, 97, 114, 97, 108, 108,
  101, 108, 58, 32, 116, 114, 117, 101, 13, 10])
const CRLF_NEW_SHA = '964818db73295040edb4f77c01f68582bd2363a1532bfa2237f704dbf744b046'

/** The LF spelling of the SAME text. A line-ending fold on the digest path collapses these two. */
const LF_NEW = Uint8Array.from([117, 115, 101, 58, 10, 32, 32, 112, 97, 114, 97, 108, 108, 101, 108,
  58, 32, 116, 114, 117, 101, 10])
const LF_NEW_SHA = '07b6c40ed2fe41896a0938ae5ae3afcf40b633ca7eab6088d80a826a6214dd15'

/** `name: café\n` with a COMBINING acute (NFD): `e` + U+0301. */
const NFD_BYTES = Uint8Array.from([110, 97, 109, 101, 58, 32, 99, 97, 102, 101, 204, 129, 10])
const NFD_SHA = 'f48d84d27991eda765c8f4cc6e93dbc59408781fa73632acabaae5b8b0d1f872'

/** `name: café\n` with a PRECOMPOSED é (NFC). Canonically equivalent, different bytes. */
const NFC_BYTES = Uint8Array.from([110, 97, 109, 101, 58, 32, 99, 97, 102, 195, 169, 10])
const NFC_SHA = 'a62d7561732fd007f27e99cedab9d6eee3b750a8b816bdfad3de8e33fa18f9b9'

/** `a\n` then a lone 0xFF then `\n`. No decoding round-trips the 0xFF. */
const INVALID_UTF8 = Uint8Array.from([97, 10, 255, 10])
const INVALID_UTF8_SHA = 'ead0215fe443756c2739e50b368ff79c283d540214d4ef503350fa25103198be'

const A_ONLY = Uint8Array.from([97, 10])

// The two call sites: construction holds the bytes in memory, the apply decodes them from base64.

interface StoredProposal {
  readonly path: string
  readonly newContentBase64: string
  readonly shownDiffBase64: string
  readonly shownDiffDigest: string
  readonly baseDigest: string | undefined
}

/** What a construction pipeline does: render from the bytes it just read and the bytes it made. */
function constructionShapedCall(
  disk: ReadonlyMap<string, Uint8Array>,
  path: string,
  mutated: Uint8Array,
): { rendered: ConfigDiffChanged; stored: StoredProposal } {
  const oldBytes = disk.get(path)
  const input: ConfigDiffFileInput = { path, ...(oldBytes === undefined ? {} : { oldBytes }), newBytes: mutated }
  const rendered = changed(renderConfigDiff([input]))
  return {
    rendered,
    stored: {
      path,
      newContentBase64: base64Encode(mutated),
      shownDiffBase64: base64Encode(rendered.diffBytes),
      shownDiffDigest: rendered.diffDigest,
      baseDigest: rendered.perFileDigests[0]?.oldDigest,
    },
  }
}

/** What an apply does: re-read the file as it stands, decode the record, render again. */
function applyShapedCall(
  disk: ReadonlyMap<string, Uint8Array>,
  stored: StoredProposal,
): ConfigDiffChanged {
  const oldBytes = disk.get(stored.path)
  const newBytes = base64Decode(stored.newContentBase64)
  return changed(renderConfigDiff([{
    path: stored.path,
    ...(oldBytes === undefined ? {} : { oldBytes }),
    newBytes,
  }]))
}

describe('the diff primitive orders file sections by the path\'s UTF-8 bytes', () => {
  const files: ConfigDiffFileInput[] = [
    { path: 'z.yaml', oldBytes: A_ONLY, newBytes: LF_NEW },
    { path: 'hooks.yaml', oldBytes: A_ONLY, newBytes: LF_NEW },
    { path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_NEW },
  ]

  it('produces byte-identical output whatever order the caller enumerated the set in', () => {
    const forwards = changed(renderConfigDiff(files))
    const backwards = changed(renderConfigDiff([...files].reverse()))
    const shuffled = changed(renderConfigDiff([files[1]!, files[2]!, files[0]!]))
    expect(backwards.diffBytes).toEqual(forwards.diffBytes)
    expect(shuffled.diffBytes).toEqual(forwards.diffBytes)
    expect(new Set([forwards.diffDigest, backwards.diffDigest, shuffled.diffDigest]).size).toBe(1)
  })

  it('produces byte-identical output across repeated invocations of the same input', () => {
    const first = changed(renderConfigDiff(files))
    const second = changed(renderConfigDiff(files))
    expect(second.diffBytes).toEqual(first.diffBytes)
    expect(second.diffDigest).toBe(first.diffDigest)
    expect(second.perFileDigests).toEqual(first.perFileDigests)
  })

  it('sorts by path, and the sections appear in the diff in that same order', () => {
    const rendered = changed(renderConfigDiff(files))
    expect(rendered.perFileDigests.map((entry) => entry.path))
      .toEqual([CONFIG_PATH, 'hooks.yaml', 'z.yaml'])
    const text = utf8Decode(rendered.diffBytes)
    expect(text.indexOf(`--- a/${CONFIG_PATH}`)).toBeLessThan(text.indexOf('--- a/hooks.yaml'))
    expect(text.indexOf('--- a/hooks.yaml')).toBeLessThan(text.indexOf('--- a/z.yaml'))
  })

  it('orders by UTF-8 bytes where that DISAGREES with JavaScript string order', () => {
    // U+10000 encodes as four bytes starting 0xF0; U+F000 as three starting 0xEF. So UTF-8 puts the
    // astral path SECOND. JavaScript's `<` compares UTF-16 code units, and the astral character's
    // leading surrogate is 0xD800 — below 0xF000 — so `<` puts it FIRST. This cell is that pair.
    const astral = `\u{10000}.yaml`
    const bmp = '.yaml'
    expect(astral < bmp).toBe(true)

    const rendered = changed(renderConfigDiff([
      { path: astral, oldBytes: A_ONLY, newBytes: LF_NEW },
      { path: bmp, oldBytes: A_ONLY, newBytes: LF_NEW },
    ]))
    expect(rendered.perFileDigests.map((entry) => entry.path)).toEqual([bmp, astral])
  })
})

describe('nothing changed is a typed answer, not an empty one', () => {
  it('names the two outcomes', () => {
    expect([...CONFIG_DIFF_OUTCOMES]).toEqual(['changed', 'unchanged'])
  })

  it('answers `unchanged` when every file holds the same bytes on both sides', () => {
    const rendered = renderConfigDiff([
      { path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_OLD },
      { path: 'hooks.yaml', oldBytes: A_ONLY, newBytes: A_ONLY },
    ])
    expect(rendered.outcome).toBe('unchanged')
  })

  it('the unchanged answer structurally carries no diff bytes to interpret', () => {
    const rendered = renderConfigDiff([{ path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_OLD }])
    expect('diffBytes' in rendered).toBe(false)
    expect('diffDigest' in rendered).toBe(false)
  })

  it('still reports the digests, because an apply still wants to say which file it read', () => {
    const rendered = renderConfigDiff([{ path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_OLD }])
    expect(rendered.perFileDigests).toEqual([
      { path: CONFIG_PATH, oldDigest: LF_OLD_SHA, newDigest: LF_OLD_SHA },
    ])
  })

  it('an empty file set is unchanged rather than a diff of nothing', () => {
    expect(renderConfigDiff([]).outcome).toBe('unchanged')
  })

  it('one changed file among unchanged ones is still `changed`', () => {
    const rendered = renderConfigDiff([
      { path: 'hooks.yaml', oldBytes: A_ONLY, newBytes: A_ONLY },
      { path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_NEW },
    ])
    expect(rendered.outcome).toBe('changed')
    // And the unchanged file contributes no section — a review shows what changed.
    expect(utf8Decode(changed(rendered).diffBytes)).not.toContain('hooks.yaml')
  })
})

describe('a difference that renders as nothing is refused, not shown', () => {
  // 0x80 and 0xFF are both bytes NO decoding round-trips, so both decode to U+FFFD and the two
  // files read as the same text. Their bytes, and their digests, differ.
  const lone80 = Uint8Array.from([0x80, 0x0a])
  const loneFF = Uint8Array.from([0xff, 0x0a])

  it('the hazard is real: the two sides decode to the same text', () => {
    expect(utf8Decode(lone80)).toBe(utf8Decode(loneFF))
    expect(lone80).not.toEqual(loneFF)
  })

  it('refuses BY NAME rather than returning an empty diff for changed bytes', () => {
    expect(() => renderConfigDiff([{ path: CONFIG_PATH, oldBytes: lone80, newBytes: loneFF }]))
      .toThrow(UnrenderableConfigDiffError)
  })

  it('the refusal names every path it applies to', () => {
    let paths: readonly string[] = []
    try {
      renderConfigDiff([
        { path: 'hooks.yaml', oldBytes: lone80, newBytes: loneFF },
        { path: CONFIG_PATH, oldBytes: lone80, newBytes: loneFF },
      ])
    } catch (error) {
      paths = (error as UnrenderableConfigDiffError).paths
    }
    expect([...paths]).toEqual([CONFIG_PATH, 'hooks.yaml'])
  })

  it('does not fire when the bytes are equal — that is `unchanged`, not a refusal', () => {
    expect(renderConfigDiff([{ path: CONFIG_PATH, oldBytes: lone80, newBytes: lone80 }]).outcome)
      .toBe('unchanged')
  })
})

describe('the representation corpus — raw bytes, both call sites', () => {
  it('the CRLF corpus member digests the bytes it was handed, carriage returns and all', () => {
    const rendered = changed(renderConfigDiff([
      { path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: CRLF_NEW },
    ]))
    expect(rendered.perFileDigests[0]?.newDigest).toBe(CRLF_NEW_SHA)
    expect(rendered.perFileDigests[0]?.oldDigest).toBe(LF_OLD_SHA)
  })

  it('the CRLF and LF spellings of one text are two different files', () => {
    expect(CRLF_NEW_SHA).not.toBe(LF_NEW_SHA)
    const crlf = changed(renderConfigDiff([{ path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: CRLF_NEW }]))
    const lf = changed(renderConfigDiff([{ path: CONFIG_PATH, oldBytes: LF_OLD, newBytes: LF_NEW }]))
    expect(crlf.perFileDigests[0]?.newDigest).not.toBe(lf.perFileDigests[0]?.newDigest)
    expect(crlf.diffDigest).not.toBe(lf.diffDigest)
  })

  it('the non-NFC corpus member digests the bytes it was handed, decomposition and all', () => {
    const rendered = changed(renderConfigDiff([
      { path: CONFIG_PATH, oldBytes: A_ONLY, newBytes: NFD_BYTES },
    ]))
    expect(rendered.perFileDigests[0]?.newDigest).toBe(NFD_SHA)
  })

  it('the two canonically-equivalent unicode forms are two different files', () => {
    // They compare equal after normalisation and unequal as bytes — which is exactly the pair a
    // normalising digest path would collapse, and exactly the pair an apply must not confuse.
    expect(utf8Decode(NFD_BYTES).normalize('NFC')).toBe(utf8Decode(NFC_BYTES).normalize('NFC'))
    expect(NFD_SHA).not.toBe(NFC_SHA)
    const nfd = changed(renderConfigDiff([{ path: CONFIG_PATH, oldBytes: A_ONLY, newBytes: NFD_BYTES }]))
    const nfc = changed(renderConfigDiff([{ path: CONFIG_PATH, oldBytes: A_ONLY, newBytes: NFC_BYTES }]))
    expect(nfd.perFileDigests[0]?.newDigest).toBe(NFD_SHA)
    expect(nfc.perFileDigests[0]?.newDigest).toBe(NFC_SHA)
  })

  it('an invalid-UTF-8 sequence digests as itself and does not throw', () => {
    const rendered = changed(renderConfigDiff([
      { path: CONFIG_PATH, oldBytes: A_ONLY, newBytes: INVALID_UTF8 },
    ]))
    expect(rendered.perFileDigests[0]?.newDigest).toBe(INVALID_UTF8_SHA)
    // The render may be lossy for such a file; the digest and the stored bytes may not.
    expect(utf8Decode(rendered.diffBytes)).toContain('�')
  })

  for (const [name, mutated, expectedSha] of [
    ['CRLF', CRLF_NEW, CRLF_NEW_SHA],
    ['non-NFC unicode', NFD_BYTES, NFD_SHA],
    ['invalid UTF-8', INVALID_UTF8, INVALID_UTF8_SHA],
  ] as const) {
    it(`construction and apply agree byte for byte: ${name}`, () => {
      const disk = new Map([[CONFIG_PATH, LF_OLD]])
      const { rendered, stored } = constructionShapedCall(disk, CONFIG_PATH, mutated)
      const recomputed = applyShapedCall(disk, stored)

      expect(recomputed.diffBytes).toEqual(rendered.diffBytes)
      expect(recomputed.diffDigest).toBe(stored.shownDiffDigest)
      expect(recomputed.perFileDigests).toEqual(rendered.perFileDigests)
      // And the digest both halves agree on is the one an outside authority computes.
      expect(recomputed.perFileDigests[0]?.newDigest).toBe(expectedSha)
      expect(recomputed.perFileDigests[0]?.oldDigest).toBe(LF_OLD_SHA)
      // The transport did not perturb the bytes either.
      expect(base64Decode(stored.newContentBase64)).toEqual(mutated)
      expect(base64Decode(stored.shownDiffBase64)).toEqual(rendered.diffBytes)
      expect(stored.baseDigest).toBe(LF_OLD_SHA)
    })
  }

  it('is not vacuous: a doctored stored payload makes the two halves disagree', () => {
    const disk = new Map([[CONFIG_PATH, LF_OLD]])
    const { stored } = constructionShapedCall(disk, CONFIG_PATH, CRLF_NEW)
    // Widen the payload by one byte, the tampering the comparison exists for.
    const doctored = {
      ...stored,
      newContentBase64: base64Encode(utf8Encode(`${utf8Decode(CRLF_NEW)}# added\r\n`)),
    }
    expect(applyShapedCall(disk, doctored).diffDigest).not.toBe(stored.shownDiffDigest)
  })
})
