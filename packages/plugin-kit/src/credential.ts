import { z } from 'zod'

// No pattern or format: a config holds a secret reference here, not the secret itself.
export function credential(description?: string) {
  return z.string().meta({ credential: true, ...(description ? { description } : {}) })
}
