import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerLLMAuthProviderPlugins, type LLMAuthProviderPlugin } from './plugin-registry.js'

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

function findPackageJson(packageName: string, baseDir: string): string | null {
  let current = resolve(baseDir)
  while (true) {
    const candidate = resolve(current, 'node_modules', ...packageName.split('/'), 'package.json')
    if (existsSync(candidate)) return candidate

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function exportTargetFromPackageJson(pkg: Record<string, unknown>): string | null {
  const exportsField = pkg.exports
  if (typeof exportsField === 'string') return exportsField
  if (exportsField && typeof exportsField === 'object') {
    const rootExport = (exportsField as Record<string, unknown>)['.'] ?? exportsField
    if (typeof rootExport === 'string') return rootExport
    if (rootExport && typeof rootExport === 'object') {
      const conditions = rootExport as Record<string, unknown>
      if (typeof conditions.import === 'string') return conditions.import
      if (typeof conditions.default === 'string') return conditions.default
      if (typeof conditions.require === 'string') return conditions.require
    }
  }
  if (typeof pkg.module === 'string') return pkg.module
  if (typeof pkg.main === 'string') return pkg.main
  return null
}

function resolvePackageImportFromBase(packageName: string, baseDir: string): string | null {
  const packageJsonPath = findPackageJson(packageName, baseDir)
  if (!packageJsonPath) return null

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>
  const target = exportTargetFromPackageJson(pkg)
  if (!target || !target.startsWith('.')) return null
  return pathToFileURL(resolve(dirname(packageJsonPath), target)).href
}

function packageDeclarationValue(declaration: AuthPluginDeclaration): string {
  return 'package' in declaration && typeof declaration.package === 'string'
    ? declaration.package.trim()
    : ''
}

function pathDeclarationValue(declaration: AuthPluginDeclaration): string {
  return 'path' in declaration && typeof declaration.path === 'string'
    ? declaration.path.trim()
    : ''
}

function declarationKey(declaration: AuthPluginDeclaration, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) return `package:${packageName}`
  return `path:${resolve(baseDir, pathDeclarationValue(declaration))}`
}

function resolveModuleSpecifier(declaration: AuthPluginDeclaration, baseDir: string): string {
  const packageName = packageDeclarationValue(declaration)
  if (packageName) {
    const packageImport = resolvePackageImportFromBase(packageName, baseDir)
    if (packageImport) return packageImport

    const parentUrl = pathToFileURL(resolve(baseDir, 'agent-qa.config.yaml')).href
    try {
      const resolveImport = import.meta.resolve as (specifier: string, parent?: string) => string
      return resolveImport(packageName, parentUrl)
    } catch {
      const require = createRequire(resolve(baseDir, 'agent-qa.config.yaml'))
      return pathToFileURL(require.resolve(packageName)).href
    }
  }
  const pluginPath = pathDeclarationValue(declaration)
  const absolutePath = isAbsolute(pluginPath)
    ? pluginPath
    : resolve(baseDir, pluginPath)
  return pathToFileURL(absolutePath).href
}

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

    const specifier = resolveModuleSpecifier(declaration, baseDir)
    const module = await import(specifier) as AuthPluginModule
    const bundle = await resolvePluginBundle(module, key)

    registerLLMAuthProviderPlugins(bundle.providers)
    loadedDeclarations.add(key)
    loadedProviders.push(...bundle.providers)
  }

  return loadedProviders
}

export function clearLoadedLLMAuthPluginModules(): void {
  loadedDeclarations.clear()
}
