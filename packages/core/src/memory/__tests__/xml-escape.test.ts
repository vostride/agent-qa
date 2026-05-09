import { describe, it, expect } from 'vitest'
import { escapeXml } from '../xml-escape.js'

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b')
  })

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b')
  })

  it('escapes double quote', () => {
    expect(escapeXml('a "b" c')).toBe('a &quot;b&quot; c')
  })

  it('escapes single quote (apostrophe)', () => {
    expect(escapeXml("a 'b' c")).toBe('a &apos;b&apos; c')
  })

  it('escapes all 5 XML special characters in one string', () => {
    expect(escapeXml('a <b> "c" & \'d\'')).toBe('a &lt;b&gt; &quot;c&quot; &amp; &apos;d&apos;')
  })

  it('prevents fence breakout (RET-06)', () => {
    expect(escapeXml('</memory-context>')).toBe('&lt;/memory-context&gt;')
  })

  it('returns safe text unchanged', () => {
    expect(escapeXml('safe text')).toBe('safe text')
  })

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('')
  })
})
