import { registerLLMAuthProviderPlugins, type LLMAuthProviderPlugin } from './plugin-registry.js'
import {
  declarationKey,
  declarationLabel,
  importDeclaredPluginModule,
  packageDeclarationValue,
  pathDeclarationValue,
} from '../plugin-loader-util.js'

export type AuthPluginDeclaration =
  | { package: string; path?: never }
  | { path: string; package?: never }

export interface AuthPluginBundle {
  providers: LLMAuthProviderPlugin[]
}

export interface LoadLLMAuthPluginsOptions {
  baseDir?: string
}

type AuthPluginFactory = () => AuthPluginBundle | Promise<AuthPluginBundle>
type AuthPluginModule = {
  createSubscriptionAuthPlugin?: AuthPluginFactory
  createAuthPlugin?: AuthPluginFactory
  default?: AuthPluginFactory | AuthPluginBundle | AuthPluginModule
  providers?: LLMAuthProviderPlugin[]
}

const loadedDeclarations = new Set<string>()

async function resolvePluginBundle(module: AuthPluginModule, source: string): Promise<AuthPluginBundle> {
  if (typeof module.createSubscriptionAuthPlugin === 'function') {
    return await module.createSubscriptionAuthPlugin()
  }
  if (typeof module.createAuthPlugin === 'function') {
    return await module.createAuthPlugin()
  }
  if (typeof module.default === 'function') {
    return await module.default()
  }
  if (module.default && typeof module.default === 'object') {
    const defaultModule = module.default as AuthPluginModule
    if (typeof defaultModule.createSubscriptionAuthPlugin === 'function') {
      return await defaultModule.createSubscriptionAuthPlugin()
    }
    if (typeof defaultModule.createAuthPlugin === 'function') {
      return await defaultModule.createAuthPlugin()
    }
  }
  if (module.default && typeof module.default === 'object' && Array.isArray(module.default.providers)) {
    return { providers: module.default.providers }
  }
  if (Array.isArray(module.providers)) {
    return { providers: module.providers }
  }
  throw new Error(`Auth plugin "${source}" must export createSubscriptionAuthPlugin(), createAuthPlugin(), default, or providers.`)
}

function validateDeclaration(declaration: AuthPluginDeclaration): void {
  const packageName = packageDeclarationValue(declaration)
  const pluginPath = pathDeclarationValue(declaration)

  if (packageName && pluginPath) {
    throw new Error('Auth plugin declaration must specify either package or path, not both.')
  }
  if (!packageName && !pluginPath) {
    throw new Error('Auth plugin declaration must specify package or path.')
  }
}

export async function loadLLMAuthPlugins(
  declarations: AuthPluginDeclaration[] | undefined,
  options: LoadLLMAuthPluginsOptions = {},
): Promise<LLMAuthProviderPlugin[]> {
  if (!declarations?.length) return []
  const baseDir = options.baseDir ?? process.cwd()
  const loadedProviders: LLMAuthProviderPlugin[] = []

  for (const declaration of declarations) {
    validateDeclaration(declaration)
    const key = declarationKey(declaration, baseDir)
    if (loadedDeclarations.has(key)) continue

    // A declared plugin the project lacks gets the package name and install step, not a stack.
    const module = await importDeclaredPluginModule<AuthPluginModule>(declaration, baseDir, 'auth')
    // The map key is absolute and prefixed for collisions; the message uses the person's own label.
    const bundle = await resolvePluginBundle(module, declarationLabel(declaration, baseDir))

    registerLLMAuthProviderPlugins(bundle.providers)
    loadedDeclarations.add(key)
    loadedProviders.push(...bundle.providers)
  }

  return loadedProviders
}

export function clearLoadedLLMAuthPluginModules(): void {
  loadedDeclarations.clear()
}
