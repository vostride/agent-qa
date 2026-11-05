import { z } from 'zod'
import { REMOTE_PROTOCOLS, remoteEntryIssues } from '@vostride/agent-qa-schema'
import { DurationString, NameSlugSchema } from './primitives.js'

export const RemoteEntrySchema = z
  .strictObject({
    name: NameSlugSchema,
    protocol: z.enum(REMOTE_PROTOCOLS),
    url: z.string(),
    query: z
      .record(z.string(), z.union([z.string(), z.record(z.string(), z.unknown())]))
      .optional(),
    headers: z.record(z.string(), z.string()).optional(),
    basicAuth: z
      .strictObject({
        user: z.string(),
        password: z.string(),
      })
      .optional(),
    connectTimeout: DurationString.optional(),
    context: z.enum(['new', 'reuse']).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((entry, ctx) => {
    for (const issue of remoteEntryIssues(entry)) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
  })

export type RemoteEntry = z.infer<typeof RemoteEntrySchema>
