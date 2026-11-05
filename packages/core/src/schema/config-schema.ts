import { z } from 'zod'
import {
  appRefIssues,
  capabilityCredentialIssues,
  configConnectionSecretNames,
  isLoopbackHost,
  remoteOrigin,
  secretReferenceNames,
} from '@vostride/agent-qa-schema'
import { selectWebPlace } from '../remote/select-place.js'
import { selectDevicePlace } from '../mobile/select-device.js'
import { staticCapabilityContradictions } from '../mobile/device-plan.js'
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
  const reported = new Set<string>()
  const report = (path: (string | number)[], message: string) => {
    const key = JSON.stringify([path, message])
    if (reported.has(key)) return
    reported.add(key)
    ctx.addIssue({ code: 'custom', path, message })
  }
  for (const [device, profile] of Object.entries(devices)) {
    const at = remotes.findIndex(remote => remote.name === profile.remote)
    const remote = at >= 0 && remotes[at]!.protocol === 'appium' ? remotes[at] : undefined
    const stated = {
      device,
      platform: profile.platform,
      model: profile.model,
      os: profile.os,
      id: profile.id,
    }
    if (remote?.capabilities !== undefined) {
      const layer = { name: remote.name, capabilities: remote.capabilities }
      for (const sentence of staticCapabilityContradictions({ ...stated, remote: layer })) {
        report(['registry', 'remotes', at, 'capabilities'], sentence)
      }
    }
    if (profile.capabilities === undefined) continue
    const path = ['registry', 'devices', device, 'capabilities']
    for (const sentence of staticCapabilityContradictions({
      ...stated,
      capabilities: profile.capabilities,
    })) {
      report(path, sentence)
    }
    for (const issue of capabilityCredentialIssues(profile.capabilities, path)) {
      report([...issue.path], `Device ${device}: ${issue.message}`)
    }
    const host = remote === undefined ? undefined : cleartextHost(remote.url)
    if (host !== undefined && carriesSecret(profile.capabilities)) {
      report(
        path,
        `Device ${device} sends a credential in its capabilities over http:// to ${host}; use https://.`,
      )
    }
  }
  const deviceNames = Object.keys(devices)
  const listedDevices =
    deviceNames.length === 0
      ? 'registry.devices lists no devices.'
      : `registry.devices lists: ${deviceNames.join(', ')}.`
  for (const [target, entry] of Object.entries(val.registry?.targets ?? {})) {
    const pick = entry.device
    const profile = pick !== undefined && Object.hasOwn(devices, pick) ? devices[pick] : undefined
    if (pick !== undefined) {
      const path = ['registry', 'targets', target, 'device']
      if (entry.platform === 'web') {
        report(path, `Target ${target} is a web target; device applies to android and ios targets.`)
      } else if (profile === undefined) {
        report(
          path,
          `Target ${target} names device "${pick}", which registry.devices does not list. ${listedDevices}`,
        )
      } else if (profile.platform !== entry.platform) {
        report(
          path,
          `Target ${target} is ${entry.platform}, but its device ${pick} is ${profile.platform}.`,
        )
      }
    }
    const ref = entry.app?.ref
    if (ref === undefined) continue
    const refPath = ['registry', 'targets', target, 'app', 'ref']
    for (const issue of appRefIssues(ref, refPath)) {
      report([...issue.path], `Target ${target}: ${issue.message}`)
    }
    const remote = remotes.find(listed => listed.name === profile?.remote)
    const host = remote?.protocol === 'appium' ? cleartextHost(remote.url) : undefined
    if (host !== undefined && carriesSecret(ref)) {
      report(
        refPath,
        `Target ${target} sends a credential in its app.ref over http:// to ${host} through device ${pick}; use https://.`,
      )
    }
  }
  const connectionSecrets = new Set(configConnectionSecretNames(val))
  for (const [target, { url }] of Object.entries(val.registry?.targets ?? {})) {
    if (url === undefined) continue
    for (const name of new Set(secretReferenceNames(url))) {
      if (!connectionSecrets.has(name)) continue
      ctx.addIssue({
        code: 'custom',
        path: ['registry', 'targets', target, 'url'],
        message: `registry.targets.${target}.url uses ${name}, a remote's or device's credential that only connects to it. Use another secret here.`,
      })
    }
  }
})

function carriesSecret(value: unknown): boolean {
  return secretReferenceNames(JSON.stringify(value)).length > 0
}

// The host a plain http:// url names when it is not this machine.
function cleartextHost(url: string): string | undefined {
  const origin = remoteOrigin(url)
  if (origin === undefined || origin.scheme !== 'http' || isLoopbackHost(origin.host)) {
    return undefined
  }
  return origin.host.includes(':') ? `[${origin.host}]` : origin.host
}

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
