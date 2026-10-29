import { z } from 'zod'

export const MASKED_RESOLVED_CONFIG_SCHEMA_VERSION = 2

/**
 * Which layer supplied the winning value for a resolved configuration key.
 *
 * A clean machine vocabulary rather than the CLI's existing human debug labels
 * (`global config` / `test yaml` / `cli flag`): those are display strings with spaces,
 * and this union crosses surface boundaries and projects into JSON Schema.
 */
export type ConfigValueSource =
  | 'default'
  | 'config-file'
  | 'env'
  | 'cli-flag'
  | 'test-file'

// Masked and stringified at construction, so no holder of this type sees a declared secret.
export interface MaskedConfigEntry {
  /** Dot-path key into the resolved configuration tree. */
  key: string
  /** The rendered value through the declared mask. */
  value: string
  source: ConfigValueSource
  /** True when the declared mask changed the rendered value. */
  masked: boolean
}

export interface MaskedResolvedConfig {
  schemaVersion: typeof MASKED_RESOLVED_CONFIG_SCHEMA_VERSION
  /** The configuration file the read resolved against, as the caller addressed it. */
  configPath: string
  entries: MaskedConfigEntry[]
}

const configValueSourceValues = [
  'default',
  'config-file',
  'env',
  'cli-flag',
  'test-file',
] as const satisfies readonly ConfigValueSource[]

export const MaskedConfigEntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  source: z.enum(configValueSourceValues),
  masked: z.boolean(),
}).strict() satisfies z.ZodType<MaskedConfigEntry>

export const MaskedResolvedConfigSchema = z.object({
  schemaVersion: z.literal(MASKED_RESOLVED_CONFIG_SCHEMA_VERSION),
  configPath: z.string(),
  entries: z.array(MaskedConfigEntrySchema),
}).strict() satisfies z.ZodType<MaskedResolvedConfig>

/**
 * `config.get` takes no arguments in the seed slice. A `.strict()` empty object rather than
 * `z.void()` so a key-path filter becomes an additive field later without changing the op's
 * input contract shape.
 */
export const ConfigGetInputSchema = z.object({}).strict()

export type ConfigGetInput = z.infer<typeof ConfigGetInputSchema>
