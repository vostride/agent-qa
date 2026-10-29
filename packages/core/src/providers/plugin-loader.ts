import {
  declarationKey,
  declarationLabel,
  importDeclaredPluginModule,
  packageDeclarationValue,
  pathDeclarationValue,
} from '../plugin-loader-util.js'

export type ProviderPluginDeclaration =
  | { package: string; path?: never }
  | { path: string; package?: never }

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
let warnedFirstParty = false

function warnFirstPartyProviderPlugins(): void {
  if (warnedFirstParty) return
  console.warn(
    '[agent-qa] plugins.providers modules run in-process with full Node access and can read credentials or screenshots. Use first-party provider plugins only until the container sandbox exists.',
  )
  warnedFirstParty = true
}

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

function validateDeclaration(declaration: ProviderPluginDeclaration): void {
  const packageName = packageDeclarationValue(declaration)
  const pluginPath = pathDeclarationValue(declaration)

  if (packageName && pluginPath) {
    throw new Error('Provider plugin declaration must specify either package or path, not both.')
  }
  if (!packageName && !pluginPath) {
    throw new Error('Provider plugin declaration must specify package or path.')
  }
}

export async function loadProviderPlugins(
  declarations: ProviderPluginDeclaration[] | undefined,
  options: LoadProviderPluginsOptions = {},
): Promise<ProviderPluginDescriptor[]> {
  if (!declarations?.length) return []

  warnFirstPartyProviderPlugins()

  const baseDir = options.baseDir ?? process.cwd()
  const loadedProviders: ProviderPluginDescriptor[] = []

  for (const declaration of declarations) {
    validateDeclaration(declaration)
    const key = declarationKey(declaration, baseDir)
    if (loadedDeclarations.has(key)) continue

    // The provider road shares the auth road's resolve-and-import, so it shares the guard.
    const module = await importDeclaredPluginModule<ProviderPluginModule>(declaration, baseDir, 'provider')
    // Descriptors interpolate this label into messages, which must not carry the absolute key.
    const descriptors = extractDescriptors(module, declarationLabel(declaration, baseDir))

    loadedDeclarations.add(key)
    loadedProviders.push(...descriptors)
  }

  return loadedProviders
}

export function clearLoadedProviderPluginModules(): void {
  loadedDeclarations.clear()
  warnedFirstParty = false
}
