import { z } from 'zod'
import { WorkspaceSchema } from './workspace-schema.js'
import { ServicesSchema } from './services-schema.js'
import { RegistrySchema } from './registry-schema.js'
import { MobileAppStateSchema, UseSchema } from './use-schema.js'
import { AnalyticsSchema } from './analytics-schema.js'

export const AuthPluginDeclarationSchema = z.union([
  z.object({
    package: z.string().trim().min(1),
  }).strict(),
  z.object({
    path: z.string().trim().min(1),
  }).strict(),
])

export const PluginsSchema = z.object({
  auth: z.array(AuthPluginDeclarationSchema).optional().default([]),
}).strict()

export const AgentQaConfigSchema = z.object({
  workspace: WorkspaceSchema,
  services: ServicesSchema.optional(),
  registry: RegistrySchema.optional(),
  use: UseSchema.optional(),
  plugins: PluginsSchema.optional(),
  analytics: AnalyticsSchema.optional(),
}).strict()
.superRefine((val, ctx) => {
  const llms = val.registry?.llms ?? []
  const names = llms.map(c => c.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  for (const dupe of new Set(dupes)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registry', 'llms'],
      message: `Duplicate LLM config name: "${dupe}"`,
    })
  }
  if ((val.use as any)?.platform) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['use', 'platform'],
      message: 'use.platform cannot be set at global config level. Set platform in test or suite YAML instead.',
    })
  }
  if (val.use?.llm && !names.includes(val.use.llm)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['use', 'llm'],
      message: `use.llm "${val.use.llm}" does not match any name in registry.llms`,
    })
  }
  if (!MobileAppStateSchema.safeParse(val.use?.mobile?.appState).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['use', 'mobile', 'appState'],
      message: 'use.mobile.appState is required and must be one of: preserve | reset',
    })
  }
})

export { WorkspaceSchema } from './workspace-schema.js'
export { AuthStateConfigSchema, ServicesSchema } from './services-schema.js'
export { RegistrySchema } from './registry-schema.js'
export {
  AuthStateUseSchema,
  MobileAppStateSchema,
  MobileUseSchema,
  MobileUseOverrideSchema,
  UseSchema,
  UseOverrideSchema,
  normalizeAuthStateUse,
  type NormalizedAuthStateUse,
} from './use-schema.js'
export { AnalyticsSchema } from './analytics-schema.js'
export * from './primitives.js'
