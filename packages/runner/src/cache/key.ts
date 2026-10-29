// Mask-before-hash cache-key builder (Phase 356, CACHE-01 / MASK-FUT-01 / D-04..D-06).
// CRITICAL: storage-neutral — no node:crypto / node:* import. This module NEVER
// hashes; it assembles the schema kernel's CacheableStepInput and delegates all
// hashing to the shipped computeCacheKey (browser-safe sha256hex16). The security
// floor: mask() is the FIRST transform applied to stepText so a raw secret can never
// enter key material or the derived `${key}.json` filename.

import { relevantEnvDigest } from '@vostride/agent-qa-schema'
import type {
  CacheableStepInput,
  MaskFn,
  Platform,
  RedactedEnvVar,
} from '@vostride/agent-qa-schema'

/**
 * Stable, non-secret, project-level env-digest salt (Open Question 2 resolution).
 * It MUST be a fixed versioned constant — a per-run salt would silently change the
 * env digest every run and disable ALL env-dependent cache hits. Never derive this
 * per-run and never fold a secret into it.
 */
export const CACHE_ENV_DIGEST_SALT = 'agent-qa/cache/env-digest/v1'

export interface BuildCacheableStepInputArgs {
  /** The declared-secret mask; the identity when unbound. */
  mask?: MaskFn
  platform: Platform
  suiteConfigDigest: string
  testConfigDigest: string
  stepText: string
  stepIndex: number
  testIndex: number
  /** Value-free redacted env shapes only — raw env values never reach the digest. */
  envVars: readonly RedactedEnvVar[]
  /** Stable project salt; defaults to CACHE_ENV_DIGEST_SALT. Never per-run. */
  envSalt?: string
  screenIdentityHash: string
  /** Accepted for caller ergonomics but intentionally never a key component. */
  branch?: string
}

/**
 * Assemble the schema kernel's 8-field CacheableStepInput. `mask()` is applied to
 * stepText BEFORE it enters the tuple (the MASK-FUT-01 floor, D-05); the env digest
 * folds only the value-free redacted shapes under the stable salt. The caller passes
 * the result to computeCacheKey to obtain the 16-hex CacheKey / filename.
 */
export function buildCacheableStepInput(
  args: BuildCacheableStepInputArgs,
): CacheableStepInput {
  const maskedStepText = args.mask === undefined ? args.stepText : args.mask(args.stepText)

  return {
    platform: args.platform,
    suiteConfigDigest: args.suiteConfigDigest,
    testConfigDigest: args.testConfigDigest,
    stepText: maskedStepText,
    stepIndex: args.stepIndex,
    testIndex: args.testIndex,
    relevantEnvDigest: relevantEnvDigest(args.envVars, args.envSalt ?? CACHE_ENV_DIGEST_SALT),
    screenIdentityHash: args.screenIdentityHash,
  }
}
