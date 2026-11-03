import { z } from 'zod'
import { NamedLLMConfigSchema } from './primitives.js'
import { RemoteEntrySchema } from './remote-schema.js'
import { TargetNameSchema } from '../auth-state/schema.js'

function isAbsoluteAppPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export const AppInstallSchema = z.strictObject({
  path: z.string()
    .refine((v) => !isAbsoluteAppPath(v), { error: 'app.path must be relative' })
    .optional(),
})

export const TargetSchema = z.strictObject({
  product: z.string()
    .refine(
      (v) => !/\.\./.test(v) && !/[/\\]/.test(v) && !/\0/.test(v),
      { error: 'product must not contain "..", "/", "\\", or null bytes' }
    )
    .optional(),
  platform: z.enum(['web', 'android', 'ios']),
  bundleId: z.string().optional(),
  appPackage: z.string().optional(),
  appActivity: z.string().optional(),
  app: AppInstallSchema.optional(),
  url: z.string().optional(),
  // A label only: agent-qa runs every target the same way, whatever it declares.
  environment: z
    .enum(['local', 'shared', 'production'])
    .optional()
    .describe("A label for this target's environment. agent-qa runs every target the same way."),
}).superRefine((val, ctx) => {
  if (val.platform === 'web' && !val.url) {
    ctx.addIssue({ code: 'custom', message: 'Web targets must have a url' })
  }
})

export const DeviceProfileSchema = z.strictObject({
  platform: z.enum(['android', 'ios']),
  match: z.record(z.string(), z.unknown()).optional().default({}),
}).superRefine((val, ctx) => {
  const androidOnly = ['avd', 'serial', 'appPackage', 'appActivity', 'automationName', 'browserName', 'platformVersion']
  const iosOnly = ['udid', 'bundleId', 'automationName', 'platformVersion']
  const allowed = val.platform === 'android' ? androidOnly : iosOnly
  for (const key of Object.keys(val.match)) {
    if (!allowed.includes(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['match', key],
        message: `Match field "${key}" is not valid for an ${val.platform} device. Allowed: ${allowed.join(', ')}`,
      })
    }
  }
})

export const RegistrySchema = z.strictObject({
  llms: z.array(NamedLLMConfigSchema).optional().default([]),
  remotes: z.array(RemoteEntrySchema).optional().default([]),
  targets: z.record(TargetNameSchema, TargetSchema).optional(),
  devices: z.record(z.string(), DeviceProfileSchema).optional(),
})
