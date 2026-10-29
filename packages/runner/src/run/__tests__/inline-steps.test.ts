// Ported inline-DSL parse/strip cases. Sources: core
// hook-inline.test.ts, runjs-inline.test.ts, plus appium-inline parse coverage. The
// EXECUTION halves are NOT tested here — they ride injected handlers pinned in
// member-runner.test.ts. Runner convention: `.js`-suffixed relative specifiers.
import { describe, expect, it } from 'vitest'
import {
  parseHookInline,
  stripHookInline,
  isCanonicalHookIdShape,
  parseRunJSInline,
  coerceRunJSResult,
  parseAppiumInline,
} from '../inline-steps.js'

const VALID_HOOK_ID = 'h_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

describe('parseHookInline', () => {
  it('captures quoted canonical hook ids', () => {
    expect(parseHookInline(`Before {{runHook:"${VALID_HOOK_ID}"}} after`)).toEqual([
      { hookId: VALID_HOOK_ID, fullMatch: `{{runHook:"${VALID_HOOK_ID}"}}` },
    ])
  })

  it('rejects non-canonical runHook payloads', () => {
    expect(parseHookInline('{{runHook:"setup-auth"}}')).toEqual([])
    expect(parseHookInline(`{{runHook:${VALID_HOOK_ID}}}`)).toEqual([])
  })

  it('strips inline hook tokens from the instruction text', () => {
    expect(stripHookInline(`Open page {{runHook:"${VALID_HOOK_ID}"}} then continue`)).toBe(
      'Open page then continue',
    )
  })

  it('recognises the canonical hook-id shape (runner-local gate)', () => {
    expect(isCanonicalHookIdShape(VALID_HOOK_ID)).toBe(true)
    expect(isCanonicalHookIdShape('setup-auth')).toBe(false)
    expect(isCanonicalHookIdShape('h_only-three-words')).toBe(false)
  })
})

describe('parseRunJSInline', () => {
  it('extracts JS code from double-quoted template', () => {
    expect(parseRunJSInline('Check {{runJS:"document.title"}}')).toEqual([
      { fullMatch: '{{runJS:"document.title"}}', code: 'document.title' },
    ])
  })

  it('extracts JS code from single-quoted template', () => {
    expect(parseRunJSInline("Check {{runJS:'window.location.href'}}")).toEqual([
      { fullMatch: "{{runJS:'window.location.href'}}", code: 'window.location.href' },
    ])
  })

  it('returns multiple matches from a single step', () => {
    const result = parseRunJSInline('A {{runJS:"x"}} and {{runJS:"y"}}')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ fullMatch: '{{runJS:"x"}}', code: 'x' })
    expect(result[1]).toEqual({ fullMatch: '{{runJS:"y"}}', code: 'y' })
  })

  it('handles escaped double quotes inside JS code', () => {
    const result = parseRunJSInline('{{runJS:"var x = \\"hello\\"; return x"}}')
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('var x = "hello"; return x')
  })

  it('handles escaped single quotes inside JS code', () => {
    const result = parseRunJSInline("{{runJS:'it\\'s a test'}}")
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe("it's a test")
  })

  it('returns empty array for text with no templates', () => {
    expect(parseRunJSInline('No templates here')).toEqual([])
  })

  it('returns empty array when quotes are missing', () => {
    expect(parseRunJSInline('{{runJS:noQuotes}}')).toEqual([])
  })
})

describe('coerceRunJSResult', () => {
  it('coerces primitives and structures the way core did', () => {
    expect(coerceRunJSResult(undefined)).toBe('undefined')
    expect(coerceRunJSResult(null)).toBe('null')
    expect(coerceRunJSResult(42)).toBe('42')
    expect(coerceRunJSResult(true)).toBe('true')
    expect(coerceRunJSResult('hello')).toBe('hello')
    expect(coerceRunJSResult({ a: 1 })).toBe('{"a":1}')
    expect(coerceRunJSResult([1, 2])).toBe('[1,2]')
  })
})

describe('parseAppiumInline', () => {
  it('returns null when no appium directive is present', () => {
    expect(parseAppiumInline('Tap the login button')).toBeNull()
  })

  it('parses a bare command into an executeScript action', () => {
    expect(parseAppiumInline('{{appium: mobile: scroll}}')).toEqual({
      type: 'executeScript',
      command: 'mobile: scroll',
    })
  })

  it('parses typed key/value args', () => {
    expect(parseAppiumInline('{{appium: mobile: swipe, direction: up, times: 3, smooth: true}}')).toEqual({
      type: 'executeScript',
      command: 'mobile: swipe',
      args: { direction: 'up', times: 3, smooth: true },
    })
  })
})
