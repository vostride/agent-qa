// the draft model flow's DTOs. A draft is tested with the typed
// credential inline and lands in the file only on a pass or an explicit skipTest, so nothing is
// persisted before the person chooses to keep it.
import { z } from 'zod'
import type { ProviderErrorClass } from './provider-error'

// The name rule itself is core's NameSlugSchema, applied by the route: schema cannot import core.
export const LlmConnectRequestSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  baseURL: z.string().optional(),
  providerHeaders: z.record(z.string(), z.string()).optional(),
  credential: z.object({
    type: z.enum(['api-key', 'bearer-token']),
    secret: z.string().min(1),
  }).strict().optional(),
  skipTest: z.boolean().optional(),
}).strict()

export type LlmConnectRequest = z.infer<typeof LlmConnectRequestSchema>

export type LlmConnectResult =
  | { success: true; saved: true; becameDefault: boolean; usedCredential: boolean; revision: string }
  | { success: false; errorClass: ProviderErrorClass; message: string }

export type LlmCredentialSaveResult = { saved: true; created: boolean }

/** Moves a saved credential to a renamed definition, so a rename never strands the secret. */
export const LlmCredentialMoveRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  provider: z.string().min(1),
}).strict()

export type LlmCredentialMoveRequest = z.infer<typeof LlmCredentialMoveRequestSchema>

/**
 * Why a model setup call was refused, as the route answers it.
 * - `invalid_setup_input`: the body is not a well-formed request.
 * - `name_invalid`: the name fails the name rule.
 * - `name_taken`: another definition already holds the name.
 * - `credential_provider_conflict`: a saved credential belongs to a different provider.
 * - `credential_not_accepted`: a key for a subscription provider, or a bearer token for a
 *   provider other than anthropic-compatible.
 * - `credential_missing`: the provider needs a credential and none was typed or saved.
 * - `credential_exists`: a move target already holds a credential.
 * - `validation_failed`: the config with the definition added fails whole-config validation.
 */
export type LlmSetupRefusal =
  | 'invalid_setup_input'
  | 'name_invalid'
  | 'name_taken'
  | 'credential_provider_conflict'
  | 'credential_not_accepted'
  | 'credential_missing'
  | 'credential_exists'
  | 'validation_failed'
// prettier-ignore
export const LLM_SETUP_REFUSALS = [
  'invalid_setup_input',
  'name_invalid',
  'name_taken',
  'credential_provider_conflict',
  'credential_not_accepted',
  'credential_missing',
  'credential_exists',
  'validation_failed',
] as const satisfies readonly LlmSetupRefusal[]
