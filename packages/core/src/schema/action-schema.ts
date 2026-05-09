import { z } from 'zod'

// ActionSchema discriminated union removed — the single source of truth
// for action definitions is now the tool registry (tools/registry.ts).
// ActionPlanSchema uses a permissive action schema since runtime validation
// is handled by the registry's Zod parse in toolCallToActionPlan.

export const ActionPlanSchema = z.object({
  reasoning: z.string().describe('Brief explanation of why this action was chosen'),
  action: z.object({ type: z.string() }).passthrough(),
  confidence: z.number().describe('Confidence level from 0 to 1'),
  stepComplete: z.boolean().default(false)
    .describe('Whether this action completes the step goal. Set true when the step objective is fully accomplished, false when more actions are needed.'),
  stepFailed: z.boolean().optional().default(false)
    .describe('Set true when the step goal cannot be achieved from the current screen state. When true, no action is executed and the step fails with the reasoning as the error message.'),
})

export type ActionPlan = z.infer<typeof ActionPlanSchema>
