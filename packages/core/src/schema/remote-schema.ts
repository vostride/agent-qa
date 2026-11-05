import { z } from 'zod'
import {
  REMOTE_PROTOCOLS,
  capabilityCredentialIssues,
  pluginValueCredentialIssues,
  remoteEntryIssues,
} from '@vostride/agent-qa-schema'
import { DurationString, NameSlugSchema } from './primitives.js'

export const UrlRemoteEntrySchema = z
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

export const PluginRemoteEntrySchema = z
  .strictObject({
    name: NameSlugSchema,
    plugin: NameSlugSchema,
    settings: z.record(z.string(), z.unknown()).optional(),
    connectTimeout: DurationString.optional(),
    uploadTimeout: DurationString.optional(),
    context: z.enum(['new', 'reuse']).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.capabilities !== undefined) {
      for (const issue of capabilityCredentialIssues(entry.capabilities, ['capabilities'])) {
        ctx.addIssue({
          code: 'custom',
          path: [...issue.path],
          message: `Remote ${entry.name}: ${issue.message}`,
        })
      }
    }
    if (entry.settings !== undefined) {
      const label = `Remote ${entry.name}: settings`
      for (const issue of pluginValueCredentialIssues(entry.settings, ['settings'], label)) {
        ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
      }
    }
  })

// configShapeScan words a remote that fits neither form before this union sees it.
export const RemoteEntrySchema = z.union([UrlRemoteEntrySchema, PluginRemoteEntrySchema])

export type UrlRemoteEntry = z.infer<typeof UrlRemoteEntrySchema>
export type PluginRemoteEntry = z.infer<typeof PluginRemoteEntrySchema>
export type RemoteEntry = z.infer<typeof RemoteEntrySchema>

export function isPluginRemoteEntry(entry: RemoteEntry): entry is PluginRemoteEntry {
  return 'plugin' in entry
}

export function isUrlRemoteEntry(entry: RemoteEntry): entry is UrlRemoteEntry {
  return 'url' in entry
}
