import { describe, expect, it } from 'vitest'

import { objectRootSchema } from '../middleware/object-root-tool-schema.js'

const op = { type: 'string', enum: ['equals', 'isNull'] } as const

function variant(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required }
}

describe('objectRootSchema', () => {
  it('merges an anyOf of objects with no discriminator and names each shape', () => {
    const merged = objectRootSchema({
      type: 'object',
      anyOf: [
        { ...variant({ source: { type: 'string' }, op }, ['source', 'op']),
          additionalProperties: false },
        { ...variant({ expr: { type: 'string' }, op }, ['expr', 'op']),
          additionalProperties: false },
      ],
    })

    expect(merged).toEqual({
      type: 'object',
      description: 'Send exactly one of these shapes: source | expr.',
      properties: { source: { type: 'string' }, op, expr: { type: 'string' } },
      required: ['op'],
      additionalProperties: false,
    })
  })

  it('names a discriminator value and its fields after the schema description', () => {
    const merged = objectRootSchema({
      description: 'Where to go.',
      oneOf: [
        variant({ to: { type: 'string', const: 'url' }, url: { type: 'string' } }, ['to', 'url']),
        variant({ to: { type: 'string', const: 'back' } }, ['to']),
      ],
    })

    expect(merged.description)
      .toBe('Where to go. Send exactly one of these shapes: to "url" with url | to "back".')
    expect(merged).toHaveProperty(['properties', 'to'], { type: 'string', enum: ['url', 'back'] })
    expect(merged).not.toHaveProperty('additionalProperties')
  })

  it('sends a property whose schema differs between shapes as a nested anyOf', () => {
    const merged = objectRootSchema({
      oneOf: [
        variant({ mode: { type: 'string', const: 'by' }, amount: { type: 'number' } }, ['mode']),
        variant({ mode: { type: 'string', const: 'to' }, amount: { type: 'string' } }, ['mode']),
      ],
    })

    expect(merged).toHaveProperty(
      ['properties', 'amount'], { anyOf: [{ type: 'number' }, { type: 'string' }] })
  })

  it('leaves an object schema and a union with a non-object option as they are', () => {
    const plain = { type: 'object', properties: { ref: { type: 'string' } } }
    const mixed = { anyOf: [{ type: 'object', properties: {} }, { type: 'string' }] }

    expect(objectRootSchema(plain)).toBe(plain)
    expect(objectRootSchema(mixed)).toBe(mixed)
  })
})
