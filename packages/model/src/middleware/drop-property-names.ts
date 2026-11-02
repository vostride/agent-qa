import type { LanguageModelMiddleware } from 'ai'

// OpenAI strips a string-keyed `propertyNames` with a warning; stripping it here first is silent.

type Schema = Record<string, unknown>

// The keywords the OpenAI provider walks, so the schema it sends cannot change.
const SCHEMA_KEYS = [
  'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else',
]
const SCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf']
const SCHEMA_RECORD_KEYS = ['properties', 'patternProperties', 'definitions', '$defs']

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Any other key schema stays, so the provider still refuses it.
function hasStringKeys(names: unknown): boolean {
  if (typeof names !== 'object' || names === null) return false
  return !('type' in names) || names.type === undefined || names.type === null
    || names.type === 'string'
}

function definition(value: unknown): unknown {
  return isSchema(value) ? withoutPropertyNames(value) : value
}

function definitions(record: unknown): unknown {
  return isSchema(record)
    ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, definition(value)]))
    : record
}

export function withoutPropertyNames(schema: Schema): Schema {
  const { propertyNames, ...rest } = schema
  const next: Schema = hasStringKeys(propertyNames) ? rest : { ...schema }
  for (const key of SCHEMA_KEYS) {
    if (key in next) next[key] = definition(next[key])
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = next[key]
    if (Array.isArray(list)) next[key] = list.map(definition)
  }
  for (const key of SCHEMA_RECORD_KEYS) {
    if (key in next) next[key] = definitions(next[key])
  }
  const { items, dependencies } = next
  if ('items' in next) next.items = Array.isArray(items) ? items.map(definition) : definition(items)
  if (isSchema(dependencies)) {
    next.dependencies = Object.fromEntries(Object.entries(dependencies).map(([key, value]) =>
      [key, Array.isArray(value) ? value : definition(value)]))
  }
  return next
}

export const dropPropertyNamesMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',

  transformParams: async ({ params }) => {
    const { tools, responseFormat } = params
    return {
      ...params,
      ...(tools === undefined ? {} : {
        tools: tools.map(tool => tool.type === 'function' && isSchema(tool.inputSchema)
          ? { ...tool, inputSchema: withoutPropertyNames(tool.inputSchema) }
          : tool),
      }),
      ...(responseFormat?.type === 'json' && isSchema(responseFormat.schema) ? {
        responseFormat: { ...responseFormat, schema: withoutPropertyNames(responseFormat.schema) },
      } : {}),
    }
  },
}
