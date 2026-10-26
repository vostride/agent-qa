import { z } from 'zod'
import { WorkspaceSchema } from './workspace-schema.js'
import { ServicesSchema } from './services-schema.js'
import { KnowledgeConfigSchema } from './knowledge-schema.js'
import { retiredKeyScan } from './retired-keys.js'
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

// Provider plugins load in-process with full Node access; keep them first-party-only
// until a container sandbox exists.
export const ProviderPluginDeclarationSchema = z.union([
  z.object({
    package: z.string().trim().min(1),
  }).strict(),
  z.object({
    path: z.string().trim().min(1),
  }).strict(),
])

export const PluginsSchema = z.object({
  auth: z.array(AuthPluginDeclarationSchema).optional().default([]),
  providers: z.array(ProviderPluginDeclarationSchema).optional().default([]),
}).strict()

const AgentQaConfigSchemaInner = z.object({
  workspace: WorkspaceSchema,
  services: ServicesSchema.prefault({}).optional(),
  // D-08: slim replacement for the retired v1 memory config surface; prefaulted so parsed
  // configs always materialize knowledge defaults (zod 4 .default() short-circuits without
  // parsing — .prefault() runs the inner defaults) — matches the providers `.default([])`
  // precedent in spirit.
  knowledge: KnowledgeConfigSchema.prefault({}),
  registry: RegistrySchema.optional(),
  use: UseSchema.optional(),
  plugins: PluginsSchema.optional(),
  analytics: AnalyticsSchema.optional(),
  // 432 D-18: the one production opt-in. Optional with no default: its consumer reads absence as
  // false, so only an explicit `true` in the validated config authorizes a production target.
  allowProduction: z.boolean().optional(),
  // 2026-10-01 (432-22, D-15/D-18/D-22): the `safety` section (`safety.trustMode`) is deleted with
  // trust mode. `allowProduction` above is the only production opt-in, and a file that still
  // declares `safety` gets the normal strict unrecognized-key error.
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

// D-07: retired-key pipe pre-scan — the scan MUST run before the strict object because
// zod (4.6.7 verified) skips refinements chained after a strict parse that rejects a value
// (RESEARCH Pitfall 1). z.infer of the piped schema yields the stage-B output type,
// so the exported AgentQaConfig type semantics are unchanged.
export const AgentQaConfigSchema = retiredKeyScan.pipe(AgentQaConfigSchemaInner)

export { WorkspaceSchema } from './workspace-schema.js'
export { AuthStateConfigSchema, ServicesSchema } from './services-schema.js'
export { KnowledgeConfigSchema } from './knowledge-schema.js'
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
