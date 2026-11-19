// Checks the words init uses for a saved subscription sign-in, under a pinned clock and zone.
import { describe, expect, it } from 'vitest'
import { readSignIn, type SignInClock } from '../commands/saved-sign-in.js'

const NOW = Date.UTC(2026, 10, 19, 6, 0)
const KOLKATA: SignInClock = { now: NOW, timeZone: 'Asia/Kolkata' }
const SIGNED_IN_AT = Date.UTC(2026, 10, 2, 20, 0)
const LATER_TODAY = Date.UTC(2026, 10, 19, 9, 0)
const YESTERDAY = Date.UTC(2026, 10, 18, 3, 42)

describe('the state of a saved sign-in', () => {
  it('reads valid and renewing while the token is unexpired and a refresh token is held', () => {
    expect(
      readSignIn({ renews: true, expires: LATER_TODAY, signedInAt: SIGNED_IN_AT }, KOLKATA),
    ).toEqual({ status: 'signed in 3 Nov 2026 · valid, renews itself' })
  })

  it('prints the sign-in day in the zone it is given', () => {
    expect(
      readSignIn(
        { renews: true, expires: LATER_TODAY, signedInAt: SIGNED_IN_AT },
        { now: NOW, timeZone: 'America/Los_Angeles' },
      ).status,
    ).toBe('signed in 2 Nov 2026 · valid, renews itself')
  })

  it('reads renews on next use once the token has expired and a refresh token is held', () => {
    expect(
      readSignIn({ renews: true, expires: YESTERDAY, signedInAt: SIGNED_IN_AT }, KOLKATA),
    ).toEqual({ status: 'signed in 3 Nov 2026 · renews on next use' })
  })

  it('gives the end of a sign-in that holds no refresh token while it is still valid', () => {
    expect(
      readSignIn({ renews: false, expires: LATER_TODAY, signedInAt: SIGNED_IN_AT }, KOLKATA),
    ).toEqual({ status: 'signed in 3 Nov 2026 · valid until 19 Nov 2026 14:30' })
  })

  it('reads expired, with the reason, once a sign-in with no refresh token has expired', () => {
    expect(
      readSignIn({ renews: false, expires: YESTERDAY, signedInAt: SIGNED_IN_AT }, KOLKATA),
    ).toEqual({
      status: 'expired 18 Nov 2026 09:12 · sign in again after setup',
      expired: 'the sign-in expired 18 Nov 2026 09:12',
    })
  })

  it('reads signed in with its day alone when the store holds no expiry', () => {
    expect(readSignIn({ renews: true, signedInAt: SIGNED_IN_AT }, KOLKATA)).toEqual({
      status: 'signed in 3 Nov 2026',
    })
  })

  it('reads signed in alone when the store holds neither an expiry nor a sign-in date', () => {
    expect(readSignIn({ renews: false }, KOLKATA)).toEqual({ status: 'signed in' })
  })

  it('leaves the day out when the store holds no sign-in date', () => {
    expect(readSignIn({ renews: true, expires: LATER_TODAY }, KOLKATA)).toEqual({
      status: 'signed in · valid, renews itself',
    })
  })

  it('counts a token that expires at this very moment as not expired', () => {
    expect(readSignIn({ renews: true, expires: NOW, signedInAt: SIGNED_IN_AT }, KOLKATA)).toEqual({
      status: 'signed in 3 Nov 2026 · valid, renews itself',
    })
    expect(readSignIn({ renews: false, expires: NOW, signedInAt: SIGNED_IN_AT }, KOLKATA)).toEqual(
      { status: 'signed in 3 Nov 2026 · valid until 19 Nov 2026 11:30' },
    )
  })

  it('prints midnight as 00:00', () => {
    expect(
      readSignIn(
        { renews: false, expires: Date.UTC(2026, 10, 19, 18, 30), signedInAt: SIGNED_IN_AT },
        KOLKATA,
      ).status,
    ).toBe('signed in 3 Nov 2026 · valid until 20 Nov 2026 00:00')
  })

  it('prints September as Sep', () => {
    expect(
      readSignIn(
        { renews: true, expires: LATER_TODAY, signedInAt: Date.UTC(2026, 8, 10, 12, 0) },
        KOLKATA,
      ).status,
    ).toBe('signed in 10 Sep 2026 · valid, renews itself')
  })
})
