// Provenance-based step classifier.
// CRITICAL: storage-neutral — no node:* imports. Classification is decided by
// resolution provenance, NOT a bespoke step-text regex: a step that reads or sets a
// live env/secret is non-cacheable (the loop bypasses it — no read, no write); a
// step that merely depends on config-env values is cacheable and carries only the
// value-free RedactedEnvVar shapes for folding into the digest. Reuses the shipped
// secrets provenance surface (findSecretTemplates / the [secret:*] marker).

import type { NonCacheableStepInput, RedactedEnvVar } from '@vostride/agent-qa-schema'
import { containsRedactedSecretMarker, findSecretTemplates } from '../loop/secrets.js'

export interface CacheableClassification {
  cacheable: true
  /** Value-free config-env shapes this step depends on (folded into the digest). */
  envVars: RedactedEnvVar[]
}

export interface ClassifyStepInput {
  stepText: string
  /** Variable names this step sets — the onSetVariable / setVariable provenance. */
  envSets?: readonly string[]
  /** Config-env values this cacheable step reads (value-free shapes). */
  configEnv?: readonly RedactedEnvVar[]
}

/**
 * Classify a step by resolution provenance. Env/secret read-or-set steps
 * return NonCacheableStepInput; a config-env-dependent step returns a
 * CacheableClassification carrying the value-free RedactedEnvVar shapes.
 */
export function classifyStep(
  input: ClassifyStepInput,
): CacheableClassification | NonCacheableStepInput {
  const secretTemplates = findSecretTemplates(input.stepText)
  if (secretTemplates.length > 0) {
    return {
      cacheable: false,
      reason: `step reads live secret template(s): ${secretTemplates.map((t) => t.name).join(', ')}`,
    }
  }

  if (containsRedactedSecretMarker(input.stepText)) {
    return { cacheable: false, reason: 'step contains a redacted [secret:*] marker' }
  }

  if (input.envSets !== undefined && input.envSets.length > 0) {
    return {
      cacheable: false,
      reason: `step sets live env/secret variable(s): ${input.envSets.join(', ')}`,
    }
  }

  return { cacheable: true, envVars: [...(input.configEnv ?? [])] }
}
