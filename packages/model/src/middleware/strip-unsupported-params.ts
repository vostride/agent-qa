import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'

// Deletes params the provider declares unsupported, just before the wire; others keep them.

export function stripUnsupportedParamsMiddleware(params: readonly string[]): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',

    transformParams: async ({ params: callOptions }) => {
      const present = params.filter((name) => name in (callOptions as Record<string, unknown>))
      if (present.length === 0) return callOptions
      const next = { ...(callOptions as Record<string, unknown>) }
      for (const name of present) {
        delete next[name]
      }
      return next as LanguageModelV3CallOptions
    },
  }
}
