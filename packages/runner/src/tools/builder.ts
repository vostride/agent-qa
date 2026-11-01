import { tool } from 'ai'
import type { Tool, ToolSet } from 'ai'
import { z } from 'zod'
import type { Platform, ToolSurfaceEntry } from '@vostride/agent-qa-schema'
import { workingMemoryEntrySchema } from '@vostride/agent-qa-schema'
import { groundingError } from './errors.js'
import type { ToolRegistry } from './registry.js'
import type { ToolCategory } from './types.js'

// Rides every action tool's envelope and is not a tool; closed enums reject unknown kinds.
const rememberFieldSchema = z.array(workingMemoryEntrySchema).optional()

// A closed enum, so an unknown kind fails parsing; `failureReason` is required when it is set.
const failureKindFieldSchema = z.enum(['infeasible']).optional()
const failureReasonFieldSchema = z.string().min(1).optional()
const failureEnvelopeSchema = z
  .object({
    failureKind: failureKindFieldSchema,
    failureReason: failureReasonFieldSchema,
  })
  .refine((v) => v.failureKind === undefined || v.failureReason !== undefined, {
    message: 'failureReason is required when failureKind is set',
    path: ['failureReason'],
  })

const PLAN_FIELDS = {
  reasoning: z.string().describe('Brief explanation of why this action was chosen'),
  confidence: z.number().describe('Confidence level from 0 to 1'),
  stepComplete: z.boolean().describe('Whether this action completes the step goal'),
  stepFailed: z.boolean().optional().describe('Set true when the step goal cannot be achieved'),
  doesActionAdvanceUsTowardsGoal: z.boolean().describe('True if this action moves the test toward its goal; a cheap hallucination-gate (§9.7).'),
  remember: rememberFieldSchema.describe('Record verbatim facts you will need later in the run — codes, filenames, extracted values, progress markers — BEFORE navigating away from the screen that shows them. Each item is { key, value, kind, provenance }. Omit when the current screen holds nothing you will need later.'),
  bulkCompletionPredicate: z.string().optional().describe('On entering a bulk "do X to all" step, declare the positive completion predicate (e.g. "no rows with a delete button remain") and re-state it each turn while the bulk loop runs. Omit for non-bulk steps.'),
  failureKind: failureKindFieldSchema.describe('Declare the step terminally infeasible in this build — set to "infeasible" when the requested capability/screen does not exist so the outcome is machine-distinguishable from an ordinary failure. Requires failureReason. Omit unless declaring infeasibility.'),
  failureReason: failureReasonFieldSchema.describe('Why the step is infeasible — required when failureKind is set (e.g. "Settings > Privacy is not present in this build"). Omit otherwise.'),
}

function withPlanFields(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options.map(option => (option as z.ZodObject<any>).extend(PLAN_FIELDS))
    return z.discriminatedUnion(
      schema.def.discriminator,
      options as [z.ZodObject<any>, ...z.ZodObject<any>[]],
    )
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map(option => (option as z.ZodObject<any>).extend(PLAN_FIELDS))
    return z.union(options as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]])
  }

  return (schema as z.ZodObject<any>).extend(PLAN_FIELDS)
}

export { GroundingError as ToolValidationError } from './errors.js'

export function buildTools(
  registry: ToolRegistry,
  options: { platform: Platform, categories?: ToolCategory[] },
) {
  const tools: ToolSet = {}
  const definitions = registry.getForPlatform(options.platform)
  const filtered = options.categories
    ? definitions.filter(def => options.categories?.includes(def.category))
    : definitions

  for (const def of filtered) {
    tools[def.id] = tool({
      description: def.description,
      inputSchema: withPlanFields(def.schema),
    })
  }

  return tools
}

// Shares `withPlanFields` with `buildTools`, never serializing live `tool()` objects.
export function describeBoundSurface(
  registry: ToolRegistry,
  options: { platform: Platform; nonActionTools?: Record<string, Tool> },
): ToolSurfaceEntry[] {
  const conversionOptions = { io: 'input', unrepresentable: 'any' } as const
  const actionSurface = registry.getForPlatform(options.platform).map(definition => ({
    name: definition.id,
    description: definition.description,
    parameters: z.toJSONSchema(withPlanFields(definition.schema), conversionOptions),
  }))
  const nonActionSurface = Object.entries(options.nonActionTools ?? {}).map(([name, boundTool]) => ({
    name,
    description: typeof boundTool.description === 'string' ? boundTool.description : '',
    parameters: z.toJSONSchema(boundTool.inputSchema as z.ZodType, conversionOptions),
  }))

  return [...actionSurface, ...nonActionSurface]
}

export function toolCallToActionPlan(
  toolId: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
) {
  // Destructure every plan-field here, or the strict action schema strips or rejects it.
  const { reasoning, confidence, stepComplete, stepFailed, doesActionAdvanceUsTowardsGoal, remember, bulkCompletionPredicate, failureKind, failureReason, ...actionFields } = args
  const def = registry.get(toolId)

  if (!def) {
    throw new Error(`Unknown tool: ${toolId}`)
  }

  // Closed enums reject an untrusted remember[] payload at parse time, like a bad action.
  const rememberEntries = rememberFieldSchema.parse(remember)

  // Parse the envelope before the strict action safeParse, so its fields never reach the action.
  const { failureKind: failureKindParsed, failureReason: failureReasonParsed } = failureEnvelopeSchema.parse({ failureKind, failureReason })

  const parsed = def.schema.safeParse(actionFields)

  if (!parsed.success) {
    throw groundingError.schemaInvalid(toolId, parsed.error)
  }

  return {
    reasoning: reasoning as string,
    confidence: confidence as number,
    stepComplete: stepComplete as boolean,
    stepFailed: (stepFailed as boolean | undefined) ?? false,
    doesActionAdvanceUsTowardsGoal: (doesActionAdvanceUsTowardsGoal as boolean | undefined) ?? false,
    ...(rememberEntries !== undefined ? { remember: rememberEntries } : {}),
    ...(bulkCompletionPredicate !== undefined ? { bulkCompletionPredicate: bulkCompletionPredicate as string } : {}),
    ...(failureKindParsed !== undefined ? { failureKind: failureKindParsed } : {}),
    ...(failureReasonParsed !== undefined ? { failureReason: failureReasonParsed } : {}),
    action: { type: def.type, ...(parsed.data as Record<string, unknown>) },
  }
}
