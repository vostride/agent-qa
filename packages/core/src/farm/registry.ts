import type { FarmProvider } from './types.js'
import { browserstackProvider } from './browserstack.js'

const providers = new Map<string, FarmProvider>()

export function registerProvider(provider: FarmProvider): void {
  providers.set(provider.slug, provider)
}

export function getProvider(slug: string): FarmProvider | undefined {
  return providers.get(slug)
}

export function listProviders(): FarmProvider[] {
  return Array.from(providers.values())
}

export function registerAllProviders(): void {
  registerProvider(browserstackProvider)
}
