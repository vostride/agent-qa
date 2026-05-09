import { z } from 'zod'

export const AttributePredicateSchema = z.union([
  z.string(),
  z.object({
    regex: z.string().min(1),
  }).strict(),
])

export const AnalyticsSchema = z.object({
  privacy: z.literal(true).optional(),
  passRateScope: z.object({
    attributes: z.record(z.string(), AttributePredicateSchema).optional(),
  }).strict().optional(),
}).strict()

export type AnalyticsConfig = z.infer<typeof AnalyticsSchema>
