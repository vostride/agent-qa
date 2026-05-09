import { describe, expect, it } from 'vitest'
import { parseHookInline, stripHookInline } from '../hook-inline.js'

const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

describe('parseHookInline', () => {
  it('captures quoted canonical hook ids', () => {
    expect(parseHookInline(`Before {{runHook:"${VALID_HOOK_ID}"}} after`)).toEqual([
      {
        hookId: VALID_HOOK_ID,
        fullMatch: `{{runHook:"${VALID_HOOK_ID}"}}`,
      },
    ])
  })

  it('rejects non-canonical runHook payloads', () => {
    expect(parseHookInline('{{runHook:"setup-auth"}}')).toEqual([])
    expect(parseHookInline('{{runHook:h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle}}')).toEqual([])
  })

  it('strips inline hook tokens from the instruction text', () => {
    expect(stripHookInline(`Open page {{runHook:"${VALID_HOOK_ID}"}} then continue`)).toBe('Open page then continue')
  })
})
