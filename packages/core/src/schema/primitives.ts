import { z } from 'zod'
import ms from 'ms'
import bytes from 'bytes'

export const DurationString = z.string()
  .refine((v) => ms(v as ms.StringValue) !== undefined, {
    message: 'Invalid duration format (e.g., "30s", "5m", "1h")',
  })
  .transform((v) => ms(v as ms.StringValue) as number)

const VALID_SIZE_RE = /^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|k|m|g|t)$/i

function normalizeSize(v: string): string {
  return v.replace(/^(\d+(?:\.\d+)?)(k|m|g|t)$/i, '$1$2b')
}

export const SizeString = z.string()
  .refine((v) => VALID_SIZE_RE.test(v.trim()) && bytes(normalizeSize(v)) !== null, {
    message: 'Invalid size format (e.g., "256k", "1m", "5mb")',
  })
  .transform((v) => bytes(normalizeSize(v)) as number)

const COMPATIBLE_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible'])
const SENSITIVE_HEADER_TERMS = ['authorization', 'cookie', 'x-api-key', 'api-key', 'token', 'secret']
const CONTROL_CHARACTER_RE = /[\x00-\x1F\x7F]/

function validateProviderHeaders(headers: Record<string, string>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim()
    const value = rawValue.trim()
    const normalizedKey = key.toLowerCase()

    if (key === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerHeaders'],
        message: 'Provider header keys cannot be empty.',
      })
      continue
    }

    if (seen.has(normalizedKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerHeaders'],
        message: `Duplicate provider header "${key}" is not allowed.`,
      })
    }
    seen.add(normalizedKey)

    if (CONTROL_CHARACTER_RE.test(key) || CONTROL_CHARACTER_RE.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerHeaders'],
        message: `Provider header "${key}" cannot contain control characters.`,
      })
    }

    const sensitiveTerm = SENSITIVE_HEADER_TERMS.find(term => normalizedKey.includes(term))
    if (sensitiveTerm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerHeaders'],
        message: `Provider header "${key}" cannot contain auth-like term "${sensitiveTerm}".`,
      })
    }
  }
}

function validateModelConfig(
  config: { provider?: string; baseURL?: string; providerHeaders?: Record<string, string> },
  ctx: z.RefinementCtx,
) {
  if (
    config.provider
    && COMPATIBLE_PROVIDERS.has(config.provider)
    && (!config.baseURL || config.baseURL.trim() === '')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseURL'],
      message: `Base URL is required for ${config.provider} providers.`,
    })
  }

  if (config.providerHeaders !== undefined && config.provider !== 'anthropic-compatible') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['providerHeaders'],
      message: 'providerHeaders can only be used with anthropic-compatible providers.',
    })
  }

  if (config.providerHeaders) {
    validateProviderHeaders(config.providerHeaders, ctx)
  }
}

const REMOVED_LLM_PROVIDER_VALUES = new Set([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'lmstudio',
  'custom',
])

const LLMProviderIdSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Provider must be lowercase alphanumeric + hyphens, starting with alphanumeric')
  .superRefine((provider, ctx) => {
    if (REMOVED_LLM_PROVIDER_VALUES.has(provider)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Provider "${provider}" has been removed. Use a compatible provider or an auth plugin provider ID.`,
      })
    }
  })

const ModelConfigBaseSchema = z.object({
  provider: LLMProviderIdSchema,
  model: z.string(),
  baseURL: z.string().optional(),
  providerHeaders: z.record(z.string(), z.string()).optional(),
  screenshotSize: SizeString.optional(),
  effectiveResolution: z.number().positive().int().optional(),
}).strict()

export const ModelConfigSchema = ModelConfigBaseSchema.superRefine(validateModelConfig)

const NameSlugSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Name must be lowercase alphanumeric + hyphens, starting with alphanumeric')

export const NamedLLMConfigSchema = ModelConfigBaseSchema.extend({
  name: NameSlugSchema,
  contextWindow: SizeString.optional(),
}).strict().superRefine(validateModelConfig)

export const HealingConfigSchema = z.object({
  maxAttempts: z.number(),
}).strict()

export const TimeoutConfigSchema = z.object({
  step: DurationString,
  test: DurationString,
  navigation: DurationString,
}).strict()

export const BrowserConfigSchema = z.object({
  name: z.enum(['chromium', 'firefox', 'webkit']),
  headless: z.boolean(),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
  }).strict().optional(),
}).strict()

export const TransportSchema = z.enum(['local', 'browserstack'])

export const PlannerConfigSchema = z.object({
  maxSubActions: z.number(),
  previousStepCount: z.number(),
}).strict()

export const LogCaptureConfigSchema = z.object({
  console: z.boolean(),
  network: z.boolean(),
}).strict()
