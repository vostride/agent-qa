import type { LanguageModelMiddleware } from 'ai'

export const toolSchemaMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',

  transformParams: async ({ params }) => {
    if (!params.tools) return params

    return {
      ...params,
      tools: params.tools.map((t: any) => {
        if (t.type !== 'function') return t
        const schema = { ...t.inputSchema }
        if ('$schema' in schema) delete schema.$schema
        if (!schema.type) schema.type = 'object'
        return { ...t, inputSchema: schema }
      }),
    }
  },
}
