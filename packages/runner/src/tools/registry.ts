import { z } from 'zod'
import type { Platform, Surface } from '@vostride/agent-qa-schema'
import type { ToolDefinition } from './types.js'

function mergeVariantShapes(options: readonly unknown[]): Record<string, z.ZodType> | undefined {
  const merged: Record<string, z.ZodType> = {}

  for (const option of options) {
    const shape = option && typeof option === 'object' && 'shape' in option
      ? option.shape as Record<string, z.ZodType>
      : undefined
    if (!shape) continue

    for (const [fieldName, field] of Object.entries(shape)) {
      if (!(fieldName in merged)) {
        merged[fieldName] = field
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

function getParamShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  if ('shape' in schema) {
    return schema.shape as Record<string, z.ZodType>
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    return mergeVariantShapes(schema.options)
  }

  if (schema instanceof z.ZodUnion) {
    return mergeVariantShapes(schema.options)
  }

  return undefined
}

export const EXPOSURE: Record<Platform, ReadonlySet<Surface>> = {
  web: new Set<Surface>(['web', 'common']),
  android: new Set<Surface>(['mobile', 'android', 'common']),
  ios: new Set<Surface>(['mobile', 'ios', 'common']),
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register<T extends z.ZodType>(def: ToolDefinition<T>): this {
    this.tools.set(def.id, def)
    return this
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id)
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  getForPlatform(platform: Platform): ToolDefinition[] {
    const surfaces = EXPOSURE[platform]
    return this.getAll().filter(def => surfaces.has(def.surface))
  }

  getSchema(id: string): z.ZodType {
    const def = this.tools.get(id)
    if (!def) throw new Error(`Unknown tool: ${id}`)
    return def.schema
  }

  generateDocs(platform?: Platform): string {
    const lines: string[] = []
    const filtered = platform ? this.getForPlatform(platform) : this.getAll()

    for (const def of filtered) {
      const shape = getParamShape(def.schema)
      const params: string[] = []

      if (shape) {
        for (const [fieldName, field] of Object.entries(shape)) {
          const paramDesc = field.description ?? (field as { _def?: { description?: string; innerType?: { description?: string } } })._def?.description ?? (field as { _def?: { innerType?: { description?: string } } })._def?.innerType?.description ?? ''
          params.push(paramDesc ? `${fieldName} (${paramDesc})` : fieldName)
        }
      }

      let line = `- ${def.id}: ${def.description}`
      if (params.length > 0) {
        line += `. Params: ${params.join(', ')}`
      }
      lines.push(line)
    }

    return lines.join('\n')
  }
}

export const defaultRegistry = new ToolRegistry()
