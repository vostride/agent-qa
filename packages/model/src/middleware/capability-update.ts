import type { LanguageModelMiddleware } from 'ai'
import type { ModelProfile } from '@vostride/agent-qa-schema'

import { capabilityKey, overrideStore } from '../capability/override-store.js'
import { parseRealWindow } from '../capability/overflow-parse.js'

export function capabilityUpdateMiddleware(profile: ModelProfile): LanguageModelMiddleware {
  const key = capabilityKey(profile.provider, profile.model)

  async function observe<T>(call: () => PromiseLike<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      const observedWindow = parseRealWindow(error)
      if (observedWindow !== undefined) {
        overrideStore.set(key, observedWindow)
      }
      throw error
    }
  }

  return {
    specificationVersion: 'v4',
    wrapGenerate: ({ doGenerate }) => observe(doGenerate),
    wrapStream: ({ doStream }) => observe(doStream),
  }
}
