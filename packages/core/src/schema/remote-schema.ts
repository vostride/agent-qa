import { z } from 'zod'
import { DurationString, NameSlugSchema } from './primitives.js'

export const RemoteEntrySchema = z.strictObject({
  name: NameSlugSchema,
  protocol: z.enum(['playwright', 'cdp']),
  url: z.string(),
  query: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  basicAuth: z.strictObject({
    user: z.string(),
    password: z.string(),
  }).optional(),
  connectTimeout: DurationString.optional(),
  context: z.enum(['new', 'reuse']).optional(),
})

export type RemoteEntry = z.infer<typeof RemoteEntrySchema>
