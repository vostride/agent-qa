import { z } from 'zod'

export const AUTH_STATE_SCHEMA_VERSION = 1
export const AUTH_STATE_SLUG_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

export const AuthStateNameSchema = z.string().regex(
  AUTH_STATE_SLUG_PATTERN,
  'Auth state name must match ^[a-z][a-z0-9-]*[a-z0-9]$',
)

export const TargetNameSchema = z.string().regex(
  AUTH_STATE_SLUG_PATTERN,
  'Target name must match ^[a-z][a-z0-9-]*[a-z0-9]$',
)

export const AuthStateMetadataSchema = z.object({
  version: z.literal(AUTH_STATE_SCHEMA_VERSION),
  kind: z.literal('web'),
  target: TargetNameSchema,
  name: AuthStateNameSchema,
  capturedAt: z.string().datetime(),
}).strict()

export type AuthStateMetadata = z.infer<typeof AuthStateMetadataSchema>

