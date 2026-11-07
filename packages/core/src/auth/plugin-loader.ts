import { registerLLMAuthProviderPlugins, type LLMAuthProviderPlugin } from './plugin-registry.js'
import {
  PluginNotInstalledError,
  declarationKey,
  importDeclaredPluginModule,
  packageDeclarationValue,
} from '../plugin-loader-util.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../plugins/manifest.js'
import {
  selectInProcessPluginEntries,
  type PluginRemoteInput,
} from '../plugins/resolve-entries.js'
import type { PluginEntry } from '../schema/config-schema.js'
import { getAgentQaVersion } from '../version.js'

export interface AuthPluginBundle {
  providers: LLMAuthProviderPlugin[]
}

export interface LoadLLMAuthPluginsOptions {
  baseDir?: string
  // The config's registry.remotes; an entry one of them names is refused at run start instead.
  remotes?: readonly PluginRemoteInput[]
  // The config the person named; fix lines carry it when it is not the default.
  configPath?: string
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

export async function loadLLMAuthPlugins(
  entries: readonly PluginEntry[] | undefined,
  options: LoadLLMAuthPluginsOptions = {},
): Promise<LLMAuthProviderPlugin[]> {
  if (!entries?.length) return []
  const baseDir = options.baseDir ?? process.cwd()
  const { load, refusals } = selectInProcessPluginEntries(
    entries,
    'model-auth',
    {
      configDir: baseDir,
      agentQaVersion: getAgentQaVersion(),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    },
    options.remotes,
  )
  const [refused] = refusals
  if (refused) {
    const entry = entries.find((candidate) => candidate.name === refused.entry)
    const subscription =
      entry !== undefined && packageDeclarationValue(entry) === SUBSCRIPTION_AUTH_PACKAGE
    if (refused.state === 'not_installed' && subscription) {
      throw new PluginNotInstalledError(entry, 'auth', options.configPath)
    }
    throw new Error(refused.reason)
  }

  const loadedProviders: LLMAuthProviderPlugin[] = []
  for (const resolved of load) {
    const declaration = { name: resolved.name, package: resolved.label }
    const key = declarationKey(declaration, baseDir)
    if (loadedDeclarations.has(key)) continue

    const module = await importDeclaredPluginModule<AuthPluginModule>(
      declaration,
      baseDir,
      'auth',
      options.configPath,
    )
    const bundle = await resolvePluginBundle(module, resolved.label)

    registerLLMAuthProviderPlugins(bundle.providers)
    loadedDeclarations.add(key)
    loadedProviders.push(...bundle.providers)
  }

  return loadedProviders
}

export function clearLoadedLLMAuthPluginModules(): void {
  loadedDeclarations.clear()
}
