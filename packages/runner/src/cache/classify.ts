// Provenance decides: a step that reads or sets a live env or secret is never cached.

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

// Env or secret steps are non-cacheable; others carry only value-free RedactedEnvVar shapes.
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
