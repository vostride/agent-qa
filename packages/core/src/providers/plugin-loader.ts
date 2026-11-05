import { declarationKey, importDeclaredPluginModule } from '../plugin-loader-util.js'
import { selectInProcessPluginEntries } from '../plugins/resolve-entries.js'
import type { PluginEntry } from '../schema/config-schema.js'
import { getAgentQaVersion } from '../version.js'

export interface ProviderPluginDescriptor {
  id: string
  label: string
  adapter: (transport: unknown, modelId: string) => unknown
  authModes: string[]
  needsBaseURL?: boolean
  subscription?: boolean
  credentialOptional?: boolean
  modelAdapter?: string
  baseURLPlaceholder?: string
  defaultModel?: string
}

export interface LoadProviderPluginsOptions {
  baseDir?: string
}

type ProviderPluginModule = {
  default?: unknown
  providers?: unknown
  [key: string]: unknown
}

const loadedDeclarations = new Set<string>()
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProviderDescriptorCandidate(value: unknown): boolean {
  return isRecord(value) && (
    'id' in value ||
    'label' in value ||
    'adapter' in value ||
    'authModes' in value
  )
}

function assertProviderDescriptor(value: unknown, source: string): asserts value is ProviderPluginDescriptor {
  if (!isRecord(value)) {
    throw new Error(`Provider plugin "${source}" exported a descriptor that is not an object.`)
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new Error(`Provider plugin "${source}" descriptor id is required.`)
  }
  if (typeof value.label !== 'string' || !value.label.trim()) {
    throw new Error(`Provider plugin "${source}" descriptor label is required.`)
  }
  if (typeof value.adapter !== 'function') {
    throw new Error(`Provider plugin "${source}" descriptor adapter is required.`)
  }
  if (!Array.isArray(value.authModes) || !value.authModes.every((mode) => typeof mode === 'string')) {
    throw new Error(`Provider plugin "${source}" descriptor authModes must be a string array.`)
  }
}

function extractProvidersArray(value: unknown, source: string): ProviderPluginDescriptor[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers)) return null
  for (const descriptor of value.providers) {
    assertProviderDescriptor(descriptor, source)
  }
  return value.providers as ProviderPluginDescriptor[]
}

function extractDescriptors(module: ProviderPluginModule, source: string): ProviderPluginDescriptor[] {
  const defaultProviders = extractProvidersArray(module.default, source)
  if (defaultProviders) return defaultProviders

  if (isProviderDescriptorCandidate(module.default)) {
    assertProviderDescriptor(module.default, source)
    return [module.default]
  }

  const namedProviders = extractProvidersArray(module, source)
  if (namedProviders) return namedProviders

  const namedDescriptors: ProviderPluginDescriptor[] = []
  for (const [name, value] of Object.entries(module)) {
    if (name === 'default' || name === 'providers') continue
    if (!isProviderDescriptorCandidate(value)) continue
    assertProviderDescriptor(value, source)
    namedDescriptors.push(value)
  }
  if (namedDescriptors.length > 0) return namedDescriptors

  throw new Error(`Provider plugin "${source}" must export a provider descriptor or providers array.`)
}

export async function loadProviderPlugins(
  entries: readonly PluginEntry[] | undefined,
  options: LoadProviderPluginsOptions = {},
): Promise<ProviderPluginDescriptor[]> {
  if (!entries?.length) return []
  const baseDir = options.baseDir ?? process.cwd()
  const { load, refusals } = selectInProcessPluginEntries(entries, 'model-provider', {
    configDir: baseDir,
    agentQaVersion: getAgentQaVersion(),
  })
  const [refused] = refusals
  if (refused) throw new Error(refused.reason)

  const loadedProviders: ProviderPluginDescriptor[] = []
  for (const resolved of load) {
    const declaration = { name: resolved.name, package: resolved.label }
    const key = declarationKey(declaration, baseDir)
    if (loadedDeclarations.has(key)) continue

    const module = await importDeclaredPluginModule<ProviderPluginModule>(
      declaration,
      baseDir,
      'provider',
    )
    const descriptors = extractDescriptors(module, resolved.label)

    loadedDeclarations.add(key)
    loadedProviders.push(...descriptors)
  }

  return loadedProviders
}

export function clearLoadedProviderPluginModules(): void {
  loadedDeclarations.clear()
}
