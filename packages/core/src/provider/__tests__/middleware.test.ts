import { describe, it, expect } from 'vitest'
import { toolSchemaMiddleware, createWrappedModel } from '../middleware.js'

describe('toolSchemaMiddleware', () => {
  it('strips $schema from function tool inputSchemas', async () => {
    const params = {
      tools: [
        {
          type: 'function' as const,
          name: 'click',
          inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: { ref: { type: 'string' } },
          },
        },
      ],
    }

    const result = await toolSchemaMiddleware.transformParams!({
      type: 'generate',
      params: params as any,
      model: {} as any,
    })

    const tool = (result as any).tools[0]
    expect(tool.inputSchema).not.toHaveProperty('$schema')
    expect(tool.inputSchema.type).toBe('object')
    expect(tool.inputSchema.properties).toEqual({ ref: { type: 'string' } })
  })

  it('injects type:object when missing', async () => {
    const params = {
      tools: [
        {
          type: 'function' as const,
          name: 'back',
          inputSchema: {
            properties: { reasoning: { type: 'string' } },
          },
        },
      ],
    }

    const result = await toolSchemaMiddleware.transformParams!({
      type: 'generate',
      params: params as any,
      model: {} as any,
    })

    const tool = (result as any).tools[0]
    expect(tool.inputSchema.type).toBe('object')
  })

  it('leaves non-function tools untouched', async () => {
    const params = {
      tools: [
        {
          type: 'provider' as const,
          name: 'web_search',
          id: 'web_search',
        },
      ],
    }

    const result = await toolSchemaMiddleware.transformParams!({
      type: 'generate',
      params: params as any,
      model: {} as any,
    })

    expect((result as any).tools[0]).toEqual(params.tools[0])
  })

  it('returns params unchanged when no tools', async () => {
    const params = { prompt: [] }

    const result = await toolSchemaMiddleware.transformParams!({
      type: 'generate',
      params: params as any,
      model: {} as any,
    })

    expect(result).toEqual(params)
  })

  it('does not mutate the original tool objects', async () => {
    const original = {
      type: 'function' as const,
      name: 'click',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { ref: { type: 'string' } },
      },
    }
    const params = { tools: [original] }

    await toolSchemaMiddleware.transformParams!({
      type: 'generate',
      params: params as any,
      model: {} as any,
    })

    expect(original.inputSchema).toHaveProperty('$schema')
  })
})

describe('createWrappedModel', () => {
  it('returns a model object', () => {
    const mockModel = {
      specificationVersion: 'v3',
      modelId: 'test',
      provider: 'test',
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    }

    const wrapped = createWrappedModel(mockModel as any)
    expect(wrapped).toBeDefined()
    expect((wrapped as { modelId?: string }).modelId).toBeDefined()
  })
})
