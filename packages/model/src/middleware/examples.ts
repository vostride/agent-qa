import type { LanguageModelMiddleware } from 'ai'

type JsonSchemaLike = {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, JsonSchemaLike>
}

type SampleInput = Record<string, unknown>

export function deriveExamplesMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      if (!params.tools) return params

      return {
        ...params,
        tools: params.tools.map((t: any) => {
          if (t.type !== 'function') return t
          if (t.inputExamples?.length) return t

          const input = sampleFromSchema(t.inputSchema)
          if (!input || Object.keys(input).length === 0) return t

          return { ...t, inputExamples: [{ input }] }
        }),
      }
    },
  }
}

export function sampleFromSchema(inputSchema: JsonSchemaLike | undefined): SampleInput | undefined {
  const properties = inputSchema?.properties
  if (!properties || Object.keys(properties).length === 0) return undefined

  const fields =
    inputSchema?.required && inputSchema.required.length > 0
      ? inputSchema.required
      : Object.keys(properties)

  const input: SampleInput = {}
  for (const field of fields) {
    if (!properties[field]) continue
    input[field] = sampleValue(properties[field])
  }

  return Object.keys(input).length > 0 ? input : undefined
}

function sampleValue(schema: JsonSchemaLike): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type

  switch (type) {
    case 'string':
      return ''
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return null
  }
}
