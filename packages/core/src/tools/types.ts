import type { z } from 'zod'

export type ToolCategory = 'action' | 'file' | 'network'

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  name: string
  description: string
  category: ToolCategory
  platform?: ('web' | 'android' | 'ios')[]
  schema: T
}
