import { z } from 'zod'
import { NamedLLMConfigSchema, TransportSchema } from './primitives.js'
import { TargetNameSchema } from '../auth-state/schema.js'

function isAbsoluteAppPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export const AppInstallSchema = z.object({
  path: z.string()
    .refine((v) => !isAbsoluteAppPath(v), { message: 'app.path must be relative' })
    .optional(),
  browserstack: z.string().optional(),
}).strict()

export const TargetSchema = z.object({
  product: z.string()
    .refine(
      (v) => !/\.\./.test(v) && !/[/\\]/.test(v) && !/\0/.test(v),
      { message: 'product must not contain "..", "/", "\\", or null bytes' }
    )
    .optional(),
  platform: z.enum(['web', 'android', 'ios']),
  bundleId: z.string().optional(),
  appPackage: z.string().optional(),
  appActivity: z.string().optional(),
  app: AppInstallSchema.optional(),
  url: z.string().optional(),
}).strict().superRefine((val, ctx) => {
  if (val.platform === 'web' && !val.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Web targets must have a url' })
  }
})

export const DeviceProfileSchema = z.object({
  platform: z.enum(['android', 'ios']),
  transport: TransportSchema,
  match: z.record(z.string(), z.unknown()).optional().default({}),
}).strict().superRefine((val, ctx) => {
  if (val.transport === 'local') {
    const androidOnly = ['avd', 'serial', 'appPackage', 'appActivity', 'automationName', 'browserName', 'platformVersion']
    const iosOnly = ['udid', 'bundleId', 'automationName', 'platformVersion']
    const allowed = val.platform === 'android' ? androidOnly : iosOnly
    for (const key of Object.keys(val.match)) {
      if (!allowed.includes(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['match', key],
          message: `Match field "${key}" is not valid for ${val.platform} local transport. Allowed: ${allowed.join(', ')}`,
        })
      }
    }
  }
})

export const ProviderConfigSchema = z.record(z.string(), z.unknown())

export const RegistrySchema = z.object({
  llms: z.array(NamedLLMConfigSchema).optional().default([]),
  targets: z.record(TargetNameSchema, TargetSchema).optional(),
  devices: z.record(z.string(), DeviceProfileSchema).optional(),
  providers: z.record(z.string(), ProviderConfigSchema).optional(),
}).strict()
