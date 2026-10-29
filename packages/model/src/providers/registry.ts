import type { AdapterBody } from '../adapters/index.js'

import { seedBuiltins } from './builtins.js'

export type ProviderAuthMode = 'api-key' | 'bearer-token' | 'subscription' | 'none'

export interface ProviderDescriptor {
  id: string
  label: string
  adapter: AdapterBody
  needsBaseURL: boolean
  authModes: ProviderAuthMode[]
  subscription?: boolean
  credentialOptional?: boolean
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
  baseURLPlaceholder?: string
  defaultModel?: string
  // SDK-level call option names this provider's backend rejects; stripped at egress.
  unsupportedParams?: readonly string[]
}

const registry = new Map<string, ProviderDescriptor>()

function validateDescriptor(descriptor: ProviderDescriptor): void {
  if (!descriptor.id?.trim()) {
    throw new Error('Provider descriptor id is required')
  }
  if (!descriptor.label?.trim()) {
    throw new Error(`Provider descriptor "${descriptor.id}" label is required`)
  }
  if (typeof descriptor.adapter !== 'function') {
    throw new Error(`Provider descriptor "${descriptor.id}" adapter is required`)
  }
  if (!Array.isArray(descriptor.authModes) || descriptor.authModes.length === 0) {
    throw new Error(`Provider descriptor "${descriptor.id}" authModes must be a non-empty array`)
  }
}

export function registerProvider(descriptor: ProviderDescriptor): void {
  validateDescriptor(descriptor)
  registry.set(descriptor.id, descriptor)
}

export function getProvider(id: string): ProviderDescriptor | undefined {
  return registry.get(id)
}

export function listProviders(): ProviderDescriptor[] {
  return [...registry.values()]
}

export function clearProviderRegistry(): void {
  registry.clear()
  seedBuiltins()
}

seedBuiltins()
