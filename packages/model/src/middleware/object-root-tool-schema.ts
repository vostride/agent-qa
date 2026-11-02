import type { LanguageModelMiddleware } from 'ai'

// Only the wire schema changes; the SDK still checks a call against the tool's own union.

type Schema = Record<string, unknown>
type ObjectVariant = Schema & { properties: Record<string, unknown> }

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObjectVariant(option: unknown): option is ObjectVariant {
  return isSchema(option) && option.type === 'object' && isSchema(option.properties)
    && option.allOf === undefined && option.anyOf === undefined && option.oneOf === undefined
}

function requiredOf(schema: Schema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string') : []
}

function constOf(schema: unknown): unknown {
  return isSchema(schema) ? schema.const : undefined
}

function mergeProperty(schemas: unknown[]): unknown {
  const distinct = [...new Map(schemas.map(schema => [JSON.stringify(schema), schema])).values()]
  const [first] = distinct
  if (distinct.length <= 1) return first ?? {}
  const type = isSchema(first) ? first.type : undefined
  const values = distinct.flatMap(schema => isSchema(schema) && schema.type === type
    && schema.const !== undefined
    && Object.keys(schema).every(key => key === 'type' || key === 'const') ? [schema.const] : [])
  if (type !== undefined && values.length === distinct.length) return { type, enum: values }
  return { anyOf: distinct }
}

function describeVariant(variant: ObjectVariant, shared: string[]): string {
  const consts = Object.entries(variant.properties).flatMap(([key, schema]) => {
    const value = constOf(schema)
    return value === undefined ? [] : [`${key} ${JSON.stringify(value)}`]
  })
  const fields = requiredOf(variant).filter(key =>
    !shared.includes(key) && constOf(variant.properties[key]) === undefined)
  return [consts.join(', '), fields.join(', ')].filter(part => part.length > 0).join(' with ')
    || 'no further fields'
}

export function objectRootSchema(schema: Schema): Schema {
  const union: unknown = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(union) || union.length === 0) return schema
  const variants = union.filter(isObjectVariant)
  const [first] = variants
  if (first === undefined || variants.length !== union.length) return schema

  const keys = [...new Set(variants.flatMap(variant => Object.keys(variant.properties)))]
  const properties = Object.fromEntries(keys.map(key => [key, mergeProperty(
    variants.flatMap(variant => key in variant.properties ? [variant.properties[key]] : []))]))
  const required = requiredOf(first)
    .filter(key => variants.every(variant => requiredOf(variant).includes(key)))
  const shapes = `Send exactly one of these shapes: ${
    variants.map(variant => describeVariant(variant, required)).join(' | ')}.`

  const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = schema
  return {
    ...rest,
    type: 'object',
    description: typeof rest.description === 'string' ? `${rest.description} ${shapes}` : shapes,
    properties,
    required,
    ...(variants.every(variant => variant.additionalProperties === false)
      ? { additionalProperties: false } : {}),
  }
}

export const objectRootToolSchemaMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',

  transformParams: async ({ params }) => {
    if (!params.tools) return params
    return {
      ...params,
      tools: params.tools.map(tool => tool.type === 'function' && isSchema(tool.inputSchema)
        ? { ...tool, inputSchema: objectRootSchema(tool.inputSchema) }
        : tool),
    }
  },
}
