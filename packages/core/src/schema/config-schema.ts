import { z } from 'zod'
import { connectionSecretNames, secretReferenceNames } from '@vostride/agent-qa-schema'
import { selectWebPlace } from '../remote/select-place.js'
import { selectDevicePlace } from '../mobile/select-device.js'
import { WorkspaceSchema } from './workspace-schema.js'
import { ServicesSchema } from './services-schema.js'
import { KnowledgeConfigSchema } from './knowledge-schema.js'
import { retiredKeyScan } from './retired-keys.js'
import { RegistrySchema } from './registry-schema.js'
import { UseSchema } from './use-schema.js'
import { AnalyticsSchema } from './analytics-schema.js'

export const AuthPluginDeclarationSchema = z.union([
  z.strictObject({
    package: z.string().trim().min(1),
  }),
  z.strictObject({
    path: z.string().trim().min(1),
  }),
])

// Provider plugins load in-process with full Node access; keep them first-party-only
// until a container sandbox exists.
export const ProviderPluginDeclarationSchema = z.union([
  z.strictObject({
    package: z.string().trim().min(1),
  }),
  z.strictObject({
    path: z.string().trim().min(1),
  }),
])

export const PluginsSchema = z.strictObject({
  auth: z.array(AuthPluginDeclarationSchema).optional().default([]),
  providers: z.array(ProviderPluginDeclarationSchema).optional().default([]),
})

const AgentQaConfigSchemaInner = z.strictObject({
  workspace: WorkspaceSchema,
  services: ServicesSchema.prefault({}).optional(),
  // `.prefault` runs the inner defaults; zod 4's `.default()` short-circuits without parsing.
  knowledge: KnowledgeConfigSchema.prefault({}),
  registry: RegistrySchema.optional(),
  use: UseSchema.optional(),
  plugins: PluginsSchema.optional(),
  analytics: AnalyticsSchema.optional(),
  // There is no `safety` section: a file that still declares one gets the normal strict
  // unrecognized-key error.
})
.superRefine((val, ctx) => {
  const llms = val.registry?.llms ?? []
  const names = llms.map(c => c.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  for (const dupe of new Set(dupes)) {
    ctx.addIssue({
      code: 'custom',
      path: ['registry', 'llms'],
      message: `Duplicate LLM config name: "${dupe}"`,
    })
  }
  if ((val.use as any)?.platform) {
    ctx.addIssue({
      code: 'custom',
      path: ['use', 'platform'],
      message: 'use.platform cannot be set at global config level. Set platform in test or suite YAML instead.',
    })
  }
  if (val.use?.llm && !names.includes(val.use.llm)) {
    ctx.addIssue({
      code: 'custom',
      path: ['use', 'llm'],
      message: `use.llm "${val.use.llm}" does not match any name in registry.llms`,
    })
  }

  const remotes = val.registry?.remotes ?? []
  const remoteNames = remotes.map(remote => remote.name)
  const remoteDupes = remoteNames.filter((n, i) => remoteNames.indexOf(n) !== i)
  for (const dupe of new Set(remoteDupes)) {
    ctx.addIssue({
      code: 'custom',
      path: ['registry', 'remotes'],
      message: `Duplicate remote name: "${dupe}"`,
    })
  }
  remotes.forEach((remote, index) => {
    if (remote.name === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['registry', 'remotes', index, 'name'],
        message: 'Remote name "local" is reserved: local means this machine. Rename the remote.',
      })
    }
  })
  const pick = val.use?.browser?.remote
  if (pick !== undefined) {
    const selected = selectWebPlace({ remotes, config: pick, file: 'agent-qa.config.yaml' })
    if ('refusal' in selected) {
      ctx.addIssue({
        code: 'custom',
        path: ['use', 'browser', 'remote'],
        message: selected.refusal,
      })
    }
  }
  const devices = val.registry?.devices ?? {}
  for (const [device, profile] of Object.entries(devices)) {
    if (profile.remote === undefined) continue
    const selected = selectDevicePlace({ devices, remotes, device })
    if ('refusal' in selected) {
      ctx.addIssue({
        code: 'custom',
        path: ['registry', 'devices', device, 'remote'],
        message: selected.refusal,
      })
    }
  }
  const connectionSecrets = new Set(connectionSecretNames(remotes))
  for (const [target, { url }] of Object.entries(val.registry?.targets ?? {})) {
    if (url === undefined) continue
    for (const name of new Set(secretReferenceNames(url))) {
      if (!connectionSecrets.has(name)) continue
      ctx.addIssue({
        code: 'custom',
        path: ['registry', 'targets', target, 'url'],
        message: `registry.targets.${target}.url uses ${name}, a remote's credential that only connects to it. Use another secret here.`,
      })
    }
  }
})

// The scan runs before the strict object: zod skips refinements after a strict parse rejects.
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
