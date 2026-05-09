import { tool } from 'ai'
import { z } from 'zod'
import type { ToolRegistry } from './registry.js'
import type { ToolCategory } from './types.js'

const PLAN_FIELDS = {
  reasoning: z.string().describe('Brief explanation of why this action was chosen'),
  confidence: z.number().describe('Confidence level from 0 to 1'),
  stepComplete: z.boolean().describe('Whether this action completes the step goal'),
  stepFailed: z.boolean().optional().describe('Set true when the step goal cannot be achieved'),
}

export class ToolValidationError extends Error {
  toolName: string
  zodError: z.ZodError

  constructor(toolName: string, zodError: z.ZodError) {
    super(`Invalid args for tool "${toolName}": ${zodError.message}`)
    this.name = 'ToolValidationError'
    this.toolName = toolName
    this.zodError = zodError
  }
}

export function buildTools(
  registry: ToolRegistry,
  options: { platform: 'web' | 'android' | 'ios', categories?: ToolCategory[] },
) {
  const tools: Record<string, ReturnType<typeof tool<any, any>>> = {}

  for (const def of registry.getFiltered(options)) {
    const actionShape = (def.schema as z.ZodObject<any>).shape as Record<string, z.ZodType>
    tools[def.name] = tool({
      description: def.description,
      inputSchema: z.object({ ...PLAN_FIELDS, ...actionShape }),
    })
  }

  return tools
}

export function toolCallToActionPlan(
  toolName: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
) {
  const { reasoning, confidence, stepComplete, stepFailed, ...actionFields } = args
  const schema = registry.getSchema(toolName)
  const parsed = schema.safeParse(actionFields)

  if (!parsed.success) {
    throw new ToolValidationError(toolName, parsed.error)
  }

  return {
    reasoning: reasoning as string,
    confidence: confidence as number,
    stepComplete: stepComplete as boolean,
    stepFailed: (stepFailed as boolean | undefined) ?? false,
    action: { type: toolName, ...(parsed.data as Record<string, unknown>) },
  }
}
