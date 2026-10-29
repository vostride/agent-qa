// The shared fill comparator: four verdicts, kept apart. Exact equality;
// normalized when the field only inserted separator characters around the typed text; mismatch for
// anything else; unverified when nothing was read back. Secure fields are never exact.
import { describe, it, expect } from 'vitest'
import { compareFillReread, FILL_SEPARATORS } from '../fill-verify.js'

const ERROR = (actual: string, expected: string) =>
  `field reads "${actual}" after typing "${expected}" — re-observe and retry`

describe('compareFillReread verdicts', () => {
  describe('exact', () => {
    it('a read-back equal to the requested text is exact', () => {
      const r = compareFillReread({ expected: 'abc', actual: 'abc', secure: false })
      expect(r).toEqual({ verdict: 'exact', ok: true, meta: { expected: 'abc', actual: 'abc' } })
    })

    it('the meta keeps exactly the two string keys the existing readers pin', () => {
      const r = compareFillReread({ expected: 'abc', actual: 'abc', secure: false })
      const meta = r.meta as unknown as Record<string, unknown>
      expect(Object.keys(meta).sort()).toEqual(['actual', 'expected'])
    })
  })

  describe('normalized', () => {
    it('a phone number the field formatted with spaces and hyphens is normalized and keeps both values', () => {
      const r = compareFillReread({ expected: '+13920741751', actual: '+1 392-074-1751', secure: false })
      expect(r.verdict).toBe('normalized')
      expect(r.ok).toBe(true)
      expect(r.meta).toEqual({ expected: '+13920741751', actual: '+1 392-074-1751' })
      expect(r.selfCorrectingError).toBeUndefined()
    })

    it('a card number grouped with spaces is normalized', () => {
      const r = compareFillReread({ expected: '4111111111111111', actual: '4111 1111 1111 1111', secure: false })
      expect(r.verdict).toBe('normalized')
    })

    it("':' is not a separator, so '0930' read back as '09:30' is a mismatch", () => {
      const r = compareFillReread({ expected: '0930', actual: '09:30', secure: false })
      expect(r.verdict).toBe('mismatch')
      expect(r.ok).toBe(false)
    })

    it("an inserted no-break space is normalized ('ab' vs 'a\\u00a0b')", () => {
      const r = compareFillReread({ expected: 'ab', actual: 'a b', secure: false })
      expect(r.verdict).toBe('normalized')
    })

    it("an inserted narrow no-break space is normalized ('ab' vs 'a\\u202fb')", () => {
      const r = compareFillReread({ expected: 'ab', actual: 'a b', secure: false })
      expect(r.verdict).toBe('normalized')
    })

    it('brackets and a space inserted together are normalized', () => {
      const r = compareFillReread({ expected: '13920741751', actual: '1 (392) 074-1751', secure: false })
      expect(r.verdict).toBe('normalized')
    })

    it('an inserted space that joins another space is a mismatch (whitespace changed)', () => {
      expect(compareFillReread({ expected: 'ab', actual: 'a  b', secure: false }).verdict).toBe('mismatch')
      expect(compareFillReread({ expected: 'a b', actual: 'a  b', secure: false }).verdict).toBe('mismatch')
    })

    it('the separator set is exactly the A6 set: no tab, newline or comma', () => {
      expect([...FILL_SEPARATORS].sort()).toEqual(
        [' ', ' ', ' ', ' ', '-', '(', ')', '[', ']', '{', '}', '.', '/'].sort(),
      )
      for (const ch of ['\t', '\n', ',', ':']) {
        expect(compareFillReread({ expected: 'ab', actual: `a${ch}b`, secure: false }).verdict).toBe('mismatch')
      }
    })
  })

  describe('mismatch', () => {
    const cases: Array<[string, string, string]> = [
      ['merged whitespace (the old collapse cell flips)', 'foo bar', 'foo  bar'],
      ['P14: a blank line merged into one newline', 'a\n\nb', 'a\nb'],
      ['trimmed padding', '  pad  ', 'pad'],
      ['a case change', 'Abc', 'abc'],
      ['truncation', 'abcdef', 'abc'],
      ['a multi-line text folded onto one line', 'l1\n\nl3', 'l1  l3'],
    ]
    for (const [label, expected, actual] of cases) {
      it(`${label} is a mismatch`, () => {
        const r = compareFillReread({ expected, actual, secure: false })
        expect(r.verdict).toBe('mismatch')
        expect(r.ok).toBe(false)
        expect(r.meta).toEqual({ expected, actual })
      })
    }

    it('a mismatch keeps the exact self-correcting error text', () => {
      const r = compareFillReread({ expected: 'hello', actual: 'world', secure: false })
      expect(r.selfCorrectingError).toBe(ERROR('world', 'hello'))
    })
  })

  describe('unverified', () => {
    it('no readable value is unverified: not a failure, no meta, no error', () => {
      const r = compareFillReread({ expected: 'hello', actual: undefined, secure: false })
      expect(r).toEqual({ verdict: 'unverified', ok: true })
    })
  })

  describe('secure fields', () => {
    const SECRET = 'hunter2-SUPER-secret'

    it('a non-empty secure read-back is unverified with secure true and length-sentinel meta, never the raw value', () => {
      const r = compareFillReread({ expected: SECRET, actual: SECRET, secure: true })
      expect(r.verdict).toBe('unverified')
      expect(r.secure).toBe(true)
      expect(r.ok).toBe(true)
      expect(r.selfCorrectingError).toBeUndefined()
      expect(r.meta).toEqual({ expected: `<len:${SECRET.length}>`, actual: `<len:${SECRET.length}>` })
      expect(JSON.stringify(r)).not.toContain(SECRET)
    })

    it('an empty secure read-back is a mismatch with differing sentinels and the error', () => {
      const r = compareFillReread({ expected: SECRET, actual: '', secure: true })
      expect(r.verdict).toBe('mismatch')
      expect(r.ok).toBe(false)
      expect(r.meta).toEqual({ expected: `<len:${SECRET.length}>`, actual: '<len:0>' })
      expect(r.selfCorrectingError).toBe(ERROR('<len:0>', `<len:${SECRET.length}>`))
      expect(JSON.stringify(r)).not.toContain(SECRET)
    })

    it('a secure field is never exact', () => {
      for (const actual of [SECRET, 'x', '', undefined]) {
        expect(compareFillReread({ expected: SECRET, actual, secure: true }).verdict).not.toBe('exact')
      }
    })
  })

  describe('clearText', () => {
    it('an empty read-back is exact', () => {
      const r = compareFillReread({ expected: '', actual: '', secure: false, verb: 'clearText' })
      expect(r.verdict).toBe('exact')
      expect(r.ok).toBe(true)
    })

    it('a single leftover space is a mismatch', () => {
      const r = compareFillReread({ expected: '', actual: ' ', secure: false, verb: 'clearText' })
      expect(r.verdict).toBe('mismatch')
      expect(r.ok).toBe(false)
      expect(r.selfCorrectingError).toBeDefined()
    })

    it('leftover text is a mismatch', () => {
      const r = compareFillReread({ expected: '', actual: 'x', secure: false, verb: 'clearText' })
      expect(r.verdict).toBe('mismatch')
      expect(r.selfCorrectingError).toContain('"x"')
    })

    it('an unreadable read-back is unverified', () => {
      const r = compareFillReread({ expected: '', actual: undefined, secure: false, verb: 'clearText' })
      expect(r).toEqual({ verdict: 'unverified', ok: true })
    })

    it('a secure clear that reads back empty or unreadable is unverified with secure true', () => {
      for (const actual of ['', undefined]) {
        const r = compareFillReread({ expected: '', actual, secure: true, verb: 'clearText' })
        expect(r).toEqual({ verdict: 'unverified', ok: true, secure: true })
      }
    })

    it('a secure clear that leaves text is a mismatch naming only its length', () => {
      for (const actual of ['xxxx', '••••']) {
        const r = compareFillReread({ expected: '', actual, secure: true, verb: 'clearText' })
        expect(r.verdict).toBe('mismatch')
        expect(r.ok).toBe(false)
        expect(r.secure).toBe(true)
        expect(r.meta).toEqual({ expected: '<len:0>', actual: '<len:4>' })
        expect(r.selfCorrectingError).toBe(
          'field still reads "<len:4>" after clearing — re-observe and retry',
        )
        expect(JSON.stringify(r)).not.toContain('xxxx')
        expect(JSON.stringify(r)).not.toContain('••••')
      }
    })
  })

  describe('mixed text', () => {
    const MIX = `  a,b;c|d "q" 's' é ü 中文 😀\tz  `

    it('the single-line Unicode mix compared with itself is exact', () => {
      expect(compareFillReread({ expected: MIX, actual: MIX, secure: false }).verdict).toBe('exact')
    })

    it('the same mix with its trailing spaces trimmed is a mismatch', () => {
      expect(compareFillReread({ expected: MIX, actual: MIX.trimEnd(), secure: false }).verdict).toBe('mismatch')
    })
  })
})
