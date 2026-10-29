// `mask()` runs first on stepText, so a raw secret never enters key material or the filename.

import { relevantEnvDigest } from '@vostride/agent-qa-schema'
import type {
  CacheableStepInput,
  MaskFn,
  Platform,
  RedactedEnvVar,
} from '@vostride/agent-qa-schema'

// A fixed salt: a per-run salt would change the env digest each run and defeat env cache hits.
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

// `mask()` runs on stepText before it enters the tuple; the env digest folds only redacted shapes.
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
