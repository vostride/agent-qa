import { expectTypeOf, test } from 'vitest'
import type { Anchor, ScopeKey } from '../identity/index'

test('anchors and scope keys have fixed shapes, and a selector anchor carries no role or name', () => {
  type ElAnchor = Extract<Anchor, { t: 'el' }>
  expectTypeOf<ElAnchor>().toMatchTypeOf<{ role: string; name: string }>()
  expectTypeOf<ElAnchor['ordinal']>().toEqualTypeOf<number | undefined>()

  type PlatformAnchor = Extract<Anchor, { t: 'platform' }>
  expectTypeOf<PlatformAnchor['platform']>().toEqualTypeOf<'web' | 'android' | 'ios'>()

  type SelectorAnchor = Extract<Anchor, { t: 'selector' }>
  expectTypeOf<SelectorAnchor>().toMatchTypeOf<{ literal: string }>()
  expectTypeOf<keyof SelectorAnchor>().toEqualTypeOf<'t' | 'literal'>()

  // @ts-expect-error selector anchors carry lexical evidence only, not role/name identity.
  const badSelector: SelectorAnchor = { t: 'selector', literal: 'button.submit', role: 'button' }

  expectTypeOf<ScopeKey>().toEqualTypeOf<{
    tier: 'global' | 'product' | 'suite' | 'test'
    key: string
  }>()

  void badSelector
})
