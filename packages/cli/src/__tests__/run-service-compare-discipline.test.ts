// THE COMPARE DISCIPLINE, MEASURED RATHER THAN GREPPED (Phase 402 plan 06, D-05 · T-402-20).
//
// 2026-10-01 (432-21, D-12/D-13): RE-SPELLED. This file measured `matchServiceBearer`, the run
// service's bearer compare, and that module is deleted with the run-service tokens. The one secret
// compare the run service still depends on is the live-view link's signature check — the signed,
// short-lived, subject-bound token D-13 keeps — so the same discipline is measured there: the
// constant-time primitive is REACHED for a signature of the right width, exactly once per check, a
// wrong-width signature is refused without reaching it (and without throwing), and a tampered or
// foreign-key signature is refused.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `run-service-auth-hardening.test.ts`. It replaces
// `node:crypto` for the whole module graph it loads, which a file may do only if it loads almost
// nothing: the hardening suite boots a database, a dashboard host and a TCP server, all of which
// hash. The hardening file states the same claim's SOURCE half.
//
// WHY A CALL COUNT AND NOT A SOURCE GREP. A count of `timingSafeEqual` INVOCATIONS observed at run
// time cannot be satisfied by an import, a comment, a JSDoc mention or a dead function: it is the
// number of times the constant-time primitive actually ran while a signature was being verified.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every `timingSafeEqual` invocation this file's module graph makes, in call order. */
const compareCalls: { length: number }[] = []

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      compareCalls.push({ length: a.byteLength })
      return actual.timingSafeEqual(a, b)
    },
  }
})

const { createEphemeralLiveUrlSigner } = await import('../composition/live-url-signer.js')

beforeEach(() => { compareCalls.length = 0 })
afterEach(() => { compareCalls.length = 0 })

describe('the constant-time compare is REACHED, once per signature check', () => {
  it('reaches the primitive exactly once for a matching signature', () => {
    const signer = createEphemeralLiveUrlSigner()
    const signature = signer.sign('run:r_alpha|handle:0|exp:1735689600000')
    expect(signer.equals(signature, signer.sign('run:r_alpha|handle:0|exp:1735689600000'))).toBe(true)
    // A `===` shortcut reads 0 here and stays green everywhere else, because the VERDICT is the
    // same either way.
    expect(compareCalls.length).toBe(1)
  })

  it('reaches the primitive exactly once for a same-width signature that does not match', () => {
    const signer = createEphemeralLiveUrlSigner()
    const genuine = signer.sign('run:r_alpha|handle:0')
    // Another subject, the same key: same width, different bytes — a forged subject.
    expect(signer.equals(genuine, signer.sign('run:r_bravo|handle:0'))).toBe(false)
    // Another key entirely: a link minted by another process does not validate here.
    expect(signer.equals(genuine, createEphemeralLiveUrlSigner().sign('run:r_alpha|handle:0'))).toBe(false)
    expect(compareCalls.length).toBe(2)
    // One compare per check, and every compare is over the full HMAC width.
    expect(new Set(compareCalls.map((call) => call.length))).toEqual(new Set([genuine.length]))
  })

  it('refuses a wrong-width signature WITHOUT reaching the primitive, and without throwing', () => {
    // `timingSafeEqual` THROWS on unequal lengths; a bare call would turn a malformed signature into
    // a crash on the refusal path. The width check refuses first.
    const signer = createEphemeralLiveUrlSigner()
    const genuine = signer.sign('run:r_alpha|handle:0')
    for (const tampered of ['', genuine.slice(0, -1), `${genuine}A`]) {
      expect(() => signer.equals(genuine, tampered)).not.toThrow()
      expect(signer.equals(genuine, tampered)).toBe(false)
    }
    expect(compareCalls.length).toBe(0)
  })

  it('is ONE compare per check and not two — a second compare site reads twice the check count', () => {
    const signer = createEphemeralLiveUrlSigner()
    for (const count of [1, 2, 3, 5]) {
      compareCalls.length = 0
      for (let i = 0; i < count; i += 1) {
        signer.equals(signer.sign(`run:r_${String(i)}`), signer.sign(`run:r_${String(i)}`))
      }
      expect(compareCalls.length).toBe(count)
    }
  })
})
