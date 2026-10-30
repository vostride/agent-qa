import { describe, expect, it } from 'vitest'

import { maskPayloadTree } from '../bus-projections'

const VALUE = 'Hunter-42-zz'
const MARKER = '[secret:PW_KEY]'
const mask = (text: string): string => text.split(VALUE).join(MARKER)

describe('maskPayloadTree', () => {
  it('masks every object key and string leaf and leaves the input unchanged', () => {
    const input = { [VALUE]: { list: [`a ${VALUE}`, 3, true, null] } }
    const before = JSON.stringify(input)

    const masked = maskPayloadTree(input, mask)

    expect(masked).toEqual({ [MARKER]: { list: [`a ${MARKER}`, 3, true, null] } })
    expect(JSON.stringify(input)).toBe(before)
    expect(JSON.stringify(masked)).not.toContain(VALUE)
  })

  it('keeps an own __proto__ key as an own key', () => {
    const input = JSON.parse(`{"__proto__":{"note":"${VALUE}"}}`) as Record<string, unknown>

    const masked = maskPayloadTree(input, mask) as Record<string, unknown>

    expect(Object.hasOwn(masked, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype)
    expect(JSON.stringify(masked)).toBe(`{"__proto__":{"note":"${MARKER}"}}`)
  })

  it('refuses two keys of one object that mask to the same name, naming no value', () => {
    const input = { [VALUE]: 1, [MARKER]: 2 }

    let thrown: unknown
    try {
      maskPayloadTree(input, mask)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('two keys of one object mask to the same name')
    expect(message).not.toContain(VALUE)
    expect(message).not.toContain(MARKER)
  })
})
