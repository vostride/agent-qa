import { describe, expect, expectTypeOf, it } from 'vitest'

import type { FactSubtype } from '../../delta/envelope'
import type { Anchor } from '../../identity/anchor'
import { normalizeAnchor } from '../../identity/normalize-anchor'
import type { ScopeKey } from '../../identity/scope-key'
import {
  BUNDLE_ID_HASH_SUFFIX_LENGTH,
  BUNDLE_SLUG_MAX_LENGTH,
  bundleSlug,
  computeBundleIdentityHash,
  computeStepSequenceSignature,
  deriveDiscriminantKey,
  mintBundleId,
  type BundleIdentityCore,
  type BundleIdentityInput,
} from '../content-address'

const productScope: ScopeKey = { tier: 'product', key: 'shop' }
const cartAnchor: Anchor = { t: 'el', role: 'button', name: 'Cart' }

type ElementFactSubtype = Exclude<FactSubtype, 'measurement'>

function elementFactIdentity(subtype: ElementFactSubtype): BundleIdentityInput {
  return {
    kind: 'fact',
    subtype,
    primaryAnchor: cartAnchor,
    scope: productScope,
    discriminantKey: deriveDiscriminantKey({
      kind: 'fact',
      subtype,
      elementRef: { role: 'button', name: 'Cart' },
    }),
  }
}

function withDiscriminant(
  core: Omit<BundleIdentityInput, 'discriminantKey'>,
  discriminantKey: string,
): BundleIdentityInput {
  return { ...core, discriminantKey }
}

