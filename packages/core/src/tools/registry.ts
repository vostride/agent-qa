import type { z } from 'zod'
import type { ToolDefinition, ToolCategory } from './types.js'

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register<T extends z.ZodType>(def: ToolDefinition<T>): this {
    this.tools.set(def.name, def)
    return this
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  getFiltered(options: {
    platform?: string
    categories?: ToolCategory[]
  }): ToolDefinition[] {
    return this.getAll().filter(def => {
      if (options.platform && def.platform && !def.platform.includes(options.platform as 'web' | 'android' | 'ios')) {
        return false
      }
      if (options.categories && !options.categories.includes(def.category)) {
        return false
      }
      return true
    })
  }

  getSchema(name: string): z.ZodType {
    const def = this.tools.get(name)
    if (!def) throw new Error(`Unknown tool: ${name}`)
    return def.schema
  }

  generateDocs(platform?: string): string {
    const lines: string[] = []
    const filtered = platform ? this.getFiltered({ platform }) : this.getAll()

    for (const def of filtered) {
      const shape = ('shape' in def.schema ? def.schema.shape : undefined) as Record<string, z.ZodType> | undefined
      const params: string[] = []

      if (shape) {
        for (const [fieldName, field] of Object.entries(shape)) {
          const paramDesc = field.description ?? (field as { _def?: { description?: string; innerType?: { description?: string } } })._def?.description ?? (field as { _def?: { innerType?: { description?: string } } })._def?.innerType?.description ?? ''
          params.push(paramDesc ? `${fieldName} (${paramDesc})` : fieldName)
        }
      }

      let line = `- ${def.name}: ${def.description}`
      if (params.length > 0) {
        line += `. Params: ${params.join(', ')}`
      }
      lines.push(line)
    }

    return lines.join('\n')
  }
}

export const defaultRegistry = new ToolRegistry()
