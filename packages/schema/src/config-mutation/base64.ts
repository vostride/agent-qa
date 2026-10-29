// Vendored: `Buffer` and the platform base64 pair are host APIs this package may not name.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const REVERSE: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((character, index) => [character, index]),
)

export function base64Encode(bytes: Uint8Array): string {
  let out = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]

    out += ALPHABET[first >>> 2]
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]
    out += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]
    out += third === undefined ? '=' : ALPHABET[third & 0x3f]
  }

  return out
}

/**
 * Bytes back from base64, REFUSING anything that is not base64 rather than skipping it.
 *
 * A permissive decoder is the wrong shape here: the value being decoded is about to be written to
 * a person's config file and compared against a digest, so a character this codec cannot read is a
 * corrupted record and must say so where it is read — not silently become shorter content that
 * then fails a digest comparison nobody can explain.
 */
export function base64Decode(text: string): Uint8Array {
  const body = text.endsWith('==') ? text.slice(0, -2) : text.endsWith('=') ? text.slice(0, -1) : text
  const padding = text.length - body.length
  if (text.length % 4 !== 0 || padding > 2) {
    throw new TypeError(`base64Decode was handed a value whose length is not a base64 length`)
  }

  const bytes: number[] = []
  let accumulator = 0
  let bits = 0

  for (const character of body) {
    const value = REVERSE.get(character)
    if (value === undefined) {
      throw new TypeError(
        `base64Decode was handed ${JSON.stringify(character)}, which is not a base64 character`,
      )
    }
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >>> bits) & 0xff)
    }
  }

  return Uint8Array.from(bytes)
}
