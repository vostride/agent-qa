import { describe, expect, it } from 'vitest'

import {
  computeBundleIdentityHash,
  deriveDiscriminantKey,
  mintBundleId,
  type BundleIdentityInput,
} from '../../ids/content-address'
import { normalizeAnchor } from '../../identity/normalize-anchor'
import type { BundleManifest } from '../bundle-files'
import { verifyManifestIdentity } from '../manifest-identity'

type ManifestIdentity = Pick<BundleManifest, 'id' | 'identityHash' | 'identityCore'>

function makeGenuineManifest(): ManifestIdentity {
  const primaryAnchor = normalizeAnchor({ t: 'el', role: 'Button', name: 'Sign in' })
  const discriminantKey = deriveDiscriminantKey({
    kind: 'fact',
    subtype: 'selector',
    elementRef: { role: 'Button', name: 'Sign in' },
  })
  const identityInput: BundleIdentityInput = {
    kind: 'fact',
    subtype: 'selector',
    primaryAnchor,
    scope: { tier: 'product', key: 'fixture-storefront' },
    discriminantKey,
  }

  return {
    id: mintBundleId(identityInput),
    identityHash: computeBundleIdentityHash(identityInput),
    identityCore: {
      ...identityInput,
      subtype: identityInput.subtype ?? null,
    },
  }
}

function flipFirstHex(digest: string): string {
  return `${digest[0] === '0' ? '1' : '0'}${digest.slice(1)}`
}

function flipLastHex(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`
}

describe('verifyManifestIdentity', () => {
  it('accepts identity fields genuinely derived from the stored identity core', () => {
    expect(verifyManifestIdentity(makeGenuineManifest())).toEqual([])
  })

  it('names a different schema-valid identityHash', () => {
    const manifest = makeGenuineManifest()

    expect(verifyManifestIdentity({
      ...manifest,
      identityHash: flipFirstHex(manifest.identityHash),
    })).toEqual([expect.stringContaining('identityHash')])
  })

  it('names an id whose authoritative hash suffix disagrees with the identity core', () => {
    const manifest = makeGenuineManifest()

    expect(verifyManifestIdentity({
      ...manifest,
      id: flipLastHex(manifest.id),
    })).toEqual([expect.stringContaining('id')])
  })

  it('rejects a denormalized stored primary anchor even when its derived identity is unchanged', () => {
    const manifest = makeGenuineManifest()

    expect(verifyManifestIdentity({
      ...manifest,
      identityCore: {
        ...manifest.identityCore,
        primaryAnchor: { t: 'el', role: 'button', name: 'Sign in (3)' },
      },
    })).toEqual([expect.stringContaining('identityCore.primaryAnchor')])
  })

  it('accumulates every simultaneous identity violation', () => {
    const manifest = makeGenuineManifest()
    const violations = verifyManifestIdentity({
      ...manifest,
      id: flipLastHex(manifest.id),
      identityHash: flipFirstHex(manifest.identityHash),
      identityCore: {
        ...manifest.identityCore,
        primaryAnchor: { t: 'el', role: 'button', name: 'Sign in (3)' },
      },
    })

    expect(violations).toHaveLength(3)
    expect(violations[0]).toContain('identityCore.primaryAnchor')
    expect(violations[1]).toContain('identityHash')
    expect(violations[2]).toContain('id')
  })
})