describe('bundle content address', () => {
  it('preserves legacy policy keys and separates actual Supersede generations', () => {
    const policy = { kind: 'policy', ruleKey: ' Review Rule ' } as const
    expect(deriveDiscriminantKey(policy)).toBe('{"kind":"policy","ruleKey":"review rule"}')
    const key = (token: string) => deriveDiscriminantKey({ ...policy, validityWindowEvidenceToken: token })
    expect(key('policy-materialize:first')).toBe(key('policy-materialize:first'))
    expect(key('policy-materialize:first')).not.toBe(key('policy-materialize:second'))
    expect(key('policy-materialize:first')).not.toBe(deriveDiscriminantKey(policy))
  })
  it('keys real fact supersession generations by evidence while preserving legacy keys', () => {
    const discriminant = { kind: 'fact', subtype: 'selector',
      elementRef: { role: 'button', name: 'Cart' } } as const
    const legacy = deriveDiscriminantKey(discriminant)
    expect(legacy).toBe('{"elementRef":{"name":"cart","role":"button"},"kind":"fact","subtype":"selector"}')
    const generation = (token: string) => mintBundleId({ ...elementFactIdentity('selector'),
      discriminantKey: deriveDiscriminantKey({ ...discriminant, validityWindowEvidenceToken: token }) })
    expect(generation('mark:first')).toBe(generation('mark:first'))
    expect(generation('mark:first')).not.toBe(generation('mark:second'))
    expect(generation('mark:first')).not.toBe(mintBundleId(elementFactIdentity('selector')))
    expect(deriveDiscriminantKey({ kind: 'fact', subtype: 'measurement', metricKey: 'load p95' }))
      .toBe('{"kind":"fact","metricKey":"load p95","subtype":"measurement"}')
  })

  it('is deterministic across repeated hash and id calls', () => {
    const core = elementFactIdentity('selector')
    const hashes = Array.from({ length: 5 }, () => computeBundleIdentityHash(core))
    const ids = Array.from({ length: 5 }, () => mintBundleId(core))

    expect(new Set(hashes).size).toBe(1)
    expect(new Set(ids).size).toBe(1)
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(ids[0]).toBe(`${bundleSlug(core.kind, core.primaryAnchor)}-${hashes[0]!.slice(0, 16)}`)
  })

  it('deduplicates badge-count anchor drift and raw versus pre-normalized anchors', () => {
    const discriminantKey = deriveDiscriminantKey({
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'button', name: 'Cart' },
    })
    const first = withDiscriminant(
      {
        kind: 'fact',
        subtype: 'selector',
        primaryAnchor: { t: 'el', role: 'BUTTON', name: 'Cart (3)' },
        scope: productScope,
      },
      discriminantKey,
    )
    const second = {
      ...first,
      primaryAnchor: { t: 'el' as const, role: 'button', name: 'Cart (7)' },
    }
    const preNormalized = { ...first, primaryAnchor: normalizeAnchor(first.primaryAnchor) }

    expect(computeBundleIdentityHash(first)).toBe(computeBundleIdentityHash(second))
    expect(mintBundleId(first)).toBe(mintBundleId(second))
    expect(computeBundleIdentityHash(first)).toBe(computeBundleIdentityHash(preNormalized))
  })

  it('structurally excludes prose and ignores draft summary/body changes', () => {
    type ProseIdentityKey = Extract<keyof BundleIdentityCore, 'title' | 'summary' | 'body'>
    expectTypeOf<ProseIdentityKey>().toEqualTypeOf<never>()

    const draftOne = {
      ...elementFactIdentity('behavioral'),
      summary: 'Clicking Cart opens the cart drawer.',
      body: 'Short distillation from one model.',
    }
    const draftTwo = {
      ...draftOne,
      summary: 'The cart control reveals the current basket.',
      body: 'A richer re-distillation from a more capable model.',
    }
    const identityFromDraft = (draft: typeof draftOne): BundleIdentityInput => ({
      kind: draft.kind,
      subtype: draft.subtype,
      primaryAnchor: draft.primaryAnchor,
      scope: draft.scope,
      discriminantKey: draft.discriminantKey,
    })

    expect(mintBundleId(identityFromDraft(draftOne))).toBe(
      mintBundleId(identityFromDraft(draftTwo)),
    )
  })

  it('keeps element facts distinct by subtype over the same anchor', () => {
    const subtypes: ElementFactSubtype[] = [
      'selector',
      'behavioral',
      'navigational',
      'content',
    ]
    const ids = subtypes.map((subtype) => mintBundleId(elementFactIdentity(subtype)))

    expect(new Set(ids).size).toBe(subtypes.length)
    expect(mintBundleId(elementFactIdentity('selector'))).not.toBe(
      mintBundleId(elementFactIdentity('behavioral')),
    )
  })

  it('keys measurement facts by metricKey', () => {
    const core = {
      kind: 'fact' as const,
      subtype: 'measurement' as const,
      primaryAnchor: { t: 'page' as const, route: '/checkout' },
      scope: productScope,
    }
    const first = withDiscriminant(
      core,
      deriveDiscriminantKey({ kind: 'fact', subtype: 'measurement', metricKey: 'load p95' }),
    )
    const sameNormalizedKey = withDiscriminant(
      core,
      deriveDiscriminantKey({ kind: 'fact', subtype: 'measurement', metricKey: ' LOAD   P95 ' }),
    )
    const differentMetric = withDiscriminant(
      core,
      deriveDiscriminantKey({ kind: 'fact', subtype: 'measurement', metricKey: 'load p50' }),
    )

    expect(mintBundleId(first)).toBe(mintBundleId(sameNormalizedKey))
    expect(mintBundleId(first)).not.toBe(mintBundleId(differentMetric))
  })

  it('keys cautions by normalized error strings', () => {
    const firstKey = deriveDiscriminantKey({
      kind: 'caution',
      errorKey: 'Timeout after 5000ms',
    })
    const secondKey = deriveDiscriminantKey({
      kind: 'caution',
      errorKey: ' timeout  after 3000ms ',
    })
    const first = withDiscriminant(
      {
        kind: 'caution',
        primaryAnchor: { t: 'error', message: 'Timeout after 5000ms' },
        scope: productScope,
      },
      firstKey,
    )
    const second = withDiscriminant(
      {
        ...first,
        primaryAnchor: { t: 'error', message: 'Timeout after 3000ms' },
      },
      secondKey,
    )

    expect(firstKey).toBe(secondKey)
    expect(mintBundleId(first)).toBe(mintBundleId(second))
  })

  it('keys unknowns by a sorted, deduplicated conflict-record set', () => {
    const firstKey = deriveDiscriminantKey({
      kind: 'unknown',
      conflictRecordIds: ['record-b', 'record-a', 'record-a'],
    })
    const secondKey = deriveDiscriminantKey({
      kind: 'unknown',
      conflictRecordIds: ['record-a', 'record-b'],
    })
    const core = {
      kind: 'unknown' as const,
      primaryAnchor: { t: 'page' as const, route: '/checkout' },
      scope: productScope,
    }

    expect(firstKey).toBe(secondKey)
    expect(mintBundleId(withDiscriminant(core, firstKey))).toBe(
      mintBundleId(withDiscriminant(core, secondKey)),
    )
  })

  it('keys policies by scope plus normalized ruleKey', () => {
    const ruleKey = deriveDiscriminantKey({ kind: 'policy', ruleKey: ' Dismiss Cookie Banner ' })
    const sameRuleKey = deriveDiscriminantKey({
      kind: 'policy',
      ruleKey: 'dismiss  cookie banner',
    })
    const differentRuleKey = deriveDiscriminantKey({
      kind: 'policy',
      ruleKey: 'retain cookie banner',
    })
    const core = {
      kind: 'policy' as const,
      primaryAnchor: { t: 'page' as const, route: '/' },
      scope: productScope,
    }

    expect(ruleKey).toBe(sameRuleKey)
    expect(mintBundleId(withDiscriminant(core, ruleKey))).not.toBe(
      mintBundleId(
        withDiscriminant({ ...core, scope: { tier: 'suite', key: 'smoke' } }, ruleKey),
      ),
    )
    expect(mintBundleId(withDiscriminant(core, ruleKey))).not.toBe(
      mintBundleId(withDiscriminant(core, differentRuleKey)),
    )
  })

  it('changes procedure signatures and ids when ordered steps are reordered', () => {
    const firstSignature = computeStepSequenceSignature(['open-cart', 'checkout'])
    const reorderedSignature = computeStepSequenceSignature(['checkout', 'open-cart'])
    const core = {
      kind: 'procedure' as const,
      primaryAnchor: { t: 'flow' as const, name: 'Checkout' },
      scope: productScope,
    }
    const first = withDiscriminant(
      core,
      deriveDiscriminantKey({
        kind: 'procedure',
        flowName: 'Checkout',
        stepSignature: firstSignature,
      }),
    )
    const reordered = withDiscriminant(
      core,
      deriveDiscriminantKey({
        kind: 'procedure',
        flowName: 'Checkout',
        stepSignature: reorderedSignature,
      }),
    )

    expect(firstSignature).not.toBe(reorderedSignature)
    expect(mintBundleId(first)).not.toBe(mintBundleId(reordered))
  })

  it('mints a bounded, traversal-safe slug plus authoritative 16-hex suffix', () => {
    const core = withDiscriminant(
      {
        kind: 'fact',
        subtype: 'content',
        primaryAnchor: {
          t: 'el',
          role: 'BUTTON',
          name: `../../Cart\u0000\\ ${'very long '.repeat(12)}`,
        },
        scope: productScope,
      },
      deriveDiscriminantKey({
        kind: 'fact',
        subtype: 'content',
        elementRef: { role: 'button', name: 'Cart' },
      }),
    )
    const identityHash = computeBundleIdentityHash(core)
    const id = mintBundleId(core)
    const slug = id.slice(0, -(BUNDLE_ID_HASH_SUFFIX_LENGTH + 1))

    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}$/)
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug.length).toBeLessThanOrEqual(BUNDLE_SLUG_MAX_LENGTH)
    expect(id).toBe(`${slug}-${identityHash.slice(0, BUNDLE_ID_HASH_SUFFIX_LENGTH)}`)
    expect(slug).not.toContain('..')
    expect(slug).not.toContain('/')
    expect(slug).not.toContain('\\')
    expect(slug).not.toContain('\u0000')
  })
})
