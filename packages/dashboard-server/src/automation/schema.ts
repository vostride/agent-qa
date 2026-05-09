import { z } from 'zod'

const AutomationTargetSchema = z.object({
  suite: z.string().optional(),
  tests: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})

const AutomationScheduleSchema = z.object({
  frequency: z.enum(['hourly', 'daily', 'weekly']).optional(),
  interval: z.number().optional(),
  dayOfWeek: z.number().min(0).max(6).optional(),
  timeOfDay: z.string().optional(),
  cron: z.string().optional(),
})

export const AutomationSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  target: AutomationTargetSchema,
  schedule: AutomationScheduleSchema.optional(),
  timeout: z.number().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
})

export type AutomationDefinition = z.infer<typeof AutomationSchema>
