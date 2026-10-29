import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import type { Platform, ToolSurfaceEntry } from '@vostride/agent-qa-schema'
import { workingMemoryEntrySchema } from '@vostride/agent-qa-schema'
import { groundingError } from './errors.js'
import type { ToolRegistry } from './registry.js'
import type { ToolCategory } from './types.js'

// WM-01 write channel: remember[] rides every action tool's envelope (spec §12.15,
// ratified 2026-07-05 — NOT a tool, no ≤K interaction, catalog counts frozen). Validated with
// the closed-enum workingMemoryEntrySchema so unknown kind/provenance are rejected at parse time.
const rememberFieldSchema = z.array(workingMemoryEntrySchema).optional()

// D-04 infeasible envelope (EXEC-05, spec §12.10): the additive terminal outcome riding the
// plan-field lane alongside `stepFailed`, following the 358 remember[] precedent (NOT a tool, no
// catalog count change). `failureKind` is a CLOSED enum — the single literal 'infeasible' today,
// extensible in later milestones — so an unknown kind is rejected at parse. `failureReason` is
// required-when-`failureKind`-set, enforced by the refine on failureEnvelopeSchema below. A typed
// StepEvidence.termination block (Plan 10 seam) makes "declared infeasible" machine-distinguishable
// from a plain "failed to do it".
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
  failureKind: failureKindFieldSchema.describe('Declare the step terminally infeasible in this build — set to "infeasible" when the requested capability/screen does not exist so the outcome is machine-distinguishable from an ordinary failure (D-04). Requires failureReason. Omit unless declaring infeasibility.'),
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
  const tools: Record<string, ReturnType<typeof tool<any, any>>> = {}
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

/**
 * Describe the complete model-visible bound surface for deterministic attribution.
 * This shares `withPlanFields` with `buildTools`; it never serializes live `tool()` objects,
 * whose Zod internals are not the JSON Schema presented to the model.
 */
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
    description: boundTool.description ?? '',
    parameters: z.toJSONSchema(boundTool.inputSchema as z.ZodType, conversionOptions),
  }))

  return [...actionSurface, ...nonActionSurface]
}

export function toolCallToActionPlan(
  toolId: string,
  args: Record<string, unknown>,
  registry: ToolRegistry,
) {
  // Pitfall 2: every plan-field must be destructured out of args here — anything left in
  // actionFields is fed to the strict action schema and silently stripped (or rejected), never
  // reaching the loop. remember/bulkCompletionPredicate ride the envelope alongside reasoning.
  const { reasoning, confidence, stepComplete, stepFailed, doesActionAdvanceUsTowardsGoal, remember, bulkCompletionPredicate, failureKind, failureReason, ...actionFields } = args
  const def = registry.get(toolId)

  if (!def) {
    throw new Error(`Unknown tool: ${toolId}`)
  }

  // Closed-enum rejection of the untrusted remember[] payload at parse time (V5); throws on an
  // unknown kind/provenance, same fail-loud contract as a bad action.
  const rememberEntries = rememberFieldSchema.parse(remember)

  // parse the infeasible envelope with the closed enum + required-when-set refine BEFORE the
  // strict action safeParse — both fields were destructured above (Pitfall 2), so an un-parsed
  // envelope field never leaks into the action schema. An unknown failureKind, or a failureKind
  // without a reason, throws here (fail-loud), same contract as a bad action.
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
