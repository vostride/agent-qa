import type { z } from 'zod'
import type { Surface } from '@vostride/agent-qa-schema'

export type ToolCategory = 'action'

export interface ToolDefinition<T extends z.ZodType = z.ZodType> {
  id: string
  type: string
  surface: Surface
  description: string
  category: ToolCategory
  schema: T
  /** Advisory audit/confirmation hint only; must not gate platform slices. */
  destructive?: boolean
  /** Advisory audit/trace hint only; must not gate platform slices. */
  readOnly?: boolean
}
