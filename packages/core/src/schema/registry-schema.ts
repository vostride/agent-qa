import { z } from 'zod'
import { NameSlugSchema, NamedLLMConfigSchema } from './primitives.js'
import { RemoteEntrySchema } from './remote-schema.js'
import { TargetNameSchema } from '../auth-state/schema.js'

function isAbsoluteAppPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

export const AppInstallSchema = z.strictObject({
  path: z.string()
    .refine((v) => !isAbsoluteAppPath(v), { error: 'app.path must be relative' })
    .optional(),
  ref: z.string().trim().min(1).optional(),
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
  device: z.string().trim().min(1).optional(),
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
  model: z.string().trim().min(1).optional(),
  // YAML reads os: 17.10 as the number 17.1, so a number is refused rather than coerced.
  os: z
    .string({ error: 'os must be text, so write it in quotes, such as os: "17.10".' })
    .trim()
    .min(1)
    .optional(),
  id: z.string().trim().min(1).optional(),
  remote: NameSlugSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
})

export const RegistrySchema = z.strictObject({
  llms: z.array(NamedLLMConfigSchema).optional().default([]),
  remotes: z.array(RemoteEntrySchema).optional().default([]),
  targets: z.record(TargetNameSchema, TargetSchema).optional(),
  devices: z.record(z.string(), DeviceProfileSchema).optional(),
})
