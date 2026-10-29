// The vendored UTF-8 codec.
//
// THE SCHEMA PACKAGE HAS NO HOST APIs. The platform's own text encoder, `Buffer` and the global
// object are all refused by `__tests__/module-discipline.test.ts` — which scans SOURCE TEXT, so
// naming them here would red it too. The one string<->bytes edge this package needs is therefore
// vendored, beside the vendored sha256, the same posture `determinism/sha256.ts` already takes
// about hashing rather than reaching for a platform digest API.
//
// THIS IS THE ONLY ENCODER IN THE PACKAGE. `sha256hex` reaches it too, so a string hashed and a
// string diffed are turned into bytes by one recipe. A second encoder beside this one is exactly
// the two-representations arrangement 394's CR-02 defect class is made of: two halves of one
// contract, each converting the same value its own way, agreeing until the first input that is not
// plain ASCII.
//
// THE DIGEST BASIS NEVER PASSES THROUGH HERE. Content digests are taken over the RAW bytes a file
// holds; this codec exists for the diff renderer's text edge and for the bytes a mutation
// produced as a string. Decoding a file in order to digest it would re-open CR-02 from the other
// side.

/** UTF-8 bytes for one string. Lone surrogates encode as U+FFFD, as every conformant encoder does. */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = []

  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index)

    if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        index++
      }
    }

    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }

  return Uint8Array.from(bytes)
}

/**
 * One string from UTF-8 bytes. Every malformed sequence becomes U+FFFD rather than throwing.
 *
 * REPLACEMENT IS NOT LOSSLESS AND IS NEVER TREATED AS IF IT WERE. This decode feeds the RENDERED
 * diff a person reads; it is not on the path any digest or any written byte takes. 394-23's
 * rollback is the recorded cost of confusing those two — it wrote U+FFFD back over every sequence
 * the decoder could not read, and called the result "restored".
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  let index = 0

  while (index < bytes.length) {
    const first = bytes[index]!
    let code: number
    let width: number

    if (first < 0x80) {
      code = first
      width = 1
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f
      width = 2
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f
      width = 3
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07
      width = 4
    } else {
      out += '�'
      index++
      continue
    }

    if (index + width > bytes.length) {
      out += '�'
      index++
      continue
    }

    let malformed = false
    for (let offset = 1; offset < width; offset++) {
      const next = bytes[index + offset]!
      if ((next & 0xc0) !== 0x80) {
        malformed = true
        break
      }
      code = (code << 6) | (next & 0x3f)
    }

    // Overlong forms, surrogate halves and out-of-range scalars are all malformed, and each is a
    // sequence a permissive decoder would turn into a character no encoder can produce.
    if (
      malformed
      || code > 0x10ffff
      || (code >= 0xd800 && code <= 0xdfff)
      || (width === 2 && code < 0x80)
      || (width === 3 && code < 0x800)
      || (width === 4 && code < 0x10000)
    ) {
      out += '�'
      index++
      continue
    }

    if (code > 0xffff) {
      const shifted = code - 0x10000
      out += String.fromCharCode(0xd800 + (shifted >>> 10), 0xdc00 + (shifted & 0x3ff))
    } else {
      out += String.fromCharCode(code)
    }
    index += width
  }

  return out
}
