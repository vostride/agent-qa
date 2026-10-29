// The comparator passes only on a real read: an unread value fails every operator; null is a read.

import { describe, expect, it } from 'vitest'
import type { AssertValueOp } from '@vostride/agent-qa-schema'
import { compareAssertValue } from '../assert-value.js'

const ALL_OPS: AssertValueOp[] = ['isNull', 'isDefined', 'equals', 'notEquals', 'contains', 'gt', 'lt']

function entry(url: string, status = 200): string {
  return JSON.stringify({ url, method: 'GET', status })
}

describe('compareAssertValue on unread, null and network values', () => {
  it.each(ALL_OPS)('an unread value fails %s', (op) => {
    expect(compareAssertValue({ source: 'storage', op, expected: '1', actual: undefined }).passed).toBe(false)
  })

  it('null is a read: it passes isNull and nothing else', () => {
    expect(compareAssertValue({ source: 'storage', op: 'isNull', actual: null }).passed).toBe(true)
    for (const op of ALL_OPS.filter((each) => each !== 'isNull')) {
      expect(compareAssertValue({ source: 'storage', op, expected: 'null', actual: null }).passed, op).toBe(false)
    }
  })

  it('an empty network log never satisfies isDefined', () => {
    expect(compareAssertValue({ source: 'network', op: 'isDefined', entries: [] }).passed).toBe(false)
    expect(compareAssertValue({ source: 'network', op: 'isDefined' }).passed).toBe(false)
    expect(compareAssertValue({
      source: 'network', op: 'isDefined', entries: [entry('http://x.test/api/ping')], actual: '[…]',
    }).passed).toBe(true)
  })

  it('network contains and equals match within one entry only', () => {
    const entries = [entry('http://x.test/api/a'), entry('http://x.test/api/b')]
    const actual = `[${entries.join(',')}]`
    expect(compareAssertValue({ source: 'network', op: 'contains', expected: '/api/b', entries, actual }).passed).toBe(true)
    const spanning = `"status":200},{"url"`
    expect(actual).toContain(spanning)
    expect(compareAssertValue({ source: 'network', op: 'contains', expected: spanning, entries, actual }).passed).toBe(false)
    expect(compareAssertValue({ source: 'network', op: 'equals', expected: entries[1], entries, actual }).passed).toBe(true)
    expect(compareAssertValue({ source: 'network', op: 'equals', expected: actual, entries, actual }).passed).toBe(false)
  })

  it.each(['isNull', 'notEquals', 'gt', 'lt'] as AssertValueOp[])('network %s never passes', (op) => {
    const entries = [entry('http://x.test/api/ping')]
    expect(compareAssertValue({ source: 'network', op, expected: '0', entries, actual: `[${entries[0]}]` }).passed).toBe(false)
    expect(compareAssertValue({ source: 'network', op, expected: '0', entries: [] }).passed).toBe(false)
  })
})
