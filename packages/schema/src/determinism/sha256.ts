const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

import { utf8Encode } from '../config-mutation/utf8'

function rightRotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

function hexWord(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * sha256 of RAW BYTES, hex — the one place this package's digest is computed.
 *
 * Split out of {@link sha256hex} rather than copied beside it, and the split is the whole point.
 * 395's config apply digests a file as it stands on disk while the proposal digested the same file
 * as it stood at proposal time, and the two halves must be one recipe over one representation: a
 * second implementation taking bytes is precisely 394's CR-02 defect class, where two halves of one
 * digest contract hashed different representations and agreed on every input anyone had tried.
 */
export function sha256hexBytes(input: Uint8Array): string {
  return digestBytes(Array.from(input))
}

export function sha256hex(input: string): string {
  return digestBytes(Array.from(utf8Encode(input)))
}

function digestBytes(bytes: number[]): string {
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000)
  const bitLengthLow = (bytes.length << 3) >>> 0

  bytes.push(0x80)
  while (bytes.length % 64 !== 56) {
    bytes.push(0)
  }

  bytes.push(
    (bitLengthHigh >>> 24) & 0xff,
    (bitLengthHigh >>> 16) & 0xff,
    (bitLengthHigh >>> 8) & 0xff,
    bitLengthHigh & 0xff,
    (bitLengthLow >>> 24) & 0xff,
    (bitLengthLow >>> 16) & 0xff,
    (bitLengthLow >>> 8) & 0xff,
    bitLengthLow & 0xff,
  )

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w: number[] = []

    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] = (
        (bytes[j] << 24) |
        (bytes[j + 1] << 16) |
        (bytes[j + 2] << 8) |
        bytes[j + 3]
      ) >>> 0
    }

    for (let i = 16; i < 64; i++) {
      const s0 = (rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0
      const s1 = (rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i++) {
      const s1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0
      const s0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const temp2 = (s0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(hexWord).join('')
}

export function sha256hex16(input: string): string {
  return sha256hex(input).slice(0, 16)
}
