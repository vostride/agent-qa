import { describe, it, expect } from 'vitest'
import { parseRunJSInline, coerceRunJSResult } from '../runjs-inline.js'

describe('parseRunJSInline', () => {
  it('extracts JS code from double-quoted template', () => {
    const result = parseRunJSInline('Check {{runJS:"document.title"}}')
    expect(result).toEqual([
      { fullMatch: '{{runJS:"document.title"}}', code: 'document.title' },
    ])
  })

  it('extracts JS code from single-quoted template', () => {
    const result = parseRunJSInline("Check {{runJS:'window.location.href'}}")
    expect(result).toEqual([
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
  it('returns "undefined" for undefined', () => {
    expect(coerceRunJSResult(undefined)).toBe('undefined')
  })

  it('returns "null" for null', () => {
    expect(coerceRunJSResult(null)).toBe('null')
  })

  it('returns String() for numbers', () => {
    expect(coerceRunJSResult(42)).toBe('42')
  })

  it('returns String() for booleans', () => {
    expect(coerceRunJSResult(true)).toBe('true')
  })

  it('returns the string as-is for strings', () => {
    expect(coerceRunJSResult('hello')).toBe('hello')
  })

  it('returns JSON.stringify for objects', () => {
    expect(coerceRunJSResult({ a: 1 })).toBe('{"a":1}')
  })

  it('returns JSON.stringify for arrays', () => {
    expect(coerceRunJSResult([1, 2])).toBe('[1,2]')
  })
})
