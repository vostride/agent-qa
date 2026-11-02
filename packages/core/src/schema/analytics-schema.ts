import { z } from 'zod'

export const AttributePredicateSchema = z.union([
  z.string(),
  z.strictObject({
    regex: z.string().min(1),
  }),
])

export const AnalyticsSchema = z.strictObject({
  privacy: z.literal(true).optional(),
  passRateScope: z.strictObject({
    attributes: z.record(z.string(), AttributePredicateSchema).optional(),
  }).optional(),
})

export type AnalyticsConfig = z.infer<typeof AnalyticsSchema>
